/// <reference lib="webworker" />
import { PmSandbox } from './pmSandbox';
// CSP note: the page CSP (tauri.conf.json) has no 'unsafe-eval' on purpose. Tauri attaches a CSP
// header only to .html assets, so this worker script is served without one and may eval user
// scripts; no page code compiles scripts. If a webview applies the page CSP to workers anyway,
// compile() reports "Scripts are blocked by the content security policy" (see Task 16 smoke test).
import type { ScriptResult, ScriptRun } from './scriptHost';

// `vars` for the test phase already include pre-request writes, so iteration data is not re-overlaid.
/** Worker entry: runs one pre-request/test script in an isolated global scope. */
export function handleRun(run: ScriptRun): ScriptResult {
  const setVars: [string, string][] = [];
  const seed = Object.entries(run.vars).map(([key, value]) => ({ id: `v:${key}`, key, value }));
  const sandbox = new PmSandbox(seed, (k, v) => setVars.push([k, v]), run.iterationData, run.phase === 'pre');
  let error: string | undefined;
  if (run.phase === 'pre') {
    try {
      sandbox.runPreRequest(run.code);
    } catch (e) {
      error = (e as Error).message;
    }
  } else {
    const r = run.response;
    if (r) sandbox.attachResponse(r.code, r.status, r.body);
    sandbox.runTests(run.code);
  }
  const vars = Object.fromEntries(sandbox.currentVars().map((v) => [v.key, v.value]));
  return { vars, setVars, testResults: sandbox.testResults, error };
}

self.onmessage = (ev: MessageEvent<{ id: number; run: ScriptRun }>) => {
  const { id, run } = ev.data;
  self.postMessage({ id, result: handleRun(run) });
};
