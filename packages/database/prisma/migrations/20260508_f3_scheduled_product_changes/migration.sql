-- F.3 — scheduled product changes.
--
-- Defer a Product mutation (status flip, price change) to a future
-- timestamp. A cron worker (`scheduled-changes.cron.ts`) picks up
-- PENDING rows where scheduledFor <= now() and applies them.
--
-- See model docblock in schema.prisma for the lifecycle + payload
-- contract.

CREATE TABLE "ScheduledProductChange" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "appliedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledProductChange_pkey" PRIMARY KEY ("id")
);

-- Cron picker — most selective filter is (status, scheduledFor) so
-- the worker scans PENDING in time order without a Seq Scan.
CREATE INDEX "ScheduledProductChange_status_scheduledFor_idx"
    ON "ScheduledProductChange"("status", "scheduledFor");

-- Drawer / list view per product — one query for "what's queued".
CREATE INDEX "ScheduledProductChange_productId_status_idx"
    ON "ScheduledProductChange"("productId", "status");

-- ON DELETE CASCADE so soft-deleting / hard-purging a Product cleans
-- up its scheduled changes. The Prisma side's `onDelete: Cascade`
-- on the relation drives this.
ALTER TABLE "ScheduledProductChange"
    ADD CONSTRAINT "ScheduledProductChange_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
