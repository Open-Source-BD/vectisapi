import { describe, it, expect } from 'vitest';
import { decodeSendFrame, toResponseData } from './decodeResponse';
import type { ResponseMeta } from '../../types';

const meta = (over: Partial<ResponseMeta> = {}): ResponseMeta => ({
  responseId: 'resp-1',
  status: 200,
  statusText: 'OK',
  httpVersion: 'HTTP/1.1',
  headers: [['content-type', 'application/json']],
  remoteAddr: '127.0.0.1:80',
  finalUrl: 'http://example.test/x',
  size: 11,
  timing: { totalMs: 12.6, ttfbMs: 4.2 },
  truncated: false,
  ...over,
});

/** Builds `[u32 LE meta_len][meta JSON][prefix]` like the Rust command. */
function frame(m: ResponseMeta, prefix: Uint8Array): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(m));
  const out = new Uint8Array(4 + json.length + prefix.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  out.set(prefix, 4 + json.length);
  return out.buffer;
}

describe('decodeSendFrame', () => {
  it('decodes frame', () => {
    const m = meta();
    const body = new Uint8Array([0x00, 0xff, 0x68, 0x69]);
    const out = decodeSendFrame(frame(m, body));
    expect(out.meta).toEqual(m);
    expect(Array.from(out.prefix)).toEqual([0x00, 0xff, 0x68, 0x69]);
  });

  it('decodes a frame with an empty body', () => {
    const out = decodeSendFrame(frame(meta({ size: 0 }), new Uint8Array()));
    expect(out.meta.size).toBe(0);
    expect(out.prefix.length).toBe(0);
  });

  it('rejects a frame shorter than its declared meta length', () => {
    const bad = new Uint8Array([200, 0, 0, 0, 0x7b]);
    expect(() => decodeSendFrame(bad.buffer)).toThrow(/malformed/i);
  });
});

describe('toResponseData', () => {
  it('maps meta fields', () => {
    const r = toResponseData(meta(), new TextEncoder().encode('{"a":1}'));
    expect(r).toMatchObject({
      ok: true,
      status: 200,
      statusText: 'OK',
      timeTaken: 13,
      size: 11,
      rawText: '{"a":1}',
      responseId: 'resp-1',
      truncated: false,
      httpVersion: 'HTTP/1.1',
      timing: { totalMs: 12.6, ttfbMs: 4.2 },
      finalUrl: 'http://example.test/x',
      headerList: [['content-type', 'application/json']],
    });
    expect(r).not.toHaveProperty('transport');
  });

  it('ok is true only for 2xx', () => {
    expect(toResponseData(meta({ status: 299 }), new Uint8Array()).ok).toBe(true);
    expect(toResponseData(meta({ status: 199 }), new Uint8Array()).ok).toBe(false);
    expect(toResponseData(meta({ status: 304 }), new Uint8Array()).ok).toBe(false);
    expect(toResponseData(meta({ status: 404 }), new Uint8Array()).ok).toBe(false);
  });

  it('joins duplicate headers', () => {
    const r = toResponseData(
      meta({
        headers: [
          ['Vary', 'Accept'],
          ['link', '<a>; rel=next'],
          ['vary', 'Origin'],
          ['Link', '<b>; rel=prev'],
        ],
      }),
      new Uint8Array(),
    );
    expect(r.headers).toEqual({ vary: 'Accept, Origin', link: '<a>; rel=next, <b>; rel=prev' });
    expect(r.headerList).toHaveLength(4);
  });

  it('set-cookie joined with newline', () => {
    const r = toResponseData(
      meta({
        headers: [
          ['Set-Cookie', 'a=1; Expires=Wed, 21 Oct 2025 07:28:00 GMT'],
          ['set-cookie', 'b=2; Path=/'],
        ],
      }),
      new Uint8Array(),
    );
    expect(r.headers['set-cookie']).toBe('a=1; Expires=Wed, 21 Oct 2025 07:28:00 GMT\nb=2; Path=/');
  });

  it('invalid utf8 prefix decodes lossily', () => {
    const r = toResponseData(meta({ size: 5 }), new Uint8Array([0x68, 0xff, 0xfe, 0x69, 0xc3]));
    expect(r.rawText).toBe('h��i�');
    expect(r.size).toBe(5);
  });
});
