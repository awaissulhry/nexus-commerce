-- Written by hand (Prisma does not model triggers), after 202611180102_order_apply_policies and before its own policy migration;
-- no schema folder of its own. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The sales page's second schema wave, guard only ("sales page 2/2", B-SA-005b; lead picks Round 5b; found by sa-8 for
-- B-SA-046): a customer's ask-kinds switch (PortalSettings.productionAskKinds) may open the design change. apps/factory-api
-- checks the list first and answers in words (factory-domain production-brand/kinds askKindsProblems, the same list); this rule
-- is the last word, for every login, the owner included. The refusal is check_violation (SQLSTATE 23514); its words name no
-- other customer (the brand wall: "One brand must not be able to see anything related to any other brand").
--
-- PortalSettings  it redefines …_production_wave5_guards' factory_portal_settings_guard (B-PR-40's body, the newest), word for
--                 word but for the lines marked B-SA-005b: the production asks HOLD, RESUME, SPLIT_SHIPMENT and SAMPLE_ROUND and
--                 the design change DESIGN (the OrderChangeRequestKind value of …_order_apply_schema, compared as text), each
--                 once. Every other rule as it was. Its trigger stays as it is. PortalSettings stays office only: the policy
--                 migration after this file gives the partner role no grant on it. No model changes.

-- ---------------------------------------------------------------------------------------------------------------------
-- PortalSettings (PLT-006; Owner answer C1; B-PR-12; B-PR-40; B-SA-005b)
--   UPDATE     an UPDATE that changes nothing passes; the party and the creation never change.
--   every row  at most 1 to 1000 people, or no limit; the allowed partner roles by their keys, each once (a list, maybe
--              empty); production progress (the level PROGRESS or more) shared only with a customer or a brand (checked when
--              the level is raised to it). B-PR-12: the production limits.
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
  -- B-PR-40: production progress is the level's (PROGRESS or more), checked when a row is made at it or the level is raised to
  -- it; the old switch kept in step with it is dropped.
  IF NEW."productionLevel" >= 'PROGRESS'::"ProductionShareLevel" AND (TG_OP = 'INSERT' OR OLD."productionLevel" < 'PROGRESS'::"ProductionShareLevel") THEN
    SELECT p."roles"::text[] INTO party_roles FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND NOT (party_roles && ARRAY['CUSTOMER', 'BRAND']::text[]) THEN
      RAISE EXCEPTION 'portal: production progress is shared only with a customer or a brand (Owner answer C1); party % is %', NEW."partyId", party_roles
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- end B-PR-40
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
  -- B-SA-005b: the design change DESIGN may be opened too (compared as text, as every other kind here).
  IF NEW."productionAskKinds" IS NULL
     OR EXISTS (SELECT 1 FROM unnest(NEW."productionAskKinds") k WHERE k IS NULL OR k::text NOT IN ('HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND', 'DESIGN'))
     OR cardinality(NEW."productionAskKinds") <> (SELECT count(DISTINCT k) FROM unnest(NEW."productionAskKinds") k) THEN
    RAISE EXCEPTION 'portal: the portal settings % open the production asks HOLD, RESUME, SPLIT_SHIPMENT and SAMPLE_ROUND and the design change DESIGN only, each once (RUSH follows the urgency switch; CHANGE and CANCEL the company''s cut-offs)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- end B-SA-005b
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
