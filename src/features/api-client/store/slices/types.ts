import type { TabsSlice } from './tabsSlice';
import type { HistorySlice } from './historySlice';
import type { CollectionsSlice } from './collectionsSlice';
import type { EnvironmentsSlice } from './environmentsSlice';
import type { UiSlice } from './uiSlice';
import type { WorkspaceSlice } from './workspaceSlice';

export type StoreState = TabsSlice & HistorySlice & CollectionsSlice & EnvironmentsSlice & UiSlice & WorkspaceSlice;
