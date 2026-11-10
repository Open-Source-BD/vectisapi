import type { Channel } from '@tauri-apps/api/core';
import { mockIPC } from '@tauri-apps/api/mocks';
import type { CookieView, RtEvent, Settings, WorkspaceSnapshot } from '@/features/api-client/lib/native/invoke';
import type { HttpRequestSpec, ResponseMeta } from '@/features/api-client/types';

/**
 * Browser-only stand-in for the Rust command layer, used by the Playwright e2e suite and the
 * fidelity screenshots (`vite --mode e2e`). Never part of a production build: `main.tsx` imports
 * it only when `import.meta.env.MODE === 'e2e'`, which Vite folds to `false` otherwise.
 *
 * Tests tune it before the app boots with `page.addInitScript(() => { window.__VECTIS_MOCK__ = … })`.
 */
export interface MockOptions {
  /** Workspace returned by `load_workspace` (merged over an empty snapshot). */
  snapshot?: Partial<WorkspaceSnapshot>;
  /**
   * Size in bytes of the mocked response body. Past the 2 MB inline prefix the frame carries only
   * the prefix and `truncated: true`, as Rust does; `get_response_body` serves the rest.
   */
  bodySize?: number;
  /** Fixed response body text (overrides the default echo JSON). */
  body?: string;
  /** Extra latency for `send_request`, ms. */
  latencyMs?: number;
  /** Jar contents returned by `cookies_list`. */
  cookies?: CookieView[];
}

declare global {
  interface Window {
    __VECTIS_MOCK__?: MockOptions;
  }
}

const PREFIX_BYTES = 2 * 1024 * 1024;

const defaultSettings: Settings = {
  timeoutMs: 30_000,
  followRedirects: true,
  maxRedirects: 10,
  verifyTls: true,
  proxyUrl: null,
  userAgent: null,
  responseStoreCapBytes: 512 * 1024 * 1024,
  historyLimit: 1_000,
  theme: null,
};

const encoder = new TextEncoder();

const bigCache = new Map<number, Uint8Array>();

/** A JSON document of exactly `size` bytes (memoized so timing runs measure the UI, not the mock). */
function bigJson(size: number): Uint8Array {
  let body = bigCache.get(size);
  if (!body) bigCache.set(size, (body = makeBigJson(size)));
  return body;
}

/** An array of numbered rows, padded with spaces to `size` bytes. */
function makeBigJson(size: number): Uint8Array {
  const row = '{"id":0000000,"name":"row","active":true,"tags":["a","b"]},\n';
  const rows = Math.max(0, Math.floor((size - 4) / row.length));
  const parts: string[] = ['[\n'];
  for (let i = 0; i < rows; i++) {
    const r = row.replace('0000000', String(i).padStart(7, '0'));
    parts.push(i === rows - 1 ? r.replace('},', '} ') : r);
  }
  parts.push(']');
  const text = parts.join('');
  return encoder.encode(text + ' '.repeat(Math.max(0, size - text.length)));
}

/** Bodies by response id, so `get_response_body` can serve ranges like the Rust ResponseStore. */
const bodies = new Map<string, Uint8Array>();
let nextId = 0;

function echoBody(spec: HttpRequestSpec): string {
  let json: unknown = null;
  if (spec.body.type === 'text') {
    try {
      json = JSON.parse(spec.body.value);
    } catch {
      json = null;
    }
  }
  return JSON.stringify(
    {
      args: Object.fromEntries(new URL(spec.url, 'http://localhost').searchParams),
      headers: Object.fromEntries(spec.headers),
      json,
      method: spec.method,
      url: spec.url,
    },
    null,
    2,
  );
}

