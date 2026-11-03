-- Written by hand (Prisma does not model triggers, partial indexes or expression indexes), after the generated
-- 202610317100_leather_stock_w2b_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- W2b schema wave 12/16 (B-W2b-80): leather grades and what they mean per article, hide marks, hide measures append-only,
-- shade groups, remnants, fabric rolls, the protector lot of a batch or a garment, consumables by pack, the scan-id kinds
-- ROLL and REMNANT, and the stock move reason REMNANT (features PRD-031, QHS-006, SCM-249, SCM-250, SCM-254, SCM-260, SCM-261,
-- SCM-263, MES-054, QHS-025, QHS-028). apps/factory-api's modules check all of this first, in words; these rules hold for
-- every login, the owner included. Every refusal is a check_violation (SQLSTATE 23514).
--
-- As in every guards migration: the tenant and site of a row are held by the policies (USING and WITH CHECK) and the
-- references, not here (no trigger compares "tenantId" or "siteId" of the row it guards, so a row moved out of a session's
-- scope meets row-level security first); a rule that reads another row skips a row this session cannot see (another
-- tenant's or site's: the policies refuse that write anyway); an UPDATE that changes nothing passes. A trigger reads only
-- tables (and columns) the role that fires it may read. "Everything but these columns" is compared as jsonb, so a column
-- added later is frozen too unless a later migration names it.
--
-- REMNANT is RETURN's twin: an offcut back from a work order. By every rule of the database it counts as a RETURN.
--
-- REDEFINED, each from its whole latest body (rules and words kept; the triggers stay, but for the one recreated below):
--   factory_number_series_document_kind,  (202610316901_followups_floor_w2b_guards) ROLL and REMNANT among the scan-id kinds.
--   factory_number_block_guard
--   factory_stock_move_check              (202610311001_followups_stock_w2b_guards) REMNANT enters one location, names its
--                                         work order, and is of a hide.
--   factory_cut_log_check                 (202610283801_production_guards) what a work order holds of a hide is net of its
--                                         REMNANT moves too.
--   factory_work_order_cost_entry_check   (202610312001_followups_quality_money_w2b_guards) a REMNANT takes its material off
--                                         the work order, as a RETURN does.
--   factory_hide_guard                    (202610311001_followups_stock_w2b_guards) gradeId and shadeGroupId change with the
--                                         other described columns.
-- RECREATED: the trigger "StockMove_bound_to_work_order" (…_inventory_issue_work_order_guards), its WHEN with REMNANT; its
-- function is untouched.
-- USED FROM WAVE 10 (…_inspection_plans_w2b_guards, on main): "factory_inspection_code_ok" and "factory_inspection_marks_ok".

