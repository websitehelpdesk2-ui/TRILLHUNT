/**
 * FIND MY THRILL (§29)
 *
 * Anti-fabrication design: the model NEVER supplies facts. The server
 * retrieves a candidate set from our own database, passes only those rows, and
 * then *validates* the model's answer — any id not in the grounding set is
 * discarded. Hours, prices, addresses and safety text in the output are copied
 * from the database row, not from the model. If a field is unknown in the DB,
 * the pack says so rather than guessing.
 */
import { config } from '../config.ts';
import { all, get, cfg, run } from '../lib/db.ts';
import { milesBetween, coarseDistance } from '../lib/guard.ts';
import { id, now } from '../lib/util.ts';

export interface PackStop {
  location_id: string; name: string; slug: string; role: string; why: string;
  drive_minutes: number | null; distance_label: string;
  fear: number | null; isolation: number | null; difficulty: number | null;
  access_policy: string; data_source: string;
  hours: string; price: string; reservation_required: boolean; safety_level: string | null;
}
export interface ThrillPack {
  title: string; summary: string; stops: PackStop[]; itinerary: { time: string; label: string; detail: string }[];
  unverified_notes: string[]; provider: string; grounded_ids: string[];
}

const AVG_MPH = 48;

function candidates(opts: { lat: number | null; lng: number | null; radius: number; categories: string[]; maxPrice?: number | null }) {
  const rows = all<any>(
    `SELECT l.*, (SELECT group_concat(c.slug) FROM location_categories lc JOIN categories c ON c.id = lc.category_id WHERE lc.location_id = l.id) AS cat_slugs
       FROM locations l
      WHERE l.deleted_at IS NULL AND l.moderation_status = 'approved'
        AND l.access_policy != 'private_closed'`,
  );
  return rows
    .map((r) => {
      const miles = opts.lat != null && r.lat != null ? milesBetween(opts.lat, opts.lng!, r.lat, r.lng) : null;
      return { ...r, miles, cats: String(r.cat_slugs ?? '').split(',').filter(Boolean) };
    })
    .filter((r) => (r.miles == null ? true : r.miles <= opts.radius))
    .filter((r) => (opts.categories.length ? r.cats.some((c: string) => opts.categories.includes(c)) : true));
}

/** Keyword -> category intent. Deterministic, runs before any model call. */
function parseIntent(prompt: string) {
  const p = prompt.toLowerCase();
  const cats: string[] = [];
  const map: [RegExp, string][] = [
    [/haunt|scary|terrif|fright|horror/, 'haunted-attractions'],
    [/ghost|paranormal|paranorm|paran|spirit|paranormal/, 'paranormal'],
    [/camp|tent|campground|campfire/, 'camping'],
    [/hike|trail|hiking/, 'hiking'],
    [/night|after dark|midnight/, 'night-adventures'],
    [/road ?trip|drive/, 'road-trips'],
    [/remote|isolat|middle of nowhere|off.?grid/, 'remote-adventures'],
    [/halloween|october/, 'halloween-events'],
    [/adrenaline|zip|climb|extreme|rappel/, 'outdoor-adventures'],
    [/hidden|weird|unusual|odd/, 'hidden-gems'],
  ];
  for (const [re, slug] of map) if (re.test(p)) cats.push(slug);
  const hoursMatch = p.match(/(\d+)\s*(?:hour|hr)s?\b/);
  const milesMatch = p.match(/(\d+)\s*miles?/);
  const radius = milesMatch ? Number(milesMatch[1])
    : hoursMatch ? Number(hoursMatch[1]) * AVG_MPH
    : (cfg('discovery.defaults') as any).radius_miles;
  const wantsCamp = /camp/.test(p);
  const intensity = /absolutely terrifying|most terrifying|scariest|hardcore/.test(p) ? 'extreme'
    : /mild|easy|chill|beginner|light/.test(p) ? 'mild' : 'normal';
  return { cats, radius: Math.min(radius, (cfg('discovery.defaults') as any).max_radius_miles), wantsCamp, intensity };
}

