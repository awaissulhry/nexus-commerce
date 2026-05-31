-- AF perf — index the (entityType, entityId, date) access path used by the
-- campaign + ad-group detail metric aggregation. The existing unique key buries
-- entityId behind profileId+adProduct, so the entityId-only branch seq-scanned.
CREATE INDEX IF NOT EXISTS "AmazonAdsDailyPerformance_entityType_entityId_date_idx"
  ON "AmazonAdsDailyPerformance" ("entityType", "entityId", "date");
