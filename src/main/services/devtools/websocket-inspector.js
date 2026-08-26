'use strict';
/**
 * WebSocket inspector (spec §5).
 *
 * Two capabilities, deliberately kept distinct:
 *
 *  1. **Observe** sockets the *page* opens. Chromium surfaces these through
 *     the DevTools protocol, so we attach a debugger to the tab and mirror
 *     the frames into the panel. This is the read-only view of live traffic.
 *
 *  2. **Connect** to a socket ourselves, to poke at a server directly. This
 *     is a client, implemented against RFC 6455 on a raw socket so the
 *     project keeps zero runtime dependencies for it.
 */
const EventEmitter = require('node:events');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { uid } = require('../../util/id');
const { createLogger } = require('../../util/logger');

const log = createLogger('ws');

/** Keep memory bounded on a chatty socket. */
const MAX_FRAMES = 2000;

class WebSocketInspector extends EventEmitter {
  constructor(features) {
    super();
    this.features = features;
    /** socketId -> { url, frames, state, socket?, tabId? } */
    this.sockets = new Map();
    /** webContentsId -> attached */
    this._attached = new Set();
  }

  _check() {
    if (!this.features.enabled('wsInspector')) {
      throw new Error('The WebSocket inspector is turned off in the Feature Store');
    }
  }

  // ---- observing page sockets -----------------------------------------

  /**
   * Attach to a tab and mirror the WebSocket traffic its page creates.
   *
   * Uses the Chrome DevTools Protocol `Network` domain, which is the only
   * way to see frames a page sends without injecting into the page (which
   * a page could detect and evade).
   */
  observe(tab) {
    this._check();
    const wc = tab?.webContents;
    if (!wc) throw new Error('no page to observe');
    if (this._attached.has(wc.id)) return { observing: true, already: true };

    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    } catch (err) {
      throw new Error(`could not attach the inspector: ${err.message}`);
    }
    this._attached.add(wc.id);

    wc.debugger.on('message', (_event, method, params) => {
      switch (method) {
        case 'Network.webSocketCreated':
          this._record(params.requestId, {
            url: params.url, tabId: tab.id, state: 'connecting', origin: 'page',
          });
          break;
        case 'Network.webSocketHandshakeResponseReceived':
          this._update(params.requestId, { state: 'open', status: params.response?.status });
          break;
        case 'Network.webSocketFrameSent':
          this._frame(params.requestId, 'sent', params.response);
          break;
        case 'Network.webSocketFrameReceived':
          this._frame(params.requestId, 'received', params.response);
          break;
        case 'Network.webSocketFrameError':
          this._update(params.requestId, { state: 'error', error: params.errorMessage });
          break;
        case 'Network.webSocketClosed':
          this._update(params.requestId, { state: 'closed' });
          break;
        default:
          break;
      }
    });

    wc.debugger.sendCommand('Network.enable').catch((err) =>
      log.warn(`Network.enable failed: ${err.message}`));

