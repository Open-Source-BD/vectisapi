import { useApiStore } from '../../store/useApiStore';
import { findNode, isDescendant, listContainers } from '../../lib/collectionTree';

interface TreePickerProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Exclude this node and its subtree from the choices (for Move-to). */
  excludeNodeId?: string;
}

export function TreePicker({ selectedId, onSelect, excludeNodeId }: TreePickerProps) {
  const collections = useApiStore((s) => s.collections);
  const entries = listContainers(collections);
  const excludeNode = excludeNodeId ? findNode(collections, excludeNodeId) : null;
  const choices = excludeNode ? entries.filter((e) => !isDescendant(excludeNode, e.id)) : entries;

  if (choices.length === 0) {
    return <div className="tree-picker-empty">No collections yet — create one first.</div>;
  }

  return (
    <div className="tree-picker">
      {choices.map((c) => (
        <button
          key={c.id}
          className={`tree-picker-row ${selectedId === c.id ? 'selected' : ''}`}
          style={{ paddingLeft: 8 + c.depth * 16 }}
          onClick={() => onSelect(c.id)}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
            {c.kind === 'collection' ? 'folder_special' : 'folder'}
          </span>
          {c.name}
        </button>
      ))}
    </div>
  );
}
