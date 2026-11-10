import type { HistoryItem } from '../types';

export interface HistoryGroup {
  label: string;
  items: HistoryItem[];
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Group history items into Today / Yesterday / weekday / date buckets, newest first. */
export function groupHistoryByDate(items: HistoryItem[], now: number): HistoryGroup[] {
  const today = startOfDay(now);
  const groups: HistoryGroup[] = [];
  const byLabel = new Map<string, HistoryItem[]>();

  for (const item of items) {
    const itemDay = startOfDay(new Date(item.date).getTime());
    const diffDays = Math.round((today - itemDay) / DAY);

    let label: string;
    if (diffDays <= 0) label = 'Today';
    else if (diffDays === 1) label = 'Yesterday';
    else if (diffDays < 7) label = new Date(item.date).toLocaleDateString([], { weekday: 'long' });
    else label = new Date(item.date).toLocaleDateString();

    if (!byLabel.has(label)) {
      const arr: HistoryItem[] = [];
      byLabel.set(label, arr);
      groups.push({ label, items: arr });
    }
    byLabel.get(label)!.push(item);
  }

  return groups;
}

/** Filter by case-insensitive match on method or url. */
export function filterHistory(items: HistoryItem[], query: string): HistoryItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) => i.url.toLowerCase().includes(q) || i.method.toLowerCase().includes(q));
}
