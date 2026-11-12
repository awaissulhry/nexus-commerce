-- Written by hand (Prisma does not model triggers), after the generated 202611011302_sales_orders_depth_w2b_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Orders, credit and changes, W2b-5 schema wave 39/44 (B-W2b-281; SAL-148, SAL-190, SAL-201, SAL-205, SAL-207, SAL-208,
-- SAL-218, SAL-219, SAL-221, SAL-237, SAL-241, SAL-244, SAL-248, SAL-306). apps/factory-api's modules/sales (B-W2b-303 orders in
-- depth, B-W2b-304 credit limits, B-W2b-309 order changes) checks all of this first and answers in words; these rules are the
-- last word, for every login, the owner included.
--
--   SalesOrder           (W1) "factory_sales_order_guard" REDEFINED (the whole body of 202610283601_sales_guards, never
--                        redefined since): an order waits for a yes (PENDING_APPROVAL) only from its making: nothing moves
--                        into it, and out of it only CONFIRMED (the yes) or CANCELLED (a no, with its reason, as W1's cancel).
--                        Its own trigger SalesOrder_order_depth_check: URGENT exactly with its reason (one line, at most 500);
--                        the confirmation sent (when, which version) both or neither, never while PENDING_APPROVAL, not in the
--                        future, a version of the order's own ORDER_CONFIRMATION document; once sent it stays sent, its time and
--                        version never going back.
--   SalesOrderLine       (W2b wave 3) "factory_sales_order_line_guard" and (W1) "factory_sales_order_line_size_guard" REDEFINED
--   SalesOrderLineSize   (their whole bodies): an order's lines and size quantities change while it waits for a yes, too.
--   WorkOrderSize        its own trigger WorkOrderSize_order_waits: no cell makes a line of an order that waits for a yes.
--   Shipment             its own trigger Shipment_order_waits: nothing ships for an order that waits for a yes.
--   GeneratedDocument    (W2b-4 wave 32) "factory_generated_document_check" REDEFINED (its whole body): ORDER_CONFIRMATION is a
--                        SalesOrder's, of the order's company, with no site.
--   SalesOrderAmendment  (W2a, append-only as it was) its own trigger SalesOrderAmendment_priced_check: the priced parts of a
--                        change after the start (1 to 100, each a label of one line up to 200, a signed amount in minor units
--                        that is never 0, a line of the order before or after when it names one), a fee above 0; the extra
--                        deposit a request of the same order, not cancelled, asked only when the gross total grew and of at
--                        most what it grew by (one amendment per request: a unique key); the new yes a SALES_ORDER_CHANGE
--                        request of the same order.
--   DepositRequest       their own triggers DepositRequest_penitential_check and QuoteVersion_penitential_check: a caparra
--   QuoteVersion         penitenziale (c.c. art. 1386) only while its company switches it on (its own sales settings row, else
--                        the tenant-wide row, else off: GATE-ACCOUNTANT).
--   OrderFreezeRule      its company, field, stage and creation never change; a note of one line up to 200; one active rule per
--                        company, field and stage (a partial unique index); among a company's active rules of a field a later
--                        stage never loosens an earlier BLOCKED (under a lock per company and field). Switched off, never
--                        deleted.
--   CreditCheck          append-only (UPDATE, DELETE, TRUNCATE refused, for every login). Its record: a QuoteVersion at QUOTE, a
--                        SalesOrder at ORDER or API, a WorkOrder at RELEASE, a Shipment at SHIPMENT, a PortalOrderRequest or a
--                        SalesOrder at PORTAL, of its customer and company; a currency of three capitals; amounts of 0 or more,
--                        the overdue part at most the open invoices, the exposure exactly open orders + open invoices + this
--                        one; a PASS never over the limit nor on hold, a WARN or a HOLD with something to say (over the limit,
--                        overdue or on hold); words of one line up to 500; not in the future. An override: both its check and
--                        its request; the check a HOLD (not itself an override) of the same step and record; the request an
--                        APPROVED CREDIT_OVERRIDE of that check (record type CreditCheck); checked not before the yes nor the
--                        check it overrides; once per check (a unique key).
--   CustomerMaterial     its order, line, BOM line, material, colour, unit and creation never change; a line of its order; a BOM
--                        line the order's customer supplies; the material's base unit; quantities of 0 or more, used and
--                        returned at most what was received; the expected sizes an object of size codes to decimals above 0
--                        (at most 200) adding up to the whole when given; made for an order that is not CLOSED or CANCELLED;
--                        removed only while nothing was received, used or returned.
--   Lot                  its own trigger Lot_owner_check: the owner set when the lot is made, never changed; a CUSTOMER or BRAND
--                        party; a lot of a CUSTOMER_SUPPLIED receipt owned by the receipt's party, and a lot of any other
--                        receipt owned by nobody (opening stock may be owned).
--   StockMove            its own trigger StockMove_customer_owned: a customer-owned lot is issued only to a work order whose
--                        every cell (one at least) makes that customer's order lines.
--   Reservation          its own trigger Reservation_customer_owned: a customer-owned lot is held only for that customer's order
--                        line, or for a work order whose every cell makes its order lines.
--   StockValuation       their own triggers StockValuation_not_customer_owned and WorkOrderCostEntry_not_customer_owned:
--   WorkOrderCostEntry   customer-owned stock is never valued nor costed on a work order.
--   TransferLine         (B-W2b-277) its own trigger TransferLine_owner_check: the lot goods arrive as at the other site has
--                        the owner of the lot they left.
--   GoodsReceipt         its own trigger GoodsReceipt_customer_supplied_check: a CUSTOMER_SUPPLIED receipt names no purchase
--                        order and no ship notice, and its sender is a CUSTOMER or BRAND party.
--   GoodsReceiptLine     its own trigger GoodsReceiptLine_customer_supplied_check: a line of a CUSTOMER_SUPPLIED receipt names
--                        no purchase order line, and its material is tracked by LOT or HIDE (the lot carries the owner).
--   SupplierInvoiceMatch its own trigger SupplierInvoiceMatch_customer_supplied (BEFORE, ahead of W2a's guard): no supplier
--                        invoice is matched against a line of a CUSTOMER_SUPPLIED receipt (nothing of it was bought).
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the checks are AFTER triggers (the
-- policies speak first) but the redefined W1 and W2 functions (BEFORE, as they were) and the refused deletes and the
-- append-only refusal (BEFORE: the runtime roles have no DELETE grant on those tables, so these speak to the owner). The
-- tenant of a row is left to the policies and the references, never compared here: a rule that reads another row skips a
-- row this session cannot see. An UPDATE that changes nothing passes.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers and
-- dates moved) and insert the copy: so the first rows the seed gives are ones a copy may repeat (a freeze rule switched off,
-- a PASS check that overrides nothing, a customer's material of an open order). One CustomerMaterial row per order line and
-- BOM line is the orders module's (a key made only of references cannot be copied).
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok", "factory_recall_not_future" and
-- "factory_recall_model_name_ok" (…_recall_claims_w2b_guards), "factory_styles_decimal_ok" (…_styles_libraries_w2b_guards).

-- =====================================================================================================================
-- Shared
-- =====================================================================================================================

CREATE FUNCTION "factory_order_depth_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- A party with the CUSTOMER or BRAND role: true, false, or NULL when this session cannot see the party.
CREATE FUNCTION "factory_order_depth_is_customer"(tenant uuid, party uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT ('CUSTOMER' = ANY (p."roles") OR 'BRAND' = ANY (p."roles")) FROM "Party" p WHERE p."tenantId" = tenant AND p."id" = party
$$;

-- The caparra penitenziale switch of a company (GATE-ACCOUNTANT): its own sales settings row, else the tenant-wide row, else
-- off.
CREATE FUNCTION "factory_caparra_penitenziale_on"(tenant uuid, company uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT s."caparraPenitenzialeEnabled" FROM "SalesSettings" s WHERE s."tenantId" = tenant AND s."id" = company),
    (SELECT s."caparraPenitenzialeEnabled" FROM "SalesSettings" s WHERE s."tenantId" = tenant AND s."id" = tenant AND s."companyId" IS NULL),
    false)
$$;

-- The owner of a lot (NULL: ours, or a lot this session cannot see).
CREATE FUNCTION "factory_lot_owner_of"(tenant uuid, lot uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT l."ownerPartyId" FROM "Lot" l WHERE l."tenantId" = tenant AND l."id" = lot
$$;

-- Whether every cell of a work order (one at least) makes an order line of the party.
CREATE FUNCTION "factory_work_order_only_for_party"(tenant uuid, site uuid, work_order uuid, party uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "WorkOrderSize" s WHERE s."tenantId" = tenant AND s."siteId" = site AND s."workOrderId" = work_order)
     AND NOT EXISTS (SELECT 1 FROM "WorkOrderSize" s
                      WHERE s."tenantId" = tenant AND s."siteId" = site AND s."workOrderId" = work_order AND s."partyId" IS DISTINCT FROM party)
$$;

-- =====================================================================================================================
-- SalesOrder: waiting for a yes, priority, the confirmation
-- =====================================================================================================================

-- (W1, 202610283601_sales_guards, whole) + W2b-5: PENDING_APPROVAL only from the making, out of it to CONFIRMED or CANCELLED.
CREATE OR REPLACE FUNCTION "factory_sales_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  state text;
  quote_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales: sales order % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."quoteVersionId" IS NOT NULL THEN
      SELECT v."status"::text, q."companyId" INTO state, quote_company
        FROM "QuoteVersion" v JOIN "Quote" q ON q."tenantId" = v."tenantId" AND q."id" = v."quoteId"
        WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."quoteVersionId";
      IF FOUND AND (state <> 'ACCEPTED' OR quote_company <> NEW."companyId") THEN
        RAISE EXCEPTION 'sales: sales order % is made only from an ACCEPTED version of a quote of its own company (version % is %)', NEW."id", NEW."quoteVersionId", state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."number", NEW."quoteVersionId", NEW."currency", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."partyId", OLD."number", OLD."quoteVersionId", OLD."currency", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales: the company, party, number, quote version, currency and creation of sales order % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."originalPromiseDate" IS NOT NULL AND NEW."originalPromiseDate" IS DISTINCT FROM OLD."originalPromiseDate" THEN
      RAISE EXCEPTION 'sales: the first promised date of sales order % is set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'sales: sales order % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND ((NEW."status" = 'CLOSED' AND OLD."status" <> 'SHIPPED')
            OR (NEW."status" = 'CANCELLED' AND OLD."status" NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PENDING_APPROVAL'))) THEN
      RAISE EXCEPTION 'sales: sales order % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b-5 (B-W2b-281; SAL-205): an order waits for a yes only from its making; the yes confirms it, a no cancels it.
    IF NEW."status" <> OLD."status"
       AND (NEW."status" = 'PENDING_APPROVAL' OR (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" NOT IN ('CONFIRMED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'sales: sales order % cannot move from % to %: an order waits for a yes (PENDING_APPROVAL) only from its making, and leaves it CONFIRMED with the yes or CANCELLED with a no', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."status" = 'CANCELLED') <> (coalesce(btrim(NEW."cancelReason"), '') <> '') THEN
    RAISE EXCEPTION 'sales: sales order % has a cancel reason exactly when it is CANCELLED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('CLOSED', 'CANCELLED')) <> (NEW."closedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'sales: sales order % is % with the wrong closing time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_sales_order_depth_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF (NEW."priorityLevel" = 'URGENT') <> (NEW."urgentReason" IS NOT NULL) OR NOT "factory_recall_words_ok"(NEW."urgentReason", 500, false) THEN
    RAISE EXCEPTION 'sales: sales order % is URGENT exactly with its reason in words (one line, at most 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."confirmationSentAt" IS NULL) <> (NEW."confirmationVersion" IS NULL) OR NEW."confirmationVersion" < 1 THEN
    RAISE EXCEPTION 'sales: sales order % names the confirmation it sent with when and its version (from 1), or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."confirmationSentAt" IS NOT NULL
     AND (NEW."confirmationSentAt" IS NULL OR NEW."confirmationSentAt" < OLD."confirmationSentAt" OR NEW."confirmationVersion" < OLD."confirmationVersion") THEN
    RAISE EXCEPTION 'sales: sales order % sent its confirmation (version % at %); a later sending never goes back', OLD."id", OLD."confirmationVersion", OLD."confirmationSentAt"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."confirmationSentAt" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."confirmationSentAt", NEW."confirmationVersion") IS DISTINCT FROM (OLD."confirmationSentAt", OLD."confirmationVersion")) THEN
    IF NEW."status" = 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION 'sales: sales order % waits for a yes (PENDING_APPROVAL); its confirmation is sent once it is CONFIRMED', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_recall_not_future"(NEW."confirmationSentAt") THEN
      RAISE EXCEPTION 'sales: sales order % sent its confirmation in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "GeneratedDocument" d
                    WHERE d."tenantId" = NEW."tenantId" AND d."recordType" = 'SalesOrder' AND d."recordId" = NEW."id"
                      AND d."kind" = 'ORDER_CONFIRMATION' AND d."version" = NEW."confirmationVersion") THEN
      RAISE EXCEPTION 'sales: sales order % sent confirmation version %, which is no ORDER_CONFIRMATION document of it', NEW."id", NEW."confirmationVersion"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SalesOrder_order_depth_check" AFTER INSERT OR UPDATE ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_order_depth_check"();

-- (W2b wave 3, 202610313001_followups_platform_w2b_guards, whole) + W2b-5: the lines change while the order waits for a yes.
CREATE OR REPLACE FUNCTION "factory_sales_order_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  short CONSTANT text[] := ARRAY['closedShortQuantity', 'closedShortAt', 'closedShortById', 'closeShortReason', 'closedShortReasonCode', 'version', 'updatedAt'];
  state text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."orderId" IS DISTINCT FROM OLD."orderId" THEN
      RAISE EXCEPTION 'sales: sales order line % never moves to another order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    part_of := NEW."orderId";
    SELECT o."status"::text INTO state FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."orderId" FOR SHARE;
  ELSE
    part_of := OLD."orderId";
    SELECT o."status"::text INTO state FROM "SalesOrder" o WHERE o."tenantId" = OLD."tenantId" AND o."id" = OLD."orderId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state NOT IN ('PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY')
     AND NOT (TG_OP = 'UPDATE' AND state = 'PARTLY_SHIPPED' AND (to_jsonb(NEW) - short) = (to_jsonb(OLD) - short)) THEN
    RAISE EXCEPTION 'sales: sales order % is %; its lines change only while it is CONFIRMED, IN_PRODUCTION or READY, or waits for a yes (once PARTLY_SHIPPED, a line is only closed short or reopened)', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1
     OR (NEW."kind" = 'MADE_TO_MEASURE') <> (NEW."measurementProfileId" IS NOT NULL)
     OR (NEW."kind" = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1) THEN
    RAISE EXCEPTION 'sales: sales order line % is a size grid of at least one piece, or one made-to-measure unit with its measurement profile', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."closedShortAt" IS NULL) <> (NEW."closedShortQuantity" IS NULL)
     OR (NEW."closedShortAt" IS NULL) <> (NEW."closedShortById" IS NULL)
     OR (NEW."closedShortAt" IS NULL) <> (coalesce(btrim(NEW."closeShortReason"), '') = '') THEN
    RAISE EXCEPTION 'sales: sales order line % is closed short with its pieces, time, who and why, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."closedShortQuantity" IS NOT NULL AND (NEW."closedShortQuantity" < 1 OR NEW."closedShortQuantity" > NEW."quantity") THEN
    RAISE EXCEPTION 'sales: sales order line % closes short 1 to % pieces, not %', NEW."id", NEW."quantity", NEW."closedShortQuantity"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."closedShortReasonCode" IS NOT NULL
     AND (NEW."closedShortAt" IS NULL OR NEW."closedShortReasonCode" !~ '^[A-Z][A-Z0-9_]*$') THEN
    RAISE EXCEPTION 'sales: sales order line % names a closed-short reason code (upper-case letters, digits and underscores) only while it is closed short', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- (W1, 202610283601_sales_guards, whole) + W2b-5: the size quantities change while the order waits for a yes.
CREATE OR REPLACE FUNCTION "factory_sales_order_line_size_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  line_kind text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."lineId" IS DISTINCT FROM OLD."lineId" THEN
      RAISE EXCEPTION 'sales: sales order line size % never moves to another line', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT o."status"::text, l."kind"::text, o."id" INTO state, line_kind, part_of
      FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."orderId"
      WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."lineId" FOR SHARE OF o;
  ELSE
    SELECT o."status"::text, l."kind"::text, o."id" INTO state, line_kind, part_of
      FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."orderId"
      WHERE l."tenantId" = OLD."tenantId" AND l."id" = OLD."lineId" FOR SHARE OF o;
  END IF;
  IF state IS NOT NULL AND state NOT IN ('PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY') THEN
    RAISE EXCEPTION 'sales: sales order % is %; its size quantities change only while it is CONFIRMED, IN_PRODUCTION or READY, or waits for a yes', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1 OR (line_kind IS NOT NULL AND line_kind <> 'SIZE_GRID') THEN
    RAISE EXCEPTION 'sales: sales order line size % has at least one piece, on a SIZE_GRID line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Nothing is made or shipped for an order that waits for a yes.
CREATE FUNCTION "factory_work_order_size_order_waits"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  waiting text;
BEGIN
  IF NEW."salesOrderLineId" IS NULL OR (TG_OP = 'UPDATE' AND NEW."salesOrderLineId" IS NOT DISTINCT FROM OLD."salesOrderLineId") THEN
    RETURN NULL;
  END IF;
  SELECT o."number" INTO waiting
    FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."orderId"
   WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId" AND o."status" = 'PENDING_APPROVAL';
  IF FOUND THEN
    RAISE EXCEPTION 'production: sales order % waits for a yes (PENDING_APPROVAL); nothing is made for it until it is CONFIRMED (work order cell %)', waiting, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WorkOrderSize_order_waits" AFTER INSERT OR UPDATE OF "salesOrderLineId" ON "WorkOrderSize"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_size_order_waits"();

CREATE FUNCTION "factory_shipment_order_waits"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  waiting text;
BEGIN
  SELECT o."number" INTO waiting FROM "SalesOrder" o
   WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."salesOrderId" AND o."status" = 'PENDING_APPROVAL';
  IF FOUND THEN
    RAISE EXCEPTION 'shipping: sales order % waits for a yes (PENDING_APPROVAL); nothing ships for it until it is CONFIRMED (shipment %)', waiting, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Shipment_order_waits" AFTER INSERT ON "Shipment"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipment_order_waits"();

-- (W2b-4 wave 32/33, 202611010603_techfiles_labels_w2b_guards, whole) + W2b-5: ORDER_CONFIRMATION of a SalesOrder (no site).
CREATE OR REPLACE FUNCTION "factory_generated_document_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_company uuid;
  record_site uuid;
  record_kind text;
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
          OR (NEW."kind" = 'RMA_SHEET' AND NEW."recordType" = 'ReturnAuthorisation')
          OR (NEW."kind" = 'INSPECTION_REPORT' AND NEW."recordType" IN ('Inspection', 'IncomingInspection'))
          OR (NEW."kind" = 'CERTIFICATE_OF_CONFORMITY' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'NCR_REPORT' AND NEW."recordType" = 'Nonconformance')
          OR (NEW."kind" = 'EIGHT_D' AND NEW."recordType" = 'Capa')
          OR (NEW."kind" = 'COMPLAINT_ANSWER' AND NEW."recordType" = 'Complaint')
          OR (NEW."kind" = 'CHECK_REPORT' AND NEW."recordType" = 'MachineCheckResult')
          OR (NEW."kind" = 'DVR_FROZEN' AND NEW."recordType" = 'RiskAssessmentVersion')
          OR (NEW."kind" = 'PPE_RECEIPT' AND NEW."recordType" = 'PpeIssue')
          OR (NEW."kind" = 'COMPLIANCE_PACK' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'EVIDENCE_PACK' AND NEW."recordType" = 'EvidencePack')
          OR (NEW."kind" = 'TECH_PACK' AND NEW."recordType" = 'StyleRevision')
          OR (NEW."kind" = 'USER_INFORMATION' AND NEW."recordType" = 'ComplianceDocument')
          OR (NEW."kind" = 'ORDER_CONFIRMATION' AND NEW."recordType" = 'SalesOrder')) THEN
    RAISE EXCEPTION 'documents: generated document % is a % of a %; a packing list is a Shipment''s, a claim letter a SupplierClaim''s, a job sheet a SubcontractOrder''s or a MaintenanceJob''s, an RMA sheet a ReturnAuthorisation''s, a certificate of conformity a Shipment''s, an inspection report an Inspection''s or an IncomingInspection''s, an NCR report a Nonconformance''s, an 8D a Capa''s, an answer letter a Complaint''s, a check report a MachineCheckResult''s, a frozen risk assessment a RiskAssessmentVersion''s, a PPE receipt a PpeIssue''s, a compliance pack a Shipment''s, an evidence pack an EvidencePack''s, a tech pack a StyleRevision''s, a user information leaflet a ComplianceDocument''s, an order confirmation a SalesOrder''s', NEW."id", NEW."kind", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  CASE NEW."recordType"
    -- W2b-5 wave 39/44 (B-W2b-281): an order confirmation is of its order's company; an order has no site.
    WHEN 'SalesOrder' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "SalesOrder" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- W2b-4 wave 32/33 (B-W2b-218): an evidence pack is of its company; a tech pack of its revision's style's company and a
    -- leaflet of its document's company, either for any company of the tenant when the style or document is tenant-wide; the
    -- leaflet's document is user information. None of them has a site.
    WHEN 'EvidencePack' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "EvidencePack" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'StyleRevision' THEN
      SELECT coalesce(s."companyId", NEW."companyId"), NULL::uuid INTO record_company, record_site
        FROM "StyleRevision" r JOIN "Style" s ON s."tenantId" = r."tenantId" AND s."id" = r."styleId"
       WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'ComplianceDocument' THEN
      SELECT coalesce(r."companyId", NEW."companyId"), NULL::uuid, r."kind"::text INTO record_company, record_site, record_kind
        FROM "ComplianceDocument" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
      IF FOUND AND record_kind <> 'USER_INFORMATION' THEN
        RAISE EXCEPTION 'documents: generated document % is a user information leaflet of a ComplianceDocument of kind USER_INFORMATION (this one is %)', NEW."id", record_kind
          USING ERRCODE = 'check_violation';
      END IF;
    -- W2b wave 15/16 (B-W2b-87): a frozen risk assessment is of its version's company and site, a PPE receipt of its issue's.
    WHEN 'RiskAssessmentVersion' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "RiskAssessmentVersion" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'PpeIssue' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "PpeIssue" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- W2b wave 14/16 (B-W2b-86): a check report is of its result's company and site.
    WHEN 'MachineCheckResult' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "MachineCheckResult" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- A record of the whole company has no site, and neither has its document.
    WHEN 'Capa' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "Capa" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Complaint' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "Complaint" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Inspection' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Inspection" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'IncomingInspection' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "IncomingInspection" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Nonconformance' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Nonconformance" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
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

-- =====================================================================================================================
-- SalesOrderAmendment: a priced change, an extra deposit, a new yes
-- =====================================================================================================================

CREATE FUNCTION "factory_sales_order_amendment_priced_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  part jsonb;
  shape_ok boolean;
  deposit record;
  task record;
  growth bigint;
BEGIN
  IF NEW."priceDeltaLines" IS NOT NULL THEN
    IF jsonb_typeof(NEW."priceDeltaLines") <> 'array' OR jsonb_array_length(NEW."priceDeltaLines") NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'sales: amendment % prices its change in 1 to 100 parts (a list), or not at all', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    FOR part IN SELECT value FROM jsonb_array_elements(NEW."priceDeltaLines") LOOP
      -- Each test in its own step: the amount is read as a number only once it is one.
      shape_ok := jsonb_typeof(part) = 'object';
      IF shape_ok THEN
        shape_ok := NOT EXISTS (SELECT 1 FROM jsonb_object_keys(part) k WHERE k NOT IN ('label', 'orderLineId', 'amount'))
                    AND jsonb_typeof(part -> 'label') IS NOT DISTINCT FROM 'string' AND "factory_recall_words_ok"(part ->> 'label', 200, false)
                    AND jsonb_typeof(part -> 'amount') IS NOT DISTINCT FROM 'number' AND (part ->> 'amount') ~ '^-?[0-9]{1,10}$';
      END IF;
      IF shape_ok THEN
        shape_ok := (part ->> 'amount')::bigint <> 0 AND abs((part ->> 'amount')::bigint) <= 2147483647;
      END IF;
      IF NOT shape_ok THEN
        RAISE EXCEPTION 'sales: amendment % prices each part of its change with a label (one line, at most 200 characters) and an amount in minor units (a whole number, never 0), and an order line when it names one: %', NEW."id", part
          USING ERRCODE = 'check_violation';
      END IF;
      IF part ? 'orderLineId'
         AND (jsonb_typeof(part -> 'orderLineId') IS DISTINCT FROM 'string'
              OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW."before" -> 'lines') = 'array' THEN NEW."before" -> 'lines' ELSE '[]'::jsonb END) l
                              WHERE l ->> 'id' = part ->> 'orderLineId'
                             UNION ALL
                             SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW."after" -> 'lines') = 'array' THEN NEW."after" -> 'lines' ELSE '[]'::jsonb END) l
                              WHERE l ->> 'id' = part ->> 'orderLineId')) THEN
        RAISE EXCEPTION 'sales: amendment % prices a part of order line %, which is no line of the order before or after it', NEW."id", part ->> 'orderLineId'
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;
  IF NEW."feeAmount" IS NOT NULL AND NEW."feeAmount" <= 0 THEN
    RAISE EXCEPTION 'sales: amendment % charges a fee above 0, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."depositRequestId" IS NOT NULL THEN
    growth := NEW."grossAmountAfter"::bigint - NEW."grossAmountBefore"::bigint;
    IF growth <= 0 THEN
      RAISE EXCEPTION 'sales: amendment % asks an extra deposit only when the order grew (its gross total went from % to %)', NEW."id", NEW."grossAmountBefore", NEW."grossAmountAfter"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT d."orderId", d."amount", d."status"::text AS status INTO deposit
      FROM "DepositRequest" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."depositRequestId";
    IF FOUND AND (deposit."orderId" IS DISTINCT FROM NEW."orderId" OR deposit."status" = 'CANCELLED' OR deposit."amount" > growth) THEN
      RAISE EXCEPTION 'sales: the extra deposit of amendment % is a deposit request of the same order, not cancelled, of at most what the order grew by (%)', NEW."id", growth
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."reapprovalTaskId" IS NOT NULL THEN
    SELECT t."kind"::text AS kind, t."recordType", t."recordId" INTO task
      FROM "ApprovalTask" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."reapprovalTaskId";
    IF FOUND AND (task."kind" <> 'SALES_ORDER_CHANGE' OR task."recordType" <> 'SalesOrder' OR task."recordId" <> NEW."orderId") THEN
      RAISE EXCEPTION 'sales: the new yes of amendment % is a SALES_ORDER_CHANGE request about its own order (this one is a % of % %)', NEW."id", task."kind", task."recordType", task."recordId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SalesOrderAmendment_priced_check" AFTER INSERT ON "SalesOrderAmendment"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_order_amendment_priced_check"();

