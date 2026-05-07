-- R0.1 — Returns rebuild foundation.
--
-- Adds the normalized Refund domain (Refund + RefundAttempt) so each
-- refund attempt against a Return is its own row with full channel-
-- API audit; introduces ReturnPolicy for EU consumer-law enforcement
-- (14-day window, 14-day refund deadline), restocking-fee math, auto-
-- approval rules, and high-value alerts; drops the unused legacy
-- ReturnStatus enum (Return.status uses ReturnStatusFlow).
--
-- Existing Return.refundCents / refundStatus / channelRefundId /
-- channelRefundError / channelRefundedAt are retained as a write-
-- through projection of the latest POSTED Refund so list/drawer
-- queries stay one-shot. R5.1 cuts the read path over to Refund[]
-- and starts populating the cache from Refund writes.
--
-- All adds are idempotent (CREATE TABLE / CREATE TYPE IF NOT EXISTS,
-- ADD COLUMN IF NOT EXISTS) — pattern matches CR.3 and O.36. The drop
-- of ReturnStatus is guarded by IF EXISTS so a re-run is safe.
--
-- Seed: three default ReturnPolicy rows (AMAZON, EBAY, SHOPIFY) with
-- EU defaults so any incoming return resolves a policy out of the
-- box. Per active-channel scope, Woo + Etsy are excluded.

-- ── 1. Drop dead enum ────────────────────────────────────────────────
-- ReturnStatus (line 15 of schema, separate from ReturnStatusFlow at
-- line 2507). Was never wired to any model column.
DROP TYPE IF EXISTS "ReturnStatus";

-- ── 2. New enums ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "RefundKind" AS ENUM ('CASH', 'STORE_CREDIT', 'EXCHANGE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "RefundChannelStatus" AS ENUM (
    'PENDING', 'POSTED', 'FAILED', 'MANUAL_REQUIRED', 'NOT_IMPLEMENTED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. Refund table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Refund" (
  "id"              TEXT PRIMARY KEY,
  "returnId"        TEXT NOT NULL,
  "amountCents"     INTEGER NOT NULL,
  "currencyCode"    TEXT NOT NULL DEFAULT 'EUR',
  "perLineAmounts"  JSONB,
  "kind"            "RefundKind" NOT NULL DEFAULT 'CASH',
  "reason"          TEXT,
  "channel"         TEXT NOT NULL,
  "channelRefundId" TEXT,
  "channelStatus"   "RefundChannelStatus" NOT NULL DEFAULT 'PENDING',
  "channelError"    TEXT,
  "channelPostedAt" TIMESTAMP(3),
  "actor"           TEXT,
  "notes"           TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Refund_returnId_fkey"
    FOREIGN KEY ("returnId") REFERENCES "Return"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "Refund_returnId_idx"        ON "Refund" ("returnId");
CREATE INDEX IF NOT EXISTS "Refund_channelRefundId_idx" ON "Refund" ("channelRefundId");
CREATE INDEX IF NOT EXISTS "Refund_channelStatus_idx"   ON "Refund" ("channelStatus");
CREATE INDEX IF NOT EXISTS "Refund_channel_idx"         ON "Refund" ("channel");

-- ── 4. RefundAttempt table ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RefundAttempt" (
  "id"              TEXT PRIMARY KEY,
  "refundId"        TEXT NOT NULL,
  "attemptedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "outcome"         TEXT NOT NULL,
  "channelRefundId" TEXT,
  "errorMessage"    TEXT,
  "rawRequest"      JSONB,
  "rawResponse"     JSONB,
  "durationMs"      INTEGER,

  CONSTRAINT "RefundAttempt_refundId_fkey"
    FOREIGN KEY ("refundId") REFERENCES "Refund"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "RefundAttempt_refundId_idx"    ON "RefundAttempt" ("refundId");
CREATE INDEX IF NOT EXISTS "RefundAttempt_attemptedAt_idx" ON "RefundAttempt" ("attemptedAt");

-- ── 5. ReturnPolicy table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ReturnPolicy" (
  "id"                      TEXT PRIMARY KEY,
  "channel"                 TEXT NOT NULL,
  "marketplace"             TEXT,
  "productType"             TEXT,
  "windowDays"              INTEGER NOT NULL DEFAULT 14,
  "refundDeadlineDays"      INTEGER NOT NULL DEFAULT 14,
  "buyerPaysReturn"         BOOLEAN NOT NULL DEFAULT FALSE,
  "restockingFeePct"        DECIMAL(5, 2),
  "autoApprove"             BOOLEAN NOT NULL DEFAULT FALSE,
  "highValueThresholdCents" INTEGER,
  "isActive"                BOOLEAN NOT NULL DEFAULT TRUE,
  "notes"                   TEXT,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One active policy per (channel, marketplace, productType). Nulls
-- on marketplace/productType act as wildcards; the resolver layer
-- picks the most-specific match. Postgres treats NULL as distinct in
-- UNIQUE, so the scoped index needs COALESCE for safe deduplication.
CREATE UNIQUE INDEX IF NOT EXISTS "ReturnPolicy_scope_uniq"
  ON "ReturnPolicy" (
    "channel",
    COALESCE("marketplace", '__NULL__'),
    COALESCE("productType", '__NULL__')
  );

CREATE INDEX IF NOT EXISTS "ReturnPolicy_channel_idx"  ON "ReturnPolicy" ("channel");
CREATE INDEX IF NOT EXISTS "ReturnPolicy_isActive_idx" ON "ReturnPolicy" ("isActive");

-- ── 6. Seed default policies (active-channel scope only) ─────────────
-- EU Consumer Rights Directive baseline: 14-day request window from
-- delivery + 14-day refund deadline from receipt of returned goods.
-- buyerPaysReturn defaults FALSE (we eat the cost) — operator can
-- override per channel/marketplace once volume justifies the policy
-- split. Idempotent via the scope unique index.
INSERT INTO "ReturnPolicy"
  ("id", "channel", "marketplace", "productType", "windowDays", "refundDeadlineDays", "buyerPaysReturn", "isActive", "notes")
VALUES
  ('seed_amazon_default',  'AMAZON',  NULL, NULL, 14, 14, FALSE, TRUE, 'EU default; Amazon enforces channel policy independently'),
  ('seed_ebay_default',    'EBAY',    NULL, NULL, 14, 14, FALSE, TRUE, 'EU default; eBay Money Back Guarantee is in addition'),
  ('seed_shopify_default', 'SHOPIFY', NULL, NULL, 14, 14, FALSE, TRUE, 'EU default; Shopify DTC — we are the seller of record')
ON CONFLICT DO NOTHING;
