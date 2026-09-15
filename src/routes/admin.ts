import { route } from './registry.ts';
import { all, get, run, cfg, setCfg, allCfg } from '../lib/db.ts';
import { requireRole } from '../lib/auth.ts';
import { id, now, plusHours, readJson, str, oneOf, bad, notFound } from '../lib/util.ts';
import { queueStats, logAction, recordStrike } from '../services/moderation.ts';
import { signMediaUrl, storage } from '../services/storage.ts';
import { syncEntitlements } from '../services/entitlements.ts';
import { notify } from '../services/notifications.ts';

function audit(actor: any, action: string, subject?: string, meta?: unknown) {
  run('INSERT INTO audit_logs (id, actor_id, actor_role, action, subject, meta_json, created_at) VALUES (?,?,?,?,?,?,?)',
      [id('aud'), actor.id, actor.role, action, subject ?? null, meta ? JSON.stringify(meta) : null, now()]);
}

// ------------------------------------------------------------- safety center
route('GET', '/api/admin/overview', ({ ctx }) => {
  const u = requireRole(ctx, 'admin', 'moderator');
  const c = (sql: string, p: any[] = []) => get<any>(sql, p)?.c ?? 0;
  return {
    role: u.role,
    safety_center: queueStats(),
    analytics: {
      users: c('SELECT COUNT(*) c FROM users WHERE deleted_at IS NULL'),
      new_users_7d: c(`SELECT COUNT(*) c FROM users WHERE created_at > datetime('now','-7 days')`),
      pro_subscribers: c(`SELECT COUNT(*) c FROM subscription_entitlements WHERE key='image_upload' AND granted=1`),
      locations: c('SELECT COUNT(*) c FROM locations WHERE deleted_at IS NULL'),
      verified_locations: c(`SELECT COUNT(*) c FROM locations WHERE verification_status='verified'`),
      thrill_reports: c('SELECT COUNT(*) c FROM thrill_reports WHERE deleted_at IS NULL'),
      messages_24h: c(`SELECT COUNT(*) c FROM messages WHERE created_at > datetime('now','-1 day')`),
      groups: c('SELECT COUNT(*) c FROM groups WHERE deleted_at IS NULL'),
      images_uploaded: c('SELECT COUNT(*) c FROM media_assets'),
      going_marks: c(`SELECT COUNT(*) c FROM attendance WHERE status='going'`),
      ai_packs_7d: c(`SELECT COUNT(*) c FROM ai_recommendations WHERE created_at > datetime('now','-7 days')`),
    },
  };
});

route('GET', '/api/admin/cases', ({ ctx, query }) => {
  const u = requireRole(ctx, 'admin', 'moderator');
  const status = query.get('status') ?? 'open';
  const severity = query.get('severity');
  const type = query.get('type');
  const rows = all<any>(
    `SELECT * FROM moderation_cases
      WHERE (? = 'all' OR status = ?) ${severity ? 'AND severity = ?' : ''} ${type ? 'AND subject_type = ?' : ''}
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at DESC LIMIT 100`,
    [status, status, ...(severity ? [severity] : []), ...(type ? [type] : [])]);
  return {
    cases: rows.map((c) => ({
      ...c,
      reports: all<any>('SELECT reason, details, created_at FROM reports WHERE case_id = ? LIMIT 10', [c.id]),
      subject_preview: preview(c.subject_type, c.subject_id, u.id),
      owner: c.owner_user_id ? get<any>('SELECT p.username, u.violation_count, u.status FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?', [c.owner_user_id]) : null,
    })),
  };
});