-- =====================================================================================================================
-- The caparra penitenziale (c.c. art. 1386): switched off until the accountant's word (GATE-ACCOUNTANT)
-- =====================================================================================================================

CREATE FUNCTION "factory_deposit_request_penitential_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'CAPARRA_PENITENZIALE' AND NOT "factory_caparra_penitenziale_on"(NEW."tenantId", NEW."companyId") THEN
    RAISE EXCEPTION 'sales: deposit request % is a caparra penitenziale (c.c. art. 1386), which its company does not ask: it is switched off until the accountant''s word (sales settings)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "DepositRequest_penitential_check" AFTER INSERT ON "DepositRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_deposit_request_penitential_check"();

CREATE FUNCTION "factory_quote_version_penitential_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  company uuid;
BEGIN
  IF NEW."depositKind" IS DISTINCT FROM 'CAPARRA_PENITENZIALE' OR (TG_OP = 'UPDATE' AND NEW."depositKind" IS NOT DISTINCT FROM OLD."depositKind") THEN
    RETURN NULL;
  END IF;
  SELECT q."companyId" INTO company FROM "Quote" q WHERE q."tenantId" = NEW."tenantId" AND q."id" = NEW."quoteId";
  IF FOUND AND NOT "factory_caparra_penitenziale_on"(NEW."tenantId", company) THEN
    RAISE EXCEPTION 'sales: quote version % asks a caparra penitenziale (c.c. art. 1386), which its company does not ask: it is switched off until the accountant''s word (sales settings)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QuoteVersion_penitential_check" AFTER INSERT OR UPDATE OF "depositKind" ON "QuoteVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_quote_version_penitential_check"();

