-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202610318800_protected_safety_w2b_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- W2b schema wave 16/16 (B-W2b-91): protected safety data. Health surveillance plans per role, the visits a person is due,
-- the doctor's fitness judgements (outcome and task limits only), the view log of protected records (append-only),
-- incidents, near misses and hazards with the people involved, their actions and the INAIL filings, the chemical register
-- and its safety data sheets (features QHS-252, QHS-253, QHS-254, QHS-256, QHS-265, QHS-268, QHS-270, QHS-277, QHS-278;
-- D.Lgs. 81/2008 arts. 18 c.1 r, 25, 41, 223; GDPR art. 9). apps/factory-api's modules/safety checks all of this first, in
-- words; these rules hold for every login, the owner included. Every refusal is a check_violation (SQLSTATE 23514).
--
-- As in every guards migration: the tenant and site of a row are held by the policies (USING and WITH CHECK) and the
-- references, not here; a row outside the session's scope (another tenant's, or for a floor session another site's) is left
-- to the policies, which refuse it: each guard returns at once for it ("factory_quality_plant_in_scope", …_quality_plant_
-- w2a_guards), so a check never speaks before row-level security. A rule that reads another row skips a row this session
-- cannot see; an UPDATE that changes nothing passes. A trigger reads only tables the role that fires it may read: a floor
-- session reads none of the incident tables, so the rules that read the incident speak for the office only (the floor
-- writes the people involved with its report, in the same command). "Everything but these columns" is compared as jsonb, so
-- a column added later is frozen too unless a later migration names it. "Today" is Europe/Rome's (factory_people_today).
--
-- No clinical text: the health rows hold fixed words (an outcome, a type, a reason from a list) and dates; the only words
-- are the task limits the doctor wrote for the task (at most 1000 characters) and a visit's place. An injury is fixed words
-- too. What the database cannot read (whether the task limits name a reason) the API's form says ("Write the task limit
-- only … Never the medical reason") and the roles reading it are HR and the safety roles.
--
-- Beyond the new tables (NEW TRIGGERS on tables of earlier waves; no earlier function touched):
--   "StoredFile_protected_office_only"  a file of a visit, a judgement, an incident, a person involved or an INAIL filing is
--                                       the office's only: never shared with the floor, a portal or a link.
--   "SearchEntry_not_protected"         no search entry of a health plan, visit, judgement, view, person involved or filing.
-- REDEFINED, from their whole latest bodies (202610316801_inspection_plans_w2b_guards; rules and words kept, INCIDENT among the
-- floor's document kinds; the triggers stay):
--   factory_number_series_floor_guard, factory_number_allocation_floor_guard.
-- USED FROM EARLIER WAVES, as they are: "factory_people_today" (…_people_w2b_guards), "factory_quality_plant_in_scope"
-- (…_quality_plant_w2a_guards), "factory_safety_text_ok" and "factory_safety_code_ok" (…_safety_w2b_guards),
-- "factory_document_number_guard" (…_numbering_floor_documents_guards).

CREATE FUNCTION "factory_protected_safety_w2b_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'protected safety data: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['HealthPlan', 'HealthVisit', 'FitnessJudgement', 'Incident', 'IncidentPerson', 'IncidentAction', 'InailFiling', 'Chemical',
                              'SafetyDataSheet'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_protected_safety_w2b_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- Words of at most `longest` characters, not blank (NULL: not given, which the caller allows or not).
CREATE FUNCTION "factory_protected_words_ok"(words text, longest integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT words IS NULL OR (btrim(words) <> '' AND char_length(words) <= longest)
$$;

-- =====================================================================================================================
-- HealthPlan (QHS-252)
--   every row  its key starts `plan:<role sheet>` (one plan per role); a needed plan has its frequency, 1 to 60 months; a plan
--              that is not needed has neither a frequency nor an end-of-employment visit; set by the doctor today at the
--              latest; the doctor named is a DOCTOR appointment.
--   INSERT     ACTIVE, of an ACTIVE role sheet.
--   UPDATE     the company, role sheet, key and creation never change.
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_health_plan_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['needed', 'frequencyMonths', 'endOfEmploymentVisit', 'setOn', 'doctorAppointmentId', 'status', 'version', 'updatedAt'];
  sheet_status text;
  appointed text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'health: plan % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NEW."siteId") IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF position(('plan:' || NEW."roleSheetId"::text) IN NEW."key") <> 1 THEN
    RAISE EXCEPTION 'health: plan % has the key plan:<its role sheet> (one plan per role)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."needed" AND (NEW."frequencyMonths" IS NULL OR NEW."frequencyMonths" NOT BETWEEN 1 AND 60))
     OR (NOT NEW."needed" AND (NEW."frequencyMonths" IS NOT NULL OR NEW."endOfEmploymentVisit")) THEN
    RAISE EXCEPTION 'health: plan % asks a visit every 1 to 60 months when the role needs surveillance, and no visit when it does not', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."setOn" > "factory_people_today"() THEN
    RAISE EXCEPTION 'health: plan % was set by the doctor today at the latest, not %', NEW."id", NEW."setOn"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."doctorAppointmentId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."doctorAppointmentId" IS DISTINCT FROM OLD."doctorAppointmentId") THEN
    SELECT a."role"::text INTO appointed FROM "SafetyAppointment" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."doctorAppointmentId";
    IF FOUND AND appointed <> 'DOCTOR' THEN
      RAISE EXCEPTION 'health: plan % names the occupational doctor''s appointment, not a % one', NEW."id", appointed
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'health: plan % starts ACTIVE', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT r."status"::text INTO sheet_status FROM "RoleSheet" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."roleSheetId";
    IF FOUND AND sheet_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'health: plan % is for an ACTIVE role sheet (% is %)', NEW."id", NEW."roleSheetId", sheet_status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'health: the company, role sheet, key and creation of plan % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "HealthPlan_guard" BEFORE INSERT OR UPDATE OR DELETE ON "HealthPlan"
  FOR EACH ROW EXECUTE FUNCTION "factory_health_plan_guard"();

-- =====================================================================================================================
-- HealthVisit (QHS-253; art. 41 c.2)
--   every row  a return visit carries the absence's length in days, above 60 and at most 3650, and only a return visit
--              carries one; a change of task names the new role sheet; the booking (day, when, by whom) is all or none, the
--              place only with it (at most 200 characters); BOOKED has a booking, DUE none; DONE exactly with the day it
--              took place (today at the latest); CANCELLED exactly with when, by whom and the reason.
--   INSERT     DUE, BOOKED or DONE (a visit recorded after it took place); a plan that asks visits.
--   UPDATE     the company, person, type, plan, role sheet, absence and creation never change; DUE ↔ BOOKED → DONE |
--              CANCELLED; DONE and CANCELLED are final.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_health_visit_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  movable CONSTANT text[] := ARRAY['dueOn', 'status', 'bookedOn', 'bookedPlace', 'bookedAt', 'bookedById', 'doneOn', 'cancelledAt', 'cancelledById', 'cancelReason',
                                   'version', 'updatedAt'];
  plan_needed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'health: visit % is done or cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NULL) IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF (NEW."type" = 'RETURN_AFTER_ABSENCE') <> (NEW."absenceDays" IS NOT NULL) OR coalesce(NEW."absenceDays" NOT BETWEEN 61 AND 3650, false) THEN
    RAISE EXCEPTION 'health: visit % carries an absence''s length in days exactly when it is a return after more than 60 days of absence (D.Lgs. 81/2008 art. 41 c.2 e-ter), above 60 and at most 3650; nothing else of the absence', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."type" = 'CHANGE_OF_TASK' AND NEW."roleSheetId" IS NULL THEN
    RAISE EXCEPTION 'health: change-of-task visit % names the new role sheet', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."bookedOn" IS NULL) <> (NEW."bookedAt" IS NULL) OR (NEW."bookedOn" IS NULL) <> (NEW."bookedById" IS NULL)
     OR (NEW."bookedPlace" IS NOT NULL AND NEW."bookedOn" IS NULL) OR NOT "factory_protected_words_ok"(NEW."bookedPlace", 200)
     OR (NEW."status" = 'BOOKED' AND NEW."bookedOn" IS NULL) OR (NEW."status" = 'DUE' AND NEW."bookedOn" IS NOT NULL) THEN
    RAISE EXCEPTION 'health: visit % is BOOKED with its day, when and by whom it was booked (the place, at most 200 characters, only with them), and DUE without a booking', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DONE') <> (NEW."doneOn" IS NOT NULL) OR coalesce(NEW."doneOn" > "factory_people_today"(), false) THEN
    RAISE EXCEPTION 'health: visit % is DONE exactly with the day it took place, today at the latest', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledById" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'health: visit % is CANCELLED exactly with when, by whom and the reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'health: visit % starts DUE, BOOKED or DONE (a visit recorded after it took place)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."planId" IS NOT NULL THEN
      SELECT p."needed" INTO plan_needed FROM "HealthPlan" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."planId";
      IF FOUND AND NOT plan_needed THEN
        RAISE EXCEPTION 'health: visit % is planned from a plan that asks visits (plan % says the role needs none)', NEW."id", NEW."planId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'health: the company, person, type, plan, role sheet, absence and creation of visit % never change; a different visit is a new one', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('DONE', 'CANCELLED') THEN
    RAISE EXCEPTION 'health: visit % is %; it no longer changes', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "HealthVisit_guard" BEFORE INSERT OR UPDATE OR DELETE ON "HealthVisit"
  FOR EACH ROW EXECUTE FUNCTION "factory_health_visit_guard"();

-- =====================================================================================================================
-- FitnessJudgement (QHS-254; art. 41 c.6)
--   every row  task limits exactly for FIT_WITH_LIMITS (not blank, at most 1000 characters; a voided one may have lost them);
--              an until-day exactly for TEMPORARILY_UNFIT, after the judgement's day; it expires after its day, and an UNFIT
--              judgement does not expire; the void (when, by whom, the reason) is all or none.
--   INSERT     dated today at the latest; not voided; its visit (of the same person: the reference) is not CANCELLED; the
--              doctor named is a DOCTOR appointment.
--   UPDATE     only the void, once: its time, who and the reason, and (only then) the task limits cleared; nothing else ever
--              changes.
--   DELETE     refused (voided). TRUNCATE refused.
--   one judgement not voided per visit: the partial unique index "FitnessJudgement_one_per_visit".
CREATE FUNCTION "factory_fitness_judgement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  movable CONSTANT text[] := ARRAY['voidedAt', 'voidedById', 'voidReason', 'taskLimits', 'version', 'updatedAt'];
  visit_status text;
  appointed text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'health: judgement % is voided, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NULL) IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF (NEW."taskLimits" IS NOT NULL AND NEW."outcome" <> 'FIT_WITH_LIMITS')
     OR (NEW."outcome" = 'FIT_WITH_LIMITS' AND NEW."taskLimits" IS NULL AND NEW."voidedAt" IS NULL)
     OR NOT "factory_protected_words_ok"(NEW."taskLimits", 1000) THEN
    RAISE EXCEPTION 'health: judgement % carries task limits (at most 1000 characters: the limit for the task, never the medical reason) exactly when it is FIT_WITH_LIMITS', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."outcome" = 'TEMPORARILY_UNFIT') <> (NEW."unfitUntil" IS NOT NULL) OR coalesce(NEW."unfitUntil" <= NEW."judgedOn", false) THEN
    RAISE EXCEPTION 'health: judgement % says until when exactly when it is TEMPORARILY_UNFIT, a day after the judgement''s', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(NEW."expiresOn" <= NEW."judgedOn", false) OR (NEW."outcome" = 'UNFIT' AND NEW."expiresOn" IS NOT NULL) THEN
    RAISE EXCEPTION 'health: judgement % expires after its day, and an UNFIT judgement does not expire', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."voidedAt" IS NULL) <> (NEW."voidedById" IS NULL) OR (NEW."voidedAt" IS NULL) <> (NEW."voidReason" IS NULL) THEN
    RAISE EXCEPTION 'health: the void of judgement % has its time, who voided it and the reason, all together', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."judgedOn" > "factory_people_today"() OR NEW."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'health: judgement % is recorded dated today at the latest (not %), and not voided', NEW."id", NEW."judgedOn"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."visitId" IS NOT NULL THEN
      SELECT v."status"::text INTO visit_status FROM "HealthVisit" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."visitId";
      IF FOUND AND visit_status = 'CANCELLED' THEN
        RAISE EXCEPTION 'health: judgement % comes from a visit that took place, not from cancelled visit %', NEW."id", NEW."visitId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."doctorAppointmentId" IS NOT NULL THEN
      SELECT a."role"::text INTO appointed FROM "SafetyAppointment" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."doctorAppointmentId";
      IF FOUND AND appointed <> 'DOCTOR' THEN
        RAISE EXCEPTION 'health: judgement % names the occupational doctor''s appointment, not a % one', NEW."id", appointed
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) OR OLD."voidedAt" IS NOT NULL
     OR NEW."voidedAt" IS NULL
     OR (NEW."taskLimits" IS DISTINCT FROM OLD."taskLimits" AND NEW."taskLimits" IS NOT NULL) THEN
    RAISE EXCEPTION 'health: judgement % never changes; a wrong one is voided once (its task limits may be cleared then) and recorded again', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "FitnessJudgement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FitnessJudgement"
  FOR EACH ROW EXECUTE FUNCTION "factory_fitness_judgement_guard"();

