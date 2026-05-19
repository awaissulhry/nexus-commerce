-- CreateTable: FlatFilePullRecord
-- Phase 2 of the in-editor Pull from Amazon feature (sibling to the
-- /reconciliation pull). One row is written each time an operator
-- runs the diff-preview modal — captures what was pulled, which
-- column groups were applied, and how many cells changed. Backs the
-- pull-history drawer scheduled for Phase 5 and gives support a
-- record of who touched which marketplace and when.
--
-- No FK to Product: a pull is editor-scoped (productType + sku
-- list), not product-scoped. SKUs are stored as a string[] so
-- audit rows survive product deletions intact.

CREATE TABLE "FlatFilePullRecord" (
    "id"             TEXT NOT NULL,
    "channel"        TEXT NOT NULL,
    "marketplace"    TEXT NOT NULL,
    "productType"    TEXT NOT NULL,
    "jobId"          TEXT,
    "skusRequested"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "skusReturned"   INTEGER NOT NULL DEFAULT 0,
    "columnsApplied" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "rowsApplied"    INTEGER NOT NULL DEFAULT 0,
    "fieldsApplied"  INTEGER NOT NULL DEFAULT 0,
    "appliedAt"      TIMESTAMP(3),
    "operatorNote"   TEXT,
    "pulledAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlatFilePullRecord_pkey" PRIMARY KEY ("id")
);

-- Composite index for the planned per-market pull-history drawer.
CREATE INDEX "FlatFilePullRecord_channel_marketplace_pulledAt_idx"
    ON "FlatFilePullRecord"("channel", "marketplace", "pulledAt");

-- Secondary index for product-type-scoped lookups.
CREATE INDEX "FlatFilePullRecord_productType_pulledAt_idx"
    ON "FlatFilePullRecord"("productType", "pulledAt");
