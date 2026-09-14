import { route } from './registry.ts';
import { all, get, run, tx, cfg } from '../lib/db.ts';
import {
  hashPassword, verifyPassword, createSession, destroySession, requireUser,
  AGE_ATTESTATION,
} from '../lib/auth.ts';
import { rateLimit, normLat, normLng } from '../lib/guard.ts';
import { id, now, readJson, str, oneOf, isEmail, bad, unauth, forbid, slugify, HttpError } from '../lib/util.ts';
import { syncEntitlements, subscriptionSummary } from '../services/entitlements.ts';
import { publicUser } from '../lib/view.ts';
import { awardXp, checkBadges, userStats } from '../services/xp.ts';
import { config } from '../config.ts';

export const AGE_GATE_COPY = {
  headline: 'THRILLHUNT IS FOR ADULTS 18+',
  body: [
    'THRILLHUNT connects adults with haunted attractions, outdoor adventures, camping destinations, and other adrenaline-focused experiences.',
    'Some activities and locations may involve inherent risks.',
    'You are responsible for deciding whether an activity is appropriate for you and for following all applicable laws, property rules, posted warnings, and safety requirements.',
    'You must be 18 or older to use THRILLHUNT.',
  ],
  attestation: AGE_ATTESTATION,
};

route('GET', '/api/bootstrap', ({ ctx }) => {
  const plan: any = cfg('pro.plan');
  return {
    age_gate: AGE_GATE_COPY,
    tos_version: config.tosVersion,
    plan: { id: plan.id, name: plan.name, price_cents: plan.price_cents, currency: plan.currency, interval: plan.interval, features: plan.features },
    upload_limits: (() => { const l: any = cfg('uploads.limits'); return { max_file_bytes: l.max_file_bytes, max_images_per_message: l.max_images_per_message, allowed_mime: l.allowed_mime }; })(),
    categories: all<any>('SELECT slug, name, icon, blurb FROM categories WHERE active = 1 ORDER BY sort_order'),
    session: ctx.user ? sessionPayload(ctx.user.id) : null,
    maps_provider: config.providers.maps,
  };
});

function sessionPayload(userId: string) {
  const u = get<any>(`SELECT u.id, u.email, u.role, u.status, u.restricted_until, p.*
                        FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`, [userId])!;
  return {
    id: u.id, email: u.email, role: u.role, status: u.status, restricted_until: u.restricted_until,
    username: u.username, display_name: u.display_name, avatar_emoji: u.avatar_emoji, bio: u.bio,
    home_city: u.home_city,
    has_home_coords: u.home_lat != null,
    xp: u.xp, level: u.level,
    favorite_categories: JSON.parse(u.favorite_categories ?? '[]'),
    privacy: {
      profile_visibility: u.profile_visibility, dm_policy: u.dm_policy,
      discoverable_nearby: !!u.discoverable_nearby, attendance_public: !!u.attendance_public,
      activity_public: !!u.activity_public, share_coarse_location: !!u.share_coarse_location,
    },
    notification_prefs: JSON.parse(u.notification_prefs ?? '{}'),
    subscription: subscriptionSummary(userId),
    stats: userStats(userId),
  };
}

route('POST', '/api/auth/register', async ({ req, res, ctx }) => {
  rateLimit(`register:${ctx.ipHash}`, 10, 3600);
  const b = await readJson(req);
  const email = str(b.email, 'Email').toLowerCase();
  if (!isEmail(email)) throw bad('Enter a valid email address.');
  const password = str(b.password, 'Password', { min: 10, max: 200 });
  const username = str(b.username, 'Username', { min: 3, max: 24 });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) throw bad('Usernames can use letters, numbers and underscores only.');

  // ---- HARD 18+ GATE (§4) -------------------------------------------------
  // The account cannot be created without an explicit affirmation. There is no
  // parameter, header or flag that skips this check.
  if (b.age_confirmed !== true) {
    throw forbid('You must confirm you are 18 or older to create a THRILLHUNT account.', 'age_gate_required', { age_gate: AGE_GATE_COPY });
  }
  if (b.accept_tos !== true) throw bad('You must accept the Terms and Community Guidelines.');

  if (get('SELECT id FROM users WHERE email = ?', [email])) throw bad('An account with that email already exists.', 'email_taken');
  if (get('SELECT user_id FROM profiles WHERE lower(username) = lower(?)', [username])) throw bad('That username is taken.', 'username_taken');

  const uid = id('usr');
  tx(() => {
    run(`INSERT INTO users (id, email, password_hash, role, status, age_confirmed_at, age_attestation, tos_version, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uid, email, hashPassword(password), 'user', 'active', now(), AGE_ATTESTATION, config.tosVersion, now(), now()]);
    run(`INSERT INTO profiles (user_id, username, display_name, avatar_emoji, home_city, home_lat, home_lng, favorite_categories, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uid, username, str(b.display_name, 'Display name', { required: false, max: 40 }) || username,
         str(b.avatar_emoji, 'Avatar', { required: false, max: 8 }) || '🎯',
         str(b.home_city, 'City', { required: false, max: 80 }) || null,
         normLat(b.home_lat), normLng(b.home_lng),
         JSON.stringify(Array.isArray(b.favorite_categories) ? b.favorite_categories.slice(0, 12) : []),
         now(), now()]);
  });
  syncEntitlements(uid);
  createSession(res, uid, req);
  return { user: sessionPayload(uid) };
}, 201);

