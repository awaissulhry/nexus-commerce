-- RX.4 — AI Voice-of-Customer brief storage. Additive: one new table,
-- no changes to existing tables.

-- CreateTable
CREATE TABLE "ReviewSpotlight" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "marketplace" TEXT,
    "windowDays" INTEGER NOT NULL DEFAULT 30,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "headline" TEXT,
    "content" JSONB NOT NULL,
    "model" TEXT,
    "usedAi" BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewSpotlight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewSpotlight_productId_generatedAt_idx" ON "ReviewSpotlight"("productId", "generatedAt");

-- CreateIndex
CREATE INDEX "ReviewSpotlight_generatedAt_idx" ON "ReviewSpotlight"("generatedAt");