CREATE UNIQUE INDEX "FitnessJudgement_one_per_visit" ON "FitnessJudgement" ("tenantId", "visitId") WHERE "visitId" IS NOT NULL AND "voidedAt" IS NULL;

-- =====================================================================================================================
-- ProtectedView (QHS-256, QHS-270), append-only
--   INSERT     a list (INCIDENT_PEOPLE_LIST, HEALTH_VISIT_LIST) names no record and is a LIST or a PRINT; a record is named, and
--              OPEN, COPY or PRINT; the record (when this session sees it) is of the view's company and person.
--   UPDATE, DELETE, TRUNCATE  refused for every login.
CREATE FUNCTION "factory_protected_view_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'protected safety data: a view of a protected record is never changed or removed (%)', TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_protected_view_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_company uuid;
  record_person uuid;
BEGIN
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NULL) IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF NEW."recordType" IN ('INCIDENT_PEOPLE_LIST', 'HEALTH_VISIT_LIST') THEN
    IF NEW."recordId" IS NOT NULL OR NEW."what" NOT IN ('LIST', 'PRINT') THEN
      RAISE EXCEPTION 'protected safety data: view % of a list names no record and is a LIST or a PRINT', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."recordId" IS NULL OR NEW."what" = 'LIST' THEN
    RAISE EXCEPTION 'protected safety data: view % of a % names the record, and is OPEN, COPY or PRINT', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."recordType" = 'HEALTH_VISIT' THEN
    SELECT v."companyId", v."employeeId" INTO record_company, record_person FROM "HealthVisit" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."recordId";
  ELSIF NEW."recordType" = 'FITNESS_JUDGEMENT' THEN
    SELECT j."companyId", j."employeeId" INTO record_company, record_person FROM "FitnessJudgement" j WHERE j."tenantId" = NEW."tenantId" AND j."id" = NEW."recordId";
  ELSIF NEW."recordType" = 'INCIDENT_PERSON' THEN
    SELECT i."companyId", p."employeeId" INTO record_company, record_person
      FROM "IncidentPerson" p JOIN "Incident" i ON i."tenantId" = p."tenantId" AND i."id" = p."incidentId"
     WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."recordId";
  ELSE
    SELECT i."companyId", p."employeeId" INTO record_company, record_person
      FROM "InailFiling" f JOIN "Incident" i ON i."tenantId" = f."tenantId" AND i."id" = f."incidentId"
      JOIN "IncidentPerson" p ON p."tenantId" = f."tenantId" AND p."id" = f."incidentPersonId"
     WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."recordId";
  END IF;
  IF FOUND AND (record_company, record_person) IS DISTINCT FROM (NEW."companyId", NEW."employeeId") THEN
    RAISE EXCEPTION 'protected safety data: view % names the company and the person of the % it is of', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ProtectedView_check" BEFORE INSERT ON "ProtectedView"
  FOR EACH ROW EXECUTE FUNCTION "factory_protected_view_check"();
