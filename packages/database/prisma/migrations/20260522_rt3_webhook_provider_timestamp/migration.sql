-- RT.3: end-to-end push-latency dashboard.
--
-- Adds a single nullable column to WebhookEvent so we can measure
-- (createdAt - providerTimestamp) per inbound push notification and
-- surface p50/p95/p99 latency per source on /insights/live.
--
-- Nullable on purpose:
--   * Existing rows (pre-RT.3) don't have a provider timestamp; we
--     don't want to backfill synthetically and skew the distribution.
--   * Future sources that don't expose a push timestamp can opt out
--     by leaving the column null — the latency endpoint just skips
--     those rows for percentile calculation.
--
-- The composite (channel, providerTimestamp) index supports the
-- per-source percentile queries which scan the last 24h of rows.

ALTER TABLE "WebhookEvent"
  ADD COLUMN "providerTimestamp" TIMESTAMP(3);

CREATE INDEX "WebhookEvent_channel_providerTimestamp_idx"
  ON "WebhookEvent" ("channel", "providerTimestamp");
