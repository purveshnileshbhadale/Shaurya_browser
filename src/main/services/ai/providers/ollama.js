'use strict';
/**
 * On-device inference through Ollama.
 *
 * This is the "quick and private" half of the hybrid setup in spec §4: page
 * text never leaves the machine, so summarising a work document or a medical
 * page costs nothing in exposure. It runs against a local HTTP endpoint, so
 * the same adapter serves llama.cpp, LM Studio and anything else that speaks
 * the Ollama chat API.
 */
const http = require('node:http');
const { request } = require('../../../util/net');
const { createLogger } = require('../../../util/logger');

const log = createLogger('ai:ollama');

/** Small enough to run comfortably on a laptop alongside a browser. */
const SUGGESTED_MODELS = [
  { id: 'llama3.2:3b', name: 'Llama 3.2 3B', size: '2.0 GB', note: 'Fast; good for summaries' },
  { id: 'qwen2.5:7b', name: 'Qwen 2.5 7B', size: '4.7 GB', note: 'Stronger reasoning' },
  { id: 'phi4-mini', name: 'Phi-4 Mini', size: '2.5 GB', note: 'Compact and quick' },
  { id: 'gemma3:4b', name: 'Gemma 3 4B', size: '3.3 GB', note: 'Good multilingual coverage' },
];

class OllamaProvider {
  constructor({ endpoint = 'http://127.0.0.1:11434', model = 'llama3.2:3b' } = {}) {
    this.id = 'ollama';
    this.name = 'On-device (Ollama)';
    this.kind = 'local';
    this.endpoint = endpoint.replace(/\/$/, '');
    this.model = model;
    this._availableCache = null;
  }

  /** Is a local runtime actually up? Cached briefly to keep the UI snappy. */
  async probe({ force = false } = {}) {
    if (!force && this._availableCache && Date.now() - this._availableCache.at < 15000) {
      return this._availableCache.value;
    }
    let value = { running: false, models: [] };
    try {
      const res = await request(`${this.endpoint}/api/tags`, { timeout: 2000 });
      if (res.status === 200) {
        const data = JSON.parse(res.body.toString('utf8'));
        value = {
          running: true,
          models: (data.models || []).map((m) => ({
            id: m.name,
            size: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : null,
          })),
        };
      }
    } catch {
      // Not running is the normal case, not an error worth logging loudly.
    }
    this._availableCache = { at: Date.now(), value };
    return value;
  }

  get available() {
    return this._availableCache?.value?.running ?? false;
  }

  models() {
    const installed = this._availableCache?.value?.models || [];
    const ids = new Set(installed.map((m) => m.id));
    return [
      ...installed.map((m) => ({ ...m, name: m.id, installed: true })),
      ...SUGGESTED_MODELS.filter((m) => !ids.has(m.id)).map((m) => ({ ...m, installed: false })),
    ];
  }

  /**
   * Stream a completion. Ollama returns newline-delimited JSON rather than
   * SSE, so we parse line-by-line off the raw response stream.
   *
   * @returns {Promise<{content:Array<{type:'text',text:string}>, stop_reason:string}>}
   */
  async chat({ system, messages, signal, onDelta }) {
    const probe = await this.probe();
    if (!probe.running) {
      throw new Error(
        `No local model runtime at ${this.endpoint}. Install Ollama and run \`ollama serve\`, `
        + 'or switch the assistant to the hosted model in Settings › AI.'
      );
    }

    const body = JSON.stringify({
      model: this.model,
      stream: true,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        // Local models take plain strings, so flatten the block form.
        ...messages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string'
            ? m.content
            : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
        })),
      ],
    });

    const text = await this._streamRequest('/api/chat', body, signal, (chunk) => {
      const piece = chunk?.message?.content;
      if (piece && onDelta) onDelta({ type: 'text', text: piece });
      return piece || '';
    });

    return {
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      model: this.model,
      usage: { input_tokens: null, output_tokens: null },
    };
  }

  async complete({ system, messages, signal }) {
    const result = await this.chat({ system, messages, signal });
    return result.content.map((b) => b.text).join('');
  }

  /**
   * POST and consume newline-delimited JSON, accumulating whatever the
   * extractor returns.
   */
  _streamRequest(path, body, signal, extract) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.endpoint + path);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          timeout: 120000,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`Ollama returned HTTP ${res.statusCode}`));
          }

          let accumulated = '';
          let buffer = '';

          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buffer += chunk;
            // A chunk can split a JSON line in half; keep the remainder.
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                accumulated += extract(JSON.parse(line));
              } catch (err) {
                log.debug(`unparseable line from Ollama: ${err.message}`);
              }
            }
          });
          res.on('end', () => {
            if (buffer.trim()) {
              try { accumulated += extract(JSON.parse(buffer)); } catch { /* trailing noise */ }
            }
            resolve(accumulated);
          });
          res.on('error', reject);
        }
      );

      if (signal) {
        if (signal.aborted) return req.destroy(new Error('cancelled'));
        signal.addEventListener('abort', () => req.destroy(new Error('cancelled')), { once: true });
      }
      req.on('timeout', () => req.destroy(new Error('local model timed out')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = { OllamaProvider, SUGGESTED_MODELS };
