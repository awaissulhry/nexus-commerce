-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202610283800_production_work_orders and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- Production (plan A1 §2.1 "Append-only", §2.5 "Work order", "Operation scan", §3.8; PLAN §2.8 "Limits on monitoring
-- workers", §4.7 stages 10-work-order, 11b-cut, 12-scans; features MES-005, MES-007, MES-056, MES-065, MES-068,
-- MES-069, MES-073, MES-076, MES-090, MES-095, MES-096, MES-278, PLT-208; Statuto dei Lavoratori, L. 300/1970, art. 4).
-- apps/factory-api's modules/production checks all of this first; these rules hold for every login, the owner included.
-- The tenant and site of a row are held by the policies (USING and WITH CHECK) and by the references, not here: the
-- triggers leave "tenantId" and "siteId" to them. Every refusal is a check_violation (SQLSTATE 23514): a
-- restrict_violation reaches a Prisma model call as P2003 without its message. A rule that reads another row skips a
-- row this session cannot see (another tenant's or site's): the policies refuse that write anyway. A trigger reads only
-- tables (and columns) the role that fires it may read, and locks a row FOR SHARE only where that role may update it.
--
-- "Everything but these columns" is compared as jsonb (to_jsonb(row) minus the named keys), so a column added later is
-- frozen too unless a later migration names it.

CREATE FUNCTION "factory_production_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'production: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- Who a floor record names (Statuto dei Lavoratori art. 4; PLAN §2.8; MES-278, PLT-208; Q16 OPEN). A site whose floor
-- rules record the STATION names its station and no worker; any other site (WORKER, the default, also without a row)
-- names the signed-in worker, and only a worker who has acknowledged the information notice (art. 4 c.3: the workers
-- are told what the tools record before anything is recorded; GDPR art. 13). Called by the cut log and scan triggers
-- for a row inside the session's scope.
CREATE FUNCTION "factory_production_check_subject"(tenant uuid, site uuid, worker uuid, station uuid, what text, row_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  subject text;
BEGIN
  SELECT s."scanSubject"::text INTO subject FROM "ProductionSettings" s WHERE s."tenantId" = tenant AND s."siteId" = site AND s."id" = site;
  IF coalesce(subject, 'WORKER') = 'STATION' THEN
    IF worker IS NOT NULL OR station IS NULL THEN
      RAISE EXCEPTION 'production: site % records the station, not the worker (the monitoring switch, MES-278; Statuto dei Lavoratori art. 4); % % names its station and no worker', site, what, row_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF worker IS NULL THEN
      RAISE EXCEPTION 'production: site % records the worker; % % names the signed-in worker', site, what, row_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "WorkerNoticeAck" a WHERE a."tenantId" = tenant AND a."siteId" = site AND a."workerId" = worker) THEN
      RAISE EXCEPTION 'production: worker % has not acknowledged the information notice; no % names a worker before that (Statuto dei Lavoratori art. 4 c.3, GDPR art. 13)', worker, what
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- ProductionSettings (B-W1-37, SCR-074, MES-278)
--   UPDATE     an UPDATE that changes nothing passes; the company and creation never change.
--   every row  the legal basis, its reference and when it was recorded go together (all or none).
--   DELETE     refused (the rules are changed, never removed). TRUNCATE refused.
CREATE FUNCTION "factory_production_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: the floor rules % are changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: the company and creation of the floor rules % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."monitoringBasis" IS NULL) <> (NEW."monitoringRecordedAt" IS NULL)
     OR (NEW."monitoringBasis" IS NULL) <> (btrim(coalesce(NEW."monitoringReference", '')) = '') THEN
    RAISE EXCEPTION 'production: the floor rules % record a legal basis with its reference and time, or none of them (MES-278)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ProductionSettings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ProductionSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_production_settings_guard"();
