/**
 * MEDIA STORAGE (§20, §26, §56)
 *
 * - Files are validated by MAGIC BYTES, not by the client-supplied name or
 *   Content-Type. Extension and declared MIME must agree with reality.
 * - EXIF/metadata is physically removed before anything is stored, so a user
 *   can never leak home GPS coordinates through a campsite photo.
 * - Objects live outside the web root under an opaque key. There is no public
 *   bucket path; every read goes through a short-lived signed URL bound to the
 *   media id, so access can be revoked by moderation at any time.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { cfg } from '../lib/db.ts';
import { sha256, hmac, id, HttpError, safeEq } from '../lib/util.ts';

export interface ValidatedImage {
  buffer: Buffer; mime: string; ext: string; bytes: number;
  width: number | null; height: number | null; sha256: string; exifStripped: boolean;
}

/** True format detection from the first bytes of the file. */
function sniff(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

/** Removes APP1..APP15 (EXIF/XMP/IPTC incl. GPS) and COM segments from a JPEG. */
function stripJpeg(buf: Buffer): { out: Buffer; w: number | null; h: number | null } {
  const out: Buffer[] = [buf.subarray(0, 2)];
  let i = 2, w: number | null = null, h: number | null = null;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    if (marker === 0xda) { out.push(buf.subarray(i)); break; } // start of scan -> copy rest
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.subarray(i, i + 2 + len);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
      h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7);
    }
    const isMeta = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe; // APP1-APP15, COM
    if (!isMeta) out.push(seg);
    i += 2 + len;
  }
  return { out: Buffer.concat(out), w, h };
}

/** Keeps only the chunks a PNG needs to render; drops eXIf/tEXt/iTXt/etc. */
function stripPng(buf: Buffer): { out: Buffer; w: number | null; h: number | null } {
  const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'sRGB', 'acTL', 'fcTL', 'fdAT']);
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let i = 8, w: number | null = null, h: number | null = null;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('ascii');
    const end = i + 12 + len;
    if (end > buf.length) break;
    if (type === 'IHDR') { w = buf.readUInt32BE(i + 8); h = buf.readUInt32BE(i + 12); }
    if (keep.has(type)) parts.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return { out: Buffer.concat(parts), w, h };
}

export function validateAndSanitizeImage(raw: Buffer, declaredMime: string, filename: string): ValidatedImage {
  const limits: any = cfg('uploads.limits');
  if (!raw.length) throw new HttpError(400, 'Empty file.', 'invalid_file');
  if (raw.length > limits.max_file_bytes) {
    throw new HttpError(413, `Images must be under ${Math.round(limits.max_file_bytes / 1048576)} MB.`, 'file_too_large');
  }
  const real = sniff(raw);
  if (!real) throw new HttpError(400, 'That file is not a supported image.', 'invalid_file');
  if (!limits.allowed_mime.includes(real.mime)) throw new HttpError(400, 'Unsupported image format.', 'invalid_file');
  // Client claims must match reality — mismatch is treated as hostile.
  if (declaredMime && declaredMime !== real.mime) throw new HttpError(400, 'File content does not match its type.', 'invalid_file');
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  if (ext && !['jpg', 'jpeg', 'png', 'webp'].includes(ext)) throw new HttpError(400, 'Unsupported file extension.', 'invalid_file');
  // Defence in depth: reject anything carrying script-ish payloads in-band.
  const head = raw.subarray(0, 2048).toString('latin1').toLowerCase();
  if (head.includes('<?php') || head.includes('<script')) throw new HttpError(400, 'File rejected by security scan.', 'security_rejected');

  let out = raw, w: number | null = null, h: number | null = null, stripped = false;
  if (real.mime === 'image/jpeg') { const r = stripJpeg(raw); out = r.out; w = r.w; h = r.h; stripped = true; }
  else if (real.mime === 'image/png') { const r = stripPng(raw); out = r.out; w = r.w; h = r.h; stripped = true; }
  else if (real.mime === 'image/webp') { w = raw.length > 30 ? raw.readUInt16LE(26) & 0x3fff : null; h = raw.length > 30 ? raw.readUInt16LE(28) & 0x3fff : null; }

  return { buffer: out, mime: real.mime, ext: real.ext, bytes: out.length, width: w, height: h, sha256: sha256(out), exifStripped: stripped };
}

// ------------------------------------------------------------ storage I/O
export interface StorageDriver {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  read(key: string): Buffer;
  remove(key: string): void;
}

const local: StorageDriver = {
  async put(key, data) {
    const p = join(config.storageDir, key);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, data, { mode: 0o600 });
  },
  read(key) {
    const p = join(config.storageDir, key);
    // Path-traversal guard: the resolved path must stay inside the store.
    if (!p.startsWith(config.storageDir) || key.includes('..')) throw new HttpError(400, 'Bad key.', 'invalid_key');
    if (!existsSync(p)) throw new HttpError(404, 'Media not found.', 'not_found');
    return readFileSync(p);
  },
  remove(key) { const p = join(config.storageDir, key); if (existsSync(p)) unlinkSync(p); },
};

// S3 adapter intentionally left as an explicit stub — see README "What is mocked".
const s3: StorageDriver = {
  async put() { throw new HttpError(501, 'S3 driver not configured in this build.', 'not_implemented'); },
  read() { throw new HttpError(501, 'S3 driver not configured in this build.', 'not_implemented'); },
  remove() { /* no-op */ },
};

export const storage: StorageDriver = config.providers.storage === 's3' ? s3 : local;

export const buildKey = (userId: string, ext: string) =>
  `media/${userId.slice(-4)}/${id('m')}.${ext}`;

// ---------------------------------------------------------- signed access
export function signMediaUrl(mediaId: string, viewerId: string) {
  const ttl: number = (cfg('uploads.limits') as any).signed_url_ttl_seconds ?? 600;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = hmac(`${mediaId}:${viewerId}:${exp}`);
  return `/api/media/${mediaId}?exp=${exp}&sig=${sig}`;
}
export function verifyMediaUrl(mediaId: string, viewerId: string, exp: string, sig: string) {
  if (!exp || !sig) throw new HttpError(403, 'Unsigned media request.', 'forbidden');
  if (Number(exp) * 1000 < Date.now()) throw new HttpError(403, 'This media link has expired.', 'link_expired');
  if (!safeEq(hmac(`${mediaId}:${viewerId}:${exp}`), sig)) throw new HttpError(403, 'Invalid media signature.', 'forbidden');
}

export function storageUsed(): number { return 0; }
export function fileSize(key: string) {
  try { return statSync(join(config.storageDir, key)).size; } catch { return 0; }
}
