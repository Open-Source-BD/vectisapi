import { selectActiveTab, useApiStore } from '../../store/useApiStore';
import { KvEditor } from '@/components/ui';

export function ParamsTab() {
  const tab = useApiStore(selectActiveTab);
  const updateActiveTab = useApiStore((s) => s.updateActiveTab);
  return <KvEditor items={tab.params} onChange={(params) => updateActiveTab({ params })} />;
}
