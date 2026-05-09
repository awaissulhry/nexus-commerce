-- DO.32 / W14 — DashboardLayout model.
--
-- Per-user dashboard customisation. First cut stores a deny-list
-- of widget IDs the operator wants hidden; the dashboard reads it
-- and conditionally renders. Reordering / drag-drop is a follow-up
-- (needs a separate `order String[]` column + the drag UX).
--
-- Single-row-per-user pattern: userId is unique. Pre-auth scope
-- 'default-user' to match existing Notification + Goal conventions.
--
-- Migration is idempotent (IF NOT EXISTS) so re-running on an
-- environment where the table already exists is a no-op.

CREATE TABLE IF NOT EXISTS "DashboardLayout" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL DEFAULT 'default-user',
  "hiddenWidgets" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt"     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP NOT NULL,

  CONSTRAINT "DashboardLayout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DashboardLayout_userId_key"
  ON "DashboardLayout"("userId");
