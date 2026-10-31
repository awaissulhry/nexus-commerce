-- Written by hand (Prisma does not model triggers or deferred constraint triggers), after the generated
-- 202610311000_followups_stock_w2b_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- W2b schema wave 1/7 (B-W2b-01): the W2a follow-ups for stock, receiving, claims, returns, shipping and subcontracting
-- (the B-W2a-11, -13, -17, -18, -25, -31, -43, -44, -47, -48, -58, -74, -76 notes; features SCM-135, SCM-142, SCM-213,
-- MES-125, LOG-062, LOG-090, LOG-098). apps/factory-api's modules check all of this first, in words; these rules hold for
-- every login, the owner included. Every refusal is a check_violation (SQLSTATE 23514).
--
-- As in every guards migration: the tenant and site of a row are held by the policies (USING and WITH CHECK) and the
-- references, not here (no trigger compares "tenantId" or "siteId" of the row it guards); a rule that reads another row
-- skips a row this session cannot see (another tenant's or site's: the policies refuse that write anyway); an UPDATE
-- that changes nothing passes. A trigger reads only tables (and columns) the role that fires it may read. "Everything
-- but these columns" is compared as jsonb, so a column added later is frozen too unless a later migration names it.
--
-- REDEFINED, each from its whole latest body (rules and words kept; the triggers stay):
--   factory_stock_move_check           (202610283701_supply_guards) the new reasons CUSTOMER_RETURN (enters; names its
--                                      return line, of a return of the move's company and site), SUPPLIER_RETURN and
--                                      SHIPMENT (leave; a SHIPMENT names its shipment line, of a shipment of the move's
--                                      company, and garments of the line's work order); a reversal mirrors those lines
--                                      too; a reason code is a code (no spaces) and may say why instead of the note; a
--                                      RETURNED hide is not issued.
--   factory_hide_guard                 (202610285801_production_leftovers_guards) RETURNED; the database keeps the state a
--                                      hide had when it becomes SCRAPPED or RETURNED (previousState) and lets it come back
--                                      to exactly that state once a SCRAP (SUPPLIER_RETURN) move of it is reversed and it
--                                      holds stock again; no other state keeps a previous state.
--   factory_reservation_guard          (202610305001_production_w2a_guards) a system release: RELEASED with when and why
--                                      and no person, only once the demand is done (its work order COMPLETED, CLOSED or
--                                      CANCELLED; its order line closed short or its order no longer open); a RETURNED
--                                      hide is not reserved.
--   factory_goods_receipt_guard        (202610283701_supply_guards) a POSTED receipt's supplier DDT number and date change
--                                      with a new correction (when, by whom, why; all or none), and only then.
--   factory_supplier_claim_line_guard  (202610303001_supply_w2a_guards) the return DDT moves from a cancelled DDT to the
--                                      live DDT of the line's claim that replaced it and lists the line.
--   factory_shipment_guard             (202610306001_quality_plant_w2a_guards) the freight basis (only with a charge), the
--                                      freight cost (from 0, with its currency) and the mode of transport, all still set
--                                      after the goods left.
--   factory_operation_scan_check       (202610283801_production_guards) a REPORT of an outside operation names its
--                                      subcontract receipt line instead of a worker or station (never from a floor
--                                      session), with the line's bundle, operation and counts.
-- NEW triggers (their own functions): a stock move reversal that gives a SCRAPPED (RETURNED) hide its stock back opens
-- the hide again in the same transaction; the reason codes of ReceiptDiscrepancy and SupplierClaim (and the claim's NCR);
-- a DDT's language; the words of a scrap reason; a split bundle's reason; GeneratedDocument (append-only);
-- SubcontractBundle; SubcontractReceipt and SubcontractReceiptLine (append-only); WorkOrderKit. StoredFile.category is a
-- tag: no rule (the files guard leaves it free).

CREATE FUNCTION "factory_followups_stock_w2b_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'W2b follow-ups: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- Append-only (scripts/factory/check-append-only.mjs): GeneratedDocument, SubcontractReceipt and SubcontractReceiptLine.
-- No login may change or remove a row, the owner included; the runtime roles have no UPDATE, DELETE or TRUNCATE grant.
CREATE FUNCTION "factory_followups_stock_w2b_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a document version or a receipt stays as it was written', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "GeneratedDocument_append_only" BEFORE UPDATE OR DELETE ON "GeneratedDocument"
  FOR EACH ROW EXECUTE FUNCTION "factory_followups_stock_w2b_refuse_change"();
CREATE TRIGGER "GeneratedDocument_no_truncate" BEFORE TRUNCATE ON "GeneratedDocument"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_stock_w2b_refuse_change"();
CREATE TRIGGER "SubcontractReceipt_append_only" BEFORE UPDATE OR DELETE ON "SubcontractReceipt"
  FOR EACH ROW EXECUTE FUNCTION "factory_followups_stock_w2b_refuse_change"();
CREATE TRIGGER "SubcontractReceipt_no_truncate" BEFORE TRUNCATE ON "SubcontractReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_stock_w2b_refuse_change"();
CREATE TRIGGER "SubcontractReceiptLine_append_only" BEFORE UPDATE OR DELETE ON "SubcontractReceiptLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_followups_stock_w2b_refuse_change"();
CREATE TRIGGER "SubcontractReceiptLine_no_truncate" BEFORE TRUNCATE ON "SubcontractReceiptLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_stock_w2b_refuse_change"();
CREATE TRIGGER "SubcontractBundle_no_truncate" BEFORE TRUNCATE ON "SubcontractBundle"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_stock_w2b_refuse_truncate"();
CREATE TRIGGER "WorkOrderKit_no_truncate" BEFORE TRUNCATE ON "WorkOrderKit"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_stock_w2b_refuse_truncate"();

-- =====================================================================================================================
-- Stock (inventory.prisma)

-- StockMove, INSERT: REDEFINES factory_stock_move_check (202610283701_supply_guards), its whole body, as the header says.
-- W1's rules and words stand (see that migration's comment); W2b adds:
--   locations  CUSTOMER_RETURN only enters a location; SUPPLIER_RETURN and SHIPMENT only leave one.
--   documents  a CUSTOMER_RETURN, and only it, names its return line (and that line's customer: the reference's key), a
--              line of a return of the move's company and site; a SHIPMENT, and only it, names its shipment line, a line
--              of a shipment of the move's company, and the garments it takes are of the line's work order. A reversal
--              names the same lines.
--   why        a reason code is a code (no spaces); an ADJUSTMENT, COUNT or SCRAP says why with a note or a reason code.
--   quality    a RETURNED hide is not issued (nor a CONSUMED or SCRAPPED one).
CREATE OR REPLACE FUNCTION "factory_stock_move_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  enters boolean;
  leaves boolean;
  original record;
  item_tracking text;
  base_uom text;
  lot_status text;
  lot_colour uuid;
  lot_line uuid;
  line_item uuid;
  line_colour uuid;
  receipt_state text;
  hide_state text;
  on_hand numeric;
  returned record;
  shipped record;
BEGIN
  enters := NEW."toLocationId" IS NOT NULL AND NEW."fromLocationId" IS NULL;
  leaves := NEW."fromLocationId" IS NOT NULL AND NEW."toLocationId" IS NULL;
  IF NEW."quantity" <= 0 OR NEW."baseQuantity" <= 0 THEN
    RAISE EXCEPTION 'inventory: stock move % moves a quantity above 0 (its locations give the direction)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."fromLocationId" IS NULL AND NEW."toLocationId" IS NULL) OR NEW."fromLocationId" = NEW."toLocationId" THEN
    RAISE EXCEPTION 'inventory: stock move % leaves a location, enters one, or both (two different ones)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."reversalOfId" IS NULL THEN
    IF (NEW."reason" IN ('OPENING', 'RECEIPT', 'RETURN', 'CUSTOMER_RETURN') AND NOT enters)
       OR (NEW."reason" IN ('ISSUE', 'SCRAP', 'SUPPLIER_RETURN', 'SHIPMENT') AND NOT leaves)
       OR (NEW."reason" = 'TRANSFER' AND (NEW."fromLocationId" IS NULL OR NEW."toLocationId" IS NULL))
       OR (NEW."reason" IN ('ADJUSTMENT', 'COUNT') AND NOT (enters OR leaves)) THEN
      RAISE EXCEPTION 'inventory: stock move % is a % with the wrong locations (OPENING, RECEIPT, RETURN and CUSTOMER_RETURN only enter one; ISSUE, SCRAP, SUPPLIER_RETURN and SHIPMENT only leave one; TRANSFER both; ADJUSTMENT and COUNT one side)', NEW."id", NEW."reason"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT m."reason", m."itemId", m."itemColourId", m."lotId", m."hideId", m."baseQuantity", m."receiptLineId", m."workOrderId",
           m."returnLineId", m."shipmentLineId", m."fromLocationId", m."toLocationId", m."reversalOfId"
      INTO original
      FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."reversalOfId";
    IF FOUND THEN
      IF (original."reason", original."itemId", original."itemColourId", original."lotId", original."hideId", original."baseQuantity",
          original."receiptLineId", original."workOrderId", original."returnLineId", original."shipmentLineId")
         IS DISTINCT FROM
         (NEW."reason", NEW."itemId", NEW."itemColourId", NEW."lotId", NEW."hideId", NEW."baseQuantity", NEW."receiptLineId", NEW."workOrderId",
          NEW."returnLineId", NEW."shipmentLineId")
         OR original."fromLocationId" IS DISTINCT FROM NEW."toLocationId"
         OR original."toLocationId" IS DISTINCT FROM NEW."fromLocationId" THEN
        RAISE EXCEPTION 'inventory: stock move % reverses move %: the same reason, item, colour, lot, hide, quantity and document, with its locations swapped', NEW."id", NEW."reversalOfId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF original."reversalOfId" IS NOT NULL THEN
        RAISE EXCEPTION 'inventory: move % is itself a reversal; it is not reversed (post the move again instead)', NEW."reversalOfId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF (NEW."reason" = 'RECEIPT') <> (NEW."receiptLineId" IS NOT NULL) THEN
    RAISE EXCEPTION 'inventory: stock move % is a %; a RECEIPT, and only it, names its goods receipt line', NEW."id", NEW."reason"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reason" IN ('ISSUE', 'RETURN') AND NEW."workOrderId" IS NULL THEN
    RAISE EXCEPTION 'inventory: stock move % is an % without its work order', NEW."id", NEW."reason"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b: a CUSTOMER_RETURN, and only it, names its return line (with that line's customer); a SHIPMENT, and only it, its
  -- shipment line.
  IF (NEW."reason" = 'CUSTOMER_RETURN') <> (NEW."returnLineId" IS NOT NULL) OR (NEW."returnLineId" IS NULL) <> (NEW."returnPartyId" IS NULL) THEN
    RAISE EXCEPTION 'inventory: stock move % is a %; a CUSTOMER_RETURN, and only it, names its return line (with the line''s customer)', NEW."id", NEW."reason"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."reason" = 'SHIPMENT') <> (NEW."shipmentLineId" IS NOT NULL) THEN
    RAISE EXCEPTION 'inventory: stock move % is a %; a SHIPMENT, and only it, names its shipment line', NEW."id", NEW."reason"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b: the reason code is a code (no blank, no spaces); it may say why instead of the note.
  IF NEW."reasonCode" IS NOT NULL AND NEW."reasonCode" !~ '^\S+$' THEN
    RAISE EXCEPTION 'inventory: stock move % names its reason code without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reason" IN ('ADJUSTMENT', 'COUNT', 'SCRAP') AND NEW."reversalOfId" IS NULL AND btrim(coalesce(NEW."note", '')) = '' AND NEW."reasonCode" IS NULL THEN
    RAISE EXCEPTION 'inventory: stock move % is a % and says why (SCM-192)', NEW."id", NEW."reason"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT i."tracking"::text, i."baseUom"::text INTO item_tracking, base_uom FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
  IF FOUND THEN
    IF (item_tracking IN ('LOT', 'HIDE') AND NEW."lotId" IS NULL)
       OR (item_tracking = 'HIDE' AND NEW."hideId" IS NULL)
       OR (item_tracking <> 'HIDE' AND NEW."hideId" IS NOT NULL)
       OR (item_tracking = 'NONE' AND NEW."lotId" IS NOT NULL) THEN
      RAISE EXCEPTION 'inventory: item % is tracked by %; stock move % names its lot (LOT, HIDE) and hide (HIDE) exactly then', NEW."itemId", item_tracking, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."uom"::text = base_uom AND NEW."quantity" <> NEW."baseQuantity" THEN
      RAISE EXCEPTION 'inventory: stock move % is entered in the base unit %; its quantity is its base quantity', NEW."id", base_uom
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."lotId" IS NOT NULL THEN
    SELECT l."qualityStatus"::text, l."itemColourId", l."receiptLineId" INTO lot_status, lot_colour, lot_line
      FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."lotId";
    IF FOUND THEN
      IF lot_colour IS DISTINCT FROM NEW."itemColourId" THEN
        RAISE EXCEPTION 'inventory: stock move % is of the colour of its lot %', NEW."id", NEW."lotId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."reason" = 'RECEIPT' AND lot_line IS DISTINCT FROM NEW."receiptLineId" THEN
        RAISE EXCEPTION 'inventory: stock move % receives lot %, which is not a lot of its receipt line', NEW."id", NEW."lotId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."reason" = 'ISSUE' AND NEW."reversalOfId" IS NULL AND lot_status <> 'RELEASED' THEN
        RAISE EXCEPTION 'inventory: lot % is %; only RELEASED stock is issued (REACH Annex XVII entry 47: Cr VI)', NEW."lotId", lot_status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."receiptLineId" IS NOT NULL THEN
    SELECT l."itemId", l."itemColourId", r."status"::text INTO line_item, line_colour, receipt_state
      FROM "GoodsReceiptLine" l JOIN "GoodsReceipt" r ON r."tenantId" = l."tenantId" AND r."id" = l."receiptId"
     WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."receiptLineId";
    IF FOUND THEN
      IF line_item <> NEW."itemId" OR line_colour IS DISTINCT FROM NEW."itemColourId" THEN
        RAISE EXCEPTION 'inventory: stock move % posts receipt line %, of another item or colour', NEW."id", NEW."receiptLineId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (NEW."reversalOfId" IS NULL AND receipt_state <> 'OPEN') OR (NEW."reversalOfId" IS NOT NULL AND receipt_state NOT IN ('POSTED', 'REVERSED')) THEN
        RAISE EXCEPTION 'inventory: the goods receipt of line % is %; its moves are posted while it is OPEN (with its posting), reversed while it is POSTED (with its reversal)', NEW."receiptLineId", receipt_state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."hideId" IS NOT NULL AND NEW."reason" = 'ISSUE' AND NEW."reversalOfId" IS NULL THEN
    SELECT h."state"::text INTO hide_state FROM "Hide" h WHERE h."tenantId" = NEW."tenantId" AND h."id" = NEW."hideId";
    IF FOUND AND hide_state IN ('CONSUMED', 'SCRAPPED', 'RETURNED') THEN
      RAISE EXCEPTION 'inventory: hide % is %; it is not issued', NEW."hideId", hide_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- W2b: a CUSTOMER_RETURN's line is of a return of the move's company and site; a SHIPMENT's line of a shipment of the
  -- move's company, and the garments it takes are of the line's work order (never another batch's).
  IF NEW."returnLineId" IS NOT NULL THEN
    SELECT l."siteId", r."companyId" INTO returned
      FROM "ReturnLine" l JOIN "ReturnAuthorisation" r ON r."tenantId" = l."tenantId" AND r."id" = l."returnId"
     WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."returnLineId";
    IF FOUND AND (returned."siteId" <> NEW."siteId" OR returned."companyId" <> NEW."companyId") THEN
      RAISE EXCEPTION 'inventory: stock move % puts back the goods of return line %, a line of a return of another company or site', NEW."id", NEW."returnLineId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."shipmentLineId" IS NOT NULL THEN
    SELECT s."companyId", l."workOrderId" INTO shipped
      FROM "ShipmentLine" l JOIN "Shipment" s ON s."tenantId" = l."tenantId" AND s."id" = l."shipmentId"
     WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."shipmentLineId";
    IF FOUND AND (shipped."companyId" <> NEW."companyId" OR (NEW."workOrderId" IS NOT NULL AND NEW."workOrderId" <> shipped."workOrderId")) THEN
      RAISE EXCEPTION 'inventory: stock move % ships the garments of shipment line %: a line of a shipment of its company, garments of the line''s work order', NEW."id", NEW."shipmentLineId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."toLocationId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "Location" l
                  WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."toLocationId" AND l."status" = 'ARCHIVED') THEN
    RAISE EXCEPTION 'inventory: location % is archived; it takes no stock', NEW."toLocationId"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."fromLocationId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."fromLocationId") THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.stock', NEW."tenantId", NEW."siteId", NEW."fromLocationId",
      NEW."itemId", coalesce(NEW."itemColourId"::text, '-'), coalesce(NEW."lotId"::text, '-'), coalesce(NEW."hideId"::text, '-')), 0));
    SELECT coalesce(sum(CASE WHEN m."toLocationId" = NEW."fromLocationId" THEN m."baseQuantity" ELSE -m."baseQuantity" END), 0)
      INTO on_hand
      FROM "StockMove" m
     WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."itemId" = NEW."itemId"
       AND m."itemColourId" IS NOT DISTINCT FROM NEW."itemColourId"
       AND m."lotId" IS NOT DISTINCT FROM NEW."lotId"
       AND m."hideId" IS NOT DISTINCT FROM NEW."hideId"
       AND (m."toLocationId" = NEW."fromLocationId" OR m."fromLocationId" = NEW."fromLocationId");
    IF on_hand < NEW."baseQuantity" THEN
      RAISE EXCEPTION 'inventory: stock move % takes % from location %, which holds % of it; stock never goes below zero', NEW."id", NEW."baseQuantity", NEW."fromLocationId", on_hand
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
-- A reversal that gives a SCRAPPED (RETURNED) hide its stock back opens the hide again in the same transaction (back to
-- the state it had: factory_hide_guard): at commit, a reversal of a SCRAP (SUPPLIER_RETURN) move of a hide leaves the
-- hide neither SCRAPPED (RETURNED) any more. So a written-off hide never sits in stock that nothing may issue.
CREATE FUNCTION "factory_stock_move_reopens_hide"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original_reason text;
  hide record;
