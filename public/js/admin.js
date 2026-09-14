import { api, state, ApiError } from './api.js';
import { el, toast, sheet, confirmSheet, empty, skeletons, fmtDate, money } from './ui.js';

const view = document.getElementById('view');
const nav = document.getElementById('adminnav');
let role = 'moderator';

const views = {};
const label = (t) => el('h2', { style: 'margin:4px 0 14px', text: t });

async function show(name) {
  for (const b of nav.querySelectorAll('button')) b.setAttribute('aria-current', b.dataset.view === name ? 'page' : 'false');
  location.hash = '#' + name;
  view.innerHTML = '';
  view.append(skeletons(2));
  try {
    const node = await views[name]();
    view.innerHTML = '';
    view.append(node);
  } catch (e) {
    view.innerHTML = '';
    if (e instanceof ApiError && e.status === 401) {
      view.append(empty('🔒', 'Sign in required', 'Sign in with a staff account first.',
        el('a', { class: 'btn btn-primary', href: '/app#/login', text: 'Go to sign in' })));
    } else if (e instanceof ApiError && e.status === 403) {
      view.append(empty('🛡️', 'Not available to your role', e.message));
    } else {
      view.append(empty('⚠️', 'Could not load', e.message));
    }
  }
}

// ------------------------------------------------------------ safety center
views.overview = async () => {
  const d = await api.get('/api/admin/overview');
  role = d.role;
  const s = d.safety_center, a = d.analytics;
  const card = (n, l, alert) => el('div', { class: `stat${alert ? ' alert' : ''}` }, [
    el('div', { class: 'n', text: String(n) }), el('div', { class: 'l', text: l }),
  ]);
  return el('div', { class: 'stack' }, [
    label('Safety Center'),
    el('p', { style: 'color:var(--ash);font-size:.9rem;margin-top:-8px', text: 'Queues that need a human. Anything flagged critical is already hidden from users pending review.' }),
    el('div', { class: 'statgrid' }, [
      card(s.open_cases, 'Open moderation cases', s.open_cases > 0),
      card(s.pending_images, 'Images awaiting review', s.pending_images > 0),
      card(s.open_safety, 'Open safety reports', s.open_safety > 0),
      card(s.open_appeals, 'Appeals to decide', s.open_appeals > 0),
      card(s.repeat_offenders, 'Repeat offenders', s.repeat_offenders > 0),
      card(s.suspended_users, 'Suspended or banned'),
      card(s.blocked_images, 'Images blocked'),
      card(s.approved_images, 'Images approved'),
    ]),
    label('Platform'),
    el('div', { class: 'statgrid' }, [
      card(a.users, 'Hunters'), card(a.new_users_7d, 'New this week'), card(a.pro_subscribers, 'PRO subscribers'),
      card(a.locations, 'Locations'), card(a.verified_locations, 'Verified locations'), card(a.thrill_reports, 'Thrill Reports'),
      card(a.going_marks, "“I'm going” marks"), card(a.groups, 'Groups'), card(a.messages_24h, 'Messages (24h)'),
      card(a.images_uploaded, 'Images uploaded'), card(a.ai_packs_7d, 'AI packs (7d)'),
    ]),
  ]);
};

