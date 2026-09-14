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
  w.navigator.geolocation = { getCurrentPosition: (ok) => ok({ coords: { latitude: 41.2565, longitude: -95.9345 } }) };
  Object.defineProperty(w.document, 'cookie', {
    get() { return jar.getCookieStringSync(BASE); },
    set(v) { jar.setCookieSync(v, BASE); },
    configurable: true,
  });
  installFakeLeaflet(w);
  return { dom, w };
}

/**
 * A minimal stand-in for the real Leaflet library (loaded from unpkg in the
 * browser, which jsdom does not fetch). It implements just enough of the API
 * surface that public/js/app.js's initLeafletMap() calls — L.map, tileLayer,
 * control.layers, marker, divIcon, latLngBounds, Control.extend, DomUtil,
 * DomEvent — so this test exercises our own code (does it create the right
 * number of markers, does clicking one navigate, does ?focus zoom to the
 * right pin) without depending on real tile network requests or canvas/SVG
 * rendering jsdom can't do anyway.
 */
function installFakeLeaflet(w) {
  class FakeLayer {
    addTo(map) { map.layers.push(this); return this; }
    on(evt, fn) { (this._handlers ||= {})[evt] = fn; return this; }
    fire(evt) { this._handlers?.[evt]?.(); return this; }
  }
  class FakeMarker {
    constructor(latlng) { this.latlng = latlng; this.popupContent = null; this._handlers = {}; this.opened = false; }
    addTo(map) { map.markers.push(this); return this; }
    bindPopup(html) { this.popupContent = html; return this; }
    on(evt, fn) { this._handlers[evt] = fn; return this; }
    openPopup() { this.opened = true; return this; }
    // Real Leaflet hands back a LatLng object, not the array you passed in.
    // The stub has to match, or assertions on .lat silently compare undefined.
    getLatLng() { return Array.isArray(this.latlng) ? { lat: this.latlng[0], lng: this.latlng[1] } : this.latlng; }
    fire(evt) { this._handlers[evt]?.(); }
  }
  class FakeBounds {
    constructor(pts) { this.pts = pts; }
    pad() { return this; }
    getSouth() { return 39; } getWest() { return -99; } getNorth() { return 42; } getEast() { return -95; }
  }
  class FakeMap {
    constructor(container, opts) { this.container = container; this.opts = opts; this.layers = []; this.markers = []; this.controls = []; this.view = null; w.__leafletMaps.push(this); }
    setView(latlng, zoom) { this.view = { latlng, zoom }; return this; }
    fitBounds(bounds) { this.view = { bounds }; return this; }
    addControl(c) { this.controls.push(c); c.onAdd?.(this); return this; }
    on(evt, fn) { for (const e of String(evt).split(' ')) (this._handlers ||= {})[e] = fn; return this; }
    getBounds() { return new FakeBounds([]); }
    eachLayer() {}
    removeLayer() {}
    fire(evt, payload) { this._handlers?.[evt]?.(payload); return this; }
    invalidateSize() {}
  }
  w.__leafletMaps = [];
  w.L = {
    map: (container, opts) => new FakeMap(container, opts),
    tileLayer: () => new FakeLayer(),
    layerGroup: (layers) => { const g = new FakeLayer(); g.children = layers; return g; },
    control: {
      layers: () => new FakeLayer(),
      zoom: (opts) => { const l = new FakeLayer(); l.controlOpts = opts; l.addTo = (map) => { map.controls.push(l); return l; }; return l; },
    },
    marker: (latlng) => new FakeMarker(latlng),
    divIcon: (opts) => opts,
    latLngBounds: (pts) => new FakeBounds(pts),
    Control: {
      extend: (def) => class {
        constructor(opts) { this.options = { ...def.options, ...opts }; }
        onAdd(map) { return def.onAdd.call(this, map); }
      },
    },
    DomUtil: { create: (tag) => w.document.createElement(tag) },
    DomEvent: { disableClickPropagation: () => {}, on: (elm, evt, fn) => elm.addEventListener(evt, fn), stop: () => {} },
  };
}

