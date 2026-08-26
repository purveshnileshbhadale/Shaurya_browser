/**
 * Settings, including the Feature Store (spec §7).
 *
 * Every section reads live state from the main process and writes back
 * immediately — there is no Save button, because a settings screen that can
 * be left in an unsaved state is a settings screen that lies to you.
 */

const api = window.aether;

const nav = document.getElementById('nav');
const content = document.getElementById('content');
const filter = document.getElementById('filter');

let settings = {};
let features = [];
let footprint = null;
let modes = null;

const SECTIONS = [
  { id: 'modes', label: 'Modes', icon: 'shuffle', render: renderModes },
  { id: 'features', label: 'Feature Store', icon: 'layers', render: renderFeatureStore },
  { id: 'appearance', label: 'Appearance', icon: 'palette', render: renderAppearance },
  { id: 'startPage', label: 'Start page', icon: 'home', render: renderStartPage },
  { id: 'search', label: 'Search', icon: 'search', render: renderSearch },
  { id: 'privacy', label: 'Privacy & security', icon: 'shield', render: renderPrivacy },
  { id: 'vpn', label: 'VPN', icon: 'vpn', render: renderVpn },
  { id: 'passwords', label: 'Passwords', icon: 'key', render: renderPasswords },
  { id: 'ai', label: 'AI assistant', icon: 'sparkle', render: renderAi },
  { id: 'tabs', label: 'Tabs', icon: 'tab', render: renderTabs },
  { id: 'devtools', label: 'Developer', icon: 'code', render: renderDeveloper },
  { id: 'profiles', label: 'Profiles', icon: 'users', render: renderProfiles },
  { id: 'extensions', label: 'Extensions', icon: 'puzzle', render: renderExtensions },
  { id: 'sync', label: 'Sync', icon: 'sync', render: renderSync },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'command', render: renderShortcuts },
  { id: 'about', label: 'About', icon: 'info', render: renderAbout },
];

const ICONS = {
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  palette: 'M12 21a9 9 0 1 1 9-9c0 2-1.6 3-3 3h-1.5a2 2 0 0 0-1.3 3.5A2 2 0 0 1 12 21z',
  home: 'M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3',
  shield: 'M12 3l8 3v6c0 4.4-3.4 8.4-8 9-4.6-.6-8-4.6-8-9V6z',
  vpn: 'M12 3l8 3v6c0 4.4-3.4 8.4-8 9-4.6-.6-8-4.6-8-9V6zM9 12l2 2 4-4',
  key: 'M15 7a4 4 0 1 1-3.9 5L7 16l-2 2-2-2 2-2 4-4A4 4 0 0 1 15 7z',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
  tab: 'M4 6h6l2 2h8v10H4z',
  code: 'M8 6l-5 6 5 6M16 6l5 6-5 6',
  users: 'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 5a4 4 0 0 1 0 8M22 21a6 6 0 0 0-4-5.6',
  puzzle: 'M11 3h2a2 2 0 0 1 2 2v1h1a2 2 0 0 1 2 2v2h1a2 2 0 1 1 0 4h-1v3a2 2 0 0 1-2 2h-3v-1a2 2 0 1 0-4 0v1H6a2 2 0 0 1-2-2v-3H3a2 2 0 1 1 0-4h1V8a2 2 0 0 1 2-2h1V5a2 2 0 0 1 2-2z',
  sync: 'M4 12a8 8 0 0 1 13.7-5.7L21 9M21 4v5h-5M20 12a8 8 0 0 1-13.7 5.7L3 15M3 20v-5h5',
  command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  shuffle: 'M4 7h4l8 10h4M4 17h4l2-2.5M16 7h4M18 5l2 2-2 2M18 15l2 2-2 2',
};

let active = 'features';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function start() {
  await reload();
  applyTheme();
  renderNav();

  // `aether://settings/#privacy` deep-links to a section, which is what the
  // command palette uses to jump straight to a setting.
  const hash = location.hash.replace('#', '');
  if (hash && SECTIONS.some((s) => s.id === hash)) active = hash;

  await renderSection();

  filter.addEventListener('input', () => applyFilter(filter.value.trim().toLowerCase()));
  window.addEventListener('hashchange', () => {
    const next = location.hash.replace('#', '');
    if (SECTIONS.some((s) => s.id === next)) {
      active = next;
      renderNav();
      renderSection();
    }
  });
}());

async function reload() {
  settings = await api.invoke('settings.get', {});
  const store = await api.invoke('features.list', {});
  features = store.features;
  footprint = store.footprint;
  modes = await api.invoke('modes.list', {});
}

function applyTheme() {
  const root = document.documentElement;
  const appearance = settings.appearance || {};
  if (appearance.theme && appearance.theme !== 'system') root.dataset.theme = appearance.theme;
  else delete root.dataset.theme;
  if (appearance.accent) root.style.setProperty('--accent', appearance.accent);
}