/** `send_request`'s frame: `[u32 LE meta_len][meta JSON][body prefix]`. */
function sendFrame(spec: HttpRequestSpec, opts: MockOptions): ArrayBuffer {
  const body = opts.bodySize ? bigJson(opts.bodySize) : encoder.encode(opts.body ?? echoBody(spec));
  const responseId = `mock-${++nextId}`;
  bodies.set(responseId, body);
  const truncated = body.length > PREFIX_BYTES;
  const meta: ResponseMeta = {
    responseId,
    status: 200,
    statusText: 'OK',
    httpVersion: 'HTTP/1.1',
    headers: [
      ['content-type', 'application/json'],
      ['content-length', String(body.length)],
    ],
    remoteAddr: '127.0.0.1:443',
    finalUrl: spec.url,
    size: body.length,
    timing: { totalMs: 42, ttfbMs: 38 },
    truncated,
  };
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const prefix = truncated ? body.subarray(0, PREFIX_BYTES) : body;
  const frame = new Uint8Array(4 + metaBytes.length + prefix.length);
  new DataView(frame.buffer).setUint32(0, metaBytes.length, true);
  frame.set(metaBytes, 4);
  frame.set(prefix, 4 + metaBytes.length);
  return frame.buffer;
}

function emptySnapshot(opts: MockOptions): WorkspaceSnapshot {
  return {
    collections: [],
    environments: [],
    globals: [],
    activeEnvId: null,
    history: [],
    tabs: [],
    uiState: {},
    settings: defaultSettings,
    ...opts.snapshot,
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Realtime: an echo server. `rt_send` echoes the text back on the connection's channel. */
const rtChannels = new Map<string, Channel<RtEvent>>();

function rtOpen(connId: string, channel: Channel<RtEvent>, sse: boolean): void {
  rtChannels.set(connId, channel);
  setTimeout(() => {
    channel.onmessage({ type: 'open' });
    if (sse) channel.onmessage({ type: 'sseEvent', event: 'message', data: '{"tick":1}', id: '1' });
  }, 20);
}

export function installTauriMocks(): void {
  let settings = defaultSettings;
  // Build a big mocked body up front so timing runs measure the app, not the mock.
  const preset = window.__VECTIS_MOCK__?.bodySize;
  if (preset) bigJson(preset);
  mockIPC(
    async (cmd, args) => {
      const opts = window.__VECTIS_MOCK__ ?? {};
      const a = (args ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case 'load_workspace':
          return emptySnapshot(opts);
        case 'get_settings':
          return settings;
        case 'set_settings':
          settings = a.settings as Settings;
          return null;
        case 'send_request':
          if (opts.latencyMs) await delay(opts.latencyMs);
          return sendFrame(a.spec as HttpRequestSpec, opts);
        case 'cancel_request':
          return false;
        case 'get_response_body': {
          const body = bodies.get(a.responseId as string) ?? new Uint8Array();
          const start = a.start as number;
          const end = (a.end as number | null) ?? body.length;
          return body.slice(start, end).buffer;
        }
        case 'cookies_list':
          return opts.cookies ?? [];
        case 'rt_open_ws':
          rtOpen(a.connId as string, a.onEvent as Channel<RtEvent>, false);
          return null;
        case 'rt_open_sse':
          rtOpen(a.connId as string, a.onEvent as Channel<RtEvent>, true);
          return null;
        case 'rt_send': {
          const text = a.text as string;
          const ch = rtChannels.get(a.connId as string);
          // Asynchronous like a real round trip (never before the invoke itself returns).
          setTimeout(
            () => ch?.onmessage({ type: 'message', text, bytes: encoder.encode(text).length, binary: false }),
            5,
          );
          return null;
        }
        case 'rt_close': {
          const ch = rtChannels.get(a.connId as string);
          rtChannels.delete(a.connId as string);
          ch?.onmessage({ type: 'closed', code: 1000, reason: '' });
          return null;
        }
        case 'plugin:app|version':
          return '0.1.0';
        default:
          // save_entities, add_history, flush_done, cookie deletes, dialogs (cancelled): no-ops.
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}
