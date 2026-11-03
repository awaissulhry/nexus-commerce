-- Written by hand (Prisma does not model triggers, partial indexes or deferred constraint triggers), after the generated
-- 202610318600_plant_care_w2b_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- W2b schema wave 14/16 (B-W2b-86): plant care: statutory and periodic check types, plans and results, the history of a
-- machine's status, clicking dies, the site's lock rules and request routing, a request's progress and routing, a job's
-- one-screen close and the line lead's confirmation, and the floor's photos and voice notes of a request or job (features
-- QHS-167, QHS-173, QHS-179, QHS-180, QHS-183, QHS-189, QHS-190, QHS-205, QHS-219; Owner answer H1; D.Lgs. 81/2008 art. 71
-- c.4, c.8 to c.11). apps/factory-api's modules check all of this first, in words; these rules hold for every login, the
-- owner included. Every refusal is a check_violation (SQLSTATE 23514).
--
-- As in every guards migration: the tenant and site of a row are held by the policies (USING and WITH CHECK) and the
-- references, not here (no trigger compares "tenantId" or "siteId" of the row it guards, so a row moved out of a
-- session's scope meets row-level security first); a rule that reads another row skips a row this session cannot see
-- (another tenant's or site's: the policies refuse that write anyway); an UPDATE that changes nothing passes. A trigger
-- reads only tables (and columns) the role that fires it may read. "Everything but these columns" is compared as jsonb,
-- so a column added later is frozen too unless a later migration names it.
--
-- Earlier functions redefined here, each its whole body:
--   factory_maintenance_request_guard (…_quality_plant_w2a_guards): a technician on the floor acknowledges and is on the
--                                     way, the reporter confirms the machine works, the routing and its escalation; a
--                                     triaged request still takes its progress.
--   factory_maintenance_job_guard     (…_quality_plant_w2a_guards): the failure code and minutes of the hand-back, the line
--                                     lead's confirmation, the check result a job was made from.
--   factory_generated_document_check  (…_quality_problems_w2b_guards): a CHECK_REPORT is of its MachineCheckResult's
--                                     company and site.
-- New triggers on earlier tables: "Machine_status_history" (every status change writes a MachineStatusEvent) and
-- "StoredFile_floor_guard" (what the floor may add to files: the photos and voice notes of a request or job of its site).

CREATE FUNCTION "factory_plant_care_w2b_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'plant: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['MachineCheckType', 'MachineCheckPlan', 'ClickingDie', 'PlantSettings', 'RequestRoutingRule'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_plant_care_w2b_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- An interval of a check: from 1, at most ten years in its unit.
CREATE FUNCTION "factory_plant_interval_ok"(amount integer, unit text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT amount >= 1 AND amount <= CASE unit WHEN 'DAY' THEN 3660 WHEN 'WEEK' THEN 520 WHEN 'MONTH' THEN 120 ELSE 10 END
$$;

-- =====================================================================================================================
-- Statutory and periodic checks (plantcare.prisma)

-- MachineCheckType (QHS-205, QHS-219)
--   UPDATE     the code, the class and the creation never change (plans and results keep them).
--   every row  its words (a code without spaces, Italian and English, the other languages); the law it rests on; an interval
--              from 1 to at most ten years; results kept 3 to 30 years (D.Lgs. 81/2008 art. 71 c.9: at least three).
--   DELETE     refused (retired). TRUNCATE refused.
CREATE FUNCTION "factory_machine_check_type_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plant: check type % is retired, never deleted (its plans and results keep it)', OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."code", NEW."classId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."code", OLD."classId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'plant: the code, class and creation of check type % never change (its plans and results keep them)', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_quality_plant_words_ok"(NEW."code", NEW."labelIt", NEW."labelEn", NEW."labelI18n", NULL, NULL) THEN
    RAISE EXCEPTION 'plant: check type % has a code without spaces, Italian and English words and its other languages as { "<language>": "<words>" }', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."legalBasis") = '' OR NOT "factory_plant_interval_ok"(NEW."defaultInterval", NEW."defaultIntervalUnit"::text)
     OR NEW."retentionYears" < 3 OR NEW."retentionYears" > 30 THEN
    RAISE EXCEPTION 'plant: check type % names the law it rests on, an interval from 1 to at most ten years, and keeps its results 3 to 30 years (D.Lgs. 81/2008 art. 71 c.9: at least three)', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "MachineCheckType_guard" BEFORE INSERT OR UPDATE OR DELETE ON "MachineCheckType"
  FOR EACH ROW EXECUTE FUNCTION "factory_machine_check_type_guard"();

-- MachineCheckPlan (design plant.preventive "Plans")
--   INSERT     an active check type; a machine not retired, of the type's class when the type has one.
--   UPDATE     the company, machine, check type, first due date and creation never change; ACTIVE → ENDED, and an ENDED
--              plan never changes.
--   every row  an interval from 1 to at most ten years; a reminder 0 to 365 days ahead; next due not before the first;
--              ended (when, why) exactly when ENDED. One ACTIVE plan per machine and type (the partial unique index).
--   DELETE     refused (ended). TRUNCATE refused.
CREATE FUNCTION "factory_machine_check_plan_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  check_type record;
  machine record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plant: check plan % is ended, never deleted (its results keep it)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT t."active", t."classId", t."code" INTO check_type FROM "MachineCheckType" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."checkTypeId";
    IF FOUND AND NOT check_type."active" THEN
      RAISE EXCEPTION 'plant: check type % is retired; it takes no new plan', check_type."code"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT m."status"::text AS status, m."classId", m."assetNumber" INTO machine FROM "Machine" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."machineId";
    IF FOUND AND machine.status = 'RETIRED' THEN
      RAISE EXCEPTION 'plant: machine % is retired; it takes no new check plan', machine."assetNumber"
        USING ERRCODE = 'check_violation';
    END IF;
    IF machine."classId" IS NOT NULL AND check_type."classId" IS NOT NULL AND machine."classId" <> check_type."classId" THEN
      RAISE EXCEPTION 'plant: check type % is for another class of machine than %', check_type."code", machine."assetNumber"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."machineId", NEW."checkTypeId", NEW."firstDueOn", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."machineId", OLD."checkTypeId", OLD."firstDueOn", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'plant: the machine, check type, first due date and creation of check plan % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'ENDED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'plant: check plan % is ENDED; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_plant_interval_ok"(NEW."interval", NEW."intervalUnit"::text) OR NEW."reminderDays" < 0 OR NEW."reminderDays" > 365
     OR NEW."nextDueOn" < NEW."firstDueOn" THEN
    RAISE EXCEPTION 'plant: check plan % has an interval from 1 to at most ten years, a reminder 0 to 365 days ahead, and a next due date not before its first', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ENDED') <> (NEW."endedAt" IS NOT NULL) OR (NEW."status" = 'ENDED') <> (btrim(coalesce(NEW."endedReason", '')) <> '') THEN
    RAISE EXCEPTION 'plant: check plan % is % with the wrong ending: ended (when, why) exactly when ENDED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "MachineCheckPlan_guard" BEFORE INSERT OR UPDATE OR DELETE ON "MachineCheckPlan"
  FOR EACH ROW EXECUTE FUNCTION "factory_machine_check_plan_guard"();

CREATE UNIQUE INDEX "MachineCheckPlan_one_active" ON "MachineCheckPlan" ("tenantId", "machineId", "checkTypeId") WHERE "status" = 'ACTIVE';

-- MachineCheckResult (QHS-205, QHS-219; the control register, D.Lgs. 81/2008 art. 71 c.9): append-only, for every login (no
-- update or delete grant either).
--   INSERT     its plan (when given) is of the same machine and check type; who did it; remarks unless PASSED; the next due
--              date after the day; kept at least three years from the check and its type's retention years; a correction
--              names a result of the same machine and type, never itself, with why (each result corrected at most once:
--              the partial unique index).
CREATE FUNCTION "factory_machine_check_result_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'plant: check results are append-only: % on "%" is refused (a wrong result is corrected by a new one that names it)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_machine_check_result_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  plan record;
  retention integer;
  corrected record;
BEGIN
  IF NEW."planId" IS NOT NULL THEN
    SELECT p."machineId", p."checkTypeId" INTO plan FROM "MachineCheckPlan" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."planId";
    IF FOUND AND (plan."machineId", plan."checkTypeId") IS DISTINCT FROM (NEW."machineId", NEW."checkTypeId") THEN
      RAISE EXCEPTION 'plant: check result % is of plan %, so of its machine and check type', NEW."id", NEW."planId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."performedBy") = '' OR (NEW."outcome" <> 'PASSED' AND btrim(coalesce(NEW."remarks", '')) = '') OR btrim(coalesce(NEW."remarks", 'x')) = ''
     OR (NEW."nextDueOn" IS NOT NULL AND NEW."nextDueOn" <= NEW."performedOn") THEN
    RAISE EXCEPTION 'plant: check result % says who did it, what was found unless it PASSED, and a next due date after the day it was done', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT t."retentionYears" INTO retention FROM "MachineCheckType" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."checkTypeId";
  IF NEW."keptUntil" < NEW."performedOn" + make_interval(years => greatest(3, coalesce(retention, 3))) THEN
    RAISE EXCEPTION 'plant: check result % is kept at least % years from the check (D.Lgs. 81/2008 art. 71 c.9: at least three)', NEW."id", greatest(3, coalesce(retention, 3))
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."correctsId" IS NULL) <> (btrim(coalesce(NEW."correctionReason", '')) = '') OR NEW."correctsId" = NEW."id" THEN
    RAISE EXCEPTION 'plant: check result % corrects another result exactly with why, never itself', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."correctsId" IS NOT NULL THEN
    SELECT r."machineId", r."checkTypeId" INTO corrected FROM "MachineCheckResult" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."correctsId";
    IF FOUND AND (corrected."machineId", corrected."checkTypeId") IS DISTINCT FROM (NEW."machineId", NEW."checkTypeId") THEN
      RAISE EXCEPTION 'plant: check result % corrects a result of the same machine and check type', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "MachineCheckResult_check" BEFORE INSERT ON "MachineCheckResult"
  FOR EACH ROW EXECUTE FUNCTION "factory_machine_check_result_check"();
