import type { StateCreator } from 'zustand';
import type { StoreState } from './types';
import type { HistoryItem } from '../../types';
import { createDefaultTab } from './helpers';
import { addHistoryNative, saveEntities } from '../../lib/native/invoke';

const DEFAULT_HISTORY_LIMIT = 1000;

function warn(what: string) {
  return (e: unknown) => console.warn(`${what} failed`, e);
}

export interface HistorySlice {
  history: HistoryItem[];

  addHistory: (item: HistoryItem) => void;
  deleteHistoryItem: (id: string) => void;
  clearHistory: () => void;
  replayHistory: (item: HistoryItem) => void;
}

export const createHistorySlice: StateCreator<StoreState, [], [], HistorySlice> = (set, get) => ({
  history: [],

  // Mirrors Rust `add_history` (dedupe by method+URL, prune to the settings limit) in memory, then
  // persists through the dedicated command, not the store diff.
  addHistory: (item) => {
    const limit = get().settings?.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    set((s) => ({
      history: [item, ...s.history.filter((h) => !(h.method === item.method && h.url === item.url))].slice(0, limit),
    }));
    const ts = Date.parse(item.date);
    addHistoryNative({
      itemJson: JSON.stringify(item),
      method: item.method,
      url: item.url,
      status: item.status,
      durationMs: item.time,
      ts: Number.isNaN(ts) ? Date.now() : ts,
      limit: get().settings?.historyLimit,
    }).catch(warn('add_history'));
  },
  deleteHistoryItem: (id) => {
    set((s) => ({ history: s.history.filter((h) => h.id !== id) }));
    saveEntities([{ op: 'deleteHistory', id }]).catch(warn('delete history'));
  },
  clearHistory: () => {
    set({ history: [] });
    saveEntities([{ op: 'clearHistory' }]).catch(warn('clear history'));
  },
  replayHistory: (item) => {
    const existing = get().tabs.find((t) => t.sourceHistoryId === item.id);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const req = item.request ?? { ...createDefaultTab(), method: item.method, url: item.url };
    get().newTab(req);
    get().updateActiveTab({ sourceHistoryId: item.id });
  },
});
