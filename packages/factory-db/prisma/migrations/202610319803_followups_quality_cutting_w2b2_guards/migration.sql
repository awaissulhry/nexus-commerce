-- Written by hand (Prisma does not model triggers), after the generated 202610319802_followups_quality_cutting_w2b2_schema
-- and before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- W2b schema wave 24/33 (B-W2b-204): the quality and cutting follow-ups the W2b-2 notes named as schema needs. The inspected
-- count on the three inspection records (B-W2b-93, -97, -98, -99, -111) and the in-process check's frozen AQL sample; the
-- rule that opened a record, so a rule may open a final inspection with no inspector yet (B-W2b-101, -106); a rule's due
-- hours and the in-process check's due time; the shade rule, the hide photo and the minimum remnant per site (B-W2b-100,
-- -103); the company's leather area tolerance (B-W2b-80, -94, -98); a recut closed by its ticket and a VOID ticket replaced
-- (B-W2b-117); the second-quality move of a downgrade by key (B-W2b-85, -126); the tenant's severity words (B-W2b-90, -118).
--
-- apps/factory-api checks all of this first, in words; these rules hold for every login, the owner included. Every refusal
-- is a check_violation (Prisma keeps its words). The new triggers are AFTER triggers (the policies speak first); the three
-- redefined functions keep their BEFORE triggers. No trigger compares "tenantId" or "siteId" of the row it guards; a rule
-- that reads another row skips a row this session cannot see (the policies and the references decide it); the floor role,
-- which has no grant on InspectionTrigger, never reaches a read of it. An UPDATE that changes nothing passes.
--
-- Earlier functions redefined here, each its whole body:
--   factory_inspection_guard            (…_quality_final_release_guards, W1; not redefined since): an inspection a rule
--                                       opened has no inspector while OPEN or CANCELLED; a decided one has exactly one.
--   factory_replacement_request_guard   (…_cutting_room_w2b_guards, W2b wave 13/16; not redefined since): a RECUT is DONE by
--                                       its cut log entry or by its DONE recut ticket; a VOID ticket is replaced while OPEN.
--   factory_garment_downgrade_guard     (…_cutting_room_w2b_guards, W2b wave 13/16; not redefined since): its second-quality
--                                       move is named at insert or once later.
-- NEW triggers (their own functions): Inspection_followups_w2b2, IncomingInspection_followups_w2b2,
-- InProcessCheck_followups_w2b2, InspectionTrigger_due_hours_check, ProductionSettings_cutting_check,
-- PurchasingSettings_leather_tolerance_check, QualitySettings_severity_texts_check, GarmentDowngrade_move_check.
-- No new table, so no TRUNCATE trigger.

-- =====================================================================================================================
-- 1. Inspections: the inspected count, the rule that opened a record, due times (B-W2b-93, -97 … -101, -106, -111)
-- =====================================================================================================================

