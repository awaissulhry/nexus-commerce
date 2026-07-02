# S0 — Current-State Audit & Architecture Decisions

**Workstream:** Nexus Commerce Enterprise Access Control (Auth + RBAC), phases S0–S5.
**This phase:** S0 — Discovery & architecture. **Read-only. Zero code changes.**
**Date:** 2026-07-03.
**Repo:** `apps/web` (Next.js App Router, Vercel) · `apps/api` (Fastify, Railway) · `packages/database` (Prisma/Neon Postgres) · `packages/shared`.

> **Sibling documents** (read together):
> - `S0-ENUMERATION-PAGES.md` — all 310 web pages + 18 route handlers + nav architecture
> - `S0-ENUMERATION-ENDPOINTS.md` — all 2,028 API endpoints + mount map + special cases
> - `S0-ENUMERATION-FINANCIAL-FIELDS.md` — 327 models + auth models + 191 restricted-financial fields
> - `S0-PERMISSION-REGISTRY.md` — proposed permission registry + default role matrix
> - `S0-SCHEMA.md` — proposed Prisma diff + reversible migration plan
> - `S0-DESIGN-SYSTEM.md` — design-system inventory for the Settings › Team & Access console
> - `S0-FINDINGS.md` — risk register of what is exposed/dangerous today

> **Secret hygiene:** no secret values, tokens, or `DATABASE_URL` appear anywhere in these documents — only environment-variable **names** and file paths.

---

## 1. The blunt truth: there is no authentication today

**Both backends are reachable from the public internet with zero credentials.**

- **Fastify API (Railway)** — `apps/api/src/index.ts:401` creates the app; `:663-666` binds `0.0.0.0` on `PORT`. Global hooks are request-id propagation (`:410`), compression, multipart (50 MB), rate-limit (2000/min/IP, killable via `NEXUS_DISABLE_RATE_LIMIT=1`), and CORS. **There is no global auth hook.** Of 2,028 endpoints, exactly **3** carry a guard, and it is the *soft* `allowApiKeyScope` gate that falls through to unauthenticated when no `Authorization` header is present (`products.routes.ts:155`, `listings-syndication.routes.ts:3241`, `products-catalog.routes.ts:1585`). The *hard* gate `requireApiKeyScope` exists but is wired to **zero** routes.
- **Next.js shadow backend (Vercel)** — a second data plane. 17 `app/api/*` route handlers + 46 web files import `@nexus/database` and query Prisma **directly from Vercel functions** using `DATABASE_URL`. Some are destructive (`DELETE /api/catalog/products/[id]`, `POST /api/catalog/cache-clear`, `DELETE /api/outbound/queue/[queueId]`). None check auth.
- **CORS is not authentication.** The API allow-lists 3 web origins with `credentials:true` (`apps/api/src/lib/cors-origins.ts`), but CORS only constrains *browsers*. `curl`, Postman, and any server-to-server client bypass it entirely and can call `POST /admin/repair/all`, `POST /admin/recycle-bin/purge`, refund endpoints, credential/OAuth routes, and live channel-publish endpoints.

This is the single gap the entire S1–S5 workstream closes, and **it must be closed on both data planes.** See `S0-FINDINGS.md` for the ranked risk register.

### What already exists (and why it helps)

The schema and code carry a **built-but-inert single-operator account feature** — scaffolding that explicitly anticipates "Phase I session middleware" (the phrase recurs in `api-key-hook.ts`, `profile.routes.ts`, and the `UserSession` schema comment). We inherit, not invent:

| Asset | Location | State |
|---|---|---|
| `UserProfile` (email, `passwordHash`, TOTP `twoFactorSecret`) | `schema.prisma:3517` | Model + write paths exist; **no role/permission field** |
| `UserSession` (refresh-token session rows) | `schema.prisma:3667` | Model exists; **no writer** — awaits the auth handshake |
| `LoginEvent` (login attempt history) | `schema.prisma:3692` | Model exists; outcome vocabulary already defined |
| `TwoFactorRecoveryCode` | `schema.prisma:3647` | Model exists (bcrypt-hashed codes) |
| `ApiKey` (real `scopes[]`, `ipAllowlist[]`, expiry, rotation) | `schema.prisma:3485` | **Working machine RBAC** — the vocabulary precedent for human RBAC |
| `AuditLog` (append-only via DB triggers) | `schema.prisma:6270` | Live + hardened; `userId` currently always `null` |
| Password verify + TOTP enroll/verify | `apps/api/src/routes/profile.routes.ts` | otplib + bcryptjs; endpoints themselves unauthenticated today |
| `verifyApiKey` (bcrypt + legacy SHA-256, scope/IP/expiry/rotation) | `apps/api/src/lib/api-key-auth.ts` | Working; `CANONICAL_SCOPES` at `:70` |
| `CANONICAL_SCOPES` registry (9 scopes) | `apps/api/src/lib/api-key-auth.ts:70` | `analytics:read` = "profit + ad-spend rollups" — natural `financials.view` precedent |

**Consequence for S1:** password hashing, TOTP, session/login tables, and an append-only audit log are already modelled. S1 is largely *wiring the handshake and enforcing* what exists — plus upgrading bcrypt→argon2id (a dependency add) and adding the RBAC layer that does not exist at all.

---

## 2. Domain topology & session-cookie decision (gates the whole design)

**How the web talks to the API today:** the browser calls Railway **directly, cross-origin**. `getBackendUrl()` (`apps/web/src/lib/backend-url.ts`) returns `NEXT_PUBLIC_API_URL` with a hardcoded Railway fallback; **623 web files** use it. There is **no Next.js rewrite/proxy** (`next.config.js` has only `/pim` redirects; `vercel.json` is turbo-ignore only). 26+ `EventSource` (SSE) streams and 21 browser→Railway `FormData` uploads (up to 50 MB) also go direct.

**The cookie problem:** `nexus-commerce-three.vercel.app` and `nexusapi-production-b7bb.up.railway.app` are on two different **Public Suffix List** suffixes (`vercel.app`, `up.railway.app`). Browsers refuse to set a cookie on either suffix as a shared parent domain, so **a first-party session cookie shared between web and API is impossible on the current hostnames.** This decision must be made before S1 issues its first cookie.

### Options

| Option | Mechanism | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Custom apex domain** (recommended) | `app.xavia.it` (Vercel) + `api.xavia.it` (Railway); cookie `Domain=.xavia.it; Secure; HttpOnly; SameSite=Lax` | Same-site (not same-origin) → cookie rides XHR + SSE + uploads with `credentials:'include'`; **zero change to the 623 direct-call sites**; SSE + 50 MB uploads keep their direct path; immune to third-party-cookie phase-out. `xavia.it` already owned (email `From`). | Requires DNS + domain config on both platforms; add origins to `cors-origins.ts`; update `NEXT_PUBLIC_API_URL`/`NEXUS_WEB_URL`; normalise SSE `withCredentials`. | **Clean end-state** |
| **B. Proxy all API traffic through Next.js** | `/backend/:path*` rewrite → Railway; cookie host-only first-party on web origin; CORS disappears | No custom domain needed; simplest cookie story | **Breaks 50 MB uploads** (Vercel function body limit ~4.5 MB); long-lived SSE bounded by function duration + reconnect churn; double-hop latency + Vercel bandwidth billing on every SSE/export byte. High risk given 26+ SSE + heavy upload/download surfaces. | Rejected (regresses working flows) |
| **C. Cross-site cookie as-is** | Railway sets `SameSite=None; Secure` on its host; web sends `credentials:'include'` | No infra change; API already runs credentialed CORS | Third-party cookie: Safari ITP blocks outright; Chrome phase-out makes it fragile | Stopgap only |
| **D. Bearer/refresh token** (no cookie) | Token in memory/localStorage; `Authorization` header | Works cross-origin without domain work | localStorage = XSS-exfiltratable; **breaks SSE** (EventSource cannot send headers) and `<a href>` file downloads; contradicts the server-session/instant-revocation requirement | Rejected as primary |

**Recommendation: Option A (custom apex domain).** It is the only option that preserves every working flow (direct SSE, 50 MB uploads, file-download links), gives httpOnly first-party cookies with instant server-side revocation, and needs no rewrite of 623 call sites. **This is the primary decision I need ratified at the S0 gate** — see §7.