CREATE TRIGGER "MachineCheckResult_append_only" BEFORE UPDATE OR DELETE ON "MachineCheckResult"
  FOR EACH ROW EXECUTE FUNCTION "factory_machine_check_result_append_only"();
CREATE TRIGGER "MachineCheckResult_no_truncate" BEFORE TRUNCATE ON "MachineCheckResult"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_machine_check_result_append_only"();

CREATE UNIQUE INDEX "MachineCheckResult_corrected_once" ON "MachineCheckResult" ("tenantId", "correctsId") WHERE "correctsId" IS NOT NULL;

-- =====================================================================================================================
-- The history of a machine's status (plantcare.prisma; QHS-167)

-- MachineStatusEvent: append-only, for every login (no update or delete grant either).
--   INSERT     a change: to another status than from; the reason not blank when given.
CREATE FUNCTION "factory_machine_status_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'plant: the status history of a machine is append-only: % on "%" is refused', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_machine_status_event_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."toStatus" IS NOT DISTINCT FROM NEW."fromStatus" OR btrim(coalesce(NEW."reason", 'x')) = '' THEN
    RAISE EXCEPTION 'plant: status event % is a change to another status, with a reason that is not blank when given', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "MachineStatusEvent_check" BEFORE INSERT ON "MachineStatusEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_machine_status_event_check"();
CREATE TRIGGER "MachineStatusEvent_append_only" BEFORE UPDATE OR DELETE ON "MachineStatusEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_machine_status_event_append_only"();
CREATE TRIGGER "MachineStatusEvent_no_truncate" BEFORE TRUNCATE ON "MachineStatusEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_machine_status_event_append_only"();

-- Machine: every change of its status writes one MachineStatusEvent in the same statement, for every login (the office,
-- a station's report, a technician's sign-safe or job, the owner): from, to, the machine's statusSince and statusReason.
-- It runs with the rights of the session that moves the machine (the office and the floor of the site may insert events;
-- the floor reads none).
CREATE FUNCTION "factory_machine_status_history"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "MachineStatusEvent" ("id", "tenantId", "companyId", "siteId", "machineId", "fromStatus", "toStatus", "at", "reason")
  VALUES (gen_random_uuid(), NEW."tenantId", NEW."companyId", NEW."siteId", NEW."id", OLD."status", NEW."status", NEW."statusSince",
          NULLIF(btrim(coalesce(NEW."statusReason", '')), ''));
  RETURN NULL;
