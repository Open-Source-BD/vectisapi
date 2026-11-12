import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../lib/native/invoke', async (orig) => ({
  ...(await orig<typeof import('../../lib/native/invoke')>()),
  getResponseBody: vi.fn(),
  saveResponseBody: vi.fn(),
}));

// A small "large body" threshold keeps the collapsed-tree test fast. Only ResponsePane sees it:
// CodeView keeps its own module-scoped value.
vi.mock('@/components/ui/CodeView', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/CodeView')>()),
  VIRTUALIZE_MIN_CHARS: 2_000,
}));

import { getResponseBody, saveResponseBody } from '../../lib/native/invoke';
import { useApiStore, selectActiveTab } from '../../store/useApiStore';
import { createDefaultTab } from '../../store/slices/helpers';
import type { ResponseData } from '../../types';
import { ResponsePane } from './ResponsePane';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockGetBody = vi.mocked(getResponseBody);
const mockSave = vi.mocked(saveResponseBody);

function response(over: Partial<ResponseData> = {}): ResponseData {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    timeTaken: 5,
    size: 7,
    rawText: '{"a":1}',
    headers: { 'content-type': 'application/json' },
    testResults: [],
    responseId: 'r1',
    truncated: false,
    finalUrl: 'https://api.test/v1/users.json',
    ...over,
  };
}