CREATE FUNCTION "factory_leather_w2b_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'leather and roll stock: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['LeatherGrade', 'ItemGradeRule', 'HideMark', 'ShadeGroup', 'Remnant', 'FabricRoll', 'GarmentProtectorLot'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_leather_w2b_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- The place a remnant or a roll goes to takes stock: an archived location does not (the same rule as a move's).
CREATE FUNCTION "factory_leather_place_open"(tenant uuid, site uuid, place uuid, what text, record_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Location" l WHERE l."tenantId" = tenant AND l."siteId" = site AND l."id" = place AND l."status" = 'ARCHIVED') THEN
    RAISE EXCEPTION 'inventory: % %: location % is archived; it takes no stock', what, record_id, place
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- The shade group a hide or a roll takes: of its article, of its lot when the group is a lot's, of its colour when the group
-- has one, and its text says the group's label. `taking`: the group is being set now, so it must be in use.
CREATE FUNCTION "factory_shade_group_fits"(tenant uuid, group_id uuid, item uuid, lot uuid, shade text, taking boolean, what text, record_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  shade_group record;
  lot_colour uuid;
BEGIN
  SELECT g."itemId", g."itemColourId", g."lotId", g."label", g."active" INTO shade_group
    FROM "ShadeGroup" g WHERE g."tenantId" = tenant AND g."id" = group_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF shade_group."itemId" <> item OR shade_group."lotId" <> lot THEN
    RAISE EXCEPTION 'quality: % % takes a shade group of its own article and lot; group % ("%") is of another', what, record_id, group_id, shade_group."label"
      USING ERRCODE = 'check_violation';
  END IF;
  IF shade_group."itemColourId" IS NOT NULL THEN
    SELECT l."itemColourId" INTO lot_colour FROM "Lot" l WHERE l."tenantId" = tenant AND l."id" = lot;
    IF FOUND AND lot_colour IS DISTINCT FROM shade_group."itemColourId" THEN
      RAISE EXCEPTION 'quality: % % is of another colour than shade group % ("%")', what, record_id, group_id, shade_group."label"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF shade IS DISTINCT FROM shade_group."label" THEN
    RAISE EXCEPTION 'quality: % % names shade group "%"; its shade text says the same, not "%"', what, record_id, shade_group."label", coalesce(shade, '(none)')
      USING ERRCODE = 'check_violation';
  END IF;
  IF taking AND NOT shade_group."active" THEN
    RAISE EXCEPTION 'quality: shade group "%" is retired; % % does not take it', shade_group."label", what, record_id
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- NumberSeries and NumberBlock (…_followups_floor_w2b_guards): ROLL and REMNANT among the scan-id kinds.
CREATE OR REPLACE FUNCTION "factory_number_series_document_kind"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind"::text IN ('BUNDLE', 'HIDE', 'GARMENT_SERIAL', 'COUPON', 'ROLL', 'REMNANT') THEN
    RAISE EXCEPTION 'number series %: % is a scan-id kind; its numbers come from the tenant''s number blocks, never a series', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "factory_number_block_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  session_tenant uuid := NULLIF(current_setting('factory.tenant_id', true), '')::uuid;
  device_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'number block %: a block is closed, never deleted (its numbers stay handed out)', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."kind"::text NOT IN ('BUNDLE', 'HIDE', 'GARMENT_SERIAL', 'COUPON', 'ROLL', 'REMNANT') THEN
    RAISE EXCEPTION 'number block %: % is a document kind; its numbers come from a number series', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW."kind", NEW."purpose", NEW."fromRef", NEW."toRef", NEW."deviceId", NEW."requestId", NEW."createdAt")
       IS DISTINCT FROM (OLD."kind", OLD."purpose", OLD."fromRef", OLD."toRef", OLD."deviceId", OLD."requestId", OLD."createdAt") THEN
      RAISE EXCEPTION 'number block %: its kind, purpose, range, tablet and origin never change; close it instead', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND (NEW."status", NEW."closedAt", NEW."closedReason") IS DISTINCT FROM (OLD."status", OLD."closedAt", OLD."closedReason") THEN
      RAISE EXCEPTION 'number block %: a closed block stays closed', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" = 'CLOSED' AND OLD."status" = 'ACTIVE' THEN
      -- The same lock as a use of its numbers: a use in flight lands before the closing, or sees the block closed.
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.number-block', OLD."tenantId"::text, OLD."id"::text), 0));
    END IF;
  ELSE
    IF NEW."fromRef" < 1 OR NEW."toRef" < NEW."fromRef" OR NEW."toRef" - NEW."fromRef" + 1 > 1000 THEN
      RAISE EXCEPTION 'number block %: a block holds 1 to 1000 references from 1 up (% to %)', NEW."id", NEW."fromRef", NEW."toRef"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'number block %: a block starts open', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."purpose" = 'DEVICE') <> (NEW."deviceId" IS NOT NULL) THEN
      RAISE EXCEPTION 'number block %: a DEVICE block names its tablet and an ONLINE block none', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" = 'CLOSED' AND (NEW."closedAt" IS NULL OR NEW."closedReason" IS NULL OR btrim(NEW."closedReason") = '') THEN
    RAISE EXCEPTION 'number block %: a closed block says when and why it was closed', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'ACTIVE' AND (NEW."closedAt" IS NOT NULL OR NEW."closedReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'number block %: an open block has no closing time or reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;

  -- INSERT, in the session's own tenant (another tenant's row is left to row-level security).
  IF NEW."tenantId" IS NULL OR (session_tenant IS NOT NULL AND NEW."tenantId" IS DISTINCT FROM session_tenant) THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.scan-ids', NEW."tenantId"::text, NEW."kind"::text), 0));
  IF EXISTS (SELECT 1 FROM "NumberBlock" b WHERE b."tenantId" = NEW."tenantId" AND b."kind" = NEW."kind" AND b."toRef" >= NEW."fromRef") THEN
    RAISE EXCEPTION 'number block %: % references from % were handed out already; a block starts above every block of its kind', NEW."id", NEW."kind", NEW."fromRef"
      USING ERRCODE = 'unique_violation';
  END IF;
  IF NEW."purpose" = 'DEVICE' THEN
    SELECT d."status"::text INTO device_status FROM "Device" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."deviceId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'number block %: tablet % is not one this session may reserve numbers for (unknown, or at another site)', NEW."id", NEW."deviceId"
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF device_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'number block %: tablet % is %; only an enrolled, active tablet gets numbers', NEW."id", NEW."deviceId", device_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- StockMove (…_followups_stock_w2b_guards), whole: REMNANT enters one location, names its work order, and is of a hide.
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
    IF (NEW."reason" IN ('OPENING', 'RECEIPT', 'RETURN', 'CUSTOMER_RETURN', 'REMNANT') AND NOT enters)
       OR (NEW."reason" IN ('ISSUE', 'SCRAP', 'SUPPLIER_RETURN', 'SHIPMENT') AND NOT leaves)
       OR (NEW."reason" = 'TRANSFER' AND (NEW."fromLocationId" IS NULL OR NEW."toLocationId" IS NULL))
       OR (NEW."reason" IN ('ADJUSTMENT', 'COUNT') AND NOT (enters OR leaves)) THEN
      RAISE EXCEPTION 'inventory: stock move % is a % with the wrong locations (OPENING, RECEIPT, RETURN, CUSTOMER_RETURN and REMNANT only enter one; ISSUE, SCRAP, SUPPLIER_RETURN and SHIPMENT only leave one; TRANSFER both; ADJUSTMENT and COUNT one side)', NEW."id", NEW."reason"
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
  IF NEW."reason" IN ('ISSUE', 'RETURN', 'REMNANT') AND NEW."workOrderId" IS NULL THEN
    RAISE EXCEPTION 'inventory: stock move % is an % without its work order', NEW."id", NEW."reason"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b wave 12/16: a REMNANT is an offcut of a hide.
  IF NEW."reason" = 'REMNANT' AND NEW."hideId" IS NULL THEN
    RAISE EXCEPTION 'inventory: stock move % is a REMNANT without its hide', NEW."id"
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

