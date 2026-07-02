-- Phase S1 (auth core) — Enterprise Access Control workstream.
-- See docs/security/S0-SCHEMA.md + S0-AUDIT.md for the design.
--
-- ADDITIVE ONLY. No column drops, no type changes, no data transforms.
--   • New tables: Role, UserRole, Invitation, PasswordResetToken.
--   • New enum: SystemRole (declared for app-side type-safety + S2 use).
--   • Nullable/defaulted columns on UserProfile + UserSession — the
--     single existing prod UserProfile/UserSession rows keep working
--     with no backfill.
-- Rollback: sibling rollback.sql drops exactly what this adds, with no
-- loss to pre-existing tables (they only shed the new nullable columns).
--
-- Idempotency (TECH_DEBT #37/#38 lessons): guards on every statement so
-- a partial/re-run deploy converges instead of hard-failing mid-file.

-- ─── SystemRole enum ──────────────────────────────────────────────
-- Not referenced by a column yet (Role.key is TEXT); created for
-- app-side SystemRole typing and S2 use. Harmless as an unused type.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SystemRole') THEN
    CREATE TYPE "SystemRole" AS ENUM (
      'OWNER', 'ADMIN', 'OPS_MANAGER', 'FULFILLMENT', 'FINANCE', 'VIEWER'
    );
  END IF;
END
$$;

-- ─── Role ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Role" (
    "id"          TEXT NOT NULL,
    "key"         TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isSystem"    BOOLEAN NOT NULL DEFAULT false,
    "requireMfa"  BOOLEAN NOT NULL DEFAULT false,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Role_key_key" ON "Role"("key");
CREATE INDEX IF NOT EXISTS "Role_isSystem_idx" ON "Role"("isSystem");

-- ─── UserRole ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "UserRole" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "roleId"          TEXT NOT NULL,
    "channelScope"    JSONB,
    "grantedByUserId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserRole_userId_roleId_key" ON "UserRole"("userId", "roleId");
CREATE INDEX IF NOT EXISTS "UserRole_userId_idx" ON "UserRole"("userId");
CREATE INDEX IF NOT EXISTS "UserRole_roleId_idx" ON "UserRole"("roleId");

-- ─── Invitation ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Invitation" (
    "id"              TEXT NOT NULL,
    "email"           TEXT NOT NULL,
    "roleId"          TEXT NOT NULL,
    "tokenHash"       TEXT NOT NULL,
    "channelScope"    JSONB,
    "invitedByUserId" TEXT NOT NULL,
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "acceptedAt"      TIMESTAMP(3),
    "acceptedUserId"  TEXT,
    "revokedAt"       TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX IF NOT EXISTS "Invitation_email_idx" ON "Invitation"("email");
CREATE INDEX IF NOT EXISTS "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

-- ─── PasswordResetToken ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");
CREATE INDEX IF NOT EXISTS "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- ─── UserProfile — account lifecycle + login hardening columns ────
ALTER TABLE "UserProfile"
  ADD COLUMN IF NOT EXISTS "status"             TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "deactivatedAt"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "failedLoginCount"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lockedUntil"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastLoginAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "permissionsVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "mfaRequired"        BOOLEAN NOT NULL DEFAULT false;

-- Email becomes the unique login identity. Safe for the single
-- UserProfile row; fails loud if unexpected duplicates exist (better
-- than silently allowing two accounts to share a login before auth
-- goes live).
CREATE UNIQUE INDEX IF NOT EXISTS "UserProfile_email_key" ON "UserProfile"("email");

-- ─── UserSession — live opaque-token session store columns ────────
ALTER TABLE "UserSession"
  ADD COLUMN IF NOT EXISTS "sessionTokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "idleExpiry"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "absoluteExpiry"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mfaSatisfied"     BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS "UserSession_sessionTokenHash_key" ON "UserSession"("sessionTokenHash");

-- ─── Foreign keys ─────────────────────────────────────────────────
-- Guarded with NOT VALID-free re-check pattern: add only if absent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserRole_userId_fkey') THEN
    ALTER TABLE "UserRole"
      ADD CONSTRAINT "UserRole_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserRole_roleId_fkey') THEN
    ALTER TABLE "UserRole"
      ADD CONSTRAINT "UserRole_roleId_fkey"
      FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Invitation_roleId_fkey') THEN
    ALTER TABLE "Invitation"
      ADD CONSTRAINT "Invitation_roleId_fkey"
      FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Invitation_invitedByUserId_fkey') THEN
    ALTER TABLE "Invitation"
      ADD CONSTRAINT "Invitation_invitedByUserId_fkey"
      FOREIGN KEY ("invitedByUserId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PasswordResetToken_userId_fkey') THEN
    ALTER TABLE "PasswordResetToken"
      ADD CONSTRAINT "PasswordResetToken_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
