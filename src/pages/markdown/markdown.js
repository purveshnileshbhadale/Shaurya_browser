/**
 * Live Markdown preview.
 *
 * The file is rendered in the main process (which owns filesystem access)
 * and re-rendered whenever it changes on disk — the "live" part, so saving
 * in an editor updates the preview without a reload.
 */
const file = new URLSearchParams(location.search).get('file');
const doc = document.getElementById('doc');
const pathEl = document.getElementById('path');
const statusEl = document.getElementById('status');

pathEl.textContent = file || '';

let lastMtime = 0;

async function render({ flash = false } = {}) {
  try {
    const response = await fetch(`shaurya://api/markdown?file=${encodeURIComponent(file)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (result.error) throw new Error(result.error);

    if (result.mtime === lastMtime) return;
    lastMtime = result.mtime;

    document.title = result.title;
    // The renderer escapes before it formats and never emits raw HTML from
    // the document, so this markup contains only tags it produced.
    doc.innerHTML = result.html;
    statusEl.textContent = `${(result.bytes / 1024).toFixed(1)} KB · updated ${new Date().toLocaleTimeString()}`;

    if (flash) {
      doc.classList.remove('md-flash');
      void doc.offsetWidth; // restart the animation
      doc.classList.add('md-flash');
    }
  } catch (err) {
    doc.replaceChildren();
    const message = document.createElement('p');
    message.className = 'dim';
    message.textContent = `Could not render this file: ${err.message}`;
    doc.appendChild(message);
  }
}

render();

// Poll for changes. The main process also watches the file, but polling the
// mtime here keeps the page correct even if the watcher could not attach
// (some network and container filesystems do not support inotify).
setInterval(() => render({ flash: true }), 900);
