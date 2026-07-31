-- AX3.8 — watch a replication while it runs.
--
-- A replication is hundreds of sequential Amazon calls. It used to run inside
-- the HTTP request, so the edge proxy cut the connection minutes in, the browser
-- reported "Failed to fetch", and the server carried on and created ten live
-- campaigns the operator could not see. Detaching the run needs somewhere to
-- report from, and needs a reconnecting browser to be able to FIND a run already
-- in flight rather than starting a second one.
--
-- Additive only: two nullable columns and one index.
ALTER TABLE "AdBlueprintApplication" ADD COLUMN IF NOT EXISTS "progress" JSONB;
ALTER TABLE "AdBlueprintApplication" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "AdBlueprintApplication_marketplace_productToken_status_idx"
  ON "AdBlueprintApplication" ("marketplace", "productToken", "status");
