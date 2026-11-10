/**
 * Realtime connection manager. Owns live WebSocket objects in a module-level
 * map keyed by tab id (live sockets are not serializable → never in the store).
 * Each connection carries a generation number so a stale socket's late
 * onmessage/onclose can't mutate a tab that has since reconnected. Connect is
 * idempotent (double-click safe). SSE is added in Lane B.
 */

import { createSseParser } from './parseSse';

export interface RtHandlers {
  onStatus: (status: 'connecting' | 'open' | 'closed' | 'error', info?: string) => void;
  onMessage: (dir: 'recv', text: string, bytes: number) => void;
  /** SSE only: report an event id so reconnects can send Last-Event-ID. */
  onId?: (id: string) => void;
}

interface LiveConn {
  gen: number;
  ws?: WebSocket;
  abort?: AbortController; // SSE
}

const conns = new Map<string, LiveConn>();
let genCounter = 0;

export function isConnected(tabId: string): boolean {
  const c = conns.get(tabId);
  if (!c) return false;
  if (c.ws) return c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING;
  if (c.abort) return !c.abort.signal.aborted;
  return false;
}

/** Open a WebSocket for a tab. No-op if one is already connecting/open (idempotent). */
export function openWebSocket(tabId: string, url: string, protocols: string[], handlers: RtHandlers): void {
  if (isConnected(tabId)) return;

  const gen = ++genCounter;
  let ws: WebSocket;
  try {
    ws = protocols.length ? new WebSocket(url, protocols) : new WebSocket(url);
  } catch (e) {
    handlers.onStatus('error', (e as Error).message);
    return;
  }
  conns.set(tabId, { ws, gen });

  // Stale-callback guard: only act if this socket is still the current one.
  const alive = () => conns.get(tabId)?.gen === gen;

  handlers.onStatus('connecting');
  ws.onopen = () => alive() && handlers.onStatus('open');
  ws.onmessage = (ev: MessageEvent) => {
    if (!alive()) return;
    const data: unknown = ev.data;
    if (typeof data === 'string') {
      handlers.onMessage('recv', data, byteLen(data));
    } else if (data instanceof Blob) {
      handlers.onMessage('recv', `[binary ${data.size} bytes]`, data.size);
    } else if (data instanceof ArrayBuffer) {
      handlers.onMessage('recv', `[binary ${data.byteLength} bytes]`, data.byteLength);
    } else {
      handlers.onMessage('recv', '[binary]', 0);
    }
  };
  ws.onerror = () => alive() && handlers.onStatus('error', 'WebSocket connection error');
  ws.onclose = (ev: CloseEvent) => {
    if (!alive()) return;
    conns.delete(tabId);
    handlers.onStatus('closed', `code ${ev.code}${ev.reason ? ` — ${ev.reason}` : ''}`);
  };
}

/** Send text on an open socket. Returns false if not open. */
export function sendWebSocket(tabId: string, text: string): boolean {
  const c = conns.get(tabId);
  if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
    c.ws.send(text);
    return true;
  }
  return false;
}

/** Manually close a connection (WS or SSE). Invalidates callbacks via map removal. */
export function closeConnection(tabId: string): void {
  const c = conns.get(tabId);
  if (!c) return;
  conns.delete(tabId); // makes alive() false → late callbacks are ignored
  try {
    c.ws?.close();
    c.abort?.abort();
  } catch {
    // already closing/closed
  }
}

/** Open an SSE stream for a tab via the streaming proxy. `init` is the /api/stream fetch config. */
export function openSse(tabId: string, init: { headers: Headers; body?: BodyInit }, handlers: RtHandlers): void {
  if (isConnected(tabId)) return;
  const gen = ++genCounter;
  const abort = new AbortController();
  conns.set(tabId, { gen, abort });
  const alive = () => conns.get(tabId)?.gen === gen;
  handlers.onStatus('connecting');
  void runSse(tabId, init, handlers, abort, gen, alive);
}

async function runSse(
  tabId: string,
  init: { headers: Headers; body?: BodyInit },
  handlers: RtHandlers,
  abort: AbortController,
  gen: number,
  alive: () => boolean,
): Promise<void> {
  try {
    const res = await fetch('/api/stream', {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      signal: abort.signal,
    });
    if (!alive()) return;
    if (!res.ok || !res.body) {
      let msg = `Stream error ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j?.error) msg = j.error;
      } catch {
        // non-JSON error body
      }
      handlers.onStatus('error', msg);
      conns.delete(tabId);
      return;
    }
    handlers.onStatus('open');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!alive()) {
        try {
          await reader.cancel();
        } catch {
          /* noop */
        }
        return;
      }
      const text = decoder.decode(value, { stream: true });
      for (const ev of parser.push(text)) {
        const label = ev.event && ev.event !== 'message' ? `[${ev.event}] ${ev.data}` : ev.data;
        handlers.onMessage('recv', label, byteLen(ev.data));
        if (ev.id) handlers.onId?.(ev.id);
      }
    }
    if (alive()) {
      handlers.onStatus('closed', 'Stream ended');
      conns.delete(tabId);
    }
  } catch (e) {
    if (alive() && !abort.signal.aborted) {
      handlers.onStatus('error', (e as Error).message);
      conns.delete(tabId);
    }
  }
}

export function byteLen(s: string): number {
  return new Blob([s]).size;
}
