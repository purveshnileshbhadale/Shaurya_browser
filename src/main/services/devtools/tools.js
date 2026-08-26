'use strict';
/**
 * Command-palette developer utilities (spec §5): regex tester, Base64 / URL
 * codecs, JWT decoder and hashes.
 *
 * All of these run in the main process rather than the page so that pasting
 * a production JWT into the palette does not hand it to whatever site
 * happens to be open.
 */
const crypto = require('node:crypto');

/** Regex evaluation is time-boxed: a catastrophic pattern can hang a CPU. */
const REGEX_TIMEOUT_MS = 250;

class ToolsService {
  // ---- regex -----------------------------------------------------------

  /**
   * Test a pattern against a subject and return every match with groups.
   *
   * @param {{pattern:string, flags?:string, subject:string, replace?:string}} opts
   */
  regex({ pattern, flags = 'g', subject = '', replace }) {
    if (!pattern) return { valid: false, error: 'no pattern' };

    // A pattern with nested quantifiers can take exponential time. We cannot
    // interrupt V8 mid-match, so bound the work by capping both the subject
    // and the number of matches, and by wall-clock checking between matches.
    const cappedSubject = subject.slice(0, 100_000);

    let re;
    try {
      re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
    } catch (err) {
      return { valid: false, error: err.message };
    }

    const matches = [];
    const started = Date.now();
    let timedOut = false;
    let guard = 0;

    let m;
    while ((m = re.exec(cappedSubject)) !== null) {
      matches.push({
        index: m.index,
        match: m[0],
        groups: m.slice(1),
        named: m.groups ? { ...m.groups } : null,
      });
      // Zero-length matches would loop forever without this nudge.
      if (m[0] === '') re.lastIndex++;
      if (++guard > 5000) break;
      if (Date.now() - started > REGEX_TIMEOUT_MS) {
        timedOut = true;
        break;
      }
    }

    let replaced = null;
    if (typeof replace === 'string') {
      try {
        replaced = cappedSubject.replace(new RegExp(pattern, flags), replace);
      } catch (err) {
        replaced = `(replace failed: ${err.message})`;
      }
    }

    return {
      valid: true,
      matchCount: matches.length,
      matches: matches.slice(0, 500),
      truncated: matches.length > 500 || subject.length > cappedSubject.length,
      timedOut,
      elapsedMs: Date.now() - started,
      replaced,
      explanation: explainRegex(pattern),
    };
  }

  // ---- encoders --------------------------------------------------------

  /**
   * @param {{kind:string, value:string}} opts
   * kind: base64 | base64url | url | uri-component | html | hex
   */
  encode({ kind, value }) {
    const input = String(value ?? '');
    switch (kind) {
      case 'base64': return { result: Buffer.from(input, 'utf8').toString('base64') };
      case 'base64url': return { result: Buffer.from(input, 'utf8').toString('base64url') };
      case 'url': return { result: encodeURI(input) };
      case 'uri-component': return { result: encodeURIComponent(input) };
      case 'hex': return { result: Buffer.from(input, 'utf8').toString('hex') };
      case 'html': return { result: escapeHtml(input) };
      default: throw new Error(`unknown encoding "${kind}"`);
    }
  }

  decode({ kind, value }) {
    const input = String(value ?? '').trim();
    try {
      switch (kind) {
        case 'base64':
        case 'base64url': {
          const buf = Buffer.from(input, kind === 'base64url' ? 'base64url' : 'base64');
          const text = buf.toString('utf8');
          // Round-tripping catches "this decoded to mojibake" rather than
          // handing back replacement characters as if they were the answer.
          const printable = !/�/.test(text);
          return {
            result: printable ? text : null,
            hex: printable ? null : buf.toString('hex'),
            binary: !printable,
            bytes: buf.length,
          };
        }
        case 'url':
        case 'uri-component':
          return { result: decodeURIComponent(input) };
        case 'hex':
          return { result: Buffer.from(input.replace(/\s+/g, ''), 'hex').toString('utf8') };
        case 'html':
          return { result: unescapeHtml(input) };
        default:
          throw new Error(`unknown encoding "${kind}"`);
      }
    } catch (err) {
      return { error: `could not decode as ${kind}: ${err.message}` };
    }
  }

