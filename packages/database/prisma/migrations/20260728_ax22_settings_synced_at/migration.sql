-- AX2.2 — separate "we verified this against Amazon" from "we wrote to Amazon".
--
-- Campaign.lastSyncedAt / lastSyncStatus are stamped by the WRITE path
-- (ads-sync.worker) and by archive reconciliation. The 20-minute settings sync
-- reads every ENABLED+PAUSED campaign from Amazon but only ever called
-- campaign.update() when a field actually changed — and never stamped a
-- timestamp at all. So "last synced" answered a different question than it
-- appeared to: observed spread was ES 5m, DE/FR ~2h, and one IT campaign 34
-- DAYS, none of which reflected how recently we had checked Amazon.
--
-- settingsSyncedAt is the read-freshness clock. lastSyncStatus deliberately
-- keeps meaning delivery, so a successful read can never mask a failed write.

ALTER TABLE "Campaign"
  ADD COLUMN IF NOT EXISTS "settingsSyncedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Campaign_settingsSyncedAt_idx" ON "Campaign" ("settingsSyncedAt");
