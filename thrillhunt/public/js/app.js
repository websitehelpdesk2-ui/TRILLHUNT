import { api, state, refreshSession, coordQuery, requestLocation, ApiError } from './api.js';
import { el, esc, toast, sheet, confirmSheet, sourceChip, meters, safetyPlacard, thrillWarning, empty, skeletons, fmtDate, fmtTime, money } from './ui.js';
import { NavigationService, platform } from './nav-service.js';

const view = document.getElementById('view');
const tabbar = document.getElementById('tabbar');

// ------------------------------------------------------------------ router
const routes = [];
const route = (re, fn) => routes.push([re, fn]);
const go = (hash) => { window.location.hash = hash; };

async function render() {
  const path = (location.hash || '#/home').slice(1);
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      document.querySelector('.composer')?.remove();   // chat composer is view-scoped
      view.innerHTML = '';
      view.append(skeletons(2));
      try {
        const node = await fn(...m.slice(1));
        view.innerHTML = '';
        view.append(node);
        window.scrollTo(0, 0);
        syncTabs(path);
      } catch (err) {
        view.innerHTML = '';
        view.append(errorView(err));
      }
      return;
    }
  }
  view.innerHTML = '';
  view.append(empty('🧭', 'Nothing here', 'That screen does not exist.', el('a', { class: 'btn btn-ghost', href: '#/home', text: 'Back to home' })));
}

function errorView(err) {
  if (err instanceof ApiError && err.status === 401) return authView();
  if (err instanceof ApiError && err.code === 'subscription_required') { showUpsell(err.payload.upsell); return el('div'); }
  return empty('⚠️', 'That did not load', err.message || 'Try again in a moment.',
    el('button', { class: 'btn btn-ghost', text: 'Retry', onclick: render }));
}

function syncTabs(path) {
  const map = { home: '#/home', explore: '#/explore', map: '#/map', groups: '#/groups', profile: '#/profile' };
  for (const btn of tabbar.querySelectorAll('button')) {
    const target = map[btn.dataset.tab];
    btn.setAttribute('aria-current', path.startsWith(target.slice(1)) ? 'page' : 'false');
  }
}

// =========================================================== AUTH + AGE GATE
function authView(mode = 'join') {
  const gate = state.bootstrap.age_gate;
  const wrap = el('div', { class: 'stack' });
  const err = el('div', { class: 'err', role: 'alert', style: 'color:#f0a7a8;min-height:1.2em' });

  const login = () => {
    const email = el('input', { type: 'email', id: 'li-email', autocomplete: 'email', required: true });
    const pw = el('input', { type: 'password', id: 'li-pw', autocomplete: 'current-password', required: true });
    const submit = async () => {
      err.textContent = '';
      try {
        const r = await api.post('/api/auth/login', { email: email.value, password: pw.value });
        state.user = r.user;
        toast(`Welcome back, @${r.user.username}`, 'good');
        go('#/home');
      } catch (e) { err.textContent = e.message; }
    };
    return el('div', { class: 'card' }, [
      el('h2', { text: 'Sign in' }),
      el('div', { class: 'field' }, [el('label', { for: 'li-email', text: 'Email' }), email]),
      el('div', { class: 'field' }, [el('label', { for: 'li-pw', text: 'Password' }), pw]),
      err,
      el('button', { class: 'btn btn-primary btn-block', text: 'Sign in', onclick: submit }),
      el('button', { class: 'btn btn-ghost btn-block', style: 'margin-top:10px', text: 'Create an account instead', onclick: () => { wrap.innerHTML = ''; wrap.append(register()); } }),
    ]);
  };

  const register = () => {
    const f = {
      username: el('input', { id: 'r-user', maxlength: 24, autocomplete: 'username', placeholder: 'nightcrawler_42' }),
      email: el('input', { id: 'r-email', type: 'email', autocomplete: 'email' }),
      password: el('input', { id: 'r-pw', type: 'password', autocomplete: 'new-password', placeholder: 'At least 10 characters' }),
      city: el('input', { id: 'r-city', placeholder: 'Omaha, NE' }),
    };
    const age = el('input', { type: 'checkbox', id: 'r-age' });
    const tos = el('input', { type: 'checkbox', id: 'r-tos' });

    const submit = async () => {
      err.textContent = '';
      if (!age.checked) { err.textContent = 'You must confirm you are 18 or older.'; return; }
      try {
        const body = {
          username: f.username.value, email: f.email.value, password: f.password.value,
          home_city: f.city.value, age_confirmed: age.checked, accept_tos: tos.checked,
          ...(state.coords || {}),
        };
        if (state.coords) { body.home_lat = state.coords.lat; body.home_lng = state.coords.lng; }
        const r = await api.post('/api/auth/register', body);
        state.user = r.user;
        toast('Account created. Welcome to the hunt.', 'good');
        go('#/home');
      } catch (e) { err.textContent = e.message; }
    };

    return el('div', { class: 'stack' }, [
      el('div', { class: 'card', style: 'border-color:var(--ember-dim);background:#170c06' }, [
        el('h2', { style: 'color:var(--ember);letter-spacing:.04em', text: gate.headline }),
        ...gate.body.map((b) => el('p', { style: 'font-size:.88rem;color:var(--ash);margin-bottom:.6em', text: b })),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Create your account' }),
        el('div', { class: 'field' }, [el('label', { for: 'r-user', text: 'Username' }), f.username]),
        el('div', { class: 'field' }, [el('label', { for: 'r-email', text: 'Email' }), f.email]),
        el('div', { class: 'field' }, [el('label', { for: 'r-pw', text: 'Password' }), f.password]),
        el('div', { class: 'field' }, [el('label', { for: 'r-city', text: 'Nearest city (shown on your profile)' }), f.city]),
        el('label', { class: 'checkline', for: 'r-age' }, [age, el('span', { text: gate.attestation })]),
        el('label', { class: 'checkline', for: 'r-tos' }, [tos, el('span', { text: 'I accept the Terms of Service and Community Guidelines.' })]),
        err,
        el('button', { class: 'btn btn-primary btn-block', text: 'Join the hunt', onclick: submit }),
        el('button', { class: 'btn btn-ghost btn-block', style: 'margin-top:10px', text: 'I already have an account', onclick: () => { wrap.innerHTML = ''; wrap.append(login()); } }),
      ]),
    ]);
  };

  wrap.append(mode === 'login' ? login() : register());
  return wrap;
}

route(/^\/join$/, () => authView('join'));
route(/^\/login$/, () => authView('login'));

// ==================================================================== HOME
route(/^\/home$/, async () => {
  if (!state.user) return authView();
  const d = await api.get(`/api/home?${coordQuery()}`);
  const wrap = el('div', { class: 'stack' });

  wrap.append(el('div', { class: 'row between', style: 'margin:14px 0 4px' }, [
    el('div', {}, [
      el('h2', { style: 'margin:0', text: `Evening, @${state.user.username}` }),
      el('small', { text: d.location_known ? 'Sorted by distance from you' : 'Turn on location for distances' }),
    ]),
    !d.location_known ? el('button', {
      class: 'btn btn-ghost btn-sm', text: 'Use my location',
      onclick: async () => { await requestLocation(); render(); },
    }) : null,
  ]));

  wrap.append(searchBar());

  if (d.mystery_drop) wrap.append(mysteryDropCard(d.mystery_drop));

  wrap.append(sectionHead('🔥 Trending tonight', '#/explore?sort=popular'));
  wrap.append(el('div', { class: 'hscroll' }, d.trending.map(locationTile)));

  if (d.events.length) {
    wrap.append(sectionHead('Upcoming events'));
    wrap.append(el('div', { class: 'stack' }, d.events.slice(0, 4).map((e) =>
      el('button', { class: 'tile', onclick: () => go(`#/l/${e.location_slug}`) }, [
        el('div', { class: 'row between' }, [
          el('div', { class: 'grow' }, [
            el('h3', { text: e.title }),
            el('div', { class: 'meta', text: `${e.location_name} · ${fmtDate(e.starts_at)}${e.distance_label ? ' · ' + e.distance_label : ''}` }),
          ]),
          el('span', { class: 'chip', text: e.price_text || 'See operator' }),
        ]),
      ]))));
  }

  if (d.people_going.length) {
    wrap.append(sectionHead('People going'));
    wrap.append(el('div', { class: 'stack' }, d.people_going.map((g) =>
      el('button', { class: 'tile', onclick: () => go(`#/l/${g.slug}`) }, [
        el('div', { class: 'row between' }, [
          el('div', { class: 'grow' }, [el('h3', { text: g.name }), el('div', { class: 'meta', text: fmtDate(g.going_date) })]),
          el('span', { class: 'chip ember', text: `${g.people} going` }),
        ]),
      ]))));
  }

  wrap.append(sectionHead('Your recommendations'));
  wrap.append(el('div', { class: 'stack' }, d.recommendations.map((r) =>
    el('button', { class: 'tile', onclick: () => go(`#/l/${r.slug}`) }, [
      el('div', { class: 'row between' }, [
        el('div', { class: 'grow' }, [
          el('h3', { text: r.name }),
          el('div', { class: 'meta', text: [r.distance_label, r.reason].filter(Boolean).join(' · ') }),
        ]),
        el('span', { class: 'chip', text: `★ ${r.rating_avg || '—'}` }),
      ]),
    ]))));

  wrap.append(el('button', {
    class: 'btn btn-primary btn-block', style: 'margin-top:20px',
    text: '🧠  Plan my night with AI', onclick: () => go('#/ai'),
  }));
  return wrap;
});

function sectionHead(title, href) {
  return el('div', { class: 'section-head' }, [
    el('h2', { text: title }),
    href ? el('a', { href, text: 'See all' }) : null,
  ]);
}

