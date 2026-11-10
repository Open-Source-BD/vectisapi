import { invoke } from '@tauri-apps/api/core';
import type { HttpRequestSpec, ResponseMeta } from '../../types';
import { decodeSendFrame, toBytes, type RawBytes } from './decodeResponse';

/**
 * The single place the UI talks to the Rust command layer (src-tauri/src/commands).
 * Tests `vi.mock` this module. Commands reject with `NativeError` (`{ kind, message }`).
 */

/** App settings (mirrors crates/vectis-core/src/settings.rs, camelCase). */
export interface Settings {
  /** Request timeout in ms; 0 = none. */
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  verifyTls: boolean;
  proxyUrl: string | null;
  userAgent: string | null;
  responseStoreCapBytes: number;
  historyLimit: number;
  theme: string | null;
}

/** A jar cookie as listed by `cookies_list`. */
export interface CookieView {
  domain: string;
  path: string;
  name: string;
  value: string;
  /** Unix seconds; null for session cookies. */
  expires: number | null;
  secure: boolean;
  httpOnly: boolean;
}

export async function sendRequest(spec: HttpRequestSpec): Promise<{ meta: ResponseMeta; prefix: Uint8Array }> {
  return decodeSendFrame(await invoke<RawBytes>('send_request', { spec }));
}

export function cancelRequest(id: string): Promise<boolean> {
  return invoke<boolean>('cancel_request', { requestId: id });
}

/** Raw body bytes `start..end` (end exclusive; omitted = to the end). */
export async function getResponseBody(id: string, start = 0, end?: number): Promise<Uint8Array> {
  return toBytes(await invoke<RawBytes>('get_response_body', { responseId: id, start, end: end ?? null }));
}

export function getSettings(): Promise<Settings> {
  return invoke<Settings>('get_settings');
}

export function cookiesList(): Promise<CookieView[]> {
  return invoke<CookieView[]>('cookies_list');
}

export function cookiesDelete(domain: string, path: string, name: string): Promise<void> {
  return invoke<void>('cookies_delete', { domain, path, name });
}

export function cookiesClearDomain(domain: string): Promise<void> {
  return invoke<void>('cookies_clear_domain', { domain });
}

export function cookiesClear(): Promise<void> {
  return invoke<void>('cookies_clear');
}