BEGIN
  SELECT m."reason"::text INTO original_reason
    FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."reversalOfId";
  IF NOT FOUND OR original_reason NOT IN ('SCRAP', 'SUPPLIER_RETURN') THEN
    RETURN NULL;
  END IF;
  SELECT h."state"::text AS state, h."previousState"::text AS previous INTO hide
    FROM "Hide" h WHERE h."tenantId" = NEW."tenantId" AND h."siteId" = NEW."siteId" AND h."id" = NEW."hideId";
  IF FOUND AND ((original_reason = 'SCRAP' AND hide.state = 'SCRAPPED') OR (original_reason = 'SUPPLIER_RETURN' AND hide.state = 'RETURNED')) THEN
    RAISE EXCEPTION 'inventory: stock move % reverses the % of hide %, which is still %; the hide comes back to the state it had (%) in the same transaction', NEW."id", original_reason, NEW."hideId", hide.state, coalesce(hide.previous, 'not recorded: it stays as it is, and its move is not reversed')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "StockMove_reopens_hide" AFTER INSERT ON "StockMove"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."reversalOfId" IS NOT NULL AND NEW."hideId" IS NOT NULL)
  EXECUTE FUNCTION "factory_stock_move_reopens_hide"();

-- Hide: REDEFINES factory_hide_guard (202610285801_production_leftovers_guards), its whole body. W1's and the leftovers'
-- rules stand; W2b:
--   INSERT     a new hide has no previous state.
--   UPDATE     a hide that becomes SCRAPPED or RETURNED gets the state it had as its previous state (written here, whatever
--              the update says); a SCRAPPED or RETURNED hide never changes but for one move: back to exactly its previous
--              state, the previous state cleared and nothing else changed, once a reversal of a SCRAP (SUPPLIER_RETURN)
--              move of it exists and it holds stock again (a hide scrapped before W2b has no previous state: it stays);
--              no other state keeps a previous state.
CREATE OR REPLACE FUNCTION "factory_hide_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  described CONSTANT text[] := ARRAY['grade', 'shade', 'thicknessMm', 'defects', 'state', 'closingCutLogId', 'previousState', 'version', 'updatedAt'];
  reopening CONSTANT text[] := ARRAY['state', 'closingCutLogId', 'version', 'updatedAt'];
  -- W2b: what changes when a SCRAPPED or RETURNED hide comes back.
  coming_back CONSTANT text[] := ARRAY['state', 'previousState', 'version', 'updatedAt'];
  item_tracking text;
  on_hand numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory: hide % is scrapped, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT i."tracking"::text INTO item_tracking FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND item_tracking <> 'HIDE' THEN
      RAISE EXCEPTION 'inventory: item % is tracked by %; hides belong to an item tracked by HIDE (hide %)', NEW."itemId", item_tracking, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."closingCutLogId" IS NOT NULL THEN
      RAISE EXCEPTION 'inventory: hide % is new; it has no closing cut log entry', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."previousState" IS NOT NULL THEN
      RAISE EXCEPTION 'inventory: hide % is new; it has no previous state', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || described)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || described)) THEN
      RAISE EXCEPTION 'inventory: the lot, tag and measured area of hide % never change (a correction is an adjustment move)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b: SCRAPPED and RETURNED are final but for one move: back to the state it had, once the move that took it out
    -- (a SCRAP, a SUPPLIER_RETURN) is reversed and the hide holds stock again.
    IF OLD."state" IN ('SCRAPPED', 'RETURNED') THEN
      IF OLD."previousState" IS NULL OR NEW."state" IS DISTINCT FROM OLD."previousState" OR NEW."previousState" IS NOT NULL
         OR (to_jsonb(NEW) - (kept || coming_back)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || coming_back)) THEN
        RAISE EXCEPTION 'inventory: hide % is %; it never changes, but back to the state it had (%) once the move that took it out is reversed', OLD."id", OLD."state", coalesce(OLD."previousState"::text, 'not recorded')
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT coalesce(sum(CASE WHEN m."toLocationId" IS NOT NULL THEN m."baseQuantity" ELSE 0 END)
                      - sum(CASE WHEN m."fromLocationId" IS NOT NULL THEN m."baseQuantity" ELSE 0 END), 0)
        INTO on_hand
        FROM "StockMove" m WHERE m."tenantId" = OLD."tenantId" AND m."siteId" = OLD."siteId" AND m."hideId" = OLD."id";
      IF on_hand <= 0
         OR NOT EXISTS (SELECT 1 FROM "StockMove" r
                          JOIN "StockMove" m ON m."tenantId" = r."tenantId" AND m."siteId" = r."siteId" AND m."id" = r."reversalOfId"
                         WHERE r."tenantId" = OLD."tenantId" AND r."siteId" = OLD."siteId" AND r."hideId" = OLD."id"
                           AND m."reason"::text = CASE OLD."state" WHEN 'SCRAPPED' THEN 'SCRAP' ELSE 'SUPPLIER_RETURN' END) THEN
        RAISE EXCEPTION 'inventory: hide % is %; it comes back (%) only once its % move is reversed and it holds stock again', OLD."id", OLD."state", OLD."previousState",
          CASE OLD."state" WHEN 'SCRAPPED' THEN 'SCRAP' ELSE 'SUPPLIER_RETURN' END
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    -- W2b: the database keeps the state a hide had when it becomes SCRAPPED or RETURNED; no other state keeps one.
    IF NEW."state" IN ('SCRAPPED', 'RETURNED') THEN
      NEW."previousState" := OLD."state";
    ELSIF NEW."previousState" IS NOT NULL THEN
      RAISE EXCEPTION 'inventory: hide % is %; only a SCRAPPED or RETURNED hide keeps its previous state', NEW."id", NEW."state"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'CONSUMED' THEN
      IF NEW."state" <> 'PARTLY_CUT' OR NEW."closingCutLogId" IS NOT NULL
         OR (to_jsonb(NEW) - (kept || reopening)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || reopening)) THEN
        RAISE EXCEPTION 'inventory: hide % is CONSUMED; it never changes, but back to PARTLY_CUT when its closing cut is reversed', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."closingCutLogId" IS NULL
         OR NOT EXISTS (SELECT 1 FROM "CutLog" r WHERE r."tenantId" = OLD."tenantId" AND r."siteId" = OLD."siteId" AND r."reversalOfId" = OLD."closingCutLogId") THEN
        RAISE EXCEPTION 'inventory: hide % is CONSUMED; it opens again (PARTLY_CUT) only when its closing cut log entry % is reversed', OLD."id", coalesce(OLD."closingCutLogId"::text, '(none)')
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW."state" = 'FULL' AND OLD."state" <> 'FULL' THEN
      RAISE EXCEPTION 'inventory: hide % was cut; it is never FULL again', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."state" = 'CONSUMED' THEN
      IF NEW."closingCutLogId" IS NULL
         OR NOT EXISTS (SELECT 1 FROM "CutLog" c
                         WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."closingCutLogId" AND c."hideId" = NEW."id"
                           AND c."reversalOfId" IS NULL
                           AND NOT EXISTS (SELECT 1 FROM "CutLog" r WHERE r."tenantId" = c."tenantId" AND r."siteId" = c."siteId" AND r."reversalOfId" = c."id")) THEN
        RAISE EXCEPTION 'inventory: hide % is used up (CONSUMED) with its closing cut log entry, a live entry of the hide', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."closingCutLogId" IS NOT NULL THEN
      RAISE EXCEPTION 'inventory: hide % is %; only a CONSUMED hide names its closing cut log entry', NEW."id", NEW."state"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."area" <= 0 OR NEW."baseArea" <= 0 OR NEW."areaUom" NOT IN ('M2', 'DM2', 'FT2') OR NEW."thicknessMm" <= 0 THEN
    RAISE EXCEPTION 'inventory: hide % has an area above 0 in M2, DM2 or FT2 (and in its base unit), and a thickness above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
