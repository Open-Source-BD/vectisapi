import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/native/invoke', async (orig) => ({
  ...(await orig<typeof import('../lib/native/invoke')>()),
  loadWorkspace: vi.fn(),
  saveEntities: vi.fn(),
  flushDone: vi.fn(),
  onFlush: vi.fn(),
  getSettings: vi.fn(),
}));

import { flushDone, loadWorkspace, onFlush, saveEntities, type WorkspaceSnapshot } from '../lib/native/invoke';
import { diffToOps, flushNow, pausePersistence, resumePersistence, startPersistence } from './persistNative';
import { createDefaultTab, useApiStore } from './useApiStore';
import type { StoreState } from './slices/types';

const mockLoad = vi.mocked(loadWorkspace);
const mockSave = vi.mocked(saveEntities);
const mockFlushDone = vi.mocked(flushDone);
const mockOnFlush = vi.mocked(onFlush);

const col = (id: string) => ({ id, name: id, children: [] }) as unknown as StoreState['collections'][number];
const env = (id: string) => ({ id, name: id, vars: [] }) as unknown as StoreState['environments'][number];
const base = () => useApiStore.getState();
const withState = (patch: Partial<StoreState>): StoreState => ({ ...base(), ...patch });

function snapshot(over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    collections: [],
    environments: [],
    globals: [],
    activeEnvId: null,
    history: [],
    tabs: [],
    uiState: {},
    settings: { historyLimit: 500 } as never,
    ...over,
  };
}

describe('diffToOps', () => {
  it('emits only the changed collection', () => {
    const a = col('a');
    const b = col('b');
    const prev = withState({ collections: [a, b] });
    const next = withState({ collections: [a, { ...b, name: 'B2' } as never] });
    expect(diffToOps(prev, next)).toEqual([
      { op: 'upsertCollection', id: 'b', sort: 1, json: JSON.stringify({ ...b, name: 'B2' }) },
    ]);
  });

  it('emits DeleteCollection and DeleteEnvironment for removed ids', () => {
    const prev = withState({ collections: [col('a')], environments: [env('e1'), env('e2')] });
    const next = withState({ collections: [], environments: [prev.environments[0]] });
    expect(diffToOps(prev, next)).toEqual([
      { op: 'deleteCollection', id: 'a' },
      { op: 'deleteEnvironment', id: 'e2' },
    ]);
  });

  it('re-upserts unchanged items whose position moved', () => {
    const a = col('a');
    const b = col('b');
    const ops = diffToOps(withState({ collections: [a, b] }), withState({ collections: [b, a] }));
    expect(ops).toEqual([
      { op: 'upsertCollection', id: 'b', sort: 0, json: JSON.stringify(b) },
      { op: 'upsertCollection', id: 'a', sort: 1, json: JSON.stringify(a) },
    ]);
  });

  it('strips response and prevResponse from tabs', () => {
    const tab = { ...createDefaultTab(), response: { status: 200 }, prevResponse: { status: 1 } } as never;
    const ops = diffToOps(withState({ tabs: [] }), withState({ tabs: [tab] }));
    const replace = ops.find((o) => o.op === 'replaceTabs');
    expect(replace).toBeDefined();
    if (replace?.op !== 'replaceTabs') return;
    const stored = JSON.parse(replace.tabs[0][1]);
    expect(replace.tabs[0][0]).toBe((tab as { id: string }).id);
    expect(stored.response).toBeNull();
    expect(stored.prevResponse).toBeNull();
  });

  it('maps globals, active env, theme and active tab', () => {
    const prev = withState({ globals: [], activeEnvId: null, theme: 'light', activeTabId: 't1' });
    const next = withState({
      globals: [{ id: 'g', key: 'k', value: 'v' }] as never,
      activeEnvId: 'e1',
      theme: 'dark',
      activeTabId: 't2',
    });
    expect(diffToOps(prev, next)).toEqual([
      { op: 'setGlobals', json: JSON.stringify(next.globals) },
      { op: 'setActiveEnv', id: 'e1' },
      { op: 'setUiState', key: 'theme', json: '"dark"' },
      { op: 'setUiState', key: 'activeTabId', json: '"t2"' },
    ]);
  });

  it('never emits settings, cookies or history ops', () => {
    const next = withState({ settings: { historyLimit: 5 } as never, history: [] });
    expect(diffToOps(withState({ settings: null, history: [{ id: 'x' }] as never }), next)).toEqual([]);
  });
});