-- REMNANT is bound to its work order as a RETURN is: from any work order but a DRAFT one. Its function is untouched.
DROP TRIGGER "StockMove_bound_to_work_order" ON "StockMove";
CREATE TRIGGER "StockMove_bound_to_work_order" BEFORE INSERT ON "StockMove"
  FOR EACH ROW WHEN (NEW."reason" IN ('ISSUE', 'RETURN', 'REMNANT'))
  EXECUTE FUNCTION "factory_stock_move_work_order_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- CutLog (…_production_guards), whole: what a work order holds of a hide is net of its REMNANT moves too.
CREATE OR REPLACE FUNCTION "factory_cut_log_check"() RETURNS trigger LANGUAGE plpgsql AS $$
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
     AND m."hideId" = NEW."hideId" AND m."workOrderId" = NEW."workOrderId" AND m."reason" IN ('ISSUE', 'RETURN', 'REMNANT');
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

-- ---------------------------------------------------------------------------------------------------------------------
-- WorkOrderCostEntry (…_followups_quality_money_w2b_guards), whole: a REMNANT takes its material off the work order.
CREATE OR REPLACE FUNCTION "factory_work_order_cost_entry_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_company uuid;
  method text;
  locked_at timestamptz;
  original record;
  move record;
  scan_order uuid;
  billed_order uuid;
  rework_order uuid;
