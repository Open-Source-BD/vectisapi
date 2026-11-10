import { generateId } from '../../lib/id';
import type { TabState, EnvVar, RealtimeState, RtMessage } from '../../types';
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

/** Per-connection log caps: oldest messages are dropped first. */
export const RT_LOG_CAP = 5000;
export const RT_LOG_MAX_BYTES = 20 * 1024 * 1024;
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

const rtWeight = (m: RtMessage) => m.bytes || m.text.length;

/** Append a message to a connection's log, dropping the oldest while over the count/byte caps. `total` keeps counting. */
export function pushRtMessage(rt: RealtimeState, dir: RtMessage['dir'], text: string, bytes: number): RealtimeState {
  const truncated = text.length > RT_MSG_MAX ? `${text.slice(0, RT_MSG_MAX)}… [truncated, ${bytes} bytes]` : text;
  const msg: RtMessage = { id: generateId(), dir, text: truncated, bytes, ts: Date.now() };
  let logBytes = (rt.logBytes ?? rt.messages.reduce((n, m) => n + rtWeight(m), 0)) + rtWeight(msg);
  let drop = 0;
  const count = rt.messages.length + 1;
  // Always keep the newest message, even if it alone exceeds the byte cap.
  while (drop < count - 1 && (count - drop > RT_LOG_CAP || logBytes > RT_LOG_MAX_BYTES)) {
    logBytes -= rtWeight(rt.messages[drop]);
    drop++;
  }
  const messages = [...rt.messages.slice(drop), msg];
  return { ...rt, messages, logBytes, total: rt.total + 1 };
}
