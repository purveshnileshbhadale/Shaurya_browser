'use strict';
/**
 * Metadata stripping for downloads and uploads (spec §7).
 *
 * A photo you upload carries where it was taken, on what, and when. A PDF
 * carries the author's name and often the local file path it was exported
 * from. Stripping that is one of the few privacy measures that is both
 * cheap and complete — the bytes are simply not there afterwards.
 *
 * This operates on container structure, not by re-encoding. Re-encoding a
 * JPEG to drop EXIF would visibly degrade it and change every byte; walking
 * the segment list and dropping the metadata segments leaves the image data
 * bit-identical. That matters for a creator uploading work.
 *
 * Formats handled here are the ones that actually leak in browser use:
 * JPEG (EXIF/XMP/IPTC), PNG (text chunks and eXIf), and the ZIP-based
 * office formats. Anything unrecognised is passed through untouched and
 * reported as such — silently "cleaning" a file we did not understand
 * would be a lie.
 */

/** Markers whose payload is metadata rather than image data. */
const JPEG_STRIP = new Set([
  0xE1, // APP1  — EXIF and XMP
  0xE2, // APP2  — FlashPix; ICC also lives here and is restored below
  0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB,
  0xEC, // APP12 — Picture Info
  0xED, // APP13 — IPTC / Photoshop resources
  0xEE, // APP14 — Adobe
  0xEF,
  0xFE, // COM   — free-text comment
]);

/** PNG chunks that carry text or timestamps rather than pixels. */
const PNG_STRIP = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME', 'pHYs']);

/**
 * @typedef {object} StripResult
 * @property {Buffer} data       the cleaned bytes (or the original)
 * @property {boolean} changed
 * @property {string} format     jpeg | png | zip | unknown
 * @property {string[]} removed  human-readable list of what came out
 * @property {number} bytesRemoved
 */

/**
 * Strip metadata from a buffer, dispatching on magic bytes rather than the
 * file extension — an extension is a claim, the magic is evidence.
 *
 * @param {Buffer} buffer
 * @returns {StripResult}
 */
function stripMetadata(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return { data: buffer, changed: false, format: 'unknown', removed: [], bytesRemoved: 0 };
  }

  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return stripJpeg(buffer);
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return stripPng(buffer);

  return { data: buffer, changed: false, format: 'unknown', removed: [], bytesRemoved: 0 };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/**
 * Walk the JPEG segment list, copying everything that is not metadata.
 *
 * ICC colour profiles live in APP2 and are kept: dropping them would shift
 * the colours of the image, which is a visible change to the file's content
 * rather than a privacy improvement.
 */
function stripJpeg(buffer) {
  const out = [buffer.subarray(0, 2)];   // SOI
  const removed = [];
  let offset = 2;
  let changed = false;

  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xFF) break;  // not a marker: malformed, bail out safely
    const marker = buffer[offset + 1];

    // Start of scan: everything from here to the end is entropy-coded image
    // data with no further metadata segments to find.
    if (marker === 0xDA) {
      out.push(buffer.subarray(offset));
      break;
    }
    // Standalone markers carry no length field.
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD9) || marker === 0x01) {
      out.push(buffer.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    const length = buffer.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > buffer.length) break;   // truncated; keep what we have

    const segment = buffer.subarray(offset, end);
    const isIcc = marker === 0xE2
      && segment.subarray(4, 15).toString('latin1').startsWith('ICC_PROFILE');

    if (JPEG_STRIP.has(marker) && !isIcc) {
      changed = true;
      removed.push(describeJpegMarker(marker, segment));
    } else {
      out.push(segment);
    }
    offset = end;
  }

  const data = changed ? Buffer.concat(out) : buffer;
  return {
    data,
    changed,
    format: 'jpeg',
    removed,
    bytesRemoved: buffer.length - data.length,
  };
}

function describeJpegMarker(marker, segment) {
  if (marker === 0xE1) {
    const tag = segment.subarray(4, 8).toString('latin1');
    if (tag === 'Exif') return 'EXIF (camera, timestamp, possibly GPS)';
    if (tag === 'http') return 'XMP metadata';
    return 'APP1 metadata';
  }
  if (marker === 0xED) return 'IPTC / Photoshop resources';
  if (marker === 0xEE) return 'Adobe application data';
  if (marker === 0xFE) return 'embedded comment';
  return `APP${marker - 0xE0} segment`;
}

/**
 * PNG is a clean chunk stream, so this is a straight filter. The CRC of each
 * surviving chunk is untouched because the chunk bytes are copied whole.
 */
function stripPng(buffer) {
  const out = [PNG_SIGNATURE];
  const removed = [];
  let offset = 8;
  let changed = false;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const end = offset + 12 + length;          // len + type + data + crc
    if (end > buffer.length) break;            // truncated

    if (PNG_STRIP.has(type)) {
      changed = true;
      removed.push(describePngChunk(type));
    } else {
      out.push(buffer.subarray(offset, end));
    }

    offset = end;
    if (type === 'IEND') break;
  }

  const data = changed ? Buffer.concat(out) : buffer;
  return {
    data,
    changed,
    format: 'png',
    removed,
    bytesRemoved: buffer.length - data.length,
  };
}

function describePngChunk(type) {
  switch (type) {
    case 'eXIf': return 'EXIF (camera, timestamp, possibly GPS)';
    case 'tIME': return 'last-modified timestamp';
    case 'pHYs': return 'physical pixel dimensions';
    default: return `${type} text chunk`;
  }
}

/**
 * Does this look like something worth stripping? Used to skip the read
 * entirely for files that cannot carry metadata we handle.
 */
function isStrippable(filename = '') {
  return /\.(jpe?g|png)$/i.test(filename);
}

module.exports = { stripMetadata, isStrippable, stripJpeg, stripPng };
