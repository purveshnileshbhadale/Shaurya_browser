'use strict';
/**
 * Lightweight database client (spec §3).
 *
 * Two rules shape this, and both are enforced rather than documented:
 *
 * **Read-only.** The spec says "run read queries", and that is taken
 * literally: statements are checked against an allowlist of leading keywords
 * before execution, and SQLite connections are opened with `readOnly: true`
 * so the engine itself refuses a write even if the check were bypassed. A
 * browser side panel is the wrong place to discover you have dropped a table.
 *
 * **Local by default.** Connection targets are restricted to loopback unless
 * the user explicitly ticks "allow remote", because a database browser that
 * cheerfully connects anywhere is a credential-exfiltration tool waiting for
 * a bad paste.
 *
 * SQLite works with no dependency at all — `node:sqlite` is built into Node
 * 22. Postgres and MySQL need their drivers (`pg`, `mysql2`), which are
 * optional: if they are not installed the panel says which package to add
 * rather than failing with a module-not-found stack trace.
 */
const EventEmitter = require('node:events');
const path = require('node:path');
const crypto = require('node:crypto');

const { createLogger } = require('../../util/logger');

const log = createLogger('db');

/**
 * Statements that may run. Anything else — INSERT, UPDATE, DELETE, DROP,
 * ALTER, ATTACH, PRAGMA with a value — is refused before it reaches a driver.
 */
const READ_KEYWORDS = new Set(['select', 'with', 'explain', 'show', 'describe', 'desc']);

const DRIVERS = {
  sqlite: { module: null, install: null, name: 'SQLite' },
  postgres: { module: 'pg', install: 'npm i pg', name: 'PostgreSQL' },
  mysql: { module: 'mysql2/promise', install: 'npm i mysql2', name: 'MySQL / MariaDB' },
};

/** Row cap. A `SELECT *` on a big table must not lock up the renderer. */
const ROW_LIMIT = 500;

