import type { RequestSubTab } from '../../types';
import { selectActiveTab, useApiStore } from '../../store/useApiStore';
import { UrlBar } from './UrlBar';
import { ParamsTab } from '../tabs/ParamsTab';
import { AuthTab } from '../tabs/AuthTab';
import { HeadersTab } from '../tabs/HeadersTab';
import { BodyTab } from '../tabs/BodyTab';
import { ScriptsTab } from '../tabs/ScriptsTab';
import { TestsTab } from '../tabs/TestsTab';

const SUB_TABS: RequestSubTab[] = ['params', 'auth', 'headers', 'body', 'scripts', 'tests'];

const PANELS: Record<RequestSubTab, React.ComponentType> = {
  params: ParamsTab,
  auth: AuthTab,
  headers: HeadersTab,
  body: BodyTab,
  scripts: ScriptsTab,
  tests: TestsTab,
};

interface RequestPaneProps {
  send: () => void;
}

export function RequestPane({ send }: RequestPaneProps) {
  const active = useApiStore((s) => selectActiveTab(s).activeSubTab);
  const updateActiveTab = useApiStore((s) => s.updateActiveTab);

  return (
    <section className="request-pane md-surface">
      <UrlBar send={send} />
      <div className="tabs-container">
        <div className="md-tabs-header">
          {SUB_TABS.map((t) => (
            <button
              key={t}
              className={`md-tab-btn ${active === t ? 'active' : ''}`}
              onClick={() => updateActiveTab({ activeSubTab: t })}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        {SUB_TABS.map((t) => {
          const Panel = PANELS[t];
          return (
            <div key={t} className={`md-tab-content ${active === t ? 'active' : ''}`}>
              <Panel />
            </div>
          );
        })}
      </div>
    </section>
  );
}
