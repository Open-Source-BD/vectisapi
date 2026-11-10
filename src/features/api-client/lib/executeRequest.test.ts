import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./proxyClient', async (orig) => ({
  ...(await orig<typeof import('./proxyClient')>()),
  sendViaProxy: vi.fn(),
  sendDirect: vi.fn(),
}));

import { sendViaProxy, sendDirect } from './proxyClient';
import { executeRequest } from './executeRequest';
import { createDefaultTab } from '../store/useApiStore';

const mockSend = sendViaProxy as unknown as ReturnType<typeof vi.fn>;
const mockDirect = sendDirect as unknown as ReturnType<typeof vi.fn>;

function proxyRes(body: string, status = 200, extra: Record<string, unknown> = {}) {
  return {
    ok: status < 400,
    status,
    statusText: 'OK',
    timeTaken: 5,
    size: body.length,
    rawText: body,
    headers: {},
    finalUrl: 'http://example.test',
    transport: 'proxy',
    ...extra,
  };
}

const CF_BODY = '<title>Just a moment...</title> challenges.cloudflare.com';

beforeEach(() => {
  mockSend.mockReset();
  mockDirect.mockReset();
});

describe('executeRequest', () => {
  it('happy path returns response and runs tests', async () => {
    mockSend.mockResolvedValue(proxyRes('{"id":1}'));
    const tab = createDefaultTab();
    tab.url = 'http://example.test';
    tab.tests = 'pm.test("ok", () => pm.expect(pm.response.code).to.eql(200))';
    const r = await executeRequest(tab, []);
    expect(r.response?.status).toBe(200);
    expect(r.response?.transport).toBe('proxy');
    expect(r.response?.testResults[0]).toMatchObject({ name: 'ok', pass: true });
    expect(mockDirect).not.toHaveBeenCalled();
  });

  it('pre-request script error returns {phase:pre-request} and does not send', async () => {
    const tab = createDefaultTab();
    tab.scripts = 'throw new Error("boom")';
    const r = await executeRequest(tab, []);
    expect(r.error?.phase).toBe('pre-request');
    expect(r.response).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('pre-request variable mutation reaches sendViaProxy (latent bug fix)', async () => {
    mockSend.mockResolvedValue(proxyRes('{}'));
    const tab = createDefaultTab();
    tab.scripts = 'pm.environment.set("tok", "T1")';
    await executeRequest(tab, []);
    const varsArg = mockSend.mock.calls[0][1] as { key: string; value: string }[];
    expect(varsArg.find((v) => v.key === 'tok')?.value).toBe('T1');
  });

  it('send failure returns {phase:send} with null response', async () => {
    mockSend.mockRejectedValueOnce(new Error('network down'));
    const tab = createDefaultTab();
    const r = await executeRequest(tab, []);
    expect(r.response).toBeNull();
    expect(r.error?.phase).toBe('send');
  });

  it('forwards script env writes to onSetVar', async () => {
    mockSend.mockResolvedValue(proxyRes('{}'));
    const onSet = vi.fn();
    const tab = createDefaultTab();
    tab.scripts = 'pm.environment.set("a", "b")';
    await executeRequest(tab, [], { onSetVar: onSet });
    expect(onSet).toHaveBeenCalledWith('a', 'b');
  });

  // --- Bot-wall fallback ---

  it('GET challenge + directFallback:auto + no cookie → auto-retries browser-direct', async () => {
    mockSend.mockResolvedValue(proxyRes(CF_BODY, 403));
    mockDirect.mockResolvedValue(proxyRes('{"real":true}', 200, { transport: 'direct' }));
    const tab = createDefaultTab(); // GET by default
    const r = await executeRequest(tab, [], { directFallback: 'auto' });
    expect(mockDirect).toHaveBeenCalledTimes(1);
    expect(r.response?.transport).toBe('direct');
    expect(r.response?.rawText).toBe('{"real":true}');
    expect(r.challenge).toBeUndefined();
  });

  it('GET challenge + jar cookie → reports challenge, does NOT auto-direct', async () => {
    mockSend.mockResolvedValue(proxyRes(CF_BODY, 403));
    const tab = createDefaultTab();
    const r = await executeRequest(tab, [], { directFallback: 'auto', cookieHeader: 'sid=1' });
    expect(mockDirect).not.toHaveBeenCalled();
    expect(r.response).toBeNull();
    expect(r.challenge).toMatchObject({ vendor: 'Cloudflare', directEligible: false });
  });

  it('POST challenge + auto → reports challenge (eligible) but does NOT auto-send', async () => {
    mockSend.mockResolvedValue(proxyRes(CF_BODY, 403));
    const tab = createDefaultTab();
    tab.method = 'POST';
    const r = await executeRequest(tab, [], { directFallback: 'auto' });
    expect(mockDirect).not.toHaveBeenCalled();
    expect(r.challenge).toMatchObject({ vendor: 'Cloudflare', method: 'POST', directEligible: true });
  });

  it('challenge with directFallback off (runner default) → reports challenge', async () => {
    mockSend.mockResolvedValue(proxyRes(CF_BODY, 403));
    const tab = createDefaultTab();
    const r = await executeRequest(tab, []); // no directFallback → 'off'
    expect(mockDirect).not.toHaveBeenCalled();
    expect(r.challenge?.vendor).toBe('Cloudflare');
  });

  it('forceDirect sends straight via sendDirect (manual retry)', async () => {
    mockDirect.mockResolvedValue(proxyRes('{"direct":1}', 200, { transport: 'direct' }));
    const tab = createDefaultTab();
    const r = await executeRequest(tab, [], { forceDirect: true });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDirect).toHaveBeenCalledTimes(1);
    expect(r.response?.transport).toBe('direct');
  });

  it('auto-direct retry that throws (CORS) returns the honest failure message', async () => {
    mockSend.mockResolvedValue(proxyRes(CF_BODY, 403));
    mockDirect.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const tab = createDefaultTab();
    const r = await executeRequest(tab, [], { directFallback: 'auto' });
    expect(r.response).toBeNull();
    expect(r.error?.phase).toBe('send');
    expect(r.error?.message).toMatch(/browser could not reach the target/i);
  });
});
