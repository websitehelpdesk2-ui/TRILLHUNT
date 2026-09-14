/**
 * DEMO SEED (§52)
 *
 * IMPORTANT: every location, event and business created here is FICTIONAL and
 * flagged `is_demo = 1`. The UI renders a SAMPLE DATA chip on anything with
 * that flag. No real business is presented as verified, and no real-world
 * safety information is invented — demo records that would need verification
 * leave those fields NULL so the "Information unavailable" path is exercised.
 *
 * Coordinates are plausible points in the region so distance math is testable;
 * they are not claims about real places.
 */
import { db, run, get, all, migrate, tx, setCfg } from '../src/lib/db.ts';
import { hashPassword, AGE_ATTESTATION } from '../src/lib/auth.ts';
import { id, now, plusDays, plusHours, slugify } from '../src/lib/util.ts';
import { syncEntitlements } from '../src/services/entitlements.ts';
import { config } from '../src/config.ts';

migrate();

const RESET = process.argv.includes('--reset');
if (RESET) {
  for (const t of ['mystery_drop_reveals', 'mystery_drops', 'ai_recommendations', 'trips', 'xp_transactions',
    'user_achievements', 'badges', 'audit_logs', 'appeals', 'moderation_actions', 'moderation_cases', 'reports',
    'safety_reports', 'notifications', 'message_reactions', 'message_attachments', 'messages', 'chat_members',
    'chats', 'group_members', 'groups', 'post_likes', 'thrill_reports', 'reviews', 'media_assets', 'saved_locations',
    'attendance', 'user_blocks', 'events', 'business_profiles', 'location_categories', 'locations', 'categories',
    'payment_events', 'subscription_entitlements', 'subscriptions', 'sessions', 'profiles', 'users', 'rate_events', 'app_config']) {
    try { db.exec(`DELETE FROM ${t}`); } catch { /* table may not exist yet */ }
  }
}

const CATS: [string, string, string, string][] = [
  ['haunted-attractions', 'Haunted Attractions', '👻', 'Ticketed haunts, scream parks and walkthroughs.'],
  ['halloween-events', 'Halloween Events', '🎃', 'Seasonal festivals, trails and parties.'],
  ['paranormal', 'Paranormal', '🔦', 'Guided investigations and reportedly active sites.'],
  ['camping', 'Camping', '🏕️', 'Campgrounds, primitive sites and basecamps.'],
  ['remote-adventures', 'Remote Adventures', '🌲', 'Far from pavement, further from signal.'],
  ['night-adventures', 'Night Adventures', '🌙', 'Everything hits different after dark.'],
  ['hiking', 'Hiking', '🥾', 'Trails worth the calves.'],
  ['road-trips', 'Road Trips', '🚗', 'Routes built for a full tank and bad decisions in good company.'],
  ['horror-experiences', 'Horror Experiences', '🧟', 'Immersive, interactive, intense.'],
  ['outdoor-adventures', 'Outdoor Adventures', '🔥', 'Climbing, water, heights, adrenaline.'],
  ['hidden-gems', 'Hidden Gems', '🧭', 'Weird, wonderful and under-visited.'],
  ['trending', 'Trending', '⭐', 'What the community is on right now.'],
];

const BADGES: [string, string, string, string, any][] = [
  ['first-blood', 'First Blood', '🩸', 'Filed your first Thrill Report.', { stat: 'thrill_reports', min: 1 }],
  ['night-crawler', 'Night Crawler', '🌙', 'Completed 3 night adventures.', { stat: 'night', min: 3 }],
  ['no-signal', 'No Signal', '📵', 'Completed 2 remote trips with no cell service.', { stat: 'checkins', min: 2 }],
  ['ghost-hunter', 'Ghost Hunter', '👻', 'Completed 3 haunted or paranormal experiences.', { stat: 'haunted', min: 3 }],
  ['campfire-veteran', 'Campfire Veteran', '🏕️', 'Completed 3 camping trips.', { stat: 'camping', min: 3 }],
  ['road-warrior', 'Road Warrior', '🚗', 'Completed 2 road-trip experiences.', { stat: 'road_trips', min: 2 }],
  ['fearless', 'Fearless', '💀', 'Filed 10 Thrill Reports.', { stat: 'thrill_reports', min: 10 }],
  ['pack-leader', 'Pack Leader', '🐺', 'Joined or created 3 groups.', { stat: 'groups', min: 3 }],
];