function preview(type: string, sid: string, viewerId: string) {
  if (type === 'message') return get<any>('SELECT body, created_at FROM messages WHERE id = ?', [sid]) ?? null;
  if (type === 'image' || type === 'video') {
    const a = get<any>('SELECT id, mime, bytes, moderation_status, moderation_json FROM media_assets WHERE id = ?', [sid]);
    return a ? { ...a, url: a.moderation_status === 'blocked' ? null : signMediaUrl(a.id, viewerId) } : null;
  }
  if (type === 'thrill_report') return get<any>('SELECT body, overall FROM thrill_reports WHERE id = ?', [sid]) ?? null;
  if (type === 'review') return get<any>('SELECT body, rating FROM reviews WHERE id = ?', [sid]) ?? null;
  if (type === 'location') return get<any>('SELECT name, slug, access_policy, data_source FROM locations WHERE id = ?', [sid]) ?? null;
  if (type === 'user' || type === 'profile') return get<any>('SELECT username, bio FROM profiles WHERE user_id = ?', [sid]) ?? null;
  if (type === 'group') return get<any>('SELECT name, description FROM groups WHERE id = ?', [sid]) ?? null;
  return null;
}

route('POST', '/api/admin/cases/:id/action', async ({ req, ctx, params }) => {
  const u = requireRole(ctx, 'admin', 'moderator');
  const b = await readJson(req);
  const action = oneOf(b.action, 'Action', ['approve', 'remove_content', 'warn', 'restrict', 'suspend', 'ban', 'dismiss', 'escalate']);
  const c = get<any>('SELECT * FROM moderation_cases WHERE id = ?', [params.id]);
  if (!c) throw notFound();
  const reason = str(b.reason, 'Reason', { max: 500, required: false });

  const removers: Record<string, string> = {
    message: 'UPDATE messages SET deleted_at = ? WHERE id = ?',
    thrill_report: 'UPDATE thrill_reports SET deleted_at = ? WHERE id = ?',
    review: 'UPDATE reviews SET deleted_at = ? WHERE id = ?',
    location: 'UPDATE locations SET deleted_at = ? WHERE id = ?',
    group: 'UPDATE groups SET deleted_at = ? WHERE id = ?',
    event: 'UPDATE events SET deleted_at = ? WHERE id = ?',
  };

  if (action === 'approve') {
    if (c.subject_type === 'image' || c.subject_type === 'video') run(`UPDATE media_assets SET moderation_status='approved' WHERE id = ?`, [c.subject_id]);
    if (c.subject_type === 'message') run(`UPDATE messages SET moderation_status='approved' WHERE id = ?`, [c.subject_id]);
    if (c.subject_type === 'thrill_report') run(`UPDATE thrill_reports SET moderation_status='approved' WHERE id = ?`, [c.subject_id]);
    if (c.subject_type === 'review') run(`UPDATE reviews SET moderation_status='approved' WHERE id = ?`, [c.subject_id]);
  } else if (action === 'remove_content') {
    if (c.subject_type === 'image' || c.subject_type === 'video') {
      const a = get<any>('SELECT storage_key FROM media_assets WHERE id = ?', [c.subject_id]);
      if (a?.storage_key && a.storage_key !== '(not stored)') storage.remove(a.storage_key);
      run(`UPDATE media_assets SET moderation_status='blocked', deleted_at=? WHERE id = ?`, [now(), c.subject_id]);
    } else if (removers[c.subject_type]) run(removers[c.subject_type], [now(), c.subject_id]);
    if (c.owner_user_id) recordStrike(c.owner_user_id, c.severity, reason || 'Community Guidelines violation', c.id);
  } else if (['warn', 'restrict', 'suspend', 'ban'].includes(action) && c.owner_user_id) {
    const rules: any = cfg('moderation.enforcement');
    if (action === 'restrict') run('UPDATE users SET status=?, restricted_until=?, status_reason=?, updated_at=? WHERE id=?', ['restricted', plusHours(rules.restrict_hours), reason, now(), c.owner_user_id]);
    if (action === 'suspend') run('UPDATE users SET status=?, status_reason=?, updated_at=? WHERE id=?', ['suspended', reason, now(), c.owner_user_id]);
    if (action === 'ban') run('UPDATE users SET status=?, status_reason=?, updated_at=? WHERE id=?', ['banned', reason, now(), c.owner_user_id]);
    if (action === 'warn') notify(c.owner_user_id, 'moderation', 'Community Guidelines warning', reason || 'Please review the Community Guidelines.', '/app#/guidelines');
  }

  run(`UPDATE moderation_cases SET status = ?, assigned_to = ?, notes = COALESCE(?, notes), updated_at = ?, resolved_at = ? WHERE id = ?`,
      [action === 'escalate' ? 'escalated' : action === 'dismiss' ? 'dismissed' : 'actioned', u.id, reason || null, now(),
       action === 'escalate' ? null : now(), params.id]);
  logAction(params.id, u.id, action, c.owner_user_id, reason);
  audit(u, `case.${action}`, params.id, { subject: c.subject_type });
  return { ok: true };
});

