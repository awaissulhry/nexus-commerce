-- Written by hand (Prisma does not model triggers or partial indexes), after the generated …_planning_depth_w2b_schema and
-- before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.
--
-- Planning in depth, W2b-5 schema wave 41/44 (B-W2b-286; read by B-W2b-293, -301, -306, -312, -317, -318, -319, -321, -329).
-- apps/factory-api checks all of this first and answers in words; these rules are the last word, for every login, the owner
-- included.
--
--   PlannedWorkOrder   a MAKE or SUBCONTRACT proposal: kind, style, colourway and creation fixed; the size run (1 to 200
--                      sizes, each once, whole garments) adds up to its quantity; start ≤ due; the demand a list; a workshop
--                      (SUBCONTRACTOR, ACTIVE), its routing steps and kit date exactly for SUBCONTRACT (the kit leaves by the
--                      due date), a line only for MAKE; firm with when; the protected fields from the known list, each once,
--                      with who and when; a later run (never an older one) moves it on; CONVERTED exactly with its work order
--                      (of the site and style) and when, a SUBCONTRACT also with its subcontract order (of that work order and
--                      workshop), then frozen. Removed only while PLANNED, not firm and with nothing protected.
--   MrpActionMessage   about a PurchaseOrderLine, WorkOrder, SubcontractOrder, PlannedWorkOrder or MaterialRequirement of the
--                      run's site; each action with its from and to (a date, or a quantity with its unit) in the right
--                      direction; words 1-2000; facts an object; inserted OPEN, decided once (DONE or IGNORED, with when)
--                      while its run is DONE, then frozen. Never deleted.
--   PromiseRecord      append-only. Of an order that is not SHIPPED, CLOSED or CANCELLED, not before its date; a size of the
--                      line's grid or every size; one FIRST per line and size (a partial unique index); a RE_PROMISE after a
--                      FIRST of that size or of every size, with why (a code and/or words); promised and told not in the
--                      future; the plan version with its site, both or neither.
--   ScheduleChange     append-only. A change of its site's WORKING plan; each side (from, to) all or nothing: one lane and a
--                      start before the end; PLACE has a to side, REMOVE a from side, MOVE both and they differ, PIN and
--                      UNPIN neither, PUBLISH names a PUBLISHED version of the site and no slot, UNDO the change it undoes
--                      (of the same plan and slot, not a PUBLISH or an UNDO; once: a partial unique index); changed by a
--                      person, not in the future.
--   WhatIfScenario     inserted DRAFT; owner, base, site and creation fixed; moves (a list of at most 500 objects) and name
--                      change only while DRAFT; DRAFT → APPLIED | DISCARDED once, each with when. Never deleted.
--   SubcontractorCapacity  a workshop (SUBCONTRACTOR) fixed once made; 1 to 1 000 000 a week; until not before from.
--   ItemPlanning       FIXED lot sizing exactly with its quantity, PERIOD exactly with its days; scrap 0 to under 100 %, yield
--                      above 0 to 100 %, delay 0-366 days; plan level and strategy only for a FINISHED or COMPONENT item, phantom
--                      only for a COMPONENT. Checked when these columns change (W2a's routes write the others: never refused
--                      here); the lot sizing is read with the ORDERS method only.
--   PlanningSettings   the size-run rule's groups: none for ONE_GRID; 2 to 20 groups of 1 to 50 size codes, a code in one
--                      group only, for SIZE_GROUPS.
--   PlanningRun        the inputs snapshot is an object (W1's guard freezes it once the run is no longer RUNNING).
--   MaterialRequirement  REDEFINED `factory_material_requirement_guard` (…_followups_quality_money_w2b_guards, whole): the hard
--                      peg is one of the columns a planner sets after the run, only while the requirement is OPEN. Its own
--                      check: orderSpecific exactly with the order line and its party, a line of its sources.
--   SalesOrder         the backlog rank 1 to 1 000 000, or none.
--   ScheduleSlot       REDEFINED `factory_schedule_slot_guard` (…_production_w2a_guards, whole): the pin is one of the
--                      columns a move changes. Its own check: pinned exactly with when (not in the future); a slot pinned
--                      before and after a write keeps its lane and times.
--   SubcontractOrder   the kit date, when it is written, not before the order date and not after the day the goods are due
--                      back (W2a's guard keeps it with the terms: changed while DRAFT; W2a's routes that move the dates are never
--                      refused here).
--   WorkOrderOperation REDEFINED `factory_work_order_operation_guard` (…_followups_floor_w2b_guards, whole): outsourced and its
--                      subcontract order change while the work order is DRAFT, RELEASED, IN_PROGRESS or ON_HOLD. Its own
--                      check: a subcontract order only on an outsourced operation, not CANCELLED or CLOSED when named.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words, a write to kept data a
-- restrict_violation; the new checks are AFTER triggers (the policies speak first), the refused deletes and the append-only
-- refusals BEFORE; the redefined functions keep their BEFORE triggers. An UPDATE that changes nothing passes. A rule that
-- reads another row skips a row this session cannot see, unless the row it names must exist. No data copy: every new column
-- is null, false, empty or its default on the rows made before it, and they keep every rule.
--
-- USED FROM EARLIER WAVES, as they are: "factory_styles_text_ok", "factory_styles_distinct" (…_styles_libraries_w2b_guards),
-- "factory_bom_options_words_ok" (…_bom_options_w2b_guards), "factory_recall_not_future" (…_recall_claims_w2b_guards).
-- No function of the parallel waves 35-40 is touched.

-- =====================================================================================================================
-- Shared: TRUNCATE refused, the append-only refusal, the refused delete.
CREATE FUNCTION "factory_planning_depth_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'planning: TRUNCATE on "%" is refused; its rows are kept', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE FUNCTION "factory_planning_depth_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'planning: % % is written once and never changed or removed (append-only); a new row corrects it', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE FUNCTION "factory_planning_depth_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'planning: % % is kept, never deleted', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'restrict_violation';
END
$$;

-- A list of size codes: 1 to 20 characters each, on one line.
CREATE FUNCTION "factory_planning_size_code_ok"(code jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(code) = 'string' AND "factory_styles_text_ok"(code #>> '{}', 20) AND (code #>> '{}') !~ '[[:space:]]'
$$;

-- =====================================================================================================================
-- PlannedWorkOrder (B-W2b-293, -306; PLN-067, PLN-068, PLN-069, PLN-076, PLN-089, PLN-164).
CREATE FUNCTION "factory_planned_work_order_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed CONSTANT text[] := ARRAY['sizes', 'startDate', 'dueDate', 'lineId', 'partyId', 'operationSeqs', 'kitDueAt', 'styleRevisionId'];
  entry jsonb;
  total bigint := 0;
  codes text[] := ARRAY[]::text[];
  old_start timestamptz;
  new_start timestamptz;
  workshop record;
  made record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."siteId", NEW."kind", NEW."styleId", NEW."colourwayId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."siteId", OLD."kind", OLD."styleId", OLD."colourwayId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'planning: the site, kind, style, colourway and creation of planned work order % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'CONVERTED'
       AND (to_jsonb(NEW) - ARRAY['note', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['note', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'planning: planned work order % was made real (work order %); it never changes', OLD."id", OLD."workOrderId"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."runId" <> OLD."runId" THEN
      SELECT r."startedAt" INTO old_start FROM "PlanningRun" r WHERE r."tenantId" = OLD."tenantId" AND r."id" = OLD."runId";
      SELECT r."startedAt" INTO new_start FROM "PlanningRun" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."runId";
      IF new_start < old_start THEN
        RAISE EXCEPTION 'planning: planned work order % is moved on by a later run of its site, never back to an older one', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."status" <> 'PLANNED' THEN
    RAISE EXCEPTION 'planning: planned work order % starts PLANNED (it is made real later)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The size run.
  IF NEW."sizes" IS NULL OR jsonb_typeof(NEW."sizes") <> 'array' OR jsonb_array_length(NEW."sizes") NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'planning: planned work order % has a size run of 1 to 200 sizes', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW."sizes") LOOP
    IF jsonb_typeof(entry) <> 'object' OR NOT "factory_planning_size_code_ok"(entry -> 'size')
       OR jsonb_typeof(entry -> 'quantity') <> 'number' OR (entry ->> 'quantity') !~ '^[1-9][0-9]{0,6}$'
       OR (SELECT count(*) FROM jsonb_object_keys(entry)) <> 2 THEN
      RAISE EXCEPTION 'planning: planned work order % names each size of its run as { "size": "52", "quantity": 4 } (whole garments from 1)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (entry ->> 'size') = ANY (codes) THEN
      RAISE EXCEPTION 'planning: planned work order % names size % twice', NEW."id", entry ->> 'size'
        USING ERRCODE = 'check_violation';
    END IF;
    codes := codes || (entry ->> 'size');
    total := total + (entry ->> 'quantity')::bigint;
  END LOOP;
  IF NEW."quantity" <> total THEN
    RAISE EXCEPTION 'planning: planned work order % makes % garments, the sum of its size run (not %)', NEW."id", total, NEW."quantity"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."sizeGroup", 100) OR NEW."startDate" > NEW."dueDate"
     OR NEW."demand" IS NULL OR jsonb_typeof(NEW."demand") <> 'array' OR jsonb_array_length(NEW."demand") > 1000
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."demand") AS d(value) WHERE jsonb_typeof(d.value) <> 'object')
     OR NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'planning: planned work order % starts on or before its due date, pegs a list of at most 1000 demands, and keeps its size group (1-100) and note (1-2000 characters) on their lines', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- MAKE on a line, SUBCONTRACT to a workshop with its steps and kit date.
  IF (NEW."kind" = 'SUBCONTRACT') <> (NEW."partyId" IS NOT NULL)
     OR (NEW."kind" = 'MAKE' AND (NEW."kitDueAt" IS NOT NULL OR cardinality(NEW."operationSeqs") > 0))
     OR (NEW."kind" = 'SUBCONTRACT' AND NEW."lineId" IS NOT NULL)
     OR NEW."operationSeqs" IS NULL OR cardinality(NEW."operationSeqs") > 200 OR NOT "factory_styles_distinct"(NEW."operationSeqs")
     OR EXISTS (SELECT 1 FROM unnest(NEW."operationSeqs") AS s(seq) WHERE s.seq < 1)
     OR NEW."kitDueAt"::date > NEW."dueDate" THEN
    RAISE EXCEPTION 'planning: planned work order % is a MAKE (on a line of its site, or none) or a SUBCONTRACT (to a workshop, with the routing steps it does, each once from 1, and the kit leaving by its due date)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."partyId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."partyId" IS DISTINCT FROM OLD."partyId") THEN
    SELECT p."status"::text AS status, 'SUBCONTRACTOR' = ANY (p."roles") AS workshop INTO workshop
      FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND (workshop.status <> 'ACTIVE' OR NOT workshop.workshop) THEN
      RAISE EXCEPTION 'planning: planned work order % goes to an ACTIVE workshop (a party with the SUBCONTRACTOR role)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Firm, protected.
  IF (NEW."firm") <> (NEW."firmedAt" IS NOT NULL) OR (NEW."firmedById" IS NOT NULL AND NEW."firmedAt" IS NULL) THEN
    RAISE EXCEPTION 'planning: planned work order % is firm exactly with when it was made firm', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."protectedFields" IS NULL OR NOT "factory_styles_distinct"(NEW."protectedFields") OR NOT NEW."protectedFields" <@ allowed
     OR (cardinality(NEW."protectedFields") > 0) <> (NEW."protectedAt" IS NOT NULL)
     OR (NEW."protectedById" IS NOT NULL AND NEW."protectedAt" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."protectedAt") OR NOT "factory_recall_not_future"(NEW."firmedAt") THEN
    RAISE EXCEPTION 'planning: planned work order % protects only its sizes, startDate, dueDate, lineId, partyId, operationSeqs, kitDueAt and styleRevisionId, each once, with who and when (not in the future); Reset to plan protects none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Made real.
  IF (NEW."status" = 'CONVERTED') <> (NEW."workOrderId" IS NOT NULL) OR (NEW."status" = 'CONVERTED') <> (NEW."convertedAt" IS NOT NULL)
     OR (NEW."convertedById" IS NOT NULL AND NEW."convertedAt" IS NULL)
     OR (NEW."subcontractOrderId" IS NOT NULL AND NEW."kind" <> 'SUBCONTRACT')
     OR (NEW."status" = 'CONVERTED' AND NEW."kind" = 'SUBCONTRACT' AND NEW."subcontractOrderId" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."convertedAt") THEN
    RAISE EXCEPTION 'planning: planned work order % is CONVERTED exactly with the work order made from it and when (a SUBCONTRACT also with its subcontract order)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'CONVERTED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'CONVERTED') THEN
    SELECT w."styleId" INTO made FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF FOUND AND made."styleId" <> NEW."styleId" THEN
      RAISE EXCEPTION 'planning: planned work order % is made real as a work order of its own style', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."subcontractOrderId" IS NOT NULL THEN
      SELECT o."partyId" INTO made FROM "SubcontractOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."subcontractOrderId";
      IF FOUND AND made."partyId" <> NEW."partyId" THEN
        RAISE EXCEPTION 'planning: planned work order % is made real with a subcontract order to its own workshop', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_planned_work_order_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PLANNED' OR OLD."firm" OR cardinality(OLD."protectedFields") > 0 THEN
    RAISE EXCEPTION 'planning: planned work order % is removed only while PLANNED, not firm and with nothing protected (reset it to plan first)', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "PlannedWorkOrder_check" AFTER INSERT OR UPDATE ON "PlannedWorkOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_planned_work_order_check"();
CREATE TRIGGER "PlannedWorkOrder_delete" BEFORE DELETE ON "PlannedWorkOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_planned_work_order_delete"();
CREATE TRIGGER "PlannedWorkOrder_no_truncate" BEFORE TRUNCATE ON "PlannedWorkOrder"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_planning_depth_refuse_truncate"();

-- =====================================================================================================================
-- MrpActionMessage (B-W2b-306; PLN-073).
CREATE FUNCTION "factory_mrp_action_message_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  decided CONSTANT text[] := ARRAY['status', 'decidedAt', 'decidedById', 'decisionNote', 'version', 'updatedAt'];
  run_state text;
  found_it boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (to_jsonb(NEW) - decided) IS DISTINCT FROM (to_jsonb(OLD) - decided) THEN
      RAISE EXCEPTION 'planning: action message % is its run''s; only its decision is written', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'planning: action message % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT r."status"::text INTO run_state FROM "PlanningRun" r WHERE r."tenantId" = OLD."tenantId" AND r."id" = OLD."runId";
    IF run_state IS NOT NULL AND run_state <> 'DONE' THEN
      RAISE EXCEPTION 'planning: action message % is decided only while its run is DONE (it is %)', OLD."id", run_state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'planning: action message % is written OPEN', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    found_it := CASE NEW."recordType"
      WHEN 'PurchaseOrderLine' THEN EXISTS (SELECT 1 FROM "PurchaseOrderLine" x WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId" AND x."id" = NEW."recordId")
      WHEN 'WorkOrder' THEN EXISTS (SELECT 1 FROM "WorkOrder" x WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId" AND x."id" = NEW."recordId")
      WHEN 'SubcontractOrder' THEN EXISTS (SELECT 1 FROM "SubcontractOrder" x WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId" AND x."id" = NEW."recordId")
      WHEN 'PlannedWorkOrder' THEN EXISTS (SELECT 1 FROM "PlannedWorkOrder" x WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId" AND x."id" = NEW."recordId")
      WHEN 'MaterialRequirement' THEN EXISTS (SELECT 1 FROM "MaterialRequirement" x WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId" AND x."id" = NEW."recordId")
      ELSE NULL
    END;
    IF found_it IS NULL THEN
      RAISE EXCEPTION 'planning: action message % is about a PurchaseOrderLine, WorkOrder, SubcontractOrder, PlannedWorkOrder or MaterialRequirement, not a %', NEW."id", NEW."recordType"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT found_it THEN
      RAISE EXCEPTION 'planning: action message % is about % %, which is not one of its run''s site', NEW."id", NEW."recordType", NEW."recordId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."seq" < 1 OR NEW."message" IS NULL OR NOT "factory_bom_options_words_ok"(NEW."message", 2000)
     OR NEW."facts" IS NULL OR jsonb_typeof(NEW."facts") <> 'object' OR NOT "factory_bom_options_words_ok"(NEW."decisionNote", 2000) THEN
    RAISE EXCEPTION 'planning: action message % has its place from 1, says what to do in 1 to 2000 characters, keeps its facts as an object and a note of at most 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."fromQuantity" IS NOT NULL OR NEW."toQuantity" IS NOT NULL) <> (NEW."uom" IS NOT NULL)
     OR NEW."fromQuantity" < 0 OR NEW."toQuantity" < 0
     OR (NEW."action" IN ('EXPEDITE', 'DEFER')
         AND (NEW."fromDate" IS NULL OR NEW."toDate" IS NULL OR NEW."fromQuantity" IS NOT NULL OR NEW."toQuantity" IS NOT NULL
              OR (NEW."action" = 'EXPEDITE' AND NEW."toDate" >= NEW."fromDate") OR (NEW."action" = 'DEFER' AND NEW."toDate" <= NEW."fromDate")))
     OR (NEW."action" IN ('INCREASE', 'DECREASE')
         AND (NEW."fromQuantity" IS NULL OR NEW."toQuantity" IS NULL OR NEW."fromDate" IS NOT NULL OR NEW."toDate" IS NOT NULL
              OR (NEW."action" = 'INCREASE' AND NEW."toQuantity" <= NEW."fromQuantity")
              OR (NEW."action" = 'DECREASE' AND (NEW."toQuantity" >= NEW."fromQuantity" OR NEW."toQuantity" <= 0))))
     OR (NEW."action" = 'CANCEL' AND (NEW."toDate" IS NOT NULL OR NEW."toQuantity" IS NOT NULL))
     OR (NEW."action" = 'NEW' AND (NEW."toDate" IS NULL OR NEW."toQuantity" IS NULL OR NEW."toQuantity" <= 0 OR NEW."fromDate" IS NOT NULL OR NEW."fromQuantity" IS NOT NULL)) THEN
    RAISE EXCEPTION 'planning: action message % (%) has the wrong from and to: EXPEDITE and DEFER move a date earlier or later, INCREASE and DECREASE a quantity up or down (above 0, with its unit), NEW says how much by when, CANCEL may name what it cancels', NEW."id", NEW."action"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'OPEN') <> (NEW."decidedAt" IS NULL) OR (NEW."decidedById" IS NOT NULL AND NEW."decidedAt" IS NULL)
     OR (NEW."decisionNote" IS NOT NULL AND NEW."decidedAt" IS NULL) OR NOT "factory_recall_not_future"(NEW."decidedAt") THEN
    RAISE EXCEPTION 'planning: action message % is DONE or IGNORED exactly with when (not in the future) and by whom', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MrpActionMessage_check" AFTER INSERT OR UPDATE ON "MrpActionMessage"
  FOR EACH ROW EXECUTE FUNCTION "factory_mrp_action_message_check"();
CREATE TRIGGER "MrpActionMessage_kept" BEFORE DELETE ON "MrpActionMessage"
  FOR EACH ROW EXECUTE FUNCTION "factory_planning_depth_kept"();
CREATE TRIGGER "MrpActionMessage_no_truncate" BEFORE TRUNCATE ON "MrpActionMessage"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_planning_depth_refuse_truncate"();

-- =====================================================================================================================
-- PromiseRecord (B-W2b-301, -317; PLN-171, PLN-173, PLN-175): append-only.
CREATE FUNCTION "factory_promise_record_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line record;
BEGIN
  SELECT l."kind"::text AS kind, o."status"::text AS status, o."orderDate" AS "orderDate" INTO line
    FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."orderId"
    WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
  IF FOUND THEN
    IF line.status IN ('SHIPPED', 'CLOSED', 'CANCELLED') THEN
      RAISE EXCEPTION 'planning: the order of line % is %; nothing more is promised on it', NEW."salesOrderLineId", line.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."promisedDate" < line."orderDate" THEN
      RAISE EXCEPTION 'planning: promise % is for a day before its order''s date', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."size" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SalesOrderLineSize" s WHERE s."tenantId" = NEW."tenantId" AND s."lineId" = NEW."salesOrderLineId" AND s."size" = NEW."size") THEN
      RAISE EXCEPTION 'planning: promise % is for size %, which is not in the size grid of its line (none: every size)', NEW."id", NEW."size"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."kind" = 'RE_PROMISE' THEN
    IF NEW."reasonCode" IS NULL AND NEW."reason" IS NULL THEN
      RAISE EXCEPTION 'planning: re-promise % says why (a reason code or words)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "PromiseRecord" p WHERE p."tenantId" = NEW."tenantId" AND p."salesOrderLineId" = NEW."salesOrderLineId" AND p."kind" = 'FIRST'
                     AND (NEW."size" IS NULL OR p."size" IS NULL OR p."size" = NEW."size")) THEN
      RAISE EXCEPTION 'planning: re-promise % follows the first promise of its line and size (record the FIRST one first)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."reasonCode" IS NOT NULL AND NEW."reasonCode" !~ '^[A-Z][A-Z0-9_]{0,59}$') OR NOT "factory_bom_options_words_ok"(NEW."reason", 2000)
     OR NOT "factory_styles_text_ok"(NEW."size", 20)
     OR (NEW."siteId" IS NULL) <> (NEW."planVersionId" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."promisedAt") OR NOT "factory_recall_not_future"(NEW."customerToldAt") THEN
    RAISE EXCEPTION 'planning: promise % keeps its reason code (A-Z, 0-9, _) and words (at most 2000), its size, its plan version with its site (both or neither), and was promised and told not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PromiseRecord_check" AFTER INSERT ON "PromiseRecord"
  FOR EACH ROW EXECUTE FUNCTION "factory_promise_record_check"();
CREATE TRIGGER "PromiseRecord_append_only" BEFORE UPDATE OR DELETE ON "PromiseRecord"
  FOR EACH ROW EXECUTE FUNCTION "factory_planning_depth_append_only"();
CREATE TRIGGER "PromiseRecord_no_truncate" BEFORE TRUNCATE ON "PromiseRecord"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_planning_depth_refuse_truncate"();

-- The first promise of a line and size is kept forever: one per line and size ('' for every size).
CREATE UNIQUE INDEX "PromiseRecord_one_first" ON "PromiseRecord" ("tenantId", "salesOrderLineId", coalesce("size", '')) WHERE "kind" = 'FIRST';

-- =====================================================================================================================
-- ScheduleChange (B-W2b-312, -329; PLN-139, PLN-149): append-only.
CREATE FUNCTION "factory_schedule_change_side_ok"(line uuid, centre uuid, party uuid, starts timestamptz, ends timestamptz) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT (starts IS NULL AND ends IS NULL AND num_nonnulls(line, centre, party) = 0)
      OR (starts IS NOT NULL AND ends IS NOT NULL AND ends > starts AND num_nonnulls(line, centre, party) = 1)
$$;

CREATE FUNCTION "factory_schedule_change_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  has_from boolean := NEW."fromStartAt" IS NOT NULL;
  has_to boolean := NEW."toStartAt" IS NOT NULL;
  plan_kind text;
  undone record;
BEGIN
  SELECT v."kind"::text INTO plan_kind FROM "PlanVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."siteId" = NEW."siteId" AND v."id" = NEW."planVersionId";
  IF FOUND AND plan_kind <> 'WORKING' THEN
    RAISE EXCEPTION 'planning: change % is of its site''s WORKING plan (a published version never changes)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_schedule_change_side_ok"(NEW."fromLineId", NEW."fromWorkCentreId", NEW."fromPartyId", NEW."fromStartAt", NEW."fromEndAt")
     OR NOT "factory_schedule_change_side_ok"(NEW."toLineId", NEW."toWorkCentreId", NEW."toPartyId", NEW."toStartAt", NEW."toEndAt") THEN
    RAISE EXCEPTION 'planning: change % names each side (from, to) whole or not at all: one lane (a line, a work centre or a workshop) and a start before its end', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'PUBLISH') = (NEW."slotId" IS NOT NULL) OR (NEW."kind" = 'PUBLISH') = (NEW."workOrderId" IS NOT NULL)
     OR (NEW."kind" = 'PUBLISH') <> (NEW."publishedVersionId" IS NOT NULL) OR (NEW."kind" = 'UNDO') <> (NEW."undoesChangeId" IS NOT NULL)
     OR (NEW."kind" = 'PLACE' AND (has_from OR NOT has_to))
     OR (NEW."kind" = 'MOVE' AND (NOT has_from OR NOT has_to
         OR (NEW."fromLineId", NEW."fromWorkCentreId", NEW."fromPartyId", NEW."fromStartAt", NEW."fromEndAt")
            IS NOT DISTINCT FROM (NEW."toLineId", NEW."toWorkCentreId", NEW."toPartyId", NEW."toStartAt", NEW."toEndAt")))
     OR (NEW."kind" = 'REMOVE' AND (NOT has_from OR has_to))
     OR (NEW."kind" IN ('PIN', 'UNPIN', 'PUBLISH') AND (has_from OR has_to)) THEN
    RAISE EXCEPTION 'planning: change % (%) has the wrong parts: PLACE goes to a lane, REMOVE leaves one, MOVE goes from one place to another, PIN and UNPIN name the slot only, PUBLISH names the published version and no slot, UNDO names the change it undoes and what it puts back (if anything)', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'PUBLISH' THEN
    SELECT v."kind"::text INTO plan_kind FROM "PlanVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."siteId" = NEW."siteId" AND v."id" = NEW."publishedVersionId";
    IF FOUND AND plan_kind <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'planning: change % publishes a PUBLISHED version of its site', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."kind" = 'UNDO' THEN
    SELECT c."planVersionId", c."kind"::text AS kind, c."slotId" INTO undone
      FROM "ScheduleChange" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."undoesChangeId";
    IF FOUND AND (undone."planVersionId" <> NEW."planVersionId" OR undone.kind IN ('PUBLISH', 'UNDO') OR undone."slotId" IS DISTINCT FROM NEW."slotId") THEN
      RAISE EXCEPTION 'planning: change % undoes a change of the same plan and slot (a place, move, removal, pin or unpin; never a publish or an undo)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."reason", 2000) OR NOT "factory_recall_not_future"(NEW."changedAt") THEN
    RAISE EXCEPTION 'planning: change % keeps its reason in at most 2000 characters and was made not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ScheduleChange_check" AFTER INSERT ON "ScheduleChange"
  FOR EACH ROW EXECUTE FUNCTION "factory_schedule_change_check"();
CREATE TRIGGER "ScheduleChange_append_only" BEFORE UPDATE OR DELETE ON "ScheduleChange"
  FOR EACH ROW EXECUTE FUNCTION "factory_planning_depth_append_only"();
CREATE TRIGGER "ScheduleChange_no_truncate" BEFORE TRUNCATE ON "ScheduleChange"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_planning_depth_refuse_truncate"();

-- A change is undone once.
CREATE UNIQUE INDEX "ScheduleChange_one_undo" ON "ScheduleChange" ("tenantId", "undoesChangeId") WHERE "undoesChangeId" IS NOT NULL;

-- =====================================================================================================================
-- WhatIfScenario (B-W2b-312; design planning.board "What-if").
CREATE FUNCTION "factory_what_if_scenario_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."siteId", NEW."ownerId", NEW."basePlanVersionId", NEW."basedAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."siteId", OLD."ownerId", OLD."basePlanVersionId", OLD."basedAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'planning: the site, owner, base and creation of what-if % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'planning: what-if % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'planning: what-if % starts as a DRAFT', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."name", 200)
     OR NEW."moves" IS NULL OR jsonb_typeof(NEW."moves") <> 'array' OR jsonb_array_length(NEW."moves") > 500
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."moves") AS m(value) WHERE jsonb_typeof(m.value) <> 'object')
     OR NOT "factory_recall_not_future"(NEW."basedAt") THEN
    RAISE EXCEPTION 'planning: what-if % keeps a name of at most 200 characters, a list of at most 500 moves, and was based on its plan not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'APPLIED') <> (NEW."appliedAt" IS NOT NULL) OR (NEW."appliedById" IS NOT NULL AND NEW."appliedAt" IS NULL)
     OR (NEW."status" = 'DISCARDED') <> (NEW."discardedAt" IS NOT NULL) OR (NEW."discardedById" IS NOT NULL AND NEW."discardedAt" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."appliedAt") OR NOT "factory_recall_not_future"(NEW."discardedAt") THEN
    RAISE EXCEPTION 'planning: what-if % is APPLIED or DISCARDED exactly with when (not in the future) and by whom', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WhatIfScenario_check" AFTER INSERT OR UPDATE ON "WhatIfScenario"
  FOR EACH ROW EXECUTE FUNCTION "factory_what_if_scenario_check"();
CREATE TRIGGER "WhatIfScenario_kept" BEFORE DELETE ON "WhatIfScenario"
  FOR EACH ROW EXECUTE FUNCTION "factory_planning_depth_kept"();
CREATE TRIGGER "WhatIfScenario_no_truncate" BEFORE TRUNCATE ON "WhatIfScenario"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_planning_depth_refuse_truncate"();

-- =====================================================================================================================
-- SubcontractorCapacity (B-W2b-321; PLN-124).
CREATE FUNCTION "factory_subcontractor_capacity_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  workshop boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."partyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'planning: the workshop and creation of capacity % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    SELECT 'SUBCONTRACTOR' = ANY (p."roles") INTO workshop FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF workshop IS FALSE THEN
      RAISE EXCEPTION 'planning: capacity % is of a workshop (a party with the SUBCONTRACTOR role)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."perWeek" NOT BETWEEN 1 AND 1000000 OR NEW."validTo" < NEW."validFrom" OR NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'planning: capacity % takes 1 to 1 000 000 a week, until a day not before its first, with a note of at most 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SubcontractorCapacity_check" AFTER INSERT OR UPDATE ON "SubcontractorCapacity"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontractor_capacity_check"();
CREATE TRIGGER "SubcontractorCapacity_no_truncate" BEFORE TRUNCATE ON "SubcontractorCapacity"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_planning_depth_refuse_truncate"();

-- =====================================================================================================================
-- ItemPlanning (B-W2b-318, -319, -293; PLN-006, PLN-008, PLN-061, PLN-079, PLN-081, PLN-082): W2a's guard untouched.
CREATE FUNCTION "factory_item_planning_depth_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF (NEW."lotSizing" = 'FIXED') <> (NEW."fixedLotQty" IS NOT NULL) OR NEW."fixedLotQty" <= 0
     OR (NEW."lotSizing" = 'PERIOD') <> (NEW."lotPeriodDays" IS NOT NULL) OR NEW."lotPeriodDays" NOT BETWEEN 1 AND 366 THEN
    RAISE EXCEPTION 'planning: item parameters % size orders FIXED exactly with the lot quantity (above 0) and by PERIOD exactly with its days (1 to 366) (PLN-006)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."scrapPct" < 0 OR NEW."scrapPct" >= 100 OR NEW."yieldPct" <= 0 OR NEW."yieldPct" > 100 OR NEW."delayDays" NOT BETWEEN 0 AND 366 THEN
    RAISE EXCEPTION 'planning: item parameters % add scrap of 0 to under 100 %%, a yield above 0 to 100 %% and a delay of 0 to 366 days', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."planLevel" IS NOT NULL OR NEW."strategy" IS NOT NULL OR NEW."phantom" THEN
    SELECT i."kind"::text INTO item_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND ((NEW."planLevel" IS NOT NULL OR NEW."strategy" IS NOT NULL) AND item_kind NOT IN ('FINISHED', 'COMPONENT')) THEN
      RAISE EXCEPTION 'planning: item parameters % give a plan level or a production strategy only to a made item (FINISHED or COMPONENT), not a %', NEW."id", item_kind
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND NEW."phantom" AND item_kind <> 'COMPONENT' THEN
      RAISE EXCEPTION 'planning: item parameters % make only a COMPONENT a phantom (its parts pass through), not a %', NEW."id", item_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ItemPlanning_w2b5_depth" AFTER INSERT OR UPDATE OF "lotSizing", "fixedLotQty", "lotPeriodDays", "planLevel", "strategy", "scrapPct", "yieldPct", "phantom", "delayDays" ON "ItemPlanning"
  FOR EACH ROW EXECUTE FUNCTION "factory_item_planning_depth_check"();

-- =====================================================================================================================
-- PlanningSettings (B-W2b-293; PLN-068): the size-run rule. W2a's guard untouched.
CREATE FUNCTION "factory_planning_settings_size_run_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  grp jsonb;
  code jsonb;
  seen text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."sizeRunRule", NEW."sizeGroups") IS NOT DISTINCT FROM (OLD."sizeRunRule", OLD."sizeGroups") THEN
    RETURN NULL;
  END IF;
  IF NEW."sizeGroups" IS NULL OR jsonb_typeof(NEW."sizeGroups") <> 'array'
     OR (NEW."sizeRunRule" = 'ONE_GRID' AND jsonb_array_length(NEW."sizeGroups") <> 0)
     OR (NEW."sizeRunRule" = 'SIZE_GROUPS' AND jsonb_array_length(NEW."sizeGroups") NOT BETWEEN 2 AND 20) THEN
    RAISE EXCEPTION 'planning: the settings of site % keep no size groups for ONE_GRID and 2 to 20 for SIZE_GROUPS (PLN-068)', NEW."siteId"
      USING ERRCODE = 'check_violation';
  END IF;
  FOR grp IN SELECT value FROM jsonb_array_elements(NEW."sizeGroups") LOOP
    IF jsonb_typeof(grp) <> 'array' OR jsonb_array_length(grp) NOT BETWEEN 1 AND 50 THEN
      RAISE EXCEPTION 'planning: each size group of site % lists 1 to 50 size codes', NEW."siteId"
        USING ERRCODE = 'check_violation';
    END IF;
    FOR code IN SELECT value FROM jsonb_array_elements(grp) LOOP
      IF NOT "factory_planning_size_code_ok"(code) OR (code #>> '{}') = ANY (seen) THEN
        RAISE EXCEPTION 'planning: the size groups of site % name each size code (1 to 20 characters, no spaces) in one group only', NEW."siteId"
          USING ERRCODE = 'check_violation';
      END IF;
      seen := seen || (code #>> '{}');
    END LOOP;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PlanningSettings_w2b5_size_run" AFTER INSERT OR UPDATE OF "sizeRunRule", "sizeGroups" ON "PlanningSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_planning_settings_size_run_check"();

-- =====================================================================================================================
-- PlanningRun (B-W2b-306; PLN-095): the inputs snapshot. W1's guard untouched (it freezes the row once not RUNNING).
CREATE FUNCTION "factory_planning_run_inputs_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."inputs" IS NOT DISTINCT FROM OLD."inputs" THEN
    RETURN NULL;
  END IF;
  IF NEW."inputs" IS NULL OR jsonb_typeof(NEW."inputs") <> 'object' THEN
    RAISE EXCEPTION 'planning: run % keeps what it read as an object ({} when not recorded)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PlanningRun_w2b5_inputs" AFTER INSERT OR UPDATE OF "inputs" ON "PlanningRun"
  FOR EACH ROW EXECUTE FUNCTION "factory_planning_run_inputs_check"();

-- =====================================================================================================================
-- MaterialRequirement (B-W2b-306; PLN-072): the hard peg. REDEFINED from …_followups_quality_money_w2b_guards (whole; the
-- W2b-5 lines are marked): the peg is one of the columns a planner writes after the run, only while the requirement is OPEN.
CREATE OR REPLACE FUNCTION "factory_material_requirement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  decided CONSTANT text[] := ARRAY['decision', 'decisionNote', 'purchaseOrderLineId', 'decidedAt', 'decidedById',
    'firmQuantity', 'firmBaseQuantity', 'firmDate', 'firmSupplierId', 'firmedAt', 'firmedById', 'version', 'updatedAt',
    -- W2b-5 (wave 41/44): the hard peg to one order line (PLN-072).
    'orderSpecific', 'reservedForLineId', 'reservedForPartyId'];
  run_state text;
  line_item uuid;
  line_colour uuid;
  carried record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supply: material requirement % is kept with its run, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || decided)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || decided)) THEN
      RAISE EXCEPTION 'supply: the numbers of material requirement % are its run''s snapshot; they never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT r."status"::text INTO run_state FROM "PlanningRun" r WHERE r."tenantId" = OLD."tenantId" AND r."id" = OLD."runId";
    IF run_state IS NOT NULL AND run_state <> 'DONE' THEN
      RAISE EXCEPTION 'supply: material requirement % is decided only while its run is DONE (it is %)', OLD."id", run_state
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."decision" = 'ORDERED' AND NEW."decision" = 'ORDERED'
       AND (NEW."firmQuantity", NEW."firmBaseQuantity", NEW."firmDate", NEW."firmSupplierId", NEW."firmedAt", NEW."firmedById")
           IS DISTINCT FROM (OLD."firmQuantity", OLD."firmBaseQuantity", OLD."firmDate", OLD."firmSupplierId", OLD."firmedAt", OLD."firmedById") THEN
      RAISE EXCEPTION 'supply: the firm planned order of material requirement % is fixed while it is ORDERED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b-5 (wave 41/44): a planner hard-pegs it (or lets it go) while it is OPEN; ORDERED or IGNORED, the peg is fixed.
    IF (NEW."orderSpecific", NEW."reservedForLineId", NEW."reservedForPartyId") IS DISTINCT FROM (OLD."orderSpecific", OLD."reservedForLineId", OLD."reservedForPartyId")
       AND OLD."decision" <> 'OPEN' THEN
      RAISE EXCEPTION 'supply: material requirement % is %; its hard peg to an order line is fixed (it is set while the requirement is OPEN)', OLD."id", OLD."decision"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."grossQuantity" < 0 OR NEW."usableStock" < 0 OR NEW."heldStock" < 0 OR NEW."onOrder" < 0 OR NEW."suggestedQuantity" < 0
     OR NEW."netQuantity" <> greatest(0, NEW."grossQuantity" - NEW."usableStock" - NEW."onOrder") THEN
    RAISE EXCEPTION 'supply: material requirement % has no negative quantity and a net need of max(0, gross - usable stock - on order)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."purchaseOrderLineId" IS NOT NULL AND NEW."decision" <> 'ORDERED')
     OR (NEW."decision" = 'ORDERED' AND NEW."action" = 'BUY' AND NEW."purchaseOrderLineId" IS NULL)
     OR (NEW."decision" <> 'OPEN') <> (NEW."decidedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'supply: material requirement % is ORDERED with the purchase order line that buys it (a BUY), and decided with its time', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."purchaseOrderLineId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."purchaseOrderLineId" IS DISTINCT FROM OLD."purchaseOrderLineId") THEN
    SELECT l."itemId", l."itemColourId" INTO line_item, line_colour
      FROM "PurchaseOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."purchaseOrderLineId";
    IF FOUND AND (line_item <> NEW."itemId" OR line_colour IS DISTINCT FROM NEW."itemColourId") THEN
      RAISE EXCEPTION 'supply: purchase order line % buys another material or colour than material requirement %', NEW."purchaseOrderLineId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- W2a: the firm planned order (PLN-075).
  IF (NEW."firmedAt" IS NULL) <> (NEW."firmQuantity" IS NULL) OR (NEW."firmedAt" IS NULL) <> (NEW."firmBaseQuantity" IS NULL)
     OR (NEW."firmedAt" IS NULL) <> (NEW."firmDate" IS NULL) OR (NEW."firmedById" IS NOT NULL AND NEW."firmedAt" IS NULL)
     OR (NEW."firmSupplierId" IS NOT NULL AND (NEW."firmedAt" IS NULL OR NEW."action" <> 'BUY'))
     OR NEW."firmQuantity" <= 0 OR NEW."firmBaseQuantity" <= 0 THEN
    RAISE EXCEPTION 'supply: the firm planned order of material requirement % has its quantity in both units (above 0), its date and time, and a supplier only for a BUY', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."firmedAt" IS NOT NULL AND NEW."decision" = 'IGNORED' THEN
    RAISE EXCEPTION 'supply: material requirement % is set aside (IGNORED); it is not a firm planned order', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."firmCarriedFromId" IS NOT NULL THEN
    -- W2b: a carried line is written firm; later it may be made planned again (its firm columns cleared), and keeps
    -- firmCarriedFromId (a snapshot column, never changed) as its history.
    IF TG_OP = 'INSERT' AND NEW."firmedAt" IS NULL THEN
      RAISE EXCEPTION 'supply: material requirement % carries a firm planned order, so it is firm when it is written (it may be made planned again later)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
      SELECT m."runId", m."itemId", m."itemColourId", m."action"::text AS "kind", m."firmedAt" INTO carried
        FROM "MaterialRequirement" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."firmCarriedFromId";
      IF FOUND AND (carried."runId" = NEW."runId" OR carried."itemId" <> NEW."itemId" OR carried."itemColourId" IS DISTINCT FROM NEW."itemColourId"
                    OR carried."kind" <> NEW."action"::text OR carried."firmedAt" IS NULL) THEN
        RAISE EXCEPTION 'supply: material requirement % carries a firm line of another run, of the same material, colour and action', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_material_requirement_hard_peg_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."orderSpecific", NEW."reservedForLineId", NEW."reservedForPartyId") IS NOT DISTINCT FROM (OLD."orderSpecific", OLD."reservedForLineId", OLD."reservedForPartyId") THEN
    RETURN NULL;
  END IF;
  IF NEW."orderSpecific" <> (NEW."reservedForLineId" IS NOT NULL) OR (NEW."reservedForLineId" IS NULL) <> (NEW."reservedForPartyId" IS NULL) THEN
    RAISE EXCEPTION 'planning: material requirement % is order-specific exactly with the order line (and its party) it is for (PLN-072)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reservedForLineId" IS NOT NULL
     AND NOT (NEW."sources" @> jsonb_build_array(jsonb_build_object('orderLineId', NEW."reservedForLineId"::text))) THEN
    RAISE EXCEPTION 'planning: material requirement % is hard-pegged only to an order line it was planned for (one of its sources)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MaterialRequirement_w2b5_hard_peg" AFTER INSERT OR UPDATE OF "orderSpecific", "reservedForLineId", "reservedForPartyId" ON "MaterialRequirement"
  FOR EACH ROW EXECUTE FUNCTION "factory_material_requirement_hard_peg_check"();