  // ---- JWT -------------------------------------------------------------

  /**
   * Decode a JWT and report what can be checked without the signing key.
   *
   * Deliberately does not claim a token is "valid": verifying the signature
   * needs the secret or public key, and a decoder that implies validity is
   * how people ship `alg: none` bugs.
   */
  jwt({ token, secret }) {
    const raw = String(token || '').trim().replace(/^Bearer\s+/i, '');
    const parts = raw.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'a JWT has three dot-separated parts' };
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    let header;
    let payload;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch (err) {
      return { valid: false, error: `could not parse: ${err.message}` };
    }

    const now = Math.floor(Date.now() / 1000);
    const claims = {
      issuer: payload.iss ?? null,
      subject: payload.sub ?? null,
      audience: payload.aud ?? null,
      issuedAt: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
      expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
      notBefore: payload.nbf ? new Date(payload.nbf * 1000).toISOString() : null,
      jwtId: payload.jti ?? null,
    };

    const warnings = [];
    if (header.alg === 'none') {
      warnings.push('alg is "none" — this token is unsigned and must never be trusted');
    }
    if (payload.exp && payload.exp < now) {
      warnings.push(`expired ${humanDuration(now - payload.exp)} ago`);
    }
    if (payload.nbf && payload.nbf > now) {
      warnings.push(`not valid for another ${humanDuration(payload.nbf - now)}`);
    }
    if (!payload.exp) warnings.push('no exp claim — this token never expires');

    // Optional HMAC verification when the user supplies the secret.
    let signatureChecked = null;
    if (secret && /^HS(256|384|512)$/.test(header.alg || '')) {
      const bits = header.alg.slice(2);
      const expected = crypto
        .createHmac(`sha${bits}`, secret)
        .update(`${headerB64}.${payloadB64}`)
        .digest('base64url');
      // Constant-time compare, so this tool cannot be used as an oracle.
      signatureChecked = expected.length === signatureB64.length
        && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureB64));
    }

    return {
      valid: true,
      header,
      payload,
      claims,
      warnings,
      signature: {
        algorithm: header.alg || null,
        checked: signatureChecked,
        note: signatureChecked === null
          ? 'Signature not verified — supply the secret (HS*) to check it. '
            + 'Decoding a token never proves it is authentic.'
          : signatureChecked
            ? 'HMAC signature matches the supplied secret.'
            : 'HMAC signature does NOT match the supplied secret.',
      },
      expired: Boolean(payload.exp && payload.exp < now),
    };
  }

  // ---- hashes ----------------------------------------------------------

  hash({ value, algorithms = ['md5', 'sha1', 'sha256', 'sha512'] }) {
    const buf = Buffer.from(String(value ?? ''), 'utf8');
    const out = {};
    for (const algo of algorithms) {
      try {
        out[algo] = crypto.createHash(algo).update(buf).digest('hex');
      } catch {
        out[algo] = null;
      }
    }
    return { bytes: buf.length, hashes: out };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A plain-language reading of a pattern's notable constructs. */
function explainRegex(pattern) {
  const notes = [];
  if (/\(\?<\w+>/.test(pattern)) notes.push('uses named capture groups');
  if (/\(\?:/.test(pattern)) notes.push('uses non-capturing groups');
  if (/\(\?=|\(\?!/.test(pattern)) notes.push('uses lookahead');
  if (/\(\?<=|\(\?<!/.test(pattern)) notes.push('uses lookbehind');
  if (/\\b/.test(pattern)) notes.push('anchored to word boundaries');
  if (/^\^/.test(pattern) && /\$$/.test(pattern)) notes.push('must match the whole subject');
  // The classic catastrophic-backtracking shape: a quantified group whose
  // body is itself quantified.
  if (/\([^)]*[+*]\)[+*]/.test(pattern)) {
    notes.push('⚠ nested quantifiers can backtrack catastrophically on non-matching input');
  }
  return notes;
}

function humanDuration(seconds) {
  const s = Math.abs(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function unescapeHtml(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

module.exports = { ToolsService, explainRegex };
