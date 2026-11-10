import { useEffect, useRef, useState } from 'react';
import { PaneResizer } from '@/components/ui';
import { RequestPane } from './components/request/RequestPane';
import { RequestTabsBar } from './components/tabs/RequestTabsBar';
import { ResponsePane } from './components/response/ResponsePane';
import { RealtimePane } from './components/realtime/RealtimePane';
import { Sidebar } from './components/sidebar/Sidebar';
import { TopBar } from './components/TopBar';
import { CloseTabModal } from './components/modals/CloseTabModal';
import { CodeModal } from './components/modals/CodeModal';
import { CurlModal } from './components/modals/CurlModal';
import { EnvModal } from './components/modals/EnvModal';
import { MoveToModal } from './components/modals/MoveToModal';
import { ResponseModal } from './components/modals/ResponseModal';
import { RunnerModal } from './components/modals/RunnerModal';
import { CommandPalette } from './components/CommandPalette';
import { CookiesModal } from './components/modals/CookiesModal';
import { SaveModal } from './components/modals/SaveModal';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useRequestRunner } from './hooks/useRequestRunner';
import { exportData, parseImportFile } from './lib/importExport';
import { usePersistence } from './store/persist';
import { selectActiveTab, useApiStore } from './store/useApiStore';

export function ApiClient() {
  usePersistence();
  const hydrated = useApiStore((s) => s.hydrated);
  const theme = useApiStore((s) => s.theme);
  const activeProtocol = useApiStore((s) => selectActiveTab(s).protocol ?? 'http');
  const send = useRequestRunner();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Reconnect a previously-granted workspace folder (permission is re-queried).
  useEffect(() => {
    useApiStore.getState().restoreWorkspace();
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const [requestHeight, setRequestHeight] = useState(340);

  const resizeRequestPane = (clientY: number) => {
    const top = splitRef.current?.getBoundingClientRect().top ?? 0;
    const total = splitRef.current?.clientHeight ?? 0;
    const next = Math.max(120, Math.min(clientY - top, total - 160));
    setRequestHeight(next);
  };
  // Expand response → request small. Collapse response → request large.
  const expandResponse = () => setRequestHeight(140);
  const collapseResponse = () => setRequestHeight(Math.max(140, (splitRef.current?.clientHeight ?? 600) - 120));

  const triggerImport = () => fileInputRef.current?.click();
  const onExport = () => {
    const { collections, environments, globals } = useApiStore.getState();
    exportData(collections, environments, globals);
  };

  useKeyboardShortcuts({ send, triggerImport });

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { collections, environments } = await parseImportFile(file);
      useApiStore.getState().mergeImport(collections, environments);
      alert('Import successful!');
    } catch (err) {
      alert((err as Error).message || 'Import failed.');
    }
    e.target.value = '';
  };

  // Match the prior SSR-safe mount guard: render nothing meaningful until
  // localStorage has hydrated to avoid a hydration mismatch.
  if (!hydrated) {
    return (
      <div
        style={{
          height: '100vh',
          background: 'var(--md-sys-color-background)',
        }}
      />
    );
  }

  return (
    <div id="app">
      <Sidebar triggerImport={triggerImport} onExport={onExport} />
      <main className="main-area">
        <TopBar />
        <RequestTabsBar />
        {activeProtocol !== 'http' ? (
          <RealtimePane send={send} />
        ) : (
          <div className="pane-split" ref={splitRef}>
            <div className="request-pane-wrap" style={{ height: requestHeight }}>
              <RequestPane send={send} />
            </div>
            <PaneResizer onDrag={resizeRequestPane} />
            <ResponsePane onExpand={expandResponse} onCollapse={collapseResponse} />
          </div>
        )}
      </main>

      <input
        type="file"
        ref={fileInputRef}
        accept=".json,.yaml,.yml"
        style={{ display: 'none' }}
        onChange={handleImport}
      />

      <EnvModal />
      <SaveModal />
      <CodeModal />
      <MoveToModal />
      <CurlModal />
      <CloseTabModal />
      <ResponseModal />
      <RunnerModal />
      <CommandPalette />
      <CookiesModal />
    </div>
  );
}
