import type { StateCreator } from 'zustand';
import type { StoreState } from './types';
import type { HistoryItem } from '../../types';
import { createDefaultTab } from './helpers';

export interface HistorySlice {
  history: HistoryItem[];

  addHistory: (item: HistoryItem) => void;
  deleteHistoryItem: (id: string) => void;
  clearHistory: () => void;
  replayHistory: (item: HistoryItem) => void;
}

export const createHistorySlice: StateCreator<StoreState, [], [], HistorySlice> = (set, get) => ({
  history: [],

  addHistory: (item) =>
    set((s) => ({
      history: [item, ...s.history.filter((h) => !(h.method === item.method && h.url === item.url))].slice(0, 50),
    })),
  deleteHistoryItem: (id) => set((s) => ({ history: s.history.filter((h) => h.id !== id) })),
  clearHistory: () => set({ history: [] }),
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
