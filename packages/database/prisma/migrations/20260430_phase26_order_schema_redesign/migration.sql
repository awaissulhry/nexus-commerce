-- Phase 26: Redesign Order/OrderItem tables for cross-channel order management
-- and add FinancialTransaction table.
--
-- The original Order table was Amazon-only (amazonOrderId, channelId FK).
-- Phase 26 replaces it with a channel-agnostic model supporting AMAZON/EBAY/SHOPIFY.
-- All dependent data (OrderItem, Return rows) is cleared — this is a dev/staging
-- environment populated only with mock orders from ingestMockOrders().

-- ── Step 1: Drop FKs that reference Order ───────────────────────────────────
-- OO.2 — wrapped each table operation in a IF-EXISTS guard so this
-- migration is idempotent on fresh dev DBs that never had the
-- legacy Return / OrderItem / Order tables. The structural DROP
-- TABLEs below already use IF EXISTS; this lifts the same guard up
-- to the constraint + truncate steps.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'OrderItem') THEN
    ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_orderId_fkey";
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'Return') THEN
    ALTER TABLE "Return" DROP CONSTRAINT IF EXISTS "Return_orderId_fkey";
  END IF;
END $$;

-- ── Step 2: Drop FKs on Order itself ───────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'Order') THEN
    ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_channelId_fkey";
  END IF;
END $$;

-- ── Step 3: Clear dependent rows (mock data only) ──────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'OrderItem') THEN
    TRUNCATE TABLE "OrderItem";
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'Return') THEN
    TRUNCATE TABLE "Return";
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'Order') THEN
    TRUNCATE TABLE "Order";
  END IF;
END $$;

-- ── Step 4: Drop the old Order and OrderItem tables ─────────────────────────
DROP TABLE IF EXISTS "OrderItem";
DROP TABLE IF EXISTS "Order";

-- ── Step 5: Create enums (not previously migrated) ─────────────────────────
DO $$ BEGIN
  CREATE TYPE "OrderChannel" AS ENUM ('AMAZON', 'EBAY', 'SHOPIFY');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'SHIPPED', 'CANCELLED', 'DELIVERED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ── Step 6: Recreate Order with Phase 26 schema ────────────────────────────
CREATE TABLE "Order" (
    "id"              TEXT NOT NULL,
    "channel"         "OrderChannel" NOT NULL,
    "channelOrderId"  TEXT NOT NULL,
    "status"          "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "totalPrice"      DECIMAL(12,2) NOT NULL,
    "customerName"    TEXT NOT NULL,
    "customerEmail"   TEXT NOT NULL,
    "shippingAddress" JSONB NOT NULL,
    "amazonMetadata"  JSONB,
    "ebayMetadata"    JSONB,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Order_channel_channelOrderId_key" ON "Order"("channel", "channelOrderId");
CREATE INDEX "Order_channel_idx"        ON "Order"("channel");
CREATE INDEX "Order_status_idx"         ON "Order"("status");
CREATE INDEX "Order_customerEmail_idx"  ON "Order"("customerEmail");
CREATE INDEX "Order_createdAt_idx"      ON "Order"("createdAt");

-- ── Step 7: Recreate OrderItem with Phase 26 schema ────────────────────────
CREATE TABLE "OrderItem" (
    "id"              TEXT NOT NULL,
    "orderId"         TEXT NOT NULL,
    "productId"       TEXT,
    "sku"             TEXT NOT NULL,
    "quantity"        INTEGER NOT NULL,
    "price"           DECIMAL(10,2) NOT NULL,
    "amazonMetadata"  JSONB,
    "ebayMetadata"    JSONB,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderItem_orderId_idx"    ON "OrderItem"("orderId");
CREATE INDEX "OrderItem_productId_idx"  ON "OrderItem"("productId");
CREATE INDEX "OrderItem_sku_idx"        ON "OrderItem"("sku");

-- ── Step 8: Create FinancialTransaction table ───────────────────────────────
CREATE TABLE "FinancialTransaction" (
    "id"                   TEXT NOT NULL,
    "amazonTransactionId"  TEXT,
    "ebayTransactionId"    TEXT,
    "orderId"              TEXT NOT NULL,
    "transactionType"      TEXT NOT NULL,
    "transactionDate"      TIMESTAMP(3) NOT NULL,
    "amount"               DECIMAL(12,2) NOT NULL,
    "currencyCode"         TEXT NOT NULL DEFAULT 'USD',
    "amazonFee"            DECIMAL(10,2) NOT NULL DEFAULT 0,
    "fbaFee"               DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paymentServicesFee"   DECIMAL(10,2) NOT NULL DEFAULT 0,
    "ebayFee"              DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paypalFee"            DECIMAL(10,2) NOT NULL DEFAULT 0,
    "otherFees"            DECIMAL(10,2) NOT NULL DEFAULT 0,
    "grossRevenue"         DECIMAL(12,2) NOT NULL,
    "netRevenue"           DECIMAL(12,2) NOT NULL,
    "status"               TEXT NOT NULL,
    "amazonMetadata"       JSONB,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialTransaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FinancialTransaction_orderId_idx"         ON "FinancialTransaction"("orderId");
CREATE INDEX "FinancialTransaction_transactionType_idx" ON "FinancialTransaction"("transactionType");
CREATE INDEX "FinancialTransaction_transactionDate_idx" ON "FinancialTransaction"("transactionDate");
CREATE INDEX "FinancialTransaction_status_idx"          ON "FinancialTransaction"("status");

-- ── Step 9: Foreign keys ────────────────────────────────────────────────────
ALTER TABLE "OrderItem"
    ADD CONSTRAINT "OrderItem_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderItem"
    ADD CONSTRAINT "OrderItem_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FinancialTransaction"
    ADD CONSTRAINT "FinancialTransaction_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Return.orderId FK is intentionally NOT recreated — the Return model was
-- removed from schema.prisma in a later refactor; the table remains in the DB
-- as an orphaned legacy table with no active FK constraint on Order.
