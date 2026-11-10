import type { StateCreator } from 'zustand';
import type { StoreState } from './types';
import type { TabState, Protocol, RealtimeState } from '../../types';
import { generateId } from '../../lib/id';
import { isTabDirty } from '../../lib/tabDirty';
import {
  closeConnection,
  openWebSocket,
  openSse,
  sendWebSocket,
  byteLen,
  type RtHandlers,
} from '../../lib/realtimeConnection';
import { buildRequestSpec, buildWsRequest } from '../../lib/native/buildRequestSpec';
import { findNode } from '../../lib/collectionTree';
import { clone, createDefaultTab, type PendingSave, selectActiveVars, pushRtMessage } from './helpers';

type StoreSet = Parameters<StateCreator<StoreState, [], [], TabsSlice>>[0];

/** Handlers that write a tab's live connection events into `realtime[tabId]`. */
function rtHandlers(tabId: string, set: StoreSet): RtHandlers {
  return {
    onStatus: (status, info) =>
      set((s) => {
        const rt = s.realtime[tabId] ?? { status: 'idle', messages: [], total: 0 };
        return {
          realtime: {
            ...s.realtime,
            [tabId]: { ...rt, status, closeInfo: info, error: status === 'error' ? (info ?? 'error') : rt.error },
          },
        };
      }),
    onMessage: (dir, text, bytes) =>
      set((s) => {
        const rt = s.realtime[tabId];
        if (!rt) return {};
        return { realtime: { ...s.realtime, [tabId]: pushRtMessage(rt, dir, text, bytes) } };
      }),
    onId: (id) =>
      set((s) => {
        const rt = s.realtime[tabId];
        if (!rt) return {};
        return { realtime: { ...s.realtime, [tabId]: { ...rt, lastEventId: id } } };
      }),
  };
}

export interface TabsSlice {
  tabs: TabState[];
  activeTabId: string;
  closingTabId: string | null;
  pendingSave: PendingSave | null;
  /** Live realtime (WebSocket/SSE) state per tab — NOT persisted, NOT in the dirty-check. */
  realtime: Record<string, RealtimeState>;

  // Tabs
  newTab: (req?: TabState) => void;
  closeTab: (id: string) => void;
  requestCloseTab: (id: string) => void;
  confirmCloseTab: () => void;
  saveAndCloseTab: () => void;
  cancelCloseTab: () => void;
  setActiveTab: (id: string) => void;
  updateActiveTab: (updates: Partial<TabState>) => void;
  /** Swap a truncated response's preview for its full body (no-op if that tab moved on to another response). */
  setFullResponseBody: (tabId: string, responseId: string, rawText: string) => void;

  // Realtime
  setTabProtocol: (protocol: Protocol) => void;
  wsConnect: (tabId: string) => void;
  wsSend: (tabId: string, text: string) => void;
  wsDisconnect: (tabId: string) => void;
  sseConnect: (tabId: string) => void;
}

const initialTab = createDefaultTab();

