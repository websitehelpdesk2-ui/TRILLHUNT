// Thin API client. Never holds secrets — auth is an httpOnly cookie the JS
// can't read; only the CSRF token cookie is readable, by design.
const cookie = (k) => document.cookie.split('; ').find((c) => c.startsWith(k + '='))?.split('=')[1] ?? '';

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error || 'Something went wrong.');
    this.status = status;
    this.code = payload?.code;
    this.payload = payload || {};
  }
}

async function request(method, path, body, extraHeaders = {}) {
  const headers = { 'x-th-csrf': cookie('th_csrf'), ...extraHeaders };
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b, h) => request('POST', p, b, h),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
  uploadImage: (file) => request('POST', '/api/uploads/image', file, {
    'content-type': file.type,
    'x-filename': file.name || 'upload.jpg',
  }),
};

// Shared client state (never trusted for authorization — the server re-checks).
export const state = {
  user: null,
  bootstrap: null,
  coords: null,
  get isPro() { return !!this.user?.subscription?.entitlements?.image_upload; },
};

export async function refreshSession() {
  const r = await api.get('/api/auth/session');
  state.user = r.user;
  return r.user;
}

export function coordQuery(extra = '') {
  const c = state.coords;
  const q = c ? `lat=${c.lat}&lng=${c.lng}` : '';
  return [q, extra].filter(Boolean).join('&');
}

/** Asks the OS for location. Coordinates stay on this device + this request. */
export function requestLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => { state.coords = { lat: +p.coords.latitude.toFixed(4), lng: +p.coords.longitude.toFixed(4) }; resolve(state.coords); },
      () => resolve(null),
      { timeout: 8000, maximumAge: 600000 },
    );
  });
}
