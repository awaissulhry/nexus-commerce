-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202610283700_supply_inventory and before the policy migration. When the migrations are renumbered, keep this file as
-- it is under its new timestamp.

-- Supply and inventory (plan A1 §2.1 "Quantities", "Append-only", §2.5 "Purchase order", "Lot"; PLAN §2.8 "Cr VI",
-- §4.7 stages 08-buy, 09a-receive, 09b-cr6, 11a-issue; features SCM-053, SCM-113, SCM-117, SCM-176, SCM-189, SCM-192,
-- SCM-194, SCM-253, PLN-062, QHS-029). apps/factory-api's modules check all of this first; these rules hold for every
-- login, the owner included. The tenant, site and party of a row are held by the policies (USING and WITH CHECK) and by
-- the references, not here: the triggers leave "tenantId", "siteId" (and, where a partner may write, "partyId") to
-- them. Every refusal is a check_violation (SQLSTATE 23514): a restrict_violation reaches a Prisma model call as P2003
-- without its message. A rule that reads another row skips a row this session cannot see (another tenant's or site's):
-- the policies refuse that write anyway. A trigger reads only tables (and columns) the role that fires it may read.
--
-- "Everything but these columns" is compared as jsonb (to_jsonb(row) minus the named keys), so a column added later is
-- frozen too unless a later migration names it.

