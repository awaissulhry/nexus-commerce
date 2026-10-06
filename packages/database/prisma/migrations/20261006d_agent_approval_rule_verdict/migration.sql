-- ADS AUTONOMY AA-W2-4 — the watch level: a request Claude asks for at `watch` goes through the business's full rule
-- check (the connection's nexus.run, the Pause, the tool's limits with the ads strategy, the daily cap) and the verdict
-- is recorded on the request; a person still decides it. The level itself is a value of the existing text column
-- AgentTool.claudeTrust (no change there).
--
-- Additive and nullable: every existing request keeps NULL = "not asked at watch", so nothing changes at deploy and
-- nothing is written until a business sets a kind to watch. No new table: AgentApproval's ownership, grants and
-- row-level security are unchanged.

-- AlterTable
ALTER TABLE "AgentApproval" ADD COLUMN IF NOT EXISTS "ruleVerdict" JSONB;