**SSE + downloads note:** even with cookies working, EventSource cannot send an `Authorization` header and `<a href>` downloads open outside fetch. With Option A the cookie rides both automatically. If you pick anything else, the 12 SSE endpoints (`S0-ENUMERATION-ENDPOINTS.md §4c`) and 39 file endpoints (`§4d`) need cookie-or-query-token auth designed in explicitly.

---

## 3. Session strategy: Postgres source-of-truth, Redis as optional cache

The master prompt suggests Upstash Redis for sessions. **Discovery says: make Postgres the source of truth, treat Redis as an optional accelerator.** Rationale:

- **No Upstash reference exists** in the repo. Redis is reached via `REDIS_URL`/`REDIS_HOST` (`apps/api/src/lib/queue.ts`, ioredis). Provider is unconfirmed from code.
- The ads L2 cache is **circuit-breakered specifically because "Redis is unreachable on prod"** (its own comment) — Redis has been flaky. The whole codebase degrades gracefully without it.
- `UserSession` (a DB session table) **already exists** and is the intended session substrate ("the only writer for now is the eventual auth handshake").
- Rate-limiting today is **in-memory per-instance**, not Redis-backed — inadequate for a login endpoint under multiple Railway replicas.

**Proposed design:**
- **Sessions:** row in `UserSession` (Postgres) is authoritative; opaque session ID in an httpOnly cookie; server looks up the row per request. Instant revocation = delete/flag the row. This satisfies requirement §3.9 (server-side sessions, instant lockout) without depending on Redis uptime.
- **Permission-version stamp (requirement §3.5):** a `permissionsVersion` integer on the user (or role), bumped on any role/permission mutation. Cache the resolved permission set keyed by `(userId, permissionsVersion)`. **Redis if available; in-process LRU with short TTL as the guaranteed fallback** so a Redis outage degrades to "re-resolve from DB", never to "auth fails open".
- **Login rate-limit / lockout:** persist attempt counters. Use Redis if present; otherwise DB-backed counters on `UserProfile`/`LoginEvent`. Never in-memory-only for the login path.
- **`rediss://` uses `rejectUnauthorized:false`** (`queue.ts`) — TLS cert validation disabled. Flag for S1 hardening if Redis handles any auth state.

---

## 4. Email capability: YES — Resend

Auth emails (invitations, password resets, login/MFA notifications) are feasible in v1 without new infrastructure.

- Single choke point: `apps/api/src/services/email/transport.ts` → `sendEmail()` → Resend HTTP API with `RESEND_API_KEY`. No SMTP/SES/SendGrid/Postmark.
- **Hard dry-run gate:** unless `NEXUS_ENABLE_OUTBOUND_EMAILS === 'true'`, every send is mocked and logged. Default `From`: `NEXUS_EMAIL_FROM` (`Xavia <ship@xavia.it>`).
- Supports attachments + raw headers (List-Unsubscribe already used). `EmailSuppression` model (`schema.prisma:10525`) backs GDPR unsubscribe.

**Decision:** invitations and password resets ship as **both** a copyable secure link (works with email disabled) **and** an email send when `NEXUS_ENABLE_OUTBOUND_EMAILS=true`. This satisfies the master prompt's "copyable links if no provider" floor while using the real provider that exists. Auth transactional emails should **bypass** `EmailSuppression` (security messages are not marketing) — a design note for S1.

---

## 5. Design system: build the console from existing components

Full inventory in `S0-DESIGN-SYSTEM.md`. Headline: the DS (`apps/web/src/design-system`, 53 exports across primitives/components/patterns) can build the entire Team & Access console. The universal `DataGrid`, `Modal`, `Drawer`, `Tabs`, `Toggle`, `Checkbox`, `Select`/`Combobox`/`MultiSelect`, `Tag`/`Pill`, `Toast`, `DateRangePicker`, `Pagination`, `EmptyState`, `Stepper`, `Menu`, `BulkActionBar`, `EditModeBar`, and `TagInput` all exist.

**5 thin gaps** (all compositions over existing pieces except Avatar): **Avatar**, **FormField** (label+error wrapper), **Button `danger` variant**, a **dedicated ConfirmDialog** wrapper (convention today is a composed `Modal`), and the **permission-matrix** component (best built as `DataGrid<PermissionRow>` with a Toggle/Checkbox per role column — the `settings/notifications` event×channel toggle table at `NotificationsClient.tsx:457-590` is the exact precedent).