export const createTabsSlice: StateCreator<StoreState, [], [], TabsSlice> = (set, get) => ({
  tabs: [initialTab],
  activeTabId: initialTab.id,
  closingTabId: null,
  pendingSave: null,
  realtime: {},

  // --- Tabs ---

  newTab: (req) => {
    const tab = req ? { ...clone(req), id: generateId(), response: null } : createDefaultTab();
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    // The live connection is closed by the tab-id subscription in useApiStore.
    const dropRt = (rt: Record<string, RealtimeState>) => {
      if (!rt[id]) return rt;
      const next = { ...rt };
      delete next[id];
      return next;
    };
    if (tabs.length === 1) {
      const fresh = createDefaultTab();
      set((s) => ({ tabs: [fresh], activeTabId: fresh.id, realtime: dropRt(s.realtime) }));
      return;
    }
    const idx = tabs.findIndex((t) => t.id === id);
    let nextActive = activeTabId;
    if (id === activeTabId) nextActive = idx > 0 ? tabs[idx - 1].id : tabs[idx + 1].id;
    set((s) => ({ tabs: tabs.filter((t) => t.id !== id), activeTabId: nextActive, realtime: dropRt(s.realtime) }));
  },

  requestCloseTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (tab && isTabDirty(tab, get().collections)) {
      set({ closingTabId: id });
      return;
    }
    get().closeTab(id);
  },

  confirmCloseTab: () => {
    const { closingTabId } = get();
    if (!closingTabId) return;
    set({ closingTabId: null });
    get().closeTab(closingTabId);
  },

  saveAndCloseTab: () => {
    const { closingTabId, collections } = get();
    if (!closingTabId) return;
    const tab = get().tabs.find((t) => t.id === closingTabId);
    set({ activeTabId: closingTabId });
    const savedNode = tab?.sourceNodeId && findNode(collections, tab.sourceNodeId);
    if (savedNode) {
      get().saveActiveRequest();
      set({ closingTabId: null });
      get().closeTab(closingTabId);
    } else {
      set({ closingTabId: null });
      get().saveActiveRequest();
    }
  },

  cancelCloseTab: () => set({ closingTabId: null }),

  setActiveTab: (id) => set({ activeTabId: id }),

  updateActiveTab: (updates) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, ...updates } : t)),
    })),

  setFullResponseBody: (tabId, responseId, rawText) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId && t.response?.responseId === responseId
          ? { ...t, response: { ...t.response, rawText, truncated: false } }
          : t,
      ),
    })),

  // --- Realtime ---

  setTabProtocol: (protocol) => {
    const id = get().activeTabId;
    closeConnection(id);
    get().updateActiveTab({ protocol });
    set((s) => ({ realtime: { ...s.realtime, [id]: { status: 'idle', messages: [], total: 0 } as RealtimeState } }));
  },

  wsConnect: (tabId) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const ws = buildWsRequest(tab, selectActiveVars(state), tabId);
    if (!ws) {
      set((s) => {
        const rt = s.realtime[tabId] ?? { status: 'idle', messages: [], total: 0 };
        const error = 'WebSocket URL must start with ws:// or wss://';
        return { realtime: { ...s.realtime, [tabId]: { ...rt, status: 'error', error } } };
      });
      return;
    }

    set((s) => ({
      realtime: { ...s.realtime, [tabId]: { status: 'connecting', messages: [], total: 0 } as RealtimeState },
    }));
    openWebSocket(tabId, ws.url, [], rtHandlers(tabId, set), ws.headers);
  },

  wsSend: (tabId, text) => {
    if (!text) return;
    if (!sendWebSocket(tabId, text)) return;
    set((s) => {
      const rt = s.realtime[tabId];
      if (!rt) return {};
      return { realtime: { ...s.realtime, [tabId]: pushRtMessage(rt, 'sent', text, byteLen(text)) } };
    });
  },

  wsDisconnect: (tabId) => {
    closeConnection(tabId);
    set((s) => {
      const rt = s.realtime[tabId] ?? { status: 'idle' as const, messages: [], total: 0 };
      return {
        realtime: { ...s.realtime, [tabId]: pushRtMessage({ ...rt, status: 'closed' }, 'system', 'Disconnected', 0) },
      };
    });
  },

  sseConnect: (tabId) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    // Same request assembly as HTTP sends (incl. form-data); the Rust engine streams it.
    const spec = buildRequestSpec(tab, selectActiveVars(state), tabId);
    const prevId = state.realtime[tabId]?.lastEventId;

    set((s) => ({
      realtime: {
        ...s.realtime,
        [tabId]: { status: 'connecting', messages: [], total: 0, lastEventId: prevId } as RealtimeState,
      },
    }));
    openSse(tabId, spec, prevId ?? null, rtHandlers(tabId, set));
  },
});
