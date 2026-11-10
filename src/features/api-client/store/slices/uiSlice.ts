import type { StateCreator } from 'zustand';
import type { StoreState } from './types';
import type { SidebarTab } from '../../types';
import type { CodeLang } from '../../lib/codegen';
import { getSettings, type Settings } from '../../lib/native/invoke';

export type Theme = 'light' | 'dark';
export type WorkspaceStatus = 'disconnected' | 'connected' | 'reconnect' | 'unsupported';

export interface UiSlice {
  theme: Theme;
  activeSidebarTab: SidebarTab;
  isLoading: boolean;
  isEnvModalOpen: boolean;
  isSaveModalOpen: boolean;
  isCodeModalOpen: boolean;
  isMoveModalOpen: boolean;
  isCurlModalOpen: boolean;
  isResponseModalOpen: boolean;
  isCommandPaletteOpen: boolean;
  isCookieModalOpen: boolean;
  historySearch: string;
  codeLang: CodeLang;
  codeSnippet: string;
  copied: boolean;
  /** Native app settings, loaded once at startup (`null` until loaded). */
  settings: Settings | null;

  // UI setters
  toggleExpanded: (id: string) => void;
  setCollectionSearch: (v: string) => void;
  setHistorySearch: (v: string) => void;
  setActiveSidebarTab: (tab: SidebarTab) => void;
  setIsLoading: (v: boolean) => void;
  setEnvModalOpen: (v: boolean) => void;
  setCurlModalOpen: (v: boolean) => void;
  setResponseModalOpen: (v: boolean) => void;
  setCommandPaletteOpen: (v: boolean) => void;
  setCookieModalOpen: (v: boolean) => void;
  setSaveModalOpen: (v: boolean) => void;
  setCodeModalOpen: (v: boolean) => void;
  setCodeLang: (v: CodeLang) => void;
  setCodeSnippet: (v: string) => void;
  setCopied: (v: boolean) => void;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
  loadSettings: () => Promise<void>;
}

export const createUiSlice: StateCreator<StoreState, [], [], UiSlice> = (set) => ({
  theme: 'light',
  activeSidebarTab: 'history',
  isLoading: false,
  isEnvModalOpen: false,
  isSaveModalOpen: false,
  isCodeModalOpen: false,
  isMoveModalOpen: false,
  isCurlModalOpen: false,
  isResponseModalOpen: false,
  isCommandPaletteOpen: false,
  isCookieModalOpen: false,
  historySearch: '',
  codeLang: 'curl' as CodeLang,
  codeSnippet: '',
  copied: false,
  settings: null,

  toggleExpanded: (id) => set((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })),
  setCollectionSearch: (collectionSearch) => set({ collectionSearch }),
  setHistorySearch: (historySearch) => set({ historySearch }),
  setActiveSidebarTab: (activeSidebarTab) => set({ activeSidebarTab }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setEnvModalOpen: (isEnvModalOpen) => set({ isEnvModalOpen }),
  setCurlModalOpen: (isCurlModalOpen) => set({ isCurlModalOpen }),
  setResponseModalOpen: (isResponseModalOpen) => set({ isResponseModalOpen }),
  setCommandPaletteOpen: (isCommandPaletteOpen) => set({ isCommandPaletteOpen }),
  setCookieModalOpen: (isCookieModalOpen) => set({ isCookieModalOpen }),
  setSaveModalOpen: (isSaveModalOpen) => set({ isSaveModalOpen }),
  setCodeModalOpen: (isCodeModalOpen) => set({ isCodeModalOpen }),
  setCodeLang: (codeLang) => set({ codeLang }),
  setCodeSnippet: (codeSnippet) => set({ codeSnippet }),
  setCopied: (copied) => set({ copied }),
  toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
  setTheme: (theme) => set({ theme }),
  loadSettings: async () => {
    try {
      set({ settings: await getSettings() });
    } catch (e) {
      // The engine still applies its own settings; only the UI copy is missing.
      console.warn('get_settings failed', e);
    }
  },
});
