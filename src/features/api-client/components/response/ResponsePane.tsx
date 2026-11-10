import React, { useMemo, useState } from 'react';
import { selectActiveTab, useApiStore } from '../../store/useApiStore';
import { formatSize } from '../../lib/format';
import { syntaxHighlight } from '../../lib/syntaxHighlight';
import { generateTypes, TYPE_LANGS, type TypeLang } from '../../lib/jsonToTypes';
import { parseSetCookie } from '../../lib/cookies';
import { diffLines, diffStats } from '../../lib/diffLines';
import { parseJsonBody } from '../../lib/parseJsonBody';
import { getResponseBody, saveResponseBody } from '../../lib/native/invoke';
import { decodeText, toNativeError } from '../../lib/native/decodeResponse';
import type { ResponseData } from '../../types';
import { CodeView, JsonTree } from '@/components/ui';
import { VIRTUALIZE_MIN_CHARS } from '@/components/ui/CodeView';
import { escapeHtml } from '@/components/ui/VirtualLines';

/** Line diff is an O(n*m) table; above this many cells the Diff tab says so instead. */
const MAX_DIFF_CELLS = 10_000_000;

/** Pretty-print a body for stable diffing (indented JSON when parseable). */
function prettyBody(rawText: string | undefined): string {
  if (rawText === undefined) return '';
  const v = parseJsonBody(rawText);
  if (v && typeof v === 'object') return JSON.stringify(v, null, 2);
  return rawText;
}

function lineCount(s: string): number {
  let n = 1;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

function extensionFor(contentType: string | undefined): string {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('html')) return 'html';
  if (ct.startsWith('text/')) return 'txt';
  return 'bin';
}

