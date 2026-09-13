-- PR.5 Presence rollback. NOT part of forward apply; separate Owner approval.
-- Refuses to discard ANY stated intent/fact/retirement/stop or retained identity.
-- No CASCADE; never removes a dependent object's data automatically.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL row_security = off;
LOCK TABLE "ChannelListing" IN ACCESS EXCLUSIVE MODE;
DO $pr_presence_rollback$
DECLARE presence_column TEXT; populated BOOLEAN;
BEGIN
  IF NOT pg_try_advisory_xact_lock(72707369) THEN
    RAISE EXCEPTION 'PR presence migration lock is held';
  END IF;
  IF to_regclass('public."ListingIdentity"') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE "ListingIdentity" IN ACCESS EXCLUSIVE MODE';
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM "ListingIdentity")' INTO populated;
    IF populated THEN RAISE EXCEPTION 'Refusing rollback: ListingIdentity contains data'; END IF;
  END IF;
  FOREACH presence_column IN ARRAY ARRAY['presenceIntent', 'presenceIntentAt', 'presenceIntentBy', 'presenceIntentReason', 'presenceEffectiveFrom', 'presenceUntil', 'channelFact', 'channelFactAt', 'channelFactVia', 'channelFactDetail', 'endedAt', 'endedBy', 'endedReason', 'saleStopId'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns c
               WHERE c.table_schema = 'public' AND c.table_name = 'ChannelListing'
                 AND c.column_name = presence_column) THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM "ChannelListing" WHERE %I IS NOT NULL)', presence_column) INTO populated;
      IF populated THEN RAISE EXCEPTION 'Refusing rollback: ChannelListing.% contains data', presence_column; END IF;
    END IF;
  END LOOP;
END;
$pr_presence_rollback$;
DROP TABLE IF EXISTS "ListingIdentity";
ALTER TABLE "ChannelListing"
  DROP COLUMN IF EXISTS "presenceIntent",
  DROP COLUMN IF EXISTS "presenceIntentAt",
  DROP COLUMN IF EXISTS "presenceIntentBy",
  DROP COLUMN IF EXISTS "presenceIntentReason",
  DROP COLUMN IF EXISTS "presenceEffectiveFrom",
  DROP COLUMN IF EXISTS "presenceUntil",
  DROP COLUMN IF EXISTS "channelFact",
  DROP COLUMN IF EXISTS "channelFactAt",
  DROP COLUMN IF EXISTS "channelFactVia",
  DROP COLUMN IF EXISTS "channelFactDetail",
  DROP COLUMN IF EXISTS "endedAt",
  DROP COLUMN IF EXISTS "endedBy",
  DROP COLUMN IF EXISTS "endedReason",
  DROP COLUMN IF EXISTS "saleStopId";
COMMIT;
