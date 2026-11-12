import { describe, expect, it } from 'vitest';
import { parseCurl, tokenize } from './parseCurl';
import type { TabState } from '../types';

const base = (): TabState => ({
  id: 'b',
  method: 'GET',
  url: '',
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
});

describe('tokenize', () => {
  it('respects quotes and line continuations', () => {
    expect(tokenize('curl \'http://x\' \\\n  -H "a: b"')).toEqual(['curl', 'http://x', '-H', 'a: b']);
  });
});

describe('parseCurl', () => {
  it('parses method, url, headers', () => {
    const t = parseCurl("curl -X DELETE 'https://api/x' -H 'X-A: 1'", base());
    expect(t.method).toBe('DELETE');
    expect(t.url).toBe('https://api/x');
    expect(t.headers[0]).toMatchObject({ key: 'X-A', value: '1' });
  });

  it('infers POST when body present', () => {
    const t = parseCurl(`curl https://api/x -d '{"a":1}'`, base());
    expect(t.method).toBe('POST');
    expect(t.body.type).toBe('raw');
    expect(t.body.rawContent).toBe('{"a":1}');
  });

  it('maps Authorization: Bearer to bearer auth', () => {
    const t = parseCurl("curl https://api/x -H 'Authorization: Bearer abc'", base());
    expect(t.auth.type).toBe('bearer');
    expect(t.auth.bearer).toBe('abc');
    expect(t.headers).toHaveLength(0);
  });

  it('maps -u to basic auth', () => {
    const t = parseCurl('curl https://api/x -u user:pass', base());
    expect(t.auth).toMatchObject({ type: 'basic', basicUser: 'user', basicPass: 'pass' });
  });

  it('content-type header sets raw type', () => {
    const t = parseCurl(`curl https://api/x -H 'Content-Type: application/xml' -d '<a/>'`, base());
    expect(t.body.rawType).toBe('application/xml');
  });

  it('--data-urlencode → urlencoded body', () => {
    const t = parseCurl('curl https://api/x --data-urlencode q=hi', base());
    expect(t.body.type).toBe('urlencoded');
    expect(t.body.urlencoded[0]).toMatchObject({ key: 'q', value: 'hi' });
  });

  it('ignores boolean flags', () => {
    const t = parseCurl('curl -sL https://api/x --compressed', base());
    expect(t.url).toBe('https://api/x');
  });
});
