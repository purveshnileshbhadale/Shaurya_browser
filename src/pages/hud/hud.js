/**
 * Hardware overlay renderer (spec §4).
 *
 * Receives samples from the performance service through the overlay preload
 * and paints them. Deliberately dumb: no polling, no state beyond the last
 * sample, no requestAnimationFrame loop. The window is always on top of
 * whatever the user is actually doing, so every cycle it spends is a cycle
 * taken from the thing it is measuring.
 */
const root = document.getElementById('hud');

/**
 * Which metrics to show and how to render each.
 *
 * `level` returns a threshold band rather than a colour, so the palette
 * lives in CSS and this stays about the numbers.
 */
const METRICS = {
  cpu: {
    label: 'CPU',
    read: (m) => m.system?.cpu,
    format: (v) => `${v.toFixed(0)}%`,
    fraction: (v, m) => Math.min(1, v / (100 * (m.system?.cpuCores || 1))),
    level: (v, m) => {
      const cores = m.system?.cpuCores || 1;
      const share = v / (100 * cores);
      return share > 0.7 ? 'bad' : share > 0.4 ? 'warn' : null;
    },
  },
  ram: {
    label: 'RAM',
    read: (m) => m.system?.memoryBytes,
    format: (v) => `${(v / 1024 / 1024 / 1024).toFixed(1)} GB`,
    fraction: (v, m) => {
      const total = m.system?.systemMemory?.totalBytes;
      return total ? Math.min(1, v / total) : 0;
    },
    level: (v, m) => {
      const total = m.system?.systemMemory?.totalBytes;
      if (!total) return null;
      const share = v / total;
      return share > 0.6 ? 'bad' : share > 0.35 ? 'warn' : null;
    },
  },
  gpu: {
    // Labelled "GPU proc" rather than "GPU" on purpose: this is the GPU
    // process's own load, which is the only GPU figure available without a
    // platform-specific driver hook. Calling it "GPU" would imply adapter
    // utilisation we cannot measure.
    label: 'GPU proc',
    read: (m) => m.system?.gpuProcessCpu,
    format: (v) => `${v.toFixed(0)}%`,
    fraction: (v) => Math.min(1, v / 100),
    level: (v) => (v > 70 ? 'warn' : null),
  },
  fps: {
    label: 'FPS',
    read: (m) => {
      // The foreground tab's frame rate; a hibernated or idle tab reports
      // nothing rather than zero, and nothing is what should be shown.
      const reporting = (m.tabs || []).filter((t) => t.fps != null);
      if (!reporting.length) return null;
      return Math.max(...reporting.map((t) => t.fps));
    },
    format: (v) => String(Math.round(v)),
    fraction: (v) => Math.min(1, v / 144),
    level: (v) => (v >= 55 ? 'good' : v >= 30 ? 'warn' : 'bad'),
  },
  tabs: {
    label: 'Tabs',
    read: (m) => (m.tabs || []).filter((t) => !t.hibernated).length,
    format: (v) => String(v),
    fraction: () => 0,
    level: () => null,
  },
};

let lastKeys = '';

window.shauryaHud?.onMetrics((metrics) => {
  const show = metrics.show?.length ? metrics.show : ['cpu', 'ram', 'fps'];

  if (metrics.opacity != null) {
    document.documentElement.style.setProperty('--opacity', String(metrics.opacity));
  }

  // Rebuild only when the *set* of rows changes; otherwise patch in place, so
  // a sample every second does not churn the DOM.
  const keys = show.join(',');
  if (keys !== lastKeys) {
    lastKeys = keys;
    root.replaceChildren();
    for (const id of show) {
      const spec = METRICS[id];
      if (!spec) continue;
      root.appendChild(buildRow(id, spec.label));
    }
  }

  for (const id of show) {
    const spec = METRICS[id];
    if (!spec) continue;
    const value = spec.read(metrics);
    const row = root.querySelector(`[data-metric="${id}"]`);
    if (!row) continue;

    const valueEl = row.querySelector('.value');
    const fill = row.querySelector('.bar > i');

    if (value == null || Number.isNaN(value)) {
      valueEl.textContent = '—';
      valueEl.removeAttribute('data-level');
      if (fill) fill.style.width = '0';
      continue;
    }

    valueEl.textContent = spec.format(value);
    const level = spec.level(value, metrics);
    if (level) valueEl.dataset.level = level;
    else valueEl.removeAttribute('data-level');

    if (fill) {
      fill.style.width = `${Math.round(spec.fraction(value, metrics) * 100)}%`;
      fill.parentElement.style.color = valueEl.dataset.level === 'bad' ? '#f87171'
        : valueEl.dataset.level === 'warn' ? '#fbbf24' : '#4ade80';
    }
  }
});

function buildRow(id, label) {
  const wrap = document.createElement('div');
  wrap.dataset.metric = id;

  const row = document.createElement('div');
  row.className = 'row';

  const labelEl = document.createElement('span');
  labelEl.className = 'label';
  labelEl.textContent = label;

  const valueEl = document.createElement('span');
  valueEl.className = 'value';
  valueEl.textContent = '—';

  row.append(labelEl, valueEl);
  wrap.appendChild(row);

  // The tab count has no meaningful scale, so it gets no bar.
  if (id !== 'tabs') {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.appendChild(document.createElement('i'));
    wrap.appendChild(bar);
  }

  return wrap;
}
