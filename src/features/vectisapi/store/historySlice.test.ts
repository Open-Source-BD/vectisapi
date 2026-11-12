import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/native/invoke', async (orig) => ({
  ...(await orig<typeof import('../lib/native/invoke')>()),
  addHistoryNative: vi.fn().mockResolvedValue(undefined),
  saveEntities: vi.fn().mockResolvedValue(undefined),
}));

import { addHistoryNative, saveEntities } from '../lib/native/invoke';
import { useApiStore } from './useApiStore';
import type { HistoryItem } from '../types';

const item = (id: string, url: string, method: HistoryItem['method'] = 'GET'): HistoryItem => ({
  id,
  method,
  url,
  status: 200,
  time: 12,
  date: '2026-01-02T03:04:05.000Z',
});

describe('history slice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApiStore.setState({ history: [], settings: null });
  });

  it('dedupes by method+url and calls add_history', () => {
    const s = useApiStore.getState();
    s.addHistory(item('1', 'u'));
    s.addHistory(item('2', 'u'));
    expect(useApiStore.getState().history.map((h) => h.id)).toEqual(['2']);
    expect(addHistoryNative).toHaveBeenLastCalledWith({
      itemJson: JSON.stringify(item('2', 'u')),
      method: 'GET',
      url: 'u',
      status: 200,
      durationMs: 12,
      ts: Date.parse('2026-01-02T03:04:05.000Z'),
      limit: undefined,
    });
  });

  it('caps at the settings history limit', () => {
    useApiStore.setState({ settings: { historyLimit: 3 } as never });
    for (let i = 0; i < 5; i++) useApiStore.getState().addHistory(item(String(i), `u${i}`));
    expect(useApiStore.getState().history.map((h) => h.id)).toEqual(['4', '3', '2']);
  });

  it('delete and clear emit DeleteHistory / ClearHistory', () => {
    useApiStore.setState({ history: [item('1', 'a'), item('2', 'b')] });
    useApiStore.getState().deleteHistoryItem('1');
    expect(saveEntities).toHaveBeenLastCalledWith([{ op: 'deleteHistory', id: '1' }]);
    useApiStore.getState().clearHistory();
    expect(saveEntities).toHaveBeenLastCalledWith([{ op: 'clearHistory' }]);
    expect(useApiStore.getState().history).toEqual([]);
  });
});
