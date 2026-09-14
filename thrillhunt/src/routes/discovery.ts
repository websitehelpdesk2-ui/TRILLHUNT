import { route } from './registry.ts';
import { all, get, run, cfg } from '../lib/db.ts';
import { requireUser, requireWrite } from '../lib/auth.ts';
import { milesBetween, coarseDistance, normLat, normLng, rateLimit } from '../lib/guard.ts';
import { id, now, readJson, str, int, oneOf, notFound, bad, clamp } from '../lib/util.ts';
import { locationCard, destinationFor, publicUser, SAFETY_LABELS, UNKNOWN_INFO, THRILL_WARNING } from '../lib/view.ts';
import { has } from '../services/entitlements.ts';
import { personalRecommendations } from '../services/ai.ts';
import { awardXp, checkBadges } from '../services/xp.ts';
import { openCase } from '../services/moderation.ts';
import { notify } from '../services/notifications.ts';

const LOC_SELECT = `SELECT l.*, (SELECT group_concat(c.slug) FROM location_categories lc JOIN categories c ON c.id = lc.category_id WHERE lc.location_id = l.id) AS cat_slugs
                      FROM locations l WHERE l.deleted_at IS NULL AND l.moderation_status = 'approved'`;

/** Viewer origin: explicit query coords (user granted location) else stored home coords. */
function origin(ctx: any, query: URLSearchParams) {
  const qlat = normLat(query.get('lat')), qlng = normLng(query.get('lng'));
  if (qlat != null && qlng != null) return { lat: qlat, lng: qlng };
  if (ctx.user) {
    const p = get<any>('SELECT home_lat, home_lng FROM profiles WHERE user_id = ?', [ctx.user.id]);
    if (p?.home_lat != null) return { lat: p.home_lat, lng: p.home_lng };
  }
  return { lat: null, lng: null };
}

function withDistance(rows: any[], o: { lat: number | null; lng: number | null }) {
  return rows.map((r) => ({
    ...r,
    miles: o.lat != null && r.lat != null ? milesBetween(o.lat, o.lng!, r.lat, r.lng) : null,
  }));
}

route('GET', '/api/home', ({ ctx, query }) => {
  const o = origin(ctx, query);
  const rows = withDistance(all<any>(LOC_SELECT), o);
  const near = rows.filter((r) => r.miles == null || r.miles <= 250);

  const trending = [...near].sort((a, b) => b.trending_score - a.trending_score).slice(0, 6).map((r) => locationCard(r, o));

  const events = all<any>(
    `SELECT e.*, l.name AS location_name, l.slug AS location_slug, l.lat, l.lng, l.city, l.region, l.data_source
       FROM events e JOIN locations l ON l.id = e.location_id
      WHERE e.deleted_at IS NULL AND e.starts_at > ? ORDER BY e.starts_at LIMIT 8`, [now()])
    .map((e) => {
      const miles = o.lat != null && e.lat != null ? milesBetween(o.lat, o.lng!, e.lat, e.lng) : null;
      return {
        id: e.id, title: e.title, starts_at: e.starts_at, price_text: e.price_text, ticket_url: e.ticket_url,
        location_name: e.location_name, location_slug: e.location_slug, data_source: e.data_source,
        is_demo: !!e.is_demo, distance_label: miles == null ? null : coarseDistance(miles),
      };
    });

  // "People going" respects each user's attendance_public setting.
  const going = all<any>(
    `SELECT a.going_date, l.slug, l.name, COUNT(*) AS people
       FROM attendance a JOIN locations l ON l.id = a.location_id
       JOIN profiles p ON p.user_id = a.user_id
      WHERE a.status = 'going' AND a.going_date >= date('now') AND a.visibility = 'public' AND p.attendance_public = 1
      GROUP BY l.id, a.going_date ORDER BY people DESC LIMIT 6`);

  const drop = get<any>(
    `SELECT d.*, l.name, l.slug FROM mystery_drops d JOIN locations l ON l.id = d.location_id
      WHERE d.starts_at <= ? AND d.ends_at > ? ORDER BY d.created_at DESC LIMIT 1`, [now(), now()]);
  const revealed = drop && ctx.user
    ? !!get('SELECT drop_id FROM mystery_drop_reveals WHERE drop_id = ? AND user_id = ?', [drop.id, ctx.user.id])
    : false;

  return {
    trending,
    events,
    people_going: going,
    mystery_drop: drop ? {
      id: drop.id, teaser: drop.teaser, fear_flames: drop.fear_flames,
      group_min: drop.group_min, group_max: drop.group_max, radius_miles: drop.radius_miles,
      pro_only: !!drop.pro_only,
      locked: !!drop.pro_only && !(ctx.user && has(ctx.user.id, 'mystery_exclusive')),
      revealed,
      reveal: revealed ? { name: drop.name, slug: drop.slug } : null,
      ends_at: drop.ends_at,
    } : null,
    recommendations: ctx.user
      ? personalRecommendations(ctx.user.id, o.lat, o.lng, 6).map((r: any) => ({ ...locationCard(r, o), reason: r.reason }))
      : trending.slice(0, 3),
    location_known: o.lat != null,
  };
});

