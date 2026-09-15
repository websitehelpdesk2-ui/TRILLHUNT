/**
 * Import real US recreation facilities from RIDB (Recreation Information
 * Database), the federal API behind Recreation.gov.
 *
 * Why this source: it is public, free, national, and legally clean to use.
 * Campgrounds, trailheads and facilities across NPS, USFS, BLM, USACE and the
 * Fish & Wildlife Service, with real coordinates, real addresses and real
 * reservation links. That is the cold-start problem solved for the camping and
 * outdoor half of THRILLHUNT — the haunted-attraction half still has to be
 * earned listing by listing.
 *
 * Get a free key: https://ridb.recreation.gov/profile  (Developer → API Key)
 *
 *   RIDB_API_KEY=xxxx node scripts/import-recreation-gov.ts --state=IA --dry-run
 *   RIDB_API_KEY=xxxx node scripts/import-recreation-gov.ts --state=IA,NE --limit=200
 *   RIDB_API_KEY=xxxx node scripts/import-recreation-gov.ts --all --limit=2000
 *
 * Flags:
 *   --state=XX[,YY]  restrict to states (recommended; --all is a lot of rows)
 *   --limit=N        stop after N imported facilities (default 500)
 *   --dry-run        show what would be written, touch nothing
 *   --all            no state filter
 *   --facilities-only  skip RecAreas (parks/forests/refuges); facilities only
 *   --purge-museums   delete previously-imported museums/visitor centers/offices, then exit
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not invent safety information. RIDB gives us names, coordinates,
 * addresses, phone numbers, reservation URLs and descriptions — so those are
 * what we store. Fear ratings, isolation, darkness, hazards, cell service and
 * emergency access are left NULL, which the app renders as "Information
 * unavailable. Verify directly with the official operator or property owner."
 * A plausible-looking guessed hazard note is worse than an honest blank.
 */

import { migrate, all, get, run, tx } from '../src/lib/db.ts';
import { id, now, slugify } from '../src/lib/util.ts';

const API = 'https://ridb.recreation.gov/api/v1';
const KEY = process.env.RIDB_API_KEY ?? '';

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a: string) => a.startsWith(`--${name}=`))?.split('=')[1];
const has = (name: string) => args.includes(`--${name}`);

const DRY = has('dry-run');
const LIMIT = Number(flag('limit') ?? 500);
const STATES = (flag('state') ?? '').split(',').map((s: string) => s.trim().toUpperCase()).filter(Boolean);
const ALL = has('all');
const SKIP_RECAREAS = has('facilities-only');
const PURGE = has('purge-museums');