describe('startPersistence', () => {
  let flushHandler: (() => void) | undefined;
  const unlisten = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    flushHandler = undefined;
    mockLoad.mockResolvedValue(snapshot());
    mockSave.mockResolvedValue(undefined);
    mockFlushDone.mockResolvedValue(undefined);
    mockOnFlush.mockImplementation(async (h) => {
      flushHandler = h;
      return unlisten;
    });
    useApiStore.setState({ hydrated: false, collections: [], environments: [], persistNotice: null });
  });

  afterEach(async () => {
    await flushNow();
    vi.useRealTimers();
  });

  it('hydrates from the snapshot, including theme, active tab and settings', async () => {
    const tab = createDefaultTab();
    mockLoad.mockResolvedValue(
      snapshot({
        collections: [{ id: 'c1', name: 'C', children: [] }],
        tabs: [tab],
        uiState: { theme: 'dark', activeTabId: tab.id },
        history: [{ id: 'h1', method: 'GET', url: 'u', status: 200, time: 1, date: '2026-01-01' }],
      }),
    );
    const stop = await startPersistence();
    const s = base();
    expect(s.hydrated).toBe(true);
    expect(s.theme).toBe('dark');
    expect(s.activeTabId).toBe(tab.id);
    expect(s.collections[0].id).toBe('c1');
    expect(s.history).toHaveLength(1);
    expect(s.settings?.historyLimit).toBe(500);
    expect(mockSave).not.toHaveBeenCalled();
    stop();
  });

  it('starts clean and marks hydrated when loading fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockLoad.mockRejectedValue(new Error('boom'));
    const stop = await startPersistence();
    expect(base().hydrated).toBe(true);
    expect(base().collections).toEqual([]);
    warn.mockRestore();
    stop();
  });

  it('debounces 300ms per entity', async () => {
    const stop = await startPersistence();
    const c = col('a');
    useApiStore.setState({ collections: [c] });
    await vi.advanceTimersByTimeAsync(100);
    useApiStore.setState({ collections: [{ ...c, name: 'x' } as never] });
    await vi.advanceTimersByTimeAsync(100);
    useApiStore.setState({ collections: [{ ...c, name: 'y' } as never] });
    await vi.advanceTimersByTimeAsync(299);
    expect(mockSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0][0]).toEqual([
      { op: 'upsertCollection', id: 'a', sort: 0, json: JSON.stringify({ ...c, name: 'y' }) },
    ]);
    stop();
  });

  it('continuous edits still write within max wait', async () => {
    const stop = await startPersistence();
    const c = col('a');
    for (let i = 1; i <= 30; i++) {
      useApiStore.setState({ collections: [{ ...c, name: `n${i}` } as never] });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(mockSave.mock.calls.length).toBeGreaterThanOrEqual(2);
    stop();
  });

  it('stop flushes pending ops', async () => {
    const stop = await startPersistence();
    useApiStore.setState({ environments: [env('e9')] });
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('flush on close writes pending entities then reports flush_done', async () => {
    const stop = await startPersistence();
    useApiStore.setState({ environments: [env('e1')] });
    expect(mockSave).not.toHaveBeenCalled();
    expect(flushHandler).toBeDefined();
    flushHandler?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0][0]).toEqual([
      { op: 'upsertEnvironment', id: 'e1', sort: 0, json: JSON.stringify(env('e1')) },
    ]);
    expect(mockFlushDone).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.invocationCallOrder[0]).toBeLessThan(mockFlushDone.mock.invocationCallOrder[0]);
    // The debounce timer was cancelled by the flush.
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockSave).toHaveBeenCalledTimes(1);
    stop();
  });

  it('signals flush_done even when a save fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSave.mockRejectedValue(new Error('disk'));
    const stop = await startPersistence();
    useApiStore.setState({ environments: [env('e1')] });
    flushHandler?.();
    await vi.advanceTimersByTimeAsync(1000); // the one retry
    expect(mockSave).toHaveBeenCalledTimes(2);
    expect(mockFlushDone).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    stop();
  });

  /** A fake database: a call's ops commit when its promise resolves, after `delays[n]` ms. */
  function fakeDb(delays: number[]) {
    const commits: string[] = [];
    let call = 0;
    mockSave.mockImplementation((ops) => {
      const delay = delays[call++] ?? 0;
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          for (const op of ops) if (op.op === 'upsertCollection') commits.push(JSON.parse(op.json).name);
          resolve();
        }, delay),
      );
    });
    return commits;
  }

  it('serializes writes: a slow older write still commits before a newer one', async () => {
    const commits = fakeDb([500, 0]);
    const stop = await startPersistence();
    const c = col('a');
    useApiStore.setState({ collections: [{ ...c, name: 'old' } as never] });
    await vi.advanceTimersByTimeAsync(300); // first write starts, takes 500 ms
    useApiStore.setState({ collections: [{ ...c, name: 'new' } as never] });
    await vi.advanceTimersByTimeAsync(300); // second write is due but must wait
    expect(mockSave).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(mockSave).toHaveBeenCalledTimes(2);
    expect(commits).toEqual(['old', 'new']);
    stop();
  });

  it('flushNow waits behind a write already in flight', async () => {
    const commits = fakeDb([500, 0]);
    const stop = await startPersistence();
    const c = col('a');
    useApiStore.setState({ collections: [{ ...c, name: 'old' } as never] });
    await vi.advanceTimersByTimeAsync(300);
    useApiStore.setState({ collections: [{ ...c, name: 'new' } as never] });
    let flushed = false;
    void flushNow().then(() => (flushed = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(flushed).toBe(false);
    expect(mockSave).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400); // t=800: the slow write commits, then the flush write
    await vi.advanceTimersByTimeAsync(1);
    expect(flushed).toBe(true);
    expect(commits).toEqual(['old', 'new']);
    stop();
  });

  it('retries a failed write once after 1 s; success shows no notice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSave.mockRejectedValueOnce(new Error('busy'));
    const stop = await startPersistence();
    useApiStore.setState({ environments: [env('e1')] });
    await vi.advanceTimersByTimeAsync(300);
    expect(mockSave).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(mockSave).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockSave).toHaveBeenCalledTimes(2);
    expect(mockSave.mock.calls[1][0]).toEqual(mockSave.mock.calls[0][0]);
    expect(base().persistNotice).toBeNull();
    warn.mockRestore();
    stop();
  });

  it('a write that fails twice shows a notice; the next successful write clears it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSave.mockRejectedValueOnce(new Error('disk full')).mockRejectedValueOnce(new Error('disk full'));
    const stop = await startPersistence();
    useApiStore.setState({ environments: [env('e1')] });
    await vi.advanceTimersByTimeAsync(1300);
    expect(mockSave).toHaveBeenCalledTimes(2);
    expect(base().persistNotice).toBe('Changes could not be saved — disk full');
    useApiStore.setState({ environments: [env('e2')] });
    await vi.advanceTimersByTimeAsync(300);
    expect(mockSave).toHaveBeenCalledTimes(4); // upsert e2, delete e1
    expect(base().persistNotice).toBeNull();
    warn.mockRestore();
    stop();
  });

  it('pausePersistence drops pending edits and ignores changes until resumed', async () => {
    const stop = await startPersistence();
    useApiStore.setState({ environments: [env('pending')] });
    pausePersistence();
    useApiStore.setState({ environments: [env('ignored')] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockSave).not.toHaveBeenCalled();
    resumePersistence();
    useApiStore.setState({ environments: [env('after')] });
    await vi.advanceTimersByTimeAsync(300);
    // Only the change made after resuming is written (diffed against the state at that point).
    expect(mockSave.mock.calls.map((c) => c[0])).toEqual([
      [{ op: 'upsertEnvironment', id: 'after', sort: 0, json: JSON.stringify(env('after')) }],
      [{ op: 'deleteEnvironment', id: 'ignored' }],
    ]);
    stop();
  });

  it('stops listening and persisting after cleanup', async () => {
    const stop = await startPersistence();
    stop();
    expect(unlisten).toHaveBeenCalled();
    useApiStore.setState({ environments: [env('z')] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockSave).not.toHaveBeenCalled();
  });
});
