/**
 * Minimal ZIP reader/writer for the workspace snapshot fallback (Firefox/Safari,
 * where the File System Access API is unavailable). Pairs with
 * serializeWorkspace/deserializeWorkspace: the same FileEntry[] that the live
 * folder writes is packaged into a downloadable .zip, and an uploaded .zip is
 * unpacked back into FileEntry[].
 *
 * No dependency — the format is small and well-defined. Writing uses DEFLATE
 * (via the platform CompressionStream) with a STORE fallback; reading supports
 * STORE (method 0) and DEFLATE (method 8), so a zip re-created by the user's OS
 * archive tool still imports cleanly. Zip64, encryption, and data descriptors
 * are not produced by us; we parse the central directory, which always carries
 * the real sizes, so externally-zipped files round-trip too.
 */

import type { FileEntry } from './workspaceFile';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const DOS_DATE = 0x0021; // 1980-01-01, the zip epoch — deterministic across runs.

const enc = new TextEncoder();
const dec = new TextDecoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Pump bytes through a (de)compression transform. Uses the writer directly so
 *  it works in browsers and Node (jsdom's Blob.stream() is unreliable). */
async function pump(transform: GenericTransformStream, bytes: Uint8Array): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const buf = await new Response(transform.readable as ReadableStream<Uint8Array>).arrayBuffer();
  return new Uint8Array(buf);
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    return await pump(new CompressionStream('deflate-raw'), bytes);
  } catch {
    return null;
  }
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return pump(new DecompressionStream('deflate-raw'), bytes);
}

interface Local {
  nameBytes: Uint8Array;
  data: Uint8Array; // stored (possibly compressed) bytes
  crc: number;
  method: number;
  compSize: number;
  uncompSize: number;
  offset: number;
}

/** Build a .zip Blob from workspace file entries. */
export async function zipFiles(files: FileEntry[], opts: { compress?: boolean } = {}): Promise<Blob> {
  const compress = opts.compress !== false;
  const locals: Local[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  const emit = (b: Uint8Array) => {
    chunks.push(b);
    offset += b.length;
  };

  for (const file of files) {
    const nameBytes = enc.encode(file.path);
    const raw = enc.encode(file.content);
    const crc = crc32(raw);

    let method = 0;
    let data: Uint8Array = raw;
    if (compress) {
      const deflated = await deflateRaw(raw);
      // Only keep DEFLATE when it actually wins — tiny files can grow.
      if (deflated && deflated.length < raw.length) {
        method = 8;
        data = deflated;
      }
    }

    const local: Local = {
      nameBytes,
      data,
      crc,
      method,
      compSize: data.length,
      uncompSize: raw.length,
      offset,
    };
    locals.push(local);

    const header = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, LOCAL_SIG, true);
    v.setUint16(4, 20, true); // version needed
    v.setUint16(6, 0x0800, true); // UTF-8 filename flag
    v.setUint16(8, method, true);
    v.setUint16(10, 0, true); // time
    v.setUint16(12, DOS_DATE, true); // date
    v.setUint32(14, crc, true);
    v.setUint32(18, local.compSize, true);
    v.setUint32(22, local.uncompSize, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true); // extra len
    header.set(nameBytes, 30);
    emit(header);
    emit(data);
  }

  // Central directory.
  const cdStart = offset;
  for (const l of locals) {
    const rec = new Uint8Array(46 + l.nameBytes.length);
    const v = new DataView(rec.buffer);
    v.setUint32(0, CENTRAL_SIG, true);
    v.setUint16(4, 20, true); // version made by
    v.setUint16(6, 20, true); // version needed
    v.setUint16(8, 0x0800, true); // UTF-8 flag
    v.setUint16(10, l.method, true);
    v.setUint16(12, 0, true); // time
    v.setUint16(14, DOS_DATE, true); // date
    v.setUint32(16, l.crc, true);
    v.setUint32(20, l.compSize, true);
    v.setUint32(24, l.uncompSize, true);
    v.setUint16(28, l.nameBytes.length, true);
    v.setUint16(30, 0, true); // extra len
    v.setUint16(32, 0, true); // comment len
    v.setUint16(34, 0, true); // disk number
    v.setUint16(36, 0, true); // internal attrs
    v.setUint32(38, 0, true); // external attrs
    v.setUint32(42, l.offset, true); // local header offset
    rec.set(l.nameBytes, 46);
    emit(rec);
  }
  const cdSize = offset - cdStart;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, locals.length, true); // entries on this disk
  ev.setUint16(10, locals.length, true); // total entries
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  emit(eocd);

  return new Blob(chunks as BlobPart[], { type: 'application/zip' });
}

/** Parse a .zip into workspace file entries. Skips directory records and binary noise. */
export async function unzipFiles(buffer: ArrayBuffer): Promise<FileEntry[]> {
  const bytes = new Uint8Array(buffer);
  const v = new DataView(buffer);

  // Find the End Of Central Directory record (scan back past any zip comment).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid zip file (no end-of-central-directory record).');

  const total = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);

  const out: FileEntry[] = [];
  for (let n = 0; n < total; n++) {
    if (v.getUint32(p, true) !== CENTRAL_SIG) break;
    const method = v.getUint16(p + 10, true);
    const compSize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const localOff = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry
    if (!(name.endsWith('.json') || name.endsWith('.gitignore'))) continue;

    // Jump to the local header to find where the file data actually begins
    // (local name/extra lengths can differ from the central record).
    if (v.getUint32(localOff, true) !== LOCAL_SIG) continue;
    const lNameLen = v.getUint16(localOff + 26, true);
    const lExtraLen = v.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const stored = bytes.subarray(dataStart, dataStart + compSize);

    let raw: Uint8Array;
    if (method === 0) raw = stored;
    else if (method === 8) raw = await inflateRaw(stored);
    else continue; // unsupported compression — skip rather than corrupt

    out.push({ path: name, content: dec.decode(raw) });
  }
  return out;
}