CREATE TRIGGER "ProductionSettings_no_truncate" BEFORE TRUNCATE ON "ProductionSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- WorkOrder (MES-005, MES-007, MES-076; A1 §2.5)
--   INSERT     a work order starts as DRAFT.
--   UPDATE     an UPDATE that changes nothing passes; the company, number, kind, style and creation never change; the
--              status moves DRAFT → RELEASED | CANCELLED, RELEASED → IN_PROGRESS | CANCELLED, IN_PROGRESS → COMPLETED |
--              CANCELLED, COMPLETED → CLOSED; CLOSED and CANCELLED are final (only the note changes). From RELEASED on
--              the frozen specification never changes: the revision, the label template, the batch number and the
--              release (only the status and its times, the due date, priority and note do).
--   release    (DRAFT → RELEASED) the revision is a RELEASED revision of its style; the label template is that
--              revision's (ACTIVE, when it has one); it has a batch number; it has cells (a made-to-measure work order
--              exactly one, of quantity 1, with the measurement profile; a size grid none with one); every step of the
--              revision's routing is one of its operations.
--   every row  released (time and batch number) exactly from RELEASED on (a work order cancelled after its release
--              keeps them); started from IN_PROGRESS on, completed from COMPLETED on, closed exactly when CLOSED;
--              CANCELLED exactly with its time and reason.
--   DELETE     refused (a work order is cancelled). TRUNCATE refused.
-- The cells, operations and planned materials change only while the work order is DRAFT (their triggers, which lock
-- its row FOR SHARE, so a release waits for the transaction that edits them, and an edit after it sees it released).
CREATE FUNCTION "factory_work_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  progress CONSTANT text[] := ARRAY['status', 'dueDate', 'priority', 'note', 'startedAt', 'completedAt', 'closedAt', 'cancelledAt',
    'cancelReason', 'version', 'updatedAt'];
  revision_state text;
  revision_label uuid;
  label_state text;
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
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('RELEASED', 'CANCELLED'))
                OR (OLD."status" = 'RELEASED' AND NEW."status" IN ('IN_PROGRESS', 'CANCELLED'))
                OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('COMPLETED', 'CANCELLED'))
                OR (OLD."status" = 'COMPLETED' AND NEW."status" = 'CLOSED')) THEN
      RAISE EXCEPTION 'production: work order % cannot move from % to %', OLD."id", OLD."status", NEW."status"
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
      SELECT count(*), count(*) FILTER (WHERE (c."measurementProfileId" IS NOT NULL) <> (NEW."kind" = 'MADE_TO_MEASURE')
                                          OR (NEW."kind" = 'MADE_TO_MEASURE' AND c."quantity" <> 1))
        INTO cells, wrong_cells
        FROM "WorkOrderSize" c WHERE c."tenantId" = NEW."tenantId" AND c."workOrderId" = NEW."id";
      IF cells = 0 OR wrong_cells > 0 OR (NEW."kind" = 'MADE_TO_MEASURE' AND cells <> 1) THEN
        RAISE EXCEPTION 'production: work order % is released with its cells: a size grid without measurement profiles, or one made-to-measure unit of quantity 1 with its profile', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*) INTO operations FROM "WorkOrderOperation" o WHERE o."tenantId" = NEW."tenantId" AND o."workOrderId" = NEW."id";
      SELECT count(*) INTO unmapped
        FROM "RoutingOperation" ro
       WHERE ro."tenantId" = NEW."tenantId" AND ro."revisionId" = NEW."styleRevisionId"
         AND NOT EXISTS (SELECT 1 FROM "WorkOrderOperation" o
                          WHERE o."tenantId" = NEW."tenantId" AND o."workOrderId" = NEW."id" AND o."routingSeq" = ro."seq");
      IF operations = 0 OR unmapped > 0 THEN
        RAISE EXCEPTION 'production: work order % is released with every step of its revision''s routing as an operation at a work centre of its site (% step(s) missing)', NEW."id", unmapped
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF btrim(NEW."number") = '' OR (NEW."batchNumber" IS NOT NULL AND btrim(NEW."batchNumber") = '') THEN
    RAISE EXCEPTION 'production: work order % has a number, and a batch number that is not blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED') AND NEW."releasedAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND (NEW."releasedAt" IS NOT NULL OR NEW."releasedById" IS NOT NULL))
     OR (NEW."releasedAt" IS NULL) <> (NEW."batchNumber" IS NULL)
     OR (NEW."releasedAt" IS NOT NULL AND NEW."styleRevisionId" IS NULL) THEN
    RAISE EXCEPTION 'production: work order % is % with the wrong release: its release time, revision and batch number (MES-076) are set exactly from RELEASED on', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('IN_PROGRESS', 'COMPLETED', 'CLOSED') AND NEW."startedAt" IS NULL)
     OR (NEW."status" IN ('DRAFT', 'RELEASED') AND NEW."startedAt" IS NOT NULL)
     OR (NEW."status" IN ('COMPLETED', 'CLOSED')) <> (NEW."completedAt" IS NOT NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) THEN
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

