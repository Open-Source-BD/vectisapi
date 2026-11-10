import type { EnvVar, TabState } from '../types';
import { resolveEnv } from './envResolver';

const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** Ensure a URL has a protocol; returns the normalized string. */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : 'http://' + trimmed;
}

export interface BuiltRequest {
  finalUrl: string;
  method: string;
  headers: Headers;
  body?: BodyInit;
  isFormData: boolean;
}

/**
 * Assemble a request from tab state: env-resolve the URL, append query params,
 * apply the 6 auth types, build the body. Shared by the buffered HTTP proxy
 * (`sendViaProxy`) and the SSE streaming connect so auth/env/body never drift.
 *
 * CLIENT-ONLY — uses browser APIs (`btoa`, `FormData`, `File`). The proxy/stream
 * route must NOT import this; it only reads the forwarded headers.
 */
export function buildProxyRequest(tab: TabState, environments: EnvVar[]): BuiltRequest {
  const r = (s: string) => resolveEnv(s, environments);

  const url = new URL(normalizeUrl(r(tab.url)));
  tab.params.forEach((p) => {
    if (p.key) url.searchParams.append(r(p.key), r(p.value));
  });

  const headers = new Headers();
  tab.headers.forEach((h) => {
    if (h.key) headers.append(r(h.key), r(h.value));
  });

  const auth = tab.auth;
  if (auth.type === 'bearer' && auth.bearer) {
    headers.set('Authorization', `Bearer ${r(auth.bearer)}`);
  } else if (auth.type === 'basic' && auth.basicUser) {
    headers.set('Authorization', `Basic ${btoa(r(auth.basicUser) + ':' + r(auth.basicPass))}`);
  } else if (auth.type === 'apikey' && auth.apiKeyName) {
    if (auth.apiKeyIn === 'query') url.searchParams.append(r(auth.apiKeyName), r(auth.apiKeyValue));
    else headers.set(r(auth.apiKeyName), r(auth.apiKeyValue));
  } else if (auth.type === 'oauth2' && auth.oauthToken) {
    headers.set('Authorization', `Bearer ${r(auth.oauthToken)}`);
  } else if (auth.type === 'jwt' && auth.jwtToken) {
    const prefix = auth.jwtPrefix?.trim();
    headers.set('Authorization', prefix ? `${prefix} ${r(auth.jwtToken)}` : r(auth.jwtToken));
  }

  let body: BodyInit | undefined;
  if (BODY_METHODS.includes(tab.method) && tab.body.type !== 'none') {
    if (tab.body.type === 'raw') {
      body = r(tab.body.rawContent);
      if (!headers.has('Content-Type')) headers.set('Content-Type', tab.body.rawType);
    } else if (tab.body.type === 'formdata') {
      const fd = new FormData();
      tab.body.formdata.forEach((item) => {
        if (!item.key) return;
        if (item.type === 'file' && item.file) fd.append(r(item.key), item.file);
        else fd.append(r(item.key), r(item.value));
      });
      body = fd;
    } else if (tab.body.type === 'urlencoded') {
      const usp = new URLSearchParams();
      tab.body.urlencoded.forEach((item) => {
        if (item.key) usp.append(r(item.key), r(item.value));
      });
      body = usp;
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/x-www-form-urlencoded');
    } else if (tab.body.type === 'graphql') {
      const g = tab.body.graphql ?? { query: '', variables: '' };
      let vars: unknown = {};
      try {
        vars = g.variables.trim() ? JSON.parse(g.variables) : {};
      } catch {
        vars = {};
      }
      body = JSON.stringify({ query: r(g.query), variables: vars });
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
  }

  return { finalUrl: url.toString(), method: tab.method, headers, body, isFormData: body instanceof FormData };
}

/**
 * Headers the browser forbids on a direct `fetch` (it silently drops or throws on
 * them) plus our proxy-only headers. `buildProxyRequest` produces proxy-shaped
 * headers; strip these before a browser-direct send so the request is valid and
 * doesn't leak proxy plumbing. Returns a fresh Headers (does not mutate input).
 */
const DIRECT_FORBIDDEN = new Set([
  'cookie',
  'host',
  'user-agent',
  'referer',
  'content-length',
  'connection',
  'accept-encoding',
  'origin',
  'x-proxy-target-url',
  'x-proxy-method',
  'x-proxy-cookie',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

export function sanitizeDirectHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, key) => {
    if (!DIRECT_FORBIDDEN.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}
