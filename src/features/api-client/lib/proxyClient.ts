import type { EnvVar, TabState } from '../types';
import { buildProxyRequest, normalizeUrl, sanitizeDirectHeaders } from './buildProxyRequest';

export { normalizeUrl };

export interface ProxyResult {
  ok: boolean;
  status: number;
  statusText: string;
  timeTaken: number;
  size: number;
  rawText: string;
  headers: Record<string, string>;
  /** Final target URL (with query params, protocol-normalized). */
  finalUrl: string;
  /** Which transport served this response. */
  transport: 'proxy' | 'direct';
}

/**
 * Map a fetch Response + its already-read body into a ProxyResult. One source of
 * truth for the response contract so the proxy and direct paths can't drift.
 * Proxy timing comes from the `x-proxy-time` header the route stamps; direct
 * timing is measured client-side and passed in via `clientMs`.
 */
function toProxyResult(
  response: Response,
  rawText: string,
  finalUrl: string,
  transport: 'proxy' | 'direct',
  clientMs?: number,
): ProxyResult {
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  let timeTaken = clientMs ?? 0;
  if (transport === 'proxy') {
    timeTaken = parseInt(headers['x-proxy-time'] || '0', 10);
    delete headers['x-proxy-time'];
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    timeTaken,
    size: new Blob([rawText]).size,
    rawText,
    headers,
    finalUrl,
    transport,
  };
}

/**
 * Build the request from tab state and send it through the `/api/proxy` route
 * handler (server-side fetch → no CORS limits, full header/cookie fidelity).
 */
export async function sendViaProxy(
  tab: TabState,
  environments: EnvVar[],
  signal?: AbortSignal,
  cookieHeader?: string,
): Promise<ProxyResult> {
  const { finalUrl, method, headers, body: fetchBody, isFormData } = buildProxyRequest(tab, environments);

  const proxyHeaders = new Headers(headers);
  proxyHeaders.set('X-Proxy-Target-Url', finalUrl);
  proxyHeaders.set('X-Proxy-Method', method);
  // `Cookie` is a forbidden fetch header; smuggle the jar's cookies via a
  // custom header the proxy restores. Don't override an explicit Cookie header.
  if (cookieHeader && !headers.has('Cookie')) proxyHeaders.set('X-Proxy-Cookie', cookieHeader);

  // Let fetch set the multipart boundary itself for form-data.
  if (isFormData) proxyHeaders.delete('Content-Type');

  const response = await fetch('/api/proxy', { method: 'POST', headers: proxyHeaders, body: fetchBody, signal });
  const rawText = await response.text();
  return toProxyResult(response, rawText, finalUrl, 'proxy');
}

/**
 * Send the request straight from the browser (the user's real IP, like Postman
 * desktop) — the bot-wall fallback. Bypasses the proxy, so it's CORS-limited and
 * sends no ambient cookies (`credentials: 'omit'`, which keeps wildcard-CORS
 * targets working). Throws TypeError on CORS/preflight/mixed-content/network
 * failure; the caller turns that into the honest "couldn't reach it" message.
 */
export async function sendDirect(tab: TabState, environments: EnvVar[], signal?: AbortSignal): Promise<ProxyResult> {
  const { finalUrl, method, headers, body, isFormData } = buildProxyRequest(tab, environments);
  const directHeaders = sanitizeDirectHeaders(headers);
  if (isFormData) directHeaders.delete('Content-Type');

  const start = performance.now();
  const response = await fetch(finalUrl, {
    method,
    headers: directHeaders,
    body,
    signal,
    credentials: 'omit',
    redirect: 'follow',
  });
  const rawText = await response.text();
  return toProxyResult(response, rawText, finalUrl, 'direct', Math.round(performance.now() - start));
}
