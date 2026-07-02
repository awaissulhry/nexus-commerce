# S0 — Proposed Prisma Schema Diff & Reversible Migration Plan

**Status:** Proposal for the S0 gate. Applied in **S1** (auth core) and **S2** (RBAC). No migration is applied in S0.

**Substrate that already exists** (do not recreate — see `S0-ENUMERATION-FINANCIAL-FIELDS.md §2`): `UserProfile` (3517), `UserSession` (3667), `LoginEvent` (3692), `TwoFactorRecoveryCode` (3647), `ApiKey` (3485), `AuditLog` (6270, append-only via triggers). We **extend** these and **add** the RBAC + invitation + lockout models that do not exist.

**Neon/migration conventions honoured** (`reference_neon_migrations`, `reference_railway_deploy_debug`):
- Each migration is its own `packages/database/prisma/migrations/<ts>_<name>/migration.sql` folder with a sibling **`rollback.sql`** (existing repo convention — e.g. `20260509_w4_1_tier_pricing/rollback.sql`).
- `prisma migrate deploy` runs on Railway `prestart`. For manual deploy use the **non-pooled** connection string (strip `-pooler`); stale advisory locks → `pg_terminate_backend`.
- Additive-only where possible (new tables + new **nullable** columns) so the migration is safe to deploy ahead of code and trivially reversible. No column drops, no type changes on hot tables.
- CI drift gates (`check-schema-drift.mjs`, `check-column-drift.mjs`) must pass — every new model needs a `CREATE TABLE`, every new field an `ADD COLUMN`.

---

## 1. New enum

```prisma
// System roles are protected (seeded, cannot be deleted). Custom roles
// created by the Owner carry isSystem=false and any name.
enum SystemRole {
  OWNER
  ADMIN
  OPS_MANAGER
  FULFILLMENT
  FINANCE
  VIEWER
}
```

## 2. New models — RBAC core

```prisma
// A role is a named permission set. The six SystemRole rows are seeded
// and protected; Owners may create unlimited custom roles.
model Role {
  id          String   @id @default(cuid())
  // For seeded roles, matches a SystemRole value; for custom roles, a slug.
  key         String   @unique
  name        String
  description String   @default("")
  // OWNER is implicit-all: the resolver short-circuits before reading
  // permissions. Stored anyway for display, but never the enforcement path.
  isSystem    Boolean  @default(false)
  // Permission keys from packages/shared/src/permissions.ts. Deny-by-default:
  // absence = denied. OWNER ignores this list (implicit-all).
  permissions String[] @default([])
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  assignments UserRole[]

  @@index([isSystem])
}

// Assignment of a role to a user, optionally scoped to channels/marketplaces.
// A user may hold multiple assignments (union of permissions).
model UserRole {
  id       String      @id @default(cuid())
  userId   String
  user     UserProfile @relation(fields: [userId], references: [id], onDelete: Cascade)
  roleId   String
  role     Role        @relation(fields: [roleId], references: [id], onDelete: Cascade)

  // null = all channels/markets (fast path). Else e.g.
  // { "channels": ["EBAY"], "marketplaces": ["IT"] }. Enforcement wiring
  // lands with the S4+ scoped-role UI; column exists from day one.
  channelScope Json?

  // Accountability: who granted this, when.
  grantedByUserId String?
  createdAt       DateTime @default(now())

  @@unique([userId, roleId])
  @@index([userId])
  @@index([roleId])
}
```

**Why `permissions String[]` on Role, not a `RolePermission` join table:** permissions are a fixed registry in code, not user-defined rows; an array column is simpler, matches the existing `ApiKey.scopes String[]` precedent, and avoids a join on every permission resolve. The join-table alternative buys referential integrity we don't need (the registry is the integrity boundary) at the cost of resolve-time joins. Documented here so the choice is deliberate.

## 3. New model — Invitations

