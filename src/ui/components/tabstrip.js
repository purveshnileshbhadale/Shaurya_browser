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

    const indicators = [];
    if (tab.loading) indicators.push(h('span.tab-indicator', {}, h('span.spinner')));
    if (tab.audible && !tab.muted) {
      indicators.push(h('button.tab-indicator', {
        title: 'Mute tab',
        onclick: (e) => { e.stopPropagation(); invoke('tabs.mute', { id: tab.id, muted: true }); },
      }, icon('volume')));
    }
    if (tab.muted) {
      indicators.push(h('button.tab-indicator', {
        title: 'Unmute tab',
        onclick: (e) => { e.stopPropagation(); invoke('tabs.mute', { id: tab.id, muted: false }); },
      }, icon('mute')));
    }
    if (tab.hibernated) {
      indicators.push(h('span.tab-indicator', { title: 'Suspended to save memory' }, icon('sleep')));
    }

    return h('div', {
      class: classes,
      draggable: 'true',
      title: `${tab.title}\n${tab.url}`,
      dataset: { key: tab.id },
    },
    h('span.tab-favicon', {}, favicon(tab.url, tab.favicon)),
    !tab.pinned && h('span.tab-title', { text: tab.title || 'Loading…' }),
    ...indicators,
    !tab.pinned && h('button.tab-close', { title: 'Close tab' }, icon('close')));
  }

  subscribe('tabs', render);
  render();

  return { render, element: container };
}

/** Right-click menu for a tab. Rendered by the popover module. */
function showTabMenu(tabId, x, y) {
  window.dispatchEvent(new CustomEvent('aether:tabmenu', { detail: { tabId, x, y } }));
}