-- The rule a record names as the one that opened it (openedByTriggerId; its company by the reference): a rule of one of the
-- events that open that kind of record, and the record runs on a version of the rule's plan (the opening takes the plan's
-- APPROVED version). A rule this session cannot see: left to the policies and the reference.
CREATE FUNCTION "factory_inspection_opened_by_rule_check"(tenant uuid, rule_id uuid, plan_version uuid, events text[], what text, record uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  rule record;
BEGIN
  SELECT t."event"::text AS event, t."planId" INTO rule FROM "InspectionTrigger" t WHERE t."tenantId" = tenant AND t."id" = rule_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF rule.event <> ALL (events) THEN
    RAISE EXCEPTION 'quality: % % names rule % (%) as the one that opened it; only a rule of % opens one', what, record, rule_id, rule.event, array_to_string(events, ', ')
      USING ERRCODE = 'check_violation';
  END IF;
  IF plan_version IS NULL
     OR NOT EXISTS (SELECT 1 FROM "InspectionPlanVersion" v WHERE v."tenantId" = tenant AND v."id" = plan_version AND v."planId" = rule."planId") THEN
    RAISE EXCEPTION 'quality: % % was opened by rule %; it runs on a version of that rule''s plan', what, record, rule_id
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- Inspection: REDEFINES factory_inspection_guard (202610285701_quality_final_release_guards), its whole body. Its rules
-- stand; W2b schema wave 24/33: an inspection a rule opened (openedByTriggerId) names no inspector while it is OPEN or
-- CANCELLED (the first inspector who takes it is written then); every other row names exactly one, and a decided
-- inspection always does (W1's four-eyes check reads it at the decision).
CREATE OR REPLACE FUNCTION "factory_inspection_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  order_state text;
  pieces bigint;
  critical bigint;
  major bigint;
  minor bigint;
  checklist_fails boolean;
  computed "InspectionResult";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: inspection % is kept (cancelled when abandoned), never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'quality: inspection % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."workOrderId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."workOrderId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, work order and creation of inspection % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: inspection % is %; a decided or cancelled inspection never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."lotSize" < 1 OR NEW."sampleSize" < 1 OR NEW."sampleSize" > NEW."lotSize"
     OR NEW."acceptMajor" < 0 OR NEW."acceptMinor" < 0 OR NEW."acceptMajor" > NEW."sampleSize" OR NEW."acceptMinor" > NEW."sampleSize"
     OR NEW."aqlMajor" < 0 OR NEW."aqlMinor" < 0 OR btrim(NEW."inspectionLevel") = '' THEN
    RAISE EXCEPTION 'quality: inspection % has a lot from 1, a sample from 1 up to the lot, acceptance numbers from 0 up to the sample, AQLs from 0 and an inspection level (ISO 2859-1)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-4 (wave 24/33): exactly one inspector, but none while OPEN or CANCELLED on an inspection a rule opened (the first
  -- inspector who takes it is written then). A decided inspection always has one.
  IF (NEW."inspectorWorkerId" IS NOT NULL AND NEW."inspectorUserId" IS NOT NULL)
     OR (NEW."inspectorWorkerId" IS NULL AND NEW."inspectorUserId" IS NULL
         AND (NEW."openedByTriggerId" IS NULL OR NEW."status" NOT IN ('OPEN', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'quality: inspection % names exactly one inspector: a worker of the site or an office user (only an inspection a rule opened waits for one while OPEN)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'factory_floor_runtime' AND NEW."inspectorUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'quality: the floor records the inspection of a worker (the signed-in floor inspector), not of an office user (inspection %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('PASSED', 'FAILED')) <> (NEW."decidedAt" IS NOT NULL)
     OR (NEW."status" IN ('PASSED', 'FAILED')) <> (btrim(coalesce(NEW."signatureSha256", '')) <> '') THEN
    RAISE EXCEPTION 'quality: inspection % is % with the wrong decision: its time and signature are set exactly when PASSED or FAILED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  -- The computed result and an override's reason belong to the decision (an OPEN or CANCELLED inspection has neither;
  -- the decision below writes the computed result).
  IF NEW."status" NOT IN ('PASSED', 'FAILED') AND (NEW."computedResult" IS NOT NULL OR NEW."overrideReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: inspection % is %; only a decided inspection has a computed result or an override reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT w."status"::text, (SELECT sum(c."quantity") FROM "WorkOrderSize" c WHERE c."tenantId" = w."tenantId" AND c."workOrderId" = w."id")
    INTO order_state, pieces
    FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF NOT FOUND THEN
    -- Outside this session's scope: the policies refuse the row.
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND order_state NOT IN ('RELEASED', 'IN_PROGRESS', 'COMPLETED') THEN
    RAISE EXCEPTION 'quality: work order % is %; its garments are inspected while it is RELEASED, IN_PROGRESS or COMPLETED', NEW."workOrderId", order_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lotSize" > coalesce(pieces, 0) THEN
    RAISE EXCEPTION 'quality: inspection % judges a lot of % garment(s); work order % has %', NEW."id", NEW."lotSize", NEW."workOrderId", coalesce(pieces, 0)
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" = 'OPEN' AND NEW."status" IN ('PASSED', 'FAILED') THEN
    IF NEW."checklist" IS NULL OR jsonb_typeof(NEW."checklist") <> 'array' OR jsonb_array_length(NEW."checklist") = 0 THEN
      RAISE EXCEPTION 'quality: inspection % is decided with its garment and label checklist (QHS-050): a list of checked items', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_quality_check_not_maker"(NEW."tenantId", NEW."workOrderId", NEW."inspectorWorkerId", NEW."inspectorUserId", NEW."notMakerStatement", 'inspection', NEW."id");
    SELECT coalesce(sum(d."quantity") FILTER (WHERE d."defectClass" = 'CRITICAL'), 0),
           coalesce(sum(d."quantity") FILTER (WHERE d."defectClass" = 'MAJOR'), 0),
           coalesce(sum(d."quantity") FILTER (WHERE d."defectClass" = 'MINOR'), 0)
      INTO critical, major, minor
      FROM "InspectionDefect" d WHERE d."tenantId" = NEW."tenantId" AND d."inspectionId" = NEW."id";
    IF critical > NEW."sampleSize" OR major > NEW."sampleSize" OR minor > NEW."sampleSize" THEN
      RAISE EXCEPTION 'quality: inspection % counts more defective garments in a class than its sample of %', NEW."id", NEW."sampleSize"
        USING ERRCODE = 'check_violation';
    END IF;
    -- The computed result (QHS-013): any critical defect, more major or minor defective garments than the acceptance
    -- numbers, or a checklist item not ok FAILS; written here, never by the API.
    checklist_fails := jsonb_path_exists(NEW."checklist", '$[*] ? (@.ok == false)');
    computed := CASE WHEN critical > 0 OR major > NEW."acceptMajor" OR minor > NEW."acceptMinor" OR checklist_fails THEN 'FAIL'::"InspectionResult" ELSE 'PASS'::"InspectionResult" END;
    NEW."computedResult" := computed;
    IF NEW."status" = 'PASSED' THEN
      IF critical > 0 THEN
        RAISE EXCEPTION 'quality: inspection % found % critical defect(s); a critical defect is never accepted, it FAILS', NEW."id", critical
          USING ERRCODE = 'check_violation';
      END IF;
      IF checklist_fails THEN
        RAISE EXCEPTION 'quality: inspection % has a checklist item that is not ok; it does not PASS', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (major > NEW."acceptMajor" OR minor > NEW."acceptMinor") AND btrim(coalesce(NEW."overrideReason", '')) = '' THEN
        RAISE EXCEPTION 'quality: inspection % found % major and % minor defective garment(s); its plan accepts % and %, so it FAILS (a PASS over it is an override with the inspector''s written reason, QHS-013)', NEW."id", major, minor, NEW."acceptMajor", NEW."acceptMinor"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    -- An override (QHS-013): the decision differs from the computed result exactly when the inspector wrote why.
    IF (NEW."status" = 'PASSED') <> (computed = 'PASS') AND btrim(coalesce(NEW."overrideReason", '')) = '' THEN
      RAISE EXCEPTION 'quality: inspection % is decided % against its computed result %; an override carries the inspector''s written reason (QHS-013)', NEW."id", NEW."status", computed
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."status" = 'PASSED') = (computed = 'PASS') AND NEW."overrideReason" IS NOT NULL THEN
      RAISE EXCEPTION 'quality: inspection % is decided % as computed; it has no override reason', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Inspection (new trigger Inspection_followups_w2b2; W1's, W2a's and wave 10's triggers untouched):
--   inspectedCount     from 0 up to the sample (null: not counted); once a unit is counted the AQL profile and code letter
--                      stay fixed (as once a defect, a result or a measurement is recorded: Inspection_plan_guard).
--   openedByTriggerId  given at insert, never by a floor session (the rules run in the worker), and never changed: a rule
--                      of an event that finishes garments (an operation finished, a bundle scanned, packing), and the
--                      inspection runs on a version of the rule's plan (a FINAL plan: Inspection_plan_guard).
-- A decided inspection is frozen with both by W1's guard.
CREATE FUNCTION "factory_inspection_followups_w2b2_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF NEW."inspectedCount" IS NOT NULL AND (NEW."inspectedCount" < 0 OR NEW."inspectedCount" > NEW."sampleSize") THEN
    RAISE EXCEPTION 'quality: inspection % counts the units inspected from 0 up to its sample of %, not %', NEW."id", NEW."sampleSize", NEW."inspectedCount"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."openedByTriggerId" IS NOT NULL THEN
      IF current_user = 'factory_floor_runtime' THEN
        RAISE EXCEPTION 'quality: inspection %: the rules open inspections in the worker; a floor session never names one', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM "factory_inspection_opened_by_rule_check"(NEW."tenantId", NEW."openedByTriggerId", NEW."planVersionId",
        ARRAY['OPERATION_FINISHED', 'BUNDLE_SCAN', 'PACKING'], 'final inspection', NEW."id");
    END IF;
  ELSE
    IF NEW."openedByTriggerId" IS DISTINCT FROM OLD."openedByTriggerId" THEN
      RAISE EXCEPTION 'quality: the rule that opened inspection % is given when it opens and never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."aqlProfileId", NEW."codeLetter") IS DISTINCT FROM (OLD."aqlProfileId", OLD."codeLetter") AND coalesce(OLD."inspectedCount", 0) > 0 THEN
      RAISE EXCEPTION 'quality: the AQL profile of inspection % is frozen once counting starts (% unit(s) counted)', OLD."id", OLD."inspectedCount"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Inspection_followups_w2b2" AFTER INSERT OR UPDATE ON "Inspection"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_followups_w2b2_guard"();

-- IncomingInspection (new trigger IncomingInspection_followups_w2b2; wave 10's guard untouched: it already lets an OPEN
-- inspection wait for its inspector):
--   inspectedCount     from 0 up to the sample (null: not counted); once a unit is counted the AQL profile and code letter
--                      stay fixed.
--   openedByTriggerId  given at insert, never by a floor session, never changed: a GOODS_RECEIPT rule, and the inspection
--                      runs on a version of the rule's plan.
CREATE FUNCTION "factory_incoming_inspection_followups_w2b2_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF NEW."inspectedCount" IS NOT NULL AND (NEW."inspectedCount" < 0 OR NEW."inspectedCount" > NEW."sampleSize") THEN
    RAISE EXCEPTION 'quality: incoming inspection % counts the units inspected from 0 up to its sample of %, not %', NEW."id", NEW."sampleSize", NEW."inspectedCount"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."openedByTriggerId" IS NOT NULL THEN
      IF current_user = 'factory_floor_runtime' THEN
        RAISE EXCEPTION 'quality: incoming inspection %: the rules open inspections in the worker; a floor session never names one', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM "factory_inspection_opened_by_rule_check"(NEW."tenantId", NEW."openedByTriggerId", NEW."planVersionId",
        ARRAY['GOODS_RECEIPT'], 'incoming inspection', NEW."id");
    END IF;
  ELSE
    IF NEW."openedByTriggerId" IS DISTINCT FROM OLD."openedByTriggerId" THEN
      RAISE EXCEPTION 'quality: the rule that opened incoming inspection % is given when it opens and never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."aqlProfileId", NEW."codeLetter") IS DISTINCT FROM (OLD."aqlProfileId", OLD."codeLetter") AND coalesce(OLD."inspectedCount", 0) > 0 THEN
      RAISE EXCEPTION 'quality: the AQL profile of incoming inspection % is frozen once counting starts (% unit(s) counted)', OLD."id", OLD."inspectedCount"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "IncomingInspection_followups_w2b2" AFTER INSERT OR UPDATE ON "IncomingInspection"
  FOR EACH ROW EXECUTE FUNCTION "factory_incoming_inspection_followups_w2b2_guard"();

-- InProcessCheck (new trigger InProcessCheck_followups_w2b2; wave 10's guard untouched: it already lets an OPEN check wait for
-- its inspector):
--   sampleSize         from 1 (null: none); it stays fixed once counting starts (a unit counted, a result or a measurement).
--   inspectedCount     from 0, up to the sample when there is one (null: not counted); once a unit is counted the AQL
--                      profile and code letter stay fixed.
--   dueAt              set and moved by the office (a rule's due hours, in the worker), never by a floor session.
--   openedByTriggerId  given at insert, never by a floor session, never changed: an OPERATION_FINISHED or BUNDLE_SCAN rule,
--                      and the check runs on a version of the rule's plan.
CREATE FUNCTION "factory_in_process_check_followups_w2b2_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF NEW."sampleSize" < 1 THEN
    RAISE EXCEPTION 'quality: in-process check % has an AQL sample from 1, not %', NEW."id", NEW."sampleSize"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."inspectedCount" < 0 OR NEW."inspectedCount" > NEW."sampleSize" THEN
    RAISE EXCEPTION 'quality: in-process check % counts the units inspected from 0, up to its sample of % when it has one, not %', NEW."id", NEW."sampleSize", NEW."inspectedCount"
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'factory_floor_runtime'
     AND ((TG_OP = 'INSERT' AND NEW."dueAt" IS NOT NULL) OR (TG_OP = 'UPDATE' AND NEW."dueAt" IS DISTINCT FROM OLD."dueAt")) THEN
    RAISE EXCEPTION 'quality: the office sets by when in-process check % is due; the floor does not', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."openedByTriggerId" IS NOT NULL THEN
      IF current_user = 'factory_floor_runtime' THEN
        RAISE EXCEPTION 'quality: in-process check %: the rules open checks in the worker; a floor session never names one', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM "factory_inspection_opened_by_rule_check"(NEW."tenantId", NEW."openedByTriggerId", NEW."planVersionId",
        ARRAY['OPERATION_FINISHED', 'BUNDLE_SCAN'], 'in-process check', NEW."id");
    END IF;
  ELSE
    IF NEW."openedByTriggerId" IS DISTINCT FROM OLD."openedByTriggerId" THEN
      RAISE EXCEPTION 'quality: the rule that opened in-process check % is given when it opens and never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF ((NEW."aqlProfileId", NEW."codeLetter") IS DISTINCT FROM (OLD."aqlProfileId", OLD."codeLetter") AND coalesce(OLD."inspectedCount", 0) > 0)
       OR (NEW."sampleSize" IS DISTINCT FROM OLD."sampleSize"
           AND (coalesce(OLD."inspectedCount", 0) > 0 OR "factory_inspection_counting_started"(NEW."tenantId", NULL, NULL, NEW."id"))) THEN
      RAISE EXCEPTION 'quality: the AQL profile and sample of in-process check % are frozen once counting starts', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "InProcessCheck_followups_w2b2" AFTER INSERT OR UPDATE ON "InProcessCheck"
  FOR EACH ROW EXECUTE FUNCTION "factory_in_process_check_followups_w2b2_guard"();

-- InspectionTrigger (new trigger InspectionTrigger_due_hours_check; wave 10's guard untouched): what a rule opens is due 1 to
-- 720 hours after it opens; null: no due time.
CREATE FUNCTION "factory_inspection_trigger_due_hours_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."dueHours" < 1 OR NEW."dueHours" > 720 THEN
    RAISE EXCEPTION 'quality: inspection rule % makes what it opens due 1 to 720 hours later (null: no due time), not %', NEW."id", NEW."dueHours"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "InspectionTrigger_due_hours_check" AFTER INSERT OR UPDATE OF "dueHours" ON "InspectionTrigger"
  FOR EACH ROW WHEN (NEW."dueHours" IS NOT NULL)
  EXECUTE FUNCTION "factory_inspection_trigger_due_hours_check"();

-- =====================================================================================================================
-- 2. Settings: the site's cutting rules, the leather area tolerance, the severity words (B-W2b-80, -90, -94, -100, -103)
-- =====================================================================================================================

-- ProductionSettings (new trigger ProductionSettings_cutting_check, beside the settings' guard and the floor checks'
-- trigger, neither redefined): the minimum remnant is an area (M2, DM2 or FT2) above 0 and at most 10 m² (a whole hide is
-- 4 to 6 m²). The shade rule and the photo switch are any of their values.
CREATE FUNCTION "factory_production_settings_cutting_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."minimumRemnantUom"::text NOT IN ('M2', 'DM2', 'FT2') OR NEW."minimumRemnantArea" <= 0
     OR NEW."minimumRemnantArea" * (CASE NEW."minimumRemnantUom"::text WHEN 'M2' THEN 1 WHEN 'DM2' THEN 0.01 ELSE 0.09290304 END) > 10 THEN
    RAISE EXCEPTION 'production: the floor rules % keep remnants from an area above 0 and at most 10 m², in M2, DM2 or FT2 (not % %)', NEW."id", NEW."minimumRemnantArea", NEW."minimumRemnantUom"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ProductionSettings_cutting_check" AFTER INSERT OR UPDATE OF "minimumRemnantArea", "minimumRemnantUom" ON "ProductionSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_production_settings_cutting_check"();

-- PurchasingSettings (new trigger PurchasingSettings_leather_tolerance_check; the settings' guard untouched): the leather
-- area tolerance is 0 to 100 percent, as an order line's; null: not set on this row.
CREATE FUNCTION "factory_purchasing_settings_leather_tolerance_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."leatherAreaTolerancePct" < 0 OR NEW."leatherAreaTolerancePct" > 100 THEN
    RAISE EXCEPTION 'purchasing: the purchasing settings % give leather lots an area tolerance of 0 to 100 percent (null: not set here), not %', NEW."id", NEW."leatherAreaTolerancePct"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PurchasingSettings_leather_tolerance_check" AFTER INSERT OR UPDATE OF "leatherAreaTolerancePct" ON "PurchasingSettings"
  FOR EACH ROW WHEN (NEW."leatherAreaTolerancePct" IS NOT NULL)
  EXECUTE FUNCTION "factory_purchasing_settings_leather_tolerance_check"();

-- The tenant's severity words (QualitySettings.severityTexts), in words what is wrong with them, or NULL: an object of the
-- classes CRITICAL, MAJOR, MINOR, each an object of "words" and "meaning" (CRITICAL: "words" only: its meaning is the
-- domain's locked text, QHS-002), each an object of language code (two or three lower-case letters) → text, not blank,
-- words up to 60 characters, a meaning up to 500.
CREATE FUNCTION "factory_severity_texts_problem"(texts jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  klass record;
  part record;
  language record;
BEGIN
  IF jsonb_typeof(texts) <> 'object' THEN
    RETURN 'an object of severity classes';
  END IF;
  FOR klass IN SELECT * FROM jsonb_each(texts) LOOP
    IF klass.key NOT IN ('CRITICAL', 'MAJOR', 'MINOR') THEN
      RETURN format('a class CRITICAL, MAJOR or MINOR, not %s', klass.key);
    END IF;
    IF jsonb_typeof(klass.value) <> 'object' THEN
      RETURN format('%s: an object of words and meaning', klass.key);
    END IF;
    FOR part IN SELECT * FROM jsonb_each(klass.value) LOOP
      IF part.key NOT IN ('words', 'meaning') THEN
        RETURN format('%s: words or meaning, not %s', klass.key, part.key);
      END IF;
      IF klass.key = 'CRITICAL' AND part.key = 'meaning' THEN
        RETURN 'CRITICAL keeps its locked meaning (a safety or compliance failure, never accepted): only its words are the tenant''s';
      END IF;
      IF jsonb_typeof(part.value) <> 'object' THEN
        RETURN format('%s %s: an object of language → text', klass.key, part.key);
      END IF;
      FOR language IN SELECT * FROM jsonb_each(part.value) LOOP
        IF language.key !~ '^[a-z]{2,3}$' OR jsonb_typeof(language.value) <> 'string' OR btrim(language.value #>> '{}') = ''
           OR char_length(language.value #>> '{}') > (CASE part.key WHEN 'words' THEN 60 ELSE 500 END) THEN
          RETURN format('%s %s in %s: a language code of two or three letters and a text of 1 to %s characters', klass.key, part.key, language.key,
                        CASE part.key WHEN 'words' THEN 60 ELSE 500 END);
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN NULL;
END
$$;

-- QualitySettings (new trigger QualitySettings_severity_texts_check, beside the earlier waves' triggers, none redefined): the
-- severity words are kept on the tenant-wide row only (the defect library is tenant-wide), in the shape above.
CREATE FUNCTION "factory_quality_settings_severity_texts_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text;
BEGIN
  IF NEW."companyId" IS NOT NULL THEN
    RAISE EXCEPTION 'quality: the severity words are the tenant''s, kept on its tenant-wide settings; settings % are a company''s', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  problem := "factory_severity_texts_problem"(NEW."severityTexts");
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'quality: the severity words of settings % are %', NEW."id", problem
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QualitySettings_severity_texts_check" AFTER INSERT OR UPDATE OF "severityTexts", "companyId" ON "QualitySettings"
  FOR EACH ROW WHEN (NEW."severityTexts" IS NOT NULL)
  EXECUTE FUNCTION "factory_quality_settings_severity_texts_check"();

-- =====================================================================================================================
-- 3. Cutting: a recut closed by its ticket, a VOID ticket replaced (B-W2b-117); the second-quality move (B-W2b-85, -126)
-- =====================================================================================================================

-- ReplacementRequest: REDEFINES factory_replacement_request_guard (202610318501_cutting_room_w2b_guards), its whole body. Its
-- rules stand; W2b schema wave 24/33:
--   DONE           a RECUT is DONE with its cut log entry (a leather recut, as before) or, without one, by its recut ticket
--                  once that ticket is DONE (a fabric recut is cut on its ticket, with no cut log entry); a cut log entry
--                  only on a DONE RECUT.
--   recutTicketId  given while OPEN (at insert too), never cleared; while OPEN another RECUT ticket of the same work order,
--                  cell and part (not VOID) takes its place once the named one is VOID.
CREATE OR REPLACE FUNCTION "factory_replacement_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  content CONSTANT text[] := ARRAY['quantity', 'part', 'reason'];
  progress CONSTANT text[] := ARRAY['status', 'decidedAt', 'decidedById', 'decisionNote', 'cutLogId', 'recutTicketId', 'doneAt', 'cancelledAt', 'cancelReason', 'note',
                                    'version', 'updatedAt'];
  order_state text;
  cell_quantity integer;
  decided boolean;
  ticket record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: replacement % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."decidedAt" IS NOT NULL OR NEW."decidedById" IS NOT NULL OR NEW."cutLogId" IS NOT NULL THEN
      RAISE EXCEPTION 'production: replacement % starts OPEN, undecided and not cut', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || content || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || content || progress)) THEN
      RAISE EXCEPTION 'production: the work order, cell, kind, sources and creation of replacement % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' AND (NEW."quantity", NEW."part", NEW."reason") IS DISTINCT FROM (OLD."quantity", OLD."part", OLD."reason") THEN
      RAISE EXCEPTION 'production: replacement % is %; its garments, part and reason change only while OPEN', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('DONE', 'REFUSED', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'production: replacement % is %; only its note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'OPEN' AND NEW."kind" = 'REDUCE' AND NEW."status" IN ('APPROVED', 'REFUSED'))
                OR (OLD."status" = 'OPEN' AND NEW."kind" = 'RECUT' AND NEW."status" = 'DONE')
                OR (OLD."status" = 'OPEN' AND NEW."status" = 'CANCELLED')
                OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('DONE', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'production: replacement % (%) cannot move from % to % (a REDUCE is approved or refused first, a RECUT is done by its cut)', OLD."id", OLD."kind", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."decidedAt" IS NOT NULL AND (NEW."decidedAt", NEW."decidedById", NEW."decisionNote") IS DISTINCT FROM (OLD."decidedAt", OLD."decidedById", OLD."decisionNote") THEN
      RAISE EXCEPTION 'production: replacement % was decided once; the decision stays', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b-2 (wave 13/16): the recut ticket is given while OPEN. W2b-4 (wave 24/33): it is never cleared, and while OPEN
    -- another ticket takes its place once the named one is VOID (B-W2b-117).
    IF NEW."recutTicketId" IS DISTINCT FROM OLD."recutTicketId" THEN
      IF OLD."status" <> 'OPEN' OR NEW."recutTicketId" IS NULL THEN
        RAISE EXCEPTION 'production: replacement %: its recut ticket is given while it is OPEN and never changes (never cleared; a VOID one is replaced)', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."recutTicketId" IS NOT NULL THEN
        SELECT t."number", t."status"::text AS status INTO ticket
          FROM "CutTicket" t WHERE t."tenantId" = OLD."tenantId" AND t."id" = OLD."recutTicketId";
        IF FOUND AND ticket.status <> 'VOID' THEN
          RAISE EXCEPTION 'production: replacement % is recut by ticket %, which is %; its recut ticket never changes until that one is VOID', OLD."id", ticket."number", ticket.status
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;

  IF NEW."quantity" < 1 OR btrim(NEW."reason") = '' OR (NEW."part" IS NOT NULL AND (NEW."kind" <> 'RECUT' OR btrim(NEW."part") = ''))
     OR (NEW."recordType" IS NULL) <> (NEW."recordId" IS NULL) OR btrim(coalesce(NEW."recordType", '-')) = '' THEN
    RAISE EXCEPTION 'production: replacement % has at least one garment, a reason, a part only for a RECUT, and the record behind it as type and id or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."recutTicketId" IS NOT NULL AND NEW."kind" <> 'RECUT' THEN
    RAISE EXCEPTION 'production: replacement % is a %; only a RECUT has a recut ticket', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  decided := NEW."status" IN ('APPROVED', 'REFUSED') OR (NEW."kind" = 'REDUCE' AND NEW."status" = 'DONE');
  IF (decided AND NEW."decidedAt" IS NULL)
     OR (NEW."status" = 'OPEN' AND NEW."decidedAt" IS NOT NULL)
     OR (NEW."kind" = 'RECUT' AND NEW."decidedAt" IS NOT NULL)
     OR (NEW."decidedAt" IS NULL) <> (NEW."decidedById" IS NULL)
     OR (NEW."decidedAt" IS NULL AND NEW."decisionNote" IS NOT NULL)
     OR (NEW."status" = 'REFUSED' AND btrim(coalesce(NEW."decisionNote", '')) = '') THEN
    RAISE EXCEPTION 'production: replacement % is % with the wrong decision: a REDUCE is approved or refused by someone, when, and a refusal says why; a RECUT has no decision', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decidedById" IS NOT NULL AND NEW."decidedById" = NEW."createdById" THEN
    RAISE EXCEPTION 'production: replacement % is decided by another person than the one who asked for it (four eyes)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-4 (wave 24/33): a RECUT is DONE by its cut log entry or by its recut ticket (DONE, below); a cut log entry only
  -- on a DONE RECUT.
  IF (NEW."cutLogId" IS NOT NULL AND NOT (NEW."kind" = 'RECUT' AND NEW."status" = 'DONE'))
     OR (NEW."kind" = 'RECUT' AND NEW."status" = 'DONE' AND NEW."cutLogId" IS NULL AND NEW."recutTicketId" IS NULL)
     OR (NEW."status" = 'DONE') <> (NEW."doneAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'production: replacement % is % with the wrong times: a RECUT is DONE exactly with its cut log entry or its DONE recut ticket (a cut log entry only then), done exactly when DONE, cancelled exactly with its time and reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
    IF order_state NOT IN ('RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED') THEN
      RAISE EXCEPTION 'production: work order % is %; its scrap is replaced while it is RELEASED, IN_PROGRESS, ON_HOLD or COMPLETED', NEW."workOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."sourceScanId" IS NOT NULL
       AND EXISTS (SELECT 1 FROM "OperationScan" s
                    WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sourceScanId" AND (s."workOrderId" <> NEW."workOrderId" OR s."scrapQuantity" < 1)) THEN
      RAISE EXCEPTION 'production: replacement % replaces the scrap of scan %, a scan of its work order with scrap', NEW."id", NEW."sourceScanId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."reworkOrderId" IS NOT NULL
       AND EXISTS (SELECT 1 FROM "ReworkOrder" r
                    WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."reworkOrderId" AND (r."status" <> 'DONE' OR r."scrapQuantity" < 1)) THEN
      RAISE EXCEPTION 'production: replacement % replaces the scrap of rework %, which is DONE with scrap', NEW."id", NEW."reworkOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW."quantity" IS DISTINCT FROM OLD."quantity" THEN
    SELECT c."quantity" INTO cell_quantity FROM "WorkOrderSize" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."workOrderSizeId";
    IF FOUND AND NEW."quantity" > cell_quantity THEN
      RAISE EXCEPTION 'production: replacement % asks for % garment(s); its cell makes %', NEW."id", NEW."quantity", cell_quantity
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."cutLogId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."cutLogId" IS DISTINCT FROM OLD."cutLogId") THEN
    IF EXISTS (SELECT 1 FROM "CutLog" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."cutLogId")
       AND NOT EXISTS (SELECT 1 FROM "CutLog" c JOIN "CutLogPiece" p ON p."tenantId" = c."tenantId" AND p."cutLogId" = c."id"
                        WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."cutLogId" AND c."reversalOfId" IS NULL
                          AND p."workOrderSizeId" = NEW."workOrderSizeId" AND (NEW."part" IS NULL OR p."part" = NEW."part")) THEN
      RAISE EXCEPTION 'production: replacement % is cut by cut log entry %, an entry (not a reversal) with pieces of its cell%', NEW."id", NEW."cutLogId",
        CASE WHEN NEW."part" IS NULL THEN '' ELSE format(' and part %s', NEW."part") END
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- W2b-4 (wave 24/33): a RECUT DONE without a cut log entry is done by its recut ticket, which is DONE (a fabric recut is cut
  -- on its ticket; B-W2b-117).
  IF NEW."kind" = 'RECUT' AND NEW."status" = 'DONE' AND NEW."cutLogId" IS NULL
     AND (TG_OP = 'INSERT' OR OLD."status" <> 'DONE' OR NEW."recutTicketId" IS DISTINCT FROM OLD."recutTicketId") THEN
    SELECT t."number", t."status"::text AS status INTO ticket
      FROM "CutTicket" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."recutTicketId";
    IF FOUND AND ticket.status <> 'DONE' THEN
      RAISE EXCEPTION 'production: replacement % is done by its recut ticket %, which is % (a RECUT is DONE once its ticket is DONE, or by its cut log entry)', NEW."id", ticket."number", ticket.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- W2b-2 (wave 13/16): the recut ticket is a RECUT ticket of its work order, cell and part, not VOID.
  IF NEW."recutTicketId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."recutTicketId" IS DISTINCT FROM OLD."recutTicketId") THEN
    SELECT t."number", t."kind"::text AS kind, t."status"::text AS status, t."workOrderId", t."workOrderSizeId", t."part" INTO ticket
      FROM "CutTicket" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."recutTicketId";
    IF FOUND AND (ticket.kind <> 'RECUT' OR ticket.status = 'VOID' OR ticket."workOrderId" IS DISTINCT FROM NEW."workOrderId"
                  OR ticket."workOrderSizeId" IS DISTINCT FROM NEW."workOrderSizeId" OR ticket."part" IS DISTINCT FROM NEW."part") THEN
      RAISE EXCEPTION 'production: replacement % is recut by ticket %: a RECUT ticket of its work order, cell and part that is not VOID', NEW."id", ticket."number"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- GarmentDowngrade: REDEFINES factory_garment_downgrade_guard (202610318501_cutting_room_w2b_guards), its whole body. Its
-- rules stand; W2b schema wave 24/33: moveId, its second-quality move, is named at insert or once later (a downgrade made
-- before the column), then never changed; the rest of the row still changes only by its withdrawal.
CREATE OR REPLACE FUNCTION "factory_garment_downgrade_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  withdrawing CONSTANT text[] := ARRAY['voidedAt', 'voidedById', 'voidReason', 'version', 'updatedAt'];
  work_order record;
  cell_quantity integer;
  item_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: downgrade % is withdrawn, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || withdrawing || ARRAY['moveId'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || withdrawing || ARRAY['moveId'])) THEN
      RAISE EXCEPTION 'production: downgrade % never changes; withdraw it and record another', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b-4 (wave 24/33): its second-quality move is named at insert or once later, then never changed.
    IF NEW."moveId" IS DISTINCT FROM OLD."moveId" AND OLD."moveId" IS NOT NULL THEN
      RAISE EXCEPTION 'production: downgrade % names its second-quality move once; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."voidedAt" IS NOT NULL AND (NEW."voidedAt", NEW."voidedById", NEW."voidReason") IS DISTINCT FROM (OLD."voidedAt", OLD."voidedById", OLD."voidReason") THEN
      RAISE EXCEPTION 'production: downgrade % is withdrawn already', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'production: downgrade % is new; it is not withdrawn', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."quantity" < 1 OR NOT "factory_inspection_code_ok"(NEW."reasonCode") OR num_nonnulls(NEW."secondQualityItemId", NEW."variantId") <> 1 THEN
    RAISE EXCEPTION 'production: downgrade % has garments from 1, a reason code without spaces, and exactly one of a second-quality item and a SKU', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nonnulls(NEW."voidedAt", NEW."voidedById", NEW."voidReason") NOT IN (0, 3) OR btrim(NEW."voidReason") = '' THEN
    RAISE EXCEPTION 'production: downgrade % says when, by whom and why it was withdrawn, or none of it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;

  SELECT w."status"::text AS status, w."styleId" INTO work_order FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF work_order.status NOT IN ('RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED') THEN
    RAISE EXCEPTION 'production: work order % is %; garments are downgraded while it is RELEASED, IN_PROGRESS, ON_HOLD or COMPLETED', NEW."workOrderId", work_order.status
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."quantity" INTO cell_quantity FROM "WorkOrderSize" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."workOrderSizeId";
  IF FOUND AND NEW."quantity" > cell_quantity THEN
    RAISE EXCEPTION 'production: downgrade % sends % garment(s) to second quality; its cell makes %', NEW."id", NEW."quantity", cell_quantity
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."bundleId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."bundleId" AND b."workOrderSizeId" <> NEW."workOrderSizeId") THEN
    RAISE EXCEPTION 'production: downgrade % names bundle % of another cell', NEW."id", NEW."bundleId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reworkOrderId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "ReworkOrder" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."reworkOrderId" AND r."workOrderSizeId" <> NEW."workOrderSizeId") THEN
    RAISE EXCEPTION 'production: downgrade % names rework % of another cell', NEW."id", NEW."reworkOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sourceScanId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sourceScanId" AND s."workOrderId" <> NEW."workOrderId") THEN
    RAISE EXCEPTION 'production: downgrade % names scan % of another work order', NEW."id", NEW."sourceScanId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."secondQualityItemId" IS NOT NULL THEN
    SELECT i."kind"::text INTO item_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."secondQualityItemId";
    IF FOUND AND item_kind <> 'FINISHED' THEN
      RAISE EXCEPTION 'production: downgrade % keeps the garments as item %, of kind %; a second-quality item is FINISHED', NEW."id", NEW."secondQualityItemId", item_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."variantId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "Variant" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."variantId" AND v."styleId" <> work_order."styleId") THEN
    RAISE EXCEPTION 'production: downgrade % keeps the garments as SKU %, of another style than the work order''s', NEW."id", NEW."variantId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- GarmentDowngrade (new trigger GarmentDowngrade_move_check): the move it names (when it names one, read as the role that
-- writes; the reference keeps it on the downgrade's site) put its garments into stock: an ADJUSTMENT or a
-- PRODUCTION_RECEIPT of the downgrade's work order into a place (from none), not a reversal, of its garments in pieces, of
-- its second-quality item, or of an item of its SKU; and no other downgrade names it.
CREATE FUNCTION "factory_garment_downgrade_move_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  move record;
BEGIN
  SELECT m."workOrderId", m."reason"::text AS reason, m."fromLocationId", m."toLocationId", m."reversalOfId", m."quantity", m."uom"::text AS uom,
         m."itemId", i."variantId" AS item_variant
    INTO move
    FROM "StockMove" m LEFT JOIN "Item" i ON i."tenantId" = m."tenantId" AND i."id" = m."itemId"
   WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."moveId";
  IF FOUND THEN
    IF move."workOrderId" IS DISTINCT FROM NEW."workOrderId" OR move.reason NOT IN ('ADJUSTMENT', 'PRODUCTION_RECEIPT')
       OR move."fromLocationId" IS NOT NULL OR move."toLocationId" IS NULL OR move."reversalOfId" IS NOT NULL
       OR move.uom <> 'PCS' OR move."quantity" <> NEW."quantity" THEN
      RAISE EXCEPTION 'production: downgrade % names move %; its second-quality move puts its % garment(s) of work order % into a place (an ADJUSTMENT or a PRODUCTION_RECEIPT in pieces, not a reversal)', NEW."id", NEW."moveId", NEW."quantity", NEW."workOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."secondQualityItemId" IS NOT NULL AND move."itemId" <> NEW."secondQualityItemId")
       OR (NEW."variantId" IS NOT NULL AND move.item_variant IS DISTINCT FROM NEW."variantId") THEN
      RAISE EXCEPTION 'production: downgrade % names move %, of another item than the one it keeps the garments as', NEW."id", NEW."moveId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM "GarmentDowngrade" g WHERE g."tenantId" = NEW."tenantId" AND g."moveId" = NEW."moveId" AND g."id" <> NEW."id") THEN
    RAISE EXCEPTION 'production: move % is the second-quality move of another downgrade; downgrade % names its own', NEW."moveId", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "GarmentDowngrade_move_check" AFTER INSERT OR UPDATE OF "moveId" ON "GarmentDowngrade"
  FOR EACH ROW WHEN (NEW."moveId" IS NOT NULL)
  EXECUTE FUNCTION "factory_garment_downgrade_move_check"();