CREATE TRIGGER "ProtectedView_append_only" BEFORE UPDATE OR DELETE ON "ProtectedView"
  FOR EACH ROW EXECUTE FUNCTION "factory_protected_view_append_only"();
CREATE TRIGGER "ProtectedView_no_truncate" BEFORE TRUNCATE ON "ProtectedView"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_protected_view_append_only"();

-- =====================================================================================================================
-- Incident (QHS-265)
--   every row  what happened in words (not blank, at most 2000 characters), where (an area, a station, a machine or a place,
--              at least one; words at most 500 characters); it happened at the latest when it was reported; "seen" is all or
--              none; CLOSED exactly with when and by whom, CANCELLED exactly with when, by whom and the reason; the reporter:
--              sent without a name, no reporter, creator or device; else a floor report names the worker (never an office
--              user), an office report the office user (never a worker or a tablet).
--   INSERT     OPEN, not seen yet; a FLOOR report only by a floor session, an OFFICE one only by the office; an injury is
--              reported with a name (only a near miss or a hazard may stay unnamed).
--   UPDATE     the company, number, reporter, tablet, report time and creation never change; "seen" is written once; OPEN →
--              CLOSED (held while an action is open or an INAIL filing waits) | CANCELLED; CLOSED → OPEN (reopened), and
--              nothing else of a closed incident changes; CANCELLED is final; not an injury while a person is injured in it.
--   DELETE     refused. TRUNCATE refused.
--   its number: "factory_document_number_guard" (given when the row is made, never changed).
CREATE FUNCTION "factory_incident_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['kind', 'occurredAt', 'what', 'areaId', 'stationId', 'machineId', 'place', 'immediateAction', 'maintenanceRequestId', 'severity',
                                   'seenAt', 'seenById', 'status', 'closedAt', 'closedById', 'cancelledAt', 'cancelledById', 'cancelReason', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'incidents: incident % is closed or cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NEW."siteId") IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF NOT "factory_protected_words_ok"(NEW."what", 2000) OR NEW."what" IS NULL THEN
    RAISE EXCEPTION 'incidents: incident % says what happened (at most 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nonnulls(NEW."areaId", NEW."stationId", NEW."machineId", NEW."place") = 0
     OR NOT "factory_protected_words_ok"(NEW."place", 500) OR NOT "factory_protected_words_ok"(NEW."immediateAction", 500) THEN
    RAISE EXCEPTION 'incidents: incident % says where it happened: an area, a station, a machine or a place in words (words at most 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."occurredAt" > NEW."reportedAt" THEN
    RAISE EXCEPTION 'incidents: incident % happened at the latest when it was reported', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."seenAt" IS NULL) <> (NEW."seenById" IS NULL) THEN
    RAISE EXCEPTION 'incidents: incident % was seen by safety with when and by whom, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."status" = 'CLOSED') <> (NEW."closedById" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledById" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelReason" IS NOT NULL) OR NOT "factory_protected_words_ok"(NEW."cancelReason", 500) THEN
    RAISE EXCEPTION 'incidents: incident % is CLOSED exactly with when and by whom, and CANCELLED exactly with when, by whom and the reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reporterAnonymous" THEN
    IF num_nonnulls(NEW."reportedByWorkerId", NEW."reportedById", NEW."deviceId", NEW."createdById") > 0 THEN
      RAISE EXCEPTION 'incidents: incident % was sent without a name: no reporter, creator or tablet is stored with it', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW."reportedVia" = 'FLOOR' AND (NEW."reportedByWorkerId" IS NULL OR NEW."reportedById" IS NOT NULL))
     OR (NEW."reportedVia" = 'OFFICE' AND (NEW."reportedById" IS NULL OR NEW."reportedByWorkerId" IS NOT NULL OR NEW."deviceId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'incidents: incident % names its reporter: the floor worker of a floor report, the office user of an office one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."seenAt" IS NOT NULL THEN
      RAISE EXCEPTION 'incidents: incident % starts OPEN, not seen yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."reportedVia" = 'FLOOR') <> (current_user = 'factory_floor_runtime') THEN
      RAISE EXCEPTION 'incidents: incident % is a % report; a floor report is sent from a floor session, an office one from the office', NEW."id", NEW."reportedVia"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'INJURY' AND NEW."reporterAnonymous" THEN
      RAISE EXCEPTION 'incidents: incident % is an injury; only a near miss or a hazard may be sent without a name', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'incidents: the company, number, reporter, tablet, report time and creation of incident % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."seenAt" IS NOT NULL AND (NEW."seenAt", NEW."seenById") IS DISTINCT FROM (OLD."seenAt", OLD."seenById") THEN
    RAISE EXCEPTION 'incidents: incident % was seen by safety once; that is never rewritten', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'incidents: incident % is CANCELLED; it no longer changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'CLOSED' AND NEW."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'incidents: incident % is CLOSED; reopen it first', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'CLOSED'
     AND (to_jsonb(NEW) - ARRAY['status', 'closedAt', 'closedById', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'closedAt', 'closedById', 'version', 'updatedAt']) THEN
    RAISE EXCEPTION 'incidents: incident % is CLOSED; reopening it changes nothing else', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'CLOSED' AND OLD."status" <> 'CLOSED' THEN
    IF EXISTS (SELECT 1 FROM "IncidentAction" a WHERE a."tenantId" = NEW."tenantId" AND a."incidentId" = NEW."id" AND a."status" = 'OPEN') THEN
      RAISE EXCEPTION 'incidents: incident % is held open while one of its actions is open', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "InailFiling" f WHERE f."tenantId" = NEW."tenantId" AND f."incidentId" = NEW."id" AND f."status" IN ('WAITING_CERTIFICATE', 'DUE')) THEN
      RAISE EXCEPTION 'incidents: incident % is held open while an INAIL filing of it waits (its certificate, or the filing)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."kind" <> 'INJURY' AND OLD."kind" = 'INJURY'
     AND EXISTS (SELECT 1 FROM "IncidentPerson" p WHERE p."tenantId" = NEW."tenantId" AND p."incidentId" = NEW."id" AND p."involvement" = 'INJURED') THEN
    RAISE EXCEPTION 'incidents: incident % stays an injury while a person is injured in it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Incident_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Incident"
  FOR EACH ROW EXECUTE FUNCTION "factory_incident_guard"();
CREATE TRIGGER "Incident_number" BEFORE INSERT OR UPDATE ON "Incident"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('incident', 'INCIDENT');

-- =====================================================================================================================
-- IncidentPerson (QHS-270)
--   every row  a person of the company or someone from outside by name (at most 200 characters), exactly one; the body parts
--              each once, the side only with them; a person only INVOLVED carries no injury (no part, side, nature, first aid
--              or hospital).
--   the office (it reads the incident): written and removed only while the incident is OPEN; an INJURED person only in an
--              injury. A floor session cannot read the incident: it inserts the people with its report, in the same command.
--   UPDATE     the incident and creation never change.
--   DELETE     the office only (no floor grant), while the incident is OPEN (a filing of the person holds it: its reference).
--   TRUNCATE   refused.
CREATE FUNCTION "factory_incident_person_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['involvement', 'employeeId', 'outsideName', 'bodyParts', 'bodySide', 'nature', 'firstAidGiven', 'sentToHospital', 'version', 'updatedAt'];
  incident record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF "factory_quality_plant_in_scope"(NEW."tenantId", NEW."siteId") IS NOT TRUE THEN
      RETURN NEW;
    END IF;
    IF (NEW."employeeId" IS NULL) = (NEW."outsideName" IS NULL) OR NOT "factory_protected_words_ok"(NEW."outsideName", 200) THEN
      RAISE EXCEPTION 'incidents: person % of an incident is a person of the company or someone from outside by name, exactly one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF cardinality(NEW."bodyParts") <> (SELECT count(DISTINCT part) FROM unnest(NEW."bodyParts") part)
       OR (NEW."bodySide" IS NOT NULL AND cardinality(NEW."bodyParts") = 0) THEN
      RAISE EXCEPTION 'incidents: person % of an incident names each body part once, and a side only with the parts', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."involvement" = 'INVOLVED'
       AND (cardinality(NEW."bodyParts") > 0 OR NEW."nature" IS NOT NULL OR NEW."firstAidGiven" OR NEW."sentToHospital") THEN
      RAISE EXCEPTION 'incidents: person % was involved, not hurt: no injury, first aid or hospital is recorded', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF current_user <> 'factory_floor_runtime' THEN
    SELECT i."kind"::text AS kind, i."status"::text AS status INTO incident
      FROM "Incident" i WHERE i."tenantId" = coalesce(NEW."tenantId", OLD."tenantId") AND i."id" = coalesce(NEW."incidentId", OLD."incidentId") FOR SHARE;
    IF FOUND THEN
      IF incident.status <> 'OPEN' THEN
        RAISE EXCEPTION 'incidents: the people of incident % change only while it is OPEN (it is %)', coalesce(NEW."incidentId", OLD."incidentId"), incident.status
          USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP <> 'DELETE' AND NEW."involvement" = 'INJURED' AND incident.kind <> 'INJURY' THEN
        RAISE EXCEPTION 'incidents: person % is injured, so incident % is an injury, not a %', NEW."id", NEW."incidentId", incident.kind
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'incidents: the incident and creation of person % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "IncidentPerson_guard" BEFORE INSERT OR UPDATE OR DELETE ON "IncidentPerson"
  FOR EACH ROW EXECUTE FUNCTION "factory_incident_person_guard"();

-- =====================================================================================================================
-- IncidentAction (design plant.incidents "Actions")
--   every row  its place from 1; a title (at most 300 characters); DONE exactly with when and by whom, CANCELLED exactly with
--              when and the reason; the evidence note at most 2000 characters; what it was made into names exactly the
--              record of its kind (none for a plain action); a measure made from an incident names this incident as its
--              source; written while the incident is OPEN.
--   INSERT     OPEN.
--   UPDATE     the incident, place and creation never change; what it was made into is set once; DONE and CANCELLED are final.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_incident_action_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['title', 'ownerId', 'dueOn', 'status', 'doneAt', 'doneById', 'evidenceNote', 'cancelledAt', 'cancelReason', 'madeInto',
                                   'maintenanceJobId', 'riskMeasureId', 'trainingSessionId', 'version', 'updatedAt'];
  measure record;
  incident_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'incidents: action % is done or cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NEW."siteId") IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF NEW."seq" < 1 OR NEW."title" IS NULL OR NOT "factory_protected_words_ok"(NEW."title", 300) OR NOT "factory_protected_words_ok"(NEW."evidenceNote", 2000) THEN
    RAISE EXCEPTION 'incidents: action % has its place from 1 and a title (at most 300 characters; the evidence note at most 2000)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DONE') <> (NEW."doneAt" IS NOT NULL) OR (NEW."status" = 'DONE') <> (NEW."doneById" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."status" = 'CANCELLED') <> (NEW."cancelReason" IS NOT NULL)
     OR NOT "factory_protected_words_ok"(NEW."cancelReason", 500) THEN
    RAISE EXCEPTION 'incidents: action % is DONE exactly with when and by whom, and CANCELLED exactly with when and the reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."madeInto" IS NOT DISTINCT FROM 'MAINTENANCE_JOB') <> (NEW."maintenanceJobId" IS NOT NULL)
     OR (NEW."madeInto" IS NOT DISTINCT FROM 'RISK_MEASURE') <> (NEW."riskMeasureId" IS NOT NULL)
     OR (NEW."madeInto" IS NOT DISTINCT FROM 'TRAINING_SESSION') <> (NEW."trainingSessionId" IS NOT NULL) THEN
    RAISE EXCEPTION 'incidents: action % names exactly the record it was made into (a maintenance job, a measure or a training session), or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."riskMeasureId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."riskMeasureId" IS DISTINCT FROM OLD."riskMeasureId") THEN
    SELECT m."source"::text AS source, m."sourceRecordType" AS record_type, m."sourceRecordId" AS record_id INTO measure
      FROM "RiskMeasure" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."riskMeasureId";
    IF FOUND AND (measure.source <> 'INCIDENT' OR measure.record_type IS DISTINCT FROM 'Incident' OR measure.record_id IS DISTINCT FROM NEW."incidentId") THEN
      RAISE EXCEPTION 'incidents: action % is made into a measure whose source is this incident (source INCIDENT, record Incident %)', NEW."id", NEW."incidentId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT i."status"::text INTO incident_status FROM "Incident" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."incidentId" FOR SHARE;
  IF FOUND AND incident_status <> 'OPEN' THEN
    RAISE EXCEPTION 'incidents: the actions of incident % change only while it is OPEN (it is %)', NEW."incidentId", incident_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'incidents: action % starts OPEN', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'incidents: the incident, place and creation of action % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."madeInto" IS NOT NULL
     AND (NEW."madeInto", NEW."maintenanceJobId", NEW."riskMeasureId", NEW."trainingSessionId") IS DISTINCT FROM (OLD."madeInto", OLD."maintenanceJobId", OLD."riskMeasureId", OLD."trainingSessionId") THEN
    RAISE EXCEPTION 'incidents: action % was made into its % once; that never changes', OLD."id", OLD."madeInto"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('DONE', 'CANCELLED') THEN
    RAISE EXCEPTION 'incidents: action % is %; it no longer changes', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "IncidentAction_guard" BEFORE INSERT OR UPDATE OR DELETE ON "IncidentAction"
  FOR EACH ROW EXECUTE FUNCTION "factory_incident_action_guard"();

