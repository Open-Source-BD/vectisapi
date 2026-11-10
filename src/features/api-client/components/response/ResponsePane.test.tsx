import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../lib/native/invoke', async (orig) => ({
  ...(await orig<typeof import('../../lib/native/invoke')>()),
  getResponseBody: vi.fn(),
  saveResponseBody: vi.fn(),
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

  it('shows an inline error when the stored body was evicted', async () => {
    mockSave.mockRejectedValue({ kind: 'other', message: 'Response body no longer available' });
    show(response());
    await act(async () => button(/Download/)!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Response body no longer available');
  });
});