// --------------------------------------------------------------- moderation
views.cases = async () => {
  const d = await api.get('/api/admin/cases?status=open');
  if (!d.cases.length) return el('div', {}, [label('Moderation queue'), empty('✅', 'Queue is clear', 'No open cases right now.')]);
  return el('div', { class: 'stack' }, [
    label('Moderation queue'),
    ...d.cases.map((c) => el('div', { class: `card${c.severity === 'critical' ? '' : ''}`, style: c.severity === 'critical' ? 'border-color:#5b2526' : '' }, [
      el('div', { class: 'row between wrap' }, [
        el('div', { class: 'chiprow' }, [
          el('span', { class: `chip ${c.severity === 'critical' ? 'restricted' : 'community'}`, text: c.severity.toUpperCase() }),
          el('span', { class: 'chip', text: c.subject_type }),
          el('span', { class: 'chip', text: c.source }),
        ]),
        el('small', { text: fmtDate(c.created_at) }),
      ]),
      c.owner ? el('p', { style: 'margin:10px 0 4px;font-size:.9rem' , text: `Author @${c.owner.username} — ${c.owner.violation_count} prior violation(s), account ${c.owner.status}` }) : null,
      c.subject_preview ? el('div', { class: 'card flat tight', style: 'margin:8px 0' }, [
        c.subject_preview.url ? el('img', { src: c.subject_preview.url, alt: 'Reported image', style: 'max-width:240px;border-radius:8px' })
          : el('p', { style: 'margin:0;font-size:.9rem', text: c.subject_preview.body || JSON.stringify(c.subject_preview).slice(0, 240) }),
      ]) : null,
      c.reports.length ? el('div', { class: 'chiprow', style: 'margin-bottom:10px' }, c.reports.map((r) => el('span', { class: 'chip', text: r.reason }))) : null,
      el('div', { class: 'row wrap' }, [
        ...[['approve', 'Approve'], ['remove_content', 'Remove content'], ['warn', 'Warn'], ['restrict', 'Restrict'], ['suspend', 'Suspend'], ['ban', 'Ban'], ['dismiss', 'Dismiss'], ['escalate', 'Escalate']]
          .map(([action, text]) => el('button', {
            class: `btn btn-sm ${action === 'ban' || action === 'suspend' ? 'btn-danger' : 'btn-ghost'}`, text,
            onclick: () => actOnCase(c, action),
          })),
      ]),
    ])),
  ]);
};

function actOnCase(c, action) {
  return sheet(`${action.replace('_', ' ')} — case`, (close) => {
    const reason = el('textarea', { placeholder: 'Reason (shown to the user for warnings and enforcement)' });
    return el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: 'Reason' }), reason]),
      el('button', {
        class: 'btn btn-primary btn-block', text: 'Apply decision',
        onclick: async () => {
          try { await api.post(`/api/admin/cases/${c.id}/action`, { action, reason: reason.value }); close(); toast('Decision recorded', 'good'); show('cases'); }
          catch (e) { toast(e.message, 'bad'); }
        },
      }),
    ]);
  });
}

// -------------------------------------------------------------- image queue
views.media = async () => {
  const d = await api.get('/api/admin/media/queue');
  if (!d.media.length) return el('div', {}, [label('Image review queue'), empty('🖼️', 'Nothing pending', 'Every uploaded image has a decision.')]);
  return el('div', { class: 'stack' }, [
    label('Image review queue'),
    el('p', { style: 'color:var(--ash);font-size:.9rem;margin-top:-8px', text: 'These images are not visible to other users until approved.' }),
    ...d.media.map((m) => el('div', { class: 'card' }, [
      el('div', { class: 'row between wrap' }, [
        el('div', {}, [el('strong', { text: '@' + (m.username || 'unknown') }), el('div', { class: 'meta', text: `${m.mime} · ${(m.bytes / 1024).toFixed(0)} KB · ${fmtDate(m.created_at)}` })]),
        el('div', { class: 'chiprow' }, [el('span', { class: 'chip', text: m.provider }), ...m.labels.map((l) => el('span', { class: 'chip community', text: l }))]),
      ]),
      el('img', { src: m.url, alt: 'Image awaiting review', style: 'max-width:260px;border-radius:10px;margin:10px 0;display:block' }),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Approve', onclick: async () => { await api.post(`/api/admin/media/${m.id}/decide`, { decision: 'approve' }); toast('Approved', 'good'); show('media'); } }),
        el('button', { class: 'btn btn-danger btn-sm', text: 'Block & strike', onclick: async () => { if (await confirmSheet('Block this image?', 'The file is deleted and a strike is recorded against the uploader.', 'Block image', true)) { await api.post(`/api/admin/media/${m.id}/decide`, { decision: 'block' }); toast('Blocked'); show('media'); } } }),
      ]),
    ])),
  ]);
};

