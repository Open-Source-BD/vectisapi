import { describe, expect, it } from 'vitest';
import { parseData } from './parseData';

describe('parseData', () => {
  it('returns [] for empty input', () => {
    expect(parseData('')).toEqual([]);
    expect(parseData('   ')).toEqual([]);
  });

  it('parses a JSON array of objects', () => {
    const rows = parseData('[{"id":1,"name":"a"},{"id":2,"name":"b"}]');
    expect(rows).toEqual([
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
    ]);
  });

  it('wraps a single JSON object as one row and stringifies nested values', () => {
    const rows = parseData('{"id":7,"meta":{"k":1}}');
    expect(rows).toEqual([{ id: '7', meta: '{"k":1}' }]);
  });

  it('parses CSV with a header row', () => {
    const rows = parseData('id,name\n1,alice\n2,bob');
    expect(rows).toEqual([
      { id: '1', name: 'alice' },
      { id: '2', name: 'bob' },
    ]);
  });

  it('honors quoted CSV fields containing commas and escaped quotes', () => {
    const rows = parseData('id,note\n1,"a,b"\n2,"say ""hi"""');
    expect(rows).toEqual([
      { id: '1', note: 'a,b' },
      { id: '2', note: 'say "hi"' },
    ]);
  });

  it('throws on malformed JSON instead of returning []', () => {
    expect(() => parseData('[{bad json}]')).toThrow();
  });

  it('throws when a JSON row is not an object', () => {
    expect(() => parseData('[1,2,3]')).toThrow();
  });
});
