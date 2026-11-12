import { describe, expect, it } from 'vitest';
import { diffLines, diffStats } from './diffLines';

describe('diffLines', () => {
  it('marks identical text as all same', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc');
    expect(d.every((l) => l.type === 'same')).toBe(true);
    expect(diffStats(d)).toEqual({ added: 0, removed: 0 });
  });

  it('detects an inserted line', () => {
    const d = diffLines('a\nc', 'a\nb\nc');
    expect(d.map((l) => `${l.type}:${l.text}`)).toEqual(['same:a', 'add:b', 'same:c']);
  });

  it('detects a removed line', () => {
    const d = diffLines('a\nb\nc', 'a\nc');
    expect(d.map((l) => `${l.type}:${l.text}`)).toEqual(['same:a', 'del:b', 'same:c']);
  });

  it('represents a changed line as del + add', () => {
    const d = diffLines('x\nold\nz', 'x\nnew\nz');
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
    expect(d.find((l) => l.type === 'del')?.text).toBe('old');
    expect(d.find((l) => l.type === 'add')?.text).toBe('new');
  });
});
