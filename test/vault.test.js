'use strict';
/**
 * Vault tests.
 *
 * These assert the properties the vault's whole value rests on: the file is
 * opaque without the master password, tampering is detected rather than
 * silently tolerated, and a wrong password is refused.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// The vault reaches for Electron's userData path; point it at a temp dir.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-vault-'));
process.env.AETHER_USER_DATA = tmpRoot;

const { seal, open } = require('../src/main/services/passwords/vault');

test('seal/open round-trips', () => {
  const key = crypto.randomBytes(32);
  const message = Buffer.from('correct horse battery staple', 'utf8');
  const sealed = seal(key, message);
  assert.notEqual(sealed.toString('hex'), message.toString('hex'));
  assert.equal(open(key, sealed).toString('utf8'), 'correct horse battery staple');
});

test('every seal uses a fresh nonce', () => {
  const key = crypto.randomBytes(32);
  const a = seal(key, Buffer.from('same'));
  const b = seal(key, Buffer.from('same'));
  assert.notEqual(a.toString('hex'), b.toString('hex'),
    'identical plaintext must not produce identical ciphertext');
  assert.notEqual(a.subarray(0, 12).toString('hex'), b.subarray(0, 12).toString('hex'));
});

test('the wrong key cannot open a sealed blob', () => {
  const sealed = seal(crypto.randomBytes(32), Buffer.from('secret'));
  assert.throws(() => open(crypto.randomBytes(32), sealed));
});

test('tampering with the ciphertext is detected, not tolerated', () => {
  const key = crypto.randomBytes(32);
  const sealed = seal(key, Buffer.from('transfer $10 to alice'));

  // Flip one bit in the ciphertext body.
  const tampered = Buffer.from(sealed);
  tampered[20] ^= 0x01;
  assert.throws(() => open(key, tampered), /unable to authenticate|bad decrypt|auth/i,
    'GCM must reject a modified blob rather than returning garbage');
});

test('tampering with the auth tag is detected', () => {
  const key = crypto.randomBytes(32);
  const sealed = seal(key, Buffer.from('hello'));
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => open(key, tampered));
});

test('a full vault lifecycle keeps the file opaque on disk', async (t) => {
  // Fresh directory so this test owns its vault file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-vault2-'));
  process.env.AETHER_USER_DATA = dir;

  // paths.js memoises the root, so load a private copy of the module graph.
  const modulePath = require.resolve('../src/main/services/passwords/vault');
  const pathsPath = require.resolve('../src/main/util/paths');
  delete require.cache[modulePath];
  delete require.cache[pathsPath];
  const { VaultService } = require(modulePath);

  const features = { enabled: () => true };
  const settings = { get: () => undefined, set: () => {} };
  const vault = new VaultService(settings, features);

  assert.equal(vault.exists, false);
  assert.equal(vault.unlocked, false);

  const { recoveryKey } = await vault.create({ masterPassword: 'a-long-master-password' });
  assert.match(recoveryKey, /^[A-Z0-9]{5}(-[A-Z0-9]{5})+$/, 'recovery key is grouped for reading');

  vault.add({ origin: 'https://example.com', username: 'ada', password: 'hunter2hunter2' });
  vault.add({ origin: 'https://bank.example', username: 'ada@x.dev', password: 'Tr0ub4dor&3xyz' });

  // The listing must not carry passwords.
  const listed = vault.list();
  assert.equal(listed.length, 2);
  for (const e of listed) {
    assert.equal('password' in e, false, 'list() must never include the secret');
    assert.equal(e.hasPassword, true);
  }

  // The file must reveal neither passwords nor which sites are stored.
  const onDisk = fs.readFileSync(path.join(dir, 'vault.aeth'), 'utf8');
  assert.equal(onDisk.includes('hunter2'), false, 'password must not appear in the file');
  assert.equal(onDisk.includes('bank.example'), false, 'site list must not leak either');
  assert.equal(onDisk.includes('ada'), false);

  // Reveal is explicit and returns the real secret.
  const revealed = vault.reveal(listed[0].id);
  assert.equal(revealed.password, 'hunter2hunter2');

  // Lock wipes cleartext.
  vault.lock();
  assert.equal(vault.unlocked, false);
  assert.throws(() => vault.list(), /locked/);

  // The wrong password is refused.
  await assert.rejects(
    vault.unlock({ masterPassword: 'not-the-password' }), /incorrect master password/);

  // The right one works, and the data survived a lock/unlock cycle.
  await vault.unlock({ masterPassword: 'a-long-master-password' });
  assert.equal(vault.list().length, 2);

  // The recovery key is an independent way in.
  vault.lock();
  await vault.unlock({ recoveryKey });
  assert.equal(vault.list().length, 2, 'recovery key opens the same vault');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('candidatesFor matches subdomains but not lookalike hosts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-vault3-'));
  process.env.AETHER_USER_DATA = dir;
  delete require.cache[require.resolve('../src/main/services/passwords/vault')];
  delete require.cache[require.resolve('../src/main/util/paths')];
  const { VaultService } = require('../src/main/services/passwords/vault');

  const vault = new VaultService(
    { get: () => undefined, set: () => {} }, { enabled: () => true });
  await vault.create({ masterPassword: 'another-long-password' });
  vault.add({ origin: 'https://example.com', username: 'ada', password: 'pw-for-example' });

  assert.equal(vault.candidatesFor('https://example.com').length, 1);
  assert.equal(vault.candidatesFor('https://accounts.example.com').length, 1,
    'subdomains of a saved site are offered the credential');
  assert.equal(vault.candidatesFor('https://example.com.evil.net').length, 0,
    'a lookalike host must never be offered the credential');
  assert.equal(vault.candidatesFor('https://notexample.com').length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('generated passwords hit the requested length and alphabet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-vault4-'));
  process.env.AETHER_USER_DATA = dir;
  delete require.cache[require.resolve('../src/main/services/passwords/vault')];
  delete require.cache[require.resolve('../src/main/util/paths')];
  const { VaultService } = require('../src/main/services/passwords/vault');
  const vault = new VaultService({ get: () => undefined, set: () => {} }, { enabled: () => true });

  const { password, entropyBits } = vault.generate({ length: 24 });
  assert.equal(password.length, 24);
  assert.ok(entropyBits > 128, `expected >128 bits, got ${entropyBits}`);
  assert.equal(/[lIO01]/.test(password), false, 'ambiguous characters are excluded by default');

  // Distinctness across many draws — a broken RNG would repeat.
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(vault.generate({ length: 16 }).password);
  assert.equal(seen.size, 200);

  fs.rmSync(dir, { recursive: true, force: true });
});
