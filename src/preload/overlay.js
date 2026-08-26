'use strict';
/**
 * Preload for the always-on-top overlay windows — the hardware HUD (spec §4)
 * and the teleprompter (spec §5).
 *
 * These windows show *our* pages and never web content, but they are still
 * given the narrowest possible bridge: two receive-only channels and nothing
 * that can reach back into the browser. There is no `invoke` here at all.
 * If one of these pages is ever compromised, the worst it can do is render
 * the wrong number.
 */
const { contextBridge, ipcRenderer } = require('electron');

/** Only these channels are relayed, whatever a page asks for. */
const HUD_CHANNELS = ['hud:metrics'];
const PROMPTER_CHANNELS = ['prompter:script', 'prompter:control'];

/**
 * Wrap a listener so the page never receives Electron's `event` object —
 * which carries a `sender` a page has no business holding.
 */
function subscribe(channel, handler) {
  const wrapped = (_event, payload) => {
    try {
      handler(payload);
    } catch (err) {
      // A throwing renderer callback must not take the IPC listener down
      // with it, or the overlay silently stops updating.
      console.error(`[aether] overlay handler for ${channel} failed`, err);
    }
  };
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('aetherHud', {
  onMetrics: (handler) => subscribe(HUD_CHANNELS[0], handler),
});

contextBridge.exposeInMainWorld('aetherPrompter', {
  onScript: (handler) => subscribe(PROMPTER_CHANNELS[0], handler),
  onControl: (handler) => subscribe(PROMPTER_CHANNELS[1], handler),
});