-- Reservation: REDEFINES factory_reservation_guard (202610305001_production_w2a_guards), its whole body. Its rules stand;
-- W2b (B-W2a-11): RELEASED needs when and why, and by whom unless the system released it: a release with no person is
-- taken only once the demand is done (its work order COMPLETED, CLOSED or CANCELLED; its order line closed short, or its
-- order no longer CONFIRMED, IN_PRODUCTION, READY or PARTLY_SHIPPED), so a handler can release the rest when a work order
-- completes or is cancelled. A RETURNED hide is not reserved.
CREATE OR REPLACE FUNCTION "factory_reservation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  office_moves CONSTANT text[] := ARRAY['quantity', 'issuedQuantity', 'needDate', 'status', 'issuedAt', 'releasedAt',
    'releasedById', 'releaseReason', 'note', 'version', 'updatedAt'];
  floor_moves CONSTANT text[] := ARRAY['issuedQuantity', 'status', 'issuedAt', 'version', 'updatedAt'];
  item_tracking text;
  lot_colour uuid;
  lot_state text;
  hide_state text;
  work_state text;
  line_company uuid;
  line_site uuid;
  order_state text;
  line_closed timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reservations: reservation % is released, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."status" <> 'ACTIVE' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'reservations: reservation % is %; it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime' THEN
      IF (to_jsonb(NEW) - (kept || floor_moves)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || floor_moves))
         OR NEW."status" NOT IN ('ACTIVE', 'ISSUED') THEN
        RAISE EXCEPTION 'reservations: a floor session records only what was issued against reservation % (and ISSUED)', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF (to_jsonb(NEW) - (kept || office_moves)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || office_moves)) THEN
      RAISE EXCEPTION 'reservations: what reservation % holds and what for never change; release it and reserve again', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."status" <> 'ACTIVE' OR NEW."issuedQuantity" <> 0 OR NEW."issuedAt" IS NOT NULL OR NEW."releasedAt" IS NOT NULL
       OR NEW."releasedById" IS NOT NULL OR NEW."releaseReason" IS NOT NULL THEN
      RAISE EXCEPTION 'reservations: reservation % starts ACTIVE, with nothing issued or released', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."quantity" <= 0 OR NEW."issuedQuantity" < 0 OR NEW."issuedQuantity" > NEW."quantity" THEN
    RAISE EXCEPTION 'reservations: reservation % holds a quantity above 0, of which 0 up to all of it was issued', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ISSUED') <> (NEW."issuedAt" IS NOT NULL)
     OR (NEW."status" = 'ISSUED' AND NEW."issuedQuantity" <> NEW."quantity") THEN
    RAISE EXCEPTION 'reservations: reservation % is ISSUED exactly with its time, once all of it was issued', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b: by whom, unless the system released it (releasedById null) once its demand was done (below).
  IF (NEW."status" = 'RELEASED') <> (NEW."releasedAt" IS NOT NULL)
     OR (NEW."releasedAt" IS NULL AND NEW."releasedById" IS NOT NULL)
     OR (NEW."releasedAt" IS NULL) <> (btrim(coalesce(NEW."releaseReason", '')) = '') THEN
    RAISE EXCEPTION 'reservations: reservation % is RELEASED exactly with when, by whom and why (SCM-210)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b (B-W2a-11): the system releases (no person) only what nobody needs any more: the rest of a reservation whose work
  -- order is COMPLETED, CLOSED or CANCELLED, or whose order line is closed short or of an order no longer open.
  IF TG_OP = 'UPDATE' AND NEW."status" = 'RELEASED' AND OLD."status" = 'ACTIVE' AND NEW."releasedById" IS NULL THEN
    IF NEW."workOrderId" IS NOT NULL THEN
      SELECT w."status"::text INTO work_state
        FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
      IF FOUND AND work_state NOT IN ('COMPLETED', 'CLOSED', 'CANCELLED') THEN
        RAISE EXCEPTION 'reservations: reservation % is released by the system only once its work order % is done (it is %); a person releases it now, with the reason', NEW."id", NEW."workOrderId", work_state
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT o."status"::text, l."closedShortAt" INTO order_state, line_closed
        FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."orderId"
        WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
      IF FOUND AND line_closed IS NULL AND order_state IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED') THEN
        RAISE EXCEPTION 'reservations: reservation % is released by the system only once its order line is closed or its order is no longer open (it is %); a person releases it now, with the reason', NEW."id", order_state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF (NEW."kind" = 'HIDE') <> (NEW."hideId" IS NOT NULL) OR (NEW."hideId" IS NOT NULL AND NEW."lotId" IS NULL) THEN
    RAISE EXCEPTION 'reservations: reservation % names its hide and lot when it is a HIDE, and no hide otherwise', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."workOrderId" IS NULL) = (NEW."salesOrderLineId" IS NULL) OR (NEW."partyId" IS NULL) <> (NEW."salesOrderLineId" IS NULL) THEN
    RAISE EXCEPTION 'reservations: reservation % is held for exactly one work order or one sales order line (with its party)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT i."tracking"::text INTO item_tracking FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND (NEW."kind" = 'QUANTITY') = (item_tracking = 'HIDE') THEN
      RAISE EXCEPTION 'reservations: reservation % is a % of an item tracked %: leather tracked hide by hide is reserved by AREA or HIDE, any other item by QUANTITY', NEW."id", NEW."kind", item_tracking
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."itemColourId" IS NULL
       AND EXISTS (SELECT 1 FROM "ItemColour" c WHERE c."tenantId" = NEW."tenantId" AND c."itemId" = NEW."itemId") THEN
      RAISE EXCEPTION 'reservations: reservation % names the colour it holds: its item comes in colours', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."lotId" IS NOT NULL THEN
      SELECT l."itemColourId", l."qualityStatus"::text INTO lot_colour, lot_state
        FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."lotId";
      IF FOUND AND (lot_colour IS DISTINCT FROM NEW."itemColourId" OR lot_state = 'REJECTED') THEN
        RAISE EXCEPTION 'reservations: reservation % holds lot % in the lot''s own colour, and never a REJECTED lot', NEW."id", NEW."lotId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."hideId" IS NOT NULL THEN
      SELECT h."state"::text INTO hide_state
        FROM "Hide" h WHERE h."tenantId" = NEW."tenantId" AND h."siteId" = NEW."siteId" AND h."id" = NEW."hideId";
      IF FOUND AND hide_state IN ('CONSUMED', 'SCRAPPED', 'RETURNED') THEN
        RAISE EXCEPTION 'reservations: hide % is %; nothing of it can be reserved', NEW."hideId", hide_state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."workOrderId" IS NOT NULL THEN
      SELECT w."status"::text INTO work_state
        FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
      IF FOUND AND work_state NOT IN ('DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD') THEN
        RAISE EXCEPTION 'reservations: work order % is %; stock is reserved only for an open work order', NEW."workOrderId", work_state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."salesOrderLineId" IS NOT NULL THEN
      SELECT l."companyId", l."siteId", o."status"::text INTO line_company, line_site, order_state
        FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."orderId"
        WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
      IF FOUND AND (line_company <> NEW."companyId" OR (line_site IS NOT NULL AND line_site <> NEW."siteId")
                    OR order_state NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED')) THEN
        RAISE EXCEPTION 'reservations: sales order line % is not a line of an open order of the company made at this site', NEW."salesOrderLineId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
-- GoodsReceipt: REDEFINES factory_goods_receipt_guard (202610283701_supply_guards), its whole body. Its rules stand; W2b
-- (B-W2a-31): on a POSTED receipt the supplier's DDT number and date still change, each change with a new correction
-- (a later supplierDdtCorrectedAt, by whom, why), and a correction only with such a change; a correction is all three or
-- none and only on a POSTED (or then REVERSED) receipt. The API's command writes the audit row of each correction.
CREATE OR REPLACE FUNCTION "factory_goods_receipt_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  progress CONSTANT text[] := ARRAY['status', 'postedAt', 'postedById', 'reversedAt', 'reversedById', 'reversalReason', 'cancelledAt',
    'note', 'version', 'updatedAt'];
  -- W2b (B-W2a-31): the supplier's DDT number and date, still corrected while POSTED, with the correction.
  ddt_fix CONSTANT text[] := ARRAY['supplierDdtNumber', 'supplierDdtDate', 'supplierDdtCorrectedAt', 'supplierDdtCorrectedById',
    'supplierDdtCorrectionReason'];
  ddt_changed boolean := false;
  fix_changed boolean := false;
  order_party uuid;
  order_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory: goods receipt % is cancelled or reversed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'inventory: goods receipt % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'inventory: the company, number and creation of goods receipt % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'OPEN' AND NEW."status" IN ('POSTED', 'CANCELLED'))
                OR (OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED')) THEN
      RAISE EXCEPTION 'inventory: goods receipt % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN'
       AND (to_jsonb(NEW) - (kept || progress || CASE WHEN OLD."status" = 'POSTED' THEN ddt_fix ELSE ARRAY[]::text[] END))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || progress || CASE WHEN OLD."status" = 'POSTED' THEN ddt_fix ELSE ARRAY[]::text[] END)) THEN
      RAISE EXCEPTION 'inventory: goods receipt % is %; what was received changes only while it is OPEN (W2b: a POSTED receipt''s supplier DDT number and date with their correction)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b: on a POSTED receipt, the supplier's DDT number or date changes only with a new, later correction (when, who,
    -- why), and a correction is recorded only with such a change.
    IF OLD."status" = 'POSTED' THEN
      ddt_changed := (NEW."supplierDdtNumber", NEW."supplierDdtDate") IS DISTINCT FROM (OLD."supplierDdtNumber", OLD."supplierDdtDate");
      fix_changed := (NEW."supplierDdtCorrectedAt", NEW."supplierDdtCorrectedById", NEW."supplierDdtCorrectionReason")
                     IS DISTINCT FROM (OLD."supplierDdtCorrectedAt", OLD."supplierDdtCorrectedById", OLD."supplierDdtCorrectionReason");
    END IF;
    IF OLD."status" = 'POSTED'
       AND (ddt_changed <> fix_changed
            OR (ddt_changed AND (NEW."supplierDdtCorrectedAt" IS NULL OR NEW."supplierDdtCorrectedAt" <= coalesce(OLD."supplierDdtCorrectedAt", '-infinity'::timestamptz)))) THEN
      RAISE EXCEPTION 'inventory: goods receipt % is POSTED; its supplier DDT number or date is corrected with a new correction (when, by whom and why), and a correction comes only with such a change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('REVERSED', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'inventory: goods receipt % is %; only its note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'POSTED' AND (NEW."postedAt", NEW."postedById") IS DISTINCT FROM (OLD."postedAt", OLD."postedById") THEN
      RAISE EXCEPTION 'inventory: goods receipt % was posted; its posting never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."status" IN ('POSTED', 'REVERSED')) <> (NEW."postedAt" IS NOT NULL)
     OR (NEW."status" = 'REVERSED') <> (NEW."reversedAt" IS NOT NULL)
     OR (NEW."status" = 'REVERSED' AND btrim(coalesce(NEW."reversalReason", '')) = '')
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'inventory: goods receipt % is % with the wrong posting, reversal (time and reason) or cancellation', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b: a correction is all three (when, by whom, why) or none, and only on a POSTED or REVERSED receipt.
  IF (NEW."supplierDdtCorrectedAt" IS NULL) <> (NEW."supplierDdtCorrectedById" IS NULL)
     OR (NEW."supplierDdtCorrectedAt" IS NULL) <> (btrim(coalesce(NEW."supplierDdtCorrectionReason", '')) = '')
     OR (NEW."supplierDdtCorrectedAt" IS NOT NULL AND NEW."status" NOT IN ('POSTED', 'REVERSED')) THEN
    RAISE EXCEPTION 'inventory: goods receipt % records a supplier DDT correction with when, by whom and why (all or none), only once it is POSTED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."purchaseOrderId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."purchaseOrderId", NEW."supplierId") IS DISTINCT FROM (OLD."purchaseOrderId", OLD."supplierId")) THEN
    SELECT o."partyId", o."status"::text INTO order_party, order_state
      FROM "PurchaseOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."purchaseOrderId";
    IF FOUND THEN
      IF order_party <> NEW."supplierId" THEN
        RAISE EXCEPTION 'inventory: goods receipt % comes from the supplier of its purchase order %', NEW."id", NEW."purchaseOrderId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF order_state NOT IN ('SENT', 'CONFIRMED', 'PARTLY_RECEIVED') THEN
        RAISE EXCEPTION 'inventory: purchase order % is %; goods are received against a SENT, CONFIRMED or PARTLY_RECEIVED order', NEW."purchaseOrderId", order_state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
