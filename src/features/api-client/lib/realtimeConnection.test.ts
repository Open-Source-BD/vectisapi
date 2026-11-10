import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RtEvent } from './native/invoke';

const native = vi.hoisted(() => ({
  rtOpenWs: vi.fn(),
  rtOpenSse: vi.fn(),
  rtSend: vi.fn(),
  rtClose: vi.fn(),
}));
vi.mock('./native/invoke', () => native);

import { openWebSocket, openSse, sendWebSocket, closeConnection, isConnected } from './realtimeConnection';
import type { HttpRequestSpec } from '../types';

type Sink = (e: RtEvent) => void;
/** The event callback handed to the n-th rt_open_ws call. */
const wsSink = (n = 0) => native.rtOpenWs.mock.calls[n][4] as Sink;
const sseSink = (n = 0) => native.rtOpenSse.mock.calls[n][3] as Sink;

function handlers() {
  const statuses: [string, string | undefined][] = [];
  const messages: { dir: string; text: string; bytes: number }[] = [];
  const ids: string[] = [];
  return {
    statuses,
    messages,
    ids,
    onStatus: (s: string, info?: string) => statuses.push([s, info]),
    onMessage: (dir: 'recv', text: string, bytes: number) => messages.push({ dir, text, bytes }),
    onId: (id: string) => ids.push(id),
  };
}
const names = (h: ReturnType<typeof handlers>) => h.statuses.map(([s]) => s);

beforeEach(() => {
  native.rtOpenWs.mockResolvedValue(undefined);
  native.rtOpenSse.mockResolvedValue(undefined);
  native.rtSend.mockResolvedValue(undefined);
  native.rtClose.mockResolvedValue(undefined);
});
afterEach(() => {
  closeConnection('t1');
  closeConnection('t2');
  vi.clearAllMocks();
});

describe('realtimeConnection', () => {
  it('openWebSocket passes headers and protocols to rt_open_ws', () => {
    openWebSocket('t1', 'wss://x', ['graphql-ws'], handlers(), [['Authorization', 'Bearer T']]);
    expect(native.rtOpenWs).toHaveBeenCalledWith(
      't1',
      'wss://x',
      [['Authorization', 'Bearer T']],
      ['graphql-ws'],
      expect.any(Function),
    );
  });

  it('headers default to none', () => {
    openWebSocket('t1', 'wss://x', [], handlers());
    expect(native.rtOpenWs.mock.calls[0].slice(0, 4)).toEqual(['t1', 'wss://x', [], []]);
  });

  it('events map to RtHandlers', () => {
    const h = handlers();
    openWebSocket('t1', 'wss://x', [], h);
    expect(names(h)).toEqual(['connecting']);
    wsSink()({ type: 'connecting' });
    wsSink()({ type: 'open' });
    wsSink()({ type: 'message', text: 'hello', bytes: 5, binary: false });
    expect(names(h)).toEqual(['connecting', 'open']);
    expect(h.messages).toEqual([{ dir: 'recv', text: 'hello', bytes: 5 }]);
    wsSink()({ type: 'closed', code: 1000, reason: 'bye' });
    expect(h.statuses.at(-1)).toEqual(['closed', 'code 1000 — bye']);
    expect(isConnected('t1')).toBe(false);
  });

  it('maps error events and open rejections to the error status', () => {
    const h = handlers();
    openWebSocket('t1', 'wss://x', [], h);
    wsSink()({ type: 'error', message: 'refused' });
    expect(h.statuses.at(-1)).toEqual(['error', 'refused']);
    expect(isConnected('t1')).toBe(false);
  });

  it('reports a rejected rt_open_ws as an error', async () => {
    native.rtOpenWs.mockRejectedValueOnce({ kind: 'invalid_url', message: 'bad url' });
    const h = handlers();
    openWebSocket('t1', 'nope', [], h);
    await vi.waitFor(() => expect(h.statuses.at(-1)).toEqual(['error', 'bad url']));
    expect(isConnected('t1')).toBe(false);
  });

  it('maps SSE events (labels, byte size, ids) and ends the stream', () => {
    const h = handlers();
    const spec = { requestId: 't1', method: 'GET', url: 'https://x/s' } as HttpRequestSpec;
    openSse('t1', spec, 'abc', h);
    expect(native.rtOpenSse).toHaveBeenCalledWith('t1', spec, 'abc', expect.any(Function));
    sseSink()({ type: 'open' });
    sseSink()({ type: 'sseEvent', event: 'message', data: 'hi', id: '7' });
    sseSink()({ type: 'sseEvent', event: 'tick', data: 'é', id: null });
    expect(h.messages).toEqual([
      { dir: 'recv', text: 'hi', bytes: 2 },
      { dir: 'recv', text: '[tick] é', bytes: 2 },
    ]);
    expect(h.ids).toEqual(['7']);
    sseSink()({ type: 'closed', code: null, reason: '' });
    expect(h.statuses.at(-1)).toEqual(['closed', 'Stream ended']);
  });

  it('send works only when open and goes through rt_send', () => {
    openWebSocket('t1', 'wss://x', [], handlers());
    expect(sendWebSocket('t1', 'a')).toBe(false); // still connecting
    wsSink()({ type: 'open' });
    expect(sendWebSocket('t1', 'a')).toBe(true);
    expect(native.rtSend).toHaveBeenCalledWith('t1', 'a');
  });

  it('is idempotent — a second connect does not open a second connection', () => {
    openWebSocket('t1', 'wss://x', [], handlers());
    openWebSocket('t1', 'wss://x', [], handlers());
    expect(native.rtOpenWs).toHaveBeenCalledTimes(1);
  });

  it('closeConnection calls rt_close once and ignores late events', () => {
    const h = handlers();
    openWebSocket('t1', 'wss://x', [], h);
    wsSink()({ type: 'open' });
    closeConnection('t1');
    closeConnection('t1');
    expect(native.rtClose).toHaveBeenCalledTimes(1);
    expect(native.rtClose).toHaveBeenCalledWith('t1');
    wsSink()({ type: 'closed', code: 1006, reason: 'late' });
    wsSink()({ type: 'message', text: 'ghost', bytes: 5, binary: false });
    expect(names(h)).toEqual(['connecting', 'open']);
    expect(h.messages).toHaveLength(0);
  });

  it('stale generation ignored after reconnect', () => {
    const h1 = handlers();
    openWebSocket('t1', 'wss://x', [], h1);
    const oldSink = wsSink(0);
    oldSink({ type: 'open' });
    closeConnection('t1');

    const h2 = handlers();
    openWebSocket('t1', 'wss://x', [], h2);
    const newSink = wsSink(1);
    newSink({ type: 'open' });

    oldSink({ type: 'message', text: 'from-old', bytes: 8, binary: false });
    oldSink({ type: 'closed', code: 1006, reason: '' }); // must not drop the new connection
    newSink({ type: 'message', text: 'from-new', bytes: 8, binary: false });
    expect(h2.messages.map((m) => m.text)).toEqual(['from-new']);
    expect(h1.messages).toHaveLength(0);
    expect(isConnected('t1')).toBe(true);
  });
});
