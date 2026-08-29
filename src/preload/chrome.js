'use strict';
/**
 * Preload for the browser chrome (and the overlay).
 *
 * This is the only bridge between the privileged main process and the UI
 * renderer. It exposes a deliberately narrow surface: two multiplexed
 * channels plus an event subscription. The renderer never sees `ipcRenderer`,
 * `require`, or any Node primitive, so a markup-injection bug in the chrome
 * cannot escalate into main-process code execution.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { INVOKE, SEND, EVENTS } = require('../main/ipc/channels');

/** Channel allowlists, frozen so page script cannot extend them. */
const INVOKE_SET = new Set(INVOKE);
const SEND_SET = new Set(SEND);
const EVENT_SET = new Set(EVENTS);

/** event name -> Set<callback> */
const listeners = new Map();

ipcRenderer.on('shaurya:event', (_event, channel, payload) => {
  const set = listeners.get(channel);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(payload);
    } catch (err) {
      // A throwing listener must not stop the others from running.
      console.error(`[shaurya] listener for ${channel} failed:`, err);
    }
  }
});

const api = {
  /**
   * Call a main-process handler.
   * @param {string} channel  must be declared in ipc/channels.js
   * @param {any} [payload]
   * @returns {Promise<any>} resolves with the result, or rejects with the
   *          handler's error message (main-process stacks never cross over)
   */
  async invoke(channel, payload) {
    if (!INVOKE_SET.has(channel)) {
      throw new Error(`shaurya: "${channel}" is not an invokable channel`);
    }
    const result = await ipcRenderer.invoke('shaurya:invoke', channel, payload);
    if (result && typeof result === 'object' && '__error' in result) {
      throw new Error(result.__error);
    }
    return result;
  },

  /** Fire-and-forget message to the main process. */
  send(channel, payload) {
    if (!SEND_SET.has(channel)) {
      throw new Error(`shaurya: "${channel}" is not a sendable channel`);
    }
    ipcRenderer.send('shaurya:send', channel, payload);
  },

  /**
   * Subscribe to a push event.
   * @returns {() => void} unsubscribe
   */
  on(channel, callback) {
    if (!EVENT_SET.has(channel)) {
      throw new Error(`shaurya: "${channel}" is not a known event`);
    }
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(callback);
    return () => set.delete(callback);
  },

  /** One-shot subscription. */
  once(channel, callback) {
    const off = api.on(channel, (payload) => {
      off();
      callback(payload);
    });
    return off;
  },

  /** Static environment facts the UI needs at first paint. */
  env: Object.freeze({
    platform: process.platform,
    arch: process.arch,
    chromium: process.versions.chrome,
    node: process.versions.node,
    // Parsed from the query string the window put on the chrome URL.
    ...Object.fromEntries(new URLSearchParams(location.search).entries()),
  }),

  /**
   * Real filesystem path for a dropped File. Needed by the extension loader
   * and the local-server manager, which take a folder the user drags in.
   */
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  /** Channel catalogues, so UI code can assert against typos at startup. */
  channels: Object.freeze({ invoke: INVOKE, send: SEND, events: EVENTS }),
};

contextBridge.exposeInMainWorld('shaurya', Object.freeze(api));
