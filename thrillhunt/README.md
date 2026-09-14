# THRILLHUNT

**CHASE THE THRILL. RESPECT THE RISK.**
*Find the places that scare you. Find the people crazy enough to go.*

An 18+ social discovery platform for haunted attractions, paranormal locations, remote camping,
night hikes, road trips and other adrenaline experiences — with a real safety layer, a group-forming
layer, and a paid tier that gates image uploads server-side.

This is a working MVP, not a mockup. It boots, seeds, serves a mobile-first app, an admin dashboard
and a marketing site, and passes 120 automated checks (69 backend, 51 UI).

---

## 1. Run it

Requires **Node 22.6+** and nothing else. No `npm install`, no build step, no Docker, no database
server. Node runs the TypeScript directly (type stripping) and the database is the built-in
`node:sqlite`.

```bash
cd thrillhunt
cp .env.example .env          # optional — sensible defaults are baked in
node scripts/seed.ts --reset  # creates db/thrillhunt.db and loads demo data
node src/server.ts
```

Then open:

| Screen | URL |
| --- | --- |
| Marketing landing page | http://localhost:3000/ |
| The app | http://localhost:3000/app |
| Admin dashboard | http://localhost:3000/admin |

### GitHub Codespaces

```bash
HOST=0.0.0.0 node src/server.ts
```

Forward port **3000**, then set `PUBLIC_URL` to the forwarded `https://…app.github.dev` URL and
`COOKIE_SECURE=true` in `.env` before signing in — the session cookie is `SameSite=Lax; Secure`
over HTTPS, and `PUBLIC_URL` is what checkout redirects and share links are built from.

### Demo accounts

All demo data is fictional and flagged `is_demo` in the database and with a "Sample data" chip in the UI.

| Account | Password | Notes |
| --- | --- | --- |
| `jake@demo.thrillhunt.test` | `DemoPass!2026` | PRO — can upload images |
| `sarah@demo.thrillhunt.test` | `DemoPass!2026` | Free — hits the paywall |
| `mike@demo.thrillhunt.test` | `DemoPass!2026` | Free |
| `kate@demo.thrillhunt.test` | `DemoPass!2026` | PRO |
| `admin@thrillhunt.test` | `AdminPass!2026` | Full admin |
| `mod@thrillhunt.test` | `AdminPass!2026` | Moderator (no config access) |

Group invite code for the seeded crew: **HOLLOW42**.

### Tests

```bash
node tests/run.ts        # 69 backend/security assertions, boots a throwaway server + DB
npm i --no-save jsdom tough-cookie && node tests/ui-smoke.mjs   # 51 UI assertions (server must be running)
```

The UI test is the only thing in the repo that needs packages, and they are deliberately not project
dependencies — the application itself stays at zero.

---

## 2. What was built

Every numbered item below is implemented and exercised by tests or by the seeded demo.

**Accounts & the 18+ gate.** Registration cannot complete without an explicit `age_confirmed === true`;
the attestation text and timestamp are stored on the user row. Scrypt password hashing, server-side
sessions (only a SHA-256 of the token is stored), CSRF double-submit on every state-changing request,
per-IP rate limits.

**Discovery.** Home (trending, events, who's going, mystery drop, recommendations), Explore with
category + sort + filters, natural-language search with visible interpretation, a schematic pin map,
and a location page carrying thrill metrics, KNOW BEFORE YOU GO, the THRILL WARNING, official links,
events, reviews and Thrill Reports.

**Safety layer.** Every listing is labelled VERIFIED / COMMUNITY REPORTED / RESTRICTED and carries a
🟢🟡🟠🔴 indicator that is never colour-only. Unknown fields render
*"Information unavailable. Verify directly with the official operator or property owner."* — the app
has no code path that invents hours, prices, access rules or safety facts. Restricted/closed property
(`access_policy = private_closed`) refuses attendance, refuses group creation, is never returned by
the AI planner or a mystery drop, and points the user at legal guided alternatives instead.

**Social.** Location chats, private groups with invite codes, DMs with a message-request gate and a
`dm_policy` setting, reactions, mute/block, message deletion, per-message reporting.

**Adventures & XP.** "I'm going" with per-night attendance, completion, Thrill Reports with seven
rated dimensions that recompute the location's metrics, XP with levels (Curious → Explorer → Menace →
Chaos Agent → IRL Legend) and the eight badges from the spec, plus a share card.

**PRO & the paywall.** Image upload, advanced filters, unlimited AI planning and PRO-exclusive drops
are entitlements derived on the server from subscription state. The paywall is enforced in the upload
endpoint, in message send, and in Thrill Report attachment — a client that forges a `media_id` or
PATCHes its own profile to grant itself an entitlement gets a 403.

