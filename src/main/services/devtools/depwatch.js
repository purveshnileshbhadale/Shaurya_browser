'use strict';
/**
 * Dependency and vulnerability watcher (spec §3).
 *
 * When a manifest is opened in the browser — a `package.json` on GitHub, a
 * `requirements.txt` in a gist, a local file — this reads it and reports
 * which pinned versions are behind and which have known CVEs.
 *
 * Advisories come from **OSV.dev**, Google's open vulnerability database. It
 * is free, needs no key, has a batch endpoint, and covers npm, PyPI, Go,
 * crates.io, Maven and more from one query shape. The alternative (GitHub's
 * advisory API) needs a token and covers less.
 *
 * Only names and versions are sent — never the file, never the URL it came
 * from. A vulnerability checker that uploaded your private dependency graph
 * to answer the question would be a poor trade, so the request body is
 * exactly the ecosystem/name/version triples and nothing else.
 */
const EventEmitter = require('node:events');

const { createLogger } = require('../../util/logger');

const log = createLogger('depwatch');

const OSV_BATCH = 'https://api.osv.dev/v1/querybatch';
const NPM_REGISTRY = 'https://registry.npmjs.org';
const PYPI = 'https://pypi.org/pypi';

/** Manifests recognised, and how to read them. */
const MANIFESTS = {
  'package.json': { ecosystem: 'npm', parse: parsePackageJson },
  'package-lock.json': { ecosystem: 'npm', parse: parsePackageLock },
  'requirements.txt': { ecosystem: 'PyPI', parse: parseRequirements },
  'pyproject.toml': { ecosystem: 'PyPI', parse: parsePyproject },
  'go.mod': { ecosystem: 'Go', parse: parseGoMod },
  'Cargo.toml': { ecosystem: 'crates.io', parse: parseCargoToml },
};

class DepWatchService extends EventEmitter {
  constructor({ features }) {
    super();
    this.features = features;
    this._cache = new Map();
  }

  /** Does this URL or filename look like a manifest we can read? */
  static recognise(urlOrName) {
    const name = String(urlOrName).split(/[?#]/)[0].split('/').pop();
    return MANIFESTS[name] ? { name, ...MANIFESTS[name] } : null;
  }

  /**
   * Analyse manifest text.
   *
   * @param {string} filename
   * @param {string} text
   */
  async analyse(filename, text, fetchImpl = fetch) {
    if (!this.features.enabled('depWatch')) throw new Error('the dependency watcher is off');

    const spec = DepWatchService.recognise(filename);
    if (!spec) throw new Error(`${filename} is not a manifest Shaurya reads`);

    let deps;
    try {
      deps = spec.parse(text);
    } catch (err) {
      throw new Error(`could not parse ${spec.name}: ${err.message}`);
    }
    if (!deps.length) return { ecosystem: spec.ecosystem, dependencies: [], vulnerable: 0 };

    // Both lookups in parallel: they are independent and the panel needs both
    // before it can render a row.
    const [advisories, latest] = await Promise.all([
      this._advisories(spec.ecosystem, deps, fetchImpl).catch((err) => {
        log.debug(`OSV lookup failed: ${err.message}`);
        return new Map();
      }),
      this._latestVersions(spec.ecosystem, deps, fetchImpl).catch(() => new Map()),
    ]);

    const dependencies = deps.map((dep) => {
      const vulns = advisories.get(`${dep.name}@${dep.version}`) || [];
      const newest = latest.get(dep.name) || null;
      return {
        ...dep,
        latest: newest,
        outdated: Boolean(newest && dep.version && newest !== dep.version),
        vulnerabilities: vulns,
        severity: highestSeverity(vulns),
      };
    });

    // Vulnerable first, then outdated: a CVE is a different kind of problem
    // from being a minor version behind, and sorting them together buries it.
    dependencies.sort((a, b) => {
      const rank = (d) => (d.vulnerabilities.length ? 0 : d.outdated ? 1 : 2);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });

    const result = {
      ecosystem: spec.ecosystem,
      manifest: spec.name,
      dependencies,
      total: dependencies.length,
      vulnerable: dependencies.filter((d) => d.vulnerabilities.length).length,
      outdated: dependencies.filter((d) => d.outdated).length,
      source: 'osv.dev',
      privacyNote: 'Only package names and versions were sent. The file itself was not.',
    };

    this.emit('analysed', result);
    return result;
  }

  /** OSV batch query: one request for the whole manifest. */
  async _advisories(ecosystem, deps, fetchImpl) {
    const queries = deps
      .filter((d) => d.version)
      .map((d) => ({ package: { name: d.name, ecosystem }, version: d.version }));
    if (!queries.length) return new Map();

    const response = await fetchImpl(OSV_BATCH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries }),
    });
    if (!response.ok) throw new Error(`OSV returned ${response.status}`);

