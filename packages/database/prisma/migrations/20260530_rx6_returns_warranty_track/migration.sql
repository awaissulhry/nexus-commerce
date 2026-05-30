-- RX.6b — warranty / defect / recall RMA track. Additive only:
-- existing Return rows default to returnType='STANDARD', all other
-- columns nullable; ReturnItem.lotId is a nullable FK to Lot. No
-- backfill, no destructive changes.

ALTER TABLE "Return" ADD COLUMN "returnType" TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "Return" ADD COLUMN "warrantyStatus" TEXT;
ALTER TABLE "Return" ADD COLUMN "warrantyResolution" TEXT;
ALTER TABLE "Return" ADD COLUMN "defectReportedAt" TIMESTAMP(3);
ALTER TABLE "Return" ADD COLUMN "manufacturerRef" TEXT;
CREATE INDEX "Return_returnType_idx" ON "Return"("returnType");

ALTER TABLE "ReturnItem" ADD COLUMN "lotId" TEXT;
CREATE INDEX "ReturnItem_lotId_idx" ON "ReturnItem"("lotId");
ALTER TABLE "ReturnItem" ADD CONSTRAINT "ReturnItem_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