**Placement:** Team & Access slots into the existing Settings shell (`app/settings/layout.tsx` + `_shell/settings-nav.ts`) as a new rail group, rendering DS components inside (the /products/next "DS-first inside a shell" pattern). Legacy `components/ui/*` (old ConfirmDialog, old ToastProvider) are **off-limits** for new UI per the design-system mandate.

---

## 6. Auth library recommendation

**Requirements:** credentials-first (invite-only, no social login), server-side sessions with instant revocation, TOTP MFA, and a **custom RBAC layer regardless of choice** (page/feature/field permissions with channel scoping — no library ships this).

| Candidate | Fit | Verdict |
|---|---|---|
| **Auth.js (NextAuth)** | Next-centric; database-session adapter exists. But it assumes auth lives in the Next app — our security boundary is the **Fastify API** (the shadow Next backend is secondary). Credentials provider is deliberately limited; bending it to a Fastify-primary, cookie-on-custom-domain, cross-plane model fights the framework. Heavy for what we use. | **No** |
| **better-auth** | Modern, TS-first, good primitives. But newer/smaller ecosystem, and it still wants to own session issuance in a way that doesn't map cleanly onto "Fastify is the boundary + a second Next data plane + existing `UserProfile`/`UserSession`/`ApiKey` tables we must reuse." We'd fight its schema ownership. | **No** |
| **Lean custom session layer** on vetted primitives | argon2id (`@node-rs/argon2` or `argon2`) for passwords · `otplib` (already a dep) for TOTP · `qrcode` (already a dep) for enrolment · Node `crypto` for session IDs/tokens (random, stored hashed) · sessions in the existing `UserSession` table · a Fastify `preHandler`/`onRequest` guard reading the cookie. **No hand-rolled crypto** — only vetted libraries; the "custom" part is orchestration + the RBAC engine, which is custom no matter what. | **Recommended** |

**Recommendation: lean custom session layer.** The security boundary is Fastify, not Next; the session/login/2FA/API-key tables already exist and match a bespoke design; the RBAC engine (the actual hard part) is custom under every option; and we avoid a heavy framework fighting a two-data-plane, custom-domain, cross-origin topology. Concretely: keep `otplib`/`qrcode`, **add argon2id** (replacing bcryptjs for password hashing — bcrypt verify kept only for one-time migration of any legacy hash), keep sessions in `UserSession`, enforce in a Fastify hook, and mirror a minimal session check in the Next shadow backend (or fold those 17 handlers behind the Fastify API — see the S1 open question in §7).

---

## 7. Decisions I need at the S0 gate

Everything above is a proposal. Before S1 writes code, please confirm:

1. **Domain/cookie strategy (§2).** Approve **Option A (custom apex, e.g. `app.xavia.it` + `api.xavia.it`)**? If a domain isn't available soon, I can start S1 on Option C (cross-site `SameSite=None`) as a labelled stopgap and cut over — but A is the clean target. *This is the load-bearing decision.*
2. **Session store (§3).** Approve **Postgres `UserSession` as source of truth, Redis as optional cache** (rather than Redis-primary as the prompt suggested)?
3. **Auth library (§6).** Approve the **lean custom layer** (+ argon2id) over Auth.js/better-auth?
4. **Shadow Next backend (§1).** Two data planes both need protection. Preference: (a) guard the 17 `app/api/*` handlers + 46 direct-Prisma files in place, or (b) route them through the now-authenticated Fastify API and delete the direct-Prisma path? (b) is more secure long-term; (a) is faster. I lean (a) for S1, (b) as follow-up.
5. **Channel-scoping (master prompt §4).** Schema will support optional per-channel/marketplace role scoping from day one (`UserRole.channelScope`). Confirm the **UI** for it can ship later (S4+) while the schema lands now?
6. **Financial field-level borderline calls.** Several fields need a human ruling (order-level price vs revenue aggregates, refund amounts for returns staff, carrier costs, MAP/min-price floors, invoice amounts on printed docs). These are enumerated in `S0-PERMISSION-REGISTRY.md §4`; I'll need those answered before S2's field-level serializers, not before S1.

Once 1–5 are ratified I'll proceed to S1 (Authentication core). No code has been written in S0.
