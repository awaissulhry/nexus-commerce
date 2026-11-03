-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202610318500_cutting_room_w2b_schema and before the policy migration. When the migrations are renumbered, keep this file as
-- it is under its new timestamp.

-- W2b schema wave 13/16 (B-W2b-85): the cutting room. Cut orders over several work orders and their lines, cut and recut
-- tickets, fabric lays roll by roll with the ply check at both ends, ply stickers, the fabric used, the reconciliation per line
-- (append-only), secondary processes, the trolley to sewing, pattern pieces (frozen with their revision), second quality, the
-- cutting table's checks on the cut log, the repair station's scans on a rework and a recut's ticket (features MES-034,
-- MES-037, MES-038, MES-039, MES-041, MES-043, MES-044, MES-045, MES-046, MES-047, MES-048, MES-053, MES-055, MES-060, MES-063,
-- MES-064, MES-132, MES-133, PRD-219). apps/factory-api's modules check all of this first, in words; these rules hold for
-- every login, the owner included. Every refusal is a check_violation (SQLSTATE 23514).
--
-- As in every guards migration: the tenant and site of a row are held by the policies (USING and WITH CHECK) and the
-- references, not here (no trigger compares "tenantId" or "siteId" of the row it guards, so a row moved out of a session's
-- scope meets row-level security first); a rule that reads another row skips a row this session cannot see (another
-- tenant's or site's: the policies refuse that write anyway); an UPDATE that changes nothing passes. A trigger reads only
-- tables (and columns) the role that fires it may read. "Everything but these columns" is compared as jsonb, so a column
-- added later is frozen too unless a later migration names it. A floor session (current_user factory_floor_runtime) moves a
-- cut order, a ticket and a lay only the way the table moves them, and changes nothing else of them.
--
-- The fabric tables (Lay, LayRoll, PlyRun, a lay's CutConsumption) are read by no rule of the leather path: a factory that
-- cuts no lays leaves them empty.
--
-- REDEFINED, each from its whole latest body (rules and words kept; the triggers stay):
--   factory_rework_order_guard         (202610305001_production_w2a_guards) the repair station's scans: repairInAt with its
--                                      station from IN_PROGRESS on, repairOutAt after it, each set once.
--   factory_replacement_request_guard  (202610305001_production_w2a_guards) a RECUT's recut ticket: given while OPEN, never
--                                      changed, a RECUT ticket of its work order, cell and part that is not VOID.
-- NEW TRIGGERS on tables of earlier waves (no earlier function touched):
--   "CutLog_cutting_rules"             the photo, thickness and overrides of an entry (a reversal has none).
--   "PatternPiece_revision_guard"      uses the …_product_guards part rule (factory_style_revision_part_guard) as is.
-- USED FROM EARLIER WAVES, as they are: "factory_document_number_guard" (…_numbering_floor_documents_guards),
-- "factory_inspection_code_ok" (…_quality_plant_w2a_guards), "factory_work_order_gate" (…_production_w2a_guards),
-- "factory_style_revision_part_guard" (…_product_guards).

CREATE FUNCTION "factory_cutting_w2b_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cutting room: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['CutOrder', 'CutOrderLine', 'CutTicket', 'Lay', 'LayRoll', 'PlyRun', 'CutConsumption', 'SecondaryProcess', 'CutIssue',
                              'CutIssueLine', 'GarmentDowngrade'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_cutting_w2b_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- A list of words: none blank, none twice (NULL: an empty list).
CREATE FUNCTION "factory_cutting_words_ok"(words text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM unnest(coalesce(words, '{}'::text[])) w WHERE btrim(w) = '')
     AND cardinality(coalesce(words, '{}'::text[])) = (SELECT count(DISTINCT w) FROM unnest(coalesce(words, '{}'::text[])) w)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- CutOrder (MES-034)
--   every row  its number (factory_document_number_guard); LEATHER has no marker; FABRIC's marker length above 0 in M, CM or
--              MM (both or neither), its width above 0, and from RELEASED on a name and a length; released (when and by
--              whom) exactly from RELEASED on (kept when CANCELLED, never while PLANNED), cut exactly from CUT on, reconciled
--              (when and by whom) exactly when RECONCILED, cancelled exactly with its time and reason.
--   INSERT     PLANNED, nothing released, cut or reconciled; its material is tracked by HIDE (LEATHER) or LOT (FABRIC).
--   UPDATE     the company, number, kind, material and colour and the creation never change; the marker changes only while
--              PLANNED. The status moves PLANNED → RELEASED (with a line at least) | CANCELLED, RELEASED → IN_PROGRESS | PLANNED
--              (while no ticket was started) | CANCELLED, IN_PROGRESS → CUT (a fabric cut order: every lay CUT or CANCELLED,
--              one at least CUT), CUT → RECONCILED (every line has its reconciliation); RECONCILED and CANCELLED are final
--              (only the note changes). A floor session moves it only RELEASED → IN_PROGRESS and IN_PROGRESS → CUT.
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_cut_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  marker CONSTANT text[] := ARRAY['markerName', 'markerLength', 'markerUom', 'markerWidthCm', 'markerFileId'];
  progress CONSTANT text[] := ARRAY['stationId', 'dueDate', 'status', 'releasedAt', 'releasedById', 'cutAt', 'reconciledAt', 'reconciledById', 'cancelledAt',
                                    'cancelReason', 'note', 'version', 'updatedAt'];
  floor_moves CONSTANT text[] := ARRAY['status', 'cutAt', 'version', 'updatedAt'];
  released boolean;
  item_tracking text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cutting: cut order % is cancelled, never deleted', OLD."number"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PLANNED' OR NEW."releasedAt" IS NOT NULL OR NEW."cutAt" IS NOT NULL OR NEW."reconciledAt" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN
      RAISE EXCEPTION 'cutting: cut order % starts PLANNED, not yet released, cut or reconciled', NEW."number"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."tracking"::text INTO item_tracking FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND item_tracking <> (CASE NEW."kind" WHEN 'LEATHER' THEN 'HIDE' ELSE 'LOT' END) THEN
      RAISE EXCEPTION 'cutting: cut order % is %; its material is tracked by % (item % is tracked by %)', NEW."number", NEW."kind",
        CASE NEW."kind" WHEN 'LEATHER' THEN 'HIDE' ELSE 'LOT (its rolls)' END, NEW."itemId", item_tracking
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || marker || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || marker || progress)) THEN
      RAISE EXCEPTION 'cutting: the company, number, kind, material, colour and creation of cut order % never change', OLD."number"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('RECONCILED', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'cutting: cut order % is %; only its note changes', OLD."number", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'PLANNED' AND (to_jsonb(NEW) -> 'markerName', to_jsonb(NEW) -> 'markerLength', to_jsonb(NEW) -> 'markerUom', to_jsonb(NEW) -> 'markerWidthCm', to_jsonb(NEW) -> 'markerFileId')
                                     IS DISTINCT FROM
                                     (to_jsonb(OLD) -> 'markerName', to_jsonb(OLD) -> 'markerLength', to_jsonb(OLD) -> 'markerUom', to_jsonb(OLD) -> 'markerWidthCm', to_jsonb(OLD) -> 'markerFileId') THEN
      RAISE EXCEPTION 'cutting: cut order % is %; its marker changes only while PLANNED (its tickets carry it)', OLD."number", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'PLANNED' AND NEW."status" IN ('RELEASED', 'CANCELLED'))
                OR (OLD."status" = 'RELEASED' AND NEW."status" IN ('IN_PROGRESS', 'PLANNED', 'CANCELLED'))
                OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'CUT')
                OR (OLD."status" = 'CUT' AND NEW."status" = 'RECONCILED')) THEN
      RAISE EXCEPTION 'cutting: cut order % cannot move from % to %', OLD."number", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime'
       AND ((to_jsonb(NEW) - (kept || floor_moves)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || floor_moves))
            OR (NEW."status" <> OLD."status" AND NOT ((OLD."status" = 'RELEASED' AND NEW."status" = 'IN_PROGRESS') OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'CUT')))) THEN
      RAISE EXCEPTION 'cutting: at the table a cut order only starts (RELEASED → IN_PROGRESS) and is cut (IN_PROGRESS → CUT); the office does the rest (cut order %)', OLD."number"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" THEN
      IF NEW."status" = 'RELEASED' AND OLD."status" = 'PLANNED'
         AND NOT EXISTS (SELECT 1 FROM "CutOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."cutOrderId" = NEW."id") THEN
        RAISE EXCEPTION 'cutting: cut order % has no line; it is released with a work order cell at least', NEW."number"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."status" = 'PLANNED'
         AND EXISTS (SELECT 1 FROM "CutTicket" t WHERE t."tenantId" = NEW."tenantId" AND t."cutOrderId" = NEW."id" AND t."status" IN ('STARTED', 'DONE')) THEN
        RAISE EXCEPTION 'cutting: cut order %: a ticket of it was scanned at a table; it does not go back to PLANNED', NEW."number"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."status" = 'CUT' AND NEW."kind" = 'FABRIC'
         AND (EXISTS (SELECT 1 FROM "Lay" y WHERE y."tenantId" = NEW."tenantId" AND y."cutOrderId" = NEW."id" AND y."status" NOT IN ('CUT', 'CANCELLED'))
              OR NOT EXISTS (SELECT 1 FROM "Lay" y WHERE y."tenantId" = NEW."tenantId" AND y."cutOrderId" = NEW."id" AND y."status" = 'CUT')) THEN
        RAISE EXCEPTION 'cutting: cut order % is CUT once every lay of it is CUT or CANCELLED, and one at least is CUT', NEW."number"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."status" = 'RECONCILED'
         AND EXISTS (SELECT 1 FROM "CutOrderLine" l
                      WHERE l."tenantId" = NEW."tenantId" AND l."cutOrderId" = NEW."id"
                        AND NOT EXISTS (SELECT 1 FROM "CutReconciliation" r WHERE r."tenantId" = l."tenantId" AND r."cutOrderLineId" = l."id")) THEN
        RAISE EXCEPTION 'cutting: cut order % is RECONCILED once every line of it has its reconciliation', NEW."number"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."kind" = 'LEATHER' AND num_nonnulls(NEW."markerName", NEW."markerLength", NEW."markerUom", NEW."markerWidthCm", NEW."markerFileId") > 0 THEN
    RAISE EXCEPTION 'cutting: cut order % cuts leather hide by hide; it has no marker', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."markerLength" IS NULL) <> (NEW."markerUom" IS NULL) OR NEW."markerLength" <= 0 OR NEW."markerUom" NOT IN ('M', 'CM', 'MM')
     OR NEW."markerWidthCm" <= 0 OR btrim(NEW."markerName") = '' THEN
    RAISE EXCEPTION 'cutting: cut order % has a marker named in words, its length above 0 in M, CM or MM (both or neither) and its width above 0', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  released := NEW."status" IN ('RELEASED', 'IN_PROGRESS', 'CUT', 'RECONCILED');
  IF NEW."kind" = 'FABRIC' AND released AND (NEW."markerName" IS NULL OR NEW."markerLength" IS NULL) THEN
    RAISE EXCEPTION 'cutting: cut order % is % with no marker; a fabric cut order is released with its marker (name and length)', NEW."number", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (released AND NEW."releasedAt" IS NULL) OR (NEW."status" = 'PLANNED' AND NEW."releasedAt" IS NOT NULL)
     OR (NEW."releasedAt" IS NULL) <> (NEW."releasedById" IS NULL)
     OR (NEW."status" IN ('CUT', 'RECONCILED')) <> (NEW."cutAt" IS NOT NULL)
     OR (NEW."status" = 'RECONCILED') <> (NEW."reconciledAt" IS NOT NULL)
     OR (NEW."reconciledAt" IS NULL) <> (NEW."reconciledById" IS NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'cutting: cut order % is % with the wrong times: released (when, by whom) from RELEASED on, cut from CUT on, reconciled (when, by whom) exactly when RECONCILED, cancelled exactly with its time and reason', NEW."number", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CutOrder_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CutOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_cut_order_guard"();
CREATE TRIGGER "CutOrder_number" BEFORE INSERT OR UPDATE ON "CutOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('cut order', 'CUT_ORDER');

-- ---------------------------------------------------------------------------------------------------------------------
-- CutOrderLine (MES-034, MES-037)
--   INSERT, UPDATE, DELETE  only while the cut order is PLANNED (its row FOR SHARE: a release waits for a line in flight, and
--              a line after it sees it released); a line never moves to another cut order.
--   every row  at least one garment; FABRIC: a ratio and plies from 1 with ratio × plies = its garments; LEATHER: neither.
--   cell       (at insert, and when the cell or the garments change) the work order is RELEASED or IN_PROGRESS; no more garments
--              than the cell makes; the cell takes the cut order's material (and colour, when the cut order names one) in its
--              planned materials.
--   TRUNCATE   refused.
CREATE FUNCTION "factory_cut_order_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cut_order record;
  order_state text;
  cell_quantity integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."cutOrderId" IS DISTINCT FROM OLD."cutOrderId" THEN
      RAISE EXCEPTION 'cutting: cut order line % never moves to another cut order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT c."number", c."status"::text AS status, c."kind"::text AS kind, c."itemId", c."itemColourId" INTO cut_order
    FROM "CutOrder" c
   WHERE c."tenantId" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END)
     AND c."id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."cutOrderId" ELSE NEW."cutOrderId" END)
     FOR SHARE;
  IF NOT FOUND THEN
    -- Outside this session's scope: the policies refuse the row.
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF cut_order.status <> 'PLANNED' THEN
    RAISE EXCEPTION 'cutting: cut order % is %; its lines change only while it is PLANNED', cut_order."number", cut_order.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1
     OR (cut_order.kind = 'FABRIC' AND (NEW."ratio" IS NULL OR NEW."plies" IS NULL OR NEW."ratio" < 1 OR NEW."plies" < 1 OR NEW."ratio" * NEW."plies" <> NEW."quantity"))
     OR (cut_order.kind = 'LEATHER' AND (NEW."ratio" IS NOT NULL OR NEW."plies" IS NOT NULL)) THEN
    RAISE EXCEPTION 'cutting: line % of cut order % has at least one garment; a fabric line has a ratio and plies from 1 that give its garments (ratio × plies), a leather line neither', NEW."id", cut_order."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR (NEW."workOrderId", NEW."workOrderSizeId", NEW."quantity") IS DISTINCT FROM (OLD."workOrderId", OLD."workOrderSizeId", OLD."quantity") THEN
    SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF FOUND AND order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
      RAISE EXCEPTION 'cutting: work order % is %; a cut order takes RELEASED or IN_PROGRESS work orders', NEW."workOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT s."quantity" INTO cell_quantity FROM "WorkOrderSize" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."workOrderSizeId";
    IF FOUND AND NEW."quantity" > cell_quantity THEN
      RAISE EXCEPTION 'cutting: line % of cut order % cuts % garment(s); its cell makes %', NEW."id", cut_order."number", NEW."quantity", cell_quantity
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND NOT EXISTS (SELECT 1 FROM "WorkOrderMaterial" m
                              WHERE m."tenantId" = NEW."tenantId" AND m."workOrderId" = NEW."workOrderId" AND m."workOrderSizeId" = NEW."workOrderSizeId"
                                AND m."itemId" = cut_order."itemId" AND (cut_order."itemColourId" IS NULL OR m."itemColourId" = cut_order."itemColourId")) THEN
      RAISE EXCEPTION 'cutting: the cell of line % does not take the material of cut order % (item %, colour %) in its planned materials; a cut order groups work orders of one material and colour',
        NEW."id", cut_order."number", cut_order."itemId", coalesce(cut_order."itemColourId"::text, 'any')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CutOrderLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CutOrderLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_cut_order_line_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- CutTicket (MES-041, MES-044)
