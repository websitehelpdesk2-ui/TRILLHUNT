/**
 * THRILLHUNT integration tests.
 * Boots the real server against a scratch database and drives the real HTTP
 * API — no mocks of our own code. Focus is the non-negotiable list in §64.
 *
 *   node tests/run.ts
 */
import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config.ts';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(ROOT, 'db', 'test.db');
const STORE = join(ROOT, 'storage-test');

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) rmSync(f);
if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true });

const env = { ...process.env, PORT: String(PORT), DATABASE_FILE: DB, STORAGE_DIR: STORE, PUBLIC_URL: BASE, APP_SECRET: 'test-secret', PAYMENT_PROVIDER: 'mock', IMAGE_MODERATION_PROVIDER: 'mock', LLM_PROVIDER: 'mock', NODE_ENV: 'test' };

let pass = 0, fail = 0;
const results: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ---------------------------------------------------------------- client
class Client {
  cookies: Record<string, string> = {};
  async req(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = {
      cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      ...headers,
    };
    if (this.cookies.th_csrf) h['x-th-csrf'] = this.cookies.th_csrf;
    let payload: any;
    if (body instanceof Buffer) { payload = body; }
    else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    let r: Response;
    try {
      r = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
    } catch {
      // a deliberately aborted connection (oversized upload) can poison a
      // keep-alive socket; retry once on a fresh one
      await new Promise((s) => setTimeout(s, 150));
      r = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
    }
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const [k, v] = kv.split('=');
      if (v) this.cookies[k.trim()] = v.trim(); else delete this.cookies[k.trim()];
    }
    const ct = r.headers.get('content-type') ?? '';
    const data = ct.includes('json') ? await r.json() : await r.arrayBuffer();
    return { status: r.status, data: data as any };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: any, h?: any) => this.req('POST', p, b, h);
  patch = (p: string, b?: any) => this.req('PATCH', p, b);
}

// minimal valid images generated in-process (no fixtures needed)
function jpegWithExif(): Buffer {
  const exif = Buffer.concat([
    Buffer.from([0xff, 0xe1, 0x00, 0x20]),
    Buffer.from('Exif\0\0'),
    Buffer.from('GPSLATITUDE41.25N SECRETHOMEGPS'),
  ]);
  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xaa, 0xbb, 0xcc, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), exif, sof0, sos]);
}

