'use strict';
/**
 * Bookmarks, including the git-aware hover cards from spec §5.
 *
 * A bookmark pointing at a GitHub or GitLab pull request gets enriched with
 * live PR state — review status, CI checks, changed files — so a bookmarks
 * bar of open PRs becomes a dashboard rather than a list of links.
 */
const EventEmitter = require('node:events');
const { JsonStore } = require('../util/json-store');
const paths = require('../util/paths');
const { uid } = require('../util/id');
const { request } = require('../util/net');
const { createLogger } = require('../util/logger');

const log = createLogger('bookmarks');

/** Git card responses are cached briefly; PR state does not change per-hover. */
const CARD_TTL_MS = 90_000;

class BookmarkService extends EventEmitter {
  constructor(settings, features) {
    super();
    this.settings = settings;
    this.features = features;
    this.store = new JsonStore(paths.bookmarksFile(), {
      folders: [{ id: 'root', name: 'Bookmarks', parentId: null }],
      items: [],
    });
    this._cardCache = new Map();
  }

  // ---- CRUD ------------------------------------------------------------

  list({ folderId } = {}) {
    const items = folderId
      ? this.store.data.items.filter((b) => b.folderId === folderId)
      : this.store.data.items;
    return items.map((b) => ({ ...b, git: parseGitUrl(b.url) }));
  }

  folders() {
    return this.store.data.folders.slice();
  }

  add({ url, title, folderId = 'root', tags = [] }) {
    if (!url) throw new Error('a bookmark needs a URL');
    const existing = this.store.data.items.find((b) => b.url === url && b.folderId === folderId);
    if (existing) return existing;

    const item = {
      id: uid('b_'),
      url,
      title: title || url,
      folderId,
      tags,
      created: Date.now(),
      // Recognised at save time so the UI can badge it immediately.
      git: parseGitUrl(url),
    };
    this.store.data.items.push(item);
    this.store.save();
    this.emit('changed');
    return item;
  }

  update(id, patch) {
    const item = this.store.data.items.find((b) => b.id === id);
    if (!item) throw new Error(`unknown bookmark ${id}`);
    Object.assign(item, patch, { id: item.id });
    if (patch.url) item.git = parseGitUrl(patch.url);
    this.store.save();
    this.emit('changed');
    return item;
  }

  remove(id) {
    const idx = this.store.data.items.findIndex((b) => b.id === id);
    if (idx < 0) return false;
    this.store.data.items.splice(idx, 1);
    this.store.save();
    this.emit('changed');
    return true;
  }

  createFolder(name, parentId = 'root') {
    const folder = { id: uid('f_'), name, parentId };
    this.store.data.folders.push(folder);
    this.store.save();
    this.emit('changed');
    return folder;
  }

  isBookmarked(url) {
    return this.store.data.items.some((b) => b.url === url);
  }

  // ---- git-aware hover cards (spec §5) ---------------------------------

  /**
   * Fetch live state for a GitHub/GitLab URL.
   *
   * Uses unauthenticated public API by default; if the user has stored a
   * token in the vault it is used, which raises the rate limit and exposes
   * private repositories they already have access to.
   *
   * @param {string} url
   * @returns {Promise<object|null>}
   */
  async gitCard(url, { token } = {}) {
    if (!this.features.enabled('gitCards')) return null;
    const info = parseGitUrl(url);
    if (!info) return null;

    const cacheKey = `${info.host}:${info.owner}/${info.repo}#${info.number || info.kind}`;
    const cached = this._cardCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CARD_TTL_MS) return cached.data;

    let data = null;
    try {
      data = info.host === 'github'
        ? await this._githubCard(info, token)
        : await this._gitlabCard(info, token);
    } catch (err) {
      log.warn(`git card for ${url}: ${err.message}`);
      data = { ...info, error: err.message };
    }

