-- PO.1 — schema additions for the /fulfillment/purchase-orders rebuild.
--
-- Additive only:
--   1. BrandSettings — value-based approval ladder fields
--   2. PurchaseOrder — supplier ack token + confirmed ETA columns
--      + composite index on (expectedDeliveryDate, deletedAt)
--      for the "Late POs" / "This week's deliveries" saved views.
--   3. PurchaseOrderItem — per-line note + lineOrder for drag-reorder
--   4. NEW PurchaseOrderAttachment — PO-level docs (quote, contract,
--      art, label sheets). Distinct from InboundShipmentAttachment
--      which is receive-side.
--   5. NEW PurchaseOrderRevision — post-SUBMITTED revision chain with
--      JSON snapshot of frozen items + supplier ack lifecycle.
--   6. NEW PoComment — threaded comments with @-mentions.
--
-- No data backfills required. Existing PurchaseOrderItem rows get
-- lineOrder=0 by default; the API will renumber on first edit.

-- ─── 1. BrandSettings: approval ladder ──────────────────────────────
ALTER TABLE "BrandSettings"
  ADD COLUMN "poApprovalThresholdCents" INTEGER,
  ADD COLUMN "poApprovalApproverEmail"  TEXT;

-- ─── 2. PurchaseOrder: ack token + confirmed ETA ────────────────────
ALTER TABLE "PurchaseOrder"
  ADD COLUMN "supplierConfirmedDeliveryDate" TIMESTAMP(3),
  ADD COLUMN "supplierConfirmedAt"           TIMESTAMP(3),
  ADD COLUMN "supplierAckToken"              TEXT,
  ADD COLUMN "supplierAckExpiresAt"          TIMESTAMP(3);

-- Token is globally unique so the ack URL is collision-free.
-- Partial-where-not-null keeps the index lean since the vast majority
-- of historical POs will never have a token minted.
CREATE UNIQUE INDEX "PurchaseOrder_supplierAckToken_key"
  ON "PurchaseOrder"("supplierAckToken")
  WHERE "supplierAckToken" IS NOT NULL;

-- "Late POs" / "This week's deliveries" hot path.
CREATE INDEX "PurchaseOrder_expectedDeliveryDate_deletedAt_idx"
  ON "PurchaseOrder"("expectedDeliveryDate", "deletedAt");

-- ─── 3. PurchaseOrderItem: per-line note + display order ────────────
ALTER TABLE "PurchaseOrderItem"
  ADD COLUMN "note"      TEXT,
  ADD COLUMN "lineOrder" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "PurchaseOrderItem_purchaseOrderId_lineOrder_idx"
  ON "PurchaseOrderItem"("purchaseOrderId", "lineOrder");

-- ─── 4. PurchaseOrderAttachment ─────────────────────────────────────
CREATE TABLE "PurchaseOrderAttachment" (
  "id"              TEXT NOT NULL,
  "purchaseOrderId" TEXT NOT NULL,
  "kind"            TEXT NOT NULL,
  "url"             TEXT NOT NULL,
  "filename"        TEXT,
  "contentType"     TEXT,
  "sizeBytes"       INTEGER,
  "uploadedBy"      TEXT,
  "uploadedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PurchaseOrderAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PurchaseOrderAttachment_purchaseOrderId_idx"
  ON "PurchaseOrderAttachment"("purchaseOrderId");
CREATE INDEX "PurchaseOrderAttachment_kind_idx"
  ON "PurchaseOrderAttachment"("kind");

ALTER TABLE "PurchaseOrderAttachment"
  ADD CONSTRAINT "PurchaseOrderAttachment_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId")
  REFERENCES "PurchaseOrder"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 5. PurchaseOrderRevision ───────────────────────────────────────
CREATE TABLE "PurchaseOrderRevision" (
  "id"                 TEXT NOT NULL,
  "purchaseOrderId"    TEXT NOT NULL,
  "version"            INTEGER NOT NULL,
  "reason"             TEXT,
  "status"             TEXT NOT NULL DEFAULT 'PENDING',
  "snapshotJson"       JSONB NOT NULL,
  "createdBy"          TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supplierNotifiedAt" TIMESTAMP(3),
  "supplierAckedAt"    TIMESTAMP(3),
  "cancelledAt"        TIMESTAMP(3),

  CONSTRAINT "PurchaseOrderRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PurchaseOrderRevision_purchaseOrderId_version_key"
  ON "PurchaseOrderRevision"("purchaseOrderId", "version");
CREATE INDEX "PurchaseOrderRevision_purchaseOrderId_idx"
  ON "PurchaseOrderRevision"("purchaseOrderId");
CREATE INDEX "PurchaseOrderRevision_status_idx"
  ON "PurchaseOrderRevision"("status");

ALTER TABLE "PurchaseOrderRevision"
  ADD CONSTRAINT "PurchaseOrderRevision_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId")
  REFERENCES "PurchaseOrder"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 6. PoComment ───────────────────────────────────────────────────
CREATE TABLE "PoComment" (
  "id"              TEXT NOT NULL,
  "purchaseOrderId" TEXT NOT NULL,
  "userId"          TEXT,
  "body"            TEXT NOT NULL,
  "mentions"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "editedAt"        TIMESTAMP(3),

  CONSTRAINT "PoComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PoComment_purchaseOrderId_createdAt_idx"
  ON "PoComment"("purchaseOrderId", "createdAt");

ALTER TABLE "PoComment"
  ADD CONSTRAINT "PoComment_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId")
  REFERENCES "PurchaseOrder"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
