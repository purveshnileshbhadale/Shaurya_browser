/**
 * Overlay renderer.
 *
 * Hosts the three surfaces that must draw *over* page content: the command
 * palette, the screenshot region selector with its annotation tools, and the
 * colour picker's magnifier.
 *
 * The overlay view is attached above the page views only while one of these
 * is open, and detached the moment it closes — an always-present full-window
 * view on top would swallow every click meant for the page.
 */
import { h, icon, clear, $ } from './core/dom.js';
import { invoke, on, send } from './core/store.js';
import { createPalette } from './components/palette.js';

const root = $('#overlay-root');
let palette = null;
let activeSurface = null;

// The main process tells us what to show when it attaches the view.
on('overlay:show', ({ route, payload }) => show(route, payload));

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dismiss();
});

function show(route, payload = {}) {
  clear(root);
  activeSurface = route;
  root.dataset.surface = route;

  if (route === 'palette') return showPalette();
  if (route === 'capture') return showCaptureSelector(payload);
  if (route === 'annotate') return showAnnotator(payload);
  if (route === 'colorpicker') return showColorPicker();
  return null;
}

function dismiss() {
  clear(root);
  activeSurface = null;
  delete root.dataset.surface;
  send('ui.contextMenu', { kind: 'overlay-dismiss' });
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

function showPalette() {
  palette = createPalette({ root, onClose: dismiss });
  palette.open();
}

// ---------------------------------------------------------------------------
// Screenshot region selector
// ---------------------------------------------------------------------------

/**
 * Drag a rectangle over the page.
 *
 * The dimmed backdrop uses a `box-shadow` spread on the selection rather than
 * four separate mask elements — one composited layer instead of four, so the
 * marquee tracks the cursor at full frame rate.
 */
function showCaptureSelector({ mode = 'region' } = {}) {
  const selection = h('div.capture-selection');
  const size = h('div.capture-size');
  const hint = h('div.capture-hint', {}, icon('crop'),
    h('span', { text: 'Drag to select · Esc to cancel' }));

  root.append(h('div.capture-backdrop'), selection, size, hint);

  let start = null;

  root.addEventListener('mousedown', (event) => {
    start = { x: event.clientX, y: event.clientY };
    hint.style.display = 'none';
    update(event);
  });

  root.addEventListener('mousemove', (event) => {
    if (!start) return;
    update(event);
  });

  root.addEventListener('mouseup', async (event) => {
    if (!start) return;
    const rect = rectFrom(start, event);
    start = null;
    if (rect.width < 4 || rect.height < 4) return dismiss();

    const shot = await invoke('capture.region', { rect }).catch(() => null);
    if (shot) show('annotate', shot);
    else dismiss();
  });

  function update(event) {
    const rect = rectFrom(start, event);
    Object.assign(selection.style, {
      display: 'block',
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    Object.assign(size.style, {
      display: 'block',
      left: `${rect.x}px`,
      top: `${Math.max(0, rect.y - 26)}px`,
    });
    size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  }

  function rectFrom(a, event) {
    return {
      x: Math.min(a.x, event.clientX),
      y: Math.min(a.y, event.clientY),
      width: Math.abs(event.clientX - a.x),
      height: Math.abs(event.clientY - a.y),
    };
  }
}

// ---------------------------------------------------------------------------
// Annotation
// ---------------------------------------------------------------------------

/**
 * Mark up a capture before saving it (spec §2).
 *
 * Strokes are kept as a model and re-rendered each frame rather than painted
 * cumulatively, which is what makes undo possible without snapshotting the
 * bitmap on every stroke.
 */
function showAnnotator(shot) {
  const canvas = h('canvas.annotate-canvas');
  const ctx = canvas.getContext('2d');
  const image = new Image();

  let tool = 'pen';
  let color = '#ff3b30';
  let strokes = [];
  let current = null;

  const toolbar = h('div.annotate-toolbar', {},
    ...['pen', 'arrow', 'rect', 'highlight'].map((name) =>
      h('button.icon-btn', {
        class: { 'is-active': name === tool },
        title: name,
        dataset: { tool: name },
        onclick: (event) => {
          tool = name;
          for (const b of toolbar.querySelectorAll('[data-tool]')) {
            b.classList.toggle('is-active', b.dataset.tool === name);
          }
        },
      }, icon(name === 'pen' ? 'code' : name === 'arrow' ? 'forward'
        : name === 'rect' ? 'crop' : 'palette'))),
    h('div.divider'),
    ...['#ff3b30', '#ff9500', '#34c759', '#0a84ff', '#16181d', '#ffffff'].map((swatch) =>
      h('button.annotate-swatch', {
        style: { background: swatch },
        class: { 'is-active': swatch === color },
        onclick: () => {
          color = swatch;
          for (const b of toolbar.querySelectorAll('.annotate-swatch')) {
            b.classList.toggle('is-active', b.style.background === swatch);
          }
        },
      })),
    h('div.divider'),
    h('button.icon-btn', { title: 'Undo', onclick: () => { strokes.pop(); redraw(); } },
      icon('back')),
    h('button.btn', { onclick: dismiss }, 'Cancel'),
    h('button.btn', {
      onclick: async () => {
        await invoke('capture.copy', { dataUrl: canvas.toDataURL('image/png') });
        dismiss();
      },
    }, icon('copy'), ' Copy'),
    h('button.btn.btn-primary', {
      onclick: async () => {
        await invoke('capture.save', {
          dataUrl: canvas.toDataURL('image/png'),
          suggestedName: shot.suggestedName,
        });
        dismiss();
      },
    }, icon('download'), ' Save'));

  root.append(h('div.annotate-backdrop'), h('div.annotate-stage', {}, canvas), toolbar);

  image.onload = () => {
    canvas.width = image.width;
    canvas.height = image.height;
    // Fit the capture into the viewport without upscaling it.
    const scale = Math.min(
      1,
      (window.innerWidth - 80) / image.width,
      (window.innerHeight - 160) / image.height
    );
    canvas.style.width = `${image.width * scale}px`;
    canvas.style.height = `${image.height * scale}px`;
    redraw();
  };
  image.src = shot.dataUrl;

  canvas.addEventListener('mousedown', (event) => {
    current = { tool, color, points: [pointFor(event)] };
  });
  canvas.addEventListener('mousemove', (event) => {
    if (!current) return;
    current.points.push(pointFor(event));
    redraw();
  });
  window.addEventListener('mouseup', () => {
    if (!current) return;
    strokes.push(current);
    current = null;
    redraw();
  });

  function pointFor(event) {
    const rect = canvas.getBoundingClientRect();
    // Map viewport coordinates onto the canvas's real pixel grid.
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    for (const stroke of [...strokes, current].filter(Boolean)) drawStroke(stroke);
  }

  function drawStroke(stroke) {
    const { points } = stroke;
    if (!points.length) return;

    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.tool === 'highlight' ? 18 : 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (stroke.tool === 'highlight') {
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = 'multiply';
    }

    const first = points[0];
    const last = points[points.length - 1];

    if (stroke.tool === 'rect') {
      ctx.strokeRect(first.x, first.y, last.x - first.x, last.y - first.y);
    } else if (stroke.tool === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
      // Arrowhead, rotated to the stroke's direction.
      const angle = Math.atan2(last.y - first.y, last.x - first.x);
      const head = 14;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(last.x - head * Math.cos(angle - Math.PI / 7),
        last.y - head * Math.sin(angle - Math.PI / 7));
      ctx.lineTo(last.x - head * Math.cos(angle + Math.PI / 7),
        last.y - head * Math.sin(angle + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Colour picker
// ---------------------------------------------------------------------------

function showColorPicker() {
  const readout = h('div.picker-readout');
  const hint = h('div.capture-hint', {}, icon('palette'),
    h('span', { text: 'Click to sample · Esc to cancel' }));
  root.append(h('div.picker-crosshair'), readout, hint);

  let last = null;

  root.addEventListener('mousemove', throttle(async (event) => {
    const sample = await invoke('colorpicker.start', {
      x: event.clientX, y: event.clientY,
    }, { quiet: true }).catch(() => null);
    if (!sample) return;
    last = sample;
    Object.assign(readout.style, {
      display: 'flex',
      left: `${event.clientX + 18}px`,
      top: `${event.clientY + 18}px`,
    });
    clear(readout);
    readout.append(
      h('span.picker-swatch', { style: { background: sample.hex } }),
      h('div', {},
        h('div.mono', { text: sample.hex }),
        h('div.dimmer.mono', { text: sample.rgbString })));
  }, 40));

  root.addEventListener('click', async () => {
    if (!last) return dismiss();
    await navigator.clipboard.writeText(last.hex).catch(() => {});
    dismiss();
  });
}

function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}