route('GET', '/api/admin/media/queue', ({ ctx }) => {
  const u = requireRole(ctx, 'admin', 'moderator');
  return {
    media: all<any>(`SELECT m.*, p.username FROM media_assets m LEFT JOIN profiles p ON p.user_id = m.owner_user_id
                      WHERE m.moderation_status = 'review' AND m.deleted_at IS NULL ORDER BY m.created_at LIMIT 50`)
      .map((m) => ({
        id: m.id, username: m.username, mime: m.mime, bytes: m.bytes, width: m.width, height: m.height,
        provider: m.moderation_provider, labels: JSON.parse(m.moderation_json ?? '{}').labels ?? [],
        created_at: m.created_at, url: signMediaUrl(m.id, u.id),
      })),
  };
});

route('POST', '/api/admin/media/:id/decide', async ({ req, ctx, params }) => {
  const u = requireRole(ctx, 'admin', 'moderator');
  const b = await readJson(req);
  const decision = oneOf(b.decision, 'Decision', ['approve', 'block']);
  const a = get<any>('SELECT * FROM media_assets WHERE id = ?', [params.id]);
  if (!a) throw notFound();
  if (decision === 'approve') run(`UPDATE media_assets SET moderation_status='approved' WHERE id = ?`, [params.id]);
  else {
    if (a.storage_key !== '(not stored)') storage.remove(a.storage_key);
    run(`UPDATE media_assets SET moderation_status='blocked', deleted_at=? WHERE id = ?`, [now(), params.id]);
    recordStrike(a.owner_user_id, 'high', 'Image violated Community Guidelines');
  }
  run(`UPDATE moderation_cases SET status='actioned', resolved_at=?, updated_at=? WHERE subject_type='image' AND subject_id=? AND status IN ('open','in_review')`, [now(), now(), params.id]);
  audit(u, `media.${decision}`, params.id);
  return { ok: true };
});

// ------------------------------------------------------------------- users
route('GET', '/api/admin/users', ({ ctx, query }) => {
  requireRole(ctx, 'admin', 'moderator');
  const q = (query.get('q') ?? '').toLowerCase();
  return {
    users: all<any>(
      `SELECT u.id, u.email, u.role, u.status, u.violation_count, u.created_at, u.age_confirmed_at,
              p.username, p.xp, p.level,
              (SELECT granted FROM subscription_entitlements e WHERE e.user_id = u.id AND e.key='image_upload') AS is_pro
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.deleted_at IS NULL AND (? = '' OR lower(u.email) LIKE '%'||?||'%' OR lower(p.username) LIKE '%'||?||'%')
        ORDER BY u.created_at DESC LIMIT 100`, [q, q, q]),
  };
});

route('POST', '/api/admin/users/:id/status', async ({ req, ctx, params }) => {
  const u = requireRole(ctx, 'admin');
  const b = await readJson(req);
  const status = oneOf(b.status, 'Status', ['active', 'restricted', 'suspended', 'banned']);
  run('UPDATE users SET status = ?, status_reason = ?, restricted_until = ?, updated_at = ? WHERE id = ?',
      [status, str(b.reason, 'Reason', { max: 300, required: false }), status === 'restricted' ? plusHours(72) : null, now(), params.id]);
  if (status === 'active') run('UPDATE users SET violation_count = 0 WHERE id = ?', [params.id]);
  audit(u, `user.${status}`, params.id, { reason: b.reason });
  notify(params.id, 'moderation', `Account status: ${status}`, b.reason ?? undefined, '/app#/settings');
  return { ok: true };
});

