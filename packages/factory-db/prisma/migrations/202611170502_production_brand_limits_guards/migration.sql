-- Written by hand (B-PR-12), after 202611170500_production_brand_limits_schema and 202611170501_production_brand_limits_copy, before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- A customer's production limits (production plan, schema wave 2/5, B-PR-12; lead picks L7, L18, L21; review fixes R-46, R-50,
-- R-53). For every login, the owner included. The refusals are check_violation (SQLSTATE 23514); their words name no other
-- customer (the brand wall: "One brand must not be able to see anything related to any other brand").
--
-- PortalSettings  it redefines …_portal_identity_w2b_guards' factory_portal_settings_guard, word for word but for the lines
--                 marked B-PR-12 (every earlier rule kept: changed never deleted, party and creation fixed, 1 to 1000 people,
--                 the allowed roles by key each once, progress shared only with a customer or a brand):
--                   - progressShared stays (until B-PR-40) and equals "productionLevel is PROGRESS or more": a write of one
--                     moves the other (the office switch of today, until B-PR-14, moves the level: on → PROGRESS, off →
--                     STATUS; a level written moves the switch); both written must agree; an insert takes the higher of the two;
--                   - the urgent quota 0 to 20;
--                   - the supervisor and since when, both or neither; the backup only beside a supervisor, never the same
--                     person; each an active office person when named or changed (the Inquiry assignee's rule: a person
--                     made inactive later stays named until the office changes it, B-PR-42a reads "no longer active");
--                   - the production asks: HOLD, RESUME, SPLIT_SHIPMENT and SAMPLE_ROUND only, each once (RUSH follows the
--                     urgency switch, R-50; CHANGE and CANCEL the company's cut-offs);
--                   - the named approver: an active portal person of the party itself when named or changed;
--                   - the production limits (urgency, asks, approver, supervisor, backup) set only for a customer or a brand,
--                     checked when one is set or changed, as progress is (Owner answer C1).
--                 PortalSettings stays office only: the policy migration after this file gives the partner role no grant on it.
-- OrderFreezeRule it redefines …_sales_orders_depth_w2b_guards' factory_order_freeze_rule_check, word for word but for the lines
--                 marked B-PR-12, and its one-active-rule unique, now per customer: a rule's customer (partyId) is fixed with
--                 its company, field, stage and creation; a customer's rule names a CUSTOMER or BRAND party; one active rule
--                 per company, customer (or none), field and stage (a partial unique: none counts as one customer); a later
--                 stage never loosens an earlier BLOCKED inside one set (company, customer or none, field: a customer's rules
--                 replace the company's for that field, so the two sets are never compared), under a lock per set (the
--                 company's set keeps the key of before, the one the API takes).

-- ---------------------------------------------------------------------------------------------------------------------
-- PortalSettings (PLT-006; Owner answer C1; B-PR-12)
--   UPDATE     an UPDATE that changes nothing passes; the party and the creation never change.
--   every row  at most 1 to 1000 people, or no limit; the allowed partner roles by their keys, each once (a list, maybe
--              empty); production progress shared only with a customer or a brand (checked when it is switched on).
--              B-PR-12: the production limits above.
--   DELETE     refused (switch the portal off instead). TRUNCATE refused.
CREATE OR REPLACE FUNCTION "factory_portal_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  party_roles text[];
  user_audience text; -- B-PR-12
  user_status text; -- B-PR-12
  user_party uuid; -- B-PR-12
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal: the portal settings % are changed, never deleted (switch the portal off)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."partyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'portal: the party and creation of the portal settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."maxUsers" IS NOT NULL AND NEW."maxUsers" NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'portal: the portal settings % hold 1 to 1000 people, or no limit, not %', NEW."id", NEW."maxUsers"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."allowedRoleKeys" IS NULL
     OR EXISTS (SELECT 1 FROM unnest(NEW."allowedRoleKeys") k WHERE k IS NULL OR k !~ '^[a-z][a-z0-9_.-]*$')
     OR cardinality(NEW."allowedRoleKeys") <> (SELECT count(DISTINCT k) FROM unnest(NEW."allowedRoleKeys") k) THEN
    RAISE EXCEPTION 'portal: the portal settings % name the allowed partner roles by their keys, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-12: progressShared follows productionLevel (on exactly from PROGRESS) until it is dropped (B-PR-40). One written
  -- moves the other; both written must agree (the check below); an insert takes the higher of the two.
  IF TG_OP = 'INSERT' THEN
    IF NEW."progressShared" AND NEW."productionLevel" < 'PROGRESS'::"ProductionShareLevel" THEN
      NEW."productionLevel" := 'PROGRESS'::"ProductionShareLevel";
    ELSIF NOT NEW."progressShared" AND NEW."productionLevel" >= 'PROGRESS'::"ProductionShareLevel" THEN
      NEW."progressShared" := true;
    END IF;
  ELSIF NEW."productionLevel" IS DISTINCT FROM OLD."productionLevel" AND NEW."progressShared" IS NOT DISTINCT FROM OLD."progressShared" THEN
    NEW."progressShared" := NEW."productionLevel" >= 'PROGRESS'::"ProductionShareLevel";
  ELSIF NEW."progressShared" IS DISTINCT FROM OLD."progressShared" AND NEW."productionLevel" IS NOT DISTINCT FROM OLD."productionLevel" THEN
    NEW."productionLevel" := CASE
      WHEN NOT NEW."progressShared" THEN 'STATUS'::"ProductionShareLevel"
      WHEN NEW."productionLevel" < 'PROGRESS'::"ProductionShareLevel" THEN 'PROGRESS'::"ProductionShareLevel"
      ELSE NEW."productionLevel"
    END;
  END IF;
  IF NEW."progressShared" IS DISTINCT FROM (NEW."productionLevel" >= 'PROGRESS'::"ProductionShareLevel") THEN
    RAISE EXCEPTION 'portal: the portal settings % share production progress exactly from the level PROGRESS on (progressShared follows productionLevel, %)', NEW."id", NEW."productionLevel"
      USING ERRCODE = 'check_violation';
  END IF;
  -- end B-PR-12
  IF NEW."progressShared" AND (TG_OP = 'INSERT' OR NOT OLD."progressShared") THEN
    SELECT p."roles"::text[] INTO party_roles FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND NOT (party_roles && ARRAY['CUSTOMER', 'BRAND']::text[]) THEN
      RAISE EXCEPTION 'portal: production progress is shared only with a customer or a brand (Owner answer C1); party % is %', NEW."partyId", party_roles
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- B-PR-12: the production limits.
  IF NEW."productionUrgentMax" IS NULL OR NEW."productionUrgentMax" NOT BETWEEN 0 AND 20 THEN
    RAISE EXCEPTION 'portal: the portal settings % let 0 to 20 orders be urgent at once, not %', NEW."id", NEW."productionUrgentMax"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."productionSupervisorId" IS NULL) <> (NEW."productionSupervisorSetAt" IS NULL) THEN
    RAISE EXCEPTION 'portal: the portal settings % name a production supervisor together with since when, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."productionBackupId" IS NOT NULL AND (NEW."productionSupervisorId" IS NULL OR NEW."productionBackupId" = NEW."productionSupervisorId") THEN
    RAISE EXCEPTION 'portal: the portal settings % name a backup only beside a production supervisor, and never the supervisor', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."productionAskKinds" IS NULL
     OR EXISTS (SELECT 1 FROM unnest(NEW."productionAskKinds") k WHERE k IS NULL OR k::text NOT IN ('HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'))
     OR cardinality(NEW."productionAskKinds") <> (SELECT count(DISTINCT k) FROM unnest(NEW."productionAskKinds") k) THEN
    RAISE EXCEPTION 'portal: the portal settings % open the production asks HOLD, RESUME, SPLIT_SHIPMENT and SAMPLE_ROUND only, each once (RUSH follows the urgency switch; CHANGE and CANCEL the company''s cut-offs)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."productionSupervisorId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."productionSupervisorId" IS DISTINCT FROM OLD."productionSupervisorId") THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."productionSupervisorId";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'portal: the production supervisor of the portal settings % is an active office person, not one that is % (%)', NEW."id", user_status, user_audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."productionBackupId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."productionBackupId" IS DISTINCT FROM OLD."productionBackupId") THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."productionBackupId";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'portal: the production backup of the portal settings % is an active office person, not one that is % (%)', NEW."id", user_status, user_audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."productionApproverId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."productionApproverId" IS DISTINCT FROM OLD."productionApproverId") THEN
    SELECT u."audience"::text, u."status"::text, u."partyId" INTO user_audience, user_status, user_party FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."productionApproverId";
    IF FOUND AND (user_audience <> 'PARTNER' OR user_status <> 'ACTIVE' OR user_party IS DISTINCT FROM NEW."partyId") THEN
      RAISE EXCEPTION 'portal: the production approver of the portal settings % is an active portal person of its own party', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."productionUrgencyOn" OR cardinality(NEW."productionAskKinds") > 0 OR NEW."productionApproverId" IS NOT NULL
      OR NEW."productionSupervisorId" IS NOT NULL OR NEW."productionBackupId" IS NOT NULL)
     AND (TG_OP = 'INSERT'
          OR (NEW."productionUrgencyOn", NEW."productionAskKinds", NEW."productionApproverId", NEW."productionSupervisorId", NEW."productionBackupId")
             IS DISTINCT FROM (OLD."productionUrgencyOn", OLD."productionAskKinds", OLD."productionApproverId", OLD."productionSupervisorId", OLD."productionBackupId")) THEN
    SELECT p."roles"::text[] INTO party_roles FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND NOT (party_roles && ARRAY['CUSTOMER', 'BRAND']::text[]) THEN
      RAISE EXCEPTION 'portal: production limits (urgency, production asks, approver, supervisor, backup) are set only for a customer or a brand; party % is %', NEW."partyId", party_roles
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- end B-PR-12
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- OrderFreezeRule (B-PR-12: per customer)
-- =====================================================================================================================

