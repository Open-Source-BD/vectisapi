import { describe, expect, it } from 'vitest';
import { fromPostman, isPostmanCollection, toPostman } from './postmanFormat';
import type { FolderNode, PostmanCollection, RequestNode } from '../types';

const pm: PostmanCollection = {
  info: { name: 'Demo', schema: 'x' },
  item: [
    {
      name: 'Auth',
      item: [
        {
          name: 'Login',
          request: {
            method: 'POST',
            header: [{ key: 'X-A', value: '1' }],
            url: { raw: 'https://api/login' },
            auth: { type: 'bearer', bearer: [{ key: 'token', value: 'abc' }] },
            body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } },
          },
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {})'] } }],
        },
      ],
    },
    {
      name: 'Health',
      request: { method: 'GET', url: { raw: 'https://api/health' } },
    },
  ],
};

describe('isPostmanCollection', () => {
  it('detects postman shape', () => {
    expect(isPostmanCollection(pm)).toBe(true);
    expect(isPostmanCollection({ collections: [] })).toBe(false);
    expect(isPostmanCollection(null)).toBe(false);
  });
});

describe('fromPostman', () => {
  it('maps folders, requests, auth, body, scripts', () => {
    const col = fromPostman(pm);
    expect(col.name).toBe('Demo');
    const auth = col.children[0] as FolderNode;
    expect(auth.type).toBe('folder');
    const login = auth.children[0] as RequestNode;
    expect(login.request.method).toBe('POST');
    expect(login.request.url).toBe('https://api/login');
    expect(login.request.headers[0]).toMatchObject({ key: 'X-A', value: '1' });
    expect(login.request.auth).toMatchObject({ type: 'bearer', bearer: 'abc' });
    expect(login.request.body).toMatchObject({ type: 'raw', rawContent: '{"a":1}', rawType: 'application/json' });
    expect(login.request.tests).toContain('pm.test');
  });
});

describe('round-trip toPostman(fromPostman)', () => {
  it('preserves structure and key fields', () => {
    const back = toPostman(fromPostman(pm));
    expect(back.info.name).toBe('Demo');
    expect(back.item[0].name).toBe('Auth');
    expect(back.item[0].item?.[0].name).toBe('Login');
    expect(back.item[0].item?.[0].request?.method).toBe('POST');
    expect(back.item[1].request?.url).toMatchObject({ raw: 'https://api/health' });
  });
});