-- =====================================================================================================================
-- Receiving and claims (claims.prisma)

-- ReceiptDiscrepancy (W2b, B-W2a-31): its reason code is a code (no spaces) and, like what was found, changes only while
-- the discrepancy is OPEN.
CREATE FUNCTION "factory_receipt_discrepancy_reason_code_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW."reasonCode" IS NOT NULL AND NEW."reasonCode" !~ '^\S+$' THEN
    RAISE EXCEPTION 'inventory: discrepancy % names its reason code without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'OPEN' AND NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode" THEN
    RAISE EXCEPTION 'inventory: discrepancy % is %; what was found (its reason code too) changes only while it is OPEN', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReceiptDiscrepancy_reason_code_guard" BEFORE INSERT OR UPDATE ON "ReceiptDiscrepancy"
  FOR EACH ROW EXECUTE FUNCTION "factory_receipt_discrepancy_reason_code_guard"();

-- SupplierClaim (W2b, B-W2a-44, -47): its reason code is a code (no spaces), fixed once the claim is sent (like its
-- reason); the NCR it names is of the claim's company (and site: the reference).
CREATE FUNCTION "factory_supplier_claim_reason_code_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ncr_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW."reasonCode" IS NOT NULL AND NEW."reasonCode" !~ '^\S+$' THEN
    RAISE EXCEPTION 'supply: claim % names its reason code without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'DRAFT' AND NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode" THEN
    RAISE EXCEPTION 'supply: claim % is %; what it is about (its reason code too) is fixed once it is sent', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ncrId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."ncrId" IS DISTINCT FROM OLD."ncrId") THEN
    SELECT n."companyId" INTO ncr_company FROM "Nonconformance" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."ncrId";
    IF FOUND AND ncr_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'supply: claim % names nonconformance %, of another company', NEW."id", NEW."ncrId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SupplierClaim_reason_code_guard" BEFORE INSERT OR UPDATE ON "SupplierClaim"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_claim_reason_code_guard"();

