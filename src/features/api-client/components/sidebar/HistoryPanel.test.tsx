import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../lib/native/invoke', async (orig) => ({
  ...(await orig<typeof import('../../lib/native/invoke')>()),
  searchHistory: vi.fn(),
}));

import { searchHistory } from '../../lib/native/invoke';
import { useApiStore } from '../../store/useApiStore';
import { HistoryPanel } from './HistoryPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockSearch = vi.mocked(searchHistory);
const item = (id: string, url: string) => ({
  id,
  method: 'GET' as const,
  url,
  status: 200,
  time: 1,
  date: new Date().toISOString(),
});

describe('HistoryPanel search', () => {
  let root: Root;
  let host: HTMLElement;
  const urls = () => [...host.querySelectorAll('.h-url')].map((e) => e.textContent);
  const type = (q: string) => act(() => useApiStore.getState().setHistorySearch(q));

  beforeEach(() => {
    vi.useFakeTimers();
    mockSearch.mockReset();
    useApiStore.setState({
      history: [item('1', 'https://a.test/alpha'), item('2', 'https://b.test/beta')],
      historySearch: '',
      settings: null,
    });
    host = document.createElement('div');
    root = createRoot(host);
    act(() => root.render(<HistoryPanel />));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it('debounces search_history by 150ms and shows its results', async () => {
    mockSearch.mockResolvedValue([JSON.stringify(item('2', 'https://b.test/beta'))]);
    expect(urls()).toHaveLength(2);
    type('b');
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(mockSearch).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith('b', 1000);
    expect(urls()).toEqual(['https://b.test/beta']);
  });

  it('ignores a stale result that arrives after the query changed', async () => {
    let resolveFirst!: (rows: string[]) => void;
    mockSearch.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    mockSearch.mockResolvedValueOnce([JSON.stringify(item('1', 'https://a.test/alpha'))]);
    type('b');
    await act(() => vi.advanceTimersByTimeAsync(150));
    type('alp');
    await act(() => vi.advanceTimersByTimeAsync(150));
    await act(async () => resolveFirst([JSON.stringify(item('2', 'https://b.test/beta'))]));
    expect(urls()).toEqual(['https://a.test/alpha']);
  });
});