DROP INDEX "OrderFreezeRule_one_active";
CREATE UNIQUE INDEX "OrderFreezeRule_one_active" ON "OrderFreezeRule" ("tenantId", "companyId", (COALESCE("partyId", '00000000-0000-0000-0000-000000000000'::uuid)), "field", "frozenFrom") WHERE "active";

CREATE OR REPLACE FUNCTION "factory_order_freeze_rule_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  looser text;
  party_roles text[]; -- B-PR-12
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."field", NEW."frozenFrom", NEW."createdAt", NEW."createdById", NEW."partyId") -- B-PR-12: + partyId
       IS DISTINCT FROM (OLD."companyId", OLD."field", OLD."frozenFrom", OLD."createdAt", OLD."createdById", OLD."partyId") THEN
      RAISE EXCEPTION 'sales: the company, field, stage and creation of freeze rule % never change, nor its customer (switch it off and add another)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- B-PR-12: a customer's own rule names a customer or a brand.
  IF TG_OP = 'INSERT' AND NEW."partyId" IS NOT NULL THEN
    SELECT p."roles"::text[] INTO party_roles FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND NOT (party_roles && ARRAY['CUSTOMER', 'BRAND']::text[]) THEN
      RAISE EXCEPTION 'sales: freeze rule % holds the orders of a customer or a brand; party % is %', NEW."id", NEW."partyId", party_roles
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- end B-PR-12
  IF NOT "factory_recall_words_ok"(NEW."note", 200, false) THEN
    RAISE EXCEPTION 'sales: the words of freeze rule % are one line of at most 200 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."active" THEN
    -- B-PR-12: one set per company, customer (or none) and field; the company's set keeps the key of before (concat_ws skips
    -- a null customer).
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.order_freeze', NEW."tenantId", NEW."companyId", NEW."partyId", NEW."field"), 0));
    SELECT r."frozenFrom"::text INTO looser FROM "OrderFreezeRule" r
     WHERE r."tenantId" = NEW."tenantId" AND r."companyId" = NEW."companyId" AND r."field" = NEW."field" AND r."active" AND r."id" <> NEW."id"
       AND r."partyId" IS NOT DISTINCT FROM NEW."partyId" -- B-PR-12
       AND ((NEW."action" = 'CHANGE_REQUEST' AND r."action" = 'BLOCKED' AND r."frozenFrom" < NEW."frozenFrom")
            OR (NEW."action" = 'BLOCKED' AND r."action" = 'CHANGE_REQUEST' AND r."frozenFrom" > NEW."frozenFrom"))
     ORDER BY r."frozenFrom" LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'sales: freeze rule % (% from %, %) would loosen what an earlier stage blocks: % is % from % on; a later stage never loosens an earlier BLOCKED', NEW."id", NEW."field", NEW."frozenFrom", NEW."action", NEW."field",
        CASE WHEN NEW."action" = 'BLOCKED' THEN 'a change request' ELSE 'BLOCKED' END, looser
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