function searchBar() {
  const input = el('input', { type: 'search', placeholder: 'haunted attractions near Omaha', 'aria-label': 'Search experiences' });
  const submit = () => { if (input.value.trim()) go(`#/search/${encodeURIComponent(input.value.trim())}`); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  return el('div', { class: 'row', style: 'margin:10px 0' }, [
    el('div', { class: 'grow' }, [input]),
    el('button', { class: 'iconbtn', 'aria-label': 'Search', text: '🔍', onclick: submit }),
  ]);
}

function locationTile(l) {
  return el('button', { class: 'tile', onclick: () => go(`#/l/${l.slug}`) }, [
    sourceChip(l.data_source, l.is_demo),
    el('h3', { style: 'margin-top:8px', text: l.name }),
    el('div', { class: 'meta', text: [l.distance_label, l.city && `${l.city}, ${l.region}`].filter(Boolean).join(' · ') }),
    el('div', { style: 'margin:10px 0' }, [meters(l, [['fear', 'Fear'], ['isolation', 'Isolation'], ['darkness', 'Darkness']])]),
    el('div', { class: 'row between' }, [
      el('span', { class: 'chip', text: `★ ${l.rating_avg || '—'} (${l.rating_count})` }),
      el('span', { class: 'chip', text: `${l.interested_count} interested` }),
    ]),
  ]);
}

function mysteryDropCard(drop) {
  const box = el('div', { class: 'card', style: 'border-color:#5b2526;background:linear-gradient(180deg,#1c0d0e,#120a0b)' });
  const paint = () => {
    box.innerHTML = '';
    box.append(
      el('div', { class: 'row between' }, [
        el('span', { class: 'chip restricted', text: '🔴 MYSTERY DROP' }),
        el('small', { text: `Ends ${fmtDate(drop.ends_at)}` }),
      ]),
      el('p', { style: 'margin:12px 0 6px;font-size:1.02rem', text: drop.teaser }),
      el('div', { class: 'row wrap', style: 'margin-bottom:12px' }, [
        el('span', { class: 'chip ember', text: `Fear ${'🔥'.repeat(drop.fear_flames)}` }),
        el('span', { class: 'chip', text: `Recommended group: ${drop.group_min}–${drop.group_max}` }),
        drop.pro_only ? el('span', { class: 'chip pro', text: 'PRO exclusive' }) : null,
      ]),
      drop.reveal
        ? el('button', { class: 'btn btn-ghost btn-block', text: `Open ${drop.reveal.name}`, onclick: () => go(`#/l/${drop.reveal.slug}`) })
        : el('button', {
            class: 'btn btn-primary btn-block', text: 'REVEAL',
            onclick: async () => {
              try {
                const r = await api.post(`/api/mystery-drops/${drop.id}/reveal`);
                drop.reveal = { name: r.location.name, slug: r.location.slug };
                paint();
                toast(`Revealed: ${r.location.name}`, 'good');
              } catch (e) { handleError(e); }
            },
          }),
    );
  };
  paint();
  return box;
}

// ================================================================= EXPLORE
route(/^\/explore(?:\?(.*))?$/, async (qs) => {
  const params = new URLSearchParams(qs || '');
  const cats = state.bootstrap.categories;
  const wrap = el('div', { class: 'stack' });
  wrap.append(el('h2', { style: 'margin:16px 0 0', text: 'Explore' }), searchBar());

  const catRow = el('div', { class: 'hscroll', style: 'margin-bottom:6px' },
    [{ slug: '', name: 'Everything', icon: '✴️' }, ...cats].map((c) =>
      el('button', {
        class: 'chip', style: `flex:0 0 auto;padding:9px 14px;${(params.get('category') || '') === c.slug ? 'border-color:var(--ember);color:var(--ember)' : ''}`,
        text: `${c.icon} ${c.name}`,
        onclick: () => { params.set('category', c.slug); go(`#/explore?${params}`); },
      })));
  wrap.append(catRow);

  const sorts = [['recommended', 'Recommended'], ['closest', 'Closest'], ['rating', 'Highest rated'], ['popular', 'Most popular'], ['terrifying', 'Most terrifying'], ['newest', 'Newest']];
  const sortSel = el('select', { 'aria-label': 'Sort results' }, sorts.map(([v, l]) => el('option', { value: v, selected: params.get('sort') === v, text: l })));
  sortSel.addEventListener('change', () => { params.set('sort', sortSel.value); go(`#/explore?${params}`); });

  wrap.append(el('div', { class: 'row', style: 'margin-bottom:4px' }, [
    el('div', { class: 'grow' }, [sortSel]),
    el('button', { class: 'btn btn-ghost btn-sm', text: '⚙︎ Filters', onclick: () => filterSheet(params) }),
  ]));

  const data = await api.get(`/api/explore?${params}&${coordQuery()}`);
  if (data.advanced_filters_locked) {
    wrap.append(el('div', { class: 'card', style: 'border-color:#4a3b86' }, [
      el('div', { class: 'row between' }, [
        el('div', { class: 'grow' }, [el('strong', { text: 'Advanced filters are a PRO feature' }), el('div', { class: 'meta', text: 'Fear, difficulty and price filters need THRILLHUNT PRO.' })]),
        el('button', { class: 'btn btn-pro btn-sm', text: 'Upgrade', onclick: () => go('#/pro') }),
      ]),
    ]));
  }
  wrap.append(el('small', { text: `${data.total} experiences` }));
  wrap.append(data.results.length
    ? el('div', { class: 'stack' }, data.results.map(locationTile))
    : empty('🔦', 'Nothing matches yet', 'Widen the distance or clear a filter. We will not invent places to fill the list.'));
  return wrap;
});

function filterSheet(params) {
  return sheet('Filters', (close) => {
    const within = el('input', { type: 'number', value: params.get('within') || 250, min: 1, max: 3000 });
    const rating = el('input', { type: 'number', value: params.get('min_rating') || 0, min: 0, max: 5, step: .5 });
    const fear = el('input', { type: 'range', value: params.get('min_fear') || 0, min: 0, max: 10 });
    const verified = el('input', { type: 'checkbox', checked: params.get('verified') === 'true' });
    const openNow = el('input', { type: 'checkbox', checked: params.get('open_now') === 'true' });
    return el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: 'Within (miles)' }), within]),
      el('div', { class: 'field' }, [el('label', { text: 'Minimum rating' }), rating]),
      el('div', { class: 'field' }, [el('label', { text: 'Minimum fear (PRO)' }), fear]),
      el('label', { class: 'checkline' }, [verified, el('span', { text: 'Verified listings only' })]),
      el('label', { class: 'checkline' }, [openNow, el('span', { text: 'Has published hours' })]),
      el('button', {
        class: 'btn btn-primary btn-block', text: 'Apply filters',
        onclick: () => {
          params.set('within', within.value);
          params.set('min_rating', rating.value);
          if (+fear.value > 0) params.set('min_fear', fear.value); else params.delete('min_fear');
          verified.checked ? params.set('verified', 'true') : params.delete('verified');
          openNow.checked ? params.set('open_now', 'true') : params.delete('open_now');
          close(true);
          go(`#/explore?${params}`);
        },
      }),
    ]);
  });
}

// ================================================================== SEARCH
route(/^\/search\/(.+)$/, async (q) => {
  const query = decodeURIComponent(q);
  const d = await api.get(`/api/search?q=${encodeURIComponent(query)}&${coordQuery()}`);
  const wrap = el('div', { class: 'stack' }, [el('h2', { style: 'margin-top:16px', text: `“${query}”` }), searchBar()]);
  const i = d.interpreted;
  if (i && (i.categories.length || i.radius_miles || i.near || i.time_window)) {
    wrap.append(el('div', { class: 'chiprow' }, [
      ...i.categories.map((c) => el('span', { class: 'chip ember', text: c.replace(/-/g, ' ') })),
      i.radius_miles ? el('span', { class: 'chip', text: `within ${i.radius_miles} mi` }) : null,
      i.near ? el('span', { class: 'chip', text: `near ${i.near}` }) : null,
      i.time_window ? el('span', { class: 'chip', text: i.time_window }) : null,
    ]));
  }
  if (d.events?.length) {
    wrap.append(sectionHead('Events this week'));
    wrap.append(el('div', { class: 'stack' }, d.events.map((e) =>
      el('button', { class: 'tile', onclick: () => go(`#/l/${e.slug}`) }, [
        el('h3', { text: e.title }), el('div', { class: 'meta', text: `${e.name} · ${fmtDate(e.starts_at)}` }),
      ]))));
  }
  wrap.append(d.results.length
    ? el('div', { class: 'stack' }, d.results.map(locationTile))
    : empty('🔍', 'No matches', 'Try a category like “camping”, or search a place name.'));
  return wrap;
});

// ===================================================================== MAP
route(/^\/map(?:\?(.*))?$/, async (qs) => {
  const params = new URLSearchParams(qs || '');
  const filter = params.get('filter') || 'nearby';
  const d = await api.get(`/api/map?filter=${filter}&${coordQuery()}`);
  const wrap = el('div', { class: 'stack' }, [el('h2', { style: 'margin-top:16px', text: 'Map' })]);

  wrap.append(el('div', { class: 'hscroll' }, [['nearby', 'Nearby'], ['open_now', 'Open now'], ['weekend', 'This weekend'], ['trending', 'Trending'], ['drops', 'Mystery drops']].map(([k, label]) =>
    el('button', {
      class: 'chip', style: `flex:0 0 auto;padding:9px 14px;${filter === k ? 'border-color:var(--ember);color:var(--ember)' : ''}`,
      text: label, onclick: () => go(`#/map?filter=${k}`),
    }))));

  const canvas = el('canvas');
  const holder = el('div', { class: 'mapwrap' }, [canvas, el('div', { class: 'maphint', text: 'Location pins only — hunters are never plotted' })]);
  wrap.append(holder);
  const list = el('div', { class: 'stack' });
  wrap.append(list);

  requestAnimationFrame(() => drawMap(canvas, d, (pin) => go(`#/l/${pin.slug}`)));
  list.append(...d.pins.slice(0, 12).map((p) => el('button', { class: 'tile', onclick: () => go(`#/l/${p.slug}`) }, [
    el('div', { class: 'row between' }, [
      el('div', { class: 'grow' }, [el('h3', { text: `${iconFor(p.category)} ${p.name}` }), el('div', { class: 'meta', text: p.distance_label || `${p.lat.toFixed(2)}, ${p.lng.toFixed(2)}` })]),
      el('span', { class: 'chip', text: `★ ${p.rating_avg || '—'}` }),
    ]),
  ])));
  return wrap;
});

