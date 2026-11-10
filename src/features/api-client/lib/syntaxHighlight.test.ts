import { describe, expect, it } from 'vitest';
import { syntaxHighlight } from './syntaxHighlight';

describe('syntaxHighlight', () => {
  it('wraps keys and string values', () => {
    const out = syntaxHighlight('{"a":"b"}');
    expect(out).toContain('<span class="json-key">"a":</span>');
    expect(out).toContain('<span class="json-string">"b"</span>');
  });

  it('wraps numbers, booleans, null', () => {
    const out = syntaxHighlight('{"n":1,"t":true,"z":null}');
    expect(out).toContain('<span class="json-number">1</span>');
    expect(out).toContain('<span class="json-boolean">true</span>');
    expect(out).toContain('<span class="json-null">null</span>');
  });

  it('escapes angle brackets', () => {
    expect(syntaxHighlight('<script>')).toContain('&lt;script&gt;');
  });

  it('stringifies non-string input', () => {
    expect(syntaxHighlight({ a: 1 })).toContain('json-key');
  });
});
