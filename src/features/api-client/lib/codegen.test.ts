import { describe, expect, it } from 'vitest';
import { generateCode } from './codegen';
import type { EnvVar, TabState } from '../types';

const baseTab: TabState = {
  id: 't1',
  method: 'POST',
  url: 'https://{{host}}/users',
  params: [],
  headers: [{ id: 'h1', key: 'X-Custom', value: '{{ver}}' }],
  auth: {
    type: 'bearer',
    bearer: '{{token}}',
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
};

const env: EnvVar[] = [
  { id: '1', key: 'host', value: 'api.example.com' },
  { id: '2', key: 'ver', value: 'v1' },
  { id: '3', key: 'token', value: 'abc123' },
];

describe('generateCode (curl)', () => {
  it('resolves env in url, headers, and bearer auth', () => {
    const out = generateCode(baseTab, env);
    expect(out).toContain("curl -X POST 'https://api.example.com/users'");
    expect(out).toContain("-H 'X-Custom: v1'");
    expect(out).toContain("-H 'Authorization: Bearer abc123'");
  });

  it('omits Authorization when auth type is none', () => {
    const out = generateCode({ ...baseTab, auth: { ...baseTab.auth, type: 'none' } }, env);
    expect(out).not.toContain('Authorization');
  });
});

describe('generateCode (other languages)', () => {
  const withBody = {
    ...baseTab,
    body: {
      type: 'raw' as const,
      formdata: [],
      urlencoded: [],
      rawContent: '{"a":1}',
      rawType: 'application/json' as const,
    },
  };

  it('Fetch: method + headers + body', () => {
    const out = generateCode(withBody, env, 'fetch');
    expect(out).toContain('fetch("https://api.example.com/users"');
    expect(out).toContain('method: "POST"');
    expect(out).toContain('"Authorization": "Bearer abc123"');
    expect(out).toContain('body: `{"a":1}`');
  });

  it('Python requests: url + request call', () => {
    const out = generateCode(withBody, env, 'python');
    expect(out).toContain('import requests');
    expect(out).toContain('requests.request("POST", url');
  });

  it('Go: net/http NewRequest', () => {
    expect(generateCode(baseTab, env, 'go')).toContain('http.NewRequest("POST", "https://api.example.com/users"');
  });

  it('appends query params to the url', () => {
    const tabWithQuery = { ...baseTab, params: [{ id: 'p', key: 'q', value: 'hi there' }] };
    expect(generateCode(tabWithQuery, env, 'curl')).toContain('q=hi%20there');
  });

  it('API key in header', () => {
    const t = {
      ...baseTab,
      auth: {
        ...baseTab.auth,
        type: 'apikey' as const,
        apiKeyName: 'X-Api-Key',
        apiKeyValue: 'secret',
        apiKeyIn: 'header' as const,
      },
    };
    expect(generateCode(t, env, 'curl')).toContain("-H 'X-Api-Key: secret'");
  });

  it('API key in query', () => {
    const t = {
      ...baseTab,
      auth: {
        ...baseTab.auth,
        type: 'apikey' as const,
        apiKeyName: 'api_key',
        apiKeyValue: 'k1',
        apiKeyIn: 'query' as const,
      },
    };
    expect(generateCode(t, env, 'curl')).toContain('api_key=k1');
  });

  it('JWT with custom prefix', () => {
    const t = { ...baseTab, auth: { ...baseTab.auth, type: 'jwt' as const, jwtToken: 'eyJ', jwtPrefix: 'Token' } };
    expect(generateCode(t, env, 'curl')).toContain("-H 'Authorization: Token eyJ'");
  });
});
