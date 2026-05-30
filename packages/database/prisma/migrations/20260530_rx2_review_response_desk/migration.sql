-- RX.2 — Review Response Desk. Additive + online-safe: new columns on
-- Review (all nullable / defaulted) + a new ReviewResponse table. No
-- rewrite of existing rows; triageStatus null is treated as NEW by the app.

-- AlterTable
ALTER TABLE "Review" ADD COLUMN "triageStatus" TEXT;
ALTER TABLE "Review" ADD COLUMN "assignee" TEXT;
ALTER TABLE "Review" ADD COLUMN "triageTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Review" ADD COLUMN "triageNote" TEXT;
ALTER TABLE "Review" ADD COLUMN "triageUpdatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Review_triageStatus_idx" ON "Review"("triageStatus");
CREATE INDEX "Review_assignee_idx" ON "Review"("assignee");

-- CreateTable
CREATE TABLE "ReviewResponse" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "locale" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "isAiDrafted" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "createdBy" TEXT,
    "providerResponseCode" TEXT,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewResponse_reviewId_idx" ON "ReviewResponse"("reviewId");

-- CreateIndex
CREATE INDEX "ReviewResponse_status_idx" ON "ReviewResponse"("status");

-- AddForeignKey
ALTER TABLE "ReviewResponse" ADD CONSTRAINT "ReviewResponse_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;
