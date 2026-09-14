/**
 * OUTBOUND SERIALIZERS.
 * Every public payload is built here, by allow-list. Private columns
 * (home_lat/home_lng, emails, storage keys, raw session tokens, emergency
 * contacts) have no path to a client because no serializer emits them.
 */
import { all, get } from './db.ts';
import { coarseDistance, milesBetween } from './guard.ts';
import { levelFor } from '../services/xp.ts';

export const SAFETY_LABELS: Record<string, { dot: string; label: string }> = {
  low: { dot: '🟢', label: 'Low concern' },
  caution: { dot: '🟡', label: 'Use caution' },
  elevated: { dot: '🟠', label: 'Elevated risk' },
  high: { dot: '🔴', label: 'High risk / restrictions' },
};

export const UNKNOWN_INFO = 'Information unavailable. Verify directly with the official operator or property owner.';

export const THRILL_WARNING = [
  'This experience may involve physical, environmental, or other inherent risks. Information submitted by users may be inaccurate or outdated.',
  'Verify conditions and access with the official property/operator before visiting. Follow posted rules, applicable laws, weather advisories, and safety instructions. Never enter restricted or private areas without authorization.',
  'THRILLHUNT does not guarantee the safety, accuracy, legality, or availability of any location or activity.',
];

export function publicUser(userId: string, viewerId?: string) {
  const row = get<any>(
    `SELECT u.id, u.role, u.status, p.username, p.display_name, p.avatar_emoji, p.bio, p.home_city,
            p.xp, p.level, p.profile_visibility, p.attendance_public, p.activity_public
       FROM users u JOIN profiles p ON p.user_id = u.id
      WHERE u.id = ? AND u.deleted_at IS NULL`, [userId]);
  if (!row) return null;
  const self = viewerId === userId;
  if (!self && row.profile_visibility === 'private') {
    return { id: row.id, username: row.username, avatar_emoji: '🕶️', private: true };
  }
  const lv = levelFor(row.xp);
  return {
    id: row.id, username: row.username, display_name: row.display_name,
    avatar_emoji: row.avatar_emoji, bio: row.bio,
    home_city: row.home_city,           // coarse, self-declared city only
    xp: row.xp, level: lv.level, level_title: lv.title, next_title: lv.nextTitle, next_at: lv.nextAt,
    badges: all<any>(`SELECT b.slug, b.name, b.icon, ua.earned_at FROM user_achievements ua
                      JOIN badges b ON b.id = ua.badge_id WHERE ua.user_id = ? ORDER BY ua.earned_at DESC`, [userId]),
    is_pro: !!get<any>(`SELECT granted FROM subscription_entitlements WHERE user_id = ? AND key='image_upload' AND granted=1`, [userId]),
    role: row.role,
  };
}

export function locationCard(r: any, viewer?: { lat: number | null; lng: number | null }) {
  const miles = viewer?.lat != null && r.lat != null ? milesBetween(viewer.lat, viewer.lng!, r.lat, r.lng) : null;
  return {
    id: r.id, slug: r.slug, name: r.name, tagline: r.tagline,
    data_source: r.data_source, verification_status: r.verification_status, is_demo: !!r.is_demo,
    access_policy: r.access_policy,
    city: r.city, region: r.region,
    distance_label: miles == null ? null : coarseDistance(miles),
    distance_miles: miles == null ? null : Math.round(miles),
    rating_avg: r.rating_avg, rating_count: r.rating_count,
    interested_count: r.interested_count, trending_score: r.trending_score,
    fear: r.fear, paranormal: r.paranormal, isolation: r.isolation, darkness: r.darkness, difficulty: r.difficulty,
    price_text: r.price_text ?? null,
    safety: r.safety_level ? { level: r.safety_level, ...SAFETY_LABELS[r.safety_level] } : { level: null, dot: '⚪️', label: 'Safety info unavailable' },
    categories: String(r.cat_slugs ?? '').split(',').filter(Boolean),
  };
}

/** Navigation destination payload (§68). Never invents coordinates. */
export function destinationFor(r: any) {
  const hasCoords = r.lat != null && r.lng != null;
  const address = [r.address_line, r.city, r.region, r.postal_code].filter(Boolean).join(', ');
  return {
    name: r.name,
    address: address || null,
    lat: hasCoords ? r.lat : null,
    lng: hasCoords ? r.lng : null,
    place_id: r.place_id ?? null,
    precision: r.address_precision,
    approximate: r.address_precision !== 'exact' || !address,
    note: r.address_precision === 'exact' && address ? null
      : 'Navigation may be approximate — confirm the exact meeting point with the operator.',
  };
}
