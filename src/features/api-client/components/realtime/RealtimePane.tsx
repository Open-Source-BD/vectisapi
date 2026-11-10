import { useState } from 'react';
import { selectActiveTab, useApiStore } from '../../store/useApiStore';
import { UrlBar } from '../request/UrlBar';

const STATUS_META: Record<string, { label: string; icon: string; color: string }> = {
  idle: { label: 'Not connected', icon: 'radio_button_unchecked', color: 'var(--md-sys-color-on-surface-variant)' },
  connecting: { label: 'Connecting…', icon: 'pending', color: 'var(--warning)' },
  open: { label: 'Connected', icon: 'check_circle', color: 'var(--success)' },
  closed: { label: 'Closed', icon: 'do_not_disturb_on', color: 'var(--md-sys-color-on-surface-variant)' },
  error: { label: 'Error', icon: 'error', color: 'var(--md-sys-color-error)' },
};

const DIR_ICON = { sent: 'north_east', recv: 'south_west', system: 'info' } as const;

interface Props {
  send: () => void;
}

/** WebSocket workspace: connect bar (UrlBar in WS mode) + message log + send composer. */
export function RealtimePane({ send }: Props) {
  const tab = useApiStore(selectActiveTab);
  const rt = useApiStore((s) => s.realtime[tab.id]);
  const wsSend = useApiStore((s) => s.wsSend);

  const [draft, setDraft] = useState('');
  const isWs = (tab.protocol ?? 'http') === 'ws';
  const status = rt?.status ?? 'idle';
  const messages = rt?.messages ?? [];
  const total = rt?.total ?? 0;
  const meta = STATUS_META[status];
  const canSend = status === 'open';
  const trimmed = total - messages.length;

  const submit = () => {
    if (!canSend || !draft) return;
    wsSend(tab.id, draft);
    setDraft('');
  };

  return (
    <div className="realtime-pane">
      <UrlBar send={send} />

      <div className="rt-status-bar">
        <span className="rt-status" style={{ color: meta.color }}>
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
            {meta.icon}
          </span>
          {meta.label}
        </span>
        {rt?.closeInfo && status !== 'error' && <span className="rt-info">{rt.closeInfo}</span>}
        {rt?.error && (
          <span className="rt-error" role="alert">
            {rt.error}
          </span>
        )}
        <span className="rt-count">
          {total} message{total === 1 ? '' : 's'}
        </span>
      </div>

      <div className="rt-log" aria-live="polite">
        {messages.length === 0 && (
          <div className="empty-state" style={{ padding: '40px 16px' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '44px', opacity: 0.5 }}>
              swap_vert
            </span>
            <span>
              {status === 'open'
                ? isWs
                  ? 'Connected. Send a message below.'
                  : 'Connected. Waiting for events…'
                : `Connect to ${isWs ? 'a WebSocket' : 'an SSE'} URL to start.`}
            </span>
          </div>
        )}
        {trimmed > 0 && <div className="rt-trim">… {trimmed} older messages trimmed</div>}
        {messages.map((m) => (
          <div key={m.id} className={`rt-row rt-${m.dir}`}>
            <span className="material-symbols-outlined rt-dir" style={{ fontSize: '14px' }}>
              {DIR_ICON[m.dir]}
            </span>
            <span className="rt-text">{m.text}</span>
            <span className="rt-meta">
              {m.bytes ? `${m.bytes}B` : ''} {new Date(m.ts).toLocaleTimeString()}
            </span>
          </div>
        ))}
      </div>

      {isWs && (
        <div className="rt-composer">
          <textarea
            className="md-input rt-input"
            placeholder={
              canSend ? 'Message to send (Enter to send, Shift+Enter for newline)' : 'Connect to send messages'
            }
            value={draft}
            disabled={!canSend}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
          />
          <button className="md-filled-btn rt-send" onClick={submit} disabled={!canSend || !draft}>
            <span className="material-symbols-outlined">send</span> Send
          </button>
        </div>
      )}
    </div>
  );
}
