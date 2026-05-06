-- =====================================================================
-- H.1 — InboundShipment / Item schema upgrade
--
-- Foundation for the inbound rebuild. Adds carrier + tracking,
-- multi-currency, cost capture, photos, attachments, discrepancy
-- model, status enum extensions. Additive only — no existing column
-- semantics change.
-- =====================================================================

-- ── 1. Status enum extensions ───────────────────────────────────────
ALTER TYPE "InboundStatus" ADD VALUE IF NOT EXISTS 'SUBMITTED';
ALTER TYPE "InboundStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_RECEIVED';
ALTER TYPE "InboundStatus" ADD VALUE IF NOT EXISTS 'RECEIVED';
ALTER TYPE "InboundStatus" ADD VALUE IF NOT EXISTS 'RECONCILED';

-- ── 2. InboundShipment: carrier + tracking + ASN + cost + audit ─────
ALTER TABLE "InboundShipment" ADD COLUMN "asnFileUrl"         TEXT;
ALTER TABLE "InboundShipment" ADD COLUMN "carrierCode"        TEXT;
ALTER TABLE "InboundShipment" ADD COLUMN "trackingNumber"     TEXT;
ALTER TABLE "InboundShipment" ADD COLUMN "trackingUrl"        TEXT;
ALTER TABLE "InboundShipment" ADD COLUMN "currencyCode"       TEXT NOT NULL DEFAULT 'EUR';
ALTER TABLE "InboundShipment" ADD COLUMN "exchangeRate"       DECIMAL(12, 6);
ALTER TABLE "InboundShipment" ADD COLUMN "shippingCostCents"  INTEGER;
ALTER TABLE "InboundShipment" ADD COLUMN "customsCostCents"   INTEGER;
ALTER TABLE "InboundShipment" ADD COLUMN "dutiesCostCents"    INTEGER;
ALTER TABLE "InboundShipment" ADD COLUMN "insuranceCostCents" INTEGER;
ALTER TABLE "InboundShipment" ADD COLUMN "createdById"        TEXT;
ALTER TABLE "InboundShipment" ADD COLUMN "receivedById"       TEXT;

CREATE INDEX "InboundShipment_purchaseOrderId_idx" ON "InboundShipment"("purchaseOrderId");
CREATE INDEX "InboundShipment_carrierCode_idx"     ON "InboundShipment"("carrierCode");
CREATE INDEX "InboundShipment_trackingNumber_idx"  ON "InboundShipment"("trackingNumber");
CREATE INDEX "InboundShipment_expectedAt_idx"      ON "InboundShipment"("expectedAt");

-- ── 3. InboundShipmentItem: cost + photos ───────────────────────────
ALTER TABLE "InboundShipmentItem" ADD COLUMN "unitCostCents"     INTEGER;
ALTER TABLE "InboundShipmentItem" ADD COLUMN "costVarianceCents" INTEGER;
ALTER TABLE "InboundShipmentItem" ADD COLUMN "photoUrls"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ── 4. InboundShipmentAttachment ────────────────────────────────────
CREATE TABLE "InboundShipmentAttachment" (
  "id"                TEXT         NOT NULL,
  "inboundShipmentId" TEXT         NOT NULL,
  "kind"              TEXT         NOT NULL,
  "url"               TEXT         NOT NULL,
  "filename"          TEXT,
  "contentType"       TEXT,
  "sizeBytes"         INTEGER,
  "uploadedBy"        TEXT,
  "uploadedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboundShipmentAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InboundShipmentAttachment_inboundShipmentId_idx" ON "InboundShipmentAttachment"("inboundShipmentId");
CREATE INDEX "InboundShipmentAttachment_kind_idx"              ON "InboundShipmentAttachment"("kind");

ALTER TABLE "InboundShipmentAttachment"
  ADD CONSTRAINT "InboundShipmentAttachment_inboundShipmentId_fkey"
  FOREIGN KEY ("inboundShipmentId") REFERENCES "InboundShipment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 5. InboundDiscrepancy ───────────────────────────────────────────
CREATE TABLE "InboundDiscrepancy" (
  "id"                    TEXT         NOT NULL,
  "inboundShipmentId"     TEXT         NOT NULL,
  "inboundShipmentItemId" TEXT,
  "reasonCode"            TEXT         NOT NULL,
  "expectedValue"         TEXT,
  "actualValue"           TEXT,
  "quantityImpact"        INTEGER,
  "costImpactCents"       INTEGER,
  "description"           TEXT,
  "photoUrls"             TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"                TEXT         NOT NULL DEFAULT 'REPORTED',
  "reportedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reportedBy"            TEXT,
  "acknowledgedAt"        TIMESTAMP(3),
  "resolvedAt"            TIMESTAMP(3),
  "resolutionNotes"       TEXT,
  CONSTRAINT "InboundDiscrepancy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InboundDiscrepancy_inboundShipmentId_idx"     ON "InboundDiscrepancy"("inboundShipmentId");
CREATE INDEX "InboundDiscrepancy_inboundShipmentItemId_idx" ON "InboundDiscrepancy"("inboundShipmentItemId");
CREATE INDEX "InboundDiscrepancy_status_idx"                ON "InboundDiscrepancy"("status");
CREATE INDEX "InboundDiscrepancy_reasonCode_idx"            ON "InboundDiscrepancy"("reasonCode");

ALTER TABLE "InboundDiscrepancy"
  ADD CONSTRAINT "InboundDiscrepancy_inboundShipmentId_fkey"
  FOREIGN KEY ("inboundShipmentId") REFERENCES "InboundShipment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InboundDiscrepancy"
  ADD CONSTRAINT "InboundDiscrepancy_inboundShipmentItemId_fkey"
  FOREIGN KEY ("inboundShipmentItemId") REFERENCES "InboundShipmentItem"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
