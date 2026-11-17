-- Written by hand (B-PR-01; data only, no schema change), after the generated 202611170200_production_brand_wall_schema and
-- before 202611170202_production_brand_wall_guards and the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- One customer per work order (production plan, schema wave 1/5, B-PR-01; lead pick L8, the brand wall): the schema step
-- added WorkOrder.partyId and filled no row. This file fills it once for the work orders made before the rule, from their
-- cells (each cell names its order line's customer, WorkOrderSize.partyId):
--
--   its cells name one customer                    → that customer
--   no cell names a customer, a SAMPLE              → its sample round's customer (null: a round for no customer)
--   its cells name several customers                → none: "Mixed brands (made before the rule)"; its cells may only leave
--                                                     it (a split into one work order per customer), and once those left
--                                                     are of one customer it takes that customer, once (the guards file)
--   no cell at all, not a SAMPLE                    → none (nothing to copy from; the office cancels such an empty draft)
--
-- A NOTICE says how many mixed work orders there are (the lead reports the count of each server after its refresh).
-- Re-running this file changes nothing (it only fills a null). The file is one script, so one transaction: a failure
-- leaves every row, and the guard, as they were.

-- A released, closed or cancelled work order never changes its frozen columns for any login (WorkOrder_guard), so the guard
-- is off for this one statement: only the new column is written (no version, no updatedAt).
ALTER TABLE "WorkOrder" DISABLE TRIGGER "WorkOrder_guard";
UPDATE "WorkOrder" w
   SET "partyId" = x.party
  FROM (
    SELECT o."id",
           CASE WHEN count(DISTINCT c."partyId") = 1 THEN (array_agg(c."partyId") FILTER (WHERE c."partyId" IS NOT NULL))[1]
                WHEN count(DISTINCT c."partyId") = 0 AND o."kind" = 'SAMPLE' THEN r."partyId"
           END AS party
      FROM "WorkOrder" o
      LEFT JOIN "WorkOrderSize" c ON c."tenantId" = o."tenantId" AND c."workOrderId" = o."id"
      LEFT JOIN "SampleRound" r ON r."tenantId" = o."tenantId" AND r."id" = o."sampleRoundId"
     GROUP BY o."id", o."kind", r."partyId"
  ) x
 WHERE w."id" = x."id" AND w."partyId" IS NULL AND x.party IS NOT NULL;
ALTER TABLE "WorkOrder" ENABLE TRIGGER "WorkOrder_guard";

DO $$
DECLARE
  mixed integer;
  empty integer;
BEGIN
  SELECT count(*) FILTER (WHERE n > 1), count(*) FILTER (WHERE n = 0 AND kind <> 'SAMPLE') INTO mixed, empty
    FROM (SELECT o."kind"::text AS kind, count(DISTINCT c."partyId") AS n
            FROM "WorkOrder" o
            LEFT JOIN "WorkOrderSize" c ON c."tenantId" = o."tenantId" AND c."workOrderId" = o."id"
           WHERE o."partyId" IS NULL
           GROUP BY o."id", o."kind") t;
  RAISE NOTICE 'production (B-PR-01): % work order(s) made before the one-customer rule mix customers and keep none ("Mixed brands (made before the rule)", split them); % work order(s) without a cell name none', mixed, empty;
END
$$;
