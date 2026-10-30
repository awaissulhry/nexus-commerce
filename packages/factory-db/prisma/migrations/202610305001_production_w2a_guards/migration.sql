-- Written by hand (Prisma does not model triggers), after the generated 202610305000_production_w2a_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Production and schedule, W2a schema wave 5/7 (plan W2A §5; MES-008, MES-011, MES-019, MES-071, MES-126, MES-130,
-- GAP-003, PLN-129, PLN-131, PLN-147, PLN-160; Owner answers P3 and F2): the hand-written rules of what
-- 202610305000_production_w2a_schema made, for every login (the owner included). The API answers each refusal first, in
-- words (apps/factory-api modules/production/{work-orders,completion,rework,scrap,bundles}, modules/inventory/finished,
-- modules/quality/holds, modules/planning/schedule: B-W2a-12, B-W2a-13, B-W2a-26, B-W2a-34); these are the last word.
-- Every refusal is a check_violation (SQLSTATE 23514). The tenant, site and party of a row are left to the policies and
-- the references: a rule never refuses a change of them (the policies do, with their own error), and a rule that reads
-- another row skips a row this session cannot see (the policies refuse that write anyway).
--
--   WorkOrder           ON_HOLD (MES-008) from DRAFT, RELEASED or IN_PROGRESS with its reason, back to that status or
--                       CANCELLED; the kind REPAIR (MES-019) released with at least one operation (not the whole
--                       routing) and cells of any sales line kind; the line it is allocated to (PLN-160). REDEFINES
--                       factory_work_order_guard (202610283801_production_guards): its whole body, with those rules.
--   WorkOrderSize       a REPAIR work order's cells. REDEFINES factory_work_order_size_guard (202610283801_production_guards):
--                       its whole body, with that rule.
--   the gate            a held work order moves on nowhere: no scan, cut, bundle, correction request, garment label
--                       print, final inspection, quality release, rework progress or finished-goods receipt takes it
--                       until the hold is lifted (factory_work_order_gate, under a lock the hold, close and cancel wait
--                       on: WorkOrder_gate_lock).
--   Bundle              a split (MES-071): of an ACTIVE bundle, the same cell and part, its genealogy kept, at least one
--                       garment left in the parent; a parent with ACTIVE children is not voided.
--   Item                FINISHED (GAP-003) exactly with its SKU (variantId), counted in PCS, never by hide; its SKU and
--                       kind never change. A BOM line never names a FINISHED item.
--   StockMove           PRODUCTION_RECEIPT (GAP-003, MES-011): finished garments of an IN_PROGRESS or COMPLETED work order,
--                       as the FINISHED item of a SKU it makes, into finished-goods stock, never more than its cell
--                       makes.
--   ReworkOrder         MES-126: OPEN → IN_PROGRESS → DONE | CANCELLED, its result adds up, its references agree.
--   ReplacementRequest  MES-130: a RECUT is done by a cut of its cell, a REDUCE approved by another person.
--   PlanVersion         P3, PLN-147: one WORKING plan per site; PUBLISHED versions numbered upwards and frozen once
--                       published, never left unpublished at commit; never deleted.
--   ScheduleSlot        a slot books one lane; the slots of a published version never change and are never removed.
--   TRUNCATE            refused on the four new tables (…_production_guards' factory_production_refuse_truncate).
--
-- "Everything but these columns" is compared as jsonb (to_jsonb(row) minus the named keys), so a column added later is
-- frozen too unless a later migration names it.

-- ---------------------------------------------------------------------------------------------------------------------
-- The gate (MES-008: "floor devices refuse to start it and show the reason"; the plan: a held work order moves on
-- nowhere). The work a work order's floor and quality rows record is inserted only while the work order is not ON_HOLD.
-- A hold and a scan at the same time take turns: the scan's trigger takes the work order's gate lock SHARED (many scans
-- of one work order run side by side), then reads its status (READ COMMITTED: each statement of the function sees what
-- committed before it); a move of the status to ON_HOLD, CLOSED or CANCELLED takes the same lock EXCLUSIVE
-- (WorkOrder_gate_lock), so it waits for the scans in flight, and a scan after it waits for it and then sees it. The
-- floor role only reads work orders, so a row lock cannot do it (as …_inventory_issue_work_order_guards explains). The
-- API's hold, close and cancel commands take the lock first ('factory.work-order-gate|<tenant>|<work order>',
-- pg_advisory_xact_lock), before they update the row, so a command that also writes gated rows never meets them in a
-- cycle; the trigger takes it again (advisory locks are re-entrant).
CREATE FUNCTION "factory_work_order_gate"(tenant uuid, work_order uuid, what text, row_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
  reason text;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(concat_ws('|', 'factory.work-order-gate', tenant, work_order), 0));
  SELECT w."status"::text, w."holdReason" INTO order_state, reason FROM "WorkOrder" w WHERE w."tenantId" = tenant AND w."id" = work_order;
  IF FOUND AND order_state = 'ON_HOLD' THEN
    RAISE EXCEPTION 'production: work order % is ON_HOLD (%); % % waits until the hold is lifted (MES-008)', work_order, reason, what, row_id
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION "factory_work_order_gate_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "factory_work_order_gate"(NEW."tenantId", NEW."workOrderId", TG_TABLE_NAME, NEW."id");
  RETURN NEW;
END
$$;

-- Each fires before the table's own check (triggers of one event fire in name order), so the gate's words come first.
CREATE TRIGGER "OperationScan_awaits_hold" BEFORE INSERT ON "OperationScan"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_gate_check"();
CREATE TRIGGER "CutLog_awaits_hold" BEFORE INSERT ON "CutLog"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_gate_check"();
CREATE TRIGGER "Bundle_awaits_hold" BEFORE INSERT ON "Bundle"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_gate_check"();
CREATE TRIGGER "ScanCorrectionRequest_awaits_hold" BEFORE INSERT ON "ScanCorrectionRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_gate_check"();
CREATE TRIGGER "GarmentLabelPrint_awaits_hold" BEFORE INSERT ON "GarmentLabelPrint"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_gate_check"();
CREATE TRIGGER "Inspection_awaits_hold" BEFORE INSERT ON "Inspection"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_gate_check"();
CREATE TRIGGER "QualityRelease_awaits_hold" BEFORE INSERT ON "QualityRelease"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_gate_check"();

