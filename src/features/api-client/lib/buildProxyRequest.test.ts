import { describe, it, expect } from 'vitest';
import { buildProxyRequest } from './buildProxyRequest';
import type { EnvVar, TabState } from '../types';

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

describe('buildProxyRequest', () => {
  it('resolves env in url + params', () => {
    const b = buildProxyRequest(tab({ params: [{ id: 'p', key: 'q', value: '{{tok}}', type: 'text' }] }), vars);
    expect(b.finalUrl).toBe('https://api.x/users?q=T9');
    expect(b.method).toBe('GET');
  });

  it('applies bearer auth with env resolution', () => {
    const b = buildProxyRequest(tab({ auth: { ...tab().auth, type: 'bearer', bearer: '{{tok}}' } }), vars);
    expect(b.headers.get('Authorization')).toBe('Bearer T9');
  });

  it('applies basic auth (base64) and apikey in query vs header', () => {
    const basic = buildProxyRequest(
      tab({ auth: { ...tab().auth, type: 'basic', basicUser: 'u', basicPass: 'p' } }),
      vars,
    );
    expect(basic.headers.get('Authorization')).toBe(`Basic ${btoa('u:p')}`);
    const q = buildProxyRequest(
      tab({ auth: { ...tab().auth, type: 'apikey', apiKeyName: 'k', apiKeyValue: 'v', apiKeyIn: 'query' } }),
      vars,
    );
    expect(q.finalUrl).toContain('k=v');
    const h = buildProxyRequest(
      tab({ auth: { ...tab().auth, type: 'apikey', apiKeyName: 'X-Key', apiKeyValue: 'v', apiKeyIn: 'header' } }),
      vars,
    );
    expect(h.headers.get('X-Key')).toBe('v');
  });

  it('builds a raw JSON body with Content-Type for POST', () => {
    const b = buildProxyRequest(
      tab({
        method: 'POST',
        body: { type: 'raw', rawContent: '{"a":{{tok}}}', rawType: 'application/json', formdata: [], urlencoded: [] },
      }),
      vars,
    );
    expect(b.body).toBe('{"a":T9}');
    expect(b.headers.get('Content-Type')).toBe('application/json');
    expect(b.isFormData).toBe(false);
  });

  it('flags form-data so the caller can drop Content-Type', () => {
    const b = buildProxyRequest(
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
      vars,
    );
    expect(b.isFormData).toBe(true);
  });
});