-- =====================================================================================================================
-- InailFiling (QHS-268; art. 18 c.1 r)
--   every row  its key starts `inail:<person>:<type>` (one of each type per person); the absence 0 to 3650 days; the
--              certificate's reference at most 100 characters; the deadline exactly with the certificate's time, 48 hours
--              after it; WAITING_CERTIFICATE has no certificate time, DUE and FILED have one; FILED exactly with when (not
--              before the certificate), by whom and INAIL's protocol number (at most 100 characters); NOT_NEEDED exactly with
--              when and by whom.
--   INSERT     WAITING_CERTIFICATE, DUE or FILED (a filing recorded after it was sent); for an injured person of the company in
--              an injury, while the incident is OPEN.
--   UPDATE     the incident, person, type, key and creation never change; FILED is final.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_inail_filing_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['expectedAbsenceDays', 'actualAbsenceDays', 'certificateReference', 'certificateReceivedAt', 'dueAt', 'status', 'filedAt', 'filedById',
                                   'protocolNumber', 'notNeededAt', 'notNeededById', 'version', 'updatedAt'];
  person record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'incidents: INAIL filing % is filed or not needed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NEW."siteId") IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF position(('inail:' || NEW."incidentPersonId"::text || ':' || NEW."type"::text) IN NEW."key") <> 1 THEN
    RAISE EXCEPTION 'incidents: INAIL filing % has the key inail:<its person>:<its type> (one of each type per person)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(NEW."expectedAbsenceDays" NOT BETWEEN 0 AND 3650, false) OR coalesce(NEW."actualAbsenceDays" NOT BETWEEN 0 AND 3650, false)
     OR NOT "factory_protected_words_ok"(NEW."certificateReference", 100) THEN
    RAISE EXCEPTION 'incidents: INAIL filing % counts the absence in days, 0 to 3650, and the certificate''s reference in at most 100 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."certificateReceivedAt" IS NULL) <> (NEW."dueAt" IS NULL) OR NEW."dueAt" <> NEW."certificateReceivedAt" + interval '48 hours'
     OR (NEW."status" = 'WAITING_CERTIFICATE' AND NEW."certificateReceivedAt" IS NOT NULL)
     OR (NEW."status" IN ('DUE', 'FILED') AND NEW."certificateReceivedAt" IS NULL) THEN
    RAISE EXCEPTION 'incidents: INAIL filing % is due 48 hours after the medical certificate was received (D.Lgs. 81/2008 art. 18 c.1 r): the deadline exactly with the certificate''s time, which a filing DUE or FILED has and one WAITING_CERTIFICATE has not', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'FILED') <> (NEW."filedAt" IS NOT NULL) OR (NEW."status" = 'FILED') <> (NEW."filedById" IS NOT NULL)
     OR (NEW."status" = 'FILED') <> (NEW."protocolNumber" IS NOT NULL) OR NOT "factory_protected_words_ok"(NEW."protocolNumber", 100)
     OR coalesce(NEW."filedAt" < NEW."certificateReceivedAt", false) THEN
    RAISE EXCEPTION 'incidents: INAIL filing % is FILED exactly with when (not before the certificate), by whom and INAIL''s protocol number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'NOT_NEEDED') <> (NEW."notNeededAt" IS NOT NULL) OR (NEW."status" = 'NOT_NEEDED') <> (NEW."notNeededById" IS NOT NULL) THEN
    RAISE EXCEPTION 'incidents: INAIL filing % is NOT_NEEDED exactly with when and by whom it was decided', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'NOT_NEEDED' THEN
      RAISE EXCEPTION 'incidents: INAIL filing % starts WAITING_CERTIFICATE, DUE or FILED (a filing recorded after it was sent)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT p."involvement"::text AS involvement, p."employeeId" AS employee, i."kind"::text AS kind, i."status"::text AS status INTO person
      FROM "IncidentPerson" p JOIN "Incident" i ON i."tenantId" = p."tenantId" AND i."id" = p."incidentId"
     WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."incidentPersonId";
    IF FOUND THEN
      IF person.involvement <> 'INJURED' OR person.employee IS NULL OR person.kind <> 'INJURY' THEN
        RAISE EXCEPTION 'incidents: INAIL filing % is for an injured person of the company in an injury', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF person.status <> 'OPEN' THEN
        RAISE EXCEPTION 'incidents: INAIL filing % is added while incident % is OPEN (it is %)', NEW."id", NEW."incidentId", person.status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'incidents: the incident, person, type, key and creation of INAIL filing % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'FILED' THEN
    RAISE EXCEPTION 'incidents: INAIL filing % is FILED; it no longer changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InailFiling_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InailFiling"
  FOR EACH ROW EXECUTE FUNCTION "factory_inail_filing_guard"();