-- SupplierClaimLine: REDEFINES factory_supplier_claim_line_guard (202610303001_supply_w2a_guards), its whole body. Its
-- rules stand; W2b (B-W2a-17, -44): the stock move stays set once; the return DDT moves only from a DDT a DdtCancellation
-- cancelled to the live DDT (no cancellation) of the line's claim (source SupplierClaim) that lists the line (its lines
-- name it as sourceLineId), never back to none.
CREATE OR REPLACE FUNCTION "factory_supplier_claim_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
  discrepancy_supplier uuid;
  moved record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."claimId" <> OLD."claimId" THEN
      RAISE EXCEPTION 'supply: claim line % never moves to another claim', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    part_of := OLD."claimId";
    SELECT c."status"::text INTO state FROM "SupplierClaim" c WHERE c."tenantId" = OLD."tenantId" AND c."id" = OLD."claimId" FOR SHARE;
  ELSE
    part_of := NEW."claimId";
    SELECT c."status"::text INTO state FROM "SupplierClaim" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."claimId" FOR SHARE;
  END IF;

  IF TG_OP IN ('INSERT', 'DELETE') THEN
    IF state IS NOT NULL AND state <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: claim % is %; its lines are added and removed only while it is DRAFT', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  ELSE
    IF state IN ('CLOSED', 'CANCELLED') THEN
      RAISE EXCEPTION 'supply: claim % is %; its lines change no more', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF state IS NOT NULL AND state <> 'DRAFT'
       AND (NEW."seq", NEW."discrepancyId", NEW."receiptLineId", NEW."itemId", NEW."itemColourId", NEW."lotId", NEW."hideId", NEW."quantity", NEW."uom", NEW."baseQuantity", NEW."reason")
           IS DISTINCT FROM
           (OLD."seq", OLD."discrepancyId", OLD."receiptLineId", OLD."itemId", OLD."itemColourId", OLD."lotId", OLD."hideId", OLD."quantity", OLD."uom", OLD."baseQuantity", OLD."reason") THEN
      RAISE EXCEPTION 'supply: claim % is %; what its lines are about changes only while it is DRAFT', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."moveId" IS NOT NULL AND NEW."moveId" IS DISTINCT FROM OLD."moveId" THEN
      RAISE EXCEPTION 'supply: the stock move and return DDT of claim line % are set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b (B-W2a-17, -44): the return DDT moves only from a cancelled DDT to the live DDT of the line's claim that
    -- replaced it and lists the line (a DdtCancellation names the old one; the new one has none).
    IF OLD."ddtId" IS NOT NULL AND NEW."ddtId" IS DISTINCT FROM OLD."ddtId"
       AND (NEW."ddtId" IS NULL
            OR NOT EXISTS (SELECT 1 FROM "DdtCancellation" c WHERE c."tenantId" = OLD."tenantId" AND c."ddtId" = OLD."ddtId")
            OR EXISTS (SELECT 1 FROM "DdtCancellation" c WHERE c."tenantId" = NEW."tenantId" AND c."ddtId" = NEW."ddtId")
            OR NOT EXISTS (SELECT 1 FROM "Ddt" d
                            WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."ddtId"
                              AND d."sourceType" = 'SupplierClaim' AND d."sourceId" = NEW."claimId"
                              AND jsonb_typeof(d."lines") = 'array'
                              AND EXISTS (SELECT 1 FROM jsonb_array_elements(d."lines") e WHERE e ->> 'sourceLineId' = NEW."id"::text))) THEN
      RAISE EXCEPTION 'supply: the stock move and return DDT of claim line % are set once; the DDT moves only from a cancelled DDT to the live DDT of its claim that replaced it and lists the line', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."quantity" <= 0 OR NEW."baseQuantity" <= 0 OR NEW."unitCost" < 0 OR NEW."creditAmount" < 0 OR (NEW."hideId" IS NOT NULL AND NEW."lotId" IS NULL) THEN
    RAISE EXCEPTION 'supply: claim line % has its quantities above 0, no negative cost or credit, and a hide only with its lot', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."discrepancyId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."discrepancyId" IS DISTINCT FROM OLD."discrepancyId") THEN
    SELECT d."supplierId" INTO discrepancy_supplier FROM "ReceiptDiscrepancy" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."discrepancyId";
    IF FOUND AND discrepancy_supplier <> NEW."partyId" THEN
      RAISE EXCEPTION 'supply: claim line % pursues a discrepancy of its claim''s supplier', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."moveId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."moveId" IS DISTINCT FROM OLD."moveId") THEN
    SELECT m."itemId", m."lotId", m."hideId" INTO moved FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."moveId";
    IF FOUND AND (moved."itemId" <> NEW."itemId" OR (NEW."lotId" IS NOT NULL AND moved."lotId" IS DISTINCT FROM NEW."lotId")
                  OR (NEW."hideId" IS NOT NULL AND moved."hideId" IS DISTINCT FROM NEW."hideId")) THEN
      RAISE EXCEPTION 'supply: claim line % names a stock move of its own item, lot and hide', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
