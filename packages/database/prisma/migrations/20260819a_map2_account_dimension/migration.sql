-- MAP.2 — the account dimension.
--
-- Approved by the operator 2026-08-19 as a NON-ADDITIVE migration (it drops unique
-- indexes), conditional on a row-count-exact backfill verified BEFORE the old keys
-- drop. That verification is not a checklist item here — it is §4 below, a DO block
-- that RAISES and aborts the whole transaction if a single row is unattributed.
--
-- Measured on prod immediately before writing this (`_map2-premeasure.mts`):
--   ChannelConnection         11 rows,  2 active (AMAZON env, EBAY oauth), 9 revoked
--   ChannelListing           977 rows  (AMAZON 725, EBAY 252)
--   SharedListingMembership  712 rows  (eBay Shared-SKU by definition)
--   Order                   4393 rows  (AMAZON 4389, EBAY 4)
--   VariantChannelListing      0 rows  (already carries channelConnectionId)
--   SyncChannelPolicy          0 rows
--
-- Every statement is idempotent (IF [NOT] EXISTS). A half-applied migration that
-- cannot be re-run is how P3009 takes the whole service down
-- (reference_prisma_migration_p3009_blocks_deploys), and this one both adds columns
-- and reshapes indexes, so it is the exact shape that trap likes.
--
-- ⚠ SCOPE: this is MAP.2a. It does NOT widen the ChannelListing /
--   VariantChannelListing / SyncChannelPolicy unique keys, although the plan grouped
--   them here. Measured, not assumed: Prisma compiles a compound-unique `upsert` to
--   `INSERT ... ON CONFLICT (<those exact columns>)` — verified on prod inside a
--   rolled-back transaction. `ON CONFLICT` requires an index matching the named
--   columns exactly, and the replacement is an EXPRESSION index (COALESCE), which
--   cannot match. So dropping those keys now would not fail at compile time — it
--   would fail at RUNTIME with 42P10 on all 24 call sites that use them
--   (17 × productId_channel_marketplace, 2 × productId_channelMarket,
--    1 × variantId_channel_marketplace, 4 × channel_marketplace).
--
--   Those keys therefore widen in MAP.2b, in the same commit as MAP.3's caller
--   conversion, so the Prisma schema and the database never disagree about what is
--   unique. Nothing is lost by waiting: a second account cannot exist until MAP.4.
--
--   ChannelConnection's own index (§6) has no such exposure — the model declares no
--   `@@unique` at all (the partial index lives in raw SQL only) and nothing upserts
--   it, which is why `seedEnvManagedConnections` hand-rolls find-then-write.
--
-- Rollback: rollback.sql beside this file.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ChannelConnection gains account identity
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "accountLabel"      TEXT;
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "accountColor"      TEXT;
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "isPrimary"         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "sortOrder"         INTEGER NOT NULL DEFAULT 0;
-- The account's identity AT the marketplace: Amazon merchant id, eBay sign-in name,
-- Shopify shop domain. Nullable because eBay's current OAuth scope returns no
-- identity at all — ebay-auth.service.ts:451 writes the literal
-- "eBay seller (verified)" — so MAP.4 has to add the identity scope before a second
-- eBay account can be told apart from the first. See §6a for why that matters.
ALTER TABLE "ChannelConnection" ADD COLUMN IF NOT EXISTS "externalAccountId" TEXT;

-- The existing single connection per channel is that channel's primary.
UPDATE "ChannelConnection" c SET "isPrimary" = true
WHERE c."isActive" = true
  AND NOT EXISTS (
    SELECT 1 FROM "ChannelConnection" o
    WHERE o."channelType" = c."channelType" AND o."isPrimary" = true AND o.id <> c.id
  );

