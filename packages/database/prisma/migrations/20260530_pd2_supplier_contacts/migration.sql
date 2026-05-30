-- PD.2 — supplier contact persons (additive: new table only).
CREATE TABLE "SupplierContact" (
  "id" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "whatsapp" TEXT,
  "wechat" TEXT,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupplierContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupplierContact_supplierId_idx" ON "SupplierContact"("supplierId");
ALTER TABLE "SupplierContact" ADD CONSTRAINT "SupplierContact_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