-- =====================================================================================================================
-- SalesOrder (B-W2b-317, -318; PLN-177, PLN-088): the backlog rank. W1's guard untouched (it freezes a CLOSED or
-- CANCELLED order).
CREATE FUNCTION "factory_sales_order_backlog_rank_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."backlogRank" IS NOT DISTINCT FROM OLD."backlogRank" THEN
    RETURN NULL;
  END IF;
  IF NEW."backlogRank" NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION 'planning: sales order % has a place in the backlog from 1 to 1 000 000, or none', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SalesOrder_w2b5_backlog_rank" AFTER INSERT OR UPDATE OF "backlogRank" ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_order_backlog_rank_check"();

-- =====================================================================================================================
-- ScheduleSlot (B-W2b-312; PLN-139): the pin. REDEFINED from …_production_w2a_guards (whole; the W2b-5 lines are marked):
-- the pin is one of the columns a move changes.
CREATE OR REPLACE FUNCTION "factory_schedule_slot_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  moves CONSTANT text[] := ARRAY['lineId', 'workCentreId', 'partyId', 'startAt', 'endAt', 'pieces', 'minutes', 'overloadReason', 'note',
    'version', 'updatedAt', 'updatedById',
    -- W2b-5 (wave 41/44): the pin (PLN-139); ScheduleSlot_w2b5_pin keeps a pinned slot where it is.
    'pinned', 'pinnedAt', 'pinnedById'];
  plan record;
  order_state text;
  lane_ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."planKind" = 'PUBLISHED' THEN
      RAISE EXCEPTION 'production: slot % is of published version %; it is kept as the floor was given it (PLN-147)', OLD."id", OLD."planVersionId"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."planKind" = 'PUBLISHED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'production: slot % is of a published version; it never changes (PLN-147)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - (kept || moves)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || moves)) THEN
      RAISE EXCEPTION 'production: the plan, work order, operation and creation of slot % never change; a move changes its lane, times, garments and minutes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF num_nonnulls(NEW."lineId", NEW."workCentreId", NEW."partyId") <> 1 THEN
    RAISE EXCEPTION 'production: slot % books exactly one lane: a line, a work centre or a workshop', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."endAt" <= NEW."startAt" OR NEW."pieces" < 1 OR NEW."minutes" < 0 OR btrim(coalesce(NEW."overloadReason", '-')) = '' THEN
    RAISE EXCEPTION 'production: slot % ends after it starts, books garments from 1 and minutes from 0, and a reason to keep it over is not blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' AND NEW."planKind" = 'PUBLISHED' THEN
    SELECT v."number", v."publishedAt" INTO plan
      FROM "PlanVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."siteId" = NEW."siteId" AND v."id" = NEW."planVersionId";
    IF FOUND AND plan."publishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'production: plan version % (v%) is published; it takes no more slots (PLN-147)', NEW."planVersionId", plan."number"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF FOUND AND order_state IN ('CLOSED', 'CANCELLED') THEN
      RAISE EXCEPTION 'production: work order % is %; it is not placed on the board', NEW."workOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR (NEW."lineId", NEW."workCentreId", NEW."partyId") IS DISTINCT FROM (OLD."lineId", OLD."workCentreId", OLD."partyId") THEN
    IF NEW."lineId" IS NOT NULL THEN
      SELECT l."status" = 'ACTIVE' INTO lane_ok FROM "Line" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."lineId";
    ELSIF NEW."workCentreId" IS NOT NULL THEN
      SELECT c."status" = 'ACTIVE' INTO lane_ok FROM "WorkCentre" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."workCentreId";
    ELSE
      SELECT p."status" = 'ACTIVE' AND 'SUBCONTRACTOR' = ANY (p."roles") INTO lane_ok FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    END IF;
    IF lane_ok IS FALSE THEN
      RAISE EXCEPTION 'production: slot % is placed on an ACTIVE lane: a line or work centre of its site, or a workshop (a party with the SUBCONTRACTOR role)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_schedule_slot_pin_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF NEW."pinned" <> (NEW."pinnedAt" IS NOT NULL) OR (NEW."pinnedById" IS NOT NULL AND NEW."pinnedAt" IS NULL) OR NOT "factory_recall_not_future"(NEW."pinnedAt") THEN
    RAISE EXCEPTION 'production: slot % is pinned exactly with when (not in the future) and by whom', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."pinned" AND NEW."pinned"
     AND (NEW."lineId", NEW."workCentreId", NEW."partyId", NEW."startAt", NEW."endAt") IS DISTINCT FROM (OLD."lineId", OLD."workCentreId", OLD."partyId", OLD."startAt", OLD."endAt") THEN
    RAISE EXCEPTION 'production: slot % is pinned; it stays on its lane and times until it is unpinned (PLN-139)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ScheduleSlot_w2b5_pin" AFTER INSERT OR UPDATE ON "ScheduleSlot"
  FOR EACH ROW EXECUTE FUNCTION "factory_schedule_slot_pin_check"();

