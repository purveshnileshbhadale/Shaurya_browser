/**
 * Mode panels (spec §1: "swappable panels registered against a common Mode
 * API — never hardcoded UI branches").
 *
 * Every panel here is a plain registration: an id, a label, an icon, and a
 * render function that receives the panel body and returns a disposer. The
 * panel host looks up the id; nothing in the host, the toolbar, or the mode
 * service knows which modes exist or which panels belong to them. A mode
 * document names panel ids, and that is the entire coupling.
 *
 * Adding a mode therefore touches: the mode document, and this file. Adding a
 * *panel* touches only this file.
 */
import { h, icon, clear, formatBytes, formatRelative } from '../core/dom.js';
import { state, subscribe, invoke, toast } from '../core/store.js';

// ===========================================================================
// Shared building blocks
// ===========================================================================

/** A titled group of rows, the shape every panel in this file uses. */
function section(title, ...children) {
  return h('section.panel-section', {},
    h('h3.panel-section-title', { text: title }),
    ...children.filter(Boolean));
}

/** A key/value row. */
function stat(label, value, tone) {
  return h('div.stat-row', { dataset: tone ? { tone } : {} },
    h('span.stat-label', { text: label }),
    h('span.stat-value', { text: String(value ?? '—') }));
}

/**
 * A note explaining a limit.
 *
 * Used wherever a feature cannot do the whole of what its name suggests. It
 * is styled as information rather than as an error, because these are honest
 * boundaries, not failures.
 */
function limitNote(text) {
  return h('p.panel-note', {}, icon('info'), h('span', { text }));
}

function emptyState(text, action) {
  return h('div.empty', {}, h('p', { text }), action || null);
}

function button(label, onclick, { variant = '', iconName } = {}) {
  return h(`button.btn${variant ? `.${variant}` : ''}`, { onclick },
    iconName ? icon(iconName) : null, h('span', { text: label }));
}

/** Re-render on a store key, returning a disposer the host will call. */
function live(key, render) {
  const unsubscribe = subscribe(key, render);
  render();
  return unsubscribe;
}

// ===========================================================================
// Gamer: performance
// ===========================================================================

function renderPerfPanel(body) {
  const summary = h('div.perf-summary');
  const tabList = h('div.perf-tabs');

  const turbo = h('button.big-toggle', {
    onclick: async () => {
      const next = !state.perf?.turbo?.on;
      const result = await invoke('perf.turbo', { on: next });
      toast(result.on
        ? `Turbo on — ${result.suspendedTabs} tab(s) suspended`
        : 'Turbo off', 'success');
    },
  });

  body.append(
    section('Turbo', turbo,
      limitNote('Suspends background tabs, extensions and sync. Anything making '
        + 'sound is left alone, and turning Turbo off restores exactly what it '
        + 'suspended — not every tab you ever hibernated.')),
    section('This machine', summary,
      limitNote('CPU and memory are Chromium\'s own process metrics. There is no '
        + 'cross-platform GPU utilisation API, so the GPU row is the GPU '
        + 'process\'s load, not the adapter\'s.')),
    section('Tabs', tabList),
    section('Latency', renderPing()),
  );

  return live('perf', () => {
    const on = state.perf?.turbo?.on === true;
    clear(turbo);
    turbo.dataset.on = String(on);
    turbo.append(icon('zap'), h('span', { text: on ? 'Turbo is on' : 'Turn on Turbo' }));

    const sys = state.perf?.system;
    clear(summary);
    if (sys) {
      summary.append(
        stat('Browser CPU', `${sys.cpu}%`),
        stat('Memory', formatBytes(sys.memoryBytes)),
        stat('Processes', sys.processCount),
        stat('GPU process', `${sys.gpuProcessCpu}% · ${formatBytes(sys.gpuProcessMemoryBytes)}`),
        sys.systemMemory
          ? stat('System memory free', formatBytes(sys.systemMemory.freeBytes))
          : null,
      );
    } else {
      summary.append(emptyState('Sampling…'));
    }

    clear(tabList);
    const rows = [...(state.perf?.tabs || [])].sort((a, b) => b.cpu - a.cpu).slice(0, 12);
    if (!rows.length) { tabList.append(emptyState('No tabs to measure.')); return; }

    for (const row of rows) {
      tabList.append(h('div.perf-tab', {
        dataset: { hibernated: String(row.hibernated), capped: String(row.capped) },
        title: row.cap
          ? `Capped at ${row.cap.cpuPercent ?? '—'}% CPU / ${row.cap.memoryMb ?? '—'} MB. `
            + 'Aether cannot hard-limit a renderer, so a tab over its cap for '
            + 'several seconds is put to sleep instead.'
          : row.url,
        oncontextmenu: (event) => { event.preventDefault(); openCapMenu(row); },
      },
      h('span.perf-tab-title', { text: row.title || 'Untitled' }),
      h('span.perf-tab-metrics', {},
        h('span', { text: row.hibernated ? 'asleep' : `${row.cpu}%` }),
        h('span', { text: formatBytes(row.memoryBytes) }),
        row.fps != null ? h('span', { text: `${row.fps} fps` }) : null),
      row.capped ? h('span.perf-cap-badge', { text: 'cap' }) : null));
    }
  });
}

