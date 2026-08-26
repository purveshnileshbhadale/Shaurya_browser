'use strict';
/**
 * RFC 6455 framing tests.
 *
 * Framing bugs are nasty because they present as "the server closed the
 * connection" with no further detail. The cases here are the ones that
 * actually bite: the three payload-length encodings, client masking (a
 * server MUST close on an unmasked client frame), and partial reads — a TCP
 * chunk boundary lands mid-frame constantly on a busy socket.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { encodeFrame, decodeFrame } = require('../src/main/services/devtools/websocket-inspector');

/** Undo client masking so a test can read what a server would. */
function serverView(frame) {
  const decoded = decodeFrame(frame);
  assert.ok(decoded, 'frame should decode');
  return decoded;
}

test('encodes and decodes a short text frame', () => {
  const frame = encodeFrame(Buffer.from('hello', 'utf8'), 0x1);
  const decoded = serverView(frame);
  assert.equal(decoded.opcode, 0x1);
  assert.equal(decoded.payload.toString('utf8'), 'hello');
  assert.equal(decoded.consumed, frame.length);
});

test('client frames are always masked', () => {
  const frame = encodeFrame(Buffer.from('x'), 0x1);
  // Bit 0x80 of the second byte is the MASK flag.
  assert.equal(Boolean(frame[1] & 0x80), true,
    'an unmasked client frame makes a compliant server close the connection');
});

test('the same payload masks differently each time', () => {
  const a = encodeFrame(Buffer.from('repeat'), 0x1);
  const b = encodeFrame(Buffer.from('repeat'), 0x1);
  assert.notEqual(a.toString('hex'), b.toString('hex'), 'masking key must be fresh per frame');
  assert.equal(serverView(a).payload.toString(), serverView(b).payload.toString());
});

test('handles the 16-bit extended length encoding', () => {
  // 126..65535 uses the 2-byte length form.
  const payload = Buffer.alloc(1000, 0x61);
  const frame = encodeFrame(payload, 0x1);
  assert.equal(frame[1] & 0x7f, 126, 'length marker selects the 16-bit form');
  const decoded = serverView(frame);
  assert.equal(decoded.payload.length, 1000);
  assert.equal(decoded.payload.toString('utf8'), 'a'.repeat(1000));
});

test('handles the 64-bit extended length encoding', () => {
  const payload = Buffer.alloc(70000, 0x62);
  const frame = encodeFrame(payload, 0x2);
  assert.equal(frame[1] & 0x7f, 127, 'length marker selects the 64-bit form');
  const decoded = serverView(frame);
  assert.equal(decoded.opcode, 0x2);
  assert.equal(decoded.payload.length, 70000);
});

test('boundary at exactly 125 and 126 bytes', () => {
  const small = encodeFrame(Buffer.alloc(125, 0x63), 0x1);
  assert.equal(small[1] & 0x7f, 125, '125 fits the 7-bit form');
  assert.equal(serverView(small).payload.length, 125);

  const big = encodeFrame(Buffer.alloc(126, 0x63), 0x1);
  assert.equal(big[1] & 0x7f, 126, '126 needs the extended form');
  assert.equal(serverView(big).payload.length, 126);
});

test('an empty close frame round-trips', () => {
  const frame = encodeFrame(Buffer.alloc(0), 0x8);
  const decoded = serverView(frame);
  assert.equal(decoded.opcode, 0x8);
  assert.equal(decoded.payload.length, 0);
});

test('FIN bit is set on every frame we send', () => {
  for (const opcode of [0x1, 0x2, 0x8, 0x9, 0xa]) {
    const frame = encodeFrame(Buffer.from('x'), opcode);
    assert.equal(Boolean(frame[0] & 0x80), true, `FIN missing for opcode ${opcode}`);
    assert.equal(frame[0] & 0x0f, opcode);
  }
});

test('a partial frame decodes to null instead of throwing', () => {
  const frame = encodeFrame(Buffer.from('a longer message that will be split'), 0x1);
  // Every truncation point must be handled gracefully.
  for (let cut = 0; cut < frame.length; cut++) {
    assert.equal(decodeFrame(frame.subarray(0, cut)), null,
      `truncating at ${cut} bytes should report "not yet complete"`);
  }
  assert.ok(decodeFrame(frame), 'the complete frame decodes');
});

test('two frames in one buffer are decoded one at a time', () => {
  const combined = Buffer.concat([
    encodeFrame(Buffer.from('first'), 0x1),
    encodeFrame(Buffer.from('second'), 0x1),
  ]);

  const first = decodeFrame(combined);
  assert.equal(first.payload.toString(), 'first');

  const rest = combined.subarray(first.consumed);
  const second = decodeFrame(rest);
  assert.equal(second.payload.toString(), 'second');
  assert.equal(second.consumed, rest.length, 'the buffer is fully consumed');
});

test('unmasked server frames decode correctly', () => {
  // Servers do not mask. Build one by hand: FIN + text, no mask bit.
  const payload = Buffer.from('from server', 'utf8');
  const frame = Buffer.concat([
    Buffer.from([0x81, payload.length]),
    payload,
  ]);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.opcode, 0x1);
  assert.equal(decoded.payload.toString('utf8'), 'from server');
});

test('binary payloads survive the round trip byte for byte', () => {
  const payload = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x01, 0xfe, 0x00]);
  const decoded = serverView(encodeFrame(payload, 0x2));
  assert.deepEqual([...decoded.payload], [...payload]);
});

test('multi-byte UTF-8 is not corrupted by masking', () => {
  const text = 'héllo — 世界 🌍';
  const decoded = serverView(encodeFrame(Buffer.from(text, 'utf8'), 0x1));
  assert.equal(decoded.payload.toString('utf8'), text);
});