-- =====================================================================================================================
-- Chemical (QHS-277; art. 223)
--   every row  a name (at most 200 characters); the supplier a party or a name, at most one; pictograms each once; hazard (H,
--              EUH) and precautionary (P) statements as CLP codes, each once; where it is kept (at most 200 characters), the
--              cabinet a code; the most kept above 0 with its unit, both or neither; the role sheets of its site and the PPE
--              items of its company, each once.
--   INSERT     ACTIVE.
--   UPDATE     the company and creation never change.
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_chemical_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  fixed CONSTANT text[] := ARRAY['id', 'companyId', 'createdAt', 'createdById'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chemicals: chemical % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NEW."siteId") IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF NEW."name" IS NULL OR NOT "factory_protected_words_ok"(NEW."name", 200) OR NOT "factory_protected_words_ok"(NEW."supplierName", 200)
     OR (NEW."supplierPartyId" IS NOT NULL AND NEW."supplierName" IS NOT NULL) THEN
    RAISE EXCEPTION 'chemicals: chemical % has a name (at most 200 characters) and its supplier as a party or by name, at most one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."ghsPictograms") <> (SELECT count(DISTINCT p) FROM unnest(NEW."ghsPictograms") p)
     OR cardinality(NEW."hazardStatements") <> (SELECT count(DISTINCT h) FROM unnest(NEW."hazardStatements") h)
     OR cardinality(NEW."precautionStatements") <> (SELECT count(DISTINCT s) FROM unnest(NEW."precautionStatements") s)
     OR EXISTS (SELECT 1 FROM unnest(NEW."hazardStatements") h WHERE h !~ '^(EUH[0-9]{3}[A-Za-z]?|H[0-9]{3}[A-Za-z]{0,2}(\+H[0-9]{3}[A-Za-z]{0,2})*)$')
     OR EXISTS (SELECT 1 FROM unnest(NEW."precautionStatements") s WHERE s !~ '^P[0-9]{3}(\+P[0-9]{3})*$') THEN
    RAISE EXCEPTION 'chemicals: chemical % lists each pictogram once, and its hazard (H225, EUH066) and precautionary (P210, P305+P351+P338) statements as CLP codes, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."storagePlace" IS NULL OR NOT "factory_protected_words_ok"(NEW."storagePlace", 200)
     OR (NEW."cabinetCode" IS NOT NULL AND NOT "factory_safety_code_ok"(NEW."cabinetCode")) THEN
    RAISE EXCEPTION 'chemicals: chemical % says where it is kept (at most 200 characters), and its cabinet as a code without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."maxQuantity" IS NULL) <> (NEW."maxQuantityUnit" IS NULL) OR coalesce(NEW."maxQuantity" <= 0, false) THEN
    RAISE EXCEPTION 'chemicals: the most of chemical % kept is above 0 with its unit, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."roleSheetIds") <> (SELECT count(DISTINCT r) FROM unnest(NEW."roleSheetIds") r)
     OR cardinality(NEW."ppeItemIds") <> (SELECT count(DISTINCT p) FROM unnest(NEW."ppeItemIds") p) THEN
    RAISE EXCEPTION 'chemicals: chemical % names each role sheet and PPE item once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."roleSheetIds" IS DISTINCT FROM OLD."roleSheetIds")
     AND (SELECT count(*) FROM "RoleSheet" r WHERE r."tenantId" = NEW."tenantId" AND r."siteId" = NEW."siteId" AND r."id" = ANY (NEW."roleSheetIds")) <> cardinality(NEW."roleSheetIds") THEN
    RAISE EXCEPTION 'chemicals: chemical % is used by role sheets of its own site', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."ppeItemIds" IS DISTINCT FROM OLD."ppeItemIds")
     AND (SELECT count(*) FROM "PpeItem" p WHERE p."tenantId" = NEW."tenantId" AND p."companyId" = NEW."companyId" AND p."id" = ANY (NEW."ppeItemIds")) <> cardinality(NEW."ppeItemIds") THEN
    RAISE EXCEPTION 'chemicals: chemical % needs PPE items of its own company''s catalogue', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'chemicals: chemical % starts ACTIVE', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(fixed) k) IS DISTINCT FROM (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(fixed) k) THEN
    RAISE EXCEPTION 'chemicals: the company and creation of chemical % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Chemical_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Chemical"
  FOR EACH ROW EXECUTE FUNCTION "factory_chemical_guard"();

