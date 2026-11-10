import type { TestResult } from '../types';

export interface ScriptRun {
  phase: 'pre' | 'test';
  code: string;
  vars: Record<string, string>;
  iterationData?: Record<string, string>;
  response?: { code: number; status: string; body: string };
}

export interface ScriptResult {
  /** Variable map after the script ran. */
  vars: Record<string, string>;
  /** Every `pm.environment.set` call, in order. */
  setVars: [string, string][];
  testResults: TestResult[];
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

let worker: Worker | null = null;
let nextId = 1;
/** Runs are serialized: a timeout terminates the (shared) worker. */
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Worker {
  worker ??= new Worker(new URL('./scriptWorker.ts', import.meta.url), { type: 'module' });
  return worker;
}

function execute(run: ScriptRun, timeoutMs: number): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const id = nextId++;
    const w = getWorker();
    const finish = (result: ScriptResult) => {
      clearTimeout(timer);
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      resolve(result);
    };
    const failed = (message: string): ScriptResult => ({
      vars: run.vars,
      setVars: [],
      testResults: [],
      error: message,
    });
    const onMessage = (ev: MessageEvent<{ id: number; result: ScriptResult }>) => {
      if (ev.data.id === id) finish(ev.data.result);
    };
    const onError = (ev: ErrorEvent) => {
      ev.preventDefault();
      w.terminate();
      if (worker === w) worker = null;
      finish(failed(ev.message || 'Script worker failed'));
    };
    const timer = setTimeout(() => {
      w.terminate();
      if (worker === w) worker = null;
      finish(failed(`Script timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage({ id, run });
  });
}

/**
 * Run a pre-request or test script in a Web Worker (no DOM/window access) with a
 * hard timeout. Empty code returns immediately without touching the worker.
 */
export function runScript(run: ScriptRun, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<ScriptResult> {
  if (!run.code.trim()) {
    return Promise.resolve({ vars: run.vars, setVars: [], testResults: [] });
  }
  const result = queue.then(() => execute(run, timeoutMs));
  queue = result;
  return result;
}