function openCapMenu(row) {
  const cpu = window.prompt(
    `Cap "${row.title}" at how much CPU (%)?\n\n`
    + 'A browser cannot hard-limit a renderer, so this is a watchdog: a tab '
    + 'over its cap for five seconds is put to sleep. Leave blank to clear.',
    row.cap?.cpuPercent ?? '',
  );
  if (cpu === null) return;
  if (!cpu.trim()) {
    invoke('perf.clearTabCap', { tabId: row.tabId }).then(() => toast('Cap cleared'));
    return;
  }
  invoke('perf.setTabCap', { tabId: row.tabId, cpuPercent: Number(cpu) })
    .then(() => toast(`Capped at ${cpu}% CPU`, 'success'));
}

function renderPing() {
  const wrap = h('div.ping-panel');
  const results = h('div.ping-results');

  wrap.append(
    button('Test regions', async () => {
      results.replaceChildren(emptyState('Measuring…'));
      try {
        const report = await invoke('ping.test', {});
        clear(results);
        for (const r of report.results) {
          results.append(h('div.ping-row', {},
            h('span', { text: `${r.name}${r.city ? ` · ${r.city}` : ''}` }),
            h('span.ping-value', { dataset: { grade: gradeOf(r.median) } },
              { text: r.median == null ? 'unreachable' : `${r.median} ms` }),
            r.jitter != null ? h('span.ping-jitter', { text: `±${r.jitter}` }) : null));
        }
        if (report.best) {
          results.prepend(h('p.panel-note', {}, icon('check'),
            h('span', { text: `Closest: ${report.best.name} at ${report.best.median} ms` })));
        }
      } catch (err) {
        results.replaceChildren(emptyState(err.message));
      }
    }, { iconName: 'gauge' }),
    results,
    limitNote('Measured as a TCP handshake, so it reads a little higher than a '
      + 'game client\'s UDP ping. The ranking between regions is what you pick '
      + 'a server with, and that is preserved.'),
  );
  return wrap;
}

function gradeOf(ms) {
  if (ms == null) return 'unreachable';
  if (ms < 30) return 'excellent';
  if (ms < 60) return 'good';
  if (ms < 100) return 'fair';
  return 'poor';
}

// ===========================================================================
// Gamer: streams
// ===========================================================================

