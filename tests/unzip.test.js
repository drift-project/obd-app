// The archive reader is checked against Node's zlib, which writes the
// compressed data here, and against the app's own writer.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';

import { unzip, zip } from '../src/zip.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const text = ({ bytes }) => decoder.decode(bytes);

/**
 * A ZIP archive built by hand the way other tools build one: `extra` bytes
 * in the local header that the directory does not repeat, and an archive
 * comment at the end.
 */
function foreignZip(files, { comment = '' } = {}) {
  const chunks = [];
  const directory = [];
  let offset = 0;
  for (const { name, content, store = false, extra = 0 } of files) {
    const raw = encoder.encode(content);
    const body = store ? raw : new Uint8Array(deflateRawSync(raw));
    const nameBytes = encoder.encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, store ? 0 : 8, true);
    local.setUint32(14, crc32(raw), true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, extra, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(10, store ? 0 : 8, true);
    entry.setUint32(16, crc32(raw), true);
    entry.setUint32(20, body.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    directory.push(new Uint8Array(entry.buffer), nameBytes);
    chunks.push(new Uint8Array(local.buffer), nameBytes, new Uint8Array(extra), body);
    offset += 30 + nameBytes.length + extra + body.length;
  }
  const commentBytes = encoder.encode(comment);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directory.reduce((sum, part) => sum + part.length, 0), true);
  end.setUint32(16, offset, true);
  end.setUint16(20, commentBytes.length, true);
  return new Blob([...chunks, ...directory, new Uint8Array(end.buffer), commentBytes]);
}

const CSV = `timestamp_ms,x\r\n${Array.from({ length: 400 }, (_, i) => `${1794327542000 + i * 17},${i % 9}`).join('\r\n')}\r\n`;

test('an archive written by the app is read back whole', async () => {
  const files = [
    { name: 'obd_data_20261110_173958.csv', data: CSV },
    { name: 'phone_gps_20261110_173958.csv', data: 'timestamp_ms,speed_ms\r\n1794327542000,12.5\r\n' },
    { name: 'log_info_20261110_173958.txt', data: 'zażółć gęślą jaźń' },
  ];
  const read = await unzip(await zip(files));
  assert.deepEqual(read.map(({ name }) => name), files.map(({ name }) => name));
  assert.deepEqual(read.map(text), files.map(({ data }) => data));
});

test('an archive written without compression is read as well', async () => {
  const [file] = await unzip(await zip([{ name: 'a.csv', data: CSV }], { compress: false }));
  assert.equal(text(file), CSV);
});

test('archives from other tools are read: deflated, stored, with extra fields and a comment', async () => {
  const blob = foreignZip(
    [
      { name: 'phone_gyroscope_20261110_174900.csv', content: CSV, extra: 28 },
      { name: 'notes.txt', content: 'stored as it is', store: true },
    ],
    { comment: 'repacked on the phone' },
  );
  const read = await unzip(blob);
  assert.deepEqual(read.map(({ name }) => name), ['phone_gyroscope_20261110_174900.csv', 'notes.txt']);
  assert.equal(text(read[0]), CSV);
  assert.equal(text(read[1]), 'stored as it is');
});

test('an empty archive has no files', async () => {
  assert.deepEqual(await unzip(await zip([])), []);
});

test('something that is not an archive is refused', async () => {
  await assert.rejects(unzip(new Blob(['timestamp_ms,rpm\r\n1,2\r\n'])), /not a ZIP file/);
  await assert.rejects(unzip(new Blob([])), /not a ZIP file/);
});

test('a directory that points nowhere is reported as damage', async () => {
  const bytes = new Uint8Array(await (await zip([{ name: 'a.txt', data: 'a' }])).arrayBuffer());
  // Break the signature of the directory entry.
  const view = new DataView(bytes.buffer);
  const directory = view.getUint32(bytes.length - 22 + 16, true);
  bytes[directory] = 0;
  await assert.rejects(unzip(new Blob([bytes])), /damaged ZIP file/);
});