END
$$;

CREATE TRIGGER "Machine_status_history" AFTER UPDATE OF "status" ON "Machine"
  FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "factory_machine_status_history"();

-- =====================================================================================================================
-- Clicking dies (plantcare.prisma; QHS-173)

-- ClickingDie
--   INSERT     not RETIRED.
--   UPDATE     the company, number, style and creation never change; a RETIRED die changes only its note.
--   every row  a number without spaces; the piece in words; a size of the style's range when given; words not blank when
--              given; a cost from 0.
--   DELETE     refused (retired). TRUNCATE refused.
CREATE FUNCTION "factory_clicking_die_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  style_sizes text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plant: die % is retired, never deleted', OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."condition" = 'RETIRED' THEN
      RAISE EXCEPTION 'plant: die % is registered in use; it is retired later', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."code", NEW."styleId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."code", OLD."styleId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'plant: the company, number, style and creation of die % never change (the number is stamped on it)', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."condition" = 'RETIRED'
       AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'plant: die % is RETIRED; only its note changes', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."code") = '' OR NEW."code" ~ '\s' OR btrim(NEW."piece") = '' OR btrim(coalesce(NEW."size", 'x')) = ''
     OR btrim(coalesce(NEW."rackLocation", 'x')) = '' OR btrim(coalesce(NEW."material", 'x')) = '' OR coalesce(NEW."purchaseCost", 0) < 0 THEN
    RAISE EXCEPTION 'plant: die % has a number without spaces, the piece in words, words that are not blank when given and a cost from 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."size" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."size" IS DISTINCT FROM OLD."size") THEN
    SELECT s."sizes" INTO style_sizes FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND AND NOT (NEW."size" = ANY (style_sizes)) THEN
      RAISE EXCEPTION 'plant: die %: size % is not in its style''s range', NEW."code", NEW."size"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ClickingDie_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ClickingDie"
  FOR EACH ROW EXECUTE FUNCTION "factory_clicking_die_guard"();

-- =====================================================================================================================
-- The site's plant rules and request routing (plantcare.prisma; QHS-179, QHS-183)

-- PlantSettings (design plant.settings "Unsafe lock")
--   UPDATE     the company and creation never change.
--   every row  Owner answer H1: anyone at the station locks, only a technician signs safe. The design's other choices (leads
--              and technicians lock; a safety officer signs safe too) wait for the Owner's word: a later migration lifts
--              this refusal when he gives it.
--   DELETE     refused (a site's rules change, never go). TRUNCATE refused.
CREATE FUNCTION "factory_plant_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plant: the plant rules of a site change, never go (settings %)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'plant: the company and creation of plant settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."lockBy" <> 'ANYONE_AT_STATION' OR NEW."signSafeBy" <> 'TECHNICIANS' THEN
    RAISE EXCEPTION 'plant: anyone at the station locks an unsafe machine and only a technician signs it safe (Owner answer H1; D.Lgs. 81/2008 art. 71); another choice waits for the Owner''s word (settings %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PlantSettings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PlantSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_plant_settings_guard"();

-- RequestRoutingRule (design plant.settings "Request routing and escalation")
--   UPDATE     the company and creation never change.
--   every row  a place from 0; exactly one of a team and a technician; each escalation with its minutes and its person
--              (both or neither), 1 to 1440 minutes, the second only after the first and later than it; a team, technician
--              or person chosen (or changed to) is active.
--   DELETE     a rule no request names (the references refuse the rest: set it inactive). TRUNCATE refused.
CREATE FUNCTION "factory_request_routing_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  team_status text;
  person uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'plant: the company and creation of routing rule % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."seq" < 0 OR (NEW."teamId" IS NULL) = (NEW."technicianId" IS NULL) THEN
    RAISE EXCEPTION 'plant: routing rule % has a place from 0 and sends requests to exactly one of a team and a technician', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."escalateAfterMinutes" IS NULL) <> (NEW."escalateToId" IS NULL)
     OR (NEW."escalateAgainAfterMinutes" IS NULL) <> (NEW."escalateAgainToId" IS NULL)
     OR (NEW."escalateAgainAfterMinutes" IS NOT NULL AND NEW."escalateAfterMinutes" IS NULL)
     OR coalesce(NEW."escalateAfterMinutes", 1) NOT BETWEEN 1 AND 1440
     OR coalesce(NEW."escalateAgainAfterMinutes", 1440) NOT BETWEEN 1 AND 1440
     OR NEW."escalateAgainAfterMinutes" <= NEW."escalateAfterMinutes" THEN
    RAISE EXCEPTION 'plant: routing rule % escalates after 1 to 1440 minutes to one person, and again (later, to one person) only after a first escalation', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."teamId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."teamId" IS DISTINCT FROM OLD."teamId") THEN
    SELECT t."status"::text INTO team_status FROM "Team" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."teamId";
    IF FOUND AND team_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'plant: routing rule % sends requests to an active team', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  FOR person IN
    SELECT p FROM unnest(ARRAY[
      CASE WHEN TG_OP = 'INSERT' OR NEW."technicianId" IS DISTINCT FROM OLD."technicianId" THEN NEW."technicianId" END,
      CASE WHEN TG_OP = 'INSERT' OR NEW."escalateToId" IS DISTINCT FROM OLD."escalateToId" THEN NEW."escalateToId" END,
      CASE WHEN TG_OP = 'INSERT' OR NEW."escalateAgainToId" IS DISTINCT FROM OLD."escalateAgainToId" THEN NEW."escalateAgainToId" END]) AS p
     WHERE p IS NOT NULL
  LOOP
    IF EXISTS (SELECT 1 FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = person AND e."status" <> 'ACTIVE') THEN
      RAISE EXCEPTION 'plant: routing rule % names a person who has left (employee %)', NEW."id", person
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RequestRoutingRule_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RequestRoutingRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_request_routing_rule_guard"();