// All fictional. lat/lng are plausible regional points for distance testing.
const LOCATIONS: any[] = [
  {
    name: 'Hollow Creek Haunted Woods', tagline: 'A mile of trail. Nine acts. No safe word.',
    cats: ['haunted-attractions', 'horror-experiences', 'night-adventures'],
    description: 'A ticketed outdoor haunted trail run by a seasonal attraction operator. Groups of up to six walk a marked one-mile loop through timber with live actors and practical effects. Closed-toe shoes required; the trail is uneven and unlit between sets.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'ticketed',
    city: 'Blair', region: 'NE', lat: 41.5439, lng: -96.1253, address_precision: 'exact', address_line: '12 County Road (demo address)',
    price_text: '$28–$36', price_min_cents: 2800, website_url: 'https://example.com/hollow-creek',
    hours: { note: 'Fri–Sat 7:30pm–midnight, late Sep through early Nov (seasonal)', seasonal: 'Seasonal — September to November' },
    fear: 9.2, paranormal: 8.7, isolation: 8.4, darkness: 9.8, difficulty: 6.1,
    safety_level: 'caution',
    safety: {
      property_status: 'Private property operated as a seasonal attraction — open to ticket holders only.',
      operating_status: 'Seasonal. Check the operator before driving out.',
      reservations: 'Timed tickets recommended on weekends.',
      hazards: 'Uneven terrain, tree roots, strobe lighting, fog, loud noise.',
      terrain: 'Moderate — 1 mile of dirt trail with slopes.',
      night_access: 'Only during posted operating hours with a ticket.',
      operator: 'Sample Operator LLC (demo record)',
    },
    rating: 4.8, ratings: 212, trending: 96,
  },
  {
    name: 'Blackwater Ridge Primitive Camp', tagline: 'No hookups. No lights. No neighbours.',
    cats: ['camping', 'remote-adventures'],
    description: 'Primitive walk-in campsites managed by a county parks department. Sites are first-come, first-served with a self-pay envelope at the trailhead. Water must be packed in.',
    data_source: 'community', verification_status: 'unverified', access_policy: 'permit',
    city: 'Nebraska City', region: 'NE', lat: 40.6772, lng: -95.8591, address_precision: 'approximate',
    price_text: '$12/night (community-reported)', price_min_cents: 1200,
    hours: null,
    fear: 4.1, paranormal: 5.2, isolation: 9.3, darkness: 9.1, difficulty: 5.4,
    safety_level: 'elevated',
    safety: {
      permits: 'Self-issue permit required at the trailhead kiosk (community-reported).',
      cell_service: 'Community reports say none past the first ridge.',
      hazards: 'No potable water. Ticks in summer. Steep descent to the creek.',
      emergency_access: 'Nearest paved road is roughly 2 miles from the furthest sites.',
    },
    rating: 4.5, ratings: 64, trending: 71,
  },
  {
    name: 'The Drover Hotel Paranormal Investigation', tagline: 'Guided overnight. Fourth floor only.',
    cats: ['paranormal', 'horror-experiences'],
    description: 'A guided overnight investigation hosted inside a historic hotel by a licensed tour company. Participants are escorted at all times and equipment is provided. 18+ only.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'guided',
    city: 'Council Bluffs', region: 'IA', lat: 41.2619, lng: -95.8608, address_precision: 'exact', address_line: '400 Sample Street (demo address)',
    price_text: '$85 per person', price_min_cents: 8500, reservation_url: 'https://example.com/drover-booking',
    hours: { note: 'Investigations run 10pm–3am, select Saturdays' },
    fear: 7.4, paranormal: 9.6, isolation: 3.2, darkness: 8.8, difficulty: 2.1,
    safety_level: 'low',
    safety: {
      property_status: 'Private property. Access only on a booked, guided investigation.',
      operating_status: 'Operating — select dates.',
      reservations: 'Required. Sells out weeks ahead.',
      operator: 'Sample Paranormal Tours (demo record)',
      emergency_access: 'Staffed building, street access.',
      night_access: 'Only with the guide. Do not enter outside booked hours.',
    },
    rating: 4.9, ratings: 143, trending: 88,
  },
  {
    name: 'Sandhills Dark Sky Overlook', tagline: 'The Milky Way, unreasonably loud.',
    cats: ['night-adventures', 'hiking', 'hidden-gems'],
    description: 'A public overlook with minimal light pollution, popular with astrophotographers. Gravel lot, short walk to the rim, no facilities.',
    data_source: 'community', verification_status: 'unverified', access_policy: 'open',
    city: 'Broken Bow', region: 'NE', lat: 41.4014, lng: -99.6387, address_precision: 'approximate',
    price_text: 'Free', price_min_cents: 0, hours: { note: 'Open 24h (community-reported)' },
    fear: 2.8, paranormal: 3.9, isolation: 8.9, darkness: 9.9, difficulty: 3.2,
    safety_level: 'caution',
    safety: {
      hazards: 'Unfenced drop at the rim. Bring headlamps and park fully off the roadway.',
      cell_service: 'Spotty — community-reported.',
      weather: 'Wind exposure; conditions change fast after dark.',
    },
    rating: 4.7, ratings: 88, trending: 64,
  },
  {
    name: 'Ironwood Scream Park', tagline: 'Four attractions. One wristband. Zero dignity.',
    cats: ['haunted-attractions', 'halloween-events'],
    description: 'A multi-attraction seasonal scream park with indoor haunted houses, a midway and food vendors. Family-friendly early hours, 18+ intense hours after 10pm.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'ticketed',
    city: 'Omaha', region: 'NE', lat: 41.2565, lng: -95.9345, address_precision: 'exact', address_line: '900 Sample Boulevard (demo address)',
    price_text: '$39 all-access', price_min_cents: 3900, website_url: 'https://example.com/ironwood',
    hours: { note: 'Thu–Sun 7pm–1am during the season' },
    fear: 8.1, paranormal: 4.4, isolation: 2.2, darkness: 8.6, difficulty: 3.0,
    safety_level: 'low',
    safety: {
      property_status: 'Private venue, open to ticket holders.',
      operating_status: 'Seasonal.',
      reservations: 'Walk-ups accepted; weekends sell out.',
      hazards: 'Strobe lighting, fog, loud audio, actors in close proximity.',
      emergency_access: 'On-site staff and first aid.',
      operator: 'Sample Attractions Co. (demo record)',
    },
    rating: 4.6, ratings: 431, trending: 92,
  },
  {
    name: 'Loess Bluff Night Trail', tagline: '6.2 miles. Headlamps mandatory. Ridgeline the whole way.',
    cats: ['hiking', 'night-adventures', 'outdoor-adventures'],
    description: 'A public trail system that permits after-dark use on marked routes. The ridge section is exposed with steep drop-offs on the east side.',
    data_source: 'community', verification_status: 'pending', access_policy: 'open',
    city: 'Missouri Valley', region: 'IA', lat: 41.5572, lng: -95.8853, address_precision: 'approximate',
    price_text: 'Free', price_min_cents: 0, hours: null,
    fear: 5.2, paranormal: 4.0, isolation: 7.1, darkness: 9.2, difficulty: 7.6,
    safety_level: 'elevated',
    safety: {
      hazards: 'Steep unguarded drop-offs, loose loess soil after rain.',
      terrain: 'Strenuous — 1,100 ft cumulative gain.',
      night_access: 'Community-reported as permitted on marked trails; verify current park rules.',
    },
    rating: 4.4, ratings: 57, trending: 58,
  },
  {
    name: 'The Larkin Sanatorium (CLOSED — DO NOT ENTER)', tagline: 'Listed for awareness. Entry is not permitted.',
    cats: ['hidden-gems'],
    description: 'A decommissioned private facility that appears frequently in local folklore. The property is fenced, monitored and strictly closed to the public. This listing exists so people stop asking how to get in: you cannot, legally, and THRILLHUNT will not help you try. There are guided, legal alternatives in the Paranormal category.',
    data_source: 'restricted', verification_status: 'verified', access_policy: 'private_closed',
    city: 'Fremont', region: 'NE', lat: 41.4333, lng: -96.4981, address_precision: 'approximate',
    price_text: null, price_min_cents: null, hours: null,
    fear: null, paranormal: null, isolation: null, darkness: null, difficulty: null,
    safety_level: 'high',
    safety: {
      property_status: 'PRIVATE PROPERTY — CLOSED. Entry is trespassing and is actively enforced.',
      operating_status: 'Permanently closed to visitors.',
      hazards: 'Structurally unsound. Asbestos. No emergency access.',
      emergency_access: 'None.',
    },
    rating: 0, ratings: 0, trending: 12,
  },
  {
    name: 'Cottonwood Hollow Campground', tagline: 'Firewood, river access, and a very loud owl.',
    cats: ['camping', 'road-trips'],
    description: 'A managed campground with reservable sites, potable water and vault toilets. Popular staging point for river paddling.',
    data_source: 'verified', verification_status: 'verified', access_policy: 'reservation',
    city: 'Plattsmouth', region: 'NE', lat: 41.0111, lng: -95.8822, address_precision: 'exact', address_line: '55 Sample River Road (demo address)',
    price_text: '$22–$30/night', price_min_cents: 2200, reservation_url: 'https://example.com/cottonwood-reserve',
    hours: { note: 'Check-in 2pm, quiet hours 10pm–7am' },
    fear: 1.9, paranormal: 3.1, isolation: 5.5, darkness: 7.4, difficulty: 2.0,
    safety_level: 'low',
    safety: {
      reservations: 'Required in peak season.',
      cell_service: 'Reliable at the office, patchy at riverside sites.',
      weather: 'River sites flood — check the forecast.',
      operator: 'Sample Parks District (demo record)',
      emergency_access: 'Paved access road, camp host on site.',
    },
    rating: 4.3, ratings: 176, trending: 44,
  },
];

