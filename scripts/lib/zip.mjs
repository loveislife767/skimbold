// Zero-dependency ZIP writer and reader for release packages.
//
// Output is deterministic: entries are sorted by name, every entry carries the same DOS
// timestamp (1980-01-01 00:00), and the compressor settings are fixed, so building the same
// files twice gives byte-identical archives. Names are UTF-8 with forward slashes, which is
// what the Chrome Web Store, Edge Add-ons and addons.mozilla.org expect.
//
// Deliberately limited to what extension packages need: no ZIP64 (under 65,535 entries and
// 4 GiB), no directory entries, no encryption.
import zlib from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_UTF8 = 0x0800;
const VERSION_NEEDED = 20;
// "Made by" Unix (high byte 3) so the external attributes below carry a Unix file mode.
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED;
const FILE_MODE = 0o100644;
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980-01-01: year offset 0, month 1, day 1 (the earliest DOS date)
const MAX_UINT32 = 0xffffffff;
const MAX_UINT16 = 0xffff;

// Formats that are already compressed; deflating them again only costs time.
const STORED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.pdf', '.zip', '.gz', '.br', '.woff', '.woff2', '.mp3', '.mp4', '.webm', '.ogg',
]);

function extensionOf(name) {
  const slash = name.lastIndexOf('/');
  const dot = name.lastIndexOf('.');
  return dot > slash ? name.slice(dot).toLowerCase() : '';
}

function normaliseName(name) {
  if (typeof name !== 'string' || name === '') throw new TypeError('zip: every entry needs a non-empty name');
  const clean = name.replaceAll('\\', '/');
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.split('/').some((part) => part === '..' || part === '' || part === '.')) {
    throw new Error(`zip: unsafe or malformed entry name "${name}"`);
  }
  return clean;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('zip: entry data must be a Buffer, Uint8Array or string');
}

/**
 * Builds a ZIP archive in memory.
 * @param {Array<{name: string, data: Buffer|Uint8Array|string}>} entries
 * @param {{level?: number}} [options] deflate level, 0–9 (default 9)
 * @returns {Buffer}
 */
export function createZip(entries, { level = 9 } = {}) {
  const prepared = entries.map(({ name, data }) => ({ name: normaliseName(name), data: toBuffer(data) }));
  prepared.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < prepared.length; i++) {
    if (prepared[i].name === prepared[i - 1].name) throw new Error(`zip: duplicate entry "${prepared[i].name}"`);
  }
  if (prepared.length > MAX_UINT16) throw new Error('zip: too many entries (ZIP64 is not supported)');

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of prepared) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    let method = METHOD_STORE;
    let body = data;
    if (!STORED_EXTENSIONS.has(extensionOf(name)) && data.length > 0) {
      const deflated = zlib.deflateRawSync(data, { level });
      // Keep the smaller form: tiny or random files can grow when deflated.
      if (deflated.length < data.length) {
        method = METHOD_DEFLATE;
        body = deflated;
      }
    }
    if (data.length > MAX_UINT32 || offset > MAX_UINT32) throw new Error('zip: archive too large (ZIP64 is not supported)');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(VERSION_MADE_BY, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(FLAG_UTF8, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // extra field length
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);

    chunks.push(local, nameBytes, body);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }

  const centralBytes = Buffer.concat(central);
  if (offset > MAX_UINT32) throw new Error('zip: archive too large (ZIP64 is not supported)');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(prepared.length, 8);
  end.writeUInt16LE(prepared.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBytes, end]);
}

/**
 * Reads a ZIP archive written by createZip (or any non-ZIP64, unencrypted archive that uses
 * store or deflate). Verifies each entry's CRC-32 and size, and that the local and central
 * headers agree. Throws on any inconsistency.
 * @param {Buffer} zip
 * @returns {Array<{name: string, data: Buffer, method: number, crc32: number, compressedSize: number, flags: number, dosTime: number, dosDate: number, externalAttributes: number}>}
 */
export function readZip(zip) {
  const buf = toBuffer(zip);
  let endAt = -1;
  // The end record is 22 bytes plus a comment of up to 65,535 bytes.
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - MAX_UINT16); i--) {
    if (buf.readUInt32LE(i) === END_OF_CENTRAL) {
      endAt = i;
      break;
    }
  }
  if (endAt < 0) throw new Error('zip: end of central directory not found');
  const count = buf.readUInt16LE(endAt + 10);
  const centralSize = buf.readUInt32LE(endAt + 12);
  let at = buf.readUInt32LE(endAt + 16);
  if (at + centralSize > endAt) throw new Error('zip: central directory overlaps the end record');

  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== CENTRAL_HEADER) throw new Error(`zip: bad central header #${n}`);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const dosTime = buf.readUInt16LE(at + 12);
    const dosDate = buf.readUInt16LE(at + 14);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const externalAttributes = buf.readUInt32LE(at + 38);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x0001) throw new Error(`zip: "${name}" is encrypted`);
    if (buf.readUInt32LE(localAt) !== LOCAL_HEADER) throw new Error(`zip: bad local header for "${name}"`);
    const localNameLength = buf.readUInt16LE(localAt + 26);
    const localExtraLength = buf.readUInt16LE(localAt + 28);
    const localName = buf.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1', localAt + 30, localAt + 30 + localNameLength);
    if (localName !== name) throw new Error(`zip: local and central names differ for "${name}"`);
    if (buf.readUInt16LE(localAt + 8) !== method || buf.readUInt32LE(localAt + 14) !== crc) {
      throw new Error(`zip: local and central headers disagree for "${name}"`);
    }
    const start = localAt + 30 + localNameLength + localExtraLength;
    const body = buf.subarray(start, start + compressedSize);

    let data;
    if (method === METHOD_STORE) data = Buffer.from(body);
    else if (method === METHOD_DEFLATE) data = zlib.inflateRawSync(body);
    else throw new Error(`zip: "${name}" uses unsupported method ${method}`);
    if (data.length !== size) throw new Error(`zip: "${name}" is ${data.length} bytes, header says ${size}`);
    if (zlib.crc32(data) !== crc) throw new Error(`zip: CRC mismatch for "${name}"`);

    entries.push({ name, data, method, crc32: crc, compressedSize, flags, dosTime, dosDate, externalAttributes });
  }
  return entries;
}
