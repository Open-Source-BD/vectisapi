export interface ParsedCookie {
  name: string;
  value: string;
  attributes: string;
}

/**
 * Parse a Set-Cookie header value into individual cookies. Native responses join
 * multiple Set-Cookie headers with `\n`; a comma-joined value is also split, but
 * only on commas that precede a new `name=` pair, so commas inside `Expires=...`
 * are preserved.
 */
export function parseSetCookie(header: string | undefined): ParsedCookie[] {
  if (!header) return [];
  const parts = header.split('\n').flatMap((line) => line.split(/,(?=\s*[^=;,\s]+\s*=)/));
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
