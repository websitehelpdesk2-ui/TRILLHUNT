import { route } from './registry.ts';
import { all, get, run, cfg } from '../lib/db.ts';
import { requireUser, requireWrite } from '../lib/auth.ts';
import { rateLimit } from '../lib/guard.ts';
import { id, now, readJson, readBody, str, bad, forbid, notFound, hmac, safeEq, HttpError } from '../lib/util.ts';
import { payments, applySubscriptionEvent, normalizeStripeEvent } from '../services/payments.ts';
import { requireEntitlement, has, subscriptionSummary, syncEntitlements } from '../services/entitlements.ts';
import { validateAndSanitizeImage, storage, buildKey, signMediaUrl, verifyMediaUrl } from '../services/storage.ts';
import { imageModerator, openCase, recordStrike } from '../services/moderation.ts';
import { config } from '../config.ts';

// ------------------------------------------------------------- plan / status
route('GET', '/api/pro', ({ ctx }) => {
  const plan: any = cfg('pro.plan');
  return {
    plan: { id: plan.id, name: plan.name, price_cents: plan.price_cents, currency: plan.currency, interval: plan.interval, features: plan.features, trial_days: plan.trial_days },
    price_display: `$${(plan.price_cents / 100).toFixed(2)}/${plan.interval}`,
    provider: config.providers.payments,
    subscription: ctx.user ? subscriptionSummary(ctx.user.id) : null,
  };
});

route('POST', '/api/pro/checkout', async ({ ctx }) => {
  const u = requireUser(ctx);
  rateLimit(`checkout:${u.id}`, 10, 3600);
  const session = await payments.createCheckout(u.id, u.email);
  return { checkout_url: session.url, provider: session.provider, reference: session.reference };
});

route('POST', '/api/pro/portal', async ({ ctx }) => {
  const u = requireUser(ctx);
  return await payments.createPortal(u.id);
});

route('POST', '/api/pro/cancel', async ({ ctx }) => {
  const u = requireUser(ctx);
  await payments.cancel(u.id);
  syncEntitlements(u.id);
  return { subscription: subscriptionSummary(u.id), message: 'Your PRO access stays active until the end of the current billing period.' };
});

/** §19 "restore subscription" — re-reads provider state and rebuilds entitlements. */
route('POST', '/api/pro/restore', ({ ctx }) => {
  const u = requireUser(ctx);
  const r = syncEntitlements(u.id);
  return { restored: r.active, subscription: subscriptionSummary(u.id) };
});

// ------------------------------------------------------------------ webhook
// Unauthenticated by design; authenticity comes from the signature check.
route('POST', '/api/webhooks/payments', async ({ req }) => {
  const raw = await readBody(req, 512 * 1024);
  const ev = payments.verifyWebhook(raw, req.headers as any);
  if (config.providers.payments === 'stripe') {
    const n = normalizeStripeEvent(ev.type, ev.data);
    if (!n.userId) return { ignored: true };
    return applySubscriptionEvent({ id: ev.id, ...n } as any, 'stripe');
  }
  const d: any = ev.data;
  if (!d.user_id) throw bad('Missing user_id.');
  return applySubscriptionEvent({
    id: ev.id, type: ev.type, userId: d.user_id, status: d.status,
    periodEnd: d.period_end ?? null, cancelAtPeriodEnd: !!d.cancel_at_period_end,
    error: d.error ?? null, subId: d.subscription_id ?? `mock_${d.user_id}`, customerId: `mockcus_${d.user_id}`,
  }, 'mock');
});

/**
 * MOCK provider only: stands in for the hosted checkout page's server callback.
 * The signature proves the request came from our own signed checkout URL.
 * This route does not exist when PAYMENT_PROVIDER=stripe.
 */
route('POST', '/api/mock/checkout/complete', async ({ req }) => {
  if (config.providers.payments !== 'mock') throw notFound();
  const b = await readJson(req);
  const ref = str(b.ref, 'Reference');
  const userId = str(b.user_id, 'User');
  if (!safeEq(hmac(`${ref}:${userId}`), str(b.sig, 'Signature'))) throw forbid('Invalid checkout signature.', 'bad_signature');
  const payload = JSON.stringify({
    id: `evt_${ref}`, type: b.scenario === 'fail' ? 'payment.failed' : 'checkout.completed',
    user_id: userId, status: b.scenario === 'fail' ? 'past_due' : 'active',
    period_end: new Date(Date.now() + 30 * 864e5).toISOString(), error: b.scenario === 'fail' ? 'Card declined.' : null,
  });
  // Round-trips through the real webhook path so the signature + idempotency
  // logic is exercised exactly as it would be in production.
  const ev = payments.verifyWebhook(Buffer.from(payload), { 'x-mock-signature': hmac(payload) });
  const d: any = ev.data;
  applySubscriptionEvent({ id: ev.id, type: ev.type, userId, status: d.status, periodEnd: d.period_end, error: d.error, subId: `mock_${userId}`, customerId: `mockcus_${userId}` }, 'mock');
  return { ok: true, subscription: subscriptionSummary(userId) };
});