-- =====================================================================================================================
-- Requests and jobs (plant.prisma): W2a's two functions, redefined whole.

-- MaintenanceRequest (QHS-178, QHS-179, QHS-180, H1)
--   INSERT     NEW, untriaged and not signed safe, nobody on the way, nothing confirmed, not escalated (it may carry where it
--              was routed); a floor session names a worker or the station, never an office user.
--   UPDATE     the machine, whether it is unsafe, who reported it and when (station, tablet) and the creation never
--              change; NEW → ACKNOWLEDGED | JOB_MADE | MERGED | CLOSED, ACKNOWLEDGED → JOB_MADE | MERGED | CLOSED;
--              JOB_MADE, MERGED and CLOSED change only by the sign-safe and the progress (on the way, works again); the
--              acknowledgement, the sign-safe, the on-the-way and the works-again are each set once; the escalation only
--              goes up, each time later. A floor session changes only: the acknowledgement (NEW → ACKNOWLEDGED, as a
--              worker), the on-the-way (as a worker), the works-again (as a worker or the station) and the sign-safe (a
--              technician with the PIN, as a worker); never an office user's column, never the routing.
--   every row  at least one reporter (an office user, a worker, the station) and at most one person; acknowledged from
--              ACKNOWLEDGED on (by at most one person, only with when, never on NEW); its job exactly while JOB_MADE (a job
--              of the same machine), the request it was merged into exactly while MERGED (another of the same machine),
--              closed (when, by whom) exactly when MERGED or CLOSED, why exactly when CLOSED (in words for OTHER); the
--              sign-safe only on an unsafe request, all at once: when, one technician and what was checked; an unsafe
--              request not signed safe is neither merged nor closed, nor confirmed working. On the way: exactly one person
--              with when, set while ACKNOWLEDGED or JOB_MADE. Works again: at most one person (none: the station), only with
--              when, set while JOB_MADE once its job is handed back (or closed), or while MERGED. Routed to at most one of a
--              team and a person, the rule only with one; the escalation level 0 to 2, with when exactly from 1.
--   lock       (at commit) an unsafe request not signed safe keeps its machine DO_NOT_USE (or RETIRED): W2a's
--              "MaintenanceRequest_locks_machine", unchanged.
--   DELETE     refused (closed). TRUNCATE refused.
CREATE OR REPLACE FUNCTION "factory_maintenance_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  -- What a triaged request still takes: the sign-safe and the progress.
  triaged_allowed CONSTANT text[] := ARRAY['tenantId', 'siteId', 'signedSafeAt', 'signedSafeById', 'signedSafeByWorkerId', 'signedSafeNote',
                                           'onTheWayAt', 'onTheWayById', 'onTheWayByWorkerId', 'confirmedWorksAt', 'confirmedWorksById',
                                           'confirmedWorksByWorkerId', 'version', 'updatedAt'];
  -- What the floor changes: never an office user's column, never the routing.
  floor_allowed CONSTANT text[] := ARRAY['tenantId', 'siteId', 'status', 'acknowledgedAt', 'acknowledgedByWorkerId', 'onTheWayAt', 'onTheWayByWorkerId',
                                         'confirmedWorksAt', 'confirmedWorksByWorkerId', 'signedSafeAt', 'signedSafeByWorkerId', 'signedSafeNote',
                                         'version', 'updatedAt'];
  other_machine uuid;
  job_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plant: request % is closed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'NEW' OR NEW."acknowledgedAt" IS NOT NULL OR NEW."jobId" IS NOT NULL OR NEW."mergedIntoId" IS NOT NULL OR NEW."closedAt" IS NOT NULL
       OR NEW."signedSafeAt" IS NOT NULL OR NEW."onTheWayAt" IS NOT NULL OR NEW."confirmedWorksAt" IS NOT NULL OR NEW."escalationLevel" <> 0 THEN
      RAISE EXCEPTION 'plant: request % starts NEW, untriaged and not signed safe, with nobody on the way, nothing confirmed and not escalated', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime' AND NEW."reportedById" IS NOT NULL THEN
      RAISE EXCEPTION 'plant: the floor reports request % as a worker or as the station, never as an office user', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."machineId", NEW."unsafe", NEW."reportedAt", NEW."reportedById", NEW."reportedByWorkerId", NEW."stationId", NEW."deviceId",
        NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."machineId", OLD."unsafe", OLD."reportedAt", OLD."reportedById", OLD."reportedByWorkerId", OLD."stationId", OLD."deviceId",
        OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'plant: the machine of request %, whether it is unsafe, who reported it and when never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT (OLD."status" IN ('NEW', 'ACKNOWLEDGED') AND NEW."status" IN ('ACKNOWLEDGED', 'JOB_MADE', 'MERGED', 'CLOSED')) THEN
      RAISE EXCEPTION 'plant: request % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('JOB_MADE', 'MERGED', 'CLOSED') AND (to_jsonb(NEW) - triaged_allowed) IS DISTINCT FROM (to_jsonb(OLD) - triaged_allowed) THEN
      RAISE EXCEPTION 'plant: request % is %; only its sign-safe and its progress are still written', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."acknowledgedAt" IS NOT NULL
        AND (NEW."acknowledgedAt", NEW."acknowledgedById", NEW."acknowledgedByWorkerId") IS DISTINCT FROM (OLD."acknowledgedAt", OLD."acknowledgedById", OLD."acknowledgedByWorkerId"))
       OR (OLD."signedSafeAt" IS NOT NULL
           AND (NEW."signedSafeAt", NEW."signedSafeById", NEW."signedSafeByWorkerId", NEW."signedSafeNote")
               IS DISTINCT FROM (OLD."signedSafeAt", OLD."signedSafeById", OLD."signedSafeByWorkerId", OLD."signedSafeNote"))
       OR (OLD."onTheWayAt" IS NOT NULL
           AND (NEW."onTheWayAt", NEW."onTheWayById", NEW."onTheWayByWorkerId") IS DISTINCT FROM (OLD."onTheWayAt", OLD."onTheWayById", OLD."onTheWayByWorkerId"))
       OR (OLD."confirmedWorksAt" IS NOT NULL
           AND (NEW."confirmedWorksAt", NEW."confirmedWorksById", NEW."confirmedWorksByWorkerId")
               IS DISTINCT FROM (OLD."confirmedWorksAt", OLD."confirmedWorksById", OLD."confirmedWorksByWorkerId")) THEN
      RAISE EXCEPTION 'plant: the acknowledgement, the sign-safe, the on-the-way and the works-again of request % are each written once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."escalationLevel" < OLD."escalationLevel"
       OR (NEW."escalationLevel" > OLD."escalationLevel" AND OLD."escalatedAt" IS NOT NULL AND NEW."escalatedAt" <= OLD."escalatedAt")
       OR (NEW."escalationLevel" = OLD."escalationLevel" AND NEW."escalatedAt" IS DISTINCT FROM OLD."escalatedAt") THEN
      RAISE EXCEPTION 'plant: request % escalates only further, each time later', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime'
       AND ((to_jsonb(NEW) - floor_allowed) IS DISTINCT FROM (to_jsonb(OLD) - floor_allowed)
            OR (NEW."status" <> OLD."status" AND NOT (OLD."status" = 'NEW' AND NEW."status" = 'ACKNOWLEDGED'))) THEN
      RAISE EXCEPTION 'plant: the floor signs request % safe (a technician with the PIN), acknowledges it, is on the way and confirms the machine works, as a worker; nothing else', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."reportedById" IS NULL AND NEW."reportedByWorkerId" IS NULL AND NEW."stationId" IS NULL)
     OR (NEW."reportedById" IS NOT NULL AND NEW."reportedByWorkerId" IS NOT NULL) THEN
    RAISE EXCEPTION 'plant: request % names who reported it: an office user, a worker or the station (at most one person)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'NEW' AND NEW."acknowledgedAt" IS NOT NULL) OR (NEW."status" = 'ACKNOWLEDGED' AND NEW."acknowledgedAt" IS NULL)
     OR ((NEW."acknowledgedById" IS NOT NULL OR NEW."acknowledgedByWorkerId" IS NOT NULL) AND NEW."acknowledgedAt" IS NULL)
     OR (NEW."acknowledgedById" IS NOT NULL AND NEW."acknowledgedByWorkerId" IS NOT NULL)
     OR (NEW."status" = 'JOB_MADE') <> (NEW."jobId" IS NOT NULL)
     OR (NEW."status" = 'MERGED') <> (NEW."mergedIntoId" IS NOT NULL) OR NEW."mergedIntoId" = NEW."id"
     OR (NEW."status" IN ('MERGED', 'CLOSED')) <> (NEW."closedAt" IS NOT NULL)
     OR (NEW."closedById" IS NOT NULL AND NEW."closedAt" IS NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closeReason" IS NOT NULL)
     OR (NEW."status" <> 'CLOSED' AND NEW."closeNote" IS NOT NULL)
     OR (NEW."closeReason" = 'OTHER' AND btrim(coalesce(NEW."closeNote", '')) = '') THEN
    RAISE EXCEPTION 'plant: request % is % with the wrong triage: acknowledged from ACKNOWLEDGED on (by at most one person), its job exactly while JOB_MADE, the request it joined exactly while MERGED, closed (when) exactly when MERGED or CLOSED, why exactly when CLOSED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."signedSafeAt" IS NOT NULL AND NOT NEW."unsafe")
     OR (NEW."signedSafeAt" IS NULL) <> (NEW."signedSafeById" IS NULL AND NEW."signedSafeByWorkerId" IS NULL)
     OR (NEW."signedSafeById" IS NOT NULL AND NEW."signedSafeByWorkerId" IS NOT NULL)
     OR (NEW."signedSafeAt" IS NULL) <> (btrim(coalesce(NEW."signedSafeNote", '')) = '') THEN
    RAISE EXCEPTION 'plant: request % is signed safe only when it was unsafe, all at once: when, one technician and what was checked (H1)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."unsafe" AND NEW."signedSafeAt" IS NULL AND NEW."status" IN ('MERGED', 'CLOSED') THEN
    RAISE EXCEPTION 'plant: request % locked its machine as unsafe; it is neither merged nor closed before a technician signs the machine safe (H1)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- The progress (QHS-180).
  IF (NEW."onTheWayAt" IS NULL) <> (NEW."onTheWayById" IS NULL AND NEW."onTheWayByWorkerId" IS NULL)
     OR (NEW."onTheWayById" IS NOT NULL AND NEW."onTheWayByWorkerId" IS NOT NULL)
     OR (NEW."confirmedWorksAt" IS NULL AND (NEW."confirmedWorksById" IS NOT NULL OR NEW."confirmedWorksByWorkerId" IS NOT NULL))
     OR (NEW."confirmedWorksById" IS NOT NULL AND NEW."confirmedWorksByWorkerId" IS NOT NULL) THEN
    RAISE EXCEPTION 'plant: request % has the technician on the way with when and exactly one person, and its works-again with when and at most one person (none: the station)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."onTheWayAt" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."onTheWayAt" IS NULL) AND NEW."status" NOT IN ('ACKNOWLEDGED', 'JOB_MADE') THEN
    RAISE EXCEPTION 'plant: a technician is on the way to request % only while it is ACKNOWLEDGED or JOB_MADE, not %', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."confirmedWorksAt" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."confirmedWorksAt" IS NULL) THEN
    IF NEW."unsafe" AND NEW."signedSafeAt" IS NULL THEN
      RAISE EXCEPTION 'plant: request % locked its machine as unsafe; nobody confirms it works before a technician signs it safe (H1)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" NOT IN ('JOB_MADE', 'MERGED') THEN
      RAISE EXCEPTION 'plant: the machine of request % is confirmed working once its job is handed back (JOB_MADE) or the request joined another (MERGED), not while %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'JOB_MADE' THEN
      SELECT j."status"::text INTO job_status FROM "MaintenanceJob" j WHERE j."tenantId" = NEW."tenantId" AND j."id" = NEW."jobId";
      IF FOUND AND job_status NOT IN ('HANDED_BACK', 'CLOSED') THEN
        RAISE EXCEPTION 'plant: the machine of request % is confirmed working once its job % is handed back, not while it is %', NEW."id", NEW."jobId", job_status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  -- The routing (QHS-179).
  IF (NEW."routedTeamId" IS NOT NULL AND NEW."routedEmployeeId" IS NOT NULL)
     OR (NEW."routingRuleId" IS NOT NULL AND NEW."routedTeamId" IS NULL AND NEW."routedEmployeeId" IS NULL)
     OR NEW."escalationLevel" NOT BETWEEN 0 AND 2 OR (NEW."escalationLevel" > 0) <> (NEW."escalatedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'plant: request % is routed to at most one of a team and a person (a rule only with one), and escalated 0 to 2 times, with when exactly from the first', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."jobId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."jobId" IS DISTINCT FROM OLD."jobId") THEN
    SELECT j."machineId" INTO other_machine FROM "MaintenanceJob" j WHERE j."tenantId" = NEW."tenantId" AND j."id" = NEW."jobId";
    IF FOUND AND other_machine <> NEW."machineId" THEN
      RAISE EXCEPTION 'plant: request % is about machine %; its job % is about another machine', NEW."id", NEW."machineId", NEW."jobId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."mergedIntoId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."mergedIntoId" IS DISTINCT FROM OLD."mergedIntoId") THEN
    SELECT r."machineId" INTO other_machine FROM "MaintenanceRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."mergedIntoId";
    IF FOUND AND other_machine <> NEW."machineId" THEN
      RAISE EXCEPTION 'plant: request % joins a request of another machine', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- MaintenanceJob (QHS-184, QHS-190, QHS-205)