-- =====================================================================================================================
-- SafetyDataSheet (QHS-278; REACH art. 35)
--   every row  a version (at most 50 characters), its revision day today at the latest, a language (ISO 639-1); SUPERSEDED
--              exactly with when and by whom.
--   INSERT     CURRENT, or SUPERSEDED (an older sheet kept); of an ACTIVE chemical; its PDF a file of the chemical that is not
--              deleted.
--   UPDATE     only CURRENT → SUPERSEDED (when, by whom); nothing else ever changes.
--   DELETE     refused (superseded sheets are kept). TRUNCATE refused.
--   one CURRENT sheet per chemical and language: the partial unique index "SafetyDataSheet_one_current".
CREATE FUNCTION "factory_safety_data_sheet_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['status', 'supersededAt', 'supersededById', 'version', 'updatedAt'];
  chemical_status text;
  file record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chemicals: data sheet % is superseded and kept, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NEW."siteId") IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF NEW."versionLabel" IS NULL OR NOT "factory_protected_words_ok"(NEW."versionLabel", 50) OR NEW."language" !~ '^[a-z]{2}$' OR NEW."revisedOn" > "factory_people_today"() THEN
    RAISE EXCEPTION 'chemicals: data sheet % has its version (at most 50 characters), its revision day (today at the latest) and its language (ISO 639-1)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'SUPERSEDED') <> (NEW."supersededAt" IS NOT NULL) OR (NEW."status" = 'SUPERSEDED') <> (NEW."supersededById" IS NOT NULL) THEN
    RAISE EXCEPTION 'chemicals: data sheet % is SUPERSEDED exactly with when and by whom', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT c."status"::text INTO chemical_status FROM "Chemical" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."chemicalId";
    IF FOUND AND chemical_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'chemicals: data sheet % is added to an ACTIVE chemical (% is %)', NEW."id", NEW."chemicalId", chemical_status
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT f."recordType" AS record_type, f."recordId" AS record_id, f."status"::text AS status INTO file
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
    IF FOUND AND (file.record_type <> 'Chemical' OR file.record_id <> NEW."chemicalId" OR file.status = 'DELETED') THEN
      RAISE EXCEPTION 'chemicals: data sheet % is a file of its chemical that is not deleted', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) OR OLD."status" = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'chemicals: data sheet % never changes; a CURRENT one is only SUPERSEDED by a newer one', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SafetyDataSheet_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SafetyDataSheet"
  FOR EACH ROW EXECUTE FUNCTION "factory_safety_data_sheet_guard"();

