# S4 — Admin Console (Settings › Team & Access) — Phase Report

**Status:** Built + deployed. API live and verified on prod; the console page ships with the current web deploy.
**Date:** 2026-07-03.

---

## 1. What was built

The Owner/Admin surface for the RBAC system — everything you need to run access control from the UI, at **Settings › Team & Access**. The whole guardrailed service layer was already built in S2; S4 adds the API routes that expose it and the console that drives them.

**Members**
- List of everyone with their roles, status, last login, and 2FA state.
- Invite a member (email + role → creates the invitation and copies the accept-link to the clipboard).
- Per-member actions: assign / remove a role, deactivate (kills their sessions immediately) / reactivate, force sign-out everywhere.

**Roles**
- Cards per role with member counts. `OWNER` is locked and clearly marked "System · locked".
- A **permission-matrix editor** grouped by module — pages, feature actions, and **financial-field** toggles (financials called out with a "Financial data" flag). Create, edit, and delete custom roles.

**Invitations**
- Pending list with expiry; revoke.

**Guardrails, surfaced.** Every Owner-supremacy rule is enforced **server-side** in the service layer (S2) and returns a `409` with a reason — the last Owner can't be demoted/deactivated, only an Owner grants Owner, system roles are immutable. The UI shows the reason and confirms destructive actions.

## 2. Files

- **API** — `apps/api/src/routes/team.routes.ts` (13 endpoints: users list/sessions/deactivate/reactivate/force-signout/assign-role/remove-role; roles list/create/update/delete/duplicate/catalog). Registered in `index.ts`; all covered by the RBAC manifest (`users.manage` / `roles.manage`).
- **Shared** — `permissionCatalog()` added to `packages/shared/permissions.ts` (grouped, labelled permissions for the matrix).
- **Web** — `app/settings/team/page.tsx` + `TeamAccessClient.tsx`; nav entry in `settings-nav.ts` under a new "Team & access" group.
- Commits `d173172b` (API) + `84884bbf` (console).

## 3. Validation

| Check | Result |
|---|---|
| API `tsc` + full build | ✅ |
| Web `tsc` | ✅ |
| Local `next build` | ✅ |
| UI token guard (P3) | ✅ |
| RBAC coverage (new /api/team routes) | ✅ 2,051 routes, 0 unmapped |
| API routes live on prod | ✅ (`/api/team/roles` → 401 gated) |
| Console page render | verified once the web deploy propagates |

## 4. Deferred (S4 follow-ups, non-blocking)

- **Preview-as-role** (read-only simulation of what a role sees) — the master-prompt "preview as role"; deferred.
- **Embedded audit-log viewer** — the console links to the existing `/settings/audit` + `/audit-log`; a filtered in-console view is a follow-up.
- **Channel-scoping UI** (the schema + API accept `channelScope`; the picker UI is later).
- **DS-component polish** — the console is functional and passes the token guard; a pass to swap raw elements for design-system primitives (DataGrid/Modal/Menu) would tighten it.
- **Avatar / FormField / danger-button / ConfirmDialog** DS gaps (from S0-DESIGN-SYSTEM) — composed inline for now.

## 5. Next

**S5 — MFA & hardening:** TOTP enforced at login (enrolment infra already exists), per-role MFA flag (the `requireMfa` column is already there), recovery codes, the security test suite in CI, an OWASP ASVS self-audit, and the final `SECURITY.md` runbook.
