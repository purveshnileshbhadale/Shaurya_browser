'use strict';
/**
 * Manifest parsing, mock pattern matching and Docker log demultiplexing.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  DepWatchService, parsePackageJson, parseRequirements, parseGoMod, parseCargoToml, pinned,
} = require('../src/main/services/devtools/depwatch');
const { matchesPattern } = require('../src/main/services/devtools/mocking');
const { demultiplex, dedupePorts } = require('../src/main/services/devtools/docker');
const { renderTypeRef, summariseSchema } = require('../src/main/services/devtools/graphql');
const { scoreSnippet } = require('../src/main/services/devtools/snippets');

// ---- manifest recognition -------------------------------------------------

test('manifests are recognised by filename, through a URL', () => {
  assert.equal(DepWatchService.recognise('https://github.com/a/b/raw/main/package.json')?.ecosystem, 'npm');
  assert.equal(DepWatchService.recognise('requirements.txt')?.ecosystem, 'PyPI');
  assert.equal(DepWatchService.recognise('go.mod?raw=1')?.ecosystem, 'Go');
  assert.equal(DepWatchService.recognise('index.html'), null);
});

test('version ranges pin to a concrete version', () => {
  assert.equal(pinned('^1.2.3'), '1.2.3');
  assert.equal(pinned('~0.4.11'), '0.4.11');
  assert.equal(pinned('>=2.0.0'), '2.0.0');
  assert.equal(pinned('1.0.0-beta.2'), '1.0.0-beta.2');
  assert.equal(pinned('*'), null);
});

test('package.json yields deps and marks devDependencies', () => {
  const deps = parsePackageJson(JSON.stringify({
    dependencies: { express: '^4.18.2' },
    devDependencies: { jest: '~29.7.0' },
  }));

  const express = deps.find((d) => d.name === 'express');
  assert.equal(express.version, '4.18.2');
  assert.equal(express.dev, false);
  assert.equal(deps.find((d) => d.name === 'jest').dev, true);
});

test('requirements.txt handles comments, extras and unpinned lines', () => {
  const deps = parseRequirements([
    '# a comment',
    'requests==2.31.0',
    'django>=4.2  # inline comment',
    'celery[redis]==5.3.4',
    '-r other.txt',
    '',
  ].join('\n'));

  assert.equal(deps.length, 3, 'the -r include and the comment are not dependencies');
  assert.equal(deps.find((d) => d.name === 'requests').version, '2.31.0');
  assert.equal(deps.find((d) => d.name === 'celery').version, '5.3.4');
});

test('go.mod parses a require block and flags indirect deps', () => {
  const deps = parseGoMod([
    'module example.com/x',
    'require (',
    '  github.com/gin-gonic/gin v1.9.1',
    '  golang.org/x/sys v0.15.0 // indirect',
    ')',
  ].join('\n'));

  assert.equal(deps.length, 2);
  assert.equal(deps[0].version, '1.9.1');
  assert.equal(deps[1].dev, true, 'indirect deps are marked so they can be de-emphasised');
});

test('Cargo.toml parses both simple and table dependency forms', () => {
  const deps = parseCargoToml([
    '[dependencies]',
    'serde = "1.0.193"',
    'tokio = { version = "1.35.0", features = ["full"] }',
    '',
    '[dev-dependencies]',
    'criterion = "0.5"',
  ].join('\n'));

  assert.equal(deps.length, 2, 'dev-dependencies are a separate section');
  assert.equal(deps.find((d) => d.name === 'serde').version, '1.0.193');
  assert.equal(deps.find((d) => d.name === 'tokio').version, '1.35.0');
});

test('a malformed manifest reports rather than throwing raw', () => {
  assert.throws(() => parsePackageJson('{not json'), /JSON/);
});

// ---- mock matching --------------------------------------------------------

test('a pattern without a wildcard matches as a substring', () => {
  assert.equal(matchesPattern('https://api.test/v1/users/7', '/v1/users'), true);
  assert.equal(matchesPattern('https://api.test/v1/posts', '/v1/users'), false);
});

test('* stays inside a path segment, ** crosses them', () => {
  assert.equal(matchesPattern('https://api.test/v1/users', 'https://api.test/v1/*'), true);
  assert.equal(matchesPattern('https://api.test/v1/users/7', 'https://api.test/v1/*'), false,
    'a single star must not cross a slash');
  assert.equal(matchesPattern('https://api.test/v1/users/7', 'https://api.test/**'), true);
});

test('regex metacharacters in a pattern are literal', () => {
  assert.equal(matchesPattern('https://api.test/a.b', 'https://api.test/a.b'), true);
  assert.equal(matchesPattern('https://api.test/axb', 'https://api.test/a.b'), false,
    'the dot must not act as a wildcard');
});

test('an unparseable pattern fails closed', () => {
  assert.equal(matchesPattern('https://x.test/', '['), false);
});

// ---- Docker ---------------------------------------------------------------

test('multiplexed docker logs are split by stream', () => {
  const frame = (stream, text) => {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  const lines = demultiplex(Buffer.concat([
    frame(1, 'listening on 3000\n'),
    frame(2, 'deprecation warning\n'),
  ]));

  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { stream: 'stdout', text: 'listening on 3000' });
  assert.deepEqual(lines[1], { stream: 'stderr', text: 'deprecation warning' });
});

test('un-multiplexed output falls back to plain text', () => {
  const lines = demultiplex(Buffer.from('plain line one\nplain line two\n'));
  assert.ok(lines.includes('plain line one'));
});

test('duplicate IPv4/IPv6 port bindings collapse to one row', () => {
  const ports = dedupePorts([
    { PublicPort: 5432, PrivatePort: 5432, Type: 'tcp', IP: '0.0.0.0' },
    { PublicPort: 5432, PrivatePort: 5432, Type: 'tcp', IP: '::' },
    { PrivatePort: 9000, Type: 'tcp' },
  ]);

  assert.equal(ports.length, 1, 'unpublished ports are not shown, duplicates collapse');
  assert.equal(ports[0].public, 5432);
});

// ---- GraphQL --------------------------------------------------------------

test('type references render in GraphQL notation', () => {
  assert.equal(renderTypeRef({ kind: 'SCALAR', name: 'String' }), 'String');
  assert.equal(
    renderTypeRef({ kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'ID' } }),
    'ID!',
  );
  assert.equal(
    renderTypeRef({
      kind: 'NON_NULL',
      ofType: { kind: 'LIST', ofType: { kind: 'NON_NULL', ofType: { name: 'User' } } },
    }),
    '[User!]!',
  );
});

test('schema summary drops introspection meta-types', () => {
  const schema = summariseSchema({
    queryType: { name: 'Query' },
    types: [
      { name: 'Query', kind: 'OBJECT', fields: [{ name: 'me', type: { name: 'User' }, args: [] }] },
      { name: '__Schema', kind: 'OBJECT', fields: [] },
      { name: 'User', kind: 'OBJECT', fields: [] },
    ],
  });

  assert.equal(schema.query, 'Query');
  assert.equal(schema.types.length, 2, '__Schema is noise in a schema browser');
  assert.ok(schema.index.every((t) => !t.name.startsWith('__')));
});

test('a missing schema is refused clearly', () => {
  assert.throws(() => summariseSchema(null), /no schema/);
});

// ---- snippets -------------------------------------------------------------

test('snippet ranking prefers title over tags over body', () => {
  const byTitle = { title: 'curl post', tags: [], body: '' };
  const byTag = { title: 'request', tags: ['curl'], body: '' };
  const byBody = { title: 'request', tags: [], body: 'curl -X POST' };

  assert.ok(scoreSnippet(byTitle, 'curl') > scoreSnippet(byTag, 'curl'));
  assert.ok(scoreSnippet(byTag, 'curl') > scoreSnippet(byBody, 'curl'));
  assert.equal(scoreSnippet({ title: 'x', tags: [], body: '' }, 'curl'), 0);
});
