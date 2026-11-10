import { useEffect, useState } from 'react';
import { useApiStore } from '../../store/useApiStore';
import { getAppVersion, openDataDir, type Settings } from '../../lib/native/invoke';
import { exportAll, importAll, importNextPostman } from '../../lib/native/backup';

const MB = 1024 * 1024;
export const HISTORY_LIMIT_MIN = 50;
export const HISTORY_LIMIT_MAX = 10_000;
export const STORE_CAP_MIN_MB = 64;
export const STORE_CAP_MAX_MB = 4096;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Empty, or an http(s)/socks5 proxy URL. */
export function isValidProxyUrl(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  try {
    const url = new URL(v);
    return ['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) && !!url.hostname;
  } catch {
    return false;
  }
}

/** Form text → a non-negative integer, or null if it isn't one. */
function parseCount(text: string): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  return Number(text);
}

export function SettingsModal() {
  const isOpen = useApiStore((s) => s.isSettingsModalOpen);
  const settings = useApiStore((s) => s.settings);
  const loadSettings = useApiStore((s) => s.loadSettings);
  useEffect(() => {
    if (isOpen && !settings) void loadSettings();
  }, [isOpen, settings, loadSettings]);
  if (!isOpen || !settings) return null;
  return <SettingsModalInner initial={settings} />;
}

