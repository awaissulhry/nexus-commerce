CREATE TABLE "AmazonMediaRun" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "listingId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,
  "revision" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REVIEW',
  "plan" JSONB NOT NULL,
  "receipts" JSONB NOT NULL,
  "actorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmazonMediaRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AmazonMediaRun_listingId_createdAt_idx" ON "AmazonMediaRun"("listingId", "createdAt");
CREATE INDEX "AmazonMediaRun_status_updatedAt_idx" ON "AmazonMediaRun"("status", "updatedAt");