-- =====================================================================================================================
-- OrderFreezeRule
-- =====================================================================================================================

CREATE UNIQUE INDEX "OrderFreezeRule_one_active" ON "OrderFreezeRule" ("tenantId", "companyId", "field", "frozenFrom") WHERE "active";

CREATE FUNCTION "factory_order_freeze_rule_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  looser text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."field", NEW."frozenFrom", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."field", OLD."frozenFrom", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales: the company, field, stage and creation of freeze rule % never change (switch it off and add another)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 200, false) THEN
    RAISE EXCEPTION 'sales: the words of freeze rule % are one line of at most 200 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."active" THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.order_freeze', NEW."tenantId", NEW."companyId", NEW."field"), 0));
    SELECT r."frozenFrom"::text INTO looser FROM "OrderFreezeRule" r
     WHERE r."tenantId" = NEW."tenantId" AND r."companyId" = NEW."companyId" AND r."field" = NEW."field" AND r."active" AND r."id" <> NEW."id"
       AND ((NEW."action" = 'CHANGE_REQUEST' AND r."action" = 'BLOCKED' AND r."frozenFrom" < NEW."frozenFrom")
            OR (NEW."action" = 'BLOCKED' AND r."action" = 'CHANGE_REQUEST' AND r."frozenFrom" > NEW."frozenFrom"))
     ORDER BY r."frozenFrom" LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'sales: freeze rule % (% from %, %) would loosen what an earlier stage blocks: % is % from % on; a later stage never loosens an earlier BLOCKED', NEW."id", NEW."field", NEW."frozenFrom", NEW."action", NEW."field",
        CASE WHEN NEW."action" = 'BLOCKED' THEN 'a change request' ELSE 'BLOCKED' END, looser
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_order_freeze_rule_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales: freeze rule % is switched off, never deleted', OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "OrderFreezeRule_check" AFTER INSERT OR UPDATE ON "OrderFreezeRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_freeze_rule_check"();
CREATE TRIGGER "OrderFreezeRule_never_deleted" BEFORE DELETE ON "OrderFreezeRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_freeze_rule_never_deleted"();
CREATE TRIGGER "OrderFreezeRule_no_truncate" BEFORE TRUNCATE ON "OrderFreezeRule"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_depth_refuse_truncate"();