```prisma
// Invite-only access. No public registration. Single-use, hashed token,
// 72h TTL, bound to an email + role. Delivered as a copyable link and/or
// Resend email.
model Invitation {
  id           String    @id @default(cuid())
  email        String
  roleId       String
  role         Role      @relation(fields: [roleId], references: [id], onDelete: Restrict)
  // sha256 of the raw token; raw token is shown once at creation and emailed.
  tokenHash    String    @unique
  channelScope Json?     // mirrors UserRole.channelScope for the created assignment
  invitedByUserId String
  expiresAt    DateTime
  acceptedAt   DateTime?
  acceptedUserId String?
  revokedAt    DateTime?
  createdAt    DateTime  @default(now())

  @@index([email])
  @@index([expiresAt])
}
```
*(Requires a back-relation `invitations Invitation[]` on `Role`.)*

## 4. New model — Password reset tokens

```prisma
// Single-use, hashed, ≤60min TTL. All sessions invalidated on successful reset.
model PasswordResetToken {
  id        String    @id @default(cuid())
  userId    String
  user      UserProfile @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String    @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  @@index([userId])
  @@index([expiresAt])
}
```

## 5. Extensions to existing models (additive, nullable/defaulted)

### `UserProfile` — add RBAC link, lockout state, MFA enforcement, status
```prisma
// ADD to model UserProfile:
  status              String    @default("active")  // "active" | "deactivated"
  deactivatedAt       DateTime?
  // Login hardening (progressive lockout; counters here so they survive
  // process restarts and work across Railway replicas without Redis).
  failedLoginCount    Int       @default(0)
  lockedUntil         DateTime?
  lastLoginAt         DateTime?
  // Immediate propagation (§3.5): bump on any role/permission mutation
  // affecting this user; cached permission sets keyed by (userId, this).
  permissionsVersion  Int       @default(0)
  // MFA enrolment already exists (twoFactorSecret/twoFactorEnabledAt).
  // Add explicit enforcement + recovery bookkeeping:
  mfaRequired         Boolean   @default(false)  // per-user override; role flag also applies
  // Relations
  roleAssignments     UserRole[]
  resetTokens         PasswordResetToken[]
  invitationsAccepted Invitation[]  @relation("acceptedInvitations")  // optional
```
> The password path migrates **bcrypt → argon2id** in S1. `passwordHash` stays `String`; the verifier auto-detects format (argon2id / bcrypt / legacy sha256) and re-hashes to argon2id on next successful login — same self-migrating pattern the schema already documents for sha256→bcrypt. No column change.

### `Role` — MFA enforcement flag (S5)
```prisma
// ADD to model Role:
  requireMfa  Boolean  @default(false)  // seeded true for OWNER/ADMIN/FINANCE in S5
```

### `UserSession` — make it the live session store
The model exists but has no writer. Add what an opaque-cookie session store needs:
```prisma
// ADD to model UserSession:
  sessionTokenHash String?   @unique  // sha256 of the opaque cookie value
  absoluteExpiry   DateTime?           // absolute lifetime cap (default now+30d)
  idleExpiry       DateTime?           // sliding idle timeout (default now+7d, bumped on use)
  mfaSatisfied     Boolean   @default(false)  // step-up: session passed TOTP this login
```
*(Existing `revokedAt` already gives instant revocation; `tokenPrefix` stays for display.)*

### `AuditLog` — no schema change; start populating `userId`
No migration needed — `userId String?` and `ip String?` already exist. S1/S2 begin **writing** the real actor (today hardcoded `null` at `utils/settings-audit.ts:93` and the web mirror). The append-only triggers (`20260509_l6_0_audit_log_immutability`) already protect it. **Note:** audit `before/after` JSON can contain restricted financial values → the audit **viewer** is gated by `audit.view` AND financial JSON is redacted for non-`financials.view` callers (see `S0-PERMISSION-REGISTRY.md §3`).

---

## 6. Migration plan (staged, reversible)

Split across the phases that use them so each ships with its tests:

| Migration | Phase | Contents | Reversibility |
|---|---|---|---|
| `<ts>_s1_auth_core` | S1 | `UserProfile` adds (status, lockout, `permissionsVersion`, `mfaRequired`, relations); `UserSession` adds (session token/expiries/mfa); `PasswordResetToken`; `Invitation` (needs `Role` first — see note) | `rollback.sql` drops new columns + tables. All adds are nullable/defaulted → dropping is clean; no data transform |
| `<ts>_s2_rbac` | S2 | `SystemRole` enum; `Role`; `UserRole`; `Role.requireMfa`; back-relations | `rollback.sql` drops `UserRole`, `Role`, enum |
| (seed, not a migration) | S2 | Seed the 6 system roles + their permission arrays from the registry; idempotent owner-bootstrap script | Re-runnable; no schema change |

**Ordering note:** `Invitation.roleId` FKs `Role`, so either (a) land `Role` in the S1 migration too (roles table without the RBAC-enforcement columns yet), or (b) make `Invitation` part of the S2 migration. **Recommendation: (b)** — invitations are only useful once roles exist, so `s2_rbac` carries `Role` + `UserRole` + `Invitation` together, and `s1_auth_core` carries only the session/password/lockout additions + `PasswordResetToken`. This keeps S1 shippable and testable (login + reset + lockout) before RBAC exists.

**Revised split:**
- **`s1_auth_core`:** `UserProfile` lockout/status/`permissionsVersion`/`mfaRequired` + relations to reset tokens; `UserSession` session-store columns; `PasswordResetToken`. → enables S1 login/session/reset/lockout.
- **`s2_rbac`:** `SystemRole` enum; `Role` (+`requireMfa`); `UserRole` (+`channelScope`); `Invitation`; `UserProfile.roleAssignments` back-relation. → enables RBAC + invites.

**Rollback commands** (stated per phase report, per master prompt §6):
```
# Reverse the most recent migration (manual, non-pooled connection):
psql "$NON_POOLED_DATABASE_URL" -f packages/database/prisma/migrations/<ts>_<name>/rollback.sql
# then remove the migration folder + mark rolled back in _prisma_migrations,
# or restore from the pre-migration Neon branch/snapshot.
```
Because every change is additive (new tables + nullable/defaulted columns), rollback drops objects with **no data loss to existing tables** — the pre-existing `UserProfile`/`UserSession` rows are untouched by a rollback (they simply lose the new nullable columns).

---

## 7. What is deliberately NOT changed

- **No changes to any of the 191 financial-field columns.** Field-level security is a **serialization** concern (S2 response filter), not a schema change. The data model is untouched; the API omits fields per caller permission.
- **No changes to hot tables' shape** (`Product`, `Order`, `OrderItem`, `ProductReadCache`, ads perf tables). The /products grid reads `ProductReadCache`, which already carries no cost/margin — no filtering needed there.
- **`ApiKey` is left as-is.** Machine RBAC already works; S2 will optionally unify its `CANONICAL_SCOPES` with the new human permission registry in `packages/shared`, but that's a code move, not a migration.
- **No multi-tenant / Organization / Workspace model.** Nexus is single-operator; roles attach to `UserProfile` directly. (If multi-tenant is ever needed, `UserRole` already has room for an `orgId` — out of scope now.)

---

## 8. Open schema questions for the gate

1. **`permissions String[]` vs `RolePermission` join table** (§2) — I recommend the array (matches `ApiKey.scopes`, no resolve-time join). Confirm.
2. **Multiple roles per user** — `UserRole` allows N assignments (permission union). Acceptable, or one-role-per-user? Multiple is more flexible (e.g. FINANCE + a scoped FULFILLMENT); union semantics are the norm. I recommend allowing multiple.
3. **`channelScope Json?` shape** — `{channels?: string[], marketplaces?: string[]}`. Confirm the vocabulary (channel codes `AMAZON|EBAY|SHOPIFY`, marketplace codes `IT|DE|FR|...`).
4. **Owner bootstrap source** — idempotent script promotes the first OWNER from an env-provided email (`NEXUS_OWNER_EMAIL` or similar, name TBD). The existing singleton `UserProfile` row becomes the OWNER. Confirm which email.