function renderNav() {
  nav.replaceChildren(el('h1', '', 'Settings'));
  for (const section of SECTIONS) {
    const button = el('button', `nav-item${section.id === active ? ' is-active' : ''}`);
    button.appendChild(svg(ICONS[section.icon]));
    button.append(el('span', '', section.label));
    button.addEventListener('click', () => {
      active = section.id;
      location.hash = section.id;
      renderNav();
      renderSection();
    });
    nav.appendChild(button);
  }
}

async function renderSection() {
  content.replaceChildren();
  const section = SECTIONS.find((s) => s.id === active);
  content.appendChild(await section.render());
}

/** Live filter across every section, so search finds settings by name. */
function applyFilter(query) {
  if (!query) {
    for (const row of content.querySelectorAll('.row, .feature')) row.style.display = '';
    return;
  }
  for (const row of content.querySelectorAll('.row, .feature')) {
    row.style.display = row.textContent.toLowerCase().includes(query) ? '' : 'none';
  }
}

// ---------------------------------------------------------------------------
// Modes and the custom-mode builder (spec §8)
// ---------------------------------------------------------------------------

async function renderModes() {
  const section = el('section');
  section.append(
    el('h2', '', 'Modes'),
    el('p', 'section-note',
      'A mode decides which features are on, which panels the sidebar offers, and how '
      + 'the browser looks. Switching one never changes your saved preferences — it '
      + 'lays a set of choices over them, so switching back restores exactly what you had.')
  );

  // ---- the modes themselves ----
  const list = el('div', 'mode-cards');
  for (const mode of modes.modes) {
    const card = el('div', `mode-card${mode.active ? ' is-active' : ''}`);
    if (mode.accent) card.style.setProperty('--card-accent', mode.accent);

    const head = el('div', 'mode-card-head');
    head.append(
      el('span', 'mode-card-name', mode.name),
      el('span', 'mode-card-kind', mode.builtin ? 'built-in' : 'custom')
    );
    card.append(head, el('p', 'mode-card-tagline', mode.tagline || ''));

    const actions = el('div', 'mode-card-actions');

    if (!mode.active) {
      const use = el('button', 'btn small', 'Use');
      use.addEventListener('click', async () => {
        await api.invoke('modes.activate', { id: mode.id });
        await reload();
        renderSection();
      });
      actions.appendChild(use);
    } else {
      actions.appendChild(el('span', 'mode-card-current', 'Active'));
    }

    // Copying a built-in is how you customise one: the presets stay pristine,
    // and the copy is fully independent so a future change to the built-in
    // cannot rewrite someone's saved mode underneath them.
    const copy = el('button', 'btn small ghost', 'Duplicate');
    copy.addEventListener('click', async () => {
      const name = prompt(`Name for your copy of ${mode.name}`, `${mode.name} copy`);
      if (!name) return;
      await api.invoke('modes.duplicate', { id: mode.id, name });
      await reload();
      renderSection();
    });
    actions.appendChild(copy);

    if (mode.overrideCount > 0) {
      const reset = el('button', 'btn small ghost',
        `Reset ${mode.overrideCount} change${mode.overrideCount === 1 ? '' : 's'}`);
      reset.addEventListener('click', async () => {
        await api.invoke('modes.resetOverrides', { id: mode.id });
        await reload();
        renderSection();
      });
      actions.appendChild(reset);
    }

    if (!mode.builtin) {
      const remove = el('button', 'btn small danger', 'Delete');
      remove.addEventListener('click', async () => {
        if (!confirm(`Delete the "${mode.name}" mode? Your features and settings are not affected.`)) return;
        await api.invoke('modes.remove', { id: mode.id });
        await reload();
        renderSection();
      });
      actions.appendChild(remove);
    }

    card.appendChild(actions);
    list.appendChild(card);
  }
  section.appendChild(list);

  // ---- the builder ----
  section.append(
    el('h3', '', 'Build a custom mode'),
    el('p', 'section-note',
      'Start from a built-in, then tick the features you want. A custom mode is the '
      + 'same kind of thing as a built-in one, so it appears in the switcher beside them.')
  );

  const builder = el('div', 'mode-builder');

  const nameRow = el('div', 'row');
  const nameInput = el('input', 'input');
  nameInput.placeholder = 'Name your mode';
  const baseSelect = el('select', 'input');
  for (const mode of modes.modes) {
    const option = el('option', '', `Based on ${mode.name}`);
    option.value = mode.id;
    baseSelect.appendChild(option);
  }
  nameRow.append(nameInput, baseSelect);
  builder.appendChild(nameRow);

  // Feature picker, grouped exactly as the Feature Store groups them, so the
  // two screens teach the same mental model.
  const picker = el('div', 'mode-picker');
  const chosen = new Set(features.filter((f) => f.enabled).map((f) => f.id));

  const groups = new Map();
  for (const feature of features) {
    if (feature.core) continue;
    if (!groups.has(feature.category)) groups.set(feature.category, []);
    groups.get(feature.category).push(feature);
  }

  const renderPicker = () => {
    picker.replaceChildren();
    for (const [category, items] of groups) {
      const group = el('div', 'mode-picker-group');
      group.appendChild(el('h4', '', category));
      for (const feature of items) {
        const chip = el('button', `pick${chosen.has(feature.id) ? ' is-on' : ''}`, feature.name);
        chip.title = feature.description;
        chip.addEventListener('click', () => {
          if (chosen.has(feature.id)) chosen.delete(feature.id);
          else chosen.add(feature.id);
          renderPicker();
        });
        group.appendChild(chip);
      }
      picker.appendChild(group);
    }
  };
  renderPicker();
  builder.appendChild(picker);

  // Seeding from the chosen base keeps the picker honest: tick "based on
  // Gamer" and it immediately shows what Gamer actually turns on. Resolved by
  // the main process rather than guessed here, and without activating the
  // mode — a preview must not flicker the user's chrome or fire every
  // mode-change side effect for something they may discard.
  baseSelect.addEventListener('change', async () => {
    const preview = await api.invoke('modes.preview', { id: baseSelect.value })
      .catch(() => null);
    if (!preview) return;
    chosen.clear();
    for (const [id, on] of Object.entries(preview.features)) if (on) chosen.add(id);
    renderPicker();
  });

  const create = el('button', 'btn primary', 'Create mode');
  create.addEventListener('click', async () => {
    if (!nameInput.value.trim()) { nameInput.focus(); return; }
    const featureMap = {};
    for (const feature of features) {
      if (feature.core) continue;
      featureMap[feature.id] = chosen.has(feature.id);
    }
    await api.invoke('modes.create', {
      name: nameInput.value.trim(),
      basedOn: baseSelect.value,
      features: featureMap,
    });
    nameInput.value = '';
    await reload();
    renderSection();
  });
  builder.appendChild(create);

  section.appendChild(builder);
  return section;
}