-- Amazon's identity is already held: displayName is the merchant id (A1VRHKTGYO1JNU).
-- eBay's displayName is a placeholder, not an identity, so it is deliberately NOT
-- backfilled — an identity we cannot trust is worse than none.
UPDATE "ChannelConnection" SET "externalAccountId" = "displayName"
WHERE "channelType" = 'AMAZON' AND "displayName" IS NOT NULL AND "externalAccountId" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The attribution column on everything an account can own
--    (VariantChannelListing already has it, with its index and FK.)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "ChannelListing"          ADD COLUMN IF NOT EXISTS "channelConnectionId" TEXT;
ALTER TABLE "SharedListingMembership" ADD COLUMN IF NOT EXISTS "channelConnectionId" TEXT;
ALTER TABLE "Order"                   ADD COLUMN IF NOT EXISTS "channelConnectionId" TEXT;
ALTER TABLE "SyncChannelPolicy"       ADD COLUMN IF NOT EXISTS "channelConnectionId" TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Backfill — resolved from the data, never from a hard-coded id
--
--    Runs BEFORE the singleton index is dropped in §6, so
--    "the active connection for this channel" is still guaranteed to be exactly one
--    row. That ordering is what makes the subquery deterministic rather than a guess.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE "ChannelListing" t SET "channelConnectionId" = (
  SELECT c.id FROM "ChannelConnection" c
  WHERE c."channelType" = t.channel AND c."isActive" = true
  ORDER BY c."updatedAt" DESC LIMIT 1
) WHERE t."channelConnectionId" IS NULL;

UPDATE "VariantChannelListing" t SET "channelConnectionId" = (
  SELECT c.id FROM "ChannelConnection" c
  WHERE c."channelType" = t.channel AND c."isActive" = true
  ORDER BY c."updatedAt" DESC LIMIT 1
) WHERE t."channelConnectionId" IS NULL AND t.channel IS NOT NULL;

-- SharedListingMembership is the eBay Shared-SKU / Trading-API pool: it has no
-- channel column because every row is eBay by construction.
UPDATE "SharedListingMembership" t SET "channelConnectionId" = (
  SELECT c.id FROM "ChannelConnection" c
  WHERE c."channelType" = 'EBAY' AND c."isActive" = true
  ORDER BY c."updatedAt" DESC LIMIT 1
) WHERE t."channelConnectionId" IS NULL;

-- Order.channel is the OrderChannel enum; MANUAL has no marketplace connection and
-- is correctly left NULL.
UPDATE "Order" t SET "channelConnectionId" = (
  SELECT c.id FROM "ChannelConnection" c
  WHERE c."channelType" = t.channel::text AND c."isActive" = true
  ORDER BY c."updatedAt" DESC LIMIT 1
) WHERE t."channelConnectionId" IS NULL;

UPDATE "SyncChannelPolicy" t SET "channelConnectionId" = (
  SELECT c.id FROM "ChannelConnection" c
  WHERE c."channelType" = t.channel AND c."isActive" = true
  ORDER BY c."updatedAt" DESC LIMIT 1
) WHERE t."channelConnectionId" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE GATE — the backfill is proven exact, or nothing here happens at all
--
--    A row may only still be NULL if there is genuinely no active connection for its
--    channel to attribute it to (an Order on MANUAL, a listing on a channel nobody
--    has connected). Any row that COULD have been attributed and was not aborts the
--    transaction, so the §6 index drops can never run against a partial backfill.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  missed  BIGINT;
  detail  TEXT;
BEGIN
  SELECT count(*), string_agg(DISTINCT src, ', ')
    INTO missed, detail
  FROM (
    SELECT 'ChannelListing' AS src FROM "ChannelListing" t
      WHERE t."channelConnectionId" IS NULL
        AND EXISTS (SELECT 1 FROM "ChannelConnection" c WHERE c."channelType" = t.channel AND c."isActive")
    UNION ALL
    SELECT 'VariantChannelListing' FROM "VariantChannelListing" t
      WHERE t."channelConnectionId" IS NULL AND t.channel IS NOT NULL
        AND EXISTS (SELECT 1 FROM "ChannelConnection" c WHERE c."channelType" = t.channel AND c."isActive")
    UNION ALL
    SELECT 'SharedListingMembership' FROM "SharedListingMembership" t
      WHERE t."channelConnectionId" IS NULL
        AND EXISTS (SELECT 1 FROM "ChannelConnection" c WHERE c."channelType" = 'EBAY' AND c."isActive")
    UNION ALL
    SELECT 'Order' FROM "Order" t
      WHERE t."channelConnectionId" IS NULL
        AND EXISTS (SELECT 1 FROM "ChannelConnection" c WHERE c."channelType" = t.channel::text AND c."isActive")
    UNION ALL
    SELECT 'SyncChannelPolicy' FROM "SyncChannelPolicy" t
      WHERE t."channelConnectionId" IS NULL
        AND EXISTS (SELECT 1 FROM "ChannelConnection" c WHERE c."channelType" = t.channel AND c."isActive")
  ) q;

  IF missed > 0 THEN
    RAISE EXCEPTION
      'MAP.2 backfill incomplete: % attributable row(s) left unattributed in [%]. Old unique keys NOT dropped.',
      missed, detail;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Foreign keys and indexes on the new column