--   every row  its number (factory_document_number_guard) and a scan code without spaces; CUT: a cut order and nothing of a
--              recut; RECUT: no cut order or lay, a work order and its cell, sets from 1, a part in words when it names one, a
--              lot with its item (both or neither); started exactly from STARTED on (DONE included; kept when VOID), done
--              exactly when DONE, voided exactly with its time and reason.
--   INSERT     OPEN, nothing started, done or voided. CUT: a cut order PLANNED, RELEASED or IN_PROGRESS; a fabric one's ticket
--              names a lay of it that is neither CUT nor CANCELLED, a leather one's none. RECUT: a work order RELEASED or
--              IN_PROGRESS; the bundle (when named) an ACTIVE bundle of the cell.
--   UPDATE     only the status, its times, the print time and the voiding change. OPEN → STARTED → DONE; OPEN, STARTED → VOID;
--              DONE and VOID are final. A CUT ticket starts while its cut order is RELEASED or IN_PROGRESS, and a lay's ticket
--              is DONE only once its lay is counted (CHECKED or CUT). A floor session only starts, finishes and prints one.
--   Partial unique indexes: at most one ticket that is not VOID per lay, and per leather cut order.
--   DELETE     refused (voided). TRUNCATE refused.
CREATE FUNCTION "factory_cut_ticket_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  progress CONSTANT text[] := ARRAY['status', 'printedAt', 'startedAt', 'doneAt', 'voidedAt', 'voidReason', 'version', 'updatedAt'];
  cut_order record;
  lay_state text;
  order_state text;
  bundle record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cutting: cut ticket % is voided, never deleted', OLD."number"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."startedAt" IS NOT NULL OR NEW."doneAt" IS NOT NULL OR NEW."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'cutting: cut ticket % starts OPEN, not yet started, done or voided', NEW."number"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || progress)) THEN
      RAISE EXCEPTION 'cutting: cut ticket % never changes but for its status, times, print time and voiding (a new ticket replaces a wrong one)', OLD."number"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('DONE', 'VOID') THEN
      RAISE EXCEPTION 'cutting: cut ticket % is %; it never changes', OLD."number", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'OPEN' AND NEW."status" IN ('STARTED', 'VOID')) OR (OLD."status" = 'STARTED' AND NEW."status" IN ('DONE', 'VOID'))) THEN
      RAISE EXCEPTION 'cutting: cut ticket % cannot move from % to %', OLD."number", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime' AND NEW."status" = 'VOID' THEN
      RAISE EXCEPTION 'cutting: at the table a ticket is started and finished; the office voids it (cut ticket %)', OLD."number"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NOT "factory_inspection_code_ok"(NEW."scanCode") THEN
    RAISE EXCEPTION 'cutting: cut ticket % has a scan code without spaces', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'CUT'
     AND (NEW."cutOrderId" IS NULL OR num_nonnulls(NEW."workOrderId", NEW."workOrderSizeId", NEW."bundleId", NEW."part", NEW."quantity", NEW."lotItemId", NEW."lotId") > 0 OR NEW."endBits") THEN
    RAISE EXCEPTION 'cutting: cut ticket % cuts a cut order: it names the cut order and nothing of a recut', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'RECUT'
     AND (NEW."cutOrderId" IS NOT NULL OR NEW."layId" IS NOT NULL OR NEW."workOrderId" IS NULL OR NEW."workOrderSizeId" IS NULL
          OR NEW."quantity" IS NULL OR NEW."quantity" < 1 OR btrim(NEW."part") = '' OR (NEW."lotItemId" IS NULL) <> (NEW."lotId" IS NULL)) THEN
    RAISE EXCEPTION 'cutting: recut ticket % names its work order, cell and sets (from 1), a part in words or none, a lot with its item or none, and no cut order or lay', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('STARTED', 'DONE') AND NEW."startedAt" IS NULL) OR (NEW."status" = 'OPEN' AND NEW."startedAt" IS NOT NULL)
     OR (NEW."status" = 'DONE') <> (NEW."doneAt" IS NOT NULL)
     OR (NEW."status" = 'VOID') <> (NEW."voidedAt" IS NOT NULL)
     OR (NEW."status" = 'VOID') <> (btrim(coalesce(NEW."voidReason", '')) <> '') THEN
    RAISE EXCEPTION 'cutting: cut ticket % is % with the wrong times: started from STARTED on, done exactly when DONE, voided exactly with its time and reason', NEW."number", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."kind" = 'CUT' THEN
    SELECT c."number", c."status"::text AS status, c."kind"::text AS kind INTO cut_order
      FROM "CutOrder" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."cutOrderId";
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
    IF NEW."layId" IS NOT NULL THEN
      SELECT y."status"::text INTO lay_state FROM "Lay" y WHERE y."tenantId" = NEW."tenantId" AND y."id" = NEW."layId";
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF cut_order.status NOT IN ('PLANNED', 'RELEASED', 'IN_PROGRESS') THEN
        RAISE EXCEPTION 'cutting: cut order % is %; it takes no new ticket', cut_order."number", cut_order.status
          USING ERRCODE = 'check_violation';
      END IF;
      IF (cut_order.kind = 'FABRIC') <> (NEW."layId" IS NOT NULL) THEN
        RAISE EXCEPTION 'cutting: cut ticket % of cut order % (%): a fabric cut order has a ticket per lay, a leather one a ticket of its own (no lay)', NEW."number", cut_order."number", cut_order.kind
          USING ERRCODE = 'check_violation';
      END IF;
      IF lay_state IN ('CUT', 'CANCELLED') THEN
        RAISE EXCEPTION 'cutting: lay % is %; it takes no new ticket', NEW."layId", lay_state
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."status" <> OLD."status" THEN
      IF NEW."status" = 'STARTED' AND cut_order.status NOT IN ('RELEASED', 'IN_PROGRESS') THEN
        RAISE EXCEPTION 'cutting: cut order % is %; its tickets start while it is RELEASED or IN_PROGRESS', cut_order."number", cut_order.status
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."status" = 'DONE' AND NEW."layId" IS NOT NULL AND lay_state NOT IN ('CHECKED', 'CUT') THEN
        RAISE EXCEPTION 'cutting: lay % is %; its ticket is done once its plies were counted at both ends and agree (MES-039)', NEW."layId", lay_state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
    IF order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
      RAISE EXCEPTION 'cutting: work order % is %; a recut is cut while it is RELEASED or IN_PROGRESS', NEW."workOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."bundleId" IS NOT NULL THEN
      SELECT b."workOrderSizeId", b."status"::text AS status INTO bundle FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."bundleId";
      IF FOUND AND (bundle."workOrderSizeId" <> NEW."workOrderSizeId" OR bundle.status <> 'ACTIVE') THEN
        RAISE EXCEPTION 'cutting: recut ticket % joins an ACTIVE bundle of its cell (bundle %)', NEW."number", NEW."bundleId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CutTicket_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CutTicket"
  FOR EACH ROW EXECUTE FUNCTION "factory_cut_ticket_guard"();
