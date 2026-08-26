'use strict';
/**
 * Tokenised filter matcher.
 *
 * Linearly testing 150k rules per request would add tens of milliseconds to
 * every subresource load. Instead we do what uBlock Origin and Brave's
 * adblock-rust do: pick one representative token per rule, bucket rules by
 * that token, and at match time only test the buckets whose token actually
 * appears in the URL. That turns "check every rule" into "check the handful
 * of rules that could possibly match".
 */

/** Tokens shorter than this are too common to discriminate. */
const MIN_TOKEN = 3;

/** Tokens that appear in a huge share of URLs and so select nothing. */
const COMMON_TOKENS = new Set([
  'http', 'https', 'www', 'com', 'net', 'org', 'html', 'php', 'index',
  'javascript', 'css', 'img', 'images', 'static', 'assets', 'content',
]);

const TOKEN_RE = /[a-z0-9%]{3,}/g;

/** Extract candidate tokens from an already-lowercased string. */
function tokenize(str) {
  TOKEN_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = TOKEN_RE.exec(str)) !== null) out.push(m[0]);
  return out;
}

/**
 * Extract only the tokens of a *pattern* that are guaranteed to appear as
 * whole tokens in a matching URL.
 *
 * This is the subtle part of any tokenised matcher. A URL is tokenised into
 * maximal `[a-z0-9%]+` runs, so `/banner123.gif` yields `banner123`, not
 * `banner`. Indexing the rule `/banner*.gif` under `banner` would therefore
 * make it invisible to that URL. A pattern token is only safe to index when
 * neither of its edges can absorb extra alphanumerics:
 *
 *   - the left edge is a literal non-token character, or the very start of
 *     an anchored pattern;
 *   - the right edge is a literal non-token character, or the very end of an
 *     end-anchored pattern.
 *
 * `*` on either side disqualifies a token; so does an unanchored pattern
 * edge, since the URL may continue with more alphanumerics there. Rules
 * with no safe token fall back to the catch-all bucket, which is correct if
 * slower.
 *
 * @returns {string[]} tokens safe to index this rule under
 */
function completeTokens(rule) {
  const pattern = rule.pattern.toLowerCase();
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(pattern)) !== null) {
    const start = m.index;
    const end = start + m[0].length;

    const leftOk = start > 0
      ? pattern[start - 1] !== '*'
      : rule.anchorStart || rule.anchorDomain;
    const rightOk = end < pattern.length
      ? pattern[end] !== '*'
      : rule.anchorEnd;

    if (leftOk && rightOk) out.push(m[0]);
  }
  return out;
}

