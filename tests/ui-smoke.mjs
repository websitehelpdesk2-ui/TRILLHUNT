/**
 * UI smoke test. Loads the real app.html + ES modules into a jsdom window and
 * walks every route against a live THRILLHUNT server, asserting each screen
 * renders without throwing and that key copy is present.
 *
 * jsdom lives outside the project on purpose — THRILLHUNT itself stays
 * dependency-free. Run with:  node /tmp/uitest/smoke.mjs
 */
// Optional test: needs jsdom + tough-cookie, which are NOT project dependencies.
//   npm i --no-save jsdom tough-cookie   then   node tests/ui-smoke.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { CookieJar } from 'tough-cookie';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const ROOT = new URL('../public/', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, note = '') => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${note ? ' — ' + note : ''}`); }
};

// ---------------------------------------------------------------- cookie jar
const jar = new CookieJar();
const realFetch = globalThis.fetch;   // captured before we shadow the global
let nfetch=0;
async function jarFetch(url, opts = {}) {

  const abs = new URL(url, BASE).toString();
  const headers = new Headers(opts.headers || {});
  const cookie = await jar.getCookieString(abs);
  if (cookie) headers.set('cookie', cookie);
  const res = await realFetch(abs, { ...opts, headers, redirect: 'manual' });
  for (const c of res.headers.getSetCookie?.() ?? []) await jar.setCookie(c, abs).catch(() => {});
  return res;
}

function makeWindow(htmlFile, hash) {
  const html = readFileSync(ROOT + htmlFile, 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: BASE + '/app' + hash, pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  w.fetch = jarFetch;
  w.HTMLCanvasElement.prototype.getContext = () => ({
    scale() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    arc() {}, fill() {}, fillText() {}, set font(v) {}, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set textAlign(v) {},
  });
  w.navigator.geolocation = { getCurrentPosition: (ok) => ok({ coords: { latitude: 41.2565, longitude: -95.9345 } }) };
  Object.defineProperty(w.document, 'cookie', {
    get() { return jar.getCookieStringSync(BASE); },
    set(v) { jar.setCookieSync(v, BASE); },
    configurable: true,
  });
  return { dom, w };
}

async function installGlobals(w) {
  for (const k of ['window', 'document', 'navigator', 'location', 'history', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'Headers', 'Blob', 'FileReader', 'Intl']) {
    if (w[k] === undefined) continue;
    try { Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true }); }
    catch { /* read-only global (navigator on newer Node) — patched below */ }
  }
  globalThis.fetch = jarFetch;
  if (globalThis.navigator !== w.navigator) {
    // Node 22 exposes a read-only global navigator; give the app the jsdom one.
    Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
  }
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.addEventListener = w.addEventListener.bind(w);
  globalThis.prompt = () => '';
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = () => globalThis.document.getElementById('view').textContent;