function stopFrom(r: any, role: string, why: string): PackStop {
  const hours = r.hours_json ? summarizeHours(r.hours_json) : 'Hours unavailable — verify with the operator.';
  return {
    location_id: r.id, name: r.name, slug: r.slug, role, why,
    drive_minutes: r.miles == null ? null : Math.round((r.miles / AVG_MPH) * 60),
    distance_label: r.miles == null ? 'Distance unavailable' : coarseDistance(r.miles),
    fear: r.fear, isolation: r.isolation, difficulty: r.difficulty,
    access_policy: r.access_policy, data_source: r.data_source,
    hours,
    price: r.price_text ?? 'Price unavailable — verify with the operator.',
    reservation_required: ['reservation', 'permit', 'guided'].includes(r.access_policy),
    safety_level: r.safety_level ?? null,
  };
}

function summarizeHours(json: string) {
  try {
    const h = JSON.parse(json);
    if (h.note) return h.note;
    if (h.seasonal) return h.seasonal;
    return 'See official hours';
  } catch { return 'Hours unavailable — verify with the operator.'; }
}

/** Rule-based planner. Also the fallback whenever the LLM output fails validation. */
function buildPack(prompt: string, pool: any[], intent: ReturnType<typeof parseIntent>): ThrillPack {
  const byFear = [...pool].sort((a, b) => (b.fear ?? 0) - (a.fear ?? 0));
  const scare = byFear.find((r) => r.cats.includes('haunted-attractions') || r.cats.includes('horror-experiences') || r.cats.includes('paranormal')) ?? byFear[0];
  const camp = pool.filter((r) => r.cats.includes('camping')).sort((a, b) => (b.isolation ?? 0) - (a.isolation ?? 0))[0];
  const night = pool.filter((r) => r.cats.includes('night-adventures') || r.cats.includes('hiking'))
    .sort((a, b) => (a.difficulty ?? 9) - (b.difficulty ?? 9))[0];

  const stops: PackStop[] = [];
  if (scare) stops.push(stopFrom(scare, 'Main event', intent.intensity === 'extreme' ? 'Highest community fear rating in your radius.' : 'Strong fear rating with verified operator info.'));
  if (camp && (intent.wantsCamp || intent.cats.includes('camping'))) stops.push(stopFrom(camp, 'Basecamp', 'High isolation score for the after-party quiet.'));
  if (night) stops.push(stopFrom(night, 'Night leg', 'Manageable difficulty after dark with a group.'));

  const notes: string[] = [];
  for (const s of stops) {
    if (s.data_source !== 'verified') notes.push(`${s.name} is community-reported — confirm details before you commit.`);
    if (s.reservation_required) notes.push(`${s.name} requires a reservation or permit. Book it first.`);
    if (s.hours.includes('unavailable')) notes.push(`Hours for ${s.name} are not in our data. Check the official source.`);
  }

  const itinerary = stops.length
    ? [
        { time: '17:30', label: 'Roll out', detail: `Meet your group and start the drive${stops[0].drive_minutes ? ` (~${stops[0].drive_minutes} min)` : ''}.` },
        { time: '19:00', label: stops[0].name, detail: stops[0].why },
        { time: '21:30', label: 'Food', detail: 'Refuel locally — pick something open late near the route.' },
        ...(stops[1] ? [{ time: '23:00', label: `Basecamp — ${stops[1].name}`, detail: 'Set up while you still have energy. Confirm the reservation on arrival.' }] : []),
        ...(stops[2] ? [{ time: '00:30', label: `Night leg — ${stops[2].name}`, detail: 'Headlamps, buddy system, stay on marked trails.' }] : []),
        { time: '07:00', label: 'Sunrise breakfast', detail: 'Debrief, then file your Thrill Report for XP.' },
      ]
    : [];

  return {
    title: stops.length >= 3 ? 'THE 12-HOUR NIGHTMARE' : stops.length ? 'YOUR THRILL PACK' : 'NOTHING IN RANGE YET',
    summary: stops.length
      ? `${stops.length} stops inside ${Math.round(intent.radius)} miles, ordered so nobody is driving tired at 3am.`
      : 'We could not find experiences in our database that match those constraints. Widen the radius or change the category — we will not invent places to fill a gap.',
    stops, itinerary, unverified_notes: [...new Set(notes)],
    provider: 'rules', grounded_ids: pool.map((p) => p.id),
  };
}