**Image pipeline.** Magic-byte sniffing (a PHP shell renamed `.jpg` is rejected), declared-MIME
agreement, size and rate limits, **real EXIF/GPS stripping** (JPEG APP1/COM segments dropped, PNG
chunks allow-listed), moderation verdict, then storage with a viewer-bound expiring signed URL. A
signed URL replayed by a different account returns 403.

**Moderation & Safety Center.** Unified reporting across 10 subject types and 9 reasons, automatic
quarantine of critical reports, a moderation case queue, an image review queue, a configurable
enforcement ladder (warn → restrict → suspend → ban), appeals, and a full audit log of every staff
action.

**Admin dashboard.** Safety Center with live queue counts, moderation, media queue, users (status +
manual entitlement grants), locations (verification, access policy, safety level), safety reports,
appeals, business claims, configuration and audit log. Role-separated: moderators cannot touch
configuration.

**Find My Thrill (AI).** Intent parsing, candidate retrieval from the database only, a rule-based
pack builder ("THE 12-HOUR NIGHTMARE"), optional LLM refinement behind a validation gate that
discards any location id not in the grounding set, and an explicit list of what could not be verified.

**Trip check-in.** Private emergency contact, a due-back time, and copy that states plainly in three
places that THRILLHUNT is not an emergency service and does not monitor check-ins.

**NAVIGATE hand-off (§66–73).** A reusable `NavigationService` builds Apple Maps universal links on
iOS/macOS, Google Maps universal links on Android and web, and a `geo:` intent so Android can offer
any installed app. It never embeds the user's position, never asks for coordinates it doesn't need,
and falls back to a sheet offering *Copy address* and *Open in browser* when a handoff fails.
Approximate-precision listings say so before you set off.

---

## 3. Structure

```
thrillhunt/
├── db/schema.sql          40+ tables: users, profiles, sessions, subscriptions, entitlements,
│                          locations, categories, business profiles, events, reviews, thrill reports,
│                          media assets, chats, messages, groups, attendance, trips, mystery drops,
│                          badges, XP ledger, reports, moderation cases, appeals, safety reports,
│                          notifications, audit logs, rate events, app config
├── src/
│   ├── config.ts          env loading + provider switches + CONFIG_DEFAULTS (price, entitlements,
│   │                      upload limits, AI caps, enforcement ladder — none hard-coded in features)
│   ├── server.ts          zero-dependency HTTP server, router, static files, CSP + security headers
│   ├── lib/               db, util, auth, guard (rate limit + coarse distance), view serializers
│   ├── services/          entitlements, payments, storage, moderation, notifications, xp, ai
│   └── routes/            auth, discovery, social, content, pro, ai, admin
├── public/
│   ├── index.html         marketing landing page
│   ├── app.html + js/     mobile-first SPA (router, api client, ui kit, NavigationService)
│   ├── admin.html + js/   staff dashboard
│   ├── checkout.html      sandbox payment page
│   └── css/theme.css      design system
├── scripts/seed.ts        12 categories, 8 badges, 8 fictional demo locations, demo users and content
└── tests/                 run.ts (backend), ui-smoke.mjs (UI)
```

## 4. Tech choices

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node 22 with native TS type-stripping | Zero build step; the repo runs as written |
| HTTP | `node:http` + a small router | No framework to audit or keep patched for an MVP |
| Database | `node:sqlite` in dev | Zero setup; the DB surface is four functions (`all/get/run/tx`) so a PostgreSQL swap is a single file |
| Frontend | Vanilla ES modules + CSS custom properties | No bundler; loads instantly on mobile; the JSON contract is framework-agnostic for a later React Native port |
| Auth | httpOnly session cookie + CSRF double-submit | The client can never read the session token |

**Swapping to PostgreSQL:** rewrite `src/lib/db.ts` only. The schema is written portable (`TEXT`
timestamps, no SQLite-specific types); `datetime('now', …)` appears in a handful of analytics
queries and would become `now() - interval …`.

## 5. Configuration is data, not code

`app_config` rows, editable at **Admin → Configuration**, drive: the PRO plan and price, the
entitlement matrix for free and pro, upload limits (size, per-message count, rate, quota, allowed
types, signed-URL TTL), AI daily caps, the enforcement ladder, chat limits and discovery defaults.
Price changes take effect immediately in the app, the checkout page and the API. Nothing in a feature
file contains a price.

## 6. What is mocked, and what production needs

