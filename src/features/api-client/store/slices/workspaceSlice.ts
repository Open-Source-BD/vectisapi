import type { StateCreator } from 'zustand';
import type { StoreState } from './types';
import type { WorkspaceStatus } from './uiSlice';
import { serializeWorkspace, deserializeWorkspace } from '../../lib/workspaceFile';
import { zipFiles, unzipFiles } from '../../lib/zipWorkspace';
import type { Collection, TreeNode } from '../../types';

const FILE_BODY_WARNED_KEY = 'next-postman-file-body-warned';

function anyFileBody(cols: Collection[]): boolean {
  const walk = (nodes: TreeNode[]): boolean =>
    nodes.some((n) =>
      n.type === 'folder' ? walk(n.children) : n.request.body.formdata.some((f) => f.type === 'file' && f.file),
    );
  return cols.some((c) => walk(c.children));
}

export interface WorkspaceSlice {
  workspaceStatus: WorkspaceStatus;
  workspaceName: string;
  workspaceBusy: boolean;
  workspaceError: string | null;

  restoreWorkspace: () => Promise<void>;
  connectWorkspace: () => Promise<void>;
  reconnectWorkspace: () => Promise<void>;
  saveToWorkspace: () => Promise<void>;
  loadFromWorkspace: () => Promise<void>;
  disconnectWorkspace: () => Promise<void>;
  /** Snapshot fallback for browsers without File System Access (Firefox/Safari). */
  exportWorkspaceZip: () => Promise<void>;
  importWorkspaceZip: (file: File) => Promise<void>;
}

/** Connected workspace directory handle (not serializable → not in state). */
let wsHandle: import('../../lib/workspaceFs').WorkspaceHandle | null = null;

export const createWorkspaceSlice: StateCreator<StoreState, [], [], WorkspaceSlice> = (set, get) => ({
  workspaceStatus: 'disconnected' as WorkspaceStatus,
  workspaceName: '',
  workspaceBusy: false,
  workspaceError: null,

  restoreWorkspace: async () => {
    const { isFsSupported, loadHandle } = await import('../../lib/workspaceFs');
    if (!isFsSupported()) {
      set({ workspaceStatus: 'unsupported' as WorkspaceStatus });
      return;
    }
    try {
      const handle = await loadHandle();
      if (handle) {
        wsHandle = handle;
        set({ workspaceStatus: 'reconnect' as WorkspaceStatus, workspaceName: handle.name });
      }
    } catch {
      // no stored handle / IDB unavailable — stay disconnected
    }
  },

  connectWorkspace: async () => {
    const { isFsSupported, pickWorkspaceDir, saveHandle } = await import('../../lib/workspaceFs');
    if (!isFsSupported()) {
      set({ workspaceStatus: 'unsupported' as WorkspaceStatus });
      return;
    }
    set({ workspaceBusy: true, workspaceError: null });
    try {
      const handle = await pickWorkspaceDir();
      wsHandle = handle;
      await saveHandle(handle);
      set({ workspaceStatus: 'connected' as WorkspaceStatus, workspaceName: handle.name });
      await get().saveToWorkspace();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') set({ workspaceError: (e as Error).message });
    } finally {
      set({ workspaceBusy: false });
    }
  },

  reconnectWorkspace: async () => {
    if (!wsHandle) return;
    const { ensurePermission } = await import('../../lib/workspaceFs');
    set({ workspaceBusy: true, workspaceError: null });
    try {
      const ok = await ensurePermission(wsHandle);
      set({
        workspaceStatus: ok ? 'connected' : ('reconnect' as WorkspaceStatus),
        workspaceError: ok ? null : 'Permission denied',
      });
    } finally {
      set({ workspaceBusy: false });
    }
  },

  saveToWorkspace: async () => {
    if (!wsHandle) return;
    const { ensurePermission, writeWorkspace } = await import('../../lib/workspaceFs');
    set({ workspaceBusy: true, workspaceError: null });
    try {
      if (!(await ensurePermission(wsHandle))) {
        set({ workspaceStatus: 'reconnect' as WorkspaceStatus, workspaceError: 'Folder permission needed' });
        return;
      }
      const { collections, environments, globals } = get();
      if (
        typeof localStorage !== 'undefined' &&
        !localStorage.getItem(FILE_BODY_WARNED_KEY) &&
        anyFileBody(collections)
      ) {
        localStorage.setItem(FILE_BODY_WARNED_KEY, '1');
        alert(
          "Heads up: file attachments in form-data bodies are not written to the folder (the file itself can't be serialized). Everything else is saved — re-attach files after loading elsewhere.",
        );
      }
      await writeWorkspace(wsHandle, serializeWorkspace({ collections, environments, globals }));
      set({ workspaceStatus: 'connected' as WorkspaceStatus });
    } catch (e) {
      set({ workspaceError: (e as Error).message });
    } finally {
      set({ workspaceBusy: false });
    }
  },

  loadFromWorkspace: async () => {
    if (!wsHandle) return;
    const { ensurePermission, readWorkspace } = await import('../../lib/workspaceFs');
    set({ workspaceBusy: true, workspaceError: null });
    try {
      if (!(await ensurePermission(wsHandle))) {
        set({ workspaceStatus: 'reconnect' as WorkspaceStatus, workspaceError: 'Folder permission needed' });
        return;
      }
      const data = deserializeWorkspace(await readWorkspace(wsHandle));
      const expanded = { ...get().expanded };
      data.collections.forEach((c) => {
        expanded[c.id] = true;
      });
      set({
        collections: data.collections,
        environments: data.environments,
        globals: data.globals,
        expanded,
        workspaceStatus: 'connected' as WorkspaceStatus,
      });
    } catch (e) {
      set({ workspaceError: (e as Error).message });
    } finally {
      set({ workspaceBusy: false });
    }
  },

  disconnectWorkspace: async () => {
    const { clearHandle } = await import('../../lib/workspaceFs');
    await clearHandle();
    wsHandle = null;
    set({ workspaceStatus: 'disconnected' as WorkspaceStatus, workspaceName: '', workspaceError: null });
  },

  exportWorkspaceZip: async () => {
    set({ workspaceBusy: true, workspaceError: null });
    try {
      const { collections, environments, globals } = get();
      if (
        typeof localStorage !== 'undefined' &&
        !localStorage.getItem(FILE_BODY_WARNED_KEY) &&
        anyFileBody(collections)
      ) {
        localStorage.setItem(FILE_BODY_WARNED_KEY, '1');
        alert(
          "Heads up: file attachments in form-data bodies are not written to the zip (the file itself can't be serialized). Everything else is saved — re-attach files after importing.",
        );
      }
      const blob = await zipFiles(serializeWorkspace({ collections, environments, globals }));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'next-postman-workspace.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      set({ workspaceError: (e as Error).message });
    } finally {
      set({ workspaceBusy: false });
    }
  },

  importWorkspaceZip: async (file) => {
    set({ workspaceBusy: true, workspaceError: null });
    try {
      const data = deserializeWorkspace(await unzipFiles(await file.arrayBuffer()));
      const expanded = { ...get().expanded };
      data.collections.forEach((c) => {
        expanded[c.id] = true;
      });
      set({
        collections: data.collections,
        environments: data.environments,
        globals: data.globals,
        expanded,
      });
    } catch (e) {
      set({ workspaceError: (e as Error).message });
    } finally {
      set({ workspaceBusy: false });
    }
  },
});