CREATE TRIGGER "CutTicket_number" BEFORE INSERT OR UPDATE ON "CutTicket"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('cut ticket', 'CUT_TICKET');

CREATE UNIQUE INDEX "CutTicket_one_per_lay" ON "CutTicket" ("tenantId", "layId") WHERE "kind" = 'CUT' AND "layId" IS NOT NULL AND "status" <> 'VOID';
CREATE UNIQUE INDEX "CutTicket_one_per_leather_order" ON "CutTicket" ("tenantId", "cutOrderId") WHERE "kind" = 'CUT' AND "layId" IS NULL AND "status" <> 'VOID';

-- ---------------------------------------------------------------------------------------------------------------------
-- Lay (MES-038, MES-039)
--   every row  plies planned from 1; the length spread above 0 in M, CM or MM (both or neither); the ply counts at both ends
--              and their time exactly from CHECKED on (CUT included), the two counts equal; cut exactly when CUT; cancelled
--              exactly with its time and reason.
--   INSERT     PLANNED, of a FABRIC cut order that is PLANNED, RELEASED or IN_PROGRESS.
--   UPDATE     the cut order, its number and the creation never change; the plies planned change only while PLANNED or
--              SPREADING. PLANNED → SPREADING → CHECKED → CUT, CHECKED → SPREADING, PLANNED, SPREADING, CHECKED → CANCELLED;
--              CUT and CANCELLED are final (only the note changes). Spreading, counting and cutting happen while the cut order
--              is RELEASED or IN_PROGRESS. CHECKED: both counts are the plies its rolls gave (a difference blocks the cut).
--              A floor session spreads, counts and cuts; it neither changes the plies planned nor cancels.
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_lay_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  progress CONSTANT text[] := ARRAY['plies', 'layLength', 'lengthUom', 'plyCountLeft', 'plyCountRight', 'checkedAt', 'status', 'cutAt', 'cancelledAt',
                                    'cancelReason', 'note', 'version', 'updatedAt'];
  floor_moves CONSTANT text[] := ARRAY['layLength', 'lengthUom', 'plyCountLeft', 'plyCountRight', 'checkedAt', 'status', 'cutAt', 'note', 'version', 'updatedAt'];
  cut_order record;
  spread integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cutting: lay % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PLANNED' THEN
      RAISE EXCEPTION 'cutting: lay % starts PLANNED', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || progress)) THEN
      RAISE EXCEPTION 'cutting: the cut order, number and creation of lay % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CUT', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'cutting: lay % is %; only its note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."plies" <> OLD."plies" AND OLD."status" NOT IN ('PLANNED', 'SPREADING') THEN
      RAISE EXCEPTION 'cutting: lay % is %; its plies planned change only while it is PLANNED or SPREADING', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'PLANNED' AND NEW."status" IN ('SPREADING', 'CANCELLED'))
                OR (OLD."status" = 'SPREADING' AND NEW."status" IN ('CHECKED', 'CANCELLED'))
                OR (OLD."status" = 'CHECKED' AND NEW."status" IN ('CUT', 'SPREADING', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'cutting: lay % cannot move from % to % (it is spread, counted at both ends, then cut)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime'
       AND ((to_jsonb(NEW) - (kept || floor_moves)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || floor_moves)) OR NEW."status" = 'CANCELLED') THEN
      RAISE EXCEPTION 'cutting: at the table a lay is spread, counted and cut; the office plans its plies and cancels it (lay %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."plies" < 1 OR (NEW."layLength" IS NULL) <> (NEW."lengthUom" IS NULL) OR NEW."layLength" <= 0 OR NEW."lengthUom" NOT IN ('M', 'CM', 'MM') THEN
    RAISE EXCEPTION 'cutting: lay % has plies planned from 1 and a length spread above 0 in M, CM or MM (both or neither)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('CHECKED', 'CUT')) <> (NEW."checkedAt" IS NOT NULL)
     OR num_nonnulls(NEW."plyCountLeft", NEW."plyCountRight", NEW."checkedAt") NOT IN (0, 3)
     OR NEW."plyCountLeft" IS DISTINCT FROM NEW."plyCountRight" OR NEW."plyCountLeft" < 1 THEN
    RAISE EXCEPTION 'cutting: lay % is % with the wrong ply counts: from CHECKED on both ends are counted, agree and say when (left %, right %); recount before cutting', NEW."id", NEW."status",
      coalesce(NEW."plyCountLeft"::text, '-'), coalesce(NEW."plyCountRight"::text, '-')
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CUT') <> (NEW."cutAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'cutting: lay % is % with the wrong times: cut exactly when CUT, cancelled exactly with its time and reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT c."number", c."status"::text AS status, c."kind"::text AS kind INTO cut_order
    FROM "CutOrder" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."cutOrderId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND (cut_order.kind <> 'FABRIC' OR cut_order.status NOT IN ('PLANNED', 'RELEASED', 'IN_PROGRESS')) THEN
    RAISE EXCEPTION 'cutting: cut order % is a % cut order and %; a lay is planned on a FABRIC cut order that is PLANNED, RELEASED or IN_PROGRESS', cut_order."number", cut_order.kind, cut_order.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" <> OLD."status" AND NEW."status" IN ('SPREADING', 'CHECKED', 'CUT') AND cut_order.status NOT IN ('RELEASED', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'cutting: cut order % is %; its lays are spread, counted and cut while it is RELEASED or IN_PROGRESS', cut_order."number", cut_order.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" = 'CHECKED'
     AND (NEW."status" <> OLD."status" OR NEW."plyCountLeft" IS DISTINCT FROM OLD."plyCountLeft" OR NEW."plyCountRight" IS DISTINCT FROM OLD."plyCountRight") THEN
    SELECT coalesce(sum(r."plies"), 0) INTO spread FROM "LayRoll" r WHERE r."tenantId" = NEW."tenantId" AND r."layId" = NEW."id";
    IF NEW."plyCountLeft" <> spread THEN
      RAISE EXCEPTION 'cutting: lay %: % plies were spread from its rolls, and both ends were counted at %; recount before cutting', NEW."id", spread, NEW."plyCountLeft"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Lay_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Lay"
  FOR EACH ROW EXECUTE FUNCTION "factory_lay_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- LayRoll (MES-038, MES-037)
--   INSERT, UPDATE, DELETE  only while the lay is PLANNED or SPREADING (its row FOR SHARE: a count waits for a roll in flight)
--              and its cut order RELEASED or IN_PROGRESS; a row never moves to another lay.
--   every row  plies from 1, splices from 0, end loss and roll end returned from 0, each up to the roll's length.
--   roll       (at insert, and when the roll changes) of the cut order's material, of its colour when it names one; not
--              CONSUMED, SCRAPPED or RETURNED; of the shade (group and text) of the lay's other rolls: mixing shade groups in one
--              lay is refused.
--   TRUNCATE   refused.
CREATE FUNCTION "factory_lay_roll_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lay record;
  roll record;
  other record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."layId" IS DISTINCT FROM OLD."layId" THEN
      RAISE EXCEPTION 'cutting: lay roll % never moves to another lay', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT y."id", y."status"::text AS status, c."number", c."status"::text AS order_state, c."itemId", c."itemColourId" INTO lay
    FROM "Lay" y JOIN "CutOrder" c ON c."tenantId" = y."tenantId" AND c."id" = y."cutOrderId"
   WHERE y."tenantId" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END)
     AND y."id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."layId" ELSE NEW."layId" END)
     FOR SHARE OF y;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF lay.status NOT IN ('PLANNED', 'SPREADING') OR lay.order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'cutting: lay % is % (cut order % is %); its rolls change only while it is spread (PLANNED or SPREADING) and its cut order RELEASED or IN_PROGRESS', lay."id", lay.status, lay."number", lay.order_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."plies" < 1 OR NEW."splices" < 0 OR NEW."endLoss" < 0 OR NEW."endReturned" < 0 THEN
    RAISE EXCEPTION 'cutting: lay roll % gives plies from 1, with splices, end loss and roll end returned from 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT f."code", f."itemId", f."state"::text AS state, f."length", f."shadeGroupId", f."shade", l."itemColourId" INTO roll
    FROM "FabricRoll" f LEFT JOIN "Lot" l ON l."tenantId" = f."tenantId" AND l."id" = f."lotId"
   WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."rollId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW."endLoss" > roll."length" OR NEW."endReturned" > roll."length" THEN
    RAISE EXCEPTION 'cutting: lay roll %: the end loss and the roll end returned are each at most roll %''s length (%)', NEW."id", roll."code", roll."length"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."rollId" IS DISTINCT FROM OLD."rollId" THEN
    IF roll."itemId" <> lay."itemId" OR (lay."itemColourId" IS NOT NULL AND roll."itemColourId" IS DISTINCT FROM lay."itemColourId") THEN
      RAISE EXCEPTION 'cutting: roll % is not of the material (and colour) cut order % cuts', roll."code", lay."number"
        USING ERRCODE = 'check_violation';
    END IF;
    IF roll.state IN ('CONSUMED', 'SCRAPPED', 'RETURNED') THEN
      RAISE EXCEPTION 'cutting: roll % is %; it is not spread', roll."code", roll.state
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT f."code", f."shadeGroupId", f."shade" INTO other
      FROM "LayRoll" r JOIN "FabricRoll" f ON f."tenantId" = r."tenantId" AND f."id" = r."rollId"
     WHERE r."tenantId" = NEW."tenantId" AND r."layId" = NEW."layId" AND r."id" <> NEW."id"
       AND (f."shadeGroupId", f."shade") IS DISTINCT FROM (roll."shadeGroupId", roll."shade")
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'cutting: roll % (shade %) is of another shade than roll % (shade %) in the same lay; one lay is spread from one shade group (MES-037)',
        roll."code", coalesce(roll."shade", '(none)'), other."code", coalesce(other."shade", '(none)')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LayRoll_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LayRoll"
  FOR EACH ROW EXECUTE FUNCTION "factory_lay_roll_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- PlyRun (MES-043)
