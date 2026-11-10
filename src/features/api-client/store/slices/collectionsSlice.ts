import type { StateCreator } from 'zustand';
import type { StoreState } from './types';
import type { Collection, TabState, Environment, EnvVar, HistoryItem } from '../../types';
import type { CookieJar } from '../../lib/cookies';
import { generateId } from '../../lib/id';
import * as tree from '../../lib/collectionTree';
import { runCollection, type RunResultItem } from '../../lib/collectionRunner';
import { parseData } from '../../lib/parseData';
import { cookieHeaderFor, mergeSetCookie } from '../../lib/cookies';
import { clone, createDefaultTab, snapshotRequest, selectActiveVars } from './helpers';

function migrateEnvironments(raw: unknown): Environment[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const first = raw[0] as Record<string, unknown>;
  if (first && Array.isArray(first.vars)) return raw as Environment[];
  return [{ id: generateId(), name: 'Default', vars: raw as EnvVar[] }];
}

export interface CollectionsSlice {
  collections: Collection[];
  expanded: Record<string, boolean>;
  collectionSearch: string;
  cookieJar: CookieJar;
  moveNodeId: string | null;
  hydrated: boolean;

  // Collections — tree
  createCollection: (name: string) => void;
  renameCollection: (id: string, name: string) => void;
  setCollectionDescription: (id: string, description: string) => void;
  deleteCollection: (id: string) => void;
  createFolder: (parentId: string, name: string) => void;
  addRequest: (parentId: string) => void;
  renameNode: (id: string, name: string) => void;
  deleteNode: (id: string) => void;
  duplicateNode: (id: string) => void;
  moveNode: (nodeId: string, targetParentId: string, index?: number) => void;
  openRequestNode: (nodeId: string) => void;

  // Save flow
  saveActiveRequest: () => void;
  saveActiveRequestAs: () => void;
  openSaveModalForHistory: (item: HistoryItem) => void;
  confirmSave: (parentId: string, name: string) => void;
  cancelSave: () => void;

  // Import / hydrate
  mergeImport: (collections: Collection[], environments: Environment[]) => void;
  hydrate: (data: {
    history?: HistoryItem[];
    collections?: unknown;
    environments?: unknown;
    activeEnvId?: string | null;
    globals?: EnvVar[];
    tabs?: TabState[];
    activeTabId?: string;
    theme?: string;
    cookieJar?: CookieJar;
  }) => void;

  // Collection Runner
  runnerNodeId: string | null;
  runnerRunning: boolean;
  runnerProgress: { current: number; total: number };
  runnerResults: RunResultItem[];
  runnerError: string | null;
  openRunner: (nodeId: string) => void;
  closeRunner: () => void;
  startRun: (opts: { iterations: number; dataText: string }) => Promise<void>;
  cancelRun: () => void;

  // Cookies
  captureCookies: (url: string, setCookieHeader: string | undefined) => void;
  clearCookies: (domain?: string) => void;

  // Move modal
  openMoveModal: (nodeId: string) => void;
  closeMoveModal: () => void;
}

let runAbort: AbortController | null = null;

