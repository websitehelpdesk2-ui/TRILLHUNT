// Authentication + authorization.
// Passwords: scrypt (node:crypto) with per-user salt. No plaintext, ever.
// Sessions: opaque 32-byte random token in an httpOnly cookie. Only the
// SHA-256 of the token is stored, so a DB leak cannot be replayed as a login.
import { scryptSync, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { get, run } from './db.ts';
import { config } from '../config.ts';
import { id, now, plusDays, sha256, token, safeEq, parseCookies, HttpError, unauth, forbid } from './util.ts';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const h = scryptSync(pw, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${h}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, N, r, p, salt, h] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const calc = scryptSync(pw, salt, SCRYPT.keylen, { N: +N, r: +r, p: +p }).toString('hex');
  return safeEq(calc, h);
}

export interface Ctx {
  user?: {
    id: string; email: string; role: 'user' | 'business' | 'moderator' | 'admin';
    status: string; restricted_until: string | null; username: string; xp: number; level: number;
  };
  sessionId?: string;
  csrf?: string;
  ipHash: string;
}

export function createSession(res: ServerResponse, userId: string, req: IncomingMessage) {
  const raw = token(32);
  const csrf = token(18);
  run(
    `INSERT INTO sessions (id, user_id, csrf_secret, user_agent, ip_hash, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
    [sha256(raw), userId, csrf, String(req.headers['user-agent'] ?? '').slice(0, 200), ipHash(req), now(), plusDays(config.sessionDays)],
  );
  const attrs = [
    `th_session=${raw}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${config.sessionDays * 86400}`,
    config.cookieSecure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
  // CSRF token cookie is intentionally readable by JS (double-submit pattern).
  const csrfCookie = [`th_csrf=${csrf}`, 'Path=/', 'SameSite=Lax', `Max-Age=${config.sessionDays * 86400}`, config.cookieSecure ? 'Secure' : ''].filter(Boolean).join('; ');
  res.setHeader('set-cookie', [attrs, csrfCookie]);
  return csrf;
}

export function destroySession(req: IncomingMessage, res: ServerResponse) {
  const raw = parseCookies(req).th_session;
  if (raw) run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now(), sha256(raw)]);
  res.setHeader('set-cookie', ['th_session=; Path=/; HttpOnly; Max-Age=0', 'th_csrf=; Path=/; Max-Age=0']);
}

export const ipHash = (req: IncomingMessage) =>
  sha256(String(req.socket.remoteAddress ?? 'local') + config.secret).slice(0, 32);

export function loadCtx(req: IncomingMessage): Ctx {
  const ctx: Ctx = { ipHash: ipHash(req) };
  const raw = parseCookies(req).th_session;
  if (!raw) return ctx;
  const row = get<any>(
    `SELECT s.id AS sid, s.csrf_secret, u.id, u.email, u.role, u.status, u.restricted_until,
            p.username, p.xp, p.level
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN profiles p ON p.user_id = u.id
      WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.deleted_at IS NULL`,
    [sha256(raw), now()],
  );
  if (!row) return ctx;
  ctx.sessionId = row.sid;
  ctx.csrf = row.csrf_secret;
  ctx.user = {
    id: row.id, email: row.email, role: row.role, status: row.status,
    restricted_until: row.restricted_until, username: row.username, xp: row.xp ?? 0, level: row.level ?? 1,
  };
  return ctx;
}

/** Mutating requests must carry the CSRF token from the cookie in a header. */
export function assertCsrf(req: IncomingMessage, ctx: Ctx) {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  if (!ctx.user) return; // unauthenticated POSTs (login/register) are rate-limited instead
  const header = String(req.headers['x-th-csrf'] ?? '');
  if (!header || !ctx.csrf || !safeEq(header, ctx.csrf)) {
    throw new HttpError(403, 'Security token mismatch. Refresh and try again.', 'csrf_failed');
  }
}

export function requireUser(ctx: Ctx) {
  if (!ctx.user) throw unauth();
  if (ctx.user.status === 'banned') throw forbid('This account is permanently banned.', 'account_banned');
  if (ctx.user.status === 'suspended') throw forbid('This account is suspended. You may submit an appeal.', 'account_suspended');
  return ctx.user;
}

/** Restricted users can read, but cannot post/chat/upload. */
export function requireWrite(ctx: Ctx) {
  const u = requireUser(ctx);
  if (u.status === 'restricted' && (!u.restricted_until || u.restricted_until > now())) {
    throw forbid('Posting is temporarily restricted on this account.', 'account_restricted', { until: u.restricted_until });
  }
  return u;
}

export function requireRole(ctx: Ctx, ...roles: string[]) {
  const u = requireUser(ctx);
  if (!roles.includes(u.role)) throw forbid('Administrator access required.', 'admin_only');
  return u;
}

export const AGE_ATTESTATION =
  'I confirm I am 18 years of age or older. I understand some activities and locations involve inherent risks, ' +
  'and that I am responsible for following all applicable laws, property rules, posted warnings and safety requirements.';