--   every row  plies from 1, the first at most the last; at least one part, none blank, none twice; stickers from 1; printed
--              exactly from PRINTED on (kept when VOID, never while PLANNED); voided exactly with its time and reason.
--   INSERT     PLANNED or PRINTED, of a lay that is counted (CHECKED or CUT), up to the plies counted.
--   UPDATE     only the status, the print time and the voiding change. PLANNED → PRINTED | VOID, PRINTED → VOID; VOID is final.
--   DELETE     refused (voided). TRUNCATE refused.
CREATE FUNCTION "factory_ply_run_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  progress CONSTANT text[] := ARRAY['status', 'printedAt', 'voidedAt', 'voidReason', 'version', 'updatedAt'];
  lay record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cutting: ply run % is voided, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || progress)) THEN
      RAISE EXCEPTION 'cutting: ply run % never changes but for its print state (void it and print a new run)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'VOID' OR (NEW."status" <> OLD."status" AND NOT ((OLD."status" = 'PLANNED' AND NEW."status" IN ('PRINTED', 'VOID')) OR (OLD."status" = 'PRINTED' AND NEW."status" = 'VOID'))) THEN
      RAISE EXCEPTION 'cutting: ply run % cannot move from % to % (a VOID run never changes)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'VOID' THEN
    RAISE EXCEPTION 'cutting: ply run % is new; it is not voided', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."firstPly" < 1 OR NEW."lastPly" < NEW."firstPly" OR cardinality(NEW."parts") = 0 OR NOT "factory_cutting_words_ok"(NEW."parts") OR NEW."labelCount" < 1 THEN
    RAISE EXCEPTION 'cutting: ply run % numbers plies from 1 (the first at most the last) for at least one part (none blank or twice), with stickers from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'PRINTED' AND NEW."printedAt" IS NULL) OR (NEW."status" = 'PLANNED' AND NEW."printedAt" IS NOT NULL)
     OR (NEW."status" = 'VOID') <> (NEW."voidedAt" IS NOT NULL)
     OR (NEW."status" = 'VOID') <> (btrim(coalesce(NEW."voidReason", '')) <> '') THEN
    RAISE EXCEPTION 'cutting: ply run % is % with the wrong times: printed from PRINTED on, voided exactly with its time and reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT y."status"::text AS status, y."plyCountLeft" INTO lay FROM "Lay" y WHERE y."tenantId" = NEW."tenantId" AND y."siteId" = NEW."siteId" AND y."id" = NEW."layId";
    IF FOUND AND (lay.status NOT IN ('CHECKED', 'CUT') OR NEW."lastPly" > lay."plyCountLeft") THEN
      RAISE EXCEPTION 'cutting: ply run % numbers a lay counted at both ends (CHECKED or CUT; lay % is %), up to the plies counted (%)', NEW."id", NEW."layId", lay.status, coalesce(lay."plyCountLeft"::text, '-')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PlyRun_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PlyRun"
  FOR EACH ROW EXECUTE FUNCTION "factory_ply_run_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- CutReconciliation (MES-045), append-only
