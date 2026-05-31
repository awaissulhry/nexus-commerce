-- Apex A.2a — per-campaign live-write allowlist + daily-write safety counter.
-- DEFAULT-DENY: liveBidWritesEnabled=false means the write-gate refuses live
-- bid/state mutations for this campaign even when the deploy-wide live flag and
-- the per-connection writesEnabledAt are set. Additive + backward-compatible:
-- existing rows default to false (no live writes) and 0/null counters.
ALTER TABLE "Campaign"
  ADD COLUMN IF NOT EXISTS "liveBidWritesEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "liveBidWritesToday" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "liveBidWritesDay" TEXT;
