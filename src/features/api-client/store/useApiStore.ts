import { create } from 'zustand';
import {
  createTabsSlice,
  createHistorySlice,
  createCollectionsSlice,
  createEnvironmentsSlice,
  createUiSlice,
  createWorkspaceSlice,
} from './slices';
import type { StoreState } from './slices/types';
import { closeConnection } from '../lib/realtimeConnection';

export const useApiStore = create<StoreState>()((...a) => ({
  ...createTabsSlice(...a),
  ...createHistorySlice(...a),
  ...createCollectionsSlice(...a),
  ...createEnvironmentsSlice(...a),
  ...createUiSlice(...a),
  ...createWorkspaceSlice(...a),
}));

// Close the live realtime connection of every tab that disappears (explicit close, the
// last-tab replacement in closeTab, workspace hydration, ...).
useApiStore.subscribe((state, prev) => {
  if (state.tabs === prev.tabs) return;
  const ids = new Set(state.tabs.map((t) => t.id));
  for (const t of prev.tabs) if (!ids.has(t.id)) closeConnection(t.id);
});

// Re-export shared helpers for backward-compatible imports.
export { createDefaultTab, selectActiveTab, selectActiveVars } from './slices/helpers';
export type { PendingSave } from './slices/helpers';
export type { WorkspaceStatus } from './slices/uiSlice';
