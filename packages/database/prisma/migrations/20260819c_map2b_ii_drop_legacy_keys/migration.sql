-- MAP.2b-ii — drop the legacy single-account unique keys.
--
-- The second half of MAP.2b, held back one release on purpose. MAP.2b created the
-- four-column keys ADDITIVELY so that a rolling deploy could not fail: while both
-- key sets existed, an old container emitting `ON CONFLICT (3 cols)` still matched
-- the old index, and a new one emitting `ON CONFLICT (4 cols)` matched the new.
--
-- That window is closed. `20260819b` deployed at 2026-08-19T18:16:13Z and the crons
-- at 18:20 and 18:25 ran on it, so no container is still emitting the old spec.
--
-- ⚠ THIS is the statement that actually lets a second account exist. Until now the
-- old three-column index was still enforcing "one listing per product per channel
-- per marketplace, across all accounts" — the constraint the whole programme is
-- about. Everything before this was preparation.
--
-- Idempotent. Rollback: rollback.sql beside this file (and read its warning first —
-- restoring these keys fails, correctly, once a second account has written rows).

DROP INDEX IF EXISTS "ChannelListing_productId_channelMarket_key";
DROP INDEX IF EXISTS "ChannelListing_productId_channel_marketplace_key";
DROP INDEX IF EXISTS "VariantChannelListing_variantId_channel_marketplace_key";
DROP INDEX IF EXISTS "SyncChannelPolicy_channel_marketplace_key";