BEGIN
  SELECT w."companyId" INTO order_company FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
  IF FOUND AND order_company <> NEW."companyId" THEN
    RAISE EXCEPTION 'costing: cost entry % is of work order %''s company', NEW."id", NEW."workOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currency" !~ '^[A-Z]{3}$' OR btrim(NEW."idempotencyKey") = '' OR NEW."unitCost" < 0 OR NEW."standardUnitCost" < 0
     OR (NEW."sourceType" IS NULL) <> (NEW."sourceId" IS NULL) OR btrim(NEW."sourceType") = '' THEN
    RAISE EXCEPTION 'costing: cost entry % has an ISO currency, a key, unit costs of 0 or more, and a source type and id together', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s."costingMethod"::text, s."methodLockedAt" INTO method, locked_at FROM "CostingSettings" s
   WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId";
  IF NOT FOUND THEN
    SELECT s."costingMethod"::text, s."methodLockedAt" INTO method, locked_at FROM "CostingSettings" s
     WHERE s."tenantId" = NEW."tenantId" AND s."companyId" IS NULL;
  END IF;
  IF coalesce(method, 'UNDECIDED') <> NEW."costingMethod"::text THEN
    RAISE EXCEPTION 'costing: cost entry % is valued by %, but the company''s costing method is %', NEW."id", NEW."costingMethod", coalesce(method, 'UNDECIDED')
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."costingMethod" <> 'UNDECIDED' AND locked_at IS NULL THEN
    RAISE EXCEPTION 'costing: cost entry % relies on the costing method %; lock the method first (it is locked once used)', NEW."id", NEW."costingMethod"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."reversalOfId" IS NOT NULL THEN
    SELECT e."kind"::text AS kind, e."amount" AS amount, e."reversalOfId" AS reversal_of INTO original FROM "WorkOrderCostEntry" e
     WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."reversalOfId";
    IF FOUND THEN
      IF original.reversal_of IS NOT NULL OR original.kind <> NEW."kind"::text OR NEW."amount" <> -original.amount THEN
        RAISE EXCEPTION 'costing: reversal % takes back entry % exactly: the same kind and the opposite amount (%), never a reversal', NEW."id", NEW."reversalOfId", -original.amount
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "WorkOrderCostEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."reversalOfId" = NEW."reversalOfId") THEN
        RAISE EXCEPTION 'costing: cost entry % is reversed already', NEW."reversalOfId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF btrim(coalesce(NEW."reason", '')) = '' THEN
      RAISE EXCEPTION 'costing: reversal % says why', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'MATERIAL' THEN
    IF NEW."itemId" IS NULL OR NEW."quantity" IS NULL OR NEW."stockMoveId" IS NULL OR NEW."minutes" IS NOT NULL THEN
      RAISE EXCEPTION 'costing: material entry % names its item, quantity and stock move (no minutes)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT m."reason"::text AS reason, m."workOrderId" AS work_order, m."itemId" AS item, m."baseQuantity" AS quantity INTO move
      FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."stockMoveId";
    IF FOUND AND (move.work_order IS DISTINCT FROM NEW."workOrderId" OR move.item <> NEW."itemId" OR abs(NEW."quantity") <> move.quantity
                  OR NOT ((move.reason = 'ISSUE' AND NEW."quantity" > 0 AND NEW."amount" >= 0)
                       OR (move.reason IN ('RETURN', 'REMNANT') AND NEW."quantity" < 0 AND NEW."amount" <= 0))) THEN
      RAISE EXCEPTION 'costing: material entry % posts stock move % (% of %): an ISSUE to the work order adds its base quantity and cost, a RETURN or REMNANT from it takes them off', NEW."id", NEW."stockMoveId", move.reason, move.quantity
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'SCRAP' THEN
    IF NEW."stockMoveId" IS NOT NULL AND NEW."operationScanId" IS NOT NULL THEN
      RAISE EXCEPTION 'costing: scrap entry % names its SCRAP move or the scan that scrapped (one of them)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b: neither: the scrap of a rework order of this work order opened by hand, with no scan (sourceType
    -- ReworkOrder, sourceId the rework order).
    IF NEW."stockMoveId" IS NULL AND NEW."operationScanId" IS NULL THEN
      IF NEW."sourceType" IS DISTINCT FROM 'ReworkOrder' THEN
        RAISE EXCEPTION 'costing: scrap entry % names its SCRAP move, the scan that scrapped, or the rework order of the work order that scrapped (sourceType ReworkOrder)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."workOrderId" INTO rework_order FROM "ReworkOrder" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."sourceId";
      IF NOT FOUND OR rework_order <> NEW."workOrderId" THEN
        RAISE EXCEPTION 'costing: scrap entry % names rework order %, which is not a rework order of work order %', NEW."id", NEW."sourceId", NEW."workOrderId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."stockMoveId" IS NOT NULL THEN
      SELECT m."reason"::text AS reason, m."workOrderId" AS work_order INTO move FROM "StockMove" m
       WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."stockMoveId";
      IF FOUND AND (move.reason <> 'SCRAP' OR move.work_order IS DISTINCT FROM NEW."workOrderId") THEN
        RAISE EXCEPTION 'costing: scrap entry % names stock move %, a % move not of this work order', NEW."id", NEW."stockMoveId", move.reason
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."kind" = 'LABOUR' THEN
    IF NEW."operationScanId" IS NULL OR NEW."minutes" IS NULL OR NEW."minutes" <= 0 OR NEW."amount" < 0 OR NEW."quantity" IS NOT NULL THEN
      RAISE EXCEPTION 'costing: labour entry % names its scan and the minutes earned (above 0), with an amount of 0 or more (never a person''s total)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'SUBCONTRACT' THEN
    IF NEW."subcontractOrderId" IS NULL AND NEW."supplierInvoiceLineId" IS NULL THEN
      RAISE EXCEPTION 'costing: subcontract entry % names its subcontract order or the subcontractor''s invoice line', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."supplierInvoiceLineId" IS NOT NULL THEN
      SELECT o."workOrderId" INTO billed_order FROM "SupplierInvoiceLine" l
        JOIN "SubcontractOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."subcontractOrderId"
       WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."supplierInvoiceLineId";
      IF NOT FOUND OR billed_order <> NEW."workOrderId" THEN
        RAISE EXCEPTION 'costing: subcontract entry % names invoice line %, which bills no subcontract order of this work order', NEW."id", NEW."supplierInvoiceLineId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."kind" = 'COMPLETION' AND NEW."amount" > 0 THEN
    RAISE EXCEPTION 'costing: completion entry % moves value out of the work order (an amount of 0 or less)', NEW."id"
      USING ERRCODE = 'check_violation';
  ELSIF NEW."kind" = 'ADJUSTMENT' AND btrim(coalesce(NEW."reason", '')) = '' THEN
    RAISE EXCEPTION 'costing: adjustment % says why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."operationScanId" IS NOT NULL THEN
    SELECT s."workOrderId" INTO scan_order FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."operationScanId";
    IF FOUND AND scan_order <> NEW."workOrderId" THEN
      RAISE EXCEPTION 'costing: cost entry % names scan %, which is of another work order', NEW."id", NEW."operationScanId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", "factory_money_rome_day"(NEW."occurredAt"), format('cost entry %s of work order %s', NEW."id", NEW."workOrderId"));
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Hide (…_followups_stock_w2b_guards), whole: gradeId and shadeGroupId change with the other described columns.
CREATE OR REPLACE FUNCTION "factory_hide_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  described CONSTANT text[] := ARRAY['grade', 'shade', 'gradeId', 'shadeGroupId', 'thicknessMm', 'defects', 'state', 'closingCutLogId', 'previousState', 'version', 'updatedAt'];
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

-- ---------------------------------------------------------------------------------------------------------------------
-- Hide: a grade or shade group named as a record says the same as the text W1 keeps (labels and history read the text).
--   every row  gradeId: the text is the grade's code. shadeGroupId: the group is of the hide's article, lot and colour, and
--              the text is its label.
--   when set   a retired grade or group is not taken. One a hide has already stays when it is retired.
CREATE FUNCTION "factory_hide_grade_shade_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  grade_row record;
BEGIN
  IF NEW."gradeId" IS NOT NULL THEN
    SELECT g."code", g."active" INTO grade_row FROM "LeatherGrade" g WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."gradeId";
    IF FOUND THEN
      IF NEW."grade" IS DISTINCT FROM grade_row."code" THEN
        RAISE EXCEPTION 'inventory: hide % names grade "%"; its grade text says the same, not "%"', NEW."id", grade_row."code", coalesce(NEW."grade", '(none)')
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT grade_row."active" AND (TG_OP = 'INSERT' OR NEW."gradeId" IS DISTINCT FROM OLD."gradeId") THEN
        RAISE EXCEPTION 'inventory: grade "%" is retired; hide % does not take it', grade_row."code", NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."shadeGroupId" IS NOT NULL THEN
    PERFORM "factory_shade_group_fits"(NEW."tenantId", NEW."shadeGroupId", NEW."itemId", NEW."lotId", NEW."shade",
                                       TG_OP = 'INSERT' OR NEW."shadeGroupId" IS DISTINCT FROM OLD."shadeGroupId", 'hide', NEW."id");
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Hide_grade_shade_check" BEFORE INSERT OR UPDATE OF "gradeId", "shadeGroupId", "grade", "shade" ON "Hide"
  FOR EACH ROW EXECUTE FUNCTION "factory_hide_grade_shade_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Item (SCM-263): a consumable by the pack: how many base units a pack holds, above 0, and what it is, both or neither.
