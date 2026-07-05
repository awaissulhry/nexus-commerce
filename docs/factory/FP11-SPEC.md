# FP11 — Settings & Team: page-cycle spec (awaiting Owner approval)

Written 2026-07-06 on FP10's approval. Gate 1 of the FP11 double gate — nothing below is built until the Owner approves. **This is the LAST page-cycle — it closes the 11-page arc.** Seeds: `F0-IA.md` §2, PLAYBOOK §11-FP11, `FD9` (schema-ready roles, minimal UI, flip to enforce before a second login), `FD5` (WhatsApp: decide at FP11). The auth schema (User/Role/UserRole/Invitation), the Owner-supremacy `guardrails`, and `permissionCatalog()` have been live since F1 — FP11 gives them a face and turns the key.

## Purpose (one sentence)

Let the Owner run the platform itself — invite people and set who can do what (the role matrix), tune the factory's knobs (stage pipeline, pricing defaults, VAT, backups), turn RBAC from shadow to **enforce** before a second person ever logs in, and settle the WhatsApp question — so Factory OS is complete and self-governing.

## Scope

**IN (FP11):**
- **Team & roles** (`/settings/team`) — a **members** list (name, email, role, last login) with role reassignment and deactivate; **pending invitations** with an invite form (email + role) and revoke; a **role matrix** editor to create/edit **custom roles** from `permissionCatalog()` (checkboxes per group), OWNER/WORKER shown read-only. Every write goes through a **team service** that consults the F1 `guardrails` (only an owner grants OWNER; the last owner can't be removed/deactivated; system roles immutable; a role with members can't be deleted; unknown permissions rejected).
- **Invitation accept** — a PUBLIC tokenized route (`/join/[token]`, the FP3 accept-link pattern): validate the (unexpired, unrevoked) token, the invitee sets a display name + password, and a User + UserRole is created for the invited role. Invites expire; accepting is one-time.
- **Settings depth** (`/settings/config`) — a **stage-pipeline** editor (the global `production.stages` list — add / rename / reorder; new work orders read it), **pricing defaults** (`pricing.defaults`: margin-floor %, default deposit %), **VAT display rate** (`financials.defaults.vatRatePct`), and a **backup panel** listing the worker's nightly SQLite snapshots (`.snapshots/`) with sizes/dates and a restore-instructions note.
- **Flip RBAC to `enforce`** — verified on the isolated build (OWNER passes; a role missing a permission gets an audited 403; no page crashes because the factory authenticates at the route, not in SSR). The **live `.env` flip + `:3100` restart is the Owner's gate-2 step** (a posture change on the running instance, done together — like connecting Sendcloud was).
- **The WhatsApp decision** (FD5) — presented, not built: the two paths (unofficial bridge — free, fragile, ToS risk; Meta Cloud API — official, per-message fees) with a recommendation, surfaced as a settings note. Whatever the Owner picks lands later as a second `Conversation.channel` behind the same Inbox (the schema is already channel-pluggable).
- **Settings hub** — the landing page's "Team & roles" card goes live and a "Configuration" card is added.

**OUT (named, so the boundary is explicit):**
- **Building the WhatsApp channel** — FP11 delivers the *decision*; the transport lands in a follow-up once the Owner picks and real volume justifies it (the schema stays ready).
- **A backup RESTORE button** — the panel lists snapshots and tells the Owner the one-line restore command; an in-app "restore over the live DB" button is deliberately not built (too sharp an edge to click by accident on a local-first instance).
- **SSO / 2FA / self-serve password reset UI** — invite + owner-set + the existing rotation script cover v1; richer auth flows are later.
- **A full audit-log viewer** — `audit.view` exists and the ONE-TIMELINE surfaces per-entity history; a global searchable audit page is a separate concern.
- **Per-user notification preferences beyond what exists** — the notification bus is live; a granular per-event opt-in matrix is deferred.

## Layout

```text
/settings (hub):  Integrations · Import/Export · Health · [Team & roles ✓] · [Configuration ✓]
/settings/team:
  MEMBERS:  name · email · role ▾ · last login · [deactivate]        (guardrail-checked)
  INVITATIONS:  [+ Invite: email + role]  · pending list · [revoke]
  ROLES:  OWNER/WORKER (read-only) · custom roles · [+ New role] → matrix editor (permissionCatalog groups)
/settings/config:
  STAGE PIPELINE:  CUTTING…PACKING — add / rename / drag-reorder
  DEFAULTS:  margin-floor % · deposit % · VAT display %
  BACKUPS:  nightly snapshots (name · size · date) + restore note
  RBAC:  mode (shadow/enforce) + "flip to enforce" guidance
/join/[token] (PUBLIC):  invited email · display name · password → accept
```

## Component reuse

| Region | Components |
|---|---|
| Members / invitations | `DataGrid`, `Listbox` (role), `Modal` (invite), `Pill` (role/status) |
| Role matrix | `Checkbox` grouped by `permissionCatalog()`; `Modal`/panel |
| Stage pipeline | the `@dnd-kit` sortable pattern (already used on FP2 options / TC-series), inline rename |
| Defaults / VAT | `Input` number fields, save-on-blur |
| Backups | `DataGrid` over the snapshot list (read-only) |
| Guardrails (tested) | `src/lib/auth/guardrails.ts` (built in F1) — the team service calls them |
| Accept page | the FP3 public-token pattern (signed token, CSRF handshake) |

## Data & API

