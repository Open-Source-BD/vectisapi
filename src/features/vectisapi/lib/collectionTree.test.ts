import { describe, expect, it } from 'vitest';
import {
  duplicateNode,
  findNode,
  insertNode,
  isDescendant,
  listContainers,
  listRequests,
  makeFolder,
  makeRequest,
  migrateCollections,
  moveNode,
  removeNode,
  updateNode,
} from './collectionTree';
import type { Collection, FolderNode, TabState } from '../types';

const tab = (): TabState => ({
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
});

function sample(): Collection[] {
  return [
    {
      id: 'c1',
      name: 'API',
      date: 'd',
      children: [
        {
          id: 'f1',
          type: 'folder',
          name: 'Auth',
          children: [{ id: 'req1', type: 'request', name: 'Login', request: tab() }],
        },
        { id: 'req2', type: 'request', name: 'Health', request: tab() },
      ],
    },
  ];
}

describe('collectionTree', () => {
  it('finds nested nodes', () => {
    expect(findNode(sample(), 'req1')?.name).toBe('Login');
    expect(findNode(sample(), 'f1')?.type).toBe('folder');
    expect(findNode(sample(), 'nope')).toBeNull();
  });

  it('lists requests under a collection, folder, or single request (depth-first)', () => {
    expect(listRequests(sample(), 'c1').map((r) => r.name)).toEqual(['Login', 'Health']);
    expect(listRequests(sample(), 'f1').map((r) => r.name)).toEqual(['Login']);
    expect(listRequests(sample(), 'req2').map((r) => r.name)).toEqual(['Health']);
    expect(listRequests(sample(), 'nope')).toEqual([]);
  });

  it('inserts into a collection root and a folder', () => {
    const node = makeRequest('New', tab());
    const intoCol = insertNode(sample(), 'c1', node);
    expect(findNode(intoCol, node.id)).toBeTruthy();
    const intoFolder = insertNode(sample(), 'f1', makeFolder('Sub'));
    const folder = findNode(intoFolder, 'f1') as FolderNode;
    expect(folder.children.some((c) => c.name === 'Sub')).toBe(true);
  });

  it('removes nodes recursively', () => {
    expect(findNode(removeNode(sample(), 'req1'), 'req1')).toBeNull();
  });

  it('updates (renames) a node', () => {
    const out = updateNode(sample(), 'req1', { name: 'Renamed' });
    expect(findNode(out, 'req1')?.name).toBe('Renamed');
  });

  it('moves a request into a folder', () => {
    const out = moveNode(sample(), 'req2', 'f1');
    const folder = findNode(out, 'f1') as FolderNode;
    expect(folder.children.some((c) => c.id === 'req2')).toBe(true);
  });

  it('blocks moving a folder into its own descendant', () => {
    const cols = insertNode(sample(), 'f1', makeFolder('Inner'));
    const inner = (findNode(cols, 'f1') as FolderNode).children.find((c) => c.type === 'folder')!;
    const out = moveNode(cols, 'f1', inner.id);
    // unchanged: f1 still at collection root
    expect((out[0].children[0] as FolderNode).id).toBe('f1');
  });

  it('isDescendant detects subtree membership', () => {
    const f = findNode(sample(), 'f1')!;
    expect(isDescendant(f, 'req1')).toBe(true);
    expect(isDescendant(f, 'req2')).toBe(false);
  });

  it('duplicates a node with fresh ids and a Copy name, beside the original', () => {
    const out = duplicateNode(sample(), 'req2');
    const names = out[0].children.map((c) => c.name);
    expect(names).toContain('Health Copy');
    // two distinct ids
    const reqs = out[0].children.filter((c) => c.name.startsWith('Health'));
    expect(reqs[0].id).not.toBe(reqs[1].id);
  });

  it('lists containers (collections + folders) with depth', () => {
    const entries = listContainers(sample());
    expect(entries).toEqual([
      { id: 'c1', name: 'API', depth: 0, kind: 'collection' },
      { id: 'f1', name: 'Auth', depth: 1, kind: 'folder' },
    ]);
  });

  it('migrates legacy flat collections into one collection', () => {
    const legacy = [{ id: 'old', name: 'Get Users', request: tab(), date: 'd' }];
    const out = migrateCollections(legacy);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('My Collection');
    expect(out[0].children[0].name).toBe('Get Users');
  });

  it('keeps already-migrated collections untouched', () => {
    const out = migrateCollections(sample());
    expect(out[0].id).toBe('c1');
  });
});
