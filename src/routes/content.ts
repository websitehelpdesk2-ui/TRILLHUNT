import { route } from './registry.ts';
import { all, get, run, tx } from '../lib/db.ts';
import { requireUser, requireWrite } from '../lib/auth.ts';
import { rateLimit } from '../lib/guard.ts';
import { id, now, plusHours, readJson, str, int, oneOf, bad, forbid, notFound } from '../lib/util.ts';
import { publicUser, locationCard } from '../lib/view.ts';
import { moderateText, openCase, recordStrike } from '../services/moderation.ts';
import { has, requireEntitlement } from '../services/entitlements.ts';
import { signMediaUrl } from '../services/storage.ts';
import { awardXp, checkBadges } from '../services/xp.ts';
import { notify, listNotifications, markRead } from '../services/notifications.ts';
import { config } from '../config.ts';

const RATINGS = ['fear', 'paranormal', 'isolation', 'darkness', 'difficulty', 'value', 'overall'] as const;

// --------------------------------------------------------- thrill reports
route('POST', '/api/locations/:slug/thrill-report', async ({ req, ctx, params }) => {
  const u = requireWrite(ctx);
  rateLimit(`tr:${u.id}`, 10, 3600);
  const loc = get<any>('SELECT id, name FROM locations WHERE slug = ? AND deleted_at IS NULL', [params.slug]);
  if (!loc) throw notFound();
  const b = await readJson(req);
  const body = str(b.body, 'Report', { max: 4000, required: false });
  const mediaIds: string[] = Array.isArray(b.media_ids) ? b.media_ids.slice(0, 6) : [];
  if (mediaIds.length) requireEntitlement(u.id, 'image_upload');   // §31 photos are Pro

  const verdict = body ? moderateText(body) : { verdict: 'approve' as const, labels: [], provider: 'rules', score: 0 };
  if (verdict.verdict === 'block') {
    const cid = openCase({ subjectType: 'thrill_report', subjectId: `blocked:${id()}`, ownerUserId: u.id, origin: 'auto_moderation', severity: 'high' });
    recordStrike(u.id, 'high', 'Thrill Report violated Community Guidelines', cid);
    throw forbid("This report couldn't be posted because it may violate THRILLHUNT's Community Guidelines.", 'content_blocked');
  }

  const rid = id('trp');
  const vals = Object.fromEntries(RATINGS.map((k) => [k, b[k] == null ? null : int(b[k], k, { min: 0, max: 10, required: false })]));
  tx(() => {
    run(`INSERT INTO thrill_reports (id, location_id, user_id, visited_on, fear, paranormal, isolation, darkness, difficulty, value, overall, would_return, body, moderation_status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [rid, loc.id, u.id, b.visited_on ?? null, vals.fear, vals.paranormal, vals.isolation, vals.darkness,
         vals.difficulty, vals.value, vals.overall, b.would_return ? 1 : 0, body || null,
         verdict.verdict === 'review' ? 'pending' : 'approved', now()]);
    for (const m of mediaIds) {
      const a = get<any>('SELECT owner_user_id, moderation_status FROM media_assets WHERE id = ?', [m]);
      if (!a || a.owner_user_id !== u.id) throw forbid('That image is not available.', 'invalid_media');
      run(`UPDATE media_assets SET attached_to = 'thrill_report' WHERE id = ?`, [m]);
    }
    run(`UPDATE attendance SET status = 'completed' WHERE location_id = ? AND user_id = ?`, [loc.id, u.id]);
    // Recompute community thrill metrics from reports only — never invented.
    for (const k of ['fear', 'paranormal', 'isolation', 'darkness', 'difficulty']) {
      run(`UPDATE locations SET ${k} = (SELECT ROUND(AVG(${k}),1) FROM thrill_reports WHERE location_id = ? AND ${k} IS NOT NULL AND deleted_at IS NULL) WHERE id = ?`, [loc.id, loc.id]);
    }
    run('UPDATE locations SET trending_score = trending_score + 4 WHERE id = ?', [loc.id]);
  });
  if (verdict.verdict === 'review') openCase({ subjectType: 'thrill_report', subjectId: rid, ownerUserId: u.id, origin: 'auto_moderation', severity: 'normal' });

  const quality = (body?.length ?? 0) > 120 && RATINGS.every((k) => vals[k] != null);
  awardXp(u.id, 'thrill_report', undefined, `tr:${rid}`);
  if (quality) awardXp(u.id, 'quality_thrill_report', undefined, `trq:${rid}`);
  awardXp(u.id, 'first_adventure', undefined, 'first_adventure');
  const badges = checkBadges(u.id);
  const prof = get<any>('SELECT xp, level FROM profiles WHERE user_id = ?', [u.id]);

  return {
    id: rid, moderation: verdict.verdict, xp: prof?.xp, level: prof?.level, badges,
    share_card: shareCard(loc, vals, u.username),
  };
}, 201);

function shareCard(loc: any, vals: any, username: string) {
  // §35 — share payload the client renders into a card / native share sheet.
  return {
    headline: `${loc.name}`,
    subline: `Fear ${vals.fear ?? '—'}/10 · Overall ${vals.overall ?? '—'}/10`,
    byline: `@${username} on THRILLHUNT`,
    tagline: 'CHASE THE THRILL. RESPECT THE RISK.',
    url: `${config.publicUrl}/l/${loc.slug ?? ''}`,
    targets: ['tiktok', 'instagram', 'snapchat', 'facebook', 'sms', 'copy'],
  };
}

route('POST', '/api/locations/:slug/review', async ({ req, ctx, params }) => {
  const u = requireWrite(ctx);
  rateLimit(`rev:${u.id}`, 10, 3600);
  const loc = get<any>('SELECT id FROM locations WHERE slug = ?', [params.slug]);
  if (!loc) throw notFound();
  const b = await readJson(req);
  const rating = int(b.rating, 'Rating', { min: 1, max: 5 });
  const body = str(b.body, 'Review', { max: 2000, required: false });
  const verdict = body ? moderateText(body) : { verdict: 'approve' as const };
  if (verdict.verdict === 'block') throw forbid("This review couldn't be posted because it may violate THRILLHUNT's Community Guidelines.", 'content_blocked');
  const rid = id('rev');
  run(`INSERT INTO reviews (id, location_id, user_id, rating, body, moderation_status, created_at) VALUES (?,?,?,?,?,?,?)`,
      [rid, loc.id, u.id, rating, body || null, verdict.verdict === 'review' ? 'pending' : 'approved', now()]);
  run(`UPDATE locations SET rating_avg = (SELECT ROUND(AVG(rating),2) FROM reviews WHERE location_id = ? AND deleted_at IS NULL),
       rating_count = (SELECT COUNT(*) FROM reviews WHERE location_id = ? AND deleted_at IS NULL) WHERE id = ?`, [loc.id, loc.id, loc.id]);
  awardXp(u.id, 'review', undefined, `rev:${rid}`);
  return { id: rid, moderation: verdict.verdict };
}, 201);

// -------------------------------------------------------------- feed (§34)
route('GET', '/api/feed', ({ ctx, query }) => {
  const viewer = ctx.user?.id;
  const before = query.get('before');
  const rows = all<any>(
    `SELECT t.*, p.username, p.avatar_emoji, p.activity_public, l.name AS location_name, l.slug AS location_slug,
            l.city, l.region, l.data_source
       FROM thrill_reports t JOIN profiles p ON p.user_id = t.user_id JOIN locations l ON l.id = t.location_id
      WHERE t.deleted_at IS NULL AND t.moderation_status = 'approved' AND p.activity_public = 1
        ${before ? 'AND t.created_at < ?' : ''}
        ${viewer ? 'AND t.user_id NOT IN (SELECT target_id FROM user_blocks WHERE user_id = ?)' : ''}
      ORDER BY t.created_at DESC LIMIT 20`,
    [...(before ? [before] : []), ...(viewer ? [viewer] : [])]);

  return {
    posts: rows.map((r) => ({
      id: r.id,
      user: { username: r.username, avatar_emoji: r.avatar_emoji },
      location: { name: r.location_name, slug: r.location_slug, city: r.city, region: r.region, data_source: r.data_source },
      ratings: Object.fromEntries(RATINGS.map((k) => [k, r[k]])),
      would_return: !!r.would_return,
      body: r.body,
      like_count: r.like_count,
      liked: viewer ? !!get('SELECT 1 FROM post_likes WHERE thrill_report_id = ? AND user_id = ?', [r.id, viewer]) : false,
      created_at: r.created_at,
      media: all<any>(`SELECT id FROM media_assets WHERE attached_to = 'thrill_report' AND owner_user_id = ? AND moderation_status='approved' LIMIT 0`, [r.user_id])
        .map((m: any) => ({ url: viewer ? signMediaUrl(m.id, viewer) : null })),
    })),
  };
});

route('POST', '/api/feed/:id/like', ({ ctx, params }) => {
  const u = requireUser(ctx);
  const existing = get('SELECT 1 FROM post_likes WHERE thrill_report_id = ? AND user_id = ?', [params.id, u.id]);
  if (existing) run('DELETE FROM post_likes WHERE thrill_report_id = ? AND user_id = ?', [params.id, u.id]);
  else run('INSERT INTO post_likes (thrill_report_id, user_id, created_at) VALUES (?,?,?)', [params.id, u.id, now()]);
  run('UPDATE thrill_reports SET like_count = (SELECT COUNT(*) FROM post_likes WHERE thrill_report_id = ?) WHERE id = ?', [params.id, params.id]);
  return { liked: !existing };
});

// -------------------------------------------------- unified reporting (§45)
const REPORT_REASONS = ['sexual_content', 'graphic_violence', 'harassment', 'dangerous_activity', 'illegal_activity', 'hate_abuse', 'privacy', 'spam', 'other'] as const;
const SUBJECTS = ['user', 'profile', 'message', 'image', 'video', 'location', 'review', 'thrill_report', 'group', 'event'] as const;
const SEVERE = new Set(['sexual_content', 'illegal_activity', 'hate_abuse']);

route('GET', '/api/report/options', () => ({
  prompt: 'WHY ARE YOU REPORTING THIS?',
  image_prompt: 'WHY ARE YOU REPORTING THIS IMAGE?',
  reasons: [
    { key: 'sexual_content', label: 'Sexual/inappropriate content' },
    { key: 'graphic_violence', label: 'Graphic violence/gore' },
    { key: 'harassment', label: 'Harassment' },
    { key: 'dangerous_activity', label: 'Dangerous activity' },
    { key: 'illegal_activity', label: 'Illegal activity' },
    { key: 'hate_abuse', label: 'Hate/abusive content' },
    { key: 'privacy', label: 'Privacy concern' },
    { key: 'spam', label: 'Spam' },
    { key: 'other', label: 'Other' },
  ],
  subjects: SUBJECTS,
}));

route('POST', '/api/report', async ({ req, ctx }) => {
  const u = requireUser(ctx);
  rateLimit(`report:${u.id}`, 30, 3600);
  const b = await readJson(req);
  const subjectType = oneOf(b.subject_type, 'Subject type', SUBJECTS);
  const subjectId = str(b.subject_id, 'Subject');
  const reason = oneOf(b.reason, 'Reason', REPORT_REASONS);
  const details = str(b.details, 'Details', { max: 1000, required: false });

  // Resolve the content owner so repeat-offender tracking works.
  const ownerSql: Record<string, string> = {
    message: 'SELECT user_id AS owner FROM messages WHERE id = ?',
    image: 'SELECT owner_user_id AS owner FROM media_assets WHERE id = ?',
    video: 'SELECT owner_user_id AS owner FROM media_assets WHERE id = ?',
    review: 'SELECT user_id AS owner FROM reviews WHERE id = ?',
    thrill_report: 'SELECT user_id AS owner FROM thrill_reports WHERE id = ?',
    group: 'SELECT created_by AS owner FROM groups WHERE id = ?',
    location: 'SELECT submitted_by AS owner FROM locations WHERE id = ?',
    event: 'SELECT created_by AS owner FROM events WHERE id = ?',
    user: 'SELECT id AS owner FROM users WHERE id = ?',
    profile: 'SELECT user_id AS owner FROM profiles WHERE user_id = ?',
  };
  const owner = get<any>(ownerSql[subjectType], [subjectId])?.owner ?? null;
  const severity = SEVERE.has(reason) ? 'critical' : reason === 'dangerous_activity' ? 'high' : 'normal';
  const caseId = openCase({ subjectType, subjectId, ownerUserId: owner, origin: 'user_report', severity, notes: reason });
  run(`INSERT INTO reports (id, reporter_id, subject_type, subject_id, reason, details, case_id, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [id('rpt'), u.id, subjectType, subjectId, reason, details, caseId, now()]);

  // Critical reports hide the content immediately, pending human review.
  if (severity === 'critical') {
    if (subjectType === 'image' || subjectType === 'video') run(`UPDATE media_assets SET moderation_status = 'review' WHERE id = ?`, [subjectId]);
    if (subjectType === 'message') run(`UPDATE messages SET moderation_status = 'pending' WHERE id = ?`, [subjectId]);
  }
  return { ok: true, case_id: caseId, message: 'Thanks for the report. Our moderation team will review it.' };
}, 201);

route('POST', '/api/appeals', async ({ req, ctx }) => {
  const u = requireUser(ctx);
  rateLimit(`appeal:${u.id}`, 3, 86400);
  const b = await readJson(req);
  run(`INSERT INTO appeals (id, user_id, case_id, body, status, created_at) VALUES (?,?,?,?, 'open', ?)`,
      [id('apl'), u.id, b.case_id ?? null, str(b.body, 'Appeal', { min: 10, max: 2000 }), now()]);
  return { ok: true, message: 'Appeal submitted. A human moderator will review it.' };
}, 201);

// ------------------------------------------------------ trip check-in (§46)
route('POST', '/api/trips', async ({ req, ctx }) => {
  const u = requireWrite(ctx);
  const b = await readJson(req);
  const tid = id('trp');
  run(`INSERT INTO trips (id, user_id, group_id, title, plan_json, starts_at, status, emergency_contact_name, emergency_contact_value, created_at)
       VALUES (?,?,?,?,?,?, 'planned', ?,?,?)`,
      [tid, u.id, b.group_id ?? null, str(b.title, 'Title', { max: 120 }),
       JSON.stringify(b.plan ?? {}), b.starts_at ?? null,
       str(b.emergency_contact_name, 'Contact name', { max: 80, required: false }) || null,
       str(b.emergency_contact_value, 'Contact', { max: 120, required: false }) || null, now()]);
  return {
    trip_id: tid,
    disclaimer: 'THRILLHUNT is not an emergency service and does not monitor check-ins in real time. In an emergency, contact your local emergency services immediately.',
  };
}, 201);

route('POST', '/api/trips/:id/start', async ({ req, ctx, params }) => {
  const u = requireUser(ctx);
  const t = get<any>('SELECT * FROM trips WHERE id = ? AND user_id = ?', [params.id, u.id]);
  if (!t) throw notFound();
  const b = await readJson(req);
  const hours = Math.min(Number(b.hours ?? 12), 48);
  run(`UPDATE trips SET status='active', checkin_started_at=?, checkin_due_at=? WHERE id = ?`, [now(), plusHours(hours), params.id]);
  return {
    ok: true, due_at: plusHours(hours),
    reminder: 'Consider sharing your itinerary with someone you trust. THRILLHUNT is NOT an emergency service.',
  };
});

route('POST', '/api/trips/:id/checkin', async ({ req, ctx, params }) => {
  const u = requireUser(ctx);
  const b = await readJson(req);
  const outcome = oneOf(b.outcome, 'Outcome', ['home', 'help_requested']);
  const t = get<any>('SELECT * FROM trips WHERE id = ? AND user_id = ?', [params.id, u.id]);
  if (!t) throw notFound();
  run(`UPDATE trips SET status = 'completed', checkin_closed_at = ?, checkin_outcome = ? WHERE id = ?`, [now(), outcome, params.id]);
  if (outcome === 'home') { awardXp(u.id, 'trip_checkin_complete', undefined, `checkin:${params.id}`); checkBadges(u.id); }
  return {
    ok: true,
    message: outcome === 'home'
      ? 'Glad you made it back. File a Thrill Report to lock in your XP.'
      : 'If you are in danger or need medical help, call your local emergency number now. THRILLHUNT cannot dispatch help. We have flagged this trip for our safety team.',
    emergency_notice: outcome === 'help_requested',
  };
});

route('GET', '/api/trips', ({ ctx }) => {
  const u = requireUser(ctx);
  // Emergency contact values are returned only to the trip owner.
  return { trips: all<any>('SELECT * FROM trips WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', [u.id]) };
});

// ---------------------------------------------------------- notifications
route('GET', '/api/notifications', ({ ctx }) => {
  const u = requireUser(ctx);
  return { notifications: listNotifications(u.id), unread: listNotifications(u.id).filter((n) => !n.read_at).length };
});
route('POST', '/api/notifications/read', ({ ctx }) => { markRead(requireUser(ctx).id); return { ok: true }; });
