'use strict';
/**
 * Adblock Plus / uBlock filter syntax parser.
 *
 * Produces plain rule objects that the matcher indexes. We support the
 * subset that EasyList and EasyPrivacy actually lean on — which is the
 * overwhelming majority of their ~150k lines:
 *
 *   ||example.com^$third-party,script       network rule with options
 *   @@||example.com/allowed.js              exception (allowlist)
 *   /banner\d+\.gif/                        regex rule
 *   |http://ads.                            anchored-at-start
 *   example.com##.ad-banner                 cosmetic hide
 *   example.com#@#.ad-banner                cosmetic exception
 *
 * Unsupported extended syntax (`#?#`, `#$#`, `$redirect=`, scriptlets) is
 * skipped rather than mis-parsed: silently dropping a rule degrades
 * blocking, mis-parsing one can break a site.
 */

/** Chromium resource types we can filter, mapped from ABP option names. */
const TYPE_OPTIONS = new Set([
  'script', 'image', 'stylesheet', 'object', 'xmlhttprequest', 'subdocument',
  'document', 'websocket', 'media', 'font', 'ping', 'other', 'popup',
  'webrtc', 'beacon', 'csp_report', 'stylesheet', 'xhr',
]);

/** ABP option name -> Electron webRequest resourceType. */
const TYPE_MAP = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  object: 'object',
  xmlhttprequest: 'xhr',
  xhr: 'xhr',
  subdocument: 'subFrame',
  document: 'mainFrame',
  websocket: 'webSocket',
  media: 'media',
  font: 'font',
  ping: 'ping',
  beacon: 'ping',
  csp_report: 'cspReport',
  other: 'other',
};

const RULE_KIND = { NETWORK: 0, EXCEPTION: 1, COSMETIC: 2, COSMETIC_EXCEPTION: 3 };

/**
 * Parse one filter line.
 * @param {string} raw
 * @returns {object|null} rule, or null if the line is a comment/unsupported
 */