CREATE TRIGGER "WorkOrder_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_guard"();
CREATE TRIGGER "WorkOrder_no_truncate" BEFORE TRUNCATE ON "WorkOrder"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();

-- WorkOrderSize (MES-002, MES-003; the frozen size quantities)
--   INSERT, UPDATE, DELETE  only while the work order is DRAFT (its row locked FOR SHARE); a cell never moves to another
--                           work order. An UPDATE that changes nothing passes.
--   every row               at least one piece; it makes its sales order line: the line's style and colourway, of the
--                           work order's kind, with the line's measurement profile; a made-to-measure cell is one unit
--                           with the profile, a size-grid cell has none.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_work_order_size_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF order_kind IS NOT NULL
     AND ((order_kind = 'MADE_TO_MEASURE') <> (NEW."measurementProfileId" IS NOT NULL)
          OR (order_kind = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1)) THEN
    RAISE EXCEPTION 'production: work order cell % is one made-to-measure unit with its measurement profile, or a size-grid cell without one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."styleId", l."colourwayId", l."kind"::text AS kind, l."measurementProfileId" INTO line
    FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
  IF FOUND
     AND ((line."styleId", line."colourwayId", line."measurementProfileId") IS DISTINCT FROM (NEW."styleId", NEW."colourwayId", NEW."measurementProfileId")
          OR (order_kind IS NOT NULL AND line.kind <> order_kind)) THEN
    RAISE EXCEPTION 'production: work order cell % makes its sales order line %: the same style, colourway, kind and measurement profile', NEW."id", NEW."salesOrderLineId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkOrderSize_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkOrderSize"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_size_guard"();
CREATE TRIGGER "WorkOrderSize_no_truncate" BEFORE TRUNCATE ON "WorkOrderSize"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();