export const createCollectionsSlice: StateCreator<StoreState, [], [], CollectionsSlice> = (set, get) => ({
  collections: [],
  expanded: {},
  collectionSearch: '',
  cookieJar: {},
  moveNodeId: null,
  hydrated: false,
  runnerNodeId: null,
  runnerRunning: false,
  runnerProgress: { current: 0, total: 0 },
  runnerResults: [],
  runnerError: null,

  // --- Collections ---

  createCollection: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const col: Collection = {
      id: generateId(),
      name: trimmed,
      children: [],
      date: new Date().toISOString(),
    };
    set((s) => ({ collections: [...s.collections, col], expanded: { ...s.expanded, [col.id]: true } }));
  },

  renameCollection: (id, name) =>
    set((s) => ({
      collections: s.collections.map((c) => (c.id === id ? { ...c, name } : c)),
    })),

  setCollectionDescription: (id, description) =>
    set((s) => ({
      collections: s.collections.map((c) => (c.id === id ? { ...c, description } : c)),
    })),

  deleteCollection: (id) => set((s) => ({ collections: s.collections.filter((c) => c.id !== id) })),

  createFolder: (parentId, name) => {
    const folder = tree.makeFolder(name.trim() || 'New Folder');
    set((s) => ({
      collections: tree.insertNode(s.collections, parentId, folder),
      expanded: { ...s.expanded, [parentId]: true, [folder.id]: true },
    }));
  },

  addRequest: (parentId) => {
    const node = tree.makeRequest('New Request', createDefaultTab());
    set((s) => ({
      collections: tree.insertNode(s.collections, parentId, node),
      expanded: { ...s.expanded, [parentId]: true },
    }));
    get().openRequestNode(node.id);
  },

  renameNode: (id, name) => set((s) => ({ collections: tree.updateNode(s.collections, id, { name }) })),
  deleteNode: (id) => set((s) => ({ collections: tree.removeNode(s.collections, id) })),
  duplicateNode: (id) => set((s) => ({ collections: tree.duplicateNode(s.collections, id) })),

  moveNode: (nodeId, targetParentId, index) =>
    set((s) => ({
      collections: tree.moveNode(s.collections, nodeId, targetParentId, index),
      expanded: { ...s.expanded, [targetParentId]: true },
    })),

  openRequestNode: (nodeId) => {
    const existing = get().tabs.find((t) => t.sourceNodeId === nodeId);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const node = tree.findNode(get().collections, nodeId);
    if (!node || node.type !== 'request') return;
    get().newTab(node.request);
    get().updateActiveTab({ sourceNodeId: nodeId });
  },

  // --- Save flow ---

  saveActiveRequest: () => {
    const { tabs, activeTabId, collections } = get();
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    if (tab.sourceNodeId && tree.findNode(collections, tab.sourceNodeId)) {
      set({ collections: tree.updateNode(collections, tab.sourceNodeId, { request: snapshotRequest(tab) }) });
      return;
    }
    set({
      pendingSave: { request: snapshotRequest(tab), suggestedName: tab.url || 'New Request', fromActiveTab: true },
      isSaveModalOpen: true,
    });
  },

  saveActiveRequestAs: () => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    set({
      pendingSave: { request: snapshotRequest(tab), suggestedName: tab.url || 'New Request', fromActiveTab: true },
      isSaveModalOpen: true,
    });
  },

  openSaveModalForHistory: (item) => {
    const request = item.request ?? { ...createDefaultTab(), method: item.method, url: item.url };
    set({
      pendingSave: {
        request: snapshotRequest(request),
        suggestedName: item.url || 'New Request',
        fromActiveTab: false,
      },
      isSaveModalOpen: true,
    });
  },

  confirmSave: (parentId, name) => {
    const { pendingSave, collections } = get();
    if (!pendingSave) return;
    const node = tree.makeRequest(name.trim() || 'New Request', clone(pendingSave.request));
    set((s) => ({
      collections: tree.insertNode(collections, parentId, node),
      expanded: { ...s.expanded, [parentId]: true },
      isSaveModalOpen: false,
      pendingSave: null,
    }));
    if (pendingSave.fromActiveTab) get().updateActiveTab({ sourceNodeId: node.id });
  },

  cancelSave: () => set({ isSaveModalOpen: false, pendingSave: null }),

  // --- Import / hydrate ---

  mergeImport: (collections, environments) =>
    set((s) => {
      const expanded = { ...s.expanded };
      collections.forEach((c) => {
        expanded[c.id] = true;
      });
      return {
        collections: [...collections, ...s.collections],
        environments: [...environments, ...s.environments],
        expanded,
      };
    }),

  hydrate: (data) => {
    const collections = tree.migrateCollections(data.collections ?? []);
    const environments = migrateEnvironments(data.environments);
    const expanded: Record<string, boolean> = {};
    collections.forEach((c) => {
      expanded[c.id] = true;
    });

    const tabs =
      data.tabs && data.tabs.length
        ? data.tabs.map((t) => ({ ...t, protocol: t.protocol ?? 'http' }))
        : [createDefaultTab()];
    const activeTabId = data.activeTabId && tabs.some((t) => t.id === data.activeTabId) ? data.activeTabId : tabs[0].id;

    set({
      history: data.history ?? [],
      collections,
      environments,
      activeEnvId: data.activeEnvId ?? environments[0]?.id ?? null,
      globals: Array.isArray(data.globals) ? data.globals : [],
      tabs,
      activeTabId,
      theme: data.theme === 'dark' ? 'dark' : 'light',
      cookieJar: data.cookieJar && typeof data.cookieJar === 'object' ? data.cookieJar : {},
      expanded,
      hydrated: true,
    });
  },

  // --- Collection Runner ---

  openRunner: (runnerNodeId) =>
    set({
      runnerNodeId,
      runnerRunning: false,
      runnerResults: [],
      runnerProgress: { current: 0, total: 0 },
      runnerError: null,
    }),

  closeRunner: () => {
    runAbort?.abort();
    runAbort = null;
    set({ runnerNodeId: null, runnerRunning: false });
  },

  startRun: async ({ iterations, dataText }) => {
    const state = get();
    const nodeId = state.runnerNodeId;
    if (!nodeId || state.runnerRunning) return;

    const requests = tree.listRequests(state.collections, nodeId);
    if (requests.length === 0) {
      set({ runnerError: null, runnerResults: [], runnerProgress: { current: 0, total: 0 } });
      return;
    }

    let dataRows: Record<string, string>[] = [];
    if (dataText.trim()) {
      try {
        dataRows = parseData(dataText);
      } catch (e) {
        set({ runnerError: (e as Error).message });
        return;
      }
    }

    const seedVars = selectActiveVars(state);
    runAbort = new AbortController();
    set({ runnerRunning: true, runnerResults: [], runnerProgress: { current: 0, total: 0 }, runnerError: null });

    await runCollection({
      requests,
      seedVars,
      iterations,
      dataRows,
      signal: runAbort.signal,
      onResult: (item) => set((s) => ({ runnerResults: [...s.runnerResults, item] })),
      onProgress: (current, total) => set({ runnerProgress: { current, total } }),
      cookieHeaderFor: (url) => cookieHeaderFor(get().cookieJar, url),
      onCookies: (url, sc) => get().captureCookies(url, sc),
    });

    runAbort = null;
    set({ runnerRunning: false });
  },

  cancelRun: () => {
    runAbort?.abort();
    runAbort = null;
    set({ runnerRunning: false });
  },

  // --- Cookies ---

  captureCookies: (url, setCookieHeader) =>
    set((s) => ({ cookieJar: mergeSetCookie(s.cookieJar, url, setCookieHeader) })),

  clearCookies: (domain) =>
    set((s) => {
      if (!domain) return { cookieJar: {} };
      const next = { ...s.cookieJar };
      delete next[domain];
      return { cookieJar: next };
    }),

  openMoveModal: (moveNodeId) => set({ moveNodeId, isMoveModalOpen: true }),
  closeMoveModal: () => set({ isMoveModalOpen: false, moveNodeId: null }),
});
