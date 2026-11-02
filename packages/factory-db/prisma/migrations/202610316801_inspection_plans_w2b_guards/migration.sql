-- Written by hand (Prisma does not model triggers, partial indexes or deferred constraint triggers), after the generated
-- 202610316800_inspection_plans_w2b_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- W2b schema wave 10/16 (B-W2b-76): inspection plans with versions and checks, AQL profiles, the rules that open an
-- inspection, incoming inspections with their hides, rolls and components, in-process checks with the first-piece hold,
-- results, measurements and amendments (features QHS-002, QHS-008 … QHS-016, QHS-021, QHS-025 … QHS-036, QHS-039 …
-- QHS-042, QHS-145, MES-054, MES-127; Statuto dei Lavoratori art. 4). apps/factory-api's modules check all of this first,
-- in words; these rules hold for every login, the owner included. Every refusal is a check_violation (SQLSTATE 23514).
--
-- As in every guards migration: the tenant and site of a row are held by the policies (USING and WITH CHECK) and the
-- references, not here (no trigger compares "tenantId" or "siteId" of the row it guards, so a row moved out of a
-- session's scope meets row-level security first); a rule that reads another row skips a row this session cannot see
-- (another tenant's or site's: the policies refuse that write anyway); an UPDATE that changes nothing passes. A trigger
-- reads only tables (and columns) the role that fires it may read, and locks a row FOR SHARE only where that role may
-- update it. "Everything but these columns" is compared as jsonb, so a column added later is frozen too unless a later
-- migration names it.
--
-- What W1 keeps: no W1 function of the final inspection or the release is redefined. Inspection gets one more trigger of
-- its own, which only speaks for an inspection that runs on a plan (planVersionId) or an AQL profile; an inspection
-- without one is decided exactly as before. Fired after "Inspection_guard" (by name), so W1's rules speak first.
--
-- The only earlier functions redefined here are numbering's two floor document functions (whole bodies, from
-- …_followups_quality_money_w2b_guards, with INCOMING_INSPECTION among the floor's document kinds).

CREATE FUNCTION "factory_inspection_plans_w2b_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inspection plans and records: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['InspectionPlan', 'InspectionPlanVersion', 'InspectionPlanCheck', 'AqlProfile', 'AqlProfileAssignment', 'InspectionTrigger',
                              'IncomingInspection', 'IncomingHideResult', 'IncomingRollResult', 'IncomingComponentResult', 'InProcessCheck',
                              'InspectionCheckResult', 'InspectionMeasurement'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_inspection_plans_w2b_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- A code: not blank, no spaces.
CREATE FUNCTION "factory_inspection_code_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(code) <> '' AND code !~ '\s'
$$;

-- An ISO 2859-1 sample size code letter (the standard skips I, O and the letters after R).
CREATE FUNCTION "factory_inspection_letter_ok"(letter text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT letter ~ '^[A-HJ-NP-R]$'
$$;

-- The "applies to" chips of a plan or a rule: a list of { "kind": …, "value": … } (empty: everything).
CREATE FUNCTION "factory_inspection_chips_ok"(chips jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(chips) = 'array' THEN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(chips) chip
     WHERE CASE WHEN jsonb_typeof(chip) = 'object'
                THEN coalesce(chip ->> 'kind', '') NOT IN ('STYLE', 'CATEGORY', 'MATERIAL', 'SUPPLIER', 'OPERATION', 'CUSTOMER')
                  OR jsonb_typeof(chip -> 'value') IS DISTINCT FROM 'string' OR btrim(chip ->> 'value') = ''
                ELSE true END
  ) ELSE false END
$$;

-- A frequency and its number: a percent, or the N of every Nth bundle; the other frequencies have none.
CREATE FUNCTION "factory_inspection_frequency_ok"(frequency text, amount integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE frequency
           WHEN 'PERCENT_OF_OPERATIONS' THEN coalesce(amount BETWEEN 1 AND 100, false)
           WHEN 'EVERY_NTH_BUNDLE' THEN coalesce(amount >= 1, false)
           ELSE amount IS NULL
         END
$$;

-- The defect marks of a hide: a list of objects with x and y from 0 to 1 (the hide map's axes).
CREATE FUNCTION "factory_inspection_marks_ok"(marks jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(marks) = 'array' THEN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(marks) mark
     WHERE CASE WHEN jsonb_typeof(mark) = 'object' AND jsonb_typeof(mark -> 'x') = 'number' AND jsonb_typeof(mark -> 'y') = 'number'
                THEN (mark ->> 'x')::numeric NOT BETWEEN 0 AND 1 OR (mark ->> 'y')::numeric NOT BETWEEN 0 AND 1
                ELSE true END
  ) ELSE false END
$$;

-- The version a record runs on (QHS-016): APPROVED when the record takes it, of one of the stages of that kind of record.
CREATE FUNCTION "factory_inspection_version_usable"(tenant uuid, version_id uuid, stages text[], what text, record uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  found_version record;
BEGIN
  SELECT v."status"::text AS "status", p."stage"::text AS "stage", p."code", v."number" INTO found_version
    FROM "InspectionPlanVersion" v
    JOIN "InspectionPlan" p ON p."tenantId" = v."tenantId" AND p."id" = v."planId"
   WHERE v."tenantId" = tenant AND v."id" = version_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF found_version."status" <> 'APPROVED' THEN
    RAISE EXCEPTION 'quality: % % runs on an APPROVED plan version; % v% is %', what, record, found_version."code", found_version."number", found_version."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (found_version."stage" = ANY (stages)) THEN
    RAISE EXCEPTION 'quality: % % runs on a plan of stage %; % is of stage %', what, record, array_to_string(stages, ' or '), found_version."code", found_version."stage"
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- The AQL profile a record or a version takes: one still in use.
CREATE FUNCTION "factory_inspection_profile_usable"(tenant uuid, profile_id uuid, what text, record uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  in_use boolean;
BEGIN
  SELECT a."active" INTO in_use FROM "AqlProfile" a WHERE a."tenantId" = tenant AND a."id" = profile_id;
  IF FOUND AND NOT in_use THEN
    RAISE EXCEPTION 'quality: AQL profile % is retired; % % takes a profile in use', profile_id, what, record
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- The record a result, measurement or amendment hangs on, exactly one of the three: its status and its plan version.
-- The row is locked FOR SHARE, so a result in flight finishes before the record is decided, and one after it sees the
-- decision. No row seen: state NULL (left to the policies and the references).
CREATE FUNCTION "factory_inspection_record"(tenant uuid, inspection uuid, incoming uuid, in_process uuid, OUT state text, OUT plan_version uuid) LANGUAGE plpgsql AS $$
BEGIN
  IF inspection IS NOT NULL THEN
    SELECT i."status"::text, i."planVersionId" INTO state, plan_version FROM "Inspection" i WHERE i."tenantId" = tenant AND i."id" = inspection FOR SHARE;
  ELSIF incoming IS NOT NULL THEN
    SELECT i."status"::text, i."planVersionId" INTO state, plan_version FROM "IncomingInspection" i WHERE i."tenantId" = tenant AND i."id" = incoming FOR SHARE;
  ELSE
    SELECT c."status"::text, c."planVersionId" INTO state, plan_version FROM "InProcessCheck" c WHERE c."tenantId" = tenant AND c."id" = in_process FOR SHARE;
  END IF;
END
$$;

-- Has a record's counting started? A result or a measurement is recorded.
CREATE FUNCTION "factory_inspection_counting_started"(tenant uuid, inspection uuid, incoming uuid, in_process uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "InspectionCheckResult" r
                  WHERE r."tenantId" = tenant AND (r."inspectionId" = inspection OR r."incomingInspectionId" = incoming OR r."inProcessCheckId" = in_process))
      OR EXISTS (SELECT 1 FROM "InspectionMeasurement" m
                  WHERE m."tenantId" = tenant AND (m."inspectionId" = inspection OR m."incomingInspectionId" = incoming OR m."inProcessCheckId" = in_process))
$$;

-- The first CRITICAL check of a record's plan that failed, by a result or a measurement (QHS-002: a critical failure is
-- never accepted), or NULL.
CREATE FUNCTION "factory_inspection_failed_critical"(tenant uuid, plan_version uuid, inspection uuid, incoming uuid, in_process uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT c."code"
    FROM "InspectionPlanCheck" c
   WHERE c."tenantId" = tenant AND c."planVersionId" = plan_version AND c."checkClass" = 'CRITICAL'
     AND (EXISTS (SELECT 1 FROM "InspectionCheckResult" r
                   WHERE r."tenantId" = tenant AND r."planCheckId" = c."id" AND r."outcome" = 'FAIL'
                     AND (r."inspectionId" = inspection OR r."incomingInspectionId" = incoming OR r."inProcessCheckId" = in_process))
       OR EXISTS (SELECT 1 FROM "InspectionMeasurement" m
                   WHERE m."tenantId" = tenant AND m."planCheckId" = c."id" AND NOT m."pass"
                     AND (m."inspectionId" = inspection OR m."incomingInspectionId" = incoming OR m."inProcessCheckId" = in_process)))
   ORDER BY c."sortOrder", c."code"
   LIMIT 1
$$;

-- Does a record pass its plan? In words what stops it, or NULL: a mandatory check with no result or measurement, or a
-- CRITICAL check that failed.
CREATE FUNCTION "factory_inspection_results_problem"(tenant uuid, plan_version uuid, inspection uuid, incoming uuid, in_process uuid) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  code text;
BEGIN
  SELECT c."code" INTO code
    FROM "InspectionPlanCheck" c
   WHERE c."tenantId" = tenant AND c."planVersionId" = plan_version AND c."mandatory" AND c."type" <> 'INSTRUCTION'
     AND NOT EXISTS (SELECT 1 FROM "InspectionCheckResult" r
                      WHERE r."tenantId" = tenant AND r."planCheckId" = c."id"
                        AND (r."inspectionId" = inspection OR r."incomingInspectionId" = incoming OR r."inProcessCheckId" = in_process))
     AND NOT EXISTS (SELECT 1 FROM "InspectionMeasurement" m
                      WHERE m."tenantId" = tenant AND m."planCheckId" = c."id"
                        AND (m."inspectionId" = inspection OR m."incomingInspectionId" = incoming OR m."inProcessCheckId" = in_process))
   ORDER BY c."sortOrder", c."code"
   LIMIT 1;
  IF FOUND THEN
    RETURN format('mandatory check %s has no result', code);
  END IF;
  code := "factory_inspection_failed_critical"(tenant, plan_version, inspection, incoming, in_process);
  IF code IS NOT NULL THEN
    RETURN format('critical check %s failed', code);
  END IF;
  RETURN NULL;
END
$$;

-- Who recorded a result or a measurement: at most one person, the floor never an office user, and someone or something.
CREATE FUNCTION "factory_inspection_recorder_check"(office_user uuid, worker uuid, device uuid, what text, record uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF num_nonnulls(office_user, worker) > 1 OR num_nonnulls(office_user, worker, device) = 0 THEN
    RAISE EXCEPTION 'quality: % % names at most one person (an office user or a worker of the site), or at least the device it came from', what, record
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'factory_floor_runtime' AND office_user IS NOT NULL THEN
    RAISE EXCEPTION 'quality: the floor records a worker, not an office user (% %)', what, record
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- =====================================================================================================================
-- Plans (QHS-008, QHS-009, QHS-016)

-- InspectionPlan
--   UPDATE     the company, code, stage and creation never change (every record of it is of that stage).
--   every row  a code without spaces, a name, its chips.
--   DELETE     refused: a plan no longer used has its versions retired. TRUNCATE refused.
CREATE FUNCTION "factory_inspection_plan_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: inspection plan % is kept (its versions are retired), never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."code", NEW."stage", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."code", OLD."stage", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, code, stage and creation of inspection plan % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_inspection_code_ok"(NEW."code") OR btrim(NEW."name") = '' THEN
    RAISE EXCEPTION 'quality: inspection plan % has a code without spaces and a name', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_inspection_chips_ok"(NEW."appliesTo") THEN
    RAISE EXCEPTION 'quality: inspection plan % says where it applies as a list of { kind, value } chips (style, category, material, supplier, operation, customer)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InspectionPlan_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InspectionPlan"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_plan_guard"();

-- InspectionPlanVersion
--   INSERT     DRAFT, unapproved.
--   UPDATE     plan, number, author and creation never change. DRAFT → APPROVED | RETIRED, APPROVED → RETIRED; RETIRED is
--              final. Once approved only the retirement changes: the version is frozen with its checks.
--   APPROVED   by a second person: never its author (QHS-016), who, when and the signature together, with at least one
--              check that takes a result, and a profile in use when it names one.
--   every row  sampling: FIXED has its sample size and no profile, AQL_PROFILE no sample size; the frequency's number;
--              RETIRED ⇔ who and when.
--   DELETE     refused (a draft nobody wants is retired). TRUNCATE refused.
-- At most one APPROVED per plan (the partial unique index): the command retires the old version first.
CREATE FUNCTION "factory_inspection_plan_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  moving CONSTANT text[] := ARRAY['tenantId', 'status', 'retiredById', 'retiredAt', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: plan version % is kept (retired when nobody wants it), never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'quality: plan version % starts DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."planId", NEW."number", NEW."authorId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."planId", OLD."number", OLD."authorId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the plan, number, author and creation of plan version % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'RETIRED' THEN
      RAISE EXCEPTION 'quality: plan version % is RETIRED; a retired version never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'APPROVED' AND (NEW."status" = 'DRAFT' OR (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving)) THEN
      RAISE EXCEPTION 'quality: plan version % is APPROVED; an approved version is frozen with its checks (a change is a new version)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."number" < 1 THEN
    RAISE EXCEPTION 'quality: plan version % has a number from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."samplingMethod" = 'FIXED' AND (coalesce(NEW."fixedSampleSize", 0) < 1 OR NEW."aqlProfileId" IS NOT NULL))
     OR (NEW."samplingMethod" = 'AQL_PROFILE' AND NEW."fixedSampleSize" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: plan version % samples by an AQL profile or a fixed number of units from 1, not both', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."frequency" IS NULL AND NEW."frequencyValue" IS NOT NULL)
     OR (NEW."frequency" IS NOT NULL AND NOT "factory_inspection_frequency_ok"(NEW."frequency"::text, NEW."frequencyValue")) THEN
    RAISE EXCEPTION 'quality: plan version % has a percent from 1 to 100, an N from 1, or no number, as its frequency asks', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nonnulls(NEW."approvedById", NEW."approvedAt", NEW."approvalSha256") NOT IN (0, 3) OR btrim(NEW."approvalSha256") = ''
     OR (NEW."status" = 'APPROVED' AND NEW."approvedById" IS NULL) OR (NEW."status" = 'DRAFT' AND NEW."approvedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: plan version % is % with the wrong approval: who approved it, when and the signature are set together, by the approval', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."approvedById" = NEW."authorId" THEN
    RAISE EXCEPTION 'quality: the author of plan version % does not approve it (QHS-016: a second person does)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'RETIRED') <> (NEW."retiredById" IS NOT NULL) OR (NEW."status" = 'RETIRED') <> (NEW."retiredAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: plan version % is %; who retired it and when are set exactly when RETIRED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" = 'DRAFT' AND NEW."status" = 'APPROVED' THEN
    IF NOT EXISTS (SELECT 1 FROM "InspectionPlanCheck" c
                    WHERE c."tenantId" = NEW."tenantId" AND c."planVersionId" = NEW."id" AND c."type" <> 'INSTRUCTION') THEN
      RAISE EXCEPTION 'quality: plan version % has nothing to check; a version is approved with at least one check that takes a result', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."aqlProfileId" IS NOT NULL THEN
      PERFORM "factory_inspection_profile_usable"(NEW."tenantId", NEW."aqlProfileId", 'plan version', NEW."id");
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InspectionPlanVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InspectionPlanVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_plan_version_guard"();

CREATE UNIQUE INDEX "InspectionPlanVersion_one_approved" ON "InspectionPlanVersion" ("tenantId", "planId") WHERE "status" = 'APPROVED';

-- InspectionPlanCheck
--   INSERT, UPDATE, DELETE  only while its version is DRAFT (the version's row FOR SHARE, so an approval waits for a check
--                           in flight, and a check after it sees it).
--   UPDATE     its version, code and creation never change.
--   every row  its words; MEASUREMENT: nominal, tolerance from 0 and unit, all three or none (the graded spec); the other
--              types none of them; CHOICE: at least two choices, each once, none blank; the others none; INSTRUCTION: no
--              class, not mandatory, no photo.
--   DELETE     of a DRAFT's check. TRUNCATE refused.
CREATE FUNCTION "factory_inspection_plan_check_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT v."status"::text INTO state FROM "InspectionPlanVersion" v WHERE v."tenantId" = OLD."tenantId" AND v."id" = OLD."planVersionId" FOR SHARE;
  ELSE
    SELECT v."status"::text INTO state FROM "InspectionPlanVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."planVersionId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'quality: plan version % is %; its checks change only while it is DRAFT', coalesce(NEW."planVersionId", OLD."planVersionId"), state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."id", NEW."planVersionId", NEW."code", NEW."createdAt", NEW."createdById")
     IS DISTINCT FROM (OLD."id", OLD."planVersionId", OLD."code", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'quality: the version, code and creation of plan check % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_quality_plant_words_ok"(NEW."code", NEW."labelIt", NEW."labelEn", NEW."labelI18n", NULL, NULL) THEN
    RAISE EXCEPTION 'quality: plan check % has a code without spaces, Italian and English words, and its other languages as { "<language>": "<words>" }', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."type" = 'MEASUREMENT' THEN
    IF num_nonnulls(NEW."nominal", NEW."tolerance", NEW."uom") NOT IN (0, 3) OR NEW."tolerance" < 0 THEN
      RAISE EXCEPTION 'quality: measurement check % has a nominal, a tolerance from 0 and a unit, or none of them (the graded spec of the size)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF num_nonnulls(NEW."nominal", NEW."tolerance", NEW."uom") > 0 THEN
    RAISE EXCEPTION 'quality: plan check % is %; only a measurement has a nominal, a tolerance and a unit', NEW."id", NEW."type"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."type" = 'CHOICE' THEN
    IF cardinality(NEW."choices") < 2 OR (SELECT count(DISTINCT c) FROM unnest(NEW."choices") AS c) <> cardinality(NEW."choices")
       OR EXISTS (SELECT 1 FROM unnest(NEW."choices") AS c WHERE btrim(c) = '') THEN
      RAISE EXCEPTION 'quality: choice check % has at least two choices, each once, none blank', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF cardinality(NEW."choices") > 0 THEN
    RAISE EXCEPTION 'quality: plan check % is %; only a choice has choices', NEW."id", NEW."type"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."type" = 'INSTRUCTION' AND (NEW."mandatory" OR NEW."checkClass" IS NOT NULL OR NEW."photoRequired") THEN
    RAISE EXCEPTION 'quality: instruction % takes no result: it has no class and is neither mandatory nor asks a photo', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InspectionPlanCheck_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InspectionPlanCheck"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_plan_check_guard"();

-- =====================================================================================================================
-- AQL profiles (QHS-021; ISO 2859-1) and when inspections are created (QHS-010, QHS-011)

-- AqlProfile
--   UPDATE     the company, code and creation never change.
--   every row  a code without spaces, a name; critical is 0 (QHS-002: a critical defect is never accepted); major and
--              minor from 0 up to 1000 (the top of ISO 2859-1's range); the company default is in use.
--   DELETE     refused (retired with active). TRUNCATE refused.
-- At most one default per company (the partial unique index).
CREATE FUNCTION "factory_aql_profile_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: AQL profile % is kept (retired with active), never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."code", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."code", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, code and creation of AQL profile % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_inspection_code_ok"(NEW."code") OR btrim(NEW."name") = '' THEN
    RAISE EXCEPTION 'quality: AQL profile % has a code without spaces and a name', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."aqlCritical" <> 0 THEN
    RAISE EXCEPTION 'quality: AQL profile % has critical at 0; a critical defect is never accepted (QHS-002)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."aqlMajor" NOT BETWEEN 0 AND 1000 OR NEW."aqlMinor" NOT BETWEEN 0 AND 1000 THEN
    RAISE EXCEPTION 'quality: AQL profile % has major and minor AQLs from 0 to 1000 (ISO 2859-1)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."isDefault" AND NOT NEW."active" THEN
    RAISE EXCEPTION 'quality: AQL profile % is retired; the company default is a profile in use', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AqlProfile_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AqlProfile"
  FOR EACH ROW EXECUTE FUNCTION "factory_aql_profile_guard"();

CREATE UNIQUE INDEX "AqlProfile_one_default" ON "AqlProfile" ("tenantId", "companyId") WHERE "isDefault";

-- AqlProfileAssignment
--   UPDATE     only active changes: another profile or subject is a new row.
--   every row  a customer, a style or both; the customer has the CUSTOMER or BRAND role; the style is the company's own or
--              tenant-wide; a new active row takes a profile in use.
--   DELETE     refused (set inactive: the history stays). TRUNCATE refused.
-- One active row per customer and style pair (the partial unique index).
CREATE FUNCTION "factory_aql_profile_assignment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  style_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: AQL profile assignment % is set inactive, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."profileId", NEW."customerId", NEW."styleId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."profileId", OLD."customerId", OLD."styleId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: AQL profile assignment % keeps its profile and subject (another one is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."customerId" IS NULL AND NEW."styleId" IS NULL THEN
    RAISE EXCEPTION 'quality: AQL profile assignment % is for a customer, a style or both', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."customerId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."customerId" AND ('CUSTOMER' = ANY (p."roles") OR 'BRAND' = ANY (p."roles"))
  ) THEN
    RAISE EXCEPTION 'quality: party % is not a customer of the tenant (AQL profile assignment %)', NEW."customerId", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."styleId" IS NOT NULL THEN
    SELECT s."companyId" INTO style_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF style_company IS NOT NULL AND style_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'quality: style % is another company''s (AQL profile assignment %)', NEW."styleId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."active" THEN
    PERFORM "factory_inspection_profile_usable"(NEW."tenantId", NEW."profileId", 'assignment', NEW."id");
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AqlProfileAssignment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AqlProfileAssignment"
  FOR EACH ROW EXECUTE FUNCTION "factory_aql_profile_assignment_guard"();

CREATE UNIQUE INDEX "AqlProfileAssignment_one_active" ON "AqlProfileAssignment"
  ("tenantId", "companyId", (COALESCE("customerId", '00000000-0000-0000-0000-000000000000'::uuid)), (COALESCE("styleId", '00000000-0000-0000-0000-000000000000'::uuid)))
  WHERE "active";

-- InspectionTrigger
--   UPDATE     the company and creation never change.
--   every row  its chips; the frequency's number.
--   DELETE     allowed (its inspections keep their version). TRUNCATE refused.
CREATE FUNCTION "factory_inspection_trigger_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company and creation of inspection rule % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_inspection_chips_ok"(NEW."appliesTo") THEN
    RAISE EXCEPTION 'quality: inspection rule % says what it applies to as a list of { kind, value } chips (style, category, material, supplier, operation, customer)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_inspection_frequency_ok"(NEW."frequency"::text, NEW."frequencyValue") THEN
    RAISE EXCEPTION 'quality: inspection rule % has a percent from 1 to 100, an N from 1, or no number, as its frequency asks', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InspectionTrigger_guard" BEFORE INSERT OR UPDATE ON "InspectionTrigger"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_trigger_guard"();

-- =====================================================================================================================
-- The final inspection on a plan (QHS-016)

-- Inspection, one more trigger (W1's functions are not touched; "Inspection_plan_guard" fires after "Inspection_guard"):
--   planVersionId  an APPROVED version of a FINAL plan when it is set; set at the opening or once while OPEN, never
--                  changed or cleared (a decided inspection is frozen by W1's guard).
--   aqlProfileId   a profile in use when set; profile and code letter stay fixed once counting starts (a defect, a result
--                  or a measurement is recorded; design "The profile is frozen once counting starts").
--   codeLetter     an ISO 2859-1 letter.
--   PASSED         on a plan: every mandatory check has its result, and no CRITICAL check failed (W1's checklist and
--                  numbers still decide the rest: the command writes `checklist` from the results).
CREATE FUNCTION "factory_inspection_plan_link_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW."codeLetter" IS NOT NULL AND NOT "factory_inspection_letter_ok"(NEW."codeLetter") THEN
    RAISE EXCEPTION 'quality: inspection % has an ISO 2859-1 code letter (A to R, no I or O), not %', NEW."id", NEW."codeLetter"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."planVersionId" IS NOT NULL AND NEW."planVersionId" IS DISTINCT FROM OLD."planVersionId" THEN
    RAISE EXCEPTION 'quality: inspection % keeps the plan version frozen on it (QHS-016)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."planVersionId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."planVersionId" IS NULL) THEN
    PERFORM "factory_inspection_version_usable"(NEW."tenantId", NEW."planVersionId", ARRAY['FINAL'], 'final inspection', NEW."id");
  END IF;
  IF NEW."aqlProfileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."aqlProfileId" IS DISTINCT FROM OLD."aqlProfileId") THEN
    PERFORM "factory_inspection_profile_usable"(NEW."tenantId", NEW."aqlProfileId", 'final inspection', NEW."id");
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."aqlProfileId", NEW."codeLetter") IS DISTINCT FROM (OLD."aqlProfileId", OLD."codeLetter")
     AND ("factory_inspection_counting_started"(NEW."tenantId", NEW."id", NULL, NULL)
          OR EXISTS (SELECT 1 FROM "InspectionDefect" d WHERE d."tenantId" = NEW."tenantId" AND d."inspectionId" = NEW."id")) THEN
    RAISE EXCEPTION 'quality: the AQL profile of inspection % is frozen once counting starts', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'OPEN' AND NEW."status" = 'PASSED' AND NEW."planVersionId" IS NOT NULL THEN
    problem := "factory_inspection_results_problem"(NEW."tenantId", NEW."planVersionId", NEW."id", NULL, NULL);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'quality: inspection % does not PASS on its plan: %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Inspection_plan_guard" BEFORE INSERT OR UPDATE ON "Inspection"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_plan_link_guard"();

-- =====================================================================================================================
-- Incoming inspections (QHS-025 … QHS-036)

-- IncomingInspection
--   INSERT     OPEN; an APPROVED version of an INCOMING plan; a profile in use.
--   UPDATE     company, subject, plan version and creation never change; a decided or cancelled one never changes
--              (a correction is an InspectionAmendment); profile and code letter stay fixed once counting starts (a unit,
--              a result, a measurement, a counter above 0).
--   every row  exactly one subject: a lot with its item, or a workshop's receipt with its work order; the lot above 0, the
--              sample from 1 up to it; the sampling plan whole or absent, acceptance numbers up to the sample; the counters
--              from 0 up to the sample; at most one inspector, the floor only a worker; a code letter of ISO 2859-1.
--   DECIDED    one inspector, the time, the signature, and accepted + rejected + to sort = the lot, each from 0; every
--              hide, roll and component has its decision. The database writes the computed result: FAIL for a critical
--              defect, more major or minor units than the acceptance numbers, or a failed critical check. The whole lot
--              is never accepted over a critical defect or a failed critical check, nor with a mandatory check missing; a
--              whole-lot decision against the computed result carries the inspector's reason, and only then.
--   CANCELLED  from OPEN, with when and why.
--   DELETE     refused. TRUNCATE refused.
-- The lot's own status is the command's: W1's rule stays (a person with the quality role, never who received it).
CREATE FUNCTION "factory_incoming_inspection_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  problem text;
  critical_failed boolean;
  computed "InspectionResult";
  whole_accepted boolean;
  whole_rejected boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: incoming inspection % is kept (cancelled when abandoned), never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'quality: incoming inspection % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_inspection_version_usable"(NEW."tenantId", NEW."planVersionId", ARRAY['INCOMING'], 'incoming inspection', NEW."id");
    IF NEW."aqlProfileId" IS NOT NULL THEN
      PERFORM "factory_inspection_profile_usable"(NEW."tenantId", NEW."aqlProfileId", 'incoming inspection', NEW."id");
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."lotId", NEW."itemId", NEW."subcontractReceiptId", NEW."workOrderId", NEW."planVersionId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."lotId", OLD."itemId", OLD."subcontractReceiptId", OLD."workOrderId", OLD."planVersionId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, subject, plan version and creation of incoming inspection % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: incoming inspection % is %; a decided or cancelled inspection never changes (a correction is an amendment)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."aqlProfileId" IS DISTINCT FROM OLD."aqlProfileId" AND NEW."aqlProfileId" IS NOT NULL THEN
      PERFORM "factory_inspection_profile_usable"(NEW."tenantId", NEW."aqlProfileId", 'incoming inspection', NEW."id");
    END IF;
    IF (NEW."aqlProfileId", NEW."codeLetter") IS DISTINCT FROM (OLD."aqlProfileId", OLD."codeLetter")
       AND (NEW."foundCritical" > 0 OR NEW."foundMajor" > 0 OR NEW."foundMinor" > 0
            OR "factory_inspection_counting_started"(NEW."tenantId", NULL, NEW."id", NULL)
            OR EXISTS (SELECT 1 FROM "IncomingHideResult" h WHERE h."tenantId" = NEW."tenantId" AND h."incomingInspectionId" = NEW."id")
            OR EXISTS (SELECT 1 FROM "IncomingRollResult" r WHERE r."tenantId" = NEW."tenantId" AND r."incomingInspectionId" = NEW."id")
            OR EXISTS (SELECT 1 FROM "IncomingComponentResult" c WHERE c."tenantId" = NEW."tenantId" AND c."incomingInspectionId" = NEW."id")) THEN
      RAISE EXCEPTION 'quality: the AQL profile of incoming inspection % is frozen once counting starts', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."lotId" IS NULL) = (NEW."subcontractReceiptId" IS NULL)
     OR (NEW."lotId" IS NULL) <> (NEW."itemId" IS NULL)
     OR (NEW."subcontractReceiptId" IS NULL) <> (NEW."workOrderId" IS NULL) THEN
    RAISE EXCEPTION 'quality: incoming inspection % is of a lot with its item, or of a workshop''s receipt with its work order, exactly one of the two', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lotSize" <= 0 OR NEW."sampleSize" < 1 OR NEW."sampleSize" > NEW."lotSize" THEN
    RAISE EXCEPTION 'quality: incoming inspection % has a lot above 0 and a sample from 1 up to the lot', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nonnulls(NEW."inspectionLevel", NEW."aqlMajor", NEW."aqlMinor", NEW."acceptMajor", NEW."acceptMinor") NOT IN (0, 5)
     OR btrim(NEW."inspectionLevel") = '' OR NEW."aqlMajor" < 0 OR NEW."aqlMinor" < 0
     OR NEW."acceptMajor" < 0 OR NEW."acceptMinor" < 0 OR NEW."acceptMajor" > NEW."sampleSize" OR NEW."acceptMinor" > NEW."sampleSize" THEN
    RAISE EXCEPTION 'quality: incoming inspection % keeps its sampling plan whole or not at all: level, AQLs from 0, acceptance numbers from 0 up to the sample', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."foundCritical" NOT BETWEEN 0 AND NEW."sampleSize" OR NEW."foundMajor" NOT BETWEEN 0 AND NEW."sampleSize" OR NEW."foundMinor" NOT BETWEEN 0 AND NEW."sampleSize" THEN
    RAISE EXCEPTION 'quality: incoming inspection % counts units with a defect from 0 up to its sample of %', NEW."id", NEW."sampleSize"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."codeLetter" IS NOT NULL AND NOT "factory_inspection_letter_ok"(NEW."codeLetter") THEN
    RAISE EXCEPTION 'quality: incoming inspection % has an ISO 2859-1 code letter (A to R, no I or O), not %', NEW."id", NEW."codeLetter"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."inspectorWorkerId" IS NOT NULL AND NEW."inspectorUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'quality: incoming inspection % names one inspector: a worker of the site or an office user', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'factory_floor_runtime' AND NEW."inspectorUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'quality: the floor records the inspection of a worker (the signed-in floor inspector), not of an office user (incoming inspection %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DECIDED') <> (NEW."decidedAt" IS NOT NULL)
     OR (NEW."status" = 'DECIDED') <> (btrim(coalesce(NEW."signatureSha256", '')) <> '')
     OR num_nonnulls(NEW."acceptedQuantity", NEW."rejectedQuantity", NEW."toSortQuantity") <> (CASE WHEN NEW."status" = 'DECIDED' THEN 3 ELSE 0 END)
     OR (NEW."status" = 'DECIDED' AND NEW."inspectorWorkerId" IS NULL AND NEW."inspectorUserId" IS NULL) THEN
    RAISE EXCEPTION 'quality: incoming inspection % is %; its inspector, time, signature and three quantities are set exactly when DECIDED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> 'DECIDED' AND (NEW."computedResult" IS NOT NULL OR NEW."overrideReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: incoming inspection % is %; only a decided inspection has a computed result or an override reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'quality: incoming inspection % is %; when and why it was cancelled are set exactly when CANCELLED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" = 'OPEN' AND NEW."status" = 'DECIDED' THEN
    IF NEW."acceptedQuantity" < 0 OR NEW."rejectedQuantity" < 0 OR NEW."toSortQuantity" < 0
       OR NEW."acceptedQuantity" + NEW."rejectedQuantity" + NEW."toSortQuantity" <> NEW."lotSize" THEN
      RAISE EXCEPTION 'quality: incoming inspection % decides accepted, rejected and to sort from 0, adding up to the lot of %', NEW."id", NEW."lotSize"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "IncomingHideResult" h WHERE h."tenantId" = NEW."tenantId" AND h."incomingInspectionId" = NEW."id" AND h."decision" IS NULL)
       OR EXISTS (SELECT 1 FROM "IncomingRollResult" r WHERE r."tenantId" = NEW."tenantId" AND r."incomingInspectionId" = NEW."id" AND r."decision" IS NULL)
       OR EXISTS (SELECT 1 FROM "IncomingComponentResult" c WHERE c."tenantId" = NEW."tenantId" AND c."incomingInspectionId" = NEW."id" AND c."decision" IS NULL) THEN
      RAISE EXCEPTION 'quality: incoming inspection % is decided with a decision on every hide, roll and component', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    whole_accepted := NEW."acceptedQuantity" = NEW."lotSize";
    whole_rejected := NEW."rejectedQuantity" = NEW."lotSize";
    problem := "factory_inspection_results_problem"(NEW."tenantId", NEW."planVersionId", NULL, NEW."id", NULL);
    critical_failed := "factory_inspection_failed_critical"(NEW."tenantId", NEW."planVersionId", NULL, NEW."id", NULL) IS NOT NULL;
    computed := CASE WHEN NEW."foundCritical" > 0 OR critical_failed
                       OR NEW."foundMajor" > coalesce(NEW."acceptMajor", NEW."sampleSize") OR NEW."foundMinor" > coalesce(NEW."acceptMinor", NEW."sampleSize")
                     THEN 'FAIL'::"InspectionResult" ELSE 'PASS'::"InspectionResult" END;
    NEW."computedResult" := computed;
    IF whole_accepted AND problem IS NOT NULL THEN
      RAISE EXCEPTION 'quality: incoming inspection % does not accept the whole lot: %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
    IF whole_accepted AND NEW."foundCritical" > 0 THEN
      RAISE EXCEPTION 'quality: incoming inspection % found % unit(s) with a critical defect; a critical defect is never accepted', NEW."id", NEW."foundCritical"
        USING ERRCODE = 'check_violation';
    END IF;
    IF ((whole_accepted AND computed = 'FAIL') OR (whole_rejected AND computed = 'PASS')) <> (btrim(coalesce(NEW."overrideReason", '')) <> '') THEN
      RAISE EXCEPTION 'quality: incoming inspection % carries the inspector''s reason exactly when the whole lot is decided against its computed result (%)', NEW."id", computed
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "IncomingInspection_guard" BEFORE INSERT OR UPDATE OR DELETE ON "IncomingInspection"
  FOR EACH ROW EXECUTE FUNCTION "factory_incoming_inspection_guard"();

-- Numbered like Inspection (…_numbering_floor_documents_guards): given when the row is made, never changed.
CREATE TRIGGER "IncomingInspection_number" BEFORE INSERT OR UPDATE ON "IncomingInspection"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('incoming inspection', 'INCOMING_INSPECTION');

-- A unit of an incoming inspection is written, changed and removed only while it is OPEN (its row FOR SHARE: a decision
-- waits for a unit in flight, and a unit after it sees the decision).
CREATE FUNCTION "factory_incoming_unit_check"(tenant uuid, inspection uuid, what text, record uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  SELECT i."status"::text INTO state FROM "IncomingInspection" i WHERE i."tenantId" = tenant AND i."id" = inspection FOR SHARE;
  IF state IS NOT NULL AND state <> 'OPEN' THEN
    RAISE EXCEPTION 'quality: incoming inspection % is %; its % % changes only while it is OPEN', inspection, state, what, record
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- IncomingHideResult
--   every write  only while the inspection is OPEN.
--   UPDATE       the inspection, hide and creation never change.
--   every row    the measured area above 0 in an area unit, the declared one above 0 when known; each link both or neither;
--                the marks a list with x and y from 0 to 1.
-- A hide has one decided row per inspection (the partial unique index), and every row has a decision when it is signed.
CREATE FUNCTION "factory_incoming_hide_result_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "factory_incoming_unit_check"(OLD."tenantId", OLD."incomingInspectionId", 'hide', OLD."id");
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."incomingInspectionId", NEW."lotId", NEW."hideId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."incomingInspectionId", OLD."lotId", OLD."hideId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the inspection, hide and creation of hide result % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM "factory_incoming_unit_check"(NEW."tenantId", NEW."incomingInspectionId", 'hide', NEW."id");
  IF NEW."seq" < 1 OR NEW."measuredArea" <= 0 OR NEW."declaredArea" <= 0 OR NEW."areaUom" NOT IN ('M2', 'DM2', 'FT2') THEN
    RAISE EXCEPTION 'quality: hide result % has a place from 1, and its areas above 0 in M2, DM2 or FT2', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."shadeRecordType" IS NULL) <> (NEW."shadeRecordId" IS NULL) OR (NEW."gradeRecordType" IS NULL) <> (NEW."gradeRecordId" IS NULL)
     OR btrim(NEW."shadeRecordType") = '' OR btrim(NEW."gradeRecordType") = '' THEN
    RAISE EXCEPTION 'quality: hide result % names a shade group or grade record by its type and id, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_inspection_marks_ok"(NEW."marks") THEN
    RAISE EXCEPTION 'quality: hide result % keeps its marks as a list, each with x and y from 0 to 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "IncomingHideResult_guard" BEFORE INSERT OR UPDATE OR DELETE ON "IncomingHideResult"
  FOR EACH ROW EXECUTE FUNCTION "factory_incoming_hide_result_guard"();

CREATE UNIQUE INDEX "IncomingHideResult_one_decided" ON "IncomingHideResult" ("tenantId", "incomingInspectionId", "hideId") WHERE "decision" IS NOT NULL;

-- IncomingRollResult (QHS-032)
--   every write  only while the inspection is OPEN.
--   UPDATE       the inspection and creation never change.
--   every row    a roll reference; its record both or neither; counters from 0; width and length above 0. The database
--                writes the points per 100 square yards: (1×ones + 2×twos + 3×threes + 4×fours) × 100 / the roll's square
--                yards (1 m² = 1.19599 sq yd), whatever the API sends.
CREATE FUNCTION "factory_incoming_roll_result_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "factory_incoming_unit_check"(OLD."tenantId", OLD."incomingInspectionId", 'roll', OLD."id");
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."incomingInspectionId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."incomingInspectionId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the inspection and creation of roll result % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM "factory_incoming_unit_check"(NEW."tenantId", NEW."incomingInspectionId", 'roll', NEW."id");
  IF btrim(NEW."rollRef") = '' OR (NEW."recordType" IS NULL) <> (NEW."recordId" IS NULL) OR btrim(NEW."recordType") = '' THEN
    RAISE EXCEPTION 'quality: roll result % has a roll reference, and names the roll''s record by its type and id, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."onePoint" < 0 OR NEW."twoPoint" < 0 OR NEW."threePoint" < 0 OR NEW."fourPoint" < 0 OR NEW."widthCm" <= 0 OR NEW."lengthM" <= 0 THEN
    RAISE EXCEPTION 'quality: roll result % has counters from 0, and a width and a length above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."pointsPer100SqYd" := round((NEW."onePoint" + 2 * NEW."twoPoint" + 3 * NEW."threePoint" + 4 * NEW."fourPoint") * 100
                                  / (NEW."widthCm" / 100 * NEW."lengthM" * 1.19599004630108), 2);
  RETURN NEW;
END
$$;

CREATE TRIGGER "IncomingRollResult_guard" BEFORE INSERT OR UPDATE OR DELETE ON "IncomingRollResult"
  FOR EACH ROW EXECUTE FUNCTION "factory_incoming_roll_result_guard"();

-- IncomingComponentResult (QHS-033)
--   every write  only while the inspection is OPEN.
--   UPDATE       the inspection and creation never change.
--   every row    a place from 1; pieces checked from 1, those not right from 0 up to them; a protector's type and size
--                only on a protector.
CREATE FUNCTION "factory_incoming_component_result_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "factory_incoming_unit_check"(OLD."tenantId", OLD."incomingInspectionId", 'component', OLD."id");
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."incomingInspectionId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."incomingInspectionId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the inspection and creation of component result % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM "factory_incoming_unit_check"(NEW."tenantId", NEW."incomingInspectionId", 'component', NEW."id");
  IF NEW."seq" < 1 OR NEW."checkedQuantity" < 1 OR NEW."defectiveQuantity" NOT BETWEEN 0 AND NEW."checkedQuantity" THEN
    RAISE EXCEPTION 'quality: component result % has a place from 1, pieces checked from 1, and those not right from 0 up to them', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" <> 'PROTECTOR' AND NEW."protectorType" IS NOT NULL THEN
    RAISE EXCEPTION 'quality: component result % is %; only a protector has a type', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "IncomingComponentResult_guard" BEFORE INSERT OR UPDATE OR DELETE ON "IncomingComponentResult"
  FOR EACH ROW EXECUTE FUNCTION "factory_incoming_component_result_guard"();

-- =====================================================================================================================
-- In-process checks (QHS-039 … QHS-042, MES-127)

-- InProcessCheck
--   INSERT     OPEN, or DECIDED at once (an end-of-line pass); an APPROVED version of the kind's stage (FIRST_PIECE and
--              ROVING: IN_LINE; CUTTING; END_OF_LINE) when it names one; a profile in use.
--   UPDATE     company, kind, where, plan version and creation never change; a decided or cancelled check never changes
--              (a correction is an InspectionAmendment); profile and code letter stay fixed once counting starts.
--   every row  a bundle or an operation with its work order; FIRST_PIECE names the work order and its first bundle, CUTTING
--              the work order, ROVING and END_OF_LINE a line or a work order; pieces, defective pieces up to them, defects
--              from 0; at most one inspector, the floor only a worker; a code letter of ISO 2859-1.
--   DECIDED    an outcome of the kind (see InProcessOutcome), the time, one inspector, pieces from 1; a first piece also
--              the signature. On a plan, a passing outcome needs every mandatory result and no failed critical check.
--   CANCELLED  from OPEN, with when and why.
--   workerId   only behind the gate (Statuto art. 4): never from a floor session (the floor reads no legal basis), and only
--              while the site's PERFORMANCE legal gate is in force; employeeId is that worker's, and none without a worker.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_in_process_check_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  problem text;
  worker_employee uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: in-process check % is kept (cancelled when abandoned), never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'quality: in-process check % starts OPEN, or DECIDED at once', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."planVersionId" IS NOT NULL THEN
      PERFORM "factory_inspection_version_usable"(NEW."tenantId", NEW."planVersionId",
        ARRAY[CASE NEW."kind" WHEN 'CUTTING' THEN 'CUTTING' WHEN 'END_OF_LINE' THEN 'END_OF_LINE' ELSE 'IN_LINE' END], 'in-process check', NEW."id");
    END IF;
    IF NEW."aqlProfileId" IS NOT NULL THEN
      PERFORM "factory_inspection_profile_usable"(NEW."tenantId", NEW."aqlProfileId", 'in-process check', NEW."id");
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."kind", NEW."lineId", NEW."workOrderId", NEW."bundleId", NEW."workOrderOperationId", NEW."planVersionId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."kind", OLD."lineId", OLD."workOrderId", OLD."bundleId", OLD."workOrderOperationId", OLD."planVersionId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, kind, place, plan version and creation of in-process check % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: in-process check % is %; a decided or cancelled check never changes (a correction is an amendment)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."aqlProfileId" IS DISTINCT FROM OLD."aqlProfileId" AND NEW."aqlProfileId" IS NOT NULL THEN
      PERFORM "factory_inspection_profile_usable"(NEW."tenantId", NEW."aqlProfileId", 'in-process check', NEW."id");
    END IF;
    IF (NEW."aqlProfileId", NEW."codeLetter") IS DISTINCT FROM (OLD."aqlProfileId", OLD."codeLetter")
       AND "factory_inspection_counting_started"(NEW."tenantId", NULL, NULL, NEW."id") THEN
      RAISE EXCEPTION 'quality: the AQL profile of in-process check % is frozen once counting starts', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."bundleId" IS NOT NULL OR NEW."workOrderOperationId" IS NOT NULL) AND NEW."workOrderId" IS NULL THEN
    RAISE EXCEPTION 'quality: in-process check % names the work order of its bundle or operation', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'FIRST_PIECE' AND (NEW."workOrderId" IS NULL OR NEW."bundleId" IS NULL))
     OR (NEW."kind" = 'CUTTING' AND NEW."workOrderId" IS NULL)
     OR (NEW."kind" IN ('ROVING', 'END_OF_LINE') AND NEW."lineId" IS NULL AND NEW."workOrderId" IS NULL) THEN
    RAISE EXCEPTION 'quality: in-process check % is % without its place: a first piece names its work order and first bundle, a cutting check its work order, a roving or end-of-line check a line or a work order', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."pieces" < 0 OR NEW."defectivePieces" NOT BETWEEN 0 AND NEW."pieces" OR NEW."defects" < 0 THEN
    RAISE EXCEPTION 'quality: in-process check % counts pieces from 0, those with a defect up to them, and defects from 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."codeLetter" IS NOT NULL AND NOT "factory_inspection_letter_ok"(NEW."codeLetter") THEN
    RAISE EXCEPTION 'quality: in-process check % has an ISO 2859-1 code letter (A to R, no I or O), not %', NEW."id", NEW."codeLetter"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."inspectorWorkerId" IS NOT NULL AND NEW."inspectorUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'quality: in-process check % names one inspector: a worker of the site or an office user', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'factory_floor_runtime' AND NEW."inspectorUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'quality: the floor records the check of a worker (the signed-in floor inspector), not of an office user (in-process check %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DECIDED') <> (NEW."outcome" IS NOT NULL) OR (NEW."status" = 'DECIDED') <> (NEW."decidedAt" IS NOT NULL)
     OR (NEW."status" = 'DECIDED' AND (NEW."pieces" < 1 OR (NEW."inspectorWorkerId" IS NULL AND NEW."inspectorUserId" IS NULL))) THEN
    RAISE EXCEPTION 'quality: in-process check % is %; its outcome, time, inspector and pieces from 1 are set exactly when DECIDED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> 'DECIDED' AND NEW."signatureSha256" IS NOT NULL
     OR (NEW."kind" = 'FIRST_PIECE' AND NEW."status" = 'DECIDED' AND btrim(coalesce(NEW."signatureSha256", '')) = '') THEN
    RAISE EXCEPTION 'quality: in-process check % has a signature only when decided, and a first piece always then', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."outcome" IS NOT NULL AND NOT (
    CASE NEW."kind"
      WHEN 'FIRST_PIECE' THEN NEW."outcome" IN ('APPROVED', 'REJECTED')
      WHEN 'ROVING' THEN NEW."outcome" IN ('GREEN', 'AMBER', 'RED')
      ELSE NEW."outcome" IN ('PASS', 'FAIL')
    END
  ) THEN
    RAISE EXCEPTION 'quality: a % check is not %', NEW."kind", NEW."outcome"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'quality: in-process check % is %; when and why it was cancelled are set exactly when CANCELLED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."workerId" IS NULL AND NEW."employeeId" IS NOT NULL THEN
    RAISE EXCEPTION 'quality: in-process check % names an employee only with their worker', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."workerId" IS NOT NULL AND (TG_OP = 'INSERT' OR (NEW."workerId", NEW."employeeId") IS DISTINCT FROM (OLD."workerId", OLD."employeeId")) THEN
    IF current_user = 'factory_floor_runtime' THEN
      RAISE EXCEPTION 'quality: a floor session never names the operator of a check (in-process check %): results are per operation by default (Statuto art. 4)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "PeopleLegalGate" g WHERE g."tenantId" = NEW."tenantId" AND g."siteId" = NEW."siteId"
                     AND g."purpose" = 'PERFORMANCE' AND g."switchedOffAt" IS NULL) THEN
      RAISE EXCEPTION 'quality: in-process check % names an operator only while the site''s PERFORMANCE legal gate is switched on (Statuto art. 4 c.1; People › Settings)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT w."employeeId" INTO worker_employee FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workerId";
    IF FOUND AND worker_employee IS DISTINCT FROM NEW."employeeId" THEN
      RAISE EXCEPTION 'quality: in-process check % keeps the operator''s own employee', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" = 'DECIDED' AND NEW."planVersionId" IS NOT NULL AND NEW."outcome" IN ('APPROVED', 'PASS', 'GREEN')
     AND (TG_OP = 'INSERT' OR OLD."status" = 'OPEN') THEN
    problem := "factory_inspection_results_problem"(NEW."tenantId", NEW."planVersionId", NULL, NULL, NEW."id");
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'quality: in-process check % is not % on its plan: %', NEW."id", NEW."outcome", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InProcessCheck_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InProcessCheck"
  FOR EACH ROW EXECUTE FUNCTION "factory_in_process_check_guard"();

-- The first-piece hold (QHS-039): a FIRST_PIECE check of a work order holds its run (at its operation or, naming none, at
-- all of them) until one of the run is APPROVED, whatever its status short of CANCELLED: other bundles' work there is
-- refused. The first bundle itself goes through, or there is nothing to check. A work order nobody asked a first piece of
-- is not held. PAUSE and HAND_BACK always pass (stopping the clock must work, as for the holds), and so do UNDO and
-- CORRECTION (they mend what was recorded; no new work).
CREATE FUNCTION "factory_operation_scan_first_piece_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run record;
BEGIN
  SELECT count(*) AS "asked", count(*) FILTER (WHERE c."outcome" = 'APPROVED') AS "approved", coalesce(bool_or(c."bundleId" = NEW."bundleId"), false) AS "firstBundle"
    INTO run
    FROM "InProcessCheck" c
   WHERE c."tenantId" = NEW."tenantId" AND c."workOrderId" = NEW."workOrderId" AND c."kind" = 'FIRST_PIECE' AND c."status" <> 'CANCELLED'
     AND (c."workOrderOperationId" IS NULL OR c."workOrderOperationId" = NEW."workOrderOperationId");
  IF run."asked" > 0 AND run."approved" = 0 AND NOT run."firstBundle" THEN
    RAISE EXCEPTION 'quality: work order % waits for its first piece: this operation runs once a first piece is approved (QHS-039)', NEW."workOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OperationScan_awaits_first_piece" BEFORE INSERT ON "OperationScan"
  FOR EACH ROW WHEN (NEW."kind"::text NOT IN ('PAUSE', 'HAND_BACK', 'UNDO', 'CORRECTION'))
  EXECUTE FUNCTION "factory_operation_scan_first_piece_check"();

-- =====================================================================================================================
-- Results and measurements (of a final inspection, an incoming inspection or an in-process check)

-- InspectionCheckResult
--   every write  only while its record is OPEN (the record's row FOR SHARE).
--   UPDATE       the record, check, unit and creation never change.
--   every row    exactly one record; a check of the plan version frozen on it; never an INSTRUCTION; the unit from 1; a
--                value of the check's type unless NOT_APPLICABLE; a measurement against the check's nominal has the outcome
--                its value gives; who recorded it.
CREATE FUNCTION "factory_inspection_check_result_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  asked record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO parent FROM "factory_inspection_record"(OLD."tenantId", OLD."inspectionId", OLD."incomingInspectionId", OLD."inProcessCheckId");
    IF parent.state IS NOT NULL AND parent.state <> 'OPEN' THEN
      RAISE EXCEPTION 'quality: result % stays: its record is % (a correction is an amendment)', OLD."id", parent.state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."id", NEW."inspectionId", NEW."incomingInspectionId", NEW."inProcessCheckId", NEW."planCheckId", NEW."sampleIndex", NEW."createdAt", NEW."createdById")
     IS DISTINCT FROM (OLD."id", OLD."inspectionId", OLD."incomingInspectionId", OLD."inProcessCheckId", OLD."planCheckId", OLD."sampleIndex", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'quality: the record, check, unit and creation of result % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nonnulls(NEW."inspectionId", NEW."incomingInspectionId", NEW."inProcessCheckId") <> 1 THEN
    RAISE EXCEPTION 'quality: result % is of exactly one record: a final inspection, an incoming inspection or an in-process check', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO parent FROM "factory_inspection_record"(NEW."tenantId", NEW."inspectionId", NEW."incomingInspectionId", NEW."inProcessCheckId");
  IF parent.state IS NOT NULL AND parent.state <> 'OPEN' THEN
    RAISE EXCEPTION 'quality: result % waits for an OPEN record; its record is % (a correction is an amendment)', NEW."id", parent.state
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c."planVersionId", c."type"::text AS "type", c."nominal", c."tolerance", c."choices" INTO asked
    FROM "InspectionPlanCheck" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."planCheckId";
  IF FOUND THEN
    IF parent.state IS NOT NULL AND asked."planVersionId" IS DISTINCT FROM parent.plan_version THEN
      RAISE EXCEPTION 'quality: result % answers a check of the plan version frozen on its record (QHS-016)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF asked."type" = 'INSTRUCTION' THEN
      RAISE EXCEPTION 'quality: result %: an instruction takes no result', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."outcome" <> 'NOT_APPLICABLE' THEN
      IF (asked."type" = 'MEASUREMENT' AND coalesce(NEW."value", '') !~ '^-?\d+(\.\d+)?$')
         OR (asked."type" = 'COUNT' AND coalesce(NEW."value", '') !~ '^\d+$')
         OR (asked."type" = 'CHOICE' AND NOT coalesce(NEW."value" = ANY (asked."choices"), false))
         OR (asked."type" = 'FREE_TEXT' AND btrim(coalesce(NEW."value", '')) = '') THEN
        RAISE EXCEPTION 'quality: result %: a % check takes its value (a decimal, a whole number, one of its choices, words)', NEW."id", asked."type"
          USING ERRCODE = 'check_violation';
      END IF;
      IF asked."type" = 'MEASUREMENT' AND asked."nominal" IS NOT NULL
         AND (NEW."outcome" = 'PASS') <> (abs(NEW."value"::numeric - asked."nominal") <= asked."tolerance") THEN
        RAISE EXCEPTION 'quality: result %: % against % ± % is a %, by the numbers', NEW."id", NEW."value", asked."nominal", asked."tolerance",
          (CASE WHEN NEW."outcome" = 'PASS' THEN 'FAIL' ELSE 'PASS' END)
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."sampleIndex" < 1 THEN
    RAISE EXCEPTION 'quality: result % is about a unit of the sample from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM "factory_inspection_recorder_check"(NEW."recordedById", NEW."recordedByWorkerId", NEW."deviceId", 'result', NEW."id");
  RETURN NEW;
END
$$;

CREATE TRIGGER "InspectionCheckResult_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InspectionCheckResult"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_check_result_guard"();

-- InspectionMeasurement
--   every write  only while its record is OPEN (the record's row FOR SHARE).
--   UPDATE       the record, point, size, unit and creation never change.
--   every row    exactly one record; a point code without spaces; the unit from 1; nominal and measured from 0, tolerance
--                from 0; a plan check is a MEASUREMENT of the version frozen on the record, and its nominal, tolerance and
--                unit, when it has them, are the row's; who recorded it. The database writes `pass`.
CREATE FUNCTION "factory_inspection_measurement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  asked record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO parent FROM "factory_inspection_record"(OLD."tenantId", OLD."inspectionId", OLD."incomingInspectionId", OLD."inProcessCheckId");
    IF parent.state IS NOT NULL AND parent.state <> 'OPEN' THEN
      RAISE EXCEPTION 'quality: measurement % stays: its record is % (a correction is an amendment)', OLD."id", parent.state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."id", NEW."inspectionId", NEW."incomingInspectionId", NEW."inProcessCheckId", NEW."planCheckId", NEW."pointCode", NEW."size", NEW."sampleIndex", NEW."createdAt", NEW."createdById")
     IS DISTINCT FROM (OLD."id", OLD."inspectionId", OLD."incomingInspectionId", OLD."inProcessCheckId", OLD."planCheckId", OLD."pointCode", OLD."size", OLD."sampleIndex", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'quality: the record, point, size, unit and creation of measurement % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nonnulls(NEW."inspectionId", NEW."incomingInspectionId", NEW."inProcessCheckId") <> 1 THEN
    RAISE EXCEPTION 'quality: measurement % is of exactly one record: a final inspection, an incoming inspection or an in-process check', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO parent FROM "factory_inspection_record"(NEW."tenantId", NEW."inspectionId", NEW."incomingInspectionId", NEW."inProcessCheckId");
  IF parent.state IS NOT NULL AND parent.state <> 'OPEN' THEN
    RAISE EXCEPTION 'quality: measurement % waits for an OPEN record; its record is % (a correction is an amendment)', NEW."id", parent.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_inspection_code_ok"(NEW."pointCode") OR NEW."sampleIndex" < 1 OR NEW."nominal" < 0 OR NEW."tolerance" < 0 OR NEW."measured" < 0 THEN
    RAISE EXCEPTION 'quality: measurement % has a point code without spaces, a unit of the sample from 1, and nominal, tolerance and value from 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."planCheckId" IS NOT NULL THEN
    SELECT c."planVersionId", c."type"::text AS "type", c."nominal", c."tolerance", c."uom" INTO asked
      FROM "InspectionPlanCheck" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."planCheckId";
    IF FOUND THEN
      IF asked."type" <> 'MEASUREMENT' OR (parent.state IS NOT NULL AND asked."planVersionId" IS DISTINCT FROM parent.plan_version) THEN
        RAISE EXCEPTION 'quality: measurement % answers a MEASUREMENT check of the plan version frozen on its record (QHS-016)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF asked."nominal" IS NOT NULL AND (NEW."nominal", NEW."tolerance", NEW."uom") IS DISTINCT FROM (asked."nominal", asked."tolerance", asked."uom") THEN
        RAISE EXCEPTION 'quality: measurement % keeps its check''s nominal, tolerance and unit (% ± % %)', NEW."id", asked."nominal", asked."tolerance", asked."uom"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  PERFORM "factory_inspection_recorder_check"(NEW."recordedById", NEW."recordedByWorkerId", NEW."deviceId", 'measurement', NEW."id");
  NEW."pass" := abs(NEW."measured" - NEW."nominal") <= NEW."tolerance";
  RETURN NEW;
END
$$;

CREATE TRIGGER "InspectionMeasurement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InspectionMeasurement"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_measurement_guard"();

-- =====================================================================================================================
-- Amendments (QHS-145)

-- InspectionAmendment: append-only, for every login (no update or delete grant either).
--   every row  exactly one record, signed (PASSED, FAILED or DECIDED); a signature.
--   REQUEST    the field, the value after, the reason; the row it is on, type and id, both or neither; answers nothing.
--   SIGNED     answers a REQUEST of the same record, says nothing of its own; never signed by who asked.
--   REFUSED    the same, with the reason.
-- One answer per request (the unique key): two people answering at once meet there.
CREATE FUNCTION "factory_inspection_amendment_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'quality: amendments are append-only: % on "%" is refused', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_inspection_amendment_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  asked record;
BEGIN
  IF num_nonnulls(NEW."inspectionId", NEW."incomingInspectionId", NEW."inProcessCheckId") <> 1 THEN
    RAISE EXCEPTION 'quality: amendment % is of exactly one record: a final inspection, an incoming inspection or an in-process check', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO parent FROM "factory_inspection_record"(NEW."tenantId", NEW."inspectionId", NEW."incomingInspectionId", NEW."inProcessCheckId");
  IF parent.state IS NOT NULL AND parent.state NOT IN ('PASSED', 'FAILED', 'DECIDED') THEN
    RAISE EXCEPTION 'quality: amendment %: a record is amended once it is signed; this one is %', NEW."id", parent.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."signatureSha256") = '' THEN
    RAISE EXCEPTION 'quality: amendment % carries its signature', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'REQUEST' THEN
    IF NEW."requestId" IS NOT NULL OR btrim(coalesce(NEW."field", '')) = '' OR NEW."after" IS NULL OR btrim(coalesce(NEW."reason", '')) = ''
       OR (NEW."recordType" IS NULL) <> (NEW."recordId" IS NULL) OR btrim(NEW."recordType") = '' THEN
      RAISE EXCEPTION 'quality: amendment % asks for the field, the value after and the reason; the row it is on by type and id, both or neither (QHS-145)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."requestId" IS NULL OR num_nonnulls(NEW."field", NEW."recordType", NEW."recordId", NEW."before", NEW."after") > 0 THEN
    RAISE EXCEPTION 'quality: amendment % answers its request and says nothing of its own', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'REFUSED' AND btrim(coalesce(NEW."reason", '')) = '' THEN
    RAISE EXCEPTION 'quality: amendment % refuses a correction with the reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r."kind"::text AS "kind", r."signedById", r."inspectionId", r."incomingInspectionId", r."inProcessCheckId" INTO asked
    FROM "InspectionAmendment" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."requestId";
  IF FOUND THEN
    IF asked."kind" <> 'REQUEST' OR (asked."inspectionId", asked."incomingInspectionId", asked."inProcessCheckId")
       IS DISTINCT FROM (NEW."inspectionId", NEW."incomingInspectionId", NEW."inProcessCheckId") THEN
      RAISE EXCEPTION 'quality: amendment % answers a request of its own record', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF asked."signedById" = NEW."signedById" THEN
      RAISE EXCEPTION 'quality: amendment %: the person who asked for a correction does not sign it (QHS-145: a second person does)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InspectionAmendment_check" BEFORE INSERT ON "InspectionAmendment"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_amendment_check"();
CREATE TRIGGER "InspectionAmendment_append_only" BEFORE UPDATE OR DELETE ON "InspectionAmendment"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_amendment_append_only"();
CREATE TRIGGER "InspectionAmendment_no_truncate" BEFORE TRUNCATE ON "InspectionAmendment"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_inspection_amendment_append_only"();

-- =====================================================================================================================
-- Numbering: INCOMING_INSPECTION is a floor document kind

-- factory_number_series_floor_guard and factory_number_allocation_floor_guard (…_followups_quality_money_w2b_guards): their
-- whole bodies, with INCOMING_INSPECTION among the floor's document kinds (factory-domain numbering/kinds
-- FLOOR_DOCUMENT_KINDS; ownership/numbering.json onlyValues). Their triggers stay as they are.
CREATE OR REPLACE FUNCTION "factory_number_series_floor_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  site_company uuid;
BEGIN
  IF current_user <> 'factory_floor_runtime' THEN
    RETURN NULL;
  END IF;
  IF NEW."fiscal" OR NEW."kind"::text IN ('DDT', 'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE')
     OR NEW."kind"::text NOT IN ('GOODS_RECEIPT', 'LOT', 'INSPECTION', 'RELEASE', 'HOLD', 'NCR', 'INCOMING_INSPECTION') THEN
    RAISE EXCEPTION 'number series %: a tablet numbers goods receipts, lots, inspections, releases, holds, NCRs and incoming inspections only, never from a fiscal series; a % series is the office''s', NEW."id", (CASE WHEN NEW."fiscal" THEN 'fiscal ' ELSE '' END) || NEW."kind"::text
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
  IF NEW."kind"::text NOT IN ('GOODS_RECEIPT', 'LOT', 'INSPECTION', 'RELEASE', 'HOLD', 'NCR', 'INCOMING_INSPECTION') THEN
    RAISE EXCEPTION 'number % (%): a tablet numbers goods receipts, lots, inspections, releases, holds, NCRs and incoming inspections only', NEW."formatted", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."companyId", s."kind"::text AS "kind", s."fiscal", s."nextValue" INTO series
    FROM "NumberSeries" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."seriesId";
  IF NOT FOUND OR series."fiscal" THEN
    RAISE EXCEPTION 'number % (%): series % is not one a tablet numbers from (a goods receipt, lot, inspection, release, hold, NCR or incoming inspection series)', NEW."formatted", NEW."kind", NEW."seriesId"
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