const ICONS = { 'haunted-attractions': '👻', 'halloween-events': '🎃', paranormal: '🔦', camping: '🏕️', 'remote-adventures': '🌲', 'night-adventures': '🌙', hiking: '🥾', 'road-trips': '🚗', 'horror-experiences': '🧟', 'outdoor-adventures': '🔥', 'hidden-gems': '🧭' };
const iconFor = (c) => ICONS[c] || '📍';

/** Schematic pin map. Real tiles require a maps provider key (see README). */
function drawMap(canvas, data, onPick) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const pins = data.pins.filter((p) => p.lat != null);
  if (!pins.length) return;
  const lats = pins.map((p) => p.lat), lngs = pins.map((p) => p.lng);
  const pad = 0.35;
  let minLat = Math.min(...lats) - pad, maxLat = Math.max(...lats) + pad;
  let minLng = Math.min(...lngs) - pad, maxLng = Math.max(...lngs) + pad;
  const project = (p) => ({
    x: ((p.lng - minLng) / (maxLng - minLng)) * rect.width,
    y: rect.height - ((p.lat - minLat) / (maxLat - minLat)) * rect.height,
  });

  ctx.fillStyle = '#0a0a0d'; ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.strokeStyle = '#17171d'; ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    ctx.beginPath(); ctx.moveTo((rect.width / 8) * i, 0); ctx.lineTo((rect.width / 8) * i, rect.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, (rect.height / 8) * i); ctx.lineTo(rect.width, (rect.height / 8) * i); ctx.stroke();
  }
  if (data.center) {
    const c = project(data.center);
    ctx.fillStyle = 'rgba(255,90,31,.14)';
    ctx.beginPath(); ctx.arc(c.x, c.y, 26, 0, 7); ctx.fill();
    ctx.fillStyle = '#ff5a1f';
    ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, 7); ctx.fill();
  }
  const spots = [];
  for (const p of pins) {
    const { x, y } = project(p);
    spots.push({ x, y, p });
    ctx.font = '18px serif'; ctx.textAlign = 'center';
    ctx.fillText(iconFor(p.category), x, y);
  }
  canvas.onclick = (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 26;
    for (const s of spots) { const d = Math.hypot(s.x - mx, s.y - my); if (d < bd) { bd = d; best = s; } }
    if (best) onPick(best.p);
  };
}

// ========================================================== LOCATION DETAIL
route(/^\/l\/([\w-]+)$/, async (slug) => {
  const d = await api.get(`/api/locations/${slug}?${coordQuery()}`);
  const L = d.location;
  const wrap = el('div', { class: 'stack' });

  wrap.append(el('div', { style: 'margin-top:16px' }, [
    sourceChip(L.data_source, L.is_demo),
    el('h1', { style: 'font-size:2rem;margin:10px 0 4px', text: L.name }),
    el('p', { style: 'color:var(--ash);margin:0 0 6px', text: L.tagline || '' }),
    el('div', { class: 'row wrap' }, [
      el('span', { class: 'chip', text: `★ ${L.rating_avg || '—'} (${L.rating_count})` }),
      L.distance_label ? el('span', { class: 'chip', text: L.distance_label }) : null,
      el('span', { class: 'chip', text: L.price_text }),
    ]),
  ]));

  if (L.access_policy === 'private_closed') {
    wrap.append(el('div', { class: 'warning' }, [
      el('strong', { text: '⛔ CLOSED PROPERTY — ENTRY IS NOT PERMITTED' }),
      el('p', { style: 'margin:0', text: 'This listing exists for awareness only. THRILLHUNT will not help anyone enter restricted property. Try the Paranormal category for legal, guided alternatives.' }),
    ]));
  }

  // primary actions
  const actions = el('div', { class: 'stack', style: 'margin-top:6px' });
  actions.append(el('button', { class: 'btn btn-primary btn-block', text: '📍  NAVIGATE', onclick: () => navigateSheet(d.destination) }));
  if (L.access_policy !== 'private_closed') {
    actions.append(el('div', { class: 'row' }, [
      el('button', { class: 'btn btn-ghost grow', text: "I'M GOING", onclick: () => goingSheet(L) }),
      el('button', { class: 'btn btn-ghost grow', text: 'JOIN GROUP', onclick: () => createGroupSheet(L) }),
    ]));
    actions.append(el('div', { class: 'row' }, [
      d.chat ? el('button', { class: 'btn btn-ghost grow', text: `CHAT · ${d.chat.members}`, onclick: () => go(`#/chat/${d.chat.id}`) }) : null,
      el('button', { class: 'btn btn-ghost grow', text: d.saved ? '★ SAVED' : '☆ SAVE', onclick: async (e) => { const r = await api.post(`/api/locations/${slug}/save`); toast(r.saved ? 'Saved' : 'Removed'); e.target.textContent = r.saved ? '★ SAVED' : '☆ SAVE'; } }),
      el('button', { class: 'btn btn-ghost grow', text: 'SHARE', onclick: () => shareSheet({ headline: L.name, subline: L.tagline || '', url: `${location.origin}/l/${L.slug}`, tagline: 'CHASE THE THRILL. RESPECT THE RISK.' }) }),
    ]));
  }
  wrap.append(actions);

  wrap.append(sectionHead('Thrill metrics'));
  wrap.append(el('div', { class: 'card' }, [meters(L)]));

  if (L.description) {
    wrap.append(sectionHead('About'));
    wrap.append(el('div', { class: 'card' }, [el('p', { style: 'margin:0', text: L.description })]));
  }

  wrap.append(sectionHead('Know before you go'));
  wrap.append(safetyPlacard(d.safety));
  wrap.append(el('div', { class: 'card flat' }, [
    el('dl', { style: 'margin:0;display:grid;gap:10px' }, [
      el('div', {}, [el('dt', { style: 'font-size:.72rem;color:var(--smoke)', text: 'HOURS' }), el('dd', { style: 'margin:2px 0 0;font-size:.9rem', text: L.hours_display })]),
      el('div', {}, [el('dt', { style: 'font-size:.72rem;color:var(--smoke)', text: 'PRICE' }), el('dd', { style: 'margin:2px 0 0;font-size:.9rem', text: L.price_text })]),
      el('div', {}, [el('dt', { style: 'font-size:.72rem;color:var(--smoke)', text: 'LOCATION' }), el('dd', { style: 'margin:2px 0 0;font-size:.9rem', text: L.address_display })]),
    ]),
    el('div', { class: 'row wrap', style: 'margin-top:12px' }, [
      L.website_url ? el('a', { class: 'btn btn-ghost btn-sm', href: L.website_url, target: '_blank', rel: 'noopener', text: 'Official website' }) : null,
      L.reservation_url ? el('a', { class: 'btn btn-ghost btn-sm', href: L.reservation_url, target: '_blank', rel: 'noopener', text: 'Reservations' }) : null,
      el('button', { class: 'btn btn-danger btn-sm', text: '⚠︎ Report safety issue', onclick: () => safetyReportSheet(slug) }),
    ]),
  ]));
  wrap.append(thrillWarning(d.safety.warning));

  if (d.business) {
    wrap.append(el('div', { class: 'card', style: 'border-color:#2c5b3c' }, [
      el('span', { class: 'chip verified', text: 'OFFICIAL BUSINESS INFORMATION' }),
      el('p', { style: 'margin:10px 0 0;font-size:.9rem', text: `${d.business.legal_name} — claim status: ${d.business.claim_status}.` }),
    ]));
  }

  if (d.whos_going.length) {
    wrap.append(sectionHead("Who's going?"));
    wrap.append(el('div', { class: 'stack' }, d.whos_going.map((g) =>
      el('button', {
        class: 'tile', onclick: async () => {
          const r = await api.get(`/api/locations/${slug}/going?date=${g.going_date}`);
          sheet(fmtDate(g.going_date), () => el('div', { class: 'stack' }, [
            ...r.people.map((p) => el('div', { class: 'row' }, [
              el('span', { style: 'font-size:1.4rem', text: p.avatar_emoji || '🎯' }),
              el('div', { class: 'grow' }, [el('strong', { text: '@' + p.username }), el('div', { class: 'meta', text: `Level ${p.level} — ${p.level_title}` })]),
            ])),
            el('button', { class: 'btn btn-primary btn-block', text: 'CREATE GROUP', onclick: () => createGroupSheet(L, g.going_date) }),
          ]));
        },
      }, [
        el('div', { class: 'row between' }, [
          el('span', { text: fmtDate(g.going_date) }),
          el('span', { class: 'chip ember', text: `${g.people} going` }),
        ]),
      ]))));
  }

  if (d.events.length) {
    wrap.append(sectionHead('Events'));
    wrap.append(el('div', { class: 'stack' }, d.events.map((e) => el('div', { class: 'card tight' }, [
      el('div', { class: 'row between' }, [
        el('div', { class: 'grow' }, [el('strong', { text: e.title }), el('div', { class: 'meta', text: fmtDate(e.starts_at) })]),
        el('span', { class: 'chip', text: e.price_text || '' }),
      ]),
      e.description ? el('p', { style: 'margin:8px 0 0;font-size:.88rem;color:var(--ash)', text: e.description }) : null,
    ]))));
  }

  wrap.append(sectionHead('Thrill Reports'));
  wrap.append(el('button', { class: 'btn btn-ghost btn-block', text: '✍️  File a Thrill Report', onclick: () => thrillReportSheet(slug) }));
  wrap.append(d.thrill_reports.length
    ? el('div', { class: 'stack' }, d.thrill_reports.map(reportCard))
    : el('p', { style: 'color:var(--ash);font-size:.9rem', text: 'No reports yet. Be the first one back.' }));

  if (d.reviews.length) {
    wrap.append(sectionHead('Reviews'));
    wrap.append(el('div', { class: 'stack' }, d.reviews.map((r) => el('div', { class: 'card tight' }, [
      el('div', { class: 'row between' }, [
        el('strong', { text: `${r.avatar_emoji} @${r.username}` }),
        el('span', { class: 'chip', text: '★'.repeat(r.rating) }),
      ]),
      r.body ? el('p', { style: 'margin:8px 0 0;font-size:.9rem', text: r.body }) : null,
    ]))));
  }
  return wrap;
});

