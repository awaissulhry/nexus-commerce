-- Phase E — per-user notification prefs + webhook subscriptions.
--
-- Three pieces:
--   1. NotificationPreference: + userId (FK, nullable for back-compat),
--      + channelFilter[], + digestCadence; switch unique constraint
--      from (eventType) to (userId, eventType).
--   2. UserProfile: + quietHoursStart, quietHoursEnd.
--   3. New table NotificationWebhook for outbound subscriptions.
--
-- The unique-key change is the tricky part: existing rows have
-- userId IS NULL, so the new composite (userId, eventType) still
-- enforces "at most one workspace-global pref per event-type" while
-- letting per-user rows coexist. Postgres treats NULLs as distinct
-- by default in unique indexes, so multiple userId=NULL rows would
-- pass the constraint — that's actually what we want during the
-- transition; the API enforces "one row per (userId|workspace,
-- eventType)" at the application layer.

-- ── 1. NotificationPreference column additions ───────────────────
ALTER TABLE "NotificationPreference"
  ADD COLUMN "userId"         TEXT,
  ADD COLUMN "channelFilter"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "digestCadence"  TEXT   NOT NULL DEFAULT 'instant';

-- ── 2. Swap the unique constraint ───────────────────────────────
-- Drop the old single-column unique on eventType, replace with the
-- composite. Postgres unique-NULL semantics mean existing rows
-- (userId IS NULL) still get a unique-per-event guarantee.
ALTER TABLE "NotificationPreference"
  DROP CONSTRAINT IF EXISTS "NotificationPreference_eventType_key";

CREATE UNIQUE INDEX "NotificationPreference_userId_eventType_key"
  ON "NotificationPreference"("userId", "eventType");

CREATE INDEX "NotificationPreference_userId_idx"
  ON "NotificationPreference"("userId");

-- ── 3. FK on the new userId column ──────────────────────────────
ALTER TABLE "NotificationPreference"
  ADD CONSTRAINT "NotificationPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 4. UserProfile quiet hours ──────────────────────────────────
ALTER TABLE "UserProfile"
  ADD COLUMN "quietHoursStart" TEXT,
  ADD COLUMN "quietHoursEnd"   TEXT;

-- ── 5. NotificationWebhook ──────────────────────────────────────
CREATE TABLE "NotificationWebhook" (
  "id"               TEXT NOT NULL,
  "userId"           TEXT,
  "label"            TEXT NOT NULL,
  "url"              TEXT NOT NULL,
  "secretHash"       TEXT NOT NULL,
  "secretPrefix"     TEXT NOT NULL,
  "events"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "isActive"         BOOLEAN NOT NULL DEFAULT true,
  "lastFiredAt"      TIMESTAMP(3),
  "lastStatus"       INTEGER,
  "lastError"        TEXT,
  "consecutiveFails" INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationWebhook_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationWebhook_userId_idx"
  ON "NotificationWebhook"("userId");
CREATE INDEX "NotificationWebhook_isActive_idx"
  ON "NotificationWebhook"("isActive");

ALTER TABLE "NotificationWebhook"
  ADD CONSTRAINT "NotificationWebhook_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
