import { useEffect, useMemo, useState } from 'react';
import { useApiStore } from '../../store/useApiStore';
import { filterHistory, groupHistoryByDate } from '../../lib/historyGroup';
import { searchHistory } from '../../lib/native/invoke';
import type { HistoryItem } from '../../types';
import { WindowedList } from './WindowedList';

const SEARCH_DEBOUNCE_MS = 150;
const DEFAULT_SEARCH_LIMIT = 1000;
/** Estimates for rows not yet measured (natural CSS sizes at rest). */
const LABEL_ESTIMATE = 25;
const ROW_ESTIMATE = 34;

type Row = { kind: 'label'; label: string } | { kind: 'item'; item: HistoryItem };

const rowEstimate = (row: Row) => (row.kind === 'label' ? LABEL_ESTIMATE : ROW_ESTIMATE);
const rowKey = (row: Row) => (row.kind === 'label' ? `label:${row.label}` : row.item.id);

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

  const limit = useApiStore((s) => s.settings?.historyLimit) ?? DEFAULT_SEARCH_LIMIT;

  // A non-empty query is answered by SQLite (FTS); the in-memory filter covers the gap until the
  // answer arrives and any search failure.
  const query = search.trim();
  const [found, setFound] = useState<{ query: string; items: HistoryItem[] } | null>(null);
  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchHistory(query, limit)
        .then((rows) => {
          if (cancelled) return;
          const items: HistoryItem[] = [];
          for (const row of rows) {
            try {
              items.push(JSON.parse(row) as HistoryItem);
            } catch {
              // skip an unreadable row
            }
          }
          setFound({ query, items });
        })
        .catch((e: unknown) => console.warn('search_history failed', e));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, limit]);

  const filtered = useMemo(() => {
    if (!query) return history;
    if (found?.query !== query) return filterHistory(history, query);
    const live = new Set(history.map((h) => h.id)); // a row deleted mid-search must disappear
    return found.items.filter((h) => live.has(h.id));
  }, [history, query, found]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const group of groupHistoryByDate(filtered, now)) {
      out.push({ kind: 'label', label: group.label });
      for (const item of group.items) out.push({ kind: 'item', item });
    }
    return out;
  }, [filtered, now]);

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

      {filtered.length === 0 ? (
        <div className="tree-scroll">
          <div className="sidebar-empty">
            <span className="material-symbols-outlined" style={{ fontSize: '36px', opacity: 0.5 }}>
              history
            </span>
            <span>{history.length === 0 ? 'No requests yet.' : 'No matches.'}</span>
          </div>
        </div>
      ) : (
        <WindowedList
          className="tree-scroll"
          items={rows}
          estimateHeight={rowEstimate}
          keyOf={rowKey}
          renderItem={(row) =>
            row.kind === 'label' ? (
              <div className="history-group-label">
                {row.label}
              </div>
            ) : (
              <div className="history-row" onClick={() => replayHistory(row.item)}>
                <span className={`h-method collection-method ${row.item.method.toLowerCase()}`}>{row.item.method}</span>
                <span className="h-url">{row.item.url}</span>
                <span className="h-status">{row.item.status || '—'}</span>
                <div className="h-actions">
                  <button
                    className="md-icon-btn-small"
                    title="Save to collection"
                    onClick={(e) => {
                      e.stopPropagation();
                      openSaveModalForHistory(row.item);
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
                      deleteHistoryItem(row.item.id);
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                      close
                    </span>
                  </button>
                </div>
              </div>
            )
          }
        />
      )}
    </div>
  );
}
