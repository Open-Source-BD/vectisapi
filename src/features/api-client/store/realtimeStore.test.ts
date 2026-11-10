import { describe, it, expect, beforeEach, vi } from 'vitest';

const native = vi.hoisted(() => ({
  rtOpenWs: vi.fn(),
  rtOpenSse: vi.fn(),
  rtSend: vi.fn(),
  rtClose: vi.fn(),
}));
vi.mock('../lib/native/invoke', () => native);

import { useApiStore, createDefaultTab } from './useApiStore';
import { pushRtMessage, RT_LOG_CAP, RT_LOG_MAX_BYTES } from './slices/helpers';
import type { RealtimeState } from '../types';

const empty = (): RealtimeState => ({ status: 'open', messages: [], total: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  native.rtOpenWs.mockResolvedValue(undefined);
  native.rtOpenSse.mockResolvedValue(undefined);
  native.rtClose.mockResolvedValue(undefined);
  const t = createDefaultTab();
  useApiStore.setState({ tabs: [t], activeTabId: t.id, realtime: {} });
});

describe('closing tabs closes their connection', () => {
  it('closeTab on one of several tabs calls rt_close for that tab id', () => {
    useApiStore.getState().newTab();
    const [a, b] = useApiStore.getState().tabs;
    useApiStore.setState({ tabs: [{ ...a, protocol: 'ws', url: 'wss://x' }, b] });
    useApiStore.getState().wsConnect(a.id);
    expect(native.rtOpenWs).toHaveBeenCalledTimes(1);
    useApiStore.getState().closeTab(a.id);
    expect(native.rtClose).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${a.id}:`)));
  });

  it('closing the last tab (replacement path) closes the old tab id', () => {
    const [a] = useApiStore.getState().tabs;
    useApiStore.setState({ tabs: [{ ...a, protocol: 'ws', url: 'wss://x' }] });
    useApiStore.getState().wsConnect(a.id);
    useApiStore.getState().closeTab(a.id);
    expect(native.rtClose).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${a.id}:`)));
    expect(useApiStore.getState().tabs[0].id).not.toBe(a.id);
  });

  it('wsConnect sends tab headers + auth and converts http to ws', () => {
    const [a] = useApiStore.getState().tabs;
    useApiStore.setState({
      tabs: [
        {
          ...a,
          protocol: 'ws',
          url: 'http://x/sock',
          headers: [{ id: 'h', key: 'X-A', value: '1', enabled: true }] as never,
          auth: { ...a.auth, type: 'bearer', bearer: 'T' },
        },
      ],
    });
    useApiStore.getState().wsConnect(a.id);
    const [, url, headers] = native.rtOpenWs.mock.calls[0];
    expect(url).toBe('ws://x/sock');
    expect(headers).toEqual([
      ['X-A', '1'],
      ['Authorization', 'Bearer T'],
    ]);
  });

  it('wsConnect rejects non-ws schemes without opening', () => {
    const [a] = useApiStore.getState().tabs;
    useApiStore.setState({ tabs: [{ ...a, protocol: 'ws', url: 'ftp://x' }] });
    useApiStore.getState().wsConnect(a.id);
    expect(native.rtOpenWs).not.toHaveBeenCalled();
    expect(useApiStore.getState().realtime[a.id].status).toBe('error');
  });

  it('sseConnect sends the full spec including form-data and the last event id', () => {
    const [a] = useApiStore.getState().tabs;
    useApiStore.setState({
      tabs: [
        {
          ...a,
          protocol: 'sse',
          method: 'POST',
          url: 'https://x/stream',
          body: {
            ...a.body,
            type: 'formdata',
            formdata: [{ id: 'f', key: 'k', value: 'v', enabled: true, type: 'text' }] as never,
          },
        },
      ],
      realtime: { [a.id]: { status: 'closed', messages: [], total: 0, lastEventId: '42' } },
    });
    useApiStore.getState().sseConnect(a.id);
    const [id, spec, last] = native.rtOpenSse.mock.calls[0];
    expect(id).toMatch(new RegExp(`^${a.id}:`));
    expect(spec.body).toEqual({ type: 'multipart', value: [{ name: 'k', value: { type: 'text', value: 'v' } }] });
    expect(last).toBe('42');
  });
});

describe('log cap', () => {
  it('keeps at most 5000 messages, drops oldest first, total keeps counting', () => {
    let rt = empty();
    for (let i = 0; i < RT_LOG_CAP + 10; i++) rt = pushRtMessage(rt, 'recv', `m${i}`, 2);
    expect(RT_LOG_CAP).toBe(5000);
    expect(rt.messages).toHaveLength(5000);
    expect(rt.messages[0].text).toBe('m10');
    expect(rt.messages.at(-1)!.text).toBe(`m${RT_LOG_CAP + 9}`);
    expect(rt.total).toBe(RT_LOG_CAP + 10);
  });

  it('keeps at most 20 MB, drops oldest first', () => {
    expect(RT_LOG_MAX_BYTES).toBe(20 * 1024 * 1024);
    let rt = empty();
    const chunk = 5 * 1024 * 1024;
    for (let i = 0; i < 6; i++) rt = pushRtMessage(rt, 'recv', `m${i}`, chunk);
    expect(rt.messages.map((m) => m.text)).toEqual(['m2', 'm3', 'm4', 'm5']);
    expect(rt.total).toBe(6);
  });

  it('always keeps the newest message even if it alone exceeds the cap', () => {
    const rt = pushRtMessage(empty(), 'recv', 'huge', RT_LOG_MAX_BYTES + 1);
    expect(rt.messages).toHaveLength(1);
  });
});