// ------------------------------------------------------------ safety reports
views.safety = async () => {
  const d = await api.get('/api/admin/safety-reports');
  if (!d.reports.length) return el('div', {}, [label('Safety reports'), empty('🛡️', 'No open reports', 'Users have not flagged any listing problems.')]);
  return el('div', { class: 'stack' }, [
    label('Safety reports'),
    ...d.reports.map((r) => el('div', { class: 'card', style: r.severity === 'critical' ? 'border-color:#5b2526' : '' }, [
      el('div', { class: 'row between' }, [
        el('strong', { text: r.location_name }),
        el('span', { class: `chip ${r.severity === 'critical' ? 'restricted' : 'community'}`, text: `${r.issue_type} · ${r.severity}` }),
      ]),
      el('p', { style: 'margin:8px 0;font-size:.9rem', text: r.body || '(no detail provided)' }),
      el('small', { text: `Reported by @${r.username || 'unknown'} · ${fmtDate(r.created_at)}` }),
      el('div', { class: 'row', style: 'margin-top:10px' }, [
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Resolve — listing updated', onclick: () => resolveSafety(r.id, 'resolved') }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Dismiss', onclick: () => resolveSafety(r.id, 'dismissed') }),
        el('a', { class: 'btn btn-ghost btn-sm', href: `/app#/l/${r.slug}`, target: '_blank', text: 'Open listing' }),
      ]),
    ])),
  ]);
};

async function resolveSafety(id, status) {
  const note = prompt('Resolution note (optional):') ?? '';
  await api.post(`/api/admin/safety-reports/${id}/resolve`, { status, resolution: note });
  toast('Updated', 'good');
  show('safety');
}

// -------------------------------------------------------------------- users
views.users = async () => {
  const search = el('input', { placeholder: 'Search email or username', style: 'max-width:320px' });
  const body = el('div', {});
  const load = async () => {
    const d = await api.get(`/api/admin/users?q=${encodeURIComponent(search.value)}`);
    body.innerHTML = '';
    body.append(el('table', { class: 'admin' }, [
      el('thead', {}, [el('tr', {}, [...['User', 'Role', 'Status', 'Strikes', 'XP', 'PRO', '18+ confirmed', ''].map((h) => el('th', { text: h }))])]),
      el('tbody', {}, d.users.map((u) => el('tr', {}, [
        el('td', {}, [el('strong', { text: '@' + (u.username || '—') }), el('div', { class: 'meta', text: u.email })]),
        el('td', { text: u.role }),
        el('td', { text: u.status }),
        el('td', { text: String(u.violation_count) }),
        el('td', { text: String(u.xp ?? 0) }),
        el('td', { text: u.is_pro ? 'Yes' : 'No' }),
        el('td', { text: u.age_confirmed_at ? fmtDate(u.age_confirmed_at) : '—' }),
        el('td', {}, [el('button', { class: 'btn btn-ghost btn-sm', text: 'Manage', onclick: () => manageUser(u) })]),
      ]))),
    ]));
  };
  search.addEventListener('input', () => load());
  await load();
  return el('div', { class: 'stack' }, [label('Users'), search, body]);
};

function manageUser(u) {
  return sheet(`@${u.username}`, (close) => {
    const stat = el('select', {}, ['active', 'restricted', 'suspended', 'banned'].map((s) => el('option', { value: s, selected: u.status === s, text: s })));
    const reason = el('input', { placeholder: 'Reason' });
    return el('div', { class: 'stack' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Account status' }), stat]),
      el('div', { class: 'field' }, [el('label', { text: 'Reason' }), reason]),
      el('button', {
        class: 'btn btn-primary btn-block', text: 'Update status',
        onclick: async () => {
          try { await api.post(`/api/admin/users/${u.id}/status`, { status: stat.value, reason: reason.value }); close(); toast('Updated', 'good'); show('users'); }
          catch (e) { toast(e.message, 'bad'); }
        },
      }),
      el('button', {
        class: 'btn btn-ghost btn-block', text: u.is_pro ? 'Revoke image uploads' : 'Grant image uploads (comp)',
        onclick: async () => {
          try { await api.post(`/api/admin/users/${u.id}/entitlement`, { key: 'image_upload', granted: !u.is_pro, reason: reason.value || 'Manual adjustment' }); close(); toast('Entitlement updated', 'good'); show('users'); }
          catch (e) { toast(e.message, 'bad'); }
        },
      }),
    ]);
  });
}

