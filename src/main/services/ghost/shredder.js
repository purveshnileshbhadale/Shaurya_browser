'use strict';
/**
 * Secure file deletion (spec §7).
 *
 * An honest note about what this can and cannot promise, because "secure
 * delete" is a phrase that invites overclaiming:
 *
 * Overwriting a file's bytes in place reliably destroys the data **on a
 * traditional spinning disk with no filesystem journaling of file contents**.
 * On an SSD, on a copy-on-write filesystem (APFS, Btrfs, ZFS), or inside a
 * VM with a snapshotting host, the overwrite may land on freshly allocated
 * blocks and leave the originals recoverable at the hardware layer. Wear
 * levelling in particular is designed to *avoid* rewriting the same cell.
 *
 * So: this raises the cost of recovery substantially, and the UI says that
 * rather than claiming erasure. For genuinely sensitive material the only
 * complete answer is full-disk encryption, which is an OS decision, not a
 * browser one — and the panel says that too.
 *
 * Three passes by default: random, complement, random. More passes is
 * cargo-culted from 1990s magnetic media guidance (Gutmann's 35-pass scheme
 * targets MFM/RLL encodings that no current drive uses) and mostly costs
 * time. The filename is also overwritten by renaming before unlink, because
 * a directory entry can outlive the data it pointed at.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLogger } = require('../../util/logger');

const log = createLogger('shred');

/** Write in 1 MiB blocks: large enough to be fast, small enough to bound RAM. */
const BLOCK = 1024 * 1024;

/**
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.passes=3]
 * @returns {Promise<{path:string, bytes:number, passes:number, renamed:boolean}>}
 */
async function shred(filePath, { passes = 3 } = {}) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('only regular files can be shredded');

  const size = stat.size;
  const handle = await fs.open(filePath, 'r+');

  try {
    for (let pass = 0; pass < passes; pass += 1) {
      await overwrite(handle, size, pass);
      // Force each pass to the device before the next one starts, or the
      // page cache may coalesce them into a single physical write and the
      // extra passes buy nothing at all.
      await handle.sync();
    }
    // Collapse the file so its length stops being a hint about the content.
    await handle.truncate(0);
    await handle.sync();
  } finally {
    await handle.close();
  }

  // Rename before unlink: the old directory entry (and therefore the
  // original filename, which is often descriptive enough to matter) is
  // replaced rather than merely freed.
  let renamed = false;
  let target = filePath;
  try {
    const dir = path.dirname(filePath);
    for (let i = 0; i < 3; i += 1) {
      const next = path.join(dir, crypto.randomBytes(12).toString('hex'));
      await fs.rename(target, next);
      target = next;
      renamed = true;
    }
  } catch (err) {
    log.debug(`rename before unlink failed: ${err.message}`);
  }

  await fs.unlink(target);
  log.info(`shredded ${path.basename(filePath)} (${size} bytes, ${passes} passes)`);

  return { path: filePath, bytes: size, passes, renamed };
}

/**
 * One overwrite pass.
 *
 * Even passes are random; odd passes are the complement of a fixed byte, so
 * the sequence flips as many cells as possible between passes rather than
 * writing statistically similar random data every time.
 */
async function overwrite(handle, size, pass) {
  const useRandom = pass % 2 === 0;
  const fill = useRandom ? null : Buffer.alloc(BLOCK, pass % 4 === 1 ? 0xFF : 0x00);

  let written = 0;
  while (written < size) {
    const length = Math.min(BLOCK, size - written);
    const block = useRandom
      ? crypto.randomBytes(length)
      : fill.subarray(0, length);
    await handle.write(block, 0, length, written);
    written += length;
  }
}

/**
 * What the UI should say before the user commits. Kept next to the
 * implementation so the claim and the code cannot drift apart.
 */
function caveat() {
  return {
    headline: 'Overwrites the file before deleting it.',
    detail: 'On an SSD, or a copy-on-write filesystem like APFS or Btrfs, '
      + 'wear levelling can leave the original blocks intact underneath. This '
      + 'raises the cost of recovery a great deal; it is not a guarantee of '
      + 'erasure. Full-disk encryption is the only complete answer, and that '
      + 'is a setting in your operating system rather than in a browser.',
    reversible: false,
  };
}

module.exports = { shred, caveat, BLOCK };
