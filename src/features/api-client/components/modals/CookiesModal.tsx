import { useApiStore } from '../../store/useApiStore';

/** Manage the persisted cookie jar: view cookies per host, clear by host or all. */
export function CookiesModal() {
  const isOpen = useApiStore((s) => s.isCookieModalOpen);
  const setOpen = useApiStore((s) => s.setCookieModalOpen);
  const jar = useApiStore((s) => s.cookieJar);
  const clearCookies = useApiStore((s) => s.clearCookies);
  if (!isOpen) return null;

  const domains = Object.keys(jar)
    .filter((d) => jar[d]?.length)
    .sort();

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
                <div key={c.name} className="cookies-row">
                  <span className="cookies-name">{c.name}</span>
                  <span className="cookies-value">{c.value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
