-- DO.39 / W14 — DashboardView (saved named layouts).
--
-- Replaces the deferred "per-role views" piece of the original
-- DO.33 row. Single-user pre-auth makes real roles a stretch;
-- saved per-operator views deliver the operational value (switch
-- between Daily ops / Finance check-in / Weekly review) without
-- needing a Role + Permission model.
--
-- Apply-from-view copies hiddenWidgets + widgetOrder into the
-- singleton DashboardLayout row. activeViewId on DashboardLayout
-- points at the source view so the switcher can highlight it.
--
-- Idempotent: CREATE IF NOT EXISTS on the table + index, ADD
-- COLUMN IF NOT EXISTS on the existing pointer.

CREATE TABLE IF NOT EXISTS "DashboardView" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL DEFAULT 'default-user',
  "name"          TEXT NOT NULL,
  "hiddenWidgets" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "widgetOrder"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "isDefault"     BOOLEAN NOT NULL DEFAULT false,
  "createdAt"     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP NOT NULL,

  CONSTRAINT "DashboardView_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DashboardView_userId_name_key"
  ON "DashboardView"("userId", "name");

CREATE INDEX IF NOT EXISTS "DashboardView_userId_idx"
  ON "DashboardView"("userId");

ALTER TABLE "DashboardLayout"
  ADD COLUMN IF NOT EXISTS "activeViewId" TEXT;
