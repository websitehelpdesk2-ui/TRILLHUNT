/**
 * GAMIFICATION (§32)
 * XP is only ever awarded for lawful, completed, documented activity.
 * There is deliberately no XP source tied to restricted-access locations.
 */
import { all, get, run } from '../lib/db.ts';
import { id, now } from '../lib/util.ts';
import { notify } from './notifications.ts';

export const LEVELS: { level: number; title: string; xp: number }[] = [
  { level: 1, title: 'Curious', xp: 0 },
  { level: 5, title: 'Explorer', xp: 2000 },
  { level: 10, title: 'Menace', xp: 5000 },
  { level: 25, title: 'Chaos Agent', xp: 15000 },
  { level: 50, title: 'IRL Legend', xp: 50000 },
];

export function levelFor(xp: number) {
  // Smooth curve between named tiers: 250 XP per level baseline.
  const level = Math.max(1, Math.min(50, Math.floor(Math.sqrt(xp / 20)) + 1));
  const tier = [...LEVELS].reverse().find((l) => level >= l.level) ?? LEVELS[0];
  const next = LEVELS.find((l) => l.level > level);
  return { level, title: tier.title, nextTitle: next?.title ?? null, nextAt: next?.xp ?? null };
}

export const XP_RULES: Record<string, number> = {
  first_adventure: 250,
  first_haunted_attraction: 500,
  first_camping: 300,
  thrill_report: 150,
  quality_thrill_report: 150,
  review: 50,
  joined_group: 40,
  marked_going: 20,
  invited_friend: 100,
  trip_checkin_complete: 75,
};

export function awardXp(userId: string, reason: string, amount?: number, dedupeKey?: string) {
  const amt = amount ?? XP_RULES[reason] ?? 0;
  if (!amt) return { awarded: 0 };
  if (dedupeKey) {
    const dup = get<any>('SELECT id FROM xp_transactions WHERE user_id = ? AND dedupe_key = ?', [userId, dedupeKey]);
    if (dup) return { awarded: 0, duplicate: true };
  }
  run('INSERT INTO xp_transactions (id, user_id, amount, reason, dedupe_key, created_at) VALUES (?,?,?,?,?,?)',
      [id('xp'), userId, amt, reason, dedupeKey ?? null, now()]);
  const before = get<any>('SELECT xp, level FROM profiles WHERE user_id = ?', [userId]);
  const xp = (before?.xp ?? 0) + amt;
  const lv = levelFor(xp);
  run('UPDATE profiles SET xp = ?, level = ?, updated_at = ? WHERE user_id = ?', [xp, lv.level, now(), userId]);
  if (lv.level > (before?.level ?? 1)) {
    notify(userId, 'level_up', `🏆 Level ${lv.level} — ${lv.title}`, `You reached ${xp.toLocaleString()} XP.`, '/app#/profile');
  }
  return { awarded: amt, xp, level: lv.level, title: lv.title };
}

export function checkBadges(userId: string) {
  const earned: any[] = [];
  const stats = userStats(userId);
  for (const b of all<any>('SELECT * FROM badges')) {
    if (get<any>('SELECT badge_id FROM user_achievements WHERE user_id = ? AND badge_id = ?', [userId, b.id])) continue;
    let rule: any = {};
    try { rule = JSON.parse(b.rule_json); } catch { continue; }
    const value = (stats as any)[rule.stat] ?? 0;
    if (typeof rule.min === 'number' && value >= rule.min) {
      run('INSERT INTO user_achievements (user_id, badge_id, earned_at) VALUES (?,?,?)', [userId, b.id, now()]);
      notify(userId, 'badge', `🏆 You earned ${b.name}`, b.description, '/app#/profile');
      earned.push({ slug: b.slug, name: b.name, icon: b.icon });
    }
  }
  return earned;
}

export function userStats(userId: string) {
  const q = (sql: string, p: any[] = [userId]) => get<any>(sql, p)?.c ?? 0;
  return {
    thrill_reports: q('SELECT COUNT(*) c FROM thrill_reports WHERE user_id = ? AND deleted_at IS NULL'),
    adventures: q(`SELECT COUNT(*) c FROM attendance WHERE user_id = ? AND status = 'completed'`),
    haunted: q(`SELECT COUNT(*) c FROM attendance a JOIN location_categories lc ON lc.location_id = a.location_id
                JOIN categories c2 ON c2.id = lc.category_id
                WHERE a.user_id = ? AND a.status='completed' AND c2.slug IN ('haunted-attractions','horror-experiences')`),
    camping: q(`SELECT COUNT(*) c FROM attendance a JOIN location_categories lc ON lc.location_id = a.location_id
                JOIN categories c2 ON c2.id = lc.category_id
                WHERE a.user_id = ? AND a.status='completed' AND c2.slug = 'camping'`),
    night: q(`SELECT COUNT(*) c FROM attendance a JOIN location_categories lc ON lc.location_id = a.location_id
              JOIN categories c2 ON c2.id = lc.category_id
              WHERE a.user_id = ? AND a.status='completed' AND c2.slug = 'night-adventures'`),
    road_trips: q(`SELECT COUNT(*) c FROM attendance a JOIN location_categories lc ON lc.location_id = a.location_id
              JOIN categories c2 ON c2.id = lc.category_id
              WHERE a.user_id = ? AND a.status='completed' AND c2.slug = 'road-trips'`),
    groups: q('SELECT COUNT(*) c FROM group_members WHERE user_id = ? AND left_at IS NULL'),
    checkins: q(`SELECT COUNT(*) c FROM trips WHERE user_id = ? AND checkin_outcome = 'home'`),
  };
}