    const body = await response.json();
    const out = new Map();
    (body.results || []).forEach((result, index) => {
      const dep = deps.filter((d) => d.version)[index];
      if (!dep || !result.vulns?.length) return;
      out.set(`${dep.name}@${dep.version}`, result.vulns.map((v) => ({
        id: v.id,
        summary: v.summary || '',
        modified: v.modified,
        url: `https://osv.dev/vulnerability/${v.id}`,
        severity: v.database_specific?.severity || null,
      })));
    });
    return out;
  }

  /**
   * Newest published version per package.
   *
   * Serial with a small cache and only for npm/PyPI, because these are the
   * registries with a cheap single-package metadata endpoint. Go and crates
   * report advisories but not "latest", which the panel shows as a dash
   * rather than a wrong number.
   */
  async _latestVersions(ecosystem, deps, fetchImpl) {
    const out = new Map();
    if (!['npm', 'PyPI'].includes(ecosystem)) return out;

    for (const dep of deps.slice(0, 60)) {
      const key = `${ecosystem}:${dep.name}`;
      if (this._cache.has(key)) { out.set(dep.name, this._cache.get(key)); continue; }

      try {
        const url = ecosystem === 'npm'
          ? `${NPM_REGISTRY}/${encodeURIComponent(dep.name)}/latest`
          : `${PYPI}/${encodeURIComponent(dep.name)}/json`;
        // eslint-disable-next-line no-await-in-loop
        const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) continue;
        // eslint-disable-next-line no-await-in-loop
        const body = await response.json();
        const version = ecosystem === 'npm' ? body.version : body.info?.version;
        if (version) { out.set(dep.name, version); this._cache.set(key, version); }
      } catch { /* one package failing must not fail the report */ }
    }
    return out;
  }
}

// ===========================================================================
// Manifest parsers
// ===========================================================================

/** Strip range operators to the concrete version OSV wants. */
function pinned(range) {
  const match = String(range).match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
  return match ? match[1] : null;
}

function parsePackageJson(text) {
  const json = JSON.parse(text);
  const out = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(json[section] || {})) {
      out.push({ name, range, version: pinned(range), dev: section === 'devDependencies' });
    }
  }
  return out;
}

/** A lockfile gives exact versions, which is strictly better for advisories. */
function parsePackageLock(text) {
  const json = JSON.parse(text);
  const out = [];
  const packages = json.packages || {};
  for (const [path, meta] of Object.entries(packages)) {
    if (!path || !meta.version) continue;
    out.push({
      name: path.replace(/^node_modules\//, '').replace(/.*\/node_modules\//, ''),
      range: meta.version,
      version: meta.version,
      dev: meta.dev === true,
    });
  }
  return out;
}

function parseRequirements(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line || line.startsWith('-')) continue;
    const match = line.match(/^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*([<>=!~]+)?\s*([\w.]+)?/);
    if (!match) continue;
    out.push({ name: match[1], range: `${match[2] || ''}${match[3] || ''}`, version: match[3] || null });
  }
  return out;
}

function parsePyproject(text) {
  const out = [];
  // Both the PEP 621 and Poetry shapes, without pulling in a TOML parser for
  // what is a flat list of `name = "version"` lines in practice.
  const deps = String(text).match(/\[(?:tool\.poetry\.)?dependencies\]([\s\S]*?)(?:\n\[|$)/);
  if (deps) {
    for (const line of deps[1].split('\n')) {
      const match = line.match(/^\s*([A-Za-z0-9._-]+)\s*=\s*"?\^?~?([\d.]+)?/);
      if (match && match[1] !== 'python') {
        out.push({ name: match[1], range: match[2] || '', version: match[2] || null });
      }
    }
  }
  const pep621 = String(text).match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (pep621) {
    for (const entry of pep621[1].split(',')) {
      const match = entry.match(/"([A-Za-z0-9._-]+)\s*[><=~!]*\s*([\d.]+)?"/);
      if (match) out.push({ name: match[1], range: match[2] || '', version: match[2] || null });
    }
  }
  return out;
}

function parseGoMod(text) {
  const out = [];
  const block = String(text).match(/require\s*\(([\s\S]*?)\)/);
  const lines = block ? block[1].split('\n') : String(text).split('\n').filter((l) => l.startsWith('require '));
  for (const raw of lines) {
    const match = raw.replace(/^require\s+/, '').trim().match(/^([^\s]+)\s+v([\w.\-+]+)/);
    if (match) out.push({ name: match[1], range: `v${match[2]}`, version: match[2], dev: /\/\/ indirect/.test(raw) });
  }
  return out;
}

function parseCargoToml(text) {
  const out = [];
  const block = String(text).match(/\[dependencies\]([\s\S]*?)(?:\n\[|$)/);
  if (!block) return out;
  for (const line of block[1].split('\n')) {
    const simple = line.match(/^\s*([A-Za-z0-9._-]+)\s*=\s*"([^"]+)"/);
    if (simple) { out.push({ name: simple[1], range: simple[2], version: pinned(simple[2]) }); continue; }
    const table = line.match(/^\s*([A-Za-z0-9._-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/);
    if (table) out.push({ name: table[1], range: table[2], version: pinned(table[2]) });
  }
  return out;
}

const SEVERITY_ORDER = ['LOW', 'MODERATE', 'MEDIUM', 'HIGH', 'CRITICAL'];

function highestSeverity(vulns) {
  let best = null;
  for (const v of vulns) {
    const level = String(v.severity || '').toUpperCase();
    if (!SEVERITY_ORDER.includes(level)) continue;
    if (!best || SEVERITY_ORDER.indexOf(level) > SEVERITY_ORDER.indexOf(best)) best = level;
  }
  return best || (vulns.length ? 'UNKNOWN' : null);
}

module.exports = {
  DepWatchService, MANIFESTS,
  parsePackageJson, parseRequirements, parseGoMod, parseCargoToml, parsePyproject,
  pinned,
};