CREATE FUNCTION "factory_supply_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'supply: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- PurchaseOrder (SCM-053; A1 §2.5)
--   INSERT     an order starts as DRAFT.
--   UPDATE     an UPDATE that changes nothing passes; the company, number and creation never change; the status moves
--              DRAFT → SENT | CANCELLED, SENT → CONFIRMED | DECLINED | PARTLY_RECEIVED | RECEIVED | DRAFT | CANCELLED,
--              DECLINED → DRAFT | CANCELLED, CONFIRMED → PARTLY_RECEIVED | RECEIVED | CANCELLED, PARTLY_RECEIVED and
--              RECEIVED → each other | CLOSED | back to CONFIRMED or SENT (a reversed receipt); CLOSED and CANCELLED are
--              final (only the internal note changes). Outside DRAFT only the progress columns change. A send needs a
--              line and fixes the amount (the sum of the lines). A return to DRAFT raises the revision by one and clears
--              the send. The supplier's confirmation is set once, in the move SENT → CONFIRMED; its decline is written
--              only in the move SENT → DECLINED. A partner session (the PO_CONFIRM link: factory_partner_runtime,
--              src/roles.ts) changes only that: SENT → CONFIRMED or DECLINED with those columns.
--   DELETE     refused (an order is cancelled). TRUNCATE refused.
--   every row  sent exactly outside DRAFT (a cancelled draft was never sent); confirmed (time and channel, the link for
--              LINK) exactly from CONFIRMED on, never in DRAFT, SENT or DECLINED; DECLINED with its time; CLOSED and
--              CANCELLED exactly with their time, CANCELLED with its reason.
CREATE FUNCTION "factory_purchase_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  progress CONSTANT text[] := ARRAY['status', 'revision', 'sentAt', 'sentById', 'confirmedAt', 'confirmedVia', 'confirmLinkId',
    'confirmedByName', 'supplierRef', 'confirmNote', 'declinedAt', 'declineReason', 'closedAt', 'cancelledAt', 'cancelReason',
    'internalNote', 'version', 'updatedAt'];
  answer CONSTANT text[] := ARRAY['status', 'confirmedAt', 'confirmedVia', 'confirmLinkId', 'confirmedByName', 'supplierRef',
    'confirmNote', 'declinedAt', 'declineReason', 'version', 'updatedAt'];
  line_count integer;
  line_total bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supply: purchase order % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: purchase order % starts as DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'supply: the company, number and creation of purchase order % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('SENT', 'CANCELLED'))
                OR (OLD."status" = 'SENT' AND NEW."status" IN ('CONFIRMED', 'DECLINED', 'PARTLY_RECEIVED', 'RECEIVED', 'DRAFT', 'CANCELLED'))
                OR (OLD."status" = 'DECLINED' AND NEW."status" IN ('DRAFT', 'CANCELLED'))
                OR (OLD."status" = 'CONFIRMED' AND NEW."status" IN ('PARTLY_RECEIVED', 'RECEIVED', 'CANCELLED'))
                OR (OLD."status" IN ('PARTLY_RECEIVED', 'RECEIVED') AND NEW."status" IN ('PARTLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CONFIRMED', 'SENT'))) THEN
      RAISE EXCEPTION 'supply: purchase order % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - (kept || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || progress)) THEN
      RAISE EXCEPTION 'supply: purchase order % is %; its terms change only while it is DRAFT (recall it to change it)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['internalNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'supply: purchase order % is %; only its internal note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."confirmedAt", NEW."confirmedVia", NEW."confirmLinkId", NEW."confirmedByName", NEW."supplierRef", NEW."confirmNote")
       IS DISTINCT FROM
       (OLD."confirmedAt", OLD."confirmedVia", OLD."confirmLinkId", OLD."confirmedByName", OLD."supplierRef", OLD."confirmNote")
       AND NOT (OLD."status" = 'SENT' AND NEW."status" = 'CONFIRMED' AND OLD."confirmedAt" IS NULL) THEN
      RAISE EXCEPTION 'supply: the supplier''s confirmation of purchase order % is set once, when it moves from SENT to CONFIRMED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."declinedAt", NEW."declineReason") IS DISTINCT FROM (OLD."declinedAt", OLD."declineReason")
       AND NOT (OLD."status" = 'SENT' AND NEW."status" = 'DECLINED') THEN
      RAISE EXCEPTION 'supply: the supplier''s decline of purchase order % is written only when it moves from SENT to DECLINED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."sentAt", NEW."sentById") IS DISTINCT FROM (OLD."sentAt", OLD."sentById")
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'SENT') OR (OLD."status" IN ('SENT', 'DECLINED') AND NEW."status" = 'DRAFT')) THEN
      RAISE EXCEPTION 'supply: purchase order % gets its send time when it is sent, and loses it when it goes back to DRAFT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."revision" NOT IN (OLD."revision", OLD."revision" + 1)
       OR (NEW."status" = 'DRAFT' AND OLD."status" IN ('SENT', 'DECLINED')) <> (NEW."revision" = OLD."revision" + 1) THEN
      RAISE EXCEPTION 'supply: the revision of purchase order % goes up by one exactly when a SENT or DECLINED order goes back to DRAFT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'SENT' THEN
      SELECT count(*), coalesce(sum(l."netAmount"), 0) INTO line_count, line_total
        FROM "PurchaseOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."purchaseOrderId" = NEW."id";
      IF line_count = 0 THEN
        RAISE EXCEPTION 'supply: purchase order % has no line; it cannot be sent', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF line_total <> NEW."netAmount" THEN
        RAISE EXCEPTION 'supply: the amount of purchase order % (%) is not the sum of its lines (%)', NEW."id", NEW."netAmount", line_total
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND ((to_jsonb(NEW) - (kept || answer)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer))
            OR (NEW."status" <> OLD."status" AND NOT (OLD."status" = 'SENT' AND NEW."status" IN ('CONFIRMED', 'DECLINED')))) THEN
      RAISE EXCEPTION 'supply: a partner session only confirms or declines its SENT purchase order (order %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."revision" < 1 OR NEW."netAmount" < 0 THEN
    RAISE EXCEPTION 'supply: purchase order % has a revision from 1 and no negative amount', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DRAFT' AND NEW."sentAt" IS NOT NULL) OR (NEW."status" NOT IN ('DRAFT', 'CANCELLED') AND NEW."sentAt" IS NULL) THEN
    RAISE EXCEPTION 'supply: purchase order % is % with the wrong send time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."confirmedAt" IS NULL) <> (NEW."confirmedVia" IS NULL)
     OR (NEW."confirmedAt" IS NULL AND (NEW."confirmLinkId" IS NOT NULL OR NEW."confirmedByName" IS NOT NULL OR NEW."supplierRef" IS NOT NULL OR NEW."confirmNote" IS NOT NULL))
     OR (NEW."confirmedVia" IS NOT DISTINCT FROM 'LINK') <> (NEW."confirmLinkId" IS NOT NULL)
     OR (NEW."status" = 'CONFIRMED' AND NEW."confirmedAt" IS NULL)
     OR (NEW."status" IN ('DRAFT', 'SENT', 'DECLINED') AND NEW."confirmedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'supply: purchase order % is % with an inconsistent confirmation (its time, channel and link go together, from CONFIRMED on)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DECLINED' AND NEW."declinedAt" IS NULL) OR (NEW."declinedAt" IS NULL AND NEW."declineReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'supply: purchase order % is % with the wrong decline time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED' AND btrim(coalesce(NEW."cancelReason", '')) = '') THEN
    RAISE EXCEPTION 'supply: purchase order % is % with the wrong closing or cancellation (a cancellation has its time and reason)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PurchaseOrder_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PurchaseOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_purchase_order_guard"();