--   INSERT     its key starts `reconciliation:<line>` (one per line); the cut order is CUT; what was ordered is the line's
--              garments; cut from 0, recut from 0 up to the cut; a reason code (no spaces) exactly when cut differs from ordered.
--   UPDATE, DELETE, TRUNCATE  refused for every login.
CREATE FUNCTION "factory_cut_reconciliation_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cutting: a reconciliation is never changed or removed (%); it is written once the cut order is cut', TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_cut_reconciliation_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line record;
BEGIN
  IF position(('reconciliation:' || NEW."cutOrderLineId"::text) IN NEW."key") <> 1 THEN
    RAISE EXCEPTION 'cutting: reconciliation % has the key reconciliation:<its line> (one per line)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."cutQuantity" < 0 OR NEW."recutQuantity" < 0 OR NEW."recutQuantity" > NEW."cutQuantity"
     OR (NEW."cutQuantity" <> NEW."orderedQuantity") <> (NEW."varianceReasonCode" IS NOT NULL)
     OR NOT "factory_inspection_code_ok"(coalesce(NEW."varianceReasonCode", '-')) THEN
    RAISE EXCEPTION 'cutting: reconciliation % has cut from 0 and recut from 0 up to the cut, and a reason code (no spaces) exactly when cut (%) differs from ordered (%)', NEW."id", NEW."cutQuantity", NEW."orderedQuantity"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."quantity", c."number", c."status"::text AS status INTO line
    FROM "CutOrderLine" l JOIN "CutOrder" c ON c."tenantId" = l."tenantId" AND c."id" = l."cutOrderId"
   WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."cutOrderLineId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF line.status <> 'CUT' THEN
    RAISE EXCEPTION 'cutting: cut order % is %; it is reconciled once it is CUT', line."number", line.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."orderedQuantity" <> line."quantity" THEN
    RAISE EXCEPTION 'cutting: reconciliation %: the line ordered % garment(s), not %', NEW."id", line."quantity", NEW."orderedQuantity"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CutReconciliation_check" BEFORE INSERT ON "CutReconciliation"
  FOR EACH ROW EXECUTE FUNCTION "factory_cut_reconciliation_check"();
