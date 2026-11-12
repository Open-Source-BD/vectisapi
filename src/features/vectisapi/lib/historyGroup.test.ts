import { describe, expect, it } from 'vitest';
import { filterHistory, groupHistoryByDate } from './historyGroup';
import type { HistoryItem } from '../types';

const NOW = new Date('2026-06-14T12:00:00').getTime();

const item = (id: string, date: string, url = 'https://api/x', method: HistoryItem['method'] = 'GET'): HistoryItem => ({
  id,
  method,
  url,
  status: 200,
  time: 1,
  date,
});

describe('groupHistoryByDate', () => {
  it('buckets into Today / Yesterday / older', () => {
    const groups = groupHistoryByDate(
      [item('a', '2026-06-14T09:00:00'), item('b', '2026-06-13T09:00:00'), item('c', '2026-06-01T09:00:00')],
      NOW,
    );
    expect(groups[0].label).toBe('Today');
    expect(groups[1].label).toBe('Yesterday');
    expect(groups[0].items[0].id).toBe('a');
    expect(groups).toHaveLength(3);
  });

  it('merges same-day items into one group', () => {
    const groups = groupHistoryByDate([item('a', '2026-06-14T09:00:00'), item('b', '2026-06-14T11:00:00')], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });
});

describe('filterHistory', () => {
  const items = [
    item('a', '2026-06-14T09:00:00', 'https://api/users', 'GET'),
    item('b', '2026-06-14T09:00:00', 'https://api/login', 'POST'),
  ];

  it('matches on url', () => {
    expect(filterHistory(items, 'login').map((i) => i.id)).toEqual(['b']);
  });
  it('matches on method, case-insensitive', () => {
    expect(filterHistory(items, 'post').map((i) => i.id)).toEqual(['b']);
  });
  it('returns all on empty query', () => {
    expect(filterHistory(items, '  ')).toHaveLength(2);
  });
});
