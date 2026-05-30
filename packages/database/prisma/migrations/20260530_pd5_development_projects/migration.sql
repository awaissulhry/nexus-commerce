-- PD.5 — development projects (additive: two new tables).
CREATE TABLE "DevelopmentProject" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CONCEPT',
  "productType" TEXT,
  "brief" TEXT,
  "targetCostCents" INTEGER,
  "targetLaunchDate" TIMESTAMP(3),
  "ownerUserId" TEXT,
  "linkedProductId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DevelopmentProject_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DevelopmentProject_code_key" ON "DevelopmentProject"("code");
CREATE INDEX "DevelopmentProject_status_idx" ON "DevelopmentProject"("status");

CREATE TABLE "DevelopmentProjectSupplier" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "quotedCostCents" INTEGER,
  "sampleStatus" TEXT,
  "isSelected" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DevelopmentProjectSupplier_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DevelopmentProjectSupplier_projectId_supplierId_key" ON "DevelopmentProjectSupplier"("projectId", "supplierId");
CREATE INDEX "DevelopmentProjectSupplier_supplierId_idx" ON "DevelopmentProjectSupplier"("supplierId");
ALTER TABLE "DevelopmentProjectSupplier" ADD CONSTRAINT "DevelopmentProjectSupplier_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DevelopmentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DevelopmentProjectSupplier" ADD CONSTRAINT "DevelopmentProjectSupplier_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
