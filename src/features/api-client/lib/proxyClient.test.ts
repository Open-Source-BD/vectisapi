import { describe, expect, it, vi, afterEach } from 'vitest';
import { sendDirect, sendViaProxy } from './proxyClient';
import { sanitizeDirectHeaders } from './buildProxyRequest';
import type { TabState } from '../types';

const tab = (over: Partial<TabState> = {}): TabState =>
  ({
    id: 't',
    method: 'GET',
    url: 'https://api.example.com/x',
    params: [],
    headers: [],
    auth: { type: 'none' } as TabState['auth'],
    body: { type: 'none', formdata: [], urlencoded: [], rawContent: '', rawType: 'application/json' },
    scripts: '',
    tests: '',
    response: null,
    activeSubTab: 'params',
    activeResTab: 'body',
    ...over,
  }) as TabState;

afterEach(() => vi.restoreAllMocks());

describe('sanitizeDirectHeaders', () => {
  it('strips forbidden and proxy-only headers, keeps the rest', () => {
    const h = new Headers();
    h.set('Authorization', 'Bearer x');
    h.set('Cookie', 'sid=1');
    h.set('X-Proxy-Cookie', 'sid=1');
    h.set('Host', 'evil.com');
    h.set('Content-Type', 'application/json');
    const out = sanitizeDirectHeaders(h);
    expect(out.get('authorization')).toBe('Bearer x');
    expect(out.get('content-type')).toBe('application/json');
    expect(out.has('cookie')).toBe(false);
    expect(out.has('x-proxy-cookie')).toBe(false);
    expect(out.has('host')).toBe(false);
  });
});

describe('sendDirect', () => {
  it('maps a fetch Response to a direct ProxyResult, client-timed', async () => {
    const res = new Response('{"ok":true}', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);

    const out = await sendDirect(tab(), []);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.com/x',
      expect.objectContaining({ method: 'GET', credentials: 'omit' }),
    );
    expect(out.transport).toBe('direct');
    expect(out.status).toBe(200);
    expect(out.rawText).toBe('{"ok":true}');
    expect(out.headers['content-type']).toBe('application/json');
    expect(out.timeTaken).toBeGreaterThanOrEqual(0);
    expect(out.finalUrl).toBe('https://api.example.com/x');
  });

  it('does not send a Cookie header on the direct fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    await sendDirect(tab({ headers: [{ id: 'c', key: 'Cookie', value: 'sid=1', type: 'text' }] }), []);
    const passedHeaders = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(passedHeaders.has('cookie')).toBe(false);
  });

  it('lets the browser set the multipart boundary (no Content-Type) for form-data', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    await sendDirect(
      tab({
        method: 'POST',
        body: {
          type: 'formdata',
          formdata: [{ id: 'k', key: 'f', value: 'x', type: 'text' }],
          urlencoded: [],
          rawContent: '',
          rawType: 'application/json',
        },
      }),
      [],
    );
    const passedHeaders = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(passedHeaders.has('content-type')).toBe(false);
  });

  it('propagates a fetch TypeError (CORS/network) to the caller', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(sendDirect(tab(), [])).rejects.toThrow(/Failed to fetch/);
  });
});

describe('sendViaProxy', () => {
  it('forwards a GET request through /api/proxy and maps the response', async () => {
    const upstream = new Response('{"ok":true}', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json', 'x-proxy-time': '42' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream);

    const out = await sendViaProxy(tab(), []);

    expect(fetchSpy).toHaveBeenCalledWith('/api/proxy', expect.objectContaining({ method: 'POST' }));
    const callHeaders = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(callHeaders.get('X-Proxy-Target-Url')).toBe('https://api.example.com/x');
    expect(callHeaders.get('X-Proxy-Method')).toBe('GET');
    expect(callHeaders.has('X-Proxy-Cookie')).toBe(false);

    expect(out.transport).toBe('proxy');
    expect(out.status).toBe(200);
    expect(out.rawText).toBe('{"ok":true}');
    expect(out.headers['content-type']).toBe('application/json');
    expect(out.headers['x-proxy-time']).toBeUndefined();
    expect(out.timeTaken).toBe(42);
    expect(out.finalUrl).toBe('https://api.example.com/x');
  });

  it('sets X-Proxy-Cookie from the cookie header argument', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await sendViaProxy(tab(), [], undefined, 'session=abc');

    const callHeaders = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Headers;
    expect(callHeaders.get('X-Proxy-Cookie')).toBe('session=abc');
  });

  it('does not set X-Proxy-Cookie when the tab has an explicit Cookie header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const t = tab({ headers: [{ id: 'c', key: 'Cookie', value: 'sid=1', type: 'text' }] });

    await sendViaProxy(t, [], undefined, 'session=abc');

    const callHeaders = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Headers;
    expect(callHeaders.has('X-Proxy-Cookie')).toBe(false);
  });

  it('lets the browser set the multipart boundary (no Content-Type) for form-data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    await sendViaProxy(
      tab({
        method: 'POST',
        body: {
          type: 'formdata',
          formdata: [{ id: 'k', key: 'f', value: 'x', type: 'text' }],
          urlencoded: [],
          rawContent: '',
          rawType: 'application/json',
        },
      }),
      [],
    );

    const callHeaders = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Headers;
    expect(callHeaders.has('Content-Type')).toBe(false);
  });

  it('propagates the abort signal to the proxy fetch', async () => {
    const ctrl = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, opts) =>
        new Promise<Response>((_resolve, reject) => {
          if (opts?.signal) {
            (opts.signal as AbortSignal).addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }
        }),
    );
    setTimeout(() => ctrl.abort(), 5);

    await expect(sendViaProxy(tab(), [], ctrl.signal)).rejects.toThrow(/Aborted|abort/);

    const callSignal = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).signal;
    expect(callSignal).toBe(ctrl.signal);
  });

  it('rejects when the proxy fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Network failure'));

    await expect(sendViaProxy(tab(), [])).rejects.toThrow(/Network failure/);
  });
});