CREATE TRIGGER "PurchaseOrder_no_truncate" BEFORE TRUNCATE ON "PurchaseOrder"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- PurchaseOrderLine (SCM-050, SCM-075)
--   INSERT, DELETE  only while the order is DRAFT; a new line has no confirmation.
--   UPDATE          an UPDATE that changes nothing passes; a line never moves to another order; outside DRAFT only the
--                   supplier's confirmation (quantity, date) changes: set once, while the order is SENT or CONFIRMED. A
--                   partner session sets only that, only while its order is SENT. The order row is locked FOR SHARE, so a
--                   send waits for the transaction that edits its lines (and an edit after it sees it).
--   every row       a quantity above 0 in both units, no negative price, amount, confirmed quantity, hides or
--                   tolerance, a thickness range from low to high; it needs Cr VI evidence when its item does.
--   TRUNCATE        refused.
CREATE FUNCTION "factory_purchase_order_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  answer CONSTANT text[] := ARRAY['confirmedQuantity', 'confirmedDate', 'version', 'updatedAt'];
  state text;
  part_of uuid;
  item_needs_test boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."purchaseOrderId" <> OLD."purchaseOrderId" THEN
      RAISE EXCEPTION 'supply: purchase order line % never moves to another order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    part_of := NEW."purchaseOrderId";
    SELECT o."status"::text INTO state FROM "PurchaseOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."purchaseOrderId" FOR SHARE;
  ELSE
    part_of := OLD."purchaseOrderId";
    SELECT o."status"::text INTO state FROM "PurchaseOrder" o WHERE o."tenantId" = OLD."tenantId" AND o."id" = OLD."purchaseOrderId" FOR SHARE;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF state IS NOT NULL AND state <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: purchase order % is %; its lines are removed only while it is DRAFT', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF state IS NOT NULL AND state <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: purchase order % is %; lines are added only while it is DRAFT', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."confirmedQuantity" IS NOT NULL OR NEW."confirmedDate" IS NOT NULL THEN
      RAISE EXCEPTION 'supply: purchase order line % is new; the supplier has not confirmed it yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF state IS NOT NULL AND state <> 'DRAFT'
       AND (to_jsonb(NEW) - (kept || answer)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer)) THEN
      RAISE EXCEPTION 'supply: purchase order % is %; its lines change only while it is DRAFT (recall it to change them)', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."confirmedQuantity", NEW."confirmedDate") IS DISTINCT FROM (OLD."confirmedQuantity", OLD."confirmedDate")
       AND ((OLD."confirmedQuantity" IS NOT NULL AND NEW."confirmedQuantity" IS DISTINCT FROM OLD."confirmedQuantity")
            OR (OLD."confirmedDate" IS NOT NULL AND NEW."confirmedDate" IS DISTINCT FROM OLD."confirmedDate")
            OR (state IS NOT NULL AND state NOT IN ('SENT', 'CONFIRMED'))) THEN
      RAISE EXCEPTION 'supply: the supplier''s confirmation of purchase order line % is set once, while its order is SENT or CONFIRMED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND ((to_jsonb(NEW) - (kept || answer)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer))
            OR ((NEW."confirmedQuantity", NEW."confirmedDate") IS DISTINCT FROM (OLD."confirmedQuantity", OLD."confirmedDate") AND state IS DISTINCT FROM 'SENT')) THEN
      RAISE EXCEPTION 'supply: a partner session only confirms the lines of its SENT purchase order (line %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."quantity" <= 0 OR NEW."baseQuantity" <= 0 OR NEW."unitPrice" < 0 OR NEW."netAmount" < 0 OR NEW."confirmedQuantity" < 0
     OR NEW."estimatedHides" < 0 OR NEW."areaTolerancePct" < 0 OR NEW."thicknessMinMm" > NEW."thicknessMaxMm" THEN
    RAISE EXCEPTION 'supply: purchase order line % has a quantity above 0, no negative price, amount, confirmed quantity, hides or tolerance, and a thickness range from low to high', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."itemId" <> OLD."itemId" OR NEW."requiresCrViTest" <> OLD."requiresCrViTest" THEN
    SELECT i."requiresCrViTest" INTO item_needs_test FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND item_needs_test AND NOT NEW."requiresCrViTest" THEN
      RAISE EXCEPTION 'supply: item % needs Cr VI evidence (REACH Annex XVII entry 47); purchase order line % must say so', NEW."itemId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PurchaseOrderLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PurchaseOrderLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_purchase_order_line_guard"();
