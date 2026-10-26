-- Reviews Inbox (2026-10-26, Reviews area PR B, build spec B3) — the fields the one Inbox for product reviews and seller
-- feedback reads and writes.
--
--   Review.orderId          the Nexus order a review or feedback is about (eBay feedback: matched from its order line
--                           at ingest). A plain id, no foreign key.
--   Review.language         ISO 639-1 code of the review text ('de'), from the sentiment call or a translate.
--   Review.bodyEnglish      the review text in English; null when it is English or not translated yet.
--   Review.importBatchId    the file import that created the row, so "Undo this import" removes exactly that batch.
--   ReviewSentiment.editedBy / editedAt   a person changed the mood or themes; a later AI re-read keeps their choice.
--
-- Additive only: nullable columns and two indexes on existing business-owned tables (their row-level security already
-- covers new columns; no model-ownership change). Nothing is backfilled; with the columns empty every current screen
-- and job behaves exactly as before.
--
-- Rollback: DROP INDEX "Review_orderId_idx"; DROP INDEX "Review_importBatchId_idx";
--           ALTER TABLE "Review" DROP COLUMN "orderId", DROP COLUMN "language", DROP COLUMN "bodyEnglish", DROP COLUMN "importBatchId";
--           ALTER TABLE "ReviewSentiment" DROP COLUMN "editedBy", DROP COLUMN "editedAt";

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "bodyEnglish" TEXT,
ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "language" TEXT,
ADD COLUMN     "orderId" TEXT;

-- AlterTable
ALTER TABLE "ReviewSentiment" ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "editedBy" TEXT;

-- CreateIndex
CREATE INDEX "Review_orderId_idx" ON "Review"("orderId");

-- CreateIndex
CREATE INDEX "Review_importBatchId_idx" ON "Review"("importBatchId");
