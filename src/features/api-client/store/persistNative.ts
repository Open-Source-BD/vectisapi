import { useEffect } from 'react';
import {
  flushDone,
  loadWorkspace,
  onFlush,
  saveEntities,
  type EntityOp,
} from '../lib/native/invoke';
import type { HistoryItem, TabState } from '../types';
import type { StoreState } from './slices/types';
import { useApiStore } from './useApiStore';

/** Quiet period after the last change to an entity before it is written. */
const DEBOUNCE_MS = 300;
/** Longest an entity's first unsaved change may wait, however steadily it keeps changing. */
const MAX_WAIT_MS = 1000;

/** Stable identity of the entity an op writes; later ops for the same key replace earlier ones. */
function opKey(op: EntityOp): string {
  switch (op.op) {
    case 'upsertCollection':
    case 'deleteCollection':
      return `collection:${op.id}`;
    case 'upsertEnvironment':
    case 'deleteEnvironment':
      return `environment:${op.id}`;
    case 'setUiState':
      return `ui:${op.key}`;
    default:
      return op.op === 'replaceTabs' ? 'tabs' : op.op === 'setGlobals' ? 'globals' : op.op;
  }
}

function diffById<T extends { id: string }>(
  prev: T[],
  next: T[],
  upsert: (id: string, sort: number, json: string) => EntityOp,
  remove: (id: string) => EntityOp,
): EntityOp[] {
  if (prev === next) return [];
  const prevIndex = new Map(prev.map((item, i) => [item.id, i] as const));
  const ops: EntityOp[] = [];
  next.forEach((item, i) => {
    const before = prevIndex.get(item.id);
    if (before === undefined || prev[before] !== item || before !== i) {
      ops.push(upsert(item.id, i, JSON.stringify(item)));
    }
  });
  const kept = new Set(next.map((item) => item.id));
  for (const item of prev) if (!kept.has(item.id)) ops.push(remove(item.id));
  return ops;
}

/**
 * The writes needed to take the database from `prev` to `next`. Collections and environments are
 * compared by reference per id (`sort` = array index). History goes through `add_history` /
 * `DeleteHistory` / `ClearHistory` from the store actions, and settings and cookies are owned by
 * Rust, so none of those appear here.
 */
export function diffToOps(prev: StoreState, next: StoreState): EntityOp[] {
  const ops: EntityOp[] = [
    ...diffById(
      prev.collections,
      next.collections,
      (id, sort, json) => ({ op: 'upsertCollection', id, sort, json }),
      (id) => ({ op: 'deleteCollection', id }),
    ),
    ...diffById(
      prev.environments,
      next.environments,
      (id, sort, json) => ({ op: 'upsertEnvironment', id, sort, json }),
      (id) => ({ op: 'deleteEnvironment', id }),
    ),
  ];
  if (prev.globals !== next.globals) ops.push({ op: 'setGlobals', json: JSON.stringify(next.globals) });
  if (prev.activeEnvId !== next.activeEnvId) ops.push({ op: 'setActiveEnv', id: next.activeEnvId });
  if (prev.tabs !== next.tabs) {
    // Drop live responses to keep the database small; files don't serialize.
    ops.push({
      op: 'replaceTabs',
      tabs: next.tabs.map((t) => [t.id, JSON.stringify({ ...t, response: null, prevResponse: null })]),
    });
  }
  if (prev.theme !== next.theme) ops.push({ op: 'setUiState', key: 'theme', json: JSON.stringify(next.theme) });
  if (prev.activeTabId !== next.activeTabId) {
    ops.push({ op: 'setUiState', key: 'activeTabId', json: JSON.stringify(next.activeTabId) });
  }
  return ops;
}

const pending = new Map<string, EntityOp>();
const firstPendingAt = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Set<Promise<void>>();

function send(ops: EntityOp[]): void {
  if (ops.length === 0) return;
  const p = saveEntities(ops)
    .catch((e: unknown) => console.warn('save_entities failed', e))
    .finally(() => inflight.delete(p));
  inflight.add(p);
}

function schedule(op: EntityOp): void {
  const key = opKey(op);
  pending.set(key, op);
  clearTimeout(timers.get(key));
  const now = Date.now();
  if (!firstPendingAt.has(key)) firstPendingAt.set(key, now);
  const delay = Math.max(0, Math.min(DEBOUNCE_MS, firstPendingAt.get(key)! + MAX_WAIT_MS - now));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      firstPendingAt.delete(key);
      const queued = pending.get(key);
      pending.delete(key);
      if (queued) send([queued]);
    }, delay),
  );
}

/** Writes every pending op now (one call) and waits for all writes in flight. */
export async function flushNow(): Promise<void> {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  firstPendingAt.clear();
  const ops = [...pending.values()];
  pending.clear();
  send(ops);
  await Promise.all([...inflight]);
}

/**
 * Loads the workspace from SQLite into the store (a failed load starts clean), then persists
 * store changes with a per-entity debounce and flushes when Rust asks on window close.
 * Resolves once hydrated; the returned function stops persisting.
 */
export async function startPersistence(): Promise<() => void> {
  let unlisten: (() => void) | undefined;
  let stopped = false;
  onFlush(() => {
    void flushNow()
      .catch((e: unknown) => console.warn('flush failed', e))
      .finally(() => flushDone().catch((e: unknown) => console.warn('flush_done failed', e)));
  })
    .then((fn) => {
      if (stopped) fn();
      else unlisten = fn;
    })
    .catch((e: unknown) => console.warn('flush listener failed', e));

  const store = useApiStore.getState();
  try {
    const snap = await loadWorkspace();
    store.hydrate({
      history: snap.history as HistoryItem[],
      collections: snap.collections,
      environments: snap.environments,
      activeEnvId: snap.activeEnvId,
      globals: Array.isArray(snap.globals) ? (snap.globals as never) : [],
      tabs: snap.tabs as TabState[],
      activeTabId: typeof snap.uiState.activeTabId === 'string' ? snap.uiState.activeTabId : undefined,
      theme: typeof snap.uiState.theme === 'string' ? snap.uiState.theme : undefined,
    });
    useApiStore.setState({ settings: snap.settings });
  } catch (e) {
    // Unreadable database → start clean (still mark hydrated).
    console.warn('load_workspace failed', e);
    store.hydrate({});
  }

  const unsub = useApiStore.subscribe((state, prev) => {
    for (const op of diffToOps(prev, state)) schedule(op);
  });
  return () => {
    stopped = true;
    unsub();
    unlisten?.();
    void flushNow(); // don't drop edits still waiting on their debounce
  };
}

/** Hydrates the store from SQLite on mount and keeps it persisted (see `startPersistence`). */
export function usePersistence(): void {
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void startPersistence().then((fn) => {
      if (cancelled) fn();
      else stop = fn;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
}
