# S1 — Authentication Core — Phase Report

**Status:** Code complete, validated locally, **awaiting approval to deploy** (the deploy applies the migration to prod). No production state changed yet.
**Date:** 2026-07-03.

---

## 1. What was built (plain English)

Nexus had **no authentication** — anyone who knew the API URL could call almost anything (S0 finding F1). S1 stands up the real thing: people log in with an email + password, get a **server-side session** (a random token in an httpOnly cookie, validated against the database on every request), and the Owner can **invite** teammates and **reset** passwords. Deactivating a user or resetting a password kills their sessions instantly.

Crucially, **S1 protects only its own new `/api/auth/*` endpoints.** It does *not* yet lock down the other 2,028 endpoints — that deny-by-default sweep is S2, sequenced deliberately so the app keeps working while auth rolls out. So after S1 deploys, nothing existing breaks; we've added the login machinery that S2 will enforce everywhere.

Security properties delivered:
- **argon2id** password hashing (OWASP params), with a strength gate (12-char floor + zxcvbn score ≥ 3) and automatic upgrade of any legacy bcrypt/sha256 hash on next login.
- **Server-side sessions** on the existing `UserSession` table (Postgres is the source of truth — no Redis dependency). Sliding 7-day idle + absolute 30-day cap. Instant revocation.
- **Login hardening**: uniform errors (no account enumeration, incl. a timing equalizer), per-account progressive lockout with exponential backoff, and a per-IP throttle — all durable across restarts/replicas.
- **CSRF protection** (double-submit) appropriate to the cross-site interim cookie mode.
- **Invite-only** onboarding (single-use hashed token, 72h TTL, bound to email + role) and **password reset** (single-use hashed token, ≤60min, revokes all sessions).
- **Security headers** on every API response (HSTS, nosniff, frame denial, CSP).
- **Real audit actor**: auth events + admin mutations now write the actual `userId`/IP to the append-only `AuditLog`, closing S0 finding F6.
- **Env-driven cookie transport** so the custom-domain cutover (Option A) is a config flip, not a rewrite.

## 2. Files

**New — auth library** (`apps/api/src/lib/auth/`):
- `password.ts` — argon2id hash/verify + legacy detection/rehash + zxcvbn strength gate
- `tokens.ts` — CSPRNG opaque tokens + sha256 storage + constant-time compare
- `session.ts` — session create/validate/revoke on `UserSession`; IP truncation; sliding idle
- `cookies.ts` — env-driven cookie config (interim `SameSite=None` ↔ Option-A `SameSite=Lax`)
- `lockout.ts` — per-account + per-IP login lockout
- `csrf.ts` — double-submit-cookie CSRF
- `guards.ts` — `loadSession` / `requireAuth` / `requireOwner` / `requireCsrf` Fastify preHandlers
- `audit.ts` — auth audit writer (real actor)
- `auth.vitest.test.ts` — 26 unit tests

**New — routes / services / scripts:**
- `apps/api/src/routes/auth.routes.ts` — all `/api/auth/*` endpoints
- `apps/api/src/routes/auth-routes.vitest.test.ts` — 7 HTTP-level wiring tests (inject)
- `apps/api/src/services/email/auth-emails.ts` — invite + reset emails (Resend, dry-run-safe)
- `apps/api/src/scripts/bootstrap-owner.ts` — idempotent OWNER bootstrap

**New — migration:**
- `packages/database/prisma/migrations/20260703_s1_auth_core/{migration.sql,rollback.sql}`

**Modified:**
- `packages/database/prisma/schema.prisma` — `SystemRole` enum; `Role`/`UserRole`/`Invitation`/`PasswordResetToken` models; `UserProfile` extensions (status, lockout, `permissionsVersion`, `mfaRequired`, email unique); `UserSession` session-store columns
- `apps/api/src/index.ts` — register `@fastify/cookie`, security-headers hook, `authRoutes`
- `apps/api/package.json` + `package-lock.json` — add `@node-rs/argon2`, `@fastify/cookie`, `zxcvbn` (+ `@types/zxcvbn`)

## 3. Sequencing refinement (flagged)

My S0 doc parked `Role`/`UserRole`/`Invitation` in a separate S2 migration. During build I folded them into the single **S1** migration, because owner-bootstrap and the invite flow both need a role to bind to. **Only `OWNER` is seeded** (by the bootstrap script); the other 5 roles + all permission *values* + the deny-by-default enforcement remain S2 exactly as planned. Net effect: S1 invites are owner-only until S2 seeds the rest — fine, since the invite UI is S4 and S1 is verified by API.