-- A hold, a close or a cancel waits for the gated rows in flight; those after it see it.
CREATE FUNCTION "factory_work_order_gate_lock"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.work-order-gate', NEW."tenantId", NEW."id"), 0));
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkOrder_gate_lock" BEFORE UPDATE OF "status" ON "WorkOrder"
  FOR EACH ROW WHEN (NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" IN ('ON_HOLD', 'CLOSED', 'CANCELLED'))
  EXECUTE FUNCTION "factory_work_order_gate_lock"();

-- ---------------------------------------------------------------------------------------------------------------------
-- WorkOrder (MES-005, MES-007, MES-076; W2a MES-008 hold, MES-019 repair, PLN-160 line)
--   INSERT     a work order starts as DRAFT.
--   UPDATE     an UPDATE that changes nothing passes; the company, number, kind, style and creation never change; the
--              status moves DRAFT → RELEASED | CANCELLED | ON_HOLD, RELEASED → IN_PROGRESS | CANCELLED | ON_HOLD,
--              IN_PROGRESS → COMPLETED | CANCELLED | ON_HOLD, COMPLETED → CLOSED, ON_HOLD → the status it was held
--              from | CANCELLED; CLOSED and CANCELLED are final (only the note changes). From RELEASED on, and while
--              held, the frozen specification never changes: the revision, the label template, the batch number and
--              the release (only the status and its times, the hold, the line, the due date, priority and note do).
--   hold       entering ON_HOLD records the status it was in (heldFromStatus), when and why; while held, where it was
--              held from, when and by whom stay (the reason and the record behind it may be put right); lifting it
--              clears the hold.
--   line       an ACTIVE line of its site when set or changed; it stays once the work order is COMPLETED (output is
--              counted per line, Owner answer F2).
--   release    (DRAFT → RELEASED) the revision is a RELEASED revision of its style; the label template is that
--              revision's (ACTIVE, when it has one); it has a batch number; it has cells (a made-to-measure work order
--              exactly one, of quantity 1, with the measurement profile; a size grid none with one; a repair's cells
--              any, a made-to-measure garment one unit); every step of the revision's routing is one of its operations
--              (a repair: at least one operation, the steps the repair needs).
--   every row  the hold exactly while ON_HOLD (held from DRAFT, RELEASED or IN_PROGRESS, with when and a reason; the
--              record behind it both type and id, or neither); released (time and batch number) exactly from RELEASED
--              on, started from IN_PROGRESS on, completed from COMPLETED on, closed exactly when CLOSED, as the status
--              it was held from says while ON_HOLD (a work order cancelled after its release keeps them); CANCELLED
--              exactly with its time and reason.
--   DELETE     refused (a work order is cancelled). TRUNCATE refused.
-- The cells, operations and planned materials change only while the work order is DRAFT (their triggers, which lock
-- its row FOR SHARE, so a release waits for the transaction that edits them, and an edit after it sees it released).
CREATE OR REPLACE FUNCTION "factory_work_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  progress CONSTANT text[] := ARRAY['status', 'dueDate', 'priority', 'note', 'startedAt', 'completedAt', 'closedAt', 'cancelledAt',
    'cancelReason', 'lineId', 'heldFromStatus', 'holdReason', 'heldAt', 'heldById', 'holdRecordType', 'holdRecordId', 'version', 'updatedAt'];
  effective text;
  revision_state text;
  revision_label uuid;
  label_state text;
  line_state text;
  cells integer;
  wrong_cells integer;
  operations integer;
  unmapped integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: work order % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'production: work order % starts as DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."kind", NEW."styleId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."number", OLD."kind", OLD."styleId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: the company, number, kind, style and creation of work order % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('RELEASED', 'CANCELLED', 'ON_HOLD'))
                OR (OLD."status" = 'RELEASED' AND NEW."status" IN ('IN_PROGRESS', 'CANCELLED', 'ON_HOLD'))
                OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('COMPLETED', 'CANCELLED', 'ON_HOLD'))
                OR (OLD."status" = 'COMPLETED' AND NEW."status" = 'CLOSED')
                OR (OLD."status" = 'ON_HOLD' AND (NEW."status" = OLD."heldFromStatus" OR NEW."status" = 'CANCELLED'))) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('production: work order %s cannot move from %s to %s%s', OLD."id", OLD."status", NEW."status",
          CASE WHEN OLD."status" = 'ON_HOLD' THEN format(' (lifting its hold puts it back to %s, MES-008)', OLD."heldFromStatus") ELSE '' END);
    END IF;
    IF NEW."status" = 'ON_HOLD' AND OLD."status" <> 'ON_HOLD' AND NEW."heldFromStatus" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'production: work order % is held from the status it is in (%), the status lifting the hold goes back to (MES-008)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'ON_HOLD' AND OLD."status" = 'ON_HOLD'
       AND (NEW."heldFromStatus", NEW."heldAt", NEW."heldById") IS DISTINCT FROM (OLD."heldFromStatus", OLD."heldAt", OLD."heldById") THEN
      RAISE EXCEPTION 'production: the hold of work order % keeps where it was held from, when and by whom; a new hold comes after this one is lifted', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - (kept || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || progress)) THEN
      RAISE EXCEPTION 'production: work order % is %; its frozen specification (revision, label template, batch number) and release never change (MES-005); a different specification is a new work order', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'production: work order % is %; only its note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'COMPLETED' AND NEW."lineId" IS DISTINCT FROM OLD."lineId" THEN
      RAISE EXCEPTION 'production: work order % is COMPLETED; the line it was made on stays (output is counted per line)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'DRAFT' AND NEW."status" = 'RELEASED' THEN
      IF NEW."styleRevisionId" IS NULL THEN
        RAISE EXCEPTION 'production: work order % is released with a RELEASED revision of its style', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."status"::text, r."labelTemplateId" INTO revision_state, revision_label
        FROM "StyleRevision" r WHERE r."tenantId" = NEW."tenantId" AND r."styleId" = NEW."styleId" AND r."id" = NEW."styleRevisionId";
      IF FOUND THEN
        IF revision_state <> 'RELEASED' THEN
          RAISE EXCEPTION 'production: revision % is %; work order % is released only with a RELEASED revision of its style', NEW."styleRevisionId", revision_state, NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."labelTemplateId" IS DISTINCT FROM revision_label THEN
          RAISE EXCEPTION 'production: work order % carries the label template of its revision % (%), frozen with it', NEW."id", NEW."styleRevisionId", coalesce(revision_label::text, 'none')
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      IF NEW."labelTemplateId" IS NOT NULL THEN
        SELECT t."status"::text INTO label_state FROM "LabelTemplate" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."labelTemplateId";
        IF FOUND AND label_state <> 'ACTIVE' THEN
          RAISE EXCEPTION 'production: label template % is %; work order % is released with an ACTIVE one', NEW."labelTemplateId", label_state, NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      SELECT count(*),
             count(*) FILTER (WHERE CASE WHEN NEW."kind" = 'REPAIR'
                                         THEN c."measurementProfileId" IS NOT NULL AND c."quantity" <> 1
                                         ELSE (c."measurementProfileId" IS NOT NULL) <> (NEW."kind" = 'MADE_TO_MEASURE')
                                              OR (NEW."kind" = 'MADE_TO_MEASURE' AND c."quantity" <> 1) END)
        INTO cells, wrong_cells
        FROM "WorkOrderSize" c WHERE c."tenantId" = NEW."tenantId" AND c."workOrderId" = NEW."id";
      IF cells = 0 OR wrong_cells > 0 OR (NEW."kind" = 'MADE_TO_MEASURE' AND cells <> 1) THEN
        RAISE EXCEPTION 'production: work order % is released with its cells: a size grid without measurement profiles, one made-to-measure unit of quantity 1 with its profile, or a repair''s garments (a made-to-measure one a single unit with its profile)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*) INTO operations FROM "WorkOrderOperation" o WHERE o."tenantId" = NEW."tenantId" AND o."workOrderId" = NEW."id";
      SELECT count(*) INTO unmapped
        FROM "RoutingOperation" ro
       WHERE ro."tenantId" = NEW."tenantId" AND ro."revisionId" = NEW."styleRevisionId"
         AND NOT EXISTS (SELECT 1 FROM "WorkOrderOperation" o
                          WHERE o."tenantId" = NEW."tenantId" AND o."workOrderId" = NEW."id" AND o."routingSeq" = ro."seq");
      IF operations = 0 OR (NEW."kind" <> 'REPAIR' AND unmapped > 0) THEN
        RAISE EXCEPTION 'production: work order % is released with every step of its revision''s routing as an operation at a work centre of its site (% step(s) missing); a repair with at least one', NEW."id", unmapped
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  effective := CASE WHEN NEW."status" = 'ON_HOLD' THEN NEW."heldFromStatus"::text ELSE NEW."status"::text END;

  IF btrim(NEW."number") = '' OR (NEW."batchNumber" IS NOT NULL AND btrim(NEW."batchNumber") = '') THEN
    RAISE EXCEPTION 'production: work order % has a number, and a batch number that is not blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ON_HOLD') <> (NEW."heldFromStatus" IS NOT NULL)
     OR (NEW."status" = 'ON_HOLD') <> (NEW."heldAt" IS NOT NULL)
     OR (NEW."status" = 'ON_HOLD') <> (btrim(coalesce(NEW."holdReason", '')) <> '')
     OR (NEW."status" <> 'ON_HOLD' AND (NEW."heldById" IS NOT NULL OR NEW."holdRecordType" IS NOT NULL OR NEW."holdRecordId" IS NOT NULL))
     OR (NEW."heldFromStatus" IS NOT NULL AND NEW."heldFromStatus" NOT IN ('DRAFT', 'RELEASED', 'IN_PROGRESS'))
     OR (NEW."holdRecordType" IS NULL) <> (NEW."holdRecordId" IS NULL)
     OR btrim(coalesce(NEW."holdRecordType", '-')) = '' THEN
    RAISE EXCEPTION 'production: work order % is % with the wrong hold: ON_HOLD exactly with the status it was held from (DRAFT, RELEASED or IN_PROGRESS), when and why (MES-008), and the record behind it as type and id or neither; no hold otherwise', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lineId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."lineId" IS DISTINCT FROM OLD."lineId") THEN
    SELECT l."status"::text INTO line_state FROM "Line" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."lineId";
    IF FOUND AND line_state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'production: line % is %; work order % is allocated to an ACTIVE line of its site (PLN-160)', NEW."lineId", line_state, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (effective IN ('RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED') AND NEW."releasedAt" IS NULL)
     OR (effective = 'DRAFT' AND (NEW."releasedAt" IS NOT NULL OR NEW."releasedById" IS NOT NULL))
     OR (NEW."releasedAt" IS NULL) <> (NEW."batchNumber" IS NULL)
     OR (NEW."releasedAt" IS NOT NULL AND NEW."styleRevisionId" IS NULL) THEN
    RAISE EXCEPTION 'production: work order % is % with the wrong release: its release time, revision and batch number (MES-076) are set exactly from RELEASED on', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (effective IN ('IN_PROGRESS', 'COMPLETED', 'CLOSED') AND NEW."startedAt" IS NULL)
     OR (effective IN ('DRAFT', 'RELEASED') AND NEW."startedAt" IS NOT NULL)
     OR (effective IN ('COMPLETED', 'CLOSED')) <> (NEW."completedAt" IS NOT NULL)
     OR (effective = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'production: work order % is % with the wrong start, completion or closing time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'production: work order % is % with the wrong cancellation (a cancelled work order has its time and reason, MES-007)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- WorkOrderSize (MES-002, MES-003; the frozen size quantities; W2a MES-019 a repair's garments)
--   INSERT, UPDATE, DELETE  only while the work order is DRAFT (its row locked FOR SHARE); a cell never moves to another
--                           work order. An UPDATE that changes nothing passes.
--   every row               at least one piece; it makes its sales order line: the line's style, colourway and
--                           measurement profile, and the line's kind is the work order's (a size grid's, a
--                           made-to-measure unit's); a made-to-measure cell is one unit with the profile, a size-grid
--                           cell has none. A REPAIR work order's cell repairs garments of a line of any kind: with the
--                           line's profile, and then one unit.
--   TRUNCATE                refused.
CREATE OR REPLACE FUNCTION "factory_work_order_size_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  order_kind text;
  part_of uuid;
  line record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."workOrderId" <> OLD."workOrderId" THEN
      RAISE EXCEPTION 'production: work order cell % never moves to another work order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    part_of := NEW."workOrderId";
    SELECT w."status"::text, w."kind"::text INTO state, order_kind FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId" FOR SHARE;
  ELSE
    part_of := OLD."workOrderId";
    SELECT w."status"::text, w."kind"::text INTO state, order_kind FROM "WorkOrder" w WHERE w."tenantId" = OLD."tenantId" AND w."id" = OLD."workOrderId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'production: work order % is %; its size quantities are frozen (MES-005), they change only while it is DRAFT', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1 OR btrim(NEW."size") = '' THEN
    RAISE EXCEPTION 'production: work order cell % has a size and at least one piece', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF order_kind IS NOT NULL AND order_kind <> 'REPAIR'
     AND ((order_kind = 'MADE_TO_MEASURE') <> (NEW."measurementProfileId" IS NOT NULL)
          OR (order_kind = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1)) THEN
    RAISE EXCEPTION 'production: work order cell % is one made-to-measure unit with its measurement profile, or a size-grid cell without one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF order_kind = 'REPAIR' AND NEW."measurementProfileId" IS NOT NULL AND NEW."quantity" <> 1 THEN
    RAISE EXCEPTION 'production: repair cell % repairs one made-to-measure garment (one unit with its profile)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."styleId", l."colourwayId", l."kind"::text AS kind, l."measurementProfileId" INTO line
    FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
  IF FOUND
     AND ((line."styleId", line."colourwayId", line."measurementProfileId") IS DISTINCT FROM (NEW."styleId", NEW."colourwayId", NEW."measurementProfileId")
          OR (order_kind IS NOT NULL AND order_kind <> 'REPAIR' AND line.kind <> order_kind)) THEN
    RAISE EXCEPTION 'production: work order cell % makes its sales order line %: the same style, colourway, kind and measurement profile (a repair: any kind)', NEW."id", NEW."salesOrderLineId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Bundle, a split (MES-071: "pieces into a child bundle with its own ticket (rework, recut, hold); genealogy kept")
--   INSERT     a bundle split from another (parentBundleId) is of the same work order (the reference), cell and part;
--              the parent is ACTIVE and not itself; its cut log entries are among the parent's (genealogy); the
--              parent's quantity stays as cut, and what its children that are not VOID took, this one included,
--              leaves at least one garment in it. Read under a transaction lock per parent, so two splits of one
--              bundle at once wait for each other. The parent never changes (a frozen column of factory_bundle_guard).
--   VOID       a bundle with ACTIVE children is voided only after them.
CREATE FUNCTION "factory_bundle_split_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  taken integer;
BEGIN
  IF NEW."parentBundleId" = NEW."id" THEN
    RAISE EXCEPTION 'production: bundle % is not split from itself', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.bundle-split', NEW."tenantId", NEW."parentBundleId"), 0));
  SELECT b."workOrderSizeId", b."part", b."status"::text AS status, b."quantity", b."cutLogIds" INTO parent
    FROM "Bundle" b
   WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."workOrderId" = NEW."workOrderId" AND b."id" = NEW."parentBundleId";
  IF NOT FOUND THEN
    -- Another work order's or site's bundle: the reference refuses it.
    RETURN NEW;
  END IF;
  IF parent.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'production: bundle % is %; only an ACTIVE bundle is split (MES-071)', NEW."parentBundleId", parent.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF (parent."workOrderSizeId", parent."part") IS DISTINCT FROM (NEW."workOrderSizeId", NEW."part") THEN
    RAISE EXCEPTION 'production: bundle % is split from bundle % of the same cell and part', NEW."id", NEW."parentBundleId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (NEW."cutLogIds" <@ parent."cutLogIds") THEN
    RAISE EXCEPTION 'production: bundle % keeps the genealogy of bundle %: its cut log entries are among the parent''s', NEW."id", NEW."parentBundleId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(c."quantity"), 0) INTO taken
    FROM "Bundle" c WHERE c."tenantId" = NEW."tenantId" AND c."parentBundleId" = NEW."parentBundleId" AND c."status" <> 'VOID';
  IF taken + NEW."quantity" > parent."quantity" - 1 THEN
    RAISE EXCEPTION 'production: bundle % carries % garment(s), % split off already; a split of % leaves none in it (at least one stays, MES-071)', NEW."parentBundleId", parent."quantity", taken, NEW."quantity"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Bundle_split_check" BEFORE INSERT ON "Bundle"
  FOR EACH ROW WHEN (NEW."parentBundleId" IS NOT NULL)
  EXECUTE FUNCTION "factory_bundle_split_check"();

CREATE FUNCTION "factory_bundle_split_void_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Bundle" c WHERE c."tenantId" = NEW."tenantId" AND c."parentBundleId" = NEW."id" AND c."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'production: bundle % has ACTIVE bundles split from it; void them first (MES-071: the genealogy stays whole)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Bundle_split_void_check" BEFORE UPDATE OF "status" ON "Bundle"
  FOR EACH ROW WHEN (OLD."status" = 'ACTIVE' AND NEW."status" = 'VOID')
  EXECUTE FUNCTION "factory_bundle_split_void_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Item, a finished garment (GAP-003)
--   every row  FINISHED exactly with its SKU (variantId); a FINISHED item counts pieces (PCS), is tracked by none, lot
--              or serial (never hide) and needs no Cr VI test of its own (its leather's lots had theirs).
--   UPDATE     an UPDATE that changes nothing passes; a finished-goods item keeps its SKU, and an item never becomes or
--              stops being FINISHED (a new SKU is a new item). One item per SKU: the unique key.
CREATE FUNCTION "factory_item_finished_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."variantId" IS DISTINCT FROM OLD."variantId" OR (NEW."kind" = 'FINISHED') <> (OLD."kind" = 'FINISHED') THEN
      RAISE EXCEPTION 'product: item % keeps its kind and SKU: a finished-goods item is one SKU for good, and no other item becomes one (a new SKU is a new item)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."kind" = 'FINISHED') <> (NEW."variantId" IS NOT NULL) THEN
    RAISE EXCEPTION 'product: item % is a FINISHED garment exactly when it names its SKU (variantId)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'FINISHED' AND (NEW."baseUom" <> 'PCS' OR NEW."tracking" = 'HIDE' OR NEW."requiresCrViTest") THEN
    RAISE EXCEPTION 'product: finished-goods item % counts pieces (PCS), is tracked by none, lot or serial (never by hide) and needs no Cr VI test of its own', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Item_finished_guard" BEFORE INSERT OR UPDATE ON "Item"
  FOR EACH ROW EXECUTE FUNCTION "factory_item_finished_guard"();

-- BomLine: a BOM line names a material, never a finished garment's item (FINISHED is stock, not a material of the
-- library: the product module's material reads and costing leave it out).
CREATE FUNCTION "factory_bom_line_not_finished"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId" AND i."kind" = 'FINISHED') THEN
    RAISE EXCEPTION 'product: BOM line % names item %, a finished garment''s item; a BOM line names a material', NEW."id", NEW."itemId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "BomLine_not_finished" BEFORE INSERT OR UPDATE OF "itemId" ON "BomLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_bom_line_not_finished"();

-- ---------------------------------------------------------------------------------------------------------------------
-- StockMove, PRODUCTION_RECEIPT (GAP-003, MES-011: partial completion to stock)
--   always     it names its work order, of the move's site; whole garments.
--   receipt    (not a reversal) it only enters stock, into a FINISHED_GOODS location or a place inside one; the work
--              order is IN_PROGRESS or COMPLETED (never ON_HOLD: the gate); the item is the FINISHED item of a SKU of
--              the work order's style, in the colourway and size of one of its cells; and the garments of that SKU in
--              stock from the work order (its receipts less their reversals), this one included, never pass the
--              cell's quantity. Read under the work order's gate lock (shared) and a receipt lock per work order, so
--              two receipts at once wait for each other.
--   reversal   mirrors its receipt (StockMove_check) and leaves stock; it is taken in any state.
-- Fires before StockMove_check (triggers of one event fire in name order): the work order's locks before the stock's.
CREATE FUNCTION "factory_stock_move_production_receipt_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_row record;
  sku record;
  cell_quantity integer;
  in_stock numeric;
  finished_place boolean;
BEGIN
  IF NEW."workOrderId" IS NULL THEN
    RAISE EXCEPTION 'inventory: stock move % is a PRODUCTION_RECEIPT without its work order', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."baseQuantity" <> trunc(NEW."baseQuantity") THEN
    RAISE EXCEPTION 'inventory: stock move % receives finished garments, whole pieces, not %', NEW."id", NEW."baseQuantity"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reversalOfId" IS NULL AND NOT (NEW."toLocationId" IS NOT NULL AND NEW."fromLocationId" IS NULL) THEN
    RAISE EXCEPTION 'inventory: stock move % is a PRODUCTION_RECEIPT; it only enters stock (its reversal leaves it)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reversalOfId" IS NULL THEN
    PERFORM "factory_work_order_gate"(NEW."tenantId", NEW."workOrderId", 'StockMove', NEW."id");
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.work-order-receipt', NEW."tenantId", NEW."workOrderId"), 0));
  SELECT w."status"::text AS status, w."styleId" INTO order_row
    FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory: stock move % is a PRODUCTION_RECEIPT for work order %, which is not a work order of its site', NEW."id", NEW."workOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reversalOfId" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF order_row.status NOT IN ('IN_PROGRESS', 'COMPLETED') THEN
    RAISE EXCEPTION 'inventory: work order % is %; its finished garments go into stock while it is IN_PROGRESS or COMPLETED (stock move %)', NEW."workOrderId", order_row.status, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."kind"::text AS kind, v."styleId", v."colourwayId", v."size" INTO sku
    FROM "Item" i LEFT JOIN "Variant" v ON v."tenantId" = i."tenantId" AND v."id" = i."variantId"
   WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
  IF NOT FOUND OR sku.kind <> 'FINISHED' THEN
    RAISE EXCEPTION 'inventory: stock move % receives item %, which is not a FINISHED item (a SKU): a production receipt puts finished garments into stock', NEW."id", NEW."itemId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF sku."styleId" IS DISTINCT FROM order_row."styleId" THEN
    RAISE EXCEPTION 'inventory: item % is a SKU of another style than work order %''s (stock move %)', NEW."itemId", NEW."workOrderId", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c."quantity" INTO cell_quantity
    FROM "WorkOrderSize" c
   WHERE c."tenantId" = NEW."tenantId" AND c."workOrderId" = NEW."workOrderId" AND c."colourwayId" = sku."colourwayId" AND c."size" = sku."size";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory: work order % makes no garment of item %''s SKU (no cell of its colourway and size; stock move %)', NEW."workOrderId", NEW."itemId", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  WITH RECURSIVE place AS (
    SELECT l."id", l."parentId", l."kind"::text AS kind, 1 AS depth
      FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."toLocationId"
    UNION ALL
    SELECT p."id", p."parentId", p."kind"::text, place.depth + 1
      FROM "Location" p JOIN place ON p."tenantId" = NEW."tenantId" AND p."siteId" = NEW."siteId" AND p."id" = place."parentId"
     WHERE place.depth < 32
  )
  SELECT EXISTS (SELECT 1 FROM place WHERE kind = 'FINISHED_GOODS') INTO finished_place;
  IF NOT finished_place THEN
    RAISE EXCEPTION 'inventory: stock move % puts finished garments into location %, which is not finished-goods stock (a FINISHED_GOODS location or a place inside one)', NEW."id", NEW."toLocationId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(CASE WHEN m."reversalOfId" IS NULL THEN m."baseQuantity" ELSE -m."baseQuantity" END), 0) INTO in_stock
    FROM "StockMove" m
   WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."workOrderId" = NEW."workOrderId"
     AND m."itemId" = NEW."itemId" AND m."reason" = 'PRODUCTION_RECEIPT';
  IF in_stock + NEW."baseQuantity" > cell_quantity THEN
    RAISE EXCEPTION 'inventory: work order % makes % garment(s) of item %; % went into stock already, so % more is too many (stock move %)', NEW."workOrderId", cell_quantity, NEW."itemId", in_stock, NEW."baseQuantity", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "StockMove_bound_to_production" BEFORE INSERT ON "StockMove"
  FOR EACH ROW WHEN (NEW."reason" = 'PRODUCTION_RECEIPT')
  EXECUTE FUNCTION "factory_stock_move_production_receipt_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- ReworkOrder (MES-126)
--   INSERT     OPEN with no result, for a work order that is RELEASED, IN_PROGRESS or ON_HOLD (a hold's disposition).
--   UPDATE     an UPDATE that changes nothing passes; the work order, cell, company, source scan, the operation it was
--              found at, the record behind it and the creation never change; what it is (bundle, the operation it is
--              redone at, its garments, reason and description) changes only while OPEN; the status moves OPEN →
--              IN_PROGRESS | DONE | CANCELLED, IN_PROGRESS → DONE | CANCELLED; DONE and CANCELLED are final (only the
--              note changes). A move to IN_PROGRESS or DONE takes the work order's gate: never while it is ON_HOLD,
--              and only while it is RELEASED or IN_PROGRESS.
--   every row  at least one garment; DONE: good + scrapped = its garments, 0 and 0 before; started from IN_PROGRESS on
--              (DONE included), not while OPEN; done exactly when DONE; cancelled exactly with its time and reason; a
--              reason code; the record behind it as type and id, or neither.
--   what       (at insert, and when it changes while OPEN) the reason is an active REWORK reason of the tenant's list;
--              the bundle (when named) is an ACTIVE bundle of the cell with at least its garments; the operation it is
--              redone at comes at or before the one it was found at.
--   source     (at insert) the scan is a REPORT or CORRECTION of the work order with rework, at the operation it was
--              found at.
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_rework_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  content CONSTANT text[] := ARRAY['bundleId', 'reworkAtOperationId', 'quantity', 'reasonCode', 'description'];
  progress CONSTANT text[] := ARRAY['status', 'goodQuantity', 'scrapQuantity', 'startedAt', 'doneAt', 'cancelledAt', 'cancelReason', 'note', 'version', 'updatedAt'];
  order_state text;
  item record;
  found_seq integer;
  redo_seq integer;
  scan record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: rework % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."goodQuantity" <> 0 OR NEW."scrapQuantity" <> 0 THEN
      RAISE EXCEPTION 'production: rework % starts OPEN, with no result yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || content || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || content || progress)) THEN
      RAISE EXCEPTION 'production: the work order, cell, source, the operation it was found at and the creation of rework % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN'
       AND (NEW."bundleId", NEW."reworkAtOperationId", NEW."quantity", NEW."reasonCode", NEW."description")
           IS DISTINCT FROM (OLD."bundleId", OLD."reworkAtOperationId", OLD."quantity", OLD."reasonCode", OLD."description") THEN
      RAISE EXCEPTION 'production: rework % is %; what it is (bundle, operation, garments, reason) changes only while OPEN', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('DONE', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'production: rework % is %; only its note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'OPEN' AND NEW."status" IN ('IN_PROGRESS', 'DONE', 'CANCELLED'))
                OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('DONE', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'production: rework % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."quantity" < 1 OR NEW."goodQuantity" < 0 OR NEW."scrapQuantity" < 0
     OR (NEW."status" = 'DONE' AND NEW."goodQuantity" + NEW."scrapQuantity" <> NEW."quantity")
     OR (NEW."status" <> 'DONE' AND (NEW."goodQuantity" <> 0 OR NEW."scrapQuantity" <> 0)) THEN
    RAISE EXCEPTION 'production: rework % has at least one garment; when DONE, its good and scrapped garments add up to them (none before)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('IN_PROGRESS', 'DONE') AND NEW."startedAt" IS NULL)
     OR (NEW."status" = 'OPEN' AND NEW."startedAt" IS NOT NULL)
     OR (NEW."status" = 'DONE') <> (NEW."doneAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'production: rework % is % with the wrong times: started from IN_PROGRESS on, done exactly when DONE, cancelled exactly with its time and reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."reasonCode") = '' OR (NEW."recordType" IS NULL) <> (NEW."recordId" IS NULL) OR btrim(coalesce(NEW."recordType", '-')) = '' THEN
    RAISE EXCEPTION 'production: rework % has a reason code, and the record behind it as type and id, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF NOT FOUND THEN
    -- Outside this session's scope: the policies refuse the row.
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND order_state NOT IN ('RELEASED', 'IN_PROGRESS', 'ON_HOLD') THEN
    RAISE EXCEPTION 'production: work order % is %; rework is opened while it is RELEASED, IN_PROGRESS or ON_HOLD', NEW."workOrderId", order_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" <> OLD."status" AND NEW."status" IN ('IN_PROGRESS', 'DONE') THEN
    PERFORM "factory_work_order_gate"(NEW."tenantId", NEW."workOrderId", 'rework', NEW."id");
    SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
    IF order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
      RAISE EXCEPTION 'production: work order % is %; its rework moves on while it is RELEASED or IN_PROGRESS', NEW."workOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT'
     OR (NEW."bundleId", NEW."reworkAtOperationId", NEW."quantity", NEW."reasonCode")
        IS DISTINCT FROM (OLD."bundleId", OLD."reworkAtOperationId", OLD."quantity", OLD."reasonCode") THEN
    IF NOT EXISTS (SELECT 1 FROM "ScrapReason" r
                    WHERE r."tenantId" = NEW."tenantId" AND r."kind" = 'REWORK' AND r."code" = NEW."reasonCode" AND r."active") THEN
      RAISE EXCEPTION 'production: rework % names %, which is not an active REWORK reason of the tenant''s list', NEW."id", NEW."reasonCode"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."bundleId" IS NOT NULL THEN
      SELECT b."workOrderSizeId", b."status"::text AS status, b."quantity" INTO item
        FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."id" = NEW."bundleId";
      IF FOUND AND (item."workOrderSizeId" <> NEW."workOrderSizeId" OR item.status <> 'ACTIVE' OR item."quantity" < NEW."quantity") THEN
        RAISE EXCEPTION 'production: rework % travels in an ACTIVE bundle of its cell that carries at least its % garment(s) (bundle %)', NEW."id", NEW."quantity", NEW."bundleId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."foundAtOperationId" IS NOT NULL THEN
      SELECT o."seq" INTO found_seq FROM "WorkOrderOperation" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."foundAtOperationId";
      SELECT o."seq" INTO redo_seq FROM "WorkOrderOperation" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."reworkAtOperationId";
      IF found_seq IS NOT NULL AND redo_seq IS NOT NULL AND redo_seq > found_seq THEN
        RAISE EXCEPTION 'production: rework % goes back to an operation at or before the one it was found at (%, not % after it)', NEW."id", found_seq, redo_seq
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND NEW."sourceScanId" IS NOT NULL THEN
    SELECT s."workOrderId", s."workOrderOperationId", s."kind"::text AS kind, s."reworkQuantity" INTO scan
      FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."sourceScanId";
    IF FOUND AND (scan."workOrderId" <> NEW."workOrderId" OR scan.kind NOT IN ('REPORT', 'CORRECTION') OR scan."reworkQuantity" < 1
                  OR NEW."foundAtOperationId" IS DISTINCT FROM scan."workOrderOperationId") THEN
      RAISE EXCEPTION 'production: rework % comes from scan %, a REPORT or CORRECTION of its work order with rework, at the operation it was found at', NEW."id", NEW."sourceScanId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReworkOrder_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ReworkOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_rework_order_guard"();
CREATE TRIGGER "ReworkOrder_no_truncate" BEFORE TRUNCATE ON "ReworkOrder"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- ReplacementRequest (MES-130)
--   INSERT     OPEN, undecided, for a work order that is RELEASED, IN_PROGRESS, ON_HOLD or COMPLETED; no more garments
--              than its cell; its scan (when named) is of the work order with scrap, its rework (when named) DONE with
--              scrap.
--   UPDATE     an UPDATE that changes nothing passes; the work order, cell, kind, sources and creation never change;
--              its garments, part and reason only while OPEN; the status moves OPEN → APPROVED | REFUSED (a REDUCE),
--              OPEN → DONE (a RECUT), OPEN → CANCELLED, APPROVED → DONE | CANCELLED; DONE, REFUSED and CANCELLED are
--              final (only the note changes).
--   every row  at least one garment; a reason; a part only for a RECUT; the record behind it as type and id, or
--              neither. A REDUCE's decision (who and when) exactly once decided (APPROVED, REFUSED, DONE; kept when
--              CANCELLED after APPROVED), by another person than who asked; REFUSED says why; a RECUT has none. A RECUT
--              is DONE exactly with its cut log entry: of the work order, not a reversal, with pieces of the cell (of
--              the part, when named); a REDUCE never names one. Done exactly when DONE; cancelled exactly with its time
--              and reason.
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_replacement_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  content CONSTANT text[] := ARRAY['quantity', 'part', 'reason'];
  progress CONSTANT text[] := ARRAY['status', 'decidedAt', 'decidedById', 'decisionNote', 'cutLogId', 'doneAt', 'cancelledAt', 'cancelReason', 'note', 'version', 'updatedAt'];
  order_state text;
  cell_quantity integer;
  decided boolean;
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
  END IF;

  IF NEW."quantity" < 1 OR btrim(NEW."reason") = '' OR (NEW."part" IS NOT NULL AND (NEW."kind" <> 'RECUT' OR btrim(NEW."part") = ''))
     OR (NEW."recordType" IS NULL) <> (NEW."recordId" IS NULL) OR btrim(coalesce(NEW."recordType", '-')) = '' THEN
    RAISE EXCEPTION 'production: replacement % has at least one garment, a reason, a part only for a RECUT, and the record behind it as type and id or neither', NEW."id"
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
  IF (NEW."kind" = 'RECUT' AND NEW."status" = 'DONE') <> (NEW."cutLogId" IS NOT NULL)
     OR (NEW."status" = 'DONE') <> (NEW."doneAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'production: replacement % is % with the wrong times: a RECUT is DONE exactly with its cut log entry, done exactly when DONE, cancelled exactly with its time and reason', NEW."id", NEW."status"
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
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReplacementRequest_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ReplacementRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_replacement_request_guard"();
CREATE TRIGGER "ReplacementRequest_no_truncate" BEFORE TRUNCATE ON "ReplacementRequest"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- PlanVersion (Owner answer P3; PLN-147)
--   WORKING    one per site (the partial unique index below); none of the published columns (number, previous,
--              covers, effective, published); only its note changes; never deleted.
--   PUBLISHED  numbered above every earlier version of its site (the unique key refuses two of one number); the
--              version it follows (when named) is a published version of its site with a lower number; covers from ≤
--              to (both or neither). Until publishedAt is set its range, start and note may change; publishedAt is set
--              once, with who published it, its range and when the floor starts working to it; from then on nothing
--              changes. It never stays without publishedAt past its transaction (a deferred check). Never deleted.
--   UPDATE     an UPDATE that changes nothing passes; the company, kind, number, previous version and creation never
--              change.
CREATE FUNCTION "factory_plan_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  highest integer;
  previous record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: plan % is kept, never deleted (the working plan of its site, or a version the floor was given)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."kind", NEW."number", NEW."previousId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."kind", OLD."number", OLD."previousId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: the company, kind, number, previous version and creation of plan % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."publishedAt" IS NOT NULL AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'production: plan version % (v%) is published; it never changes (the floor was given it, PLN-147)', OLD."id", OLD."number"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."kind" = 'WORKING' THEN
    IF NEW."number" IS NOT NULL OR NEW."previousId" IS NOT NULL OR NEW."coversFrom" IS NOT NULL OR NEW."coversTo" IS NOT NULL
       OR NEW."effectiveFrom" IS NOT NULL OR NEW."publishedAt" IS NOT NULL OR NEW."publishedById" IS NOT NULL THEN
      RAISE EXCEPTION 'production: plan % is the working plan of its site; it has no number, range or publication (P3)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."number" IS NULL OR NEW."number" < 1
     OR (NEW."coversFrom" IS NULL) <> (NEW."coversTo" IS NULL) OR NEW."coversFrom" > NEW."coversTo"
     OR (NEW."publishedAt" IS NULL) <> (NEW."publishedById" IS NULL)
     OR (NEW."publishedAt" IS NOT NULL AND (NEW."coversFrom" IS NULL OR NEW."effectiveFrom" IS NULL)) THEN
    RAISE EXCEPTION 'production: plan version % has a number from 1, a range from ≤ to (both or neither), and once published who published it, its range and when the floor starts working to it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT max(v."number") INTO highest FROM "PlanVersion" v
     WHERE v."tenantId" = NEW."tenantId" AND v."siteId" = NEW."siteId" AND v."kind" = 'PUBLISHED' AND v."id" <> NEW."id";
    IF highest IS NOT NULL AND NEW."number" <= highest THEN
      RAISE EXCEPTION 'production: plan version % is v%; the site''s versions go up (v% exists)', NEW."id", NEW."number", highest
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."previousId" IS NOT NULL THEN
      SELECT v."kind"::text AS kind, v."number", v."publishedAt" INTO previous
        FROM "PlanVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."siteId" = NEW."siteId" AND v."id" = NEW."previousId";
      IF FOUND AND (previous.kind <> 'PUBLISHED' OR previous."publishedAt" IS NULL OR previous."number" >= NEW."number") THEN
        RAISE EXCEPTION 'production: plan version % follows plan %, a published version of its site with a lower number', NEW."id", NEW."previousId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PlanVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PlanVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_plan_version_guard"();
CREATE TRIGGER "PlanVersion_no_truncate" BEFORE TRUNCATE ON "PlanVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();

-- One working plan per site.
CREATE UNIQUE INDEX "PlanVersion_one_working" ON "PlanVersion" ("tenantId", "siteId") WHERE "kind" = 'WORKING';

-- A published version is complete by the end of the transaction that made it: publishedAt set (its slots are in by then).
CREATE FUNCTION "factory_plan_version_published"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PlanVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."id" AND v."publishedAt" IS NULL) THEN
    RAISE EXCEPTION 'production: plan version % (v%) is made and published in one transaction: its publishedAt is set when its slots are in', NEW."id", NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "PlanVersion_published" AFTER INSERT ON "PlanVersion"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."kind" = 'PUBLISHED')
  EXECUTE FUNCTION "factory_plan_version_published"();

-- ---------------------------------------------------------------------------------------------------------------------
-- ScheduleSlot (PLN-129, PLN-131, PLN-147, PLN-160)
--   every row  exactly one lane (a line, a work centre or a workshop); it ends after it starts; garments from 1 (when
--              named); standard minutes from 0; a kept-over reason that is not blank (when named).
--   working    (a slot of the WORKING plan) placed for a work order that is not CLOSED or CANCELLED; its lane, when set
--              or changed, an ACTIVE line or work centre of the site, or an ACTIVE party with the SUBCONTRACTOR role. An
--              UPDATE that changes nothing passes; its plan, work order, operation and creation never change (a move
--              changes the lane, the times, the garments, the minutes and the notes). Removed freely (back to the tray).
--   published  (a slot of a PUBLISHED version) inserted only while its version is not published yet (the publish
--              command copies the working plan into it); then never changed and never removed.
--   TRUNCATE   refused.
CREATE FUNCTION "factory_schedule_slot_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  moves CONSTANT text[] := ARRAY['lineId', 'workCentreId', 'partyId', 'startAt', 'endAt', 'pieces', 'minutes', 'overloadReason', 'note',
    'version', 'updatedAt', 'updatedById'];
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

CREATE TRIGGER "ScheduleSlot_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ScheduleSlot"
  FOR EACH ROW EXECUTE FUNCTION "factory_schedule_slot_guard"();
CREATE TRIGGER "ScheduleSlot_no_truncate" BEFORE TRUNCATE ON "ScheduleSlot"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();
