/**
 * Side panels: the AI assistant, notes, and the developer tools
 * (REST client, WebSocket inspector, localhost manager, utilities).
 *
 * One panel host with swappable content, so opening a panel is a width
 * change in the main process plus a content swap here — never a re-layout of
 * the whole chrome.
 */
import { h, icon, clear, delegate, formatBytes, formatRelative } from '../core/dom.js';
import { state, subscribe, invoke, toast, selectors } from '../core/store.js';

export function createPanel({ container }) {
  let current = null;
  let disposeContent = null;

  const title = h('div.panel-title');
  const head = h('div.panel-head', {}, title,
    h('button.icon-btn', { title: 'Close panel', onclick: () => close() }, icon('close')));
  const body = h('div.panel-body');
  const resize = h('div.panel-resize');

  container.append(resize, head, body);
  wireResize(resize);

  function open(kind) {
    if (current === kind) return close();
    current = kind;
    container.classList.add('is-open');

    clear(title);
    clear(body);
    disposeContent?.();

    const view = VIEWS[kind];
    if (!view) {
      body.appendChild(h('div.empty', {}, `Unknown panel "${kind}"`));
      return;
    }
    title.append(icon(view.icon), h('span', { text: view.label }));
    disposeContent = view.render(body);

    invoke('layout.setPanel', { kind });
  }

  function close() {
    current = null;
    container.classList.remove('is-open');
    disposeContent?.();
    disposeContent = null;
    invoke('layout.setPanel', { kind: null });
  }

  function wireResize(handle) {
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = container.getBoundingClientRect().width;

      const move = (e) => {
        // The panel is anchored right, so dragging left widens it.
        const width = Math.round(startWidth + (startX - e.clientX));
        container.style.setProperty('--panel-w', `${width}px`);
      };
      const up = (e) => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        invoke('layout.setPanelWidth', {
          width: Math.round(startWidth + (startX - e.clientX)),
        });
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  return { open, close, get current() { return current; }, element: container };
}

// ===========================================================================
// AI assistant
// ===========================================================================

function renderAiPanel(body) {
  const log = h('div.ai-log');
  const sources = h('div.ai-sources');

  const input = h('textarea.ai-input', {
    placeholder: 'Ask about this page…',
    rows: 2,
    onkeydown: (event) => {
      // Enter sends; Shift+Enter is a newline — the convention every chat UI
      // uses, and the one users' fingers already expect.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    oninput: (event) => {
      const el = event.target;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    },
  });

  const modelSelect = h('select.ai-model', {
    onchange: () => invoke('settings.set', { path: 'ai.defaultModel', value: modelSelect.value }),
  });

  const multiTab = h('button.chip', {
    onclick: async () => {
      const granted = !state.ai.multiTabGranted;
      await invoke('ai.grantMultiTab', { granted });
      state.ai.multiTabGranted = granted;
      renderSources();
      toast(granted
        ? 'The assistant can now read your other tabs in this window'
        : 'Multi-tab access revoked');
    },
  }, icon('layers'), h('span', { text: 'Multi-tab' }));

  const actions = h('div.ai-actions', {},
    quickAction('Summarise', 'note', () => invoke('ai.summarize', { length: 'medium' })),
    quickAction('Key points', 'sparkle', () => ask('What are the key points on this page?')),
    quickAction('Translate', 'translate', () => {
      const language = prompt('Translate this page into which language?', 'Spanish');
      if (language) invoke('ai.translate', { targetLanguage: language });
    }),
    quickAction('Compare tabs', 'compare', () => invoke('ai.compareTabs', {})),
    quickAction('Research', 'search', () => {
      const question = input.value.trim() || prompt('What should I research?');
      if (question) { input.value = ''; invoke('ai.research', { question }); }
    }));

  body.append(sources, actions, log, h('div.ai-composer', {}, input,
    h('div.ai-composer-row', {}, modelSelect, multiTab,
      h('button.btn.btn-primary', { onclick: submit }, icon('send'), 'Send'))));

  function quickAction(label, iconName, onclick) {
    return h('button.chip', { onclick }, icon(iconName), h('span', { text: label }));
  }

  function ask(prompt) {
    return invoke('ai.chat', { prompt });
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    state.ai.messages.push({ role: 'user', text });
    input.value = '';
    input.style.height = 'auto';
    renderLog();
    invoke('ai.chat', { prompt: text, conversationId: state.ai.conversationId });
  }

  async function loadProviders() {
    const providers = await invoke('ai.providers', {}, { quiet: true }).catch(() => null);
    if (!providers) return;
    clear(modelSelect);
    modelSelect.append(
      h('option', {
        value: 'local',
        text: providers.local.running ? 'On-device' : 'On-device (not running)',
        disabled: !providers.local.running,
      }),
      h('option', {
        value: 'hosted',
        text: providers.hosted.available ? `Hosted · ${providers.hosted.model}` : 'Hosted (no API key)',
        disabled: !providers.hosted.available,
      })
    );
    modelSelect.value = providers.default;
  }

  function renderSources() {
    clear(sources);
    const context = state.ai.sources || [];
    if (!context.length) {
      sources.appendChild(h('div.ai-source.dim', {}, icon('info'),
        h('span', { text: 'The assistant reads the active tab when you ask.' })));
      return;
    }
    for (const source of context) {
      sources.appendChild(h('div.ai-source', {},
        icon(source.role === 'active' ? 'tab' : 'layers'),
        h('span.truncate', { text: source.title || source.url }),
        h('span.dimmer', { text: `${Math.round(source.chars / 1000)}k` })));
    }
  }

  function renderLog() {
    clear(log);

    for (const message of state.ai.messages) {
      if (message.role === 'user') {
        log.appendChild(h('div.ai-msg.is-user', {}, h('div.ai-bubble', { text: message.text })));
        continue;
      }
      if (message.role === 'error') {
        log.appendChild(h('div.ai-msg.is-error', {}, icon('warning'),
          h('span', { text: message.text })));
        continue;
      }

      const parts = [];
      if (message.thinking) {
        parts.push(h('details.ai-thinking', {},
          h('summary', { text: 'Reasoning' }),
          h('div', { text: message.thinking })));
      }
      for (const tool of message.tools || []) {
        parts.push(h('div.ai-tool', {}, icon('command'),
          h('span', { text: `Used ${tool.name}` })));
      }
      parts.push(h('div.ai-markdown', { html: renderMarkdownLite(message.text || '') }));
      log.appendChild(h('div.ai-msg.is-assistant', {}, ...parts));
    }

    if (state.ai.streaming) {
      log.appendChild(h('div.ai-msg.is-assistant', {}, h('span.spinner')));
    }

    // A confirmation card for any action with a real-world effect (spec §4).
    if (state.ai.confirm) {
      log.appendChild(confirmCard(state.ai.confirm));
    }

    log.scrollTop = log.scrollHeight;
  }

  function confirmCard(request) {
    return h('div.ai-confirm', {},
      h('div.ai-confirm-head', {}, icon('warning'),
        h('strong', { text: 'Confirm before continuing' })),
      h('p', { text: request.summary || `The assistant wants to run "${request.tool}".` }),
      request.url && h('p.dimmer.truncate', { text: request.url }),
      h('pre.ai-confirm-args', { text: JSON.stringify(request.input, null, 2) }),
      h('div.ai-confirm-actions', {},
        h('button.btn', {
          onclick: () => respond(false),
        }, 'Decline'),
        h('button.btn.btn-primary', {
          onclick: () => respond(true),
        }, 'Allow once')));
  }

  async function respond(approved) {
    const request = state.ai.confirm;
    state.ai.confirm = null;
    renderLog();
    await invoke('ai.confirmAction', { id: request.id, approved });
  }

  const unsubscribe = subscribe('ai', () => { renderLog(); renderSources(); });
  loadProviders();
  renderLog();
  renderSources();
  return unsubscribe;
}

// ===========================================================================
// Notes
// ===========================================================================

function renderNotesPanel(body) {
  const list = h('div.note-list');

  const generate = h('button.btn.btn-primary', {
    onclick: async () => {
      generate.disabled = true;
      generate.textContent = 'Reading page…';
      try {
        await invoke('notes.generate', {});
        toast('Notes created', 'success');
        await load();
      } finally {
        generate.disabled = false;
        clear(generate);
        generate.append(icon('sparkle'), document.createTextNode(' Generate from this page'));
      }
    },
  }, icon('sparkle'), ' Generate from this page');

  body.append(h('div.note-toolbar', {}, generate), list);

  async function load() {
    const notes = await invoke('notes.list', {}, { quiet: true }).catch(() => []);
    clear(list);
    if (!notes.length) {
      list.appendChild(h('div.empty', {},
        'No notes yet. Open an article, a video with captions or a PDF, then generate notes.'));
      return;
    }
    for (const note of notes) {
      list.appendChild(h('div.note-card', {},
        h('div.note-title', { text: note.title }),
        h('div.note-excerpt', { text: note.excerpt }),
        h('div.note-meta', {},
          h('span', { text: formatRelative(note.updated) }),
          note.sourceKind && h('span.chip', { text: note.sourceKind }),
          note.hasQuiz && h('span.chip', { text: 'Quiz' })),
        h('div.note-actions', {},
          exportButton(note, 'markdown', 'Markdown'),
          exportButton(note, 'pdf', 'PDF'),
          exportButton(note, 'obsidian', 'Obsidian'),
          exportButton(note, 'notion', 'Notion'),
          h('button.icon-btn', {
            title: 'Delete note',
            onclick: async () => { await invoke('notes.remove', { id: note.id }); load(); },
          }, icon('trash')))));
    }
  }

  function exportButton(note, target, label) {
    return h('button.chip', {
      onclick: async () => {
        const result = await invoke('notes.export', { id: note.id, target });
        if (result?.exported) toast(`Exported to ${label}`, 'success');
      },
    }, label);
  }

  const unsubscribe = subscribe('notes', load);
  load();
  return unsubscribe;
}

// ===========================================================================
// Developer tools
// ===========================================================================

function renderDevPanel(body) {
  const tabs = ['REST', 'Sockets', 'Servers', 'Utilities'];
  let active = 'REST';

  const tabBar = h('div.panel-tabs');
  const content = h('div.dev-content');
  body.append(tabBar, content);

  function renderTabs() {
    clear(tabBar);
    for (const name of tabs) {
      tabBar.appendChild(h('button.panel-tab', {
        class: { 'is-active': name === active },
        text: name,
        onclick: () => { active = name; renderTabs(); renderContent(); },
      }));
    }
  }

  function renderContent() {
    clear(content);
    if (active === 'REST') renderRestClient(content);
    else if (active === 'Sockets') renderSockets(content);
    else if (active === 'Servers') renderServers(content);
    else renderUtilities(content);
  }

  renderTabs();
  renderContent();
  return () => {};
}

/** REST client (spec §5). */
function renderRestClient(root) {
  const method = h('select.rest-method', {},
    ...['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
      .map((m) => h('option', { value: m, text: m })));
  const url = h('input.rest-url', { placeholder: 'https://api.example.com/v1/things', spellcheck: 'false' });
  const headers = h('textarea.rest-body', { placeholder: 'Header-Name: value\nOne per line', rows: 3 });
  const requestBody = h('textarea.rest-body', { placeholder: 'Request body (JSON, text…)', rows: 5 });
  const useCookies = h('input', { type: 'checkbox' });
  const output = h('div.rest-output');

  const send = h('button.btn.btn-primary', {
    onclick: async () => {
      send.disabled = true;
      clear(output);
      output.appendChild(h('div.empty', {}, h('span.spinner')));
      try {
        const response = await invoke('http.send', {
          method: method.value,
          url: url.value,
          headers: parseHeaders(headers.value),
          body: requestBody.value || undefined,
          useBrowserCookies: useCookies.checked,
        });
        renderResponse(response);
      } catch (err) {
        clear(output);
        output.appendChild(h('div.rest-error', {}, icon('warning'), h('span', { text: err.message })));
      } finally {
        send.disabled = false;
      }
    },
  }, icon('send'), ' Send');

  root.append(
    h('div.rest-line', {}, method, url, send),
    h('label.rest-label', {}, 'Headers'), headers,
    h('label.rest-label', {}, 'Body'), requestBody,
    h('label.rest-check', {}, useCookies,
      h('span', { text: 'Send this profile’s cookies' })),
    output
  );

  function renderResponse(response) {
    clear(output);
    const ok = response.status >= 200 && response.status < 300;
    output.append(
      h('div.rest-status', {},
        h('span.chip', {
          class: ok ? 'is-ok' : 'is-bad',
          text: `${response.status} ${response.statusText}`,
        }),
        h('span.chip', { text: `${Math.round(response.timing.total)} ms` }),
        h('span.chip', { text: formatBytes(response.size.decoded) })),
      // A waterfall of the phases is what makes a slow endpoint diagnosable.
      h('div.rest-timing', {},
        timingBar('DNS', response.timing.dns, response.timing.total),
        timingBar('Connect', response.timing.connect, response.timing.total),
        timingBar('TLS', response.timing.tls, response.timing.total),
        timingBar('TTFB', response.timing.ttfb, response.timing.total),
        timingBar('Download', response.timing.download, response.timing.total)),
      h('details.rest-headers', {}, h('summary', { text: 'Response headers' }),
        h('pre', { text: Object.entries(response.headers)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n') })),
      h('pre.rest-body-out', { text: prettyBody(response) })
    );
  }

  function timingBar(label, value, total) {
    if (value == null) return null;
    const pct = total ? Math.max(1, Math.round((value / total) * 100)) : 0;
    return h('div.timing-row', {},
      h('span.timing-label', { text: label }),
      h('span.timing-track', {}, h('span.timing-fill', { style: { width: `${pct}%` } })),
      h('span.timing-value', { text: `${Math.round(value)}ms` }));
  }

  function prettyBody(response) {
    if (response.bodyBase64) return `(binary, ${formatBytes(response.size.decoded)})`;
    const text = response.body || '';
    if (/json/i.test(response.contentType || '')) {
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch { /* not actually JSON */ }
    }
    return text.slice(0, 200_000);
  }

  function parseHeaders(text) {
    const out = {};
    for (const line of String(text).split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return out;
  }
}

/** WebSocket inspector (spec §5). */
function renderSockets(root) {
  const list = h('div.ws-list');
  const frames = h('div.ws-frames');
  root.append(
    h('div.rest-line', {},
      h('button.btn', { onclick: refresh }, icon('refresh'), ' Capture page sockets')),
    list, frames);

  async function refresh() {
    const sockets = await invoke('ws.sockets', {}, { quiet: true }).catch(() => []);
    clear(list);
    if (!sockets.length) {
      list.appendChild(h('div.empty', {},
        'No sockets yet. Open a page that uses WebSockets — frames appear live.'));
      return;
    }
    for (const socket of sockets) {
      list.appendChild(h('div.ws-row', {
        onclick: () => showFrames(socket.id),
      },
      h('span.ws-state', { class: `is-${socket.state}`, text: socket.state }),
      h('span.truncate', { text: socket.url }),
      h('span.dimmer', { text: `${socket.frameCount} frames` })));
    }
  }

  async function showFrames(socketId) {
    const rows = await invoke('ws.frames', { socketId }, { quiet: true }).catch(() => []);
    clear(frames);
    for (const frame of rows.slice(-200)) {
      frames.appendChild(h('div.ws-frame', { class: `is-${frame.direction}` },
        h('span.ws-arrow', { text: frame.direction === 'sent' ? '↑' : '↓' }),
        h('span.ws-text.truncate', { text: frame.text }),
        h('span.dimmer', { text: formatRelative(frame.at) })));
    }
  }

  const unsubscribe = subscribe('ws', refresh);
  refresh();
  return unsubscribe;
}

/** Localhost manager (spec §5). */
function renderServers(root) {
  const list = h('div.server-list');
  const ports = h('div.port-list');

  root.append(
    h('div.rest-line', {},
      h('button.btn.btn-primary', {
        onclick: async () => { await invoke('localservers.start', {}); refresh(); },
      }, icon('server'), ' Serve a folder'),
      h('button.btn', { onclick: scan }, icon('search'), ' Scan ports')),
    list, ports);

  async function refresh() {
    const servers = await invoke('localservers.list', {}, { quiet: true }).catch(() => []);
    clear(list);
    for (const server of servers) {
      list.appendChild(h('div.server-row', {},
        h('a.server-url', {
          text: server.url,
          onclick: () => invoke('tabs.create', { url: server.url }),
        }),
        h('span.truncate.dimmer', { text: server.root }),
        h('button.icon-btn', {
          title: 'Stop',
          onclick: async () => { await invoke('localservers.stop', { id: server.id }); refresh(); },
        }, icon('stop'))));
    }
  }

  async function scan() {
    clear(ports);
    ports.appendChild(h('div.empty', {}, h('span.spinner')));
    const open = await invoke('localservers.scanPorts', {}, { quiet: true }).catch(() => []);
    clear(ports);
    if (!open.length) {
      ports.appendChild(h('div.empty', {}, 'Nothing listening on the usual dev ports'));
      return;
    }
    for (const entry of open) {
      ports.appendChild(h('div.port-row', {
        onclick: () => invoke('tabs.create', { url: entry.url }),
      },
      h('span.chip', { text: String(entry.port) }),
      h('span', { text: entry.url }),
      entry.ours && h('span.chip', { text: 'Aether' })));
    }
  }

  const unsubscribe = subscribe('servers', refresh);
  refresh();
  return unsubscribe;
}

/** Regex, encoders, JWT (spec §5). */
function renderUtilities(root) {
  const pattern = h('input.rest-url', { placeholder: '\\b\\w+@\\w+\\.\\w+\\b', spellcheck: 'false' });
  const subject = h('textarea.rest-body', { placeholder: 'Test string', rows: 4 });
  const regexOut = h('div.util-out');

  const codecInput = h('textarea.rest-body', { placeholder: 'Text or token', rows: 4 });
  const codecOut = h('div.util-out');

  root.append(
    h('h4.util-head', {}, icon('regex'), ' Regex tester'),
    pattern, subject, regexOut,
    h('h4.util-head', {}, icon('code'), ' Encode / decode'),
    codecInput,
    h('div.rest-line', {},
      codecButton('Base64 →', () => invoke('tools.encode', { kind: 'base64', value: codecInput.value })),
      codecButton('→ Base64', () => invoke('tools.decode', { kind: 'base64', value: codecInput.value })),
      codecButton('URL →', () => invoke('tools.encode', { kind: 'uri-component', value: codecInput.value })),
      codecButton('→ URL', () => invoke('tools.decode', { kind: 'uri-component', value: codecInput.value })),
      codecButton('JWT', () => invoke('tools.jwt', { token: codecInput.value })),
      codecButton('Hash', () => invoke('tools.hash', { value: codecInput.value }))),
    codecOut);

  const run = debounce(async () => {
    if (!pattern.value) { clear(regexOut); return; }
    const result = await invoke('tools.regex', {
      pattern: pattern.value, subject: subject.value,
    }, { quiet: true }).catch(() => null);
    clear(regexOut);
    if (!result) return;
    if (!result.valid) {
      regexOut.appendChild(h('div.rest-error', {}, icon('warning'), h('span', { text: result.error })));
      return;
    }
    regexOut.append(
      h('div.rest-line', {},
        h('span.chip', { text: `${result.matchCount} matches` }),
        result.timedOut && h('span.chip', { text: 'timed out' })),
      ...(result.explanation || []).map((note) => h('div.dimmer', { text: note })),
      h('pre', { text: result.matches.slice(0, 40)
        .map((m) => `${m.index}: ${m.match}${m.groups.length ? `  [${m.groups.join(', ')}]` : ''}`)
        .join('\n') }));
  }, 200);

  pattern.addEventListener('input', run);
  subject.addEventListener('input', run);

  function codecButton(label, fn) {
    return h('button.btn', {
      onclick: async () => {
        const result = await fn().catch((err) => ({ error: err.message }));
        clear(codecOut);
        codecOut.appendChild(h('pre', { text: JSON.stringify(result, null, 2) }));
      },
    }, label);
  }

  return () => {};
}

// ===========================================================================
// Registry
// ===========================================================================

const VIEWS = {
  ai: { label: 'Assistant', icon: 'sparkle', render: renderAiPanel },
  notes: { label: 'Notes', icon: 'note', render: renderNotesPanel },
  dev: { label: 'Developer', icon: 'code', render: renderDevPanel },
};

// ===========================================================================
// Helpers
// ===========================================================================

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Minimal Markdown for assistant output.
 *
 * Escapes first, so a model that echoes page content containing `<script>`
 * cannot inject it into the chrome renderer — which is privileged.
 */
function renderMarkdownLite(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return escaped
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) =>
      `<pre class="code"><code>${code}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
    .replace(/\[(\d+)\]/g, '<sup class="cite">$1</sup>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hupol])(.+)$/gm, '<p>$1</p>');
}
