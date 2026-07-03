# Nexus Commerce — Security Architecture & Runbook

The reference for how authentication and access control work, the threats
they defend against, and the operational procedures for running them. Pairs
with the phase reports (`S0`–`S5`) and `SETUP-GUIDE.md`.

---

## 1. Architecture at a glance

```
 Browser (app.* / vercel.app)                 Fastify API (api.* / railway.app)
 ─────────────────────────────                ──────────────────────────────────
  AuthProvider  ── /csrf,/me ──►  credentialed  onRequest: request-id, security headers
  usePermission / <Can>            fetch (CHIPS  preHandler: RBAC gate ─► manifest + resolver
  nav filtering                    Partitioned   preSerialization: financial field filter
  login / MFA step                 cookies)      route plugins (2,057 endpoints)
                                                  │
                                                  ▼
                                     Neon Postgres  (sessions, roles, audit — source of truth)
```

- **Server is the boundary.** The browser only hides things for UX; every check is enforced in the API. A hostile client is assumed.
- **Sessions** are server-side rows in `UserSession` (Postgres), keyed by sha256 of an opaque token in an httpOnly cookie. No stateless JWTs — revocation is instant.
- **RBAC** is one global `preHandler` matching each request's route pattern against a **route→permission manifest**; deny-by-default is proven by a CI/pre-push coverage check (0 unmapped of 2,057 routes).
- **Field-level security** strips restricted financial fields server-side (`preSerialization`), recursing into JSON blobs.
- **Permissions** live in one typed registry (`packages/shared/permissions.ts`); the resolver caches by `(userId, permissionsVersion, roleKeys)`, so any mutation propagates on the next request.
- **MFA**: TOTP verified at login for enrolled users; per-role `requireMfa` (OWNER/ADMIN/FINANCE).

**Cookie topology.** Interim: web and API are on different Public-Suffix domains, so cookies are `SameSite=None; Secure; Partitioned` (CHIPS) — required for modern Chrome. Target: a custom apex (`app.`/`api.xavia.it`) makes them first-party (`SameSite=Lax`), removing the Safari fragility. Controlled by env only (`COOKIE_DOMAIN`, `NEXUS_WEB_ORIGINS`, `NEXT_PUBLIC_API_URL`).

## 2. Roles & permissions

Six seeded roles (OWNER implicit-all; ADMIN, OPS_MANAGER, FULFILLMENT, FINANCE, VIEWER) plus unlimited custom roles. Three permission layers: `pages.*`, `<module>.<action>`, `financials.*`. Full matrix in `S0-PERMISSION-REGISTRY.md`; edit roles in **Settings › Team & Access**.

**Owner supremacy (enforced in the service layer, not just UI):** the last OWNER can't be demoted/deleted/deactivated; only an OWNER grants OWNER; system roles are immutable.

## 3. Threat model (summary)

| Threat | Defense |
|---|---|
| Anonymous API access | Deny-by-default gate on every route (was S0 finding F1) |
| Credential stuffing / brute force | argon2id + per-account progressive lockout + per-IP throttle (real client IP via `trustProxy`) |
| Account enumeration | Uniform login errors + timing equalizer; reset-request always 200 |
| Session theft | httpOnly + Secure + Partitioned cookie; server-side revocation; sliding + absolute expiry |
| CSRF | Double-submit token (header vs cookie), constant-time compare |
| Privilege escalation | Deny-by-default + Owner-supremacy guardrails + permission-version invalidation |
| Financial data exposure | Server-side field stripping (incl. JSON blobs) for callers without `financials.view` |
| Lost 2FA device | Single-use recovery codes; admin MFA reset (audited) |
| Insider / accountability | Append-only `AuditLog` (DB triggers) with real actor + IP on every mutation |
| XSS → token theft | Session token is httpOnly (JS can't read it); CSP + nosniff headers |
| Clickjacking | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` |

## 4. Runbook

### Offboard a staff member in under 30 seconds
1. **Settings › Team & Access → Members → the person → Manage → Deactivate.**
2. Their status flips to *deactivated*, **all their sessions are revoked immediately**, and their next request 401s. Done.
   (Prefer deactivate over delete — it preserves their audit trail. To also cut a shared device without deactivating, use **Force sign-out**.)

### Reset a user's password
They self-serve via **/forgot-password** (needs `NEXUS_ENABLE_OUTBOUND_EMAILS=true`). Or run the owner-bootstrap script for the OWNER. A completed reset revokes all their sessions.

### Reset a user's 2FA (lost device)
**Members → the person → Manage → Reset 2FA** (audited). They re-enrol on next login.

### Rotate secrets
Env-only, no code changes: update the value on Railway/Vercel and redeploy. Session/CSRF tokens are opaque + DB-validated (no signing secret to rotate). If `NEXUS_CREDENTIAL_ENC_KEY` rotates, re-encrypt stored channel credentials. The go-live owner password should be rotated after setup (it may have transited a setup channel).

### Turn enforcement off (emergency)
Unset `NEXUS_RBAC_MODE` (→ shadow) on Railway and `NEXT_PUBLIC_AUTH_ENFORCE` on Vercel, redeploy. The app returns to open access without a migration. Field filtering + gate both no-op in shadow.

### Incident basics
1. **Contain** — deactivate affected accounts (revokes sessions); if broad, force-rotate by bumping every user's `permissionsVersion` or revoking all `UserSession` rows.
2. **Investigate** — `AuditLog` (Settings › Audit / `/audit-log`) is append-only and stamped with actor + IP; `LoginEvent` holds success/failure/lockout history.
3. **Recover** — reset credentials + 2FA for affected users; review role assignments in Team & Access.

## 5. Known gaps / follow-ups

- **Interim Safari:** CHIPS covers Chrome/Edge/Firefox; Safari ITP may still block the cross-site cookie → custom domain (Option A) resolves it.
- **Vercel-direct routes:** the datasheet-export download + a few proxy routes are on the web origin and can't read the API cookie in interim; they close with the custom-domain move.
- **Dependency vulnerabilities:** `npm audit` reports 39 pre-existing prod advisories (0 critical, 21 high, 18 moderate) — not introduced by this workstream; triage via `npm audit fix` review. Tracked in `ASVS-CHECKLIST.md`.
- **CI-YAML:** the coverage + security-test gates run in the pre-push hook; add the YAML steps when a `workflow`-scoped token is available (snippet in `S2-REPORT.md`).
- **Universal self-service settings:** 2FA enrolment currently lives in the Team console (owner/admin-reachable); a universally-reachable `/settings/security` self-service page is a follow-up for non-admin users.