--
--    ON DELETE SET NULL, deliberately. VariantChannelListing's pre-existing FK
--    CASCADEs, which is survivable for a projection but would be catastrophic here:
--    deleting a ChannelConnection row must never delete 977 listings or 4,393
--    ORDERS. Disconnecting an account loses its attribution, not its history.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "ChannelListing_channelConnectionId_idx"          ON "ChannelListing"          ("channelConnectionId");
CREATE INDEX IF NOT EXISTS "SharedListingMembership_channelConnectionId_idx" ON "SharedListingMembership" ("channelConnectionId");
CREATE INDEX IF NOT EXISTS "Order_channelConnectionId_idx"                   ON "Order"                   ("channelConnectionId");
CREATE INDEX IF NOT EXISTS "SyncChannelPolicy_channelConnectionId_idx"       ON "SyncChannelPolicy"       ("channelConnectionId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChannelListing_channelConnectionId_fkey') THEN
    ALTER TABLE "ChannelListing" ADD CONSTRAINT "ChannelListing_channelConnectionId_fkey"
      FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SharedListingMembership_channelConnectionId_fkey') THEN
    ALTER TABLE "SharedListingMembership" ADD CONSTRAINT "SharedListingMembership_channelConnectionId_fkey"
      FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_channelConnectionId_fkey') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_channelConnectionId_fkey"
      FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SyncChannelPolicy_channelConnectionId_fkey') THEN
    ALTER TABLE "SyncChannelPolicy" ADD CONSTRAINT "SyncChannelPolicy_channelConnectionId_fkey"
      FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. The keys — this is the non-additive half
--
--    ⚠ Every replacement wraps the connection id in COALESCE. In Postgres NULL is
--    never equal to NULL, so a plain 4-column unique index would let unlimited
--    duplicate rows through the moment channelConnectionId is NULL — the opposite of
--    a constraint. COALESCE to a sentinel makes unattributed rows collide exactly as
--    they do today, so nothing loosens for data the resolver has not reached yet.
--    Prisma cannot express an expression index, so these live in raw SQL only —
--    the same arrangement the dropped ChannelConnection index already documented.
-- ─────────────────────────────────────────────────────────────────────────────

-- 6a. ChannelConnection: the singleton goes.
--
--     Replaced by uniqueness on ACCOUNT IDENTITY rather than on channel. This is the
--     channel-agnostic form the operator's decision 1 requires — no channel name
--     appears in it — and it is a stronger invariant than "many rows, full stop":
--     the same seller account cannot be connected twice.
--
--     While externalAccountId is NULL (every eBay row today) the COALESCE collapses
--     it to one active row per (channelType, marketplace) — byte-identical to the
--     constraint being dropped. So MAP.2 loosens nothing on its own; MAP.4 unlocks
--     the second account by capturing identity, and cannot admit an account it is
--     unable to tell apart from the first.
DROP INDEX IF EXISTS "ChannelConnection_channelType_marketplace_active_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelConnection_active_account_key"
  ON "ChannelConnection" ("channelType", COALESCE("marketplace", '~'), COALESCE("externalAccountId", '~'))
  WHERE "isActive" = true;

-- One primary per channel.
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelConnection_channelType_primary_key"
  ON "ChannelConnection" ("channelType") WHERE "isPrimary" = true;

-- 6b–6d. DEFERRED TO MAP.2b — see the SCOPE note at the top of this file.
--   ChannelListing (both keys), VariantChannelListing and SyncChannelPolicy keep
--   their single-account unique keys until MAP.3 converts the callers that upsert
--   through them. Their attribution columns, added in §2 and backfilled in §3, are
--   already in place, so MAP.2b is a pure index swap with no data movement.

-- Order.(channel, channelOrderId) and SharedListingMembership.(marketplace, itemId,
-- sku) are deliberately unchanged: marketplace order ids and eBay ItemIDs are
-- globally unique, so those keys survive multi-account. They gained attribution in
-- §2, which is all they needed.