-- WorkOrderOperation (the routing of the frozen spec mapped to the site)
--   INSERT, DELETE  only while the work order is DRAFT (its row locked FOR SHARE).
--   UPDATE          an UPDATE that changes nothing passes; an operation never moves to another work order; after
--                   DRAFT only its work centre changes.
--   every row       a copy of its revision's routing step (code, name, standard minutes, scan required), at a work centre
--                   of the work order's site of the step's kind, with a place from 1.
--   TRUNCATE        refused.
CREATE FUNCTION "factory_work_order_operation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  state text;
  part_of uuid;
  step record;
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
  IF TG_OP = 'INSERT' THEN
    part_of := NEW."workOrderId";
    SELECT w."status"::text INTO state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId" FOR SHARE;
  ELSE
    part_of := OLD."workOrderId";
    SELECT w."status"::text INTO state FROM "WorkOrder" w WHERE w."tenantId" = OLD."tenantId" AND w."id" = OLD."workOrderId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT'
     AND (TG_OP <> 'UPDATE'
          OR (to_jsonb(NEW) - (kept || ARRAY['workCentreId', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['workCentreId', 'version', 'updatedAt']))) THEN
    RAISE EXCEPTION 'production: work order % is %; its operations are frozen (MES-005), only their work centre changes (another of the same kind)', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'production: work order operation % has a place from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT ro."code", ro."name", ro."standardMinutes", ro."scanRequired", ro."workCentreKind"::text AS kind INTO step
    FROM "RoutingOperation" ro WHERE ro."tenantId" = NEW."tenantId" AND ro."revisionId" = NEW."styleRevisionId" AND ro."seq" = NEW."routingSeq";
  IF FOUND THEN
    IF (step."code", step."name", step."standardMinutes", step."scanRequired") IS DISTINCT FROM (NEW."code", NEW."name", NEW."standardMinutes", NEW."scanRequired") THEN
      RAISE EXCEPTION 'production: work order operation % is a copy of routing step % of revision % (code, name, standard minutes, scan required)', NEW."id", NEW."routingSeq", NEW."styleRevisionId"
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

CREATE TRIGGER "WorkOrderOperation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkOrderOperation"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_operation_guard"();
CREATE TRIGGER "WorkOrderOperation_no_truncate" BEFORE TRUNCATE ON "WorkOrderOperation"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();

-- WorkOrderMaterial (the planned materials of the frozen spec)
--   INSERT, UPDATE, DELETE  only while the work order is DRAFT (its row locked FOR SHARE); a line never moves to another
--                           work order. An UPDATE that changes nothing passes.
--   every row               a quantity above 0 in both units; in the item's base unit the two are equal.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_work_order_material_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
  base_uom text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."workOrderId" <> OLD."workOrderId" THEN
      RAISE EXCEPTION 'production: planned material % never moves to another work order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    part_of := NEW."workOrderId";
    SELECT w."status"::text INTO state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId" FOR SHARE;
  ELSE
    part_of := OLD."workOrderId";
    SELECT w."status"::text INTO state FROM "WorkOrder" w WHERE w."tenantId" = OLD."tenantId" AND w."id" = OLD."workOrderId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'production: work order % is %; its planned materials are frozen (MES-005), they change only while it is DRAFT', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" <= 0 OR NEW."baseQuantity" <= 0 THEN
    RAISE EXCEPTION 'production: planned material % has a quantity above 0 in both units', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."baseUom"::text INTO base_uom FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
  IF FOUND AND NEW."uom"::text = base_uom AND NEW."quantity" <> NEW."baseQuantity" THEN
    RAISE EXCEPTION 'production: planned material % is in the base unit %; its quantity is its base quantity', NEW."id", base_uom
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkOrderMaterial_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkOrderMaterial"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_material_guard"();
CREATE TRIGGER "WorkOrderMaterial_no_truncate" BEFORE TRUNCATE ON "WorkOrderMaterial"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- CutLog, CutLogPiece, OperationScan, WorkerNoticeAck: append-only (plan A1 §2.1; scripts/factory/check-append-only.mjs).
-- The floor's ledgers: no login may change or remove a row, the owner and superusers included; the runtime roles have
-- no UPDATE, DELETE or TRUNCATE grant either (the policy migration). A mistake is a new row: a reversed cut log entry,
-- an undone or corrected scan, a new acknowledgement.
CREATE FUNCTION "factory_refuse_production_ledger_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a mistake is fixed with a new row (a reversal, an undo or a correction)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "CutLog_append_only" BEFORE UPDATE OR DELETE ON "CutLog"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "CutLog_no_truncate" BEFORE TRUNCATE ON "CutLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "CutLogPiece_append_only" BEFORE UPDATE OR DELETE ON "CutLogPiece"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "CutLogPiece_no_truncate" BEFORE TRUNCATE ON "CutLogPiece"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "OperationScan_append_only" BEFORE UPDATE OR DELETE ON "OperationScan"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "OperationScan_no_truncate" BEFORE TRUNCATE ON "OperationScan"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "WorkerNoticeAck_append_only" BEFORE UPDATE OR DELETE ON "WorkerNoticeAck"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "WorkerNoticeAck_no_truncate" BEFORE TRUNCATE ON "WorkerNoticeAck"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_production_ledger_change"();

-- WorkerNoticeAck, INSERT (PLT-208, SCR-025; Statuto dei Lavoratori art. 4 c.3; GDPR art. 13)
--   an ACTIVE worker; a version, a language (ISO 639-1) and the SHA-256 of the text as shown; on a DEVICE exactly with
--   the device (and its clock), on PAPER with neither. One per worker and version (the unique key).
CREATE FUNCTION "factory_worker_notice_ack_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  worker_status text;
BEGIN
  SELECT w."status"::text INTO worker_status FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workerId";
  IF FOUND AND worker_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'production: worker % is %; only an ACTIVE worker acknowledges the notice', NEW."workerId", worker_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."noticeVersion") = '' OR NEW."locale" !~ '^[a-z]{2}$' OR NEW."noticeSha256" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'production: notice acknowledgement % names the version, the language (ISO 639-1) and the SHA-256 of the text as shown', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."channel" = 'DEVICE') <> (NEW."deviceId" IS NOT NULL) OR (NEW."channel" = 'PAPER' AND NEW."deviceTime" IS NOT NULL) THEN
    RAISE EXCEPTION 'production: notice acknowledgement % names its device exactly when it was given on one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkerNoticeAck_check" BEFORE INSERT ON "WorkerNoticeAck"
  FOR EACH ROW EXECUTE FUNCTION "factory_worker_notice_ack_check"();

