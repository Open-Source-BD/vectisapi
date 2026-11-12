import type { TabState } from '../../types';
import { useApiStore } from '../../store/useApiStore';
import { isTabDirty } from '../../lib/tabDirty';

export function RequestTabsBar() {
  const tabs = useApiStore((s) => s.tabs);
  const activeTabId = useApiStore((s) => s.activeTabId);
  const collections = useApiStore((s) => s.collections);
  const setActiveTab = useApiStore((s) => s.setActiveTab);
  const requestCloseTab = useApiStore((s) => s.requestCloseTab);
  const newTab = useApiStore((s) => s.newTab);

  const isDirty = (t: TabState): boolean => isTabDirty(t, collections);

  return (
    <div className="request-tabs-bar md-surface">
      <div style={{ display: 'flex', flex: 1, overflowX: 'auto' }}>
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`req-tab ${t.id === activeTabId ? 'active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            <span className="req-tab-title">
              {t.method} {t.url ? t.url.split('?')[0].substring(0, 20) : 'Untitled Request'}
            </span>
            {isDirty(t) && <span className="req-tab-dirty" title="Unsaved changes" />}
            <button
              className="req-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                requestCloseTab(t.id);
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                close
              </span>
            </button>
          </div>
        ))}
      </div>
      <button className="md-icon-btn-small" onClick={() => newTab()} title="New Tab (Cmd+T)">
        <span className="material-symbols-outlined">add</span>
      </button>
    </div>
  );
}