function renderStreamPanel(body) {
  const list = h('div.stream-list');
  const layoutRow = h('div.chip-row');

  const platform = h('select.input', {},
    h('option', { value: 'twitch', text: 'Twitch' }),
    h('option', { value: 'youtube', text: 'YouTube' }),
    h('option', { value: 'kick', text: 'Kick' }));
  const channel = h('input.input', { placeholder: 'Channel or video id' });

  body.append(
    section('Open a stream',
      h('div.row', {}, platform, channel,
        button('Open', () => {
          if (!channel.value.trim()) return;
          invoke('stream.open', { platform: platform.value, channel: channel.value.trim() })
            .then(() => invoke('stream.add', {
              platform: platform.value, channel: channel.value.trim(),
            }))
            .catch((err) => toast(err.message, 'error'));
        }, { variant: 'primary' })),
      limitNote('The player is a real always-on-top window, so it stays visible '
        + 'over a borderless-fullscreen game. Streams play through the '
        + 'platform\'s own embed — Aether does not touch the video stream.')),
    section('Layout', layoutRow),
    section('Saved', list),
  );

  return live('streams', () => {
    clear(layoutRow);
    for (const layout of state.streams?.layouts || []) {
      layoutRow.append(h('button.chip', {
        dataset: { active: String(state.streams?.activeLayout === layout.id) },
        title: layout.description,
        onclick: () => invoke('stream.open', { layout: layout.id, ...state.streams.current })
          .catch(() => invoke('settings.set', { path: 'gaming.streamLayout', value: layout.id })),
      }, h('span', { text: layout.name })));
    }

    clear(list);
    const saved = state.streams?.saved || [];
    if (!saved.length) { list.append(emptyState('No saved channels yet.')); return; }

    for (const s of saved) {
      list.append(h('div.list-row', {},
        h('span.list-row-main', { text: s.label || s.channel }),
        h('span.list-row-sub', { text: s.platform }),
        h('button.icon-btn', {
          title: 'Open',
          onclick: () => invoke('stream.open', s).catch((err) => toast(err.message, 'error')),
        }, icon('external')),
        h('button.icon-btn', {
          title: 'Remove',
          onclick: () => invoke('stream.remove', s),
        }, icon('trash'))));
    }
  });
}

// ===========================================================================
// Gamer: library, presence and patch notes
// ===========================================================================

function renderGamesPanel(body) {
  const library = h('div.game-grid');
  const notes = h('div.feed-list');
  const presence = h('div.presence-row');

  body.append(
    section('Library', library),
    section('Presence', presence),
    section('Patch notes', notes,
      h('div.row', {},
        h('input.input#feed-url', { placeholder: 'Add an RSS or Atom feed URL' }),
        button('Add', () => {
          const input = body.querySelector('#feed-url');
          if (!input.value.trim()) return;
          invoke('games.addFeed', { url: input.value.trim() })
            .then(() => { input.value = ''; return invoke('games.refresh', {}); })
            .catch((err) => toast(err.message, 'error'));
        }))),
  );

  invoke('games.feeds', {}).then((s) => Object.assign(state.games, s)).catch(() => {});

  return live('games', () => {
    clear(library);
    const games = state.games?.library || [];
    if (!games.length) {
      library.append(emptyState(
        state.games?.steamConfigured === false
          ? 'Add a Steam Web API key and your SteamID in Settings → Gaming to see '
            + 'your library. The key is free and your profile must be public.'
          : 'No games found.',
      ));
    } else {
      for (const game of games.slice(0, 24)) {
        library.append(h('div.game-card', { title: game.name },
          game.header ? h('img.game-cover', { src: game.header, loading: 'lazy' }) : null,
          h('span.game-name', { text: game.name }),
          h('span.game-time', {
            text: game.minutes ? `${Math.round(game.minutes / 60)}h` : 'unplayed',
          })));
      }
    }

    clear(presence);
    const p = state.games?.presence || {};
    presence.append(p.connected
      ? stat('Discord', 'connected', 'ok')
      : stat('Discord', p.reason || 'not running'));

    clear(notes);
    const items = state.games?.patchNotes || [];
    if (!items.length) { notes.append(emptyState('No patch notes yet. Add a feed above.')); return; }
    for (const item of items.slice(0, 20)) {
      notes.append(h('a.feed-item', {
        href: '#',
        onclick: (e) => { e.preventDefault(); invoke('tabs.create', { url: item.url }); },
      },
      h('span.feed-title', { text: item.title }),
      h('span.feed-meta', {
        text: item.published ? formatRelative(item.published) : '',
      })));
    }
  });
}

// ===========================================================================
// Gamer: deals
// ===========================================================================

