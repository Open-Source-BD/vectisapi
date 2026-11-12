import type { Collection, FolderNode, RequestNode, TreeNode } from '../types';
import { generateId } from './id';

const deepClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// --- Lookups ---

export function findNode(cols: Collection[], id: string): TreeNode | null {
  for (const col of cols) {
    const found = findInNodes(col.children, id);
    if (found) return found;
  }
  return null;
}

function findInNodes(nodes: TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.type === 'folder') {
      const f = findInNodes(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

export function findCollection(cols: Collection[], id: string): Collection | null {
  return cols.find((c) => c.id === id) ?? null;
}

/** True if `id` is `node` itself or anywhere in its subtree. */
export function isDescendant(node: TreeNode, id: string): boolean {
  if (node.id === id) return true;
  if (node.type === 'folder') return node.children.some((c) => isDescendant(c, id));
  return false;
}

// --- Container child mutation (a container is a collection root or a folder) ---

function mapContainer(cols: Collection[], containerId: string, fn: (children: TreeNode[]) => TreeNode[]): Collection[] {
  return cols.map((col) =>
    col.id === containerId
      ? { ...col, children: fn(col.children) }
      : { ...col, children: mapFolderContainer(col.children, containerId, fn) },
  );
}

function mapFolderContainer(
  nodes: TreeNode[],
  containerId: string,
  fn: (children: TreeNode[]) => TreeNode[],
): TreeNode[] {
  return nodes.map((n) => {
    if (n.type !== 'folder') return n;
    if (n.id === containerId) return { ...n, children: fn(n.children) };
    return { ...n, children: mapFolderContainer(n.children, containerId, fn) };
  });
}

// --- Insert / remove / update ---

export function insertNode(cols: Collection[], parentId: string, node: TreeNode, index?: number): Collection[] {
  return mapContainer(cols, parentId, (children) => {
    const next = [...children];
    next.splice(index ?? next.length, 0, node);
    return next;
  });
}

export function removeNode(cols: Collection[], id: string): Collection[] {
  return cols.map((col) => ({ ...col, children: removeFromNodes(col.children, id) }));
}

function removeFromNodes(nodes: TreeNode[], id: string): TreeNode[] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) => (n.type === 'folder' ? { ...n, children: removeFromNodes(n.children, id) } : n));
}

export function updateNode(
  cols: Collection[],
  id: string,
  patch: Partial<FolderNode> & Partial<RequestNode>,
): Collection[] {
  return cols.map((col) => ({ ...col, children: patchNodes(col.children, id, patch) }));
}

function patchNodes(nodes: TreeNode[], id: string, patch: Partial<FolderNode> & Partial<RequestNode>): TreeNode[] {
  return nodes.map((n) => {
    if (n.id === id) return { ...n, ...patch } as TreeNode;
    if (n.type === 'folder') return { ...n, children: patchNodes(n.children, id, patch) };
    return n;
  });
}

// --- Move ---

export function moveNode(cols: Collection[], nodeId: string, targetParentId: string, index?: number): Collection[] {
  const node = findNode(cols, nodeId);
  if (!node) return cols;
  // Block dropping a folder into itself or a descendant.
  if (node.type === 'folder' && isDescendant(node, targetParentId)) return cols;
  if (nodeId === targetParentId) return cols;

  const without = removeNode(cols, nodeId);
  return insertNode(without, targetParentId, node, index);
}

// --- Duplicate ---

function withFreshIds(node: TreeNode): TreeNode {
  if (node.type === 'folder') {
    return { ...node, id: generateId(), children: node.children.map(withFreshIds) };
  }
  return {
    ...node,
    id: generateId(),
    request: { ...deepClone(node.request), id: generateId() },
  };
}

/** Duplicate the node, inserting the copy right after the original. */
export function duplicateNode(cols: Collection[], id: string): Collection[] {
  return cols.map((col) => ({ ...col, children: dupInNodes(col.children, id) }));
}

function dupInNodes(nodes: TreeNode[], id: string): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.id === id) {
      out.push(n);
      const copy = withFreshIds({ ...n, name: `${n.name} Copy` });
      out.push(copy);
    } else if (n.type === 'folder') {
      out.push({ ...n, children: dupInNodes(n.children, id) });
    } else {
      out.push(n);
    }
  }
  return out;
}

// --- Request listing (Collection Runner) ---

/** Depth-first list of every request inside a node list, preserving order. */
function flattenRequests(nodes: TreeNode[]): RequestNode[] {
  const out: RequestNode[] = [];
  for (const n of nodes) {
    if (n.type === 'request') out.push(n);
    else out.push(...flattenRequests(n.children));
  }
  return out;
}

/**
 * Ordered requests under a target id, which may be a collection root, a folder,
 * or a single request. Returns [] if the id is not found.
 */
export function listRequests(cols: Collection[], id: string): RequestNode[] {
  const col = findCollection(cols, id);
  if (col) return flattenRequests(col.children);
  const node = findNode(cols, id);
  if (!node) return [];
  return node.type === 'request' ? [node] : flattenRequests(node.children);
}

// --- Drop-target listing (collections + folders only) ---

export interface ContainerEntry {
  id: string;
  name: string;
  depth: number;
  kind: 'collection' | 'folder';
}

export function listContainers(cols: Collection[]): ContainerEntry[] {
  const out: ContainerEntry[] = [];
  for (const col of cols) {
    out.push({ id: col.id, name: col.name, depth: 0, kind: 'collection' });
    collectFolders(col.children, 1, out);
  }
  return out;
}

function collectFolders(nodes: TreeNode[], depth: number, out: ContainerEntry[]): void {
  for (const n of nodes) {
    if (n.type === 'folder') {
      out.push({ id: n.id, name: n.name, depth, kind: 'folder' });
      collectFolders(n.children, depth + 1, out);
    }
  }
}

// --- Node factories ---

export function makeFolder(name: string): FolderNode {
  return { id: generateId(), type: 'folder', name, children: [] };
}

export function makeRequest(name: string, request: RequestNode['request']): RequestNode {
  return { id: generateId(), type: 'request', name, request };
}

// --- Migration (legacy flat collections → nested tree) ---

interface MaybeLegacy {
  id?: string;
  name?: string;
  date?: string;
  children?: TreeNode[];
  request?: RequestNode['request'];
}

/** Accepts persisted/imported collections of either shape and returns the tree shape. */
export function migrateCollections(raw: unknown): Collection[] {
  if (!Array.isArray(raw)) return [];
  const modern: Collection[] = [];
  const legacy: RequestNode[] = [];

  for (const c of raw as MaybeLegacy[]) {
    if (c && Array.isArray(c.children)) {
      modern.push(c as Collection);
    } else if (c && c.request) {
      legacy.push({ id: generateId(), type: 'request', name: c.name || 'Request', request: c.request });
    }
  }

  if (legacy.length) {
    modern.push({
      id: generateId(),
      name: 'My Collection',
      children: legacy,
      date: new Date().toISOString(),
    });
  }
  return modern;
}