/** Guards live in main(), not at module scope, so mapFacility stays importable by tests. */
function checkArgs() {
  if (!KEY) {
    console.error(`
  RIDB_API_KEY is not set.

  1. Sign in at https://ridb.recreation.gov/profile
  2. Copy your API key from the Developer section
  3. Re-run:  RIDB_API_KEY=your-key node scripts/import-recreation-gov.ts --state=IA --dry-run
`);
    process.exit(1);
  }
  if (!STATES.length && !ALL) {
    console.error('  Pass --state=IA,NE (recommended) or --all. Importing every facility in the country is ~30k rows.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------- schema
// External provenance columns, added idempotently so this script can run
// against a database created before it existed.
function ensureColumns() {
  const cols = all<any>(`PRAGMA table_info(locations)`).map((c: any) => c.name);
  if (!cols.includes('external_source')) run(`ALTER TABLE locations ADD COLUMN external_source TEXT`);
  if (!cols.includes('external_id')) run(`ALTER TABLE locations ADD COLUMN external_id TEXT`);
  run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_loc_external ON locations(external_source, external_id)
       WHERE external_source IS NOT NULL`);
}

// ---------------------------------------------------------------- fetching
async function ridb(path: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${API}${path}?${qs}`, { headers: { apikey: KEY, accept: 'application/json' } });
  if (res.status === 401) throw new Error('RIDB rejected the API key (401). Check RIDB_API_KEY.');
  if (res.status === 429) { await new Promise((r) => setTimeout(r, 5000)); return ridb(path, params); }
  if (!res.ok) throw new Error(`RIDB ${path} returned ${res.status}`);
  return res.json();
}

/**
 * Pages through a RIDB collection. Both /facilities and /recareas share the
 * same envelope, so one generator covers both.
 *
 * Facilities are the specific things — a campground, a trailhead, a boat ramp.
 * RecAreas are the containers — a national forest, a refuge, a park. Importing
 * both is what turns a thin map into a dense one, which is the whole point.
 */
async function* collection(path: '/facilities' | '/recareas') {
  const states = ALL ? [''] : STATES;
  for (const state of states) {
    let offset = 0;
    for (;;) {
      const page: any = await ridb(path, {
        limit: 50, offset, full: 'true', ...(state ? { state } : {}),
      });
      const rows: any[] = page?.RECDATA ?? [];
      if (!rows.length) break;
      for (const r of rows) yield r;
      offset += rows.length;
      if (offset >= (page?.METADATA?.RESULTS?.TOTAL_COUNT ?? 0)) break;
      await new Promise((r) => setTimeout(r, 250));   // be a polite client
    }
  }
}

// ---------------------------------------------------------------- mapping
/**
 * Which THRILLHUNT categories a RIDB record maps onto.
 *
 * RIDB tags each record with its own ACTIVITY list, which is far more reliable
 * than guessing from the name — so that comes first, and name matching is only
 * the fallback. Nothing here invents a haunted or paranormal tag: RIDB is a
 * recreation database and has no opinion on ghosts.
 */
const ACTIVITY_MAP: Array<[RegExp, string]> = [
  [/camping|campsite/i, 'camping'],
  [/hiking|trail/i, 'hiking'],
  [/biking|bicycl|cycling/i, 'bike-trails'],
  [/wildlife|scenic|photograph/i, 'outdoor-adventures'],
  [/climbing|caving|rappel/i, 'outdoor-adventures'],
  [/boating|paddl|kayak|canoe|raft/i, 'outdoor-adventures'],
  [/astronom|star|night sky/i, 'night-adventures'],
];

/**
 * RIDB's /facilities endpoint is not just campgrounds and trailheads — it also
 * carries visitor centers, museums, administrative offices, gift shops and
 * interpretive centers, because those are "facilities" too in federal-land
 * terms. None of that is what THRILLHUNT is for, and letting the category
 * fallback catch them (as the first version of this importer did) is how a
 * Mission museum ends up on a thrill-seeker's map next to a haunted asylum.
 *
 * So this is an inclusion list, not an exclusion list: a record has to earn a
 * THRILLHUNT category — through its activity tags or its name pattern — or it
 * is not imported at all. "Could not categorise it" now means "skip it",
 * never "call it outdoor-adventures and hope".
 */
const EXCLUDE_TYPE = /museum|visitor center|welcome center|interpretive center|nature center|headquarters|administrative|office|gift shop|store|concession|ranger station|permit office/i;
const EXCLUDE_NAME = /\bmuseum\b|\bvisitor center\b|\bheadquarters\b|\badministration\b|\bgift shop\b/i;

function categoriesFor(rec: any): string[] | null {
  const name = String(rec.FacilityName ?? rec.RecAreaName ?? '').toLowerCase();
  const type = String(rec.FacilityTypeDescr ?? '').toLowerCase();
  if (EXCLUDE_TYPE.test(type) || EXCLUDE_NAME.test(name)) return null;

  const cats: string[] = [];
  const activities: string[] = (rec.ACTIVITY ?? []).map((a: any) => String(a.ActivityName ?? ''));
  for (const activity of activities) {
    for (const [pattern, slug] of ACTIVITY_MAP) if (pattern.test(activity)) cats.push(slug);
  }

  if (/campground|camp\b/.test(name) || type.includes('campground')) cats.push('camping');
  if (/trail|trailhead/.test(name)) cats.push('hiking');
  if (/wilderness|backcountry|primitive|remote/.test(name)) cats.push('remote-adventures');
  if (/observator|dark sky|stargaz/.test(name)) cats.push('night-adventures');
  if (/cave|cavern/.test(name)) cats.push('hidden-gems');
  // A bare RecArea/Facility type with no other signal is still recreation
  // land — a national forest or refuge with no matched activity tag is worth
  // keeping. What we refuse is the fallback that swallowed everything.
  if (!cats.length && /recreation area|forest|refuge|wilderness|park|reservoir|lake/.test(name + ' ' + type)) {
    cats.push('outdoor-adventures');
  }

  return cats.length ? [...new Set(cats)] : null;
}

/**
 * RIDB → THRILLHUNT. Exported so the mapping can be unit-tested against a
 * fixture without hitting the network.
 */
export function mapFacility(f: any) {
  const addr = (f.FACILITYADDRESS ?? f.RECAREAADDRESS ?? [])[0] ?? {};
  const lat = Number(f.FacilityLatitude) || null;
  const lng = Number(f.FacilityLongitude) || null;
  if (!lat || !lng) return null;                       // no coordinates, no map pin, no import
  const name = String(f.FacilityName ?? '').trim();
  if (!name) return null;

  // Strip the HTML RIDB embeds in descriptions; keep it short.
  const raw = String(f.FacilityDescription ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const description = raw.length > 600 ? `${raw.slice(0, 597)}…` : raw || null;

  const reservable = String(f.Reservable) === 'true' || f.Reservable === true;
  const cats = categoriesFor(f);
  if (!cats) return null;   // museums, visitor centers, offices — not a THRILLHUNT category

  return {
    external_source: 'ridb',
    external_id: String(f.FacilityID),
    name,
    slug: `${slugify(name)}-${String(f.FacilityID)}`,   // FacilityID keeps slugs unique
    description,
    // Federal facility records are authoritative for what they cover.
    data_source: 'verified' as const,
    verification_status: 'verified' as const,
    access_policy: reservable ? ('reservation' as const) : ('open' as const),
    address_line: addr.FacilityStreetAddress1 ?? null,
    city: addr.City ?? addr.AddressCity ?? null,
    region: addr.AddressStateCode ?? addr.StateCode ?? null,
    postal_code: addr.PostalCode ?? addr.AddressPostalCode ?? null,
    lat, lng,
    address_precision: addr.FacilityStreetAddress1 ? ('exact' as const) : ('approximate' as const),
    website_url: f.FacilityDirectionsURL || null,
    phone: f.FacilityPhone || null,
    reservation_url: reservable ? `https://www.recreation.gov/camping/campgrounds/${f.FacilityID}` : null,
    price_text: null,          // RIDB fees live on a separate endpoint and vary by site
    categories: cats,
  };
}

/** RecAreas use different field names for the same things. Normalise, then reuse. */
export function mapRecArea(r: any) {
  return mapFacility({
    FacilityID: `rec-${r.RecAreaID}`,
    FacilityName: r.RecAreaName,
    FacilityDescription: r.RecAreaDescription,
    FacilityTypeDescr: 'Recreation Area',
    FacilityLatitude: r.RecAreaLatitude,
    FacilityLongitude: r.RecAreaLongitude,
    FacilityPhone: r.RecAreaPhone,
    FacilityDirectionsURL: r.RecAreaDirectionsURL,
    Reservable: false,
    FACILITYADDRESS: r.RECAREAADDRESS,
    ACTIVITY: r.ACTIVITY,
  });
}

// ---------------------------------------------------------------- writing
function upsert(rec: ReturnType<typeof mapFacility>) {
  if (!rec) return 'skipped';
  const existing = get<any>(
    'SELECT id FROM locations WHERE external_source = ? AND external_id = ?',
    [rec.external_source, rec.external_id],
  );
  const ts = now();

  if (existing) {
    run(`UPDATE locations SET name=?, description=?, address_line=?, city=?, region=?, postal_code=?,
         lat=?, lng=?, address_precision=?, website_url=?, phone=?, reservation_url=?,
         access_policy=?, verified_at=?, updated_at=? WHERE id=?`,
      [rec.name, rec.description, rec.address_line, rec.city, rec.region, rec.postal_code,
       rec.lat, rec.lng, rec.address_precision, rec.website_url, rec.phone, rec.reservation_url,
       rec.access_policy, ts, ts, existing.id]);
    return 'updated';
  }

  const locId = id('loc');
  run(`INSERT INTO locations (id, slug, name, description, data_source, verification_status, verified_at,
        is_demo, access_policy, address_line, city, region, postal_code, country, lat, lng,
        address_precision, website_url, phone, reservation_url, price_text,
        external_source, external_id, moderation_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?, 'US', ?,?,?,?,?,?,?,?,?, 'approved', ?,?)`,
    [locId, rec.slug, rec.name, rec.description, rec.data_source, rec.verification_status, ts,
     rec.access_policy, rec.address_line, rec.city, rec.region, rec.postal_code, rec.lat, rec.lng,
     rec.address_precision, rec.website_url, rec.phone, rec.reservation_url, rec.price_text,
     rec.external_source, rec.external_id, ts, ts]);

  for (const slug of rec.categories) {
    const cat = get<any>('SELECT id FROM categories WHERE slug = ?', [slug]);
    if (cat) run('INSERT OR IGNORE INTO location_categories (location_id, category_id) VALUES (?,?)', [locId, cat.id]);
  }
  return 'inserted';
}


/**
 * One-time cleanup for an earlier version of this importer that fell back to
 * `outdoor-adventures` for anything it could not categorise — which meant
 * museums, visitor centers and administrative offices got imported as thrill
 * destinations. This removes exactly those, and only records this importer
 * created (external_source = 'ridb'), never a user's own submission or a hand-
 * written listing that happens to share a name pattern.
 */
function purgeMuseums() {
  ensureColumns();
  const bad = /museum|visitor center|welcome center|interpretive center|nature center|headquarters|administrative|gift shop|concession|ranger station|permit office/i;
  const rows = all<any>(`SELECT id, name FROM locations WHERE external_source = 'ridb' AND deleted_at IS NULL`);
  const toRemove = rows.filter((r: any) => bad.test(r.name));
  console.log(`\n  Found ${toRemove.length} of ${rows.length} RIDB imports matching museum/office/visitor-center patterns.\n`);
  for (const r of toRemove) console.log(`  - ${r.name}`);
  if (!DRY) {
    for (const r of toRemove) run(`UPDATE locations SET deleted_at = ? WHERE id = ?`, [now(), r.id]);
    console.log(`\n  Removed. Nothing else was touched.\n`);
  } else {
    console.log(`\n  [DRY RUN] Nothing deleted. Re-run without --dry-run to remove these.\n`);
  }
}

// ---------------------------------------------------------------- main
async function main() {
  migrate();
  if (PURGE) { purgeMuseums(); return; }
  checkArgs();
  if (!DRY) ensureColumns();

  const counts = { inserted: 0, updated: 0, skipped: 0 };
  let seen = 0;

  console.log(`\n  Importing from RIDB${STATES.length ? ` — ${STATES.join(', ')}` : ' — all states'}${DRY ? '  [DRY RUN]' : ''}\n`);

  const sources: Array<['/facilities' | '/recareas', (row: any) => ReturnType<typeof mapFacility>]> =
    SKIP_RECAREAS ? [['/facilities', mapFacility]]
                  : [['/facilities', mapFacility], ['/recareas', mapRecArea]];

  outer:
  for (const [path, mapper] of sources) {
    for await (const f of collection(path)) {
      if (seen >= LIMIT) break outer;
      const rec = mapper(f);
      if (!rec) { counts.skipped++; continue; }
      seen++;

      if (DRY) {
        console.log(`  + ${rec.name}  (${[rec.city, rec.region].filter(Boolean).join(', ') || 'no address'})  [${rec.categories.join(', ')}]`);
        counts.inserted++;
        continue;
      }
      try {
        counts[upsert(rec) as 'inserted' | 'updated' | 'skipped']++;
      } catch (e) {
        counts.skipped++;
        console.warn(`  ! skipped ${rec.name}: ${(e as Error).message}`);
      }
    }
  }

  console.log(`\n  ${counts.inserted} inserted, ${counts.updated} updated, ${counts.skipped} skipped.`);
  console.log(`  Safety fields are intentionally empty — the app will show "Information unavailable"`);
  console.log(`  rather than a guess. Fill them in through the admin dashboard as they get confirmed.\n`);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) main().catch((e) => { console.error(`\n  Import failed: ${e.message}\n`); process.exit(1); });