// ---------------------------------------------------------------------------
// Feature Store (spec §7)
// ---------------------------------------------------------------------------

async function renderFeatureStore() {
  const section = el('section');
  section.append(
    el('h2', '', 'Feature Store'),
    el('p', 'section-note',
      'Every heavy or borrowed feature can be switched off individually. Turning one off '
      + 'releases its resources — it is not just hidden. Features that depend on another '
      + 'are switched with it.')
  );

  const gauge = el('div', 'footprint');
  const pct = Math.round((footprint.activeCount / footprint.total) * 100);
  const dial = el('div', 'footprint-gauge');
  dial.style.setProperty('--pct', String(pct));
  dial.appendChild(el('span', '', `${pct}%`));
  const text = el('div', 'footprint-text');
  text.append(
    el('h3', '', `${footprint.activeCount} of ${footprint.total} features on`),
    el('p', '', `Estimated footprint: ${footprint.label}. `
      + 'Switch off what you do not use to keep Aether light.')
  );
  gauge.append(dial, text);
  section.appendChild(gauge);

  const groups = new Map();
  for (const feature of features) {
    if (!groups.has(feature.category)) groups.set(feature.category, []);
    groups.get(feature.category).push(feature);
  }

  for (const [category, list] of groups) {
    const group = el('div', 'feature-group');
    group.appendChild(el('h3', '', category));

    for (const feature of list) {
      const blocked = feature.blockedBy.length > 0;
      const card = el('div',
        `feature${feature.enabled ? '' : ' is-off'}${blocked ? ' is-blocked' : ''}`);

      const body = el('div', 'feature-text');
      const name = el('div', 'feature-name');
      name.append(el('span', '', feature.name));
      const cost = el('span', 'cost', feature.cost);
      cost.dataset.cost = feature.cost;
      name.appendChild(cost);
      body.appendChild(name);

      const note = el('div', 'feature-note', feature.description);
      if (feature.costNote) note.append(el('span', 'dimmer', ` ${feature.costNote}.`));
      if (blocked) {
        note.append(el('span', 'dimmer',
          ` Needs ${feature.blockedBy.join(', ')} to be on.`));
      }
      // A switch whose position the user did not choose has to say so, or the
      // Feature Store looks like it is lying about their settings.
      if (feature.source === 'mode' && modes?.active) {
        note.append(el('span', 'by-mode',
          ` Set by ${modes.active.name} Mode — changing it here applies to that mode only.`));
      }
      body.appendChild(note);

      // Shows the *resolved* state, since that is what the browser is
      // actually doing right now. Toggling inside a mode records a per-mode
      // override; in Default it writes the preference, exactly as before.
      const toggle = el('button', 'switch');
      toggle.setAttribute('aria-checked', String(feature.enabled));
      toggle.setAttribute('aria-label', feature.name);
      toggle.addEventListener('click', async () => {
        const store = await api.invoke('features.toggle', {
          id: feature.id, enabled: !feature.enabled,
        });
        features = store.features;
        footprint = store.footprint;
        modes = await api.invoke('modes.list', {}).catch(() => modes);
        renderSection();
      });

      card.append(body, toggle);
      group.appendChild(card);
    }
    section.appendChild(group);
  }

  return section;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderAppearance() {
  const section = sectionShell('Appearance', 'Themes apply per profile.');
  section.append(
    selectRow('Theme', 'appearance.theme',
      [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']],
      'Aether follows your OS setting unless you choose otherwise.'),
    swatchRow('Accent colour', 'appearance.accent'),
    selectRow('Density', 'appearance.density',
      [['comfortable', 'Comfortable'], ['compact', 'Compact']],
      'Compact trims the toolbar and tab strip for smaller screens.'),
    selectRow('Tab layout', 'appearance.tabOrientation',
      [['vertical', 'Vertical sidebar'], ['horizontal', 'Horizontal strip']]),
    toggleRow('Animations', 'appearance.animations',
      'Turn off to remove every transition. Reduced-motion is honoured automatically.'),
    numberRow('Corner radius', 'appearance.roundedCorners', { min: 0, max: 24 })
  );
  return section;
}

function renderStartPage() {
  const section = sectionShell('Start page',
    'What a new tab shows, and which widgets appear on it.');
  section.append(
    selectRow('New tab shows', 'startPage.mode',
      [['speeddial', 'Speed dial'], ['blank', 'Blank page'],
        ['url', 'A specific page'], ['restore', 'Reopen last session']]),
    textRow('Custom URL', 'startPage.customUrl', 'https://example.com'),
    selectRow('Background', 'startPage.background',
      [['aurora', 'Aurora gradient'], ['plain', 'Plain']]),
    toggleRow('Weather widget', 'startPage.widgets.weather'),
    textRow('Weather location', 'startPage.weatherLocation', 'Lisbon'),
    toggleRow('To-do widget', 'startPage.widgets.todo'),
    toggleRow('Recent notes widget', 'startPage.widgets.notes')
  );
  return section;
}

function renderSearch() {
  const engines = Object.entries(settings.search?.engines || {})
    .map(([id, engine]) => [id, engine.name]);
  const section = sectionShell('Search', 'Which engine the address bar uses.');
  section.append(
    selectRow('Search engine', 'search.engine', engines),
    toggleRow('Search suggestions', 'search.suggestionsEnabled',
      'Off by default: suggestions send every keystroke to the search engine '
      + 'before you press Enter.')
  );
  return section;
}

function renderPrivacy() {
  const section = sectionShell('Privacy & security',
    'These settings are enforced in Chromium’s network stack, not by a content script.');

  const promise = el('div', 'callout is-good');
  promise.append(
    el('h4', '', 'Your browsing is never sold or shared with advertisers'),
    el('p', '', 'On any tier, free or Pro. Sync stores only ciphertext, and Aether has '
      + 'no analytics or telemetry of any kind.')
  );
  section.appendChild(promise);

  section.append(
    toggleRow('Block ads and trackers', 'privacy.adblock',
      'Requests are cancelled before a socket opens, so trackers receive nothing at all.'),
    toggleRow('Aggressive mode', 'privacy.adblockAggressive',
      'Also drops first-party analytics beacons. Occasionally breaks a site.'),
    toggleRow('HTTPS-only mode', 'privacy.httpsOnly',
      'Upgrades plaintext navigations. Local and private-range addresses are exempt.'),
    toggleRow('Fingerprinting resistance', 'privacy.fingerprintResistance',
      'Normalises canvas, audio, font and hardware signals per origin.'),
    toggleRow('Block third-party cookies', 'privacy.blockThirdPartyCookies'),
    toggleRow('Send Global Privacy Control', 'privacy.doNotSell',
      'A legally binding do-not-sell signal in several jurisdictions.')
  );

  const listBox = el('div');
  listBox.appendChild(el('h3', '', 'Filter lists'));
  api.invoke('adblock.lists', {}).then((lists) => {
    for (const list of lists) {
      const row = el('div', 'list-row');
      const info = el('div', 'row-text');
      info.append(el('div', 'row-title', list.name));
      const detail = list.error
        ? `Could not update — ${list.error}`
        : list.rules
          ? `${list.rules.toLocaleString()} rules · updated ${relative(list.lastFetched)}`
          : 'Not downloaded yet';
      info.append(el('div', 'row-note', detail));
      const toggle = el('button', 'switch');
      toggle.setAttribute('aria-checked', String(list.enabled));
      toggle.addEventListener('click', async () => {
        await api.invoke('adblock.setListEnabled', { id: list.id, enabled: !list.enabled });
        renderSection();
      });
      row.append(info, toggle);
      listBox.appendChild(row);
    }
    const update = el('button', 'btn', 'Update lists now');
    update.addEventListener('click', async () => {
      update.disabled = true;
      update.textContent = 'Updating…';
      await api.invoke('adblock.updateLists', { force: true });
      renderSection();
    });
    listBox.appendChild(update);
  });
  section.appendChild(listBox);

  return section;
}

function renderVpn() {
  const section = sectionShell('VPN',
    'A WireGuard tunnel with a kill switch. Keys are generated on this device and the '
    + 'private key is never transmitted.');

  api.invoke('vpn.status', {}).then((status) => {
    const box = el('div', 'callout');
    box.append(
      el('h4', '', `Status: ${status.status}`),
      el('p', '', status.scope
        ? `This tunnel protects ${status.scope}.`
        : 'Not connected. Aether uses a device-wide WireGuard tunnel when the system '
          + 'tools are installed, and a browser-only tunnel otherwise — the difference '
          + 'is shown here whenever you connect.')
    );
    section.insertBefore(box, section.children[2] || null);

    if (status.usage) {
      section.appendChild(infoRow('Data used this month',
        status.usage.limit
          ? `${gb(status.usage.used)} of ${gb(status.usage.limit)}`
          : gb(status.usage.used)));
    }
  });

  section.append(
    toggleRow('Kill switch', 'vpn.killSwitch',
      'Blocks all traffic if the tunnel drops, so nothing leaks over the bare connection.'),
    toggleRow('Connect on startup', 'vpn.autoConnect'),
    selectRow('Region', 'vpn.region',
      [['auto', 'Fastest'], ['nl-ams', 'Amsterdam'], ['de-fra', 'Frankfurt'],
        ['us-nyc', 'New York']])
  );
  return section;
}

function renderPasswords() {
  const section = sectionShell('Passwords',
    'A local vault sealed with AES-256-GCM. The key is derived from your master '
    + 'password with scrypt and is never stored.');

  api.invoke('vault.status', {}).then((status) => {
    const box = el('div', 'callout');
    box.append(
      el('h4', '', status.exists
        ? (status.unlocked ? `Unlocked · ${status.entryCount} entries` : 'Locked')
        : 'No vault yet'),
      el('p', '', status.exists
        ? `Locks automatically after ${status.idleLockMinutes} minutes of inactivity.`
        : 'Create a vault to start saving passwords. Choose a master password you can '
          + 'remember — it cannot be recovered without the recovery key.')
    );
    section.insertBefore(box, section.children[2] || null);

    const action = el('button', 'btn btn-primary',
      status.exists ? (status.unlocked ? 'Lock vault' : 'Unlock vault') : 'Create vault');
    action.addEventListener('click', async () => {
      if (status.exists && status.unlocked) {
        await api.invoke('vault.lock', {});
      } else {
        const password = prompt(status.exists
          ? 'Master password'
          : 'Choose a master password (at least 10 characters)');
        if (!password) return;
        if (status.exists) await api.invoke('vault.unlock', { masterPassword: password });
        else {
          const result = await api.invoke('vault.create', { masterPassword: password });
          alert(`Save this recovery key somewhere safe. It is shown once:\n\n${result.recoveryKey}`);
        }
      }
      renderSection();
    });
    section.appendChild(action);
  });

  return section;
}

function renderAi() {
  const section = sectionShell('AI assistant',
    'Choose where inference runs. On-device keeps page text on this machine; hosted '
    + 'sends it to the provider for that request.');

  section.append(
    selectRow('Default model', 'ai.defaultModel',
      [['local', 'On-device'], ['hosted', 'Hosted']]),
    selectRow('Hosted model', 'ai.hosted.model',
      [['claude-opus-5', 'Claude Opus 5 — best reasoning'],
        ['claude-sonnet-5', 'Claude Sonnet 5 — faster'],
        ['claude-haiku-4-5', 'Claude Haiku 4.5 — fastest']]),
    textRow('On-device endpoint', 'ai.local.endpoint', 'http://127.0.0.1:11434'),
    textRow('On-device model', 'ai.local.model', 'llama3.2:3b'),
    toggleRow('Multi-tab context by default', 'ai.multiTabContext',
      'Off by default. The assistant reads only the active tab until you grant this, '
      + 'and private windows never contribute page content.'),
    toggleRow('Generate a quiz with notes', 'ai.autoQuiz'),
    textRow('Obsidian vault folder', 'ai.obsidianVault', '/Users/you/Notes')
  );

  const gate = el('div', 'callout is-warning');
  gate.append(
    el('h4', '', 'Actions always ask first'),
    el('p', '', 'Submitting a form, clicking a button, purchasing, sending or posting '
      + 'always pauses for your explicit approval. This cannot be switched off, which is '
      + 'what stops a page from talking the assistant into acting on your behalf.')
  );
  section.appendChild(gate);

  return section;
}

function renderTabs() {
  const section = sectionShell('Tabs', 'Hibernation suspends idle tabs to free memory.');
  section.append(
    toggleRow('Hibernate idle tabs', 'tabs.hibernateEnabled'),
    numberRow('Suspend after (minutes)', 'tabs.hibernateAfterMinutes', { min: 1, max: 600 }),
    toggleRow('Never suspend tabs playing audio', 'tabs.hibernateExcludeAudible'),
    toggleRow('Never suspend pinned tabs', 'tabs.hibernateExcludePinned'),
    toggleRow('Open links in the background', 'tabs.openInBackground')
  );
  return section;
}

function renderDeveloper() {
  const section = sectionShell('Developer',
    'Tools that live in the sidebar and the command palette.');

  section.append(
    toggleRow('JSON viewer', 'devtools.jsonViewer',
      'Formats raw JSON responses instead of showing a wall of text.'),
    toggleRow('Markdown preview', 'devtools.markdownPreview',
      'Renders local .md files, and re-renders when you save.'),
    toggleRow('Git-aware bookmarks', 'devtools.gitCards',
      'PR status, CI checks and diffs on GitHub and GitLab links.'),
    toggleRow('Hot-reload unpacked extensions', 'devtools.hotReloadExtensions')
  );

  // The CORS toggle, gated to dev profiles only (spec §5).
  const cors = el('div', 'callout is-warning');
  cors.append(
    el('h4', '', 'CORS development toggle'),
    el('p', '', 'Relaxing the same-origin policy lets any page you visit read data from '
      + 'origins you are signed into. It can only be enabled on a development profile, '
      + 'never survives a restart, and shows a banner the whole time it is on.')
  );
  section.appendChild(cors);

  api.invoke('cors.status', {}).then((status) => {
    if (!status.eligibleProfiles.length) {
      section.appendChild(el('p', 'row-note',
        'Create a profile of type “Development” under Profiles to use this.'));
      return;
    }
    for (const profile of status.eligibleProfiles) {
      const on = status.active.some((a) => a.profileId === profile.id);
      const row = el('div', 'row');
      const info = el('div', 'row-text');
      info.append(el('div', 'row-title', profile.name),
        el('div', 'row-note', on ? 'Same-origin protection is OFF' : 'Protected'));
      const toggle = el('button', 'switch');
      toggle.setAttribute('aria-checked', String(on));
      toggle.addEventListener('click', async () => {
        await api.invoke('cors.setEnabled', { profileId: profile.id, enabled: !on });
        renderSection();
      });
      row.append(info, toggle);
      section.appendChild(row);
    }
  });

  return section;
}

function renderProfiles() {
  const section = sectionShell('Profiles',
    'Each profile is a separate cookie jar, cache and extension set — genuinely '
    + 'isolated, not just a different colour.');

  api.invoke('profiles.list', {}).then((profiles) => {
    for (const profile of profiles) {
      const row = el('div', 'row');
      const dot = el('span');
      Object.assign(dot.style, {
        width: '11px', height: '11px', borderRadius: '50%',
        background: profile.color, flex: 'none',
      });
      const info = el('div', 'row-text');
      info.append(el('div', 'row-title', profile.name),
        el('div', 'row-note', `${profile.kind}${profile.active ? ' · active' : ''}`));
      row.append(dot, info);

      if (!profile.active) {
        const use = el('button', 'btn', 'Switch to');
        use.addEventListener('click', async () => {
          await api.invoke('profiles.switch', { id: profile.id });
          renderSection();
        });
        row.appendChild(use);
      }
      section.appendChild(row);
    }

    for (const [kind, label] of [['normal', 'New profile'], ['dev', 'New dev profile']]) {
      const add = el('button', 'btn', label);
      add.addEventListener('click', async () => {
        const name = prompt('Profile name');
        if (!name) return;
        await api.invoke('profiles.create', { name, kind });
        renderSection();
      });
      section.appendChild(add);
    }
  });

  return section;
}

function renderExtensions() {
  const section = sectionShell('Extensions',
    'Chrome Web Store extensions install natively — Aether runs the same Manifest V3 '
    + 'implementation as Chromium itself.');

  const store = el('button', 'btn btn-primary', 'Open the Chrome Web Store');
  store.addEventListener('click', () => api.invoke('extensions.openStore', {}));
  section.appendChild(store);

  const load = el('button', 'btn', 'Load unpacked…');
  load.addEventListener('click', async () => {
    const result = await api.invoke('extensions.load', {}).catch((err) => {
      alert(err.message);
      return null;
    });
    if (result) renderSection();
  });
  section.appendChild(load);

  api.invoke('extensions.list', {}).then((list) => {
    if (!list.length) {
      section.appendChild(el('p', 'row-note', 'No extensions installed.'));
      return;
    }
    for (const ext of list) {
      const row = el('div', 'row');
      const info = el('div', 'row-text');
      info.append(el('div', 'row-title', ext.name || ext.path));
      info.append(el('div', 'row-note',
        ext.error ? `Error: ${ext.error}` : `${ext.version || ''} ${ext.unpacked ? '· unpacked' : ''}`));
      const remove = el('button', 'btn btn-danger', 'Remove');
      remove.addEventListener('click', async () => {
        await api.invoke('extensions.remove', { id: ext.id || ext.path });
        renderSection();
      });
      row.append(info, remove);
      section.appendChild(row);
    }
  });

  return section;
}

function renderSync() {
  const section = sectionShell('Sync',
    'End-to-end encrypted across desktop and Android.');

  api.invoke('sync.status', {}).then((status) => {
    const box = el('div', 'callout is-good');
    box.append(el('h4', '', 'Zero-knowledge by construction'), el('p', '', status.guarantee));
    section.insertBefore(box, section.children[2] || null);

    section.appendChild(infoRow('Status', status.enabled ? status.status : 'Not set up'));
    if (status.lastSync) {
      section.appendChild(infoRow('Last synced', relative(status.lastSync)));
    }

    for (const collection of status.collections) {
      section.appendChild(toggleRow(
        capitalise(collection.name),
        `sync.collections.${collection.name}`,
        collection.requiresUnlock ? 'Syncs only while the vault is unlocked.' : ''
      ));
    }

    const action = el('button', 'btn btn-primary', status.enabled ? 'Sync now' : 'Set up sync');
    action.addEventListener('click', async () => {
      if (status.enabled) {
        await api.invoke('sync.now', {});
      } else {
        const endpoint = prompt('Sync server URL', status.endpoint || 'https://sync.aether.dev');
        if (!endpoint) return;
        const passphrase = prompt('Sync passphrase (at least 12 characters)');
        if (!passphrase) return;
        const result = await api.invoke('sync.enroll', { endpoint, passphrase })
          .catch((err) => { alert(err.message); return null; });
        if (result?.recoveryPhrase) {
          alert(`Recovery phrase — write this down, it is shown once:\n\n${result.recoveryPhrase}`);
        }
      }
      renderSection();
    });
    section.appendChild(action);
  });

  return section;
}

function renderShortcuts() {
  const section = sectionShell('Keyboard shortcuts',
    'Every command is reachable without a mouse, and every chord can be changed. '
    + 'Conflicts are refused rather than silently shadowing another command.');

  api.invoke('shortcuts.list', {}).then(({ commands, conflicts }) => {
    if (conflicts.length) {
      const warn = el('div', 'callout is-warning');
      warn.append(el('h4', '', 'Conflicting shortcuts'),
        el('p', '', conflicts.map((c) => c.accelerator).join(', ')));
      section.appendChild(warn);
    }

    const groups = new Map();
    for (const command of commands) {
      if (!groups.has(command.group)) groups.set(command.group, []);
      groups.get(command.group).push(command);
    }

    for (const [group, list] of groups) {
      section.appendChild(el('h3', '', group));
      for (const command of list) {
        const row = el('div', 'row');
        const info = el('div', 'row-text');
        info.append(el('div', 'row-title', command.label));
        if (command.customised) info.append(el('div', 'row-note', 'Customised'));

        const key = el('button', 'kbd', pretty(command.accelerator) || 'Unbound');
        key.addEventListener('click', () => captureChord(key, command));
        row.append(info, key);
        section.appendChild(row);
      }
    }

    const reset = el('button', 'btn', 'Reset all shortcuts');
    reset.addEventListener('click', async () => {
      await api.invoke('shortcuts.reset', {});
      renderSection();
    });
    section.appendChild(reset);
  });

  return section;
}

/** Record the next chord the user presses and bind it. */
function captureChord(button, command) {
  button.textContent = 'Press a key…';
  button.classList.add('is-capturing');

  const onKey = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') return finish();

    // A bare modifier is not a chord; wait for a real key.
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;

    const parts = [];
    if (event.metaKey || event.ctrlKey) parts.push('CmdOrCtrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);

    const result = await api.invoke('shortcuts.set', {
      id: command.id, accelerator: parts.join('+'),
    });
    if (!result.ok) {
      alert(`That chord is already used by “${result.conflictLabel}”. `
        + 'Change that one first, or pick a different key.');
    }
    finish();
    renderSection();
  };

  function finish() {
    window.removeEventListener('keydown', onKey, true);
    button.classList.remove('is-capturing');
  }

  window.addEventListener('keydown', onKey, true);
}

function renderAbout() {
  const section = sectionShell('About Aether', '');
  fetch('aether://api/version').then((r) => r.json()).then((version) => {
    section.append(
      infoRow('Aether', version.aether),
      infoRow('Chromium', version.chromium),
      infoRow('Node', version.node),
      infoRow('V8', version.v8),
      infoRow('Platform', `${version.platform} ${version.arch}`)
    );
  });

  const promise = el('div', 'callout is-good');
  promise.append(
    el('h4', '', 'What Aether will never do'),
    el('p', '', 'Sell or share your browsing with advertisers, on any tier. Collect '
      + 'analytics or telemetry. Read your pages without you asking. Send anything to a '
      + 'sync server that the server could decrypt.')
  );
  section.appendChild(promise);
  return section;
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function sectionShell(title, note) {
  const section = el('section');
  section.append(el('h2', '', title));
  if (note) section.append(el('p', 'section-note', note));
  return section;
}

function row(title, note, control) {
  const wrap = el('div', 'row');
  const text = el('div', 'row-text');
  text.append(el('div', 'row-title', title));
  if (note) text.append(el('div', 'row-note', note));
  const holder = el('div', 'row-control');
  holder.appendChild(control);
  wrap.append(text, holder);
  return wrap;
}

function toggleRow(title, path, note = '') {
  const toggle = el('button', 'switch');
  const current = Boolean(get(path));
  toggle.setAttribute('aria-checked', String(current));
  toggle.addEventListener('click', async () => {
    const next = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(next));
    await api.invoke('settings.set', { path, value: next });
    set(path, next);
  });
  return row(title, note, toggle);
}

function selectRow(title, path, options, note = '') {
  const select = document.createElement('select');
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = get(path) ?? options[0][0];
  select.addEventListener('change', async () => {
    await api.invoke('settings.set', { path, value: select.value });
    set(path, select.value);
    if (path.startsWith('appearance.')) applyTheme();
  });
  return row(title, note, select);
}

function textRow(title, path, placeholder = '', note = '') {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.value = get(path) ?? '';
  input.addEventListener('change', async () => {
    await api.invoke('settings.set', { path, value: input.value });
    set(path, input.value);
  });
  return row(title, note, input);
}

function numberRow(title, path, { min, max } = {}, note = '') {
  const input = document.createElement('input');
  input.type = 'number';
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  input.value = String(get(path) ?? 0);
  input.addEventListener('change', async () => {
    const value = Number(input.value);
    await api.invoke('settings.set', { path, value });
    set(path, value);
  });
  return row(title, note, input);
}

function swatchRow(title, path) {
  const wrap = el('div');
  wrap.style.display = 'flex';
  wrap.style.gap = '7px';
  for (const color of ['#6C8CFF', '#4CC9A7', '#F7A072', '#C77DFF', '#FF6B8A', '#5BC0EB', '#F5D547']) {
    const swatch = el('button');
    Object.assign(swatch.style, {
      width: '26px', height: '26px', borderRadius: '50%',
      background: color,
      border: get(path) === color ? '2px solid var(--text)' : '2px solid transparent',
    });
    swatch.addEventListener('click', async () => {
      await api.invoke('settings.set', { path, value: color });
      set(path, color);
      applyTheme();
      renderSection();
    });
    wrap.appendChild(swatch);
  }
  return row(title, '', wrap);
}

function infoRow(title, value) {
  return row(title, '', el('span', 'mono-sm dim', String(value)));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function get(path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), settings);
}

function set(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let node = settings;
  for (const key of keys) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[last] = value;
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function svg(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const node = document.createElementNS(ns, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.7');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  for (const segment of String(d).split('M').filter(Boolean)) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M' + segment);
    node.appendChild(path);
  }
  return node;
}

function pretty(accelerator) {
  if (!accelerator) return '';
  const mac = navigator.platform.toLowerCase().includes('mac');
  return accelerator
    .replace(/CmdOrCtrl/g, mac ? '⌘' : 'Ctrl')
    .replace(/Control/g, mac ? '⌃' : 'Ctrl')
    .replace(/Alt/g, mac ? '⌥' : 'Alt')
    .replace(/Shift/g, mac ? '⇧' : 'Shift')
    .replace(/\+/g, mac ? '' : '+');
}

function relative(timestamp) {
  if (!timestamp) return 'never';
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} minutes ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hours ago`;
  return `${Math.floor(delta / 86_400_000)} days ago`;
}

function gb(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1).replace(/([A-Z])/g, ' $1');
}
