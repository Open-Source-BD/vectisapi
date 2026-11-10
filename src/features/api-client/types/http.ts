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
  rawText: string;
  headers: Record<string, string>;
  testResults: TestResult[];
  /** Which transport served this response. Absent = proxy (legacy/back-compat). */
  transport?: 'proxy' | 'direct';
}

/** A detected bot-wall challenge that was NOT auto-retried (caller renders UI). */
export interface ChallengeInfo {
  vendor: string;
  method: HttpMethod;
  /** True when a clean browser-direct retry is possible (no cookie a browser can't replay). */
  directEligible: boolean;
  /** Set when a manual browser-direct retry was attempted and failed (CORS/network). */
  retryError?: string;
}
