import { flushNow, pausePersistence, reloadWorkspace, resumePersistence } from '../../store/persistNative';
import { useApiStore } from '../../store/useApiStore';
import type { Collection, EnvVar, Environment } from '../../types';
import { deserializeWorkspace, type FileEntry, type WorkspaceData } from '../workspaceFile';
import { exportBackup, importBackup, pickNextPostmanWorkspace, type NextPostmanFile } from './invoke';

/**
 * Settings-modal actions: full backup export/import and the one-way next-postman migration.
 * Rust shows every dialog; these only orchestrate flushing and reloading the store.
 */

/** Writes pending edits, then exports everything to a user-picked file; the path, or null. */
export async function exportAll(): Promise<string | null> {
  await flushNow();
  return exportBackup();
}

/** Shown when the database was replaced but the store could not be reloaded from it. */
export const RESTART_AFTER_IMPORT = 'Import finished — restart VectisAPI to load it';

/**
 * Replaces the whole workspace (and settings) with a user-picked backup, then reloads the store
 * from the database; the path, or null if cancelled. Pending edits are written first, and
 * persistence is paused from just before the import until the reload finishes so no store change
 * can overwrite the imported data. If the reload fails, persistence stays paused (the store no
 * longer matches the database) and this rejects with `RESTART_AFTER_IMPORT`.
 */
export async function importAll(): Promise<string | null> {
  await flushNow();
  pausePersistence();
  let path: string | null;
  try {
    path = await importBackup();
  } catch (e) {
    resumePersistence(); // the import rolled back; the database still matches the store
    throw e;
  }
  if (!path) {
    resumePersistence();
    return null;
  }
  try {
    await reloadWorkspace();
  } catch (e) {
    console.warn('reload after import failed', e);
    throw new Error(RESTART_AFTER_IMPORT);
  }
  resumePersistence();
  return path;
}

/** Deep copy of `value` without form-data `filePath`s (they point into another filesystem). */
export function withoutFilePaths<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, v: unknown) => (key === 'filePath' ? undefined : v)) as T;
}

/**
 * Picked files → next-postman's workspace-relative paths (`collections/...`, `environments/...`).
 * A zip made by the OS archiver, or a parent folder, adds leading directories; they're dropped.
 */
export function toWorkspaceEntries(files: NextPostmanFile[]): FileEntry[] {
  const out: FileEntry[] = [];
  for (const file of files) {
    const parts = file.path.split('/');
    const root = parts.findIndex((p) => p === 'collections' || p === 'environments');
    if (root >= 0) out.push({ path: parts.slice(root).join('/'), content: file.text });
  }
  return out;
}

const withoutIds = <T extends { id: string }>(items: T[], incoming: T[]): T[] => {
  const ids = new Set(incoming.map((i) => i.id));
  return items.filter((i) => !ids.has(i.id));
};

/**
 * Adds an imported workspace to the current one: imported collections/environments go first and
 * replace existing ones with the same id (re-importing doesn't duplicate); imported globals are
 * added unless a global with that key exists.
 */
export function mergeWorkspace(
  current: { collections: Collection[]; environments: Environment[]; globals: EnvVar[] },
  data: WorkspaceData,
): { collections: Collection[]; environments: Environment[]; globals: EnvVar[] } {
  const keys = new Set(current.globals.map((g) => g.key));
  return {
    collections: [...data.collections, ...withoutIds(current.collections, data.collections)],
    environments: [...data.environments, ...withoutIds(current.environments, data.environments)],
    globals: [...current.globals, ...data.globals.filter((g) => g.key && !keys.has(g.key))],
  };
}

/**
 * Imports a next-postman workspace (its exported `.zip` or its folder) into the store, which
 * persists it. Resolves to what was imported, or null if cancelled; rejects if the selection
 * holds no next-postman workspace.
 */
export async function importNextPostman(
  source: 'zip' | 'folder',
): Promise<{ collections: number; environments: number } | null> {
  const files = await pickNextPostmanWorkspace(source);
  if (!files) return null;
  // Keep `fileName` so the user sees which file to pick again.
  const data = withoutFilePaths(deserializeWorkspace(toWorkspaceEntries(files)));
  if (!data.collections.length && !data.environments.length && !data.globals.length) {
    throw new Error('No next-postman workspace found (expected collections/ or environments/).');
  }
  useApiStore.setState((s) => {
    const expanded = { ...s.expanded };
    data.collections.forEach((c) => {
      expanded[c.id] = true;
    });
    return { ...mergeWorkspace(s, data), expanded };
  });
  return { collections: data.collections.length, environments: data.environments.length };
}