-- =====================================================================================================================
-- CreditCheck (append-only)
-- =====================================================================================================================

CREATE FUNCTION "factory_credit_check_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales: a credit check is never changed or removed (% of CreditCheck %); an override is a new check', TG_OP, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_credit_check_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_company uuid;
  record_party uuid;
  over boolean;
  overridden record;
  task record;
BEGIN
  IF NOT ((NEW."step" = 'QUOTE' AND NEW."recordType" = 'QuoteVersion')
          OR (NEW."step" IN ('ORDER', 'API') AND NEW."recordType" = 'SalesOrder')
          OR (NEW."step" = 'RELEASE' AND NEW."recordType" = 'WorkOrder')
          OR (NEW."step" = 'SHIPMENT' AND NEW."recordType" = 'Shipment')
          OR (NEW."step" = 'PORTAL' AND NEW."recordType" IN ('PortalOrderRequest', 'SalesOrder'))) THEN
    RAISE EXCEPTION 'sales: credit check % at % checks a %; a quote check a QuoteVersion, an order or API check a SalesOrder, a release check a WorkOrder, a shipment check a Shipment, a portal check a PortalOrderRequest or a SalesOrder', NEW."id", NEW."step", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  CASE NEW."recordType"
    WHEN 'QuoteVersion' THEN
      SELECT q."companyId", v."partyId" INTO record_company, record_party
        FROM "QuoteVersion" v JOIN "Quote" q ON q."tenantId" = v."tenantId" AND q."id" = v."quoteId"
       WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."recordId";
    WHEN 'SalesOrder' THEN
      SELECT o."companyId", o."partyId" INTO record_company, record_party FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."recordId";
    WHEN 'PortalOrderRequest' THEN
      SELECT r."companyId", r."partyId" INTO record_company, record_party FROM "PortalOrderRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Shipment' THEN
      SELECT s."companyId", o."partyId" INTO record_company, record_party
        FROM "Shipment" s JOIN "SalesOrder" o ON o."tenantId" = s."tenantId" AND o."id" = s."salesOrderId"
       WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."recordId";
    ELSE
      -- A work order makes the customer's orders when one of its cells is of the customer's lines.
      SELECT w."companyId", (SELECT c."partyId" FROM "WorkOrderSize" c
                              WHERE c."tenantId" = w."tenantId" AND c."siteId" = w."siteId" AND c."workOrderId" = w."id" AND c."partyId" = NEW."partyId" LIMIT 1)
        INTO record_company, record_party
        FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."recordId";
  END CASE;
  IF NOT FOUND OR record_company IS DISTINCT FROM NEW."companyId" OR record_party IS DISTINCT FROM NEW."partyId" THEN
    RAISE EXCEPTION 'sales: credit check % names % %, which is no record of its customer and company', NEW."id", NEW."recordType", NEW."recordId"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'sales: credit check % has a currency of three capitals (ISO 4217)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."openOrdersAmount" < 0 OR NEW."openInvoicesAmount" < 0 OR NEW."overdueAmount" < 0 OR NEW."subjectAmount" < 0 OR NEW."exposureAmount" < 0
     OR NEW."limitAmount" < 0 OR NEW."overdueAmount" > NEW."openInvoicesAmount"
     OR NEW."exposureAmount"::bigint <> NEW."openOrdersAmount"::bigint + NEW."openInvoicesAmount"::bigint + NEW."subjectAmount"::bigint THEN
    RAISE EXCEPTION 'sales: credit check % adds up its exposure (open orders % + open invoices % + this one % = %), from 0, the overdue part (%) at most the open invoices, the limit from 0', NEW."id",
      NEW."openOrdersAmount", NEW."openInvoicesAmount", NEW."subjectAmount", NEW."exposureAmount", NEW."overdueAmount"
      USING ERRCODE = 'check_violation';
  END IF;
  over := NEW."limitAmount" IS NOT NULL AND NEW."exposureAmount" > NEW."limitAmount";
  IF (NEW."result" = 'PASS' AND (over OR NEW."onHold"))
     OR (NEW."result" IN ('WARN', 'HOLD') AND NOT (over OR NEW."overdueAmount" > 0 OR NEW."onHold")) THEN
    RAISE EXCEPTION 'sales: credit check % is a %, but it is % (exposure %, limit %, overdue %, on hold %): a PASS is within the limit and not on hold, a WARN or a HOLD says what is wrong', NEW."id", NEW."result",
      CASE WHEN over THEN 'over the limit' ELSE 'within the limit' END, NEW."exposureAmount", coalesce(NEW."limitAmount"::text, 'none'), NEW."overdueAmount", NEW."onHold"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."words", 500, false) OR NOT "factory_recall_words_ok"(NEW."requestId", 200, false) THEN
    RAISE EXCEPTION 'sales: the words of credit check % are one line of at most 500 characters, and its request id not blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."checkedAt") THEN
    RAISE EXCEPTION 'sales: credit check % is not checked in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW."overridesCheckId" IS NULL) <> (NEW."overrideTaskId" IS NULL) THEN
    RAISE EXCEPTION 'sales: credit check % overrides a check exactly with the request for a yes that allowed it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."overridesCheckId" IS NOT NULL THEN
    SELECT c."step"::text AS step, c."recordType", c."recordId", c."result"::text AS result, c."overridesCheckId", c."checkedAt" INTO overridden
      FROM "CreditCheck" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."overridesCheckId";
    IF FOUND AND (overridden."result" <> 'HOLD' OR overridden."overridesCheckId" IS NOT NULL
                  OR (overridden."step", overridden."recordType", overridden."recordId") IS DISTINCT FROM (NEW."step"::text, NEW."recordType", NEW."recordId")
                  OR NEW."checkedAt" < overridden."checkedAt") THEN
      RAISE EXCEPTION 'sales: credit check % overrides check %: a HOLD (not itself an override) of the same step and record, checked not before it', NEW."id", NEW."overridesCheckId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT t."kind"::text AS kind, t."status"::text AS status, t."recordType", t."recordId", t."decidedAt" INTO task
      FROM "ApprovalTask" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."overrideTaskId";
    IF FOUND AND (task."kind" <> 'CREDIT_OVERRIDE' OR task."status" <> 'APPROVED' OR task."recordType" <> 'CreditCheck'
                  OR task."recordId" <> NEW."overridesCheckId" OR NEW."checkedAt" < task."decidedAt") THEN
      RAISE EXCEPTION 'sales: credit check % overrides check % with an APPROVED CREDIT_OVERRIDE request about that check, not before its yes (request % is a % %, of % %)', NEW."id", NEW."overridesCheckId",
        NEW."overrideTaskId", task."status", task."kind", task."recordType", task."recordId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "CreditCheck_append_only" BEFORE UPDATE OR DELETE ON "CreditCheck"
  FOR EACH ROW EXECUTE FUNCTION "factory_credit_check_append_only"();
