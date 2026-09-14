import { all, get, run } from '../lib/db.ts';
import { id, now } from '../lib/util.ts';

export function notify(userId: string, kind: string, title: string, body?: string, link?: string) {
  const prefs = get<any>('SELECT notification_prefs FROM profiles WHERE user_id = ?', [userId]);
  try {
    const p = JSON.parse(prefs?.notification_prefs ?? '{}');
    if (p[kind] === false) return; // user opted out of this category (§36)
  } catch { /* default on */ }
  run('INSERT INTO notifications (id, user_id, kind, title, body, link, created_at) VALUES (?,?,?,?,?,?,?)',
      [id('ntf'), userId, kind, title, body ?? null, link ?? null, now()]);
}

export function listNotifications(userId: string, limit = 40) {
  return all<any>('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
}
export function markRead(userId: string) {
  run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [now(), userId]);
}