route('POST', '/api/admin/users/:id/entitlement', async ({ req, ctx, params }) => {
  const u = requireRole(ctx, 'admin');
  const b = await readJson(req);
  const key = str(b.key, 'Entitlement');
  run(`INSERT INTO subscription_entitlements (user_id, key, granted, source, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(user_id, key) DO UPDATE SET granted = excluded.granted, source = excluded.source, updated_at = excluded.updated_at`,
      [params.id, key, b.granted ? 1 : 0, `admin:${u.id}`, now()]);
  audit(u, 'entitlement.grant', params.id, { key, granted: !!b.granted });
  return { ok: true };
});

// --------------------------------------------------------------- locations
route('GET', '/api/admin/locations', ({ ctx, query }) => {
  requireRole(ctx, 'admin', 'moderator');
  return { locations: all<any>(
    `SELECT id, name, slug, city, region, data_source, verification_status, access_policy, safety_level, is_demo, moderation_status, created_at
       FROM locations WHERE deleted_at IS NULL ${query.get('pending') === 'true' ? `AND verification_status = 'pending'` : ''}
      ORDER BY created_at DESC LIMIT 200`) };
});


/** Locations awaiting first review — the user-submission queue. */
route('GET', '/api/admin/locations/pending', ({ ctx }) => {
  requireRole(ctx, 'admin', 'moderator');
  const rows = all<any>(`SELECT l.*, p.username AS submitter
                         FROM locations l LEFT JOIN profiles p ON p.user_id = l.submitted_by
                         WHERE l.moderation_status = 'pending' AND l.deleted_at IS NULL
                         ORDER BY l.created_at ASC LIMIT 100`);
  return {
    pending: rows.map((r) => ({
      id: r.id, slug: r.slug, name: r.name, description: r.description, lore: r.lore,
      city: r.city, region: r.region, address_line: r.address_line, lat: r.lat, lng: r.lng,
      access_policy: r.access_policy, website_url: r.website_url, submitter: r.submitter,
      created_at: r.created_at,
      // Surfaced so a reviewer sees the attestation they are relying on.
      attestation: get<any>(`SELECT meta_json FROM audit_logs
                             WHERE subject = ? AND action = 'location.submitted'
                             ORDER BY created_at DESC LIMIT 1`, [r.id])?.meta_json ?? null,
    })),
    review_guidance: [
      'Confirm the place exists and that public access is lawful before approving.',
      'Reject anything on closed, private or restricted property — no exceptions for "everyone goes there".',
      'Approving publishes it as COMMUNITY REPORTED. Only mark it verified after confirming with the operator.',
    ],
  };
});

/** Approve or reject a submitted location. */
route('POST', '/api/admin/locations/:id/review', async ({ req, ctx, params }) => {
  const u = requireRole(ctx, 'admin', 'moderator');
  const b = await readJson(req);
  const decision = oneOf(b.decision, 'Decision', ['approve', 'reject']);
  const reason = str(b.reason, 'Reason', { max: 500, required: false });
  const loc = get<any>('SELECT * FROM locations WHERE id = ?', [params.id]);
  if (!loc) throw notFound();

  if (decision === 'approve') {
    run(`UPDATE locations SET moderation_status = 'approved', updated_at = ? WHERE id = ?`, [now(), loc.id]);
    if (loc.submitted_by) {
      notify(loc.submitted_by, 'location_approved', 'Your location is live',
        `${loc.name} is now on the map, labelled community reported until it is verified.`,
        `/app#/l/${loc.slug}`);
    }
  } else {
    run(`UPDATE locations SET moderation_status = 'blocked', deleted_at = ?, updated_at = ? WHERE id = ?`,
      [now(), now(), loc.id]);
    if (loc.submitted_by) {
      notify(loc.submitted_by, 'location_rejected', 'Your submission was not published',
        reason || 'It did not meet the listing guidelines. You can appeal from Settings.',
        '/app#/settings');
    }
  }

  // 'actioned' and 'dismissed' are the schema's vocabulary — there is no
  // 'closed' status, and inventing one fails the CHECK constraint.
  run(`UPDATE moderation_cases SET status = ?, resolved_at = ?, updated_at = ?
       WHERE subject_id = ? AND status IN ('open','in_review')`,
    [decision === 'approve' ? 'dismissed' : 'actioned', now(), now(), loc.id]);
  audit(u, `location.${decision}`, loc.id, { reason: reason || null });
  return { ok: true, decision };
});

