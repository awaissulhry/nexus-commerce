# S2 — RBAC Engine — Phase Report

**Status:** Complete, deployed in **shadow mode** (inert), verified. Enforcement flips on in S3.
**Date:** 2026-07-03.

---

## 1. What was built (plain English)

The permission system. Every one of the **2,038 API routes** now maps to a required permission; a user's roles resolve to a permission set; financial fields get stripped for anyone who shouldn't see them. **It runs in shadow mode** — it resolves and *would* enforce, but lets requests through — because the web app can't authenticate until S3. Flipping `NEXUS_RBAC_MODE=enforce` in S3 turns it live without any code change.

Why shadow: hard-enforcing before the browser sends a session cookie (S3) would 403 the entire app. Shadow deploys the real engine safely, validates the whole permission map against real traffic, and makes S3's cutover a one-env-var flip.

## 2. The three layers (all shipped)

**1. Page + feature permissions — the gate.** One global `preHandler` (`rbac-hook.ts`) matches each request's route pattern against a **route→permission manifest** (`permissions-manifest.ts`), resolves the caller's permissions (`rbac.ts`, cached by `(userId, permissionsVersion, roleKeys)`), and allows/denies. OWNER is implicit-all. Unmapped route → deny-by-default.

**2. Deny-by-default is *proven*, not assumed.** `check-rbac-coverage.ts` boots the app, walks all 2,038 routes, and fails if **any** is unmapped. Result: **0 unmapped, 83 distinct permissions, 65 PUBLIC** (health/webhooks/OAuth/auth). Wired into the pre-push hook, so a new endpoint can't ship without a mapping. *(CI-YAML step deferred — the push token lacks GitHub `workflow` scope; snippet in §7 for you to add.)*

**3. Field-level financial security — "absent, not hidden."** A `preSerialization` hook (`field-filter.ts`) strips the restricted money fields (`financial-fields.ts`, curated from the S0 audit) from every response for callers without the matching `financials.*` permission — **recursing into nested JSON blobs** (AuditLog before/after, amazonMetadata, PO snapshots), the bypass channels S0 flagged. Operational prices (order totals, list prices) stay visible per the S0 rulings.

## 3. Owner supremacy + immediate propagation

- **Guardrails** (`team-guardrails.ts`, pure + unit-tested): the last OWNER can never be demoted/deleted/deactivated by anyone incl. themselves; only an OWNER grants OWNER; system roles are immutable; role permissions must be valid registry entries.
- **Service layer** (`team-access.service.ts`): the only sanctioned path for role/user changes — assign/remove role, deactivate (kills sessions instantly), reactivate, force sign-out, role CRUD. Every mutation **bumps `permissionsVersion`** so the affected users re-resolve on their next request (immediate propagation, §3.5). No Redis dependency — the version stamp lives in Postgres; the resolver cache keys off it.
- **Roles self-seed** on every API boot (`seedSystemRoles()`, idempotent) — the 6 defaults converge to the registry without a manual step.

## 4. Files

**New** (`apps/api/src/lib/auth/`): `rbac.ts`, `permissions-manifest.ts`, `rbac-hook.ts`, `financial-fields.ts`, `field-filter.ts`, `team-guardrails.ts` + 3 vitest files (field-filter, guardrails, permission-matrix).
**New:** `packages/shared/permissions.ts` (the registry), `apps/api/src/services/team-access.service.ts`, `apps/api/src/scripts/check-rbac-coverage.ts`, `seed-roles.ts`, `seed-dev-users.ts`.
**Modified:** `apps/api/src/index.ts` (global hooks + boot seed + route collector), `guards.ts`, `.githooks/pre-push`, `packages/shared/package.json`.
**Commits:** `50b5b9f8` (engine foundation) + `379fdd0e` (filter/guardrails/service/seeds).

## 5. Validation

| Check | Result |
|---|---|
| Full build (`npm run build`) | ✅ |
| Deny-by-default coverage | ✅ 2038 routes, **0 unmapped** |
| Unit/HTTP tests | ✅ **75** (auth 26, HTTP 7, field-filter 5, guardrails 14, matrix 23) |
| Permission matrix (endpoint × role) | ✅ — caught + fixed OPS_MANAGER wrongly holding `pricing.tiers.manage` |
| Live smoke (shadow deploy) | see §6 |

## 6. Deploy safety (shadow mode)

Both new global hooks are inert in shadow: the gate logs only *meaningful* would-denials (authenticated-but-forbidden; silent on the unauthenticated norm), and the field filter returns immediately (`NEXUS_RBAC_MODE !== 'enforce'`). No added DB load for unauthenticated traffic (session only loaded when a cookie is present). The existing S1 auth smoke tests continue to pass on prod.

## 7. What's deferred (as designed)

- **The enforce flip** (`NEXUS_RBAC_MODE=enforce`) → **S3**, alongside the credentialed web client + login/403 pages. Before flipping, two follow-ups: (a) `/api/internal/bidding/*` must move to API-key service auth (the bidding-engine microservice has no session); (b) confirm the generic-named financial routes in `FINANCIAL_ONLY_ROUTE_PREFIXES` are route-gated.
- **Team & Access console UI** (users/roles/matrix/audit-log viewer) → **S4** (the service layer it calls is done here).
- **CI-YAML coverage step** — add this to `.github/workflows/ci.yml` with a `workflow`-scoped token:
  ```yaml
  - name: RBAC deny-by-default coverage
    env: { DATABASE_URL: "postgresql://ci:ci@localhost:5432/ci", RBAC_COVERAGE: "1" }
    run: npx tsx apps/api/src/scripts/check-rbac-coverage.ts
  ```
  (Enforced via the pre-push hook in the meantime.)

## 8. Rollback

No migration in S2 (pure code). To disable the engine entirely: unset `NEXUS_RBAC_MODE` (stays shadow) or revert commits `379fdd0e` + `50b5b9f8`. Shadow mode is already the safe default.