function renderDealsPanel(body) {
  const feed = h('div.deal-list');
  const watched = h('div.deal-list');
  const search = h('input.input', { placeholder: 'Search a title to watch…' });
  const searchResults = h('div.deal-list');

  search.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || !search.value.trim()) return;
    searchResults.replaceChildren(emptyState('Searching…'));
    try {
      const results = await invoke('deals.search', { query: search.value.trim() });
      clear(searchResults);
      for (const game of results.slice(0, 8)) {
        searchResults.append(h('div.list-row', {},
          h('span.list-row-main', { text: game.title }),
          game.cheapest != null ? h('span.list-row-sub', { text: `$${game.cheapest}` }) : null,
          button('Watch', () => invoke('deals.watch', {
            gameId: game.gameId, title: game.title,
          }).then(() => toast(`Watching ${game.title}`, 'success')))));
      }
    } catch (err) {
      searchResults.replaceChildren(emptyState(err.message));
    }
  });

  body.append(
    section('Watch a game', search, searchResults),
    section('Watching', watched),
    section('Current deals', feed),
  );

  invoke('deals.list', {}).then((s) => Object.assign(state.deals, s)).catch(() => {});

  return live('deals', () => {
    clear(watched);
    const list = state.deals?.watched || [];
    if (!list.length) watched.append(emptyState('Nothing on the watchlist.'));
    for (const entry of list) {
      watched.append(h('div.list-row', {},
        h('span.list-row-main', { text: entry.title }),
        h('span.list-row-sub', {
          text: entry.lastPrice != null
            ? `$${entry.lastPrice} at ${entry.lastStore}`
            : 'checking…',
        }),
        h('button.icon-btn', {
          title: 'Stop watching',
          onclick: () => invoke('deals.unwatch', { gameId: entry.gameId }),
        }, icon('trash'))));
    }

    clear(feed);
    for (const deal of (state.deals?.deals || []).slice(0, 12)) {
      feed.append(h('a.deal-card', {
        href: '#',
        onclick: (e) => { e.preventDefault(); invoke('tabs.create', { url: deal.url }); },
      },
      h('span.deal-title', { text: deal.title }),
      h('span.deal-price', {}, h('s', { text: `$${deal.retail}` }), ` $${deal.price}`),
      h('span.deal-store', { text: `${deal.savings}% off · ${deal.store}` })));
    }

    if (state.deals?.currencyNote) feed.append(limitNote(state.deals.currencyNote));
  });
}

// ===========================================================================
// Creator: assets
// ===========================================================================

function renderAssetsPanel(body) {
  const results = h('div.asset-grid');
  const query = h('input.input', { placeholder: 'Search open-licensed media…' });
  const source = h('select.input', {});

  async function run() {
    if (!query.value.trim()) return;
    results.replaceChildren(emptyState('Searching…'));
    try {
      const found = await invoke('creator.search', {
        query: query.value.trim(), source: source.value,
      });
      clear(results);
      if (!found.results.length) { results.append(emptyState('Nothing found.')); return; }
      for (const asset of found.results) {
        results.append(h('figure.asset', { title: asset.title },
          h('img', { src: asset.thumbnail, loading: 'lazy', alt: asset.title }),
          h('figcaption', {},
            h('span.asset-licence', { text: asset.licence || 'see source' }),
            h('button.link', {
              onclick: () => {
                navigator.clipboard?.writeText(asset.attribution);
                toast('Attribution copied — paste it wherever you use this.', 'success');
              },
            }, 'Copy credit'))));
      }
    } catch (err) {
      results.replaceChildren(emptyState(err.message));
    }
  }

  query.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  body.append(
    section('Find media',
      h('div.row', {}, query, source, button('Search', run, { variant: 'primary' })),
      limitNote('Openverse and Wikimedia need no account. Every result carries its '
        + 'licence and a ready-made attribution line — using a CC-BY asset '
        + 'without the credit is a licence breach, so it is one click away.')),
    section('Results', results),
    section('Teleprompter', renderTeleprompter()),
  );

  invoke('creator.sources', {}).then((sources) => {
    clear(source);
    for (const s of sources) {
      source.append(h('option', {
        value: s.id,
        text: s.available ? s.name : `${s.name} (needs a key)`,
        disabled: !s.available,
      }));
    }
  }).catch(() => {});

  return () => {};
}

function renderTeleprompter() {
  const text = h('textarea.input', { rows: 4, placeholder: 'Paste your script…' });
  return h('div', {},
    text,
    h('div.row', {},
      button('Save', () => {
        if (!text.value.trim()) return;
        invoke('creator.saveScript', { title: text.value.slice(0, 40), body: text.value })
          .then((s) => toast(`Saved — about ${Math.round(s.estimatedSeconds / 60)} min at 150 wpm`, 'success'));
      }),
      button('Open overlay', () => invoke('tabs.create', { url: 'aether://teleprompter' }))),
    limitNote('The overlay floats above other windows and scrolls at a set words-'
      + 'per-minute. A USB foot pedal that emits a spare function key can '
      + 'start and stop it — set which key in Settings → Creator.'));
}