const USERS = [
  { username: 'JAKETHEEXPLORER', email: 'jake@demo.thrillhunt.test', emoji: '🧭', bio: 'If it is dark, muddy, or allegedly haunted, I am already in the car.', city: 'Omaha, NE', lat: 41.2565, lng: -95.9345, xp: 7450, pro: true },
  { username: 'sarah_nocturne', email: 'sarah@demo.thrillhunt.test', emoji: '🌙', bio: 'Night hikes and bad ideas. Will drive 3 hours for a good trail.', city: 'Lincoln, NE', lat: 40.8136, lng: -96.7026, xp: 3120, pro: false },
  { username: 'mikeonthemap', email: 'mike@demo.thrillhunt.test', emoji: '🔦', bio: 'Paranormal investigation hobbyist. Skeptic with a full kit.', city: 'Council Bluffs, IA', lat: 41.2619, lng: -95.8608, xp: 1890, pro: false },
  { username: 'campfire_kate', email: 'kate@demo.thrillhunt.test', emoji: '🏕️', bio: 'Primitive sites only. Bring coffee.', city: 'Blair, NE', lat: 41.5439, lng: -96.1253, xp: 5010, pro: true },
];

tx(() => {
  // categories
  CATS.forEach(([slug, name, icon, blurb], i) =>
    run(`INSERT INTO categories (id, slug, name, icon, blurb, sort_order, active) VALUES (?,?,?,?,?,?,1)
         ON CONFLICT(slug) DO UPDATE SET name=excluded.name, icon=excluded.icon`, [id('cat'), slug, name, icon, blurb, i]));

  BADGES.forEach(([slug, name, icon, desc, rule]) =>
    run(`INSERT INTO badges (id, slug, name, icon, description, rule_json, pro_only) VALUES (?,?,?,?,?,?,0)
         ON CONFLICT(slug) DO NOTHING`, [id('bdg'), slug, name, icon, desc, JSON.stringify(rule)]));

  // locations
  for (const L of LOCATIONS) {
    const lid = id('loc');
    const slug = slugify(L.name);
    run(`INSERT INTO locations (id, slug, name, tagline, description, data_source, verification_status, verified_at, is_demo,
          access_policy, address_line, city, region, country, lat, lng, address_precision, website_url, hours_json, price_text,
          price_min_cents, reservation_url, fear, paranormal, isolation, darkness, difficulty, rating_avg, rating_count,
          interested_count, trending_score, safety_level, safety_json, moderation_status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?, 'US', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'approved', ?,?)
         ON CONFLICT(slug) DO NOTHING`,
      [lid, slug, L.name, L.tagline, L.description, L.data_source, L.verification_status,
       L.verification_status === 'verified' ? now() : null, L.access_policy, L.address_line ?? null, L.city, L.region,
       L.lat, L.lng, L.address_precision, L.website_url ?? null, L.hours ? JSON.stringify(L.hours) : null,
       L.price_text ?? null, L.price_min_cents ?? null, L.reservation_url ?? null,
       L.fear, L.paranormal, L.isolation, L.darkness, L.difficulty, L.rating, L.ratings,
       Math.floor(L.ratings / 6), L.trending, L.safety_level, JSON.stringify(L.safety ?? {}), now(), now()]);

    const loc = get<any>('SELECT id FROM locations WHERE slug = ?', [slug])!;
    for (const c of L.cats) {
      const cat = get<any>('SELECT id FROM categories WHERE slug = ?', [c]);
      if (cat) run('INSERT OR IGNORE INTO location_categories (location_id, category_id) VALUES (?,?)', [loc.id, cat.id]);
    }
    // Location chat exists for every visitable location.
    if (L.access_policy !== 'private_closed' && !get('SELECT id FROM chats WHERE location_id = ?', [loc.id])) {
      run('INSERT INTO chats (id, kind, location_id, title, created_at) VALUES (?,?,?,?,?)', [id('cht'), 'location', loc.id, L.name, now()]);
    }
    if (L.data_source === 'verified') {
      run(`INSERT INTO business_profiles (id, location_id, legal_name, contact_email, claim_status, verified_at, created_at, updated_at)
           VALUES (?,?,?,?, 'verified', ?,?,?)`,
        [id('biz'), loc.id, `${L.name} (sample business record)`, 'ops@example.com', now(), now(), now()]);
    }
  }

  // events
  const evLoc = (slug: string) => get<any>('SELECT id FROM locations WHERE slug = ?', [slug])?.id;
  const evs: [string, string, string, number, string][] = [
    ['hollow-creek-haunted-woods', 'Blackout Night — no glow sticks', 'Lights-down run of the full trail. 18+ only.', 3, '$36'],
    ['ironwood-scream-park', 'Opening Weekend', 'All four attractions open, midway food vendors on site.', 6, '$39'],
    ['the-drover-hotel-paranormal-investigation', 'Fourth Floor Overnight', 'Guided 10pm–3am investigation, equipment provided.', 9, '$85'],
    ['cottonwood-hollow-campground', 'Group Campout — river sites', 'Community campout, reservable group loop.', 14, '$25'],
  ];
  for (const [slug, title, desc, days, price] of evs) {
    const lid = evLoc(slug);
    if (lid) run(`INSERT INTO events (id, location_id, title, description, starts_at, price_text, data_source, is_demo, created_at)
                  VALUES (?,?,?,?,?,?, 'verified', 1, ?)`, [id('evt'), lid, title, desc, plusDays(days), price, now()]);
  }

  // users
  for (const U of USERS) {
    if (get('SELECT id FROM users WHERE email = ?', [U.email])) continue;
    const uid = id('usr');
    run(`INSERT INTO users (id, email, password_hash, role, status, age_confirmed_at, age_attestation, tos_version, created_at, updated_at)
         VALUES (?,?,?, 'user', 'active', ?,?,?,?,?)`,
      [uid, U.email, hashPassword('DemoPass!2026'), now(), AGE_ATTESTATION, config.tosVersion, now(), now()]);
    run(`INSERT INTO profiles (user_id, username, display_name, avatar_emoji, bio, home_city, home_lat, home_lng, xp, level, favorite_categories, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, U.username, U.username, U.emoji, U.bio, U.city, U.lat, U.lng, U.xp,
       Math.max(1, Math.floor(Math.sqrt(U.xp / 20)) + 1), JSON.stringify(['haunted-attractions', 'camping', 'night-adventures']), now(), now()]);
    if (U.pro) {
      run(`INSERT INTO subscriptions (id, user_id, provider, provider_customer_id, provider_subscription_id, plan_id, status,
            cancel_at_period_end, current_period_start, current_period_end, created_at, updated_at)
           VALUES (?,?, 'mock', ?,?, 'pro_monthly', 'active', 0, ?,?,?,?)`,
        [id('sub'), uid, `mockcus_${uid}`, `mock_${uid}`, now(), plusDays(30), now(), now()]);
    }
    syncEntitlements(uid);
  }

  // admin + moderator
  for (const [email, username, role] of [['admin@thrillhunt.test', 'TH_ADMIN', 'admin'], ['mod@thrillhunt.test', 'TH_MOD', 'moderator']]) {
    if (get('SELECT id FROM users WHERE email = ?', [email])) continue;
    const uid = id('usr');
    run(`INSERT INTO users (id, email, password_hash, role, status, age_confirmed_at, age_attestation, tos_version, created_at, updated_at)
         VALUES (?,?,?,?, 'active', ?,?,?,?,?)`,
      [uid, email, hashPassword('AdminPass!2026'), role, now(), AGE_ATTESTATION, config.tosVersion, now(), now()]);
    run(`INSERT INTO profiles (user_id, username, display_name, avatar_emoji, bio, created_at, updated_at)
         VALUES (?,?,?, '🛡️', 'THRILLHUNT staff account.', ?,?)`, [uid, username, username, now(), now()]);
    syncEntitlements(uid);
  }

  // social activity
  const jake = get<any>(`SELECT user_id FROM profiles WHERE username = 'JAKETHEEXPLORER'`)!.user_id;
  const sarah = get<any>(`SELECT user_id FROM profiles WHERE username = 'sarah_nocturne'`)!.user_id;
  const mike = get<any>(`SELECT user_id FROM profiles WHERE username = 'mikeonthemap'`)!.user_id;
  const kate = get<any>(`SELECT user_id FROM profiles WHERE username = 'campfire_kate'`)!.user_id;
  const hollow = get<any>(`SELECT id FROM locations WHERE slug = 'hollow-creek-haunted-woods'`)!.id;
  const hollowChat = get<any>('SELECT id FROM chats WHERE location_id = ?', [hollow])!.id;

  const msgs: [string, string][] = [
    [mike, 'Anyone going Saturday? I have room for 3 coming from Council Bluffs.'],
    [sarah, 'Thinking about it. Is the back half of the trail as muddy as people say?'],
    [jake, "I'm coming from Omaha. Boots, not sneakers — learned that the hard way last year."],
    [sarah, 'Want to make a group? Easier than coordinating in here.'],
    [kate, "In. I'll camp at Cottonwood after so I'm not driving back at 2am."],
  ];
  let t = Date.now() - 36e5;
  for (const [uid, body] of msgs) {
    run('INSERT OR IGNORE INTO chat_members (chat_id, user_id, state, joined_at) VALUES (?,?,?,?)', [hollowChat, uid, 'active', now()]);
    run('INSERT INTO messages (id, chat_id, user_id, body, moderation_status, created_at) VALUES (?,?,?,?, \'approved\', ?)',
        [id('msg'), hollowChat, uid, body, new Date(t += 6e5).toISOString()]);
  }

  // attendance
  const sat = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const sun = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10);
  for (const [uid, date] of [[jake, sat], [sarah, sat], [mike, sat], [kate, sun]] as [string, string][]) {
    run(`INSERT OR IGNORE INTO attendance (id, location_id, user_id, status, going_date, visibility, created_at)
         VALUES (?,?,?, 'going', ?, 'public', ?)`, [id('att'), hollow, uid, date, now()]);
  }

  // a group with its chat
  if (!get(`SELECT id FROM groups WHERE name = 'Saturday Hollow Creek Crew'`)) {
    const gid = id('grp'), cid = id('cht');
    run(`INSERT INTO groups (id, name, description, location_id, planned_date, visibility, max_members, invite_code, created_by, created_at)
         VALUES (?,?,?,?,?, 'private', 8, 'HOLLOW42', ?, ?)`,
      [gid, 'Saturday Hollow Creek Crew', 'Meeting at the gravel lot at 7. Boots. Do not be the person in sneakers.', hollow, sat, jake, now()]);
    run('INSERT INTO chats (id, kind, group_id, title, created_at) VALUES (?,?,?,?,?)', [cid, 'group', gid, 'Saturday Hollow Creek Crew', now()]);
    for (const uid of [jake, sarah, mike]) {
      run('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)', [gid, uid, uid === jake ? 'owner' : 'member', now()]);
      run('INSERT INTO chat_members (chat_id, user_id, state, joined_at) VALUES (?,?,?,?)', [cid, uid, 'active', now()]);
    }
    run(`INSERT INTO messages (id, chat_id, user_id, body, moderation_status, created_at) VALUES (?,?,?,?, 'approved', ?)`,
        [id('msg'), cid, jake, 'Gravel lot, 7pm sharp. Tickets are timed so we cannot be late.', now()]);
  }

  // thrill reports + reviews
  const reports: [string, string, any][] = [
    [jake, 'hollow-creek-haunted-woods', { fear: 9, paranormal: 7, isolation: 8, darkness: 10, difficulty: 6, value: 8, overall: 9, would_return: 1, body: 'Act six is the one that gets people. The trail is genuinely dark between sets — bring boots, the back half was ankle-deep after Thursday rain. Staff kept everything tight and safe. Absolutely terrifying in the best way.' }],
    [kate, 'blackwater-ridge-primitive-camp', { fear: 4, paranormal: 6, isolation: 10, darkness: 9, difficulty: 5, value: 9, overall: 9, would_return: 1, body: 'Zero signal past the first ridge, which is the entire point. Pack water — there is none. Heard something big moving at 2am and have decided it was a deer.' }],
    [mike, 'the-drover-hotel-paranormal-investigation', { fear: 7, paranormal: 10, isolation: 3, darkness: 9, difficulty: 2, value: 8, overall: 9, would_return: 1, body: 'Skeptic here. Still cannot explain the fourth-floor audio. Guides were professional and never once suggested wandering off on our own.' }],
    [sarah, 'sandhills-dark-sky-overlook', { fear: 3, paranormal: 4, isolation: 9, darkness: 10, difficulty: 3, value: 10, overall: 10, would_return: 1, body: 'Best sky I have seen in this state. The rim is unfenced — stay back from the edge and bring more light than you think you need.' }],
  ];
  for (const [uid, slug, r] of reports) {
    const lid = get<any>('SELECT id FROM locations WHERE slug = ?', [slug])?.id;
    if (!lid) continue;
    run(`INSERT INTO thrill_reports (id, location_id, user_id, visited_on, fear, paranormal, isolation, darkness, difficulty, value, overall, would_return, body, moderation_status, like_count, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'approved', ?, ?)`,
      [id('trp'), lid, uid, new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10), r.fear, r.paranormal, r.isolation,
       r.darkness, r.difficulty, r.value, r.overall, r.would_return, r.body, Math.floor(Math.random() * 40) + 5, now()]);
    run(`INSERT INTO reviews (id, location_id, user_id, rating, body, moderation_status, created_at) VALUES (?,?,?,?,?, 'approved', ?)`,
      [id('rev'), lid, uid, Math.min(5, Math.round(r.overall / 2)), 'Worth the drive. Check the operator for current hours before you go.', now()]);
    run(`INSERT OR IGNORE INTO attendance (id, location_id, user_id, status, going_date, visibility, created_at)
         VALUES (?,?,?, 'completed', ?, 'public', ?)`, [id('att'), lid, uid, new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10), now()]);
  }

  // mystery drop (never points at restricted property)
  if (!get('SELECT id FROM mystery_drops WHERE ends_at > ?', [now()])) {
    const target = get<any>(`SELECT id FROM locations WHERE slug = 'blackwater-ridge-primitive-camp'`)!.id;
    run(`INSERT INTO mystery_drops (id, location_id, teaser, fear_flames, group_min, group_max, radius_miles, pro_only, starts_at, ends_at, created_at)
         VALUES (?,?,?,?,?,?,?,0,?,?,?)`,
      [id('drop'), target, "We've found something within 100 miles. No signal. No lights. No neighbours.", 5, 3, 6, 100, now(), plusHours(72), now()]);
  }
});

// default admin-editable config rows so the admin UI has something to show
setCfg('pro.plan', (await import('../src/config.ts')).CONFIG_DEFAULTS['pro.plan']);
setCfg('uploads.limits', (await import('../src/config.ts')).CONFIG_DEFAULTS['uploads.limits']);
setCfg('moderation.enforcement', (await import('../src/config.ts')).CONFIG_DEFAULTS['moderation.enforcement']);

console.log('✅ Seeded THRILLHUNT demo data');
console.log('   Demo users (password: DemoPass!2026):');
USERS.forEach((u) => console.log(`     ${u.email.padEnd(34)} @${u.username}${u.pro ? '  [PRO]' : '  [FREE]'}`));
console.log('   Admin: admin@thrillhunt.test / AdminPass!2026');
console.log('   Mod  : mod@thrillhunt.test   / AdminPass!2026');