**No migration** — `User` / `Role` / `UserRole` / `Invitation` / `Session` / `AppSetting` all exist; `permissionCatalog()` + `guardrails` + `rbacMode()` are built. **+1 permission** `settings.manage` (config writes — OWNER; minted into the registry so custom roles can grant it); `users.manage` / `roles.manage` already seeded for team writes.

**Team service (the only sanctioned mutation path):** `src/lib/auth/team-service.ts` — assign role / deactivate / invite / accept / create-role / edit-role / delete-role, each calling the relevant guardrail before writing and bumping `permissionsVersion` where a live session's grants change.

**Routes** (all `guarded()` + coverage-checked):

| Route | Methods | Permission |
|---|---|---|
| `/api/team/members` | GET (list), PATCH (role / activate / deactivate) | `users.manage` |
| `/api/team/invitations` | GET (pending), POST (invite → token), DELETE (revoke) | `users.manage` |
| `/api/team/accept/[token]` | GET (validate — PUBLIC), POST (accept: name+password → User+UserRole — PUBLIC) | public (token is the auth) |
| `/api/team/roles` | GET (catalog + roles), POST (create), PATCH (edit perms), DELETE (unused only) | `roles.manage` |
| `/api/settings/config` | GET (stages + defaults + VAT + rbac mode), PATCH (write an AppSetting) | `settings.manage` |
| `/api/settings/backups` | GET (snapshot list) | `pages.settings` |

Accept contract: `GET` returns the invite's email + role name if the token is valid/unexpired/unrevoked/unaccepted (else 410); `POST {displayName, password}` creates the User (Argon/bcrypt hash via the existing password util), the UserRole, stamps `acceptedAt`, and returns a session — one-time. Guardrails run server-side on every team write; a `GuardrailError` maps to a 4xx with its message.

## Interactions

- **Invite a cutter:** `/settings/team` → Invite → email + WORKER → a join link (shown once / emailed) → they open `/join/[token]`, set a password, and they're in as WORKER (no financials, Production+Materials nav only).
- **Make a custom role:** New role "Shipper" → tick `pages.shipping` + `labels.purchase` in the matrix → save → assign it. The last-owner/system-role/unknown-permission guardrails refuse the unsafe edits with a clear message.
- **Tune the floor:** Configuration → rename a stage or drag it earlier → new work orders use the new pipeline. Set the margin-floor and deposit %.
- **Turn the key:** verify enforce on the isolated build, then (with the Owner) flip `.env` to `enforce` and restart — from now a missing permission is a real 403.
- **Settle WhatsApp:** read the decision note, pick a path (or defer) — recorded for the follow-up.

## States

Skeletons on the lists; EmptyState (no pending invites / no custom roles); guardrail errors as inline toasts with the human message; the invite link shown in a copyable field after creation; backup panel empty until the first nightly snapshot; the accept page handles expired/used tokens with a clear message.

## RBAC

The whole page is `pages.settings` (absent from the worker nav). Team writes behind `users.manage` / `roles.manage`; config writes behind the new `settings.manage`; the accept route is PUBLIC (the token is the credential). **This cycle flips `FACTORY_RBAC_MODE=enforce`** — the finish line of the FD9 plan: every route is already `guarded()` (coverage-checked at 120/120), so enforce turns shadow-logged would-be-denials into audited 403s without gaps.

## Bulk / import-export

None new. Team membership is deliberately one-at-a-time (each grant is audited). Backups are read-only.

## Teardown verdicts applied (traceability)

| Verdict (F0-DECISIONS / F0) | Where it lands |
|---|---|
| Schema-ready roles, minimal UI (FD9) | The team UI over the F1 schema + guardrails; flip to enforce |
| Owner supremacy, guardrail-enforced (F0 §S) | The team service consults `guardrails` on every write |
| WhatsApp decided at FP11 with real volume (FD5) | The decision note + recommendation; channel deferred |
| Zero-training worker nav (FD9) | A new WORKER (or custom role) inherits the nav-by-permission model |
| Local-first = we are the ops team | The backup panel + RBAC mode are visible, not hidden |

## Acceptance targets (gate-2 click-through)

Open `/settings/team` → the members list (you as OWNER) → **Invite** a WORKER → open the **join link** in a private window, set a password, land in as WORKER with the reduced nav and zero financials → back as OWNER, create a custom **role** in the matrix and assign it → the guardrails refuse removing the last owner / editing a system role (clear messages) → `/settings/config` → rename/reorder a **stage** (a new work order uses it) → set **margin-floor / deposit / VAT** → see the **backup** snapshots → verify **enforce** on the isolated build, then flip `.env` + restart together. Plus: `team-service` guardrail paths unit-tested (last-owner, system-role, unknown-permission, owner-grant); a test proves a WORKER token accepts into the WORKER role only; 201+ existing tests stay green; rbac / no-touch / parity / build green; **the WhatsApp decision is recorded.**

## Build plan (no time estimates)

FP11.1 — team service (wraps `guardrails`) + `/api/team/members` + `/api/team/invitations` + the PUBLIC `/api/team/accept/[token]` + `/join/[token]` page + `/settings/team` members & invitations. → FP11.2 — `/api/team/roles` + the permission-matrix role editor (create/edit/delete custom roles) with guardrails surfaced. → FP11.3 — `/api/settings/config` + `/api/settings/backups` + `/settings/config` (stage-pipeline editor + defaults + VAT + backup panel) + `settings.manage`. → FP11.4 — verify `enforce` on `:3199`, present the WhatsApp decision, headless verify the whole cycle + `FP11-REPORT.md`, mark the 11-page arc **complete**; the live enforce flip is the Owner's gate step. Each sub-phase a scoped commit; push at cycle end; STOP for gate 2.
