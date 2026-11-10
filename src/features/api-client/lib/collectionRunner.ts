import type { EnvVar, HttpMethod, RequestNode, TestResult } from '../types';
import { executeRequest } from './executeRequest';

/** One executed request within a run (per iteration). */
export interface RunResultItem {
  requestId: string;
  name: string;
  method: HttpMethod;
  /** 1-based iteration index. */
  iteration: number;
  /** HTTP status, or 0 when no response (network/script error). */
  status: number;
  ok: boolean;
  timeTaken: number;
  testResults: TestResult[];
  error?: string;
}

export interface RunConfig {
  requests: RequestNode[];
  /** Active env + globals, seeds each iteration's run-scoped bag. */
  seedVars: EnvVar[];
  /** Iteration count when no data file is supplied (min 1). */
  iterations: number;
  /** Data rows; when present, one iteration per row (overrides `iterations`). */
  dataRows?: Record<string, string>[];
  signal: AbortSignal;
  onResult: (item: RunResultItem) => void;
  onProgress: (current: number, total: number) => void;
  /** Per-request timeout in ms (0 = none). Omitted = the settings timeout. */
  timeoutMs?: number;
}

/**
 * Run every request in order, N times (or once per data row). Variables set by a
 * test/pre-request script flow to the next request via a run-scoped bag (chaining)
 * that is discarded at run end — the saved environment is never mutated.
 * Continue-on-failure: a failed request records an error item and the run goes on.
 */
export async function runCollection(cfg: RunConfig): Promise<void> {
  const rows = cfg.dataRows && cfg.dataRows.length ? cfg.dataRows : null;
  const iterations = rows ? rows.length : Math.max(1, cfg.iterations);
  const total = cfg.requests.length * iterations;
  let done = 0;

  for (let iter = 0; iter < iterations; iter++) {
    if (cfg.signal.aborted) return;
    const row = rows ? rows[iter] : {};

    // Run-scoped bag, fresh per iteration, seeded from env/globals. No persist.
    const bag = new Map<string, string>();
    cfg.seedVars.forEach((v) => {
      if (v.key) bag.set(v.key, v.value);
    });

    for (const node of cfg.requests) {
      if (cfg.signal.aborted) return;
      const seed: EnvVar[] = [...bag.entries()].map(([key, value]) => ({ id: `v:${key}`, key, value }));
      // Cookies are attached and captured by the native jar.
      const res = await executeRequest(node.request, seed, {
        iterationData: row,
        signal: cfg.signal,
        onSetVar: (k, v) => bag.set(k, v),
        timeoutMs: cfg.timeoutMs,
      });
      // A cancelled run must not report a result that settled after the abort.
      if (cfg.signal.aborted) return;
      done++;
      cfg.onResult({
        requestId: node.id,
        name: node.name,
        method: node.request.method,
        iteration: iter + 1,
        status: res.response?.status ?? 0,
        ok: res.response?.ok ?? false,
        timeTaken: res.response?.timeTaken ?? 0,
        testResults: res.response?.testResults ?? [],
        error: res.error?.message,
      });
      cfg.onProgress(done, total);
    }
  }
}