describe('ResponsePane large bodies', () => {
  let root: Root;
  let host: HTMLElement;

  const show = (res: ResponseData) => {
    const tab = { ...createDefaultTab(), response: res, activeResTab: 'body' as const };
    act(() => useApiStore.setState({ tabs: [tab], activeTabId: tab.id }));
  };
  const button = (label: string | RegExp) =>
    [...host.querySelectorAll('button')].find((b) =>
      typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? ''),
    );

  beforeEach(() => {
    mockGetBody.mockReset();
    mockSave.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<ResponsePane />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('truncated response shows Load full body with the formatted size', () => {
    show(response({ truncated: true, size: 13_002_342, rawText: '{"a":' }));
    expect(button('Load full body (12.4 MB)')).toBeDefined();
  });

  it('pretty view of a truncated (>2MB) body loads only after Load full body', async () => {
    show(response({ truncated: true, size: 3_000_000, rawText: '{"a":1}' }));
    expect(host.querySelector('.json-tree-view')).toBeNull();
    expect(host.querySelector('.json-key')).toBeNull(); // no highlighting of the preview
    expect(mockGetBody).not.toHaveBeenCalled();

    mockGetBody.mockResolvedValue(new TextEncoder().encode('{"a":1,"b":2}'));
    await act(async () => button(/^Load full body/)!.click());

    expect(mockGetBody).toHaveBeenCalledWith('r1');
    expect(host.querySelector('.json-tree-view')).not.toBeNull();
    const res = selectActiveTab(useApiStore.getState()).response!;
    expect(res.rawText).toBe('{"a":1,"b":2}');
    expect(res.truncated).toBe(false);
    expect(button(/^Load full body/)).toBeUndefined();
  });

  it('Download calls save_response_body with suggested name and never builds a Blob', async () => {
    const BlobSpy = vi.fn();
    vi.stubGlobal('Blob', BlobSpy);
    mockSave.mockResolvedValue('/tmp/users.json');
    show(response());
    await act(async () => button(/Download/)!.click());
    expect(mockSave).toHaveBeenCalledWith('r1', 'users.json');
    expect(BlobSpy).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('suggests response.<ext> from content-type when the URL has no file name', async () => {
    mockSave.mockResolvedValue(null);
    show(response({ finalUrl: 'https://api.test/', headers: { 'content-type': 'text/xml; charset=utf-8' } }));
    await act(async () => button(/Download/)!.click());
    expect(mockSave).toHaveBeenCalledWith('r1', 'response.xml');
    expect(host.querySelector('[role="alert"]')).toBeNull(); // cancel is a no-op
  });

  it('looks up content-type case-insensitively for the suggested name', async () => {
    mockSave.mockResolvedValue(null);
    show(response({ finalUrl: 'https://api.test/', headers: { 'Content-Type': 'Application/JSON' } }));
    await act(async () => button(/Download/)!.click());
    expect(mockSave).toHaveBeenCalledWith('r1', 'response.json');
  });

  it('Load full body shows a loading state, then an inline error when the fetch fails', async () => {
    let reject!: (e: unknown) => void;
    mockGetBody.mockImplementation(() => new Promise((_, r) => (reject = r)));
    show(response({ truncated: true, size: 3_000_000, rawText: '{"a":' }));
    await act(async () => button(/^Load full body/)!.click());
    const loadingBtn = button('Loading…');
    expect(loadingBtn).toBeDefined();
    expect(loadingBtn!.disabled).toBe(true);

    await act(async () => reject({ kind: 'other', message: 'Response body no longer available' }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Response body no longer available');
    expect(button(/^Load full body/)!.disabled).toBe(false);
    const res = selectActiveTab(useApiStore.getState()).response!;
    expect(res.truncated).toBe(true);
    expect(res.rawText).toBe('{"a":');
  });

  it('a loaded large JSON body opens the tree collapsed below the root', async () => {
    const big = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, name: `n${i}` })));
    expect(JSON.stringify(JSON.parse(big), null, 2).length).toBeGreaterThan(2_000);
    mockGetBody.mockResolvedValue(new TextEncoder().encode(big));
    show(response({ truncated: true, size: big.length, rawText: big.slice(0, 100) }));
    await act(async () => button(/^Load full body/)!.click());
    const branches = host.querySelectorAll('.jt-branch');
    // Root is open (its children are listed), each child object is collapsed.
    expect(host.querySelectorAll('.jt-collapsed').length).toBe(200);
    expect(branches[0].querySelector('.jt-collapsed')).toBeNull();
    expect(branches[0].querySelector('.jt-toggle')?.textContent).toBe('expand_more');
  });

  it('shows an inline error when the stored body was evicted', async () => {
    mockSave.mockRejectedValue({ kind: 'other', message: 'Response body no longer available' });
    show(response());
    await act(async () => button(/Download/)!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Response body no longer available');
  });
});

describe('ResponsePane timing popover', () => {
  let root: Root;
  let host: HTMLElement;
  const timed = { timing: { totalMs: 120, ttfbMs: 45 }, httpVersion: 'HTTP/2' };

  const show = (res: ResponseData) => {
    const tab = { ...createDefaultTab(), response: res, activeResTab: 'body' as const };
    act(() => useApiStore.setState({ tabs: [tab], activeTabId: tab.id }));
  };
  const time = () => host.querySelector<HTMLElement>('.metric-time')!;
  const trigger = () => host.querySelector<HTMLElement>('.timing-trigger');
  const popover = () => host.querySelector('.timing-popover');

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<ResponsePane />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('hovering time shows TTFB, download, total and HTTP version', () => {
    show(response(timed));
    expect(popover()).toBeNull();
    act(() => time().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    const text = popover()?.textContent ?? '';
    expect(text).toContain('Time to first byte45 ms');
    expect(text).toContain('Download75 ms');
    expect(text).toContain('Total120 ms');
    expect(text).toContain('HTTP versionHTTP/2');
    act(() => time().dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(popover()).toBeNull();
  });

  it('keyboard focus shows it, blur and Escape hide it', () => {
    show(response(timed));
    expect(trigger()?.tabIndex).toBe(0);
    act(() => trigger()!.focus());
    expect(popover()).not.toBeNull();
    expect(trigger()!.getAttribute('aria-describedby')).toBe(popover()!.id);
    act(() => {
      trigger()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(popover()).toBeNull();
    act(() => trigger()!.focus());
    act(() => trigger()!.blur());
    expect(popover()).toBeNull();
  });

  it('without timing there is no focusable trigger and no popover', () => {
    show(response());
    expect(trigger()).toBeNull();
    act(() => time().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(popover()).toBeNull();
  });
});
