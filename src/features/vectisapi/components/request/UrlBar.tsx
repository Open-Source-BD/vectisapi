import type { HttpMethod, Protocol } from '../../types';
import { selectActiveTab, useApiStore } from '../../store/useApiStore';
import { cancelSend } from '../../lib/sendActive';
import { VarInput } from './VarInput';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const PROTOCOLS: { value: Protocol; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'ws', label: 'WS' },
  { value: 'sse', label: 'SSE' },
];

interface UrlBarProps {
  send: () => void;
}

export function UrlBar({ send }: UrlBarProps) {
  const tab = useApiStore(selectActiveTab);
  const isLoading = useApiStore((s) => !!s.loadingTabs[s.activeTabId]);
  const updateActiveTab = useApiStore((s) => s.updateActiveTab);
  const saveActiveRequest = useApiStore((s) => s.saveActiveRequest);
  const saveActiveRequestAs = useApiStore((s) => s.saveActiveRequestAs);
  const isSaved = useApiStore((s) => !!selectActiveTab(s).sourceNodeId);
  const setCodeModalOpen = useApiStore((s) => s.setCodeModalOpen);
  const setTabProtocol = useApiStore((s) => s.setTabProtocol);
  const wsConnect = useApiStore((s) => s.wsConnect);
  const wsDisconnect = useApiStore((s) => s.wsDisconnect);
  const sseConnect = useApiStore((s) => s.sseConnect);
  const rtStatus = useApiStore((s) => s.realtime[tab.id]?.status ?? 'idle');

  const protocol = tab.protocol ?? 'http';
  const isWs = protocol === 'ws';
  const isRealtime = protocol !== 'http';
  const rtActive = rtStatus === 'connecting' || rtStatus === 'open';
  const connect = () => (protocol === 'sse' ? sseConnect(tab.id) : wsConnect(tab.id));

  return (
    <div className="url-bar-container">
      <select
        className="md-select method-select"
        value={protocol}
        onChange={(e) => setTabProtocol(e.target.value as Protocol)}
        title="Protocol"
        aria-label="Protocol"
      >
        {PROTOCOLS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      {!isWs && (
        <select
          className="md-select method-select"
          value={tab.method}
          onChange={(e) => updateActiveTab({ method: e.target.value as HttpMethod })}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      )}
      <VarInput
        className="md-input url-input"
        value={tab.url}
        onValueChange={(url) => updateActiveTab({ url })}
        placeholder={
          isWs
            ? 'wss://echo.example.com/socket'
            : protocol === 'sse'
              ? 'https://api.example.com/events'
              : 'https://api.example.com/v1/users/{{userId}}'
        }
        spellCheck={false}
        aria-label={isRealtime ? `${protocol.toUpperCase()} URL` : 'Request URL'}
        onEscape={isLoading ? () => cancelSend(tab.id) : undefined}
      />
      {isRealtime ? (
        <button
          className={`md-filled-btn send-btn ${rtActive ? 'ws-disconnect' : ''}`}
          onClick={() => (rtActive ? wsDisconnect(tab.id) : connect())}
          title={rtActive ? 'Disconnect' : 'Connect'}
        >
          <span className="material-symbols-outlined">{rtActive ? 'link_off' : 'cable'}</span>{' '}
          {rtActive ? 'Disconnect' : 'Connect'}
        </button>
      ) : (
        <>
          <button
            className="md-filled-btn send-btn"
            onClick={isLoading ? () => cancelSend(tab.id) : send}
            title={isLoading ? 'Cancel request (Esc)' : 'Send Request (Cmd+Enter)'}
          >
            <span className="material-symbols-outlined">{isLoading ? 'close' : 'send'}</span>{' '}
            {isLoading ? 'Cancel' : 'Send'}
          </button>
          {isSaved ? (
            <button className="md-tonal-btn save-btn" onClick={saveActiveRequestAs} title="Save As new request">
              <span className="material-symbols-outlined">save_as</span> Save As
            </button>
          ) : (
            <button className="md-tonal-btn save-btn" onClick={saveActiveRequest} title="Save Request (Cmd+S)">
              <span className="material-symbols-outlined">save</span> Save
            </button>
          )}
          <button className="md-tonal-btn save-btn" onClick={openCode} title="Generate Code">
            <span className="material-symbols-outlined">code</span> Code
          </button>
        </>
      )}
    </div>
  );

  function openCode() {
    setCodeModalOpen(true);
  }
}
