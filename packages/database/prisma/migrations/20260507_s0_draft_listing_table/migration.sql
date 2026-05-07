-- S.0 / C-1 — Create the DraftListing table.
--
-- The model has lived in schema.prisma since Phase 5 but the migration
-- was never written. The /listings/generate page calls
-- `prisma.draftListing.create(...)` via ai-listing.service.ts and
-- crashes at runtime with `relation "DraftListing" does not exist`.
-- Phase 1 audit caught it; this migration fixes it.
--
-- Verified against the broader prisma migrate diff: this is the only
-- change that needs to ship in S.0. Other column-level drift between
-- schema.prisma and the live DB is intentionally NOT addressed here —
-- see TECH_DEBT #37 (column-level drift detection) for that work.

-- CreateTable
CREATE TABLE "DraftListing" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "ebayTitle" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "itemSpecifics" JSONB NOT NULL,
    "htmlDescription" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DraftListing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DraftListing_productId_idx" ON "DraftListing"("productId");

-- CreateIndex
CREATE INDEX "DraftListing_status_idx" ON "DraftListing"("status");

-- CreateIndex
CREATE INDEX "DraftListing_createdAt_idx" ON "DraftListing"("createdAt");

-- AddForeignKey
ALTER TABLE "DraftListing" ADD CONSTRAINT "DraftListing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