CREATE FUNCTION "factory_item_pack_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."packSize" IS NULL) <> (NEW."packUom" IS NULL) OR NEW."packSize" <= 0 THEN
    RAISE EXCEPTION 'product: item % has a pack size above 0 and its pack unit, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Item_pack_check" BEFORE INSERT OR UPDATE OF "packSize", "packUom" ON "Item"
  FOR EACH ROW EXECUTE FUNCTION "factory_item_pack_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- LeatherGrade
--   every row  a code without spaces, words in Italian and English, the other languages an object, a usable share from 0 to
--              100.
--   UPDATE     the code and the creation never change (Hide.grade copies the code).
--   DELETE     refused: a grade is retired. TRUNCATE refused.
CREATE FUNCTION "factory_leather_grade_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory: leather grade % is retired, never deleted', OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."code", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."code", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'inventory: the code of leather grade % never changes (hides copy it)', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_inspection_code_ok"(NEW."code") OR btrim(NEW."labelIt") = '' OR btrim(NEW."labelEn") = '' OR jsonb_typeof(NEW."labelI18n") <> 'object' THEN
    RAISE EXCEPTION 'inventory: leather grade % has a code without spaces and its words', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."usableShare" NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'inventory: the usable share of leather grade % is a percent from 0 to 100, not %', NEW."code", NEW."usableShare"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LeatherGrade_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LeatherGrade"
  FOR EACH ROW EXECUTE FUNCTION "factory_leather_grade_guard"();

-- ItemGradeRule
--   every row  a usable share from 0 to 100; no blank panel.
--   INSERT     an article tracked by HIDE, a grade in use.
--   UPDATE     the article, the grade and the creation never change.
--   DELETE     refused: a rule is retired. TRUNCATE refused. At most one active rule per article and grade.
CREATE FUNCTION "factory_item_grade_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_tracking text;
  grade_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory: grade rule % is retired, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."itemId", NEW."gradeId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."itemId", OLD."gradeId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'inventory: grade rule %: its article and grade never change (retire it and add another)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT i."tracking"::text INTO item_tracking FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND item_tracking <> 'HIDE' THEN
      RAISE EXCEPTION 'inventory: grade rule %: item % is tracked by %; grades are of an article tracked by HIDE', NEW."id", NEW."itemId", item_tracking
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT g."active" INTO grade_active FROM "LeatherGrade" g WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."gradeId";
    IF FOUND AND NOT grade_active THEN
      RAISE EXCEPTION 'inventory: grade rule %: grade % is retired', NEW."id", NEW."gradeId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."usableShare" NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'inventory: the usable share of grade rule % is a percent from 0 to 100, not %', NEW."id", NEW."usableShare"
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW."panels") panel WHERE btrim(panel) = '') THEN
    RAISE EXCEPTION 'inventory: grade rule % names its panels in words', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ItemGradeRule_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ItemGradeRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_item_grade_rule_guard"();

CREATE UNIQUE INDEX "ItemGradeRule_one_active" ON "ItemGradeRule" ("tenantId", "itemId", "gradeId") WHERE "active";

-- ---------------------------------------------------------------------------------------------------------------------
-- ShadeGroup
--   every row  a label in words; a site exactly with a lot; of an article tracked by HIDE or LOT; a lot's group is of the
--              lot's colour.
--   UPDATE     the article, colour, site, lot and creation never change.
--   DELETE     refused: a group is retired. TRUNCATE refused. A label once per article, colour and lot (Prisma's unique key
--              leaves out rows with a null; the expression index below does not).
CREATE FUNCTION "factory_shade_group_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_tracking text;
  lot_colour uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: shade group "%" is retired, never deleted', OLD."label"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."itemId", NEW."itemColourId", NEW."lotSiteId", NEW."lotId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."itemId", OLD."itemColourId", OLD."lotSiteId", OLD."lotId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: shade group "%": its article, colour and lot never change', OLD."label"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."label") = '' THEN
    RAISE EXCEPTION 'quality: shade group % has a label', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."lotSiteId" IS NULL) <> (NEW."lotId" IS NULL) THEN
    RAISE EXCEPTION 'quality: shade group % is one lot''s, with the lot''s site, or the article''s, with neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."tracking"::text INTO item_tracking FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
  IF FOUND AND item_tracking NOT IN ('HIDE', 'LOT') THEN
    RAISE EXCEPTION 'quality: shade group %: item % is tracked by %; shade groups are of hides and lots', NEW."id", NEW."itemId", item_tracking
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lotId" IS NOT NULL THEN
    SELECT l."itemColourId" INTO lot_colour FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."lotId";
    IF FOUND AND lot_colour IS DISTINCT FROM NEW."itemColourId" THEN
      RAISE EXCEPTION 'quality: shade group % of lot % is of the lot''s colour', NEW."id", NEW."lotId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ShadeGroup_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ShadeGroup"
  FOR EACH ROW EXECUTE FUNCTION "factory_shade_group_guard"();

