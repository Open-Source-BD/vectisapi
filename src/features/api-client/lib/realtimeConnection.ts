/**
 * Realtime connection manager over the Rust WebSocket/SSE engine. The sockets live in
 * Rust; this module keeps one entry per tab id (the Rust `connId`) with a generation
 * number so a stale connection's late events can't mutate a tab that has since
 * reconnected. Connect is idempotent (double-click safe).
 */

import type { HttpRequestSpec } from '../types';
import { rtClose, rtOpenSse, rtOpenWs, rtSend, type RtEvent } from './native/invoke';

export interface RtHandlers {
  onStatus: (status: 'connecting' | 'open' | 'closed' | 'error', info?: string) => void;
  onMessage: (dir: 'recv', text: string, bytes: number) => void;
  /** SSE only: report an event id so reconnects can send Last-Event-ID. */
  onId?: (id: string) => void;
}

interface LiveConn {
  gen: number;
  open: boolean;
}

const conns = new Map<string, LiveConn>();
let genCounter = 0;

export function isConnected(tabId: string): boolean {
  return conns.has(tabId);
}

/** Translate Rust events into handler calls; events from a replaced/closed connection are dropped. */
function eventHandler(tabId: string, gen: number, handlers: RtHandlers, sse: boolean) {
  const alive = () => conns.get(tabId)?.gen === gen;
  return (ev: RtEvent) => {
    if (!alive()) return;
    switch (ev.type) {
      case 'connecting':
        break; // already reported when the connection was requested
      case 'open':
        conns.get(tabId)!.open = true;
        handlers.onStatus('open');
        break;
      case 'message':
        handlers.onMessage('recv', ev.text, ev.bytes);
        break;
      case 'sseEvent': {
        const label = ev.event && ev.event !== 'message' ? `[${ev.event}] ${ev.data}` : ev.data;
        handlers.onMessage('recv', label, byteLen(ev.data));
        if (ev.id) handlers.onId?.(ev.id);
        break;
      }
      case 'closed': {
        conns.delete(tabId);
        const info = sse ? ev.reason || 'Stream ended' : `code ${ev.code ?? 1005}${ev.reason ? ` — ${ev.reason}` : ''}`;
        handlers.onStatus('closed', info);
        break;
      }
      case 'error':
        conns.delete(tabId);
        handlers.onStatus('error', ev.message);
        break;
    }
  };
}

function start(
  tabId: string,
  handlers: RtHandlers,
  sse: boolean,
  open: (onEvent: (e: RtEvent) => void) => Promise<void>,
): void {
  const gen = ++genCounter;
  conns.set(tabId, { gen, open: false });
  handlers.onStatus('connecting');
  open(eventHandler(tabId, gen, handlers, sse)).catch((e: unknown) => {
    if (conns.get(tabId)?.gen !== gen) return;
    conns.delete(tabId);
    handlers.onStatus('error', errorMessage(e));
  });
}

function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** Open a WebSocket for a tab. No-op if one is already connecting/open (idempotent). */
export function openWebSocket(
  tabId: string,
  url: string,
  protocols: string[],
  handlers: RtHandlers,
  headers: [string, string][] = [],
): void {
  if (isConnected(tabId)) return;
  start(tabId, handlers, false, (onEvent) => rtOpenWs(tabId, url, headers, protocols, onEvent));
}

/** Send text on an open socket. Returns false if not open. */
export function sendWebSocket(tabId: string, text: string): boolean {
  const c = conns.get(tabId);
  if (!c?.open) return false;
  const gen = c.gen;
  rtSend(tabId, text).catch((e: unknown) => {
    // A failed send means the socket is going away; Rust reports that as the terminal event.
    if (conns.get(tabId)?.gen === gen) console.warn('rt_send failed', e);
  });
  return true;
}

/** Manually close a connection (WS or SSE). Invalidates callbacks via map removal. */
export function closeConnection(tabId: string): void {
  if (!conns.delete(tabId)) return;
  rtClose(tabId).catch(() => {
    // already closed on the Rust side
  });
}

/** Open an SSE stream for a tab; the full request (any body kind) is sent by the Rust engine. */
export function openSse(tabId: string, spec: HttpRequestSpec, lastEventId: string | null, handlers: RtHandlers): void {
  if (isConnected(tabId)) return;
  start(tabId, handlers, true, (onEvent) => rtOpenSse(tabId, spec, lastEventId, onEvent));
}

export function byteLen(s: string): number {
  return new Blob([s]).size;
}
