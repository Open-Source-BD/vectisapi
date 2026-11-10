import { useApiStore } from '../store/useApiStore';
import { WorkspaceChip } from './WorkspaceChip';

export function TopBar() {
  const setEnvModalOpen = useApiStore((s) => s.setEnvModalOpen);
  const environments = useApiStore((s) => s.environments);
  const activeEnvId = useApiStore((s) => s.activeEnvId);
  const setActiveEnv = useApiStore((s) => s.setActiveEnv);
  const setCurlModalOpen = useApiStore((s) => s.setCurlModalOpen);
  const theme = useApiStore((s) => s.theme);
  const toggleTheme = useApiStore((s) => s.toggleTheme);

  return (
    <div className="top-bar md-surface-container-low">
      <div className="logo">
        <span className="material-symbols-outlined" style={{ color: 'var(--md-sys-color-primary)' }}>
          api
        </span>
        <span>API Client</span>
      </div>
      <div className="top-bar-actions">
        <WorkspaceChip />
        <button className="md-icon-btn-small" onClick={toggleTheme} title="Toggle theme">
          <span className="material-symbols-outlined">{theme === 'dark' ? 'light_mode' : 'dark_mode'}</span>
        </button>
        <button className="md-tonal-btn env-btn" onClick={() => setCurlModalOpen(true)} title="Import cURL">
          <span className="material-symbols-outlined">terminal</span> Import cURL
        </button>
        <select
          className="md-select env-switcher"
          value={activeEnvId ?? ''}
          onChange={(e) => setActiveEnv(e.target.value || null)}
          title="Active environment"
        >
          <option value="">No Environment</option>
          {environments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </select>
        <button
          className="md-tonal-btn env-btn"
          onClick={() => setEnvModalOpen(true)}
          title="Environments (Cmd+Shift+E)"
        >
          <span className="material-symbols-outlined">settings</span> Environments
        </button>
      </div>
    </div>
  );
}
