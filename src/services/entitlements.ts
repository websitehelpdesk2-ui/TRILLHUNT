/**
 * ENTITLEMENTS — the single source of truth for "what can this user do".
 *
 * Hard rule (§19, §55): entitlements are DERIVED on the server from the
 * subscription record, which is only ever written by the payment provider
 * webhook or an admin. No client request can set or assert them.
 */
import { all, get, run, cfg } from '../lib/db.ts';
import { now, forbid } from '../lib/util.ts';

export type EntitlementKey =
  | 'image_upload' | 'ai_advanced' | 'ai_unlimited' | 'advanced_filters'
  | 'offline' | 'mystery_exclusive' | 'premium_badges' | 'advanced_stats';

const ACTIVE = new Set(['active', 'trialing']);

/** Recompute the entitlement rows for a user from their subscription state. */
export function syncEntitlements(userId: string) {
  const sub = get<any>(
    `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1`, [userId],
  );
  const proKeys: string[] = cfg('entitlements.pro');
  const freeKeys: string[] = cfg('entitlements.free');

  let active = false;
  if (sub && ACTIVE.has(sub.status)) {
    // An "active" row whose period has lapsed is treated as expired until the
    // provider webhook says otherwise — fail closed.
    active = !sub.current_period_end || sub.current_period_end > now();
    if (!active) run('UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?', ['expired', now(), sub.id]);
  }

  const granted = new Set(active ? proKeys : freeKeys);
  const source = active ? `subscription:${sub.id}` : 'plan:free';
  const keys = new Set<string>([...proKeys, ...freeKeys]);

  for (const key of keys) {
    // Admin comp grants are preserved.
    const existing = get<any>('SELECT source, granted FROM subscription_entitlements WHERE user_id = ? AND key = ?', [userId, key]);
    if (existing?.source?.startsWith('admin:') && existing.granted) continue;
    run(
      `INSERT INTO subscription_entitlements (user_id, key, granted, source, expires_at, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(user_id, key) DO UPDATE SET granted = excluded.granted,
         source = excluded.source, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      [userId, key, granted.has(key) ? 1 : 0, source, active ? sub.current_period_end : null, now()],
    );
  }
  return { active, sub };
}

export function has(userId: string, key: EntitlementKey): boolean {
  const row = get<any>('SELECT granted, expires_at FROM subscription_entitlements WHERE user_id = ? AND key = ?', [userId, key]);
  if (!row || !row.granted) return false;
  if (row.expires_at && row.expires_at <= now()) { syncEntitlements(userId); return has(userId, key); }
  return true;
}

/** Throws a 403 the client renders as the Pro upsell sheet. */
export function requireEntitlement(userId: string, key: EntitlementKey) {
  if (!has(userId, key)) {
    const plan: any = cfg('pro.plan');
    throw forbid(
      'IMAGE MESSAGES ARE A THRILLHUNT PRO FEATURE',
      'subscription_required',
      {
        entitlement: key,
        upsell: {
          title: '📸 IMAGE MESSAGES ARE A THRILLHUNT PRO FEATURE',
          body: 'Upgrade to THRILLHUNT PRO to share photos in chats, groups and adventures.',
          cta: 'UPGRADE TO PRO',
          plan: { id: plan.id, name: plan.name, price_cents: plan.price_cents, currency: plan.currency, interval: plan.interval },
        },
      },
    );
  }
}

export function entitlementMap(userId: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of all<any>('SELECT key, granted, expires_at FROM subscription_entitlements WHERE user_id = ?', [userId])) {
    out[r.key] = !!r.granted && (!r.expires_at || r.expires_at > now());
  }
  return out;
}

export function subscriptionSummary(userId: string) {
  const sub = get<any>('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [userId]);
  const ents = entitlementMap(userId);
  return {
    is_pro: !!ents.image_upload,
    status: sub?.status ?? 'none',
    provider: sub?.provider ?? null,
    cancel_at_period_end: !!sub?.cancel_at_period_end,
    current_period_end: sub?.current_period_end ?? null,
    last_payment_error: sub?.last_payment_error ?? null,
    entitlements: ents,
  };
}
