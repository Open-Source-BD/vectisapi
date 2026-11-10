import { describe, expect, it, vi, beforeEach } from 'vitest';
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
  cookieJar: [],
});

const mockState = (overrides: Record<string, unknown> = {}) => {
  const tab = defaultTab();
  return {
    tabs: [tab],
    activeTabId: 't1',
    setIsLoading: vi.fn(),
    updateActiveTab: vi.fn(),
    setEnvVar: vi.fn(),
    captureCookies: vi.fn(),
    addHistory: vi.fn(),
    cookieJar: [],
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
    finalUrl: 'http://example.test',
    transport: 'proxy' as const,
  };
}

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

  it('captures cookies from proxy response', async () => {
    const mockExec = executeRequest as ReturnType<typeof vi.fn>;
    mockExec.mockResolvedValue({
      response: proxyRes('{}'),
      finalUrl: 'https://example.test',
    });

    const state = mockState();
    mockGetState.mockReturnValue(state);

    await executeActiveSend();
    expect(state.captureCookies).toHaveBeenCalledOnce();
  });

  it('handles pre-request error', async () => {
    const mockExec = executeRequest as ReturnType<typeof vi.fn>;
    mockExec.mockResolvedValue({ error: { phase: 'pre-request', message: 'SyntaxError' } });

    const state = mockState();
    mockGetState.mockReturnValue(state);

    await executeActiveSend();
    expect(state.setIsLoading).toHaveBeenCalledWith(false);
    expect(state.updateActiveTab).not.toHaveBeenCalled();
  });

  it('handles challenge response', async () => {
    const mockExec = executeRequest as ReturnType<typeof vi.fn>;
    mockExec.mockResolvedValue({
      challenge: { vendor: 'cloudflare' as const },
    });

    const state = mockState();
    mockGetState.mockReturnValue(state);

    await executeActiveSend();
    expect(state.updateActiveTab).toHaveBeenCalledWith(
      expect.objectContaining({ challenge: { vendor: 'cloudflare' } }),
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

  it('handles forceDirect retry failure', async () => {
    const mockExec = executeRequest as ReturnType<typeof vi.fn>;
    mockExec.mockResolvedValue({ error: { message: 'Failed' } });

    const state = mockState();
    state.tabs[0].challenge = { vendor: 'cloudflare' } as never;
    mockGetState.mockReturnValue(state);

    await executeActiveSend({ forceDirect: true });
    expect(state.updateActiveTab).toHaveBeenCalledWith(
      expect.objectContaining({
        challenge: expect.objectContaining({ retryError: 'Failed' }),
      }),
    );
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
});
