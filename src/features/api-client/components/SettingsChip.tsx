import { useApiStore } from '../store/useApiStore';

/** TopBar chip (where next-postman's workspace chip sat) that opens the Settings modal. */
export function SettingsChip() {
  const setOpen = useApiStore((s) => s.setSettingsModalOpen);
  return (
    <button className="ws-chip" onClick={() => setOpen(true)} title="Settings, backup and data folder">
      <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
        settings
      </span>{' '}
      Settings
    </button>
  );
}
