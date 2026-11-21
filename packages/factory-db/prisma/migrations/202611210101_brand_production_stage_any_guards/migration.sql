-- Written by hand (Prisma does not model functions), after 202611200203_brand_production_stage_set_policies. When the
-- migrations are renumbered, keep this file as it is under its new timestamp. No table, column, enum, policy or data change; the
-- policy folder after it is the generator's output again (scripts/factory/check-policy-parity.mjs: the policy migration comes last).
--
-- Stage control B, "full control" (the Owner's pick 2026-11-21, order production tab lane, 40-stage-plan §1; step T-SC-001;
-- schema wave 'stage control 1/1'). It reverses 11-20 D1 ("only quality's release of every piece makes it Ready") and "only
-- ahead of the floor": an office person with production.brand.manage sets the stage the customer reads to ANY of the five —
-- Preparing, Cutting, Sewing, Quality check, Ready to ship — forward or back, also below what the floor recorded (a wrong scan),
-- with a reason. Only the stage moves: the piece counts, quality's records and the shipments stay as recorded. The previous
-- guard refused stageSet NOT IN ('CUTTING','SEWING','QUALITY') for every login, the owner included, so no app code could store
-- a hand Preparing or Ready past it.
--
--   BrandOrderProduction  the stage set by hand: any of PREPARING, CUTTING, SEWING, QUALITY, READY (the column is the BrandStage
--                         enum; the list stays written out), and while it stands "stage" equals it (unchanged: stageSet IS NULL
--                         OR "stage" = stageSet). The keeper (apps/factory-api modules/production/brand/keeper.ts) writes the
--                         SHOWN stage — the hand stage while it stands, higher or lower than the floor's (factory-domain
--                         production-brand/stage-set shownStageOf, end rule E1) — and clears the five columns in the same write
--                         in which it ends. Its reason, when and by whom, the office's note and the setter: unchanged.
--
-- Redefined: …_brand_production_stage_set_guards' `factory_brand_order_production_guard` (its newest body, 202611200202, word for
-- word), but for the one IN-list of its T-MS-001 block, marked T-SC-001. The trigger BrandOrderProduction_guard (AFTER INSERT OR
-- UPDATE OR DELETE) calls it as it is. No row is moved: every stored hand stage is CUTTING, SEWING or QUALITY and stays valid.

-- =====================================================================================================================
-- BrandOrderProduction: one order's production state for its customer (the whole body of 202611200202, but for T-SC-001).
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

  -- T-MS-001: the stage set by hand (set-the-stage-by-hand plan, design A; review R10). T-SC-001 (stage control B, the Owner's
  -- pick 2026-11-21): any of the five stages, PREPARING and READY too, forward or back of the floor's; while it stands the order
  -- shows it, so the keeper clears it in the same write in which it ends (the floor agrees or moves on: end rule E1).
  IF NEW."stageSet" IS NOT NULL AND NEW."stageSet" NOT IN ('PREPARING', 'CUTTING', 'SEWING', 'QUALITY', 'READY') THEN
    RAISE EXCEPTION 'production: a person sets the stage of order % by hand to PREPARING, CUTTING, SEWING, QUALITY or READY only, not %', NEW."salesOrderId", NEW."stageSet"
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
