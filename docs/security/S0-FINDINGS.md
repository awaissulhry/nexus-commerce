# S0 — Findings & Risk Register

Vulnerabilities and dangerous conditions discovered during read-only S0 discovery. Ordered by severity. Every finding has file:line evidence and a phase where it gets closed. **No secret values appear here — env-var names only.**

**Context:** the platform is single-operator today and (per the deployment) not widely advertised, which is the only reason these are not already being exploited. They are nonetheless live on the public internet. **F1–F4 are the reason this workstream exists.**

---

## 🔴 Critical

### F1 — The entire API is unauthenticated on the public internet
Both backends accept anonymous calls to nearly every endpoint.
- Fastify API binds `0.0.0.0` (`apps/api/src/index.ts:663-666`) with **no global auth hook**; the hard gate `requireApiKeyScope` is on **0 of 2,028 endpoints** (`lib/api-key-hook.ts:69` def only); the soft gate is on 3 and falls through when no header is sent.
- CORS (`index.ts:481`, `lib/cors-origins.ts`) restricts *browsers* to 3 origins but does nothing to `curl`/Postman/server-to-server.
- The Next.js shadow backend (17 `app/api/*` handlers + 46 direct-Prisma files on Vercel) is equally open.
**Impact:** full read/write of the entire commerce dataset by anyone who knows the Railway URL (which is also in `NEXT_PUBLIC_API_URL`, shipped to every browser).
**Closed by:** S1 (session middleware) + S2 (deny-by-default `requirePermission` on every route, CI-proven).

### F2 — Destructive `/admin/*` endpoints callable with zero credentials
`routes/admin.ts` is header-commented "Protected endpoints" but has **no auth preHandler**. Anonymous callers can invoke:
- `POST /admin/repair/all` (`admin.ts:260`), `POST /admin/recycle-bin/purge` (`:1001`, permanent deletes), `POST /admin/repair/channel-listings` (`:401`), `POST /admin/normalize-image-urls` (`:345`).
- Token/infra mutations: `POST /api/admin/setup-amazon-notifications` (`amazon-notifications.routes.ts:178`), `POST /admin/refresh-ebay-tokens` (`ebay-notification.routes.ts:157`), `POST /admin/setup-ebay-notifications` (`:204`).
- 58 destructive endpoints total (wipe/backfill/restore/purge/reset/rollback) enumerated in `S0-ENUMERATION-ENDPOINTS.md §4e`.
**Impact:** anonymous data destruction and channel-integration tampering.
**Closed by:** S2 — `admin.*` permissions (OWNER/ADMIN only). **Interim option:** if you want a stopgap before S1 lands, a single env-gated shared-secret header on `/admin/*` + the internal webhooks buys time — say the word and I'll propose it as a hotfix outside the phased plan.

### F3 — Internal stock-mutation webhooks are unsigned
`POST /api/webhooks/order-created` and `POST /webhooks/stock-adjustment` (`webhooks.routes.ts:59,137`) adjust inventory with **no signature/secret**. Note the second has **no `/api` prefix** — an `/api/*`-scoped matcher would miss it.
**Impact:** anyone can decrement/inflate stock, corrupting availability and triggering downstream repricing/replenishment.
**Closed by:** S2 (signature or internal-auth on these two) — and flagged now because the fix is small and independent.

### F4 — Two data planes, both open; Vercel holds DB credentials
46 web files + 17 `app/api/*` routes query Prisma **directly from Vercel** with `DATABASE_URL` (`apps/web/.env.local`, Vercel env). Several are destructive (`DELETE /api/catalog/products/[id]`, `POST /api/catalog/cache-clear`, `DELETE /api/outbound/queue/[queueId]`) and some direct-Prisma readers (`api/products`, `api/listings`, `products/[id]/datasheet/export.json`) expose DB data with no gate.
**Impact:** doubles the credential blast radius and the attack surface; auth must be enforced in **two** codebases.
**Closed by:** S1/S2 must cover both planes. **Decision needed** (`S0-AUDIT.md §7 Q4`): guard-in-place vs consolidate behind the API.

---

## 🟡 High / Medium

### F5 — Webhook signature verification is inconsistent and non-constant-time
- **Etsy: no verification at all** (`etsy-webhooks.ts:317-345`) — the validator `validateEtsySignature` exists (`utils/webhook.ts:71`) but is never called.
- **WooCommerce: skipped when no secret** configured (`woocommerce-webhooks.ts:295-306`).
- **eBay: conditional** on `EBAY_NOTIFICATION_VERIFICATION_TOKEN` being set (`ebay-notification.routes.ts:355-364`); unset ⇒ payloads accepted unverified. Also the base string may be re-`JSON.stringify`'d (no `fastify-raw-body` plugin registered) which can break/loosen verification.
- **Shopify/Woo/Etsy use plain `hash === header`** string compare (`utils/webhook.ts:26,78`) — **not** constant-time (Cloudinary/Sendcloud/eBay correctly use `timingSafeEqual`).
**Impact:** forged channel notifications; timing side-channel on HMAC compare. (Etsy/Woo are out-of-scope channels per project memory, but the routes are live.)
**Closed by:** S2 hardening pass (constant-time compare everywhere; enforce-or-disable unverified receivers).

