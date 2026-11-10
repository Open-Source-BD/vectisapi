import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./native/invoke', () => ({
  sendRequest: vi.fn(),
  cancelRequest: vi.fn(),
  getResponseBody: vi.fn(),
}));

import { sendRequest, cancelRequest, getResponseBody } from './native/invoke';
import { executeRequest } from './executeRequest';
import { createDefaultTab } from '../store/useApiStore';
import type { HttpRequestSpec, ResponseMeta } from '../types';

const mockSend = vi.mocked(sendRequest);
const mockCancel = vi.mocked(cancelRequest);
const mockBody = vi.mocked(getResponseBody);

function nativeRes(body: string, over: Partial<ResponseMeta> = {}) {
  const prefix = new TextEncoder().encode(body);
  const meta: ResponseMeta = {
    responseId: 'resp-1',
    status: 200,
    statusText: 'OK',
    httpVersion: 'HTTP/1.1',
    headers: [],
    remoteAddr: null,
    finalUrl: 'http://example.test/',
    size: prefix.length,
    timing: { totalMs: 5, ttfbMs: 2 },
    truncated: false,
    ...over,
  };
  return { meta, prefix };
}

const sentSpec = (call = 0) => mockSend.mock.calls[call][0] as HttpRequestSpec;

beforeEach(() => {
  mockSend.mockReset();
  mockCancel.mockReset().mockResolvedValue(true);
  mockBody.mockReset();
});

describe('executeRequest', () => {
  it('happy path returns response and runs tests', async () => {
    mockSend.mockResolvedValue(nativeRes('{"id":1}'));
    const tab = createDefaultTab();
    tab.url = 'http://example.test';
    tab.tests = 'pm.test("ok", () => pm.expect(pm.response.code).to.eql(200))';
    const r = await executeRequest(tab, []);
    expect(r.response?.status).toBe(200);
    expect(r.response?.rawText).toBe('{"id":1}');
    expect(r.response?.testResults[0]).toMatchObject({ name: 'ok', pass: true });
    expect(r.finalUrl).toBe('http://example.test/');
    expect(r.error).toBeUndefined();
  });

  it('pre-request script error returns {phase:pre-request} and does not send', async () => {
    const tab = createDefaultTab();
    tab.scripts = 'throw new Error("boom")';
    const r = await executeRequest(tab, []);
    expect(r.error?.phase).toBe('pre-request');
    expect(r.response).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('pre-request variable mutation reaches the request spec', async () => {
    mockSend.mockResolvedValue(nativeRes('{}'));
    const tab = createDefaultTab();
    tab.url = 'http://example.test/{{tok}}';
    tab.scripts = 'pm.environment.set("tok", "T1")';
    await executeRequest(tab, []);
    expect(sentSpec().url).toBe('http://example.test/T1');
  });

  it('passes the timeout into the spec', async () => {
    mockSend.mockResolvedValue(nativeRes('{}'));
    const tab = createDefaultTab();
    tab.url = 'http://example.test';
    await executeRequest(tab, [], { timeoutMs: 1500 });
    expect(sentSpec().timeoutMs).toBe(1500);
  });

  it('unresolved var url yields error response', async () => {
    mockSend.mockRejectedValue({
      kind: 'invalid_url',
      message: 'invalid URL "{{base}}/x": relative URL without a base',
    });
    const tab = createDefaultTab();
    tab.url = '{{base}}/x';
    const r = await executeRequest(tab, []);
    expect(sentSpec().url).toBe('{{base}}/x');
    expect(r.response).toMatchObject({
      ok: false,
      status: 0,
      statusText: 'Error',
      rawText: 'invalid URL "{{base}}/x": relative URL without a base',
      errorKind: 'invalid_url',
      testResults: [],
    });
    expect(r.error).toEqual({ phase: 'send', message: 'invalid URL "{{base}}/x": relative URL without a base' });
  });

  it('a non-native rejection maps to kind other', async () => {
    mockSend.mockRejectedValue(new Error('ipc down'));
    const tab = createDefaultTab();
    tab.url = 'http://example.test';
    const r = await executeRequest(tab, []);
    expect(r.response).toMatchObject({ status: 0, rawText: 'ipc down', errorKind: 'other' });
  });

  it('tests receive full body when truncated', async () => {
    const full = JSON.stringify({ big: 'x'.repeat(50), tail: 'END' });
    mockSend.mockResolvedValue(nativeRes(full.slice(0, 10), { truncated: true, size: full.length }));
    mockBody.mockResolvedValue(new TextEncoder().encode(full));
    const tab = createDefaultTab();
    tab.url = 'http://example.test';
    tab.tests = 'pm.test("tail", () => pm.expect(pm.response.json().tail).to.eql("END"))';
    const r = await executeRequest(tab, []);
    expect(mockBody).toHaveBeenCalledTimes(1);
    expect(mockBody).toHaveBeenCalledWith('resp-1', 0);
    expect(r.response?.testResults[0]).toMatchObject({ name: 'tail', pass: true });
    // The pane keeps showing the inline prefix.
    expect(r.response?.rawText).toBe(full.slice(0, 10));
    expect(r.response?.truncated).toBe(true);
  });

  it('does not fetch the full body when there are no tests or it is not truncated', async () => {
    mockSend.mockResolvedValue(nativeRes('abc', { truncated: true, size: 10_000_000 }));
    const tab = createDefaultTab();
    tab.url = 'http://example.test';
    await executeRequest(tab, []);
    mockSend.mockResolvedValue(nativeRes('abc'));
    tab.tests = 'pm.test("t", () => {})';
    await executeRequest(tab, []);
    expect(mockBody).not.toHaveBeenCalled();
  });

  it('abort signal cancels', async () => {
    let rejectSend: (e: unknown) => void = () => {};
    mockSend.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    mockCancel.mockImplementation(async () => {
      rejectSend({ kind: 'cancelled', message: 'request cancelled' });
      return true;
    });
    const ctrl = new AbortController();
    const tab = createDefaultTab();
    tab.url = 'http://example.test';
    const pending = executeRequest(tab, [], { signal: ctrl.signal });
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
    ctrl.abort();
    const r = await pending;
    expect(mockCancel).toHaveBeenCalledWith(sentSpec().requestId);
    expect(r.response).toMatchObject({ status: 0, errorKind: 'cancelled' });
    expect(r.error?.phase).toBe('send');
  });

  it('an already-aborted signal does not send', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const tab = createDefaultTab();
    tab.url = 'http://example.test';
    const r = await executeRequest(tab, [], { signal: ctrl.signal });
    expect(mockSend).not.toHaveBeenCalled();
    expect(r.response).toMatchObject({ status: 0, errorKind: 'cancelled' });
  });

  it('forwards script env writes to onSetVar', async () => {
    mockSend.mockResolvedValue(nativeRes('{}'));
    const onSet = vi.fn();
    const tab = createDefaultTab();
    tab.scripts = 'pm.environment.set("a", "b")';
    await executeRequest(tab, [], { onSetVar: onSet });
    expect(onSet).toHaveBeenCalledWith('a', 'b');
  });
});
