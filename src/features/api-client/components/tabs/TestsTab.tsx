import { selectActiveTab, useApiStore } from '../../store/useApiStore';
import { CodeTextarea } from '@/components/ui';

export function TestsTab() {
  const tab = useApiStore(selectActiveTab);
  const updateActiveTab = useApiStore((s) => s.updateActiveTab);
  return (
    <>
      <div style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: '13px', marginBottom: '8px' }}>
        Write JavaScript to execute after the request. Ex: <code>{'if(pm.response.code === 200) { ... }'}</code>
      </div>
      <CodeTextarea
        className="md-textarea body-textarea"
        value={tab.tests}
        onChange={(tests) => updateActiveTab({ tests })}
        spellCheck={false}
      />
    </>
  );
}