| Area | In this build | To go live |
| --- | --- | --- |
| Payments | Mock provider with signed callbacks routed through the real webhook handler | Set `PAYMENT_PROVIDER=stripe` + `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`. The Stripe adapter (Checkout, billing portal, cancel-at-period-end, HMAC webhook verification) is written, not exercised against live Stripe. |
| Image moderation | Deterministic rules mock (filename/hash hooks so tests can force block/review) | Set `IMAGE_MODERATION_PROVIDER=rekognition` + AWS credentials, or swap in Hive/Sightengine. The adapter interface is one function. **Add a CSAM hash-matching service (PhotoDNA or equivalent) and an NCMEC reporting path before accepting a single public upload.** |
| Text moderation | Rules-based (threats, illegal-access how-to, spam) | Add a classifier; the `moderateText` seam already returns allow/review/block. |
| AI planning | Deterministic rule-based packs; optional real Anthropic call behind `LLM_PROVIDER=anthropic` | Add `ANTHROPIC_API_KEY`. The grounding gate stays either way. |
| Storage | Local disk with path-traversal guards | Set `STORAGE_PROVIDER=s3` + bucket credentials; the S3 driver is a stub with the right shape. |
| Maps | Schematic canvas pin map; real deep links to Apple/Google Maps | Add a tile provider key (`MAPS_PROVIDER=google|mapbox`). Deep-link navigation already works. |
| Email / push | Not sent. Notifications are in-app only | Add an email provider for verification, password reset and receipts; APNs/FCM for push. |
| Age verification | Self-attestation, recorded with timestamp and text | If your counsel requires it, add a third-party age-estimation or ID check at the payment or upload boundary. |
| Video | Not implemented | Needs a transcoding pipeline and frame-level moderation. |

## 7. Security notes

- Session token never leaves the server in readable form (SHA-256 stored); CSRF token is a separate readable cookie compared with a per-session secret.
- Every state-changing route requires the CSRF header; `requireWrite` also blocks suspended, banned and restricted accounts.
- Entitlements are derived from subscription rows on the server. `PATCH /api/me` has an allow-list; there is no client path to grant an entitlement.
- Uploads: magic bytes, MIME agreement, extension agreement, `<?php`/`<script` scan, size cap, rate limit, per-user quota, metadata stripping, moderation, then storage under a random key. Media is served only through a signed, expiring, viewer-bound URL.
- Payment callbacks are HMAC-verified (mock) or Stripe-signature-verified (production); events are idempotent on the provider event id.
- Strict CSP, `X-Content-Type-Options`, `Referrer-Policy`, frame denial; no inline event handlers in shipped HTML.
- Static serving resolves and re-checks the path against the public root.
- Secrets live in `.env`, are read only on the server, and never appear in a client payload.

**Before launch:** move sessions/rate limits to Redis, put the app behind TLS and a WAF, add
structured logging with PII redaction, rotate `APP_SECRET`, add account lockout and email
verification, and commission a penetration test.

## 8. Privacy

Exact user coordinates are never returned to another user. Distances are bucketed server-side
("Less than 1 mile away", "3 miles away", "20 miles away") before serialization. Home coordinates
live on the private profile row and are excluded from every public serializer. Photo EXIF/GPS is
stripped at upload. Users control profile visibility, DM policy, nearby discoverability, attendance
visibility, activity visibility and coarse-location sharing. Emergency contacts and trip plans are
private. Blocked users disappear from chat. The map plots locations only — never people.

## 9. Legal review required

Terms of Service, Privacy Policy (plus state/GDPR disclosures), the 18+ verification approach,
subscription and auto-renewal terms, refund policy, liability waivers and assumption-of-risk language,
the user-content licence, DMCA agent registration, business-listing terms, and the CSAM detection and
reporting programme all require qualified counsel before any public launch. The copy in this build is
placeholder drafting, not legal advice.

## 10. Known limitations

Polling instead of websockets in chat; no offline mode; the map is schematic rather than tiled;
search is keyword + category matching, not semantic; no image thumbnails or CDN; no email delivery;
SQLite means single-writer concurrency; moderation and AI mocks are deterministic by design;
accessibility has been built to a reasonable floor (focus rings, reduced-motion, labelled controls,
non-colour-only status) but has not been audited with a screen reader.

## 11. Next

**Next features:** real-time chat, business self-serve dashboard, event ticketing affiliates,
seasonal leaderboards, photo albums per adventure, carpool coordination, iOS/Android wrappers.

**Launch:** one metro (Omaha/Lincoln) in August, six weeks before Halloween. Seed 150 verified
listings by hand, partner with 10 haunted attractions for launch-night groups, recruit 30 local
horror/outdoor creators.

**First 1,000 users:** local creator partnerships, a "who's going Saturday" hook shared into existing
Facebook and Discord horror groups, and operator co-marketing (they get a free verified listing).

**First 10,000:** expand metro by metro along the same seasonal calendar, ship share cards designed
for TikTok, add the business dashboard so operators drive their own audience in, and run Mystery Drops
as recurring press-worthy moments.

**KPIs:** week-4 retention, % of users who mark "I'm going" in week 1, group-formation rate per
location, Thrill Report rate per completed adventure, free→PRO conversion, moderation queue latency
(target: every critical case actioned inside an hour), and safety-report resolution time.