CREATE UNIQUE INDEX "SafetyDataSheet_one_current" ON "SafetyDataSheet" ("tenantId", "chemicalId", "language") WHERE "status" = 'CURRENT';

-- =====================================================================================================================
-- The files and search entries of protected records (NEW TRIGGERS on files.prisma's StoredFile and search.prisma's
-- SearchEntry; their own functions untouched)

-- A file of a visit, a judgement (its copy), an incident (a photo), a person involved or an INAIL filing (its receipt) is the
-- office's only: never shared with the floor, a portal or a link (GDPR art. 9; plan: "no floor read of health tables").
CREATE FUNCTION "factory_protected_file_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."recordType" NOT IN ('HealthVisit', 'FitnessJudgement', 'Incident', 'IncidentPerson', 'InailFiling') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NOT (NEW."visibility" <@ ARRAY['OFFICE']::"FileAudience"[]) OR NEW."floorSiteId" IS NOT NULL OR NEW."partyId" IS NOT NULL THEN
    RAISE EXCEPTION 'files: file % of a % is protected safety data: the office''s only, never shared with the floor, a portal or a link', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "StoredFile_protected_office_only" BEFORE INSERT OR UPDATE ON "StoredFile"
  FOR EACH ROW EXECUTE FUNCTION "factory_protected_file_guard"();