CREATE TRIGGER "CutReconciliation_append_only" BEFORE UPDATE OR DELETE ON "CutReconciliation"
  FOR EACH ROW EXECUTE FUNCTION "factory_cut_reconciliation_append_only"();
CREATE TRIGGER "CutReconciliation_no_truncate" BEFORE TRUNCATE ON "CutReconciliation"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cut_reconciliation_append_only"();

-- ---------------------------------------------------------------------------------------------------------------------
-- CutConsumption (MES-046)
--   every row  estimate, cut-log figure and confirmed figure from 0; confirmed with its time, both or neither.
--   INSERT     FABRIC: a lay of the cut order that is CUT, the key `consumption:<lay>`, a length unit (M, CM, MM); LEATHER: no
--              lay, the cut order IN_PROGRESS or CUT, the key `consumption:<cut order>`, an area unit (M2, DM2, FT2).
--   UPDATE     the cut order, lay, key, unit and creation never change.
--   always     the cut order is neither RECONCILED nor CANCELLED.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_cut_consumption_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  changing CONSTANT text[] := ARRAY['estimated', 'recorded', 'confirmed', 'confirmedAt', 'note', 'version', 'updatedAt'];
  cut_order record;
  lay_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cutting: consumption % is never deleted; correct its confirmed figure', OLD."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || changing)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || changing)) THEN
      RAISE EXCEPTION 'cutting: the cut order, lay, key and unit of consumption % never change', OLD."key"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."estimated" < 0 OR NEW."recorded" < 0 OR NEW."confirmed" < 0 OR (NEW."confirmed" IS NULL) <> (NEW."confirmedAt" IS NULL) THEN
    RAISE EXCEPTION 'cutting: consumption % has its estimate, cut-log figure and confirmed figure from 0, the confirmed one with its time', NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c."number", c."status"::text AS status, c."kind"::text AS kind INTO cut_order
    FROM "CutOrder" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."cutOrderId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF cut_order.status IN ('RECONCILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'cutting: cut order % is %; its consumption no longer changes', cut_order."number", cut_order.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF cut_order.kind = 'FABRIC' THEN
      IF NEW."layId" IS NOT NULL THEN
        SELECT y."status"::text INTO lay_state FROM "Lay" y WHERE y."tenantId" = NEW."tenantId" AND y."id" = NEW."layId";
      END IF;
      IF NEW."layId" IS NULL OR lay_state IS DISTINCT FROM 'CUT' OR position(('consumption:' || NEW."layId"::text) IN NEW."key") <> 1
         OR NEW."uom" NOT IN ('M', 'CM', 'MM') THEN
        RAISE EXCEPTION 'cutting: consumption % of fabric cut order % is a lay''s once it is CUT (key consumption:<lay>), in M, CM or MM', NEW."key", cut_order."number"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."layId" IS NOT NULL OR cut_order.status NOT IN ('IN_PROGRESS', 'CUT') OR position(('consumption:' || NEW."cutOrderId"::text) IN NEW."key") <> 1
          OR NEW."uom" NOT IN ('M2', 'DM2', 'FT2') THEN
      RAISE EXCEPTION 'cutting: consumption % of leather cut order % is the cut order''s (no lay; key consumption:<cut order>) once it is IN_PROGRESS or CUT, in M2, DM2 or FT2', NEW."key", cut_order."number"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CutConsumption_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CutConsumption"
  FOR EACH ROW EXECUTE FUNCTION "factory_cut_consumption_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- SecondaryProcess (MES-047)