--   INSERT     NEW or PLANNED, not started, handed back, closed or cancelled.
--   UPDATE     the company, number, machine, source and creation never change, nor the check result once set; the moves of
--              MaintenanceJobStatus; CLOSED and CANCELLED never change; the start time is set once; the line lead's
--              confirmation is set once, while HANDED_BACK; a floor session (a technician, the line lead) only starts,
--              pauses for parts, hands back (with the failure code and minutes), takes back its work and confirms the
--              machine works (the status among NEW, PLANNED, IN_PROGRESS, WAITING_PARTS and HANDED_BACK, the start, the
--              hand-back and the lead's confirmation as a worker), nothing else.
--   every row  a number and a problem; at most one technician; started from IN_PROGRESS on (never while NEW or PLANNED);
--              the hand-back (when, one person, what was done, the machine after: RUNNING, DO_NOT_USE or RETIRED)
--              exactly while HANDED_BACK or CLOSED, its failure code (upper-case letters, digits, underscores) and minutes
--              (0 to 525600) only then; the lead's confirmation (when, exactly one person) only then; closed exactly when
--              CLOSED (who only with it); cancelled (when, why) exactly when CANCELLED. Handed back RUNNING only once the
--              machine has no unsafe request left that is not signed safe (H1: sign it safe first). A check result named
--              (or newly named) is of the same machine, FAILED or PASSED_WITH_REMARKS, on a STATUTORY_CHECK job.
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE OR REPLACE FUNCTION "factory_maintenance_job_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  floor_allowed CONSTANT text[] := ARRAY['tenantId', 'siteId', 'status', 'startedAt', 'handedBackAt', 'handedBackByWorkerId', 'workDone', 'machineAfter',
                                         'failureCode', 'minutesSpent', 'leadConfirmedAt', 'leadConfirmedByWorkerId', 'version', 'updatedAt'];
  lock_request uuid;
  result record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plant: maintenance job % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('NEW', 'PLANNED') OR NEW."startedAt" IS NOT NULL OR NEW."handedBackAt" IS NOT NULL OR NEW."closedAt" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN
      RAISE EXCEPTION 'plant: maintenance job % starts NEW or PLANNED, not started', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."machineId", NEW."source", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."number", OLD."machineId", OLD."source", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'plant: the company, number, machine, source and creation of maintenance job % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'plant: maintenance job % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'NEW' AND NEW."status" IN ('PLANNED', 'IN_PROGRESS', 'CANCELLED'))
                OR (OLD."status" = 'PLANNED' AND NEW."status" IN ('NEW', 'IN_PROGRESS', 'CANCELLED'))
                OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('WAITING_PARTS', 'HANDED_BACK', 'CANCELLED'))
                OR (OLD."status" = 'WAITING_PARTS' AND NEW."status" IN ('IN_PROGRESS', 'CANCELLED'))
                OR (OLD."status" = 'HANDED_BACK' AND NEW."status" IN ('IN_PROGRESS', 'CLOSED'))) THEN
      RAISE EXCEPTION 'plant: maintenance job % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."startedAt" IS NOT NULL AND NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
      RAISE EXCEPTION 'plant: maintenance job % started at %; its start is set once', OLD."id", OLD."startedAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."checkResultId" IS NOT NULL AND NEW."checkResultId" IS DISTINCT FROM OLD."checkResultId" THEN
      RAISE EXCEPTION 'plant: maintenance job % was made from check result %; that never changes', OLD."id", OLD."checkResultId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."leadConfirmedAt" IS NOT NULL AND NEW."leadConfirmedAt" IS NOT NULL
        AND (NEW."leadConfirmedAt", NEW."leadConfirmedById", NEW."leadConfirmedByWorkerId") IS DISTINCT FROM (OLD."leadConfirmedAt", OLD."leadConfirmedById", OLD."leadConfirmedByWorkerId"))
       OR (OLD."leadConfirmedAt" IS NULL AND NEW."leadConfirmedAt" IS NOT NULL AND OLD."status" <> 'HANDED_BACK') THEN
      RAISE EXCEPTION 'plant: the line lead confirms maintenance job % once, while it is HANDED_BACK', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime'
       AND ((to_jsonb(NEW) - floor_allowed) IS DISTINCT FROM (to_jsonb(OLD) - floor_allowed) OR NEW."status" IN ('CLOSED', 'CANCELLED')) THEN
      RAISE EXCEPTION 'plant: the floor starts, pauses, hands back and confirms maintenance job % (a technician, the line lead); closing, cancelling and planning it are the office''s', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."number") = '' OR btrim(NEW."problem") = '' OR (NEW."assigneeId" IS NOT NULL AND NEW."assigneeWorkerId" IS NOT NULL) THEN
    RAISE EXCEPTION 'plant: maintenance job % has a number, a problem and at most one technician', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('NEW', 'PLANNED') AND NEW."startedAt" IS NOT NULL)
     OR (NEW."status" IN ('IN_PROGRESS', 'WAITING_PARTS', 'HANDED_BACK', 'CLOSED') AND NEW."startedAt" IS NULL) THEN
    RAISE EXCEPTION 'plant: maintenance job % is % with the wrong start: started from IN_PROGRESS on, never while NEW or PLANNED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('HANDED_BACK', 'CLOSED')) <> (NEW."handedBackAt" IS NOT NULL)
     OR (NEW."status" IN ('HANDED_BACK', 'CLOSED')) <> (NEW."machineAfter" IS NOT NULL)
     OR (NEW."status" IN ('HANDED_BACK', 'CLOSED')) <> (btrim(coalesce(NEW."workDone", '')) <> '')
     OR (NEW."status" IN ('HANDED_BACK', 'CLOSED')) <> ((NEW."handedBackById" IS NULL) <> (NEW."handedBackByWorkerId" IS NULL))
     OR (NEW."status" NOT IN ('HANDED_BACK', 'CLOSED') AND (NEW."handedBackById" IS NOT NULL OR NEW."handedBackByWorkerId" IS NOT NULL))
     OR (NEW."machineAfter" IS NOT NULL AND NEW."machineAfter" NOT IN ('RUNNING', 'DO_NOT_USE', 'RETIRED')) THEN
    RAISE EXCEPTION 'plant: maintenance job % is % with the wrong hand-back: exactly while HANDED_BACK or CLOSED, with when, one person, what was done and the machine after (RUNNING, DO_NOT_USE or RETIRED)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  -- The one-screen close (QHS-190) and the line lead's confirmation (QHS-180, QHS-191): part of the hand-back.
  IF (NEW."status" NOT IN ('HANDED_BACK', 'CLOSED')
      AND (NEW."failureCode" IS NOT NULL OR NEW."minutesSpent" IS NOT NULL OR NEW."leadConfirmedAt" IS NOT NULL))
     OR NEW."failureCode" !~ '^[A-Z][A-Z0-9_]*$'
     OR NEW."minutesSpent" NOT BETWEEN 0 AND 525600
     OR (NEW."leadConfirmedAt" IS NULL) <> (NEW."leadConfirmedById" IS NULL AND NEW."leadConfirmedByWorkerId" IS NULL)
     OR (NEW."leadConfirmedById" IS NOT NULL AND NEW."leadConfirmedByWorkerId" IS NOT NULL) THEN
    RAISE EXCEPTION 'plant: maintenance job % has its failure code (upper-case letters, digits, underscores), its minutes (0 to 525600) and the line lead''s confirmation (when, exactly one person) only while HANDED_BACK or CLOSED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."closedById" IS NOT NULL AND NEW."closedAt" IS NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'plant: maintenance job % is % with the wrong closing or cancellation', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."machineAfter" = 'RUNNING' AND NEW."status" IN ('HANDED_BACK', 'CLOSED') AND (TG_OP = 'INSERT' OR OLD."status" NOT IN ('HANDED_BACK', 'CLOSED') OR OLD."machineAfter" IS DISTINCT FROM 'RUNNING') THEN
    lock_request := "factory_machine_lock_of"(NEW."tenantId", NEW."machineId");
    IF lock_request IS NOT NULL THEN
      RAISE EXCEPTION 'plant: maintenance job % hands machine % back running, but request % locked it as unsafe and no technician signed it safe yet (H1: sign it safe first)', NEW."id", NEW."machineId", lock_request
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- A job made from a check (QHS-205: a failed check makes the job).
  IF NEW."checkResultId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."checkResultId" IS NULL) THEN
    IF NEW."source" <> 'STATUTORY_CHECK' THEN
      RAISE EXCEPTION 'plant: maintenance job % names a check result, so its source is STATUTORY_CHECK', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT r."machineId", r."outcome"::text AS outcome INTO result FROM "MachineCheckResult" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."checkResultId";
    IF FOUND AND (result."machineId" <> NEW."machineId" OR result.outcome = 'PASSED') THEN
      RAISE EXCEPTION 'plant: maintenance job % is made from a failed or remarked check of its own machine', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- Files (files.prisma): what the floor may add (QHS-189)

