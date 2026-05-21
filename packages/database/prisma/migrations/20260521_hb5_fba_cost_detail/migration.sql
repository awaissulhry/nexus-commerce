-- HB.5 — FBA cost detail tables.
--
-- Captures Amazon's per-event ledgers that flow into the per-marketplace
-- P&L picture but were never ingested:
--
--   FbaReimbursement       — Amazon credits the seller for lost / damaged
--                            / not-returned inventory. Real positive P&L.
--                            Source: GET_FBA_REIMBURSEMENTS_DATA.
--   FbaInventoryAdjustment — Per-FC inventory ledger events (transfers,
--                            removals, damages, corrections).
--                            Source: GET_FBA_INVENTORY_ADJUSTMENTS_DATA.
--
-- FbaStorageAge already exists (pre-existing schema, populated via the
-- AD-series storage-age ingest cron — not in this migration).

CREATE TABLE "FbaReimbursement" (
  "id"                  TEXT NOT NULL,
  -- Amazon's reimbursement-id. Unique per event; safe upsert key.
  "reimbursementId"     TEXT NOT NULL,
  "approvalDate"        TIMESTAMP(3) NOT NULL,
  "caseId"              TEXT,
  "amazonOrderId"       TEXT,
  -- Free-form reason text Amazon supplies (e.g. "Lost_Inbound",
  -- "Damaged_Warehouse", "FBA_Inventory_Reimbursement"). Kept as string
  -- for forward-compat with new reason codes.
  "reason"              TEXT,
  "sku"                 TEXT NOT NULL,
  "fnsku"               TEXT,
  "asin"                TEXT,
  "quantityReimbursed"  INTEGER NOT NULL DEFAULT 0,
  -- amountPerUnit + totalAmount in integer cents. Native currency
  -- (matches Order/Settlement convention — no implicit conversion).
  "amountPerUnitCents"  INTEGER NOT NULL DEFAULT 0,
  "totalAmountCents"    INTEGER NOT NULL DEFAULT 0,
  "currencyCode"        TEXT NOT NULL DEFAULT 'EUR',
  -- SP-API marketplaceId (APJ6JRA9NG5V4 for IT, etc.).
  "marketplaceId"       TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FbaReimbursement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FbaReimbursement_reimbursementId_key"
  ON "FbaReimbursement"("reimbursementId");
CREATE INDEX "FbaReimbursement_approvalDate_idx"
  ON "FbaReimbursement"("approvalDate");
CREATE INDEX "FbaReimbursement_sku_idx"
  ON "FbaReimbursement"("sku");
CREATE INDEX "FbaReimbursement_marketplaceId_idx"
  ON "FbaReimbursement"("marketplaceId");

CREATE TABLE "FbaInventoryAdjustment" (
  "id"                    TEXT NOT NULL,
  -- Amazon's adjusted-id (sometimes "transaction-item-id"). Unique per
  -- adjustment event.
  "adjustmentId"          TEXT NOT NULL,
  "adjustedDate"          TIMESTAMP(3) NOT NULL,
  -- Adjustment kind. Examples: 'CustomerReturn', 'Damaged',
  -- 'Misplaced', 'MissingFromInbound', 'Found', 'TransferIn',
  -- 'TransferOut', 'CrossFcTransfer'.
  "transactionType"       TEXT NOT NULL,
  "fnsku"                 TEXT,
  "sku"                   TEXT NOT NULL,
  "asin"                  TEXT,
  -- Signed integer — negative for removals (transfer out, damaged,
  -- etc.), positive for additions (transfer in, found).
  "quantity"              INTEGER NOT NULL,
  "fulfillmentCenterId"   TEXT,
  "reasonCode"            TEXT,
  "disposition"           TEXT,
  "marketplaceId"         TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FbaInventoryAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FbaInventoryAdjustment_adjustmentId_key"
  ON "FbaInventoryAdjustment"("adjustmentId");
CREATE INDEX "FbaInventoryAdjustment_adjustedDate_idx"
  ON "FbaInventoryAdjustment"("adjustedDate");
CREATE INDEX "FbaInventoryAdjustment_sku_idx"
  ON "FbaInventoryAdjustment"("sku");
CREATE INDEX "FbaInventoryAdjustment_transactionType_idx"
  ON "FbaInventoryAdjustment"("transactionType");
