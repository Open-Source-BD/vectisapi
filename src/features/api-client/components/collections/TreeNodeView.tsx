/* eslint-disable react-hooks/refs -- dnd-kit's useDraggable/useDroppable return
   setNodeRef/transform/listeners that the React Compiler lint mis-classifies as
   refs; reading them in render is the library's intended usage. */
import { useState } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { TreeNode } from '../../types';
import { useApiStore } from '../../store/useApiStore';

export type NodeKind = 'collection' | 'folder' | 'request';
export interface MenuTarget {
  id: string;
  kind: NodeKind;
}

interface Props {
  node: TreeNode;
  depth: number;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  onContextMenu: (e: React.MouseEvent, target: MenuTarget) => void;
  activeSourceId?: string;
  forceExpand?: boolean;
}

export function TreeNodeView({
  node,
  depth,
  editingId,
  setEditingId,
  onContextMenu,
  activeSourceId,
  forceExpand,
}: Props) {
  const storeExpanded = useApiStore((s) => !!s.expanded[node.id]);
  const expanded = forceExpand || storeExpanded;
  const toggleExpanded = useApiStore((s) => s.toggleExpanded);
  const openRequestNode = useApiStore((s) => s.openRequestNode);
  const renameNode = useApiStore((s) => s.renameNode);

  const indent = { paddingLeft: 8 + depth * 14 };
  const isEditing = editingId === node.id;

  if (node.type === 'request') {
    return (
      <RequestRow
        node={node}
        style={indent}
        isEditing={isEditing}
        active={activeSourceId === node.id}
        onOpen={() => openRequestNode(node.id)}
        onCommit={(name) => {
          renameNode(node.id, name);
          setEditingId(null);
        }}
        onCancel={() => setEditingId(null)}
        onContextMenu={(e) => onContextMenu(e, { id: node.id, kind: 'request' })}
      />
    );
  }

  return (
    <>
      <FolderRow
        node={node}
        style={indent}
        expanded={expanded}
        isEditing={isEditing}
        onToggle={() => toggleExpanded(node.id)}
        onCommit={(name) => {
          renameNode(node.id, name);
          setEditingId(null);
        }}
        onCancel={() => setEditingId(null)}
        onContextMenu={(e) => onContextMenu(e, { id: node.id, kind: 'folder' })}
      />
      {expanded &&
        node.children.map((child) => (
          <TreeNodeView
            key={child.id}
            node={child}
            depth={depth + 1}
            editingId={editingId}
            setEditingId={setEditingId}
            onContextMenu={onContextMenu}
            activeSourceId={activeSourceId}
            forceExpand={forceExpand}
          />
        ))}
    </>
  );
}

function NameEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="md-input tree-rename-input"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => (value.trim() ? onCommit(value.trim()) : onCancel())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') value.trim() ? onCommit(value.trim()) : onCancel();
        else if (e.key === 'Escape') onCancel();
      }}
    />
  );
}

function FolderRow({
  node,
  style,
  expanded,
  isEditing,
  onToggle,
  onCommit,
  onCancel,
  onContextMenu,
}: {
  node: Extract<TreeNode, { type: 'folder' }>;
  style: React.CSSProperties;
  expanded: boolean;
  isEditing: boolean;
  onToggle: () => void;
  onCommit: (v: string) => void;
  onCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const drag = useDraggable({ id: node.id });
  const drop = useDroppable({ id: node.id });
  const transform = CSS.Translate.toString(drag.transform);

  return (
    <div ref={drop.setNodeRef} className={`tree-drop ${drop.isOver ? 'drop-target' : ''}`}>
      <div
        ref={drag.setNodeRef}
        className={`tree-row folder-row ${drag.isDragging ? 'dragging' : ''}`}
        style={{ ...style, transform }}
        onClick={onToggle}
        onContextMenu={onContextMenu}
        {...drag.attributes}
        {...drag.listeners}
      >
        <span className="material-symbols-outlined tree-chevron">{expanded ? 'expand_more' : 'chevron_right'}</span>
        <span className="material-symbols-outlined tree-icon">folder</span>
        {isEditing ? (
          <NameEditor initial={node.name} onCommit={onCommit} onCancel={onCancel} />
        ) : (
          <span className="tree-name">{node.name}</span>
        )}
      </div>
    </div>
  );
}

function RequestRow({
  node,
  style,
  isEditing,
  active,
  onOpen,
  onCommit,
  onCancel,
  onContextMenu,
}: {
  node: Extract<TreeNode, { type: 'request' }>;
  style: React.CSSProperties;
  isEditing: boolean;
  active: boolean;
  onOpen: () => void;
  onCommit: (v: string) => void;
  onCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const drag = useDraggable({ id: node.id });
  const transform = CSS.Translate.toString(drag.transform);

  return (
    <div
      ref={drag.setNodeRef}
      className={`tree-row request-row ${active ? 'active' : ''} ${drag.isDragging ? 'dragging' : ''}`}
      style={{ ...style, transform }}
      onClick={() => !isEditing && onOpen()}
      onContextMenu={onContextMenu}
      {...drag.attributes}
      {...drag.listeners}
    >
      <span className={`tree-method collection-method ${node.request.method.toLowerCase()}`}>
        {node.request.method}
      </span>
      {isEditing ? (
        <NameEditor initial={node.name} onCommit={onCommit} onCancel={onCancel} />
      ) : (
        <span className="tree-name">{node.name}</span>
      )}
    </div>
  );
}
