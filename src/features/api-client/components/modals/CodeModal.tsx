import { selectActiveTab, useApiStore } from '../../store/useApiStore';
import { CODE_LANGS, generateCode } from '../../lib/codegen';
import { CodeView } from '@/components/ui';

export function CodeModal() {
  const isOpen = useApiStore((s) => s.isCodeModalOpen);
  if (!isOpen) return null;
  return <CodeModalInner />;
}

function CodeModalInner() {
  const setOpen = useApiStore((s) => s.setCodeModalOpen);
  const tab = useApiStore(selectActiveTab);
  const environments = useApiStore((s) => s.environments);
  const activeEnvId = useApiStore((s) => s.activeEnvId);
  const globals = useApiStore((s) => s.globals);
  const lang = useApiStore((s) => s.codeLang);
  const setLang = useApiStore((s) => s.setCodeLang);

  const activeEnv = environments.find((e) => e.id === activeEnvId);
  const vars = [...globals, ...(activeEnv?.vars ?? [])];
  const code = generateCode(tab, vars, lang);

  return (
    <div
      className="md-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="md-modal" style={{ maxWidth: '760px', width: '95%' }}>
        <div className="md-modal-header">
          <h3>Generate Code</h3>
          <button className="md-icon-btn-small" onClick={() => setOpen(false)}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="md-modal-body">
          <div className="types-bar" style={{ borderBottom: 'none', padding: '0 0 12px' }}>
            {CODE_LANGS.map((l) => (
              <button
                key={l.id}
                className={`types-lang-btn ${lang === l.id ? 'active' : ''}`}
                onClick={() => setLang(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              height: '55vh',
              border: '1px solid var(--md-sys-color-outline-variant)',
              borderRadius: '8px',
              overflow: 'hidden',
            }}
          >
            <CodeView text={code} />
          </div>
        </div>
      </div>
    </div>
  );
}
