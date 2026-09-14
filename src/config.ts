// Central configuration. Secrets come from the environment ONLY.
// Nothing in this file is ever shipped to the browser.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency).
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      // strip inline comments and surrounding quotes
      process.env[m[1]] = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
    }
  }
}

const env = (k: string, d = '') => process.env[k] ?? d;

export const config = {
  env: env('NODE_ENV', 'development'),
  port: Number(env('PORT', '3000')),
  host: env('HOST', '0.0.0.0'),
  publicUrl: env('PUBLIC_URL', `http://localhost:${env('PORT', '3000')}`),
  dbFile: env('DATABASE_FILE', join(ROOT, 'db', 'thrillhunt.db')),
  storageDir: env('STORAGE_DIR', join(ROOT, 'storage')),

  // Signing secret for sessions, signed media URLs and mock webhooks.
  secret: env('APP_SECRET', 'dev-only-insecure-secret-change-me'),
  sessionDays: 30,
  cookieSecure: env('COOKIE_SECURE', 'false') === 'true',

  tosVersion: '2026-09-13',

  providers: {
    // 'mock' keeps the whole flow working offline; swap via .env for production.
    payments: env('PAYMENT_PROVIDER', 'mock') as 'mock' | 'stripe',
    imageModeration: env('IMAGE_MODERATION_PROVIDER', 'mock') as 'mock' | 'rekognition' | 'hive' | 'anthropic',
    llm: env('LLM_PROVIDER', 'mock') as 'mock' | 'anthropic',
    storage: env('STORAGE_PROVIDER', 'local') as 'local' | 's3',
    maps: env('MAPS_PROVIDER', 'osm') as 'osm' | 'google' | 'mapbox',
  },

  stripe: {
    secretKey: env('STRIPE_SECRET_KEY'),
    webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
    priceId: env('STRIPE_PRICE_ID'),
  },
  anthropic: { apiKey: env('ANTHROPIC_API_KEY'), model: env('ANTHROPIC_MODEL', 'claude-sonnet-4-6') },
  aws: {
    region: env('AWS_REGION', 'us-east-2'),
    bucket: env('S3_BUCKET'),
    accessKeyId: env('AWS_ACCESS_KEY_ID'),
    secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
  },
};

// Defaults for admin-editable rules. Live values come from app_config (DB).
// §18: price is NEVER hard-coded in the app — it is read from here/DB.
export const CONFIG_DEFAULTS: Record<string, unknown> = {
  'pro.plan': {
    id: 'pro_monthly',
    name: 'THRILLHUNT PRO',
    price_cents: 799,
    currency: 'usd',
    interval: 'month',
    trial_days: 0,
    features: [
      'Image uploads in chats, groups and DMs',
      'Advanced AI trip planning',
      'Unlimited AI Thrill Packs',
      'Advanced search filters',
      'Offline experience info',
      'Exclusive Mystery Drops',
      'Premium badges + profile',
      'Advanced stats',
    ],
  },
  'entitlements.pro': ['image_upload', 'ai_advanced', 'ai_unlimited', 'advanced_filters', 'offline', 'mystery_exclusive', 'premium_badges', 'advanced_stats'],
  'entitlements.free': [],
  'uploads.limits': {
    max_file_bytes: 8 * 1024 * 1024,
    max_images_per_message: 4,
    max_uploads_per_minute: 10,
    max_storage_bytes_per_account: 2 * 1024 * 1024 * 1024,
    allowed_mime: ['image/jpeg', 'image/png', 'image/webp'],
    signed_url_ttl_seconds: 600,
  },
  'ai.limits': { free_packs_per_day: 2, pro_packs_per_day: 200 },
  'moderation.enforcement': {
    warn_at: 1,
    restrict_at: 2,
    restrict_hours: 72,
    suspend_at: 3,
    ban_at: 5,
    critical_immediate_suspend: true,
  },
  'chat.limits': { messages_per_minute: 20, dm_requests_per_day: 20, mentions_per_message: 8 },
  'discovery.defaults': { radius_miles: 100, max_radius_miles: 500 },
};
