-- Phase C — Profile & Security rebuild.
--
-- Three pieces:
--   1. UserProfile: 9 new nullable columns (phone, timezone, locale,
--      working hours, week start, 2FA secret + enabledAt).
--   2. TwoFactorRecoveryCode: bcrypt-hashed recovery codes, 10 per
--      enrollment, single-use (consumed via usedAt).
--   3. UserSession + LoginEvent: device tracking + append-only login
--      history. Active until full auth middleware lands in Phase I —
--      schema plumbed end-to-end so the UI can render real shapes.
--
-- All UserProfile additions are nullable so the existing seeded row
-- doesn't need a backfill. The two new tables FK back to UserProfile
-- with ON DELETE CASCADE / SET NULL as appropriate.

-- ── 1. UserProfile column additions ──────────────────────────────
ALTER TABLE "UserProfile"
  ADD COLUMN "phone"              TEXT,
  ADD COLUMN "timezone"           TEXT,
  ADD COLUMN "language"           TEXT,
  ADD COLUMN "dateFormat"         TEXT,
  ADD COLUMN "weekStart"          INTEGER,
  ADD COLUMN "workingHoursStart"  TEXT,
  ADD COLUMN "workingHoursEnd"    TEXT,
  ADD COLUMN "twoFactorSecret"    TEXT,
  ADD COLUMN "twoFactorEnabledAt" TIMESTAMP(3);

-- ── 2. TwoFactorRecoveryCode ─────────────────────────────────────
CREATE TABLE "TwoFactorRecoveryCode" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "codeHash"  TEXT NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TwoFactorRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TwoFactorRecoveryCode_userId_idx"
  ON "TwoFactorRecoveryCode"("userId");
CREATE INDEX "TwoFactorRecoveryCode_userId_usedAt_idx"
  ON "TwoFactorRecoveryCode"("userId", "usedAt");

ALTER TABLE "TwoFactorRecoveryCode"
  ADD CONSTRAINT "TwoFactorRecoveryCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. UserSession ───────────────────────────────────────────────
CREATE TABLE "UserSession" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "tokenPrefix" TEXT NOT NULL,
  "userAgent"   TEXT,
  "ipAddress"   TEXT,
  "ipCity"      TEXT,
  "ipCountry"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"   TIMESTAMP(3),
  CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");
CREATE INDEX "UserSession_userId_revokedAt_idx"
  ON "UserSession"("userId", "revokedAt");

ALTER TABLE "UserSession"
  ADD CONSTRAINT "UserSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 4. LoginEvent ────────────────────────────────────────────────
-- userId is nullable so failed logins from an unknown email still
-- record. FK with ON DELETE SET NULL so deleting a user keeps the
-- audit trail intact (we still want to see "someone tried to log in
-- as alice@x" even after alice is gone).
CREATE TABLE "LoginEvent" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT,
  "emailTried" TEXT,
  "outcome"    TEXT NOT NULL,
  "userAgent"  TEXT,
  "ipAddress"  TEXT,
  "ipCity"     TEXT,
  "ipCountry"  TEXT,
  "metadata"   JSONB,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoginEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginEvent_userId_idx" ON "LoginEvent"("userId");
CREATE INDEX "LoginEvent_createdAt_idx" ON "LoginEvent"("createdAt");

ALTER TABLE "LoginEvent"
  ADD CONSTRAINT "LoginEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
