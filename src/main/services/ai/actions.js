'use strict';
/**
 * The assistant's tools, and the confirmation gate in front of them.
 *
 * Spec §4 requires the assistant to ask before "any action with real-world
 * effect (purchase, send, post, delete, submit)". The way that is enforced
 * here is structural rather than advisory:
 *
 *   - Every tool declares `effect: 'read'` or `effect: 'write'`.
 *   - Read tools execute immediately.
 *   - Write tools *never* execute from the model's decision alone. The call
 *     is parked, the user is shown exactly what will happen, and only an
 *     explicit approval releases it.
 *
 * That means a prompt-injected page cannot talk the assistant into
 * submitting a form: the injection can at most cause a confirmation card to
 * appear, which the user then declines.
 */
const EventEmitter = require('node:events');
const { uid } = require('../../util/id');
const { createLogger } = require('../../util/logger');

const log = createLogger('ai:actions');

/**
 * Tool catalogue. `strict: true` guarantees the arguments validate against
 * the schema, so handlers do not have to defend against malformed input.
 */
const TOOLS = [
  {
    name: 'open_url',
    effect: 'read',
    description: 'Open a URL in a new background tab so its content can be read. '
      + 'Use this for research; it does not navigate the user away from what they are reading.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to open' },
        reason: { type: 'string', description: 'Why this page is needed' },
      },
      required: ['url', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_tab',
    effect: 'read',
    description: 'Read the text of a tab the user has already granted access to.',
    input_schema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_web',
    effect: 'read',
    description: 'Run a web search and return the result page for reading.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_note',
    effect: 'read', // writes only to the user's own local notes
    description: 'Save structured notes to the user\'s local notes collection.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        markdown: { type: 'string' },
        source_url: { type: 'string' },
      },
      required: ['title', 'markdown'],
      additionalProperties: false,
    },
  },
  {
    name: 'fill_form',
    effect: 'write',
    description: 'Type text into fields on the current page. Does NOT submit the form. '
      + 'The user must approve before anything is typed.',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['name', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['fields'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_form',
    effect: 'write',
    description: 'Submit a form on the current page. This sends data and may post, purchase, '
      + 'or send a message. Always requires explicit user approval.',
    input_schema: {
      type: 'object',
      properties: {
        form_index: { type: 'number' },
        summary: {
          type: 'string',
          description: 'A plain-language description of what submitting will do',
        },
      },
      required: ['form_index', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'click_element',
    effect: 'write',
    description: 'Click an element on the page. Requires explicit user approval because a '
      + 'click can purchase, send, delete or post.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        summary: { type: 'string', description: 'What this click will do' },
      },
      required: ['selector', 'summary'],
      additionalProperties: false,
    },
  },
];

/** Words that force a confirmation regardless of the declared effect. */
const HIGH_STAKES = /\b(buy|purchase|checkout|pay|order|subscribe|delete|remove|send|post|publish|tweet|transfer|confirm|submit)\b/i;

class ActionBroker extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../content-bridge').ContentBridge} deps.content
   */
  constructor({ content, windowManager, search, notes }) {
    super();
    this.content = content;
    this.windowManager = windowManager;
    this.search = search;
    this.notes = notes;
    /** pendingId -> { resolve, reject, payload, timer } */
    this._pending = new Map();
  }

  /** Tool definitions in the shape the Messages API expects. */
  definitions() {
    return TOOLS.map(({ effect, ...tool }) => ({ ...tool, strict: true }));
  }

  /** Does this call need the user's blessing before it runs? */
  requiresConfirmation(name, input) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return true; // unknown tool: refuse to run it unattended
    if (tool.effect === 'write') return true;
    // Even a "read" tool gets a gate if its arguments describe a real-world
    // action — a search query is harmless, a form fill described as
    // "confirm purchase" is not.
    return HIGH_STAKES.test(JSON.stringify(input || {}));
  }

  /**
   * Execute a tool call, gating writes behind user approval.
   *
   * @param {{name:string, input:object, id:string}} call
   * @param {{window:object, tab:object, windowId:string}} ctx
   * @returns {Promise<{content:string, is_error?:boolean}>}
   */
  async execute(call, ctx) {
    const { name, input } = call;

    if (this.requiresConfirmation(name, input)) {
      const approved = await this._requestConfirmation(call, ctx);
      if (!approved) {
        log.info(`user declined ${name}`);
        return {
          content: 'The user declined this action. Do not retry it; '
            + 'explain what you were going to do and stop.',
          is_error: false,
        };
      }
    }

    try {
      const result = await this._run(name, input, ctx);
      return { content: typeof result === 'string' ? result : JSON.stringify(result) };
    } catch (err) {
      log.warn(`${name} failed: ${err.message}`);
      return { content: `Tool failed: ${err.message}`, is_error: true };
    }
  }

  _requestConfirmation(call, ctx) {
    const id = uid('act_');
    const tool = TOOLS.find((t) => t.name === call.name);

    const payload = {
      id,
      tool: call.name,
      effect: tool?.effect || 'write',
      description: tool?.description || '',
      // The user-facing summary the model was required to provide, falling
      // back to the raw arguments so nothing is ever hidden.
      summary: call.input?.summary || call.input?.reason || null,
      input: call.input,
      url: ctx.tab?.url || null,
    };

    return new Promise((resolve) => {
      // An unanswered confirmation must not hang the conversation forever.
      const timer = setTimeout(() => {
        this._pending.delete(id);
        log.info(`confirmation ${id} expired`);
        resolve(false);
      }, 5 * 60 * 1000);
      if (timer.unref) timer.unref();

      this._pending.set(id, { resolve, timer, payload });
      this.emit('confirm', { windowId: ctx.windowId, ...payload });
    });
  }

  /** Called from the UI when the user answers a confirmation card. */
  respond(id, approved) {
    const entry = this._pending.get(id);
    if (!entry) return false;
    this._pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(Boolean(approved));
    return true;
  }

  pending() {
    return [...this._pending.values()].map((e) => e.payload);
  }

  // ---- implementations -------------------------------------------------

  async _run(name, input, ctx) {
    switch (name) {
      case 'open_url': {
        if (!/^https?:\/\//i.test(input.url)) throw new Error('only http(s) URLs can be opened');
        const tab = ctx.window.tabs.create({ url: input.url, background: true });
        // Give the page a moment to commit before reading it.
        await waitForLoad(tab);
        const context = await this.content
          .command(tab.webContents, 'context.collect', { maxChars: 20000 })
          .catch(() => null);
        return {
          opened: input.url,
          tab_id: tab.id,
          title: context?.title || tab.title,
          text: context?.text || '(could not read the page)',
        };
      }

      case 'read_tab': {
        const tab = ctx.window.tabs.get(input.tab_id);
        if (!tab) throw new Error('no such tab');
        const context = await this.content.command(tab.webContents, 'context.collect', { maxChars: 20000 });
        return { title: context.title, url: context.url, text: context.text };
      }

      case 'search_web': {
        const resolved = this.search.resolve(input.query);
        const url = resolved.kind === 'search' ? resolved.url : this.search._asSearch(input.query).url;
        const tab = ctx.window.tabs.create({ url, background: true });
        await waitForLoad(tab);
        const context = await this.content
          .command(tab.webContents, 'context.collect', { maxChars: 16000 })
          .catch(() => null);
        return { query: input.query, tab_id: tab.id, results: context?.text || '' };
      }

      case 'save_note': {
        const note = this.notes.save({
          title: input.title,
          markdown: input.markdown,
          sourceUrl: input.source_url || ctx.tab?.url,
        });
        return { saved: true, note_id: note.id };
      }

      case 'fill_form': {
        // Approved by the user at this point. Filling is still separated from
        // submitting so a second approval is needed before anything is sent.
        const filled = await ctx.window.tabs.active.webContents.executeJavaScript(
          buildFillScript(input.fields), true
        );
        return { filled, note: 'Fields were filled. Nothing has been submitted.' };
      }

      case 'submit_form': {
        const ok = await ctx.window.tabs.active.webContents.executeJavaScript(
          `(() => { const f = document.forms[${Number(input.form_index)}];
                    if (!f) return false; f.requestSubmit ? f.requestSubmit() : f.submit();
                    return true; })()`,
          true
        );
        return { submitted: ok };
      }

      case 'click_element': {
        const ok = await ctx.window.tabs.active.webContents.executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(input.selector)});
                    if (!el) return false; el.click(); return true; })()`,
          true
        );
        return { clicked: ok };
      }

      default:
        throw new Error(`unknown tool ${name}`);
    }
  }
}

/**
 * Build the fill script with values injected as JSON literals rather than
 * concatenated into source — page-provided or model-provided strings must
 * never become executable code.
 */
function buildFillScript(fields) {
  const safe = JSON.stringify(fields || []);
  return `(() => {
    const fields = ${safe};
    let filled = 0;
    for (const { name, value } of fields) {
      const el = document.querySelector(
        '[name=' + JSON.stringify(name) + '], #' + CSS.escape(name));
      if (!el) continue;
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      filled++;
    }
    return filled;
  })()`;
}

/** Resolve once a freshly opened tab has committed and stopped loading. */
function waitForLoad(tab, timeout = 15000) {
  return new Promise((resolve) => {
    if (!tab.webContents) return resolve();
    const done = () => {
      clearTimeout(timer);
      tab.webContents?.off('did-stop-loading', done);
      // A short settle lets client-rendered pages paint their content.
      setTimeout(resolve, 400);
    };
    const timer = setTimeout(() => {
      tab.webContents?.off('did-stop-loading', done);
      resolve();
    }, timeout);
    if (timer.unref) timer.unref();
    tab.webContents.on('did-stop-loading', done);
  });
}

module.exports = { ActionBroker, TOOLS, HIGH_STAKES };
