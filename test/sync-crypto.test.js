'use strict';
/**
 * Sync crypto tests.
 *
 * These assert the properties the "zero-knowledge" claim actually rests on:
 * ciphertext reveals nothing, ids are blinded and non-invertible, records
 * cannot be moved between collections, and two devices with the same
 * passphrase agree on ids without ever exchanging one.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const {
  deriveKeys, deriveFromKey, sealRecord, openRecord, blindId,
  accountId, authProof, generateRecoveryPhrase,
} = require('../src/main/services/sync/crypto');

const SALT = Buffer.alloc(32, 7);

test('key derivation is deterministic and separates purposes', async () => {
  const a = await deriveKeys('correct horse battery staple', SALT);
  const b = await deriveKeys('correct horse battery staple', SALT);

  assert.equal(a.root.toString('hex'), b.root.toString('hex'), 'same input, same keys');
  for (const purpose of ['data', 'id', 'auth']) {
    assert.equal(a[purpose].length, 32);
    assert.equal(a[purpose].toString('hex'), b[purpose].toString('hex'));
  }
  // The three subkeys must be independent: leaking one must not reveal another.
  const keys = [a.data, a.id, a.auth].map((k) => k.toString('hex'));
  assert.equal(new Set(keys).size, 3, 'subkeys must all differ');
  assert.equal(keys.includes(a.root.toString('hex')), false, 'no subkey equals the root');
});

test('a different passphrase yields entirely different keys', async () => {
  const a = await deriveKeys('passphrase one', SALT);
  const b = await deriveKeys('passphrase two', SALT);
  assert.notEqual(a.root.toString('hex'), b.root.toString('hex'));
  assert.notEqual(a.data.toString('hex'), b.data.toString('hex'));
});

test('a different salt yields different keys for the same passphrase', async () => {
  const a = await deriveKeys('same', Buffer.alloc(32, 1));
  const b = await deriveKeys('same', Buffer.alloc(32, 2));
  assert.notEqual(a.root.toString('hex'), b.root.toString('hex'));
});

test('deriveFromKey produces the same hierarchy shape', async () => {
  const keys = await deriveFromKey(crypto.randomBytes(32));
  assert.equal(keys.data.length, 32);
  assert.equal(keys.id.length, 32);
  assert.equal(keys.auth.length, 32);
  await assert.rejects(() => deriveFromKey(Buffer.alloc(16)), /32 bytes/);
});

test('a record round-trips through seal and open', async () => {
  const keys = await deriveKeys('pw', SALT);
  const value = { url: 'https://example.com/secret-page', title: 'Quarterly numbers' };

  const sealed = sealRecord(keys, {
    collection: 'bookmarks', id: 'bm-1', value, updatedAt: 1700000000,
  });
  const opened = openRecord(keys, {
    collection: 'bookmarks', id: sealed.id, ciphertext: sealed.ciphertext,
  });

  assert.deepEqual(opened.value, value);
  assert.equal(opened.updatedAt, 1700000000);
});

test('ciphertext leaks neither content nor the local id', async () => {
  const keys = await deriveKeys('pw', SALT);
  const sealed = sealRecord(keys, {
    collection: 'bookmarks',
    id: 'my-local-bookmark-id',
    value: { url: 'https://intranet.acme.corp/payroll', title: 'Payroll' },
    updatedAt: 1,
  });

  const wire = JSON.stringify(sealed);
  for (const secret of ['intranet', 'acme', 'payroll', 'Payroll', 'my-local-bookmark-id']) {
    assert.equal(wire.includes(secret), false, `"${secret}" must not appear on the wire`);
  }
});

test('record ids are blinded, deterministic, and collection-scoped', async () => {
  const keys = await deriveKeys('pw', SALT);

  const a = blindId(keys, 'bookmarks', 'item-1');
  const b = blindId(keys, 'bookmarks', 'item-1');
  assert.equal(a, b, 'two devices must agree without exchanging anything');

  assert.notEqual(a, blindId(keys, 'bookmarks', 'item-2'), 'different items differ');
  assert.notEqual(a, blindId(keys, 'history', 'item-1'), 'same id in another collection differs');
  assert.equal(a.includes('item-1'), false, 'the local id must not be recoverable');
});

test('a different account cannot derive the same record id', async () => {
  const mine = await deriveKeys('my passphrase', SALT);
  const theirs = await deriveKeys('their passphrase', SALT);
  assert.notEqual(
    blindId(mine, 'bookmarks', 'shared-url'),
    blindId(theirs, 'bookmarks', 'shared-url'),
    'the server must not be able to correlate two accounts by record id'
  );
});

test('tampered ciphertext fails to open rather than decrypting to garbage', async () => {
  const keys = await deriveKeys('pw', SALT);
  const sealed = sealRecord(keys, {
    collection: 'passwords', id: 'p1', value: { secret: 'hunter2' }, updatedAt: 1,
  });

  const raw = Buffer.from(sealed.ciphertext, 'base64');
  raw[20] ^= 0x01;
  assert.throws(() => openRecord(keys, {
    collection: 'passwords', id: sealed.id, ciphertext: raw.toString('base64'),
  }));
});

test('a record cannot be moved between collections by the server', async () => {
  const keys = await deriveKeys('pw', SALT);
  const sealed = sealRecord(keys, {
    collection: 'passwords', id: 'p1', value: { secret: 'hunter2' }, updatedAt: 1,
  });

  // The collection is bound in as AAD, so replaying it elsewhere fails.
  assert.throws(
    () => openRecord(keys, {
      collection: 'bookmarks', id: sealed.id, ciphertext: sealed.ciphertext,
    }),
    /unable to authenticate|bad decrypt|auth/i
  );
});

test('the wrong key cannot open a record', async () => {
  const mine = await deriveKeys('mine', SALT);
  const theirs = await deriveKeys('theirs', SALT);
  const sealed = sealRecord(mine, {
    collection: 'notes', id: 'n1', value: { text: 'private' }, updatedAt: 1,
  });
  assert.throws(() => openRecord(theirs, {
    collection: 'notes', id: sealed.id, ciphertext: sealed.ciphertext,
  }));
});

test('sealing the same value twice produces different ciphertext', async () => {
  const keys = await deriveKeys('pw', SALT);
  const args = { collection: 'notes', id: 'n1', value: { text: 'same' }, updatedAt: 1 };
  const a = sealRecord(keys, args);
  const b = sealRecord(keys, args);

  assert.equal(a.id, b.id, 'the id is stable so updates replace rather than duplicate');
  assert.notEqual(a.ciphertext, b.ciphertext, 'a fresh nonce every time');
});

test('account id is stable and reveals nothing about the passphrase', async () => {
  const keys = await deriveKeys('a fairly long passphrase', SALT);
  const id = accountId(keys);
  assert.equal(id, accountId(keys));
  assert.equal(id.length, 32);
  assert.equal(id.includes('passphrase'), false);
});

test('auth proofs are request-bound and time-bound', async () => {
  const keys = await deriveKeys('pw', SALT);
  const base = { method: 'POST', path: '/v1/records', body: '{"a":1}', timestamp: 1700000000000 };

  const proof = authProof(keys, base);
  assert.equal(proof.signature, authProof(keys, base).signature, 'deterministic for one request');

  assert.notEqual(proof.signature, authProof(keys, { ...base, method: 'GET' }).signature);
  assert.notEqual(proof.signature, authProof(keys, { ...base, path: '/v1/other' }).signature);
  assert.notEqual(proof.signature, authProof(keys, { ...base, body: '{"a":2}' }).signature);
  assert.notEqual(proof.signature, authProof(keys, { ...base, timestamp: 1700000001000 }).signature,
    'a captured proof must not be replayable later');
});

test('recovery phrases are unambiguous and unique', () => {
  const phrase = generateRecoveryPhrase();
  assert.match(phrase, /^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
  assert.equal(/[ILOU]/.test(phrase), false, 'look-alike glyphs are excluded');

  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(generateRecoveryPhrase());
  assert.equal(seen.size, 500);
});
