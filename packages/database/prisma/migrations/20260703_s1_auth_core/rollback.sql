-- Rollback for 20260703_s1_auth_core.
-- Drops exactly what migration.sql added. Pre-existing UserProfile /
-- UserSession rows are preserved — they only shed the new nullable
-- columns. New tables are dropped whole (they hold only S1 auth data
-- created after this migration; confirm no live users depend on them
-- before running in prod).
--
-- Usage (non-pooled connection; strip `-pooler` from the host):
--   psql "$NON_POOLED_DATABASE_URL" -f rollback.sql
-- Then remove the migration folder + its _prisma_migrations row, or
-- restore the pre-migration Neon branch.

-- Drop FKs first (safe if already gone).
ALTER TABLE IF EXISTS "PasswordResetToken" DROP CONSTRAINT IF EXISTS "PasswordResetToken_userId_fkey";
ALTER TABLE IF EXISTS "Invitation"         DROP CONSTRAINT IF EXISTS "Invitation_invitedByUserId_fkey";
ALTER TABLE IF EXISTS "Invitation"         DROP CONSTRAINT IF EXISTS "Invitation_roleId_fkey";
ALTER TABLE IF EXISTS "UserRole"           DROP CONSTRAINT IF EXISTS "UserRole_roleId_fkey";
ALTER TABLE IF EXISTS "UserRole"           DROP CONSTRAINT IF EXISTS "UserRole_userId_fkey";

-- Drop new tables.
DROP TABLE IF EXISTS "PasswordResetToken";
DROP TABLE IF EXISTS "Invitation";
DROP TABLE IF EXISTS "UserRole";
DROP TABLE IF EXISTS "Role";

-- Remove UserSession session-store columns.
DROP INDEX IF EXISTS "UserSession_sessionTokenHash_key";
ALTER TABLE "UserSession"
  DROP COLUMN IF EXISTS "sessionTokenHash",
  DROP COLUMN IF EXISTS "idleExpiry",
  DROP COLUMN IF EXISTS "absoluteExpiry",
  DROP COLUMN IF EXISTS "mfaSatisfied";

-- Drop the email uniqueness (back to non-unique).
DROP INDEX IF EXISTS "UserProfile_email_key";

-- Remove UserProfile auth columns.
ALTER TABLE "UserProfile"
  DROP COLUMN IF EXISTS "status",
  DROP COLUMN IF EXISTS "deactivatedAt",
  DROP COLUMN IF EXISTS "failedLoginCount",
  DROP COLUMN IF EXISTS "lockedUntil",
  DROP COLUMN IF EXISTS "lastLoginAt",
  DROP COLUMN IF EXISTS "permissionsVersion",
  DROP COLUMN IF EXISTS "mfaRequired";

-- Drop the enum last (nothing references it once tables are gone).
DROP TYPE IF EXISTS "SystemRole";
