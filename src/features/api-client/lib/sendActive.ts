import { selectActiveTab, selectActiveVars, useApiStore } from '../store/useApiStore';
import { executeRequest } from './executeRequest';
import { resolveEnv } from './envResolver';
import { generateId } from './id';
import type { TabState } from '../types';

/**
 * Send the active tab's request through the native engine and write the result
 * back to the store. The Rust cookie jar attaches and captures cookies itself.
 * Single-send only — the collection runner uses `executeRequest` directly.
 */
export async function executeActiveSend(): Promise<void> {
  const state = useApiStore.getState();
  const tab = selectActiveTab(state);
  if (!tab.url) return;
  // Realtime tabs (ws/sse) don't use the HTTP send pipeline.
  if (tab.protocol && tab.protocol !== 'http') return;

  state.setIsLoading(true);

  const vars = selectActiveVars(state);
  const resolved = resolveEnv(tab.url, vars).trim();
  // An unresolved `{{base}}` is left alone; the engine reports it as an invalid URL.
  if (!/^https?:\/\//i.test(resolved) && !resolved.startsWith('{{')) {
    state.updateActiveTab({ url: 'http://' + resolved });
  }

  const result = await executeRequest(tab, vars, {
    onSetVar: state.setEnvVar,
    timeoutMs: state.settings?.timeoutMs,
  });

  if (result.error?.phase === 'pre-request') {
    alert('Pre-request Script Error:\n' + result.error.message);
    state.setIsLoading(false);
    return;
  }

  if (result.error || !result.response) {
    state.updateActiveTab({
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
    state.setIsLoading(false);
    return;
  }

  // Success — keep the prior response for the Diff view.
  state.updateActiveTab({
    response: result.response,
    prevResponse: tab.response,
    activeResTab: 'body',
  });
  const snapshot: TabState = {
    ...JSON.parse(JSON.stringify(tab)),
    response: null,
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
  state.setIsLoading(false);
}
