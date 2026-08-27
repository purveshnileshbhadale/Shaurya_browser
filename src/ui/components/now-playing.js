/**
 * The now-playing bar.
 *
 * Sits at the foot of the sidebar and only exists while something is playing,
 * because a permanent empty player is furniture. Three jobs, in order of how
 * often they are wanted:
 *
 *   1. **Pause it.** Someone hears sound and wants it to stop. That is one
 *      click, always in the same place, without hunting for the tab.
 *   2. **Find it.** Clicking the title jumps to the tab making the noise —
 *      the "which of my forty tabs is that" problem every browser has.
 *   3. **Know what it is.** Title, artist and cover, from the page's own
 *      Media Session metadata.
 *
 * The progress line is deliberately a hairline rather than a scrubber. A
 * draggable seek bar at sidebar width would be a 2px target that gets nudged
 * by accident; the panel offers seeking where there is room for it.
 */
import { h, icon, clear } from '../core/dom.js';
import { state, subscribe, invoke, toast } from '../core/store.js';

export function createNowPlaying({ container }) {
  let currentId = null;
  let currentArt = null;

  const art = h('div.np-art');
  const title = h('div.np-title');
  const subtitle = h('div.np-subtitle');

  const playPause = h('button.np-btn.np-play', {
    onclick: (event) => {
      event.stopPropagation();
      invoke('media.control', { action: 'playpause' })
        .catch((err) => toast(err.message, 'error'));
    },
  });

  const prev = h('button.np-btn', {
    title: 'Previous',
    onclick: (event) => {
      event.stopPropagation();
      invoke('media.control', { action: 'previous' }).catch(() => {});
    },
  }, icon('back'));

  const next = h('button.np-btn', {
    title: 'Next',
    onclick: (event) => {
      event.stopPropagation();
      invoke('media.control', { action: 'next' }).catch(() => {});
    },
  }, icon('forward'));

  const progress = h('div.np-progress', {}, h('i'));

  const body = h('div.np-body', {}, title, subtitle);

  // The whole row (except the buttons) reveals the tab. That is the largest
  // possible target for the second-most-common intent.
  const root = h('div.now-playing', {
    role: 'group',
    'aria-label': 'Now playing',
    onclick: () => {
      if (currentId) invoke('media.reveal', { tabId: currentId }).catch(() => {});
    },
  }, art, body, h('div.np-controls', {}, prev, playPause, next), progress);

  container.appendChild(root);

  subscribe('media', render);
  render();

  function render() {
    const media = state.media || {};
    const session = media.active
      || (media.sessions || []).find((s) => s.playing)
      || (media.sessions || [])[0];

    // No media anywhere: collapse to nothing rather than showing an empty
    // player. The CSS animates the height so this does not jolt the sidebar.
    if (!session || !media.backgroundPlay) {
      root.dataset.visible = 'false';
      currentId = null;
      return;
    }

    root.dataset.visible = 'true';
    root.dataset.playing = String(session.playing);
    currentId = session.tabId;

    title.textContent = session.title || 'Untitled';
    title.title = session.title || '';

    // Artist reads better than the origin, but the origin is what identifies
    // *which tab* — so show the artist when there is one and the host when
    // there is not.
    const host = hostOf(session.origin);
    subtitle.textContent = session.artist || host;
    subtitle.title = [session.artist, session.album, host].filter(Boolean).join(' · ');

    // Only swap the image when the source actually changed, or every
    // two-second position update would restart the image load and flicker.
    if (session.artwork !== currentArt) {
      currentArt = session.artwork;
      clear(art);
      if (session.artwork) {
        art.appendChild(h('img', {
          src: session.artwork,
          alt: '',
          loading: 'lazy',
          // A broken cover should degrade to the glyph, not to a broken-image
          // icon sitting in the browser's own chrome.
          onerror: (event) => { event.target.remove(); art.appendChild(icon('volume')); },
        }));
      } else {
        art.appendChild(icon(session.hasVideo ? 'screen' : 'volume'));
      }
    }

    clear(playPause);
    playPause.appendChild(icon(session.playing ? 'pause' : 'play'));
    playPause.title = session.playing ? 'Pause' : 'Play';
    playPause.setAttribute('aria-label', playPause.title);

    // Transport buttons the page does not implement are hidden rather than
    // disabled: a greyed-out next button still invites a click.
    prev.hidden = !session.canPrevious;
    next.hidden = !session.canNext;

    const fill = progress.firstElementChild;
    if (session.duration && session.position != null) {
      fill.style.width = `${Math.min(100, (session.position / session.duration) * 100)}%`;
      progress.hidden = false;
    } else {
      progress.hidden = true;
    }
  }

  return { element: root, refresh: render };
}

function hostOf(origin) {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
