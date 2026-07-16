-- A7 — Amazon template vault (additive)
CREATE TABLE "AmazonTemplateVault" (
    "id" TEXT NOT NULL,
    "templateIdentifier" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "productTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "headerLanguageTag" TEXT,
    "filename" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonTemplateVault_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AmazonTemplateVault_templateIdentifier_key" ON "AmazonTemplateVault"("templateIdentifier");
CREATE INDEX "AmazonTemplateVault_marketplace_idx" ON "AmazonTemplateVault"("marketplace");
