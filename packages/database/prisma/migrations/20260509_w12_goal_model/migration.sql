-- DO.30 / W12 — Goal model.
--
-- Operator-set period targets (daily / weekly / monthly / quarterly
-- / yearly) for revenue, orders, AOV, units sold, and new customers.
-- The Command Center overview reads ACTIVE goals and computes
-- progress against the same window arithmetic the headline KPIs use
-- (zoned to Europe/Rome; see DO.2).
--
-- targetValue semantics depend on `type`:
--   revenue / aov → currency amount in the row's `currency`
--                   (NULL = EUR fallback to match DO.1's primary)
--   orders / units / newCustomers → count
--
-- Single-user pre-auth: userId defaults to 'default-user' to match
-- the existing Notification + saved-view-alert convention.
--
-- Migration is idempotent (IF NOT EXISTS on table + indexes) so
-- re-running on an environment where the table already exists is
-- a no-op.

CREATE TABLE IF NOT EXISTS "Goal" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL DEFAULT 'default-user',
  "type"        TEXT NOT NULL,
  "period"      TEXT NOT NULL,
  "targetValue" DECIMAL(14,2) NOT NULL,
  "currency"    TEXT,
  "label"       TEXT,
  "status"      TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP NOT NULL,

  CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Goal_userId_status_idx"
  ON "Goal"("userId", "status");

CREATE INDEX IF NOT EXISTS "Goal_period_idx"
  ON "Goal"("period");