// ===========================================================================
// Creator: brand kit
// ===========================================================================

function renderBrandPanel(body) {
  const swatches = h('div.swatch-grid');
  const fonts = h('div.chip-row');
  const thumbs = h('div.thumb-compare');

  body.append(
    section('Brand colours', swatches,
      h('div.row', {},
        h('input.input#brand-colour', { type: 'text', placeholder: '#FF6B00' }),
        button('Add', () => {
          const input = body.querySelector('#brand-colour');
          const kit = state.creator?.kits?.kits?.[0];
          invoke('creator.saveKit', {
            id: kit?.id,
            name: kit?.name || 'My brand',
            colours: [...(kit?.colours || []), input.value],
            fonts: kit?.fonts || [],
          }).then(() => { input.value = ''; });
        }))),
    section('Fonts', fonts),
    section('Thumbnail A/B', thumbs,
      limitNote('Both candidates are rendered at the sizes a real feed uses. A '
        + 'thumbnail that reads at full width often falls apart at 168px, which '
        + 'is where most impressions actually happen.')),
  );

  invoke('creator.state', {}).then((s) => Object.assign(state.creator, s)).catch(() => {});

  return live('creator', () => {
    const kit = state.creator?.kits?.kits?.[0];

    clear(swatches);
    for (const colour of kit?.colours || []) {
      swatches.append(h('button.swatch', {
        style: { background: colour },
        title: `${colour} — click to copy`,
        onclick: () => {
          navigator.clipboard?.writeText(colour);
          invoke('creator.applyValue', { value: colour }).catch(() => {});
          toast(`${colour} copied`, 'success');
        },
      }));
    }
    if (!kit?.colours?.length) swatches.append(emptyState('No brand colours yet.'));

    clear(fonts);
    for (const font of kit?.fonts || []) {
      fonts.append(h('span.chip', { text: font, style: { fontFamily: font } }));
    }

    clear(thumbs);
    const comparison = state.creator?.thumbnails;
    for (const layout of (comparison?.layouts || []).slice(0, 3)) {
      thumbs.append(h('div.thumb-layout', {},
        h('span.thumb-layout-name', { text: `${layout.name} · ${layout.width}px` }),
        h('div.thumb-pair', {},
          ...[0, 1].map((i) => h('div.thumb-slot', {
            style: { width: `${Math.min(layout.width, 150)}px`, aspectRatio: layout.ratio.replace(':', '/') },
            onclick: () => {
              const path = window.prompt('Path to a thumbnail image');
              if (path) invoke('creator.setThumbnail', { index: i, path });
            },
          }, comparison?.slots?.[i]
            ? h('img', { src: `file://${comparison.slots[i]}` })
            : h('span', { text: `Slot ${i + 1}` }))))));
    }
  });
}

// ===========================================================================
// Creator: schedule
// ===========================================================================

function renderSchedulePanel(body) {
  const queue = h('div.list');
  const platforms = h('div.chip-row');

  body.append(
    section('Connected', platforms,
      limitNote('Publishing needs an account connection per platform. Aether '
        + 'stores the token in your encrypted vault. Anything queued for a '
        + 'platform that is not connected is marked blocked rather than left '
        + 'looking like it is about to go out.')),
    section('Queue', queue),
    section('Analytics', h('div#creator-analytics')),
  );

  invoke('creator.state', {}).then((s) => Object.assign(state.creator, s)).catch(() => {});

  return live('creator', () => {
    clear(platforms);
    for (const p of state.creator?.platforms || []) {
      platforms.append(h('span.chip', {
        dataset: { active: String(p.connected) },
        title: `Scopes: ${p.scopes}`,
      }, h('span', { text: p.connected ? `${p.name} ✓` : p.name })));
    }

    clear(queue);
    const items = state.creator?.queue || [];
    if (!items.length) { queue.append(emptyState('Nothing scheduled.')); return; }
    for (const item of items) {
      queue.append(h('div.list-row', { dataset: { status: item.status } },
        h('span.list-row-main', { text: item.title || '(untitled)' }),
        h('span.list-row-sub', {
          text: `${item.platform} · ${new Date(item.when).toLocaleString()}`,
        }),
        item.blockedReason ? h('span.list-row-warn', { text: item.blockedReason }) : null,
        h('button.icon-btn', {
          title: 'Remove',
          onclick: () => invoke('creator.unschedule', { id: item.id }),
        }, icon('trash'))));
    }
  });
}

