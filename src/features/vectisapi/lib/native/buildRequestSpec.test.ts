import { describe, it, expect } from 'vitest';
import { buildRequestSpec, buildWsRequest } from './buildRequestSpec';
import type { EnvVar, TabState } from '../../types';

const vars: EnvVar[] = [
  { id: '1', key: 'base', value: 'https://api.x' },
  { id: '2', key: 'tok', value: 'T9' },
];

const tab = (over: Partial<TabState> = {}): TabState => ({
  id: 'r',
  method: 'GET',
  url: '{{base}}/users',
  params: [],
  headers: [],
  auth: {
    type: 'none',
    bearer: '',
    basicUser: '',
    basicPass: '',
    apiKeyName: '',
    apiKeyValue: '',
    apiKeyIn: 'header',
    oauthToken: '',
    jwtToken: '',
    jwtPrefix: 'Bearer',
  },
  body: { type: 'none', formdata: [], urlencoded: [], rawContent: '', rawType: 'application/json' },
  scripts: '',
  tests: '',
  response: null,
  activeSubTab: 'params',
  activeResTab: 'body',
  ...over,
});

const build = (t: TabState, timeoutMs?: number) => buildRequestSpec(t, vars, 'req-1', timeoutMs);

/** Case-insensitive lookup of every value of a header, in order. */
const headerValues = (headers: [string, string][], name: string) =>
  headers.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
const header = (headers: [string, string][], name: string) => headerValues(headers, name)[0];

const auth = (over: Partial<TabState['auth']>) => ({ auth: { ...tab().auth, ...over } });

