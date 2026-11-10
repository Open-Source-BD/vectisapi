import type { EnvVar, HttpMethod, RequestNode, TestResult } from '../types';
import { executeRequest } from './executeRequest';
import { resolveEnv } from './envResolver';

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
  /** Cookie header for a resolved URL (shared jar). */
  cookieHeaderFor?: (url: string) => string;
  /** Capture a response Set-Cookie into the jar. */
  onCookies?: (url: string, setCookieHeader: string | undefined) => void;
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
      const resolvedUrl = cfg.cookieHeaderFor ? resolveEnv(node.request.url, seed) : '';
      const res = await executeRequest(node.request, seed, {
        iterationData: row,
        signal: cfg.signal,
        onSetVar: (k, v) => bag.set(k, v),
        cookieHeader: cfg.cookieHeaderFor?.(resolvedUrl),
      });
      cfg.onCookies?.(res.finalUrl ?? resolvedUrl, res.response?.headers['set-cookie']);
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
        // The runner never auto-switches transport (deterministic runs). A bot-wall
        // challenge is reported as a failed item; retry it as a single send.
        error:
          res.error?.message ??
          (res.challenge
            ? `Blocked by ${res.challenge.vendor} bot wall — retry this request individually to send from your browser`
            : undefined),
      });
      cfg.onProgress(done, total);
    }
  }
}
