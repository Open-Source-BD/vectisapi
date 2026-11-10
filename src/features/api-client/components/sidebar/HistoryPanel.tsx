import { useState } from 'react';
import { useApiStore } from '../../store/useApiStore';
import { filterHistory, groupHistoryByDate } from '../../lib/historyGroup';

export function HistoryPanel() {
  // Captured once at mount; deterministic for the session and lint-pure.
  const [now] = useState(() => Date.now());
  const history = useApiStore((s) => s.history);
  const search = useApiStore((s) => s.historySearch);
  const setSearch = useApiStore((s) => s.setHistorySearch);
  const clearHistory = useApiStore((s) => s.clearHistory);
  const deleteHistoryItem = useApiStore((s) => s.deleteHistoryItem);
  const replayHistory = useApiStore((s) => s.replayHistory);
  const openSaveModalForHistory = useApiStore((s) => s.openSaveModalForHistory);

  const filtered = filterHistory(history, search);
  const groups = groupHistoryByDate(filtered, now);

  return (
    <div className="history-panel">
      <div className="history-toolbar">
        <span
          className="material-symbols-outlined"
          style={{ fontSize: '18px', color: 'var(--md-sys-color-on-surface-variant)' }}
        >
          search
        </span>
        <input
          className="sidebar-search-input"
          placeholder="Search history"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            background: 'none',
            border: 'none',
            outline: 'none',
            color: 'var(--md-sys-color-on-surface)',
            fontSize: '13px',
          }}
        />
        <button
          className="md-icon-btn-small"
          onClick={clearHistory}
          title="Clear history"
          disabled={history.length === 0}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
            delete_sweep
          </span>
        </button>
      </div>

      <div className="tree-scroll">
        {filtered.length === 0 && (
          <div className="sidebar-empty">
            <span className="material-symbols-outlined" style={{ fontSize: '36px', opacity: 0.5 }}>
              history
            </span>
            <span>{history.length === 0 ? 'No requests yet.' : 'No matches.'}</span>
          </div>
        )}
        {groups.map((group) => (
          <div key={group.label}>
            <div className="history-group-label">{group.label}</div>
            {group.items.map((item) => (
              <div key={item.id} className="history-row" onClick={() => replayHistory(item)}>
                <span className={`h-method collection-method ${item.method.toLowerCase()}`}>{item.method}</span>
                <span className="h-url">{item.url}</span>
                <span className="h-status">{item.status || '—'}</span>
                <div className="h-actions">
                  <button
                    className="md-icon-btn-small"
                    title="Save to collection"
                    onClick={(e) => {
                      e.stopPropagation();
                      openSaveModalForHistory(item);
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                      bookmark_add
                    </span>
                  </button>
                  <button
                    className="md-icon-btn-small danger"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteHistoryItem(item.id);
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                      close
                    </span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