-- StoredFile, for a floor session only (the office's and the system's files keep W2a's rules alone, …_files_guards):
--   INSERT     a PHOTO or AUDIO file of a maintenance request or job of the session's site and company (a job neither
--              CLOSED nor CANCELLED, a request neither MERGED nor CLOSED), shared with the office and that floor only,
--              announced (PENDING_UPLOAD), with no office user, no retention date and no category but BEFORE_WORK or
--              AFTER_WORK.
--   UPDATE     only such a file, and only its confirmation: PENDING_UPLOAD → AVAILABLE | QUARANTINED (with its time or
--              reason), the scan NOT_SCANNED → PENDING; nothing else of any file.
-- A row outside the session's site is left to the policies (they refuse it).
CREATE FUNCTION "factory_stored_file_floor_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  floor_allowed CONSTANT text[] := ARRAY['tenantId', 'floorSiteId', 'status', 'availableAt', 'quarantineReason', 'scanStatus', 'version', 'updatedAt'];
  record_company uuid;
  record_site uuid;
  record_status text;
BEGIN
  IF current_user <> 'factory_floor_runtime' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NEW."floorSiteId") IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."kind" NOT IN ('PHOTO', 'AUDIO') OR OLD."recordType" NOT IN ('MaintenanceRequest', 'MaintenanceJob')
       OR (to_jsonb(NEW) - floor_allowed) IS DISTINCT FROM (to_jsonb(OLD) - floor_allowed)
       OR (NEW."status" <> OLD."status" AND NOT (OLD."status" = 'PENDING_UPLOAD' AND NEW."status" IN ('AVAILABLE', 'QUARANTINED')))
       OR (NEW."scanStatus" <> OLD."scanStatus" AND NOT (OLD."scanStatus" = 'NOT_SCANNED' AND NEW."scanStatus" = 'PENDING')) THEN
      RAISE EXCEPTION 'files: the floor confirms the upload of its own photos and voice notes of a maintenance request or job, nothing else (file %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."kind" NOT IN ('PHOTO', 'AUDIO') OR NEW."recordType" NOT IN ('MaintenanceRequest', 'MaintenanceJob')
     OR NOT (NEW."visibility" @> ARRAY['OFFICE', 'FLOOR']::"FileAudience"[] AND NEW."visibility" <@ ARRAY['OFFICE', 'FLOOR']::"FileAudience"[])
     OR NEW."status" <> 'PENDING_UPLOAD' OR NEW."createdById" IS NOT NULL OR NEW."retainUntil" IS NOT NULL
     OR (NEW."category" IS NOT NULL AND NEW."category" NOT IN ('BEFORE_WORK', 'AFTER_WORK')) THEN
    RAISE EXCEPTION 'files: the floor adds only the photos and voice notes of a maintenance request or job, shared with the office and its floor, announced first (file %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."recordType" = 'MaintenanceJob' THEN
    SELECT j."companyId", j."siteId", j."status"::text INTO record_company, record_site, record_status FROM "MaintenanceJob" j WHERE j."tenantId" = NEW."tenantId" AND j."id" = NEW."recordId";
  ELSE
    SELECT r."companyId", r."siteId", r."status"::text INTO record_company, record_site, record_status FROM "MaintenanceRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
  END IF;
  IF NOT FOUND OR (record_company, record_site) IS DISTINCT FROM (NEW."companyId", NEW."floorSiteId") OR record_status IN ('CLOSED', 'CANCELLED', 'MERGED') THEN
    RAISE EXCEPTION 'files: file % is a photo or voice note of an open maintenance request or job of this site and its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "StoredFile_floor_guard" BEFORE INSERT OR UPDATE ON "StoredFile"
  FOR EACH ROW EXECUTE FUNCTION "factory_stored_file_floor_guard"();