    wc.once('destroyed', () => this._attached.delete(wc.id));
    log.info(`observing WebSocket traffic in tab ${tab.id}`);
    return { observing: true };
  }

  stopObserving(tab) {
    const wc = tab?.webContents;
    if (!wc || !this._attached.has(wc.id)) return false;
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach();
    } catch { /* already gone */ }
    this._attached.delete(wc.id);
    return true;
  }

  _record(id, data) {
    this.sockets.set(id, { id, frames: [], opened: Date.now(), ...data });
    this.emit('status', this.list());
  }

  _update(id, patch) {
    const entry = this.sockets.get(id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.emit('status', this.list());
  }

  _frame(id, direction, response) {
    const entry = this.sockets.get(id);
    if (!entry) return;
    const frame = {
      id: uid('f_'),
      direction,
      // opcode 1 = text, 2 = binary, 8 = close, 9/10 = ping/pong
      opcode: response?.opcode ?? 1,
      text: response?.payloadData ?? '',
      length: (response?.payloadData || '').length,
      at: Date.now(),
    };
    entry.frames.push(frame);
    if (entry.frames.length > MAX_FRAMES) entry.frames.splice(0, entry.frames.length - MAX_FRAMES);
    this.emit('frame', { socketId: id, frame });
  }

  // ---- our own client --------------------------------------------------

  /**
   * Open a socket from the browser itself.
   * @param {{url:string, protocols?:string[], headers?:object}} opts
   */
  connect({ url, protocols = [], headers = {} }) {
    this._check();
    const id = uid('ws_');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`"${url}" is not a valid WebSocket URL`);
    }
    if (!/^wss?:$/.test(parsed.protocol)) {
      throw new Error('the URL must start with ws:// or wss://');
    }

    // RFC 6455 handshake: a random 16-byte key, base64-encoded. The server
    // must echo back its SHA-1 with the magic GUID, which we verify.
    const key = crypto.randomBytes(16).toString('base64');
    const isSecure = parsed.protocol === 'wss:';
    const mod = isSecure ? https : http;

    this._record(id, { url, state: 'connecting', origin: 'inspector' });

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (isSecure ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...(protocols.length ? { 'Sec-WebSocket-Protocol': protocols.join(', ') } : {}),
        Origin: parsed.origin,
      },
    });

    req.on('upgrade', (res, socket) => {
      const expected = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        this._update(id, { state: 'error', error: 'handshake verification failed' });
        return;
      }

      const entry = this.sockets.get(id);
      entry.socket = socket;
      entry.protocol = res.headers['sec-websocket-protocol'] || null;
      this._update(id, { state: 'open', status: res.statusCode });

      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        // A TCP read can contain several frames, or half of one.
        for (;;) {
          const parsedFrame = decodeFrame(buffer);
          if (!parsedFrame) break;
          buffer = buffer.subarray(parsedFrame.consumed);

          if (parsedFrame.opcode === 0x8) {           // close
            this._update(id, { state: 'closed' });
            socket.end();
            return;
          }
          if (parsedFrame.opcode === 0x9) {           // ping -> pong
            socket.write(encodeFrame(parsedFrame.payload, 0xa));
            continue;
          }
          if (parsedFrame.opcode === 0xa) continue;   // pong

          this._frame(id, 'received', {
            opcode: parsedFrame.opcode,
            payloadData: parsedFrame.opcode === 0x2
              ? parsedFrame.payload.toString('base64')
              : parsedFrame.payload.toString('utf8'),
          });
        }
      });

      socket.on('close', () => this._update(id, { state: 'closed' }));
      socket.on('error', (err) => this._update(id, { state: 'error', error: err.message }));
    });

    req.on('response', (res) => {
      // The server answered with a normal HTTP response: no upgrade.
      this._update(id, {
        state: 'error',
        error: `server refused the upgrade (HTTP ${res.statusCode})`,
      });
      res.resume();
    });
    req.on('error', (err) => this._update(id, { state: 'error', error: err.message }));
    req.end();

    return { socketId: id };
  }

  /** Send a text frame on a socket we opened. */
  send({ socketId, text }) {
    const entry = this.sockets.get(socketId);
    if (!entry?.socket) throw new Error('that socket is not one the inspector opened');
    if (entry.state !== 'open') throw new Error('socket is not open');
    entry.socket.write(encodeFrame(Buffer.from(text, 'utf8'), 0x1));
    this._frame(socketId, 'sent', { opcode: 1, payloadData: text });
    return true;
  }

  disconnect(socketId) {
    const entry = this.sockets.get(socketId);
    if (!entry) return false;
    if (entry.socket) {
      try {
        entry.socket.write(encodeFrame(Buffer.alloc(0), 0x8));
        entry.socket.end();
      } catch { /* already gone */ }
    }
    this._update(socketId, { state: 'closed' });
    return true;
  }

  disconnectAll() {
    for (const id of this.sockets.keys()) this.disconnect(id);
    this.sockets.clear();
  }

  list() {
    return [...this.sockets.values()].map(({ socket, frames, ...rest }) => ({
      ...rest,
      frameCount: frames.length,
      lastFrameAt: frames.length ? frames[frames.length - 1].at : null,
    }));
  }

  frames(socketId, { since = 0, limit = 500 } = {}) {
    const entry = this.sockets.get(socketId);
    if (!entry) return [];
    return entry.frames.filter((f) => f.at >= since).slice(-limit);
  }
}

// ---------------------------------------------------------------------------
// RFC 6455 framing
// ---------------------------------------------------------------------------

/**
 * Decode one frame from the head of `buffer`.
 * Returns null when the buffer does not yet hold a complete frame.
 */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const opcode = firstByte & 0x0f;
  const masked = Boolean(secondByte & 0x80);
  let length = secondByte & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('frame too large');
    length = Number(big);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }

  return { opcode, payload, consumed: offset + length };
}

/**
 * Encode a client frame. Client-to-server frames **must** be masked, and a
 * server will close the connection if they are not.
 */
function encodeFrame(payload, opcode = 0x1) {
  const length = payload.length;
  const mask = crypto.randomBytes(4);

  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode

  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];

  return Buffer.concat([header, mask, masked]);
}

module.exports = { WebSocketInspector, encodeFrame, decodeFrame };
