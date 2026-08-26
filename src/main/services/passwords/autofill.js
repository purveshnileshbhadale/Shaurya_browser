'use strict';
/**
 * Autofill glue between the vault and page forms.
 *
 * The rule this enforces: credentials move main -> page only after an
 * explicit user choice, and only into the origin they were saved for. The
 * page can *ask* to be filled (by focusing a login field) but cannot cause a
 * fill by itself, which is what stops a hidden iframe from harvesting a
 * saved password.
 */
const EventEmitter = require('node:events');
const { createLogger } = require('../../util/logger');

const log = createLogger('autofill');

class AutofillService extends EventEmitter {
  /**
   * @param {import('./vault').VaultService} vault
   * @param {import('../content-bridge').ContentBridge} content
   * @param {import('../feature-store').FeatureStore} features
   */
  constructor(vault, content, features) {
    super();
    this.vault = vault;
    this.content = content;
    this.features = features;
    /** Offers the user dismissed, so we do not nag on every submit. */
    this._declined = new Set();
    this._wire();
  }

  _wire() {
    // A login field gained focus: offer matching credentials.
    this.content.on('autofill-focus', ({ origin, fieldType, rect }, { sender }) => {
      if (!this.features.enabled('passwords')) return;
      if (!this.vault.unlocked) {
        this.emit('locked-prompt', { origin, sender });
        return;
      }
      const candidates = this.vault.candidatesFor(origin);
      if (!candidates.length) return;
      this.emit('offer', { origin, fieldType, rect, candidates, sender });
    });

    // A form carrying a password was submitted: offer to save or update.
    this.content.on('autofill-submit', ({ origin, username, password, title }, { sender }) => {
      if (!this.features.enabled('passwords') || !password) return;
      if (!this.vault.unlocked) return;

      const key = `${origin}|${username}`;
      if (this._declined.has(key)) return;

      const existing = this.vault
        .candidatesFor(origin)
        .find((c) => c.username === username);

      if (!existing) {
        this.emit('save-prompt', { origin, username, password, title, sender, kind: 'new' });
        return;
      }

      // Only prompt for an update when the password actually changed;
      // comparing requires reveal(), which is fine — we are already unlocked
      // and this never leaves the main process.
      const current = this.vault.reveal(existing.id);
      if (current.password !== password) {
        this.emit('save-prompt', {
          origin, username, password, title, sender,
          kind: 'update', entryId: existing.id,
        });
      }
    });
  }

  /**
   * Fill a chosen entry into the page that asked.
   * @param {Electron.WebContents} webContents
   * @param {string} entryId
   */
  async fill(webContents, entryId, { expectedOrigin } = {}) {
    if (!this.vault.unlocked) throw new Error('the vault is locked');

    const entry = this.vault.list().find((e) => e.id === entryId);
    if (!entry) throw new Error('no such entry');

    // Re-check the origin at fill time. The page may have navigated between
    // the offer and the click, and filling the new page would hand a
    // credential to a site it was never saved for.
    const currentUrl = webContents.getURL();
    let currentOrigin;
    try {
      currentOrigin = new URL(currentUrl).origin;
    } catch {
      throw new Error('the page has no usable origin');
    }
    if (expectedOrigin && currentOrigin !== expectedOrigin) {
      log.warn(`refusing fill: page moved from ${expectedOrigin} to ${currentOrigin}`);
      throw new Error('the page changed; nothing was filled');
    }
    if (!this.vault.candidatesFor(currentOrigin).some((c) => c.id === entryId)) {
      log.warn(`refusing fill of ${entryId} into unrelated origin ${currentOrigin}`);
      throw new Error('that credential does not belong to this site');
    }

    const secret = this.vault.reveal(entryId);
    await this.content.command(webContents, 'autofill.fill', {
      username: secret.username,
      password: secret.password,
    });
    log.info(`filled credential for ${currentOrigin}`);
    return true;
  }

  /** User accepted a save/update prompt. */
  confirmSave({ kind, entryId, origin, username, password, title }) {
    if (kind === 'update' && entryId) {
      return this.vault.update(entryId, { password });
    }
    return this.vault.add({ origin, username, password, title });
  }

  /** User dismissed a save prompt; remember so we stop asking. */
  declineSave({ origin, username }) {
    this._declined.add(`${origin}|${username}`);
  }
}

module.exports = { AutofillService };
