export interface ParsedCookie {
  name: string;
  value: string;
  attributes: string;
}

/** Persisted cookie jar: hostname → cookies. Simplified (name/value per host). */
export type CookieJar = Record<string, { name: string; value: string }[]>;

/** Hostname of a URL (protocol optional), or '' if unparseable. */
export function domainFromUrl(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).hostname;
  } catch {
    return '';
  }
}

/** `Cookie` header value for a URL from the jar, or '' if none. */
export function cookieHeaderFor(jar: CookieJar, url: string): string {
  const cookies = jar[domainFromUrl(url)];
  return cookies?.length ? cookies.map((c) => `${c.name}=${c.value}`).join('; ') : '';
}

/** Capture a Set-Cookie response header into the jar for the request's host. */
export function mergeSetCookie(jar: CookieJar, url: string, setCookieHeader: string | undefined): CookieJar {
  const parsed = parseSetCookie(setCookieHeader);
  const domain = domainFromUrl(url);
  if (!parsed.length || !domain) return jar;
  const map = new Map((jar[domain] ?? []).map((c) => [c.name, c.value]));
  for (const c of parsed) map.set(c.name, c.value);
  return { ...jar, [domain]: [...map.entries()].map(([name, value]) => ({ name, value })) };
}

/**
 * Parse a (possibly comma-joined) Set-Cookie header value into individual
 * cookies. Splits only on commas that precede a new `name=` pair, so commas
 * inside `Expires=...` are preserved.
 */
export function parseSetCookie(header: string | undefined): ParsedCookie[] {
  if (!header) return [];
  const parts = header.split(/,(?=\s*[^=;,\s]+\s*=)/);
  const out: ParsedCookie[] = [];
  for (const part of parts) {
    const segs = part.split(';');
    const first = segs[0]?.trim() ?? '';
    const eq = first.indexOf('=');
    if (eq === -1) continue;
    out.push({
      name: first.slice(0, eq).trim(),
      value: first.slice(eq + 1).trim(),
      attributes: segs
        .slice(1)
        .map((s) => s.trim())
        .filter(Boolean)
        .join('; '),
    });
  }
  return out;
}
