-- Shared stock plan step 3 — end times for listing overrides. Plan: docs/2026-09-19-shared-stock-plan.md
-- §5; contract docs/2026-09-19-shared-stock-build.md §3.
--
-- Shared by the generator (scripts/workspace-policies.mjs, which the disposable test database applies)
-- and migration 20260919b_listing_end_times, which ENDS WITH these exact bytes (policy-migrations.json;
-- check-policy-migration-parity.mjs). Change it only through a NEW migration that ends with its new bytes.
--
-- The rule the database keeps, whatever writes the row (18 code paths write listing modes today):
--   An end time never outlives the mode it was set for. "Fixed number until Monday" is cleared the moment
--   the listing follows again; "Paused until Monday" the moment it is resumed. Otherwise a stale end
--   time left behind by a writer that knows nothing about it (a flat file, a bulk edit) would flip a
--   listing that was later fixed or paused again — at a time nobody chose for that new state.
--   Changing only the fixed NUMBER keeps the end time: the override still ends when it was meant to,
--   and following is the safe state (a fixed number is not real stock).

CREATE OR REPLACE FUNCTION nexus_listing_end_times() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."followMasterQuantity" THEN NEW."pinnedUntil" := NULL; END IF;
  IF NOT NEW."syncPaused" THEN NEW."pausedUntil" := NULL; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS nexus_listing_end_times ON "ChannelListing";
CREATE TRIGGER nexus_listing_end_times BEFORE INSERT OR UPDATE ON "ChannelListing"
  FOR EACH ROW WHEN (NEW."pinnedUntil" IS NOT NULL OR NEW."pausedUntil" IS NOT NULL)
  EXECUTE FUNCTION nexus_listing_end_times();

-- The same rule for a shared eBay variant: a fixed number is pinnedQuantity; its "paused" is Excluded
-- (followPool = false).
CREATE OR REPLACE FUNCTION nexus_membership_end_times() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."pinnedQuantity" IS NULL THEN NEW."pinnedUntil" := NULL; END IF;
  IF NEW."followPool" THEN NEW."pausedUntil" := NULL; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS nexus_membership_end_times ON "SharedListingMembership";
CREATE TRIGGER nexus_membership_end_times BEFORE INSERT OR UPDATE ON "SharedListingMembership"
  FOR EACH ROW WHEN (NEW."pinnedUntil" IS NOT NULL OR NEW."pausedUntil" IS NOT NULL)
  EXECUTE FUNCTION nexus_membership_end_times();

-- The end-time job probes every business once a minute (apps/api/src/jobs/listing-end-times.job.ts).
-- These partial indexes hold only the rows that carry an end time, so the probe never scans the tables.
CREATE INDEX IF NOT EXISTS "ChannelListing_pinnedUntil_due" ON "ChannelListing" ("pinnedUntil") WHERE "pinnedUntil" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ChannelListing_pausedUntil_due" ON "ChannelListing" ("pausedUntil") WHERE "pausedUntil" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "SharedListingMembership_pinnedUntil_due" ON "SharedListingMembership" ("pinnedUntil") WHERE "pinnedUntil" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "SharedListingMembership_pausedUntil_due" ON "SharedListingMembership" ("pausedUntil") WHERE "pausedUntil" IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SharedListingMembership_pinned_quantity_check') THEN
    ALTER TABLE "SharedListingMembership" ADD CONSTRAINT "SharedListingMembership_pinned_quantity_check" CHECK ("pinnedQuantity" IS NULL OR "pinnedQuantity" >= 0);
  END IF;
END $$;