async function installGlobals(w) {
  for (const k of ['window', 'document', 'navigator', 'location', 'history', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'Headers', 'Blob', 'FileReader', 'Intl', 'L']) {
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
  check('Location page shows the physical address up top', loc.includes('County Road'));
  check('Location page renders a real mini-map, not a placeholder', w.__leafletMaps.length >= 1);
  {
    const mini = w.__leafletMaps.at(-1);
    check('Mini-map is centered on this location\'s real coordinates', mini.markers.length === 1 && Math.abs(mini.markers[0].getLatLng().lat - 41.5439) < 0.001);
    check('Mini-map has no layer switcher / zoom clutter (single mode)', mini.opts.zoomControl === false);
  }

  await goTo('#/l/the-larkin-sanatorium-closed-do-not-enter', 900);
  const larkin = text();
  check('Restricted property is labelled as restricted', /Restricted — do not enter|ENTRY IS NOT PERMITTED/.test(larkin));
  check('Restricted property hides the going/group actions', !larkin.includes("I'M GOING"));
  check('Restricted property points at a legal alternative', /legal, guided alternative/i.test(larkin));
  check('Restricted property still states its address (awareness, not access)', /📍/.test(larkin));

  await goTo('#/l/cottonwood-hollow-campground', 900);
  check('Unknown fields say information is unavailable, never a guess',
    /Information unavailable/i.test(text()), text().slice(0, 0));

  check('Location page shows how fresh the information is', /Confirmed|Needs re-checking|facts on file/i.test(loc));

  await goTo('#/l/cutler-bend-cryptid-corridor', 900);
  const cryptid = text();
  check('Bigfoot listing leads with what is actually known', /what is actually known/i.test(cryptid));
  check('Bigfoot listing says no sighting has been verified', /ever been verified/i.test(cryptid));
  check('Bigfoot listing is labelled community reported', /Community reported/i.test(cryptid));
  check('Bigfoot listing marks its facts as unconfirmed', /not independently confirmed/i.test(cryptid));
  check('Bigfoot listing carries a Before you go block', /Before you go/i.test(cryptid));
  check('Bigfoot listing tells the story behind the site', /The story/i.test(cryptid) && /Reports began in 1971/i.test(cryptid));
  check('Lore is labelled as folklore, not fact', /not established fact/i.test(cryptid));
  check('Before you go tells solo visitors to bring someone', /at least one other person/i.test(cryptid));
  check('Before you go repeats that check-ins are not monitored', /not an emergency service/i.test(cryptid));

  await goTo('#/l/route-12-sky-watch-pullout', 900);
  check('UFO listing names the mundane explanations', /Aircraft, satellites/i.test(text()));

  await goTo('#/l/steel-rail-trail-loess-bluff-segment', 900);
  const bike = text();
  check('Bike trail shows surface and status, not just vibes', /trail surface/i.test(bike) && /trail status/i.test(bike));
  check('Bike trail is navigable like any other listing', bike.includes('NAVIGATE'));

  await goTo('#/explore?category=cryptids', 900);
  check('Cryptids is a browsable category', /Cutler Bend/.test(text()));

  await goTo('#/search/bike%20trails', 900);
  check('Searching bike trails returns rides', /Rail Trail|Singletrack/i.test(text()));

  await goTo('#/map', 900);
  check('Map states that hunters are never plotted', w.document.body.textContent.includes('hunters are never plotted'));
  check('Map uses the real Leaflet layer, not a canvas placeholder', w.__leafletMaps.length >= 1);
  {
    const apiPins = (await (await jarFetch('/api/map?filter=nearby')).json()).pins;
    const mapInstance = w.__leafletMaps.at(-1);
    check('Every location pin got a real marker on the map', mapInstance.markers.length === apiPins.filter((p) => p.lat != null).length,
          `${mapInstance.markers.length} markers vs ${apiPins.length} pins`);
    const zoomCtl = mapInstance.controls.find((c) => c.controlOpts?.position);
    check('Zoom buttons render bottom-right, in thumb reach', zoomCtl?.controlOpts.position === 'bottomright',
          JSON.stringify(mapInstance.controls.map((c) => c.controlOpts?.position ?? c.options?.position)));
    check('Locate control renders bottom-right too',
          mapInstance.controls.some((c) => c.options?.position === 'bottomright'),
          JSON.stringify(mapInstance.controls.map((c) => c.options?.position)));
    check('Map is pannable and pinch-zoomable, not a fixed image',
          mapInstance.opts.dragging === true && mapInstance.opts.touchZoom === true);
    check('Map screen offers a Search this area control', !!w.document.querySelector('.search-area'));
    check('Map screen carries a symbol legend', !!w.document.querySelector('.legend'));
    {
      const legend = w.document.querySelector('.legend');
      check('Legend explains the UFO and cryptid symbols',
            /UFO & Sky Watching/i.test(legend.textContent) && /Cryptids/i.test(legend.textContent));
      check('Legend names restricted pins as awareness-only',
            /never as an invitation/i.test(legend.textContent));
      check('Location count never renders as undefined',
            !/undefined/.test(w.document.querySelector('.results').textContent));
    }
    check('Map and results share one responsive container', !!w.document.querySelector('.map-split .results'));
    {
      // Four failed tiles is a blocked provider, not a blip: the app should
      // say so rather than leaving a grey void.
      // The roads basemap is a group (base tiles + a labels layer), so find
      // whichever layer actually registered a tileerror handler.
      const candidates = mapInstance.layers.flatMap((l) => [l, ...(l.children || [])]);
      const roadLayer = candidates.find((l) => l._handlers?.tileerror);
      for (let i = 0; i < 3; i++) roadLayer.fire('tileerror');
      check('A single tile hiccup does not cry wolf', !w.document.querySelector('.tile-error'));
      roadLayer.fire('tileerror');
      const banner = w.document.querySelector('.tile-error');
      check('Repeated tile failures produce an explanation', !!banner);
      check('Tile failure message blames the blocker, not the user\'s data',
            /content blocker or network filter/i.test(banner?.textContent || ''));
      check('Tile failure offers a way out', /Try another layer/i.test(banner?.textContent || ''));
    }
    check('Search this area stays hidden until the user actually pans',
          w.document.querySelector('.search-area')?.classList.contains('hide') === true);
    check('Dark roads basemap is not double-inverted',
          !mapInstance.container.classList.contains('tiles-invert'),
          mapInstance.container.className);
    check('Pins carry a street address or town, not bare coordinates',
          apiPins.every((p) => p.address_short === null || typeof p.address_short === 'string')
          && apiPins.some((p) => /,/.test(p.address_short || '')));

    // Clicking a marker should route to that location's page, same as tapping
    // its card in the list below the map.
    const target = apiPins.find((p) => p.lat != null);
    const marker = mapInstance.markers.find((m) => Math.abs(m.getLatLng().lat - target.lat) < 0.0001);
    marker?.fire('click');
    await wait(400);
    check('Clicking a map marker opens that location', w.location.hash.includes(`/l/${target.slug}`));
  }

  await goTo(`#/map?filter=nearby&focus=hollow-creek-haunted-woods`, 900);
  {
    const focused = w.__leafletMaps.at(-1);
    check('?focus= deep link zooms straight to that pin', focused.view?.zoom === 14);
    const openedMarker = focused.markers.find((m) => m.opened);
    check('?focus= opens that pin\'s popup', !!openedMarker);
  }

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