-- =====================================================================================================================
-- Generated documents (gendocs.prisma): a check report is of its result's company and site.

CREATE OR REPLACE FUNCTION "factory_generated_document_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_company uuid;
  record_site uuid;
  file record;
BEGIN
  IF NEW."version" < 1 OR NEW."fingerprint" !~ '^[0-9a-f]{64}$' OR NEW."language" !~ '^[a-z]{2}$'
     OR btrim(coalesce(NEW."layout", 'x')) = '' OR btrim(coalesce(NEW."number", 'x')) = '' THEN
    RAISE EXCEPTION 'documents: generated document % has a version from 1, a SHA-256 fingerprint (lower-case hex), its two-letter language and, when given, a layout and a number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((NEW."kind" = 'PACKING_LIST' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'CLAIM_LETTER' AND NEW."recordType" = 'SupplierClaim')
          OR (NEW."kind" = 'JOB_SHEET' AND NEW."recordType" IN ('SubcontractOrder', 'MaintenanceJob'))
          OR (NEW."kind" = 'RMA_SHEET' AND NEW."recordType" = 'ReturnAuthorisation')
          OR (NEW."kind" = 'INSPECTION_REPORT' AND NEW."recordType" IN ('Inspection', 'IncomingInspection'))
          OR (NEW."kind" = 'CERTIFICATE_OF_CONFORMITY' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'NCR_REPORT' AND NEW."recordType" = 'Nonconformance')
          OR (NEW."kind" = 'EIGHT_D' AND NEW."recordType" = 'Capa')
          OR (NEW."kind" = 'COMPLAINT_ANSWER' AND NEW."recordType" = 'Complaint')
          OR (NEW."kind" = 'CHECK_REPORT' AND NEW."recordType" = 'MachineCheckResult')
          OR (NEW."kind" = 'DVR_FROZEN' AND NEW."recordType" = 'RiskAssessmentVersion')
          OR (NEW."kind" = 'PPE_RECEIPT' AND NEW."recordType" = 'PpeIssue')) THEN
    RAISE EXCEPTION 'documents: generated document % is a % of a %; a packing list is a Shipment''s, a claim letter a SupplierClaim''s, a job sheet a SubcontractOrder''s or a MaintenanceJob''s, an RMA sheet a ReturnAuthorisation''s, a certificate of conformity a Shipment''s, an inspection report an Inspection''s or an IncomingInspection''s, an NCR report a Nonconformance''s, an 8D a Capa''s, an answer letter a Complaint''s, a check report a MachineCheckResult''s, a frozen risk assessment a RiskAssessmentVersion''s, a PPE receipt a PpeIssue''s', NEW."id", NEW."kind", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  CASE NEW."recordType"
    -- W2b (B-W2b-79): these tables come with wave 15, which adds its WHEN here; until then the file below is the check.
    WHEN 'RiskAssessmentVersion', 'PpeIssue' THEN
      PERFORM 1 WHERE false;
    -- W2b wave 14/16 (B-W2b-86): a check report is of its result's company and site.
    WHEN 'MachineCheckResult' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "MachineCheckResult" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- A record of the whole company has no site, and neither has its document.
    WHEN 'Capa' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "Capa" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Complaint' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "Complaint" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Inspection' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Inspection" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'IncomingInspection' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "IncomingInspection" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Nonconformance' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Nonconformance" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Shipment' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Shipment" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'SupplierClaim' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "SupplierClaim" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'SubcontractOrder' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "SubcontractOrder" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'MaintenanceJob' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "MaintenanceJob" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    ELSE
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "ReturnAuthorisation" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
  END CASE;
  IF FOUND AND (record_company, record_site) IS DISTINCT FROM (NEW."companyId", NEW."siteId") THEN
    RAISE EXCEPTION 'documents: generated document % is of the company and site of its % %', NEW."id", NEW."recordType", NEW."recordId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT f."recordType", f."recordId", f."companyId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF FOUND AND (file."recordType", file."recordId", file."companyId") IS DISTINCT FROM (NEW."recordType", NEW."recordId", NEW."companyId") THEN
    RAISE EXCEPTION 'documents: the file of generated document % is a file of its own record (% %) and company', NEW."id", NEW."recordType", NEW."recordId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