CREATE TRIGGER "PurchaseOrderLine_no_truncate" BEFORE TRUNCATE ON "PurchaseOrderLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- PlanningRun (PLN-062)
--   UPDATE     an UPDATE that changes nothing passes; the company, trigger, start and creation never change; the status
--              moves RUNNING → DONE | FAILED, DONE → SUPERSEDED; a finished run changes nothing but that and its note.
--   every row  finished exactly when not RUNNING, not before it started; FAILED with its error.
--   DELETE     refused (a run is superseded). TRUNCATE refused.
-- One RUNNING run per site ("two runs never overlap"): the partial unique index below.
CREATE FUNCTION "factory_planning_run_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supply: planning run % is superseded, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."trigger", NEW."startedAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."trigger", OLD."startedAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'supply: the company, trigger, start and creation of planning run % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'RUNNING' AND NEW."status" IN ('DONE', 'FAILED'))
                OR (OLD."status" = 'DONE' AND NEW."status" = 'SUPERSEDED')) THEN
      RAISE EXCEPTION 'supply: planning run % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'RUNNING'
       AND (to_jsonb(NEW) - (kept || ARRAY['status', 'note', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['status', 'note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'supply: planning run % is %; only its status and note change', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."status" = 'RUNNING') <> (NEW."finishedAt" IS NULL) OR NEW."finishedAt" < NEW."startedAt"
     OR (NEW."status" = 'FAILED' AND btrim(coalesce(NEW."error", '')) = '') OR NEW."orderLines" < 0 THEN
    RAISE EXCEPTION 'supply: planning run % is % with the wrong finish time or error', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PlanningRun_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PlanningRun"
  FOR EACH ROW EXECUTE FUNCTION "factory_planning_run_guard"();
CREATE TRIGGER "PlanningRun_no_truncate" BEFORE TRUNCATE ON "PlanningRun"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

CREATE UNIQUE INDEX "PlanningRun_one_running_per_site" ON "PlanningRun" ("tenantId", "siteId") WHERE "status" = 'RUNNING';

-- MaterialRequirement (B-W1-29)
--   UPDATE     an UPDATE that changes nothing passes; its numbers are the run's snapshot and never change: only the
--              decision (decision, note, purchase order line, who and when) changes, while its run is DONE.
--   every row  no negative quantity; net = max(0, gross − usable stock − on order); ORDERED exactly with the purchase
--              order line that buys it for a BUY (a line of the same item and colour), decided exactly with its time.
--   DELETE     refused (kept with its run). TRUNCATE refused.
CREATE FUNCTION "factory_material_requirement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  decided CONSTANT text[] := ARRAY['decision', 'decisionNote', 'purchaseOrderLineId', 'decidedAt', 'decidedById', 'version', 'updatedAt'];
  run_state text;
  line_item uuid;
  line_colour uuid;
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
  RETURN NEW;
END
$$;

CREATE TRIGGER "MaterialRequirement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "MaterialRequirement"
  FOR EACH ROW EXECUTE FUNCTION "factory_material_requirement_guard"();
CREATE TRIGGER "MaterialRequirement_no_truncate" BEFORE TRUNCATE ON "MaterialRequirement"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Location (SCM-176)
--   UPDATE     an UPDATE that changes nothing passes; the company, code and creation never change; a location is
--              archived only once it is empty (every stock key's balance there is 0).
--   every row  it never sits inside itself (its parent is not itself or one of its own children).
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_location_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory: location % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."code", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."code", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'inventory: the company, code and creation of location % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'ARCHIVED' AND OLD."status" <> 'ARCHIVED'
       AND EXISTS (
         SELECT 1
           FROM "StockMove" m
          WHERE m."tenantId" = OLD."tenantId" AND m."siteId" = OLD."siteId"
            AND (m."toLocationId" = OLD."id" OR m."fromLocationId" = OLD."id")
          GROUP BY m."itemId", m."itemColourId", m."lotId", m."hideId"
         HAVING sum(CASE WHEN m."toLocationId" = OLD."id" THEN m."baseQuantity" ELSE -m."baseQuantity" END) <> 0) THEN
      RAISE EXCEPTION 'inventory: location % still holds stock; move it out before archiving the location', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."parentId" IS NOT NULL
     AND (NEW."parentId" = NEW."id"
          OR EXISTS (
            WITH RECURSIVE up AS (
              SELECT l."id", l."parentId" FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."parentId"
              UNION
              SELECT l."id", l."parentId" FROM "Location" l JOIN up ON l."tenantId" = NEW."tenantId" AND l."id" = up."parentId"
            )
            SELECT 1 FROM up WHERE up."id" = NEW."id")) THEN
    RAISE EXCEPTION 'inventory: location % cannot sit inside itself', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Location_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Location"
  FOR EACH ROW EXECUTE FUNCTION "factory_location_guard"();
CREATE TRIGGER "Location_no_truncate" BEFORE TRUNCATE ON "Location"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- GoodsReceipt (SCM-113)
--   INSERT     a receipt starts OPEN.
--   UPDATE     an UPDATE that changes nothing passes; the company, number and creation never change; the status moves
--              OPEN → POSTED | CANCELLED, POSTED → REVERSED; what was received changes only while OPEN; a REVERSED or
--              CANCELLED receipt changes nothing but its note; the posting is set once.
--   every row  posted exactly when POSTED or REVERSED; REVERSED exactly with its time and reason; CANCELLED exactly
--              with its time; a named purchase order is the supplier's, and SENT, CONFIRMED or PARTLY_RECEIVED.
--   DELETE     refused (cancelled or reversed). TRUNCATE refused.
-- At commit, a receipt that became POSTED has lines and the ledger holds exactly each line's base quantity (its RECEIPT
-- moves); one that became REVERSED holds none of it any more (the deferred constraint trigger below).
CREATE FUNCTION "factory_goods_receipt_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  progress CONSTANT text[] := ARRAY['status', 'postedAt', 'postedById', 'reversedAt', 'reversedById', 'reversalReason', 'cancelledAt',
    'note', 'version', 'updatedAt'];
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
    IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - (kept || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || progress)) THEN
      RAISE EXCEPTION 'inventory: goods receipt % is %; what was received changes only while it is OPEN', OLD."id", OLD."status"
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

CREATE TRIGGER "GoodsReceipt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "GoodsReceipt"
  FOR EACH ROW EXECUTE FUNCTION "factory_goods_receipt_guard"();
CREATE TRIGGER "GoodsReceipt_no_truncate" BEFORE TRUNCATE ON "GoodsReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

CREATE FUNCTION "factory_goods_receipt_matches_ledger"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line record;
BEGIN
  IF NEW."status" = 'POSTED'
     AND NOT EXISTS (SELECT 1 FROM "GoodsReceiptLine" l WHERE l."tenantId" = NEW."tenantId" AND l."receiptId" = NEW."id") THEN
    RAISE EXCEPTION 'inventory: goods receipt % is POSTED without a line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  FOR line IN
    SELECT l."id", l."baseQuantity",
           coalesce((SELECT sum(CASE WHEN m."fromLocationId" IS NULL THEN m."baseQuantity" ELSE -m."baseQuantity" END)
                       FROM "StockMove" m
                      WHERE m."tenantId" = l."tenantId" AND m."siteId" = l."siteId" AND m."receiptLineId" = l."id"), 0) AS posted
      FROM "GoodsReceiptLine" l
     WHERE l."tenantId" = NEW."tenantId" AND l."receiptId" = NEW."id"
  LOOP
    IF line.posted <> (CASE WHEN NEW."status" = 'POSTED' THEN line."baseQuantity" ELSE 0 END) THEN
      RAISE EXCEPTION 'inventory: goods receipt % is %, but the ledger holds % (base unit) of its line %, which is %', NEW."id", NEW."status", line.posted, line."id", line."baseQuantity"
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "GoodsReceipt_matches_ledger" AFTER UPDATE ON "GoodsReceipt"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" IN ('POSTED', 'REVERSED') AND OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "factory_goods_receipt_matches_ledger"();

-- GoodsReceiptLine
--   INSERT, UPDATE, DELETE  only while the receipt is OPEN (its row locked FOR SHARE, so a posting waits for the
--                           transaction that edits its lines); a line never moves to another receipt. An UPDATE that
--                           changes nothing passes.
--   every row               a quantity above 0 in both units, no negative hide count; a named purchase order line is a
--                           line of the receipt's purchase order, of the same item and colour.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_goods_receipt_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
  receipt_order uuid;
  line_order uuid;
  line_item uuid;
  line_colour uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."receiptId" <> OLD."receiptId" THEN
      RAISE EXCEPTION 'inventory: goods receipt line % never moves to another receipt', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    part_of := NEW."receiptId";
    SELECT r."status"::text, r."purchaseOrderId" INTO state, receipt_order
      FROM "GoodsReceipt" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."receiptId" FOR SHARE;
  ELSE
    part_of := OLD."receiptId";
    SELECT r."status"::text, r."purchaseOrderId" INTO state, receipt_order
      FROM "GoodsReceipt" r WHERE r."tenantId" = OLD."tenantId" AND r."id" = OLD."receiptId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'OPEN' THEN
    RAISE EXCEPTION 'inventory: goods receipt % is %; its lines change only while it is OPEN', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" <= 0 OR NEW."baseQuantity" <= 0 OR NEW."hideCount" < 0 THEN
    RAISE EXCEPTION 'inventory: goods receipt line % has a quantity above 0 and no negative hide count', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."purchaseOrderLineId" IS NOT NULL AND state IS NOT NULL THEN
    SELECT l."purchaseOrderId", l."itemId", l."itemColourId" INTO line_order, line_item, line_colour
      FROM "PurchaseOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."purchaseOrderLineId";
    IF FOUND AND (line_order IS DISTINCT FROM receipt_order OR line_item <> NEW."itemId" OR line_colour IS DISTINCT FROM NEW."itemColourId") THEN
      RAISE EXCEPTION 'inventory: goods receipt line % receives against a line of its receipt''s purchase order, of the same item and colour', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "GoodsReceiptLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "GoodsReceiptLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_goods_receipt_line_guard"();
CREATE TRIGGER "GoodsReceiptLine_no_truncate" BEFORE TRUNCATE ON "GoodsReceiptLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- Lot (SCM-116, SCM-117, SCM-232, QHS-029; A1 §2.5; REACH Annex XVII entry 47)
--   INSERT     a lot starts in QUARANTINE, or RELEASED (when its rules below allow it); its item is tracked by LOT or
--              HIDE; it needs the Cr VI test when its item does, with the item's limit or a lower one; it is of its
--              receipt line's item and colour.
--   UPDATE     an UPDATE that changes nothing passes; the item, colour, number, supplier, receipt line, Cr VI
--              requirement and limit, and creation never change; the quality status moves QUARANTINE → RELEASED |
--              REJECTED | BLOCKED, RELEASED → BLOCKED, BLOCKED → RELEASED | REJECTED; a REJECTED lot changes nothing
--              but its quality note; the Cr VI result moves PENDING → PASS | FAIL, PASS → FAIL, and its value, evidence
--              and date change only while PENDING or with that move.
--   every row  the test is required exactly when there is a limit (above 0, at most 3 mg/kg) and a result other than
--              NOT_REQUIRED; a measured value below the limit is a PASS, at or above it a FAIL; a result names its
--              evidence; RELEASED needs a PASS when the test is required; decided (time) exactly when not QUARANTINE.
--   DELETE     refused (a bad lot is REJECTED). TRUNCATE refused.
CREATE FUNCTION "factory_lot_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  item_tracking text;
  item_needs_test boolean;
  item_limit numeric;
  line_item uuid;
  line_colour uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory: lot % is rejected, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."qualityStatus" NOT IN ('QUARANTINE', 'RELEASED') THEN
      RAISE EXCEPTION 'inventory: lot % starts in QUARANTINE (or RELEASED), not %', NEW."id", NEW."qualityStatus"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."tracking"::text, i."requiresCrViTest", i."crViLimitMgKg" INTO item_tracking, item_needs_test, item_limit
      FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND THEN
      IF item_tracking NOT IN ('LOT', 'HIDE') THEN
        RAISE EXCEPTION 'inventory: item % is tracked by %; only an item tracked by LOT or HIDE has lots (lot %)', NEW."itemId", item_tracking, NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF item_needs_test AND NOT NEW."requiresCrViTest" THEN
        RAISE EXCEPTION 'inventory: item % needs Cr VI evidence (REACH Annex XVII entry 47), so does its lot %', NEW."itemId", NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."crViLimitMgKg" > item_limit THEN
        RAISE EXCEPTION 'inventory: the Cr VI limit of lot % is its item''s (% mg/kg) or lower', NEW."id", item_limit
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."receiptLineId" IS NOT NULL THEN
      SELECT l."itemId", l."itemColourId" INTO line_item, line_colour
        FROM "GoodsReceiptLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."receiptLineId";
      IF FOUND AND (line_item <> NEW."itemId" OR line_colour IS DISTINCT FROM NEW."itemColourId") THEN
        RAISE EXCEPTION 'inventory: lot % is of its receipt line''s item and colour', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."itemId", NEW."itemColourId", NEW."code", NEW."supplierId", NEW."receiptLineId",
        NEW."requiresCrViTest", NEW."crViLimitMgKg", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."itemId", OLD."itemColourId", OLD."code", OLD."supplierId", OLD."receiptLineId",
        OLD."requiresCrViTest", OLD."crViLimitMgKg", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'inventory: the item, colour, number, supplier, receipt, Cr VI requirement and creation of lot % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."qualityStatus" <> OLD."qualityStatus"
       AND NOT ((OLD."qualityStatus" = 'QUARANTINE' AND NEW."qualityStatus" IN ('RELEASED', 'REJECTED', 'BLOCKED'))
                OR (OLD."qualityStatus" = 'RELEASED' AND NEW."qualityStatus" = 'BLOCKED')
                OR (OLD."qualityStatus" = 'BLOCKED' AND NEW."qualityStatus" IN ('RELEASED', 'REJECTED'))) THEN
      RAISE EXCEPTION 'inventory: lot % cannot move from % to %', OLD."id", OLD."qualityStatus", NEW."qualityStatus"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."qualityStatus" = 'REJECTED'
       AND (to_jsonb(NEW) - (kept || ARRAY['qualityNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['qualityNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'inventory: lot % is REJECTED; only its quality note changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."crViStatus" <> OLD."crViStatus"
       AND NOT ((OLD."crViStatus" = 'PENDING' AND NEW."crViStatus" IN ('PASS', 'FAIL'))
                OR (OLD."crViStatus" = 'PASS' AND NEW."crViStatus" = 'FAIL')) THEN
      RAISE EXCEPTION 'inventory: the Cr VI result of lot % cannot move from % to %', OLD."id", OLD."crViStatus", NEW."crViStatus"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."crViMgKg", NEW."crViEvidence", NEW."crViTestedAt") IS DISTINCT FROM (OLD."crViMgKg", OLD."crViEvidence", OLD."crViTestedAt")
       AND OLD."crViStatus" <> 'PENDING' AND NOT (OLD."crViStatus" = 'PASS' AND NEW."crViStatus" = 'FAIL') THEN
      RAISE EXCEPTION 'inventory: the Cr VI result of lot % is %; it changes only to FAIL, on later evidence', OLD."id", OLD."crViStatus"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."requiresCrViTest" <> (NEW."crViStatus" <> 'NOT_REQUIRED') OR NEW."requiresCrViTest" <> (NEW."crViLimitMgKg" IS NOT NULL)
     OR NEW."crViLimitMgKg" <= 0 OR NEW."crViLimitMgKg" > 3 OR NEW."crViMgKg" < 0 THEN
    RAISE EXCEPTION 'inventory: lot % needs the Cr VI test exactly when it has a limit (above 0, at most 3 mg/kg: REACH Annex XVII entry 47) and a result other than NOT_REQUIRED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."crViStatus" = 'PASS' AND NEW."crViMgKg" >= NEW."crViLimitMgKg") OR (NEW."crViStatus" = 'FAIL' AND NEW."crViMgKg" < NEW."crViLimitMgKg") THEN
    RAISE EXCEPTION 'inventory: lot % measured % mg/kg of Cr VI against a limit of %: below the limit is a PASS, at or above it a FAIL', NEW."id", NEW."crViMgKg", NEW."crViLimitMgKg"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."crViStatus" IN ('PASS', 'FAIL') AND NEW."crViEvidence" IS NULL THEN
    RAISE EXCEPTION 'inventory: the Cr VI result of lot % names its evidence (a report on the lot, or the supplier''s report)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."qualityStatus" = 'RELEASED' AND NEW."requiresCrViTest" AND NEW."crViStatus" <> 'PASS' THEN
    RAISE EXCEPTION 'inventory: lot % needs Cr VI evidence (REACH Annex XVII entry 47); its result is %, and it is released only with a PASS', NEW."id", NEW."crViStatus"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."qualityStatus" <> 'QUARANTINE') <> (NEW."qualityDecidedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'inventory: lot % is % with the wrong quality decision time', NEW."id", NEW."qualityStatus"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Lot_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Lot"
  FOR EACH ROW EXECUTE FUNCTION "factory_lot_guard"();
CREATE TRIGGER "Lot_no_truncate" BEFORE TRUNCATE ON "Lot"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- Hide (SCM-233, SCM-247, SCM-253)
--   INSERT     its item is tracked by HIDE.
--   UPDATE     an UPDATE that changes nothing passes; only its grade, shade, thickness, defects and state change (its
--              lot, tag and measured area never do: a correction is an adjustment move); the state never goes back to
--              FULL; a CONSUMED or SCRAPPED hide never changes.
--   every row  an area above 0 in an area unit (M2, DM2, FT2), above 0 in the base unit; a thickness above 0.
--   DELETE     refused (scrapped). TRUNCATE refused.
CREATE FUNCTION "factory_hide_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  described CONSTANT text[] := ARRAY['grade', 'shade', 'thicknessMm', 'defects', 'state', 'version', 'updatedAt'];
  item_tracking text;
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
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || described)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || described)) THEN
      RAISE EXCEPTION 'inventory: the lot, tag and measured area of hide % never change (a correction is an adjustment move)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" IN ('CONSUMED', 'SCRAPPED') THEN
      RAISE EXCEPTION 'inventory: hide % is %; it never changes', OLD."id", OLD."state"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."state" = 'FULL' AND OLD."state" <> 'FULL' THEN
      RAISE EXCEPTION 'inventory: hide % was cut; it is never FULL again', OLD."id"
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

CREATE TRIGGER "Hide_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Hide"
  FOR EACH ROW EXECUTE FUNCTION "factory_hide_guard"();
CREATE TRIGGER "Hide_no_truncate" BEFORE TRUNCATE ON "Hide"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- StockMove: append-only (plan A1 §2.1; SCM-189; scripts/factory/check-append-only.mjs). The stock ledger: no login may
-- change or remove a move, the owner and superusers included; the runtime roles have no UPDATE, DELETE or TRUNCATE grant
-- either (the policy migration). A mistake is a new move: a reversal or an adjustment.
CREATE FUNCTION "factory_refuse_stock_ledger_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a stock mistake is fixed with a reversal or an adjustment', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "StockMove_append_only" BEFORE UPDATE OR DELETE ON "StockMove"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_stock_ledger_change"();
CREATE TRIGGER "StockMove_no_truncate" BEFORE TRUNCATE ON "StockMove"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_stock_ledger_change"();

-- StockMove, INSERT (SCM-189, SCM-192, SCM-194; A1 §2.5 "Lot")
--   quantity   above 0 in both units (the locations give the direction); in the item's base unit the two are equal.
--   locations  at least one, never the same twice; by reason: OPENING, RECEIPT, RETURN only enter; ISSUE, SCRAP only
--              leave; TRANSFER both; ADJUSTMENT, COUNT one side. A reversal mirrors the move it reverses (the same
--              reason, item, colour, lot, hide, quantity and document, its locations swapped), is never itself
--              reversed, and a move has at most one (the partial unique index below). No stock enters an archived
--              location.
--   documents  a RECEIPT (and only it) names its goods receipt line, of the same item and colour, and its lot is a lot
--              of that line; it is posted while the receipt is OPEN (its posting), reversed while it is POSTED (its
--              reversal; both settled at commit, below); ISSUE and RETURN name the work order; ADJUSTMENT, COUNT and
--              SCRAP say why.
--   tracking   an item tracked by LOT names a lot and no hide, by HIDE a lot and a hide, by NONE neither; the lot is of
--              the move's colour.
--   quality    an ISSUE takes only a RELEASED lot (REACH Annex XVII entry 47: an untested or failed lot is never used)
--              and never a CONSUMED or SCRAPPED hide.
--   balance    a move never takes a location below zero for its stock key (site, item, colour, lot, hide): the balance
--              is the sum of the ledger, read under a transaction lock per location and key, so two concurrent moves of
--              the same stock wait for each other (SCM-194: two scans never consume the same hide). The lock holds for
--              READ COMMITTED transactions, the factory's: each query of this function sees what committed before it.
CREATE FUNCTION "factory_stock_move_check"() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF (NEW."reason" IN ('OPENING', 'RECEIPT', 'RETURN') AND NOT enters)
       OR (NEW."reason" IN ('ISSUE', 'SCRAP') AND NOT leaves)
       OR (NEW."reason" = 'TRANSFER' AND (NEW."fromLocationId" IS NULL OR NEW."toLocationId" IS NULL))
       OR (NEW."reason" IN ('ADJUSTMENT', 'COUNT') AND NOT (enters OR leaves)) THEN
      RAISE EXCEPTION 'inventory: stock move % is a % with the wrong locations (OPENING, RECEIPT and RETURN only enter one; ISSUE and SCRAP only leave one; TRANSFER both; ADJUSTMENT and COUNT one side)', NEW."id", NEW."reason"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT m."reason", m."itemId", m."itemColourId", m."lotId", m."hideId", m."baseQuantity", m."receiptLineId", m."workOrderId",
           m."fromLocationId", m."toLocationId", m."reversalOfId"
      INTO original
      FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."reversalOfId";
    IF FOUND THEN
      IF (original."reason", original."itemId", original."itemColourId", original."lotId", original."hideId", original."baseQuantity",
          original."receiptLineId", original."workOrderId")
         IS DISTINCT FROM
         (NEW."reason", NEW."itemId", NEW."itemColourId", NEW."lotId", NEW."hideId", NEW."baseQuantity", NEW."receiptLineId", NEW."workOrderId")
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
  IF NEW."reason" IN ('ADJUSTMENT', 'COUNT', 'SCRAP') AND NEW."reversalOfId" IS NULL AND btrim(coalesce(NEW."note", '')) = '' THEN
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
    IF FOUND AND hide_state IN ('CONSUMED', 'SCRAPPED') THEN
      RAISE EXCEPTION 'inventory: hide % is %; it is not issued', NEW."hideId", hide_state
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

CREATE TRIGGER "StockMove_check" BEFORE INSERT ON "StockMove"
  FOR EACH ROW EXECUTE FUNCTION "factory_stock_move_check"();

-- At most one reversal per move.
CREATE UNIQUE INDEX "StockMove_one_reversal" ON "StockMove" ("tenantId", "reversalOfId") WHERE "reversalOfId" IS NOT NULL;

-- A receipt's moves come with its posting, their reversals with its reversal: at commit, the receipt of a RECEIPT move
-- is POSTED (or REVERSED, when it was reversed in the same transaction), and the receipt of a reversal is REVERSED. With
-- the receipt's own check at commit (GoodsReceipt_matches_ledger), the ledger holds exactly what the receipts posted.
CREATE FUNCTION "factory_stock_move_receipt_settled"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt_state text;
BEGIN
  SELECT r."status"::text INTO receipt_state
    FROM "GoodsReceiptLine" l JOIN "GoodsReceipt" r ON r."tenantId" = l."tenantId" AND r."id" = l."receiptId"
   WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."receiptLineId";
  IF FOUND AND NOT (receipt_state = 'REVERSED' OR (NEW."reversalOfId" IS NULL AND receipt_state = 'POSTED')) THEN
    RAISE EXCEPTION 'inventory: stock move % posts receipt line %, whose receipt is % at commit; a receipt''s moves come with its posting, their reversals with its reversal', NEW."id", NEW."receiptLineId", receipt_state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "StockMove_receipt_settled" AFTER INSERT ON "StockMove"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."receiptLineId" IS NOT NULL)
  EXECUTE FUNCTION "factory_stock_move_receipt_settled"();

