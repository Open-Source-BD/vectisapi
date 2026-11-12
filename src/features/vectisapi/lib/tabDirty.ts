import type { Collection, TabState } from '../types';
import { findNode } from './collectionTree';
import { createDefaultTab } from '../store/useApiStore';

/** Stable key of the request-defining fields (ignores transient UI/response state). */
export function requestKey(t: TabState): string {
  return JSON.stringify({
    method: t.method,
    url: t.url,
    params: t.params,
    headers: t.headers,
    auth: t.auth,
    body: t.body,
    scripts: t.scripts,
    tests: t.tests,
  });
}

/**
 * True when a tab has unsaved edits:
 * - opened from a saved node → differs from that node's request
 * - unsaved (new/history) → differs from a blank default request (i.e. user typed something)
 */
export function isTabDirty(t: TabState, collections: Collection[]): boolean {
  if (t.sourceNodeId) {
    const node = findNode(collections, t.sourceNodeId);
    if (node && node.type === 'request') return requestKey(t) !== requestKey(node.request);
  }
  return requestKey(t) !== requestKey(createDefaultTab());
}
