/**
 * First-run onboarding (spec §9.3).
 *
 * Four steps, each of which does something rather than just describing it:
 * the privacy step states the guarantees the code actually enforces, the AI
 * step makes the user choose where inference runs before anything is sent
 * anywhere, and the developer step turns real features on.
 */

const api = window.aether;

const stage = document.getElementById('stage');
const dots = document.getElementById('dots');
const backBtn = document.getElementById('back');
const nextBtn = document.getElementById('next');

let index = 0;

/** Collected across steps and applied on completion. */
const choices = {
  features: {},
  theme: 'system',
  accent: '#6C8CFF',
  searchEngine: 'duckduckgo',
  // The starting mode. `default` rather than null so a user who skips the
  // question lands somewhere deliberate rather than somewhere accidental.
  mode: 'default',
};

/**
 * What the browser is for, in the user's words (spec §11.3).
 *
 * Wording matters here: these are activities, not product names. Someone
 * arriving does not yet know what "Ghost Mode" is, but they know whether
 * they are here to write code.
 */
const PURPOSES = [
  { mode: 'programmer', icon: 'code', label: 'Write code',
    detail: 'DevTools, a REST client, sockets, containers and a terminal, in a dense monospace chrome.' },
  { mode: 'gamer', icon: 'gamepad', label: 'Game and stream',
    detail: 'Turbo, an FPS overlay, instant-replay clips and an always-on-top stream player.' },
  { mode: 'creator', icon: 'wand', label: 'Make things',
    detail: 'Open-licensed assets, a brand kit, thumbnail A/B and a teleprompter.' },
  { mode: 'student', icon: 'book', label: 'Study',
    detail: 'One-click citations, PDF annotation, a focus timer and AI flashcards.' },
  { mode: 'ghost', icon: 'ghost', label: 'Stay private',
    detail: 'Tor routing, randomised fingerprints, metadata stripping and a panic key.' },
  { mode: 'default', icon: 'globe', label: 'Just browse',
    detail: 'The baseline browser. You can switch to any mode later — nothing is locked in.' },
];

