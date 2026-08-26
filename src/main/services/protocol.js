'use strict';
/**
 * The `aether://` scheme that serves Aether's own pages (start page,
 * settings, onboarding, notes, reader, JSON viewer, error pages).
 *
 * Using a registered privileged scheme rather than `file://` matters:
 *
 *   - `file://` pages share one origin, so the start page and any local HTML
 *     the user opens could read each other's storage. `aether://` pages get
 *     a real, isolated origin per host.
 *   - It gives us a stable, spoof-resistant thing to show in the address bar.
 *   - It lets us keep `webSecurity` on everywhere.
 *
 * Every path is resolved and then checked to still be inside its page root,
 * so a crafted `aether://settings/../../../etc/passwd` cannot escape.
 */
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { protocol, session, net } = require('electron');
const paths = require('../util/paths');
const { createLogger } = require('../util/logger');

const log = createLogger('protocol');

const SCHEME = 'aether';

/** host -> directory under src/pages */
const PAGE_ROOTS = {
  start: 'start',
  settings: 'settings',
  onboarding: 'onboarding',
  notes: 'notes',
  json: 'json-viewer',
  markdown: 'markdown',
  reader: 'reader',
  error: 'error',
  // Mode pages (spec §4, §5, §6). `hud` and `teleprompter` render inside
  // always-on-top windows rather than tabs; `blocked` is what the study
  // blocker redirects a cancelled navigation to.
  hud: 'hud',
  teleprompter: 'teleprompter',
  blocked: 'blocked',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Must run *before* `app.whenReady()`. Declares the scheme's capabilities so
 * Chromium treats it as a first-class secure origin.
 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,      // gives it a real origin, so storage is isolated
        secure: true,        // counts as a secure context (crypto.subtle, etc.)
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Sessions that already have the handler, so we never register twice. */
const installed = new WeakSet();

/** Shared roots that any internal page may pull assets from. */
const SHARED_ROOTS = {
  '/_shared/': paths.appPath('src', 'ui'),
  '/_assets/': paths.appPath('assets'),
  // Lets one internal page reuse another's stylesheet without a `..` path,
  // which the containment check would (correctly) refuse.
  '/_pages/': paths.appPath('src', 'pages'),
};

/**
 * Install the handler on a session.
 *
 * This is per-session on purpose, and it is easy to get wrong: the global
 * `protocol` module is an alias for `session.defaultSession.protocol`, so a
 * handler registered there is invisible to every partitioned session. Aether
 * loads every tab in a profile partition, so registering only on the default
 * session makes every `aether://` page fail with ERR_FAILED and no
 * explanation. The profile service calls this for each session it creates.
 *
 * @param {object} deps                     service container
 * @param {Electron.Session} [targetSession] defaults to the default session
 */
function installHandler(deps, targetSession) {
  const target = targetSession || session.defaultSession;

  // Registering twice on one session throws; profiles can be re-materialised.
  if (installed.has(target)) return;
  installed.add(target);

  target.protocol.handle(SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    const host = url.hostname;
    const pathname = decodeURIComponent(url.pathname);

    // --- dynamic endpoints ---------------------------------------------
    // A small JSON surface for internal pages that need data before their
    // scripts can complete an IPC round trip (e.g. the reader's article).
    if (host === 'api') {
      return handleApi(pathname, url, deps);
    }

    // --- shared assets ---------------------------------------------------
    for (const [prefix, root] of Object.entries(SHARED_ROOTS)) {
      if (pathname.startsWith(prefix)) {
        return serveFile(root, pathname.slice(prefix.length), root);
      }
    }

    // --- page bundles ----------------------------------------------------
    const dir = PAGE_ROOTS[host];
    if (!dir) {
      return new Response(`Unknown Aether page: ${host}`, {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    const root = paths.appPath('src', 'pages', dir);
    const rel = pathname === '/' || pathname === '' ? 'index.html' : pathname.slice(1);
    return serveFile(root, rel, root);
  });

  log.debug(`${SCHEME}:// handler installed on ${target.storagePath || 'default'} session`);
}

/**
 * Read a file, refusing anything that resolves outside `root`.
 * @param {string} root      directory the request is confined to
 * @param {string} relative  request-relative path
 */
async function serveFile(root, relative, confineTo) {
  // Normalising first collapses `..` segments; the containment check then
  // catches absolute paths and symlink-style escapes.
  const resolved = path.resolve(root, relative);
  const boundary = path.resolve(confineTo) + path.sep;
  if (resolved !== path.resolve(confineTo) && !resolved.startsWith(boundary)) {
    log.warn(`blocked path traversal attempt: ${relative}`);
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const stat = await fs.stat(resolved);
    const target = stat.isDirectory() ? path.join(resolved, 'index.html') : resolved;
    const body = await fs.readFile(target);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        // Internal pages are local; never let them be framed by a web page.
        'x-frame-options': 'SAMEORIGIN',
        'cache-control': 'no-cache',
      },
    });
  } catch (err) {
    if (err.code === 'ENOENT') return new Response('Not found', { status: 404 });
    log.error(`serve ${relative}: ${err.message}`);
    return new Response('Internal error', { status: 500 });
  }
}

/** `aether://api/...` — small read-only JSON endpoints for internal pages. */
async function handleApi(pathname, url, deps) {
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

  try {
    switch (pathname) {
      // The blocked interstitial's countdown. Read-only and tiny, so the
      // page does not need the privileged IPC surface just to show a clock.
      case '/study-timer':
        return json(deps.student ? deps.student.timerState() : { running: false });

      case '/version':
        return json({
          aether: require(paths.appPath('package.json')).version,
          chromium: process.versions.chrome,
          node: process.versions.node,
          v8: process.versions.v8,
          platform: process.platform,
          arch: process.arch,
        });

      case '/features':
        return json(deps.features.list());

      case '/reader': {
        // The reader page asks for the extracted article by tab id.
        const tabId = url.searchParams.get('tab');
        const article = deps.reader?.get(tabId);
        return article ? json(article) : json({ error: 'not-extracted' }, 404);
      }

      case '/markdown': {
        // Live preview of a local .md file (spec §5).
        const file = url.searchParams.get('file');
        if (!file) return json({ error: 'missing file' }, 400);
        const result = await deps.markdown.render(file);
        return json(result);
      }

      default:
        return json({ error: 'unknown endpoint' }, 404);
    }
  } catch (err) {
    log.error(`api ${pathname}: ${err.message}`);
    return json({ error: err.message }, 500);
  }
}

/**
 * Build an `aether://error/...` URL carrying enough detail for the error
 * page to explain itself without a round trip.
 */
function errorUrl({ code, description, url, kind = 'network' }) {
  const params = new URLSearchParams({
    code: String(code ?? ''),
    description: description || '',
    url: url || '',
    kind,
  });
  return `aether://error/?${params.toString()}`;
}

module.exports = { registerScheme, installHandler, errorUrl, SCHEME, PAGE_ROOTS };
