import type {
  HttpMethod,
  RequestBody,
  ResponseData,
  ChallengeInfo,
  KvItem,
  AuthConfig,
  RequestSubTab,
  ResponseSubTab,
} from './http';
import type { Protocol } from './realtime';

export interface TabState {
  id: string;
  /** Transport protocol. Absent = 'http' (back-compat with persisted tabs). */
  protocol?: Protocol;
  method: HttpMethod;
  url: string;
  params: KvItem[];
  headers: KvItem[];
  auth: AuthConfig;
  body: RequestBody;
  scripts: string;
  tests: string;
  response: ResponseData | null;
  /** Previous run's response, kept in-memory for the Diff view (not persisted). */
  prevResponse?: ResponseData | null;
  /** Bot-wall challenge pending user action (Retry from browser). Transient, not persisted. */
  challenge?: ChallengeInfo | null;
  activeSubTab: RequestSubTab;
  activeResTab: ResponseSubTab;
  /** Id of the saved RequestNode this tab was opened from (for Save vs Save As). */
  sourceNodeId?: string;
  /** Id of the HistoryItem this tab was replayed from (dedupe repeat clicks). */
  sourceHistoryId?: string;
}
