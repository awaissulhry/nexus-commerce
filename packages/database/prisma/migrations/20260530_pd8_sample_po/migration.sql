-- PD.8 — sample/development PO linkage (additive columns + FK).
ALTER TABLE "PurchaseOrder" ADD COLUMN "developmentProjectId" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "poKind" TEXT NOT NULL DEFAULT 'STANDARD';
CREATE INDEX "PurchaseOrder_developmentProjectId_idx" ON "PurchaseOrder"("developmentProjectId");
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_developmentProjectId_fkey" FOREIGN KEY ("developmentProjectId") REFERENCES "DevelopmentProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
