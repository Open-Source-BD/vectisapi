import { describe, expect, it } from 'vitest';
import { zipFiles, unzipFiles } from './zipWorkspace';
import { serializeWorkspace, deserializeWorkspace } from './workspaceFile';
import type { FileEntry } from './workspaceFile';
import type { Collection, Environment, TabState } from '../types';

/** Minimal request stub — serializeWorkspace only reads body.formdata + response. */
const stubRequest = (over: Partial<TabState>): TabState =>
  ({ body: { formdata: [] }, response: null, ...over }) as unknown as TabState;

const sample: FileEntry[] = [
  { path: 'collections/000__API/_collection.json', content: '{"id":"c1","name":"API"}' },
  { path: 'collections/000__API/000__Get.json', content: '{"id":"r1","name":"Get"}' },
  { path: 'environments/_globals.json', content: '[]' },
  { path: '.gitignore', content: '*.secret.json\n' },
];

async function toBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

describe('zipWorkspace round-trip', () => {
  it('round-trips entries with DEFLATE (default)', async () => {
    const blob = await zipFiles(sample);
    const out = await unzipFiles(await toBuffer(blob));
    expect(out).toEqual(sample);
  });

  it('round-trips entries with STORE (no compression)', async () => {
    const blob = await zipFiles(sample, { compress: false });
    const out = await unzipFiles(await toBuffer(blob));
    expect(out).toEqual(sample);
  });

  it('compresses highly-repetitive content with DEFLATE', async () => {
    const big: FileEntry[] = [{ path: 'environments/big.json', content: 'a'.repeat(5000) }];
    const compressed = await zipFiles(big);
    const stored = await zipFiles(big, { compress: false });
    expect(compressed.size).toBeLessThan(stored.size);
    expect(await unzipFiles(await toBuffer(compressed))).toEqual(big);
  });

  it('preserves UTF-8 content and paths', async () => {
    const utf: FileEntry[] = [{ path: 'environments/café.json', content: '{"emoji":"🚀","name":"naïve"}' }];
    const out = await unzipFiles(await toBuffer(await zipFiles(utf)));
    expect(out).toEqual(utf);
  });
});

describe('unzipFiles filtering', () => {
  it('skips files that are not .json or .gitignore', async () => {
    const mixed: FileEntry[] = [
      { path: 'collections/000__API/note.txt', content: 'ignore me' },
      { path: 'collections/000__API/_collection.json', content: '{"id":"c1","name":"API"}' },
    ];
    const out = await unzipFiles(await toBuffer(await zipFiles(mixed)));
    expect(out.map((f) => f.path)).toEqual(['collections/000__API/_collection.json']);
  });

  it('throws a clear error on a non-zip buffer', async () => {
    const junk = new TextEncoder().encode('this is not a zip file at all').buffer;
    await expect(unzipFiles(junk)).rejects.toThrow(/valid zip/i);
  });

  it('produces an empty list for an empty workspace zip', async () => {
    const out = await unzipFiles(await toBuffer(await zipFiles([])));
    expect(out).toEqual([]);
  });
});

describe('full workspace serialize → zip → unzip → deserialize', () => {
  it('round-trips collections, environments, and secret-split globals', async () => {
    const collections: Collection[] = [
      {
        id: 'col-1',
        name: 'My API',
        date: new Date(0).toISOString(),
        children: [
          {
            id: 'req-1',
            type: 'request',
            name: 'List users',
            request: stubRequest({ method: 'GET', url: 'https://example.com/users' }),
          },
        ],
      },
    ];
    const environments: Environment[] = [
      { id: 'env-1', name: 'Prod', vars: [{ id: 'v1', key: 'baseUrl', value: 'https://example.com' }] },
    ];
    const globals = [
      { id: 'g1', key: 'visible', value: 'ok' },
      { id: 'g2', key: 'apiKey', value: 'super-secret' },
    ];

    const files = serializeWorkspace({ collections, environments, globals });
    const blob = await zipFiles(files);
    const restored = deserializeWorkspace(await unzipFiles(await toBuffer(blob)));

    expect(restored.collections).toHaveLength(1);
    expect(restored.collections[0].id).toBe('col-1');
    expect(restored.collections[0].children[0].name).toBe('List users');
    expect(restored.environments[0].vars.map((v) => v.key)).toContain('baseUrl');
    // secret-named global ('apiKey') is split out then merged back on read
    expect(restored.globals.map((g) => g.key).sort()).toEqual(['apiKey', 'visible']);
  });
});