function reportCard(r) {
  return el('div', { class: 'card tight' }, [
    el('div', { class: 'row between' }, [
      el('strong', { text: `${r.avatar_emoji || '🎯'} @${r.username}` }),
      el('span', { class: 'chip ember', text: `Fear ${r.fear ?? '—'}/10` }),
    ]),
    r.body ? el('p', { style: 'margin:8px 0;font-size:.92rem', text: r.body }) : null,
    el('div', { class: 'row between' }, [
      el('small', { text: r.would_return ? 'Would return: YES' : 'Would return: NO' }),
      el('button', {
        class: 'btn btn-ghost btn-sm', text: '•••', 'aria-label': 'Report this post',
        onclick: () => reportSheet('thrill_report', r.id),
      }),
    ]),
  ]);
}

// ------------------------------------------------------------- action sheets
function navigateSheet(dest) {
  return sheet('Navigate', (close) => {
    const opts = NavigationService.optionsFor(dest);
    const body = el('div', { class: 'stack' });
    body.append(el('p', { style: 'color:var(--ash);font-size:.9rem;margin:0 0 4px', text: NavigationService.addressText(dest) }));
    if (dest.approximate) body.append(el('div', { class: 'warning', style: 'font-size:.82rem' }, [el('p', { style: 'margin:0', text: dest.note })]));
    for (const o of opts) {
      body.append(el('button', {
        class: 'btn btn-ghost btn-block', text: o.label,
        onclick: () => {
          const ok = NavigationService.open(o.url);
          close(true);
          if (!ok) fallbackSheet(dest);
        },
      }));
    }
    body.append(el('button', { class: 'btn btn-ghost btn-block', text: '📋  Copy address', onclick: async () => { await copy(NavigationService.addressText(dest)); toast('Address copied', 'good'); close(true); } }));
    return body;
  }, { subtitle: dest.name });
}

function fallbackSheet(dest) {
  return sheet('Unable to open navigation', (close) => el('div', { class: 'stack' }, [
    el('p', { style: 'color:var(--ash)', text: 'You can copy the destination address or open it in a supported map service.' }),
    el('button', { class: 'btn btn-ghost btn-block', text: 'Copy address', onclick: async () => { await copy(NavigationService.addressText(dest)); toast('Copied', 'good'); } }),
    el('a', { class: 'btn btn-primary btn-block', href: NavigationService.googleMapsUrl(dest), target: '_blank', rel: 'noopener', text: 'Open in browser' }),
    el('button', { class: 'btn btn-ghost btn-block', text: 'Close', onclick: () => close(null) }),
  ]));
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = el('textarea', { style: 'position:fixed;opacity:0' }); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
}

function goingSheet(L) {
  return sheet("I'm going", (close) => {
    const date = el('input', { type: 'date', value: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) });
    const publicToggle = el('input', { type: 'checkbox', checked: true });
    return el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: 'Which night?' }), date]),
      el('label', { class: 'checkline' }, [publicToggle, el('span', { text: 'Let other hunters see I am going that night' })]),
      el('button', {
        class: 'btn btn-primary btn-block', text: "I'M GOING",
        onclick: async () => {
          try {
            await api.post(`/api/locations/${L.slug}/attendance`, { status: 'going', going_date: date.value, visibility: publicToggle.checked ? 'public' : 'private' });
            close(true); toast('Locked in. +20 XP', 'good'); render();
          } catch (e) { handleError(e); }
        },
      }),
      el('button', {
        class: 'btn btn-ghost btn-block', style: 'margin-top:10px', text: 'Just interested',
        onclick: async () => { await api.post(`/api/locations/${L.slug}/attendance`, { status: 'interested' }); close(true); toast('Added to your interests'); },
      }),
    ]);
  }, { subtitle: L.name });
}

function createGroupSheet(L, date) {
  return sheet('Create a group', (close) => {
    const name = el('input', { value: `${L.name} crew` });
    const desc = el('textarea', { placeholder: 'Where are you meeting, and when?' });
    const when = el('input', { type: 'date', value: date || '' });
    return el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: 'Group name' }), name]),
      el('div', { class: 'field' }, [el('label', { text: 'Planned date' }), when]),
      el('div', { class: 'field' }, [el('label', { text: 'Plan' }), desc]),
      el('button', {
        class: 'btn btn-primary btn-block', text: 'Create private group',
        onclick: async () => {
          try {
            const r = await api.post('/api/groups', { name: name.value, description: desc.value, location_slug: L.slug, planned_date: when.value || null });
            close(true); toast('Group created. Invite link copied.', 'good');
            await copy(`${location.origin}/app#/join/${r.group.invite_code}`);
            go(`#/chat/${(await api.get(`/api/groups/${r.group.id}`)).group.chat_id}`);
          } catch (e) { handleError(e); }
        },
      }),
    ]);
  });
}

function safetyReportSheet(slug) {
  return sheet('Report a safety issue', (close) => {
    const type = el('select', {}, [
      ['closed', 'Location is closed'], ['hazard', 'Hazard on site'], ['access_denied', 'Access denied / private'],
      ['inaccurate_info', 'Listing information is wrong'], ['unsafe_conditions', 'Unsafe conditions'], ['other', 'Other'],
    ].map(([v, l]) => el('option', { value: v, text: l })));
    const body = el('textarea', { placeholder: 'What did you find?' });
    return el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: 'What is the issue?' }), type]),
      el('div', { class: 'field' }, [el('label', { text: 'Details' }), body]),
      el('p', { style: 'font-size:.8rem;color:var(--ash)', text: 'THRILLHUNT is not an emergency service. If someone is in danger, contact your local emergency services first.' }),
      el('button', {
        class: 'btn btn-primary btn-block', text: 'Send to safety team',
        onclick: async () => {
          try { const r = await api.post(`/api/locations/${slug}/safety-report`, { issue_type: type.value, body: body.value }); close(true); toast(r.message, 'good'); }
          catch (e) { handleError(e); }
        },
      }),
    ]);
  });
}

function thrillReportSheet(slug) {
  return sheet('Thrill Report', (close) => {
    const fields = [['fear', '😱 Fear'], ['paranormal', '👻 Paranormal'], ['isolation', '🌲 Isolation'], ['darkness', '🌙 Darkness'], ['difficulty', '🥾 Difficulty'], ['value', '💰 Value'], ['overall', '⭐ Overall']];
    const inputs = {};
    const body = el('textarea', { placeholder: 'What actually happened out there?' });
    const ret = el('input', { type: 'checkbox', checked: true });
    const photos = el('div', { class: 'chiprow' });
    const mediaIds = [];
    const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', style: 'display:none' });
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      try {
        const r = await api.uploadImage(file.files[0]);
        mediaIds.push(r.media_id);
        photos.append(el('span', { class: 'chip verified', text: r.status === 'review' ? 'Photo pending review' : 'Photo attached' }));
      } catch (e) { handleError(e); }
      file.value = '';
    });

    return el('div', {}, [
      ...fields.map(([k, label]) => {
        const input = el('input', { type: 'range', min: 0, max: 10, value: 5 });
        const out = el('span', { class: 'val', text: '5' });
        input.addEventListener('input', () => { out.textContent = input.value; });
        inputs[k] = input;
        return el('div', { class: 'meter', style: 'margin-bottom:8px' }, [el('span', { class: 'name', text: label }), input, out]);
      }),
      el('div', { class: 'field' }, [el('label', { text: 'Your report' }), body]),
      el('label', { class: 'checkline' }, [ret, el('span', { text: 'Would return' })]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Photos' }),
        el('button', { class: 'btn btn-ghost btn-sm', text: state.isPro ? '📸 Add photo' : '📸 Add photo (PRO)', onclick: () => state.isPro ? file.click() : showUpsell() }),
        photos,
      ]),
      file,
      el('button', {
        class: 'btn btn-primary btn-block', text: 'Publish report',
        onclick: async () => {
          const payload = { body: body.value, would_return: ret.checked, media_ids: mediaIds };
          for (const [k] of fields) payload[k] = +inputs[k].value;
          try {
            const r = await api.post(`/api/locations/${slug}/thrill-report`, payload);
            close(true);
            await refreshSession();
            toast(`Report filed. ${r.xp} XP total.`, 'good');
            if (r.badges?.length) toast(`🏆 New badge: ${r.badges[0].name}`, 'good');
            shareSheet(r.share_card);
          } catch (e) { handleError(e); }
        },
      }),
    ]);
  });
}