/**
 * Is this a read-only statement?
 *
 * Pure, and tested directly — this is the security boundary, so it must be
 * exercisable without a live database.
 *
 * @param {string} sql
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function isReadOnly(sql) {
  const text = String(sql || '');

  // Strip comments before looking at keywords, or `/* x */ DELETE ...` slips
  // past a naive prefix check.
  const stripped = text
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();

  if (!stripped) return { ok: false, reason: 'empty statement' };

  // Multiple statements are refused outright: allowing `SELECT 1; DROP TABLE t`
  // would make the keyword check meaningless.
  const withoutStrings = stripped.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  const semicolons = (withoutStrings.match(/;/g) || []).length;
  const trailingOnly = /;\s*$/.test(withoutStrings) && semicolons === 1;
  if (semicolons > 0 && !trailingOnly) {
    return { ok: false, reason: 'only one statement at a time' };
  }

  const keyword = stripped.match(/^\s*([a-z]+)/i)?.[1]?.toLowerCase();
  if (!keyword || !READ_KEYWORDS.has(keyword)) {
    return { ok: false, reason: `"${(keyword || '?').toUpperCase()}" is not a read statement` };
  }

  // Postgres lets a CTE both *contain* a writing statement
  // (`WITH x AS (DELETE ... RETURNING *)`) and be *followed* by one
  // (`WITH x AS (SELECT ...) INSERT INTO ...`). Both read as a SELECT at the
  // first keyword and both write, so scan the whole statement. String
  // literals are already blanked above, and requiring the second keyword
  // means an identifier like `delete_from` does not trip it.
  if (keyword === 'with'
    && /\b(insert\s+into|update\s+\w|delete\s+from|merge\s+into)\b/i.test(withoutStrings)) {
    return { ok: false, reason: 'a writing statement in a CTE is still a write' };
  }
  return { ok: true };
}

class DatabaseService extends EventEmitter {
  constructor({ settings, features }) {
    super();
    this.settings = settings;
    this.features = features;
    /** @type {Map<string, object>} */
    this.connections = new Map();
  }

  drivers() {
    return Object.entries(DRIVERS).map(([id, spec]) => {
      let available = true;
      if (spec.module) {
        try { require.resolve(spec.module); } catch { available = false; }
      }
      return { id, name: spec.name, available, install: spec.install };
    });
  }

  /**
   * Open a connection.
   *
   * @param {object} config
   * @param {'sqlite'|'postgres'|'mysql'} config.kind
   * @param {string} [config.file]      sqlite path
   * @param {string} [config.host]
   * @param {boolean} [config.allowRemote]
   */
  async connect(config) {
    if (!this.features.enabled('dbClient')) throw new Error('the database client is off');

    const { kind } = config;
    if (!DRIVERS[kind]) throw new Error(`unsupported database "${kind}"`);

    if (kind !== 'sqlite') {
      const host = config.host || '127.0.0.1';
      if (!isLoopback(host) && !config.allowRemote) {
        throw new Error(
          `${host} is not local. Tick "allow remote" if you really mean to `
          + 'connect a browser panel to a remote database.',
        );
      }
    }

    const id = crypto.randomUUID();
    const connection = kind === 'sqlite'
      ? await this._openSqlite(config)
      : await this._openServer(kind, config);

    this.connections.set(id, { id, kind, config: redact(config), ...connection });
    log.info(`connected: ${kind} (${id})`);
    this.emit('changed', this.list());
    return { id, kind, label: labelFor(config) };
  }

  async _openSqlite(config) {
    if (!config.file) throw new Error('a SQLite connection needs a file path');
    const { DatabaseSync } = require('node:sqlite');
    // readOnly at the engine level, so the keyword check is a second line of
    // defence rather than the only one.
    const db = new DatabaseSync(path.resolve(config.file), { readOnly: true });
    return {
      query: (sql) => {
        const stmt = db.prepare(sql);
        return { rows: stmt.all().slice(0, ROW_LIMIT) };
      },
      schema: () => {
        const tables = db.prepare(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') "
          + "AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).all();
        return tables.map((t) => ({
          name: t.name,
          kind: t.type,
          columns: db.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all().map((c) => ({
            name: c.name, type: c.type, notNull: Boolean(c.notnull), pk: Boolean(c.pk),
          })),
        }));
      },
      close: () => db.close(),
    };
  }

  async _openServer(kind, config) {
    const spec = DRIVERS[kind];
    let driver;
    try {
      driver = require(spec.module);
    } catch {
      throw new Error(`${spec.name} support needs its driver. Run: ${spec.install}`);
    }

    if (kind === 'postgres') {
      const client = new driver.Client({
        host: config.host || '127.0.0.1',
        port: config.port || 5432,
        user: config.user,
        password: config.password,
        database: config.database,
        // Never hang the panel on an unreachable host.
        connectionTimeoutMillis: 5000,
        statement_timeout: 15_000,
      });
      await client.connect();
      return {
        query: async (sql) => {
          const result = await client.query(sql);
          return { rows: (result.rows || []).slice(0, ROW_LIMIT), fields: result.fields?.map((f) => f.name) };
        },
        schema: async () => {
          const result = await client.query(
            `SELECT table_name, column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_schema NOT IN ('pg_catalog','information_schema')
             ORDER BY table_name, ordinal_position`,
          );
          return groupColumns(result.rows, 'table_name', 'column_name', 'data_type', 'is_nullable');
        },
        close: () => client.end(),
      };
    }

    const conn = await driver.createConnection({
      host: config.host || '127.0.0.1',
      port: config.port || 3306,
      user: config.user,
      password: config.password,
      database: config.database,
      connectTimeout: 5000,
    });
    return {
      query: async (sql) => {
        const [rows] = await conn.query(sql);
        return { rows: (Array.isArray(rows) ? rows : []).slice(0, ROW_LIMIT) };
      },
      schema: async () => {
        const [rows] = await conn.query(
          `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
                  DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
           ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        );
        return groupColumns(rows, 'table_name', 'column_name', 'data_type', 'is_nullable');
      },
      close: () => conn.end(),
    };
  }

  /** Run a statement, after proving it only reads. */
  async query(id, sql) {
    const connection = this.connections.get(id);
    if (!connection) throw new Error('no such connection');

    const verdict = isReadOnly(sql);
    if (!verdict.ok) {
      throw new Error(`Refused: ${verdict.reason}. This panel runs read queries only.`);
    }

    const started = Date.now();
    const result = await connection.query(sql);
    const rows = result.rows || [];

    return {
      rows,
      columns: result.fields || (rows[0] ? Object.keys(rows[0]) : []),
      rowCount: rows.length,
      truncated: rows.length >= ROW_LIMIT,
      ms: Date.now() - started,
    };
  }

  async schema(id) {
    const connection = this.connections.get(id);
    if (!connection) throw new Error('no such connection');
    return connection.schema();
  }

  async close(id) {
    const connection = this.connections.get(id);
    if (!connection) return { ok: true };
    try { await connection.close(); } catch { /* already gone */ }
    this.connections.delete(id);
    this.emit('changed', this.list());
    return { ok: true };
  }

  list() {
    return {
      connections: [...this.connections.values()].map((c) => ({
        id: c.id, kind: c.kind, label: labelFor(c.config),
      })),
      drivers: this.drivers(),
      readOnly: true,
      rowLimit: ROW_LIMIT,
    };
  }

  disposeAll() {
    for (const id of [...this.connections.keys()]) this.close(id);
  }
}

// ---------------------------------------------------------------------------

function isLoopback(host) {
  return ['127.0.0.1', '::1', 'localhost', '0.0.0.0'].includes(String(host).toLowerCase())
    || String(host).startsWith('/');   // a unix socket path is local by definition
}

function labelFor(config) {
  if (config.kind === 'sqlite') return path.basename(config.file || 'database');
  return `${config.user || ''}@${config.host || '127.0.0.1'}/${config.database || ''}`;
}

/** Never keep a password in a structure the renderer can ask for. */
function redact(config) {
  const { password, ...rest } = config;
  return { ...rest, password: password ? '••••' : '' };
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function groupColumns(rows, tableKey, colKey, typeKey, nullKey) {
  const byTable = new Map();
  for (const row of rows) {
    const table = row[tableKey];
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push({
      name: row[colKey],
      type: row[typeKey],
      notNull: String(row[nullKey]).toUpperCase() === 'NO',
    });
  }
  return [...byTable.entries()].map(([name, columns]) => ({ name, kind: 'table', columns }));
}

module.exports = { DatabaseService, isReadOnly, ROW_LIMIT, READ_KEYWORDS };