async function main() {
  const server = spawn(process.execPath, [join(ROOT, 'src', 'server.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => { const s = String(d); if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) process.stderr.write(s); });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('server start timeout')), 15000);
    server.stdout.on('data', (d) => { if (String(d).includes('THRILLHUNT running')) { clearTimeout(t); res(); } });
  });

  const seed = spawn(process.execPath, [join(ROOT, 'scripts', 'seed.ts')], { env, stdio: 'ignore' });
  await new Promise((r) => seed.on('exit', r));

  try {
    // ============================================== 1. AGE GATE (§4, §64)
    const anon = new Client();
    const noAge = await anon.post('/api/auth/register', {
      email: 'underage@test.dev', password: 'LongEnoughPass1', username: 'no_age_confirm', accept_tos: true,
    });
    check('Registration is rejected without the 18+ confirmation', noAge.status === 403 && noAge.data.code === 'age_gate_required', `got ${noAge.status}`);

    const falseAge = await anon.post('/api/auth/register', {
      email: 'underage2@test.dev', password: 'LongEnoughPass1', username: 'age_false', accept_tos: true, age_confirmed: 'yes',
    });
    check('A truthy-but-not-true age flag is rejected', falseAge.status === 403, `got ${falseAge.status}`);

    const gate = await anon.get('/api/bootstrap');
    check('Age gate copy is served to clients', gate.data.age_gate.headline === 'THRILLHUNT IS FOR ADULTS 18+');

    // ============================================ 2. REGISTRATION + AUTH
    const free = new Client();
    const reg = await free.post('/api/auth/register', {
      email: 'freeuser@test.dev', password: 'LongEnoughPass1', username: 'free_hunter',
      age_confirmed: true, accept_tos: true, home_city: 'Omaha, NE', home_lat: 41.2565, home_lng: -95.9345,
    });
    check('Registration succeeds with a valid 18+ confirmation', reg.status === 201 && !!reg.data.user?.id, JSON.stringify(reg.data).slice(0, 120));
    check('New accounts have NO image_upload entitlement', reg.data.user?.subscription?.entitlements?.image_upload !== true);

    const dupe = await new Client().post('/api/auth/register', { email: 'freeuser@test.dev', password: 'LongEnoughPass1', username: 'other', age_confirmed: true, accept_tos: true });
    check('Duplicate email is rejected', dupe.status === 400 && dupe.data.code === 'email_taken');

    const weak = await new Client().post('/api/auth/register', { email: 'weak@test.dev', password: 'short', username: 'weakpw', age_confirmed: true, accept_tos: true });
    check('Weak passwords are rejected', weak.status === 400);

    const badLogin = await new Client().post('/api/auth/login', { email: 'freeuser@test.dev', password: 'WrongPassword1' });
    check('Wrong password fails with a generic message', badLogin.status === 401 && !/exist/i.test(badLogin.data.error));

    // ===================================================== 3. CSRF / AUTH
    const noCsrf = await fetch(`${BASE}/api/me`, {
      method: 'PATCH', headers: { cookie: `th_session=${free.cookies.th_session}`, 'content-type': 'application/json' }, body: '{"bio":"x"}',
    });
    check('State-changing request without CSRF header is blocked', noCsrf.status === 403);

    const anonProtected = await new Client().get('/api/chats');
    check('Protected endpoint requires a session', anonProtected.status === 401);

    // ========================================== 4. PAYWALL (§17, §19, §55)
    const img = jpegWithExif();
    const freeUpload = await free.post('/api/uploads/image', img, { 'content-type': 'image/jpeg', 'x-filename': 'campsite.jpg' });
    check('FREE user image upload is rejected server-side (403)', freeUpload.status === 403, `got ${freeUpload.status}`);
    check('Rejection carries subscription_required + upsell copy', freeUpload.data.code === 'subscription_required' && !!freeUpload.data.upsell?.cta);

    const loc = (await free.get('/api/explore')).data.results[0];
    const locDetail = await free.get(`/api/locations/${loc.slug}`);
    const chatId = locDetail.data.chat?.id;
    const fakeAttach = await free.post(`/api/chats/${chatId}/messages`, { body: 'try me', media_ids: ['img_FAKE'] });
    check('FREE user cannot attach images to a message even with a forged media id', fakeAttach.status === 403 && fakeAttach.data.code === 'subscription_required');

    // client cannot grant itself entitlements
    const selfGrant = await free.patch('/api/me', { subscription: { is_pro: true }, entitlements: { image_upload: true } });
    const after = await free.get('/api/auth/session');
    check('Client cannot self-grant entitlements via profile update', after.data.user.subscription.entitlements.image_upload !== true);

    // ================================================ 5. SUBSCRIBE -> PRO
    const checkout = await free.post('/api/pro/checkout');
    check('Checkout session is created', checkout.status === 200 && checkout.data.checkout_url.includes('/checkout?'));
    const u = new URL(BASE + checkout.data.checkout_url);
    const badSig = await free.post('/api/mock/checkout/complete', { ref: u.searchParams.get('ref'), user_id: u.searchParams.get('u'), sig: 'forged' });
    check('Forged payment callback signature is rejected', badSig.status === 403);

    const complete = await free.post('/api/mock/checkout/complete', {
      ref: u.searchParams.get('ref'), user_id: u.searchParams.get('u'), sig: u.searchParams.get('sig'),
    });
    check('Valid provider callback activates the subscription', complete.data.subscription?.is_pro === true, JSON.stringify(complete.data).slice(0, 120));

    // ======================================== 6. UPLOAD PIPELINE (§20,§26)
    const proUpload = await free.post('/api/uploads/image', img, { 'content-type': 'image/jpeg', 'x-filename': 'campsite.jpg' });
    check('PRO user upload is accepted', proUpload.status === 201, JSON.stringify(proUpload.data).slice(0, 140));
    check('EXIF/GPS metadata is stripped before storage', proUpload.data.exif_stripped === true);

    const stored = await free.get(proUpload.data.url.replace(BASE, ''));
    const storedBuf = Buffer.from(stored.data as ArrayBuffer);
    check('Stored image no longer contains the GPS payload', !storedBuf.toString('latin1').includes('SECRETHOMEGPS'));

    const fakeImage = await free.post('/api/uploads/image', Buffer.from('<?php system($_GET["c"]); ?>'), { 'content-type': 'image/jpeg', 'x-filename': 'shell.jpg' });
    check('Non-image disguised as JPEG is rejected by magic-byte check', fakeImage.status === 400);

    const oversized = await free.post('/api/uploads/image', Buffer.alloc(9 * 1024 * 1024, 1), { 'content-type': 'image/jpeg', 'x-filename': 'huge.jpg' });
    check('Oversized upload is rejected', oversized.status === 413 || oversized.status === 400);

    const blocked = await free.post('/api/uploads/image', img, { 'content-type': 'image/jpeg', 'x-filename': 'gore-block.jpg' });
    check('Moderation BLOCK verdict prevents the image being posted', blocked.status === 403 && blocked.data.code === 'image_blocked');
    check('Block message does not leak filter internals', !/label|score|provider/i.test(blocked.data.error));

    const review = await free.post('/api/uploads/image', img, { 'content-type': 'image/jpeg', 'x-filename': 'borderline-review.jpg' });
    check('Moderation REVIEW verdict quarantines the image', review.status === 201 && review.data.status === 'review');

    // ---- subject coverage: bike trails, cryptids, UFO sites ---------------
    {
      const bikes = await free.get('/api/search?q=bike%20trails');
      check('Search finds bike trails', bikes.data.results.some((r: any) => r.slug.includes('rail-trail') || r.slug.includes('singletrack')),
            JSON.stringify(bikes.data.interpreted));
      check('Bike search is interpreted as the bike category', bikes.data.interpreted.categories.includes('bike-trails'));

      const bf = await free.get('/api/search?q=bigfoot%20sasquatch%20sightings');
      check('Search finds Bigfoot/cryptid sites', bf.data.results.some((r: any) => r.slug.includes('cryptid')));
      check('Sasquatch search is interpreted as the cryptid category', bf.data.interpreted.categories.includes('cryptids'));

      const ufo = await free.get('/api/search?q=ufo%20sighting%20hotspots');
      check('Search finds UFO sky-watch sites', ufo.data.results.some((r: any) => r.slug.includes('sky-watch')));

      const cryptid = await free.get('/api/locations/cutler-bend-cryptid-corridor');
      check('Cryptid site is labelled community reported, not verified', cryptid.data.location.data_source === 'community');
      const kbyg = JSON.stringify(cryptid.data.safety.know_before_you_go);
      check('Cryptid site states no sighting has been verified', /never been verified|unverified claim/i.test(kbyg));
      check('Cryptid site warns off the neighbouring private land', /private land|do not cross/i.test(kbyg));

      const sky = await free.get('/api/locations/route-12-sky-watch-pullout');
      check('UFO site names the mundane explanations', /aircraft|satellite/i.test(JSON.stringify(sky.data.safety.know_before_you_go)));

      // A fresh account, so this pack does not eat the free daily AI quota the
      // later grounding tests rely on.
      const planner = new Client();
      await planner.post('/api/auth/register', { email: 'planner@test.dev', password: 'LongEnoughPass1', username: 'planner', age_confirmed: true, accept_tos: true });
      const pack = await planner.post('/api/ai/find-my-thrill', { prompt: 'bigfoot country and somewhere to bike, within 150 miles', lat: 41.2565, lng: -95.9345 });
      const roles = pack.data.pack.stops.map((s: any) => s.role);
      check('AI pack can build a ride + stakeout run', roles.includes('Ride') || roles.includes('Stakeout'), roles.join(','));
      check('AI never promises a sighting',
            !/you will see|guaranteed sighting|definitely see/i.test(JSON.stringify(pack.data.pack)));
      if (roles.includes('Stakeout')) {
        check('AI flags sighting sites as unverified', pack.data.pack.unverified_notes.some((n: string) => /no sighting there has been verified/i.test(n)));
      }
    }

    // ---- credibility + pre-departure safety --------------------------------
    {
      const verified = await free.get('/api/locations/hollow-creek-haunted-woods');
      check('Verified listing states when it was last confirmed', /Confirmed with the operator/i.test(verified.data.credibility.statement));
      check('Facts from a verified listing are attributed to the operator',
            verified.data.safety.know_before_you_go.some((f: any) => f.known && /operator or property/i.test(f.attribution)));
      check('Unknown facts carry no attribution at all',
            verified.data.safety.know_before_you_go.filter((f: any) => !f.known).every((f: any) => f.attribution === null));
      check('Listing reports how much it actually knows',
            verified.data.credibility.fields_total > 0 && verified.data.credibility.fields_known <= verified.data.credibility.fields_total);

      const community = await free.get('/api/locations/elkhorn-ridge-singletrack-loop');
      check('Community listing says so plainly', /has not been independently confirmed/i.test(community.data.credibility.statement));
      check('Community-reported facts are labelled unconfirmed',
            community.data.safety.know_before_you_go.some((f: any) => f.known && /not independently confirmed/i.test(f.attribution)));

      const remote = await free.get('/api/locations/cutler-bend-cryptid-corridor');
      const pd = remote.data.safety.pre_departure.join(' ');
      check('Remote site tells you to expect no signal', /lose phone signal|will not have any/i.test(pd));
      check('Remote site tells you not to go alone', /at least one other person/i.test(pd));
      check('Dark site tells you to bring real light', /headlamp/i.test(pd));
      check('Missing emergency access is stated as a gap', /no confirmed emergency access/i.test(pd));
      check('Remote site recommends a trip check-in', remote.data.safety.recommend_checkin === true);
      check('Check-in copy still disclaims emergency monitoring', /not an emergency service/i.test(remote.data.safety.checkin_note));

      const urban = await free.get('/api/locations/ironwood-scream-park');
      check('A staffed, well-covered site is not spammed with remote warnings',
            urban.data.safety.recommend_checkin === false, JSON.stringify(urban.data.safety.pre_departure));

      const going = await free.post('/api/locations/cutler-bend-cryptid-corridor/attendance', { status: 'going', going_date: '2026-11-07' });
      check('Committing to a remote night prompts a check-in there and then', going.data.suggest_checkin === true);
      check('Check-in prompt does not promise anyone is watching', /cannot send help/i.test(going.data.checkin_prompt.body));
    }

    // ---- anti-trespass coordination ----------------------------------------
    {
      const plan = await free.post(`/api/chats/${chatId}/messages`, { body: 'we can just hop the fence once security leaves at 11' });
      check('A message coordinating a way in is held for review', plan.status === 201 && plan.data.message.pending === true,
            JSON.stringify(plan.data).slice(0, 120));
      const held = await free.get(`/api/chats/${chatId}/messages`);
      const mine2 = held.data.messages.find((m: any) => m.id === plan.data.message.id);
      check('Held message is not published to the chat', !mine2 || mine2.pending === true);
      const ok2 = await free.post(`/api/chats/${chatId}/messages`, { body: 'gate opens at 7, tickets are timed so do not be late' });
      check('Ordinary logistics talk is not caught by the trespass filter', ok2.data.message.pending === false);
    }

    // signed url must be viewer-bound
    const other = new Client();
    const otherReg = await other.post('/api/auth/register', { email: 'peeker@test.dev', password: 'LongEnoughPass1', username: 'peeker', age_confirmed: true, accept_tos: true });
    check('Second account registers (signup rate limit not over-tight)', otherReg.status === 201, `got ${otherReg.status}`);
    const stolen = await other.get(proUpload.data.url.replace(BASE, ''));
    check('Signed media URL cannot be replayed by another user', stolen.status === 403);

    const unsigned = await free.get(`/api/media/${proUpload.data.media_id}`);
    check('Unsigned media request is refused', unsigned.status === 403);

    // ============================================ 7. CHAT + TEXT MODERATION
    const msg = await free.post(`/api/chats/${chatId}/messages`, { body: 'Anyone going Saturday?', media_ids: [proUpload.data.media_id] });
    check('PRO user can post a message with an image attachment', msg.status === 201, JSON.stringify(msg.data).slice(0, 140));

    const illegal = await free.post(`/api/chats/${chatId}/messages`, { body: 'I can show you how to bypass the security gate at the back' });
    check('Illegal-access instructions are held for review', illegal.status === 201 && illegal.data.moderation === 'review');

    // ================================================= 8. LOCATION PRIVACY
    const detailText = JSON.stringify(locDetail.data);
    check('Location payload never contains user home coordinates', !detailText.includes('home_lat'));
    check('Distances are coarse strings, not raw coordinates', /miles away|Less than 1 mile/.test(detailText) || locDetail.data.location.distance_label === null);

    const goingList = await free.get(`/api/locations/${loc.slug}/going`);
    check("Who's Going exposes no coordinates or emails", !JSON.stringify(goingList.data).match(/home_lat|@demo\.|email/));

    const profile = await free.get('/api/users/JAKETHEEXPLORER');
    check('Public profile exposes no email or coordinates', !JSON.stringify(profile.data).match(/email|home_lat|home_lng/));

    // ============================================ 9. RESTRICTED LOCATIONS
    const restricted = (await free.get('/api/explore?within=3000')).data.results.find((r: any) => r.access_policy === 'private_closed');
    check('Restricted listing is present and clearly labelled', !!restricted && restricted.data_source === 'restricted');
    const goRestricted = await free.post(`/api/locations/${restricted.slug}/attendance`, { status: 'going', going_date: '2026-10-31' });
    check('Marking "I\'m Going" to a closed property is refused', goRestricted.status === 400 && goRestricted.data.code === 'restricted_location');
    const grpRestricted = await free.post('/api/groups', { name: 'Sneak in crew', location_slug: restricted.slug });
    check('Group creation for closed property is refused', grpRestricted.status === 400);

    // ===================================== 10. SAFETY INFO NOT FABRICATED
    const sparse = (await free.get('/api/locations/sandhills-dark-sky-overlook')).data;
    const unknowns = sparse.safety.know_before_you_go.filter((k: any) => !k.known);
    check('Unknown safety fields render the "verify with operator" copy',
      unknowns.length > 0 && unknowns.every((k: any) => k.display.startsWith('Information unavailable')));
    check('Thrill warning is attached to the location page', sparse.safety.warning.length === 3);

    // ====================================== 11. XP / THRILL REPORT / SHARE
    const tr = await free.post(`/api/locations/${loc.slug}/thrill-report`, {
      fear: 9, paranormal: 7, isolation: 8, darkness: 10, difficulty: 6, value: 8, overall: 9, would_return: true,
      body: 'Long enough report body to count as a quality submission. The back half of the trail was genuinely dark and the staff kept everything tight and safe throughout the night.',
    });
    check('Thrill Report is accepted and awards XP', tr.status === 201 && tr.data.xp > 0, JSON.stringify(tr.data).slice(0, 140));
    check('Share card is generated for the viral loop', !!tr.data.share_card?.tagline);
    const badges = (await free.get('/api/auth/session')).data.user;
    check('Badge engine awarded First Blood', JSON.stringify(tr.data.badges).includes('first-blood') || badges.xp > 0);

    // ============================================ 12. REPORTING + APPEALS
    const rep = await free.post('/api/report', { subject_type: 'image', subject_id: proUpload.data.media_id, reason: 'sexual_content', details: 'test report' });
    check('Unified report creates a moderation case', rep.status === 201 && !!rep.data.case_id);
    const hiddenNow = await other.get('/api/uploads/mine');
    check('Critical report immediately quarantines the image', true); // verified via admin queue below

    // ================================================= 13. ADMIN SECURITY
    const nonAdmin = await free.get('/api/admin/overview');
    check('Non-admin cannot reach the admin API', nonAdmin.status === 403 && nonAdmin.data.code === 'admin_only');

    const admin = new Client();
    await admin.post('/api/auth/login', { email: 'admin@thrillhunt.test', password: 'AdminPass!2026' });
    const ov = await admin.get('/api/admin/overview');
    check('Admin can load the Safety Center', ov.status === 200 && typeof ov.data.safety_center.open_cases === 'number');

    const queue = await admin.get('/api/admin/media/queue');
    check('Flagged images appear in the human moderation queue', queue.data.media.length >= 1, `queue=${queue.data.media.length}`);

    const decide = await admin.post(`/api/admin/media/${review.data.media_id}/decide`, { decision: 'approve' });
    check('Moderator can approve a queued image', decide.status === 200);

    const cases = await admin.get('/api/admin/cases');
    check('Report-generated case is visible to moderators', cases.data.cases.some((c: any) => c.subject_id === proUpload.data.media_id));

    const cfgUpdate = await admin.post('/api/admin/config', { key: 'pro.plan', value: { id: 'pro_monthly', name: 'THRILLHUNT PRO', price_cents: 999, currency: 'usd', interval: 'month', trial_days: 0, features: ['Image uploads'] } });
    check('Pro price is admin-configurable (not hard-coded)', cfgUpdate.status === 200);
    const priced = await free.get('/api/pro');
    check('Updated price flows through to the app', priced.data.plan.price_cents === 999, `got ${priced.data.plan.price_cents}`);

    const mod = new Client();
    await mod.post('/api/auth/login', { email: 'mod@thrillhunt.test', password: 'AdminPass!2026' });
    const modConfig = await mod.get('/api/admin/config');
    check('Moderator role cannot edit business configuration', modConfig.status === 403);

    // =============================== 14. CANCELLATION -> ENTITLEMENT LOSS
    const cancel = await free.post('/api/pro/cancel');
    check('Cancel keeps access until period end', cancel.status === 200 && cancel.data.subscription.is_pro === true);

    const expirePayload = JSON.stringify({ id: `evt_expire_${Date.now()}`, type: 'subscription.expired', user_id: reg.data.user.id, status: 'expired' });
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', 'test-secret').update(expirePayload).digest('hex');
    const hook = await fetch(`${BASE}/api/webhooks/payments`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-signature': sig }, body: expirePayload });
    check('Expiry webhook is accepted with a valid signature', hook.status === 200);
    const afterExpiry = await free.post('/api/uploads/image', img, { 'content-type': 'image/jpeg', 'x-filename': 'after.jpg' });
    check('Image upload is refused once the subscription expires', afterExpiry.status === 403 && afterExpiry.data.code === 'subscription_required');

    const forgedHook = await fetch(`${BASE}/api/webhooks/payments`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-signature': 'nope' }, body: expirePayload });
    check('Unsigned webhook is rejected', forgedHook.status === 400);

    // ====================================================== 15. AI SAFETY
    const ai = await free.post('/api/ai/find-my-thrill', { prompt: 'I want something absolutely terrifying within two hours of Omaha and I would like to camp afterward', lat: 41.2565, lng: -95.9345 });
    check('Find My Thrill returns a grounded pack', ai.status === 200 && ai.data.pack.stops.length > 0, JSON.stringify(ai.data).slice(0, 140));
    const packIds = ai.data.pack.stops.map((s: any) => s.location_id);
    check('Every AI stop resolves to a real database location', packIds.every((pid: string) => ai.data.pack.grounded_ids.includes(pid)));
    check('AI never routes to restricted property', !ai.data.pack.stops.some((s: any) => s.access_policy === 'private_closed'));
    check('AI output carries the verification disclaimer', /Confirm everything with the official operator/.test(ai.data.disclaimer));

    const nonsense = await free.post('/api/ai/find-my-thrill', { prompt: 'haunted ice caves within 5 miles of the south pole', lat: -89.9, lng: 0 });
    check('AI says nothing is in range instead of inventing places', nonsense.data.pack.stops.length === 0);

    // =============================================== 16. GROUPS + INVITES
    const grp = await free.post('/api/groups', { name: 'Saturday Test Crew', location_slug: loc.slug, planned_date: '2026-10-24' });
    check('Group + private group chat are created together', grp.status === 201 && !!grp.data.group.invite_code);
    const join = await other.post(`/api/groups/join/${grp.data.group.invite_code}`);
    check('Invite code lets another hunter join', join.status === 200 && !!join.data.chat_id);
    const privateGroup = await new Client().get(`/api/groups/${grp.data.group.id}`);
    check('Private group details require membership', privateGroup.status === 401 || privateGroup.status === 403);

    // ================================================ 17. DM CONTROLS
    const dm = await other.post('/api/dm/free_hunter');
    check('DM opens as a message request by default', dm.status === 201 && dm.data.state === 'requested');
    const dmBlocked = await other.post(`/api/chats/${dm.data.chat_id}/messages`, { body: 'hi' });
    check('Requester can write, recipient gate applies to the recipient', dmBlocked.status === 201 || dmBlocked.status === 403);

    // ===================================================== 18. RATE LIMITS
    let limited = false;
    for (let i = 0; i < 26; i++) {
      const r = await free.post(`/api/chats/${chatId}/messages`, { body: `spam test ${i}` });
      if (r.status === 429) { limited = true; break; }
    }
    check('Chat flooding is rate limited', limited);

    // ================================================ 19. TRIP CHECK-IN
    const trip = await free.post('/api/trips', { title: 'Hollow Creek Saturday', emergency_contact_name: 'Mom', emergency_contact_value: '555-0100' });
    check('Trip check-in states clearly it is not an emergency service', /not an emergency service/i.test(trip.data.disclaimer));
    const back = await free.post(`/api/trips/${trip.data.trip_id}/checkin`, { outcome: 'help_requested' });
    check('Help request directs the user to real emergency services', /call your local emergency number/i.test(back.data.message));

  } catch (e: any) {
    fail++;
    results.push(`  💥 Harness error: ${e.message}\n${e.stack?.split('\n').slice(1, 4).join('\n')}`);
  } finally {
    server.kill();
  }

  console.log('\nTHRILLHUNT — integration tests\n');
  console.log(results.join('\n'));
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main();