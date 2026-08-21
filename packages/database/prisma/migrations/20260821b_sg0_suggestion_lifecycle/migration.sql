-- SG.0 — suggestion lifecycle (additive).
-- `lastSeenAt` = the newest evaluation that still proposes the change; the sweep in
-- ads-suggestions.service.ts expires pending rows the engine has stopped re-proposing and
-- resurrects decided rows it still proposes. Existing rows take the migration timestamp,
-- which grants every current pending row a fresh full window — nothing expires instantly.
--
-- ⚠ DO NOT `prisma migrate deploy` this in isolation: name-ordering would also pick up any
-- earlier unapplied migration in the tree (20260820d must not run before the widened ingest
-- deploys — another session's constraint). Apply at the SG batch-push, after checking
-- `_prisma_migrations` for unfinished/unapplied predecessors.

ALTER TABLE "AdsRuleSuggestion"
  ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "AdsRuleSuggestion_status_lastSeenAt_idx"
  ON "AdsRuleSuggestion"("status", "lastSeenAt");