CREATE UNIQUE INDEX "ShadeGroup_one_label" ON "ShadeGroup" (
  "tenantId", "itemId",
  COALESCE("itemColourId", '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE("lotId", '00000000-0000-0000-0000-000000000000'::uuid),
  "label"
);

-- ---------------------------------------------------------------------------------------------------------------------
-- HideMark (MES-054)
--   every row  a point from 0 to 1 on each axis; a DEFECT has its code and no outline; a ZONE has its grade, an outline of
--              points from 0 to 1, and no defect code; withdrawn: when, by whom and why, all three or none.
--   INSERT     not withdrawn; a defect of the library (never a category), in use; a grade in use.
--   UPDATE     only the withdrawal, once (known defects are evidence for a claim).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_hide_mark_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  withdrawing CONSTANT text[] := ARRAY['voidedAt', 'voidedById', 'voidReason', 'version', 'updatedAt'];
  defect record;
  grade_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory: hide mark % is withdrawn, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || withdrawing)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || withdrawing)) THEN
      RAISE EXCEPTION 'inventory: hide mark % never changes; withdraw it and add another', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."voidedAt" IS NOT NULL AND (NEW."voidedAt", NEW."voidedById", NEW."voidReason") IS DISTINCT FROM (OLD."voidedAt", OLD."voidedById", OLD."voidReason") THEN
      RAISE EXCEPTION 'inventory: hide mark % is withdrawn already', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'inventory: hide mark % is new; it is not withdrawn', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nonnulls(NEW."voidedAt", NEW."voidedById", NEW."voidReason") NOT IN (0, 3) OR btrim(NEW."voidReason") = '' THEN
    RAISE EXCEPTION 'inventory: hide mark % says when, by whom and why it was withdrawn, or none of it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."x" NOT BETWEEN 0 AND 1 OR NEW."y" NOT BETWEEN 0 AND 1 OR NOT "factory_inspection_marks_ok"(NEW."outline") THEN
    RAISE EXCEPTION 'inventory: hide mark % lies on the hide: x, y and its outline''s points from 0 to 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'DEFECT' AND (NEW."defectCodeId" IS NULL OR jsonb_array_length(NEW."outline") > 0))
     OR (NEW."kind" = 'ZONE' AND (NEW."zoneGradeId" IS NULL OR NEW."defectCodeId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'inventory: hide mark % is a %: a DEFECT has its code and no outline, a ZONE its grade and no defect code', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."defectCodeId" IS NOT NULL THEN
      SELECT d."parentId", d."active" INTO defect FROM "DefectCode" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."defectCodeId";
      IF FOUND AND (defect."parentId" IS NULL OR NOT defect."active") THEN
        RAISE EXCEPTION 'inventory: hide mark % names a defect of the library in use, not a category or a retired code', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."zoneGradeId" IS NOT NULL THEN
      SELECT g."active" INTO grade_active FROM "LeatherGrade" g WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."zoneGradeId";
      IF FOUND AND NOT grade_active THEN
        RAISE EXCEPTION 'inventory: hide mark % names a retired grade', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "HideMark_guard" BEFORE INSERT OR UPDATE OR DELETE ON "HideMark"
  FOR EACH ROW EXECUTE FUNCTION "factory_hide_mark_guard"();

-- HideMeasure (SCM-249, QHS-025): append-only, for every login (no update or delete grant either).
--   INSERT     areas above 0 in an area unit; by exactly one person: an office user or a floor worker.
CREATE FUNCTION "factory_hide_measure_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory: hide measures are append-only: % on "%" is refused (a wrong measure is followed by a new row)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_hide_measure_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."measuredArea" <= 0 OR NEW."declaredArea" <= 0 OR NEW."areaUom" NOT IN ('M2', 'DM2', 'FT2') THEN
    RAISE EXCEPTION 'inventory: hide measure % has its areas above 0, in M2, DM2 or FT2', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nonnulls(NEW."measuredById", NEW."measuredByWorkerId") <> 1 THEN
    RAISE EXCEPTION 'inventory: hide measure % says who measured: an office user or a floor worker, exactly one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "HideMeasure_check" BEFORE INSERT ON "HideMeasure"
  FOR EACH ROW EXECUTE FUNCTION "factory_hide_measure_check"();
CREATE TRIGGER "HideMeasure_append_only" BEFORE UPDATE OR DELETE ON "HideMeasure"
  FOR EACH ROW EXECUTE FUNCTION "factory_hide_measure_append_only"();
CREATE TRIGGER "HideMeasure_no_truncate" BEFORE TRUNCATE ON "HideMeasure"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_hide_measure_append_only"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Remnant (SCM-254)
--   every row  an area above 0 in an area unit, and in the base unit; entered in the base unit, both say the same; a tag
--              without spaces; a place while IN_STOCK, not an archived one when it goes there.
--   INSERT     IN_STOCK; its move is a REMNANT or a RETURN, not a reversal and not reversed, of its hide, entering its place;
--              the live pieces of one move never add up to more than the move (under a lock per move).
--   UPDATE     only the grade, the place, the state and the note change. The state moves IN_STOCK → ISSUED | SCRAPPED | VOID,
--              ISSUED → IN_STOCK | USED, USED → ISSUED, SCRAPPED → IN_STOCK; VOID only once its move is reversed, and a VOID
--              remnant never changes.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_remnant_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  changing CONSTANT text[] := ARRAY['gradeId', 'locationId', 'state', 'note', 'version', 'updatedAt'];
  base_uom text;
  move record;
  taken numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory: remnant % is voided, never deleted', OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."state" = 'VOID' THEN
      RAISE EXCEPTION 'inventory: remnant % is VOID; it never changes', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - (kept || changing)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || changing)) THEN
      RAISE EXCEPTION 'inventory: the tag, hide, area and move of remnant % never change', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."state" <> OLD."state" THEN
      IF NOT ((OLD."state" = 'IN_STOCK' AND NEW."state" IN ('ISSUED', 'SCRAPPED', 'VOID'))
              OR (OLD."state" = 'ISSUED' AND NEW."state" IN ('IN_STOCK', 'USED'))
              OR (OLD."state" = 'USED' AND NEW."state" = 'ISSUED')
              OR (OLD."state" = 'SCRAPPED' AND NEW."state" = 'IN_STOCK')) THEN
        RAISE EXCEPTION 'inventory: remnant % does not go from % to %', OLD."code", OLD."state", NEW."state"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."state" = 'VOID'
         AND NOT EXISTS (SELECT 1 FROM "StockMove" r WHERE r."tenantId" = NEW."tenantId" AND r."siteId" = NEW."siteId" AND r."reversalOfId" = NEW."moveId") THEN
        RAISE EXCEPTION 'inventory: remnant % is VOID only once the move that put it into stock is reversed', OLD."code"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."state" <> 'IN_STOCK' THEN
    RAISE EXCEPTION 'inventory: remnant % starts IN_STOCK', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."area" <= 0 OR NEW."baseArea" <= 0 OR NEW."areaUom" NOT IN ('M2', 'DM2', 'FT2') OR NOT "factory_inspection_code_ok"(NEW."code") THEN
    RAISE EXCEPTION 'inventory: remnant % has a tag without spaces and an area above 0 in M2, DM2 or FT2 (and in its base unit)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."state" = 'IN_STOCK' AND NEW."locationId" IS NULL THEN
    RAISE EXCEPTION 'inventory: remnant % is in stock, so it says where it lies', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."locationId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."locationId" IS DISTINCT FROM OLD."locationId") THEN
    PERFORM "factory_leather_place_open"(NEW."tenantId", NEW."siteId", NEW."locationId", 'remnant', NEW."id");
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT i."baseUom"::text INTO base_uom
      FROM "Hide" h JOIN "Item" i ON i."tenantId" = h."tenantId" AND i."id" = h."itemId"
     WHERE h."tenantId" = NEW."tenantId" AND h."siteId" = NEW."siteId" AND h."id" = NEW."hideId";
    IF FOUND AND NEW."areaUom"::text = base_uom AND NEW."area" <> NEW."baseArea" THEN
      RAISE EXCEPTION 'inventory: remnant % is entered in the base unit %; its area is its base area', NEW."code", base_uom
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT m."reason"::text AS reason, m."hideId", m."toLocationId", m."baseQuantity", m."reversalOfId" INTO move
      FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."moveId";
    IF FOUND THEN
      IF move.reason NOT IN ('REMNANT', 'RETURN') OR move."reversalOfId" IS NOT NULL OR move."hideId" IS DISTINCT FROM NEW."hideId"
         OR move."toLocationId" IS DISTINCT FROM NEW."locationId" THEN
        RAISE EXCEPTION 'inventory: remnant % names the move that put it into stock: a REMNANT or RETURN of its hide, entering its place, not a reversal', NEW."code"
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "StockMove" r WHERE r."tenantId" = NEW."tenantId" AND r."siteId" = NEW."siteId" AND r."reversalOfId" = NEW."moveId") THEN
        RAISE EXCEPTION 'inventory: remnant %: move % was reversed; nothing of it is in stock', NEW."code", NEW."moveId"
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.remnant-move', NEW."tenantId", NEW."moveId"), 0));
      SELECT coalesce(sum(r."baseArea"), 0) INTO taken
        FROM "Remnant" r WHERE r."tenantId" = NEW."tenantId" AND r."siteId" = NEW."siteId" AND r."moveId" = NEW."moveId" AND r."state" <> 'VOID';
      IF taken + NEW."baseArea" > move."baseQuantity" THEN
        RAISE EXCEPTION 'inventory: remnant %: move % brought back %, and % of it is tagged already; % does not fit', NEW."code", NEW."moveId", move."baseQuantity", taken, NEW."baseArea"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Remnant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Remnant"
  FOR EACH ROW EXECUTE FUNCTION "factory_remnant_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- FabricRoll (SCM-260)
