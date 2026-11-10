import type { StateCreator } from 'zustand';
import type { StoreState } from './types';
import type { SidebarTab } from '../../types';
import type { CodeLang } from '../../lib/codegen';
import { getSettings, setSettings, type Settings } from '../../lib/native/invoke';

export type Theme = 'light' | 'dark';

export interface UiSlice {
  theme: Theme;
  activeSidebarTab: SidebarTab;
  /** Tabs with an HTTP send in flight (tab id → true); each tab sends and cancels on its own. */
  loadingTabs: Record<string, boolean>;
  isEnvModalOpen: boolean;
  isSaveModalOpen: boolean;
  isCodeModalOpen: boolean;
  isMoveModalOpen: boolean;
  isCurlModalOpen: boolean;
  isResponseModalOpen: boolean;
  isCommandPaletteOpen: boolean;
  isCookieModalOpen: boolean;
  isSettingsModalOpen: boolean;
  historySearch: string;
  codeLang: CodeLang;
  codeSnippet: string;
  copied: boolean;
  /** Native app settings, loaded once at startup (`null` until loaded). */
  settings: Settings | null;
  /** Non-blocking persistence problem shown in a banner (`null` = none). */
  persistNotice: string | null;

  // UI setters
  toggleExpanded: (id: string) => void;
  setCollectionSearch: (v: string) => void;
  setHistorySearch: (v: string) => void;
  setActiveSidebarTab: (tab: SidebarTab) => void;
  setTabLoading: (tabId: string, loading: boolean) => void;
  setEnvModalOpen: (v: boolean) => void;
  setCurlModalOpen: (v: boolean) => void;
  setResponseModalOpen: (v: boolean) => void;
  setCommandPaletteOpen: (v: boolean) => void;
  setCookieModalOpen: (v: boolean) => void;
  setSettingsModalOpen: (v: boolean) => void;
  setSaveModalOpen: (v: boolean) => void;
  setCodeModalOpen: (v: boolean) => void;
  setCodeLang: (v: CodeLang) => void;
  setCodeSnippet: (v: string) => void;
  setCopied: (v: boolean) => void;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
  setPersistNotice: (v: string | null) => void;
  loadSettings: () => Promise<void>;
  /** Saves via `set_settings` (Rust applies them), then updates `settings`. Rejects if saving fails. */
  saveSettings: (settings: Settings) => Promise<void>;
}

export const createUiSlice: StateCreator<StoreState, [], [], UiSlice> = (set) => ({
  theme: 'light',
  activeSidebarTab: 'history',
  loadingTabs: {},
  isEnvModalOpen: false,
  isSaveModalOpen: false,
  isCodeModalOpen: false,
  isMoveModalOpen: false,
  isCurlModalOpen: false,
  isResponseModalOpen: false,
  isCommandPaletteOpen: false,
  isCookieModalOpen: false,
  isSettingsModalOpen: false,
  historySearch: '',
  codeLang: 'curl' as CodeLang,
  codeSnippet: '',
  copied: false,
  settings: null,
  persistNotice: null,

  toggleExpanded: (id) => set((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })),
  setCollectionSearch: (collectionSearch) => set({ collectionSearch }),
  setHistorySearch: (historySearch) => set({ historySearch }),
  setActiveSidebarTab: (activeSidebarTab) => set({ activeSidebarTab }),
  setTabLoading: (tabId, loading) =>
    set((s) => {
      const loadingTabs = { ...s.loadingTabs };
      if (loading) loadingTabs[tabId] = true;
      else delete loadingTabs[tabId];
      return { loadingTabs };
    }),
  setEnvModalOpen: (isEnvModalOpen) => set({ isEnvModalOpen }),
  setCurlModalOpen: (isCurlModalOpen) => set({ isCurlModalOpen }),
  setResponseModalOpen: (isResponseModalOpen) => set({ isResponseModalOpen }),
  setCommandPaletteOpen: (isCommandPaletteOpen) => set({ isCommandPaletteOpen }),
  setCookieModalOpen: (isCookieModalOpen) => set({ isCookieModalOpen }),
  setSettingsModalOpen: (isSettingsModalOpen) => set({ isSettingsModalOpen }),
  setSaveModalOpen: (isSaveModalOpen) => set({ isSaveModalOpen }),
  setCodeModalOpen: (isCodeModalOpen) => set({ isCodeModalOpen }),
  setCodeLang: (codeLang) => set({ codeLang }),
  setCodeSnippet: (codeSnippet) => set({ codeSnippet }),
  setCopied: (copied) => set({ copied }),
  toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
  setTheme: (theme) => set({ theme }),
  setPersistNotice: (persistNotice) => set({ persistNotice }),
  loadSettings: async () => {
    try {
      set({ settings: await getSettings() });
    } catch (e) {
      // The engine still applies its own settings; only the UI copy is missing.
      console.warn('get_settings failed', e);
    }
  },
  saveSettings: async (settings) => {
    await setSettings(settings);
    set({ settings });
  },
});
