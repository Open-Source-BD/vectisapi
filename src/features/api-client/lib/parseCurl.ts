import type { HttpMethod, RawType, TabState } from '../types';
import { generateId } from './id';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const MIME_TO_RAW: Record<string, RawType> = {
  'application/json': 'application/json',
  'application/xml': 'application/xml',
  'text/xml': 'application/xml',
  'text/html': 'text/html',
  'text/plain': 'text/plain',
};

/** Shell-style tokenizer: handles ' and " quotes, escapes, and \<newline> joins. */
export function tokenize(input: string): string[] {
  const s = input.replace(/\\\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') cur += s[++i] ?? '';
      else cur += c;
      started = true;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        out.push(cur);
        cur = '';
        started = false;
      }
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

const kv = (k: string, v: string) => ({ id: generateId(), key: k, value: v, type: 'text' as const });

/** Flags that consume the following token as their value. */
const VALUE_FLAGS = new Set([
  '-X',
  '--request',
  '-H',
  '--header',
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '-u',
  '--user',
  '--url',
  '-b',
  '--cookie',
  '-A',
  '--user-agent',
  '-e',
  '--referer',
]);

/** Parse a curl command into a TabState, layered onto `base` (e.g. createDefaultTab()). */
export function parseCurl(input: string, base: TabState): TabState {
  const tab: TabState = JSON.parse(JSON.stringify(base));
  tab.headers = [];
  const tokens = tokenize(input.trim().replace(/^curl\s+/i, ''));

  let explicitMethod: HttpMethod | null = null;
  let hasBody = false;

  const setRaw = (content: string) => {
    tab.body.type = 'raw';
    tab.body.rawContent = tab.body.rawContent ? tab.body.rawContent + '&' + content : content;
    hasBody = true;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = () => tokens[++i] ?? '';

    if (t === '-X' || t === '--request') {
      const m = next().toUpperCase() as HttpMethod;
      if (METHODS.includes(m)) explicitMethod = m;
    } else if (t === '-H' || t === '--header') {
      const raw = next();
      const idx = raw.indexOf(':');
      if (idx === -1) continue;
      const key = raw.slice(0, idx).trim();
      const value = raw.slice(idx + 1).trim();
      if (key.toLowerCase() === 'authorization' && /^bearer\s/i.test(value)) {
        tab.auth.type = 'bearer';
        tab.auth.bearer = value.replace(/^bearer\s+/i, '');
      } else {
        tab.headers.push(kv(key, value));
        if (key.toLowerCase() === 'content-type') {
          const mime = value.split(';')[0].trim();
          if (MIME_TO_RAW[mime]) tab.body.rawType = MIME_TO_RAW[mime];
        }
      }
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') {
      setRaw(next());
    } else if (t === '--data-urlencode') {
      const raw = next();
      const eq = raw.indexOf('=');
      tab.body.type = 'urlencoded';
      tab.body.urlencoded.push(eq === -1 ? kv(raw, '') : kv(raw.slice(0, eq), raw.slice(eq + 1)));
      hasBody = true;
    } else if (t === '-u' || t === '--user') {
      const raw = next();
      const c = raw.indexOf(':');
      tab.auth.type = 'basic';
      tab.auth.basicUser = c === -1 ? raw : raw.slice(0, c);
      tab.auth.basicPass = c === -1 ? '' : raw.slice(c + 1);
    } else if (t === '-b' || t === '--cookie') {
      tab.headers.push(kv('Cookie', next()));
    } else if (t === '--url') {
      tab.url = next();
    } else if (VALUE_FLAGS.has(t)) {
      next(); // consume value of a flag we don't model
    } else if (t.startsWith('-')) {
      // boolean flag (-L, -k, -s, --compressed, …) — ignore
    } else if (!tab.url) {
      tab.url = t;
    }
  }

  tab.method = explicitMethod ?? (hasBody ? 'POST' : 'GET');
  return tab;
}