// ===========================================================================
// Student
// ===========================================================================

function renderStudyPanel(body) {
  const timer = h('div.timer');
  const decks = h('div.list');

  body.append(
    section('Focus', timer,
      limitNote('Blocked sites are cancelled at the network layer, not hidden '
        + 'with a overlay — so reader mode and view-source do not get around '
        + 'it. Breaks unblock automatically.')),
    section('Flashcards', decks,
      button('Make cards from this page', () => {
        toast('Generating…');
        invoke('student.generateDeck', {})
          .then((d) => toast(`${d.cards.length} cards from "${d.title}"`, 'success'))
          .catch((err) => toast(err.message, 'error'));
      }, { variant: 'primary', iconName: 'cards' })),
  );

  invoke('student.decks', {}).then((d) => { state.student.decks = d; }).catch(() => {});

  return live('student', () => {
    const t = state.student?.timer || {};
    clear(timer);
    if (t.running) {
      const mins = Math.floor((t.remainingMs || 0) / 60000);
      const secs = Math.floor(((t.remainingMs || 0) % 60000) / 1000);
      timer.append(
        h('div.timer-clock', { dataset: { phase: t.phase } },
          { text: `${mins}:${String(secs).padStart(2, '0')}` }),
        h('div.timer-phase', {
          text: `${t.phase === 'focus' ? 'Focus' : 'Break'} · round ${t.round} of ${t.rounds}`,
        }),
        button('Stop', () => invoke('student.stopTimer', {})),
      );
    } else {
      timer.append(button('Start a focus block', () => invoke('student.startTimer', {}),
        { variant: 'primary', iconName: 'clock' }));
    }

    clear(decks);
    const list = state.student?.decks || [];
    if (!list.length) { decks.append(emptyState('No decks yet.')); return; }
    for (const deck of list) {
      decks.append(h('div.list-row', {},
        h('span.list-row-main', { text: deck.title }),
        h('span.list-row-sub', { text: `${deck.cards.length} cards · ${deck.due} due` }),
        h('button.icon-btn', {
          title: 'Delete deck',
          onclick: () => invoke('student.removeDeck', { id: deck.id }),
        }, icon('trash'))));
    }
  });
}

function renderCitationsPanel(body) {
  const list = h('div.list');
  const styleSelect = h('select.input', {},
    h('option', { value: 'apa', text: 'APA 7' }),
    h('option', { value: 'mla', text: 'MLA 9' }),
    h('option', { value: 'chicago', text: 'Chicago 17' }));

  body.append(
    section('Sources',
      h('div.row', {},
        button('Cite this page', () => invoke('student.capture', {})
          .then((s) => toast(`Captured "${s.title}"`, 'success'))
          .catch((err) => toast(err.message, 'error')), { variant: 'primary', iconName: 'quote' }),
        styleSelect),
      list),
    section('Export',
      button('Copy bibliography', async () => {
        const result = await invoke('student.exportBibliography', { style: styleSelect.value });
        navigator.clipboard?.writeText(result.entries.join('\n\n'));
        toast(`${result.count} entries copied`, 'success');
      }),
      limitNote('Sources are stored as CSL-JSON, the format Zotero and Pandoc '
        + 'already read, so your library is not trapped in this browser.')),
  );

  const refresh = () => invoke('student.library', {}).then((lib) => {
    clear(list);
    if (!lib.sources.length) { list.append(emptyState('No sources captured yet.')); return; }
    for (const source of lib.sources) {
      invoke('student.cite', { id: source.id, style: styleSelect.value }).then(({ text }) => {
        list.append(h('div.citation', {
          dataset: { confidence: source.confidence },
          title: source.confidence === 'low'
            ? 'Read from the page title only — check this one before submitting.'
            : 'Read from publisher metadata.',
        },
        h('p.citation-text', { text }),
        h('div.citation-actions', {},
          h('button.link', {
            onclick: () => { navigator.clipboard?.writeText(text); toast('Copied', 'success'); },
          }, 'Copy'),
          h('button.link', {
            onclick: () => invoke('student.removeSource', { id: source.id }).then(refresh),
          }, 'Remove'))));
      }).catch(() => {});
    }
  }).catch(() => {});

  styleSelect.addEventListener('change', refresh);
  refresh();
  return () => {};
}

