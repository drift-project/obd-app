// The archive is read back here with Node's zlib, which shares no code with
// the writer: the directory is parsed by hand, the data inflated and the
// checksums recomputed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 as referenceCrc32, inflateRawSync } from 'node:zlib';

import { crc32, zip } from '../src/zip.js';

const decoder = new TextDecoder();

/** Read a ZIP the way an unzip tool does: from the directory at the end. */
async function unzip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'end of directory record');
  const count = view.getUint16(end + 10, true);
  assert.equal(view.getUint16(end + 8, true), count);
  const directorySize = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  assert.equal(at + directorySize, end, 'the directory ends where the end record starts');

  const entries = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50, 'directory entry');
    const method = view.getUint16(at + 10, true);
    const checksum = view.getUint32(at + 16, true);
    const packedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    // The local header must repeat what the directory says.
    assert.equal(view.getUint32(local, true), 0x04034b50, 'local header');
    assert.equal(view.getUint16(local + 8, true), method);
    assert.equal(view.getUint32(local + 14, true), checksum);
    assert.equal(view.getUint32(local + 18, true), packedSize);
    assert.equal(view.getUint32(local + 22, true), size);
    assert.equal(decoder.decode(bytes.subarray(local + 30, local + 30 + nameLength)), name);
    assert.equal(view.getUint16(local + 28, true), 0, 'no extra field');

    const packed = bytes.subarray(local + 30 + nameLength, local + 30 + nameLength + packedSize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(packed)) : packed;
    assert.ok(method === 0 || method === 8, `method ${method}`);
    assert.equal(data.length, size);
    assert.equal(referenceCrc32(data), checksum, `checksum of ${name}`);
    entries.push({ name, method, text: decoder.decode(data), date: view.getUint16(at + 14, true), time: view.getUint16(at + 12, true) });
    at += 46 + nameLength;
  }
  assert.equal(at, end);
  return entries;
}

const CSV = `timestamp_ms,x,y,z\r\n${Array.from({ length: 500 }, (_, i) => `${1793916437000 + i * 17},0.01,-9.81,${i % 7}`).join('\r\n')}\r\n`;

test('checksum matches the reference implementation', () => {
  const bytes = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
  assert.equal(crc32(bytes), 0x414fa339);
  assert.equal(crc32(bytes), referenceCrc32(bytes));
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('files come back out with their names and content', async () => {
  const blob = await zip([
    { name: 'obd.csv', data: 'timestamp_ms,rpm\r\n1,800\r\n' },
    { name: 'phone/gyroscope.csv', data: CSV },
    { name: 'info.txt', data: new TextEncoder().encode('zażółć gęślą jaźń') },
  ]);
  assert.equal(blob.type, 'application/zip');
  const entries = await unzip(blob);
  assert.deepEqual(entries.map((entry) => entry.name), ['obd.csv', 'phone/gyroscope.csv', 'info.txt']);
  assert.equal(entries[1].text, CSV);
  assert.equal(entries[2].text, 'zażółć gęślą jaźń');
});

test('repetitive data is deflated, data that would grow is stored', async () => {
  const entries = await unzip(await zip([{ name: 'big.csv', data: CSV }, { name: 'tiny.txt', data: 'ab' }]));
  assert.deepEqual(entries.map((entry) => entry.method), [8, 0]);
  const blob = await zip([{ name: 'big.csv', data: CSV }]);
  assert.ok(blob.size < CSV.length / 3, `${blob.size} bytes for ${CSV.length}`);
});

test('without a compressor everything is stored and still readable', async () => {
  const blob = await zip([{ name: 'big.csv', data: CSV }], { compress: false });
  const [entry] = await unzip(blob);
  assert.equal(entry.method, 0);
  assert.equal(entry.text, CSV);
});

test('an empty file and an empty archive are valid', async () => {
  const [entry] = await unzip(await zip([{ name: 'empty.csv', data: '' }]));
  assert.equal(entry.text, '');
  assert.deepEqual(await unzip(await zip([])), []);
});

test('entries carry the local date and time of the recording', async () => {
  const [entry] = await unzip(await zip([{ name: 'a.txt', data: 'a' }], { date: new Date(2026, 10, 10, 17, 19, 58) }));
  assert.equal(entry.date, ((2026 - 1980) << 9) | (11 << 5) | 10);
  assert.equal(entry.time, (17 << 11) | (19 << 5) | 29);
});
