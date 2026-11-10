import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
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

/** Native single-file picker for form-data file parts; null when cancelled. */
export async function pickFile(): Promise<{ path: string; name: string } | null> {
  const path = await open({ multiple: false, directory: false });
  if (!path) return null;
  return { path, name: path.split(/[\\/]/).pop() || path };
}

/** One persisted-entity write (mirrors `EntityOp` in crates/vectis-core/src/db; payloads are JSON strings). */
export type EntityOp =
  | { op: 'upsertCollection'; id: string; sort: number; json: string }
  | { op: 'deleteCollection'; id: string }
  | { op: 'upsertEnvironment'; id: string; sort: number; json: string }
  | { op: 'deleteEnvironment'; id: string }
  | { op: 'setGlobals'; json: string }
  | { op: 'setActiveEnv'; id: string | null }
  | { op: 'replaceTabs'; tabs: [string, string][] }
  | { op: 'setUiState'; key: string; json: string }
  | { op: 'clearHistory' }
  | { op: 'deleteHistory'; id: string };

/** Everything persisted, as loaded at startup (mirrors `WorkspaceSnapshot`, camelCase). */
export interface WorkspaceSnapshot {
  collections: unknown[];
  environments: unknown[];
  globals: unknown;
  activeEnvId: string | null;
  history: unknown[];
  tabs: unknown[];
  uiState: Record<string, unknown>;
  settings: Settings;
}

export function loadWorkspace(): Promise<WorkspaceSnapshot> {
  return invoke<WorkspaceSnapshot>('load_workspace');
}

export function saveEntities(ops: EntityOp[]): Promise<void> {
  return invoke<void>('save_entities', { ops });
}

export function addHistoryNative(args: {
  itemJson: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  ts: number;
  limit?: number;
}): Promise<void> {
  return invoke<void>('add_history', { ...args, limit: args.limit ?? null });
}

/** Matching history items (JSON strings), newest first. */
export function searchHistory(q: string, limit: number): Promise<string[]> {
  return invoke<string[]>('search_history', { q, limit });
}

export function flushDone(): Promise<void> {
  return invoke<void>('flush_done');
}

/** Subscribes to the window-close flush request; resolves to the unlisten function. */
export function onFlush(handler: () => void): Promise<() => void> {
  return listen('vectis://flush', () => handler());
}
