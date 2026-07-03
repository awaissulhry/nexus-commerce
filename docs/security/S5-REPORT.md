# S5 — MFA & Hardening — Phase Report

**Status:** ✅ Complete + deployed. This closes the S0–S5 workstream.
**Date:** 2026-07-03.

---

## 1. What shipped

**TOTP MFA**
- **At login:** an enrolled user must present a valid 6-digit TOTP code (or a single-use recovery code) before a session is issued. Un-enrolled users pass — the per-role `requireMfa` flag drives a "set up 2FA" nudge (`/me.mfaSetupRequired`), **never a lockout**, so no one gets stranded.
- **Self-service enrolment** (`/api/auth/2fa/*`, operates on the current user, any authenticated user): start (QR + secret) → verify → 10 hashed single-use recovery codes; regenerate; disable (password step-up). Web UI: a "Your two-factor authentication" card in the console + the login code step.
- **Per-role enforcement:** `requireMfa` seeded true for OWNER, ADMIN, FINANCE.
- **Admin reset:** `POST /api/team/users/:id/reset-mfa` (audited) for lost devices; surfaced as "Reset 2FA" in the member menu.
- Shared `mfa.ts` (otplib TOTP + bcrypt recovery codes — vetted libraries only).

**Security test suite in CI (pre-push)**
- 78 tests across password hashing, sessions, CSRF, lockout, field filter, permission matrix, guardrails, and MFA — wired into the pre-push hook (`npm run test:security`), so they run on every push alongside the build + RBAC coverage gate.

**Audits + docs**
- **`ASVS-CHECKLIST.md`** — OWASP ASVS Level 2 self-audit (V2 auth, V3 session, V4 access control, V6/7 crypto, V8 data, V13 API, V14 config), pass/partial/gap per item.
- **`SECURITY.md`** — architecture overview, threat-model table, and the operational runbook (offboard in <30s, secret rotation, incident basics, emergency enforce-off).
- **Dependency audit:** `npm audit` → 39 pre-existing prod advisories (0 critical, 21 high, 18 moderate), none from this workstream — flagged for separate triage.
- **Secret scan:** clean — only `.env.example` tracked (AWS documentation placeholder); `.gitignore` covers `.env*`.

## 2. Files

New: `apps/api/src/lib/auth/mfa.ts` (+ `mfa.vitest.test.ts`), `apps/api/src/routes/mfa.routes.ts`, `apps/web/src/app/settings/team/MfaSetup.tsx`, `docs/security/{SECURITY,ASVS-CHECKLIST,S5-REPORT}.md`.
Modified: `auth.routes.ts` (login MFA + `/me.mfaSetupRequired`), `team.routes.ts` (reset-mfa), `permissions-manifest.ts` (`/api/auth/2fa`), `index.ts` (register), `packages/shared/permissions.ts` (`requireMfa`), `login/page.tsx` + `TeamAccessClient.tsx`, `apps/api/package.json` + `.githooks/pre-push`.
Commit `99c9436f` (MFA) + this docs/test commit.

## 3. Validation

| Check | Result |
|---|---|
| API `tsc` + full build | ✅ |
| Web `tsc` + P3 token guard | ✅ |
| Security test suite | ✅ **78** passed |
| RBAC coverage (new /api/auth/2fa + reset-mfa) | ✅ 2,057 routes, 0 unmapped |
| npm audit (prod) | 39 advisories, 0 critical (pre-existing) |
| Secret scan | ✅ clean |

## 4. Deferred (non-blocking)

Login-notification emails; `/api/internal/*` service-to-service API-key auth (before locking the interim fully); a universally-reachable self-service `/settings/security` for non-admin users; the CI-YAML mirror of the pre-push gates (needs a `workflow`-scoped token). All tracked in `SECURITY.md §5`.

## 5. Workstream complete

| Phase | Status |
|---|---|
| S0 Discovery | ✅ |
| S1 Authentication core | ✅ LIVE |
| S2 RBAC engine | ✅ LIVE |
| S3 Frontend enforcement | ✅ LIVE |
| S4 Team & Access console | ✅ LIVE |
| S5 MFA & hardening | ✅ LIVE |

The platform went from **zero authentication** to enterprise access control — argon2id auth, server-side sessions, a proven deny-by-default RBAC engine over 2,057 endpoints, server-side financial field protection, an Owner-managed console, and TOTP MFA — live and enforcing in production.