--   every row  garments from 1; IN_HOUSE names no subcontract order, OUTSIDE no work centre; started from IN_PROGRESS on (DONE
--              included; kept when CANCELLED), done exactly when DONE, cancelled exactly with its time and reason.
--   INSERT     WAITING, nothing started; the work order RELEASED or IN_PROGRESS; an ACTIVE bundle with at least its garments.
--   UPDATE     the work order, bundle and creation never change; what it is (kind, place, garments) only while WAITING.
--              WAITING → IN_PROGRESS → DONE, WAITING and IN_PROGRESS → CANCELLED; DONE and CANCELLED are final (only the note
--              changes). A move to IN_PROGRESS or DONE takes the work order's gate (never while it is ON_HOLD).
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_secondary_process_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  content CONSTANT text[] := ARRAY['seq', 'kind', 'place', 'quantity'];
  progress CONSTANT text[] := ARRAY['workCentreId', 'subcontractOrderId', 'status', 'startedAt', 'doneAt', 'cancelledAt', 'cancelReason', 'note', 'version', 'updatedAt'];
  order_state text;
  bundle record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cutting: secondary process % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'WAITING' OR NEW."startedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'cutting: secondary process % starts WAITING', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || content || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || content || progress)) THEN
      RAISE EXCEPTION 'cutting: the work order, bundle and creation of secondary process % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'WAITING' AND (NEW."kind", NEW."place", NEW."quantity") IS DISTINCT FROM (OLD."kind", OLD."place", OLD."quantity") THEN
      RAISE EXCEPTION 'cutting: secondary process % is %; what it is (kind, place, garments) changes only while WAITING', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('DONE', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'cutting: secondary process % is %; only its note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'WAITING' AND NEW."status" IN ('IN_PROGRESS', 'CANCELLED')) OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('DONE', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'cutting: secondary process % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NEW."status" IN ('IN_PROGRESS', 'DONE') THEN
      PERFORM "factory_work_order_gate"(NEW."tenantId", NEW."workOrderId", 'secondary process', NEW."id");
    END IF;
  END IF;

  IF NEW."quantity" < 1 OR (NEW."place" = 'IN_HOUSE' AND NEW."subcontractOrderId" IS NOT NULL) OR (NEW."place" = 'OUTSIDE' AND NEW."workCentreId" IS NOT NULL) THEN
    RAISE EXCEPTION 'cutting: secondary process % has garments from 1; in house it names no subcontract order, outside no work centre', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('IN_PROGRESS', 'DONE') AND NEW."startedAt" IS NULL) OR (NEW."status" = 'WAITING' AND NEW."startedAt" IS NOT NULL)
     OR (NEW."status" = 'DONE') <> (NEW."doneAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'cutting: secondary process % is % with the wrong times: started from IN_PROGRESS on, done exactly when DONE, cancelled exactly with its time and reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."quantity" IS DISTINCT FROM OLD."quantity" THEN
    SELECT b."status"::text AS status, b."quantity" INTO bundle FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."id" = NEW."bundleId";
    IF FOUND AND ((TG_OP = 'INSERT' AND bundle.status <> 'ACTIVE') OR NEW."quantity" > bundle."quantity") THEN
      RAISE EXCEPTION 'cutting: secondary process % is done on an ACTIVE bundle with at least its % garment(s) (bundle %)', NEW."id", NEW."quantity", NEW."bundleId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF FOUND AND order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
      RAISE EXCEPTION 'cutting: work order % is %; its bundles take a secondary process while it is RELEASED or IN_PROGRESS', NEW."workOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SecondaryProcess_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SecondaryProcess"
  FOR EACH ROW EXECUTE FUNCTION "factory_secondary_process_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- CutIssue (MES-048)
--   every row  a trolley label without spaces; sent exactly from SENT on (kept when RECEIVED), received exactly when RECEIVED,
--              cancelled exactly with its time and reason.
--   INSERT     LOADING, nothing sent; an ACTIVE line.
--   UPDATE     the company, trolley and creation never change; the line only while LOADING (to an ACTIVE line). LOADING → SENT
--              (with a bundle at least) | CANCELLED, SENT → RECEIVED; RECEIVED and CANCELLED are final (only the note changes).
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_cut_issue_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  progress CONSTANT text[] := ARRAY['lineId', 'status', 'sentAt', 'receivedAt', 'cancelledAt', 'cancelReason', 'note', 'version', 'updatedAt'];
  line_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cutting: trolley % (issue %) is cancelled, never deleted', OLD."trolleyCode", OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'LOADING' OR NEW."sentAt" IS NOT NULL OR NEW."receivedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'cutting: trolley % starts LOADING', NEW."trolleyCode"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || progress)) THEN
      RAISE EXCEPTION 'cutting: the company, trolley and creation of issue % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('RECEIVED', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'cutting: trolley % (issue %) is %; only its note changes', OLD."trolleyCode", OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."lineId" IS DISTINCT FROM OLD."lineId" AND OLD."status" <> 'LOADING' THEN
      RAISE EXCEPTION 'cutting: trolley % (issue %) is %; its line changes only while LOADING', OLD."trolleyCode", OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'LOADING' AND NEW."status" IN ('SENT', 'CANCELLED')) OR (OLD."status" = 'SENT' AND NEW."status" = 'RECEIVED')) THEN
      RAISE EXCEPTION 'cutting: trolley % (issue %) cannot move from % to %', OLD."trolleyCode", OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'SENT' AND OLD."status" = 'LOADING'
       AND NOT EXISTS (SELECT 1 FROM "CutIssueLine" l WHERE l."tenantId" = NEW."tenantId" AND l."cutIssueId" = NEW."id") THEN
      RAISE EXCEPTION 'cutting: trolley % (issue %) carries no bundle; it is sent with one at least', NEW."trolleyCode", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NOT "factory_inspection_code_ok"(NEW."trolleyCode") THEN
    RAISE EXCEPTION 'cutting: issue % names its trolley by its label, without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('SENT', 'RECEIVED')) <> (NEW."sentAt" IS NOT NULL)
     OR (NEW."status" = 'RECEIVED') <> (NEW."receivedAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'cutting: trolley % (issue %) is % with the wrong times: sent from SENT on, received exactly when RECEIVED, cancelled exactly with its time and reason', NEW."trolleyCode", NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."lineId" IS DISTINCT FROM OLD."lineId" THEN
    SELECT l."status"::text INTO line_status FROM "Line" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."lineId";
    IF FOUND AND line_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'cutting: line % is %; a trolley goes to an ACTIVE line', NEW."lineId", line_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CutIssue_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CutIssue"
  FOR EACH ROW EXECUTE FUNCTION "factory_cut_issue_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- CutIssueLine (MES-048)
--   INSERT, DELETE  only while the trolley is LOADING (its row FOR SHARE); at insert an ACTIVE bundle, not yet received.
--   UPDATE     the trolley, work order, bundle and creation never change; received once, after the trolley was sent (SENT or
--              RECEIVED), then never changed or cleared.
--   TRUNCATE   refused.
CREATE FUNCTION "factory_cut_issue_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  changing CONSTANT text[] := ARRAY['receivedAt', 'note', 'version', 'updatedAt'];
  issue record;
  bundle_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || changing)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || changing)) THEN
      RAISE EXCEPTION 'cutting: the trolley, work order and bundle of trolley row % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."receivedAt" IS NOT NULL AND NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" THEN
      RAISE EXCEPTION 'cutting: bundle % on trolley row % was received; that stays', OLD."bundleId", OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT i."trolleyCode", i."status"::text AS status INTO issue
    FROM "CutIssue" i
   WHERE i."tenantId" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END)
     AND i."id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."cutIssueId" ELSE NEW."cutIssueId" END)
     FOR SHARE;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('INSERT', 'DELETE') AND issue.status <> 'LOADING' THEN
    RAISE EXCEPTION 'cutting: trolley % is %; bundles go on and off it only while it is LOADING', issue."trolleyCode", issue.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."receivedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'cutting: bundle % goes on trolley % not yet received', NEW."bundleId", issue."trolleyCode"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT b."status"::text INTO bundle_status FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."id" = NEW."bundleId";
    IF FOUND AND bundle_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'cutting: bundle % is %; a trolley carries ACTIVE bundles', NEW."bundleId", bundle_status
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."receivedAt" IS NOT NULL AND OLD."receivedAt" IS NULL AND issue.status NOT IN ('SENT', 'RECEIVED') THEN
    RAISE EXCEPTION 'cutting: trolley % is %; a bundle on it is received at the line once it was sent', issue."trolleyCode", issue.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CutIssueLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CutIssueLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_cut_issue_line_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- PatternPiece (PRD-219, MES-055)
--   INSERT, UPDATE, DELETE  only while the revision is DRAFT (the …_product_guards part rule, as for BOM lines and routing).
--   every row  a name in words, pieces from 1, sizes of the style's range (none blank or twice).
--   grade      (at insert, and when the grade or the line changes) a minimum grade only on a piece of a leather line (its item
--              tracked by HIDE); the grade is in use (not retired) when it is set.
CREATE FUNCTION "factory_pattern_piece_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  style_sizes text[];
  line_tracking text;
  grade record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF btrim(NEW."name") = '' OR NEW."quantity" < 1 OR NOT "factory_cutting_words_ok"(NEW."sizes") THEN
    RAISE EXCEPTION 'product: pattern piece % has a name in words, pieces from 1, and sizes none blank or twice', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."sizes" INTO style_sizes FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
  IF FOUND AND NOT (NEW."sizes" <@ style_sizes) THEN
    RAISE EXCEPTION 'product: pattern piece "%" names sizes outside its style''s range (%)', NEW."name", array_to_string(style_sizes, ', ')
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."minGradeId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."minGradeId" IS DISTINCT FROM OLD."minGradeId" OR NEW."bomLineId" IS DISTINCT FROM OLD."bomLineId") THEN
    IF NEW."bomLineId" IS NULL THEN
      RAISE EXCEPTION 'product: pattern piece "%" has a minimum grade, so it names the leather line it is cut from', NEW."name"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."tracking"::text INTO line_tracking
      FROM "BomLine" b JOIN "Item" i ON i."tenantId" = b."tenantId" AND i."id" = b."itemId"
     WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."bomLineId";
    IF FOUND AND line_tracking <> 'HIDE' THEN
      RAISE EXCEPTION 'product: pattern piece "%" is cut from a material tracked by %; a minimum grade is a leather (hide) rule', NEW."name", line_tracking
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT g."code", g."active" INTO grade FROM "LeatherGrade" g WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."minGradeId";
    IF FOUND AND NOT grade."active" AND (TG_OP = 'INSERT' OR NEW."minGradeId" IS DISTINCT FROM OLD."minGradeId") THEN
      RAISE EXCEPTION 'product: leather grade % is retired; pattern piece "%" does not take it', grade."code", NEW."name"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PatternPiece_revision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PatternPiece"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "PatternPiece_no_truncate" BEFORE TRUNCATE ON "PatternPiece"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "PatternPiece_check" BEFORE INSERT OR UPDATE ON "PatternPiece"
  FOR EACH ROW EXECUTE FUNCTION "factory_pattern_piece_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- GarmentDowngrade (MES-133)
