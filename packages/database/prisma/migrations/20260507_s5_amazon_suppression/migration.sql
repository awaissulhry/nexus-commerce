-- S.5 — Create the AmazonSuppression episode-shaped audit table.
--
-- One row per suppression event (suppressedAt → resolvedAt span).
-- resolvedAt = null means the listing is currently suppressed; the
-- Amazon deep view's resolver panel queries on that exact predicate.
--
-- This is a pure additive migration — column-level drift between
-- schema.prisma and the live DB (TECH_DEBT #37) is intentionally
-- NOT addressed here.

-- CreateTable
CREATE TABLE "AmazonSuppression" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "suppressedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "reasonCode" TEXT,
    "reasonText" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AmazonSuppression_listingId_suppressedAt_idx" ON "AmazonSuppression"("listingId", "suppressedAt");

-- CreateIndex
CREATE INDEX "AmazonSuppression_resolvedAt_idx" ON "AmazonSuppression"("resolvedAt");

-- AddForeignKey
ALTER TABLE "AmazonSuppression" ADD CONSTRAINT "AmazonSuppression_listingId_fkey"
    FOREIGN KEY ("listingId") REFERENCES "ChannelListing"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
