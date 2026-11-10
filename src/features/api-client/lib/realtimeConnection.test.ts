import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openWebSocket, sendWebSocket, closeConnection, isConnected } from './realtimeConnection';

let instances: MockWS[] = [];

class MockWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWS.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = MockWS.CLOSED;
  }
  _open() {
    this.readyState = MockWS.OPEN;
    this.onopen?.();
  }
  _msg(data: unknown) {
    this.onmessage?.({ data });
  }
  _close(code = 1000, reason = '') {
    this.readyState = MockWS.CLOSED;
    this.onclose?.({ code, reason });
  }
}

function handlers() {
  const statuses: string[] = [];
  const messages: { dir: string; text: string; bytes: number }[] = [];
  return {
    statuses,
    messages,
    onStatus: (s: string) => statuses.push(s),
    onMessage: (dir: 'recv', text: string, bytes: number) => messages.push({ dir, text, bytes }),
  };
}

beforeEach(() => {
  instances = [];
  vi.stubGlobal('WebSocket', MockWS);
});
afterEach(() => {
  closeConnection('t1');
  closeConnection('t2');
  vi.unstubAllGlobals();
});

describe('realtimeConnection', () => {
  it('connects: connecting → open, and delivers messages', () => {
    const h = handlers();
    openWebSocket('t1', 'wss://x', [], h);
    expect(h.statuses).toEqual(['connecting']);
    instances[0]._open();
    expect(h.statuses).toEqual(['connecting', 'open']);
    instances[0]._msg('hello');
    expect(h.messages[0]).toMatchObject({ dir: 'recv', text: 'hello' });
    expect(h.messages[0].bytes).toBeGreaterThan(0);
  });

  it('send works only when open', () => {
    const h = handlers();
    openWebSocket('t1', 'wss://x', [], h);
    expect(sendWebSocket('t1', 'a')).toBe(false); // still connecting
    instances[0]._open();
    expect(sendWebSocket('t1', 'a')).toBe(true);
    expect(instances[0].sent).toEqual(['a']);
  });

  it('is idempotent — a second connect does not open a second socket', () => {
    const h = handlers();
    openWebSocket('t1', 'wss://x', [], h);
    openWebSocket('t1', 'wss://x', [], h);
    expect(instances).toHaveLength(1);
  });

  it('ignores late events after manual close (no stale status)', () => {
    const h = handlers();
    openWebSocket('t1', 'wss://x', [], h);
    instances[0]._open();
    closeConnection('t1');
    instances[0]._close(1006, 'late'); // should be ignored
    instances[0]._msg('ghost');
    expect(h.statuses).toEqual(['connecting', 'open']); // no 'closed' from the late event
    expect(h.messages).toHaveLength(0);
  });

  it('generation guard: an old socket cannot mutate a reconnected tab', () => {
    const h1 = handlers();
    openWebSocket('t1', 'wss://x', [], h1);
    const oldSock = instances[0];
    oldSock._open();
    closeConnection('t1');

    const h2 = handlers();
    openWebSocket('t1', 'wss://x', [], h2);
    const newSock = instances[1];
    newSock._open();

    oldSock._msg('from-old'); // stale: must NOT reach the new handlers
    newSock._msg('from-new');
    expect(h2.messages.map((m) => m.text)).toEqual(['from-new']);
    expect(h1.messages).toHaveLength(0);
  });

  it('reports connection state via isConnected', () => {
    const h = handlers();
    expect(isConnected('t1')).toBe(false);
    openWebSocket('t1', 'wss://x', [], h);
    expect(isConnected('t1')).toBe(true); // connecting counts
    closeConnection('t1');
    expect(isConnected('t1')).toBe(false);
  });
});
