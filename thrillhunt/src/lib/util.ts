import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.ts';

// ---------------------------------------------------------------- ids/time
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function id(prefix = ''): string {
  let t = Date.now();
  let s = '';
  for (let i = 9; i >= 0; i--) { s = B32[t % 32] + s; t = Math.floor(t / 32); }
  const r = randomBytes(10);
  for (const b of r) s += B32[b % 32];
  return prefix ? `${prefix}_${s}` : s;
}
export const now = () => new Date().toISOString();
export const plusDays = (d: number) => new Date(Date.now() + d * 864e5).toISOString();
export const plusHours = (h: number) => new Date(Date.now() + h * 36e5).toISOString();

// ---------------------------------------------------------------- crypto
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const hmac = (s: string, key = config.secret) => createHmac('sha256', key).update(s).digest('hex');
export function safeEq(a: string, b: string) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
export const token = (n = 32) => randomBytes(n).toString('base64url');

// ---------------------------------------------------------------- errors
export class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, code = 'error', extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const bad = (m: string, code = 'invalid_request') => new HttpError(400, m, code);
export const unauth = (m = 'Sign in required.') => new HttpError(401, m, 'unauthenticated');
export const forbid = (m = 'Not allowed.', code = 'forbidden', extra = {}) => new HttpError(403, m, code, extra);
export const notFound = (m = 'Not found.') => new HttpError(404, m, 'not_found');
export const tooMany = (m = 'Slow down.') => new HttpError(429, m, 'rate_limited');

// ---------------------------------------------------------------- http
export function json(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(s);
}

export async function readBody(req: IncomingMessage, limit = 12 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) {
      // Stop buffering immediately, but keep draining so the request/response
      // exchange completes cleanly instead of poisoning a keep-alive socket.
      over = true;
      chunks.length = 0;
      if (size > limit * 4) { req.destroy(); break; }   // hard abort on abuse
      continue;
    }
    if (!over) chunks.push(c as Buffer);
  }
  if (over) throw new HttpError(413, 'Payload too large.', 'payload_too_large');
  return Buffer.concat(chunks);
}

export async function readJson<T = any>(req: IncomingMessage): Promise<T> {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {} as T;
  try { return JSON.parse(buf.toString('utf8')) as T; } catch { throw bad('Malformed JSON body.'); }
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------------------------------------------------------------- validate
export const str = (v: unknown, field: string, { min = 0, max = 5000, required = true } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${field} is required.`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`${field} must be text.`);
  const s = v.trim();
  if (s.length < min) throw bad(`${field} must be at least ${min} characters.`);
  if (s.length > max) throw bad(`${field} must be under ${max} characters.`);
  return s;
};
export const int = (v: unknown, field: string, { min = -1e9, max = 1e9, required = true, def = 0 } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${field} is required.`);
    return def;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${field} must be a number.`);
  const i = Math.round(n);
  if (i < min || i > max) throw bad(`${field} must be between ${min} and ${max}.`);
  return i;
};
export const oneOf = <T extends string>(v: unknown, field: string, opts: readonly T[], def?: T): T => {
  if ((v === undefined || v === '') && def !== undefined) return def;
  if (typeof v !== 'string' || !opts.includes(v as T)) throw bad(`${field} must be one of: ${opts.join(', ')}`);
  return v as T;
};
export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s);

// ---------------------------------------------------------------- text
export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
