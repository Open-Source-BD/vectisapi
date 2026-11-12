import type { HttpMethod } from './http';
import type { TabState } from './tab';

export interface HistoryItem {
  id: string;
  method: HttpMethod;
  url: string;
  status: number;
  time: number;
  date: string;
  /** Full request snapshot for high-fidelity replay (optional for legacy items). */
  request?: TabState;
}

export type TreeNodeType = 'folder' | 'request';

export interface FolderNode {
  id: string;
  type: 'folder';
  name: string;
  children: TreeNode[];
}

export interface RequestNode {
  id: string;
  type: 'request';
  name: string;
  request: TabState;
}

export type TreeNode = FolderNode | RequestNode;

/** A collection is the root of a tree; its children are folders and requests. */
export interface Collection {
  id: string;
  name: string;
  description?: string;
  children: TreeNode[];
  date: string;
}

/** Legacy flat collection shape (pre-tree). Used only for migration. */
export interface LegacyCollection {
  id: string;
  name: string;
  request: TabState;
  date: string;
}