## 4. Validation (all green locally)

| Check | Result |
|---|---|
| `npm run build --workspace=@nexus/api` (shared build + prisma generate + tsc) | ✅ exit 0 |
| `tsc --noEmit` | ✅ exit 0 |
| Unit tests (`auth.vitest.test.ts`) | ✅ 26/26 |
| HTTP wiring tests (`auth-routes.vitest.test.ts`) | ✅ 7/7 |
| Table drift (`check-schema-drift.mjs`) | ✅ 331 models |
| Column drift (`check-column-drift.mjs`) | ✅ 331 tables |
| `prisma validate` | ✅ valid |
| i18n parity | ✅ pass |

The DB-touching happy paths (real login, invite accept, reset) can only be verified against a live DB (no local Docker per repo policy) — see §6 for the post-deploy verification.

## 5. Security self-review

_Adversarial review pass summarized here once complete._

## 6. Verification steps (post-approval)

Because the migration applies on deploy and there's no local DB, these run against production after you approve the push:

**A. Deploy + bootstrap**
1. Approve the push → Railway runs `prisma migrate deploy` (applies `20260703_s1_auth_core`).
2. Set on Railway: `NEXUS_OWNER_EMAIL=<your email>` (optionally `NEXUS_OWNER_INITIAL_PASSWORD=<a strong one>`).
3. Run the bootstrap: `npx tsx apps/api/src/scripts/bootstrap-owner.ts` (or the dist path). It prints the owner email + role; never a secret.

**B. Smoke test (curl against `https://nexusapi-production-b7bb.up.railway.app`)**
```bash
# 1. Get a CSRF token + cookie
curl -c jar.txt https://…/api/auth/csrf         # → { "csrfToken": "…" }
# 2. Log in (needs the csrf cookie + header)
curl -b jar.txt -c jar.txt -X POST https://…/api/auth/login \
  -H 'content-type: application/json' -H 'x-nexus-csrf: <csrfToken>' \
  -d '{"email":"<owner>","password":"<pw>"}'      # → { ok:true, user:{roleKeys:["OWNER"]}, csrfToken }
# 3. Confirm the session
curl -b jar.txt https://…/api/auth/me            # → { user:{ roleKeys:["OWNER"] } }
# 4. Create an invite (owner-gated + CSRF)
curl -b jar.txt -X POST https://…/api/auth/invitations \
  -H 'content-type: application/json' -H 'x-nexus-csrf: <csrfToken>' \
  -d '{"email":"teammate@x.com","roleKey":"OWNER"}' # → { link: "https://…/accept-invite?token=…" }
```
Expected negatives: login without the CSRF header → 403; `/api/auth/me` with no cookie → 401; 5 bad passwords → account locks with backoff; a deactivated user → 403.

**C. Cookie mode** — until a custom domain exists, leave `COOKIE_DOMAIN` unset (interim `SameSite=None; Secure`, `__Host-` prefixed). To cut over to Option A later: point `app.`/`api.xavia.it` at Vercel/Railway, then set `COOKIE_DOMAIN=.xavia.it` + `NEXT_PUBLIC_API_URL=https://api.xavia.it` — no code change.

## 7. Rollback

Additive migration; reverses with no loss to existing rows:
```bash
psql "$NON_POOLED_DATABASE_URL" -f packages/database/prisma/migrations/20260703_s1_auth_core/rollback.sql
# then remove the _prisma_migrations row for 20260703_s1_auth_core, or restore the pre-deploy Neon branch.
```
(Strip `-pooler` from the host for the non-pooled URL, per repo Neon convention.)

## 8. Deferred to later phases (as designed)

- **Deny-by-default across all 2,028 endpoints + field-level financial filtering** → S2.
- **Full permission registry + seeding the other 5 roles + `requirePermission`** → S2.
- **Web login/403 pages + `<Can>` guards + session-before-first-paint** → S3.
- **MFA/TOTP verification at login + per-role enforcement** → S5 (enrolment infra already exists; login sets `mfaSatisfied=true` until then).
- **Shadow Next.js backend** (17 `app/api/*` + 46 direct-Prisma files) still needs guarding — planned follow-up (S0-AUDIT §7 Q4); does not regress in S1.

## 9. What I need from you

1. **Approve the push** (deploys + applies the additive migration to prod Neon).
2. Provide/confirm the **owner email** (env `NEXUS_OWNER_EMAIL`) so I can bootstrap.
3. Then I run the §6 verification and report back before S2.
