import { useState } from 'react';
import { useApiStore } from '../../store/useApiStore';
import { TreePicker } from '../collections/TreePicker';

export function MoveToModal() {
  const isOpen = useApiStore((s) => s.isMoveModalOpen);
  const moveNodeId = useApiStore((s) => s.moveNodeId);
  if (!isOpen || !moveNodeId) return null;
  return <MoveToModalInner moveNodeId={moveNodeId} />;
}

function MoveToModalInner({ moveNodeId }: { moveNodeId: string }) {
  const closeMoveModal = useApiStore((s) => s.closeMoveModal);
  const moveNode = useApiStore((s) => s.moveNode);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const onMove = () => {
    if (selectedId) moveNode(moveNodeId, selectedId);
    closeMoveModal();
  };

  return (
    <div
      className="md-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeMoveModal();
      }}
    >
      <div className="md-modal" style={{ maxWidth: '520px', width: '95%' }}>
        <div className="md-modal-header">
          <h3>Move to…</h3>
          <button className="md-icon-btn-small" onClick={closeMoveModal}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="md-modal-body">
          <label className="modal-label">Destination</label>
          <TreePicker selectedId={selectedId} onSelect={setSelectedId} excludeNodeId={moveNodeId} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button className="md-tonal-btn" onClick={closeMoveModal}>
              Cancel
            </button>
            <button className="md-filled-btn" disabled={!selectedId} onClick={onMove}>
              Move
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