route('POST', '/api/admin/locations/:id/verify', async ({ req, ctx, params }) => {
  const u = requireRole(ctx, 'admin', 'moderator');
  const b = await readJson(req);
  const st = oneOf(b.verification_status, 'Status', ['unverified', 'pending', 'verified', 'rejected']);
  run(`UPDATE locations SET verification_status = ?, data_source = ?, verified_at = ?, verified_by = ?, updated_at = ? WHERE id = ?`,
      [st, st === 'verified' ? 'verified' : 'community', st === 'verified' ? now() : null, u.id, now(), params.id]);
  audit(u, 'location.verify', params.id, { status: st });
  return { ok: true };
});

route('PATCH', '/api/admin/locations/:id', async ({ req, ctx, params }) => {
  const u = requireRole(ctx, 'admin', 'moderator');
  const b = await readJson(req);
  const allowed = ['name', 'tagline', 'description', 'access_policy', 'safety_level', 'safety_json', 'website_url', 'reservation_url', 'price_text', 'hours_json', 'address_line', 'city', 'region', 'postal_code', 'lat', 'lng', 'address_precision', 'data_source'];
  const fields = Object.entries(b).filter(([k]) => allowed.includes(k));
  if (!fields.length) throw bad('Nothing to update.');
  run(`UPDATE locations SET ${fields.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...fields.map(([, v]) => (typeof v === 'object' ? JSON.stringify(v) : v)), now(), params.id]);
  audit(u, 'location.update', params.id, { fields: fields.map(([k]) => k) });
  return { ok: true };
});

route('GET', '/api/admin/safety-reports', ({ ctx }) => {
  requireRole(ctx, 'admin', 'moderator');
  return { reports: all<any>(
    `SELECT s.*, l.name AS location_name, l.slug, p.username
       FROM safety_reports s JOIN locations l ON l.id = s.location_id
       LEFT JOIN profiles p ON p.user_id = s.user_id
      WHERE s.status IN ('open','reviewing') ORDER BY
        CASE s.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, s.created_at DESC LIMIT 100`) };
});

route('POST', '/api/admin/safety-reports/:id/resolve', async ({ req, ctx, params }) => {
  const u = requireRole(ctx, 'admin', 'moderator');
  const b = await readJson(req);
  run(`UPDATE safety_reports SET status = ?, resolved_at = ? WHERE id = ?`,
      [oneOf(b.status ?? 'resolved', 'Status', ['resolved', 'dismissed', 'reviewing']), now(), params.id]);
  audit(u, 'safety.resolve', params.id);
  return { ok: true };
});

route('GET', '/api/admin/appeals', ({ ctx }) => {
  requireRole(ctx, 'admin', 'moderator');
  return { appeals: all<any>(`SELECT a.*, p.username FROM appeals a LEFT JOIN profiles p ON p.user_id = a.user_id
                               WHERE a.status = 'open' ORDER BY a.created_at LIMIT 100`) };
});

route('POST', '/api/admin/appeals/:id/decide', async ({ req, ctx, params }) => {
  const u = requireRole(ctx, 'admin');
  const b = await readJson(req);
  const decision = oneOf(b.decision, 'Decision', ['granted', 'denied']);
  const a = get<any>('SELECT * FROM appeals WHERE id = ?', [params.id]);
  if (!a) throw notFound();
  run('UPDATE appeals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', [decision, u.id, now(), params.id]);
  if (decision === 'granted') {
    run(`UPDATE users SET status='active', restricted_until=NULL, violation_count = MAX(0, violation_count - 1), updated_at=? WHERE id = ?`, [now(), a.user_id]);
  }
  notify(a.user_id, 'moderation', `Appeal ${decision}`, decision === 'granted' ? 'Your account access has been restored.' : 'Your appeal was reviewed and denied.', '/app#/settings');
  audit(u, `appeal.${decision}`, params.id);
  return { ok: true };
});

// -------------------------------------------------------------- businesses
route('GET', '/api/admin/businesses', ({ ctx }) => {
  requireRole(ctx, 'admin', 'moderator');
  return { businesses: all<any>(`SELECT b.*, l.name AS location_name, l.slug FROM business_profiles b JOIN locations l ON l.id = b.location_id ORDER BY b.created_at DESC LIMIT 100`) };
});

route('POST', '/api/admin/businesses/:id/decide', async ({ req, ctx, params }) => {
  const u = requireRole(ctx, 'admin');
  const b = await readJson(req);
  const st = oneOf(b.claim_status, 'Status', ['pending', 'verified', 'rejected']);
  const biz = get<any>('SELECT * FROM business_profiles WHERE id = ?', [params.id]);
  if (!biz) throw notFound();
  run('UPDATE business_profiles SET claim_status = ?, verified_at = ?, updated_at = ? WHERE id = ?', [st, st === 'verified' ? now() : null, now(), params.id]);
  if (st === 'verified') {
    run(`UPDATE locations SET verification_status='verified', data_source='verified', verified_at=?, verified_by=?, updated_at=? WHERE id = ?`, [now(), u.id, now(), biz.location_id]);
    if (biz.owner_user_id) run(`UPDATE users SET role='business', updated_at=? WHERE id = ? AND role='user'`, [now(), biz.owner_user_id]);
  }
  audit(u, `business.${st}`, params.id);
  return { ok: true };
});

// ------------------------------------------------------------------ config
route('GET', '/api/admin/config', ({ ctx }) => { requireRole(ctx, 'admin'); return { config: allCfg() }; });

route('POST', '/api/admin/config', async ({ req, ctx }) => {
  const u = requireRole(ctx, 'admin');
  const b = await readJson(req);
  const key = str(b.key, 'Key', { max: 80 });
  if (!/^[a-z0-9_.]+$/.test(key)) throw bad('Invalid config key.');
  setCfg(key, b.value, u.id);
  audit(u, 'config.update', key, { value: b.value });
  return { ok: true, config: allCfg() };
});

// ------------------------------------------------------------ mystery drops
route('POST', '/api/admin/mystery-drops', async ({ req, ctx }) => {
  const u = requireRole(ctx, 'admin');
  const b = await readJson(req);
  const loc = get<any>('SELECT id, access_policy FROM locations WHERE slug = ?', [str(b.location_slug, 'Location')]);
  if (!loc) throw notFound('Location not found.');
  // §30 — a Mystery Drop may never point at restricted property.
  if (loc.access_policy === 'private_closed') throw bad('Mystery Drops cannot target private or closed property.', 'restricted_location');
  const did = id('drop');
  run(`INSERT INTO mystery_drops (id, location_id, teaser, fear_flames, group_min, group_max, radius_miles, pro_only, starts_at, ends_at, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [did, loc.id, str(b.teaser, 'Teaser', { max: 200 }), Number(b.fear_flames ?? 4), Number(b.group_min ?? 3),
       Number(b.group_max ?? 6), Number(b.radius_miles ?? 100), b.pro_only ? 1 : 0, b.starts_at ?? now(),
       b.ends_at ?? plusHours(72), u.id, now()]);
  audit(u, 'drop.create', did);
  return { id: did };
}, 201);

route('GET', '/api/admin/audit', ({ ctx }) => {
  requireRole(ctx, 'admin');
  return { logs: all<any>(`SELECT a.*, p.username FROM audit_logs a LEFT JOIN profiles p ON p.user_id = a.actor_id ORDER BY a.created_at DESC LIMIT 200`) };
});