import { useEffect } from 'react';
import { useApiStore } from './useApiStore';

const K_HISTORY = 'next-postman-history';
const K_COLLECTIONS = 'next-postman-collections';
const K_ENV = 'next-postman-environments';
const K_ACTIVE_ENV = 'next-postman-active-env';
const K_GLOBALS = 'next-postman-globals';
const K_TABS = 'next-postman-tabs';
const K_ACTIVE_TAB = 'next-postman-active-tab';
const K_THEME = 'next-postman-theme';
const K_COOKIES = 'next-postman-cookies';

/**
 * Hydrates the store from localStorage on mount, then subscribes to persist
 * history / collections / environments whenever they change. Hydration flips
 * the store's `hydrated` flag (read by the UI) — kept out of React state so we
 * don't call setState directly inside the effect.
 */
export function usePersistence(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      useApiStore.getState().hydrate({
        history: JSON.parse(localStorage.getItem(K_HISTORY) || '[]'),
        collections: JSON.parse(localStorage.getItem(K_COLLECTIONS) || '[]'),
        environments: JSON.parse(localStorage.getItem(K_ENV) || '[]'),
        activeEnvId: JSON.parse(localStorage.getItem(K_ACTIVE_ENV) || 'null'),
        globals: JSON.parse(localStorage.getItem(K_GLOBALS) || '[]'),
        tabs: JSON.parse(localStorage.getItem(K_TABS) || 'null') ?? undefined,
        activeTabId: JSON.parse(localStorage.getItem(K_ACTIVE_TAB) || 'null') ?? undefined,
        theme: JSON.parse(localStorage.getItem(K_THEME) || 'null') ?? undefined,
        cookieJar: JSON.parse(localStorage.getItem(K_COOKIES) || 'null') ?? undefined,
      });
    } catch {
      // corrupt storage → start clean (still mark hydrated)
      useApiStore.getState().hydrate({});
    }

    const unsub = useApiStore.subscribe((state, prev) => {
      if (state.history !== prev.history) {
        localStorage.setItem(K_HISTORY, JSON.stringify(state.history));
      }
      if (state.collections !== prev.collections) {
        localStorage.setItem(K_COLLECTIONS, JSON.stringify(state.collections));
      }
      if (state.environments !== prev.environments) {
        localStorage.setItem(K_ENV, JSON.stringify(state.environments));
      }
      if (state.activeEnvId !== prev.activeEnvId) {
        localStorage.setItem(K_ACTIVE_ENV, JSON.stringify(state.activeEnvId));
      }
      if (state.globals !== prev.globals) {
        localStorage.setItem(K_GLOBALS, JSON.stringify(state.globals));
      }
      if (state.tabs !== prev.tabs) {
        // Drop live responses to keep storage small; files don't serialize.
        localStorage.setItem(
          K_TABS,
          JSON.stringify(state.tabs.map((t) => ({ ...t, response: null, prevResponse: null }))),
        );
      }
      if (state.activeTabId !== prev.activeTabId) {
        localStorage.setItem(K_ACTIVE_TAB, JSON.stringify(state.activeTabId));
      }
      if (state.theme !== prev.theme) {
        localStorage.setItem(K_THEME, JSON.stringify(state.theme));
      }
      if (state.cookieJar !== prev.cookieJar) {
        localStorage.setItem(K_COOKIES, JSON.stringify(state.cookieJar));
      }
    });

    return unsub;
  }, []);
}