function renderDeadlinesPanel(body) {
  const buckets = h('div.deadlines');

  body.append(
    section('Deadlines', buckets),
    section('Import',
      h('div.row', {},
        h('input.input#ics-url', { placeholder: 'Paste your LMS calendar (ICS) URL' }),
        button('Import', () => {
          const input = body.querySelector('#ics-url');
          if (!input.value.trim()) return;
          invoke('student.importFeed', { url: input.value.trim() })
            .then((r) => toast(`Imported ${r.imported} deadline(s)`, 'success'))
            .catch((err) => toast(err.message, 'error'));
        }, { variant: 'primary' })),
      limitNote('Canvas, Moodle and Blackboard all publish a personal calendar '
        + 'feed. That is the one integration they share, and it needs no API key.')),
  );

  invoke('student.deadlines', {}).then((d) => { state.student.deadlines = d; }).catch(() => {});

  return live('student', () => {
    const data = state.student?.deadlines;
    clear(buckets);
    if (!data?.total) { buckets.append(emptyState('No deadlines imported.')); return; }

    for (const [name, label] of [['overdue', 'Overdue'], ['today', 'Today'],
      ['week', 'This week'], ['later', 'Later']]) {
      const items = data.buckets[name] || [];
      if (!items.length) continue;
      buckets.append(h('div.deadline-group', { dataset: { urgency: name } },
        h('h4', { text: label }),
        ...items.map((e) => h('div.deadline', {},
          h('span.deadline-title', { text: e.title }),
          h('span.deadline-meta', {
            text: [e.course, e.due ? new Date(e.due).toLocaleDateString() : null]
              .filter(Boolean).join(' · '),
          })))));
    }
  });
}

// ===========================================================================
// Ghost
// ===========================================================================

function renderGhostPanel(body) {
  const torRow = h('div.ghost-row');
  const dohRow = h('div.ghost-row');

  body.append(
    section('Tor', torRow,
      limitNote('Aether does not bundle Tor. If no local Tor proxy is listening, '
        + 'routing fails loudly rather than falling back to a direct connection '
        + 'while still showing a Tor badge.')),
    section('DNS', dohRow,
      limitNote('Chromium resolves DNS for the whole application, so this setting '
        + 'applies to every window — not only Ghost ones.')),
    section('Files',
      h('div.row', {},
        button('Strip metadata from a file…', () => pickAndRun('ghost.stripFile')),
        button('Shred a file…', () => {
          if (!window.confirm(
            'Shredding overwrites the file before deleting it. On an SSD or a '
            + 'copy-on-write filesystem, wear levelling can leave the original '
            + 'blocks intact underneath. This raises the cost of recovery a great '
            + 'deal; it is not a guarantee of erasure.\n\nContinue?',
          )) return;
          pickAndRun('ghost.shredFile');
        }, { variant: 'danger' }))),
    section('Panic',
      button('Close and wipe this window', () => invoke('ghost.panic', { scope: 'window' }),
        { variant: 'danger', iconName: 'alert' }),
      limitNote('Windows close first, then storage is cleared — so the screen is '
        + 'blank immediately rather than a second later.')),
  );

  invoke('ghost.status', {}).then((s) => Object.assign(state.ghost, s)).catch(() => {});

  return live('ghost', () => {
    const tor = state.ghost?.tor || {};
    clear(torRow);
    torRow.append(
      stat('Status', tor.available === true ? `available on :${tor.port}`
        : tor.available === false ? 'not running' : 'unknown',
      tor.available === true ? 'ok' : 'warn'),
      button(tor.available ? 'Route this window' : 'Check again', () => {
        (tor.available
          ? invoke('ghost.routeTor', { enabled: true })
          : invoke('ghost.torAvailable', { refresh: true })
        ).then((r) => toast(r.routed ? `Routed via ${r.endpoint}` : 'Rechecked'))
          .catch((err) => toast(err.message, 'error'));
      }),
      tor.available === false && tor.remedy ? limitNote(tor.remedy) : null,
    );

    const doh = state.ghost?.doh || {};
    clear(dohRow);
    const select = h('select.input', {
      onchange: (e) => invoke('ghost.setDoh', { id: e.target.value })
        .then(() => toast('Resolver updated', 'success'))
        .catch((err) => toast(err.message, 'error')),
    });
    for (const p of doh.providers || []) {
      select.append(h('option', { value: p.id, text: p.name, selected: p.active, title: p.note }));
    }
    dohRow.append(select);
  });
}

