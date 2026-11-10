import { describe, expect, it } from 'vitest';
import { serializeWorkspace, deserializeWorkspace, type WorkspaceData } from './workspaceFile';
import type { Collection, TabState } from '../types';

const tab = (over: Partial<TabState> = {}): TabState => ({
  id: 'r',
  method: 'GET',
  url: 'https://x',
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

const sample = (): WorkspaceData => ({
  collections: [
    {
      id: 'c1',
      name: 'API',
      description: 'my api',
      date: '2020-01-01T00:00:00.000Z',
      children: [
        {
          id: 'f1',
          type: 'folder',
          name: 'Auth',
          children: [
            {
              id: 'req1',
              type: 'request',
              name: 'Login',
              request: tab({ id: 'req1', method: 'POST', url: '{{baseUrl}}/login' }),
            },
          ],
        },
        { id: 'req2', type: 'request', name: 'Health', request: tab({ id: 'req2', url: '{{baseUrl}}/health' }) },
      ],
    } as Collection,
  ],
  environments: [{ id: 'e1', name: 'Prod', vars: [{ id: 'v1', key: 'baseUrl', value: 'https://api.x' }] }],
  globals: [{ id: 'g1', key: 'apiKey', value: 'KKK' }],
});

describe('workspaceFile', () => {
  it('serializes to readable per-request files mirroring the tree', () => {
    const files = serializeWorkspace(sample());
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain('collections/000__API/_collection.json');
    expect(paths).toContain('collections/000__API/000__Auth/_folder.json');
    expect(paths).toContain('collections/000__API/000__Auth/000__Login.json');
    expect(paths).toContain('collections/000__API/001__Health.json');
    expect(paths).toContain('environments/000__Prod.json');
    expect(paths).toContain('environments/_globals.json');
    expect(paths).toContain('.gitignore');
    // id lives in content, not the filename
    const login = files.find((f) => f.path.endsWith('000__Login.json'))!;
    expect(JSON.parse(login.content).id).toBe('req1');
  });

  it('round-trips collections, folders, order, envs, and globals', () => {
    const data = sample();
    const back = deserializeWorkspace(serializeWorkspace(data));

    expect(back.collections).toHaveLength(1);
    const col = back.collections[0];
    expect({ id: col.id, name: col.name, description: col.description }).toEqual({
      id: 'c1',
      name: 'API',
      description: 'my api',
    });
    // order preserved: folder Auth (0) then Health (1)
    expect(col.children.map((c) => c.name)).toEqual(['Auth', 'Health']);
    const folder = col.children[0];
    expect(folder.type).toBe('folder');
    if (folder.type === 'folder') {
      expect(folder.children[0]).toMatchObject({ id: 'req1', name: 'Login' });
      expect((folder.children[0] as { request: TabState }).request.url).toBe('{{baseUrl}}/login');
    }
    expect(back.environments).toEqual(data.environments);
    expect(back.globals).toEqual(data.globals);
  });

  it('nulls file bodies (lossy, documented) on serialize', () => {
    const data = sample();
    data.collections[0].children.push({
      id: 'req3',
      type: 'request',
      name: 'Upload',
      request: tab({
        id: 'req3',
        method: 'POST',
        body: {
          type: 'formdata',
          formdata: [{ id: 'k', key: 'f', value: '', type: 'file', file: new File(['x'], 'x.txt') }],
          urlencoded: [],
          rawContent: '',
          rawType: 'application/json',
        },
      }),
    });
    const back = deserializeWorkspace(serializeWorkspace(data));
    const upload = back.collections[0].children.find((c) => c.name === 'Upload');
    const fd = (upload as { request: TabState }).request.body.formdata[0];
    expect(fd.type).toBe('file');
    expect(fd.file).toBeNull();
  });

  it('splits secret-named vars into gitignored *.secret.json, not the versioned file', () => {
    const data = sample();
    data.environments[0].vars.push({ id: 'v2', key: 'authToken', value: 'SECRET123' });
    const files = serializeWorkspace(data);

    const prodMain = files.find((f) => f.path === 'environments/000__Prod.json')!;
    const prodSecret = files.find((f) => f.path === 'environments/000__Prod.secret.json')!;
    const globalsSecret = files.find((f) => f.path === 'environments/_globals.secret.json')!;

    // baseUrl stays versioned; authToken does not appear in the committed file
    expect(prodMain.content).toContain('baseUrl');
    expect(prodMain.content).not.toContain('SECRET123');
    expect(prodSecret.content).toContain('SECRET123');
    // global apiKey is secret-named → goes to the secret file
    expect(globalsSecret.content).toContain('KKK');
    expect(files.find((f) => f.path === 'environments/_globals.json')!.content).not.toContain('KKK');

    // round-trip still reunites them
    const back = deserializeWorkspace(files);
    expect(back.environments[0].vars.find((v) => v.key === 'authToken')?.value).toBe('SECRET123');
    expect(back.globals.find((v) => v.key === 'apiKey')?.value).toBe('KKK');
  });

  it('returns empty workspace for empty input without throwing', () => {
    expect(deserializeWorkspace([])).toEqual({ collections: [], environments: [], globals: [] });
  });
});
