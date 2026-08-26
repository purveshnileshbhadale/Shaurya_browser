'use strict';
/**
 * Hosted inference via the Anthropic Messages API.
 *
 * Uses the official SDK rather than hand-rolled HTTP so that streaming,
 * retries, typed errors and tool-call parsing come from the maintained
 * implementation. The API key is read from the encrypted vault at call time
 * and is never written to settings, logs or disk in the clear.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { createLogger } = require('../../../util/logger');

const log = createLogger('ai:anthropic');

/**
 * Models offered in the picker. The default is Opus 5 — the assistant is
 * asked to reason over whole pages and compare claims across tabs, which is
 * exactly the work a smaller model does badly.
 */
const MODELS = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', context: '1M',
    note: 'Best reasoning; the default for research and multi-tab comparison' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context: '1M',
    note: 'Faster and cheaper; good for summaries and translation' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', context: '200K',
    note: 'Fastest; best for short lookups' },
];

/** Responses in a browser side panel are short; this is headroom, not a target. */
const MAX_TOKENS = 16000;

class AnthropicProvider {
  constructor({ apiKey, model = 'claude-opus-5' } = {}) {
    this.id = 'anthropic';
    this.name = 'Anthropic';
    this.kind = 'hosted';
    this.model = model;
    this._apiKey = apiKey;
    this._client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  get available() {
    return Boolean(this._apiKey);
  }

  models() {
    return MODELS;
  }

  setApiKey(apiKey) {
    this._apiKey = apiKey;
    this._client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  /**
   * Stream a completion.
   *
   * @param {object} opts
   * @param {string} opts.system
   * @param {Array} opts.messages          SDK-shaped message params
   * @param {Array} [opts.tools]           tool definitions
   * @param {'low'|'medium'|'high'|'xhigh'|'max'} [opts.effort]
   * @param {boolean} [opts.thinking]      show reasoning in the panel
   * @param {AbortSignal} [opts.signal]
   * @param {(delta:{type:string,text:string}) => void} [opts.onDelta]
   * @returns {Promise<import('@anthropic-ai/sdk').Anthropic.Message>}
   */
  async chat({ system, messages, tools, effort = 'high', thinking = false, signal, onDelta }) {
    if (!this._client) {
      throw new Error('No Anthropic API key is set — add one in Settings › AI');
    }

    const request = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      output_config: { effort },
      // Adaptive thinking lets the model decide how much reasoning a request
      // deserves: a translation gets none, a multi-tab comparison gets real
      // deliberation. `display` is opt-in because the default returns empty
      // thinking blocks, which in a streaming panel reads as a long stall.
      thinking: thinking
        ? { type: 'adaptive', display: 'summarized' }
        : { type: 'adaptive' },
      // If a safety classifier declines, the API re-runs the same request on
      // a fallback model inside the same call rather than leaving the panel
      // blank. Routing is chosen server-side, so there is no model list here
      // to keep current.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      ...(tools?.length ? { tools } : {}),
    };

    try {
      const stream = this._client.beta.messages.stream(request, { signal });

      if (onDelta) {
        stream.on('text', (text) => onDelta({ type: 'text', text }));
        stream.on('thinking', (text) => onDelta({ type: 'thinking', text }));
      }

      const message = await stream.finalMessage();

      // A refusal that survived the fallback chain is a real outcome, not an
      // exception — surface why rather than showing an empty answer.
      if (message.stop_reason === 'refusal') {
        const detail = message.stop_details?.explanation
          || 'the request was declined by the model';
        throw new Error(`Assistant declined: ${detail}`);
      }

      return message;
    } catch (err) {
      throw translateError(err);
    }
  }

  /** Non-streaming variant for short internal calls (titles, tags). */
  async complete({ system, messages, effort = 'low', signal }) {
    if (!this._client) throw new Error('No Anthropic API key is set');
    try {
      const message = await this._client.messages.create({
        model: this.model,
        max_tokens: 2048,
        system,
        messages,
        output_config: { effort },
        thinking: { type: 'adaptive' },
      }, { signal });
      return message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    } catch (err) {
      throw translateError(err);
    }
  }
}

/**
 * Turn SDK errors into messages a browser user can act on.
 * Checked most-specific first; the generic `APIError` catch keeps the status
 * code so unexpected failures are still diagnosable.
 */
function translateError(err) {
  if (err?.name === 'AbortError') return err;

  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('That Anthropic API key was rejected — check it in Settings › AI');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Anthropic rate limit reached — try again in a moment');
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new Error(`Request rejected: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error('Could not reach the Anthropic API — check your connection or VPN');
  }
  if (err instanceof Anthropic.APIError) {
    log.warn(`API error ${err.status}: ${err.message}`);
    return new Error(`Anthropic API error ${err.status}: ${err.message}`);
  }
  return err;
}

module.exports = { AnthropicProvider, MODELS, MAX_TOKENS };
