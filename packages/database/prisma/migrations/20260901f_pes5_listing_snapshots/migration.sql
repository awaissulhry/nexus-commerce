-- PES.5 / D1 wave-1 — publish snapshots + restore-to-draft storage.
--
-- Doctrine (Owner ruling #110): every publish captures what was SENT; restore
-- writes it back as a DRAFT, never straight to live; restoring auto-snapshots
-- the current state first so the restore is itself undoable.
--
-- ── Why a table rather than the prior art's JSONB-on-the-row ───────────────
-- The eBay cockpit stores snapshots in `ChannelListing.platformAttributes.
-- _versionHistory`. Measured reasons not to copy that:
--   • that row is the HOT PATH — every sheet read loads platformAttributes, so
--     snapshots would inflate every read of any listing that has one. Amazon
--     rows already reach 5.7 KB with ZERO snapshots.
--   • it self-limits: the cockpit strips _versionHistory before snapshotting
--     "so we don't snapshot snapshots (storage blows up otherwise)".
--   • it is eBay-cockpit-only; Amazon (725 listings) has no snapshot path.
--   • measured 2026-09-01: `_versionHistory` exists on 0 of 977 listings, so it
--     has never actually run. Prior art to learn from, not to trust.
--
-- Purely additive: a new table plus a FK. No existing row is read or written,
-- and nothing depends on it until the routes ship.
--
-- Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "ChannelListingSnapshot" (
  "id"               TEXT NOT NULL,
  "channelListingId" TEXT NOT NULL,
  "channel"          TEXT NOT NULL,
  "marketplace"      TEXT NOT NULL,
  "aliasKey"         TEXT NOT NULL DEFAULT '',
  "reason"           TEXT NOT NULL,
  "publishEventId"   TEXT,
  "payload"          JSONB NOT NULL,
  "label"            TEXT,
  "capturedBy"       TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "restoredAt"       TIMESTAMP(3),
  "restoredBy"       TEXT,
  CONSTRAINT "ChannelListingSnapshot_pkey" PRIMARY KEY ("id")
);

-- CASCADE: a snapshot without its listing restores onto nothing.
ALTER TABLE "ChannelListingSnapshot"
  DROP CONSTRAINT IF EXISTS "ChannelListingSnapshot_channelListingId_fkey";
ALTER TABLE "ChannelListingSnapshot"
  ADD CONSTRAINT "ChannelListingSnapshot_channelListingId_fkey"
  FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ChannelListingSnapshot_listing_createdAt_idx"
  ON "ChannelListingSnapshot" ("channelListingId", "createdAt");
CREATE INDEX IF NOT EXISTS "ChannelListingSnapshot_publishEventId_idx"
  ON "ChannelListingSnapshot" ("publishEventId");
CREATE INDEX IF NOT EXISTS "ChannelListingSnapshot_channel_marketplace_idx"
  ON "ChannelListingSnapshot" ("channel", "marketplace");
