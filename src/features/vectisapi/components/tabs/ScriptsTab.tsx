import { selectActiveTab, useApiStore } from '../../store/useApiStore';
import { CodeTextarea } from '@/components/ui';

export function ScriptsTab() {
  const tab = useApiStore(selectActiveTab);
  const updateActiveTab = useApiStore((s) => s.updateActiveTab);
  return (
    <>
      <div style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: '13px', marginBottom: '8px' }}>
        Write JavaScript to execute before the request. Ex:{' '}
        <code>pm.environment.set(&quot;key&quot;, &quot;value&quot;)</code>
      </div>
      <CodeTextarea
        className="md-textarea body-textarea"
        value={tab.scripts}
        onChange={(scripts) => updateActiveTab({ scripts })}
        spellCheck={false}
      />
    </>
  );
}
