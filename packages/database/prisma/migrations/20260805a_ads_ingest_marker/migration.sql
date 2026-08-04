-- Ads report ingest: a real "processed" marker.
--
-- The ingest cron selected work with `rowsIngested = 0`, using it to mean "not
-- yet ingested". It is also the correct outcome for a report that contains no
-- rows. Five EU profiles (PL/SE/NL/UK/IE) have no campaigns, so 38 of ~68 daily
-- jobs were permanently zero-row, never left the selection set, and were
-- re-processed on every tick — starving the markets that do have data. IT is the
-- largest account and therefore completes LAST of nine every day, so it sat at
-- the back of a queue that never cleared and lost 7 days of performance data
-- while actively spending.
--
-- Additive and reversible: one nullable column plus an index.

ALTER TABLE "AmazonAdsReportJob" ADD COLUMN IF NOT EXISTS "ingestedAt" TIMESTAMP(3);

-- Backfill history as already-handled. Every one of these jobs has a signed S3
-- URL that expired long ago, so none can be re-ingested — leaving them null
-- would queue permanent, guaranteed-failing work. Recovery of the IT gap is done
-- by REQUESTING FRESH reports, not by replaying these.
--
-- The exception is anything completed in the last 50 minutes: those URLs may
-- still be live and the old code would have picked them up, so they stay null
-- and the new selection will process them normally.
UPDATE "AmazonAdsReportJob"
   SET "ingestedAt" = COALESCE("completedAt", "updatedAt")
 WHERE "ingestedAt" IS NULL
   AND ("completedAt" IS NULL OR "completedAt" < NOW() - INTERVAL '50 minutes');

CREATE INDEX IF NOT EXISTS "AmazonAdsReportJob_ingestedAt_completedAt_idx"
    ON "AmazonAdsReportJob" ("ingestedAt", "completedAt");
