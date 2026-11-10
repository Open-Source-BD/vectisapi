import React, { useState } from 'react';
import { selectActiveTab, useApiStore } from '../../store/useApiStore';
import { formatSize } from '../../lib/format';
import { syntaxHighlight } from '../../lib/syntaxHighlight';
import { generateTypes, TYPE_LANGS, type TypeLang } from '../../lib/jsonToTypes';
import { parseSetCookie } from '../../lib/cookies';
import { diffLines, diffStats } from '../../lib/diffLines';
import { parseJsonBody } from '../../lib/parseJsonBody';
import { CodeView, JsonTree } from '@/components/ui';

/** Pretty-print a body for stable diffing (indented JSON when parseable). */
function prettyBody(rawText: string | undefined): string {
  if (rawText === undefined) return '';
  const v = parseJsonBody(rawText);
  if (v && typeof v === 'object') return JSON.stringify(v, null, 2);
  return rawText;
}

interface ResponsePaneProps {
  onExpand?: () => void;
  onCollapse?: () => void;
  /** Rendered inside the response modal — hides the expand/collapse/open controls. */
  inModal?: boolean;
}

export function ResponsePane({ onExpand, onCollapse, inModal }: ResponsePaneProps) {
  const tab = useApiStore(selectActiveTab);
  const updateActiveTab = useApiStore((s) => s.updateActiveTab);
  const setResponseModalOpen = useApiStore((s) => s.setResponseModalOpen);
  const res = tab.response;
  const [typeLang, setTypeLang] = useState<TypeLang>('typescript');
  const [bodyView, setBodyView] = useState<'pretty' | 'raw'>('pretty');
  const [bodySearch, setBodySearch] = useState('');

  const cookies = parseSetCookie(res?.headers['set-cookie']);

  const parsed = parseJsonBody(res?.rawText);

  const downloadBody = () => {
    if (!res) return;
    const blob = new Blob([res.rawText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `response.${isJson ? 'json' : 'txt'}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isJson = parsed !== undefined && typeof parsed === 'object' && parsed !== null;
  const prettyText = isJson ? JSON.stringify(parsed, null, 2) : (res?.rawText ?? '');
  const bodyHtml = isJson
    ? syntaxHighlight(prettyText)
    : (res?.rawText ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const typesCode = isJson ? generateTypes(parsed, typeLang) : '';

  const prev = tab.prevResponse;
  const diff = prev && res ? diffLines(prettyBody(prev.rawText), prettyBody(res.rawText)) : [];
  const diffSummary = diffStats(diff);

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
          <div>
            Time: <span className="value">{res?.timeTaken || '-'}</span> ms
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
                <JsonTree data={parsed} rawText={prettyText} query={bodySearch} />
              ) : (
                <CodeView text={prettyText} html={isJson ? syntaxHighlight(prettyText) : bodyHtml} wrap />
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
                {diffSummary.added === 0 && diffSummary.removed === 0 ? (
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
