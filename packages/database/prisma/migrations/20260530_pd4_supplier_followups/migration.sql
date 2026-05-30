-- PD.4 — supplier follow-ups (additive: new table only).
CREATE TABLE "SupplierFollowUp" (
  "id" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "nextAction" TEXT,
  "dueDate" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "completedAt" TIMESTAMP(3),
  "byUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupplierFollowUp_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupplierFollowUp_supplierId_idx" ON "SupplierFollowUp"("supplierId");
CREATE INDEX "SupplierFollowUp_status_dueDate_idx" ON "SupplierFollowUp"("status", "dueDate");
ALTER TABLE "SupplierFollowUp" ADD CONSTRAINT "SupplierFollowUp_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
