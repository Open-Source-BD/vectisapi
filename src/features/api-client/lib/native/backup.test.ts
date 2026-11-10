import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];

vi.mock('./invoke', async (orig) => ({
  ...(await orig<typeof import('./invoke')>()),
  exportBackup: vi.fn(async () => {
    calls.push('export_backup');
    return '/b.json';
  }),
  importBackup: vi.fn(async () => {
    calls.push('import_backup');
    return '/b.json';
  }),
}));
vi.mock('../../store/persistNative', () => ({
  flushNow: vi.fn(async () => {
    calls.push('flush');
  }),
  reloadWorkspace: vi.fn(async () => {
    calls.push('reload');
  }),
}));

import { exportAll, importAll, mergeWorkspace, toWorkspaceEntries } from './backup';
import type { Collection } from '../../types';

const col = (id: string, name = id) => ({ id, name, children: [], date: '' }) as Collection;

describe('backup', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('flushes pending edits before exporting', async () => {
    expect(await exportAll()).toBe('/b.json');
    expect(calls).toEqual(['flush', 'export_backup']);
  });

  it('flushes before importing, then reloads the store from the database', async () => {
    expect(await importAll()).toBe('/b.json');
    expect(calls).toEqual(['flush', 'import_backup', 'reload']);
  });
});

describe('toWorkspaceEntries', () => {
  it('drops leading folders before collections/ or environments/ and skips other files', () => {
    expect(
      toWorkspaceEntries([
        { path: 'ws/collections/000__A/_collection.json', text: 'a' },
        { path: 'environments/_globals.json', text: 'g' },
        { path: 'outer/ws/environments/000__P.secret.json', text: 's' },
        { path: 'package.json', text: '{}' },
      ]),
    ).toEqual([
      { path: 'collections/000__A/_collection.json', content: 'a' },
      { path: 'environments/_globals.json', content: 'g' },
      { path: 'environments/000__P.secret.json', content: 's' },
    ]);
  });
});

describe('mergeWorkspace', () => {
  it('puts imported entries first, replaces same ids, keeps existing global keys', () => {
    const merged = mergeWorkspace(
      {
        collections: [col('a', 'old A'), col('b')],
        environments: [{ id: 'e', name: 'old', vars: [] }],
        globals: [{ id: '1', key: 'k', value: 'mine' }],
      },
      {
        collections: [col('a', 'new A')],
        environments: [
          { id: 'e', name: 'new', vars: [] },
          { id: 'f', name: 'F', vars: [] },
        ],
        globals: [
          { id: '2', key: 'k', value: 'theirs' },
          { id: '3', key: 'z', value: 'new' },
        ],
      },
    );
    expect(merged.collections.map((c) => [c.id, c.name])).toEqual([
      ['a', 'new A'],
      ['b', 'b'],
    ]);
    expect(merged.environments.map((e) => e.name)).toEqual(['new', 'F']);
    expect(merged.globals.map((g) => [g.key, g.value])).toEqual([
      ['k', 'mine'],
      ['z', 'new'],
    ]);
  });
});
