import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useApiStore } from '../../store/useApiStore';
import { HistoryPanel } from './HistoryPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (id: string, url: string, method: 'GET' | 'POST' = 'GET') => ({
  id,
  method,
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
    useApiStore.setState({
      history: [
        item('1', 'https://example.com/users'),
        item('2', 'https://b.test/beta', 'POST'),
        item('3', 'https://c.test/gamma'),
      ],
      historySearch: '',
    });
    host = document.createElement('div');
    root = createRoot(host);
    act(() => root.render(<HistoryPanel />));
  });
  afterEach(() => {
    act(() => root.unmount());
  });

  it('a mid-word substring matches immediately ("ample" finds example.com)', () => {
    expect(urls()).toHaveLength(3);
    type('ample');
    expect(urls()).toEqual(['https://example.com/users']);
  });

  it('matches the method and ignores case; results update in place as the query changes', () => {
    type('post');
    expect(urls()).toEqual(['https://b.test/beta']);
    type('GAM');
    expect(urls()).toEqual(['https://c.test/gamma']);
    type('  ');
    expect(urls()).toHaveLength(3);
  });

  it('shows "No matches." and drops a deleted item from the results', () => {
    type('nothing-like-this');
    expect(host.textContent).toContain('No matches.');
    type('test');
    expect(urls()).toEqual(['https://b.test/beta', 'https://c.test/gamma']);
    act(() => useApiStore.getState().deleteHistoryItem('2'));
    expect(urls()).toEqual(['https://c.test/gamma']);
  });
});
