-- Phase 5: BulkOperation audit log table
CREATE TABLE IF NOT EXISTS "BulkOperation" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "productCount" INTEGER NOT NULL,
    "changeCount" INTEGER NOT NULL,
    "changes" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "errors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BulkOperation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BulkOperation_createdAt_idx" ON "BulkOperation" ("createdAt");
CREATE INDEX IF NOT EXISTS "BulkOperation_userId_idx" ON "BulkOperation" ("userId");
CREATE INDEX IF NOT EXISTS "BulkOperation_status_idx" ON "BulkOperation" ("status");