/** Optional LLM pass: re-ranks and writes the narrative. Facts stay ours. */
async function llmRefine(prompt: string, pack: ThrillPack, pool: any[]): Promise<ThrillPack> {
  if (config.providers.llm !== 'anthropic' || !config.anthropic.apiKey) return pack;
  const menu = pool.slice(0, 40).map((r) => ({
    id: r.id, name: r.name, cats: r.cats, fear: r.fear, isolation: r.isolation,
    difficulty: r.difficulty, miles: r.miles == null ? null : Math.round(r.miles), access: r.access_policy, source: r.data_source,
  }));
  const system = [
    'You plan adventure itineraries for THRILLHUNT, an 18+ discovery app.',
    'You may ONLY reference locations from the provided CANDIDATES list, by id.',
    'Never invent locations, hours, prices, availability, addresses or safety information.',
    'Never suggest trespassing, entering closed/private/restricted property, evading security, ignoring signage, or any illegal or unsafe act.',
    'Return ONLY JSON: {"title":string,"summary":string,"picks":[{"id":string,"role":string,"why":string}]}',
  ].join(' ');
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.anthropic.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: config.anthropic.model, max_tokens: 1000, system,
        messages: [{ role: 'user', content: `REQUEST: ${prompt}\n\nCANDIDATES:\n${JSON.stringify(menu)}` }],
      }),
    });
    if (!r.ok) return pack;
    const data: any = await r.json();
    const text = (data.content ?? []).map((c: any) => c.text ?? '').join('\n').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    const allowed = new Map(pool.map((p) => [p.id, p]));
    // VALIDATION GATE: anything the model invented is dropped here.
    const picks = (parsed.picks ?? []).filter((p: any) => allowed.has(p.id)).slice(0, 4);
    if (!picks.length) return pack;
    const stops = picks.map((p: any) => stopFrom(allowed.get(p.id), String(p.role ?? 'Stop').slice(0, 40), String(p.why ?? '').slice(0, 200)));
    return { ...pack, title: String(parsed.title ?? pack.title).slice(0, 60), summary: String(parsed.summary ?? pack.summary).slice(0, 400), stops, provider: 'anthropic' };
  } catch { return pack; }
}

export async function findMyThrill(userId: string, prompt: string, lat: number | null, lng: number | null): Promise<ThrillPack> {
  const intent = parseIntent(prompt);
  const pool = candidates({ lat, lng, radius: intent.radius, categories: intent.cats });
  let pack = buildPack(prompt, pool, intent);
  pack = await llmRefine(prompt, pack, pool);
  run('INSERT INTO ai_recommendations (id, user_id, prompt, provider, result_json, location_ids, created_at) VALUES (?,?,?,?,?,?,?)',
      [id('rec'), userId, prompt.slice(0, 500), pack.provider, JSON.stringify(pack), JSON.stringify(pack.stops.map((s) => s.location_id)), now()]);
  return pack;
}

/** Home-screen personalization: same grounding rule, no model call needed. */
export function personalRecommendations(userId: string, lat: number | null, lng: number | null, limit = 6) {
  const prof = get<any>('SELECT favorite_categories FROM profiles WHERE user_id = ?', [userId]);
  let favs: string[] = [];
  try { favs = JSON.parse(prof?.favorite_categories ?? '[]'); } catch { /* none */ }
  const pool = candidates({ lat, lng, radius: (cfg('discovery.defaults') as any).max_radius_miles, categories: [] });
  const seen = new Set(all<any>('SELECT location_id FROM attendance WHERE user_id = ?', [userId]).map((r) => r.location_id));
  return pool
    .filter((r) => !seen.has(r.id))
    .map((r) => {
      const catBoost = r.cats.filter((c: string) => favs.includes(c)).length * 3;
      const near = r.miles == null ? 0 : Math.max(0, 3 - r.miles / 60);
      return { ...r, score: catBoost + near + (r.rating_avg ?? 0) + (r.trending_score ?? 0) / 40 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({
      ...r,
      reason: r.cats.some((c: string) => favs.includes(c)) ? 'Matches your favourite categories' : 'Popular with hunters near you',
    }));
}
