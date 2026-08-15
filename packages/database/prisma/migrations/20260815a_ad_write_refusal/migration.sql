-- AUTO.A7 / substrate S5 -- the durable record of a write-gate refusal.
--
-- Purely additive: one new table, three indexes. Nothing altered, nothing dropped.
--
-- Until now logGateDeny wrote to the application log and nowhere else, so no surface could count
-- refusals by the gate: NEG.8 renders an em-dash where that number should be, and the AUTO study
-- called refusals "unsourceable since 2026-08-04". Written INSIDE logGateDeny so no caller can
-- forget it; a failed insert is error-logged loudly, never swallowed. Surfaces reading this table
-- must state that the record starts 2026-08-15 -- earlier refusals exist only in the app log.
CREATE TABLE "AdWriteRefusal" (
  "id" TEXT NOT NULL,
  "deniedAt" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "marketplace" TEXT,
  "campaignId" TEXT,
  "entityType" TEXT,
  "entityId" TEXT,
  "payloadValueCents" INTEGER NOT NULL,
  "queueId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdWriteRefusal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdWriteRefusal_deniedAt_createdAt_idx" ON "AdWriteRefusal"("deniedAt", "createdAt");
CREATE INDEX "AdWriteRefusal_campaignId_createdAt_idx" ON "AdWriteRefusal"("campaignId", "createdAt");
CREATE INDEX "AdWriteRefusal_createdAt_idx" ON "AdWriteRefusal"("createdAt");
