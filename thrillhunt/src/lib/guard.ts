import { get, run } from './db.ts';
import { tooMany, clamp } from './util.ts';

/** Fixed-window counter, persisted so limits survive a restart. */
export function rateLimit(bucket: string, max: number, windowSec = 60) {
  const w = Math.floor(Date.now() / 1000 / windowSec);
  run(
    `INSERT INTO rate_events (bucket, window_ts, count) VALUES (?,?,1)
     ON CONFLICT(bucket, window_ts) DO UPDATE SET count = count + 1`,
    [bucket, w],
  );
  const row = get<{ count: number }>('SELECT count FROM rate_events WHERE bucket = ? AND window_ts = ?', [bucket, w]);
  if ((row?.count ?? 0) > max) throw tooMany('Too many requests. Wait a moment and try again.');
  if (Math.random() < 0.02) run('DELETE FROM rate_events WHERE window_ts < ?', [w - 60]);
}

// ------------------------------------------------------------------ geo
export function milesBetween(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 3958.8, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * §15/§57 — user-facing distance is always coarse.
 * Exact user coordinates never leave the server; other users only ever see a
 * bucketed distance string derived from it.
 */
export function coarseDistance(miles: number): string {
  if (miles < 1) return 'Less than 1 mile away';
  if (miles < 10) return `${Math.round(miles)} miles away`;
  if (miles < 50) return `${Math.round(miles / 5) * 5} miles away`;
  return `${Math.round(miles / 10) * 10} miles away`;
}

/** Snap a coordinate to ~1km for any value that could reach another user. */
export const fuzzCoord = (n: number) => Math.round(n * 100) / 100;

export const normLat = (v: unknown) => (v === undefined || v === null || v === '' ? null : clamp(Number(v), -90, 90));
export const normLng = (v: unknown) => (v === undefined || v === null || v === '' ? null : clamp(Number(v), -180, 180));
