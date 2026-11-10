import { describe, it, expect } from 'vitest';
import { parseJsonBody, stripBom } from './parseJsonBody';

const BOM = '﻿';

describe('parseJsonBody', () => {
  it('parses a plain JSON object', () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON arrays', () => {
    expect(parseJsonBody('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('parses JSON with a leading UTF-8 BOM (the bug: strict parse threw, hiding Pretty/Types)', () => {
    expect(parseJsonBody(BOM + '{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON with leading/trailing whitespace and a BOM', () => {
    expect(parseJsonBody(BOM + '  \n {"a":1}\n ')).toEqual({ a: 1 });
  });

  it('returns undefined for undefined input', () => {
    expect(parseJsonBody(undefined)).toBeUndefined();
  });

  it('returns undefined for non-JSON text instead of throwing', () => {
    expect(parseJsonBody('<html>not json</html>')).toBeUndefined();
  });

  it('parses JSON primitives (caller still gates the tree on object-ness)', () => {
    expect(parseJsonBody('42')).toBe(42);
    expect(parseJsonBody('"hi"')).toBe('hi');
    expect(parseJsonBody('null')).toBeNull();
  });
});

describe('stripBom', () => {
  it('drops a leading BOM', () => {
    expect(stripBom(BOM + 'x')).toBe('x');
  });

  it('leaves BOM-free strings untouched', () => {
    expect(stripBom('x')).toBe('x');
    expect(stripBom('')).toBe('');
  });
});
