-- Reviews Phase 3 (2026-10-27, Reviews area PR H, build spec B20) — what a review row is about.
--
--   Review.kind   'SELLER' = feedback about the seller (eBay feedback, Amazon's 1–3 star seller feedback report);
--                 'PRODUCT' = a product review. Amazon seller feedback is the first source that writes 'SELLER' on an
--                 Amazon row, so the channel alone no longer says what a row is.
--
-- Additive only: one nullable column and one index on an existing business-owned table (its row-level security already
-- covers new columns; no model-ownership change). Nothing is backfilled: a row with no kind reads by the old channel rule
-- (eBay = seller feedback, every other channel = product review; apps/api/src/services/reviews/review-visibility.ts), so
-- every current screen and job behaves exactly as before. A later contract step may backfill EBAY → 'SELLER'.
--
-- Rollback: DROP INDEX "Review_kind_channel_idx"; ALTER TABLE "Review" DROP COLUMN "kind";

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "kind" TEXT;

-- CreateIndex
CREATE INDEX "Review_kind_channel_idx" ON "Review"("kind", "channel");
