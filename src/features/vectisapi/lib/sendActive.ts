import { selectActiveTab, selectActiveVars, useApiStore } from '../store/useApiStore';
import { executeRequest } from './executeRequest';
import { resolveEnv } from './envResolver';
import { generateId } from './id';
import type { TabState } from '../types';

/** Tab id → the abort controller of that tab's send in flight. */
const inflight = new Map<string, AbortController>();

/** Cancels the HTTP send in flight on `tabId`; false if that tab isn't sending. */
export function cancelSend(tabId: string): boolean {
  const controller = inflight.get(tabId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Cancels the active tab's HTTP send, if any. */
export function cancelActiveSend(): boolean {
  return cancelSend(useApiStore.getState().activeTabId);
}

/**
 * Send the active tab's request through the native engine and write the result
 * back to that tab (even if the user switched tabs meanwhile). The Rust cookie
 * jar attaches and captures cookies itself. Each tab sends independently and can
 * be cancelled with `cancelSend`; a tab already sending ignores another send.
 * Single-send only — the collection runner uses `executeRequest` directly.
 */
export async function executeActiveSend(): Promise<void> {
  const state = useApiStore.getState();
  const tab = selectActiveTab(state);
  if (!tab.url) return;
  // Realtime tabs (ws/sse) don't use the HTTP send pipeline.
  if (tab.protocol && tab.protocol !== 'http') return;
  if (inflight.has(tab.id)) return;

  const controller = new AbortController();
  inflight.set(tab.id, controller);
  state.setTabLoading(tab.id, true);
  try {
    await send(tab, controller.signal);
  } finally {
    inflight.delete(tab.id);
    useApiStore.getState().setTabLoading(tab.id, false);
  }
}

async function send(tab: TabState, signal: AbortSignal): Promise<void> {
  const state = useApiStore.getState();
  const vars = selectActiveVars(state);
  const resolved = resolveEnv(tab.url, vars).trim();
  // An unresolved `{{base}}` is left alone; the engine reports it as an invalid URL.
  if (!/^https?:\/\//i.test(resolved) && !resolved.startsWith('{{')) {
    state.updateTab(tab.id, { url: 'http://' + resolved });
  }

  // No timeoutMs: the engine applies the live settings timeout.
  const result = await executeRequest(tab, vars, { onSetVar: state.setEnvVar, signal });

  if (result.error?.phase === 'pre-request') {
    state.updateTab(tab.id, {
      response: {
        ok: false,
        status: 0,
        statusText: 'Script Error',
        timeTaken: 0,
        size: 0,
        rawText: result.error.message,
        headers: {},
        testResults: [],
      },
      activeResTab: 'body',
    });
    return;
  }

  if (result.error || !result.response) {
    state.updateTab(tab.id, {
      response: result.response ?? {
        ok: false,
        status: 0,
        statusText: 'Error',
        timeTaken: 0,
        size: 0,
        rawText: result.error?.message ?? 'Request failed',
        headers: {},
        testResults: [],
      },
      activeResTab: 'body',
    });
    return;
  }

  // Success — keep the prior response for the Diff view.
  state.updateTab(tab.id, {
    response: result.response,
    prevResponse: tab.response,
    activeResTab: 'body',
  });
  // Clone without the responses: they can hold a fully loaded 50 MB body, and history stores requests only.
  const snapshot: TabState = {
    ...JSON.parse(JSON.stringify({ ...tab, response: null, prevResponse: null })),
    sourceNodeId: undefined,
  };
  state.addHistory({
    id: generateId(),
    method: tab.method,
    url: result.finalUrl ?? tab.url,
    status: result.response.status,
    time: result.response.timeTaken,
    date: new Date().toISOString(),
    request: snapshot,
  });
}
