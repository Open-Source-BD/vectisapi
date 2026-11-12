import { useApiStore } from '../../store/useApiStore';
import { CollectionsPanel } from '../collections/CollectionsPanel';
import { HistoryPanel } from './HistoryPanel';

interface SidebarProps {
  triggerImport: () => void;
  onExport: () => void;
}

export function Sidebar({ triggerImport, onExport }: SidebarProps) {
  const activeSidebarTab = useApiStore((s) => s.activeSidebarTab);
  const setActiveSidebarTab = useApiStore((s) => s.setActiveSidebarTab);

  return (
    <aside className="sidebar md-surface">
      <div className="sidebar-tabs md-surface-container">
        <button
          className={`sidebar-tab ${activeSidebarTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveSidebarTab('history')}
        >
          History
        </button>
        <button
          className={`sidebar-tab ${activeSidebarTab === 'collections' ? 'active' : ''}`}
          onClick={() => setActiveSidebarTab('collections')}
        >
          Collections
        </button>
      </div>
      <div className="sidebar-actions md-surface-container-low">
        <button className="md-icon-btn" onClick={triggerImport} title="Import JSON / Postman (Cmd+I)">
          <span className="material-symbols-outlined">download</span> Import
        </button>
        <button className="md-icon-btn" onClick={onExport} title="Export JSON (Cmd+E)">
          <span className="material-symbols-outlined">upload</span> Export
        </button>
      </div>
      <div className="sidebar-content">{activeSidebarTab === 'history' ? <HistoryPanel /> : <CollectionsPanel />}</div>
    </aside>
  );
}
