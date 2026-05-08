-- O.20 — Customer model. Closes the audit's biggest schema gap:
-- pre-O.20 there was no Customer table, customer info was denormalized
-- on Order (customerName + customerEmail + shippingAddress JSON).
-- That made repeat-customer detection, LTV calculations, customer-
-- side notes/tags/risk all impossible without ad-hoc GROUP BY at
-- query time.
--
-- This migration:
--   1. Creates Customer + CustomerAddress + CustomerNote tables
--   2. Backfills Customer rows from existing Order.customerEmail
--      (canonical identity = lower(email); de-duped across channels)
--   3. Adds Order.customerId FK; backfills the FK on every existing
--      row that has a non-empty customerEmail
--   4. Preserves Order.customerEmail + customerName as denormalized
--      cache (downstream consumers that already read these don't
--      break; new code reads through the relation)
--
-- Cache columns on Customer (totalOrders, totalSpentCents,
-- firstOrderAt, lastOrderAt) are populated at backfill time. A
-- follow-up commit (O.20.1 or via app code) will keep them fresh
-- on order ingestion / cancellation / refund. For now they are a
-- one-shot snapshot — the at-rest backfill values match the
-- aggregate the audit computed for the engagement.

-- ── Customer ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Customer" (
  "id"               TEXT        NOT NULL,
  "email"            TEXT        NOT NULL,
  "name"             TEXT,

  -- Aggregate cache. Refreshed on order ingestion / cancellation /
  -- refund (subsequent commits wire the writers). Backfilled here.
  "totalOrders"       INTEGER     NOT NULL DEFAULT 0,
  "totalSpentCents"   BIGINT      NOT NULL DEFAULT 0,
  "firstOrderAt"      TIMESTAMP(3),
  "lastOrderAt"       TIMESTAMP(3),

  -- Per-channel order counts as { AMAZON: 5, EBAY: 2, ... }. Useful
  -- for "this Amazon-only customer just placed their first eBay
  -- order" type signals without joining Order at every read.
  "channelOrderCounts" JSONB,

  -- Operator surface (O.21 /customers detail page consumers).
  "tags"             TEXT[]     DEFAULT ARRAY[]::TEXT[],
  -- O.22 risk engine populates these. NULL = unscored.
  "riskFlag"         TEXT,
  "manualReviewState" TEXT,

  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Customer_email_key" ON "Customer"("email");
CREATE INDEX IF NOT EXISTS "Customer_lastOrderAt_idx" ON "Customer"("lastOrderAt");
CREATE INDEX IF NOT EXISTS "Customer_totalSpentCents_idx" ON "Customer"("totalSpentCents");
CREATE INDEX IF NOT EXISTS "Customer_riskFlag_idx" ON "Customer"("riskFlag");

-- ── CustomerAddress ──────────────────────────────────────────────────
-- Multi-address per customer. type='SHIPPING' | 'BILLING' | 'BOTH'.
-- isPrimary picks the default for new orders / mailings.
CREATE TABLE IF NOT EXISTS "CustomerAddress" (
  "id"             TEXT         NOT NULL,
  "customerId"     TEXT         NOT NULL,
  "type"           TEXT         NOT NULL,
  "isPrimary"      BOOLEAN      NOT NULL DEFAULT false,

  "recipient"      TEXT,
  "line1"          TEXT         NOT NULL,
  "line2"          TEXT,
  "city"           TEXT         NOT NULL,
  "state"          TEXT,
  "postalCode"     TEXT         NOT NULL,
  "country"        TEXT         NOT NULL,
  "phone"          TEXT,

  -- Source attribution: which channel/order seeded this row.
  "source"         TEXT,
  "channelOrderId" TEXT,

  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CustomerAddress_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerAddress_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "CustomerAddress_customerId_idx" ON "CustomerAddress"("customerId");
CREATE INDEX IF NOT EXISTS "CustomerAddress_country_idx" ON "CustomerAddress"("country");

-- ── CustomerNote ─────────────────────────────────────────────────────
-- Operator-scoped notes pinned to a customer (not an order). Used by
-- the O.21 customer-detail page. Distinct from OrderNote (per-order)
-- which doesn't exist yet but would land alongside O.21 if needed.
CREATE TABLE IF NOT EXISTS "CustomerNote" (
  "id"           TEXT         NOT NULL,
  "customerId"   TEXT         NOT NULL,
  "body"         TEXT         NOT NULL,
  "authorUserId" TEXT,
  "authorEmail"  TEXT,
  "pinned"       BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CustomerNote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerNote_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "CustomerNote_customerId_idx" ON "CustomerNote"("customerId");
CREATE INDEX IF NOT EXISTS "CustomerNote_createdAt_idx" ON "CustomerNote"("createdAt");

-- ── Backfill Customer from existing Order rows ───────────────────────
-- Canonical identity: lower(customerEmail). De-dupes the same email
-- written under different cases ("Awa@Example.IT" + "awa@example.it"
-- collapse to one Customer). Name picks MIN() arbitrarily when names
-- diverge across orders — operators can edit later.
--
-- ID format: 'cust_' + first 24 chars of md5(lower(email)). Stable +
-- deterministic so re-runs produce the same id and the FK backfill
-- below stays consistent.
INSERT INTO "Customer" (
  "id", "email", "name",
  "totalOrders", "totalSpentCents",
  "firstOrderAt", "lastOrderAt",
  "channelOrderCounts",
  "createdAt", "updatedAt"
)
SELECT
  ('cust_' || substring(md5(lower("customerEmail")), 1, 24)) AS id,
  lower("customerEmail") AS email,
  MIN("customerName") AS name,
  count(*)::int AS totalOrders,
  COALESCE(SUM((round("totalPrice"::numeric * 100))::bigint), 0) AS totalSpentCents,
  MIN(COALESCE("purchaseDate", "createdAt")) AS firstOrderAt,
  MAX(COALESCE("purchaseDate", "createdAt")) AS lastOrderAt,
  jsonb_object_agg(channel::text, channel_count) AS channelOrderCounts,
  MIN("createdAt") AS createdAt,
  MAX("updatedAt") AS updatedAt
FROM (
  SELECT
    "customerEmail",
    "customerName",
    "totalPrice",
    "purchaseDate",
    "createdAt",
    "updatedAt",
    channel,
    count(*) OVER (PARTITION BY lower("customerEmail"), channel) AS channel_count
  FROM "Order"
  WHERE "customerEmail" IS NOT NULL AND "customerEmail" <> ''
) src
GROUP BY lower("customerEmail")
ON CONFLICT ("email") DO NOTHING;

-- ── Order.customerId FK + backfill ───────────────────────────────────
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "customerId" TEXT;

-- Backfill Order.customerId from the deterministic id format. Matches
-- the INSERT above so every Order row with a non-empty customerEmail
-- now points at a real Customer.
UPDATE "Order"
   SET "customerId" = ('cust_' || substring(md5(lower("customerEmail")), 1, 24))
 WHERE "customerEmail" IS NOT NULL
   AND "customerEmail" <> ''
   AND "customerId" IS NULL;

-- Add the FK constraint after the backfill so we don't reject existing
-- rows that lack a customer (legacy / test data).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Order_customerId_fkey'
  ) THEN
    ALTER TABLE "Order"
      ADD CONSTRAINT "Order_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Order_customerId_idx" ON "Order"("customerId");