-- No search entry of a health plan, a visit, a judgement, a view, a person involved or an INAIL filing: global search never
-- reaches protected safety data (an incident and a chemical may be indexed: number, kind, place, never a person).
CREATE FUNCTION "factory_search_entry_not_protected"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."recordType" IN ('HealthPlan', 'HealthVisit', 'FitnessJudgement', 'ProtectedView', 'IncidentPerson', 'InailFiling') THEN
    RAISE EXCEPTION 'search: a % is protected safety data and is never indexed (record %)', NEW."recordType", NEW."recordId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SearchEntry_not_protected" BEFORE INSERT OR UPDATE ON "SearchEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_search_entry_not_protected"();

-- =====================================================================================================================
-- Numbering: INCIDENT is a floor document kind

-- factory_number_series_floor_guard and factory_number_allocation_floor_guard (202610316801_inspection_plans_w2b_guards): their
-- whole bodies, with INCIDENT among the floor's document kinds (factory-domain numbering/kinds FLOOR_DOCUMENT_KINDS;
-- ownership/numbering.json onlyValues). Their triggers stay as they are.
CREATE OR REPLACE FUNCTION "factory_number_series_floor_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  site_company uuid;
BEGIN
  IF current_user <> 'factory_floor_runtime' THEN
    RETURN NULL;
  END IF;
  IF NEW."fiscal" OR NEW."kind"::text IN ('DDT', 'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE')
     OR NEW."kind"::text NOT IN ('GOODS_RECEIPT', 'LOT', 'INSPECTION', 'RELEASE', 'HOLD', 'NCR', 'INCOMING_INSPECTION', 'INCIDENT') THEN
    RAISE EXCEPTION 'number series %: a tablet numbers goods receipts, lots, inspections, releases, holds, NCRs, incoming inspections and incidents only, never from a fiscal series; a % series is the office''s', NEW."id", (CASE WHEN NEW."fiscal" THEN 'fiscal ' ELSE '' END) || NEW."kind"::text
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."companyId" INTO site_company FROM "Site" s WHERE s."id" = NULLIF(current_setting('factory.site_id', true), '')::uuid;
  IF site_company IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'number series %: a tablet numbers the documents of its own site''s company only', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."tenantId", NEW."companyId", NEW."kind", NEW."code", NEW."scopeKey", NEW."reset", NEW."pattern", NEW."fiscal",
        NEW."startValue", NEW."status", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."tenantId", OLD."companyId", OLD."kind", OLD."code", OLD."scopeKey", OLD."reset", OLD."pattern", OLD."fiscal",
        OLD."startValue", OLD."status", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'number series %: a tablet moves only its counter (the next number and the last date); the series is the office''s', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."nextValue" <> OLD."nextValue" AND NEW."nextValue" <> OLD."nextValue" + 1 THEN
      RAISE EXCEPTION 'number series %: a tablet moves the counter one number at a time (% to %)', OLD."id", OLD."nextValue", NEW."nextValue"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."nextValue" = OLD."nextValue" + 1 AND NOT EXISTS (
      SELECT 1 FROM "NumberAllocation" a WHERE a."tenantId" = OLD."tenantId" AND a."seriesId" = OLD."id" AND a."value" = OLD."nextValue"
    ) THEN
      RAISE EXCEPTION 'number series %: a tablet moves the counter only past a number it recorded (number % has no NumberAllocation)', OLD."id", OLD."nextValue"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  -- INSERT: the first row of a new year of a yearly series (allocateNumber's rollover on the year's first number).
  IF NEW."reset" <> 'YEARLY' OR NEW."status" <> 'ACTIVE' OR NEW."startValue" <> 1 OR NEW."nextValue" <> 1 OR NEW."lastIssuedDate" IS NOT NULL THEN
    RAISE EXCEPTION 'number series %: a tablet adds only a new year of a yearly series: active, counting from 1, nothing issued yet', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "NumberSeries" s
    WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId" AND s."kind" = NEW."kind" AND s."pattern" = NEW."pattern"
      AND s."reset" = 'YEARLY' AND s."id" <> NEW."id" AND s."scopeKey" < NEW."scopeKey"
  ) THEN
    RAISE EXCEPTION 'number series %: a tablet adds a new year only to a series the office set up (an earlier year of % %)', NEW."id", NEW."kind", NEW."pattern"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION "factory_number_allocation_floor_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  series record;
  site_company uuid;
BEGIN
  IF current_user <> 'factory_floor_runtime' THEN
    RETURN NULL;
  END IF;
  IF NEW."kind"::text NOT IN ('GOODS_RECEIPT', 'LOT', 'INSPECTION', 'RELEASE', 'HOLD', 'NCR', 'INCOMING_INSPECTION', 'INCIDENT') THEN
    RAISE EXCEPTION 'number % (%): a tablet numbers goods receipts, lots, inspections, releases, holds, NCRs, incoming inspections and incidents only', NEW."formatted", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."companyId", s."kind"::text AS "kind", s."fiscal", s."nextValue" INTO series
    FROM "NumberSeries" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."seriesId";
  IF NOT FOUND OR series."fiscal" THEN
    RAISE EXCEPTION 'number % (%): series % is not one a tablet numbers from (a goods receipt, lot, inspection, release, hold, NCR, incoming inspection or incident series)', NEW."formatted", NEW."kind", NEW."seriesId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF series."kind" <> NEW."kind"::text OR series."companyId" <> NEW."companyId" THEN
    RAISE EXCEPTION 'number % (%): a number is of its series'' kind and company', NEW."formatted", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."companyId" INTO site_company FROM "Site" s WHERE s."id" = NULLIF(current_setting('factory.site_id', true), '')::uuid;
  IF site_company IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'number % (%): a tablet numbers the documents of its own site''s company only', NEW."formatted", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."value" > series."nextValue" THEN
    RAISE EXCEPTION 'number % (%): a tablet takes its series'' next number (%), never one ahead of it (%)', NEW."formatted", NEW."kind", series."nextValue", NEW."value"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