    this._cardCache.set(cacheKey, { at: Date.now(), data });
    return data;
  }

  async _githubCard(info, token) {
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'Aether-Browser',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const api = 'https://api.github.com';

    if (info.kind === 'pull' && info.number) {
      const pr = await getJson(`${api}/repos/${info.owner}/${info.repo}/pulls/${info.number}`, headers);
      // Check runs hang off the head commit, not the PR itself.
      let checks = null;
      try {
        const runs = await getJson(
          `${api}/repos/${info.owner}/${info.repo}/commits/${pr.head.sha}/check-runs`, headers);
        const conclusions = (runs.check_runs || []).map((r) => r.conclusion || r.status);
        checks = {
          total: runs.total_count || 0,
          passed: conclusions.filter((c) => c === 'success').length,
          failed: conclusions.filter((c) => c === 'failure' || c === 'timed_out').length,
          pending: conclusions.filter((c) => c === 'queued' || c === 'in_progress').length,
          runs: (runs.check_runs || []).slice(0, 8).map((r) => ({
            name: r.name, conclusion: r.conclusion, status: r.status, url: r.html_url,
          })),
        };
      } catch { /* check runs need extra scopes on private repos */ }

      return {
        ...info,
        type: 'pull-request',
        title: pr.title,
        state: pr.merged ? 'merged' : pr.state,
        draft: pr.draft,
        author: pr.user?.login,
        branch: `${pr.head?.ref} → ${pr.base?.ref}`,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        comments: pr.comments + (pr.review_comments || 0),
        mergeable: pr.mergeable,
        updatedAt: pr.updated_at,
        checks,
      };
    }

    if (info.kind === 'issues' && info.number) {
      const issue = await getJson(`${api}/repos/${info.owner}/${info.repo}/issues/${info.number}`, headers);
      return {
        ...info,
        type: 'issue',
        title: issue.title,
        state: issue.state,
        author: issue.user?.login,
        labels: (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
        comments: issue.comments,
        updatedAt: issue.updated_at,
      };
    }

    const repo = await getJson(`${api}/repos/${info.owner}/${info.repo}`, headers);
    return {
      ...info,
      type: 'repository',
      title: repo.full_name,
      description: repo.description,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      openIssues: repo.open_issues_count,
      language: repo.language,
      defaultBranch: repo.default_branch,
      updatedAt: repo.pushed_at,
    };
  }

  async _gitlabCard(info, token) {
    const headers = {
      'user-agent': 'Aether-Browser',
      ...(token ? { 'private-token': token } : {}),
    };
    const project = encodeURIComponent(`${info.owner}/${info.repo}`);
    const api = 'https://gitlab.com/api/v4';

    if (info.kind === 'merge_requests' && info.number) {
      const mr = await getJson(`${api}/projects/${project}/merge_requests/${info.number}`, headers);
      return {
        ...info,
        type: 'merge-request',
        title: mr.title,
        state: mr.state,
        draft: mr.draft,
        author: mr.author?.username,
        branch: `${mr.source_branch} → ${mr.target_branch}`,
        updatedAt: mr.updated_at,
        checks: mr.pipeline
          ? { total: 1, passed: mr.pipeline.status === 'success' ? 1 : 0,
              failed: mr.pipeline.status === 'failed' ? 1 : 0,
              pending: /running|pending/.test(mr.pipeline.status) ? 1 : 0, runs: [] }
          : null,
      };
    }

    const proj = await getJson(`${api}/projects/${project}`, headers);
    return {
      ...info,
      type: 'repository',
      title: proj.path_with_namespace,
      description: proj.description,
      stars: proj.star_count,
      forks: proj.forks_count,
      defaultBranch: proj.default_branch,
      updatedAt: proj.last_activity_at,
    };
  }

  exportAll() {
    return { folders: this.store.data.folders, items: this.store.data.items };
  }

  importAll({ folders = [], items = [] }) {
    const known = new Set(this.store.data.items.map((b) => b.url + '|' + b.folderId));
    for (const f of folders) {
      if (!this.store.data.folders.some((x) => x.id === f.id)) this.store.data.folders.push(f);
    }
    for (const b of items) {
      if (!known.has(b.url + '|' + b.folderId)) this.store.data.items.push(b);
    }
    this.store.save();
    this.emit('changed');
  }

  flush() {
    this.store.flush();
  }
}

/** Small helper so the card code reads linearly. */
async function getJson(url, headers) {
  const res = await request(url, { headers, timeout: 12000 });
  if (res.status === 403 || res.status === 429) {
    throw new Error('rate limited — add a token in Settings to raise the limit');
  }
  if (res.status === 404) throw new Error('not found (private repository?)');
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(res.body.toString('utf8'));
}

/**
 * Recognise a GitHub/GitLab URL.
 * @returns {{host:'github'|'gitlab', owner, repo, kind, number}|null}
 */
function parseGitUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname === 'github.com' ? 'github'
    : u.hostname === 'gitlab.com' ? 'gitlab'
      : null;
  if (!host) return null;

  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, ...rest] = parts;
  // GitLab nests merge requests under `/-/`.
  const tail = rest.filter((p) => p !== '-');
  const kind = tail[0] || 'repo';
  const number = /^\d+$/.test(tail[1] || '') ? Number(tail[1]) : null;

  return { host, owner, repo: repo.replace(/\.git$/, ''), kind, number, url };
}

module.exports = { BookmarkService, parseGitUrl };
