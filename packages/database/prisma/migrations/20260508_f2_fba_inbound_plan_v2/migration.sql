-- F.2 (TECH_DEBT #50) — FBA Inbound v2024-03-20 plan tracker.
--
-- Persistent state for the multi-step v2024-03-20 SP-API flow. Each
-- plan tracks where the operator is in the create→packing→placement→
-- transport→labels sequence, the operationIds for any in-flight async
-- ops, and the per-step decisions so a partial plan can be resumed.
--
-- Pure-additive: no existing column changes. The optional FK to
-- InboundShipment uses ON DELETE SET NULL so deleting an inbound row
-- doesn't cascade-orphan a plan operator might still want to see.

CREATE TABLE "FbaInboundPlanV2" (
  "id"                            TEXT      NOT NULL,
  "inboundShipmentId"             TEXT,
  "planId"                        TEXT,
  "name"                          TEXT,
  "status"                        TEXT      NOT NULL DEFAULT 'DRAFT',
  "currentStep"                   TEXT      NOT NULL DEFAULT 'CREATE',
  "operationIds"                  JSONB,
  "selectedPackingOptionId"       TEXT,
  "selectedPlacementOptionId"     TEXT,
  "selectedTransportationOptions" JSONB,
  "shipmentIds"                   TEXT[]    NOT NULL DEFAULT '{}',
  "labels"                        JSONB,
  "createdBy"                     TEXT,
  "createdAt"                     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                     TIMESTAMP(3) NOT NULL,
  "lastError"                     TEXT,
  "lastErrorAt"                   TIMESTAMP(3),

  CONSTRAINT "FbaInboundPlanV2_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FbaInboundPlanV2_planId_key" ON "FbaInboundPlanV2"("planId");
CREATE INDEX "FbaInboundPlanV2_planId_idx" ON "FbaInboundPlanV2"("planId");
CREATE INDEX "FbaInboundPlanV2_status_idx" ON "FbaInboundPlanV2"("status");
CREATE INDEX "FbaInboundPlanV2_inboundShipmentId_idx" ON "FbaInboundPlanV2"("inboundShipmentId");
CREATE INDEX "FbaInboundPlanV2_createdAt_idx" ON "FbaInboundPlanV2"("createdAt");

ALTER TABLE "FbaInboundPlanV2"
  ADD CONSTRAINT "FbaInboundPlanV2_inboundShipmentId_fkey"
  FOREIGN KEY ("inboundShipmentId") REFERENCES "InboundShipment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