-- CutLog, INSERT (MES-056, SCR-094; REACH Annex XVII entry 47; SCM-194)
--   work order  RELEASED or IN_PROGRESS.
--   subject     the signed-in worker who acknowledged the notice, or the station (factory_production_check_subject).
--   areas       in an area unit (M2, DM2, FT2): the area used above 0, the remnant from 0, in both units; in the hide's
--               item's base unit the two are equal. A client event id that is not blank.
--   hide        of a RELEASED lot (untested or failed leather is never cut) and neither CONSUMED nor SCRAPPED.
--   area        what the hide's cuts for the work order used, this one included, stays within the area of the hide at
--               the work order: its ISSUE moves to it minus its RETURN moves from it, in the stock ledger (a reversal
--               counts the other way, as the ledger's direction says). Read under a transaction lock per hide, so two
--               cuts of one hide wait for each other. The lock does not cover a RETURN of the hide posted at the same
--               time (the stock trigger locks per location): modules/production posts a remnant's RETURN after the cut
--               log entry, in the same command.
--   reversal    a reversal mirrors its entry (work order, hide, unit and areas), is never itself reversed, and an entry
--               has at most one (the partial unique index below); it carries no pieces and is not checked against the
--               area (it gives area back).
CREATE FUNCTION "factory_cut_log_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
  hide record;
  original record;
  at_order numeric;
  cut numeric;
BEGIN
  SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF NOT FOUND THEN
    -- Outside this session's scope: the policies refuse the row.
    RETURN NEW;
  END IF;
  IF order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'production: work order % is %; hides are cut only for a RELEASED or IN_PROGRESS work order', NEW."workOrderId", order_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."areaUsed" <= 0 OR NEW."baseAreaUsed" <= 0 OR NEW."remnantArea" < 0 OR NEW."baseRemnantArea" < 0
     OR NEW."uom" NOT IN ('M2', 'DM2', 'FT2') OR btrim(NEW."clientEventId") = '' THEN
    RAISE EXCEPTION 'production: cut log entry % uses an area above 0 and leaves a remnant from 0, in M2, DM2 or FT2 (and in the base unit), with its client event id', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM "factory_production_check_subject"(NEW."tenantId", NEW."siteId", NEW."workerId", NEW."stationId", 'cut log entry', NEW."id");

  SELECT h."state"::text AS state, h."itemId", l."qualityStatus"::text AS quality, i."baseUom"::text AS base_uom INTO hide
    FROM "Hide" h
    JOIN "Lot" l ON l."tenantId" = h."tenantId" AND l."siteId" = h."siteId" AND l."id" = h."lotId"
    JOIN "Item" i ON i."tenantId" = h."tenantId" AND i."id" = h."itemId"
   WHERE h."tenantId" = NEW."tenantId" AND h."siteId" = NEW."siteId" AND h."id" = NEW."hideId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW."uom"::text = hide.base_uom AND (NEW."areaUsed" <> NEW."baseAreaUsed" OR NEW."remnantArea" <> NEW."baseRemnantArea") THEN
    RAISE EXCEPTION 'production: cut log entry % is entered in the base unit %; its areas are its base areas', NEW."id", hide.base_uom
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.hide-cut', NEW."tenantId", NEW."siteId", NEW."hideId"), 0));

  IF NEW."reversalOfId" IS NOT NULL THEN
    SELECT c."workOrderId", c."hideId", c."uom"::text AS uom, c."areaUsed", c."baseAreaUsed", c."remnantArea", c."baseRemnantArea", c."reversalOfId"
      INTO original
      FROM "CutLog" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."reversalOfId";
    IF FOUND THEN
      IF (original."workOrderId", original."hideId", original.uom, original."areaUsed", original."baseAreaUsed", original."remnantArea", original."baseRemnantArea")
         IS DISTINCT FROM
         (NEW."workOrderId", NEW."hideId", NEW."uom"::text, NEW."areaUsed", NEW."baseAreaUsed", NEW."remnantArea", NEW."baseRemnantArea") THEN
        RAISE EXCEPTION 'production: cut log entry % reverses entry %: the same work order, hide, unit and areas', NEW."id", NEW."reversalOfId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF original."reversalOfId" IS NOT NULL THEN
        RAISE EXCEPTION 'production: cut log entry % is itself a reversal; it is not reversed (log the cut again instead)', NEW."reversalOfId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "CutLog" r WHERE r."tenantId" = NEW."tenantId" AND r."siteId" = NEW."siteId" AND r."reversalOfId" = NEW."reversalOfId") THEN
        RAISE EXCEPTION 'production: cut log entry % is reversed already', NEW."reversalOfId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF hide.quality <> 'RELEASED' THEN
    RAISE EXCEPTION 'production: hide % is of a lot that is %; only RELEASED leather is cut (REACH Annex XVII entry 47: Cr VI)', NEW."hideId", hide.quality
      USING ERRCODE = 'check_violation';
  END IF;
  IF hide.state IN ('CONSUMED', 'SCRAPPED') THEN
    RAISE EXCEPTION 'production: hide % is %; it is not cut', NEW."hideId", hide.state
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(CASE WHEN m."fromLocationId" IS NOT NULL AND m."toLocationId" IS NULL THEN m."baseQuantity"
                           WHEN m."fromLocationId" IS NULL AND m."toLocationId" IS NOT NULL THEN -m."baseQuantity"
                           ELSE 0 END), 0)
    INTO at_order
    FROM "StockMove" m
   WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."itemId" = hide."itemId" AND m."lotId" = NEW."lotId"
     AND m."hideId" = NEW."hideId" AND m."workOrderId" = NEW."workOrderId" AND m."reason" IN ('ISSUE', 'RETURN');
  SELECT coalesce(sum(CASE WHEN c."reversalOfId" IS NULL THEN c."baseAreaUsed" ELSE -c."baseAreaUsed" END), 0)
    INTO cut
    FROM "CutLog" c
   WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."hideId" = NEW."hideId" AND c."workOrderId" = NEW."workOrderId";
  IF cut + NEW."baseAreaUsed" > at_order THEN
    RAISE EXCEPTION 'production: hide % has % (base unit) at work order % (issued minus returned, in the stock ledger) and % of it was cut; a cut of % does not fit', NEW."hideId", at_order, NEW."workOrderId", cut, NEW."baseAreaUsed"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CutLog_check" BEFORE INSERT ON "CutLog"
  FOR EACH ROW EXECUTE FUNCTION "factory_cut_log_check"();

