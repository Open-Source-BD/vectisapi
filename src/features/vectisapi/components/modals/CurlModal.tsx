import { useState } from 'react';
import { createDefaultTab, useApiStore } from '../../store/useApiStore';
import { parseCurl } from '../../lib/parseCurl';

export function CurlModal() {
  const isOpen = useApiStore((s) => s.isCurlModalOpen);
  if (!isOpen) return null;
  return <CurlModalInner />;
}

function CurlModalInner() {
  const setOpen = useApiStore((s) => s.setCurlModalOpen);
  const newTab = useApiStore((s) => s.newTab);
  const [text, setText] = useState('');

  const doImport = () => {
    if (!text.trim()) return;
    newTab(parseCurl(text, createDefaultTab()));
    setOpen(false);
  };

  return (
    <div
      className="md-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="md-modal" style={{ maxWidth: '640px', width: '95%' }}>
        <div className="md-modal-header">
          <h3>Import cURL</h3>
          <button className="md-icon-btn-small" onClick={() => setOpen(false)}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="md-modal-body">
          <textarea
            className="md-textarea"
            autoFocus
            placeholder="Paste a curl command…&#10;curl -X POST https://api.example.com -H 'Content-Type: application/json' -d '{&quot;a&quot;:1}'"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            style={{ width: '100%', minHeight: '160px', fontFamily: 'var(--mono-font)', marginBottom: '16px' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button className="md-tonal-btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="md-filled-btn" onClick={doImport} disabled={!text.trim()}>
              Import
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
