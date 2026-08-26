'use strict';
/**
 * Centralised filesystem layout.
 *
 * Everything Aether writes lives under one root so that a profile can be
 * wiped, backed up or synced as a unit. `AETHER_USER_DATA` overrides the
 * location, which is what the smoke tests use to stay out of the real
 * profile.
 */
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Resolve a path inside the shipped application bundle (read-only). */
function appPath(...parts) {
  return path.join(REPO_ROOT, ...parts);
}

let userDataRoot = null;

/** Root of all mutable state. Created lazily on first use. */
function userData(...parts) {
  if (!userDataRoot) {
    userDataRoot = process.env.AETHER_USER_DATA
      ? path.resolve(process.env.AETHER_USER_DATA)
      : app.getPath('userData');
    fs.mkdirSync(userDataRoot, { recursive: true });
  }
  const target = path.join(userDataRoot, ...parts);
  return target;
}

/** userData() plus a guarantee that the *directory* exists. */
function userDataDir(...parts) {
  const target = userData(...parts);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

module.exports = {
  REPO_ROOT,
  appPath,
  userData,
  userDataDir,
  // Well-known subtrees.
  profilesDir: () => userDataDir('profiles'),
  filtersDir: () => userDataDir('filters'),
  extensionsDir: () => userDataDir('extensions'),
  notesDir: () => userDataDir('notes'),
  vaultFile: () => userData('vault.aeth'),
  settingsFile: () => userData('settings.json'),
  sessionsFile: () => userData('sessions.json'),
  historyFile: () => userData('history.json'),
  bookmarksFile: () => userData('bookmarks.json'),
  collectionsFile: () => userData('http-collections.json'),
  syncStateFile: () => userData('sync-state.json'),
};