route('POST', '/api/auth/login', async ({ req, res, ctx }) => {
  rateLimit(`login:${ctx.ipHash}`, 20, 300);
  const b = await readJson(req);
  const email = str(b.email, 'Email').toLowerCase();
  const password = str(b.password, 'Password');
  rateLimit(`login-acct:${email}`, 10, 300);
  const u = get<any>('SELECT id, password_hash, status FROM users WHERE email = ? AND deleted_at IS NULL', [email]);
  // Same message either way — never confirm whether an email exists.
  if (!u || !verifyPassword(password, u.password_hash)) throw unauth('Email or password is incorrect.');
  if (u.status === 'banned') throw forbid('This account is permanently banned.', 'account_banned');
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [now(), u.id]);
  syncEntitlements(u.id);
  createSession(res, u.id, req);
  return { user: sessionPayload(u.id) };
});

route('POST', '/api/auth/logout', ({ req, res }) => { destroySession(req, res); return { ok: true }; });

route('GET', '/api/auth/session', ({ ctx }) => (ctx.user ? { user: sessionPayload(ctx.user.id) } : { user: null }));

route('PATCH', '/api/me', async ({ req, ctx }) => {
  const u = requireUser(ctx);
  const b = await readJson(req);
  const fields: [string, any][] = [];
  if (b.display_name !== undefined) fields.push(['display_name', str(b.display_name, 'Display name', { max: 40, required: false })]);
  if (b.bio !== undefined) fields.push(['bio', str(b.bio, 'Bio', { max: 400, required: false })]);
  if (b.avatar_emoji !== undefined) fields.push(['avatar_emoji', str(b.avatar_emoji, 'Avatar', { max: 8, required: false }) || '🎯']);
  if (b.home_city !== undefined) fields.push(['home_city', str(b.home_city, 'City', { max: 80, required: false })]);
  if (b.home_lat !== undefined) fields.push(['home_lat', normLat(b.home_lat)]);
  if (b.home_lng !== undefined) fields.push(['home_lng', normLng(b.home_lng)]);
  if (b.favorite_categories !== undefined) fields.push(['favorite_categories', JSON.stringify((b.favorite_categories ?? []).slice(0, 12))]);
  if (b.notification_prefs !== undefined) fields.push(['notification_prefs', JSON.stringify(b.notification_prefs ?? {})]);
  // privacy controls (§15)
  if (b.profile_visibility !== undefined) fields.push(['profile_visibility', oneOf(b.profile_visibility, 'Profile visibility', ['public', 'members', 'private'])]);
  if (b.dm_policy !== undefined) fields.push(['dm_policy', oneOf(b.dm_policy, 'Message policy', ['everyone', 'requests', 'groups_only', 'nobody'])]);
  for (const k of ['discoverable_nearby', 'attendance_public', 'activity_public', 'share_coarse_location']) {
    if (b[k] !== undefined) fields.push([k, b[k] ? 1 : 0]);
  }
  if (!fields.length) return { user: sessionPayload(u.id) };
  run(`UPDATE profiles SET ${fields.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE user_id = ?`,
      [...fields.map(([, v]) => v), now(), u.id]);
  return { user: sessionPayload(u.id) };
});

route('POST', '/api/auth/password', async ({ req, ctx }) => {
  const u = requireUser(ctx);
  const b = await readJson(req);
  const row = get<any>('SELECT password_hash FROM users WHERE id = ?', [u.id])!;
  if (!verifyPassword(str(b.current_password, 'Current password'), row.password_hash)) throw unauth('Current password is incorrect.');
  const next = str(b.new_password, 'New password', { min: 10, max: 200 });
  run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(next), now(), u.id]);
  run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ?', [now(), u.id, ctx.sessionId]);
  return { ok: true };
});

route('GET', '/api/users/:username', ({ params, ctx }) => {
  const p = get<any>('SELECT user_id FROM profiles WHERE lower(username) = lower(?)', [params.username]);
  if (!p) throw new HttpError(404, 'No such hunter.', 'not_found');
  const user = publicUser(p.user_id, ctx.user?.id);
  const stats = userStats(p.user_id);
  const reports = all<any>(
    `SELECT t.id, t.overall, t.fear, t.body, t.created_at, l.name AS location_name, l.slug AS location_slug
       FROM thrill_reports t JOIN locations l ON l.id = t.location_id
      WHERE t.user_id = ? AND t.deleted_at IS NULL AND t.moderation_status = 'approved'
      ORDER BY t.created_at DESC LIMIT 10`, [p.user_id]);
  return { user, stats, thrill_reports: reports };
});
