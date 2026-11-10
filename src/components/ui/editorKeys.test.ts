import { describe, expect, it } from 'vitest';
import { computeEdit } from './editorKeys';

const at = (value: string, pos: number, key: string) => computeEdit({ key, value, selStart: pos, selEnd: pos });

describe('computeEdit', () => {
  it('auto-closes an opening brace', () => {
    expect(at('', 0, '{')).toMatchObject({ text: '{}', cursorStart: 1, cursorEnd: 1 });
  });

  it('auto-closes brackets, parens, quotes', () => {
    expect(at('', 0, '[')?.text).toBe('[]');
    expect(at('', 0, '(')?.text).toBe('()');
    expect(at('', 0, '"')?.text).toBe('""');
    expect(at('', 0, '`')?.text).toBe('``');
  });

  it('wraps a selection', () => {
    const a = computeEdit({ key: '{', value: 'abc', selStart: 0, selEnd: 3 });
    expect(a).toMatchObject({ text: '{abc}', cursorStart: 1, cursorEnd: 4 });
  });

  it('overtypes a closing char already present', () => {
    // value "{}" cursor between → typing } moves past it, no insert
    expect(at('{}', 1, '}')).toMatchObject({ text: '', cursorStart: 2, cursorEnd: 2 });
  });

  it('overtypes a closing quote', () => {
    expect(at('""', 1, '"')).toMatchObject({ text: '', cursorStart: 2 });
  });

  it('backspace removes an empty pair', () => {
    expect(at('{}', 1, 'Backspace')).toMatchObject({ start: 0, end: 2, text: '', cursorStart: 0 });
  });

  it('Enter expands an empty pair with indentation', () => {
    const a = at('{}', 1, 'Enter');
    expect(a?.text).toBe('\n  \n');
    expect(a?.cursorStart).toBe(4);
  });

  it('Enter keeps current indentation', () => {
    // line "  ab" cursor at end (pos 4)
    const a = at('  ab', 4, 'Enter');
    expect(a?.text).toBe('\n  ');
  });

  it('Tab inserts two spaces', () => {
    expect(at('', 0, 'Tab')).toMatchObject({ text: '  ', cursorStart: 2 });
  });

  it('returns null for a normal character', () => {
    expect(at('', 0, 'a')).toBeNull();
  });
});

describe('computeEdit — HTML/XML tags', () => {
  const tag = (value: string, pos: number, lang: 'html' | 'xml') =>
    computeEdit({ key: '>', value, selStart: pos, selEnd: pos, lang });

  it('auto-closes an opening tag', () => {
    const a = tag('<div', 4, 'html');
    expect(a).toMatchObject({ text: '></div>', cursorStart: 5, cursorEnd: 5 });
  });

  it('handles attributes', () => {
    expect(tag('<a href="x"', 11, 'html')?.text).toBe('></a>');
  });

  it('skips void elements in html', () => {
    expect(tag('<br', 3, 'html')).toBeNull();
  });

  it('xml closes any tag (no void list)', () => {
    expect(tag('<br', 3, 'xml')?.text).toBe('></br>');
  });

  it('skips self-closing and closing tags', () => {
    expect(tag('<img/', 5, 'html')).toBeNull();
    expect(tag('</div', 5, 'html')).toBeNull();
  });
});

describe('computeEdit — plain text disables pairing', () => {
  it('does not auto-pair in text mode', () => {
    expect(computeEdit({ key: '{', value: '', selStart: 0, selEnd: 0, lang: 'text' })).toBeNull();
  });
  it('still auto-pairs in json mode', () => {
    expect(computeEdit({ key: '{', value: '', selStart: 0, selEnd: 0, lang: 'json' })?.text).toBe('{}');
  });
});
