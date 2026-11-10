// A small ZIP writer, so a whole recording can be saved as one file.
//
// Entries are deflated with the browser's CompressionStream where it exists
// (CSV shrinks to about a quarter) and stored as they are otherwise. Sizes and
// checksums are known before an entry is written, so no data descriptors are
// needed and every unzip tool can read the result. Archives stay far below
// 4 GB; ZIP64 is not implemented.

const encoder = new TextEncoder();

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}

/** CRC-32 as used by ZIP, gzip and PNG. */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function header(size, fill) {
  const bytes = new Uint8Array(size);
  fill(new DataView(bytes.buffer));
  return bytes;
}

/** Local time in the two 16-bit fields of the MS-DOS format, good to two seconds. */
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = (Math.max(date.getFullYear() - 1980, 0) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return [time, day];
}

/**
 * Build a ZIP archive from `[{ name, data }]`, where data is a string or a
 * Uint8Array, and return it as a Blob. `compress: false` stores everything.
 */
export async function zip(files, { date = new Date(), compress = typeof CompressionStream === 'function' } = {}) {
  const [time, day] = dosDateTime(date);
  const parts = [];
  const directory = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const raw = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const checksum = crc32(raw);
    let body = raw;
    let method = 0; // stored
    if (compress && raw.length > 0) {
      const packed = await deflate(raw);
      if (packed.length < raw.length) {
        body = packed;
        method = 8; // deflate
      }
    }
    // Fields shared by the local header and the directory entry.
    const common = (view, at) => {
      view.setUint16(at, 20, true); // version needed: 2.0
      view.setUint16(at + 2, 0x0800, true); // names are UTF-8
      view.setUint16(at + 4, method, true);
      view.setUint16(at + 6, time, true);
      view.setUint16(at + 8, day, true);
      view.setUint32(at + 10, checksum, true);
      view.setUint32(at + 14, body.length, true);
      view.setUint32(at + 18, raw.length, true);
      view.setUint16(at + 22, name.length, true);
    };
    const local = header(30, (view) => {
      view.setUint32(0, 0x04034b50, true);
      common(view, 4);
    });
    const entryOffset = offset;
    directory.push(
      header(46, (view) => {
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 20, true); // made by: 2.0
        common(view, 6);
        view.setUint32(42, entryOffset, true);
      }),
      name,
    );
    parts.push(local, name, body);
    offset += local.length + name.length + body.length;
  }

  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = header(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, files.length, true);
    view.setUint16(10, files.length, true);
    view.setUint32(12, directorySize, true);
    view.setUint32(16, offset, true);
  });
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