function renderBreachPanel(body) {
  const list = h('div.list');

  body.append(
    section('Breach monitor',
      button('Scan now', () => {
        toast('Checking…');
        invoke('ghost.runBreachScan', {})
          .then((r) => toast(r.blocked
            ? 'Unlock the vault first.'
            : `Checked ${r.total} accounts.`, r.blocked ? 'warn' : 'success'))
          .catch((err) => toast(err.message, 'error'));
      }, { variant: 'primary', iconName: 'shield' }),
      list,
      limitNote('Only a five-character prefix of each password\'s SHA-1 leaves the '
        + 'machine — the k-anonymity range API. The password itself never does.')),
  );

  invoke('ghost.breachReport', {}).then((r) => { state.ghost.breach = r; }).catch(() => {});

  return live('ghost', () => {
    const report = state.ghost?.breach || {};
    clear(list);

    if (report.running) { list.append(emptyState('Scanning…')); return; }
    if (!report.checkedAt) { list.append(emptyState('Not scanned yet.')); return; }

    if (!report.entries?.length) {
      list.append(h('p.panel-note', {}, icon('check'),
        h('span', { text: `No breached passwords among ${report.total} accounts.` })));
    }
    for (const entry of report.entries || []) {
      list.append(h('div.list-row', { dataset: { severity: entry.severity } },
        h('span.list-row-main', { text: entry.site }),
        h('span.list-row-sub', { text: `${entry.username} · seen ${entry.count.toLocaleString()} times` })));
    }
    if (report.unchecked) {
      list.append(limitNote(`${report.unchecked} account(s) could not be checked — `
        + 'a failed lookup is not a clean result, so they are not counted as safe.'));
    }
  });
}

function pickAndRun(channel) {
  const path = window.prompt('Full path to the file');
  if (!path) return;
  invoke(channel, { path })
    .then((r) => toast(r.changed === false && r.skipped
      ? `Skipped: ${r.skipped}`
      : 'Done', 'success'))
    .catch((err) => toast(err.message, 'error'));
}

// ===========================================================================
// Registry
// ===========================================================================

/**
 * Every mode panel, keyed by the id a mode document names.
 *
 * `feature` gates the panel on the Feature Store, so a mode that lists a
 * panel whose feature the user switched off shows a clear explanation rather
 * than a broken panel.
 */
export const MODE_PANELS = {
  perf: { label: 'Performance', icon: 'gauge', feature: 'tabLimits', render: renderPerfPanel },
  stream: { label: 'Streams', icon: 'screen', feature: 'streamPlayer', render: renderStreamPanel },
  games: { label: 'Games', icon: 'gamepad', feature: 'gameFeeds', render: renderGamesPanel },
  deals: { label: 'Deals', icon: 'star', feature: 'deals', render: renderDealsPanel },

  assets: { label: 'Assets', icon: 'image', feature: 'assetLibrary', render: renderAssetsPanel },
  brand: { label: 'Brand kit', icon: 'palette', feature: 'brandKit', render: renderBrandPanel },
  schedule: { label: 'Schedule', icon: 'calendar', feature: 'uploadScheduler', render: renderSchedulePanel },

  study: { label: 'Study', icon: 'book', feature: 'focusBlocker', render: renderStudyPanel },
  citations: { label: 'Citations', icon: 'quote', feature: 'citations', render: renderCitationsPanel },
  deadlines: { label: 'Deadlines', icon: 'calendar', feature: 'deadlines', render: renderDeadlinesPanel },

  ghost: { label: 'Ghost', icon: 'ghost', feature: 'tor', render: renderGhostPanel },
  breach: { label: 'Breach monitor', icon: 'shield', feature: 'breachMonitor', render: renderBreachPanel },
};