function shareSheet(card) {
  return sheet('Share', (close) => {
    const preview = el('div', { class: 'card', style: 'background:linear-gradient(135deg,#2a1207,#120a0b);border-color:#6b2c11;text-align:center;padding:26px' }, [
      el('div', { style: 'font-family:var(--font-display);font-weight:800;font-size:1.6rem;letter-spacing:-.02em', text: card.headline }),
      el('div', { style: 'color:var(--ash);margin:6px 0 14px', text: card.subline || '' }),
      el('div', { style: 'font-size:.72rem;letter-spacing:.18em;color:var(--ember)', text: card.tagline }),
    ]);
    const targets = [['TikTok', 'https://www.tiktok.com/'], ['Instagram', 'https://www.instagram.com/'], ['Snapchat', 'https://www.snapchat.com/'], ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(card.url)}`], ['Text message', `sms:?&body=${encodeURIComponent(card.headline + ' — ' + card.url)}`]];
    return el('div', { class: 'stack' }, [
      preview,
      navigator.share ? el('button', { class: 'btn btn-primary btn-block', text: 'Share…', onclick: () => navigator.share({ title: card.headline, text: card.subline, url: card.url }).catch(() => {}) }) : null,
      ...targets.map(([label, url]) => el('a', { class: 'btn btn-ghost btn-block', href: url, target: '_blank', rel: 'noopener', text: label })),
      el('button', { class: 'btn btn-ghost btn-block', text: 'Copy link', onclick: async () => { await copy(card.url); toast('Link copied', 'good'); } }),
    ]);
  });
}

const REPORT_REASONS = [
  ['sexual_content', 'Sexual/inappropriate content'], ['graphic_violence', 'Graphic violence/gore'],
  ['harassment', 'Harassment'], ['dangerous_activity', 'Dangerous activity'], ['illegal_activity', 'Illegal activity'],
  ['hate_abuse', 'Hate/abusive content'], ['privacy', 'Privacy concern'], ['spam', 'Spam'], ['other', 'Other'],
];

function reportSheet(subjectType, subjectId) {
  const prompt = subjectType === 'image' ? 'WHY ARE YOU REPORTING THIS IMAGE?' : 'WHY ARE YOU REPORTING THIS?';
  return sheet(prompt, (close) => {
    let chosen = null;
    const details = el('textarea', { placeholder: 'Anything else we should know? (optional)' });
    const list = el('div', { class: 'stack' }, REPORT_REASONS.map(([k, label]) =>
      el('button', {
        class: 'btn btn-ghost btn-block', text: label,
        onclick: (e) => {
          chosen = k;
          for (const b of list.querySelectorAll('button')) b.style.borderColor = 'var(--ink-300)';
          e.target.style.borderColor = 'var(--ember)';
        },
      })));
    return el('div', { class: 'stack' }, [
      list,
      el('div', { class: 'field' }, [el('label', { text: 'Explanation (optional)' }), details]),
      el('button', {
        class: 'btn btn-primary btn-block', text: 'Submit report',
        onclick: async () => {
          if (!chosen) { toast('Pick a reason first'); return; }
          try { const r = await api.post('/api/report', { subject_type: subjectType, subject_id: subjectId, reason: chosen, details: details.value }); close(true); toast(r.message, 'good'); }
          catch (e) { handleError(e); }
        },
      }),
    ]);
  });
}

// ==================================================================== CHAT
route(/^\/chats$/, async () => {
  const d = await api.get('/api/chats');
  const wrap = el('div', { class: 'stack' }, [el('h2', { style: 'margin-top:16px', text: 'Messages' })]);
  if (!d.chats.length) return wrap.append(empty('💬', 'No conversations yet', 'Open a location and join its chat to find people going the same night.')) || wrap;
  wrap.append(el('div', { class: 'stack' }, d.chats.map((c) =>
    el('button', { class: 'tile', onclick: () => go(`#/chat/${c.id}`) }, [
      el('div', { class: 'row between' }, [
        el('div', { class: 'grow' }, [
          el('h3', { text: `${c.kind === 'location' ? '📍' : c.kind === 'group' ? '👥' : '✉️'} ${c.title || 'Conversation'}` }),
          el('div', { class: 'meta', text: c.last_message?.body?.slice(0, 60) || 'No messages yet' }),
        ]),
        c.state === 'requested' ? el('span', { class: 'chip ember', text: 'Request' }) : c.unread ? el('span', { class: 'chip ember', text: String(c.unread) }) : null,
      ]),
    ]))));
  return wrap;
});

route(/^\/chat\/([\w]+)$/, async (chatId) => {
  const d = await api.get(`/api/chats/${chatId}/messages`);
  api.post(`/api/chats/${chatId}/read`).catch(() => {});
  const wrap = el('div', { class: 'stack', style: 'padding-bottom:70px' });
  const listEl = el('div', {});
  const paint = (messages) => {
    listEl.innerHTML = '';
    if (!messages.length) listEl.append(empty('👻', 'Quiet in here', 'Say when you are going — someone else probably is too.'));
    for (const m of messages) {
      if (m.muted) continue;
      listEl.append(el('div', { class: `msg${m.mine ? ' mine' : ''}` }, [
        el('div', { class: 'av', text: m.user.avatar_emoji || '🎯' }),
        el('div', {}, [
          el('div', { class: 'who' }, [
            el('strong', { text: '@' + m.user.username }), ' · ', fmtTime(m.created_at),
            el('button', {
              class: 'btn btn-ghost btn-sm', style: 'padding:0 6px;margin-left:6px;border:0;color:var(--smoke)',
              text: '•••', 'aria-label': 'Message options',
              onclick: () => messageOptions(m),
            }),
          ]),
          el('div', { class: 'bubble' }, [
            m.pending ? el('em', { style: 'color:var(--ash);font-size:.85rem', text: 'Held for review' }) : null,
            m.body ? el('div', { text: m.body }) : null,
            ...m.attachments.map((a) => el('img', { src: a.url, alt: 'Shared photo', loading: 'lazy' })),
          ]),
          m.reactions.length ? el('div', { class: 'chiprow', style: 'margin-top:6px' }, m.reactions.map((r) => el('span', { class: 'chip', text: `${r.emoji} ${r.c}` }))) : null,
        ]),
      ]));
    }
  };
  paint(d.messages);
  wrap.append(el('h2', { style: 'margin-top:16px', text: 'Chat' }), listEl);

  // composer
  const input = el('input', { type: 'text', placeholder: 'Message', 'aria-label': 'Message' });
  const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', style: 'display:none' });
  let pendingMedia = [];
  const pendingRow = el('div', { class: 'chiprow' });

  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    try {
      const r = await api.uploadImage(file.files[0]);
      pendingMedia.push(r.media_id);
      pendingRow.append(el('span', { class: 'chip verified', text: r.status === 'review' ? '⏳ Pending review' : '📎 Photo ready' }));
      if (r.exif_stripped) toast('Location metadata removed from your photo', 'good');
    } catch (e) { handleError(e); }
    file.value = '';
  });

  const send = async () => {
    if (!input.value.trim() && !pendingMedia.length) return;
    try {
      await api.post(`/api/chats/${chatId}/messages`, { body: input.value, media_ids: pendingMedia });
      input.value = ''; pendingMedia = []; pendingRow.innerHTML = '';
      const fresh = await api.get(`/api/chats/${chatId}/messages`);
      paint(fresh.messages);
      window.scrollTo(0, document.body.scrollHeight);
    } catch (e) { handleError(e); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  const composer = el('div', { class: 'composer' }, [
    el('div', { class: 'inner' }, [
      el('button', {
        class: 'iconbtn', 'aria-label': 'Add photo', text: '📸',
        onclick: () => (state.isPro ? file.click() : showUpsell()),
      }),
      el('div', { class: 'grow' }, [input, pendingRow]),
      el('button', { class: 'iconbtn', 'aria-label': 'Send', text: '➤', onclick: send }),
    ]),
    file,
  ]);
  document.querySelector('.composer')?.remove();
  document.body.append(composer);
  return wrap;
});

function messageOptions(m) {
  return sheet('Message options', (close) => el('div', { class: 'stack' }, [
    m.attachments.length ? el('button', { class: 'btn btn-ghost btn-block', text: 'Report image', onclick: () => { close(); reportSheet('image', m.attachments[0].media_id); } }) : null,
    el('button', { class: 'btn btn-ghost btn-block', text: 'Report message', onclick: () => { close(); reportSheet('message', m.id); } }),
    !m.mine ? el('button', { class: 'btn btn-ghost btn-block', text: 'Mute user', onclick: async () => { await api.post(`/api/users/${m.user.username}/block`, { kind: 'mute' }); close(); toast('Muted'); } }) : null,
    !m.mine ? el('button', { class: 'btn btn-danger btn-block', text: 'Block user', onclick: async () => { await api.post(`/api/users/${m.user.username}/block`, { kind: 'block' }); close(); toast('Blocked'); render(); } }) : null,
    m.mine ? el('button', { class: 'btn btn-danger btn-block', text: 'Delete message', onclick: async () => { await api.del(`/api/messages/${m.id}`); close(); render(); } }) : null,
  ]));
}

// ================================================================== GROUPS
route(/^\/groups$/, async () => {
  const d = await api.get('/api/groups');
  const wrap = el('div', { class: 'stack' }, [
    el('div', { class: 'row between', style: 'margin-top:16px' }, [
      el('h2', { style: 'margin:0', text: 'Groups' }),
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Join by code', onclick: joinByCodeSheet }),
    ]),
  ]);
  wrap.append(el('button', { class: 'btn btn-ghost btn-block', text: '💬  All messages', onclick: () => go('#/chats') }));
  if (!d.groups.length) {
    wrap.append(empty('👥', 'No groups yet', 'Open an experience, tap JOIN GROUP, and bring people with you.',
      el('a', { class: 'btn btn-primary', href: '#/explore', text: 'Find something to do' })));
    return wrap;
  }
  wrap.append(el('div', { class: 'stack' }, d.groups.map((g) =>
    el('button', { class: 'tile', onclick: () => go(`#/group/${g.id}`) }, [
      el('div', { class: 'row between' }, [
        el('div', { class: 'grow' }, [
          el('h3', { text: g.name }),
          el('div', { class: 'meta', text: [g.location_name, g.planned_date && fmtDate(g.planned_date)].filter(Boolean).join(' · ') }),
        ]),
        el('span', { class: 'chip', text: `${g.member_count} members` }),
      ]),
    ]))));
  return wrap;
});