-- StockValuation: append-only (plan A1 §2.1, §2.6; scripts/factory/check-append-only.mjs). The value ledger: no login
-- may change or remove a row; a wrong value is corrected by the move's reversal and a new move, each valued.
CREATE FUNCTION "factory_refuse_stock_valuation_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a wrong value is corrected by a reversal and a new valued move', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "StockValuation_append_only" BEFORE UPDATE OR DELETE ON "StockValuation"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_stock_valuation_change"();
CREATE TRIGGER "StockValuation_no_truncate" BEFORE TRUNCATE ON "StockValuation"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_stock_valuation_change"();

-- StockValuation, INSERT
--   it values a move that enters or leaves the site's stock (a TRANSFER inside the site moves no value), with the move's
--   company, item and lot, and the move's base quantity signed: + when it entered, − when it left; a unit cost from 0;
--   an amount of the quantity's sign (or 0).
CREATE FUNCTION "factory_stock_valuation_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  move record;
BEGIN
  SELECT m."companyId", m."itemId", m."lotId", m."baseQuantity", m."fromLocationId", m."toLocationId" INTO move
    FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."moveId";
  IF FOUND THEN
    IF (move."companyId", move."itemId", move."lotId") IS DISTINCT FROM (NEW."companyId", NEW."itemId", NEW."lotId") THEN
      RAISE EXCEPTION 'inventory: stock valuation % has the company, item and lot of its move %', NEW."id", NEW."moveId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF move."fromLocationId" IS NOT NULL AND move."toLocationId" IS NOT NULL THEN
      RAISE EXCEPTION 'inventory: move % moves stock inside the site; it changes no value (stock valuation %)', NEW."moveId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."quantity" <> (CASE WHEN move."toLocationId" IS NOT NULL THEN move."baseQuantity" ELSE -move."baseQuantity" END) THEN
      RAISE EXCEPTION 'inventory: stock valuation % values % of move %, which moved % in and out of the site''s stock (+ in, - out)', NEW."id", NEW."quantity", NEW."moveId", move."baseQuantity"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."unitCost" < 0 OR sign(NEW."valueAmount"::numeric) * sign(NEW."quantity") < 0 THEN
    RAISE EXCEPTION 'inventory: stock valuation % has a unit cost from 0 and an amount of its quantity''s sign', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "StockValuation_check" BEFORE INSERT ON "StockValuation"
  FOR EACH ROW EXECUTE FUNCTION "factory_stock_valuation_check"();