/** Save-dialog default: the final URL's last path segment, else `response.<ext from content-type>`. */
function suggestedFileName(res: ResponseData): string {
  // Native headers are lowercased by decodeResponse.joinHeaders; match case-insensitively anyway.
  const ctKey = Object.keys(res.headers).find((k) => k.toLowerCase() === 'content-type');
  const ext = extensionFor(ctKey === undefined ? undefined : res.headers[ctKey]);
  let segment = '';
  try {
    const raw = new URL(res.finalUrl ?? '').pathname.split('/').pop() ?? '';
    segment = decodeURIComponent(raw).replace(/[\\/:*?"<>|]/g, '_').trim();
  } catch {
    segment = '';
  }
  if (!segment || segment === '.' || segment === '..') return `response.${ext}`;
  return segment.includes('.') ? segment : `${segment}.${ext}`;
}

const formatMs = (ms: number) => `${Math.round(ms)} ms`;

interface ResponsePaneProps {
  onExpand?: () => void;
  onCollapse?: () => void;
  /** Rendered inside the response modal — hides the expand/collapse/open controls. */
  inModal?: boolean;
}

export function ResponsePane({ onExpand, onCollapse, inModal }: ResponsePaneProps) {
  const tab = useApiStore(selectActiveTab);
  const updateActiveTab = useApiStore((s) => s.updateActiveTab);
  const setFullResponseBody = useApiStore((s) => s.setFullResponseBody);
  const setResponseModalOpen = useApiStore((s) => s.setResponseModalOpen);
  const res = tab.response;
  const timing = res?.timing;
  const [timingOpen, setTimingOpen] = useState(false);
  const [typeLang, setTypeLang] = useState<TypeLang>('typescript');
  const [bodyView, setBodyView] = useState<'pretty' | 'raw'>('pretty');
  const [bodySearch, setBodySearch] = useState('');
  /** Keyed by responseId so a pending load / error doesn't leak onto another tab's response. */
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<{ id: string; message: string } | null>(null);

  const cookies = parseSetCookie(res?.headers['set-cookie']);

  // A truncated body is only a prefix: no parsing / pretty view / highlighting until it is loaded.
  const truncated = !!res?.truncated;
  const rawText = res?.rawText;
  const parsed = useMemo(() => (truncated ? undefined : parseJsonBody(rawText)), [truncated, rawText]);

  const loadFullBody = async () => {
    const id = res?.responseId;
    if (!id) return;
    const tabId = tab.id;
    setLoadingId(id);
    setBodyError(null);
    try {
      setFullResponseBody(tabId, id, decodeText(await getResponseBody(id)));
    } catch (e) {
      setBodyError({ id, message: toNativeError(e).message });
    } finally {
      setLoadingId((cur) => (cur === id ? null : cur));
    }
  };

  const downloadBody = async () => {
    if (!res) return;
    if (res.responseId) {
      // Native responses: Rust writes the exact stored bytes; null = dialog cancelled.
      const id = res.responseId;
      setBodyError(null);
      try {
        await saveResponseBody(id, suggestedFileName(res));
      } catch (e) {
        setBodyError({ id, message: toNativeError(e).message });
      }
      return;
    }
    const blob = new Blob([res.rawText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `response.${isJson ? 'json' : 'txt'}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isJson = parsed !== undefined && typeof parsed === 'object' && parsed !== null;
  const prettyText = useMemo(
    () => (isJson ? JSON.stringify(parsed, null, 2) : (rawText ?? '')),
    [isJson, parsed, rawText],
  );
  const largeBody = prettyText.length > VIRTUALIZE_MIN_CHARS;

  const typesCode = useMemo(
    () => (isJson && tab.activeResTab === 'types' ? generateTypes(parsed, typeLang) : ''),
    [isJson, parsed, typeLang, tab.activeResTab],
  );

  const prev = tab.prevResponse;
  const prevRaw = prev?.rawText;
  const diffResult = useMemo(() => {
    if (prevRaw === undefined || rawText === undefined || tab.activeResTab !== 'diff') return null;
    const a = prettyBody(prevRaw);
    const b = truncated ? rawText : prettyText;
    if (lineCount(a) * lineCount(b) > MAX_DIFF_CELLS) return 'too-large' as const;
    return diffLines(a, b);
  }, [prevRaw, rawText, truncated, prettyText, tab.activeResTab]);
  const diff = Array.isArray(diffResult) ? diffResult : [];
  const diffSummary = diffStats(diff);
  const error = res?.responseId && bodyError?.id === res.responseId ? bodyError.message : null;
  const loading = !!res?.responseId && loadingId === res.responseId;

  return (
    <section className="response-pane md-surface-container-lowest">
      <div className="response-header md-surface">
        <div
          className="status-badge"
          style={{ color: res ? (res.ok ? 'var(--success)' : 'var(--md-sys-color-error)') : '' }}
        >
          <span className="material-symbols-outlined status-icon">
            {res ? (res.ok ? 'check_circle' : 'error') : 'info'}
          </span>
          <span>{res ? `${res.status} ${res.statusText}` : 'Waiting for request...'}</span>
        </div>
        <div className="metrics">
          <div
            className="metric-time"
            onMouseEnter={() => setTimingOpen(true)}
            onMouseLeave={() => setTimingOpen(false)}
          >
            Time:{' '}
            {timing ? (
              <span
                className="value timing-trigger"
                tabIndex={0}
                aria-describedby={timingOpen ? 'response-timing-popover' : undefined}
                onFocus={() => setTimingOpen(true)}
                onBlur={() => setTimingOpen(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setTimingOpen(false);
                }}
              >
                {res?.timeTaken || '-'}
              </span>
            ) : (
              <span className="value">{res?.timeTaken || '-'}</span>
            )}{' '}
            ms
            {timing && timingOpen && (
              <div className="timing-popover" id="response-timing-popover" role="tooltip">
                <span>Time to first byte</span>
                <span>{formatMs(timing.ttfbMs)}</span>
                <span>Download</span>
                <span>{formatMs(Math.max(0, timing.totalMs - timing.ttfbMs))}</span>
                <span>Total</span>
                <span>{formatMs(timing.totalMs)}</span>
                {res?.httpVersion && (
                  <>
                    <span>HTTP version</span>
                    <span>{res.httpVersion}</span>
                  </>
                )}
              </div>
            )}
          </div>
          <div>
            Size: <span className="value">{res ? formatSize(res.size) : '-'}</span>
          </div>
          {!inModal && (
            <div className="response-view-actions">
              <button className="md-icon-btn-small" onClick={onExpand} title="Expand response">
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                  expand_less
                </span>
              </button>
              <button className="md-icon-btn-small" onClick={onCollapse} title="Collapse response">
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                  expand_more
                </span>
              </button>
              <button
                className="md-icon-btn-small"
                onClick={() => setResponseModalOpen(true)}
                title="Open in modal"
                disabled={!res}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                  open_in_full
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="md-tabs-header">
        {(['body', 'headers'] as const).map((t) => (
          <button
            key={t}
            className={`md-tab-btn ${tab.activeResTab === t ? 'active' : ''}`}
            onClick={() => updateActiveTab({ activeResTab: t })}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
        {isJson && (
          <button
            className={`md-tab-btn ${tab.activeResTab === 'types' ? 'active' : ''}`}
            onClick={() => updateActiveTab({ activeResTab: 'types' })}
          >
            Types
          </button>
        )}
        {cookies.length > 0 && (
          <button
            className={`md-tab-btn ${tab.activeResTab === 'cookies' ? 'active' : ''}`}
            onClick={() => updateActiveTab({ activeResTab: 'cookies' })}
          >
            Cookies ({cookies.length})
          </button>
        )}
        {res?.testResults && res.testResults.length > 0 && (
          <button
            className={`md-tab-btn ${tab.activeResTab === 'testresults' ? 'active' : ''}`}
            onClick={() => updateActiveTab({ activeResTab: 'testresults' })}
          >
            Test Results
          </button>
        )}
        {prev && res && (
          <button
            className={`md-tab-btn ${tab.activeResTab === 'diff' ? 'active' : ''}`}
            onClick={() => updateActiveTab({ activeResTab: 'diff' })}
            title="Compare this response with the previous run"
          >
            Diff
          </button>
        )}
      </div>

      <div className="response-content">
        {!res && (
          <div className="empty-state">
            <span className="material-symbols-outlined" style={{ fontSize: '48px', opacity: 0.5 }}>
              cloud_download
            </span>
            <span>Enter URL and click Send to get a response</span>
          </div>
        )}

        {res && (
          <>
            <div
              className={`md-tab-content ${tab.activeResTab === 'body' ? 'active' : ''}`}
              style={{ padding: 0, minHeight: 'unset' }}
            >
              <div className="types-bar">
                {truncated && (
                  <>
                    <span className="body-notice">Preview only — showing the start of a {formatSize(res.size)} body.</span>
                    <button className="types-lang-btn" onClick={loadFullBody} disabled={loading}>
                      {loading ? 'Loading…' : `Load full body (${formatSize(res.size)})`}
                    </button>
                  </>
                )}
                {error && (
                  <span className="body-error" role="alert">
                    {error}
                  </span>
                )}
                {isJson && (
                  <>
                    <button
                      className={`types-lang-btn ${bodyView === 'pretty' ? 'active' : ''}`}
                      onClick={() => setBodyView('pretty')}
                    >
                      Pretty
                    </button>
                    <button
                      className={`types-lang-btn ${bodyView === 'raw' ? 'active' : ''}`}
                      onClick={() => setBodyView('raw')}
                    >
                      Raw
                    </button>
                    {bodyView === 'pretty' && (
                      <input
                        className="md-input"
                        placeholder="Filter…"
                        value={bodySearch}
                        onChange={(e) => setBodySearch(e.target.value)}
                        style={{ height: '28px', flex: 1, minWidth: '120px' }}
                      />
                    )}
                  </>
                )}
                <button className="types-lang-btn" onClick={downloadBody} style={{ marginLeft: 'auto' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '14px', verticalAlign: 'middle' }}>
                    download
                  </span>{' '}
                  Download
                </button>
              </div>
              {isJson && bodyView === 'pretty' ? (
                <JsonTree
                  // Remount when crossing the size line so a large body never inherits "expanded".
                  key={largeBody ? 'large' : 'small'}
                  data={parsed}
                  rawText={prettyText}
                  query={bodySearch}
                  initiallyOpen={!largeBody}
                />
              ) : (
                <CodeView text={prettyText} highlight={isJson ? syntaxHighlight : escapeHtml} wrap />
              )}
            </div>

            <div
              className={`md-tab-content ${tab.activeResTab === 'headers' ? 'active' : ''}`}
              style={{ padding: 0, minHeight: 'unset' }}
            >
              <div className="res-headers-grid">
                {Object.keys(res.headers).map((k) => (
                  <React.Fragment key={k}>
                    <div className="header-key">{k}</div>
                    <div className="header-value">{res.headers[k]}</div>
                  </React.Fragment>
                ))}
              </div>
            </div>

            {isJson && (
              <div
                className={`md-tab-content ${tab.activeResTab === 'types' ? 'active' : ''}`}
                style={{ padding: 0, minHeight: 'unset' }}
              >
                <div className="types-bar">
                  {TYPE_LANGS.map((l) => (
                    <button
                      key={l.id}
                      className={`types-lang-btn ${typeLang === l.id ? 'active' : ''}`}
                      onClick={() => setTypeLang(l.id)}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
                <CodeView text={typesCode} />
              </div>
            )}

            {cookies.length > 0 && (
              <div className={`md-tab-content ${tab.activeResTab === 'cookies' ? 'active' : ''}`}>
                <div className="res-headers-grid">
                  {cookies.map((c, i) => (
                    <React.Fragment key={i}>
                      <div className="header-key">{c.name}</div>
                      <div className="header-value">
                        {c.value}
                        {c.attributes && (
                          <span style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: '12px' }}>
                            {' '}
                            — {c.attributes}
                          </span>
                        )}
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            )}

            <div className={`md-tab-content ${tab.activeResTab === 'testresults' ? 'active' : ''}`}>
              <div style={{ marginBottom: '16px', fontWeight: 500 }}>
                Tests: {res.testResults.filter((t) => t.pass).length}/{res.testResults.length} passed
              </div>
              {res.testResults.map((test, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    gap: '8px',
                    alignItems: 'flex-start',
                    padding: '8px 0',
                    borderBottom: '1px solid var(--md-sys-color-outline-variant)',
                  }}
                >
                  <span
                    className="material-symbols-outlined"
                    style={{ color: test.pass ? 'var(--success)' : 'var(--md-sys-color-error)', fontSize: '18px' }}
                  >
                    {test.pass ? 'check_circle' : 'cancel'}
                  </span>
                  <div>
                    <div
                      style={{
                        fontWeight: 500,
                        color: test.pass ? 'var(--md-sys-color-on-surface)' : 'var(--md-sys-color-error)',
                      }}
                    >
                      {test.name}
                    </div>
                    {!test.pass && (
                      <div
                        style={{
                          fontSize: '12px',
                          color: 'var(--md-sys-color-on-surface-variant)',
                          fontFamily: 'var(--mono-font)',
                          marginTop: '4px',
                        }}
                      >
                        {test.error}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {prev && (
              <div
                className={`md-tab-content ${tab.activeResTab === 'diff' ? 'active' : ''}`}
                style={{ padding: 0, minHeight: 'unset' }}
              >
                <div className="diff-summary">
                  <span className="diff-prev">prev {prev.status}</span>
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                    arrow_forward
                  </span>
                  <span className="diff-cur">current {res.status}</span>
                  <span className="diff-counts">
                    <span className="diff-add-count">+{diffSummary.added}</span>{' '}
                    <span className="diff-del-count">-{diffSummary.removed}</span>
                  </span>
                </div>
                {diffResult === 'too-large' ? (
                  <div className="empty-state" style={{ padding: '32px' }}>
                    <span>Bodies are too large to diff line by line.</span>
                  </div>
                ) : diffSummary.added === 0 && diffSummary.removed === 0 ? (
                  <div className="empty-state" style={{ padding: '32px' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '40px', opacity: 0.5 }}>
                      check
                    </span>
                    <span>Response body is identical to the previous run.</span>
                  </div>
                ) : (
                  <pre className="diff-view">
                    {diff.map((line, i) => (
                      <div key={i} className={`diff-line diff-${line.type}`}>
                        <span className="diff-gutter">
                          {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                        </span>
                        {line.text || ' '}
                      </div>
                    ))}
                  </pre>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