--   every row  garments from 1; a reason code without spaces; exactly one of a second-quality item and a SKU; withdrawn: when,
--              by whom and why, all three or none.
--   INSERT     not withdrawn; the work order RELEASED, IN_PROGRESS, ON_HOLD or COMPLETED (its garments exist); no more garments
--              than the cell makes; the bundle and the rework (when named) of the cell; the scan (when named) of the work
--              order; the item of kind FINISHED; the SKU of the work order's style.
--   UPDATE     only the withdrawal, once.
--   DELETE     refused (withdrawn). TRUNCATE refused.
CREATE FUNCTION "factory_garment_downgrade_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF (to_jsonb(NEW) - (kept || withdrawing)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || withdrawing)) THEN
      RAISE EXCEPTION 'production: downgrade % never changes; withdraw it and record another', OLD."id"
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

CREATE TRIGGER "GarmentDowngrade_guard" BEFORE INSERT OR UPDATE OR DELETE ON "GarmentDowngrade"
  FOR EACH ROW EXECUTE FUNCTION "factory_garment_downgrade_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- CutLog (MES-053, MES-055, MES-060, MES-063, MES-064): the cutting table's checks, written with the entry. A NEW trigger; the
-- W1 triggers ("CutLog_check", "CutLog_append_only", …) and factory_cut_log_check (…_leather_stock_w2b_guards) are untouched.
--   a reversal  has none of them (nothing was cut, nothing checked).
--   every entry the thickness above 0 and below 100 mm; the overrides none twice; with an override, exactly one lead (a worker
--               of the site, never the cutter, or an office user; a floor session names a worker) and the reason in words;
--               without one, neither; a THICKNESS override has the thickness measured.
CREATE FUNCTION "factory_cut_log_cutting_rules"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."reversalOfId" IS NOT NULL THEN
    IF NEW."photoFileId" IS NOT NULL OR NEW."measuredThicknessMm" IS NOT NULL OR cardinality(NEW."overrides") > 0
       OR num_nonnulls(NEW."overrideLeadWorkerId", NEW."overrideLeadUserId", NEW."overrideReason") > 0 THEN
      RAISE EXCEPTION 'production: cut log entry % reverses an entry; it carries no photo, thickness or override', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."measuredThicknessMm" <= 0 OR NEW."measuredThicknessMm" >= 100 THEN
    RAISE EXCEPTION 'production: cut log entry % measured a thickness of % mm; above 0 and below 100', NEW."id", NEW."measuredThicknessMm"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."overrides") <> (SELECT count(DISTINCT o) FROM unnest(NEW."overrides") o) THEN
    RAISE EXCEPTION 'production: cut log entry % names an overridden warning twice', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."overrides") = 0 THEN
    IF num_nonnulls(NEW."overrideLeadWorkerId", NEW."overrideLeadUserId", NEW."overrideReason") > 0 THEN
      RAISE EXCEPTION 'production: cut log entry % overrode no warning; it names no lead and no reason', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF num_nonnulls(NEW."overrideLeadWorkerId", NEW."overrideLeadUserId") <> 1 OR btrim(coalesce(NEW."overrideReason", '')) = '' THEN
    RAISE EXCEPTION 'production: cut log entry % overrode % ("Cut anyway"): exactly one lead allowed it, with the reason in words', NEW."id", array_to_string(NEW."overrides", ', ')
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."overrideLeadWorkerId" IS NOT NULL AND NEW."overrideLeadWorkerId" = NEW."workerId" THEN
    RAISE EXCEPTION 'production: cut log entry %: the lead who allows "Cut anyway" is another person than the cutter', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'factory_floor_runtime' AND NEW."overrideLeadUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'production: cut log entry %: at the table "Cut anyway" takes a lead''s PIN (a worker of the site), not an office user', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF 'THICKNESS' = ANY (NEW."overrides") AND NEW."measuredThicknessMm" IS NULL THEN
    RAISE EXCEPTION 'production: cut log entry % overrode the thickness check; it says the thickness measured', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CutLog_cutting_rules" BEFORE INSERT ON "CutLog"
  FOR EACH ROW EXECUTE FUNCTION "factory_cut_log_cutting_rules"();

-- ---------------------------------------------------------------------------------------------------------------------
-- ReworkOrder (…_production_w2a_guards), whole: the repair station's scans (MES-132). Scanned in at a station of the site
-- (repairInAt and repairStationId together), only from IN_PROGRESS on (never while OPEN); scanned out after it (repairOutAt
-- needs repairInAt, not earlier); each set once, never changed or cleared. The rest as before.
CREATE OR REPLACE FUNCTION "factory_rework_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  content CONSTANT text[] := ARRAY['bundleId', 'reworkAtOperationId', 'quantity', 'reasonCode', 'description'];
  progress CONSTANT text[] := ARRAY['status', 'goodQuantity', 'scrapQuantity', 'startedAt', 'doneAt', 'cancelledAt', 'cancelReason', 'repairInAt', 'repairStationId',
                                    'repairOutAt', 'note', 'version', 'updatedAt'];
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
    -- W2b-2 (wave 13/16): the repair station's scans are set once.
    IF (OLD."repairInAt" IS NOT NULL AND (NEW."repairInAt", NEW."repairStationId") IS DISTINCT FROM (OLD."repairInAt", OLD."repairStationId"))
       OR (OLD."repairOutAt" IS NOT NULL AND NEW."repairOutAt" IS DISTINCT FROM OLD."repairOutAt") THEN
      RAISE EXCEPTION 'production: rework % was scanned in (or out) at the repair station once; that stays', OLD."id"
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
  -- W2b-2 (wave 13/16): scanned in with its station, from IN_PROGRESS on; scanned out after it.
  IF (NEW."repairInAt" IS NULL) <> (NEW."repairStationId" IS NULL)
     OR (NEW."status" = 'OPEN' AND NEW."repairInAt" IS NOT NULL)
     OR (NEW."repairOutAt" IS NOT NULL AND (NEW."repairInAt" IS NULL OR NEW."repairOutAt" < NEW."repairInAt")) THEN
    RAISE EXCEPTION 'production: rework % is scanned in at a repair station (time and station together) from IN_PROGRESS on, and scanned out after it', NEW."id"
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

-- ---------------------------------------------------------------------------------------------------------------------
-- ReplacementRequest (…_production_w2a_guards), whole: a RECUT's recut ticket (MES-044). Given while OPEN (at insert too), on
-- a RECUT only, never changed once given; the ticket is a RECUT ticket of the replacement's work order and cell (and part, the
-- same or both none) that is not VOID. The rest as before.
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
    -- W2b-2 (wave 13/16): the recut ticket is given while OPEN and stays.
    IF NEW."recutTicketId" IS DISTINCT FROM OLD."recutTicketId" AND (OLD."recutTicketId" IS NOT NULL OR OLD."status" <> 'OPEN') THEN
      RAISE EXCEPTION 'production: replacement %: its recut ticket is given while it is OPEN and never changes', OLD."id"
        USING ERRCODE = 'check_violation';
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
