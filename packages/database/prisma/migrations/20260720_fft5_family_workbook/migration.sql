-- FFT.5a — per-(family, marketplace) filled Amazon workbook base (additive)
CREATE TABLE "AmazonFamilyWorkbook" (
    "id" TEXT NOT NULL,
    "familyKey" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "templateIdentifier" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonFamilyWorkbook_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AmazonFamilyWorkbook_familyKey_marketplace_key" ON "AmazonFamilyWorkbook"("familyKey", "marketplace");

CREATE INDEX "AmazonFamilyWorkbook_marketplace_idx" ON "AmazonFamilyWorkbook"("marketplace");