function joinByCodeSheet() {
  return sheet('Join a group', (close) => {
    const code = el('input', { placeholder: 'HOLLOW42', style: 'text-transform:uppercase' });
    return el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: 'Invite code' }), code]),
      el('button', {
        class: 'btn btn-primary btn-block', text: 'Join group',
        onclick: async () => {
          try { const r = await api.post(`/api/groups/join/${code.value.trim()}`); close(true); toast('You are in.', 'good'); go(`#/chat/${r.chat_id}`); }
          catch (e) { handleError(e); }
        },
      }),
    ]);
  });
}

route(/^\/join\/([\w]+)$/, async (code) => {
  try {
    const r = await api.post(`/api/groups/join/${code}`);
    toast('Joined the group', 'good');
    go(`#/chat/${r.chat_id}`);
    return el('div');
  } catch (e) { return errorView(e); }
});

route(/^\/group\/([\w]+)$/, async (gid) => {
  const d = await api.get(`/api/groups/${gid}`);
  return el('div', { class: 'stack' }, [
    el('h2', { style: 'margin-top:16px', text: d.group.name }),
    d.group.description ? el('p', { style: 'color:var(--ash)', text: d.group.description }) : null,
    el('div', { class: 'row wrap' }, [
      d.group.planned_date ? el('span', { class: 'chip ember', text: fmtDate(d.group.planned_date) }) : null,
      el('span', { class: 'chip', text: `Code ${d.group.invite_code}` }),
    ]),
    el('button', { class: 'btn btn-primary btn-block', text: 'Open group chat', onclick: () => go(`#/chat/${d.group.chat_id}`) }),
    el('button', { class: 'btn btn-ghost btn-block', text: 'Copy invite link', onclick: async () => { await copy(`${location.origin}/app#/join/${d.group.invite_code}`); toast('Invite link copied', 'good'); } }),
    sectionHead('Members'),
    el('div', { class: 'stack' }, d.members.map((m) => el('div', { class: 'card tight' }, [
      el('div', { class: 'row' }, [
        el('span', { style: 'font-size:1.4rem', text: m.avatar_emoji || '🎯' }),
        el('div', { class: 'grow' }, [el('strong', { text: '@' + m.username }), el('div', { class: 'meta', text: `Level ${m.level} — ${m.level_title}` })]),
        m.role === 'owner' ? el('span', { class: 'chip', text: 'Owner' }) : null,
      ]),
    ]))),
    el('button', { class: 'btn btn-danger btn-block', text: 'Leave group', onclick: async () => { if (await confirmSheet('Leave group?', 'You will stop receiving messages from this group.', 'Leave', true)) { await api.post(`/api/groups/${gid}/leave`); go('#/groups'); } } }),
  ]);
});

// =================================================================== FEED
route(/^\/feed$/, async () => {
  const d = await api.get('/api/feed');
  const wrap = el('div', { class: 'stack' }, [el('h2', { style: 'margin-top:16px', text: 'The Hunt' })]);
  if (!d.posts.length) return wrap.append(empty('🩸', 'No reports yet', 'Complete something and file the first Thrill Report.')) || wrap;
  for (const p of d.posts) {
    wrap.append(el('div', { class: 'card' }, [
      el('div', { class: 'row between' }, [
        el('div', { class: 'row' }, [
          el('span', { style: 'font-size:1.4rem', text: p.user.avatar_emoji || '🎯' }),
          el('strong', { text: '@' + p.user.username }),
        ]),
        el('small', { text: fmtDate(p.created_at) }),
      ]),
      el('button', { class: 'tile', style: 'margin:10px 0;padding:10px', onclick: () => go(`#/l/${p.location.slug}`) }, [
        el('div', { class: 'row between' }, [
          el('span', { text: `📍 ${p.location.name}` }),
          el('span', { class: 'chip', text: `${p.location.city || ''}` }),
        ]),
      ]),
      p.body ? el('p', { style: 'margin:0 0 10px', text: p.body }) : null,
      el('div', { class: 'chiprow', style: 'margin-bottom:10px' }, [
        el('span', { class: 'chip ember', text: `😱 ${p.ratings.fear ?? '—'}` }),
        el('span', { class: 'chip', text: `👻 ${p.ratings.paranormal ?? '—'}` }),
        el('span', { class: 'chip', text: `⭐ ${p.ratings.overall ?? '—'}` }),
        el('span', { class: 'chip', text: p.would_return ? 'Would return' : 'Would not return' }),
      ]),
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn btn-ghost btn-sm', text: `${p.liked ? '❤️' : '🤍'} ${p.like_count}`,
          onclick: async (e) => { const r = await api.post(`/api/feed/${p.id}/like`); e.target.textContent = `${r.liked ? '❤️' : '🤍'} ${p.like_count + (r.liked ? 1 : 0)}`; },
        }),
        el('button', { class: 'btn btn-ghost btn-sm', text: '🔖 Save', onclick: () => api.post(`/api/locations/${p.location.slug}/save`).then(() => toast('Saved')) }),
        el('button', { class: 'btn btn-ghost btn-sm', text: '📍 Open', onclick: () => go(`#/l/${p.location.slug}`) }),
        el('button', { class: 'btn btn-ghost btn-sm', text: '•••', 'aria-label': 'Report post', onclick: () => reportSheet('thrill_report', p.id) }),
      ]),
    ]));
  }
  return wrap;
});

// ===================================================================== AI
route(/^\/ai$/, async () => {
  const wrap = el('div', { class: 'stack' }, [
    el('h2', { style: 'margin-top:16px', text: 'Find my thrill' }),
    el('p', { style: 'color:var(--ash);font-size:.92rem', text: 'Describe the night you want. We build it from listings that actually exist, and tell you where the data runs out.' }),
  ]);
  const prompt = el('textarea', { placeholder: 'I want something absolutely terrifying within two hours of Omaha and I would like to camp afterward.' });
  const out = el('div', { class: 'stack' });
  wrap.append(el('div', { class: 'field' }, [prompt]),
    el('button', {
      class: 'btn btn-primary btn-block', text: 'Build my Thrill Pack',
      onclick: async (e) => {
        e.target.disabled = true; out.innerHTML = ''; out.append(skeletons(2));
        try {
          const r = await api.post('/api/ai/find-my-thrill', { prompt: prompt.value, ...(state.coords || {}) });
          out.innerHTML = '';
          out.append(packView(r));
        } catch (err) { out.innerHTML = ''; handleError(err); }
        e.target.disabled = false;
      },
    }), out);

  const hist = await api.get('/api/ai/history');
  if (hist.packs.length) {
    wrap.append(sectionHead('Recent packs'));
    wrap.append(el('div', { class: 'stack' }, hist.packs.slice(0, 5).map((h) =>
      el('button', { class: 'tile', onclick: () => { out.innerHTML = ''; out.append(packView({ pack: h.pack, disclaimer: 'Confirm hours, prices and access with the official operator before you go.' })); window.scrollTo(0, 0); } }, [
        el('h3', { text: h.pack.title }), el('div', { class: 'meta', text: h.prompt.slice(0, 80) }),
      ]))));
  }
  return wrap;
});

function packView(r) {
  const p = r.pack;
  const wrap = el('div', { class: 'stack' }, [
    el('div', { class: 'card', style: 'border-color:#6b2c11' }, [
      el('h2', { style: 'color:var(--ember)', text: p.title }),
      el('p', { style: 'margin:0;color:var(--ash)', text: p.summary }),
    ]),
  ]);
  p.stops.forEach((s, i) => {
    wrap.append(el('div', { class: 'card' }, [
      el('div', { class: 'row between' }, [
        el('span', { class: 'chip ember', text: `${i + 1} · ${s.role}` }),
        el('span', { class: 'chip', text: s.drive_minutes != null ? `${Math.floor(s.drive_minutes / 60)}h ${s.drive_minutes % 60}m drive` : 'Distance unknown' }),
      ]),
      el('h3', { style: 'margin:10px 0 4px', text: s.name }),
      el('p', { style: 'margin:0 0 8px;font-size:.9rem;color:var(--ash)', text: s.why }),
      el('div', { class: 'chiprow' }, [
        s.fear != null ? el('span', { class: 'chip', text: `Fear ${s.fear}/10` }) : null,
        s.isolation != null ? el('span', { class: 'chip', text: `Isolation ${s.isolation}/10` }) : null,
        el('span', { class: `chip ${s.data_source === 'verified' ? 'verified' : 'community'}`, text: s.data_source === 'verified' ? 'Verified' : 'Community reported' }),
        s.reservation_required ? el('span', { class: 'chip restricted', text: 'Reservation required' }) : null,
      ]),
      el('div', { style: 'margin-top:10px;font-size:.84rem;color:var(--ash)' }, [
        el('div', { text: `Hours: ${s.hours}` }), el('div', { text: `Price: ${s.price}` }),
      ]),
      el('button', { class: 'btn btn-ghost btn-block btn-sm', style: 'margin-top:10px', text: 'Open listing', onclick: () => go(`#/l/${s.slug}`) }),
    ]));
  });
  if (p.itinerary.length) {
    wrap.append(sectionHead('The run'));
    wrap.append(el('div', { class: 'card' }, p.itinerary.map((i) =>
      el('div', { class: 'row', style: 'align-items:flex-start;margin-bottom:12px' }, [
        el('span', { class: 'chip', style: 'flex:0 0 62px;justify-content:center', text: i.time }),
        el('div', { class: 'grow' }, [el('strong', { text: i.label }), el('div', { class: 'meta', text: i.detail })]),
      ]))));
  }
  if (p.unverified_notes.length) {
    wrap.append(el('div', { class: 'warning' }, [
      el('strong', { text: 'BEFORE YOU COMMIT' }),
      ...p.unverified_notes.map((n) => el('p', { style: 'margin:0 0 6px', text: n })),
    ]));
  }
  wrap.append(el('p', { style: 'font-size:.8rem;color:var(--smoke)', text: r.disclaimer }));
  return wrap;
}

