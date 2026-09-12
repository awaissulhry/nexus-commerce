-- Rollback for 20260901f. Safe: the table is additive and nothing else reads it.
-- ⚠ Dropping it DESTROYS every captured publish snapshot — the only record of
-- what was sent to a channel. Check before running:
--   SELECT count(*) FROM "ChannelListingSnapshot";
DROP TABLE IF EXISTS "ChannelListingSnapshot";
