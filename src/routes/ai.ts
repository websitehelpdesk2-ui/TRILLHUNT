import { route } from './registry.ts';
import { all, get, run, cfg } from '../lib/db.ts';
import { requireUser } from '../lib/auth.ts';
import { rateLimit, normLat, normLng } from '../lib/guard.ts';
import { readJson, str, now, bad, forbid, notFound } from '../lib/util.ts';
import { findMyThrill } from '../services/ai.ts';
import { has } from '../services/entitlements.ts';
import { locationCard } from '../lib/view.ts';

route('POST', '/api/ai/find-my-thrill', async ({ req, ctx }) => {
  const u = requireUser(ctx);
  const limits: any = cfg('ai.limits');
  const pro = has(u.id, 'ai_unlimited');
  const used = get<any>(`SELECT COUNT(*) c FROM ai_recommendations WHERE user_id = ? AND created_at > datetime('now','-1 day')`, [u.id])?.c ?? 0;
  const cap = pro ? limits.pro_packs_per_day : limits.free_packs_per_day;
  if (used >= cap) {
    throw forbid(
      pro ? 'Daily planning limit reached. Try again tomorrow.' : `Free accounts get ${cap} Thrill Packs per day.`,
      'subscription_required',
      { entitlement: 'ai_unlimited', upsell: { title: '🧠 UNLIMITED THRILL PACKS ARE A PRO FEATURE', body: 'Upgrade to THRILLHUNT PRO for unlimited AI planning and advanced itineraries.', cta: 'UPGRADE TO PRO' } });
  }
  rateLimit(`ai:${u.id}`, 10, 60);

  const b = await readJson(req);
  const prompt = str(b.prompt, 'Request', { min: 4, max: 500 });
  const prof = get<any>('SELECT home_lat, home_lng FROM profiles WHERE user_id = ?', [u.id]);
  const lat = normLat(b.lat) ?? prof?.home_lat ?? null;
  const lng = normLng(b.lng) ?? prof?.home_lng ?? null;

  const pack = await findMyThrill(u.id, prompt, lat, lng);
  return {
    pack,
    packs_remaining: Math.max(0, cap - used - 1),
    disclaimer: 'Hours, prices, availability and access rules change. Confirm everything with the official operator before you go. THRILLHUNT does not guarantee safety, accuracy or availability.',
  };
});

route('GET', '/api/ai/history', ({ ctx }) => {
  const u = requireUser(ctx);
  return { packs: all<any>('SELECT id, prompt, provider, created_at, result_json FROM ai_recommendations WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [u.id])
    .map((r) => ({ id: r.id, prompt: r.prompt, provider: r.provider, created_at: r.created_at, pack: JSON.parse(r.result_json) })) };
});

// -------------------------------------------------------- mystery drop (§30)
route('POST', '/api/mystery-drops/:id/reveal', ({ ctx, params }) => {
  const u = requireUser(ctx);
  const d = get<any>('SELECT * FROM mystery_drops WHERE id = ? AND ends_at > ?', [params.id, now()]);
  if (!d) throw notFound('That drop has expired.');
  if (d.pro_only && !has(u.id, 'mystery_exclusive')) {
    throw forbid('This is an exclusive PRO drop.', 'subscription_required',
      { entitlement: 'mystery_exclusive', upsell: { title: '🔴 EXCLUSIVE MYSTERY DROP', body: 'THRILLHUNT PRO members get exclusive drops.', cta: 'UPGRADE TO PRO' } });
  }
  const loc = get<any>(`SELECT l.*, (SELECT group_concat(c.slug) FROM location_categories lc JOIN categories c ON c.id=lc.category_id WHERE lc.location_id=l.id) cat_slugs
                          FROM locations l WHERE l.id = ?`, [d.location_id]);
  // A drop can never resolve to restricted property (§30).
  if (!loc || loc.access_policy === 'private_closed') throw notFound('That drop is no longer available.');
  run('INSERT OR IGNORE INTO mystery_drop_reveals (drop_id, user_id, created_at) VALUES (?,?,?)', [d.id, u.id, now()]);
  run('UPDATE locations SET trending_score = trending_score + 2 WHERE id = ?', [loc.id]);
  return { location: locationCard(loc), recommended_group: `${d.group_min}–${d.group_max}` };
});
