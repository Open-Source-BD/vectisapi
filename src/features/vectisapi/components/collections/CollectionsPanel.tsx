/* eslint-disable react-hooks/refs -- dnd-kit's useDroppable returns setNodeRef/isOver
   that the React Compiler lint mis-classifies as refs; reading them in render is intended. */
import { useState } from 'react';
import { DndContext, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import type { Collection, TreeNode } from '../../types';
import { selectActiveTab, useApiStore } from '../../store/useApiStore';
import { exportPostman } from '../../lib/importExport';
import { TreeNodeView, type MenuTarget } from './TreeNodeView';
import { ContextMenu, type MenuItem } from './ContextMenu';

interface MenuState {
  x: number;
  y: number;
  target: MenuTarget;
}

function filterCollections(cols: Collection[], query: string): Collection[] {
  const q = query.trim().toLowerCase();
  if (!q) return cols;
  const filterNodes = (nodes: TreeNode[]): TreeNode[] =>
    nodes.flatMap<TreeNode>((n) => {
      if (n.type === 'request') {
        return n.name.toLowerCase().includes(q) || n.request.url.toLowerCase().includes(q) ? [n] : [];
      }
      const kids = filterNodes(n.children);
      return kids.length || n.name.toLowerCase().includes(q) ? [{ ...n, children: kids }] : [];
    });
  return cols.flatMap((c) => {
    const kids = filterNodes(c.children);
    return kids.length || c.name.toLowerCase().includes(q) ? [{ ...c, children: kids }] : [];
  });
}

export function CollectionsPanel() {
  const collections = useApiStore((s) => s.collections);
  const search = useApiStore((s) => s.collectionSearch);
  const setSearch = useApiStore((s) => s.setCollectionSearch);
  const activeSourceId = useApiStore((s) => selectActiveTab(s).sourceNodeId);

  const createCollection = useApiStore((s) => s.createCollection);
  const moveNode = useApiStore((s) => s.moveNode);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (overId && activeId !== overId) moveNode(activeId, overId);
  };

  const openMenu = (e: React.MouseEvent, target: MenuTarget) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  };

  const newCollection = () => {
    createCollection('New Collection');
    const cols = useApiStore.getState().collections;
    setEditingId(cols[cols.length - 1].id);
  };

  const visible = filterCollections(collections, search);
  const forceExpand = !!search.trim();

  return (
    <div className="collections-panel">
      <div className="sidebar-search">
        <span className="material-symbols-outlined">search</span>
        <input placeholder="Search collections" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="md-text-btn" onClick={newCollection} title="New Collection">
          <span className="material-symbols-outlined">create_new_folder</span>
        </button>
      </div>

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="tree-scroll">
          {visible.length === 0 && (
            <div className="sidebar-empty">
              <span className="material-symbols-outlined" style={{ fontSize: '36px', opacity: 0.5 }}>
                folder_open
              </span>
              <span>No collections. Create one to save requests.</span>
            </div>
          )}
          {visible.map((col) => (
            <CollectionRoot
              key={col.id}
              collection={col}
              editingId={editingId}
              setEditingId={setEditingId}
              onContextMenu={openMenu}
              activeSourceId={activeSourceId}
              forceExpand={forceExpand}
            />
          ))}
        </div>
      </DndContext>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.target, setEditingId)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function CollectionRoot({
  collection,
  editingId,
  setEditingId,
  onContextMenu,
  activeSourceId,
  forceExpand,
}: {
  collection: Collection;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  onContextMenu: (e: React.MouseEvent, target: MenuTarget) => void;
  activeSourceId?: string;
  forceExpand: boolean;
}) {
  const storeExpanded = useApiStore((s) => s.expanded[collection.id]);
  const expanded = forceExpand || storeExpanded !== false; // collections default to expanded
  const toggleExpanded = useApiStore((s) => s.toggleExpanded);
  const renameCollection = useApiStore((s) => s.renameCollection);
  const drop = useDroppable({ id: collection.id });
  const isEditing = editingId === collection.id;

  return (
    <div className="collection-root">
      <div
        ref={drop.setNodeRef}
        className={`tree-row collection-row ${drop.isOver ? 'drop-target' : ''}`}
        onClick={() => toggleExpanded(collection.id)}
        onContextMenu={(e) => onContextMenu(e, { id: collection.id, kind: 'collection' })}
      >
        <span className="material-symbols-outlined tree-chevron">{expanded ? 'expand_more' : 'chevron_right'}</span>
        <span className="material-symbols-outlined tree-icon">folder_special</span>
        {isEditing ? (
          <input
            className="md-input tree-rename-input"
            autoFocus
            defaultValue={collection.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v) renameCollection(collection.id, v);
              setEditingId(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              else if (e.key === 'Escape') setEditingId(null);
            }}
          />
        ) : (
          <span className="tree-name collection-root-name">{collection.name}</span>
        )}
      </div>
      {expanded &&
        collection.children.map((child) => (
          <TreeNodeView
            key={child.id}
            node={child}
            depth={1}
            editingId={editingId}
            setEditingId={setEditingId}
            onContextMenu={onContextMenu}
            activeSourceId={activeSourceId}
            forceExpand={forceExpand}
          />
        ))}
    </div>
  );
}

function buildMenuItems(target: MenuTarget, setEditingId: (id: string) => void): MenuItem[] {
  const s = useApiStore.getState();
  const rename = () => setEditingId(target.id);

  if (target.kind === 'request') {
    return [
      { label: 'Open', icon: 'open_in_new', onClick: () => s.openRequestNode(target.id) },
      { label: 'Rename', icon: 'edit', onClick: rename },
      { label: 'Duplicate', icon: 'content_copy', onClick: () => s.duplicateNode(target.id) },
      { label: 'Move to…', icon: 'drive_file_move', onClick: () => s.openMoveModal(target.id) },
      { label: 'Delete', icon: 'delete', danger: true, onClick: () => s.deleteNode(target.id) },
    ];
  }

  if (target.kind === 'folder') {
    return [
      { label: 'Run', icon: 'play_arrow', onClick: () => s.openRunner(target.id) },
      { label: 'Add Request', icon: 'add', onClick: () => s.addRequest(target.id) },
      { label: 'New Folder', icon: 'create_new_folder', onClick: () => s.createFolder(target.id, 'New Folder') },
      { label: 'Rename', icon: 'edit', onClick: rename },
      { label: 'Duplicate', icon: 'content_copy', onClick: () => s.duplicateNode(target.id) },
      { label: 'Move to…', icon: 'drive_file_move', onClick: () => s.openMoveModal(target.id) },
      { label: 'Delete', icon: 'delete', danger: true, onClick: () => s.deleteNode(target.id) },
    ];
  }

  // collection
  const col = s.collections.find((c) => c.id === target.id);
  return [
    { label: 'Run', icon: 'play_arrow', onClick: () => s.openRunner(target.id) },
    { label: 'Add Request', icon: 'add', onClick: () => s.addRequest(target.id) },
    { label: 'New Folder', icon: 'create_new_folder', onClick: () => s.createFolder(target.id, 'New Folder') },
    { label: 'Rename', icon: 'edit', onClick: rename },
    { label: 'Export (Postman v2.1)', icon: 'download', onClick: () => col && exportPostman(col) },
    { label: 'Delete', icon: 'delete', danger: true, onClick: () => s.deleteCollection(target.id) },
  ];
}