CREATE TRIGGER "CreditCheck_no_truncate" BEFORE TRUNCATE ON "CreditCheck"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_depth_refuse_truncate"();
CREATE TRIGGER "CreditCheck_check" AFTER INSERT ON "CreditCheck"
  FOR EACH ROW EXECUTE FUNCTION "factory_credit_check_check"();

-- =====================================================================================================================
-- CustomerMaterial
-- =====================================================================================================================

CREATE FUNCTION "factory_customer_material_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_order uuid;
  supplied_by uuid;
  base_uom text;
  order_state text;
  size_count integer;
  size_sum numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."partyId", NEW."orderId", NEW."orderLineId", NEW."bomRevisionId", NEW."bomLineId", NEW."itemId", NEW."itemColourId",
        NEW."uom", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."companyId", OLD."partyId", OLD."orderId", OLD."orderLineId", OLD."bomRevisionId", OLD."bomLineId", OLD."itemId", OLD."itemColourId",
        OLD."uom", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales: the order, line, BOM line, material, colour, unit and creation of customer material % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT l."orderId" INTO line_order FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."orderLineId";
    IF FOUND AND line_order <> NEW."orderId" THEN
      RAISE EXCEPTION 'sales: customer material % is for line % of another order', NEW."id", NEW."orderLineId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT b."customerSuppliedByPartyId" INTO supplied_by FROM "BomLine" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."bomLineId";
    IF FOUND AND supplied_by IS DISTINCT FROM NEW."partyId" THEN
      RAISE EXCEPTION 'sales: customer material % is for BOM line %, whose material the order''s customer does not send (a customer-supplied line of that customer)', NEW."id", NEW."bomLineId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."baseUom"::text INTO base_uom FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND base_uom <> NEW."uom"::text THEN
      RAISE EXCEPTION 'sales: customer material % counts its material in the material''s base unit (%), not %', NEW."id", base_uom, NEW."uom"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT o."status"::text INTO order_state FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."orderId";
    IF FOUND AND order_state IN ('CLOSED', 'CANCELLED') THEN
      RAISE EXCEPTION 'sales: sales order % is %; no customer material is expected for it any more', NEW."orderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."expectedQuantity" < 0 OR NEW."receivedQuantity" < 0 OR NEW."usedQuantity" < 0 OR NEW."returnedQuantity" < 0
     OR NEW."usedQuantity" + NEW."returnedQuantity" > NEW."receivedQuantity" THEN
    RAISE EXCEPTION 'sales: customer material % counts from 0, and uses and returns (% + %) at most what was received (%)', NEW."id", NEW."usedQuantity", NEW."returnedQuantity", NEW."receivedQuantity"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."expectedBySize") IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(NEW."expectedBySize") = 'object' THEN NEW."expectedBySize" ELSE '{}'::jsonb END) e
                 WHERE e.key !~ '^\S{1,20}$' OR jsonb_typeof(e.value) <> 'string' OR NOT "factory_styles_decimal_ok"(e.value #>> '{}', 99999999.9999)) THEN
    RAISE EXCEPTION 'sales: customer material % expects per size an object of size codes to decimals above 0 (at most 4 places, as text)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), coalesce(sum((e.value #>> '{}')::numeric), 0) INTO size_count, size_sum FROM jsonb_each(NEW."expectedBySize") e;
  IF size_count > 200 OR (size_count > 0 AND size_sum <> NEW."expectedQuantity") THEN
    RAISE EXCEPTION 'sales: customer material % expects at most 200 sizes, adding up to its whole (% by size, % in all)', NEW."id", size_sum, NEW."expectedQuantity"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'sales: the note of customer material % is at most 2000 characters, not blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_customer_material_delete_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."receivedQuantity" > 0 OR OLD."usedQuantity" > 0 OR OLD."returnedQuantity" > 0 THEN
    RAISE EXCEPTION 'sales: customer material % was received, used or returned; it is kept (its expected quantity goes to 0 instead)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "CustomerMaterial_check" AFTER INSERT OR UPDATE ON "CustomerMaterial"
  FOR EACH ROW EXECUTE FUNCTION "factory_customer_material_check"();
CREATE TRIGGER "CustomerMaterial_delete_check" BEFORE DELETE ON "CustomerMaterial"
  FOR EACH ROW EXECUTE FUNCTION "factory_customer_material_delete_check"();
CREATE TRIGGER "CustomerMaterial_no_truncate" BEFORE TRUNCATE ON "CustomerMaterial"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_depth_refuse_truncate"();

-- =====================================================================================================================
-- Customer-owned stock: never valued, never bought, never used for another party's order
-- =====================================================================================================================

CREATE FUNCTION "factory_lot_owner_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."ownerPartyId" IS DISTINCT FROM OLD."ownerPartyId" THEN
      RAISE EXCEPTION 'inventory: the owner of lot % is set when it is made, never changed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW."ownerPartyId" IS NOT NULL AND "factory_order_depth_is_customer"(NEW."tenantId", NEW."ownerPartyId") IS FALSE THEN
    RAISE EXCEPTION 'inventory: lot % is owned by a customer: a party with the CUSTOMER or BRAND role', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."receiptLineId" IS NOT NULL THEN
    SELECT r."kind"::text AS kind, r."supplierId" INTO receipt
      FROM "GoodsReceiptLine" l JOIN "GoodsReceipt" r ON r."tenantId" = l."tenantId" AND r."id" = l."receiptId"
     WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."receiptLineId";
    IF FOUND AND ((receipt."kind" = 'CUSTOMER_SUPPLIED') <> (NEW."ownerPartyId" IS NOT NULL) OR NEW."ownerPartyId" <> receipt."supplierId") THEN
      RAISE EXCEPTION 'inventory: lot % of a % receipt: a lot of goods a customer sent (CUSTOMER_SUPPLIED) is owned by that customer, and a lot of goods we bought by nobody', NEW."id", receipt."kind"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Lot_owner_check" AFTER INSERT OR UPDATE OF "ownerPartyId" ON "Lot"
  FOR EACH ROW EXECUTE FUNCTION "factory_lot_owner_check"();

CREATE FUNCTION "factory_stock_move_customer_owned"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner uuid;
BEGIN
  owner := "factory_lot_owner_of"(NEW."tenantId", NEW."lotId");
  IF owner IS NOT NULL AND NOT "factory_work_order_only_for_party"(NEW."tenantId", NEW."siteId", NEW."workOrderId", owner) THEN
    RAISE EXCEPTION 'inventory: lot % is a customer''s own material; it is issued only to a work order whose every cell makes that customer''s orders (stock move %)', NEW."lotId", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StockMove_customer_owned" AFTER INSERT ON "StockMove"
  FOR EACH ROW WHEN (NEW."reason" = 'ISSUE' AND NEW."lotId" IS NOT NULL AND NEW."reversalOfId" IS NULL)
  EXECUTE FUNCTION "factory_stock_move_customer_owned"();

CREATE FUNCTION "factory_reservation_customer_owned"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner uuid;
BEGIN
  IF NEW."lotId" IS NULL THEN
    RETURN NULL;
  END IF;
  owner := "factory_lot_owner_of"(NEW."tenantId", NEW."lotId");
  IF owner IS NOT NULL
     AND ((NEW."salesOrderLineId" IS NOT NULL AND NEW."partyId" IS DISTINCT FROM owner)
          OR (NEW."workOrderId" IS NOT NULL AND NOT "factory_work_order_only_for_party"(NEW."tenantId", NEW."siteId", NEW."workOrderId", owner))) THEN
    RAISE EXCEPTION 'inventory: lot % is a customer''s own material; it is held only for that customer''s order lines, or for a work order whose every cell makes them (reservation %)', NEW."lotId", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Reservation_customer_owned" AFTER INSERT OR UPDATE OF "lotId", "workOrderId", "salesOrderLineId", "partyId" ON "Reservation"
  FOR EACH ROW EXECUTE FUNCTION "factory_reservation_customer_owned"();

CREATE FUNCTION "factory_valuation_not_customer_owned"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lot uuid;
BEGIN
  SELECT m."lotId" INTO lot FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."moveId";
  IF "factory_lot_owner_of"(NEW."tenantId", coalesce(lot, NEW."lotId")) IS NOT NULL THEN
    RAISE EXCEPTION 'inventory: stock move % is of lot %, a customer''s own material: customer-owned stock is never valued', NEW."moveId", coalesce(lot, NEW."lotId")
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StockValuation_not_customer_owned" AFTER INSERT ON "StockValuation"
  FOR EACH ROW EXECUTE FUNCTION "factory_valuation_not_customer_owned"();

CREATE FUNCTION "factory_cost_entry_not_customer_owned"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lot uuid;
BEGIN
  SELECT m."lotId" INTO lot FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."stockMoveId";
  IF "factory_lot_owner_of"(NEW."tenantId", lot) IS NOT NULL THEN
    RAISE EXCEPTION 'costing: stock move % is of lot %, a customer''s own material: customer-owned stock is never costed on a work order', NEW."stockMoveId", lot
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WorkOrderCostEntry_not_customer_owned" AFTER INSERT ON "WorkOrderCostEntry"
  FOR EACH ROW WHEN (NEW."stockMoveId" IS NOT NULL)
  EXECUTE FUNCTION "factory_cost_entry_not_customer_owned"();

-- A transfer to another site (B-W2b-277) keeps the owner: the lot the goods arrive as has the owner of the lot they left.
CREATE FUNCTION "factory_transfer_line_owner_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."toLotId" IS NOT NULL AND NEW."lotId" IS NOT NULL
     AND "factory_lot_owner_of"(NEW."tenantId", NEW."toLotId") IS DISTINCT FROM "factory_lot_owner_of"(NEW."tenantId", NEW."lotId") THEN
    RAISE EXCEPTION 'inventory: transfer line % receives the goods of lot % as lot %, which has another owner: a customer''s own material stays the customer''s at the other site, and ours stays ours', NEW."id", NEW."lotId", NEW."toLotId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "TransferLine_owner_check" AFTER INSERT OR UPDATE OF "lotId", "toLotId" ON "TransferLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_transfer_line_owner_check"();

-- Goods a customer sends (GoodsReceiptKind CUSTOMER_SUPPLIED): never bought.
CREATE FUNCTION "factory_goods_receipt_customer_supplied_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" <> 'CUSTOMER_SUPPLIED' OR (TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD) THEN
    RETURN NULL;
  END IF;
  IF NEW."purchaseOrderId" IS NOT NULL OR NEW."shipNoticeId" IS NOT NULL THEN
    RAISE EXCEPTION 'inventory: goods receipt % holds goods a customer sent (CUSTOMER_SUPPLIED): nothing of it was bought, so it names no purchase order or ship notice', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."supplierId" <> OLD."supplierId") AND "factory_order_depth_is_customer"(NEW."tenantId", NEW."supplierId") IS FALSE THEN
    RAISE EXCEPTION 'inventory: goods receipt % holds goods a customer sent (CUSTOMER_SUPPLIED): its sender is a party with the CUSTOMER or BRAND role', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "GoodsReceipt_customer_supplied_check" AFTER INSERT OR UPDATE ON "GoodsReceipt"
  FOR EACH ROW EXECUTE FUNCTION "factory_goods_receipt_customer_supplied_check"();

