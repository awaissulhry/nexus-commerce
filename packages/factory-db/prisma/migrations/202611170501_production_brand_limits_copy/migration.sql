-- Written by hand (B-PR-12; data only, no schema change), after the generated 202611170500_production_brand_limits_schema and
-- before 202611170502_production_brand_limits_guards and the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- A customer's production limits (production plan, schema wave 2/5, B-PR-12; lead picks L7, R-06): the schema step added the
-- limits to PortalSettings with their defaults. This file carries two of them over from what the database already says:
--
--   productionLevel     PROGRESS where production progress is shared today (progressShared on, Owner answer C1); the
--                       others stay STATUS. From the guards file on, the two stay in step (progressShared on exactly from
--                       PROGRESS) until progressShared is dropped (B-PR-40).
--   overrideFourEyes    on for the customers listed for a second person at release (QualitySettings.secondPersonPartyIds,
--                       of a company or tenant-wide): the factory's overrides of their production need a second person too.
--
-- A NOTICE says how many rows each part moved. Re-running this file changes nothing (it only raises a default). The file is
-- one script, so one transaction. The guard of …_portal_identity_w2b_guards (still the old one here) passes these updates:
-- they change neither the party, the creation, the people limit, the roles nor progressShared.

DO $$
DECLARE
  levelled integer;
  four_eyes integer;
BEGIN
  UPDATE "PortalSettings" s
     SET "productionLevel" = 'PROGRESS'
   WHERE s."progressShared" AND s."productionLevel" = 'STATUS';
  GET DIAGNOSTICS levelled = ROW_COUNT;

  UPDATE "PortalSettings" s
     SET "overrideFourEyes" = true
   WHERE NOT s."overrideFourEyes"
     AND EXISTS (SELECT 1 FROM "QualitySettings" q WHERE q."tenantId" = s."tenantId" AND s."partyId" = ANY (q."secondPersonPartyIds"));
  GET DIAGNOSTICS four_eyes = ROW_COUNT;

  RAISE NOTICE 'portal (B-PR-12): % portal setting(s) that share production progress now show the level PROGRESS; % customer(s) listed for a second person at release need one for overrides too', levelled, four_eyes;
END
$$;
