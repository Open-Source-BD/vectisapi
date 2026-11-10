import { useApiStore } from '../../store/useApiStore';

export function CloseTabModal() {
  const closingTabId = useApiStore((s) => s.closingTabId);
  if (!closingTabId) return null;
  return <CloseTabModalInner closingTabId={closingTabId} />;
}

function CloseTabModalInner({ closingTabId }: { closingTabId: string }) {
  const tabs = useApiStore((s) => s.tabs);
  const cancelCloseTab = useApiStore((s) => s.cancelCloseTab);
  const confirmCloseTab = useApiStore((s) => s.confirmCloseTab);
  const saveAndCloseTab = useApiStore((s) => s.saveAndCloseTab);

  const tab = tabs.find((t) => t.id === closingTabId);
  const name = tab ? tab.url || `${tab.method} request` : 'this request';

  return (
    <div
      className="md-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancelCloseTab();
      }}
    >
      <div className="md-modal" style={{ maxWidth: '440px', width: '95%' }}>
        <div className="md-modal-header">
          <h3>Unsaved changes</h3>
          <button className="md-icon-btn-small" onClick={cancelCloseTab}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="md-modal-body">
          <p style={{ marginBottom: '20px', color: 'var(--md-sys-color-on-surface-variant)' }}>
            Do you want to save the changes you made to <strong>{name}</strong>? Your changes will be lost if you
            don&apos;t save them.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button className="md-text-btn" onClick={confirmCloseTab}>
              Don&apos;t Save
            </button>
            <button className="md-tonal-btn" onClick={cancelCloseTab}>
              Cancel
            </button>
            <button className="md-filled-btn" onClick={saveAndCloseTab}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
