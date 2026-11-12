import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const fail = { import: false, reload: false };

vi.mock('./invoke', async (orig) => ({
  ...(await orig<typeof import('./invoke')>()),
  exportBackup: vi.fn(async () => {
    calls.push('export_backup');
    return '/b.json';
  }),
  importBackup: vi.fn(async () => {
    calls.push('import_backup');
    if (fail.import) throw { kind: 'other', message: 'bad backup' };
    return '/b.json';
  }),
  pickWorkspaceFiles: vi.fn(),
}));
vi.mock('../../store/persistNative', () => ({
  flushNow: vi.fn(async () => {
    calls.push('flush');
  }),
  reloadWorkspace: vi.fn(async () => {
    calls.push('reload');
    if (fail.reload) throw new Error('load failed');
  }),
  pausePersistence: vi.fn(() => {
    calls.push('pause_persistence');
  }),
  resumePersistence: vi.fn(() => {
    calls.push('resume_persistence');
  }),
}));

import {
  exportAll,
  importAll,
  importWorkspace,
  mergeWorkspace,
  RESTART_AFTER_IMPORT,
  toWorkspaceEntries,
} from './backup';
import { importBackup, pickWorkspaceFiles } from './invoke';
import { serializeWorkspace } from '../workspaceFile';
import { createDefaultTab, useApiStore } from '../../store/useApiStore';
import type { Collection } from '../../types';

const col = (id: string, name = id) => ({ id, name, children: [], date: '' }) as Collection;

describe('backup', () => {
  beforeEach(() => {
    calls.length = 0;
    fail.import = false;
    fail.reload = false;
  });

  it('flushes pending edits before exporting', async () => {
    expect(await exportAll()).toBe('/b.json');
    expect(calls).toEqual(['flush', 'export_backup']);
  });

  it('flushes, pauses persistence across the import and reload, then resumes', async () => {
    expect(await importAll()).toBe('/b.json');
    expect(calls).toEqual(['flush', 'pause_persistence', 'import_backup', 'reload', 'resume_persistence']);
  });

  it('a cancelled or failed import resumes persistence (the database is unchanged)', async () => {
    vi.mocked(importBackup).mockResolvedValueOnce(null);
    expect(await importAll()).toBeNull();
    expect(calls).toEqual(['flush', 'pause_persistence', 'resume_persistence']);

    calls.length = 0;
    fail.import = true;
    await expect(importAll()).rejects.toEqual({ kind: 'other', message: 'bad backup' });
    expect(calls).toEqual(['flush', 'pause_persistence', 'import_backup', 'resume_persistence']);
  });

  it('a failed reload keeps persistence paused and asks for a restart', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fail.reload = true;
    await expect(importAll()).rejects.toThrow(RESTART_AFTER_IMPORT);
    expect(RESTART_AFTER_IMPORT).toBe('Import finished — restart VectisAPI to load it');
    expect(calls).toEqual(['flush', 'pause_persistence', 'import_backup', 'reload']);
    warn.mockRestore();
  });
});

describe('importWorkspace', () => {
  it('drops form-data file paths but keeps file names', async () => {
    const request = {
      ...createDefaultTab(),
      method: 'POST' as const,
      url: 'https://x.test/upload',
    };
    request.body = {
      ...request.body,
      type: 'form-data' as never,
      formdata: [
        { id: 'f', key: 'doc', value: '', type: 'file', filePath: '/Users/someone/doc.pdf', fileName: 'doc.pdf' },
        { id: 't', key: 'note', value: 'hi' },
      ],
    };
    const collection = {
      id: 'np1',
      name: 'NP',
      date: '',
      children: [{ id: 'r1', type: 'request', name: 'Upload', request }],
    } as Collection;
    const files = serializeWorkspace({ collections: [collection], environments: [], globals: [] }).map((e) => ({
      path: `ws/${e.path}`,
      text: e.content,
    }));
    expect(files.some((f) => f.text.includes('/Users/someone/doc.pdf'))).toBe(true);
    vi.mocked(pickWorkspaceFiles).mockResolvedValue(files);
    useApiStore.setState({ collections: [], environments: [], globals: [] });

    expect(await importWorkspace('zip')).toEqual({ collections: 1, environments: 0 });
    const imported = useApiStore.getState().collections[0];
    expect(JSON.stringify(imported)).not.toContain('filePath');
    const node = imported.children[0];
    if (node.type !== 'request') throw new Error('expected a request');
    expect(node.request.body.formdata).toEqual([
      { id: 'f', key: 'doc', value: '', type: 'file', fileName: 'doc.pdf' },
      { id: 't', key: 'note', value: 'hi' },
    ]);
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