// ================================================================= PROFILE
route(/^\/profile$/, async () => {
  if (!state.user) return authView();
  await refreshSession();
  const u = state.user;
  const saved = await api.get('/api/saved');
  const me = await api.get(`/api/users/${u.username}`);
  const nextAt = me.user.next_at || (u.xp + 1000);
  return el('div', { class: 'stack' }, [
    el('div', { class: 'card', style: 'margin-top:16px' }, [
      el('div', { class: 'row' }, [
        el('span', { style: 'font-size:2.4rem', text: u.avatar_emoji }),
        el('div', { class: 'grow' }, [
          el('h2', { style: 'margin:0', text: '@' + u.username }),
          el('div', { class: 'meta', text: `Level ${u.level} — ${me.user.level_title} · ${u.xp.toLocaleString()} XP` }),
        ]),
        state.isPro ? el('span', { class: 'chip pro', text: 'PRO' }) : null,
      ]),
      u.bio ? el('p', { style: 'margin:12px 0 0;font-size:.92rem', text: u.bio }) : null,
      el('div', { class: 'xpbar', style: 'margin-top:12px' }, [el('i', { style: `width:${Math.min(100, (u.xp / nextAt) * 100)}%` })]),
      me.user.next_title ? el('small', { text: `${(nextAt - u.xp).toLocaleString()} XP to ${me.user.next_title}` }) : null,
    ]),
    el('div', { class: 'statgrid' }, [
      ['adventures', 'Adventures'], ['haunted', 'Haunted attractions'], ['camping', 'Camping trips'],
      ['night', 'Night adventures'], ['thrill_reports', 'Thrill Reports'], ['groups', 'Groups'],
    ].map(([k, label]) => el('div', { class: 'stat' }, [
      el('div', { class: 'n', text: String(me.stats[k] ?? 0) }), el('div', { class: 'l', text: label }),
    ]))),
    sectionHead('Badges'),
    me.user.badges.length
      ? el('div', { class: 'badgegrid' }, me.user.badges.map((b) => el('div', { class: 'b' }, [el('span', { class: 'ico', text: b.icon }), b.name])))
      : el('p', { style: 'color:var(--ash);font-size:.9rem', text: 'No badges yet. File a Thrill Report to earn First Blood.' }),
    sectionHead('Saved'),
    saved.results.length ? el('div', { class: 'stack' }, saved.results.map(locationTile)) : el('p', { style: 'color:var(--ash);font-size:.9rem', text: 'Nothing saved yet.' }),
    el('div', { class: 'stack', style: 'margin-top:18px' }, [
      el('button', { class: 'btn btn-ghost btn-block', text: '🩸  The Hunt feed', onclick: () => go('#/feed') }),
      el('button', { class: 'btn btn-ghost btn-block', text: '🔔  Notifications', onclick: () => go('#/notifications') }),
      el('button', { class: 'btn btn-ghost btn-block', text: '🚨  Trip check-in', onclick: () => go('#/trip') }),
      state.isPro ? el('button', { class: 'btn btn-ghost btn-block', text: '💳  Manage subscription', onclick: () => go('#/pro') })
        : el('button', { class: 'btn btn-pro btn-block', text: '⚡  Upgrade to THRILLHUNT PRO', onclick: () => go('#/pro') }),
      el('button', { class: 'btn btn-ghost btn-block', text: '⚙️  Settings & privacy', onclick: () => go('#/settings') }),
      el('button', { class: 'btn btn-ghost btn-block', text: '📜  Community Guidelines', onclick: () => go('#/guidelines') }),
      u.role === 'admin' || u.role === 'moderator' ? el('a', { class: 'btn btn-ghost btn-block', href: '/admin', text: '🛡️  Admin dashboard' }) : null,
      el('button', { class: 'btn btn-danger btn-block', text: 'Sign out', onclick: async () => { await api.post('/api/auth/logout'); state.user = null; go('#/join'); location.reload(); } }),
    ]),
  ]);
});

// ================================================================ SETTINGS
route(/^\/settings$/, async () => {
  await refreshSession();
  const u = state.user;
  const p = u.privacy;
  const mk = (key, label, help) => {
    const box = el('input', { type: 'checkbox', checked: p[key] });
    box.addEventListener('change', async () => { await api.patch('/api/me', { [key]: box.checked }); toast('Saved'); });
    return el('label', { class: 'checkline' }, [box, el('span', {}, [el('strong', { text: label }), el('div', { class: 'meta', text: help })])]);
  };
  const vis = el('select', {}, [['public', 'Anyone'], ['members', 'Signed-in hunters'], ['private', 'Nobody']].map(([v, l]) => el('option', { value: v, selected: p.profile_visibility === v, text: l })));
  vis.addEventListener('change', () => api.patch('/api/me', { profile_visibility: vis.value }).then(() => toast('Saved')));
  const dm = el('select', {}, [['everyone', 'Anyone'], ['requests', 'Anyone, as a request'], ['groups_only', 'Only people in my groups'], ['nobody', 'Nobody']].map(([v, l]) => el('option', { value: v, selected: p.dm_policy === v, text: l })));
  dm.addEventListener('change', () => api.patch('/api/me', { dm_policy: dm.value }).then(() => toast('Saved')));
  const bio = el('textarea', { value: u.bio || '' });

  return el('div', { class: 'stack' }, [
    el('h2', { style: 'margin-top:16px', text: 'Settings & privacy' }),
    el('div', { class: 'card' }, [
      el('h3', { text: 'Profile' }),
      el('div', { class: 'field' }, [el('label', { text: 'Bio' }), bio]),
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Save bio', onclick: async () => { await api.patch('/api/me', { bio: bio.value }); toast('Saved', 'good'); } }),
    ]),
    el('div', { class: 'card' }, [
      el('h3', { text: 'Who can see me' }),
      el('div', { class: 'field' }, [el('label', { text: 'Profile visible to' }), vis]),
      el('div', { class: 'field' }, [el('label', { text: 'Who can message me' }), dm]),
      mk('discoverable_nearby', 'Appear in nearby searches', 'Others can find you when browsing experiences near them.'),
      mk('attendance_public', 'Show when I am going', 'Your name appears under Who\'s Going for that date.'),
      mk('activity_public', 'Show my Thrill Reports in the feed', 'Reports stay on the location page either way.'),
      mk('share_coarse_location', 'Use my area for distances', 'Only ever shown to others as “12 miles away”, never as coordinates.'),
    ]),
    el('div', { class: 'card' }, [
      el('h3', { text: 'What we never share' }),
      el('p', { style: 'margin:0;font-size:.88rem;color:var(--ash)', text: 'Your exact location, home address, coordinates, email and private trip plans are never shown to other users. Distances between you and a location are rounded before they leave our servers.' }),
    ]),
    el('button', { class: 'btn btn-ghost btn-block', text: 'Blocked & muted hunters', onclick: async () => { const b = await api.get('/api/blocks'); sheet('Blocked & muted', () => el('div', { class: 'stack' }, b.blocks.length ? b.blocks.map((x) => el('div', { class: 'row between' }, [el('span', { text: '@' + (x.user?.username ?? 'hunter') }), el('button', { class: 'btn btn-ghost btn-sm', text: 'Undo', onclick: async (e) => { await api.post(`/api/users/${x.user.username}/block`, { kind: x.kind, undo: true }); e.target.disabled = true; } })])) : [el('p', { text: 'Nobody blocked.' })])); } }),
    el('button', { class: 'btn btn-ghost btn-block', text: 'Submit an appeal', onclick: () => sheet('Appeal a decision', (close) => { const body = el('textarea', { placeholder: 'Tell us what happened.' }); return el('div', {}, [el('div', { class: 'field' }, [body]), el('button', { class: 'btn btn-primary btn-block', text: 'Submit appeal', onclick: async () => { try { const r = await api.post('/api/appeals', { body: body.value }); close(); toast(r.message, 'good'); } catch (e) { handleError(e); } } })]); }) }),
  ]);
});

