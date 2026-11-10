export type Protocol = 'http' | 'ws' | 'sse';

/** A line in a realtime (WebSocket/SSE) connection's message log. */
export interface RtMessage {
  id: string;
  dir: 'sent' | 'recv' | 'system';
  text: string;
  /** byte length of the original payload (for the size cap / display). */
  bytes: number;
  ts: number;
}

export type RtStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** Live realtime state for a tab — kept in a separate, non-persisted store slice. */
export interface RealtimeState {
  status: RtStatus;
  messages: RtMessage[];
  /** total messages received this session (the log itself is capped). */
  total: number;
  error?: string;
  /** close code/reason when status is closed/error. */
  closeInfo?: string;
  /** SSE: last event id seen, sent as Last-Event-ID on reconnect. */
  lastEventId?: string;
}
