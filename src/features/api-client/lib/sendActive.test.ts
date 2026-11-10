import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createDefaultTab } from '../store/useApiStore';
import type { TabState } from '../types';

vi.mock('../store/useApiStore', async (orig) => {
  const actual = await orig<typeof import('../store/useApiStore')>();
  return {
    ...actual,
    selectActiveTab: (state: { tabs: TabState[]; activeTabId: string }) =>
      state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0],
    selectActiveVars: vi.fn(() => []),
    useApiStore: {
      getState: vi.fn(),
    },
  };
});

vi.mock('./executeRequest', () => ({
  executeRequest: vi.fn(),
}));

import { executeRequest } from './executeRequest';
import { executeActiveSend } from './sendActive';
import { useApiStore, selectActiveVars } from '../store/useApiStore';

const mockGetState = useApiStore.getState as ReturnType<typeof vi.fn>;

const defaultTab = () => ({
  ...createDefaultTab(),
  id: 't1',
  url: 'https://example.test',
});

const mockState = (overrides: Record<string, unknown> = {}) => {
  const tab = defaultTab();
  return {
    tabs: [tab],
    activeTabId: 't1',
    setIsLoading: vi.fn(),
    updateActiveTab: vi.fn(),
    setEnvVar: vi.fn(),
    addHistory: vi.fn(),
    settings: { timeoutMs: 4321 },
    ...overrides,
  };
};

function proxyRes(body: string, status = 200) {
  return {
    ok: status < 400,
    status,
    statusText: 'OK',
    timeTaken: 5,
    size: body.length,
    rawText: body,
    headers: {},
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  (selectActiveVars as ReturnType<typeof vi.fn>).mockReturnValue([]);
});

describe('executeActiveSend', () => {
  it('skips when tab has no url', async () => {
    const state = mockState();
    state.tabs[0].url = '';
    mockGetState.mockReturnValue(state);
    await executeActiveSend();
    expect(executeRequest).not.toHaveBeenCalled();
    expect(state.setIsLoading).not.toHaveBeenCalled();
  });

  it('skips non-http protocol tabs', async () => {
    const state = mockState();
    state.tabs[0].protocol = 'ws';
    mockGetState.mockReturnValue(state);
    await executeActiveSend();
    expect(executeRequest).not.toHaveBeenCalled();
    expect(state.setIsLoading).not.toHaveBeenCalled();
  });

  it('sets loading state and sends request', async () => {
    const mockExec = executeRequest as ReturnType<typeof vi.fn>;
    mockExec.mockResolvedValue({ response: proxyRes('{"ok":true}') });

    const state = mockState();
    mockGetState.mockReturnValue(state);

    await executeActiveSend();

    expect(state.setIsLoading).toHaveBeenCalledWith(true);
    expect(state.setIsLoading).toHaveBeenCalledWith(false);
    expect(executeRequest).toHaveBeenCalledOnce();
    expect(state.updateActiveTab).toHaveBeenCalledWith(
      expect.objectContaining({ response: expect.objectContaining({ status: 200 }) }),
    );
    expect(state.addHistory).toHaveBeenCalledOnce();
  });

  it('keeps response bodies out of the history snapshot', async () => {
    const mockExec = executeRequest as ReturnType<typeof vi.fn>;
    mockExec.mockResolvedValue({ response: proxyRes('{"new":true}') });

    const state = mockState();
    const headers = [{ id: 'h1', key: 'X-Trace', value: 'abc' }];
    Object.assign(state.tabs[0], {
      method: 'PUT',
      headers,
      response: { ...proxyRes('x'.repeat(1000)), testResults: [] },
      prevResponse: { ...proxyRes('y'.repeat(1000)), testResults: [] },
    });
    mockGetState.mockReturnValue(state);

    await executeActiveSend();
    const item = (state.addHistory as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(item.request.response).toBeNull();
    expect(item.request.prevResponse).toBeNull();
    // The request itself survives the clone.
    expect(item.request.url).toBe('https://example.test');
    expect(item.request.method).toBe('PUT');
    expect(item.request.headers).toEqual(headers);
  });

  it('leaves the timeout to the engine (live settings)', async () => {
    const mockExec = executeRequest as ReturnType<typeof vi.fn>;
    mockExec.mockResolvedValue({ response: proxyRes('{}'), finalUrl: 'https://example.test/' });

    const state = mockState();
    mockGetState.mockReturnValue(state);

    await executeActiveSend();
    expect(mockExec.mock.calls[0][2].timeoutMs).toBeUndefined();
    expect(state.addHistory).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.test/' }));
  });

  it('handles pre-request error', async () => {
    const mockExec = executeRequest as ReturnType<typeof vi.fn>;
    mockExec.mockResolvedValue({ error: { phase: 'pre-request', message: 'SyntaxError' } });

    const state = mockState();
    mockGetState.mockReturnValue(state);

    await executeActiveSend();
    expect(state.setIsLoading).toHaveBeenCalledWith(false);
    expect(state.updateActiveTab).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({ status: 0, statusText: 'Script Error', rawText: 'SyntaxError' }),
      }),
    );
  });

  it('writes error response when request fails', async () => {
    const mockExec = executeRequest as ReturnType<typeof vi.fn>;
    mockExec.mockResolvedValue({ error: { message: 'Network Error' } });

    const state = mockState();
    mockGetState.mockReturnValue(state);

    await executeActiveSend();
    expect(state.updateActiveTab).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({ status: 0, rawText: 'Network Error' }),
      }),
    );
  });

  it('writes the native error response when the send fails', async () => {
    const mockExec = executeRequest as ReturnType<typeof vi.fn>;
    const errRes = {
      ok: false,
      status: 0,
      statusText: 'Error',
      timeTaken: 0,
      size: 0,
      rawText: 'invalid URL',
      headers: {},
      testResults: [],
      errorKind: 'invalid_url',
    };
    mockExec.mockResolvedValue({ response: errRes, error: { phase: 'send', message: 'invalid URL' } });

    const state = mockState();
    mockGetState.mockReturnValue(state);

    await executeActiveSend();
    expect(state.updateActiveTab).toHaveBeenCalledWith(expect.objectContaining({ response: errRes }));
    expect(state.addHistory).not.toHaveBeenCalled();
  });

  it('prepends http:// when missing', async () => {
    const mockExec = executeRequest as ReturnType<typeof vi.fn>;
    mockExec.mockResolvedValue({ response: proxyRes('{}') });

    const state = mockState();
    state.tabs[0].url = 'example.test';
    mockGetState.mockReturnValue(state);

    await executeActiveSend();
    expect(state.updateActiveTab).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://example.test' }));
  });

  it('leaves an unresolved {{base}} url alone', async () => {
    const mockExec = executeRequest as ReturnType<typeof vi.fn>;
    mockExec.mockResolvedValue({ error: { phase: 'send', message: 'invalid URL' } });

    const state = mockState();
    state.tabs[0].url = '{{base}}/x';
    mockGetState.mockReturnValue(state);

    await executeActiveSend();
    expect(state.updateActiveTab).not.toHaveBeenCalledWith(expect.objectContaining({ url: expect.anything() }));
  });
});