const ICONS = {
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
  shield: 'M12 3l8 3v6c0 4.4-3.4 8.4-8 9-4.6-.6-8-4.6-8-9V6z',
  code: 'M8 6l-5 6 5 6M16 6l5 6-5 6',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  eyeOff: 'M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.2A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.2 6.2A17 17 0 0 0 2 12s3.6 7 10 7c1.2 0 2.3-.2 3.3-.6',
  vpn: 'M12 3l8 3v6c0 4.4-3.4 8.4-8 9-4.6-.6-8-4.6-8-9V6zM9 12l2 2 4-4',
  key: 'M15 7a4 4 0 1 1-3.9 5L7 16l-2 2-2-2 2-2 4-4A4 4 0 0 1 15 7z',
  note: 'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 8h6M9 12h6M9 16h3',
  terminal: 'M4 5h16v14H4zM8 10l2.5 2L8 14M13 14h3',
  split: 'M12 4v16M4 4h16v16H4z',
  command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z',
  check: 'M4 12l5 5L20 6',
  device: 'M7 3h10v18H7zM11 18h2',
  shuffle: 'M4 7h4l8 10h4M4 17h4l2-2.5M16 7h4M18 5l2 2-2 2M18 15l2 2-2 2',
  gamepad: 'M7 12h4M9 10v4M15 11h.01M17.5 13h.01M6.5 7h11a4.5 4.5 0 0 1 4.4 5.4l-.9 4.5A2.6 2.6 0 0 1 16.5 18L15 16H9l-1.5 2a2.6 2.6 0 0 1-4.5-1.1l-.9-4.5A4.5 4.5 0 0 1 6.5 7z',
  wand: 'M4 20L16 8M14 4l1.2 2.8L18 8l-2.8 1.2L14 12l-1.2-2.8L10 8l2.8-1.2zM19 14l.7 1.6L21 16l-1.3.4L19 18l-.7-1.6L17 16l1.3-.4z',
  ghost: 'M5 21V10a7 7 0 0 1 14 0v11l-2.3-2-2.4 2-2.3-2-2.3 2-2.4-2zM9.5 10h.01M14.5 10h.01',
  book: 'M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2zM8 3v18',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z',
};

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const steps = [
  {
    id: 'welcome',
    render: () => step({
      icon: 'sparkle',
      title: 'Welcome to Aether',
      lede: 'A Chromium browser that blocks trackers at the network layer, keeps an '
        + 'assistant beside your tabs, and ships the tools you would otherwise install '
        + 'four extensions for.',
      body: [
        points([
          ['shield', 'Private by default',
            'Ad and tracker blocking is on before you open your first page.'],
          ['sparkle', 'An assistant that reads the page',
            'Summarise, compare tabs, or turn an article into notes.'],
          ['code', 'Built for developers',
            'A REST client, socket inspector and localhost manager in the sidebar.'],
        ]),
        promise(),
      ],
    }),
  },

  {
    id: 'purpose',
    render: () => step({
      icon: 'shuffle',
      title: 'What are you here to do?',
      lede: 'Aether reconfigures itself around the work in front of you. Pick a starting '
        + 'point — the switcher in the sidebar changes it any time, without closing a '
        + 'single tab.',
      body: [purposeGrid()],
    }),
  },

  {
    id: 'privacy',
    render: () => step({
      icon: 'shield',
      title: 'Privacy you can check',
      lede: 'These are enforced in code, not promised in a policy. Every one of them '
        + 'can be inspected in Settings.',
      body: [
        points([
          ['shield', 'Blocking happens before the request',
            'Filter lists are matched in Chromium’s network stack, so a tracker '
            + 'never receives bytes, cookies or a timing signal — not even an empty frame.'],
          ['lock', 'HTTPS-only',
            'Plaintext navigations are upgraded before a socket opens. Failures show an '
            + 'interstitial rather than silently downgrading.'],
          ['eyeOff', 'Fingerprint resistance',
            'High-entropy signals are normalised per origin, so two sites cannot compare '
            + 'notes to identify you.'],
          ['key', 'Passwords stay yours',
            'The vault is AES-256-GCM sealed with a key derived from your master '
            + 'password. The file reveals neither passwords nor which sites you have '
            + 'accounts on.'],
        ]),
        el('p', 'lede', 'Browsing data is never sold or shared with advertisers — on any tier.'),
      ],
    }),
  },

  {
    id: 'ai',
    render: () => step({
      icon: 'sparkle',
      title: 'Choose where the AI runs',
      lede: 'The assistant reads the tab you are on. You decide whether that text stays '
        + 'on this machine or goes to a hosted model. You can change this at any time.',
      body: [
        choiceGroup([
          {
            key: 'aiLocal',
            title: 'On-device model',
            note: 'Page text never leaves this machine. Needs a local runtime such as '
              + 'Ollama; slower on long documents.',
          },
          {
            key: 'ai',
            title: 'Hosted model',
            note: 'Much stronger reasoning for research and comparing tabs. Page text is '
              + 'sent to the provider for that request only.',
            default: true,
          },
          {
            key: 'aiNotes',
            title: 'AI notes',
            note: 'Turn articles, video transcripts and PDFs into structured notes, '
              + 'exportable to Markdown, PDF, Notion or Obsidian.',
            default: true,
          },
        ]),
        el('p', 'lede',
          'Other tabs are off-limits until you grant multi-tab access, and private '
          + 'windows never contribute page content at all.'),
      ],
    }),
  },

  {
    id: 'developer',
    render: () => step({
      icon: 'code',
      title: 'Turn on what you need',
      lede: 'Everything here can be switched off later in the Feature Store, so the '
        + 'browser stays as light as you want it.',
      body: [
        choiceGroup([
          { key: 'devtools', title: 'Developer tools',
            note: 'Chrome DevTools plus the REST client, socket inspector and localhost manager.',
            default: true },
          { key: 'splitView', title: 'Split screen',
            note: 'Two tabs side by side with a draggable divider.', default: true },
          { key: 'vpn', title: 'Aether VPN',
            note: 'WireGuard tunnel with a kill switch. Free tier is bandwidth-capped.',
            default: false },
          { key: 'sync', title: 'Encrypted sync',
            note: 'End-to-end encrypted across desktop and Android. The server stores '
              + 'blobs it cannot read.', default: false },
        ]),
        appearance(),
      ],
    }),
  },
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function step({ icon: iconName, title, lede, body }) {
  const wrap = el('div', 'ob-step');
  const mark = el('div', 'ob-mark');
  mark.appendChild(svg(ICONS[iconName]));
  wrap.append(mark, el('h1', '', title), el('p', 'lede', lede), ...body);
  return wrap;
}

/**
 * The purpose picker.
 *
 * Single-select rather than multi: a starting mode is one thing, and offering
 * "both" here would produce a mode nobody asked for. The copy says the
 * switcher changes it later, which is the honest reassurance — this is a
 * starting point, not a commitment.
 */
function purposeGrid() {
  const wrap = el('div', 'ob-purposes');

  const render = () => {
    wrap.replaceChildren();
    for (const purpose of PURPOSES) {
      const card = el('button',
        `ob-purpose${choices.mode === purpose.mode ? ' is-on' : ''}`);
      const badge = el('div', 'ob-purpose-icon');
      badge.appendChild(svg(ICONS[purpose.icon] || ICONS.sparkle));
      const copy = el('div');
      copy.append(el('h3', '', purpose.label), el('p', '', purpose.detail));
      card.append(badge, copy);
      card.addEventListener('click', () => {
        choices.mode = purpose.mode;
        render();
      });
      wrap.appendChild(card);
    }
  };

  render();
  return wrap;
}

function points(items) {
  const wrap = el('div', 'ob-points');
  for (const [iconName, title, text] of items) {
    const row = el('div', 'ob-point');
    const badge = el('div', 'ob-point-icon');
    badge.appendChild(svg(ICONS[iconName]));
    const copy = el('div');
    copy.append(el('h3', '', title), el('p', '', text));
    row.append(badge, copy);
    wrap.appendChild(row);
  }
  return wrap;
}

function promise() {
  const box = el('div', 'ob-promise');
  const heading = el('h3');
  heading.appendChild(svg(ICONS.check));
  heading.append(document.createTextNode('Free forever, and not paid for with your data'));
  box.append(heading, el('p', '',
    'The browser, ad blocking, and a fair-use tier of VPN, AI and notes are free. Pro '
    + 'removes the usage caps. Your browsing is never sold or shared with advertisers '
    + 'at any tier.'));
  return box;
}

function choiceGroup(options) {
  const wrap = el('div', 'ob-choices');
  for (const option of options) {
    if (choices.features[option.key] === undefined) {
      choices.features[option.key] = Boolean(option.default);
    }
    const button = el('button', `ob-choice${choices.features[option.key] ? ' is-on' : ''}`);
    const text = el('div', 'ob-choice-text');
    text.append(el('h4', '', option.title), el('p', '', option.note));

    const toggle = el('span', 'switch');
    toggle.setAttribute('aria-checked', String(choices.features[option.key]));

    button.append(text, toggle);
    button.addEventListener('click', () => {
      const next = !choices.features[option.key];
      choices.features[option.key] = next;
      button.classList.toggle('is-on', next);
      toggle.setAttribute('aria-checked', String(next));
    });
    wrap.appendChild(button);
  }
  return wrap;
}

function appearance() {
  const wrap = el('div');
  wrap.appendChild(el('h3', '', 'Accent colour'));
  const row = el('div', 'ob-swatches');
  for (const color of ['#6C8CFF', '#4CC9A7', '#F7A072', '#C77DFF', '#FF6B8A', '#5BC0EB', '#F5D547']) {
    const swatch = el('button', `ob-swatch${color === choices.accent ? ' is-on' : ''}`);
    swatch.style.background = color;
    swatch.addEventListener('click', () => {
      choices.accent = color;
      document.documentElement.style.setProperty('--accent', color);
      for (const other of row.children) other.classList.remove('is-on');
      swatch.classList.add('is-on');
    });
    row.appendChild(swatch);
  }
  wrap.appendChild(row);
  return wrap;
}

function render() {
  stage.replaceChildren(steps[index].render());

  dots.replaceChildren();
  for (const [i] of steps.entries()) {
    const dot = el('div', `ob-dot${i === index ? ' is-active' : i < index ? ' is-done' : ''}`);
    dots.appendChild(dot);
  }

  backBtn.hidden = index === 0;
  nextBtn.textContent = index === steps.length - 1 ? 'Start browsing' : 'Continue';
  stage.scrollTop = 0;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

backBtn.addEventListener('click', () => {
  index = Math.max(0, index - 1);
  render();
});

nextBtn.addEventListener('click', async () => {
  if (index < steps.length - 1) {
    index++;
    render();
    return;
  }
  await finish();
});

document.getElementById('skip').addEventListener('click', finish);

window.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight' || event.key === 'Enter') nextBtn.click();
  if (event.key === 'ArrowLeft') backBtn.click();
});

async function finish() {
  nextBtn.disabled = true;
  try {
    await api.invoke('onboarding.complete', { choices });
  } catch (err) {
    console.error('could not save onboarding choices', err);
  }
  await api.invoke('tabs.navigate', { url: 'aether://start' });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Build a stroke icon; presentation set on the element, not inherited. */
function svg(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const node = document.createElementNS(ns, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.7');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  for (const segment of d.split('M').filter(Boolean)) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M' + segment);
    node.appendChild(path);
  }
  return node;
}

render();
