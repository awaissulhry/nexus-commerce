-- PES.5 — the alias discriminator becomes NOT NULL, because a NULLABLE one is
-- unusable from Prisma.
--
-- ── What went wrong with 20260901c ─────────────────────────────────────────
-- That migration put a NULLABLE `aliasId` into both compound unique keys, on the
-- reasoning that `NULLS NOT DISTINCT` makes NULL collide with NULL so existing
-- rows need no backfill. The DB half of that is correct and still is.
--
-- The client half is not. Prisma types EVERY field of a compound-unique `where`
-- as NON-NULLABLE regardless of the column's nullability:
--
--   ChannelListingProductId_channel_marketplaceCompoundUniqueInput = {
--     productId: string; channel: string; marketplace: string
--     channelConnectionId: string     <- nullable column, typed non-null
--     aliasId: string                 <- same
--   }
--
-- So `aliasId: null` is refused at QUERY-BUILD time — "Argument `aliasId` must
-- not be null" — and a NULL discriminator can be stored and indexed but never
-- TARGETED. Every channel-routed write through PATCH /api/products/bulk 500'd.
-- Measured directly, all three combinations:
--   aliasId null, conn real  -> Argument `aliasId` must not be null
--   aliasId real, conn null  -> Argument `channelConnectionId` must not be null
--   aliasId real, conn real  -> OK
--
-- `strictNullChecks` is OFF in apps/api/tsconfig.json, so `null` satisfies
-- `string` and the compiler could not catch any of it. A green tsc proved
-- nothing here (reference_api_tsconfig_not_strict).
--
-- ── ⚠ The same trap is LATENT on channelConnectionId (MAP.2b) ──────────────
-- It is nullable and in both keys, so an UNATTRIBUTED listing is equally
-- untargetable — every `channelConnectionId: … ?? null` call site would throw
-- the moment a listing without a connection exists. Harmless TODAY only because
-- 977/977 rows carry one (measured 2026-09-01). Not fixed here: that is MAP's
-- key and its own decision. Recorded so it is not rediscovered as a mystery.
--
-- ── The fix ────────────────────────────────────────────────────────────────
-- A NOT NULL `aliasKey` carries the discriminator ('' = the primary listing);
-- `aliasId` stays as the real nullable FK and leaves the keys. They are written
-- together, and listing-alias.service.ts is the only writer that sets a
-- non-empty key.
--
-- `''` cannot be a foreign key, which is exactly why the two are separate
-- columns rather than one NOT NULL FK with a sentinel row.
--
-- ── Safety ─────────────────────────────────────────────────────────────────
-- ADD COLUMN … NOT NULL DEFAULT '' backfills every existing row to '' in place,
-- which is their correct value: all 977 are primary listings. Verified before
-- writing this: `SELECT count(*) FROM "ChannelListing" WHERE "aliasId" IS NOT
-- NULL` = 0, so dropping the aliasId-keyed indexes below can orphan nothing —
-- no alias row has ever existed (alias creation is still gated on PES.5-ii).
--
-- Rollback: rollback.sql beside this file.

ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "aliasKey" TEXT NOT NULL DEFAULT '';

-- The new keys. NULLS NOT DISTINCT is still required for channelConnectionId,
-- which remains nullable; aliasKey is NOT NULL and needs no such treatment.
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channelMarket_akey_key"
  ON "ChannelListing" ("productId", "channelMarket", "channelConnectionId", "aliasKey")
  NULLS NOT DISTINCT;

CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channel_marketplace_akey_key"
  ON "ChannelListing" ("productId", "channel", "marketplace", "channelConnectionId", "aliasKey")
  NULLS NOT DISTINCT;

-- The aliasId-keyed indexes from 20260901c are dropped: they were never usable
-- from the client, and with zero non-null aliasId they constrain nothing that
-- the new keys do not. This is NOT the rolling-deploy hazard that made
-- 20260901c keep the pre-alias keys — those (…_conn_key) are still in place and
-- still serve an old container's 4-column ON CONFLICT.
DROP INDEX IF EXISTS "ChannelListing_productId_channelMarket_alias_key";
DROP INDEX IF EXISTS "ChannelListing_productId_channel_marketplace_alias_key";
