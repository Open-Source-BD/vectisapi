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

export const useApiStore = create<StoreState>()((...a) => ({
  ...createTabsSlice(...a),
  ...createHistorySlice(...a),
  ...createCollectionsSlice(...a),
  ...createEnvironmentsSlice(...a),
  ...createUiSlice(...a),
  ...createWorkspaceSlice(...a),
}));

// Re-export shared helpers for backward-compatible imports.
export { createDefaultTab, selectActiveTab, selectActiveVars } from './slices/helpers';
export type { PendingSave } from './slices/helpers';
export type { WorkspaceStatus } from './slices/uiSlice';
