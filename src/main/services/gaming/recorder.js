'use strict';
/**
 * Screen recording and instant-replay clipping (spec §4).
 *
 * The architecture is dictated by where the encoder lives. `MediaRecorder`
 * runs in a renderer, not in Node, so the main process cannot encode video
 * itself. This service therefore owns *policy* — what to capture, how deep
 * the replay buffer is, where files land — and drives a hidden renderer that
 * owns the actual capture pipeline.
 *
 * The instant-replay buffer is the interesting part. `MediaRecorder` with a
 * `timeslice` emits a chunk every N milliseconds; keeping the last
 * `replaySeconds / timeslice` chunks in a ring gives "save the last 30
 * seconds" for the cost of holding those chunks in memory, with no disk
 * writes at all until the user actually clips.
 *
 * One real constraint: **the first chunk carries the container header**. A
 * naive ring that has evicted chunk 0 produces a file no player will open.
 * So the header chunk is retained separately and prepended on every clip —
 * see `assembleClip`, which is pure and directly tested.
 */
const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs/promises');
const { app, desktopCapturer } = require('electron');

const { createLogger } = require('../../util/logger');

const log = createLogger('recorder');

/** Chunk cadence. 500ms bounds clip precision without flooding IPC. */
const TIMESLICE_MS = 500;

/**
 * Assemble a clip from a ring buffer.
 *
 * Pure, so the header-retention rule is testable without a compositor.
 *
 * @param {{header: Buffer|null, chunks: Array<{at:number,data:Buffer}>}} buffer
 * @param {number} seconds how far back to reach
 * @param {number} [now]
 * @returns {{data: Buffer, chunks: number, spanMs: number}}
 */
function assembleClip(buffer, seconds, now = Date.now()) {
  const cutoff = now - seconds * 1000;
  const kept = buffer.chunks.filter((c) => c.at >= cutoff);
  if (!kept.length) throw new Error('the replay buffer is empty');

  const parts = [];
  // Without the initialisation segment the result is not a playable file,
  // however many media chunks follow it.
  if (buffer.header) parts.push(buffer.header);
  for (const chunk of kept) parts.push(chunk.data);

  return {
    data: Buffer.concat(parts),
    chunks: kept.length,
    spanMs: kept[kept.length - 1].at - kept[0].at,
  };
}

class RecorderService extends EventEmitter {
  constructor({ settings, features }) {
    super();
    this.settings = settings;
    this.features = features;

    /** The renderer that actually holds the MediaRecorder. */
    this.host = null;

    this.recording = false;
    this.bufferArmed = false;
    this._startedAt = 0;

    /** @type {{header: Buffer|null, chunks: Array<{at:number,data:Buffer}>}} */
    this._ring = { header: null, chunks: [] };
    this._fullChunks = [];
  }

  attach(hostWebContents) {
    this.host = hostWebContents;
  }

  config() {
    return this.settings.get('gaming.recorder');
  }

