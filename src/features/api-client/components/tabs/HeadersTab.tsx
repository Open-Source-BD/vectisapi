import { selectActiveTab, useApiStore } from '../../store/useApiStore';
import { KvEditor } from '@/components/ui';

export function HeadersTab() {
  const tab = useApiStore(selectActiveTab);
  const updateActiveTab = useApiStore((s) => s.updateActiveTab);
  return <KvEditor items={tab.headers} onChange={(headers) => updateActiveTab({ headers })} />;
}
