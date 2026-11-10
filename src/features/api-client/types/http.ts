export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export type RequestSubTab = 'params' | 'auth' | 'headers' | 'body' | 'scripts' | 'tests';
export type ResponseSubTab = 'body' | 'headers' | 'types' | 'cookies' | 'testresults' | 'diff';
export type SidebarTab = 'history' | 'collections';

export type KvItemType = 'text' | 'file';

export interface KvItem {
  id: string;
  key: string;
  value: string;
  type?: KvItemType;
  file?: File | null;
}

export type AuthType = 'none' | 'bearer' | 'basic' | 'apikey' | 'oauth2' | 'jwt';

export type ApiKeyIn = 'header' | 'query';

export interface AuthConfig {
  type: AuthType;
  bearer: string;
  basicUser: string;
  basicPass: string;
  apiKeyName: string;
  apiKeyValue: string;
  apiKeyIn: ApiKeyIn;
  oauthToken: string;
  jwtToken: string;
  jwtPrefix: string;
}

export type BodyType = 'none' | 'formdata' | 'urlencoded' | 'raw' | 'graphql';
export type RawType = 'application/json' | 'text/plain' | 'application/xml' | 'text/html';

export interface RequestBody {
  type: BodyType;
  formdata: KvItem[];
  urlencoded: KvItem[];
  rawContent: string;
  rawType: RawType;
  graphql?: { query: string; variables: string };
}

export interface TestResult {
  name: string;
  pass: boolean;
  error?: string;
}

export interface ResponseData {
  ok: boolean;
  status: number;
  statusText: string;
  timeTaken: number;
  size: number;
  /** Lossy UTF-8 decode of the inline body prefix (the whole body unless `truncated`). */
  rawText: string;
  /** Header values joined with `, ` (`set-cookie` joined with `\n`). See `headerList` for wire order. */
  headers: Record<string, string>;
  testResults: TestResult[];
  /** Key into the native response store for the full body. */
  responseId?: string;
  /** True when `rawText` holds only the first 2 MB of the body. */
  truncated?: boolean;
  /** Response headers in wire order, duplicates kept. */
  headerList?: [string, string][];
  httpVersion?: string;
  timing?: { totalMs: number; ttfbMs: number };
  /** URL after redirects. */
  finalUrl?: string;
  /** Native error kind (`invalid_url`, `timeout`, ...) when the request failed. */
  errorKind?: string;
}

// --- Native IPC contract (mirrors crates/vectis-core/src/http/spec.rs, camelCase) ---

export type PartValue =
  | { type: 'text'; value: string }
  | { type: 'file'; value: { path: string; fileName?: string | null; contentType?: string | null } };

export interface MultipartPart {
  name: string;
  value: PartValue;
}

export type BodySpec =
  | { type: 'none' }
  | { type: 'text'; value: string }
  | { type: 'base64'; value: string }
  | { type: 'urlEncoded'; value: [string, string][] }
  | { type: 'multipart'; value: MultipartPart[] };

export interface HttpRequestSpec {
  requestId: string;
  method: string;
  url: string;
  /** Sent in order; duplicate names are kept. */
  headers: [string, string][];
  body: BodySpec;
  /** Overrides the settings timeout; `0` = no timeout; `null` = use settings. */
  timeoutMs: number | null;
}

export interface ResponseMeta {
  responseId: string;
  status: number;
  statusText: string;
  httpVersion: string;
  headers: [string, string][];
  remoteAddr: string | null;
  finalUrl: string;
  size: number;
  timing: { totalMs: number; ttfbMs: number };
  truncated: boolean;
}

/** Rejection payload of every native command. */
export interface NativeError {
  kind: string;
  message: string;
}
