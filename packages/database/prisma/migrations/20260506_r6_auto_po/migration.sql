-- =====================================================================
-- R.6 — Auto-PO trigger (cron-driven nightly draft creation)
--
-- Defense-in-depth opt-in:
--   1. Supplier.autoTriggerEnabled    (default false)
--   2. ReplenishmentRule.autoTriggerEnabled (default true; explicit opt-out)
--
-- Both must be true for a recommendation to fire an auto-PO. Per-PO
-- ceilings (qty + cost) cap blast radius even when opted in. Null
-- ceilings inherit env-var defaults.
-- =====================================================================

-- ── Supplier opt-in + per-PO ceilings ─────────────────────────────
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "autoTriggerEnabled"           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "autoTriggerMaxQtyPerPo"       INTEGER;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "autoTriggerMaxCostCentsPerPo" INTEGER;

-- ── ReplenishmentRule per-product opt-out (default-on) ────────────
ALTER TABLE "ReplenishmentRule" ADD COLUMN IF NOT EXISTS "autoTriggerEnabled" BOOLEAN NOT NULL DEFAULT true;

-- ── PurchaseOrder.createdBy backfill ──────────────────────────────
-- Column already exists; backfill so future filters don't deal with NULLs.
UPDATE "PurchaseOrder" SET "createdBy" = 'manual' WHERE "createdBy" IS NULL;

-- ── AutoPoRunLog forensic ledger ──────────────────────────────────
CREATE TABLE "AutoPoRunLog" (
  "id"          TEXT NOT NULL,
  "startedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"  TIMESTAMP(3),
  "triggeredBy" TEXT NOT NULL,
  "dryRun"      BOOLEAN NOT NULL DEFAULT false,

  "eligibleCount"            INTEGER NOT NULL DEFAULT 0,
  "posCreated"               INTEGER NOT NULL DEFAULT 0,
  "totalUnitsCreated"        INTEGER NOT NULL DEFAULT 0,
  "totalCostCentsCreated"    INTEGER NOT NULL DEFAULT 0,
  "declinedNoOptIn"          INTEGER NOT NULL DEFAULT 0,
  "declinedQtyCeiling"       INTEGER NOT NULL DEFAULT 0,
  "declinedCostCeiling"      INTEGER NOT NULL DEFAULT 0,
  "declinedPerProductOptOut" INTEGER NOT NULL DEFAULT 0,
  "errorCount"               INTEGER NOT NULL DEFAULT 0,

  "notes"        TEXT,
  "createdPoIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  CONSTRAINT "AutoPoRunLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AutoPoRunLog_startedAt_idx"   ON "AutoPoRunLog"("startedAt");
CREATE INDEX "AutoPoRunLog_triggeredBy_idx" ON "AutoPoRunLog"("triggeredBy");