function parseLine(raw) {
  const line = raw.trim();
  if (!line) return null;
  // Comments and list metadata.
  if (line[0] === '!' || line[0] === '[' || line.startsWith('# ')) return null;

  // --- cosmetic rules ---------------------------------------------------
  const cosmeticMatch = line.match(/^(.*?)(#@?#|#@?\?#|#@?\$#)(.+)$/);
  if (cosmeticMatch) {
    const [, domainPart, sep, body] = cosmeticMatch;
    // Extended selectors and CSS-injection rules need a full CSS engine;
    // skip rather than emit something that would hide the wrong element.
    if (sep.includes('?') || sep.includes('$')) return null;
    const exception = sep === '#@#';
    const domains = domainPart ? domainPart.split(',').map((d) => d.trim()).filter(Boolean) : [];
    return {
      kind: exception ? RULE_KIND.COSMETIC_EXCEPTION : RULE_KIND.COSMETIC,
      selector: body.trim(),
      domains: domains.filter((d) => d[0] !== '~'),
      excludeDomains: domains.filter((d) => d[0] === '~').map((d) => d.slice(1)),
      raw: line,
    };
  }

  // --- network rules ----------------------------------------------------
  let rest = line;
  let kind = RULE_KIND.NETWORK;
  if (rest.startsWith('@@')) {
    kind = RULE_KIND.EXCEPTION;
    rest = rest.slice(2);
  }

  // Split trailing $options, taking care not to cut inside a /regex/.
  let pattern = rest;
  let optionStr = '';
  const dollar = findOptionSeparator(rest);
  if (dollar >= 0) {
    pattern = rest.slice(0, dollar);
    optionStr = rest.slice(dollar + 1);
  }
  if (!pattern) return null;

  const rule = {
    kind,
    pattern,
    isRegex: pattern.length > 2 && pattern[0] === '/' && pattern.endsWith('/'),
    anchorStart: false,
    anchorEnd: false,
    anchorDomain: false,
    matchCase: false,
    thirdParty: null,      // true = only third-party, false = only first-party
    types: null,           // Set of resourceType, null = all
    excludedTypes: null,
    domains: null,         // Set of hostnames the rule applies to
    excludeDomains: null,
    important: false,
    raw: line,
  };

  if (!rule.isRegex) {
    if (pattern.startsWith('||')) {
      rule.anchorDomain = true;
      pattern = pattern.slice(2);
    } else if (pattern.startsWith('|')) {
      rule.anchorStart = true;
      pattern = pattern.slice(1);
    }
    if (pattern.endsWith('|')) {
      rule.anchorEnd = true;
      pattern = pattern.slice(0, -1);
    }
    rule.pattern = pattern;
    if (!pattern) return null;
  }

  // --- options ----------------------------------------------------------
  if (optionStr) {
    for (const optRaw of splitOptions(optionStr)) {
      const negated = optRaw[0] === '~';
      const opt = negated ? optRaw.slice(1) : optRaw;
      const eq = opt.indexOf('=');
      const name = eq >= 0 ? opt.slice(0, eq) : opt;
      const value = eq >= 0 ? opt.slice(eq + 1) : null;

      switch (name) {
        case 'third-party':
        case '3p':
          rule.thirdParty = !negated;
          break;
        case 'first-party':
        case '1p':
          rule.thirdParty = negated;
          break;
        case 'match-case':
          rule.matchCase = true;
          break;
        case 'important':
          rule.important = true;
          break;
        case 'domain':
        case 'from': {
          const parts = (value || '').split('|').filter(Boolean);
          for (const d of parts) {
            if (d[0] === '~') {
              (rule.excludeDomains ||= new Set()).add(d.slice(1).toLowerCase());
            } else {
              (rule.domains ||= new Set()).add(d.toLowerCase());
            }
          }
          break;
        }
        default:
          if (TYPE_OPTIONS.has(name)) {
            const mapped = TYPE_MAP[name];
            if (!mapped) break;
            if (negated) (rule.excludedTypes ||= new Set()).add(mapped);
            else (rule.types ||= new Set()).add(mapped);
          } else {
            // Unknown option (`redirect`, `csp`, `removeparam`, …): the rule
            // means something we can't honour, so drop it entirely.
            return null;
          }
      }
    }
  }

  if (rule.isRegex) {
    try {
      rule.regex = new RegExp(rule.pattern.slice(1, -1), rule.matchCase ? '' : 'i');
    } catch {
      return null; // Some lists carry regexes Chromium/V8 rejects.
    }
  }

  return rule;
}

/** Find the `$` that starts options, ignoring one inside a /regex/. */
function findOptionSeparator(str) {
  if (str[0] === '/') {
    const closing = str.lastIndexOf('/');
    if (closing > 0) {
      const after = str.indexOf('$', closing);
      return after;
    }
  }
  return str.indexOf('$');
}

/** Split `a,domain=x|y,b` on commas that are not inside a value list. */
function splitOptions(str) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Parse a whole list body.
 * @param {string} text
 * @returns {{network:object[], exceptions:object[], cosmetic:object[],
 *            cosmeticExceptions:object[], skipped:number, total:number}}
 */
function parseList(text) {
  const network = [];
  const exceptions = [];
  const cosmetic = [];
  const cosmeticExceptions = [];
  let skipped = 0;
  let total = 0;

  for (const line of text.split('\n')) {
    if (!line || line[0] === '!' || line[0] === '[') continue;
    total++;
    const rule = parseLine(line);
    if (!rule) { skipped++; continue; }
    switch (rule.kind) {
      case RULE_KIND.NETWORK: network.push(rule); break;
      case RULE_KIND.EXCEPTION: exceptions.push(rule); break;
      case RULE_KIND.COSMETIC: cosmetic.push(rule); break;
      case RULE_KIND.COSMETIC_EXCEPTION: cosmeticExceptions.push(rule); break;
    }
  }

  return { network, exceptions, cosmetic, cosmeticExceptions, skipped, total };
}

module.exports = { parseLine, parseList, RULE_KIND, TYPE_MAP };
