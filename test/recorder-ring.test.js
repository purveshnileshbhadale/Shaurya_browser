'use strict';
/**
 * Instant-replay ring buffer.
 *
 * The failure this guards against is subtle and expensive: a clip that
 * assembles cleanly, writes without error, and then will not open in any
 * player, because the container's initialisation segment was evicted along
 * with the old media chunks.
 */
const test = require('node:test');
const assert = require('node:assert');

const { assembleClip } = require('../src/main/services/gaming/recorder');

const HEADER = Buffer.from('WEBM-HEADER');

/** A ring holding `count` one-per-second chunks ending `now`. */
function ring(count, now = Date.now(), { header = HEADER } = {}) {
  return {
    header,
    chunks: Array.from({ length: count }, (_, i) => ({
      at: now - (count - 1 - i) * 1000,
      data: Buffer.from(`chunk-${i}`),
    })),
  };
}

test('a clip carries the header even when chunk zero was evicted long ago', () => {
  const now = Date.now();
  const buffer = ring(60, now);              // a minute of history

  const clip = assembleClip(buffer, 10, now);

  assert.ok(clip.data.subarray(0, HEADER.length).equals(HEADER),
    'without the initialisation segment the file is unplayable, however many chunks follow');
  assert.ok(clip.data.includes('chunk-59'), 'the most recent chunk must be present');
  assert.ok(!clip.data.includes('chunk-20'), 'chunks older than the window must not be');
});

test('the window selects by wall-clock age, not chunk count', () => {
  const now = Date.now();
  const clip = assembleClip(ring(60, now), 10, now);

  // 10s at one chunk per second, inclusive of the boundary sample.
  assert.equal(clip.chunks, 11);
  assert.ok(clip.spanMs >= 9500 && clip.spanMs <= 10_500, `span was ${clip.spanMs}ms`);
});

test('asking for more history than the buffer holds returns everything it has', () => {
  const now = Date.now();
  const clip = assembleClip(ring(5, now), 30, now);

  assert.equal(clip.chunks, 5, 'a short buffer yields a short clip rather than an error');
  assert.ok(clip.data.includes('chunk-0'));
});

test('an empty buffer is refused rather than writing a zero-byte file', () => {
  assert.throws(
    () => assembleClip({ header: HEADER, chunks: [] }, 30),
    /replay buffer is empty/,
  );
});

test('a buffer whose chunks are all older than the window is refused', () => {
  const now = Date.now();
  const stale = ring(5, now - 60_000);
  assert.throws(() => assembleClip(stale, 10, now), /replay buffer is empty/);
});

test('a missing header still produces the media chunks, not a crash', () => {
  // Degraded rather than fatal: the clip may not play everywhere, but
  // throwing away captured footage the user asked to keep is worse.
  const now = Date.now();
  const clip = assembleClip(ring(10, now, { header: null }), 5, now);

  assert.ok(clip.chunks > 0);
  assert.ok(!clip.data.includes('WEBM-HEADER'));
});

test('chunks are concatenated in capture order', () => {
  const now = Date.now();
  const clip = assembleClip(ring(10, now), 5, now);
  const text = clip.data.toString();

  const first = text.indexOf('chunk-5');
  const last = text.indexOf('chunk-9');
  assert.ok(first !== -1 && last !== -1);
  assert.ok(first < last, 'out-of-order chunks would produce a scrambled clip');
});

test('the header is emitted exactly once', () => {
  const now = Date.now();
  const clip = assembleClip(ring(30, now), 20, now);
  const occurrences = clip.data.toString().split('WEBM-HEADER').length - 1;
  assert.equal(occurrences, 1);
});
