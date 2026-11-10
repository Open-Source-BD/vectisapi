import { selectActiveTab, selectActiveVars, useApiStore } from '../store/useApiStore';
import { executeRequest } from './executeRequest';
import { resolveEnv } from './envResolver';
import { cookieHeaderFor } from './cookies';
import { generateId } from './id';
import type { TabState } from '../types';

/**
 * Send the active tab's request and write the result back to the store. Shared by
 * the Send button (proxy with auto browser-direct fallback on a bot-wall challenge)
 * and the "Retry from browser" panel action (`forceDirect`). Single-send only —
 * the collection runner uses `executeRequest` directly without transport switching.
 */
export async function executeActiveSend(opts: { forceDirect?: boolean } = {}): Promise<void> {
  const state = useApiStore.getState();
  const tab = selectActiveTab(state);
  if (!tab.url) return;
  // Realtime tabs (ws/sse) don't use the HTTP send pipeline.
  if (tab.protocol && tab.protocol !== 'http') return;

  state.setIsLoading(true);

  const vars = selectActiveVars(state);
  const resolved = resolveEnv(tab.url, vars).trim();
  if (!/^https?:\/\//i.test(resolved)) {
    state.updateActiveTab({ url: 'http://' + resolved });
  }

  const cookieHeader = cookieHeaderFor(state.cookieJar, resolved);
  const result = await executeRequest(tab, vars, {
    onSetVar: state.setEnvVar,
    cookieHeader,
    directFallback: opts.forceDirect ? 'off' : 'auto',
    forceDirect: opts.forceDirect,
  });

  if (result.error?.phase === 'pre-request') {
    alert('Pre-request Script Error:\n' + result.error.message);
    state.setIsLoading(false);
    return;
  }

  // A manual browser-direct retry that failed: keep the challenge panel open and
  // attach the honest failure message so the user can try again.
  if (opts.forceDirect && result.error && tab.challenge) {
    state.updateActiveTab({ challenge: { ...tab.challenge, retryError: result.error.message } });
    state.setIsLoading(false);
    return;
  }

  // A bot-wall challenge that was NOT auto-retried → render the panel (no response).
  if (result.challenge) {
    state.updateActiveTab({ response: null, challenge: result.challenge, activeResTab: 'body' });
    state.setIsLoading(false);
    return;
  }

  if (result.error || !result.response) {
    state.updateActiveTab({
      response: {
        ok: false,
        status: 0,
        statusText: 'Proxy Error',
        timeTaken: 0,
        size: 0,
        rawText: result.error?.message ?? 'Request failed',
        headers: {},
        testResults: [],
      },
      challenge: null,
      activeResTab: 'body',
    });
    state.setIsLoading(false);
    return;
  }

  // Success — keep the prior response for the Diff view, clear any challenge panel.
  state.updateActiveTab({
    response: result.response,
    prevResponse: tab.response,
    challenge: null,
    activeResTab: 'body',
  });
  // Set-Cookie isn't readable on a cross-origin direct response, so only the proxy
  // path feeds the jar (and a challenge response never reaches here at all).
  if (result.response.transport !== 'direct') {
    state.captureCookies(result.finalUrl ?? tab.url, result.response.headers['set-cookie']);
  }
  const snapshot: TabState = {
    ...JSON.parse(JSON.stringify(tab)),
    response: null,
    challenge: null,
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
