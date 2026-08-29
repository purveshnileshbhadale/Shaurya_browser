/**
 * The study blocker's interstitial (spec §6).
 *
 * Two reasons land here and they need different copy: a site on the block
 * list during a focus phase, and a site that has used up its daily time
 * limit. Conflating them would leave the user guessing why a site they never
 * blocked stopped loading.
 */
const params = new URLSearchParams(location.search);
const reason = params.get('reason') || 'focus';
const host = params.get('host') || '';

const hostEl = document.getElementById('host');
const reasonEl = document.getElementById('reason');
const headline = document.getElementById('headline');
const clock = document.getElementById('clock');
const phase = document.getElementById('phase');

if (host) hostEl.textContent = host;

if (reason === 'limit') {
  headline.textContent = 'Time is up here';
  reasonEl.textContent = 'has used its time limit for today. It unblocks at midnight.';
  // A daily limit has no countdown worth showing — "14 hours" is not
  // information anyone acts on.
} else {
  headline.textContent = 'Not right now';
  reasonEl.textContent = 'is on your block list while you focus.';
  startCountdown();
}

/**
 * Poll the timer.
 *
 * A second-resolution countdown on a page nobody should be looking at is not
 * worth a subscription, so this polls at 1Hz through the same read-only API
 * the other internal pages use, and stops as soon as the phase changes.
 */
function startCountdown() {
  const tick = async () => {
    let state;
    try {
      const response = await fetch('shaurya://api/study-timer');
      if (!response.ok) return;
      state = await response.json();
    } catch {
      return;   // the timer is not the point of this page; fail quiet
    }

    if (!state?.running) {
      // The session ended while this page was open. Say so rather than
      // leaving a frozen clock implying it is still counting down.
      clock.hidden = true;
      phase.hidden = false;
      phase.textContent = 'The session has ended — reload to continue.';
      clearInterval(handle);
      return;
    }

    clock.hidden = false;
    phase.hidden = false;

    const total = Math.max(0, state.remainingMs || 0);
    const minutes = Math.floor(total / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    clock.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
    phase.textContent = state.phase === 'focus'
      ? `Focus · round ${state.round} of ${state.rounds}`
      : 'On a break — this site is available again';
  };

  const handle = setInterval(tick, 1000);
  tick();
}
