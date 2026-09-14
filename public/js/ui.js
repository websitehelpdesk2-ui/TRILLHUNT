export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(message, kind = '') {
  document.querySelector('.toast')?.remove();
  const t = el('div', { class: `toast ${kind}`, role: 'status', 'aria-live': 'polite', text: message });
  document.body.append(t);
  setTimeout(() => t.remove(), 4200);
}

export function sheet(title, buildBody, { subtitle } = {}) {
  return new Promise((resolve) => {
    const close = (v) => { bg.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const panel = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      el('div', { class: 'grabber' }),
      title ? el('h2', { text: title }) : null,
      subtitle ? el('p', { class: 'meta', style: 'color:var(--ash);font-size:.9rem', text: subtitle }) : null,
    ]);
    const bg = el('div', { class: 'sheet-bg', onclick: (e) => { if (e.target === bg) close(null); } }, [panel]);
    panel.append(buildBody(close));
    document.body.append(bg);
    document.addEventListener('keydown', onKey);
    panel.querySelector('input,textarea,button,select')?.focus();
  });
}

export function confirmSheet(title, body, confirmLabel = 'Confirm', danger = false) {
  return sheet(title, (close) => el('div', {}, [
    el('p', { text: body, style: 'color:var(--ash)' }),
    el('div', { class: 'stack' }, [
      el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'} btn-block`, text: confirmLabel, onclick: () => close(true) }),
      el('button', { class: 'btn btn-ghost btn-block', text: 'Cancel', onclick: () => close(false) }),
    ]),
  ]));
}

// ---------------------------------------------------------------- pieces
export function sourceChip(source, isDemo) {
  const map = {
    verified: ['verified', '✅ Verified listing'],
    community: ['community', '👥 Community reported'],
    restricted: ['restricted', '⛔ Restricted — do not enter'],
  };
  const [cls, label] = map[source] || map.community;
  const chips = [el('span', { class: `chip ${cls}`, text: label })];
  if (isDemo) chips.push(el('span', { class: 'chip demo', text: '🧪 Sample data' }));
  return el('div', { class: 'chiprow' }, chips);
}

const METRICS = [
  ['fear', 'Fear'], ['paranormal', 'Paranormal'], ['isolation', 'Isolation'],
  ['darkness', 'Darkness'], ['difficulty', 'Difficulty'],
];

export function meters(loc, keys = METRICS) {
  return el('div', { class: 'meters' }, keys.map(([k, label]) => {
    const v = loc[k];
    const known = v != null;
    return el('div', { class: `meter${known ? '' : ' unknown'}` }, [
      el('span', { class: 'name', text: label }),
      el('div', { class: 'track', role: 'img', 'aria-label': `${label}: ${known ? v + ' out of 10' : 'not rated yet'}` }, [
        el('i', { class: 'fill', style: `width:${known ? (v / 10) * 100 : 100}%;display:block` }),
      ]),
      el('span', { class: 'val', text: known ? v.toFixed(1) : '—' }),
    ]);
  }));
}

export function safetyPlacard(safety) {
  const level = safety.level || 'unknown';
  return el('div', { class: `placard ${level}` }, [
    el('div', { class: 'status' }, [
      el('span', { text: safety.indicator.dot }),
      el('span', { text: safety.indicator.label }),
    ]),
    el('p', { style: 'margin:0 0 12px;font-size:.86rem;color:var(--ash)', text: safety.access_note }),
    el('dl', {}, safety.know_before_you_go.flatMap((f) => [
      el('dt', { text: f.label.toUpperCase() }),
      el('dd', { class: f.known ? '' : 'unknown' }, [
        f.display,
        // Provenance sits with the fact, not in a footnote nobody reads.
        f.attribution ? el('div', { class: 'attrib', text: f.attribution }) : null,
      ]),
    ])),
  ]);
}

export function thrillWarning(lines) {
  return el('div', { class: 'warning' }, [
    el('strong', { text: '⚠️ THRILL WARNING' }),
    ...lines.map((l) => el('p', { style: 'margin:0 0 8px', text: l })),
  ]);
}

export function credibilityLine(cred) {
  const tone = cred.data_source === 'verified' && !cred.stale ? 'verified'
    : cred.data_source === 'restricted' ? 'restricted' : 'community';
  return el('div', { class: 'card flat tight' }, [
    el('div', { class: 'row between wrap' }, [
      el('span', { class: `chip ${tone}`, text: cred.stale ? '⏳ Needs re-checking' : tone === 'verified' ? '✅ Confirmed' : '👥 Unconfirmed' }),
      el('small', { text: `${cred.fields_known} of ${cred.fields_total} facts on file` }),
    ]),
    el('p', { style: 'margin:8px 0 0;font-size:.86rem;color:var(--ash)', text: cred.statement }),
    cred.flag_note ? el('p', { style: 'margin:8px 0 0;font-size:.86rem;color:#f0a7a8', text: cred.flag_note }) : null,
  ]);
}

export function beforeYouGo(safety) {
  if (!safety.pre_departure.length) return null;
  return el('div', { class: 'card', style: 'border-color:#4a4a57' }, [
    el('h3', { style: 'margin-bottom:10px', text: 'Before you go' }),
    el('div', { class: 'stack' }, safety.pre_departure.map((line) =>
      el('div', { class: 'row', style: 'align-items:flex-start;gap:9px' }, [
        el('span', { style: 'color:var(--ember)', text: '▸' }),
        el('span', { style: 'font-size:.9rem', text: line }),
      ]))),
    safety.checkin_note ? el('p', { style: 'margin:12px 0 0;font-size:.82rem;color:var(--ash)', text: safety.checkin_note }) : null,
  ]);
}

export function empty(icon, title, body, action) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'big', text: icon }),
    el('h3', { text: title }),
    el('p', { style: 'margin:0 auto 14px;max-width:38ch', text: body }),
    action || null,
  ]);
}

export function skeletons(n = 3) {
  return el('div', { class: 'stack' }, Array.from({ length: n }, () => el('div', { class: 'skeleton' })));
}

export const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};
export const fmtTime = (s) => new Date(s).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
export const money = (cents, cur = 'usd') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: cur.toUpperCase() }).format(cents / 100);