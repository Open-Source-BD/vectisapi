import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../lib/native/invoke', async (orig) => ({
  ...(await orig<typeof import('../../lib/native/invoke')>()),
  sendRequest: vi.fn(),
  cancelRequest: vi.fn(),
  addHistory: vi.fn(async () => {}),
}));

import { cancelRequest, sendRequest } from '../../lib/native/invoke';
import { executeActiveSend } from '../../lib/sendActive';
import { createDefaultTab, selectActiveTab, useApiStore } from '../../store/useApiStore';
import type { ResponseMeta, TabState } from '../../types';
import { UrlBar } from './UrlBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockSend = vi.mocked(sendRequest);
const mockCancel = vi.mocked(cancelRequest);

function nativeRes(body: string) {
  const prefix = new TextEncoder().encode(body);
  const meta: ResponseMeta = {
    responseId: 'resp-1',
    status: 200,
    statusText: 'OK',
    httpVersion: 'HTTP/1.1',
    headers: [],
    remoteAddr: null,
    finalUrl: 'https://two.test/',
    size: prefix.length,
    timing: { totalMs: 5, ttfbMs: 2 },
    truncated: false,
  };
  return { meta, prefix };
}

const tab = (id: string, url: string): TabState => ({ ...createDefaultTab(), id, url });
const tabById = (id: string) => useApiStore.getState().tabs.find((t) => t.id === id)!;

describe('UrlBar send / cancel', () => {
  let root: Root;
  let host: HTMLElement;
  const sendBtn = () => host.querySelector<HTMLButtonElement>('.send-btn')!;
  const click = (el: HTMLElement) => act(async () => el.click());

  beforeEach(() => {
    mockSend.mockReset().mockImplementation(() => new Promise(() => {})); // never answers
    mockCancel.mockReset().mockResolvedValue(true);
    useApiStore.setState({
      tabs: [tab('t1', 'https://one.test/'), tab('t2', 'https://two.test/')],
      activeTabId: 't1',
      loadingTabs: {},
      history: [],
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<UrlBar send={() => void executeActiveSend()} />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('while sending, the Send button turns into Cancel; clicking it aborts with the cancelled response', async () => {
    expect(sendBtn().textContent).toContain('Send');
    await click(sendBtn());
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(sendBtn().className).toBe('md-filled-btn send-btn');
    expect(sendBtn().disabled).toBe(false);
    expect(sendBtn().querySelector('.material-symbols-outlined')?.textContent).toBe('close');
    expect(sendBtn().textContent).toContain('Cancel');

    await click(sendBtn());
    expect(mockCancel).toHaveBeenCalledWith(mockSend.mock.calls[0][0].requestId);
    expect(tabById('t1').response).toMatchObject({ status: 0, errorKind: 'cancelled', rawText: 'Request cancelled' });
    expect(useApiStore.getState().loadingTabs).toEqual({});
    expect(sendBtn().textContent).toContain('Send');
  });

  it('Escape in the URL field cancels the send', async () => {
    await click(sendBtn());
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Request URL"]')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(tabById('t1').response).toMatchObject({ errorKind: 'cancelled' });
    expect(sendBtn().textContent).toContain('Send');
  });

  it('Escape does nothing when not sending', async () => {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Request URL"]')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(mockCancel).not.toHaveBeenCalled();
    expect(tabById('t1').response).toBeNull();
  });

  it('another tab can send while the first is still loading; each result lands on its own tab', async () => {
    await click(sendBtn()); // t1: never answers
    act(() => useApiStore.getState().setActiveTab('t2'));
    expect(sendBtn().textContent).toContain('Send');

    mockSend.mockResolvedValueOnce(nativeRes('{"two":true}'));
    await click(sendBtn());
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(tabById('t2').response).toMatchObject({ status: 200, rawText: '{"two":true}' });
    expect(tabById('t1').response).toBeNull();
    expect(selectActiveTab(useApiStore.getState()).id).toBe('t2');
    expect(useApiStore.getState().loadingTabs).toEqual({ t1: true });

    act(() => useApiStore.getState().setActiveTab('t1'));
    expect(sendBtn().textContent).toContain('Cancel');
    await click(sendBtn());
    expect(tabById('t1').response).toMatchObject({ errorKind: 'cancelled' });
    expect(useApiStore.getState().loadingTabs).toEqual({});
  });
});