-- At most one reversal per cut log entry.
CREATE UNIQUE INDEX "CutLog_one_reversal" ON "CutLog" ("tenantId", "reversalOfId") WHERE "reversalOfId" IS NOT NULL;

-- CutLogPiece, INSERT
--   at least one piece of a named part, for an entry that is neither a reversal nor reversed.
CREATE FUNCTION "factory_cut_log_piece_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reverses uuid;
BEGIN
  IF NEW."pieces" < 1 OR btrim(NEW."part") = '' THEN
    RAISE EXCEPTION 'production: cut piece row % has at least one piece of a named part', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c."reversalOfId" INTO reverses FROM "CutLog" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."cutLogId";
  IF FOUND AND (reverses IS NOT NULL
                OR EXISTS (SELECT 1 FROM "CutLog" r WHERE r."tenantId" = NEW."tenantId" AND r."siteId" = NEW."siteId" AND r."reversalOfId" = NEW."cutLogId")) THEN
    RAISE EXCEPTION 'production: cut log entry % is a reversal or reversed; it takes no pieces', NEW."cutLogId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CutLogPiece_check" BEFORE INSERT ON "CutLogPiece"
  FOR EACH ROW EXECUTE FUNCTION "factory_cut_log_piece_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Bundle (MES-065, MES-068, MES-073)
