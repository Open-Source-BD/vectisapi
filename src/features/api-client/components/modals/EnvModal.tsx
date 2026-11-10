import { useState } from 'react';
import { useApiStore } from '../../store/useApiStore';
import { KvEditor } from '@/components/ui';
import type { EnvVar } from '../../types';

const GLOBALS = '__globals__';

export function EnvModal() {
  const isOpen = useApiStore((s) => s.isEnvModalOpen);
  if (!isOpen) return null;
  return <EnvModalInner />;
}

function EnvModalInner() {
  const setOpen = useApiStore((s) => s.setEnvModalOpen);
  const environments = useApiStore((s) => s.environments);
  const globals = useApiStore((s) => s.globals);
  const activeEnvId = useApiStore((s) => s.activeEnvId);
  const createEnvironment = useApiStore((s) => s.createEnvironment);
  const renameEnvironment = useApiStore((s) => s.renameEnvironment);
  const deleteEnvironment = useApiStore((s) => s.deleteEnvironment);
  const setActiveEnv = useApiStore((s) => s.setActiveEnv);
  const setEnvVars = useApiStore((s) => s.setEnvVars);
  const setGlobals = useApiStore((s) => s.setGlobals);
  const transferVar = useApiStore((s) => s.transferVar);

  const [selectedId, setSelectedId] = useState<string>(activeEnvId ?? GLOBALS);
  const [newName, setNewName] = useState('');

  const addEnv = () => {
    const name = newName.trim();
    if (!name) return;
    createEnvironment(name);
    const envs = useApiStore.getState().environments;
    setSelectedId(envs[envs.length - 1].id);
    setNewName('');
  };

  const selectedEnv = environments.find((e) => e.id === selectedId);
  const isGlobals = selectedId === GLOBALS;
  const vars: EnvVar[] = isGlobals ? globals : (selectedEnv?.vars ?? []);
  const onVarsChange = (items: EnvVar[]) =>
    isGlobals ? setGlobals(items) : selectedEnv && setEnvVars(selectedEnv.id, items);

  // Copy/move targets: every other container (Globals + other envs).
  const currentId = isGlobals ? null : (selectedEnv?.id ?? null);
  const targets = [
    { key: GLOBALS, id: null as string | null, name: 'Globals' },
    ...environments.map((e) => ({ key: e.id, id: e.id as string | null, name: e.name })),
  ].filter((t) => t.id !== currentId);

  const renderRowExtra = (item: { id: string; key: string }) => {
    if (!item.key.trim() || targets.length === 0) return null;
    return (
      <select
        className="md-select env-var-move"
        value=""
        title="Copy or move this variable to another environment"
        aria-label="Copy or move variable to another environment"
        onChange={(ev) => {
          const val = ev.target.value;
          if (!val) return;
          const [mode, key] = val.split('|');
          transferVar(item.id, currentId, key === GLOBALS ? null : key, mode as 'copy' | 'move');
          ev.target.value = '';
        }}
      >
        <option value="">⇄</option>
        <optgroup label="Copy to">
          {targets.map((t) => (
            <option key={`c-${t.key}`} value={`copy|${t.key}`}>
              {t.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Move to">
          {targets.map((t) => (
            <option key={`m-${t.key}`} value={`move|${t.key}`}>
              {t.name}
            </option>
          ))}
        </optgroup>
      </select>
    );
  };

  return (
    <div
      className="md-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="md-modal" style={{ maxWidth: '820px', width: '95%' }}>
        <div className="md-modal-header">
          <h3>Environments</h3>
          <button className="md-icon-btn-small" onClick={() => setOpen(false)}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="md-modal-body env-modal-body">
          <div className="env-list">
            <button className={`env-list-item ${isGlobals ? 'selected' : ''}`} onClick={() => setSelectedId(GLOBALS)}>
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                public
              </span>{' '}
              Globals
            </button>
            {environments.map((e) => (
              <button
                key={e.id}
                className={`env-list-item ${selectedId === e.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(e.id)}
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: '18px', color: activeEnvId === e.id ? 'var(--md-sys-color-primary)' : undefined }}
                >
                  {activeEnvId === e.id ? 'check_circle' : 'lan'}
                </span>
                <span className="env-list-name">{e.name}</span>
              </button>
            ))}
            <div className="env-new">
              <input
                className="md-input"
                placeholder="New environment"
                value={newName}
                onChange={(ev) => setNewName(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') addEnv();
                }}
              />
              <button className="md-icon-btn-small" onClick={addEnv} disabled={!newName.trim()}>
                <span className="material-symbols-outlined">add</span>
              </button>
            </div>
          </div>

          <div className="env-detail">
            <div className="env-detail-head">
              {isGlobals ? (
                <strong>Globals (always applied)</strong>
              ) : selectedEnv ? (
                <>
                  <input
                    className="md-input"
                    value={selectedEnv.name}
                    onChange={(ev) => renameEnvironment(selectedEnv.id, ev.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button
                    className={`md-tonal-btn ${activeEnvId === selectedEnv.id ? 'active' : ''}`}
                    onClick={() => setActiveEnv(activeEnvId === selectedEnv.id ? null : selectedEnv.id)}
                  >
                    <span className="material-symbols-outlined">
                      {activeEnvId === selectedEnv.id ? 'check_circle' : 'radio_button_unchecked'}
                    </span>
                    {activeEnvId === selectedEnv.id ? 'Active' : 'Set active'}
                  </button>
                  <button
                    className="md-icon-btn-small danger"
                    onClick={() => {
                      deleteEnvironment(selectedEnv.id);
                      setSelectedId(GLOBALS);
                    }}
                  >
                    <span className="material-symbols-outlined">delete</span>
                  </button>
                </>
              ) : (
                <span>Select an environment</span>
              )}
            </div>
            <KvEditor items={vars} onChange={onVarsChange} renderRowExtra={renderRowExtra} />
          </div>
        </div>
      </div>
    </div>
  );
}
