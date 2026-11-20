-- Written by hand (Prisma does not model triggers), after the generated 202611200201_brand_production_stage_set and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.
--
-- Set the stage by hand (set-the-stage-by-hand plan, design A; step T-MS-001; review R10, R11, R21; schema wave 'stage by
-- hand 1/1'). An office person may put an order's plain stage ahead while the floor cannot record the work (the system or
-- the scanners are down, too few people to record it, the work is at an outside workshop, something else). The five new
-- nullable columns of BrandOrderProduction hold it: stageSet, stageSetReason, stageSetNote, stageSetAt, stageSetById. The
-- keeper (apps/factory-api modules/production/brand/keeper.ts) writes the SHOWN stage into "stage": the higher of the floor's
-- and the hand stage (factory-domain production-brand/stage-set shownStageOf); the floor's own stage is never stored. All
-- five are hidden from the partner role (ownership/brand-production.json): the customer never learns a stage was set by hand.
-- apps/factory-api checks all of this first and answers in words; these rules are the last word, for every login, the owner
-- included. The refusals are check_violation (SQLSTATE 23514); their words name no other customer.
--
--   BrandOrderProduction  + the stage set by hand: CUTTING, SEWING or QUALITY only (never PREPARING, never READY), and while
--                         it stands "stage" equals it (stageSet IS NULL OR (stageSet IN ('CUTTING','SEWING','QUALITY') AND
--                         "stage" = stageSet)): the keeper clears it in the same write in which the floor reaches or passes
--                         it, and Clear moves the stage back in the same write; its reason code, when and by whom, all four
--                         or none; the office's note only beside it, one line of at most 200, required for OTHER; the setter,
--                         when set or changed (a new setter or a new time), an active office person of the tenant.
--
-- Redefined: …_brand_production_guards' `factory_brand_order_production_guard` (its only body, 202611170701, word for word),
-- with one block added before its end, marked T-MS-001. The trigger BrandOrderProduction_guard (AFTER INSERT OR UPDATE OR
-- DELETE) calls it as it is. No row is moved: the five columns are new and null on every row (no backfill).

-- =====================================================================================================================
-- BrandOrderProduction: one order's production state for its customer (the whole body of 202611170701, but for T-MS-001).
CREATE OR REPLACE FUNCTION "factory_brand_order_production_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  user_audience text;
  user_status text;
  user_party uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: the production state % of an order is kept, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."salesOrderId", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."salesOrderId", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: the order, customer, key and creation of production state % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_privacy_ops_key_ok"(NEW."key", concat('brand-production:', NEW."salesOrderId")) THEN
    RAISE EXCEPTION 'production: the key of production state % is brand-production:<salesOrderId> (one per order)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The customer's urgency (L17, L18; R-46, R-49).
  IF (NEW."urgency" = 'URGENT') <> (NEW."urgentRank" IS NOT NULL) OR NEW."urgentRank" < 1 THEN
    RAISE EXCEPTION 'production: order % has a place in its customer''s Urgent list (1 or more) exactly while it is Urgent (%)', NEW."salesOrderId", NEW."urgency"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."urgencySetAt" IS NULL) <> (NEW."urgencySetBy" IS NULL)
     OR (NEW."urgencySetById" IS NOT NULL AND NEW."urgencySetAt" IS NULL)
     OR (NEW."urgency" = 'URGENT' AND NEW."urgencySetAt" IS NULL) THEN
    RAISE EXCEPTION 'production: the urgency of order % names who set it (the customer or us) and when, both or neither, and an Urgent mark always has them', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."urgencySetById" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."urgencySetById", NEW."urgencySetBy") IS DISTINCT FROM (OLD."urgencySetById", OLD."urgencySetBy")) THEN
    SELECT u."audience"::text, u."partyId" INTO user_audience, user_party FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."urgencySetById";
    IF FOUND AND ((NEW."urgencySetBy" = 'BRAND' AND (user_audience <> 'PARTNER' OR user_party IS DISTINCT FROM NEW."partyId"))
                  OR (NEW."urgencySetBy" = 'FACTORY' AND user_audience <> 'OFFICE')) THEN
      RAISE EXCEPTION 'production: the urgency of order % is set by a portal person of its own customer (BRAND) or by an office person (FACTORY)', NEW."salesOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The factory's lock (L18; R-45): a locked order is Regular, with the reason the customer reads.
  IF NEW."urgencyLocked" AND NEW."urgency" <> 'REGULAR' THEN
    RAISE EXCEPTION 'production: order % locked by us is Regular', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."urgencyLocked" <> (NEW."urgencyLockReason" IS NOT NULL)
     OR NEW."urgencyLocked" <> (NEW."urgencyLockedAt" IS NOT NULL)
     OR NEW."urgencyLocked" <> (NEW."urgencyLockedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'production: order % is locked with its reason, when and by whom, exactly while it is locked', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."urgencyLockReason" IS NOT NULL
     AND (btrim(NEW."urgencyLockReason") = '' OR char_length(NEW."urgencyLockReason") > 500 OR NEW."urgencyLockReason" ~ '[\r\n]') THEN
    RAISE EXCEPTION 'production: the reason order % is locked is one line of at most 500 characters', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."urgencyLockedById" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."urgencyLockedById" IS DISTINCT FROM OLD."urgencyLockedById") THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."urgencyLockedById";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'production: order % is locked by an active office person', NEW."salesOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The supervisor of the order (L21): the Inquiry assignee's pattern.
  IF (NEW."supervisorId" IS NULL) <> (NEW."supervisorAssignedAt" IS NULL) THEN
    RAISE EXCEPTION 'production: order % names its supervisor together with since when, or neither (the customer''s default)', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supervisorId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."supervisorId" IS DISTINCT FROM OLD."supervisorId") THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."supervisorId";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'production: the supervisor of order % is an active office person, not one that is % (%)', NEW."salesOrderId", user_status, user_audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The factory's raise of the health (B-PR-13 health.ts): only to AT_RISK, never lower; the note is the office's.
  IF NEW."healthSet" IS NOT NULL AND NEW."healthSet" <> 'AT_RISK' THEN
    RAISE EXCEPTION 'production: a person raises the health of order % to AT_RISK only, not %', NEW."salesOrderId", NEW."healthSet"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nulls(NEW."healthSet", NEW."healthReasonCode", NEW."healthSetAt", NEW."healthSetById", NEW."healthSetUntil") NOT IN (0, 5) THEN
    RAISE EXCEPTION 'production: a raise of the health of order % has its reason code, when, by whom and until when, or there is none', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."healthNote" IS NOT NULL
     AND (NEW."healthSet" IS NULL OR btrim(NEW."healthNote") = '' OR char_length(NEW."healthNote") > 200 OR NEW."healthNote" ~ '[\r\n]') THEN
    RAISE EXCEPTION 'production: the office''s note on the health of order % stands only beside a raise, one line of at most 200 characters', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it waits on.
  IF NEW."waitingSince" IS NOT NULL AND NEW."waitingOn" IS NULL THEN
    RAISE EXCEPTION 'production: order % waits since a time only on someone', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;

  -- T-MS-001: the stage set by hand (set-the-stage-by-hand plan, design A; review R10). Only CUTTING, SEWING or QUALITY
  -- (never PREPARING, never READY: only quality's release of every piece makes an order Ready); while it stands the order
  -- shows it, so the keeper clears it in the same write in which the floor reaches or passes it.
  IF NEW."stageSet" IS NOT NULL AND NEW."stageSet" NOT IN ('CUTTING', 'SEWING', 'QUALITY') THEN
    RAISE EXCEPTION 'production: a person sets the stage of order % by hand to CUTTING, SEWING or QUALITY only, not %', NEW."salesOrderId", NEW."stageSet"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stageSet" IS NOT NULL AND NEW."stage" <> NEW."stageSet" THEN
    RAISE EXCEPTION 'production: order % shows its stage set by hand (%) while it stands, not %: clear it in the same write that moves the stage', NEW."salesOrderId", NEW."stageSet", NEW."stage"
      USING ERRCODE = 'check_violation';
  END IF;
  -- T-MS-001: why, when and by whom, all four or none.
  IF num_nulls(NEW."stageSet", NEW."stageSetReason", NEW."stageSetAt", NEW."stageSetById") NOT IN (0, 4) THEN
    RAISE EXCEPTION 'production: a stage set by hand on order % has its reason code, when and by whom, or there is none', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  -- T-MS-001: the office's note only beside it, one line of at most 200 (the raise's rule); OTHER says why in it.
  IF NEW."stageSetNote" IS NOT NULL
     AND (NEW."stageSet" IS NULL OR btrim(NEW."stageSetNote") = '' OR char_length(NEW."stageSetNote") > 200 OR NEW."stageSetNote" ~ '[\r\n]') THEN
    RAISE EXCEPTION 'production: the office''s note on the stage set by hand of order % stands only beside it, one line of at most 200 characters', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stageSetReason" = 'OTHER' AND NEW."stageSetNote" IS NULL THEN
    RAISE EXCEPTION 'production: a stage set by hand on order % for another reason (OTHER) says why in the office''s note', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  -- T-MS-001: set or changed (a new setter or a new time) by an active office person of the tenant: never a portal person,
  -- never a floor worker (not a person of the office: not found), never a suspended one. A person made inactive later stays
  -- named while the hand stage stands (the lock's rule).
  IF NEW."stageSetById" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."stageSetById", NEW."stageSetAt") IS DISTINCT FROM (OLD."stageSetById", OLD."stageSetAt")) THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."stageSetById";
    IF NOT FOUND OR user_audience <> 'OFFICE' OR user_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'production: the stage of order % is set by hand by an active office person', NEW."salesOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
