import { useApiStore } from '../../store/useApiStore';
import { ResponsePane } from '../response/ResponsePane';

export function ResponseModal() {
  const isOpen = useApiStore((s) => s.isResponseModalOpen);
  const setOpen = useApiStore((s) => s.setResponseModalOpen);
  if (!isOpen) return null;

  return (
    <div
      className="md-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="md-modal response-modal">
        <div className="md-modal-header">
          <h3>Response</h3>
          <button className="md-icon-btn-small" onClick={() => setOpen(false)} title="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="response-modal-body">
          <ResponsePane inModal />
        </div>
      </div>
    </div>
  );
}
