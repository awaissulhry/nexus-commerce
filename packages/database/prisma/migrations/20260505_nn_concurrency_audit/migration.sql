-- NN.1 — optimistic concurrency on Product, ChannelListing, ListingWizard.
-- NN.4 — append-only AuditLog table.
-- NN.14 — expiresAt column on ListingWizard for the cleanup cron.

-- 1) version columns. Default 1 so existing rows start at v1; new
-- writes bump to 2 the first time they're updated. Non-null so
-- application code can rely on it without coalescing.

ALTER TABLE "Product" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ChannelListing" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ListingWizard" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- 2) ListingWizard.expiresAt for the cleanup cron (NN.14). Nullable
-- so existing rows aren't auto-purged; cron only targets DRAFT rows
-- whose expiresAt < NOW(). New rows set this at create time.

ALTER TABLE "ListingWizard" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE INDEX "ListingWizard_expiresAt_idx" ON "ListingWizard"("expiresAt");

-- 3) AuditLog table.

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "ip" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