/** Choose the most selective safely-indexable token in a rule's pattern. */
function pickToken(rule, frequency) {
  if (rule.isRegex) return null;
  const tokens = completeTokens(rule);
  if (!tokens.length) return null;
  let best = null;
  let bestScore = Infinity;
  for (const t of tokens) {
    if (t.length < MIN_TOKEN) continue;
    // Prefer rare tokens; break ties toward longer ones.
    const score = (frequency.get(t) || 0) - t.length * 0.01 + (COMMON_TOKENS.has(t) ? 1e6 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/**
 * Does `host` fall under `domain` (exact match or a subdomain)?
 * `ads.example.com` is under `example.com`; `notexample.com` is not.
 */
function hostMatchesDomain(host, domain) {
  if (host === domain) return true;
  return host.endsWith('.' + domain);
}

/** Registrable-ish domain, used for the third-party comparison. */
function baseDomain(host) {
  if (!host) return '';
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  // Handle the common two-level public suffixes without shipping the full
  // PSL. Anything unusual degrades to "looks third-party", which is the
  // safe direction for a blocker to err in.
  const twoLevel = /^(co|com|org|net|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;
  const tail2 = parts.slice(-2).join('.');
  if (twoLevel.test(tail2) && parts.length >= 3) return parts.slice(-3).join('.');
  return tail2;
}

/** ABP separator class: anything outside [a-z0-9_-.%]. */
function isSeparator(ch) {
  return !/[a-z0-9_\-.%]/i.test(ch);
}

class FilterEngine {
  constructor() {
    /** token -> rule[] */
    this.blockBuckets = new Map();
    this.allowBuckets = new Map();
    /**
     * `$important` block rules live in their own index. ABP gives them
     * absolute precedence over exceptions, so they must be consulted before
     * we even look for an allowlist match — searching one mixed block index
     * would let an ordinary rule match first and lose that precedence.
     */
    this.importantBuckets = new Map();
    /** Rules with no usable token: tested on every request. */
    this.blockCatchAll = [];
    this.allowCatchAll = [];
    this.importantCatchAll = [];
    /** Cosmetic rules, indexed by domain plus a generic bucket. */
    this.cosmeticByDomain = new Map();
    this.cosmeticGeneric = [];
    this.cosmeticExceptions = new Map();
    this.stats = { network: 0, exceptions: 0, cosmetic: 0, lists: 0 };
    /** Small cache so repeated requests for the same URL skip matching. */
    this._cache = new Map();
    this._cacheLimit = 4096;
  }

  /**
   * Add a parsed list to the index.
   * @param {ReturnType<import('./filter-parser').parseList>} parsed
   */
  addParsedList(parsed) {
    // A frequency pass gives pickToken() a sense of which tokens are rare.
    const frequency = new Map();
    for (const rule of parsed.network.concat(parsed.exceptions)) {
      if (rule.isRegex) continue;
      for (const t of tokenize(rule.pattern.toLowerCase())) {
        frequency.set(t, (frequency.get(t) || 0) + 1);
      }
    }

    const place = (rule, buckets, catchAll) => {
      const token = pickToken(rule, frequency);
      if (token) {
        let bucket = buckets.get(token);
        if (!bucket) {
          bucket = [];
          buckets.set(token, bucket);
        }
        bucket.push(rule);
      } else {
        catchAll.push(rule);
      }
    };

    for (const rule of parsed.network) {
      if (rule.important) place(rule, this.importantBuckets, this.importantCatchAll);
      else place(rule, this.blockBuckets, this.blockCatchAll);
    }
    for (const rule of parsed.exceptions) place(rule, this.allowBuckets, this.allowCatchAll);

    for (const rule of parsed.cosmetic) {
      if (rule.domains.length) {
        for (const d of rule.domains) {
          let list = this.cosmeticByDomain.get(d);
          if (!list) {
            list = [];
            this.cosmeticByDomain.set(d, list);
          }
          list.push(rule);
        }
      } else {
        this.cosmeticGeneric.push(rule);
      }
    }
    for (const rule of parsed.cosmeticExceptions) {
      for (const d of rule.domains.length ? rule.domains : ['*']) {
        let list = this.cosmeticExceptions.get(d);
        if (!list) {
          list = [];
          this.cosmeticExceptions.set(d, list);
        }
        list.push(rule);
      }
    }

    this.stats.network += parsed.network.length;
    this.stats.exceptions += parsed.exceptions.length;
    this.stats.cosmetic += parsed.cosmetic.length;
    this.stats.lists += 1;
    this._cache.clear();
  }

  /** Drop everything — used when the user disables or reloads lists. */
  clear() {
    this.blockBuckets.clear();
    this.allowBuckets.clear();
    this.importantBuckets.clear();
    this.blockCatchAll = [];
    this.allowCatchAll = [];
    this.importantCatchAll = [];
    this.cosmeticByDomain.clear();
    this.cosmeticGeneric = [];
    this.cosmeticExceptions.clear();
    this.stats = { network: 0, exceptions: 0, cosmetic: 0, lists: 0 };
    this._cache.clear();
  }

  /**
   * Decide a request.
   * @param {{url:string, sourceUrl?:string, type?:string}} req
   * @returns {{block:boolean, rule?:object, reason?:string}}
   */
  match({ url, sourceUrl = '', type = 'other' }) {
    const cacheKey = type + ' ' + url + ' ' + sourceUrl;
    const cached = this._cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const result = this._matchUncached(url, sourceUrl, type);

    if (this._cache.size >= this._cacheLimit) {
      // Cheap eviction: drop the oldest quarter in insertion order.
      const drop = Math.floor(this._cacheLimit / 4);
      let n = 0;
      for (const k of this._cache.keys()) {
        this._cache.delete(k);
        if (++n >= drop) break;
      }
    }
    this._cache.set(cacheKey, result);
    return result;
  }

  _matchUncached(url, sourceUrl, type) {
    let target;
    try {
      target = new URL(url);
    } catch {
      return { block: false };
    }
    const lowerUrl = url.toLowerCase();
    const host = target.hostname.toLowerCase();

    let sourceHost = '';
    if (sourceUrl) {
      try {
        sourceHost = new URL(sourceUrl).hostname.toLowerCase();
      } catch {
        /* opaque origin — treated as first-party */
      }
    }
    const isThirdParty = sourceHost ? baseDomain(host) !== baseDomain(sourceHost) : false;

    const ctx = { lowerUrl, host, sourceHost, isThirdParty, type };
    const tokens = tokenize(lowerUrl);

    // 1. `$important` blocks win outright, even over exceptions.
    const importantRule = this._findMatch(
      this.importantBuckets, this.importantCatchAll, tokens, ctx);
    if (importantRule) return { block: true, rule: importantRule, reason: 'important' };

    // 2. No ordinary block rule means nothing to decide.
    const blockRule = this._findMatch(this.blockBuckets, this.blockCatchAll, tokens, ctx);
    if (!blockRule) return { block: false };

    // 3. An exception rescues an ordinary block.
    const allowRule = this._findMatch(this.allowBuckets, this.allowCatchAll, tokens, ctx);
    if (allowRule) return { block: false, rule: allowRule, reason: 'exception' };

    return { block: true, rule: blockRule, reason: 'block' };
  }

  _findMatch(buckets, catchAll, tokens, ctx) {
    const seen = new Set();
    for (const token of tokens) {
      const bucket = buckets.get(token);
      if (!bucket) continue;
      for (const rule of bucket) {
        if (seen.has(rule)) continue;
        seen.add(rule);
        if (this._ruleMatches(rule, ctx)) return rule;
      }
    }
    for (const rule of catchAll) {
      if (this._ruleMatches(rule, ctx)) return rule;
    }
    return null;
  }

  _ruleMatches(rule, ctx) {
    // Cheap discriminators first: type, party, domain scope.
    if (rule.types && !rule.types.has(ctx.type)) return false;
    if (rule.excludedTypes && rule.excludedTypes.has(ctx.type)) return false;
    if (rule.thirdParty !== null && rule.thirdParty !== ctx.isThirdParty) return false;

    if (rule.domains) {
      let ok = false;
      for (const d of rule.domains) {
        if (ctx.sourceHost && hostMatchesDomain(ctx.sourceHost, d)) {
          ok = true;
          break;
        }
      }
      if (!ok) return false;
    }
    if (rule.excludeDomains) {
      for (const d of rule.excludeDomains) {
        if (ctx.sourceHost && hostMatchesDomain(ctx.sourceHost, d)) return false;
      }
    }

    return this._patternMatches(rule, ctx);
  }

  _patternMatches(rule, ctx) {
    if (rule.isRegex) return rule.regex.test(ctx.lowerUrl);

    const url = ctx.lowerUrl;
    const pattern = rule.matchCase ? rule.pattern : rule.pattern.toLowerCase();

    if (rule.anchorDomain) {
      // `||foo.com^` must match at a label boundary of the URL's host.
      return this._matchDomainAnchored(pattern, url, ctx.host, rule.anchorEnd);
    }
    if (rule.anchorStart) {
      return this._wildcardMatch(pattern, url, 0, rule.anchorEnd);
    }

    // Unanchored: try each viable start offset. Patterns are short, and the
    // token index means non-candidates rarely reach this path at all.
    const literalHead = pattern.split(/[*^]/)[0];
    if (literalHead) {
      let idx = url.indexOf(literalHead);
      while (idx >= 0) {
        if (this._wildcardMatch(pattern, url, idx, rule.anchorEnd)) return true;
        idx = url.indexOf(literalHead, idx + 1);
      }
      return false;
    }
    for (let i = 0; i <= url.length; i++) {
      if (this._wildcardMatch(pattern, url, i, rule.anchorEnd)) return true;
    }
    return false;
  }

  _matchDomainAnchored(pattern, url, host, anchorEnd) {
    const schemeEnd = url.indexOf('://');
    if (schemeEnd < 0) return false;
    const hostStart = schemeEnd + 3;
    const hostEnd = hostStart + host.length;
    // Anchor at the host start or at any label boundary inside it, which is
    // how `||example.com` also matches `ads.example.com`.
    for (let i = hostStart; i <= hostEnd; i++) {
      if (i > hostStart && url[i - 1] !== '.') continue;
      if (this._wildcardMatch(pattern, url, i, anchorEnd)) return true;
    }
    return false;
  }

  /**
   * ABP wildcard matching anchored at a fixed offset.
   * `*` matches any run; `^` matches a separator character or end-of-URL.
   * Implemented as an iterative backtracking matcher (no regex compile per
   * rule, no recursion depth risk on long URLs).
   */
  _wildcardMatch(pattern, url, offset, anchorEnd) {
    let p = 0;
    let u = offset;
    let starP = -1;
    let starU = -1;

    while (p < pattern.length) {
      const pc = pattern[p];

      if (pc === '*') {
        starP = ++p;
        starU = u;
        continue;
      }
      if (u < url.length && (pc === url[u] || (pc === '^' && isSeparator(url[u])))) {
        p++;
        u++;
        continue;
      }
      if (pc === '^' && u === url.length) {
        // `^` also matches the end of the URL.
        p++;
        continue;
      }
      if (starP >= 0 && starU < url.length) {
        p = starP;
        u = ++starU;
        continue;
      }
      return false;
    }
    if (!anchorEnd) return true;
    // A pattern ending in `*` satisfies an end anchor by definition: the
    // wildcard absorbs whatever remains of the URL.
    if (starP === pattern.length) return true;
    return u === url.length;
  }

  /**
   * Cosmetic selectors applicable to a hostname, minus its exceptions.
   *
   * The two buckets are handled differently on purpose. *Specific* rules are
   * written for this exact site, so there are a handful and they can be
   * injected as a stylesheet immediately. *Generic* rules number in the tens
   * of thousands — injecting all of them as one stylesheet would hand the
   * style engine a selector list larger than most pages' own CSS and cost
   * more than the ads did.
   *
   * So generic rules come back indexed by their leading class/id token. The
   * content script only materialises the ones whose token actually appears
   * in the DOM, which is the approach uBlock Origin settled on for the same
   * reason.
   *
   * @returns {{specific:string[], genericByToken:Record<string,string[]>,
   *            genericOther:string[]}}
   */
  cosmeticFor(host) {
    const empty = { specific: [], genericByToken: {}, genericOther: [] };
    if (!host) return empty;

    const labels = [];
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) labels.push(parts.slice(i).join('.'));

    const excluded = new Set();
    for (const label of labels.concat('*')) {
      for (const rule of this.cosmeticExceptions.get(label) || []) excluded.add(rule.selector);
    }

    const specific = new Set();
    for (const label of labels) {
      for (const rule of this.cosmeticByDomain.get(label) || []) {
        if (!excluded.has(rule.selector)) specific.add(rule.selector);
      }
    }

    const genericByToken = Object.create(null);
    const genericOther = [];
    for (const rule of this.cosmeticGeneric) {
      if (excluded.has(rule.selector)) continue;
      if (rule.excludeDomains.some((d) => labels.includes(d))) continue;
      const token = leadingToken(rule.selector);
      if (token) {
        (genericByToken[token] ||= []).push(rule.selector);
      } else {
        genericOther.push(rule.selector);
      }
    }

    return { specific: Array.from(specific), genericByToken, genericOther };
  }
}

/**
 * The class or id a selector hinges on, e.g. `.ad-box > span` -> `.ad-box`.
 * Used to decide cheaply whether a generic rule can possibly apply to a page.
 * Returns null for selectors with no simple leading class/id hook.
 */
function leadingToken(selector) {
  const m = /^([#.])(-?[_a-zA-Z][\w-]*)/.exec(selector.trim());
  return m ? m[1] + m[2] : null;
}

module.exports = {
  FilterEngine, tokenize, completeTokens, baseDomain, hostMatchesDomain,
  isSeparator, leadingToken,
};
