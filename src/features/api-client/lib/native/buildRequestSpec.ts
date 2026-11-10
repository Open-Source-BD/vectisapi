import type { BodySpec, EnvVar, HttpRequestSpec, MultipartPart, TabState } from '../../types';
import { resolveEnv } from '../envResolver';

const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Prepend `http://` when the URL has no scheme — unless it still starts with an
 * unresolved `{{var}}`, which is passed through so the engine reports `invalid_url`
 * instead of trying DNS on a literal `{{var}}` host.
 */
function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('{{')) return trimmed;
  return 'http://' + trimmed;
}

/**
 * Append query pairs (WHATWG-serialized, like next-postman). An unparseable URL is
 * passed through with pairs concatenated, leaving the error to the engine.
 */
function withQuery(url: string, pairs: [string, string][]): string {
  try {
    const u = new URL(url);
    pairs.forEach(([k, v]) => u.searchParams.append(k, v));
    return u.toString();
  } catch {
    if (!pairs.length) return url;
    const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return url + (url.includes('?') ? '&' : '?') + qs;
  }
}

/** Base64 of the UTF-8 bytes (plain `btoa` throws on non-Latin-1 input). */
function base64Utf8(s: string): string {
  let bin = '';
  new TextEncoder().encode(s).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Assemble the native request from tab state: env-resolve the URL, append query
 * params, apply the 6 auth types, build the body. Headers keep order and duplicates;
 * auth replaces any same-named header (like `Headers.set`). Cookies are attached by
 * the Rust jar, not here.
 */
export function buildRequestSpec(
  tab: TabState,
  vars: EnvVar[],
  requestId: string,
  timeoutMs?: number,
): HttpRequestSpec {
  const r = (s: string) => resolveEnv(s, vars);

  const query: [string, string][] = [];
  tab.params.forEach((p) => {
    if (p.key) query.push([r(p.key), r(p.value)]);
  });

  let headers: [string, string][] = [];
  tab.headers.forEach((h) => {
    if (h.key) headers.push([r(h.key), r(h.value)]);
  });
  const setHeader = (name: string, value: string) => {
    headers = headers.filter(([k]) => !sameName(k, name));
    headers.push([name, value]);
  };
  const hasHeader = (name: string) => headers.some(([k]) => sameName(k, name));

  const auth = tab.auth;
  if (auth.type === 'bearer' && auth.bearer) {
    setHeader('Authorization', `Bearer ${r(auth.bearer)}`);
  } else if (auth.type === 'basic' && auth.basicUser) {
    setHeader('Authorization', `Basic ${base64Utf8(r(auth.basicUser) + ':' + r(auth.basicPass))}`);
  } else if (auth.type === 'apikey' && auth.apiKeyName) {
    if (auth.apiKeyIn === 'query') query.push([r(auth.apiKeyName), r(auth.apiKeyValue)]);
    else setHeader(r(auth.apiKeyName), r(auth.apiKeyValue));
  } else if (auth.type === 'oauth2' && auth.oauthToken) {
    setHeader('Authorization', `Bearer ${r(auth.oauthToken)}`);
  } else if (auth.type === 'jwt' && auth.jwtToken) {
    const prefix = auth.jwtPrefix?.trim();
    setHeader('Authorization', prefix ? `${prefix} ${r(auth.jwtToken)}` : r(auth.jwtToken));
  }

  let body: BodySpec = { type: 'none' };
  if (BODY_METHODS.includes(tab.method) && tab.body.type !== 'none') {
    if (tab.body.type === 'raw') {
      body = { type: 'text', value: r(tab.body.rawContent) };
      if (!hasHeader('Content-Type')) headers.push(['Content-Type', tab.body.rawType]);
    } else if (tab.body.type === 'formdata') {
      // The engine generates the multipart Content-Type (with boundary) itself.
      const parts: MultipartPart[] = [];
      tab.body.formdata.forEach((item) => {
        if (!item.key) return;
        // File parts are streamed from a disk path (Task 9); none exists yet, so skip.
        if (item.type === 'file') return;
        parts.push({ name: r(item.key), value: { type: 'text', value: r(item.value) } });
      });
      body = { type: 'multipart', value: parts };
    } else if (tab.body.type === 'urlencoded') {
      const pairs: [string, string][] = [];
      tab.body.urlencoded.forEach((item) => {
        if (item.key) pairs.push([r(item.key), r(item.value)]);
      });
      body = { type: 'urlEncoded', value: pairs };
      if (!hasHeader('Content-Type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    } else if (tab.body.type === 'graphql') {
      const g = tab.body.graphql ?? { query: '', variables: '' };
      let gqlVars: unknown = {};
      try {
        gqlVars = g.variables.trim() ? JSON.parse(g.variables) : {};
      } catch {
        gqlVars = {};
      }
      body = { type: 'text', value: JSON.stringify({ query: r(g.query), variables: gqlVars }) };
      if (!hasHeader('Content-Type')) headers.push(['Content-Type', 'application/json']);
    }
  }

  return {
    requestId,
    method: tab.method,
    url: withQuery(normalizeUrl(r(tab.url)), query),
    headers,
    body,
    timeoutMs: timeoutMs ?? null,
  };
}