--   every row  a tag without spaces; a length above 0 in a length unit, and what is left from 0 to it; a width above 0;
--              shrinkage from 0 to 100; the state says what the length left says: FULL all of it, PARTIAL and END some of it,
--              CONSUMED none (SCRAPPED and RETURNED left the stock with what they had); a shade group of its article, lot and
--              colour, whose label its shade text says; not an archived place when it goes there.
--   INSERT     a lot of an item tracked by LOT.
--   UPDATE     the tag, the lot and the length received never change.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_fabric_roll_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  changing CONSTANT text[] := ARRAY['supplierRollRef', 'lengthLeft', 'widthCm', 'shade', 'shadeGroupId', 'shrinkageLengthPercent', 'shrinkageWidthPercent',
                                    'shrinkageGroup', 'defects', 'locationId', 'state', 'note', 'version', 'updatedAt'];
  item_tracking text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory: fabric roll % is never deleted', OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || changing)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || changing)) THEN
      RAISE EXCEPTION 'inventory: the tag, lot and length received of fabric roll % never change (a correction is an adjustment move and a new length left)', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT i."tracking"::text INTO item_tracking FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND item_tracking <> 'LOT' THEN
      RAISE EXCEPTION 'inventory: fabric roll %: item % is tracked by %; rolls are parts of a lot', NEW."code", NEW."itemId", item_tracking
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_inspection_code_ok"(NEW."code") OR NEW."length" <= 0 OR NEW."uom" NOT IN ('M', 'CM', 'MM') OR NEW."lengthLeft" NOT BETWEEN 0 AND NEW."length" THEN
    RAISE EXCEPTION 'inventory: fabric roll % has a tag without spaces, a length above 0 in M, CM or MM, and what is left from 0 to it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."widthCm" <= 0 OR NEW."shrinkageLengthPercent" NOT BETWEEN 0 AND 100 OR NEW."shrinkageWidthPercent" NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'inventory: fabric roll % has a width above 0 and shrinkage from 0 to 100 percent', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."state" = 'FULL' AND NEW."lengthLeft" <> NEW."length")
     OR (NEW."state" IN ('PARTIAL', 'END') AND (NEW."lengthLeft" = 0 OR NEW."lengthLeft" = NEW."length"))
     OR (NEW."state" = 'CONSUMED' AND NEW."lengthLeft" <> 0) THEN
    RAISE EXCEPTION 'inventory: fabric roll % is % with % of % left', NEW."code", NEW."state", NEW."lengthLeft", NEW."length"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shadeGroupId" IS NOT NULL THEN
    PERFORM "factory_shade_group_fits"(NEW."tenantId", NEW."shadeGroupId", NEW."itemId", NEW."lotId", NEW."shade",
                                       TG_OP = 'INSERT' OR NEW."shadeGroupId" IS DISTINCT FROM OLD."shadeGroupId", 'fabric roll', NEW."id");
  END IF;
  IF NEW."locationId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."locationId" IS DISTINCT FROM OLD."locationId") THEN
    PERFORM "factory_leather_place_open"(NEW."tenantId", NEW."siteId", NEW."locationId", 'fabric roll', NEW."id");
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "FabricRoll_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FabricRoll"
  FOR EACH ROW EXECUTE FUNCTION "factory_fabric_roll_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- GarmentProtectorLot (SCM-261): a record of what was built in, so a lot's quality status is no condition (a lot held after
