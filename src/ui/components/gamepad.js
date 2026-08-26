/**
 * Gamepad navigation and remapping (spec §4).
 *
 * The Gamepad API has no events for button presses — only a snapshot you
 * poll — so this runs a `requestAnimationFrame` loop while a pad is
 * connected, and stops entirely when none is. A browser that polled for
 * controllers nobody owns would be burning a frame callback forever.
 *
 * Two behaviours worth calling out because they are what separate usable
 * controller navigation from a novelty:
 *
 * - **Buttons repeat on hold, sticks are continuous.** A d-pad press that
 *   fires once is maddening for list navigation, and a stick that fires
 *   discrete events is useless for scrolling. They are handled differently.
 * - **Sticks have a dead zone and a response curve.** Every analogue stick
 *   rests slightly off-centre, and a linear mapping makes fine control
 *   impossible. Cubed response gives precision near the centre and speed at
 *   the edge — the curve every game uses, for the same reason.
 */
import { state, subscribe, invoke, selectors } from '../core/store.js';

/** Below this, a stick is considered at rest. Covers worn-in hardware. */
const DEAD_ZONE = 0.18;
/** Delay before a held button starts repeating, then the repeat interval. */
const REPEAT_DELAY_MS = 420;
const REPEAT_RATE_MS = 90;
/** Maximum scroll speed at full stick deflection, in pixels per second. */
const SCROLL_MAX = 1400;

export function createGamepadNavigation({ onCommand }) {
  let frame = null;
  let connected = 0;
  let lastFrameTime = 0;

  /** index -> { pressedAt, lastRepeat } for buttons currently held. */
  const held = new Map();

  window.addEventListener('gamepadconnected', () => { connected += 1; sync(); });
  window.addEventListener('gamepaddisconnected', () => {
    connected = Math.max(0, connected - 1);
    held.clear();
    sync();
  });

  // The feature can be switched off mid-session, and a mode change is the
  // usual way that happens.
  subscribe('modes', sync);
  subscribe('features', sync);
  sync();

  function enabled() {
    return selectors.feature('gamepadNav') && connected > 0;
  }

  function sync() {
    if (enabled() && !frame) {
      lastFrameTime = performance.now();
      frame = requestAnimationFrame(poll);
    } else if (!enabled() && frame) {
      cancelAnimationFrame(frame);
      frame = null;
      held.clear();
    }
  }

  function bindings() {
    return state.gamepad?.bindings || DEFAULT_BINDINGS;
  }

  function poll(now) {
    if (!enabled()) { frame = null; return; }

    const delta = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    const pads = navigator.getGamepads?.() || [];
    const map = bindings();

    for (const pad of pads) {
      if (!pad) continue;

      // ---- buttons ----
      pad.buttons.forEach((button, index) => {
        const key = `button${index}`;
        const command = map[key];
        if (!command || command === 'none') return;

        if (!button.pressed) { held.delete(index); return; }

        const record = held.get(index);
        if (!record) {
          // Fire immediately on press, then wait out the repeat delay.
          held.set(index, { pressedAt: now, lastRepeat: now });
          run(command);
          return;
        }
        // Only navigation commands repeat. Auto-repeating "close tab" would
        // shut a window because someone rested a thumb.
        if (!REPEATABLE.has(command)) return;
        if (now - record.pressedAt < REPEAT_DELAY_MS) return;
        if (now - record.lastRepeat < REPEAT_RATE_MS) return;
        record.lastRepeat = now;
        run(command);
      });

      // ---- axes ----
      pad.axes.forEach((raw, index) => {
        const command = map[`axis${index}`];
        if (!command || command === 'none') return;

        const value = curve(raw);
        if (value === 0) return;

        if (command === 'scroll') {
          // Continuous, frame-rate independent: the same stick deflection
          // scrolls the same distance per second on 60Hz and 144Hz.
          invoke('tabs.scrollBy', { dy: value * SCROLL_MAX * delta }, { quiet: true })
            .catch(() => scrollFallback(value * SCROLL_MAX * delta));
        }
      });
    }

    frame = requestAnimationFrame(poll);
  }

  function run(command) {
    onCommand?.(command);
  }

  /** If the main process has no scroll channel, scroll the chrome instead. */
  function scrollFallback(dy) {
    const scroller = document.querySelector('#sidebar-tabs');
    if (scroller) scroller.scrollTop += dy;
  }

  return {
    get active() { return Boolean(frame); },
    get pads() { return connected; },
    stop() { if (frame) { cancelAnimationFrame(frame); frame = null; } },
  };
}

/**
 * Apply the dead zone and response curve.
 *
 * Rescaling after the dead zone matters: without it, the stick jumps from
 * nothing to 18% the instant it crosses the threshold.
 */
function curve(raw) {
  const magnitude = Math.abs(raw);
  if (magnitude < DEAD_ZONE) return 0;
  const rescaled = (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE);
  return Math.sign(raw) * (rescaled ** 3);
}

/** Commands that make sense to auto-repeat while a button is held. */
const REPEATABLE = new Set([
  'scrollUp', 'scrollDown', 'focusNext', 'focusPrev', 'tabNext', 'tabPrev',
  'zoomIn', 'zoomOut',
]);

/**
 * The default map, in W3C Standard Gamepad indices — the same layout on an
 * Xbox pad, a DualSense and a Switch Pro controller, so one default fits all
 * three without detection.
 */
export const DEFAULT_BINDINGS = {
  button0: 'activate',
  button1: 'back',
  button2: 'palette',
  button3: 'reload',
  button4: 'tabPrev',
  button5: 'tabNext',
  button6: 'zoomOut',
  button7: 'zoomIn',
  button8: 'closeTab',
  button9: 'newTab',
  button12: 'scrollUp',
  button13: 'scrollDown',
  button14: 'focusPrev',
  button15: 'focusNext',
  axis1: 'scroll',
};