route('GET', '/api/explore', ({ ctx, query }) => {
  const o = origin(ctx, query);
  const cat = query.get('category') ?? '';
  const sort = oneOf(query.get('sort') ?? 'recommended', 'Sort',
    ['closest', 'rating', 'popular', 'terrifying', 'newest', 'recommended']);
  const maxMiles = clamp(Number(query.get('within') ?? (cfg('discovery.defaults') as any).max_radius_miles), 1, 3000);
  const minRating = Number(query.get('min_rating') ?? 0);
  const minFear = Number(query.get('min_fear') ?? 0);
  const maxDifficulty = Number(query.get('max_difficulty') ?? 10);
  const verifiedOnly = query.get('verified') === 'true';
  const openNow = query.get('open_now') === 'true';
  const maxPrice = query.get('max_price') ? Number(query.get('max_price')) : null;

  // §18 — advanced filters are a Pro feature; enforced server-side, not hidden.
  const usingAdvanced = !!(query.get('min_fear') || query.get('max_difficulty') || query.get('max_price'));
  const advancedAllowed = !usingAdvanced || (ctx.user ? has(ctx.user.id, 'advanced_filters') : false);

  let rows = withDistance(all<any>(LOC_SELECT), o);
  if (cat) rows = rows.filter((r) => String(r.cat_slugs ?? '').split(',').includes(cat));
  rows = rows.filter((r) => r.miles == null || r.miles <= maxMiles);
  if (minRating) rows = rows.filter((r) => r.rating_avg >= minRating);
  if (verifiedOnly) rows = rows.filter((r) => r.data_source === 'verified');
  if (openNow) rows = rows.filter((r) => !!r.hours_json);
  if (advancedAllowed) {
    if (minFear) rows = rows.filter((r) => (r.fear ?? 0) >= minFear);
    if (maxDifficulty < 10) rows = rows.filter((r) => (r.difficulty ?? 0) <= maxDifficulty);
    if (maxPrice != null) rows = rows.filter((r) => r.price_min_cents == null || r.price_min_cents <= maxPrice * 100);
  }

  const sorters: Record<string, (a: any, b: any) => number> = {
    closest: (a, b) => (a.miles ?? 1e9) - (b.miles ?? 1e9),
    rating: (a, b) => b.rating_avg - a.rating_avg,
    popular: (a, b) => b.interested_count - a.interested_count,
    terrifying: (a, b) => (b.fear ?? 0) - (a.fear ?? 0),
    newest: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    recommended: (a, b) => (b.trending_score + b.rating_avg * 8) - (a.trending_score + a.rating_avg * 8),
  };
  rows.sort(sorters[sort]);
  const page = Math.max(0, int(query.get('page') ?? 0, 'Page', { required: false }));
  const size = 20;
  return {
    total: rows.length,
    page, page_size: size,
    advanced_filters_locked: usingAdvanced && !advancedAllowed,
    results: rows.slice(page * size, page * size + size).map((r) => locationCard(r, o)),
  };
});