// ---------------------------------------------------------------- locations
views.locations = async () => {
  const d = await api.get('/api/admin/locations');
  return el('div', { class: 'stack' }, [
    label('Locations'),
    el('table', { class: 'admin' }, [
      el('thead', {}, [el('tr', {}, ['Name', 'Where', 'Source', 'Verification', 'Access', 'Safety', ''].map((h) => el('th', { text: h })))]),
      el('tbody', {}, d.locations.map((l) => el('tr', {}, [
        el('td', {}, [el('strong', { text: l.name }), l.is_demo ? el('span', { class: 'chip demo', style: 'margin-left:6px', text: 'sample' }) : null]),
        el('td', { text: [l.city, l.region].filter(Boolean).join(', ') }),
        el('td', { text: l.data_source }),
        el('td', { text: l.verification_status }),
        el('td', { text: l.access_policy }),
        el('td', { text: l.safety_level || 'unset' }),
        el('td', {}, [
          el('button', { class: 'btn btn-ghost btn-sm', text: 'Verify', onclick: async () => { await api.post(`/api/admin/locations/${l.id}/verify`, { verification_status: 'verified' }); toast('Marked verified', 'good'); show('locations'); } }),
          el('button', { class: 'btn btn-ghost btn-sm', text: 'Edit', onclick: () => editLocation(l) }),
        ]),
      ]))),
    ]),
  ]);
};

function editLocation(l) {
  return sheet(l.name, (close) => {
    const access = el('select', {}, ['open', 'ticketed', 'reservation', 'permit', 'guided', 'private_closed'].map((v) => el('option', { value: v, selected: l.access_policy === v, text: v })));
    const safety = el('select', {}, ['', 'low', 'caution', 'elevated', 'high'].map((v) => el('option', { value: v, selected: (l.safety_level || '') === v, text: v || 'unknown (shows “Information unavailable”)' })));
    const source = el('select', {}, ['verified', 'community', 'restricted'].map((v) => el('option', { value: v, selected: l.data_source === v, text: v })));
    return el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: 'Access policy' }), access]),
      el('div', { class: 'field' }, [el('label', { text: 'Safety level' }), safety]),
      el('div', { class: 'field' }, [el('label', { text: 'Data source' }), source]),
      el('p', { style: 'font-size:.82rem;color:var(--ash)', text: 'Leave safety level unknown unless it is confirmed. The app shows “Information unavailable” rather than a guess.' }),
      el('button', {
        class: 'btn btn-primary btn-block', text: 'Save changes',
        onclick: async () => {
          const patch = { access_policy: access.value, data_source: source.value };
          if (safety.value) patch.safety_level = safety.value;
          try { await api.patch(`/api/admin/locations/${l.id}`, patch); close(); toast('Saved', 'good'); show('locations'); }
          catch (e) { toast(e.message, 'bad'); }
        },
      }),
    ]);
  });
}

// ------------------------------------------------------------------ appeals
views.appeals = async () => {
  const d = await api.get('/api/admin/appeals');
  if (!d.appeals.length) return el('div', {}, [label('Appeals'), empty('⚖️', 'No open appeals', 'Nothing to decide.')]);
  return el('div', { class: 'stack' }, [
    label('Appeals'),
    ...d.appeals.map((a) => el('div', { class: 'card' }, [
      el('div', { class: 'row between' }, [el('strong', { text: '@' + (a.username || 'unknown') }), el('small', { text: fmtDate(a.created_at) })]),
      el('p', { style: 'margin:8px 0;font-size:.9rem', text: a.body }),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Grant appeal', onclick: () => decideAppeal(a.id, 'granted') }),
        el('button', { class: 'btn btn-danger btn-sm', text: 'Deny appeal', onclick: () => decideAppeal(a.id, 'denied') }),
      ]),
    ])),
  ]);
};

async function decideAppeal(id, decision) {
  const note = prompt('Note to the user (optional):') ?? '';
  try { await api.post(`/api/admin/appeals/${id}/decide`, { decision, resolution: note }); toast('Appeal decided', 'good'); show('appeals'); }
  catch (e) { toast(e.message, 'bad'); }
}

// --------------------------------------------------------------- businesses
views.businesses = async () => {
  const d = await api.get('/api/admin/businesses');
  if (!d.businesses.length) return el('div', {}, [label('Business claims'), empty('🏢', 'No claims yet', 'Operators can claim their listing from the location page.')]);
  return el('div', { class: 'stack' }, [
    label('Business claims'),
    ...d.businesses.map((b) => el('div', { class: 'card' }, [
      el('div', { class: 'row between' }, [
        el('div', {}, [el('strong', { text: b.legal_name }), el('div', { class: 'meta', text: b.location_name })]),
        el('span', { class: 'chip', text: b.claim_status }),
      ]),
      el('div', { class: 'row', style: 'margin-top:10px' }, [
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Verify claim', onclick: async () => { await api.post(`/api/admin/businesses/${b.id}/decide`, { claim_status: 'verified' }); toast('Verified', 'good'); show('businesses'); } }),
        el('button', { class: 'btn btn-danger btn-sm', text: 'Reject', onclick: async () => { await api.post(`/api/admin/businesses/${b.id}/decide`, { claim_status: 'rejected' }); toast('Rejected'); show('businesses'); } }),
      ]),
    ])),
  ]);
};

