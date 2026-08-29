/**
 * Teleprompter overlay (spec §5).
 *
 * Scrolling is driven by requestAnimationFrame with a real elapsed-time
 * delta, not by a fixed pixel step per frame. That distinction is the whole
 * difference between a prompter that holds pace and one that drifts: a step
 * per frame runs 2.4× faster on a 144Hz display than on 60Hz, and a
 * presenter who has rehearsed to a script's timing will run out of breath.
 */
const scriptEl = document.getElementById('script');
const playBtn = document.getElementById('play');
const mirrorBtn = document.getElementById('mirror');
const wpmEl = document.getElementById('wpm');

/** Words per minute. The unit a presenter actually thinks in. */
let wpm = 150;
let playing = false;
let offset = 0;          // pixels scrolled
let lastFrame = 0;
let frame = null;

/** Pixels per second implied by the current wpm and font metrics. */
function speed() {
  const lineHeight = parseFloat(getComputedStyle(scriptEl).lineHeight) || 50;
  // Roughly nine words to a line at typical prompter widths; close enough
  // that the wpm readout is meaningful, and the user tunes from there.
  const linesPerMinute = wpm / 9;
  return (linesPerMinute * lineHeight) / 60;
}

function tick(now) {
  if (!playing) return;

  const delta = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;
  offset += speed() * delta;

  scriptEl.style.transform = `translateY(${-offset}px)`;

  // Stop at the end rather than scrolling the text off into nothing, so the
  // presenter can see they have finished.
  const limit = scriptEl.scrollHeight;
  if (offset >= limit) {
    offset = limit;
    setPlaying(false);
    return;
  }
  frame = requestAnimationFrame(tick);
}

function setPlaying(value) {
  playing = value;
  playBtn.textContent = value ? 'Pause' : 'Play';
  playBtn.dataset.on = String(value);

  if (value) {
    lastFrame = 0;
    frame = requestAnimationFrame(tick);
  } else if (frame) {
    cancelAnimationFrame(frame);
    frame = null;
  }
}

function setWpm(value) {
  wpm = Math.max(60, Math.min(400, value));
  wpmEl.textContent = `${wpm} wpm`;
}

function restart() {
  offset = 0;
  scriptEl.style.transform = 'translateY(0)';
}

// ---- controls -------------------------------------------------------------

playBtn.addEventListener('click', () => setPlaying(!playing));
document.getElementById('faster').addEventListener('click', () => setWpm(wpm + 10));
document.getElementById('slower').addEventListener('click', () => setWpm(wpm - 10));
document.getElementById('restart').addEventListener('click', restart);
mirrorBtn.addEventListener('click', () => {
  const next = document.body.dataset.mirrored !== 'true';
  document.body.dataset.mirrored = String(next);
  mirrorBtn.dataset.on = String(next);
});

/**
 * Keyboard, including the foot-pedal case.
 *
 * Most USB presenter pedals emit a spare function key or a page-up/down, so
 * binding those means a pedal works with no driver and no configuration.
 */
window.addEventListener('keydown', (event) => {
  switch (event.key) {
    case ' ':
    case 'F13':          // the key most pedals send
    case 'PageDown':
      event.preventDefault();
      setPlaying(!playing);
      break;
    case 'ArrowUp': setWpm(wpm + 10); break;
    case 'ArrowDown': setWpm(wpm - 10); break;
    case 'Home': restart(); break;
    case 'Escape': window.close(); break;
    default: break;
  }
});

// ---- content --------------------------------------------------------------

window.shauryaPrompter?.onScript((payload) => {
  const text = String(payload?.body || '').trim();
  scriptEl.replaceChildren();
  if (!text) {
    const empty = document.createElement('div');
    empty.id = 'empty';
    empty.textContent = 'No script loaded. Save one from the Creator panel.';
    scriptEl.appendChild(empty);
    return;
  }
  // textContent, not innerHTML: a script is arbitrary user text and this page
  // has no business parsing markup out of it.
  scriptEl.textContent = text;
  restart();

  if (payload.wpm) setWpm(payload.wpm);
  if (payload.fontSize) {
    document.documentElement.style.setProperty('--size', `${payload.fontSize}px`);
  }
  if (payload.mirrored != null) {
    document.body.dataset.mirrored = String(payload.mirrored);
    mirrorBtn.dataset.on = String(payload.mirrored);
  }
  if (payload.opacity != null) {
    document.documentElement.style.setProperty('--opacity', String(payload.opacity));
  }
});

window.shauryaPrompter?.onControl((command) => {
  if (command === 'play') setPlaying(true);
  else if (command === 'pause') setPlaying(false);
  else if (command === 'restart') restart();
});

setWpm(wpm);