route('GET', '/api/search', ({ ctx, query }) => {
  const o = origin(ctx, query);
  const q = (query.get('q') ?? '').trim().toLowerCase();
  if (!q) return { results: [], interpreted: null };

  // Lightweight NL interpretation: "haunted attractions near Omaha",
  // "camping within 100 miles", "scary things to do this weekend".
  const radius = Number(q.match(/within\s+(\d+)\s*miles?/)?.[1] ?? 0) || null;
  const nearCity = q.match(/near\s+([a-z\s]+)$/)?.[1]?.trim() ?? null;
  const weekend = /this weekend|tonight|tomorrow/.test(q);
  const catHints: Record<string, RegExp> = {
    'haunted-attractions': /haunt|scary|terrif|fright/,
    paranormal: /paranormal|ghost|spirit|paranormal investigation/,
    camping: /camp/,
    hiking: /hike|trail/,
    'night-adventures': /night/,
    'road-trips': /road ?trip/,
    'halloween-events': /halloween/,
    'outdoor-adventures': /adrenaline|outdoor|zip|climb/,
    'remote-adventures': /remote|isolated/,
    'hidden-gems': /hidden|weird|unusual/,
  };
  const cats = Object.entries(catHints).filter(([, re]) => re.test(q)).map(([c]) => c);

  let rows = withDistance(all<any>(LOC_SELECT), o);
  const terms = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2);
  rows = rows.map((r) => {
    const hay = `${r.name} ${r.tagline ?? ''} ${r.description ?? ''} ${r.city ?? ''} ${r.region ?? ''} ${r.cat_slugs ?? ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += hay.startsWith(t) ? 4 : 2;
    if (cats.some((c) => String(r.cat_slugs ?? '').includes(c))) score += 6;
    if (nearCity && `${r.city ?? ''} ${r.region ?? ''}`.toLowerCase().includes(nearCity)) score += 8;
    if (radius && r.miles != null && r.miles <= radius) score += 4;
    if (r.miles != null) score += Math.max(0, 3 - r.miles / 80);
    return { ...r, score };
  }).filter((r) => r.score > 0);
  if (radius) rows = rows.filter((r) => r.miles == null || r.miles <= radius);
  rows.sort((a, b) => b.score - a.score);

  const events = weekend
    ? all<any>(`SELECT e.title, e.starts_at, l.slug, l.name FROM events e JOIN locations l ON l.id = e.location_id
                 WHERE e.deleted_at IS NULL AND e.starts_at BETWEEN ? AND datetime(?, '+7 days') ORDER BY e.starts_at LIMIT 5`, [now(), now()])
    : [];

  return {
    interpreted: { categories: cats, radius_miles: radius, near: nearCity, time_window: weekend ? 'next 7 days' : null },
    results: rows.slice(0, 25).map((r) => locationCard(r, o)),
    events,
  };
});

route('GET', '/api/map', ({ ctx, query }) => {
  const o = origin(ctx, query);
  const filter = query.get('filter') ?? 'nearby';
  let rows = withDistance(all<any>(LOC_SELECT + ' AND l.lat IS NOT NULL'), o);
  if (filter === 'trending') rows = rows.filter((r) => r.trending_score > 40);
  if (filter === 'open_now') rows = rows.filter((r) => !!r.hours_json);
  if (filter === 'weekend') {
    const ids = new Set(all<any>(`SELECT DISTINCT location_id FROM events WHERE starts_at BETWEEN ? AND datetime(?, '+7 days')`, [now(), now()]).map((r) => r.location_id));
    rows = rows.filter((r) => ids.has(r.id));
  }
  if (filter === 'drops') {
    const ids = new Set(all<any>('SELECT location_id FROM mystery_drops WHERE ends_at > ?', [now()]).map((r) => r.location_id));
    rows = rows.filter((r) => ids.has(r.id));
  }
  return {
    // Pins are location pins only. No user positions are ever returned (§9).
    pins: rows.slice(0, 300).map((r) => ({
      id: r.id, slug: r.slug, name: r.name, lat: r.lat, lng: r.lng,
      category: String(r.cat_slugs ?? '').split(',')[0] ?? 'hidden-gems',
      data_source: r.data_source, access_policy: r.access_policy,
      rating_avg: r.rating_avg, fear: r.fear,
      distance_label: r.miles == null ? null : coarseDistance(r.miles),
      safety_level: r.safety_level,
    })),
    center: o.lat != null ? { lat: o.lat, lng: o.lng } : null,
  };
});

route('GET', '/api/locations/:slug', ({ ctx, params, query }) => {
  const o = origin(ctx, query);
  const r = get<any>(`${LOC_SELECT} AND l.slug = ?`, [params.slug]);
  if (!r) throw notFound('That experience does not exist or was removed.');
  const miles = o.lat != null && r.lat != null ? milesBetween(o.lat, o.lng!, r.lat, r.lng) : null;

  let safety: any = {};
  try { safety = r.safety_json ? JSON.parse(r.safety_json) : {}; } catch { safety = {}; }
  // §11 — unknown fields are explicitly labelled, never filled in.
  const SAFETY_FIELDS = [
    ['property_status', 'Property status'], ['operating_status', 'Official operating status'],
    ['reservations', 'Reservations'], ['permits', 'Permits'], ['hazards', 'Known hazards'],
    ['terrain', 'Terrain difficulty'], ['cell_service', 'Cell service'], ['emergency_access', 'Emergency access'],
    ['weather', 'Weather considerations'], ['seasonal', 'Seasonal closures'], ['night_access', 'Nighttime access'],
    ['operator', 'Official operator'],
  ];
  const know_before_you_go = SAFETY_FIELDS.map(([key, label]) => ({
    key, label,
    value: safety[key] ?? null,
    known: safety[key] != null,
    display: safety[key] ?? UNKNOWN_INFO,
  }));

  const chat = get<any>('SELECT id FROM chats WHERE location_id = ?', [r.id]);
  const members = chat ? get<any>('SELECT COUNT(*) c FROM chat_members WHERE chat_id = ? AND state != ?', [chat.id, 'left'])?.c ?? 0 : 0;

  const whosGoing = all<any>(
    `SELECT a.going_date, COUNT(*) AS people FROM attendance a JOIN profiles p ON p.user_id = a.user_id
      WHERE a.location_id = ? AND a.status = 'going' AND a.going_date >= date('now')
        AND a.visibility = 'public' AND p.attendance_public = 1
      GROUP BY a.going_date ORDER BY a.going_date LIMIT 8`, [r.id]);

  const mine = ctx.user
    ? all<any>('SELECT status, going_date FROM attendance WHERE location_id = ? AND user_id = ?', [r.id, ctx.user.id])
    : [];

  return {
    location: {
      ...locationCard(r, o),
      description: r.description,
      website_url: r.website_url, phone: r.phone,
      reservation_url: r.reservation_url,
      hours: r.hours_json ? JSON.parse(r.hours_json) : null,
      hours_display: r.hours_json ? (JSON.parse(r.hours_json).note ?? 'See official hours') : UNKNOWN_INFO,
      price_text: r.price_text ?? UNKNOWN_INFO,
      address_display: r.address_precision === 'exact' && r.address_line
        ? [r.address_line, r.city, r.region, r.postal_code].filter(Boolean).join(', ')
        : [r.city, r.region].filter(Boolean).join(', ') || UNKNOWN_INFO,
      coords: r.lat != null ? { lat: r.lat, lng: r.lng } : null,
      distance_label: miles == null ? null : coarseDistance(miles),
      verified_at: r.verified_at,
    },
    destination: destinationFor(r),           // §68 navigation payload
    safety: {
      level: r.safety_level,
      indicator: r.safety_level ? SAFETY_LABELS[r.safety_level] : { dot: '⚪️', label: 'Safety information unavailable' },
      know_before_you_go,
      access_policy: r.access_policy,
      access_note: accessNote(r.access_policy),
      warning: THRILL_WARNING,
    },
    events: all<any>(`SELECT id, title, description, starts_at, ends_at, price_text, ticket_url, data_source, is_demo
                        FROM events WHERE location_id = ? AND deleted_at IS NULL AND starts_at > ? ORDER BY starts_at LIMIT 10`, [r.id, now()]),
    reviews: all<any>(`SELECT rv.id, rv.rating, rv.body, rv.created_at, p.username, p.avatar_emoji
                         FROM reviews rv JOIN profiles p ON p.user_id = rv.user_id
                        WHERE rv.location_id = ? AND rv.deleted_at IS NULL AND rv.moderation_status = 'approved'
                        ORDER BY rv.created_at DESC LIMIT 10`, [r.id]),
    thrill_reports: all<any>(`SELECT t.id, t.fear, t.paranormal, t.isolation, t.darkness, t.difficulty, t.value, t.overall,
                                     t.would_return, t.body, t.created_at, p.username, p.avatar_emoji
                                FROM thrill_reports t JOIN profiles p ON p.user_id = t.user_id
                               WHERE t.location_id = ? AND t.deleted_at IS NULL AND t.moderation_status = 'approved'
                               ORDER BY t.created_at DESC LIMIT 10`, [r.id]),
    chat: chat ? { id: chat.id, members } : null,
    whos_going: whosGoing,
    business: get<any>(`SELECT legal_name, claim_status, verified_at FROM business_profiles WHERE location_id = ?`, [r.id]) ?? null,
    my_attendance: mine,
    saved: ctx.user ? !!get('SELECT user_id FROM saved_locations WHERE user_id = ? AND location_id = ?', [ctx.user.id, r.id]) : false,
  };
});

function accessNote(policy: string) {
  return ({
    open: 'Publicly accessible. Follow posted rules and hours.',
    ticketed: 'Ticket required. Buy through the official operator.',
    reservation: 'Reservation required before arrival.',
    permit: 'Permit required. Apply through the managing agency.',
    guided: 'Access only with an official guided tour or investigation.',
    private_closed: 'PRIVATE / CLOSED — entry is not permitted. This listing is informational only. Do not attempt to enter.',
  } as Record<string, string>)[policy] ?? UNKNOWN_INFO;
}

// ------------------------------------------------------------- attendance
route('POST', '/api/locations/:slug/attendance', async ({ req, ctx, params }) => {
  const u = requireWrite(ctx);
  const b = await readJson(req);
  const loc = get<any>('SELECT id, name, access_policy FROM locations WHERE slug = ? AND deleted_at IS NULL', [params.slug]);
  if (!loc) throw notFound();
  if (loc.access_policy === 'private_closed') {
    throw bad('This location is private or closed. THRILLHUNT does not support planning visits to restricted property.', 'restricted_location');
  }
  const status = oneOf(b.status, 'Status', ['interested', 'going', 'completed']);
  const date = b.going_date ? str(b.going_date, 'Date', { max: 10 }) : null;
  if (status !== 'interested' && !date) throw bad('Pick a date for your trip.');
  const visibility = oneOf(b.visibility ?? 'public', 'Visibility', ['public', 'private']);

  run(`INSERT INTO attendance (id, location_id, user_id, status, going_date, visibility, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(location_id, user_id, going_date) DO UPDATE SET status = excluded.status, visibility = excluded.visibility`,
      [id('att'), loc.id, u.id, status, date, visibility, now()]);
  run('UPDATE locations SET interested_count = (SELECT COUNT(*) FROM attendance WHERE location_id = ?), trending_score = trending_score + 1 WHERE id = ?', [loc.id, loc.id]);

  if (status === 'going') awardXp(u.id, 'marked_going', undefined, `going:${loc.id}:${date}`);
  if (status === 'completed') {
    awardXp(u.id, 'first_adventure', undefined, 'first_adventure');
    checkBadges(u.id);
  }
  return { ok: true, status, going_date: date };
});

route('GET', '/api/locations/:slug/going', ({ ctx, params, query }) => {
  requireUser(ctx);
  const loc = get<any>('SELECT id FROM locations WHERE slug = ?', [params.slug]);
  if (!loc) throw notFound();
  const date = query.get('date');
  const rows = all<any>(
    `SELECT a.user_id, a.going_date FROM attendance a JOIN profiles p ON p.user_id = a.user_id
      WHERE a.location_id = ? AND a.status = 'going' AND a.visibility = 'public' AND p.attendance_public = 1
        ${date ? 'AND a.going_date = ?' : ''}
        AND a.user_id NOT IN (SELECT target_id FROM user_blocks WHERE user_id = ?)
        AND a.user_id NOT IN (SELECT user_id FROM user_blocks WHERE target_id = ?)
      LIMIT 50`,
    date ? [loc.id, date, ctx.user!.id, ctx.user!.id] : [loc.id, ctx.user!.id, ctx.user!.id]);
  return { people: rows.map((r) => ({ ...publicUser(r.user_id, ctx.user!.id), going_date: r.going_date })) };
});

route('POST', '/api/locations/:slug/save', async ({ ctx, params }) => {
  const u = requireUser(ctx);
  const loc = get<any>('SELECT id FROM locations WHERE slug = ?', [params.slug]);
  if (!loc) throw notFound();
  const existing = get('SELECT user_id FROM saved_locations WHERE user_id = ? AND location_id = ?', [u.id, loc.id]);
  if (existing) { run('DELETE FROM saved_locations WHERE user_id = ? AND location_id = ?', [u.id, loc.id]); return { saved: false }; }
  run('INSERT INTO saved_locations (user_id, location_id, created_at) VALUES (?,?,?)', [u.id, loc.id, now()]);
  return { saved: true };
});

route('GET', '/api/saved', ({ ctx, query }) => {
  const u = requireUser(ctx);
  const o = origin(ctx, query);
  const rows = withDistance(all<any>(`${LOC_SELECT} AND l.id IN (SELECT location_id FROM saved_locations WHERE user_id = ?)`, [u.id]), o);
  return { results: rows.map((r) => locationCard(r, o)) };
});

// ------------------------------------------------------- safety reporting
route('POST', '/api/locations/:slug/safety-report', async ({ req, ctx, params }) => {
  const u = requireWrite(ctx);
  rateLimit(`safety:${u.id}`, 10, 3600);
  const b = await readJson(req);
  const loc = get<any>('SELECT id, name FROM locations WHERE slug = ?', [params.slug]);
  if (!loc) throw notFound();
  const issue = oneOf(b.issue_type, 'Issue type', ['closed', 'hazard', 'access_denied', 'inaccurate_info', 'unsafe_conditions', 'other']);
  const severity = oneOf(b.severity ?? 'normal', 'Severity', ['low', 'normal', 'high', 'critical']);
  const body = str(b.body, 'Details', { max: 2000, required: false });
  const caseId = openCase({ subjectType: 'location', subjectId: loc.id, origin: 'user_report', severity, notes: `Safety: ${issue}` });
  run(`INSERT INTO safety_reports (id, location_id, user_id, issue_type, severity, body, status, case_id, created_at)
       VALUES (?,?,?,?,?,?, 'open', ?, ?)`, [id('sfr'), loc.id, u.id, issue, severity, body, caseId, now()]);
  return { ok: true, message: 'Thanks — our safety team will review this. If this is an emergency, contact your local emergency services.' };
}, 201);

route('GET', '/api/categories', () =>
  ({ categories: all<any>(`SELECT c.slug, c.name, c.icon, c.blurb,
        (SELECT COUNT(*) FROM location_categories lc JOIN locations l ON l.id = lc.location_id
          WHERE lc.category_id = c.id AND l.deleted_at IS NULL) AS count
       FROM categories c WHERE c.active = 1 ORDER BY c.sort_order`) }));
