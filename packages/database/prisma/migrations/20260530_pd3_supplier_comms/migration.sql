-- PD.3 — supplier communication log (additive: new table only).
CREATE TABLE "SupplierComm" (
  "id" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "contactId" TEXT,
  "channel" TEXT NOT NULL,
  "direction" TEXT NOT NULL DEFAULT 'OUT',
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "byUserId" TEXT,
  "emailTo" TEXT,
  "emailOk" BOOLEAN,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupplierComm_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupplierComm_supplierId_createdAt_idx" ON "SupplierComm"("supplierId", "createdAt");
ALTER TABLE "SupplierComm" ADD CONSTRAINT "SupplierComm_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