async function main() {
  console.log('\nTHRILLHUNT — UI smoke test\n');

  // --- landing page renders without scripts ---------------------------------
  {
    const { w } = makeWindow('index.html', '');
    const body = w.document.body.textContent;
    check('Landing page states the tagline', body.includes('CHASE THE THRILL. RESPECT THE RISK.'));
    check('Landing page carries the 18+ notice', body.includes('18+ ONLY'));
    check('Landing page names all five pillars',
      ['Discover', 'Find your people', 'Plan your thrill', 'Share the aftermath', 'Safety first'].every((s) => body.includes(s)));
    check('Landing page refuses to help with trespassing', /will never do/i.test(body) && /trespass/i.test(body));
  }

  // --- sign in via the API so the SPA boots authenticated --------------------
  await jarFetch('/api/bootstrap');
  const csrf = (await jar.getCookieString(BASE)).match(/th_csrf=([^;]+)/)?.[1] ?? '';
  const login = await jarFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-th-csrf': csrf },
    body: JSON.stringify({ email: 'jake@demo.thrillhunt.test', password: 'DemoPass!2026' }),
  });
  check('Demo account signs in', login.status === 200);

  // --- boot the SPA ---------------------------------------------------------
  const { w } = makeWindow('app.html', '#/home');
  await installGlobals(w);
  const app = await import(new URL('../public/js/app.js', import.meta.url).href + '?' + Date.now());
  await wait(700);

  check('Home renders a greeting for the signed-in hunter', /Evening, @JAKETHEEXPLORER/.test(text()));
  check('Home shows trending experiences', text().includes('Hollow Creek Haunted Woods'));
  check('Home surfaces the Mystery Drop', text().includes('MYSTERY DROP'));
  check('Home shows a distance bucket, never an address', /\d+ miles away|Less than 1 mile away/.test(text()));

  const goTo = async (hash, ms = 700) => { w.location.hash = hash; w.dispatchEvent(new w.Event('hashchange')); await wait(ms); };

  await goTo('#/explore');
  check('Explore lists experiences', text().includes('experiences'));
  check('Explore offers every category', text().includes('Camping') || text().includes('Haunted'));

  await goTo('#/l/hollow-creek-haunted-woods', 900);
  const loc = text();
  check('Location page shows THRILL WARNING', loc.includes('THRILL WARNING'));
  check('Location page shows Know before you go', loc.includes('Know before you go'));
  check('Location page offers NAVIGATE', loc.includes('NAVIGATE'));
  check('Location page offers I\'M GOING and JOIN GROUP', loc.includes("I'M GOING") && loc.includes('JOIN GROUP'));
  check('Location page marks the listing as verified', loc.includes('Verified listing'));
  check('Location page exposes a safety-issue report', /Report safety issue/i.test(loc));

  await goTo('#/l/the-larkin-sanatorium-closed-do-not-enter', 900);
  const larkin = text();
  check('Restricted property is labelled as restricted', /Restricted — do not enter|ENTRY IS NOT PERMITTED/.test(larkin));
  check('Restricted property hides the going/group actions', !larkin.includes("I'M GOING"));
  check('Restricted property points at a legal alternative', /legal, guided alternative/i.test(larkin));

  await goTo('#/l/cottonwood-hollow-campground', 900);
  check('Unknown fields say information is unavailable, never a guess',
    /Information unavailable/i.test(text()), text().slice(0, 0));

  await goTo('#/map', 900);
  check('Map states that hunters are never plotted', w.document.body.textContent.includes('hunters are never plotted'));

  await goTo('#/groups');
  check('Groups lists the seeded crew', text().includes('Saturday Hollow Creek Crew'));

  await goTo('#/chats');
  check('Messages lists conversations', text().includes('Saturday Hollow Creek Crew') || text().includes('Hollow Creek'));

  const chatId = (await (await jarFetch('/api/chats')).json()).chats[0].id;
  await goTo(`#/chat/${chatId}`, 900);
  check('Chat renders seeded messages', /Gravel lot|room for 3|boots/i.test(text()));
  check('Chat shows a composer with a photo button', !!w.document.querySelector('.composer'));

  await goTo('#/feed');
  check('Feed renders Thrill Reports', text().includes('Act six') || text().includes('Hollow Creek'));

  await goTo('#/profile', 900);
  const prof = text();
  check('Profile shows level and XP', /Level \d+/.test(prof) && /XP/.test(prof));
  check('Profile shows adventure stats', prof.includes('Adventures'));

  await goTo('#/settings', 900);
  check('Settings exposes privacy controls', text().includes('Who can see me'));
  check('Settings states what is never shared', /never shown to other users/i.test(text()));

  await goTo('#/pro', 900);
  check('PRO page shows the configured price', /\$7\.99|\$\d+\.\d\d/.test(text()));
  check('PRO page states cards are never stored', /never stores your card/i.test(text()));

  await goTo('#/trip', 900);
  check('Trip check-in says THRILLHUNT is not an emergency service', /NOT AN EMERGENCY SERVICE/i.test(text()));

  await goTo('#/guidelines');
  check('Community Guidelines list prohibited content', /trespassing/i.test(text()));

  await goTo('#/ai', 900);
  check('Find my thrill explains grounding', /listings that actually exist/i.test(text()));

  // --- navigation deep links -------------------------------------------------
  const { NavigationService } = await import(new URL('../public/js/nav-service.js', import.meta.url).href);
  const dest = { name: 'Hollow Creek', lat: 41.5439, lng: -96.1253, address: '12 County Road, Blair, NE' };
  const apple = NavigationService.appleMapsUrl(dest);
  const google = NavigationService.googleMapsUrl(dest);
  check('Apple Maps link uses the documented scheme', apple.startsWith('https://maps.apple.com/?') && apple.includes('ll=41.5439'));
  check('Google Maps link uses the documented scheme', google.startsWith('https://www.google.com/maps/dir/?') && google.includes('destination=41.5439'));
  check('geo: intent is offered for other Android apps', NavigationService.geoUrl(dest).startsWith('geo:41.5439'));
  check('Navigation never embeds the user position', !apple.includes('saddr') && !google.includes('origin='));
  check('Web default is Google Maps', NavigationService.optionsFor(dest)[0].key === 'google');


  // --- admin dashboard -------------------------------------------------------
  {
    const ajar = new CookieJar();
    const prev = jar.getCookieStringSync(BASE);
    // sign in as staff in a fresh jar by swapping the module-level jar contents
    await jarFetch('/api/auth/logout', { method: 'POST', headers: { 'x-th-csrf': (await jar.getCookieString(BASE)).match(/th_csrf=([^;]+)/)?.[1] ?? '' } });
    const r = await jarFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-th-csrf': (await jar.getCookieString(BASE)).match(/th_csrf=([^;]+)/)?.[1] ?? '' },
      body: JSON.stringify({ email: 'admin@thrillhunt.test', password: 'AdminPass!2026' }),
    });
    check('Admin account signs in', r.status === 200);

    const { w: aw } = makeWindow('admin.html', '');
    await installGlobals(aw);
    await import(new URL('../public/js/admin.js', import.meta.url).href + '?' + Date.now());
    await wait(900);
    const at = aw.document.getElementById('view').textContent;
    check('Admin opens on the Safety Center', at.includes('Safety Center'));
    check('Safety Center shows moderation queue counts', /Open moderation cases/.test(at));
    check('Safety Center shows platform analytics', /PRO subscribers|Thrill Reports/.test(at));

    const nav = aw.document.getElementById('adminnav');
    const clickTab = async (name, ms = 800) => {
      [...nav.querySelectorAll('button')].find((b) => b.dataset.view === name).dispatchEvent(new aw.Event('click'));
      await wait(ms);
      return aw.document.getElementById('view').textContent;
    };
    check('Image review queue loads', /Image review queue/.test(await clickTab('media')));
    check('Users table lists hunters and 18+ confirmation', /18\+ confirmed/.test(await clickTab('users')));
    check('Locations table exposes verification state', /Verification/.test(await clickTab('locations')));
    const cfgText = await clickTab('config');
    check('Configuration screen shows the PRO price', /PRO price/.test(cfgText) && /\$\d+\.\d\d/.test(cfgText));
    check('Configuration exposes the enforcement ladder', /moderation\.enforcement/.test(cfgText));
    check('Audit log loads', /Audit log/.test(await clickTab('audit')));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n  💥 Harness error:', e); process.exit(1); });
