/**
 * Wrapper that runs the smoke test with a throwaway profile, and under a
 * virtual display when there is no real one (CI, containers).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron');

if (!existsSync(electron)) {
  console.error('Electron binary missing. Run: node node_modules/electron/install.js');
  process.exit(1);
}

const profile = mkdtempSync(path.join(tmpdir(), 'aether-smoke-'));
const args = [path.join(here, 'smoke-test.js'), '--no-sandbox'];

// Use xvfb when there is no display, so this runs the same way in CI.
const needsXvfb = !process.env.DISPLAY && process.platform === 'linux';
const command = needsXvfb ? 'xvfb-run' : electron;
const commandArgs = needsXvfb ? ['-a', electron, ...args] : args;

const result = spawnSync(command, commandArgs, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    AETHER_USER_DATA: profile,
    AETHER_ALLOW_ROOT: '1',
    AETHER_LOG: process.env.AETHER_LOG || 'warn',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
});

rmSync(profile, { recursive: true, force: true });
process.exit(result.status ?? 1);
