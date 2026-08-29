/**
 * Tab strip — vertical sidebar or horizontal strip (spec §2).
 *
 * Both orientations render from the same model; only the container changes.
 * Ordering, grouping and drag-and-drop all resolve through the main process,
 * so the strip is a pure projection of authoritative state and cannot drift
 * out of sync with the real tab list after a fast drag.
 */
import { h, icon, favicon, reconcile, delegate, clear } from '../core/dom.js';
import { state, subscribe, invoke, selectors } from '../core/store.js';

export function createTabStrip({ container, orientation }) {
  const isVertical = orientation === 'vertical';
  let dragState = null;

  // ---- interaction (delegated once, survives every re-render) -----------

  delegate(container, 'click', '.tab', (event, el) => {
    if (event.target.closest('.tab-close')) return;
    invoke('tabs.activate', { id: el.dataset.key });
  });

  delegate(container, 'click', '.tab-close', (event, el) => {
    event.stopPropagation();
    invoke('tabs.close', { id: el.closest('.tab').dataset.key });
  });

  delegate(container, 'auxclick', '.tab', (event, el) => {
    // Middle-click closes, as in every other browser.
    if (event.button === 1) {
      event.preventDefault();
      invoke('tabs.close', { id: el.dataset.key });
    }
  });

  delegate(container, 'click', '.tab-group-head', (_event, el) => {
    invoke('groups.toggleCollapse', { id: el.closest('.tab-group').dataset.groupId });
  });

  delegate(container, 'contextmenu', '.tab', (event, el) => {
    event.preventDefault();
    showTabMenu(el.dataset.key, event.clientX, event.clientY);
  });

  // ---- drag to reorder -------------------------------------------------

  delegate(container, 'dragstart', '.tab', (event, el) => {
    dragState = { id: el.dataset.key };
    el.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    // Some platforms require data for the drag to start at all.
    event.dataTransfer.setData('text/plain', el.dataset.key);
  });

  delegate(container, 'dragend', '.tab', (_event, el) => {
    el.classList.remove('is-dragging');
    clearDropMarkers();
    dragState = null;
  });

  delegate(container, 'dragover', '.tab', (event, el) => {
    if (!dragState || el.dataset.key === dragState.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    // Which half of the target is the cursor over? That decides whether the
    // dragged tab lands before or after it.
    const rect = el.getBoundingClientRect();
    const before = isVertical
      ? event.clientY < rect.top + rect.height / 2
      : event.clientX < rect.left + rect.width / 2;

    clearDropMarkers();
    el.classList.add(before ? 'drop-before' : 'drop-after');
    dragState.target = el.dataset.key;
    dragState.before = before;
  });

  delegate(container, 'drop', '.tab', (event) => {
    event.preventDefault();
    if (!dragState?.target) return;

    const order = visibleTabIds();
    const from = order.indexOf(dragState.id);
    let to = order.indexOf(dragState.target);
    if (from < 0 || to < 0) return;

    // Removing the dragged item first shifts every later index down by one.
    if (!dragState.before) to += 1;
    if (from < to) to -= 1;

    clearDropMarkers();
    invoke('tabs.move', { id: dragState.id, index: to });
    dragState = null;
  });

  function clearDropMarkers() {
    for (const el of container.querySelectorAll('.drop-before, .drop-after')) {
      el.classList.remove('drop-before', 'drop-after');
    }
  }

  function visibleTabIds() {
    return [...container.querySelectorAll('.tab')].map((el) => el.dataset.key);
  }

  // ---- rendering -------------------------------------------------------

  function render() {
    const { tabs, groups, activeId, activeWorkspaceId } = state.tabs;

    // Workspace filtering: a tab belongs to a workspace via its group.
    const inWorkspace = (tab) => {
      if (activeWorkspaceId === null || activeWorkspaceId === undefined) return true;
      if (!tab.groupId) return false;
      return groups.find((g) => g.id === tab.groupId)?.workspaceId === activeWorkspaceId;
    };

    const visible = tabs.filter(inWorkspace);
    const pinned = visible.filter((t) => t.pinned);
    const unpinned = visible.filter((t) => !t.pinned);

    clear(container);

    if (pinned.length) {
      const row = h('div.pinned-row');
      for (const tab of pinned) row.appendChild(tabRow(tab, activeId));
      container.appendChild(row);
    }

    // Group consecutive runs so a group renders as one contiguous band.
    let index = 0;
    while (index < unpinned.length) {
      const tab = unpinned[index];
      if (!tab.groupId) {
        container.appendChild(tabRow(tab, activeId));
        index++;
        continue;
      }

      const group = groups.find((g) => g.id === tab.groupId);
      const run = [];
      while (index < unpinned.length && unpinned[index].groupId === tab.groupId) {
        run.push(unpinned[index]);
        index++;
      }
      container.appendChild(groupBlock(group, run, activeId));
    }

    if (!visible.length) {
      container.appendChild(h('div.empty', {}, 'No tabs in this workspace'));
    }
  }

  function groupBlock(group, tabsInGroup, activeId) {
    const collapsed = group?.collapsed;
    const body = h('div.tab-group-body');
    for (const tab of tabsInGroup) body.appendChild(tabRow(tab, activeId));

    return h('div.tab-group', {
      dataset: { groupId: group?.id || '', collapsed: String(Boolean(collapsed)) },
      style: { '--group-color': group?.color || 'var(--accent)' },
    },
    h('div.tab-group-head', {},
      icon('chevronDown', { class: 'tab-group-chevron' }),
      h('span.tab-group-swatch'),
      h('span.truncate', { text: group?.name || 'Group' }),
      h('span.tab-group-count', { text: String(tabsInGroup.length) })),
    body);
  }

  function tabRow(tab, activeId) {
    const classes = {
      tab: true,
      'is-active': tab.id === activeId,
      'is-pinned': tab.pinned,
      'is-hibernated': tab.hibernated,
    };

    // A tab that is playing media, whether or not it is currently audible.
    // `audible` alone misses a paused track, and that is exactly the tab
    // someone is hunting for when they scan the strip.
    const media = (state.media?.sessions || []).find((s) => s.tabId === tab.id);
    classes['is-playing'] = Boolean(media?.playing);

    const indicators = [];
    if (tab.loading) indicators.push(h('span.tab-indicator', {}, h('span.spinner')));

    // One control, three states, always in the same place — rather than a
    // speaker that appears only while sound is coming out and shifts the
    // title around it every time a track pauses.
    if (tab.audible || tab.muted || media) {
      const muted = tab.muted;
      indicators.push(h('button.tab-indicator.tab-audio', {
        dataset: { state: muted ? 'muted' : media?.playing ? 'playing' : 'idle' },
        title: muted ? 'Unmute tab'
          : media?.playing ? `Playing: ${media.title || 'media'} — click to mute`
            : 'Mute tab',
        'aria-label': muted ? 'Unmute tab' : 'Mute tab',
        onclick: (e) => {
          e.stopPropagation();
          invoke('tabs.mute', { id: tab.id, muted: !muted });
        },
      }, icon(muted ? 'mute' : 'volume')));
    }

    if (tab.hibernated) {
      indicators.push(h('span.tab-indicator', { title: 'Suspended to save memory' }, icon('sleep')));
    }

    // The native tooltip is the only place the full URL fits in a 248px
    // sidebar, so it carries what the row had to truncate.
    const tooltip = [
      tab.title,
      tab.url,
      media?.playing ? `▸ ${[media.title, media.artist].filter(Boolean).join(' — ')}` : null,
      tab.hibernated ? 'Suspended — click to wake' : null,
    ].filter(Boolean).join('\n');

    return h('div', {
      class: classes,
      draggable: 'true',
      title: tooltip,
      dataset: { key: tab.id },
      // The strip is a list of buttons to a screen reader, not a pile of divs.
      role: 'tab',
      'aria-selected': String(tab.id === activeId),
    },
    h('span.tab-favicon', {}, favicon(tab.url, tab.favicon)),
    !tab.pinned && h('span.tab-title', { text: tab.title || 'Loading…' }),
    ...indicators,
    !tab.pinned && h('button.tab-close', {
      title: 'Close tab',
      'aria-label': `Close ${tab.title || 'tab'}`,
    }, icon('close')));
  }

  // Media state changes the audio indicator, so the strip listens for it too.
  subscribe(['tabs', 'media'], render);
  render();

  return { render, element: container };
}

/** Right-click menu for a tab. Rendered by the popover module. */
function showTabMenu(tabId, x, y) {
  window.dispatchEvent(new CustomEvent('shaurya:tabmenu', { detail: { tabId, x, y } }));
}
