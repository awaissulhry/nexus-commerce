-- P1.3 (docs/channel-connections/FINAL-PLAN.md) — the destination account of an outbound queue row.
-- Additive: one nullable column, no default, no backfill, no index (rows are read by id at send time).
ALTER TABLE "OutboundSyncQueue" ADD COLUMN "channelConnectionId" TEXT;
