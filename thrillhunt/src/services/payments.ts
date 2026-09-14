/**
 * PAYMENTS — provider-agnostic subscription handling.
 *
 * THRILLHUNT never sees or stores a card number. The checkout session is
 * created by the provider; we store only the provider's customer/subscription
 * ids and the resulting status. Status changes arrive by webhook and are the
 * only thing that flips entitlements.
 *
 * Providers:
 *   'mock'   — default. A fully working local checkout so the paywall, webhook
 *              and entitlement sync can be exercised end-to-end with no keys.
 *   'stripe' — real implementation (Checkout + webhook signature verification).
 *              Requires STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PRICE_ID.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { get, run, cfg } from '../lib/db.ts';
import { id, now, plusDays, hmac, HttpError } from '../lib/util.ts';
import { syncEntitlements } from './entitlements.ts';

export interface CheckoutSession { url: string; provider: string; reference: string }

export interface PaymentProvider {
  name: string;
  createCheckout(userId: string, email: string): Promise<CheckoutSession>;
  createPortal(userId: string): Promise<{ url: string }>;
  cancel(userId: string): Promise<void>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, any>): { id: string; type: string; data: any };
}

// ------------------------------------------------------------------ shared
function upsertSubscription(o: {
  userId: string; provider: string; customerId?: string | null; subId?: string | null;
  status: string; periodEnd?: string | null; cancelAtPeriodEnd?: boolean; error?: string | null;
}) {
  const plan: any = cfg('pro.plan');
  const existing = get<any>('SELECT id FROM subscriptions WHERE user_id = ? AND provider = ?', [o.userId, o.provider]);
  if (existing) {
    run(
      `UPDATE subscriptions SET provider_customer_id = COALESCE(?, provider_customer_id),
        provider_subscription_id = COALESCE(?, provider_subscription_id), status = ?,
        current_period_end = COALESCE(?, current_period_end), cancel_at_period_end = ?,
        last_payment_error = ?, updated_at = ? WHERE id = ?`,
      [o.customerId ?? null, o.subId ?? null, o.status, o.periodEnd ?? null,
       o.cancelAtPeriodEnd ? 1 : 0, o.error ?? null, now(), existing.id],
    );
  } else {
    run(
      `INSERT INTO subscriptions (id, user_id, provider, provider_customer_id, provider_subscription_id,
        plan_id, status, cancel_at_period_end, current_period_start, current_period_end, last_payment_error, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id('sub'), o.userId, o.provider, o.customerId ?? null, o.subId ?? null, plan.id, o.status,
       o.cancelAtPeriodEnd ? 1 : 0, now(), o.periodEnd ?? null, o.error ?? null, now(), now()],
    );
  }
  syncEntitlements(o.userId);
}

/** Applies a normalized provider event. Idempotent on event id. */
export function applySubscriptionEvent(ev: { id: string; type: string; userId: string; status?: string; periodEnd?: string | null; cancelAtPeriodEnd?: boolean; error?: string | null; customerId?: string | null; subId?: string | null }, provider: string) {
  const seen = get<any>('SELECT id, processed_at FROM payment_events WHERE id = ?', [ev.id]);
  if (seen?.processed_at) return { duplicate: true };
  run('INSERT OR REPLACE INTO payment_events (id, provider, type, user_id, payload, processed_at, created_at) VALUES (?,?,?,?,?,?,?)',
      [ev.id, provider, ev.type, ev.userId, JSON.stringify(ev), now(), now()]);

  const map: Record<string, string> = {
    'checkout.completed': 'active',
    'subscription.updated': ev.status ?? 'active',
    'subscription.canceled': 'canceled',
    'subscription.expired': 'expired',
    'payment.failed': 'past_due',
  };
  const status = map[ev.type] ?? ev.status ?? 'active';
  upsertSubscription({
    userId: ev.userId, provider, customerId: ev.customerId, subId: ev.subId, status,
    periodEnd: ev.periodEnd ?? (status === 'active' ? plusDays(30) : null),
    cancelAtPeriodEnd: ev.cancelAtPeriodEnd, error: ev.error ?? null,
  });
  return { duplicate: false, status };
}

