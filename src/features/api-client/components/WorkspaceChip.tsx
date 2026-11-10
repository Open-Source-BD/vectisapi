import { useRef, useState } from 'react';
import { useApiStore } from '../store/useApiStore';

/**
 * TopBar status chip for the git-native workspace. Always tells the user where
 * their data is and whether it's saving — the trust surface for "no lock-in".
 * Browsers drop folder permission on reload, so "reconnect" is a first-class state.
 */
export function WorkspaceChip() {
  const status = useApiStore((s) => s.workspaceStatus);
  const name = useApiStore((s) => s.workspaceName);
  const busy = useApiStore((s) => s.workspaceBusy);
  const error = useApiStore((s) => s.workspaceError);
  const connect = useApiStore((s) => s.connectWorkspace);
  const reconnect = useApiStore((s) => s.reconnectWorkspace);
  const save = useApiStore((s) => s.saveToWorkspace);
  const load = useApiStore((s) => s.loadFromWorkspace);
  const disconnect = useApiStore((s) => s.disconnectWorkspace);
  const exportZip = useApiStore((s) => s.exportWorkspaceZip);
  const importZip = useApiStore((s) => s.importWorkspaceZip);

  const [menuOpen, setMenuOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const icon = (n: string) => (
    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
      {n}
    </span>
  );

  const onPickZip = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file
    if (file) void importZip(file);
  };

  // Hidden input shared by every state that offers zip import.
  const zipInput = <input ref={fileRef} type="file" accept=".zip" hidden onChange={onPickZip} aria-hidden="true" />;

  if (status === 'unsupported') {
    // No File System Access (Firefox/Safari) → manual zip snapshot, not a dead end.
    return (
      <div
        className="ws-chip-wrap"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setMenuOpen(false);
        }}
      >
        {zipInput}
        <button
          className="ws-chip"
          onClick={() => setMenuOpen((o) => !o)}
          disabled={busy}
          aria-expanded={menuOpen}
          title={
            error || 'Live folder sync needs Chromium (Chrome/Edge). Export/import a git-friendly zip snapshot instead.'
          }
          aria-label="Workspace zip snapshot options"
        >
          {icon(error ? 'error' : 'folder_zip')}
          <span aria-live="polite">{busy ? 'Working…' : 'Workspace (zip)'}</span>
          {icon('expand_more')}
        </button>
        {menuOpen && (
          <div className="ws-menu" role="menu">
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void exportZip();
              }}
            >
              {icon('download')} Export zip snapshot
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                fileRef.current?.click();
              }}
            >
              {icon('upload')} Import zip snapshot
            </button>
          </div>
        )}
      </div>
    );
  }

  if (status === 'disconnected') {
    return (
      <button
        className="ws-chip"
        onClick={connect}
        disabled={busy}
        title="Save collections to a local folder you can commit to git"
        aria-label="Connect a local workspace folder"
      >
        {icon('create_new_folder')} {busy ? 'Connecting…' : 'Connect folder'}
      </button>
    );
  }

  if (status === 'reconnect') {
    return (
      <button
        className="ws-chip ws-reconnect"
        onClick={reconnect}
        disabled={busy}
        title={error || 'Re-grant folder permission (browsers drop it on reload)'}
        aria-label={`Reconnect workspace folder ${name}`}
      >
        {icon('sync_problem')} <span aria-live="polite">{busy ? 'Reconnecting…' : `Reconnect ${name}`}</span>
      </button>
    );
  }

  // connected
  return (
    <div
      className="ws-chip-wrap"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setMenuOpen(false);
      }}
    >
      <button
        className="ws-chip ws-connected"
        onClick={() => setMenuOpen((o) => !o)}
        disabled={busy}
        aria-expanded={menuOpen}
        aria-label={`Workspace folder ${name} connected`}
        title={error || `Connected to ${name}`}
      >
        {icon(error ? 'error' : 'folder_managed')}
        <span aria-live="polite">{busy ? 'Syncing…' : name}</span>
        {icon('expand_more')}
      </button>
      {menuOpen && (
        <div className="ws-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              save();
            }}
          >
            {icon('save')} Save to folder
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              load();
            }}
          >
            {icon('folder_open')} Load from folder
          </button>
          <button
            role="menuitem"
            className="ws-menu-danger"
            onClick={() => {
              setMenuOpen(false);
              disconnect();
            }}
          >
            {icon('link_off')} Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