describe('buildRequestSpec', () => {
  it('carries request id, method and timeout', () => {
    const s = build(tab(), 1234);
    expect(s.requestId).toBe('req-1');
    expect(s.method).toBe('GET');
    expect(s.timeoutMs).toBe(1234);
    expect(build(tab()).timeoutMs).toBeNull();
  });

  it('resolves env in url + params', () => {
    const s = build(tab({ params: [{ id: 'p', key: 'q', value: '{{tok}}', type: 'text' }] }));
    expect(s.url).toBe('https://api.x/users?q=T9');
  });

  it('appends params to an existing query and skips empty keys', () => {
    const s = build(
      tab({
        url: 'https://api.x/u?a=1',
        params: [
          { id: 'p', key: 'b', value: '2' },
          { id: 'q', key: '', value: 'ignored' },
        ],
      }),
    );
    expect(s.url).toBe('https://api.x/u?a=1&b=2');
  });

  it('prepends http:// when the url has no scheme', () => {
    expect(build(tab({ url: 'localhost:3000/x' })).url).toBe('http://localhost:3000/x');
  });

  it('passes an unresolved base url through unchanged so the engine reports invalid_url', () => {
    expect(() => build(tab({ url: '{{missing}}/x' }))).not.toThrow();
    expect(build(tab({ url: '{{missing}}/x' })).url).toBe('{{missing}}/x');
  });

  it('applies bearer auth with env resolution', () => {
    const s = build(tab(auth({ type: 'bearer', bearer: '{{tok}}' })));
    expect(header(s.headers, 'Authorization')).toBe('Bearer T9');
  });

  it('applies basic auth (base64)', () => {
    const s = build(tab(auth({ type: 'basic', basicUser: 'u', basicPass: 'p' })));
    expect(header(s.headers, 'Authorization')).toBe(`Basic ${btoa('u:p')}`);
  });

  it('basic auth base64 handles unicode', () => {
    const s = build(tab(auth({ type: 'basic', basicUser: 'üser', basicPass: 'pä😀' })));
    const bytes = new TextEncoder().encode('üser:pä😀');
    expect(header(s.headers, 'Authorization')).toBe(`Basic ${btoa(String.fromCharCode(...bytes))}`);
  });

  it('applies apikey in query vs header', () => {
    const q = build(tab(auth({ type: 'apikey', apiKeyName: 'k', apiKeyValue: 'v', apiKeyIn: 'query' })));
    expect(q.url).toContain('k=v');
    const h = build(tab(auth({ type: 'apikey', apiKeyName: 'X-Key', apiKeyValue: 'v', apiKeyIn: 'header' })));
    expect(header(h.headers, 'X-Key')).toBe('v');
  });

  it('applies oauth2 token as bearer', () => {
    const s = build(tab(auth({ type: 'oauth2', oauthToken: '{{tok}}' })));
    expect(header(s.headers, 'Authorization')).toBe('Bearer T9');
  });

  it('applies jwt with prefix, and bare when prefix is empty', () => {
    const p = build(tab(auth({ type: 'jwt', jwtToken: 'J', jwtPrefix: 'JWT' })));
    expect(header(p.headers, 'Authorization')).toBe('JWT J');
    const bare = build(tab(auth({ type: 'jwt', jwtToken: 'J', jwtPrefix: '  ' })));
    expect(header(bare.headers, 'Authorization')).toBe('J');
  });

  it('auth replaces a user Authorization header instead of duplicating it', () => {
    const s = build(
      tab({ headers: [{ id: 'h', key: 'authorization', value: 'old' }], ...auth({ type: 'bearer', bearer: 'new' }) }),
    );
    expect(headerValues(s.headers, 'Authorization')).toEqual(['Bearer new']);
  });

  it('no auth adds no Authorization header', () => {
    expect(header(build(tab()).headers, 'Authorization')).toBeUndefined();
  });

  it('headers keep duplicates in order', () => {
    const s = build(
      tab({
        headers: [
          { id: '1', key: 'X-A', value: '1' },
          { id: '2', key: 'X-B', value: '{{tok}}' },
          { id: '3', key: 'X-A', value: '2' },
          { id: '4', key: '', value: 'skipped' },
        ],
      }),
    );
    expect(s.headers).toEqual([
      ['X-A', '1'],
      ['X-B', 'T9'],
      ['X-A', '2'],
    ]);
  });

  it('builds a raw JSON body with Content-Type for POST', () => {
    const s = build(
      tab({
        method: 'POST',
        body: { type: 'raw', rawContent: '{"a":{{tok}}}', rawType: 'application/json', formdata: [], urlencoded: [] },
      }),
    );
    expect(s.body).toEqual({ type: 'text', value: '{"a":T9}' });
    expect(header(s.headers, 'Content-Type')).toBe('application/json');
  });

  it('keeps a user Content-Type over the raw default', () => {
    const s = build(
      tab({
        method: 'PUT',
        headers: [{ id: 'h', key: 'content-type', value: 'application/vnd.x+json' }],
        body: { type: 'raw', rawContent: '{}', rawType: 'application/json', formdata: [], urlencoded: [] },
      }),
    );
    expect(headerValues(s.headers, 'Content-Type')).toEqual(['application/vnd.x+json']);
  });

  it('GET with body type raw sends no body', () => {
    const s = build(
      tab({ body: { type: 'raw', rawContent: 'x', rawType: 'text/plain', formdata: [], urlencoded: [] } }),
    );
    expect(s.body).toEqual({ type: 'none' });
    expect(header(s.headers, 'Content-Type')).toBeUndefined();
  });

  it('builds a urlencoded body with its Content-Type default', () => {
    const s = build(
      tab({
        method: 'POST',
        body: {
          type: 'urlencoded',
          urlencoded: [
            { id: '1', key: 'a', value: '{{tok}}' },
            { id: '2', key: '', value: 'skip' },
            { id: '3', key: 'a', value: '2' },
          ],
          formdata: [],
          rawContent: '',
          rawType: 'application/json',
        },
      }),
    );
    expect(s.body).toEqual({
      type: 'urlEncoded',
      value: [
        ['a', 'T9'],
        ['a', '2'],
      ],
    });
    expect(header(s.headers, 'Content-Type')).toBe('application/x-www-form-urlencoded');
  });

  it('builds a graphql body as JSON with resolved query and parsed variables', () => {
    const s = build(
      tab({
        method: 'POST',
        body: {
          type: 'graphql',
          graphql: { query: 'query { u(id: "{{tok}}") }', variables: '{"n":1}' },
          formdata: [],
          urlencoded: [],
          rawContent: '',
          rawType: 'application/json',
        },
      }),
    );
    expect(s.body).toEqual({
      type: 'text',
      value: JSON.stringify({ query: 'query { u(id: "T9") }', variables: { n: 1 } }),
    });
    expect(header(s.headers, 'Content-Type')).toBe('application/json');
  });

  it('graphql with invalid variables JSON sends empty variables', () => {
    const s = build(
      tab({
        method: 'POST',
        body: {
          type: 'graphql',
          graphql: { query: 'q', variables: '{nope' },
          formdata: [],
          urlencoded: [],
          rawContent: '',
          rawType: 'application/json',
        },
      }),
    );
    expect(s.body).toEqual({ type: 'text', value: JSON.stringify({ query: 'q', variables: {} }) });
  });

  it('builds form-data as multipart text parts and adds no Content-Type', () => {
    const s = build(
      tab({
        method: 'POST',
        body: {
          type: 'formdata',
          formdata: [
            { id: 'k', key: 'f', value: '{{tok}}', type: 'text' },
            { id: 'e', key: '', value: 'skip', type: 'text' },
            // A file item without a chosen path is skipped.
            { id: 'u', key: 'upload', value: '', type: 'file' },
          ],
          urlencoded: [],
          rawContent: '',
          rawType: 'application/json',
        },
      }),
    );
    expect(s.body).toEqual({ type: 'multipart', value: [{ name: 'f', value: { type: 'text', value: 'T9' } }] });
    expect(header(s.headers, 'Content-Type')).toBeUndefined();
  });

  it('formdata file item emits File part with path', () => {
    const s = build(
      tab({
        method: 'POST',
        body: {
          type: 'formdata',
          formdata: [{ id: 'u', key: 'upload', value: '', type: 'file', filePath: '/tmp/a.png', fileName: 'a.png' }],
          urlencoded: [],
          rawContent: '',
          rawType: 'application/json',
        },
      }),
    );
    expect(s.body).toEqual({
      type: 'multipart',
      value: [{ name: 'upload', value: { type: 'file', value: { path: '/tmp/a.png', fileName: 'a.png' } } }],
    });
  });
});

describe('buildWsRequest', () => {
  it('keeps ws/wss as typed, resolves env, adds query + auth headers', () => {
    const r = buildWsRequest(
      tab({
        url: 'wss://h/s',
        params: [{ id: 'p', key: 'a', value: '{{tok}}', enabled: true } as never],
        headers: [{ id: 'h', key: 'X', value: '1', enabled: true } as never],
        auth: { ...tab().auth, type: 'bearer', bearer: '{{tok}}' },
      }),
      vars,
      'r',
    );
    expect(r).toEqual({
      url: 'wss://h/s?a=T9',
      headers: [
        ['X', '1'],
        ['Authorization', 'Bearer T9'],
      ],
    });
  });
  it('converts typed http(s) to ws(s) and rejects other schemes', () => {
    expect(buildWsRequest(tab({ url: '{{base}}/ws' }), vars, 'r')?.url).toBe('wss://api.x/ws');
    expect(buildWsRequest(tab({ url: 'http://l/ws' }), vars, 'r')?.url).toBe('ws://l/ws');
    expect(buildWsRequest(tab({ url: 'ftp://x' }), vars, 'r')).toBeNull();
    expect(buildWsRequest(tab({ url: 'example.com' }), vars, 'r')).toBeNull();
  });
});
