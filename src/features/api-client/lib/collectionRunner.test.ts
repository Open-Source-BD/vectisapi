import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./proxyClient', async (orig) => ({
  ...(await orig<typeof import('./proxyClient')>()),
  sendViaProxy: vi.fn(),
}));

import { sendViaProxy } from './proxyClient';
import { runCollection, type RunResultItem } from './collectionRunner';
import { createDefaultTab } from '../store/useApiStore';
import type { RequestNode } from '../types';

const mockSend = sendViaProxy as unknown as ReturnType<typeof vi.fn>;

function proxyRes(body: string, status = 200) {
  return {
    ok: status < 400,
    status,
    statusText: 'OK',
    timeTaken: 3,
    size: body.length,
    rawText: body,
    headers: {},
    finalUrl: 'http://example.test',
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
    const seen: { key: string; value: string }[][] = [];
    mockSend.mockImplementation(async (_tab: unknown, vars: { key: string; value: string }[]) => {
      seen.push(vars);
      return proxyRes('{"id":"XYZ"}');
    });
    const req1 = reqNode('login', { tests: 'pm.environment.set("id", pm.response.json().id)' });
    const req2 = reqNode('use-token');
    await run([req1, req2]);
    expect(seen[1].find((v) => v.key === 'id')?.value).toBe('XYZ');
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
    const seenN: (string | undefined)[] = [];
    mockSend.mockImplementation((async (...a: unknown[]) => {
      const vars = a[1] as { key: string; value: string }[] | undefined;
      seenN.push((vars ?? []).find((v) => v.key === 'n')?.value);
      return proxyRes('{}');
    }) as unknown as typeof sendViaProxy);
    const req = reqNode('echo');
    const { results } = await run([req], { dataRows: [{ n: '1' }, { n: '2' }] });
    expect(results).toHaveLength(2);
    expect(seenN).toEqual(['1', '2']);
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

  it('reports a bot-wall challenge as a failed item without switching transport', async () => {
    mockSend.mockResolvedValueOnce(proxyRes('<title>Just a moment...</title> challenges.cloudflare.com', 403));
    mockSend.mockResolvedValue(proxyRes('{}'));
    const { results } = await run([reqNode('blocked'), reqNode('next')]);
    expect(results[0]).toMatchObject({ name: 'blocked', status: 0, ok: false });
    expect(results[0].error).toMatch(/Cloudflare bot wall/i);
    // run continues to the next request (continue-on-failure)
    expect(results[1]).toMatchObject({ name: 'next', status: 200 });
  });
});
