import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./native/invoke', () => ({
  sendRequest: vi.fn(),
  cancelRequest: vi.fn(),
  getResponseBody: vi.fn(),
}));

import { sendRequest } from './native/invoke';
import { runCollection, type RunResultItem } from './collectionRunner';
import { createDefaultTab } from '../store/useApiStore';
import type { HttpRequestSpec, RequestNode } from '../types';

const mockSend = vi.mocked(sendRequest);

function proxyRes(body: string, status = 200) {
  const prefix = new TextEncoder().encode(body);
  return {
    meta: {
      responseId: 'r',
      status,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [] as [string, string][],
      remoteAddr: null,
      finalUrl: 'http://example.test/',
      size: prefix.length,
      timing: { totalMs: 3, ttfbMs: 1 },
      truncated: false,
    },
    prefix,
  };
}

function reqNode(name: string, patch: Partial<ReturnType<typeof createDefaultTab>> = {}): RequestNode {
  const tab = { ...createDefaultTab(), url: 'http://example.test', ...patch };
  return { id: `n-${name}`, type: 'request', name, request: tab };
}

async function run(requests: RequestNode[], extra: Partial<Parameters<typeof runCollection>[0]> = {}) {
  const results: RunResultItem[] = [];
  let lastProgress = { current: 0, total: 0 };
  await runCollection({
    requests,
    seedVars: [],
    iterations: 1,
    signal: new AbortController().signal,
    onResult: (i) => results.push(i),
    onProgress: (current, total) => (lastProgress = { current, total }),
    ...extra,
  });
  return { results, lastProgress };
}

beforeEach(() => mockSend.mockReset());

describe('runCollection', () => {
  it('runs requests in order and reports progress', async () => {
    mockSend.mockResolvedValue(proxyRes('{}'));
    const { results, lastProgress } = await run([reqNode('a'), reqNode('b')]);
    expect(results.map((r) => r.name)).toEqual(['a', 'b']);
    expect(lastProgress).toEqual({ current: 2, total: 2 });
  });

  it('chains: a test var set in req1 reaches req2', async () => {
    mockSend.mockResolvedValue(proxyRes('{"id":"XYZ"}'));
    const req1 = reqNode('login', { tests: 'pm.environment.set("id", pm.response.json().id)' });
    const req2 = reqNode('use-token', { url: 'http://example.test/{{id}}' });
    await run([req1, req2]);
    expect((mockSend.mock.calls[1][0] as HttpRequestSpec).url).toBe('http://example.test/XYZ');
  });

  it('continues after a failed request (continue-on-failure)', async () => {
    mockSend.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(proxyRes('{}'));
    const { results } = await run([reqNode('a'), reqNode('b')]);
    expect(results).toHaveLength(2);
    expect(results[0].error).toBeTruthy();
    expect(results[0].status).toBe(0);
    expect(results[1].ok).toBe(true);
  });

  it('iterates once per data row and exposes pm.iterationData', async () => {
    mockSend.mockResolvedValue(proxyRes('{}'));
    const req = reqNode('echo', { url: 'http://example.test/{{n}}' });
    const { results } = await run([req], { dataRows: [{ n: '1' }, { n: '2' }] });
    expect(results).toHaveLength(2);
    expect(mockSend.mock.calls.map((c) => (c[0] as HttpRequestSpec).url)).toEqual([
      'http://example.test/1',
      'http://example.test/2',
    ]);
    expect(results.map((r) => r.iteration)).toEqual([1, 2]);
  });

  it('stops early when the signal is already aborted', async () => {
    mockSend.mockResolvedValue(proxyRes('{}'));
    const ctrl = new AbortController();
    ctrl.abort();
    const results: RunResultItem[] = [];
    await runCollection({
      requests: [reqNode('a')],
      seedVars: [],
      iterations: 1,
      signal: ctrl.signal,
      onResult: (i) => results.push(i),
      onProgress: () => {},
    });
    expect(results).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('reports a native send error as a failed item and continues', async () => {
    mockSend.mockRejectedValueOnce({ kind: 'timeout', message: 'request timed out' });
    mockSend.mockResolvedValue(proxyRes('{}'));
    const { results } = await run([reqNode('slow'), reqNode('next')]);
    expect(results[0]).toMatchObject({ name: 'slow', status: 0, ok: false, error: 'request timed out' });
    expect(results[1]).toMatchObject({ name: 'next', status: 200 });
  });

  it('passes the run timeout into each request spec', async () => {
    mockSend.mockResolvedValue(proxyRes('{}'));
    await run([reqNode('a')], { timeoutMs: 777 });
    expect((mockSend.mock.calls[0][0] as HttpRequestSpec).timeoutMs).toBe(777);
  });
});