### F6 — Audit trail has no actor identity
`AuditLog.userId` is hardcoded `null` on every write (`utils/settings-audit.ts:93`, `pim-global.routes.ts:567`, web `lib/settings-audit.ts:147` — "will populate from session in Phase I"). `ip` likewise generally unset.
**Impact:** no accountability — mutations cannot be attributed. The append-only triggers protect integrity but the "who" is missing.
**Closed by:** S1 begins stamping `userId`/`ip` from the session; S2 audits every permission denial + admin mutation.

### F7 — Login-grade rate limiting does not exist yet
Rate limiting is **in-memory per-instance** (`@fastify/rate-limit`, 2000/min/IP, `index.ts:452`), globally killable via `NEXUS_DISABLE_RATE_LIMIT=1`, and several read-heavy endpoints are **allow-listed to no limit** (`/api/products/bulk-fetch`, `/api/catalog/products`, `/api/inventory`). Across multiple Railway replicas the in-memory counter is per-replica.
**Impact:** unauthenticated bulk exfiltration is unthrottled today; and this limiter is inadequate as a brute-force guard for the future login endpoint.
**Closed by:** S1 — per-account + per-IP login limits with progressive lockout (DB-backed counters; Redis if available), independent of the global limiter.

### F8 — `rediss://` TLS certificate validation disabled
`apps/api/src/lib/queue.ts` constructs ioredis with `rejectUnauthorized: false` for `rediss://` URLs.
**Impact:** MITM-able Redis transport — relevant if Redis ever holds session/permission state.
**Closed by:** S1 if Redis is used for any auth state (enable cert validation); otherwise noted for general hardening.

### F9 — No security headers on either tier
No `helmet`/equivalent on the Fastify API; no `headers()` in `next.config.js`. Missing HSTS, CSP, `X-Content-Type-Options`, `frame-ancestors`.
**Impact:** clickjacking / MIME-sniff / downgrade exposure.
**Closed by:** S1 (headers on both tiers, CSP tuned to the app).

---

## 🟢 Low / Informational

### F10 — Inert auth scaffolding can create false confidence
`/api/settings/2fa/*` and password endpoints (`profile.routes.ts:16-18`) are themselves **unauthenticated** and operate on a singleton profile; `otplib verifySync` never gates a request; `UserSession` has no writer. The presence of 2FA/session UI can read as "we have auth" when nothing is enforced.
**Mitigation:** S1 wires these into a real handshake; until then, do not treat them as controls.

### F11 — SSE `withCredentials` is inconsistent across 26+ callsites
Most `EventSource` callsites omit `withCredentials`; a few set it (`GlobalDlqBanner.tsx`, `CompetitiveAlertWatcher.tsx`). A cookie-auth rollout must normalise these (or moot them via the same-site custom domain in `S0-AUDIT.md §2` Option A).
**Closed by:** S1/S3 SSE sweep (or Option A makes it automatic).

### F12 — Hardcoded infra URLs will complicate the domain migration
`backend-url.ts` hardcodes the Railway URL as a fallback; API email/link code hardcodes `vercel.app` defaults (`NEXUS_WEB_URL`). Option A (custom domain) must sweep these.
**Closed by:** whichever phase executes the domain cutover.

### F13 — Secret hygiene is currently OK (no committed secrets)
Confirmed: local `.env`/`.env.local`/`packages/database/.env` exist but are git-ignored (`.gitignore:25-27`); only `*.env.example` tracked; `git ls-files` shows no committed secrets; **zero** `NEXT_PUBLIC_*` leaks (exactly one public var, `NEXT_PUBLIC_API_URL`, non-secret). No action needed — recorded as a positive baseline to preserve (S5 secret-scan in CI keeps it that way).

---

## Summary

| Severity | Count | IDs |
|---|---|---|
| 🔴 Critical | 4 | F1 (no auth), F2 (open admin), F3 (unsigned stock webhooks), F4 (dual open data planes) |
| 🟡 High/Med | 5 | F5 (webhook sig), F6 (no audit actor), F7 (rate limit), F8 (redis TLS), F9 (headers) |
| 🟢 Low/Info | 4 | F10 (inert scaffolding), F11 (SSE creds), F12 (hardcoded URLs), F13 (secret hygiene ✅) |

**F1, F2, F3, F4 are internet-exposed today.** If you want any of the three small independent ones (F2 admin shared-secret, F3 webhook signing, F5 Etsy/constant-time) as a **pre-S1 hotfix**, I can scope that separately — otherwise they close in S1/S2 as planned.
