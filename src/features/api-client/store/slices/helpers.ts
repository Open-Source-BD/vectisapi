import { generateId } from '../../lib/id';
import type { TabState, EnvVar } from '../../types';
import type { StoreState } from './types';

export function createDefaultTab(): TabState {
  return {
    id: generateId(),
    protocol: 'http',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: {
      type: 'none',
      bearer: '',
      basicUser: '',
      basicPass: '',
      apiKeyName: '',
      apiKeyValue: '',
      apiKeyIn: 'header',
      oauthToken: '',
      jwtToken: '',
      jwtPrefix: 'Bearer',
    },
    body: { type: 'none', formdata: [], urlencoded: [], rawContent: '', rawType: 'application/json' },
    scripts: '',
    tests: '',
    response: null,
    activeSubTab: 'params',
    activeResTab: 'body',
  };
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Snapshot a tab as a storable request (no live response, no tab-source link). */
export function snapshotRequest(tab: TabState): TabState {
  const snap = clone(tab);
  snap.response = null;
  snap.sourceNodeId = undefined;
  return snap;
}

export const RT_LOG_CAP = 500;
export const RT_MSG_MAX = 100_000;

export interface PendingSave {
  request: TabState;
  suggestedName: string;
  /** When true, saving links the active tab to the new node via sourceNodeId. */
  fromActiveTab: boolean;
}

/** Selector helper: the currently active tab (falls back to first). */
export const selectActiveTab = (s: StoreState): TabState => s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0];

/** Resolved variable list for the active env: globals first, active env overrides. */
export const selectActiveVars = (s: StoreState): EnvVar[] => {
  const active = s.environments.find((e) => e.id === s.activeEnvId);
  return [...s.globals, ...(active?.vars ?? [])];
};
