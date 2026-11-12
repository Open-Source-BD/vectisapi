import { useState } from 'react';
import type { PendingSave } from '../../store/useApiStore';
import { useApiStore } from '../../store/useApiStore';
import { listContainers } from '../../lib/collectionTree';
import { TreePicker } from '../collections/TreePicker';

export function SaveModal() {
  const isOpen = useApiStore((s) => s.isSaveModalOpen);
  const pendingSave = useApiStore((s) => s.pendingSave);
  if (!isOpen || !pendingSave) return null;
  return <SaveModalInner pending={pendingSave} />;
}

function SaveModalInner({ pending }: { pending: PendingSave }) {
  const confirmSave = useApiStore((s) => s.confirmSave);
  const cancelSave = useApiStore((s) => s.cancelSave);
  const createCollection = useApiStore((s) => s.createCollection);
  const createFolder = useApiStore((s) => s.createFolder);

  const [name, setName] = useState(pending.suggestedName);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newCol, setNewCol] = useState('');
  const [newFolder, setNewFolder] = useState('');

  const addCollection = () => {
    const trimmed = newCol.trim();
    if (!trimmed) return;
    createCollection(trimmed);
    const cols = useApiStore.getState().collections;
    setSelectedId(cols[cols.length - 1].id);
    setNewCol('');
  };

  const addFolder = () => {
    const trimmed = newFolder.trim();
    if (!trimmed || !selectedId) return;
    const before = new Set(listContainers(useApiStore.getState().collections).map((c) => c.id));
    createFolder(selectedId, trimmed);
    const added = listContainers(useApiStore.getState().collections).find((c) => !before.has(c.id));
    if (added) setSelectedId(added.id);
    setNewFolder('');
  };

  const canSave = name.trim().length > 0 && selectedId !== null;

  return (
    <div
      className="md-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancelSave();
      }}
    >
      <div className="md-modal" style={{ maxWidth: '560px', width: '95%' }}>
        <div className="md-modal-header">
          <h3>Save Request</h3>
          <button className="md-icon-btn-small" onClick={cancelSave}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="md-modal-body">
          <label className="modal-label">Request name</label>
          <input
            className="md-input"
            autoFocus
            placeholder="e.g. Get Users"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: '100%', marginBottom: '20px' }}
          />

          <label className="modal-label">Save to</label>
          <TreePicker selectedId={selectedId} onSelect={setSelectedId} />

          <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
            <input
              className="md-input"
              placeholder="New collection name"
              value={newCol}
              onChange={(e) => setNewCol(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addCollection();
              }}
              style={{ flex: 1 }}
            />
            <button className="md-tonal-btn" onClick={addCollection} disabled={!newCol.trim()}>
              <span className="material-symbols-outlined">add</span> Create
            </button>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
            <input
              className="md-input"
              placeholder={selectedId ? 'New folder name' : 'Select a target first'}
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addFolder();
              }}
              disabled={!selectedId}
              style={{ flex: 1 }}
            />
            <button className="md-tonal-btn" onClick={addFolder} disabled={!selectedId || !newFolder.trim()}>
              <span className="material-symbols-outlined">create_new_folder</span> Folder
            </button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button className="md-tonal-btn" onClick={cancelSave}>
              Cancel
            </button>
            <button
              className="md-filled-btn"
              disabled={!canSave}
              onClick={() => selectedId && confirmSave(selectedId, name)}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
