import type { FileEntry } from './workspaceFile';

/**
 * Browser File System Access layer (Chromium/Edge only). Persists the granted
 * directory handle in IndexedDB so the workspace reconnects across reloads
 * (permission is re-queried, since browsers drop it). Firefox/Safari lack this
 * API — callers must feature-detect with `isFsSupported()` first.
 */

// The permission methods are non-standard (Chromium); type them loosely.
type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: string }) => Promise<PermissionState>;
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  removeEntry: (name: string, opts?: { recursive?: boolean }) => Promise<void>;
};

export type WorkspaceHandle = DirHandle;

export function isFsSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function pickWorkspaceDir(): Promise<DirHandle> {
  const picker = (window as unknown as { showDirectoryPicker: (o: { mode: string }) => Promise<DirHandle> })
    .showDirectoryPicker;
  return picker({ mode: 'readwrite' });
}

// --- IndexedDB handle persistence ---

const DB_NAME = 'next-postman-ws';
const STORE = 'handles';
const KEY = 'dir';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveHandle(handle: DirHandle): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadHandle(): Promise<DirHandle | null> {
  const db = await openDb();
  const handle = await new Promise<DirHandle | null>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as DirHandle) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return handle;
}

export async function clearHandle(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

/** Re-check (and if needed re-request) read/write permission on a stored handle. */
export async function ensurePermission(handle: DirHandle, write = true): Promise<boolean> {
  const opts = { mode: write ? 'readwrite' : 'read' };
  if ((await handle.queryPermission?.(opts)) === 'granted') return true;
  return (await handle.requestPermission?.(opts)) === 'granted';
}

// --- Read / write the workspace tree ---

async function writeFile(root: DirHandle, path: string, content: string): Promise<void> {
  const segments = path.split('/');
  const fileName = segments.pop()!;
  let dir = root;
  for (const seg of segments) {
    dir = (await dir.getDirectoryHandle(seg, { create: true })) as DirHandle;
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

/** Overwrite the managed dirs so deletions propagate, then write fresh files. */
export async function writeWorkspace(root: DirHandle, files: FileEntry[]): Promise<void> {
  for (const dir of ['collections', 'environments']) {
    try {
      await root.removeEntry(dir, { recursive: true });
    } catch {
      // dir may not exist yet — fine
    }
  }
  for (const file of files) {
    await writeFile(root, file.path, file.content);
  }
}

async function walk(dir: DirHandle, prefix: string, out: FileEntry[]): Promise<void> {
  const entries = dir.entries?.();
  if (!entries) return;
  for await (const [name, handle] of entries) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      await walk(handle as DirHandle, path, out);
    } else if (name.endsWith('.json') || name === '.gitignore') {
      const file = await (handle as FileSystemFileHandle).getFile();
      out.push({ path, content: await file.text() });
    }
  }
}

export async function readWorkspace(root: DirHandle): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  await walk(root, '', out);
  return out;
}

/** Best-effort display name for the connected folder. */
export function handleName(handle: DirHandle | null): string {
  return handle?.name ?? '';
}
