import { useEffect, useRef, useState } from 'react';
import { useApiStore } from '../../store/useApiStore';
import { findCollection, findNode, listRequests } from '../../lib/collectionTree';
import type { RunResultItem } from '../../lib/collectionRunner';

const itemFailed = (r: RunResultItem): boolean =>
  !!r.error || r.status === 0 || r.status >= 400 || r.testResults.some((t) => !t.pass);

export function RunnerModal() {
  const nodeId = useApiStore((s) => s.runnerNodeId);
  if (!nodeId) return null;
  return <RunnerModalInner nodeId={nodeId} />;
}

function RunnerModalInner({ nodeId }: { nodeId: string }) {
  const collections = useApiStore((s) => s.collections);
  const running = useApiStore((s) => s.runnerRunning);
  const progress = useApiStore((s) => s.runnerProgress);
  const results = useApiStore((s) => s.runnerResults);
  const error = useApiStore((s) => s.runnerError);
  const startRun = useApiStore((s) => s.startRun);
  const cancelRun = useApiStore((s) => s.cancelRun);
  const closeRunner = useApiStore((s) => s.closeRunner);

  const [iterations, setIterations] = useState(1);
  const [dataText, setDataText] = useState('');
  const [showData, setShowData] = useState(false);

  const col = findCollection(collections, nodeId);
  const node = col ? null : findNode(collections, nodeId);
  const name = col?.name ?? node?.name ?? 'Selection';
  const requestCount = listRequests(collections, nodeId).length;

  const dialogRef = useRef<HTMLDivElement>(null);

  // A11y: focus the first control on open, trap Tab, Escape closes, restore focus.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = dialogRef.current;
    el?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeRunner();
        return;
      }
      if (e.key === 'Tab' && el) {
        const focusable = Array.from(
          el.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex]:not([tabindex="-1"])'),
        ).filter((n) => !n.hasAttribute('disabled'));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [closeRunner]);

  const passed = results.filter((r) => !itemFailed(r)).length;
  const totalTime = results.reduce((sum, r) => sum + r.timeTaken, 0);
  const hasRun = results.length > 0;
  const skipped = !running && hasRun && progress.current < progress.total ? progress.total - progress.current : 0;
  const showIteration = results.some((r) => r.iteration > 1);

  return (
    <div
      className="md-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) closeRunner();
      }}
    >
      <div
        className="md-modal runner-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="runner-title"
        ref={dialogRef}
      >
        <div className="md-modal-header">
          <h3 id="runner-title">Run Collection</h3>
          <button className="md-icon-btn-small" onClick={closeRunner} title="Close" aria-label="Close runner">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="md-modal-body runner-body">
          {/* Config row */}
          <div className="runner-config">
            <div className="runner-target">
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                folder
              </span>
              <span className="runner-target-name">{name}</span>
              <span className="runner-target-count">
                {requestCount} request{requestCount === 1 ? '' : 's'}
              </span>
            </div>
            <label className="runner-iter">
              Iterations
              <input
                type="number"
                min={1}
                className="md-input"
                value={iterations}
                disabled={running}
                onChange={(e) => setIterations(Math.max(1, Number(e.target.value) || 1))}
                style={{ width: 64 }}
              />
            </label>
            <button
              className="md-text-btn runner-data-toggle"
              onClick={() => setShowData((v) => !v)}
              disabled={running}
              aria-expanded={showData}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                dataset
              </span>
              Data file
            </button>
            {running ? (
              <button className="md-btn runner-cancel" onClick={cancelRun} data-autofocus>
                Cancel
              </button>
            ) : (
              <button
                className="md-btn runner-run"
                data-autofocus
                disabled={requestCount === 0}
                onClick={() => startRun({ iterations, dataText })}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                  play_arrow
                </span>
                {hasRun ? 'Run again' : 'Run'}
              </button>
            )}
          </div>

          {showData && (
            <textarea
              className="md-input runner-data"
              placeholder="Paste CSV (first row = headers) or a JSON array of objects. One iteration per row; use {{column}} or pm.iterationData.get('column')."
              value={dataText}
              disabled={running}
              onChange={(e) => setDataText(e.target.value)}
              rows={4}
            />
          )}

          {error && (
            <div className="runner-error" role="alert">
              {error}
            </div>
          )}

          {/* Progress */}
          {(running || hasRun) && progress.total > 0 && (
            <div className="runner-progress-wrap">
              <div className="runner-progress-track">
                <div
                  className="runner-progress-bar"
                  style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
                />
              </div>
              <div className="runner-progress-label" aria-live="polite">
                {running
                  ? `Running ${progress.current} of ${progress.total}`
                  : `${progress.current} of ${progress.total} done`}
                {skipped > 0 && ` — stopped, ${skipped} skipped`}
              </div>
            </div>
          )}

          {/* Summary */}
          {hasRun && (
            <div className={`runner-summary ${passed === results.length ? 'all-pass' : 'has-fail'}`}>
              <strong>
                {passed} / {results.length} passed
              </strong>
              <span className="runner-summary-time">{totalTime} ms total</span>
            </div>
          )}

          {/* Report */}
          <div className="runner-report">
            {!hasRun && !running && requestCount === 0 && (
              <div className="runner-empty">
                <span className="material-symbols-outlined" style={{ fontSize: '40px', opacity: 0.5 }}>
                  playlist_add
                </span>
                <span>This {col ? 'collection' : 'folder'} has no requests yet. Add requests to run them.</span>
              </div>
            )}
            {!hasRun && !running && requestCount > 0 && (
              <div className="runner-empty">
                <span className="material-symbols-outlined" style={{ fontSize: '40px', opacity: 0.5 }}>
                  play_circle
                </span>
                <span>
                  Press Run to execute {requestCount} request{requestCount === 1 ? '' : 's'} in order.
                </span>
              </div>
            )}
            {results.map((r, i) => {
              const failed = itemFailed(r);
              const testSummary = r.testResults.length
                ? `${r.testResults.filter((t) => t.pass).length}/${r.testResults.length} tests`
                : null;
              return (
                <div key={`${r.requestId}-${i}`} className="runner-row">
                  <span
                    className="material-symbols-outlined runner-row-icon"
                    style={{ color: failed ? 'var(--md-sys-color-error)' : 'var(--success)' }}
                    aria-label={failed ? 'failed' : 'passed'}
                  >
                    {failed ? 'cancel' : 'check_circle'}
                  </span>
                  <span className={`collection-method ${r.method.toLowerCase()}`}>{r.method}</span>
                  <span className="runner-row-name">{r.name}</span>
                  {showIteration && <span className="runner-row-iter">#{r.iteration}</span>}
                  <span className="runner-row-status">{r.error ? 'ERR' : r.status}</span>
                  {testSummary && <span className="runner-row-tests">{testSummary}</span>}
                  <span className="runner-row-time">{r.timeTaken} ms</span>
                  {r.error && <span className="runner-row-error">{r.error}</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