// ---------------------------------------------------------------- config
views.config = async () => {
  const d = await api.get('/api/admin/config');
  const entries = Object.entries(d.config).sort(([a], [b]) => a.localeCompare(b));
  const wrap = el('div', { class: 'stack' }, [
    label('Configuration'),
    el('p', { style: 'color:var(--ash);font-size:.9rem;margin-top:-8px', text: 'Pricing, entitlements, upload limits, AI caps and the enforcement ladder live here. Nothing in this list is hard-coded in the app.' }),
  ]);
  const plan = d.config['pro.plan'];
  wrap.append(el('div', { class: 'card' }, [
    el('h3', { text: 'PRO price' }),
    el('p', { style: 'margin:0 0 10px;color:var(--ash)', text: `Currently ${money(plan.price_cents, plan.currency)} per ${plan.interval}.` }),
    el('button', { class: 'btn btn-ghost btn-sm', text: 'Change price', onclick: () => changePrice(plan) }),
  ]));
  for (const [key, value] of entries) {
    const ta = el('textarea', { style: 'font-family:ui-monospace,monospace;font-size:.8rem;min-height:130px' });
    ta.value = JSON.stringify(value, null, 2);
    wrap.append(el('div', { class: 'card' }, [
      el('h3', { text: key }),
      ta,
      el('button', {
        class: 'btn btn-ghost btn-sm', style: 'margin-top:8px', text: 'Save',
        onclick: async () => {
          let parsed;
          try { parsed = JSON.parse(ta.value); } catch { toast('That is not valid JSON', 'bad'); return; }
          try { await api.post('/api/admin/config', { key, value: parsed }); toast(`${key} saved`, 'good'); }
          catch (e) { toast(e.message, 'bad'); }
        },
      }),
    ]));
  }
  return wrap;
};

function changePrice(plan) {
  return sheet('Change PRO price', (close) => {
    const amount = el('input', { type: 'number', step: '0.01', value: (plan.price_cents / 100).toFixed(2) });
    return el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: `Price per ${plan.interval} (${plan.currency.toUpperCase()})` }), amount]),
      el('p', { style: 'font-size:.82rem;color:var(--ash)', text: 'Existing subscribers keep their current price until their billing provider plan is changed too.' }),
      el('button', {
        class: 'btn btn-primary btn-block', text: 'Save price',
        onclick: async () => {
          const next = { ...plan, price_cents: Math.round(parseFloat(amount.value) * 100) };
          try { await api.post('/api/admin/config', { key: 'pro.plan', value: next }); close(); toast('Price updated', 'good'); show('config'); }
          catch (e) { toast(e.message, 'bad'); }
        },
      }),
    ]);
  });
}

// ------------------------------------------------------------------- audit
views.audit = async () => {
  const d = await api.get('/api/admin/audit');
  return el('div', { class: 'stack' }, [
    label('Audit log'),
    el('table', { class: 'admin' }, [
      el('thead', {}, [el('tr', {}, ['When', 'Actor', 'Action', 'Subject', 'Detail'].map((h) => el('th', { text: h })))]),
      el('tbody', {}, d.logs.map((l) => el('tr', {}, [
        el('td', { text: fmtDate(l.created_at) }),
        el('td', { text: '@' + (l.username || 'system') }),
        el('td', { text: l.action }),
        el('td', { text: l.subject_id || '—' }),
        el('td', { style: 'color:var(--ash);font-size:.8rem', text: (l.meta_json || '').slice(0, 90) }),
      ]))),
    ]),
  ]);
};

// -------------------------------------------------------------------- boot
for (const b of nav.querySelectorAll('button')) b.addEventListener('click', () => show(b.dataset.view));
(async () => {
  try { state.bootstrap = await api.get('/api/bootstrap'); state.user = state.bootstrap.session; } catch {}
  const start = (location.hash || '#overview').slice(1);
  show(views[start] ? start : 'overview');
})();
