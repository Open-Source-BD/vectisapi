import { describe, expect, it } from 'vitest';
import { parseSetCookie } from './cookies';

describe('parseSetCookie', () => {
  it('returns [] for empty', () => {
    expect(parseSetCookie(undefined)).toEqual([]);
    expect(parseSetCookie('')).toEqual([]);
  });

  it('parses one cookie with attributes', () => {
    const c = parseSetCookie('sid=abc; Path=/; HttpOnly');
    expect(c[0]).toMatchObject({ name: 'sid', value: 'abc', attributes: 'Path=/; HttpOnly' });
  });

  it('splits multiple cookies, keeping commas inside Expires', () => {
    const c = parseSetCookie('a=1; Expires=Wed, 21 Oct 2025 07:28:00 GMT, b=2; Path=/');
    expect(c.map((x) => x.name)).toEqual(['a', 'b']);
    expect(c[0].attributes).toContain('Expires=Wed, 21 Oct 2025');
  });

  it('splits newline-joined Set-Cookie headers (native responses)', () => {
    const c = parseSetCookie('a=1; Expires=Wed, 21 Oct 2025 07:28:00 GMT; Path=/\nb=2; HttpOnly');
    expect(c.map((x) => x.name)).toEqual(['a', 'b']);
    expect(c[0].attributes).toBe('Expires=Wed, 21 Oct 2025 07:28:00 GMT; Path=/');
    expect(c[1].attributes).toBe('HttpOnly');
  });
});
