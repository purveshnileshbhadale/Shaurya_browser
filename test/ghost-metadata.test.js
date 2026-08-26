'use strict';
/**
 * Metadata stripping.
 *
 * The tests build real container structures rather than using fixtures, so
 * they assert on the actual segment/chunk walk and stay readable about what
 * a JPEG or PNG is made of.
 */
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const { stripMetadata } = require('../src/main/services/ghost/metadata');

// ---- builders -------------------------------------------------------------

/** A JPEG segment: FF <marker> <2-byte length including itself> <payload>. */
function seg(marker, payload = Buffer.alloc(0)) {
  const header = Buffer.from([0xFF, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function buildJpeg(segments) {
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8]),               // SOI
    ...segments,
    Buffer.from([0xFF, 0xDA, 0, 2]),         // SOS, then "image data"
    Buffer.from('scan-data-not-metadata'),
    Buffer.from([0xFF, 0xD9]),               // EOI
  ]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function chunk(type, data = Buffer.alloc(0)) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32
    ? zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0
    : 0x12345678);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function buildPng(chunks) {
  return Buffer.concat([PNG_SIG, ...chunks, chunk('IEND')]);
}

// ---- JPEG -----------------------------------------------------------------

test('JPEG: EXIF is removed and image data is byte-identical', () => {
  const exif = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from('II*\0GPS 51.5074 N 0.1278 W camera=Pixel'),
  ]);
  const quant = seg(0xDB, Buffer.from('quantisation-table'));
  const original = buildJpeg([seg(0xE1, exif), quant]);

  const result = stripMetadata(original);

  assert.equal(result.format, 'jpeg');
  assert.equal(result.changed, true);
  assert.ok(result.bytesRemoved > 30);
  assert.match(result.removed[0], /EXIF/);

  const text = result.data.toString('latin1');
  assert.ok(!text.includes('51.5074'), 'GPS coordinates must not survive');
  assert.ok(!text.includes('Pixel'), 'camera model must not survive');
  assert.ok(text.includes('scan-data-not-metadata'), 'image data must survive intact');
  assert.ok(text.includes('quantisation-table'), 'non-metadata segments must survive');
});

test('JPEG: an ICC colour profile is kept', () => {
  // Dropping ICC would visibly shift the colours of the image, which is a
  // change to its content rather than a privacy gain.
  const icc = Buffer.concat([
    Buffer.from('ICC_PROFILE\0', 'latin1'),
    Buffer.from('profile-payload'),
  ]);
  const original = buildJpeg([seg(0xE2, icc), seg(0xE1, Buffer.from('Exif\0\0junk', 'latin1'))]);

  const result = stripMetadata(original);

  assert.ok(result.data.toString('latin1').includes('profile-payload'),
    'ICC_PROFILE lives in APP2 and must be preserved');
  assert.ok(!result.data.toString('latin1').includes('junk'), 'EXIF still goes');
});

test('JPEG: a comment segment is removed', () => {
  const original = buildJpeg([seg(0xFE, Buffer.from('exported by /home/alice/photos'))]);
  const result = stripMetadata(original);

  assert.equal(result.changed, true);
  assert.ok(!result.data.toString('latin1').includes('/home/alice'),
    'a local path in a comment is exactly the kind of leak this exists for');
});

test('JPEG: a file with nothing to strip is returned unchanged and says so', () => {
  const original = buildJpeg([seg(0xDB, Buffer.from('table'))]);
  const result = stripMetadata(original);

  assert.equal(result.changed, false);
  assert.equal(result.bytesRemoved, 0);
  assert.ok(result.data.equals(original), 'the identical buffer, not a rebuilt one');
});

test('JPEG: a truncated file degrades safely instead of throwing', () => {
  const truncated = Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    Buffer.from([0xFF, 0xE1, 0x00, 0xFF]),   // claims 255 bytes that are not there
  ]);
  const result = stripMetadata(truncated);
  assert.ok(Buffer.isBuffer(result.data), 'must not throw on malformed input');
});

// ---- PNG ------------------------------------------------------------------

test('PNG: text chunks and eXIf are removed, pixel data survives', () => {
  const original = buildPng([
    chunk('IHDR', Buffer.from('header-bytes')),
    chunk('tEXt', Buffer.from('Author\0Alice Smith', 'latin1')),
    chunk('eXIf', Buffer.from('camera-and-gps')),
    chunk('IDAT', Buffer.from('actual-pixel-data')),
    chunk('tIME', Buffer.from('2026-08-26')),
  ]);

  const result = stripMetadata(original);

  assert.equal(result.format, 'png');
  assert.equal(result.changed, true);

  const text = result.data.toString('latin1');
  assert.ok(!text.includes('Alice Smith'), 'author name must not survive');
  assert.ok(!text.includes('camera-and-gps'));
  assert.ok(!text.includes('2026-08-26'), 'timestamps are metadata too');
  assert.ok(text.includes('actual-pixel-data'), 'pixel data must survive');
  assert.ok(text.includes('header-bytes'), 'IHDR must survive');
  assert.ok(result.data.subarray(0, 8).equals(PNG_SIG), 'signature intact');
  assert.ok(text.endsWith('IEND') || text.includes('IEND'), 'IEND must terminate the stream');
});

test('PNG: a clean file is passed through untouched', () => {
  const original = buildPng([
    chunk('IHDR', Buffer.from('header')),
    chunk('IDAT', Buffer.from('pixels')),
  ]);
  const result = stripMetadata(original);
  assert.equal(result.changed, false);
  assert.ok(result.data.equals(original));
});

// ---- dispatch -------------------------------------------------------------

test('an unrecognised format is passed through and reported honestly', () => {
  const pdfish = Buffer.from('%PDF-1.7\nAuthor: Alice\n');
  const result = stripMetadata(pdfish);

  assert.equal(result.format, 'unknown');
  assert.equal(result.changed, false);
  assert.ok(result.data.equals(pdfish),
    'claiming to have cleaned a format we do not parse would be worse than declining');
});

test('dispatch is on magic bytes, not the caller\'s claim about the file', () => {
  // A PNG that someone named .jpg still gets the PNG walk.
  const png = buildPng([chunk('tEXt', Buffer.from('secret'))]);
  const result = stripMetadata(png);
  assert.equal(result.format, 'png');
  assert.ok(!result.data.toString('latin1').includes('secret'));
});

test('tiny and empty buffers do not throw', () => {
  for (const input of [Buffer.alloc(0), Buffer.from([0xFF]), Buffer.from([0xFF, 0xD8])]) {
    const result = stripMetadata(input);
    assert.ok(Buffer.isBuffer(result.data));
  }
});
