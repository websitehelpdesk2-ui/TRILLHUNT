-- THRILLHUNT — relational schema
-- Dialect: SQLite (dev/MVP). Written to port cleanly to PostgreSQL:
--   TEXT PRIMARY KEY (ULID-ish ids) -> keep, or uuid
--   INTEGER 0/1 booleans            -> boolean
--   TEXT timestamps (ISO-8601 UTC)  -> timestamptz
--   json stored as TEXT             -> jsonb
-- All timestamps are ISO-8601 UTC strings. Soft deletion via deleted_at.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================ IDENTITY

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,              -- scrypt: salt:params:hash
  role              TEXT NOT NULL DEFAULT 'user'
                      CHECK (role IN ('user','business','moderator','admin')),
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','restricted','suspended','banned')),
  status_reason     TEXT,
  restricted_until  TEXT,
  violation_count   INTEGER NOT NULL DEFAULT 0,
  -- 18+ HARD GATE: no account may be created without an affirmation record.
  age_confirmed_at  TEXT NOT NULL,
  age_attestation   TEXT NOT NULL,              -- text of the affirmation shown, versioned
  tos_version       TEXT NOT NULL,
  last_login_at     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS profiles (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username           TEXT NOT NULL UNIQUE,
  display_name       TEXT,
  avatar_emoji       TEXT NOT NULL DEFAULT '🎯',
  bio                TEXT,
  home_city          TEXT,                      -- coarse, user-supplied, display only
  home_lat           REAL,                      -- PRIVATE. never returned by public APIs
  home_lng           REAL,                      -- PRIVATE. used only to compute coarse distance
  xp                 INTEGER NOT NULL DEFAULT 0,
  level              INTEGER NOT NULL DEFAULT 1,
  favorite_categories TEXT NOT NULL DEFAULT '[]',
  -- privacy controls (§15)
  profile_visibility  TEXT NOT NULL DEFAULT 'public'
                        CHECK (profile_visibility IN ('public','members','private')),
  dm_policy           TEXT NOT NULL DEFAULT 'requests'
                        CHECK (dm_policy IN ('everyone','requests','groups_only','nobody')),
  discoverable_nearby INTEGER NOT NULL DEFAULT 1,
  attendance_public   INTEGER NOT NULL DEFAULT 1,
  activity_public     INTEGER NOT NULL DEFAULT 1,
  share_coarse_location INTEGER NOT NULL DEFAULT 1,
  notification_prefs  TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,               -- sha256(token); raw token never stored
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_secret   TEXT NOT NULL,
  user_agent    TEXT,
  ip_hash       TEXT,                           -- hashed, not raw IP
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ======================================================= SUBSCRIPTIONS

CREATE TABLE IF NOT EXISTS subscriptions (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                TEXT NOT NULL,        -- 'stripe' | 'mock'
  provider_customer_id    TEXT,
  provider_subscription_id TEXT,
  plan_id                 TEXT NOT NULL,        -- app_config plan key
  status                  TEXT NOT NULL
                            CHECK (status IN ('trialing','active','past_due','canceled','expired','incomplete')),
  cancel_at_period_end    INTEGER NOT NULL DEFAULT 0,
  current_period_start    TEXT,
  current_period_end      TEXT,
  last_payment_error      TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subs_provider ON subscriptions(provider, provider_subscription_id);

-- Derived, server-owned. NEVER written from a client request.
CREATE TABLE IF NOT EXISTS subscription_entitlements (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,                    -- 'image_upload','ai_advanced','offline','mystery_exclusive',...
  granted     INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL,                    -- 'subscription:<id>' | 'admin:<user_id>' | 'plan:free'
  expires_at  TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS payment_events (
  id           TEXT PRIMARY KEY,                -- provider event id (idempotency)
  provider     TEXT NOT NULL,
  type         TEXT NOT NULL,
  user_id      TEXT,
  payload      TEXT NOT NULL,
  processed_at TEXT,
  created_at   TEXT NOT NULL
);

-- ============================================================ CATALOG

CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  icon       TEXT NOT NULL,
  blurb      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS locations (
  id                 TEXT PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  tagline            TEXT,
  description        TEXT,
  -- §3 provenance: every record is explicitly one of these.
  data_source        TEXT NOT NULL DEFAULT 'community'
                       CHECK (data_source IN ('verified','community','restricted')),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
                       CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  verified_at        TEXT,
  verified_by        TEXT REFERENCES users(id),
  is_demo            INTEGER NOT NULL DEFAULT 0,   -- §52 demo data is always labeled
  access_policy      TEXT NOT NULL DEFAULT 'open'
                       CHECK (access_policy IN ('open','ticketed','reservation','permit','guided','private_closed')),
  -- destination data for navigation hand-off (§68). Never invented.
  address_line       TEXT,
  city               TEXT,
  region             TEXT,
  postal_code        TEXT,
  country            TEXT NOT NULL DEFAULT 'US',
  lat                REAL,
  lng                REAL,
  place_id           TEXT,                        -- external map provider id when known
  address_precision  TEXT NOT NULL DEFAULT 'exact'
                       CHECK (address_precision IN ('exact','approximate','unknown')),
  website_url        TEXT,
  phone              TEXT,
  hours_json         TEXT,                        -- null = unknown, never guessed
  price_text         TEXT,
  price_min_cents    INTEGER,
  reservation_url    TEXT,
  -- thrill metrics: community-aggregated, 0-10 scaled x10 stored as REAL
  fear               REAL, paranormal REAL, isolation REAL, darkness REAL, difficulty REAL,
  rating_avg         REAL NOT NULL DEFAULT 0,
  rating_count       INTEGER NOT NULL DEFAULT 0,
  interested_count   INTEGER NOT NULL DEFAULT 0,
  trending_score     REAL NOT NULL DEFAULT 0,
  -- §11 safety block. NULL means "information unavailable" — never fabricated.
  safety_level       TEXT CHECK (safety_level IN ('low','caution','elevated','high')),
  safety_json        TEXT,
  submitted_by       TEXT REFERENCES users(id),
  moderation_status  TEXT NOT NULL DEFAULT 'approved'
                       CHECK (moderation_status IN ('approved','pending','blocked')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_loc_geo ON locations(lat, lng);
CREATE INDEX IF NOT EXISTS idx_loc_trending ON locations(trending_score DESC);
CREATE INDEX IF NOT EXISTS idx_loc_rating ON locations(rating_avg DESC);
CREATE INDEX IF NOT EXISTS idx_loc_status ON locations(moderation_status, deleted_at);

CREATE TABLE IF NOT EXISTS location_categories (
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (location_id, category_id)
);

CREATE TABLE IF NOT EXISTS business_profiles (
  id            TEXT PRIMARY KEY,
  location_id   TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  legal_name    TEXT NOT NULL,
  contact_email TEXT,
  claim_status  TEXT NOT NULL DEFAULT 'unclaimed'
                  CHECK (claim_status IN ('unclaimed','pending','verified','rejected')),
  claim_evidence TEXT,
  verified_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  location_id   TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  starts_at     TEXT NOT NULL,
  ends_at       TEXT,
  price_text    TEXT,
  ticket_url    TEXT,
  data_source   TEXT NOT NULL DEFAULT 'community'
                  CHECK (data_source IN ('verified','community')),
  is_demo       INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(starts_at);

-- =========================================================== UGC

CREATE TABLE IF NOT EXISTS reviews (
  id          TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        TEXT,
  moderation_status TEXT NOT NULL DEFAULT 'approved'
                  CHECK (moderation_status IN ('approved','pending','blocked')),
  created_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_loc ON reviews(location_id);

CREATE TABLE IF NOT EXISTS thrill_reports (
  id            TEXT PRIMARY KEY,
  location_id   TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visited_on    TEXT,
  fear          INTEGER, paranormal INTEGER, isolation INTEGER,
  darkness      INTEGER, difficulty INTEGER, value INTEGER, overall INTEGER,
  would_return  INTEGER,
  body          TEXT,
  moderation_status TEXT NOT NULL DEFAULT 'approved'
                  CHECK (moderation_status IN ('approved','pending','blocked')),
  like_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tr_loc ON thrill_reports(location_id);
CREATE INDEX IF NOT EXISTS idx_tr_feed ON thrill_reports(created_at DESC);

CREATE TABLE IF NOT EXISTS post_likes (
  thrill_report_id TEXT NOT NULL REFERENCES thrill_reports(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (thrill_report_id, user_id)
);

-- Unified media table (photos + videos).
CREATE TABLE IF NOT EXISTS media_assets (
  id              TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('image','video')),
  storage_key     TEXT NOT NULL,                -- private object key, never returned raw
  mime            TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  width           INTEGER, height INTEGER,
  sha256          TEXT NOT NULL,
  exif_stripped   INTEGER NOT NULL DEFAULT 0,
  moderation_status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (moderation_status IN ('pending','approved','review','blocked')),
  moderation_provider TEXT,
  moderation_json TEXT,
  attached_to     TEXT,                          -- 'message' | 'thrill_report' | 'location'
  created_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media_assets(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_media_mod ON media_assets(moderation_status);

-- ========================================================== SOCIAL

CREATE TABLE IF NOT EXISTS groups (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  location_id  TEXT REFERENCES locations(id) ON DELETE SET NULL,
  planned_date TEXT,
  visibility   TEXT NOT NULL DEFAULT 'private'
                 CHECK (visibility IN ('public','private')),
  max_members  INTEGER NOT NULL DEFAULT 12,
  invite_code  TEXT UNIQUE,
  created_by   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  deleted_at   TEXT
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  joined_at TEXT NOT NULL,
  left_at   TEXT,
  PRIMARY KEY (group_id, user_id)
);

-- One chat abstraction for location chats, group chats and DMs.
CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('location','group','dm')),
  location_id TEXT REFERENCES locations(id) ON DELETE CASCADE,
  group_id    TEXT REFERENCES groups(id) ON DELETE CASCADE,
  title       TEXT,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_location ON chats(location_id) WHERE location_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_group ON chats(group_id) WHERE group_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT 'active'
               CHECK (state IN ('active','requested','muted','left')),
  last_read_at TEXT,
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT,
  reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  moderation_status TEXT NOT NULL DEFAULT 'approved'
                CHECK (moderation_status IN ('approved','pending','blocked')),
  created_at  TEXT NOT NULL,
  edited_at   TEXT,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS message_attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_id   TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, media_id)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS attendance (
  id          TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('interested','going','completed')),
  going_date  TEXT,
  visibility  TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  created_at  TEXT NOT NULL,
  UNIQUE (location_id, user_id, going_date)
);
CREATE INDEX IF NOT EXISTS idx_att_loc ON attendance(location_id, going_date);

CREATE TABLE IF NOT EXISTS saved_locations (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, location_id)
);

CREATE TABLE IF NOT EXISTS user_blocks (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'block' CHECK (kind IN ('block','mute')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, target_id, kind)
);

-- ===================================================== TRIPS / AI

CREATE TABLE IF NOT EXISTS trips (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id      TEXT REFERENCES groups(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  plan_json     TEXT NOT NULL,
  starts_at     TEXT,
  status        TEXT NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned','active','completed','canceled')),
  -- §46 Trip Check-In. Emergency contact is PRIVATE to the owner.
  emergency_contact_name  TEXT,
  emergency_contact_value TEXT,
  checkin_started_at      TEXT,
  checkin_due_at          TEXT,
  checkin_closed_at       TEXT,
  checkin_outcome         TEXT CHECK (checkin_outcome IN ('home','help_requested','expired')),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_recommendations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  result_json TEXT NOT NULL,
  location_ids TEXT NOT NULL DEFAULT '[]',   -- grounding set; AI may only cite these
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_user ON ai_recommendations(user_id, created_at);

CREATE TABLE IF NOT EXISTS mystery_drops (
  id             TEXT PRIMARY KEY,
  location_id    TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  teaser         TEXT NOT NULL,
  fear_flames    INTEGER NOT NULL DEFAULT 3,
  group_min      INTEGER NOT NULL DEFAULT 2,
  group_max      INTEGER NOT NULL DEFAULT 6,
  radius_miles   INTEGER NOT NULL DEFAULT 100,
  pro_only       INTEGER NOT NULL DEFAULT 0,
  starts_at      TEXT NOT NULL,
  ends_at        TEXT NOT NULL,
  created_by     TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mystery_drop_reveals (
  drop_id    TEXT NOT NULL REFERENCES mystery_drops(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (drop_id, user_id)
);

-- ==================================================== GAMIFICATION

CREATE TABLE IF NOT EXISTS badges (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  icon        TEXT NOT NULL,
  description TEXT NOT NULL,
  rule_json   TEXT NOT NULL,
  pro_only    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_achievements (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id   TEXT NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  earned_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, badge_id)
);

CREATE TABLE IF NOT EXISTS xp_transactions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  dedupe_key  TEXT,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_dedupe ON xp_transactions(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ================================================ TRUST & SAFETY

CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  reporter_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  subject_type  TEXT NOT NULL
                  CHECK (subject_type IN ('user','profile','message','image','video','location','review','thrill_report','group','event')),
  subject_id    TEXT NOT NULL,
  reason        TEXT NOT NULL,
  details       TEXT,
  case_id       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_subject ON reports(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS moderation_cases (
  id             TEXT PRIMARY KEY,
  subject_type   TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  owner_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  origin         TEXT NOT NULL CHECK (origin IN ('user_report','auto_moderation','admin','appeal')),
  severity       TEXT NOT NULL DEFAULT 'normal'
                   CHECK (severity IN ('low','normal','high','critical')),
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','in_review','actioned','dismissed','escalated')),
  report_count   INTEGER NOT NULL DEFAULT 0,
  assigned_to    TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  resolved_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_subject ON moderation_cases(subject_type, subject_id, status)
  WHERE status IN ('open','in_review');
CREATE INDEX IF NOT EXISTS idx_case_status ON moderation_cases(status, severity);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id          TEXT PRIMARY KEY,
  case_id     TEXT REFERENCES moderation_cases(id) ON DELETE CASCADE,
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,   -- remove_content|warn|restrict|suspend|ban|dismiss|approve|reinstate
  target_user TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT,
  meta_json   TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appeals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id     TEXT REFERENCES moderation_cases(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','granted','denied')),
  decided_by  TEXT REFERENCES users(id),
  decided_at  TEXT,
  created_at  TEXT NOT NULL
);

-- Location-specific safety issue reports (§10 "Report Safety Issue").
CREATE TABLE IF NOT EXISTS safety_reports (
  id          TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  issue_type  TEXT NOT NULL,   -- closed|hazard|access_denied|inaccurate_info|unsafe_conditions|other
  severity    TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('low','normal','high','critical')),
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
  case_id     TEXT REFERENCES moderation_cases(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT,
  action     TEXT NOT NULL,
  subject    TEXT,
  meta_json  TEXT,
  ip_hash    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS rate_events (
  bucket     TEXT NOT NULL,
  window_ts  INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_ts)
);

-- Admin-configurable business rules (§18 price, §25 thresholds, §27 limits).
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