-- the fact must still be recorded: that is what the recall reads).
--   every row  a placement in words when it has one; withdrawn: when, by whom and why, all three or none.
--   INSERT     not withdrawn; a work order that is being or was made (not a DRAFT or CANCELLED one); a lot of a protector
--              (kind PROTECTOR, or marked as a PPE component).
--   UPDATE     only the withdrawal, once.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_garment_protector_lot_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  withdrawing CONSTANT text[] := ARRAY['voidedAt', 'voidedById', 'voidReason', 'version', 'updatedAt'];
  order_state text;
  item record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: protector lot row % is withdrawn, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || withdrawing)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || withdrawing)) THEN
      RAISE EXCEPTION 'quality: protector lot row % never changes; withdraw it and add another', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."voidedAt" IS NOT NULL AND (NEW."voidedAt", NEW."voidedById", NEW."voidReason") IS DISTINCT FROM (OLD."voidedAt", OLD."voidedById", OLD."voidReason") THEN
      RAISE EXCEPTION 'quality: protector lot row % is withdrawn already', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'quality: protector lot row % is new; it is not withdrawn', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF FOUND AND order_state IN ('DRAFT', 'CANCELLED') THEN
      RAISE EXCEPTION 'quality: protector lot row %: work order % is %; nothing was built', NEW."id", NEW."workOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."kind"::text AS kind, i."isPpeComponent" INTO item FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND item.kind <> 'PROTECTOR' AND NOT item."isPpeComponent" THEN
      RAISE EXCEPTION 'quality: protector lot row %: item % is no protector (kind PROTECTOR, or a PPE component)', NEW."id", NEW."itemId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF num_nonnulls(NEW."voidedAt", NEW."voidedById", NEW."voidReason") NOT IN (0, 3) OR btrim(NEW."voidReason") = '' THEN
    RAISE EXCEPTION 'quality: protector lot row % says when, by whom and why it was withdrawn, or none of it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."placement") = '' THEN
    RAISE EXCEPTION 'quality: protector lot row % names its placement in words, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "GarmentProtectorLot_guard" BEFORE INSERT OR UPDATE OR DELETE ON "GarmentProtectorLot"
  FOR EACH ROW EXECUTE FUNCTION "factory_garment_protector_lot_guard"();