CREATE FUNCTION "factory_goods_receipt_line_customer_supplied_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_tracking text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."purchaseOrderLineId", NEW."itemId", NEW."receiptId") IS NOT DISTINCT FROM (OLD."purchaseOrderLineId", OLD."itemId", OLD."receiptId") THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "GoodsReceipt" r WHERE r."tenantId" = NEW."tenantId" AND r."siteId" = NEW."siteId" AND r."id" = NEW."receiptId" AND r."kind" = 'CUSTOMER_SUPPLIED') THEN
    RETURN NULL;
  END IF;
  SELECT i."tracking"::text INTO item_tracking FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
  IF NEW."purchaseOrderLineId" IS NOT NULL OR item_tracking NOT IN ('LOT', 'HIDE') THEN
    RAISE EXCEPTION 'inventory: receipt line % holds goods a customer sent (CUSTOMER_SUPPLIED): it names no purchase order line, and its material is tracked by LOT or HIDE (the lot names its owner; this one is %)', NEW."id", item_tracking
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "GoodsReceiptLine_customer_supplied_check" AFTER INSERT OR UPDATE ON "GoodsReceiptLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_goods_receipt_line_customer_supplied_check"();

-- BEFORE, and named to fire before W2a's SupplierInvoiceMatch_guard: the plainest reason speaks first.
CREATE FUNCTION "factory_supplier_invoice_match_not_customer_supplied"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."goodsReceiptLineId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "GoodsReceiptLine" l JOIN "GoodsReceipt" r ON r."tenantId" = l."tenantId" AND r."id" = l."receiptId"
                  WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."goodsReceiptLineId" AND r."kind" = 'CUSTOMER_SUPPLIED') THEN
    RAISE EXCEPTION 'payables: receipt line % holds goods a customer sent (CUSTOMER_SUPPLIED); nothing of it was bought, so no supplier invoice is matched against it', NEW."goodsReceiptLineId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SupplierInvoiceMatch_customer_supplied" BEFORE INSERT OR UPDATE OF "goodsReceiptLineId" ON "SupplierInvoiceMatch"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_invoice_match_not_customer_supplied"();