-- =====================================================================================================================
-- Shipping (shipping.prisma)

-- Shipment: REDEFINES factory_shipment_guard (202610306001_quality_plant_w2a_guards), its whole body. Its rules stand;
-- W2b (B-W2a-29, -39, -48): the freight basis (only with a freight charge), the freight cost (0 or more, with its ISO 4217
-- currency, both or neither) and the mode of transport still change after the goods left (until cancelled); the floor
-- still changes nothing but DRAFT ⇄ PACKED.
CREATE OR REPLACE FUNCTION "factory_shipment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  -- W2a: what still changes once the goods left.
  after_leaving CONSTANT text[] := ARRAY['freightCharge', 'transportEvidence', 'transportEvidenceAt', 'transportEvidenceById', 'transportEvidenceNote',
    -- W2b: how the charge was decided, what the carrier charged us (its invoice comes later) and the mode of transport.
    'freightBasis', 'freightCost', 'freightCostCurrency', 'transportMode'];
  order_state text;
  lines bigint;
  unpacked bigint;
  parcels bigint;
  unweighed bigint;
  unserialled bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shipping: shipment % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'shipping: shipment % starts as a DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT o."status"::text INTO order_state FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."salesOrderId";
    IF FOUND AND order_state IN ('CANCELLED', 'CLOSED') THEN
      RAISE EXCEPTION 'shipping: sales order % is %; nothing more ships for it', NEW."salesOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."salesOrderId", NEW."number", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."salesOrderId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'shipping: the company, order, number and creation of shipment % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('PACKED', 'CANCELLED'))
                OR (OLD."status" = 'PACKED' AND NEW."status" IN ('DRAFT', 'SHIPPED', 'CANCELLED'))
                OR (OLD."status" = 'SHIPPED' AND NEW."status" IN ('DELIVERED', 'RETURNED'))) THEN
      RAISE EXCEPTION 'shipping: shipment % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CANCELLED'
       AND (to_jsonb(NEW) - (kept || ARRAY['internalNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'shipping: shipment % is %; only its internal note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2a: after delivery (or the return) the freight charged and the transport evidence still change (LOG-105, LOG-090).
    IF OLD."status" IN ('DELIVERED', 'RETURNED')
       AND (to_jsonb(NEW) - (kept || after_leaving || ARRAY['internalNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || after_leaving || ARRAY['internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'shipping: shipment % is %; only its internal note changes (and, W2a, the freight charged and its transport evidence)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'SHIPPED'
       AND (to_jsonb(NEW) - (kept || after_leaving || ARRAY['status', 'deliveredAt', 'returnedAt', 'internalNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || after_leaving || ARRAY['status', 'deliveredAt', 'returnedAt', 'internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'shipping: shipment % left; only its delivery or return and its internal note change (and, W2a, the freight charged and its transport evidence)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime'
       AND ((to_jsonb(NEW) - (kept || ARRAY['status', 'packedAt', 'version', 'updatedAt']))
            IS DISTINCT FROM
            (to_jsonb(OLD) - (kept || ARRAY['status', 'packedAt', 'version', 'updatedAt']))
            OR (NEW."status" <> OLD."status"
                AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'PACKED') OR (OLD."status" = 'PACKED' AND NEW."status" = 'DRAFT')))) THEN
      RAISE EXCEPTION 'shipping: the floor packs and unpacks shipment % (DRAFT ⇄ PACKED), nothing else', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'DRAFT' AND NEW."status" = 'PACKED' THEN
      SELECT count(*), count(*) FILTER (WHERE l."parcelId" IS NULL) INTO lines, unpacked
        FROM "ShipmentLine" l WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id";
      SELECT count(*), count(*) FILTER (WHERE p."grossWeightKg" IS NULL) INTO parcels, unweighed
        FROM "Parcel" p WHERE p."tenantId" = NEW."tenantId" AND p."shipmentId" = NEW."id";
      IF lines = 0 OR unpacked > 0 OR parcels = 0 OR unweighed > 0 THEN
        RAISE EXCEPTION 'shipping: shipment % is PACKED with its lines, each in a parcel, and its parcels, each weighed (% line(s), % not in a parcel; % parcel(s), % not weighed)', NEW."id", lines, unpacked, parcels, unweighed
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*) INTO unserialled
        FROM "ShipmentLine" l
        JOIN "WorkOrder" w ON w."tenantId" = l."tenantId" AND w."id" = l."workOrderId"
        JOIN "Style" s ON s."tenantId" = w."tenantId" AND s."id" = w."styleId"
       WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id" AND s."garmentTracking" = 'SERIAL'
         AND l."quantity" <> (SELECT count(*) FROM "GarmentSerial" g WHERE g."tenantId" = l."tenantId" AND g."shipmentLineId" = l."id");
      IF unserialled > 0 THEN
        RAISE EXCEPTION 'shipping: shipment % has % line(s) of a serial-tracked style without a serial for each garment (Q31)', NEW."id", unserialled
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF btrim(NEW."number") = '' THEN
    RAISE EXCEPTION 'shipping: shipment % has a number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED') AND NEW."packedAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND NEW."packedAt" IS NOT NULL)
     OR (NEW."status" IN ('SHIPPED', 'DELIVERED', 'RETURNED')) <> (NEW."shippedAt" IS NOT NULL)
     OR (NEW."status" = 'DELIVERED') <> (NEW."deliveredAt" IS NOT NULL)
     OR (NEW."status" = 'RETURNED') <> (NEW."returnedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'shipping: shipment % is % with the wrong packing, shipping, delivery or return time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'shipping: shipment % is % with the wrong cancellation (a cancelled shipment has its time and reason)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2a: the freight charged from 0 (LOG-105); transport evidence only once the goods left, COMPLETE exactly with when and
  -- who checked it (LOG-090; art. 41 DL 331/93).
  IF coalesce(NEW."freightCharge", 0) < 0 THEN
    RAISE EXCEPTION 'shipping: the freight charged for shipment % is 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b (B-W2a-48): the freight basis only with a freight charge; the freight cost from 0 with its ISO 4217 currency
  -- (both or neither).
  IF NEW."freightBasis" IS NOT NULL AND NEW."freightCharge" IS NULL THEN
    RAISE EXCEPTION 'shipping: shipment % says how its freight charge was decided only when it has one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(NEW."freightCost", 0) < 0 OR (NEW."freightCost" IS NULL) <> (NEW."freightCostCurrency" IS NULL)
     OR coalesce(NEW."freightCostCurrency", 'EUR') !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'shipping: the freight cost of shipment % is 0 or more, with its ISO 4217 currency (both or neither)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."transportEvidence" <> 'NOT_NEEDED' AND NEW."status" NOT IN ('SHIPPED', 'DELIVERED', 'RETURNED'))
     OR (NEW."transportEvidence" = 'COMPLETE') <> (NEW."transportEvidenceAt" IS NOT NULL)
     OR (NEW."transportEvidence" = 'COMPLETE') <> (NEW."transportEvidenceById" IS NOT NULL) THEN
    RAISE EXCEPTION 'shipping: shipment % is % with transport evidence %: evidence is kept once the goods left, and COMPLETE exactly with when and who checked it', NEW."id", NEW."status", NEW."transportEvidence"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
-- Ddt, INSERT (W2b, B-W2a-17): the language it was printed in is two lower-case letters (ISO 639-1) when given. The DDT
-- never changes afterwards (append-only: W1's triggers).
CREATE FUNCTION "factory_ddt_language_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."language" IS NOT NULL AND NEW."language" !~ '^[a-z]{2}$' THEN
    RAISE EXCEPTION 'shipping: DDT % names the language it was printed in by its two-letter code (ISO 639-1)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Ddt_language_check" BEFORE INSERT ON "Ddt"
  FOR EACH ROW EXECUTE FUNCTION "factory_ddt_language_check"();

-- GeneratedDocument (gendocs.prisma; W2b, B-W2b-01), INSERT (append-only above):
--   version     from 1 (unique per record and kind: the index); the fingerprint a SHA-256 in lower-case hex; the
--               language two lower-case letters; a layout and a number not blank when given.
--   record      by kind: PACKING_LIST a Shipment, CLAIM_LETTER a SupplierClaim, JOB_SHEET a SubcontractOrder or a
--               MaintenanceJob, RMA_SHEET a ReturnAuthorisation; the record is of the document's company and site.
--   file        a file of the same record and company.
CREATE FUNCTION "factory_generated_document_check"() RETURNS trigger LANGUAGE plpgsql AS $$
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
          OR (NEW."kind" = 'RMA_SHEET' AND NEW."recordType" = 'ReturnAuthorisation')) THEN
    RAISE EXCEPTION 'documents: generated document % is a % of a %; a packing list is a Shipment''s, a claim letter a SupplierClaim''s, a job sheet a SubcontractOrder''s or a MaintenanceJob''s, an RMA sheet a ReturnAuthorisation''s', NEW."id", NEW."kind", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  CASE NEW."recordType"
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

CREATE TRIGGER "GeneratedDocument_check" BEFORE INSERT ON "GeneratedDocument"
  FOR EACH ROW EXECUTE FUNCTION "factory_generated_document_check"();

-- =====================================================================================================================
-- Subcontracting (subcontract.prisma)

-- SubcontractBundle (W2b, B-W2a-25):
--   INSERT     an ACTIVE bundle of the order's work order (the reference), carrying 1 up to its garments, sent while the
--              order is ISSUED, AT_WORKSHOP or PARTLY_RECEIVED.
--   UPDATE     refused: what went out stays as it went (an UPDATE that changes nothing passes).
--   DELETE     only while no receipt line of the order names the bundle (nothing of it came back: a send undone).
--   TRUNCATE   refused.
CREATE FUNCTION "factory_subcontract_bundle_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bundle record;
  order_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "SubcontractReceiptLine" l
                 JOIN "SubcontractReceipt" r ON r."tenantId" = l."tenantId" AND r."id" = l."receiptId"
                WHERE l."tenantId" = OLD."tenantId" AND l."bundleId" = OLD."bundleId" AND r."subcontractOrderId" = OLD."subcontractOrderId") THEN
      RAISE EXCEPTION 'supply: bundle % came back (in part) from subcontract order %; its trip out is kept', OLD."bundleId", OLD."subcontractOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'supply: subcontract bundle % stays as it went out', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT b."quantity", b."status"::text AS status INTO bundle
    FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."id" = NEW."bundleId";
  IF FOUND AND (bundle.status <> 'ACTIVE' OR NEW."quantity" < 1 OR NEW."quantity" > bundle."quantity") THEN
    RAISE EXCEPTION 'supply: bundle % goes out ACTIVE, with 1 up to its % garment(s) (subcontract bundle %)', NEW."bundleId", bundle."quantity", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."status"::text INTO order_state FROM "SubcontractOrder" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."subcontractOrderId";
  IF FOUND AND order_state NOT IN ('ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED') THEN
    RAISE EXCEPTION 'supply: subcontract order % is %; bundles go out with an ISSUED, AT_WORKSHOP or PARTLY_RECEIVED order', NEW."subcontractOrderId", order_state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SubcontractBundle_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SubcontractBundle"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontract_bundle_guard"();

-- SubcontractReceipt, INSERT (W2b, B-W2a-25, -76; append-only above):
--   order      AT_WORKSHOP, PARTLY_RECEIVED or RECEIVED (the receive command moves it in the same transaction).
--   receipt    a place from 1; the workshop's DDT number not blank when given, its date only with a number.
--   material   the return moves listed once each; each a TRANSFER out of the order's workshop location into another
--              location of the site, of this site.
CREATE FUNCTION "factory_subcontract_receipt_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_row record;
  order_seen boolean;
  bad bigint;
BEGIN
  SELECT s."status"::text AS status, s."locationId" INTO order_row
    FROM "SubcontractOrder" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."subcontractOrderId";
  order_seen := FOUND;
  IF order_seen AND order_row.status NOT IN ('AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED') THEN
    RAISE EXCEPTION 'supply: subcontract order % is %; goods come back from an order AT_WORKSHOP or PARTLY_RECEIVED (receipt %)', NEW."subcontractOrderId", order_row.status, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 1 OR btrim(coalesce(NEW."workshopDdtNumber", 'x')) = '' OR (NEW."workshopDdtDate" IS NOT NULL AND NEW."workshopDdtNumber" IS NULL) THEN
    RAISE EXCEPTION 'supply: subcontract receipt % has a place from 1, and the workshop''s DDT number when it gives its date', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."returnMoveIds" IS NULL OR array_position(NEW."returnMoveIds", NULL) IS NOT NULL
     OR cardinality(NEW."returnMoveIds") <> (SELECT count(DISTINCT x) FROM unnest(NEW."returnMoveIds") x) THEN
    RAISE EXCEPTION 'supply: subcontract receipt % lists each material move once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF order_seen AND cardinality(NEW."returnMoveIds") > 0 THEN
    SELECT count(*) INTO bad
      FROM "StockMove" m
     WHERE m."tenantId" = NEW."tenantId" AND m."id" = ANY (NEW."returnMoveIds")
       AND (m."siteId" <> NEW."siteId" OR m."reason" <> 'TRANSFER' OR m."fromLocationId" IS DISTINCT FROM order_row."locationId");
    IF bad > 0 THEN
      RAISE EXCEPTION 'supply: subcontract receipt % lists % move(s) that are not TRANSFERs out of its order''s workshop location at its site', NEW."id", bad
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SubcontractReceipt_check" BEFORE INSERT ON "SubcontractReceipt"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontract_receipt_check"();

-- SubcontractReceiptLine, INSERT (W2b; append-only above):
--   counts     good, defective and scrapped from 0, at least one in all; a reason code is a code (no spaces).
--   operation  an operation of the receipt's order.
--   bundle     of a cell the operation sends (when it is split by size), and never back more than its garments for the
--              operation over every receipt: read under a transaction lock per bundle and operation.
CREATE FUNCTION "factory_subcontract_receipt_line_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt_order uuid;
  operation record;
  operation_seen boolean;
  bundle record;
  back bigint;
BEGIN
  IF NEW."goodQuantity" < 0 OR NEW."defectiveQuantity" < 0 OR NEW."scrappedQuantity" < 0
     OR NEW."goodQuantity" + NEW."defectiveQuantity" + NEW."scrappedQuantity" < 1 THEN
    RAISE EXCEPTION 'supply: receipt line % counts pieces back good, defective and scrapped from 0, at least one in all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reasonCode" IS NOT NULL AND NEW."reasonCode" !~ '^\S+$' THEN
    RAISE EXCEPTION 'supply: receipt line % names its reason code without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r."subcontractOrderId" INTO receipt_order FROM "SubcontractReceipt" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."receiptId";
  SELECT o."subcontractOrderId", o."sizes" INTO operation
    FROM "SubcontractOperation" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."subcontractOperationId";
  operation_seen := FOUND;
  IF operation_seen AND receipt_order IS NOT NULL AND operation."subcontractOrderId" <> receipt_order THEN
    RAISE EXCEPTION 'supply: receipt line % reports an operation of its receipt''s subcontract order', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."bundleId" IS NOT NULL THEN
    SELECT b."quantity", b."workOrderSizeId" INTO bundle
      FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."id" = NEW."bundleId";
    IF FOUND THEN
      IF operation_seen AND jsonb_typeof(operation."sizes") = 'array' AND jsonb_array_length(operation."sizes") > 0
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(operation."sizes") e WHERE e ->> 'workOrderSizeId' = bundle."workOrderSizeId"::text) THEN
        RAISE EXCEPTION 'supply: receipt line % brings back bundle % of a size its operation does not send out', NEW."id", NEW."bundleId"
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.subcontract-back', NEW."tenantId", NEW."bundleId", NEW."subcontractOperationId"), 0));
      SELECT coalesce(sum(l."goodQuantity" + l."defectiveQuantity" + l."scrappedQuantity"), 0) INTO back
        FROM "SubcontractReceiptLine" l
       WHERE l."tenantId" = NEW."tenantId" AND l."bundleId" = NEW."bundleId" AND l."subcontractOperationId" = NEW."subcontractOperationId";
      IF back + NEW."goodQuantity" + NEW."defectiveQuantity" + NEW."scrappedQuantity" > bundle."quantity" THEN
        RAISE EXCEPTION 'supply: bundle % holds % garment(s); % came back already for this operation, so receipt line % brings back too many', NEW."bundleId", bundle."quantity", back, NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SubcontractReceiptLine_check" BEFORE INSERT ON "SubcontractReceiptLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontract_receipt_line_check"();

-- =====================================================================================================================
-- Production (production.prisma)

-- OperationScan, INSERT: REDEFINES factory_operation_scan_check (202610283801_production_guards), its whole body. W1's
-- rules and words stand; W2b (B-W2a-25, -76): a scan names a subcontract receipt line only as a REPORT, never from a
-- floor session, with no worker, station or device; that REPORT skips the worker/station subject check (the workshop did
-- the work: no person is named) and carries the line's bundle, its operation's step of the work order and its counts
-- (good; scrapped as scrap; defective as rework). The rest (one standing report per bundle and operation, undo and
-- correction) is W1's.
CREATE OR REPLACE FUNCTION "factory_operation_scan_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
  bundle record;
  target record;
  standing record;
  outside record;
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
  -- W2b (B-W2a-25, -76): an outside operation is reported by its subcontract receipt line: a REPORT written by the office
  -- (or the system), never by a floor session, naming no worker, station or device.
  IF NEW."subcontractReceiptLineId" IS NOT NULL THEN
    IF NEW."kind" <> 'REPORT' THEN
      RAISE EXCEPTION 'production: scan % is a %; only a REPORT names the subcontract receipt line that reported it', NEW."id", NEW."kind"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime' THEN
      RAISE EXCEPTION 'production: a floor session never reports an outside operation (scan %); its subcontract receipt does', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."workerId" IS NOT NULL OR NEW."stationId" IS NOT NULL OR NEW."deviceId" IS NOT NULL THEN
      RAISE EXCEPTION 'production: scan % reports an outside operation from its subcontract receipt line; it names no worker, station or device (the workshop did the work)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
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
    IF NEW."subcontractReceiptLineId" IS NULL THEN
      PERFORM "factory_production_check_subject"(NEW."tenantId", NEW."siteId", NEW."workerId", NEW."stationId", 'scan', NEW."id");
    ELSE
      -- W2b: the line's bundle, its operation's step of the work order and its counts (good; scrapped as scrap;
      -- defective as rework).
      SELECT l."bundleId", l."goodQuantity", l."defectiveQuantity", l."scrappedQuantity", o."workOrderOperationId" INTO outside
        FROM "SubcontractReceiptLine" l
        JOIN "SubcontractOperation" o ON o."tenantId" = l."tenantId" AND o."id" = l."subcontractOperationId"
       WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."subcontractReceiptLineId";
      IF FOUND AND (outside."bundleId" IS DISTINCT FROM NEW."bundleId" OR outside."workOrderOperationId" <> NEW."workOrderOperationId"
                    OR (outside."goodQuantity", outside."scrappedQuantity", outside."defectiveQuantity")
                       IS DISTINCT FROM (NEW."goodQuantity", NEW."scrapQuantity", NEW."reworkQuantity")) THEN
        RAISE EXCEPTION 'production: scan % reports subcontract receipt line %: the line''s bundle, its operation of the work order, and its counts (good; scrapped as scrap; defective as rework)', NEW."id", NEW."subcontractReceiptLineId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
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
-- ScrapReason (W2b, B-W2a-18, -74; MES-125): its other languages are words keyed by language code ({ "ro": "…" }), its
-- icon an id and its colour #RRGGBB, as ReasonCode keeps them (factory_scrap_reason_guard keeps its code and labels).
CREATE FUNCTION "factory_scrap_reason_words_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(NEW."labelI18n") <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(NEW."labelI18n") w WHERE w.key !~ '^[a-z]{2,3}$' OR jsonb_typeof(w.value) <> 'string' OR btrim(w.value #>> '{}') = '') THEN
    RAISE EXCEPTION 'production: scrap reason % keeps its other languages as words keyed by language code ({ "ro": "…" })', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."icon" !~ '^[a-z][a-z0-9-]*$' OR NEW."colour" !~ '^#[0-9A-Fa-f]{6}$' THEN
    RAISE EXCEPTION 'production: scrap reason % names its icon by its id and its colour as #RRGGBB', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ScrapReason_words_guard" BEFORE INSERT OR UPDATE ON "ScrapReason"
  FOR EACH ROW EXECUTE FUNCTION "factory_scrap_reason_words_guard"();

-- Bundle, INSERT (W2b, B-W2a-13): a split reason only on a split bundle (parentBundleId), a code without spaces. It
-- never changes afterwards (factory_bundle_guard freezes every column it does not name).
CREATE FUNCTION "factory_bundle_split_reason_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."splitReason" IS NOT NULL AND (NEW."parentBundleId" IS NULL OR NEW."splitReason" !~ '^\S+$') THEN
    RAISE EXCEPTION 'production: bundle % says why it was split only when it is split from another, by a code without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Bundle_split_reason_check" BEFORE INSERT ON "Bundle"
  FOR EACH ROW EXECUTE FUNCTION "factory_bundle_split_reason_check"();

-- =====================================================================================================================
-- Work-order kits (kits.prisma)

-- WorkOrderKit (W2b, B-W2a-58; SCM-213):
--   INSERT     for a work order still open (DRAFT, RELEASED, IN_PROGRESS or ON_HOLD).
--   UPDATE     its work order and creation never change.
--   every row  marked complete with when and by whom (both or neither); its staging place, when named or changed, is
--              a location of the site that is not archived and not a workshop's (SUBCONTRACTOR).
--   DELETE     refused (a kit is opened again or left). TRUNCATE refused.
CREATE FUNCTION "factory_work_order_kit_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  work_state text;
  place record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory: the kit of work order % is opened again or left, never deleted', OLD."workOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT w."status"::text INTO work_state
      FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF FOUND AND work_state NOT IN ('DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD') THEN
      RAISE EXCEPTION 'inventory: work order % is %; a kit is staged only for an open work order', NEW."workOrderId", work_state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."workOrderId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."workOrderId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'inventory: kit % keeps its work order and creation', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."completedAt" IS NULL) <> (NEW."completedById" IS NULL) THEN
    RAISE EXCEPTION 'inventory: kit % is marked complete with when and by whom (both or neither)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stagingLocationId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."stagingLocationId" IS DISTINCT FROM OLD."stagingLocationId") THEN
    SELECT l."status"::text AS status, l."kind"::text AS kind INTO place
      FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."stagingLocationId";
    IF FOUND AND (place.status = 'ARCHIVED' OR place.kind = 'SUBCONTRACTOR') THEN
      RAISE EXCEPTION 'inventory: kit % is staged at a location of the site in use, not a workshop''s (location % is % %)', NEW."id", NEW."stagingLocationId", place.status, place.kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkOrderKit_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkOrderKit"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_kit_guard"();