-- =====================================================================================================================
-- SubcontractOrder (B-W2b-321; PLN-164): the kit date. W2a's guard untouched (the kit date is one of the terms: changed
-- while DRAFT).
CREATE FUNCTION "factory_subcontract_order_kit_due_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."kitDueAt" IS NOT DISTINCT FROM OLD."kitDueAt" THEN
    RETURN NULL;
  END IF;
  IF NEW."kitDueAt"::date < NEW."orderDate" OR NEW."kitDueAt"::date > NEW."expectedBackDate" THEN
    RAISE EXCEPTION 'supply: the kit of subcontract order % leaves on or after the order''s date and by the day the goods are due back', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SubcontractOrder_w2b5_kit_due" AFTER INSERT OR UPDATE OF "kitDueAt" ON "SubcontractOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontract_order_kit_due_check"();

-- =====================================================================================================================
-- WorkOrderOperation (B-W2b-321; PLN-165): an operation outside or back in. REDEFINED from …_followups_floor_w2b_guards
-- (whole; the W2b-5 lines are marked): outsourced and its subcontract order change while the work order is DRAFT, RELEASED,
-- IN_PROGRESS or ON_HOLD.
CREATE OR REPLACE FUNCTION "factory_work_order_operation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  -- W2b-5 (wave 41/44; PLN-165): what changes after DRAFT: the work centre always; outside or back in while the work order
  -- is RELEASED, IN_PROGRESS or ON_HOLD.
  movable text[] := ARRAY['workCentreId', 'version', 'updatedAt'];
  state text;
  part_of uuid;
  step record;
  library record;
  company uuid;
  centre_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."workOrderId" <> OLD."workOrderId" THEN
      RAISE EXCEPTION 'production: work order operation % never moves to another work order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF current_user = 'factory_floor_runtime' THEN
    -- W2b-2: a floor session only adds an unplanned operation (its grant is INSERT), and holds no UPDATE right to lock the
    -- work order FOR SHARE: the work order's issue lock in SHARED mode instead (a status move takes it, as for a scan).
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(concat_ws('|', 'factory.work-order-issue', NEW."tenantId"::text, NEW."workOrderId"::text), 0));
    part_of := NEW."workOrderId";
    SELECT w."status"::text, w."companyId" INTO state, company FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
    IF NOT FOUND THEN
      -- Outside this session's scope: the policies refuse the row.
      RETURN NEW;
    END IF;
    IF NEW."routingSeq" IS NOT NULL THEN
      RAISE EXCEPTION 'production: a floor session adds only an unplanned operation to work order %; the routing''s operations are the office''s', NEW."workOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    part_of := NEW."workOrderId";
    SELECT w."status"::text, w."companyId" INTO state, company FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId" FOR SHARE;
  ELSE
    part_of := OLD."workOrderId";
    SELECT w."status"::text, w."companyId" INTO state, company FROM "WorkOrder" w WHERE w."tenantId" = OLD."tenantId" AND w."id" = OLD."workOrderId" FOR SHARE;
  END IF;
  IF state IN ('RELEASED', 'IN_PROGRESS', 'ON_HOLD') THEN
    movable := movable || ARRAY['outsourced', 'subcontractOrderId'];
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT'
     -- W2b-2 (MES-086): the one row added after DRAFT.
     AND NOT (TG_OP = 'INSERT' AND NEW."routingSeq" IS NULL AND state IN ('RELEASED', 'IN_PROGRESS'))
     AND (TG_OP <> 'UPDATE'
          OR (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable))) THEN
    RAISE EXCEPTION 'production: work order % is %; its operations are frozen (MES-005), only their work centre changes (another of the same kind), and while it is RELEASED, IN_PROGRESS or ON_HOLD whether one is done outside', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'production: work order operation % has a place from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-2 (MES-086): an unplanned operation is a copy of its operation of the library, when it was added (a later edit of
  -- the library leaves it), with why, at a work centre of the operation's kind.
  IF NEW."routingSeq" IS NULL THEN
    IF NEW."operationId" IS NULL OR NEW."unplannedReason" IS NULL OR NEW."unplannedReason" !~ '^\S+$' OR NEW."parallelGroup" IS NOT NULL THEN
      RAISE EXCEPTION 'production: work order operation % has no routing step: an unplanned operation names its operation of the library and why (a code, no spaces), in no parallel group', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF state = 'DRAFT' THEN
      RAISE EXCEPTION 'production: work order % is DRAFT; an unplanned operation is added once it is RELEASED or IN_PROGRESS (a draft follows its routing)', NEW."workOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT op."code", op."name", op."standardMinutes", op."workCentreKind"::text AS kind, op."status"::text AS status, op."companyId" INTO library
      FROM "Operation" op WHERE op."tenantId" = NEW."tenantId" AND op."id" = NEW."operationId";
    IF FOUND THEN
      IF TG_OP = 'INSERT' AND (library.status <> 'ACTIVE' OR library."companyId" <> company) THEN
        RAISE EXCEPTION 'production: work order operation % takes an active operation of the library of its company', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP = 'INSERT' AND (library."code", library."name", library."standardMinutes") IS DISTINCT FROM (NEW."code", NEW."name", NEW."standardMinutes") THEN
        RAISE EXCEPTION 'production: unplanned operation % is a copy of operation % of the library (code, name, standard minutes)', NEW."id", NEW."operationId"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT wc."kind"::text INTO centre_kind FROM "WorkCentre" wc WHERE wc."tenantId" = NEW."tenantId" AND wc."siteId" = NEW."siteId" AND wc."id" = NEW."workCentreId";
      IF FOUND AND centre_kind <> library.kind THEN
        RAISE EXCEPTION 'production: work order operation % runs at a work centre of kind % (its operation''s), not %', NEW."id", library.kind, centre_kind
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."operationId" IS NOT NULL OR NEW."unplannedReason" IS NOT NULL THEN
    RAISE EXCEPTION 'production: work order operation % is routing step %; only an unplanned operation names a library operation and a reason', NEW."id", NEW."routingSeq"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT ro."code", ro."name", ro."standardMinutes", ro."scanRequired", ro."parallelGroup", ro."workCentreKind"::text AS kind INTO step
    FROM "RoutingOperation" ro WHERE ro."tenantId" = NEW."tenantId" AND ro."revisionId" = NEW."styleRevisionId" AND ro."seq" = NEW."routingSeq";
  IF FOUND THEN
    -- The frozen copy of the parallel group is filled here, so a work order made from the routing needs no new column.
    NEW."parallelGroup" := coalesce(NEW."parallelGroup", step."parallelGroup");
    IF (step."code", step."name", step."standardMinutes", step."scanRequired", step."parallelGroup") IS DISTINCT FROM (NEW."code", NEW."name", NEW."standardMinutes", NEW."scanRequired", NEW."parallelGroup") THEN
      RAISE EXCEPTION 'production: work order operation % is a copy of routing step % of revision % (code, name, standard minutes, scan required, parallel group)', NEW."id", NEW."routingSeq", NEW."styleRevisionId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT wc."kind"::text INTO centre_kind FROM "WorkCentre" wc WHERE wc."tenantId" = NEW."tenantId" AND wc."siteId" = NEW."siteId" AND wc."id" = NEW."workCentreId";
    IF FOUND AND centre_kind <> step.kind THEN
      RAISE EXCEPTION 'production: work order operation % runs at a work centre of kind % (its routing step''s), not %', NEW."id", step.kind, centre_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_work_order_operation_outsourced_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."outsourced", NEW."subcontractOrderId") IS NOT DISTINCT FROM (OLD."outsourced", OLD."subcontractOrderId") THEN
    RETURN NULL;
  END IF;
  IF NEW."subcontractOrderId" IS NOT NULL AND NOT NEW."outsourced" THEN
    RAISE EXCEPTION 'production: operation % names a subcontract order only while it is done outside', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."subcontractOrderId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."subcontractOrderId" IS DISTINCT FROM OLD."subcontractOrderId") THEN
    SELECT o."status"::text INTO order_state FROM "SubcontractOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."subcontractOrderId";
    IF order_state IN ('CANCELLED', 'CLOSED') THEN
      RAISE EXCEPTION 'production: operation % goes out with a subcontract order that is not %', NEW."id", order_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WorkOrderOperation_w2b5_outsourced" AFTER INSERT OR UPDATE OF "outsourced", "subcontractOrderId" ON "WorkOrderOperation"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_operation_outsourced_check"();