// ============================================================ IMAGE UPLOAD
/**
 * §20 / §55 upload pipeline, in order:
 *   auth -> entitlement -> rate limit -> size/type validation (magic bytes)
 *   -> EXIF strip -> moderation -> store -> return authorized reference.
 * A free user is stopped at step 2 with 403 subscription_required.
 */
route('POST', '/api/uploads/image', async ({ req, ctx }) => {
  const u = requireWrite(ctx);
  requireEntitlement(u.id, 'image_upload');           // <-- THE PAYWALL

  const limits: any = cfg('uploads.limits');
  rateLimit(`upload:${u.id}`, limits.max_uploads_per_minute, 60);

  const filename = str(req.headers['x-filename'] ?? 'upload.jpg', 'Filename', { max: 200, required: false }) || 'upload.jpg';
  const declared = String(req.headers['content-type'] ?? '').split(';')[0];
  const raw = await readBody(req, limits.max_file_bytes + 1024);

  const img = validateAndSanitizeImage(raw, declared, filename);

  // Per-account storage quota.
  const used = get<any>('SELECT COALESCE(SUM(bytes),0) b FROM media_assets WHERE owner_user_id = ? AND deleted_at IS NULL', [u.id])?.b ?? 0;
  if (used + img.bytes > limits.max_storage_bytes_per_account) throw forbid('Storage limit reached for this account.', 'storage_quota');

  const verdict = await imageModerator.check(img.buffer, { mime: img.mime, sha256: img.sha256, filename });
  const mediaId = id('img');
  const key = buildKey(u.id, img.ext);

  if (verdict.verdict === 'block') {
    // Never stored as retrievable content; a case is opened and a strike recorded.
    run(`INSERT INTO media_assets (id, owner_user_id, kind, storage_key, mime, bytes, width, height, sha256, exif_stripped, moderation_status, moderation_provider, moderation_json, created_at, deleted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'blocked', ?,?,?,?)`,
        [mediaId, u.id, 'image', '(not stored)', img.mime, img.bytes, img.width, img.height, img.sha256, img.exifStripped ? 1 : 0,
         verdict.provider, JSON.stringify({ labels: verdict.labels }), now(), now()]);
    const caseId = openCase({ subjectType: 'image', subjectId: mediaId, ownerUserId: u.id, origin: 'auto_moderation', severity: 'critical' });
    recordStrike(u.id, 'high', 'Image violated Community Guidelines', caseId);
    // Deliberately vague: no detail that would help someone tune around the filter.
    throw forbid("⚠️ This image couldn't be posted because it may violate THRILLHUNT's Community Guidelines.", 'image_blocked');
  }

  await storage.put(key, img.buffer, img.mime);
  const status = verdict.verdict === 'review' ? 'review' : 'approved';
  run(`INSERT INTO media_assets (id, owner_user_id, kind, storage_key, mime, bytes, width, height, sha256, exif_stripped, moderation_status, moderation_provider, moderation_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [mediaId, u.id, 'image', key, img.mime, img.bytes, img.width, img.height, img.sha256, img.exifStripped ? 1 : 0,
       status, verdict.provider, JSON.stringify({ labels: verdict.labels, score: verdict.score }), now()]);

  if (status === 'review') {
    openCase({ subjectType: 'image', subjectId: mediaId, ownerUserId: u.id, origin: 'auto_moderation', severity: 'normal', notes: verdict.labels.join(',') });
  }

  return {
    media_id: mediaId,
    status,
    url: signMediaUrl(mediaId, u.id),
    width: img.width, height: img.height, bytes: img.bytes,
    exif_stripped: img.exifStripped,
    notice: status === 'review' ? 'This image is being reviewed before it becomes visible to others.' : null,
  };
}, 201);

/** Signed, viewer-bound media read. Blocked/quarantined media is never served. */
route('GET', '/api/media/:id', ({ req, res, ctx, params, query }) => {
  const u = requireUser(ctx);
  verifyMediaUrl(params.id, u.id, query.get('exp') ?? '', query.get('sig') ?? '');
  const a = get<any>('SELECT * FROM media_assets WHERE id = ? AND deleted_at IS NULL', [params.id]);
  if (!a) throw notFound('Media not found.');
  if (a.moderation_status === 'blocked') throw forbid('This image is unavailable.', 'image_blocked');
  if (a.moderation_status === 'review' && a.owner_user_id !== u.id && !['admin', 'moderator'].includes(u.role)) {
    throw forbid('This image is awaiting review.', 'image_pending');
  }
  const buf = storage.read(a.storage_key);
  res.writeHead(200, {
    'content-type': a.mime,
    'content-length': buf.length,
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
  });
  res.end(buf);
});

route('GET', '/api/uploads/mine', ({ ctx }) => {
  const u = requireUser(ctx);
  return {
    media: all<any>('SELECT id, mime, bytes, width, height, moderation_status, created_at FROM media_assets WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50', [u.id])
      .map((m) => ({ ...m, url: m.moderation_status === 'blocked' ? null : signMediaUrl(m.id, u.id) })),
    can_upload_images: has(u.id, 'image_upload'),
  };
});
