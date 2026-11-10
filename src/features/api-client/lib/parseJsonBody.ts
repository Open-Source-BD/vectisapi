/**
 * Tolerant JSON body parser for response detection. A strict `JSON.parse` on the
 * raw response text wrongly rejects valid JSON that ships a leading UTF-8 BOM
 * (﻿) — common from .NET/IIS and some CDNs — which then hides the Pretty
 * view + Types tab. Strip a leading BOM and surrounding whitespace, then parse.
 * Returns `undefined` (never throws) when the body isn't JSON.
 */
export function parseJsonBody(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(stripBom(text).trim());
  } catch {
    return undefined;
  }
}

/** Drop a leading UTF-8 byte-order mark if present. */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
