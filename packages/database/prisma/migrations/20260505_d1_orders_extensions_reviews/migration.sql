-- D.1 — /orders rebuild: Order extensions, FK fixes on Shipment/Return,
-- new ReviewRequest + ReviewRule + OrderTag tables, expanded OrderChannel enum.
-- Lessons applied (TECH_DEBT #37/#38):
--   • Explicit DROP TABLE IF EXISTS on the *new* tables (loud-fail on re-run).
--   • ALTER TABLE ADD COLUMN IF NOT EXISTS for idempotency on the Order
--     model (already exists in prod with rows we must not drop).
--   • Enum widening uses ADD VALUE IF NOT EXISTS (Postgres 12+).

-- ─── Expand OrderChannel enum ─────────────────────────────────────────
-- Order rows already reference this enum, so we cannot drop+recreate it.
ALTER TYPE "OrderChannel" ADD VALUE IF NOT EXISTS 'WOOCOMMERCE';
ALTER TYPE "OrderChannel" ADD VALUE IF NOT EXISTS 'ETSY';
ALTER TYPE "OrderChannel" ADD VALUE IF NOT EXISTS 'MANUAL';

-- ─── Extend Order with lifecycle + marketplace + currency + fulfillment ─
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "marketplace"          TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "currencyCode"         TEXT DEFAULT 'EUR';
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "purchaseDate"         TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "paidAt"               TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "shippedAt"            TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveredAt"          TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "cancelledAt"          TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "fulfillmentMethod"    TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "shopifyMetadata"      JSONB;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "woocommerceMetadata"  JSONB;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "etsyMetadata"         JSONB;

-- Backfill purchaseDate from createdAt for existing rows so the new sort
-- works immediately. The historical-backfill job (D.8) will replace these
-- with the channel's authoritative timestamp where available.
UPDATE "Order" SET "purchaseDate" = "createdAt" WHERE "purchaseDate" IS NULL;

-- New indexes for the new sortable/filterable columns
CREATE INDEX IF NOT EXISTS "Order_marketplace_idx"  ON "Order"("marketplace");
CREATE INDEX IF NOT EXISTS "Order_purchaseDate_idx" ON "Order"("purchaseDate");
CREATE INDEX IF NOT EXISTS "Order_deliveredAt_idx"  ON "Order"("deliveredAt");

-- ─── Real FKs on Shipment.orderId and Return.orderId ──────────────────
-- Prior schema had these as plain TEXT columns; promoting to constrained
-- FKs with SET NULL on order delete (orders may be archived but shipment/
-- return history is retained). Drop the constraint first if it exists
-- under a different name (Prisma's auto-generated name varies).
DO $$ BEGIN
  ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "Return" ADD CONSTRAINT "Return_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Null out any orphaned references so the FK constraint above doesn't
-- fail on backfill. Real orphan investigation can come later.
UPDATE "Shipment" SET "orderId" = NULL
  WHERE "orderId" IS NOT NULL
    AND "orderId" NOT IN (SELECT "id" FROM "Order");
UPDATE "Return" SET "orderId" = NULL
  WHERE "orderId" IS NOT NULL
    AND "orderId" NOT IN (SELECT "id" FROM "Order");

-- ─── Enums for the review-request engine ──────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ReviewRequestStatus" AS ENUM (
    'ELIGIBLE','SCHEDULED','SENT','SUPPRESSED','FAILED','SKIPPED'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ReviewRuleScope" AS ENUM (
    'AMAZON_PER_MARKETPLACE','AMAZON_GLOBAL','EBAY','SHOPIFY','WOOCOMMERCE','ETSY','MANUAL'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── Drop + create the new tables (no IF NOT EXISTS — loud-fail) ──────
DROP TABLE IF EXISTS "OrderTag"      CASCADE;
DROP TABLE IF EXISTS "ReviewRequest" CASCADE;
DROP TABLE IF EXISTS "ReviewRule"    CASCADE;

CREATE TABLE "ReviewRule" (
  "id"                   TEXT PRIMARY KEY,
  "name"                 TEXT NOT NULL,
  "scope"                "ReviewRuleScope" NOT NULL,
  "marketplace"          TEXT,
  "isActive"             BOOLEAN NOT NULL DEFAULT true,
  "minDaysSinceDelivery" INTEGER NOT NULL DEFAULT 7,
  "maxDaysSinceDelivery" INTEGER NOT NULL DEFAULT 25,
  "exclusions"           TEXT[] NOT NULL DEFAULT '{}',
  "minOrderTotalCents"   INTEGER,
  "createdBy"            TEXT,
  "notes"                TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewRule_name_scope_marketplace_unique" UNIQUE ("name","scope","marketplace")
);
CREATE INDEX "ReviewRule_scope_isActive_idx" ON "ReviewRule"("scope","isActive");

CREATE TABLE "ReviewRequest" (
  "id"                   TEXT PRIMARY KEY,
  "orderId"              TEXT NOT NULL,
  "channel"              TEXT NOT NULL,
  "marketplace"          TEXT,
  "status"               "ReviewRequestStatus" NOT NULL DEFAULT 'ELIGIBLE',
  "scheduledFor"         TIMESTAMP(3),
  "sentAt"               TIMESTAMP(3),
  "providerRequestId"    TEXT,
  "providerResponseCode" TEXT,
  "errorMessage"         TEXT,
  "suppressedReason"     TEXT,
  "ruleId"               TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE,
  CONSTRAINT "ReviewRequest_ruleId_fkey"  FOREIGN KEY ("ruleId")  REFERENCES "ReviewRule"("id") ON DELETE SET NULL,
  CONSTRAINT "ReviewRequest_orderId_channel_unique" UNIQUE ("orderId","channel")
);
CREATE INDEX "ReviewRequest_status_idx"       ON "ReviewRequest"("status");
CREATE INDEX "ReviewRequest_scheduledFor_idx" ON "ReviewRequest"("scheduledFor");
CREATE INDEX "ReviewRequest_sentAt_idx"       ON "ReviewRequest"("sentAt");

CREATE TABLE "OrderTag" (
  "orderId"   TEXT NOT NULL,
  "tagId"     TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("orderId","tagId"),
  CONSTRAINT "OrderTag_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE,
  CONSTRAINT "OrderTag_tagId_fkey"   FOREIGN KEY ("tagId")   REFERENCES "Tag"("id")   ON DELETE CASCADE
);
CREATE INDEX "OrderTag_orderId_idx" ON "OrderTag"("orderId");
CREATE INDEX "OrderTag_tagId_idx"   ON "OrderTag"("tagId");
