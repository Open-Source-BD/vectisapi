import { useApiStore } from '../store/useApiStore';

/** Non-blocking banner for a persistence problem (e.g. a write that failed twice). */
export function PersistNotice() {
  const notice = useApiStore((s) => s.persistNotice);
  const setNotice = useApiStore((s) => s.setPersistNotice);
  if (!notice) return null;
  return (
    <div
      role="status"
      className="persist-notice"
      style={{
        position: 'fixed',
        bottom: '16px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 8px 8px 16px',
        borderRadius: '8px',
        fontSize: '13px',
        maxWidth: 'calc(100% - 32px)',
        background: 'var(--md-sys-color-error-container)',
        color: 'var(--md-sys-color-on-error-container)',
      }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
        error
      </span>
      <span>{notice}</span>
      <button className="md-icon-btn-small" onClick={() => setNotice(null)} aria-label="Dismiss" title="Dismiss">
        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
          close
        </span>
      </button>
    </div>
  );
}
