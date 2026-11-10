import type { ChallengeInfo, EnvVar, ResponseData, TabState } from '../types';
import { PmSandbox } from './pmSandbox';
import { sendViaProxy, sendDirect, type ProxyResult } from './proxyClient';
import { detectBotChallenge } from './botWall';
import { resolveEnv } from './envResolver';

export interface ExecuteResult {
  /** Populated when the request was sent and a response (any status) came back. */
  response: ResponseData | null;
  /** Final target URL (with resolved params), when a request was sent. */
  finalUrl?: string;
  /** Set when the request never produced a response. */
  error?: { phase: 'pre-request' | 'send'; message: string };
  /** Set when the proxy hit a bot-wall challenge that was NOT auto-retried. */
  challenge?: ChallengeInfo;
}

export interface ExecuteOptions {
  /** Called when a script does `pm.environment.set` — caller decides where it lands. */
  onSetVar?: (key: string, value: string) => void;
  /** Current iteration's data row (Collection Runner). Seeds vars + `pm.iterationData`. */
  iterationData?: Record<string, string>;
  /** External cancel signal (Collection Runner Cancel button). */
  signal?: AbortSignal;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Cookie header value from the jar, attached unless the request sets its own. */
  cookieHeader?: string;
  /**
   * Bot-wall handling. 'auto' = on a detected challenge, retry browser-direct for
   * GET/HEAD with no cookie conflict (single-send). 'off' (default) = never auto-
   * switch transport; report the challenge for the caller to surface (runner).
   */
  directFallback?: 'auto' | 'off';
  /** Skip the proxy and send browser-direct immediately (manual "Retry from browser"). */
  forceDirect?: boolean;
}

const SAFE_METHODS = ['GET', 'HEAD'];

const DIRECT_FAIL_MSG =
  'The proxy was blocked by a bot wall and the browser could not reach the target directly — ' +
  'likely CORS, a blocked preflight, mixed content (HTTPS app → HTTP target), or a network error.';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

const LOCALHOST_HELP_MSG =
  'Cannot reach localhost from the deployed app.\n\n' +
  'The server-side proxy (on Vercel) cannot connect to your local machine, and the ' +
  'browser-direct fallback was blocked by CORS.\n\n' +
  'To fix, add this header to your API response:\n' +
  '  Access-Control-Allow-Origin: https://<your-app>.vercel.app\n\n' +
  'Or run next-postman locally (npm run dev) for zero-config localhost testing.';

function isRemoteApp(): boolean {
  if (typeof window === 'undefined') return true;
  return !LOCAL_HOSTNAMES.has(window.location.hostname);
}

function isLocalhostUrl(url: string, vars: EnvVar[]): boolean {
  if (!url) return false;
  try {
    const resolved = resolveEnv(url, vars).trim();
    const withProto = /^https?:\/\//i.test(resolved) ? resolved : `http://${resolved}`;
    return LOCAL_HOSTNAMES.has(new URL(withProto).hostname);
  } catch {
    return false;
  }
}

/**
 * Framework-free send/test pipeline shared by single-send (useRequestRunner) and
 * the Collection Runner. Runs the pre-request script, sends (proxy by default,
 * browser-direct on `forceDirect` or an eligible auto-fallback), then runs tests.
 * Never throws, never touches the UI.
 *
 *   pre-request ─┬─ forceDirect ─────────────► sendDirect ─► tests ─► {transport:'direct'}
 *                └─ sendViaProxy ─┬─ no challenge ─────────► tests ─► {transport:'proxy'}
 *                                 └─ challenge ─┬─ auto+eligible ─► sendDirect ─► tests
 *                                               └─ else ─────────► {challenge} (caller renders UI)
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
  const vars = sandbox.currentVars();

  // Combine the external cancel signal with a per-request timeout.
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000);

  const aborted = () => ctrl.signal.aborted;
  const finish = (result: ProxyResult): ExecuteResult => {
    sandbox.attachResponse(result.status, result.statusText, result.rawText);
    sandbox.runTests(tab.tests);
    const { finalUrl, ...resData } = result;
    return { response: { ...resData, testResults: sandbox.testResults }, finalUrl };
  };

  try {
    // forceDirect (Retry from browser) or remote app targeting localhost → skip proxy
    const useDirect = opts.forceDirect || (isRemoteApp() && isLocalhostUrl(tab.url, vars));

    if (useDirect) {
      try {
        return finish(await sendDirect(tab, vars, ctrl.signal));
      } catch (e) {
        if ((e as Error).name === 'AbortError' || aborted()) throw e;
        return {
          response: null,
          error: { phase: 'send', message: opts.forceDirect ? DIRECT_FAIL_MSG : LOCALHOST_HELP_MSG },
        };
      }
    }

    const proxied = await sendViaProxy(tab, vars, ctrl.signal, opts.cookieHeader);
    const challenge = detectBotChallenge(proxied);
    if (!challenge) return finish(proxied);

    // A bot-wall interstitial — the origin never saw this request.
    // directEligible: a clean browser-direct retry is possible (no cookie the
    //   browser can't replay). Method-independent — the user may retry a POST
    //   manually, accepting the re-send.
    // autoOk: only silently auto-retry idempotent methods with no cookie conflict.
    const explicitCookie = tab.headers.some((h) => h.key?.toLowerCase() === 'cookie' && h.value);
    const directEligible = !opts.cookieHeader && !explicitCookie;
    const autoOk = SAFE_METHODS.includes(tab.method) && directEligible;

    if (opts.directFallback === 'auto' && autoOk) {
      try {
        return finish(await sendDirect(tab, vars, ctrl.signal));
      } catch (e) {
        if ((e as Error).name === 'AbortError' || aborted()) throw e;
        return { response: null, finalUrl: proxied.finalUrl, error: { phase: 'send', message: DIRECT_FAIL_MSG } };
      }
    }

    // Not auto-retried (unsafe method, cookie conflict, or fallback off) — let the
    // caller decide whether to show a Retry button or a failed run item.
    return {
      response: null,
      finalUrl: proxied.finalUrl,
      challenge: { vendor: challenge.vendor, method: tab.method, directEligible },
    };
  } catch (e) {
    const wasAborted = (e as Error).name === 'AbortError' || aborted();
    return {
      response: null,
      error: { phase: 'send', message: wasAborted ? 'Request cancelled or timed out' : (e as Error).message },
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}
