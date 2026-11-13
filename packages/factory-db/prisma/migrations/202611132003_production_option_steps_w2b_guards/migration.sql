-- Written by hand (Prisma does not model triggers), with no schema folder of its own, before the policy migration. When
-- the migrations are renumbered, keep this file as it is under its new timestamp.

-- B-W2b-F40 — a work order is released with the routing steps its cells are for (PRD-128; design products.styles ›
-- Operations (routing) "Only for sizes, colours or options"; CF1:03 an option-only step applies only when a cell chose
-- that option). B-W2b-225 gave a routing step the cells it is for (RoutingOperation.appliesToSizes,
-- appliesToColourwayIds, appliesToOptionValueIds: empty = every one) and B-W2b-340 gave a cell the option values chosen on
-- its order line (WorkOrderSize.optionValueIds): the release copies a step when one of the work order's cells is for it
-- (factory-domain product/routing-depth `stepIsFor` / `stepsForCells`, apps/factory-api production/work-orders
-- routing-copy.ts) and leaves the others out. This guard still asked for every step of the revision, so a release whose
-- cells skip a step (an option none chose, a size or colourway none has) failed here: a 500. The API checks it first; this
-- rule holds for every login, the owner included. Every refusal is a check_violation (SQLSTATE 23514).
--
-- It redefines one function of an earlier hand-written migration (its trigger stays):
--   "factory_work_order_guard" (202610316301_floor_work_w2b_guards): at DRAFT → RELEASED a work order other than a
--                              repair has an operation for every routing step one of its cells is for, as stepIsFor
--                              reads it: a step with no sizes, colourways or options (every cell) always; a step only
--                              for some when a cell is of one of its sizes (if it names any), one of its colourways (if
--                              it names any) and chose one of its option values (if it names any). A step none of its
--                              cells is for may be left out. A repair keeps at least one operation, as before. The
--                              rest of the body is unchanged, word for word.

-- =====================================================================================================================
-- WorkOrder: factory_work_order_guard of …_floor_work_w2b_guards, redefined whole. The change, marked "B-W2b-F40" below:
--   unmapped   counts only the routing steps one of the work order's cells is for (the release's stepIsFor).
CREATE OR REPLACE FUNCTION "factory_work_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  -- W2b: rush moves with the priority.
  progress CONSTANT text[] := ARRAY['status', 'dueDate', 'priority', 'rush', 'note', 'startedAt', 'completedAt', 'closedAt', 'cancelledAt',
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
  parent record;
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
    -- W2b (MES-010): a split's parent is another work order of the same style and kind, still open.
    IF NEW."splitFromId" IS NOT NULL THEN
      SELECT w."styleId", w."kind"::text AS kind, w."status"::text AS status INTO parent
        FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."splitFromId";
      IF NEW."splitFromId" = NEW."id" OR (FOUND AND (parent."styleId" <> NEW."styleId" OR parent.kind <> NEW."kind"::text)) THEN
        RAISE EXCEPTION 'production: work order % is split from another work order of the same style and kind (MES-010)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF FOUND AND parent.status IN ('CANCELLED', 'CLOSED', 'COMPLETED') THEN
        RAISE EXCEPTION 'production: work order % is %; nothing is split from it', NEW."splitFromId", parent.status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    -- W2b: the split it came from never changes either.
    IF (NEW."id", NEW."companyId", NEW."number", NEW."kind", NEW."styleId", NEW."splitFromId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."number", OLD."kind", OLD."styleId", OLD."splitFromId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: the company, number, kind, style, split and creation of work order % never change', OLD."id"
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
      -- B-W2b-F40: only the steps one of its cells is for (factory-domain product/routing-depth stepIsFor): a step for
      -- every cell, or one only for some sizes, colourways or options when a cell is of them; the others may be left out.
      SELECT count(*) INTO unmapped
        FROM "RoutingOperation" ro
       WHERE ro."tenantId" = NEW."tenantId" AND ro."revisionId" = NEW."styleRevisionId"
         AND EXISTS (SELECT 1 FROM "WorkOrderSize" c
                      WHERE c."tenantId" = NEW."tenantId" AND c."workOrderId" = NEW."id"
                        AND (cardinality(coalesce(ro."appliesToSizes", '{}'::text[])) = 0 OR c."size" = ANY (ro."appliesToSizes"))
                        AND (cardinality(coalesce(ro."appliesToColourwayIds", '{}'::uuid[])) = 0 OR c."colourwayId" = ANY (ro."appliesToColourwayIds"))
                        AND (cardinality(coalesce(ro."appliesToOptionValueIds", '{}'::uuid[])) = 0
                             OR coalesce(c."optionValueIds", '{}'::uuid[]) && ro."appliesToOptionValueIds"))
         AND NOT EXISTS (SELECT 1 FROM "WorkOrderOperation" o
                          WHERE o."tenantId" = NEW."tenantId" AND o."workOrderId" = NEW."id" AND o."routingSeq" = ro."seq");
      IF operations = 0 OR (NEW."kind" <> 'REPAIR' AND unmapped > 0) THEN
        RAISE EXCEPTION 'production: work order % is released with every step of its revision''s routing as an operation at a work centre of its site (% step(s) missing), but a step only for sizes, colourways or options none of its cells has; a repair with at least one', NEW."id", unmapped
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

