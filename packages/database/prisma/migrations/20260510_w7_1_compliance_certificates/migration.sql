-- W7.1: EU compliance — PPE category + hazmat flags on Product,
--        plus new ProductCertificate table for CE/EN-13595/REACH/RoHS etc.

-- Extend Product with compliance columns
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "ppeCategory"    TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "hazmatClass"    TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "hazmatUnNumber" TEXT;

-- Certificate table
CREATE TABLE IF NOT EXISTS "ProductCertificate" (
  "id"          TEXT        NOT NULL,
  "productId"   TEXT        NOT NULL,
  "certType"    TEXT        NOT NULL,
  "certNumber"  TEXT,
  "standard"    TEXT,
  "issuingBody" TEXT,
  "issuedAt"    TIMESTAMP(3),
  "expiresAt"   TIMESTAMP(3),
  "fileUrl"     TEXT,
  "notes"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductCertificate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProductCertificate_productId_idx"
  ON "ProductCertificate"("productId");

CREATE INDEX IF NOT EXISTS "ProductCertificate_productId_certType_idx"
  ON "ProductCertificate"("productId", "certType");

CREATE INDEX IF NOT EXISTS "ProductCertificate_expiresAt_idx"
  ON "ProductCertificate"("expiresAt");

ALTER TABLE "ProductCertificate"
  ADD CONSTRAINT "ProductCertificate_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
