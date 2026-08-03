-- C2b — enforce one campaign, one AdSchedule at the database level.
--
-- saveRankScheduleGroup already assumes this invariant (findFirst by campaignId, then rebind), so a
-- duplicate row was never handled correctly — it was silently hijacked. The C2 integrity check
-- detects violations; this prevents them.
--
-- Verified immediately before writing this migration: 45 rows, 0 duplicate campaignIds. If that is
-- no longer true when this applies, the migration will FAIL and block the deploy — which is the
-- correct outcome: a duplicate means two schedules are competing for one campaign and that needs a
-- human decision, not an automatic one.
--
-- The unique index supersedes the plain index on the same column, so the old one is dropped rather
-- than left as a redundant duplicate.

DROP INDEX IF EXISTS "AdSchedule_campaignId_idx";

CREATE UNIQUE INDEX "AdSchedule_campaignId_key" ON "AdSchedule"("campaignId");
