import type { EnvVar, ResponseData, TabState } from '../types';
import { PmSandbox } from './pmSandbox';
import { generateId } from './id';
import { buildRequestSpec } from './native/buildRequestSpec';
import { decodeText, toNativeError, toResponseData } from './native/decodeResponse';
import { cancelRequest, getResponseBody, sendRequest } from './native/invoke';

export interface ExecuteResult {
  /** The response (any status), or a status-0 error response when the send failed. */
  response: ResponseData | null;
  /** Request URL as sent (resolved params, protocol-normalized), when a request was built. */
  finalUrl?: string;
  /** Set when the request never produced an HTTP response. */
  error?: { phase: 'pre-request' | 'send'; message: string };
}

export interface ExecuteOptions {
  /** Called when a script does `pm.environment.set` — caller decides where it lands. */
  onSetVar?: (key: string, value: string) => void;
  /** Current iteration's data row (Collection Runner). Seeds vars + `pm.iterationData`. */
  iterationData?: Record<string, string>;
  /** External cancel signal (Collection Runner Cancel button). Aborting cancels the native request. */
  signal?: AbortSignal;
  /** Per-request timeout in ms (0 = none), enforced by the engine. Omitted = the settings timeout. */
  timeoutMs?: number;
}

/** next-postman's error-response shape, plus the native error kind. */
function errorResponse(kind: string, message: string): ResponseData {
  return {
    ok: false,
    status: 0,
    statusText: 'Error',
    timeTaken: 0,
    size: 0,
    rawText: message,
    headers: {},
    testResults: [],
    errorKind: kind,
  };
}

/**
 * Framework-free send/test pipeline shared by single-send and the Collection
 * Runner: pre-request script → native send (Rust engine; cookies, redirects and
 * timeout handled there) → tests. Never throws, never touches the UI.
 */
export async function executeRequest(
  tab: TabState,
  seedVars: EnvVar[],
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const sandbox = new PmSandbox(seedVars, opts.onSetVar ?? (() => {}), opts.iterationData);

  try {
    sandbox.runPreRequest(tab.scripts);
  } catch (e) {
    return { response: null, error: { phase: 'pre-request', message: (e as Error).message } };
  }

  // Read vars AFTER the pre-request script so its mutations drive interpolation.
  const spec = buildRequestSpec(tab, sandbox.currentVars(), generateId(), opts.timeoutMs);
  const fail = (kind: string, message: string): ExecuteResult => ({
    response: errorResponse(kind, message),
    finalUrl: spec.url,
    error: { phase: 'send', message },
  });

  const signal = opts.signal;
  if (signal?.aborted) return fail('cancelled', 'Request cancelled');

  // Abort settles immediately — even if Rust hasn't registered the id yet and the
  // cancel misses (then it's retried once shortly after, best-effort).
  let onAbort = () => {};
  const aborted = new Promise<ExecuteResult>((resolve) => {
    onAbort = () => {
      resolve(fail('cancelled', 'Request cancelled'));
      void cancelNative(spec.requestId);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  const send = async (): Promise<ExecuteResult> => {
    try {
      const { meta, prefix } = await sendRequest(spec);
      const data = toResponseData(meta, prefix);

      // Tests see the whole body even when the pane only holds the 2 MB prefix.
      let testBody = data.rawText;
      if (meta.truncated && tab.tests.trim()) {
        try {
          testBody = decodeText(await getResponseBody(meta.responseId, 0));
        } catch {
          // Body evicted from the store: tests run against the prefix.
        }
      }
      if (signal?.aborted) return fail('cancelled', 'Request cancelled');
      sandbox.attachResponse(data.status, data.statusText, testBody);
      sandbox.runTests(tab.tests);
      return { response: { ...data, testResults: sandbox.testResults }, finalUrl: spec.url };
    } catch (e) {
      const { kind, message } = toNativeError(e);
      return fail(kind, message);
    }
  };

  try {
    return await Promise.race([send(), aborted]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Retry delay when a cancel races ahead of the engine registering the request. */
const CANCEL_RETRY_MS = 50;

async function cancelNative(requestId: string): Promise<void> {
  try {
    if (await cancelRequest(requestId)) return;
    await new Promise((r) => setTimeout(r, CANCEL_RETRY_MS));
    await cancelRequest(requestId);
  } catch (e) {
    console.warn('cancel_request failed', e);
  }
}