// -------------------------------------------------------------------- mock
const mock: PaymentProvider = {
  name: 'mock',
  async createCheckout(userId) {
    const ref = id('cs');
    // Signed so the mock "provider" callback cannot be forged by hand.
    const sig = hmac(`${ref}:${userId}`);
    return { provider: 'mock', reference: ref, url: `/checkout?ref=${ref}&u=${userId}&sig=${sig}` };
  },
  async createPortal() { return { url: '/app#/pro/manage' }; },
  async cancel(userId) {
    const sub = get<any>('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [userId]);
    if (!sub) throw new HttpError(404, 'No active subscription.', 'no_subscription');
    // Matches real-world behaviour: access continues until the period ends.
    run('UPDATE subscriptions SET cancel_at_period_end = 1, updated_at = ? WHERE id = ?', [now(), sub.id]);
  },
  verifyWebhook(rawBody, headers) {
    const sig = String(headers['x-mock-signature'] ?? '');
    if (!sig || sig !== hmac(rawBody.toString('utf8'))) {
      throw new HttpError(400, 'Invalid webhook signature.', 'bad_signature');
    }
    const body = JSON.parse(rawBody.toString('utf8'));
    return { id: body.id, type: body.type, data: body };
  },
};

// ------------------------------------------------------------------ stripe
const stripe: PaymentProvider = {
  name: 'stripe',
  async createCheckout(userId, email) {
    const body = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': config.stripe.priceId,
      'line_items[0][quantity]': '1',
      customer_email: email,
      client_reference_id: userId,
      'metadata[user_id]': userId,
      success_url: `${config.publicUrl}/app#/pro/success`,
      cancel_url: `${config.publicUrl}/app#/pro`,
    });
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.stripe.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j: any = await r.json();
    if (!r.ok) throw new HttpError(502, j?.error?.message ?? 'Checkout failed.', 'provider_error');
    return { provider: 'stripe', reference: j.id, url: j.url };
  },
  async createPortal(userId) {
    const sub = get<any>('SELECT provider_customer_id FROM subscriptions WHERE user_id = ? AND provider = ?', [userId, 'stripe']);
    if (!sub?.provider_customer_id) throw new HttpError(404, 'No billing account yet.', 'no_subscription');
    const r = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.stripe.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ customer: sub.provider_customer_id, return_url: `${config.publicUrl}/app#/pro` }),
    });
    const j: any = await r.json();
    if (!r.ok) throw new HttpError(502, 'Billing portal unavailable.', 'provider_error');
    return { url: j.url };
  },
  async cancel(userId) {
    const sub = get<any>('SELECT provider_subscription_id FROM subscriptions WHERE user_id = ? AND provider = ?', [userId, 'stripe']);
    if (!sub?.provider_subscription_id) throw new HttpError(404, 'No active subscription.', 'no_subscription');
    await fetch(`https://api.stripe.com/v1/subscriptions/${sub.provider_subscription_id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.stripe.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ cancel_at_period_end: 'true' }),
    });
  },
  verifyWebhook(rawBody, headers) {
    // Stripe signature scheme: t=<ts>,v1=<hmac_sha256(t.payload)>
    const header = String(headers['stripe-signature'] ?? '');
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
    if (!parts.t || !parts.v1) throw new HttpError(400, 'Missing signature.', 'bad_signature');
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) throw new HttpError(400, 'Signature expired.', 'bad_signature');
    const expected = createHmac('sha256', config.stripe.webhookSecret).update(`${parts.t}.${rawBody.toString('utf8')}`).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(parts.v1);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(400, 'Invalid signature.', 'bad_signature');
    const body = JSON.parse(rawBody.toString('utf8'));
    return { id: body.id, type: body.type, data: body.data?.object ?? {} };
  },
};

export const payments: PaymentProvider = config.providers.payments === 'stripe' ? stripe : mock;

/** Normalizes a verified Stripe event into our internal shape. */
export function normalizeStripeEvent(type: string, obj: any) {
  const userId = obj?.metadata?.user_id ?? obj?.client_reference_id;
  const periodEnd = obj?.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null;
  const m: Record<string, string> = {
    'checkout.session.completed': 'checkout.completed',
    'customer.subscription.updated': 'subscription.updated',
    'customer.subscription.deleted': 'subscription.canceled',
    'invoice.payment_failed': 'payment.failed',
  };
  return {
    type: m[type] ?? type,
    userId,
    status: obj?.status,
    periodEnd,
    cancelAtPeriodEnd: !!obj?.cancel_at_period_end,
    customerId: typeof obj?.customer === 'string' ? obj.customer : null,
    subId: typeof obj?.subscription === 'string' ? obj.subscription : obj?.id ?? null,
  };
}
