'use strict';
/**
 * Grounding: assembling what the assistant is allowed to see (spec §4).
 *
 * Three rules shape this file:
 *
 *  1. The active tab is always in scope. Other tabs are in scope **only**
 *     after the user grants multi-tab context, and the grant is per window
 *     and per session, not a setting they forget they enabled.
 *  2. Private windows never contribute context. Someone reading something
 *     in a private window did not ask for it to be summarised by a hosted
 *     model.
 *  3. Everything is budgeted. A 200-page document and six open tabs will
 *     blow any context window, so text is trimmed per source with the
 *     active tab always getting the largest share.
 */
const { createLogger } = require('../../util/logger');

const log = createLogger('ai:context');

/** Character budgets — roughly 4 chars per token. */
const BUDGET = {
  activeTab: 60000,
  otherTab: 12000,
  totalOtherTabs: 60000,
};

class ContextBuilder {
  /**
   * @param {import('../content-bridge').ContentBridge} content
   */
  constructor(content) {
    this.content = content;
    /** windowId -> { granted:boolean, at:number } */
    this._multiTabGrants = new Map();
  }

  // ---- multi-tab consent ----------------------------------------------

  /**
   * Grant or revoke multi-tab context for a window. Deliberately scoped to
   * the window and dropped when it closes: "let the assistant read my other
   * tabs" should not be a thing a user turns on once in 2026 and forgets.
   */
  setMultiTabGrant(windowId, granted) {
    if (granted) this._multiTabGrants.set(windowId, { granted: true, at: Date.now() });
    else this._multiTabGrants.delete(windowId);
    log.info(`multi-tab context ${granted ? 'granted' : 'revoked'} for window ${windowId}`);
    return this.multiTabGranted(windowId);
  }

  multiTabGranted(windowId) {
    return this._multiTabGrants.get(windowId)?.granted === true;
  }

  forgetWindow(windowId) {
    this._multiTabGrants.delete(windowId);
  }

  // ---- collection ------------------------------------------------------

  /**
   * Read one tab's content.
   * @returns {Promise<object|null>}
   */
  async forTab(tab, { maxChars = BUDGET.activeTab } = {}) {
    if (!tab?.webContents) return null;
    if (tab.hibernated) {
      // Waking a tab just to read it would be a surprising side effect of
      // asking a question, so report what we know from metadata instead.
      return {
        url: tab.url,
        title: tab.title,
        hibernated: true,
        text: '',
        note: 'This tab is suspended; wake it to include its content.',
      };
    }
    try {
      return await this.content.command(tab.webContents, 'context.collect', { maxChars });
    } catch (err) {
      log.debug(`context collection failed for ${tab.url}: ${err.message}`);
      return null;
    }
  }

  /**
   * Build the full grounding payload for a request.
   *
   * @param {object} opts
   * @param {import('../../window/browser-window').AetherWindow} opts.window
   * @param {boolean} [opts.includeOtherTabs]
   * @param {string[]} [opts.tabIds]  explicit subset the user picked
   */
  async build({ window, includeOtherTabs = false, tabIds = null }) {
    if (!window) return { active: null, others: [], multiTab: false };

    // Rule 2: a private window contributes nothing, ever.
    if (window.incognito) {
      return {
        active: null,
        others: [],
        multiTab: false,
        redacted: 'private-window',
        note: 'Page content from private windows is never sent to the assistant.',
      };
    }

    const activeTab = window.tabs.active;
    const active = await this.forTab(activeTab, { maxChars: BUDGET.activeTab });

    const wantOthers = includeOtherTabs && this.multiTabGranted(window.id);
    if (!wantOthers) {
      return { active, others: [], multiTab: false };
    }

    const candidates = window.tabs
      .list()
      .filter((t) => t.id !== activeTab?.id)
      .filter((t) => !tabIds || tabIds.includes(t.id))
      .filter((t) => /^https?:/.test(t.url || ''))
      .filter((t) => !t.hibernated);

    const others = [];
    let spent = 0;
    for (const tab of candidates) {
      if (spent >= BUDGET.totalOtherTabs) break;
      const remaining = Math.min(BUDGET.otherTab, BUDGET.totalOtherTabs - spent);
      const ctx = await this.forTab(tab, { maxChars: remaining });
      if (!ctx?.text) continue;
      others.push({ tabId: tab.id, ...ctx });
      spent += ctx.text.length;
    }

    return { active, others, multiTab: true, budgetUsed: spent };
  }

  /**
   * Render the grounding payload as the text block the model reads.
   *
   * Sources are numbered and delimited so the model can cite them, and the
   * delimiter is explicit about where page content starts and stops — page
   * text is untrusted input, and the prompt says so.
   */
  render(context) {
    if (!context) return '';
    const parts = [];

    if (context.redacted) {
      return `[No page content is available: ${context.note}]`;
    }

    if (context.active) {
      parts.push(renderSource(context.active, 1, 'ACTIVE TAB'));
    }
    context.others.forEach((ctx, i) => {
      parts.push(renderSource(ctx, i + 2, 'OTHER TAB'));
    });

    if (!parts.length) return '';
    return parts.join('\n\n');
  }
}

function renderSource(ctx, index, label) {
  const header = [
    `[SOURCE ${index} — ${label}]`,
    `Title: ${ctx.title || '(untitled)'}`,
    `URL: ${ctx.url}`,
    ctx.readingMinutes ? `Reading time: ~${ctx.readingMinutes} min` : null,
    ctx.hibernated ? `Note: ${ctx.note}` : null,
  ].filter(Boolean).join('\n');

  if (!ctx.text) return `${header}\n(no readable text)`;

  const body = ctx.truncated
    ? `${ctx.text}\n…[truncated — the page continues beyond this point]`
    : ctx.text;

  return `${header}\n---BEGIN PAGE CONTENT---\n${body}\n---END PAGE CONTENT---`;
}

module.exports = { ContextBuilder, BUDGET };
