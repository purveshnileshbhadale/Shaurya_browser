'use strict';
/**
 * The database panel's read-only guard.
 *
 * This is the security boundary for the feature, so it is tested as one:
 * the interesting cases are the ones that *look* like reads.
 */
const test = require('node:test');
const assert = require('node:assert');

const { isReadOnly } = require('../src/main/services/devtools/db');

const allowed = [
  'SELECT * FROM users',
  '  select 1  ',
  'SELECT * FROM t;',
  'WITH recent AS (SELECT * FROM logs) SELECT * FROM recent',
  'EXPLAIN SELECT * FROM t',
  'SHOW TABLES',
  'DESCRIBE users',
  '-- a comment first\nSELECT 1',
  '/* block */ SELECT 1',
];

const refused = [
  ['DELETE FROM users', /not a read statement/],
  ['UPDATE users SET admin = 1', /not a read statement/],
  ['INSERT INTO t VALUES (1)', /not a read statement/],
  ['DROP TABLE users', /not a read statement/],
  ['ALTER TABLE t ADD c INT', /not a read statement/],
  ['TRUNCATE t', /not a read statement/],
  ['ATTACH DATABASE \'x\' AS y', /not a read statement/],
  ['', /empty/],
  ['   ', /empty/],
];

for (const sql of allowed) {
  test(`allows: ${sql.trim().slice(0, 40)}`, () => {
    assert.equal(isReadOnly(sql).ok, true, `should have allowed: ${sql}`);
  });
}

for (const [sql, pattern] of refused) {
  test(`refuses: ${sql.trim().slice(0, 40) || '(empty)'}`, () => {
    const verdict = isReadOnly(sql);
    assert.equal(verdict.ok, false, `should have refused: ${sql}`);
    assert.match(verdict.reason, pattern);
  });
}

test('a write hidden behind a comment is refused', () => {
  // A naive prefix check on the raw string would see "/*" and give up, or
  // worse, see nothing it recognised and pass it through.
  const verdict = isReadOnly('/* SELECT */ DELETE FROM users');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not a read statement/);
});

test('a write hidden behind a line comment is refused', () => {
  assert.equal(isReadOnly('-- SELECT 1\nDROP TABLE t').ok, false);
});

test('stacked statements are refused even when the first one reads', () => {
  const verdict = isReadOnly('SELECT 1; DROP TABLE users');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /one statement at a time/);
});

test('a single trailing semicolon is fine', () => {
  assert.equal(isReadOnly('SELECT 1;').ok, true);
  assert.equal(isReadOnly('SELECT 1;   ').ok, true);
});

test('a semicolon inside a string literal is not a statement separator', () => {
  const verdict = isReadOnly("SELECT * FROM t WHERE note = 'a; b'");
  assert.equal(verdict.ok, true, 'refusing this would break ordinary queries');
});

test('a writing CTE is refused despite starting with WITH', () => {
  const verdict = isReadOnly(
    'WITH removed AS (DELETE FROM users WHERE id = 1 RETURNING *) SELECT * FROM removed',
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /CTE/);
});

test('a read-only CTE is still allowed', () => {
  assert.equal(
    isReadOnly('WITH t AS (SELECT 1 AS n) SELECT * FROM t').ok,
    true,
  );
});

test('case and leading whitespace do not matter', () => {
  assert.equal(isReadOnly('\n\t  SeLeCt 1').ok, true);
  assert.equal(isReadOnly('\n\t  dElEtE FROM t').ok, false);
});

test('null and non-string input are refused rather than throwing', () => {
  for (const input of [null, undefined, 42, {}]) {
    assert.doesNotThrow(() => isReadOnly(input));
    assert.equal(isReadOnly(input).ok, false);
  }
});
