import { useCallback, useEffect, useState } from 'react';
import { useApiStore } from '../../store/useApiStore';
import { cookiesClear, cookiesClearDomain, cookiesList, type CookieView } from '../../lib/native/invoke';

/** "session" for session cookies, else a short local expiry date/time. */
function expiryHint(expires: number | null): string {
  if (expires === null) return 'session';
  return `expires ${new Date(expires * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

/** Manage the native cookie jar: view cookies per domain, clear by domain or all. */
export function CookiesModal() {
  const isOpen = useApiStore((s) => s.isCookieModalOpen);
  const setOpen = useApiStore((s) => s.setCookieModalOpen);
  const [cookies, setCookies] = useState<CookieView[]>([]);

  const reload = useCallback(() => {
    cookiesList()
      .then(setCookies)
      .catch((e) => {
        console.warn('cookies_list failed', e);
        setCookies([]);
      });
  }, []);

  // Read the jar each time the modal opens (it changes on every send).
  useEffect(() => {
    if (isOpen) reload();
  }, [isOpen, reload]);

  if (!isOpen) return null;

  const clearCookies = (domain?: string) => {
    void (domain ? cookiesClearDomain(domain) : cookiesClear())
      .catch((e) => console.warn('clearing cookies failed', e))
      .finally(reload);
  };

  const jar: Record<string, CookieView[]> = {};
  for (const c of cookies) (jar[c.domain] ??= []).push(c);
  const domains = Object.keys(jar).sort();

  return (
    <div
      className="md-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="md-modal" style={{ width: 560, maxWidth: '92vw' }}>
        <div className="md-modal-header">
          <h3>Cookies</h3>
          <button className="md-icon-btn-small" onClick={() => setOpen(false)} title="Close" aria-label="Close cookies">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="md-modal-body">
          <p className="cookies-intro">
            Cookies are captured from responses and sent automatically on matching hosts.
            {domains.length > 0 && (
              <button className="md-text-btn" onClick={() => clearCookies()} style={{ height: 28 }}>
                Clear all
              </button>
            )}
          </p>
          {domains.length === 0 && (
            <div className="cookies-empty">No cookies yet. Send a request that sets cookies.</div>
          )}
          {domains.map((domain) => (
            <div key={domain} className="cookies-domain">
              <div className="cookies-domain-head">
                <span className="cookies-host">{domain}</span>
                <button
                  className="md-icon-btn-small"
                  title={`Clear cookies for ${domain}`}
                  aria-label={`Clear cookies for ${domain}`}
                  onClick={() => clearCookies(domain)}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                    delete
                  </span>
                </button>
              </div>
              {jar[domain].map((c) => (
                <div key={`${c.path}\u0000${c.name}`} className="cookies-row">
                  <span className="cookies-name">{c.name}</span>
                  <span className="cookies-value">{c.value}</span>
                  {c.path !== '/' && <span className="cookies-value">{c.path}</span>}
                  <span className="cookies-value">{expiryHint(c.expires)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