// ===================================================================== PRO
route(/^\/pro.*$/, async () => {
  const d = await api.get('/api/pro');
  const sub = d.subscription;
  const wrap = el('div', { class: 'stack' }, [
    el('div', { class: 'card', style: 'margin-top:16px;border-color:#4a3b86;background:linear-gradient(180deg,#1c1633,#120f22)' }, [
      el('span', { class: 'chip pro', text: 'THRILLHUNT PRO' }),
      el('h1', { style: 'font-size:2rem;margin:12px 0 4px', text: d.price_display }),
      el('p', { style: 'color:var(--ash);margin:0', text: 'Cancel anytime. Access continues to the end of the period.' }),
    ]),
    el('div', { class: 'card' }, [
      el('h3', { text: 'What you get' }),
      el('div', { class: 'stack' }, d.plan.features.map((f) => el('div', { class: 'row' }, [el('span', { text: '▸' }), el('span', { text: f })]))),
    ]),
  ]);

  if (sub?.is_pro) {
    wrap.append(el('div', { class: 'card' }, [
      el('h3', { text: 'Your subscription' }),
      el('p', { style: 'margin:0 0 10px;color:var(--ash)', text: `Status: ${sub.status}${sub.cancel_at_period_end ? ' (cancels at period end)' : ''}${sub.current_period_end ? ` · renews ${fmtDate(sub.current_period_end)}` : ''}` }),
      el('button', { class: 'btn btn-ghost btn-block', text: 'Manage billing', onclick: async () => { const r = await api.post('/api/pro/portal'); location.href = r.url; } }),
      !sub.cancel_at_period_end ? el('button', {
        class: 'btn btn-danger btn-block', style: 'margin-top:10px', text: 'Cancel subscription',
        onclick: async () => { if (await confirmSheet('Cancel PRO?', 'You keep image uploads and advanced planning until the end of the current period.', 'Cancel subscription', true)) { const r = await api.post('/api/pro/cancel'); toast(r.message); render(); } },
      }) : null,
    ]));
  } else {
    wrap.append(el('button', {
      class: 'btn btn-pro btn-block', text: 'UPGRADE TO PRO',
      onclick: async () => { const r = await api.post('/api/pro/checkout'); location.href = r.checkout_url; },
    }));
    wrap.append(el('button', { class: 'btn btn-ghost btn-block', text: 'Restore subscription', onclick: async () => { const r = await api.post('/api/pro/restore'); await refreshSession(); toast(r.restored ? 'Subscription restored' : 'No active subscription found'); render(); } }));
  }
  wrap.append(el('p', { style: 'font-size:.78rem;color:var(--smoke)', text: `Payments are processed by ${d.provider === 'stripe' ? 'Stripe' : 'a sandbox provider in this build'}. THRILLHUNT never stores your card details.` }));
  return wrap;
});

export function showUpsell(upsell) {
  const u = upsell || {
    title: '📸 IMAGE MESSAGES ARE A THRILLHUNT PRO FEATURE',
    body: 'Upgrade to THRILLHUNT PRO to share photos in chats, groups and adventures.',
    cta: 'UPGRADE TO PRO',
  };
  return sheet(u.title, (close) => el('div', { class: 'stack' }, [
    el('p', { style: 'color:var(--ash)', text: u.body }),
    el('button', { class: 'btn btn-pro btn-block', text: u.cta, onclick: () => { close(); go('#/pro'); } }),
    el('button', { class: 'btn btn-ghost btn-block', text: 'Not now', onclick: () => close(null) }),
  ]));
}

// ============================================================ NOTIFICATIONS
route(/^\/notifications$/, async () => {
  const d = await api.get('/api/notifications');
  api.post('/api/notifications/read').catch(() => {});
  const wrap = el('div', { class: 'stack' }, [el('h2', { style: 'margin-top:16px', text: 'Notifications' })]);
  if (!d.notifications.length) return wrap.append(empty('🔔', 'Nothing yet', 'Mark yourself going somewhere and we will tell you when the group fills up.')) || wrap;
  wrap.append(el('div', { class: 'stack' }, d.notifications.map((n) =>
    el('button', { class: 'tile', onclick: () => n.link && (location.hash = n.link.replace('/app', '')) }, [
      el('strong', { text: n.title }),
      n.body ? el('div', { class: 'meta', text: n.body }) : null,
      el('small', { text: fmtDate(n.created_at) }),
    ]))));
  return wrap;
});

// ================================================================== TRIP
route(/^\/trip$/, async () => {
  const d = await api.get('/api/trips');
  const title = el('input', { placeholder: 'Hollow Creek Saturday' });
  const name = el('input', { placeholder: 'Who should know where you are?' });
  const contact = el('input', { placeholder: 'Phone or email' });
  const wrap = el('div', { class: 'stack' }, [
    el('h2', { style: 'margin-top:16px', text: 'Trip check-in' }),
    el('div', { class: 'warning' }, [
      el('strong', { text: 'THRILLHUNT IS NOT AN EMERGENCY SERVICE' }),
      el('p', { style: 'margin:0', text: 'We do not monitor check-ins in real time and cannot dispatch help. In an emergency, contact your local emergency services.' }),
    ]),
    el('div', { class: 'card' }, [
      el('h3', { text: 'Set up a check-in' }),
      el('p', { style: 'font-size:.88rem;color:var(--ash)', text: 'Consider sharing your itinerary with someone you trust. Your emergency contact is stored privately and never shown to other hunters.' }),
      el('div', { class: 'field' }, [el('label', { text: 'Trip' }), title]),
      el('div', { class: 'field' }, [el('label', { text: 'Emergency contact name' }), name]),
      el('div', { class: 'field' }, [el('label', { text: 'How to reach them' }), contact]),
      el('button', {
        class: 'btn btn-primary btn-block', text: 'START TRIP',
        onclick: async () => {
          const r = await api.post('/api/trips', { title: title.value || 'Untitled trip', emergency_contact_name: name.value, emergency_contact_value: contact.value });
          await api.post(`/api/trips/${r.trip_id}/start`, { hours: 12 });
          toast('Check-in started. We will ask if you are back.', 'good');
          render();
        },
      }),
    ]),
  ]);
  const active = d.trips.filter((t) => t.status === 'active');
  if (active.length) {
    wrap.append(sectionHead('Open check-ins'));
    for (const t of active) {
      wrap.append(el('div', { class: 'card' }, [
        el('strong', { text: t.title }),
        el('div', { class: 'meta', text: `Due back ${fmtDate(t.checkin_due_at)}` }),
        el('div', { class: 'row', style: 'margin-top:10px' }, [
          el('button', { class: 'btn btn-primary grow', text: "✅ I'm home", onclick: async () => { const r = await api.post(`/api/trips/${t.id}/checkin`, { outcome: 'home' }); toast(r.message, 'good'); render(); } }),
          el('button', { class: 'btn btn-danger grow', text: '🚨 I need help', onclick: async () => { const r = await api.post(`/api/trips/${t.id}/checkin`, { outcome: 'help_requested' }); sheet('Get help now', () => el('div', {}, [el('p', { text: r.message }), el('a', { class: 'btn btn-primary btn-block', href: 'tel:911', text: 'Call emergency services' })])); } }),
        ]),
      ]));
    }
  }
  return wrap;
});

// ============================================================== GUIDELINES
route(/^\/guidelines$/, () => {
  const allowed = ['Horror and haunted attraction content', 'Paranormal discussion and investigation', 'Camping and outdoor adventure', 'Halloween imagery, costumes and makeup', 'Adventure sports and heights', 'Appropriate scary content, including fake blood'];
  const banned = ['Sexual exploitation and any sexual content involving minors', 'Non-consensual sexual content', 'Graphic real-world gore', 'Credible threats and doxxing', 'Harassment and hate content', 'Dangerous challenges designed to cause injury', 'Instructions for trespassing or bypassing security', 'Instructions facilitating illegal activity', 'Fraud, scams and malicious spam'];
  return el('div', { class: 'stack' }, [
    el('h2', { style: 'margin-top:16px', text: 'Community Guidelines' }),
    el('div', { class: 'card', style: 'border-color:#6b2c11' }, [
      el('p', { style: 'margin:0;font-size:1rem', text: 'THRILLHUNT is for adults who love adventure, not for people looking to harm themselves or others.' }),
    ]),
    el('div', { class: 'card' }, [el('h3', { text: 'Bring this' }), el('div', { class: 'stack' }, allowed.map((a) => el('div', { class: 'row' }, [el('span', { text: '✓' }), el('span', { text: a })])))]),
    el('div', { class: 'card' }, [el('h3', { text: 'Never this' }), el('div', { class: 'stack' }, banned.map((a) => el('div', { class: 'row' }, [el('span', { text: '✕' }), el('span', { text: a })])))]),
    el('div', { class: 'card' }, [
      el('h3', { text: 'What happens when someone breaks the rules' }),
      el('p', { style: 'margin:0;font-size:.9rem;color:var(--ash)', text: 'First violation: a warning and the content comes down. Repeated violations: temporary posting restrictions. Serious or repeated violations: suspension or a permanent ban. Every decision can be appealed from Settings, and a human reviews appeals.' }),
    ]),
  ]);
});

route(/^\/safety$/, () => el('div', { class: 'stack' }, [
  el('h2', { style: 'margin-top:16px', text: 'Safety' }),
  thrillWarning([
    'This experience may involve physical, environmental, or other inherent risks. Information submitted by users may be inaccurate or outdated.',
    'Verify conditions and access with the official property/operator before visiting. Follow posted rules, applicable laws, weather advisories, and safety instructions. Never enter restricted or private areas without authorization.',
    'THRILLHUNT does not guarantee the safety, accuracy, legality, or availability of any location or activity.',
  ]),
  el('div', { class: 'card' }, [
    el('h3', { text: 'What THRILLHUNT is not' }),
    el('p', { style: 'margin:0;font-size:.9rem;color:var(--ash)', text: 'Not a safety authority. Not an emergency service. Not a guarantee of any location\'s safety or legality. Not a substitute for professional guides or official property information.' }),
  ]),
]));

// ------------------------------------------------------------------ errors
function handleError(e) {
  if (e instanceof ApiError && e.code === 'subscription_required') { showUpsell(e.payload.upsell); return; }
  if (e instanceof ApiError && (e.code === 'image_blocked' || e.code === 'content_blocked')) { toast(e.message, 'bad'); return; }
  if (e instanceof ApiError && e.status === 401) { go('#/join'); return; }
  toast(e.message || 'Something went wrong', 'bad');
}

// ------------------------------------------------------------------- boot
window.addEventListener('hashchange', render);
(async () => {
  state.bootstrap = await api.get('/api/bootstrap');
  state.user = state.bootstrap.session;
  if (!state.user && !location.hash.startsWith('#/join') && !location.hash.startsWith('#/login')) location.hash = '#/join';
  if (!location.hash) location.hash = '#/home';
  for (const btn of tabbar.querySelectorAll('button')) {
    btn.addEventListener('click', () => go({ home: '#/home', explore: '#/explore', map: '#/map', groups: '#/groups', profile: '#/profile' }[btn.dataset.tab]));
  }
  render();
})();
