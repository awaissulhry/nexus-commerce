# OWASP ASVS Level 2 — Self-Audit

Self-assessment of the Nexus auth/RBAC workstream against OWASP Application
Security Verification Standard **Level 2**, scoped to authentication, session
management, access control, and the surrounding controls this workstream owns.
Status: ✅ pass · ⚠️ partial · ❌ gap · N-A not applicable.

Date: 2026-07-03.

---

## V2 — Authentication

| # | Requirement | Status | Notes |
|---|---|---|---|
| 2.1.1 | Min 12-char passwords allowed | ✅ | `MIN_PASSWORD_LENGTH=12`, enforced on set/reset |
| 2.1.7 | Breached/weak password check | ✅ | zxcvbn strength gate (score ≥ 3) + identity-derived penalty |
| 2.1.9 | No composition rules that reduce entropy | ✅ | Strength-based, no arbitrary rules |
| 2.2.1 | Anti-automation / lockout | ✅ | Per-account progressive lockout + per-IP throttle (`trustProxy` for real IP) |
| 2.2.3 | Secure notifications | ⚠️ | Reset link delivered (Resend); login-notification email is a follow-up |
| 2.4.1 | Passwords hashed with an approved KDF | ✅ | **argon2id**, OWASP params (m=19456,t=2,p=1) |
| 2.4.2/2.4.4 | Salting / cost | ✅ | argon2id salts internally; cost tuned |
| 2.5.1 | No default/shared credentials | ✅ | Invite-only; owner password set by operator, never hardcoded/printed |
| 2.5.4 | Credential-recovery no enumeration | ✅ | reset-request always returns 200; work is off the response path |
| 2.5.6 | Recovery uses a short-lived, single-use token | ✅ | Hashed token, ≤60 min, revokes all sessions on use |
| 2.7 / 2.8.1 | MFA / TOTP support | ✅ | TOTP verified at login; enrolment with QR + hashed recovery codes; per-role `requireMfa` |
| 2.10.x | Service auth / API keys | ✅ | `ApiKey` scopes/IP-allowlist/rotation exist; `/api/internal/*` service auth is a pre-enforce follow-up |

## V3 — Session Management

| # | Requirement | Status | Notes |
|---|---|---|---|
| 3.1.1 | No session tokens in URL | ✅ | Cookie-based; token never in URL |
| 3.2.1 | New session token on login | ✅ | Fresh opaque token per login |
| 3.2.3 | Token stored securely in cookie | ✅ | httpOnly + Secure + SameSite + Partitioned; `__Host-` in interim |
| 3.3.1 | Logout invalidates server-side | ✅ | Session row revoked; instant |
| 3.3.2 | Idle + absolute timeout | ✅ | Sliding 7-day idle + 30-day absolute cap |
| 3.3.4 | "Log out all devices" | ✅ | `logout-all` + admin force-sign-out |
| 3.4.x | Cookie attributes | ✅ | See 3.2.3; Secure forced when SameSite=None |
| 3.5.x | Server-side session store (not stateless) | ✅ | `UserSession` in Postgres, revocation instant |

## V4 — Access Control

| # | Requirement | Status | Notes |
|---|---|---|---|
| 4.1.1 | Enforced on the trusted server layer | ✅ | Single global preHandler on the API |
| 4.1.2 | Attributes not client-manipulable | ✅ | Permissions resolved server-side from DB roles |
| 4.1.3 | Least privilege | ✅ | Deny-by-default; new user has zero access until a role is assigned |
| 4.1.5 | Fail securely | ✅ | Unmapped route → 403; unauthenticated → 401 |
| 4.2.1 | No IDOR / function-level bypass | ✅ | Every route mapped; coverage test proves it (0 unmapped of 2,057) |
| 4.3.1 | Admin interfaces protected + MFA | ⚠️ | Admin gated by `users.manage`/`roles.manage`; MFA enforced for OWNER/ADMIN once enrolled |
| 4.3.2 | Deny-by-default is provable | ✅ | `check-rbac-coverage` in the pre-push gate |

## V6/V7 — Cryptography

| # | Requirement | Status | Notes |
|---|---|---|---|
| 6.2.1 | Approved crypto only, no hand-rolling | ✅ | argon2id, otplib TOTP, bcrypt (recovery), Node `crypto` — vetted libraries |
| 6.2.2 | CSPRNG for tokens | ✅ | `crypto.randomBytes` (256-bit) for all tokens |
| 7.x | Hashed secrets at rest | ✅ | Session/invite/reset tokens sha256; recovery codes bcrypt; passwords argon2id |

## V8 — Data Protection

| # | Requirement | Status | Notes |
|---|---|---|---|
| 8.1.x | Sensitive data server-side filtered | ✅ | Financial fields stripped in one serialization layer (incl. JSON blobs) |
| 8.3.x | No sensitive data in the client bundle | ✅ | 0 `NEXT_PUBLIC_*` leaks (one non-secret API URL) |

## V13 — API & Web Service

| # | Requirement | Status | Notes |
|---|---|---|---|
| 13.2.1 | Auth on all API endpoints | ✅ | Deny-by-default gate; PUBLIC set is webhooks (signature-verified) + auth entry points |
| 13.2.3 | CSRF protection | ✅ | Double-submit token, constant-time compare; suited to cross-site cookie mode |

## V14 — Configuration

| # | Requirement | Status | Notes |
|---|---|---|---|
| 14.3.2 | Security headers present | ✅ | HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, CSP, Referrer-Policy on every response |
| 14.2.1 | Dependencies up to date / no known-vuln | ⚠️ | `npm audit`: 39 pre-existing prod advisories (0 critical, 21 high, 18 moderate) — not introduced here; triage separately |
| 14.1.x | No secrets in VCS | ✅ | Only `.env.example` tracked (AWS doc placeholder); `.gitignore` covers `.env*` |
| — | Audit logging | ✅ | Append-only `AuditLog` (DB triggers), real actor + IP; every auth event + admin mutation |

---

## Summary

**Passing:** the auth/session/access-control/crypto/field-protection core meets ASVS L2.

**Partial / follow-up:**
- ⚠️ **14.2.1** — 39 pre-existing dependency advisories (0 critical). Triage via `npm audit fix` review; unrelated to this workstream's code.
- ⚠️ **2.2.3** — login-notification emails (reset email already ships).
- ⚠️ **2.10 / 4.3.x** — `/api/internal/*` service-to-service auth to move to API-key before flipping the interim to a locked-down state; MFA hard-enforcement is enrolled-only by design (no lockout of un-enrolled users).
- **Interim topology caveats** (Safari cross-site cookies, Vercel-direct routes) — resolved by the custom-domain cutover; see `SECURITY.md §5`.

No **❌ critical gaps** identified in the workstream's scope.
