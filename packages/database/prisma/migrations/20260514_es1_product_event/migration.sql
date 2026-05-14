-- ES.1: Immutable Product Event Log
-- Append-only ledger for every tracked mutation across Product,
-- ChannelListing, StockLevel, and Order aggregates.
-- Never UPDATE or DELETE rows — only INSERT.

CREATE TABLE "ProductEvent" (
  "id"            TEXT        NOT NULL,
  "aggregateId"   TEXT        NOT NULL,
  "aggregateType" TEXT        NOT NULL,
  "eventType"     TEXT        NOT NULL,
  "data"          JSONB,
  "metadata"      JSONB,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

-- Timeline: all events for one aggregate, newest first
CREATE INDEX "ProductEvent_aggregateId_createdAt_idx"
  ON "ProductEvent"("aggregateId", "createdAt" DESC);

-- Cross-aggregate feed
CREATE INDEX "ProductEvent_aggregateType_aggregateId_idx"
  ON "ProductEvent"("aggregateType", "aggregateId");

-- Event-type feed (e.g. all FLAT_FILE_IMPORTED events)
CREATE INDEX "ProductEvent_eventType_createdAt_idx"
  ON "ProductEvent"("eventType", "createdAt" DESC);

-- Admin event explorer
CREATE INDEX "ProductEvent_createdAt_idx"
  ON "ProductEvent"("createdAt" DESC);