--   INSERT     ACTIVE, with its first ticket (no replaced code), for a RELEASED or IN_PROGRESS work order; at least one
--              garment, exactly one for a made-to-measure unit (single-piece mode); its cut log entries are entries of
--              its work order, neither reversals nor named twice.
--   UPDATE     an UPDATE that changes nothing passes; only a reprint (a new code; the old one appended to the replaced
--              codes, MES-073) of an ACTIVE bundle, or ACTIVE → VOID with its time and reason; a VOID bundle never
--              changes.
--   every row  VOID exactly with its time and reason.
--   DELETE     refused (voided). TRUNCATE refused.
CREATE FUNCTION "factory_bundle_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  changing CONSTANT text[] := ARRAY['code', 'replacedCodes', 'status', 'voidedAt', 'voidReason', 'version', 'updatedAt'];
  order_state text;
  order_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: bundle % is voided, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' OR cardinality(NEW."replacedCodes") > 0 THEN
      RAISE EXCEPTION 'production: bundle % starts ACTIVE with its first ticket', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."quantity" < 1 THEN
      RAISE EXCEPTION 'production: bundle % carries at least one garment', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT w."status"::text, w."kind"::text INTO order_state, order_kind
      FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF FOUND THEN
      IF order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
        RAISE EXCEPTION 'production: work order % is %; bundles are made only for a RELEASED or IN_PROGRESS work order', NEW."workOrderId", order_state
          USING ERRCODE = 'check_violation';
      END IF;
      IF order_kind = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1 THEN
        RAISE EXCEPTION 'production: bundle % of made-to-measure work order % is the one garment (single-piece mode, MES-068)', NEW."id", NEW."workOrderId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (SELECT count(DISTINCT x) FROM unnest(NEW."cutLogIds") AS x) <> cardinality(NEW."cutLogIds")
         OR EXISTS (SELECT 1 FROM unnest(NEW."cutLogIds") AS x(id)
                     WHERE NOT EXISTS (SELECT 1 FROM "CutLog" c
                                        WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."workOrderId" = NEW."workOrderId"
                                          AND c."id" = x.id AND c."reversalOfId" IS NULL)) THEN
        RAISE EXCEPTION 'production: bundle % names cut log entries of its work order, each once, none a reversal', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || changing)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || changing)) THEN
      RAISE EXCEPTION 'production: bundle % changes only by a reprint of its ticket or by being voided', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'VOID' THEN
      RAISE EXCEPTION 'production: bundle % is VOID; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."code", NEW."replacedCodes") IS DISTINCT FROM (OLD."code", OLD."replacedCodes")
       AND (NEW."code" = OLD."code" OR NEW."replacedCodes" IS DISTINCT FROM (OLD."replacedCodes" || OLD."code")
            OR NEW."code" = ANY (NEW."replacedCodes") OR NEW."status" <> 'ACTIVE') THEN
      RAISE EXCEPTION 'production: a reprint of bundle % gives its ticket a new code and voids the old one (MES-073)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."code") = '' THEN
    RAISE EXCEPTION 'production: bundle % has a code', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'VOID') <> (NEW."voidedAt" IS NOT NULL)
     OR (NEW."status" = 'VOID') <> (btrim(coalesce(NEW."voidReason", '')) <> '') THEN
    RAISE EXCEPTION 'production: bundle % is % with the wrong void (a VOID bundle has its time and reason)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Bundle_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Bundle"
  FOR EACH ROW EXECUTE FUNCTION "factory_bundle_guard"();
CREATE TRIGGER "Bundle_no_truncate" BEFORE TRUNCATE ON "Bundle"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();

