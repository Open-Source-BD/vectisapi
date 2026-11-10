import { describe, expect, it } from 'vitest';
import { formatSize } from './format';

describe('formatSize', () => {
  it('handles zero', () => {
    expect(formatSize(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatSize(512)).toBe('512 B');
  });

  it('formats kilobytes', () => {
    expect(formatSize(2048)).toBe('2 KB');
  });

  it('formats megabytes with rounding', () => {
    expect(formatSize(1_572_864)).toBe('1.5 MB');
  });
});
