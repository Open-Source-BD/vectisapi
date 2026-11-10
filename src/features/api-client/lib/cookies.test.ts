import { describe, expect, it } from 'vitest';
import { parseSetCookie, domainFromUrl, cookieHeaderFor, mergeSetCookie, type CookieJar } from './cookies';

describe('cookie jar', () => {
  it('extracts the hostname (protocol optional)', () => {
    expect(domainFromUrl('https://api.example.com/v1/x?y=1')).toBe('api.example.com');
    expect(domainFromUrl('api.example.com/x')).toBe('api.example.com');
    expect(domainFromUrl('')).toBe('');
  });

  it('builds a Cookie header for a matching host only', () => {
    const jar: CookieJar = {
      'api.example.com': [
        { name: 'sid', value: 'a' },
        { name: 'csrf', value: 'b' },
      ],
    };
    expect(cookieHeaderFor(jar, 'https://api.example.com/x')).toBe('sid=a; csrf=b');
    expect(cookieHeaderFor(jar, 'https://other.com/x')).toBe('');
  });

  it('merges Set-Cookie into the jar, upserting by name', () => {
    let jar: CookieJar = {};
    jar = mergeSetCookie(jar, 'https://api.example.com/login', 'sid=1; Path=/; HttpOnly');
    expect(jar['api.example.com']).toEqual([{ name: 'sid', value: '1' }]);
    jar = mergeSetCookie(jar, 'https://api.example.com/login', 'sid=2, theme=dark');
    expect(jar['api.example.com']).toEqual([
      { name: 'sid', value: '2' },
      { name: 'theme', value: 'dark' },
    ]);
  });

  it('is a no-op when there is no Set-Cookie or host', () => {
    const jar: CookieJar = { 'x.com': [{ name: 'a', value: '1' }] };
    expect(mergeSetCookie(jar, 'https://x.com/y', undefined)).toBe(jar);
  });
});

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
});