-- OperationScan, INSERT (MES-069, MES-090, MES-095, MES-096; A1 §2.5 "Operation scan")
--   work order  RELEASED or IN_PROGRESS (a scan for one that moved on while the device was offline is refused here and
--               kept in the floor's rejection queue, A1 §3.8).
--   counts      from 0; REPORT and CORRECTION from 1 up to the bundle's garments together, UNDO none. A client scan id
--               that is not blank (unique per device: a resent scan is applied once).
--   REPORT      names no scan; its bundle is ACTIVE; its subject is the signed-in worker who acknowledged the notice, or
--               the station (factory_production_check_subject); the bundle has no standing report at the operation
--               (MES-069): a REPORT or CORRECTION no later UNDO or CORRECTION names. Read under a transaction lock per
--               bundle and operation, so two devices reporting the same bundle at once wait for each other and the
--               second is refused.
--   UNDO        names the standing scan it undoes (MES-095): a REPORT or CORRECTION of the same bundle, operation,
--   CORRECTION  worker and station, not voided yet; a CORRECTION also says why and who approved it (MES-096). At most
--               one row names a scan (also the partial unique index below).
CREATE FUNCTION "factory_operation_scan_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
  bundle record;
  target record;
  standing record;
BEGIN
  SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF NOT FOUND THEN
    -- Outside this session's scope: the policies refuse the row.
    RETURN NEW;
  END IF;
  IF order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'production: work order % is %; scans are taken only while it is RELEASED or IN_PROGRESS', NEW."workOrderId", order_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."goodQuantity" < 0 OR NEW."scrapQuantity" < 0 OR NEW."reworkQuantity" < 0 OR btrim(NEW."clientScanId") = '' THEN
    RAISE EXCEPTION 'production: scan % has counts from 0 and a client scan id', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'REPORT') <> (NEW."correctsId" IS NULL) THEN
    RAISE EXCEPTION 'production: scan % is a %; an UNDO or a CORRECTION, and only they, name the scan they void', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'CORRECTION' AND (btrim(coalesce(NEW."reason", '')) = '' OR NEW."approvedById" IS NULL) THEN
    RAISE EXCEPTION 'production: correction % says why and who approved it (MES-096)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT b."quantity", b."status"::text AS status INTO bundle
    FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."id" = NEW."bundleId";
  IF FOUND THEN
    IF NEW."kind" = 'UNDO' AND NEW."goodQuantity" + NEW."scrapQuantity" + NEW."reworkQuantity" <> 0 THEN
      RAISE EXCEPTION 'production: undo % carries no counts', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" <> 'UNDO' AND NEW."goodQuantity" + NEW."scrapQuantity" + NEW."reworkQuantity" NOT BETWEEN 1 AND bundle."quantity" THEN
      RAISE EXCEPTION 'production: scan % reports from 1 to the % garment(s) of bundle % (good, scrap and rework together)', NEW."id", bundle."quantity", NEW."bundleId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'REPORT' AND bundle.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'production: bundle % is %; it is not scanned', NEW."bundleId", bundle.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.scan', NEW."tenantId", NEW."siteId", NEW."bundleId", NEW."workOrderOperationId"), 0));

  IF NEW."kind" = 'REPORT' THEN
    PERFORM "factory_production_check_subject"(NEW."tenantId", NEW."siteId", NEW."workerId", NEW."stationId", 'scan', NEW."id");
    SELECT s."id", s."workerId", s."stationId", s."serverTime" INTO standing
      FROM "OperationScan" s
     WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."bundleId" = NEW."bundleId"
       AND s."workOrderOperationId" = NEW."workOrderOperationId" AND s."kind" IN ('REPORT', 'CORRECTION')
       AND NOT EXISTS (SELECT 1 FROM "OperationScan" v WHERE v."tenantId" = s."tenantId" AND v."siteId" = s."siteId" AND v."correctsId" = s."id")
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'production: bundle % is reported at operation % already (scan % at %); one scan per bundle per operation (MES-069), undo or correct it instead', NEW."bundleId", NEW."workOrderOperationId", standing."id", standing."serverTime"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT s."kind"::text AS kind, s."bundleId", s."workOrderOperationId", s."workerId", s."stationId" INTO target
      FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."correctsId";
    IF FOUND THEN
      IF target.kind NOT IN ('REPORT', 'CORRECTION') THEN
        RAISE EXCEPTION 'production: % % names scan %, an UNDO; only a report or a correction is undone or corrected', NEW."kind", NEW."id", NEW."correctsId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (target."bundleId", target."workOrderOperationId", target."workerId", target."stationId")
         IS DISTINCT FROM
         (NEW."bundleId", NEW."workOrderOperationId", NEW."workerId", NEW."stationId") THEN
        RAISE EXCEPTION 'production: % % is of the same bundle, operation, worker and station as scan %', NEW."kind", NEW."id", NEW."correctsId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "OperationScan" v WHERE v."tenantId" = NEW."tenantId" AND v."siteId" = NEW."siteId" AND v."correctsId" = NEW."correctsId") THEN
        RAISE EXCEPTION 'production: scan % is undone or corrected already', NEW."correctsId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OperationScan_check" BEFORE INSERT ON "OperationScan"
  FOR EACH ROW EXECUTE FUNCTION "factory_operation_scan_check"();

-- At most one row voids a scan.
CREATE UNIQUE INDEX "OperationScan_one_correction" ON "OperationScan" ("tenantId", "correctsId") WHERE "correctsId" IS NOT NULL;
