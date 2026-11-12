import { useEffect } from 'react';
import { useApiStore } from '../store/useApiStore';
import { exportData } from '../lib/importExport';

interface Options {
  send: () => void;
  triggerImport: () => void;
}

/**
 * Global Cmd/Ctrl keyboard shortcuts. Listener is bound once and torn down on
 * unmount; current state is read via `getState()` so the handler stays stable.
 */
export function useKeyboardShortcuts({ send, triggerImport }: Options): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const modifier = e.metaKey || e.ctrlKey;
      if (!modifier) return;
      const s = useApiStore.getState();
      const key = e.key.toLowerCase();

      if (e.key === 'Enter') {
        e.preventDefault();
        send();
      } else if (key === 'k') {
        e.preventDefault();
        s.setCommandPaletteOpen(!s.isCommandPaletteOpen);
      } else if (key === 's') {
        e.preventDefault();
        s.saveActiveRequest();
      } else if (key === 't') {
        e.preventDefault();
        s.newTab();
      } else if (key === 'w') {
        e.preventDefault();
        if (s.activeTabId) s.requestCloseTab(s.activeTabId);
      } else if (key === 'e') {
        e.preventDefault();
        if (e.shiftKey) s.setEnvModalOpen(true);
        else exportData(s.collections, s.environments);
      } else if (key === 'i') {
        e.preventDefault();
        triggerImport();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [send, triggerImport]);
}