  /** Sources the user can capture. Screens and windows, never a bare list. */
  async sources() {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumbnail: s.thumbnail?.toDataURL?.() || null,
    }));
  }

  /**
   * Arm the replay buffer.
   *
   * Kept separate from `start()` because they are genuinely different acts:
   * arming costs memory and produces no file, recording produces a file. A
   * user who wants clips does not necessarily want a 40-minute recording.
   */
  async armBuffer({ sourceId } = {}) {
    if (!this.features.enabled('recorder')) throw new Error('the recorder is off');
    if (this.bufferArmed) return this.state();

    this._ring = { header: null, chunks: [] };
    this.bufferArmed = true;

    this._send('recorder:arm', {
      sourceId,
      timeslice: TIMESLICE_MS,
      seconds: this.config().replaySeconds,
      fps: this.config().fps,
      resolution: this.config().resolution,
      audio: this.config().audio,
    });

    log.info(`replay buffer armed (${this.config().replaySeconds}s)`);
    this.emit('state', this.state());
    return this.state();
  }

  disarmBuffer() {
    this.bufferArmed = false;
    this._ring = { header: null, chunks: [] };
    this._send('recorder:disarm', {});
    this.emit('state', this.state());
    return this.state();
  }

  /**
   * A chunk arrived from the capture renderer.
   *
   * @param {Buffer} data
   * @param {boolean} isHeader true for the first chunk of a stream
   */
  ingest(data, { isHeader = false, forFullRecording = false } = {}) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (forFullRecording) {
      this._fullChunks.push(buffer);
      return;
    }
    if (isHeader || !this._ring.header) {
      this._ring.header = buffer;
      return;
    }

    this._ring.chunks.push({ at: Date.now(), data: buffer });
    this._evict();
  }

  /** Drop anything older than the configured depth, plus a small margin. */
  _evict() {
    const depthMs = (this.config().replaySeconds + 2) * 1000;
    const cutoff = Date.now() - depthMs;
    while (this._ring.chunks.length && this._ring.chunks[0].at < cutoff) {
      this._ring.chunks.shift();
    }
  }

  /** "Save the last N seconds." */
  async clip({ seconds } = {}) {
    if (!this.bufferArmed) throw new Error('the replay buffer is not armed');
    const depth = seconds || this.config().replaySeconds;

    const { data, chunks, spanMs } = assembleClip(this._ring, depth);
    const file = await this._write(data, 'clip');

    log.info(`clipped ${Math.round(spanMs / 1000)}s from ${chunks} chunks -> ${file.path}`);
    this.emit('clip', file);
    return { ...file, seconds: Math.round(spanMs / 1000), chunks };
  }

  // -- full recording ----------------------------------------------------

  async start({ sourceId } = {}) {
    if (!this.features.enabled('recorder')) throw new Error('the recorder is off');
    if (this.recording) return this.state();

    this._fullChunks = [];
    this.recording = true;
    this._startedAt = Date.now();

    this._send('recorder:start', {
      sourceId,
      timeslice: TIMESLICE_MS,
      fps: this.config().fps,
      resolution: this.config().resolution,
      audio: this.config().audio,
    });

    this.emit('state', this.state());
    return this.state();
  }

  async stop() {
    if (!this.recording) return this.state();
    this.recording = false;
    this._send('recorder:stop', {});

    // The renderer flushes a final chunk on stop; give it a moment rather
    // than truncating the last half second of every recording.
    await new Promise((resolve) => { setTimeout(resolve, TIMESLICE_MS + 200); });

    if (!this._fullChunks.length) {
      this.emit('state', this.state());
      throw new Error('the recording produced no data');
    }

    const file = await this._write(Buffer.concat(this._fullChunks), 'recording');
    this._fullChunks = [];

    log.info(`recording saved: ${file.path}`);
    this.emit('saved', file);
    this.emit('state', this.state());
    return file;
  }

  // -- output ------------------------------------------------------------

  async outputDir() {
    const configured = this.config().directory;
    const dir = configured || path.join(app.getPath('videos'), 'Shaurya');
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async _write(data, kind) {
    const dir = await this.outputDir();
    // Sortable, collision-free, and readable at a glance in a file manager.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `shaurya-${kind}-${stamp}.webm`);
    await fs.writeFile(file, data);
    return { path: file, bytes: data.length, kind, at: Date.now() };
  }

  setReplaySeconds(seconds) {
    const value = Math.max(5, Math.min(300, Number(seconds) || 30));
    this.settings.set('gaming.recorder.replaySeconds', value);
    if (this.bufferArmed) this._evict();
    this.emit('state', this.state());
    return value;
  }

  state() {
    return {
      recording: this.recording,
      bufferArmed: this.bufferArmed,
      elapsedMs: this.recording ? Date.now() - this._startedAt : 0,
      replaySeconds: this.config().replaySeconds,
      bufferedChunks: this._ring.chunks.length,
      bufferedSeconds: this._ring.chunks.length
        ? Math.round((this._ring.chunks[this._ring.chunks.length - 1].at
          - this._ring.chunks[0].at) / 1000)
        : 0,
      hasHeader: Boolean(this._ring.header),
      config: this.config(),
    };
  }

  _send(channel, payload) {
    if (!this.host || this.host.isDestroyed?.()) return;
    this.host.send(channel, payload);
  }

  dispose() {
    this.disarmBuffer();
    this.recording = false;
    this._fullChunks = [];
  }
}

module.exports = { RecorderService, assembleClip, TIMESLICE_MS };
