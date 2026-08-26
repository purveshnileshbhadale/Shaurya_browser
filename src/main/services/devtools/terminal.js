'use strict';
/**
 * Terminal panel (spec §3).
 *
 * This is the single most dangerous feature in the browser, so the
 * constraints are structural rather than advisory:
 *
 *  1. **Dev profiles only.** A profile whose kind is not `dev` cannot open a
 *     session at all — the call throws. This mirrors how the CORS toggle is
 *     already constrained, and for the same reason: a capability this sharp
 *     must not be one settings toggle away from an ordinary browsing profile.
 *  2. **Never reachable from page content.** The terminal is driven only from
 *     the privileged chrome channel. `aether:content`, which a compromised web
 *     renderer can reach, has no terminal verbs at all.
 *  3. **Explicitly opened, per session, with a visible indicator.** Sessions do
 *     not persist across a restart and are killed when the panel closes.
 *
 * A note on the implementation: this uses a plain pipe (`child_process.spawn`)
 * rather than a pseudo-terminal. `node-pty` is a native module, and requiring
 * a compiled dependency to open a shell would mean this feature silently
 * failing on any machine without build tools. The trade is real and stated in
 * the panel: full-screen curses programs (vim, htop, less) need a PTY and will
 * not render correctly. Ordinary command-line work — git, npm, build tools,
 * test runners — works exactly as expected, and that is the overwhelming
 * majority of what a terminal beside a browser is used for.
 */
const EventEmitter = require('node:events');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createLogger } = require('../../util/logger');

const log = createLogger('terminal');

/** Cap on retained scrollback per session, in bytes. */
const SCROLLBACK_LIMIT = 256 * 1024;
/** Hard ceiling on concurrent sessions. */
const MAX_SESSIONS = 4;

class TerminalService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../settings').SettingsService} deps.settings
   * @param {import('../feature-store').FeatureStore} deps.features
   * @param {import('../profiles').ProfileService} deps.profiles
   */
  constructor({ settings, features, profiles }) {
    super();
    this.settings = settings;
    this.features = features;
    this.profiles = profiles;

    /** @type {Map<string, object>} */
    this.sessions = new Map();
  }

  /** The shell to launch, and how to make it read a command from a pipe. */
  static defaultShell() {
    if (process.platform === 'win32') {
      return { command: process.env.COMSPEC || 'cmd.exe', args: [] };
    }
    // Login shell so the user's PATH, aliases and version managers are present:
    // a terminal where `nvm` and `pyenv` are missing is not much use.
    return { command: process.env.SHELL || '/bin/bash', args: ['-l', '-i'] };
  }

  /**
   * Refuse outside a dev profile. Enforced here rather than in the UI so the
   * guarantee holds even if the IPC surface is driven directly.
   */
  _assertDevProfile(profileId) {
    const profile = this.profiles.get?.(profileId) || this.profiles.active?.();
    if (!profile || profile.kind !== 'dev') {
      throw new Error(
        'The terminal is only available in a profile of kind "dev". '
        + 'Create one in Settings → Profiles.',
      );
    }
    return profile;
  }

  open({ profileId, cwd } = {}) {
    if (!this.features.enabled('terminal')) throw new Error('the terminal panel is off');
    this._assertDevProfile(profileId);

    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`at most ${MAX_SESSIONS} terminal sessions at once`);
    }

    const id = crypto.randomUUID();
    const { command, args } = TerminalService.defaultShell();
    const workingDir = resolveCwd(cwd);

    const child = spawn(command, args, {
      cwd: workingDir,
      env: {
        ...process.env,
        // Tell programs there is no capable terminal, so well-behaved ones
        // emit plain output instead of cursor-addressing escape sequences we
        // cannot render without a PTY.
        TERM: 'dumb',
        NO_COLOR: '1',
        AETHER_TERMINAL: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const session = {
      id,
      pid: child.pid,
      cwd: workingDir,
      shell: command,
      startedAt: Date.now(),
      scrollback: '',
      child,
      exited: false,
    };
    this.sessions.set(id, session);

    const push = (stream) => (chunk) => {
      const text = chunk.toString('utf8');
      session.scrollback = clamp(session.scrollback + text, SCROLLBACK_LIMIT);
      this.emit('data', { id, stream, text });
    };
    child.stdout.on('data', push('stdout'));
    child.stderr.on('data', push('stderr'));

    child.on('exit', (code, signal) => {
      session.exited = true;
      session.exitCode = code;
      this.emit('exit', { id, code, signal });
      // Keep the record briefly so the panel can show why it ended.
      setTimeout(() => this.sessions.delete(id), 30_000).unref?.();
    });
    child.on('error', (err) => {
      this.emit('data', { id, stream: 'stderr', text: `\n[aether] ${err.message}\n` });
    });

    log.info(`terminal ${id} started: ${command} (pid ${child.pid}, cwd ${workingDir})`);
    this.emit('changed', this.list());
    return this.describe(session);
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (!session || session.exited) throw new Error('no such terminal session');
    session.child.stdin.write(data);
    return { ok: true };
  }

  /**
   * Send a signal. Without a PTY there is no line discipline to turn Ctrl-C
   * into SIGINT, so the panel's interrupt button routes here instead.
   */
  signal(id, name = 'SIGINT') {
    const session = this.sessions.get(id);
    if (!session || session.exited) throw new Error('no such terminal session');
    session.child.kill(name);
    return { ok: true, signal: name };
  }

  close(id) {
    const session = this.sessions.get(id);
    if (!session) return { ok: true };
    if (!session.exited) {
      session.child.kill('SIGTERM');
      // A shell ignoring SIGTERM must not leak a process for the life of the
      // browser.
      setTimeout(() => {
        if (!session.exited) session.child.kill('SIGKILL');
      }, 2000).unref?.();
    }
    this.sessions.delete(id);
    this.emit('changed', this.list());
    return { ok: true };
  }

  scrollback(id) {
    return this.sessions.get(id)?.scrollback || '';
  }

  describe(session) {
    return {
      id: session.id,
      pid: session.pid,
      cwd: session.cwd,
      shell: session.shell,
      startedAt: session.startedAt,
      exited: session.exited,
      exitCode: session.exitCode,
    };
  }

  list() {
    return {
      sessions: [...this.sessions.values()].map((s) => this.describe(s)),
      max: MAX_SESSIONS,
      pty: false,
      note: 'Pipe-backed, not a PTY: curses programs such as vim, htop and less '
        + 'will not render. Ordinary command-line work behaves normally.',
    };
  }

  disposeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}

function resolveCwd(cwd) {
  if (!cwd) return os.homedir();
  const resolved = path.resolve(cwd);
  return resolved;
}

function clamp(text, limit) {
  if (text.length <= limit) return text;
  // Drop from the front, and cut at a line boundary so the panel never shows
  // half an escape sequence or half a word at the top of the buffer.
  const cut = text.slice(text.length - limit);
  const newline = cut.indexOf('\n');
  return newline === -1 ? cut : cut.slice(newline + 1);
}

module.exports = { TerminalService, SCROLLBACK_LIMIT, MAX_SESSIONS };
