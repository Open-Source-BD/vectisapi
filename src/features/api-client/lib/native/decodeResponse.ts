import type { NativeError, ResponseData, ResponseMeta } from '../../types';

/** Bytes as returned by a raw Tauri response (an ArrayBuffer in Tauri 2). */
export type RawBytes = ArrayBuffer | Uint8Array | number[];

export function toBytes(raw: RawBytes): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return Uint8Array.from(raw);
}

/** Decode `send_request`'s frame: `[u32 LE meta_len][meta JSON (utf-8)][body prefix]`. */
export function decodeSendFrame(buf: RawBytes): { meta: ResponseMeta; prefix: Uint8Array } {
  const bytes = toBytes(buf);
  if (bytes.length < 4) throw new Error('malformed response frame');
  const metaLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (bytes.length < 4 + metaLen) throw new Error('malformed response frame');
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + metaLen))) as ResponseMeta;
  return { meta, prefix: bytes.subarray(4 + metaLen) };
}

/** Lossy UTF-8 decode (invalid sequences become U+FFFD). */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * Header list → the legacy lowercase-keyed record the UI renders: duplicate values
 * joined with `, `, except `set-cookie` (whose values contain commas) joined with `\n`.
 */
function joinHeaders(list: [string, string][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of list) {
    const key = name.toLowerCase();
    const sep = key === 'set-cookie' ? '\n' : ', ';
    out[key] = key in out ? `${out[key]}${sep}${value}` : value;
  }
  return out;
}

export function toResponseData(meta: ResponseMeta, prefix: Uint8Array): Omit<ResponseData, 'testResults'> {
  return {
    ok: meta.status >= 200 && meta.status <= 299,
    status: meta.status,
    statusText: meta.statusText,
    timeTaken: Math.round(meta.timing.totalMs),
    size: meta.size,
    rawText: decodeText(prefix),
    headers: joinHeaders(meta.headers),
    responseId: meta.responseId,
    truncated: meta.truncated,
    headerList: meta.headers,
    httpVersion: meta.httpVersion,
    timing: meta.timing,
    finalUrl: meta.finalUrl,
  };
}

/** Normalize any rejection into `{ kind, message }`. */
export function toNativeError(e: unknown): NativeError {
  if (e && typeof e === 'object' && 'kind' in e && 'message' in e) {
    const { kind, message } = e as { kind: unknown; message: unknown };
    return { kind: String(kind), message: String(message) };
  }
  if (e instanceof Error) return { kind: 'other', message: e.message };
  return { kind: 'other', message: String(e) };
}