function SettingsModalInner({ initial }: { initial: Settings }) {
  const setOpen = useApiStore((s) => s.setSettingsModalOpen);
  const saveSettings = useApiStore((s) => s.saveSettings);
  const theme = useApiStore((s) => s.theme);
  const setTheme = useApiStore((s) => s.setTheme);

  const [timeout, setTimeoutText] = useState(String(initial.timeoutMs));
  const [followRedirects, setFollowRedirects] = useState(initial.followRedirects);
  const [maxRedirects, setMaxRedirects] = useState(String(initial.maxRedirects));
  const [verifyTls, setVerifyTls] = useState(initial.verifyTls);
  const [proxyUrl, setProxyUrl] = useState(initial.proxyUrl ?? '');
  const [userAgent, setUserAgent] = useState(initial.userAgent ?? '');
  const [storeCapMb, setStoreCapMb] = useState(String(Math.round(initial.responseStoreCapBytes / MB)));
  const [historyLimit, setHistoryLimit] = useState(String(initial.historyLimit));
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);

  useEffect(() => {
    getAppVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const close = () => setOpen(false);
  const proxyOk = isValidProxyUrl(proxyUrl);
  const timeoutMs = parseCount(timeout);
  const maxRedirectsN = parseCount(maxRedirects);
  const capMb = parseCount(storeCapMb);
  const historyN = parseCount(historyLimit);
  const formError =
    timeoutMs === null
      ? 'Timeout must be a whole number of milliseconds (0 = none).'
      : maxRedirectsN === null
        ? 'Max redirects must be a whole number.'
        : !proxyOk
          ? 'Proxy URL must start with http://, https:// or socks5://'
          : capMb === null
            ? 'Response store cap must be a whole number of MB.'
            : historyN === null
              ? 'History limit must be a whole number.'
              : null;

  const save = async () => {
    if (formError) return;
    const next: Settings = {
      ...initial,
      timeoutMs: timeoutMs!,
      followRedirects,
      maxRedirects: maxRedirectsN!,
      verifyTls,
      proxyUrl: proxyUrl.trim() || null,
      userAgent: userAgent.trim() || null,
      responseStoreCapBytes: clamp(capMb!, STORE_CAP_MIN_MB, STORE_CAP_MAX_MB) * MB,
      historyLimit: clamp(historyN!, HISTORY_LIMIT_MIN, HISTORY_LIMIT_MAX),
    };
    setBusy(true);
    try {
      await saveSettings(next);
      close();
    } catch (e) {
      setStatus({ text: `Saving settings failed: ${errorText(e)}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  /** Runs a backup action, showing its outcome in the status line. */
  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setStatus(null);
    try {
      const done = await action();
      if (done) setStatus({ text: done });
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const onExport = () => run(async () => ((await exportAll()) ? 'Backup exported.' : null));
  const onImport = () => {
    setConfirmImport(false);
    void run(async () => {
      if (!(await importAll())) return null;
      close(); // the form shows the settings from before the import
      return null;
    });
  };
  const onImportNp = (source: 'zip' | 'folder') =>
    run(async () => {
      const counts = await importNextPostman(source);
      return counts
        ? `Imported ${counts.collections} collection(s) and ${counts.environments} environment(s) from next-postman.`
        : null;
    });

  const icon = (name: string) => <span className="material-symbols-outlined">{name}</span>;
  const row = { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap' } as const;
  const check = { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '14px' } as const;

  return (
    <div
      className="md-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="md-modal" style={{ maxWidth: '640px', width: '95%' }} role="dialog" aria-label="Settings">
        <div className="md-modal-header">
          <h3>Settings</h3>
          <button className="md-icon-btn-small" onClick={close} aria-label="Close settings">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="md-modal-body">
          <label className="modal-label" htmlFor="set-timeout">
            Request timeout (ms, 0 = none)
          </label>
          <input
            id="set-timeout"
            className="md-input"
            inputMode="numeric"
            value={timeout}
            onChange={(e) => setTimeoutText(e.target.value)}
            style={{ width: '100%', marginBottom: '16px' }}
          />

          <div style={row}>
            <label style={check}>
              <input
                type="checkbox"
                checked={followRedirects}
                onChange={(e) => setFollowRedirects(e.target.checked)}
                aria-label="Follow redirects"
              />
              Follow redirects
            </label>
            <label style={{ ...check, marginLeft: 'auto' }} htmlFor="set-max-redirects">
              Max redirects
            </label>
            <input
              id="set-max-redirects"
              className="md-input"
              inputMode="numeric"
              value={maxRedirects}
              disabled={!followRedirects}
              onChange={(e) => setMaxRedirects(e.target.value)}
              style={{ width: '90px' }}
            />
          </div>

          <label style={{ ...check, marginBottom: verifyTls ? '16px' : '4px' }}>
            <input
              type="checkbox"
              checked={verifyTls}
              onChange={(e) => setVerifyTls(e.target.checked)}
              aria-label="Verify TLS certificates"
            />
            Verify TLS certificates
          </label>
          {!verifyTls && (
            <div role="note" style={{ color: 'var(--md-sys-color-error)', fontSize: '12px', marginBottom: '16px' }}>
              Certificate checks are off: any server can impersonate the host you call.
            </div>
          )}

          <label className="modal-label" htmlFor="set-proxy">
            Proxy URL
          </label>
          <input
            id="set-proxy"
            className="md-input"
            placeholder="http://proxy:8080 or socks5://host:1080 (empty = none)"
            value={proxyUrl}
            aria-invalid={!proxyOk}
            onChange={(e) => setProxyUrl(e.target.value)}
            style={{ width: '100%', marginBottom: '16px' }}
          />

          <label className="modal-label" htmlFor="set-ua">
            Default User-Agent
          </label>
          <input
            id="set-ua"
            className="md-input"
            placeholder={`VectisAPI/${version}`}
            value={userAgent}
            onChange={(e) => setUserAgent(e.target.value)}
            style={{ width: '100%', marginBottom: '16px' }}
          />

          <div style={row}>
            <label style={check} htmlFor="set-cap">
              Response store cap (MB, {STORE_CAP_MIN_MB}–{STORE_CAP_MAX_MB})
            </label>
            <input
              id="set-cap"
              className="md-input"
              inputMode="numeric"
              value={storeCapMb}
              onChange={(e) => setStoreCapMb(e.target.value)}
              style={{ width: '90px' }}
            />
            <label style={{ ...check, marginLeft: 'auto' }} htmlFor="set-history">
              History limit ({HISTORY_LIMIT_MIN}–{HISTORY_LIMIT_MAX.toLocaleString('en-US')})
            </label>
            <input
              id="set-history"
              className="md-input"
              inputMode="numeric"
              value={historyLimit}
              onChange={(e) => setHistoryLimit(e.target.value)}
              style={{ width: '90px' }}
            />
          </div>

          <div style={row}>
            <label style={check} htmlFor="set-theme">
              Theme
            </label>
            <select
              id="set-theme"
              className="md-select"
              value={theme}
              onChange={(e) => setTheme(e.target.value === 'dark' ? 'dark' : 'light')}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>

          <label className="modal-label">Backup</label>
          <div style={row}>
            <button className="md-tonal-btn" disabled={busy} onClick={() => void onExport()}>
              {icon('download')} Export all
            </button>
            <button className="md-tonal-btn" disabled={busy} onClick={() => setConfirmImport(true)}>
              {icon('upload')} Import all
            </button>
            <button className="md-tonal-btn" disabled={busy} onClick={() => void openDataDir().catch(() => {})}>
              {icon('folder_open')} Open data folder
            </button>
          </div>
          {confirmImport && (
            <div style={{ ...row, fontSize: '13px' }} role="alert">
              <span>Importing a backup replaces all collections, environments, history and settings.</span>
              <button className="md-filled-btn" disabled={busy} onClick={onImport}>
                Choose backup…
              </button>
              <button className="md-text-btn" onClick={() => setConfirmImport(false)}>
                Keep current data
              </button>
            </div>
          )}

          <label className="modal-label">Import next-postman workspace</label>
          <div style={row}>
            <button className="md-tonal-btn" disabled={busy} onClick={() => void onImportNp('zip')}>
              {icon('folder_zip')} Import next-postman workspace (zip)
            </button>
            <button className="md-tonal-btn" disabled={busy} onClick={() => void onImportNp('folder')}>
              {icon('folder')} Import next-postman workspace (folder)
            </button>
          </div>

          <div
            aria-live="polite"
            style={{
              minHeight: '18px',
              fontSize: '13px',
              marginBottom: '12px',
              color: status?.error || formError ? 'var(--md-sys-color-error)' : undefined,
            }}
          >
            {status?.text ?? formError ?? ''}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button className="md-tonal-btn" onClick={close}>
              Cancel
            </button>
            <button className="md-filled-btn" disabled={busy || !!formError} onClick={() => void save()}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
