-- Written by hand (Prisma does not model triggers), after the generated 202610319402_portal_supply_w2b_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- W2b schema wave 22/22 (B-W2b-158): the supplier portal (features SCM-023, SCM-086, SCM-106, SCM-107, SCM-110, SCM-154
-- to SCM-157; design 02 portal-links: portal.supplier.asn, .orders, .jobs, links.job, links.onboard). What suppliers and
-- workshops send: ship notices with the tannery's packing list, a substitute or a change that waits for the buyer on a
-- purchase order line, a workshop's answer to a job and its check of the kit, progress reports (append-only), return
-- notices, and the supplier questionnaire with its signed answers. A ship notice and a return notice prefill a receipt
-- and post nothing by themselves.
--
-- apps/factory-api checks all of this first, in words; these rules hold for every login, the owner included. Every
-- refusal is a check_violation (Prisma keeps its words). The guards of the new tables are AFTER triggers: for the
-- runtime roles the row-level-security policies speak first (a row moved to another tenant, site or party fails their
-- WITH CHECK), then the guard holds for every login. A rule that reads another row reads what the role that fires it
-- may read: the partner role reads its own party's purchase orders and lines, ship notices, subcontract orders, kit lines
-- and links; a row it should see and does not is a refusal. The partner role cannot read GoodsReceipt, Location,
-- SubcontractOperation or SupplierQuestionnaire: the rules that need them run for the office and floor only (named
-- below). An UPDATE that changes nothing passes.
--
-- Earlier functions redefined here, each its whole body:
--   factory_purchase_order_line_guard  (…_supply_w2a_guards, W2a wave 3/7; not redefined since): the substitute and the
--                                      buyer's-yes flag join the supplier's proposal columns.
--   factory_subcontract_order_guard    (…_supply_w2a_guards, W2a wave 3/7; not redefined since): the workshop's answer to
--                                      the job and the office's answer to a proposed date; a partner session answers only.
-- NEW triggers (their own functions): GoodsReceipt_ship_notice_check, SubcontractKitLine_workshop_check, and the guards,
-- append-only and TRUNCATE triggers of the seven new tables.

CREATE FUNCTION "factory_portal_supply_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'portal supply: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['ShipNotice', 'ShipNoticeLine', 'ShipNoticeHide', 'SubcontractReturnNotice', 'SupplierQuestionnaire',
                              'SupplierQuestionnaireResponse'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_portal_supply_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- Append-only (scripts/factory/check-append-only.mjs): SubcontractProgressReport. No login may change or remove a row,
-- the owner included; the runtime roles have no UPDATE, DELETE or TRUNCATE grant.
CREATE FUNCTION "factory_portal_supply_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a progress report stays as the workshop sent it', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "SubcontractProgressReport_append_only" BEFORE UPDATE OR DELETE ON "SubcontractProgressReport"
  FOR EACH ROW EXECUTE FUNCTION "factory_portal_supply_refuse_change"();
CREATE TRIGGER "SubcontractProgressReport_no_truncate" BEFORE TRUNCATE ON "SubcontractProgressReport"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_portal_supply_refuse_change"();

-- =====================================================================================================================
-- PurchaseOrderLine (supply.prisma), redefined whole from …_supply_w2a_guards. Kept: every W1 and W2a rule and message.
-- New (SCM-086): proposedSubstituteItemId, proposedSubstituteNote and proposalNeedsBuyer are part of the supplier's
-- proposal: none on a new line; written only while the order is SENT and cleared only while it is DRAFT, with the W1
-- proposal columns; a partner session writes them as it writes the proposal. Every row: the substitute is another item
-- than the line's; its words are not blank (at most 2000 characters); a substitute always waits for the buyer; a line
-- that waits for the buyer holds a proposal (a quantity, a date, a reason or a substitute).
CREATE OR REPLACE FUNCTION "factory_purchase_order_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  answer CONSTANT text[] := ARRAY['confirmedQuantity', 'confirmedDate', 'proposedQuantity', 'proposedDate', 'proposedSplitQuantity',
    'proposedSplitDate', 'proposalReason', 'proposedSubstituteItemId', 'proposedSubstituteNote', 'proposalNeedsBuyer', 'version', 'updatedAt'];
  ending CONSTANT text[] := ARRAY['cancelledAt', 'cancelledById', 'cancelReason', 'closedShortAt', 'closedShortById', 'closeShortReason'];
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
    IF NEW."confirmedQuantity" IS NOT NULL OR NEW."confirmedDate" IS NOT NULL
       OR NEW."proposedQuantity" IS NOT NULL OR NEW."proposedDate" IS NOT NULL OR NEW."proposedSplitQuantity" IS NOT NULL
       OR NEW."proposedSplitDate" IS NOT NULL OR NEW."proposalReason" IS NOT NULL
       OR NEW."proposedSubstituteItemId" IS NOT NULL OR NEW."proposedSubstituteNote" IS NOT NULL OR NEW."proposalNeedsBuyer" THEN
      RAISE EXCEPTION 'supply: purchase order line % is new; the supplier has not confirmed it yet (nor proposed a change)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."cancelledAt" IS NOT NULL OR NEW."closedShortAt" IS NOT NULL THEN
      RAISE EXCEPTION 'supply: purchase order line % is new; it is not cancelled or closed short yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (OLD."cancelledAt" IS NOT NULL OR OLD."closedShortAt" IS NOT NULL)
       AND (to_jsonb(NEW) - (kept || ARRAY['version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'supply: purchase order line % is cancelled or closed short; it changes no more', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF state IS NOT NULL AND state <> 'DRAFT'
       AND (to_jsonb(NEW) - (kept || answer || ending)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer || ending)) THEN
      RAISE EXCEPTION 'supply: purchase order % is %; its lines change only while it is DRAFT (recall it to change them)', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."confirmedQuantity", NEW."confirmedDate") IS DISTINCT FROM (OLD."confirmedQuantity", OLD."confirmedDate")
       AND NOT (state IS NOT DISTINCT FROM 'DRAFT' AND NEW."confirmedQuantity" IS NULL AND NEW."confirmedDate" IS NULL)
       AND ((OLD."confirmedQuantity" IS NOT NULL AND NEW."confirmedQuantity" IS DISTINCT FROM OLD."confirmedQuantity")
            OR (OLD."confirmedDate" IS NOT NULL AND NEW."confirmedDate" IS DISTINCT FROM OLD."confirmedDate")
            OR (state IS NOT NULL AND state NOT IN ('SENT', 'CHANGES_PROPOSED', 'CONFIRMED'))) THEN
      RAISE EXCEPTION 'supply: the supplier''s confirmation of purchase order line % is set once, while its order is SENT or CONFIRMED (or CHANGES_PROPOSED, when the buyer accepts the supplier''s changes), and cleared only while its order is DRAFT for a new revision', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."proposedQuantity", NEW."proposedDate", NEW."proposedSplitQuantity", NEW."proposedSplitDate", NEW."proposalReason",
        NEW."proposedSubstituteItemId", NEW."proposedSubstituteNote", NEW."proposalNeedsBuyer")
       IS DISTINCT FROM
       (OLD."proposedQuantity", OLD."proposedDate", OLD."proposedSplitQuantity", OLD."proposedSplitDate", OLD."proposalReason",
        OLD."proposedSubstituteItemId", OLD."proposedSubstituteNote", OLD."proposalNeedsBuyer")
       AND state IS NOT NULL AND state <> 'SENT'
       AND NOT (state = 'DRAFT' AND NEW."proposedQuantity" IS NULL AND NEW."proposedDate" IS NULL AND NEW."proposedSplitQuantity" IS NULL
                AND NEW."proposedSplitDate" IS NULL AND NEW."proposalReason" IS NULL
                AND NEW."proposedSubstituteItemId" IS NULL AND NEW."proposedSubstituteNote" IS NULL AND NOT NEW."proposalNeedsBuyer") THEN
      RAISE EXCEPTION 'supply: the supplier''s proposal for purchase order line % is written only while its order is SENT (and cleared only while it is DRAFT)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."cancelledAt", NEW."cancelledById", NEW."cancelReason") IS DISTINCT FROM (OLD."cancelledAt", OLD."cancelledById", OLD."cancelReason")
       AND NOT (OLD."cancelledAt" IS NULL AND NEW."cancelledAt" IS NOT NULL AND btrim(coalesce(NEW."cancelReason", '')) <> ''
                AND (state IS NULL OR state NOT IN ('RECEIVED', 'CLOSED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'supply: purchase order line % is cancelled once, with its time and reason, while its order is not received, closed or cancelled', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."closedShortAt", NEW."closedShortById", NEW."closeShortReason") IS DISTINCT FROM (OLD."closedShortAt", OLD."closedShortById", OLD."closeShortReason")
       AND NOT (OLD."closedShortAt" IS NULL AND NEW."closedShortAt" IS NOT NULL AND btrim(coalesce(NEW."closeShortReason", '')) <> ''
                AND (state IS NULL OR state = 'PARTLY_RECEIVED')) THEN
      RAISE EXCEPTION 'supply: purchase order line % is closed short once, with its time and reason, while its order is PARTLY_RECEIVED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND ((to_jsonb(NEW) - (kept || answer)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer))
            OR ((NEW."confirmedQuantity", NEW."confirmedDate") IS DISTINCT FROM (OLD."confirmedQuantity", OLD."confirmedDate") AND state IS DISTINCT FROM 'SENT')) THEN
      RAISE EXCEPTION 'supply: a partner session only confirms the lines of its SENT purchase order, or proposes changes to them (line %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."quantity" <= 0 OR NEW."baseQuantity" <= 0 OR NEW."unitPrice" < 0 OR NEW."netAmount" < 0 OR NEW."confirmedQuantity" < 0
     OR NEW."estimatedHides" < 0 OR NEW."areaTolerancePct" < 0 OR NEW."thicknessMinMm" > NEW."thicknessMaxMm" THEN
    RAISE EXCEPTION 'supply: purchase order line % has a quantity above 0, no negative price, amount, confirmed quantity, hides or tolerance, and a thickness range from low to high', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."proposedQuantity" < 0
     OR (NEW."proposedSplitQuantity" IS NULL) <> (NEW."proposedSplitDate" IS NULL)
     OR NEW."proposedSplitQuantity" <= 0
     OR (NEW."proposedSplitQuantity" IS NOT NULL AND (NEW."proposedQuantity" IS NULL OR NEW."proposedQuantity" <= 0 OR NEW."proposedDate" IS NULL)) THEN
    RAISE EXCEPTION 'supply: purchase order line % has no negative proposed quantity, and a second delivery with its quantity and date after a first one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b (wave 22/22, SCM-086): the substitute and the buyer's yes.
  IF NEW."proposedSubstituteItemId" = NEW."itemId"
     OR (NEW."proposedSubstituteNote" IS NOT NULL AND (btrim(NEW."proposedSubstituteNote") = '' OR length(NEW."proposedSubstituteNote") > 2000))
     OR ((NEW."proposedSubstituteItemId" IS NOT NULL OR NEW."proposedSubstituteNote" IS NOT NULL) AND NOT NEW."proposalNeedsBuyer")
     OR (NEW."proposalNeedsBuyer" AND NEW."proposedQuantity" IS NULL AND NEW."proposedDate" IS NULL AND NEW."proposalReason" IS NULL
         AND NEW."proposedSubstituteItemId" IS NULL AND NEW."proposedSubstituteNote" IS NULL) THEN
    RAISE EXCEPTION 'supply: purchase order line % proposes a substitute other than its own item (its words not blank, at most 2000 characters) that always waits for the buyer, and waits for the buyer only with a proposal', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."cancelledAt" IS NOT NULL AND NEW."closedShortAt" IS NOT NULL)
     OR (NEW."cancelledAt" IS NULL AND (NEW."cancelledById" IS NOT NULL OR NEW."cancelReason" IS NOT NULL))
     OR (NEW."closedShortAt" IS NULL AND (NEW."closedShortById" IS NOT NULL OR NEW."closeShortReason" IS NOT NULL)) THEN
    RAISE EXCEPTION 'supply: purchase order line % is cancelled or closed short (not both), each with its own time', NEW."id"
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

-- =====================================================================================================================
-- SubcontractOrder (subcontract.prisma), redefined whole from …_supply_w2a_guards. Kept: every W2a rule and message. New
-- (JOB_ACCEPT, PLN-163, SCM-154):
--   the answer  acceptedAt (+ acceptedByName, + proposedDate with its reason) or declinedAt (+ its reason, + declinedByName),
--               never both; given once, from no answer: accepted while the order is ISSUED, AT_WORKSHOP or PARTLY_RECEIVED,
--               declined while ISSUED or AT_WORKSHOP; cleared only when the order goes back to DRAFT (a DRAFT order holds
--               none: the move back to DRAFT clears it, here). A proposed date not before the order date; names 1..200,
--               reasons 1..2000 characters.
--   the office's answer to the proposed date  proposedDateDecision with its time (and who), set once while the order is
--               neither DRAFT, CLOSED nor CANCELLED; ACCEPTED moves the expected-back date to the proposed date in the same
--               write; cleared only with the answer (back to DRAFT).
--   a partner session  changes only the workshop's answer (acceptedAt, acceptedByName, proposedDate, proposedDateReason,
--               declinedAt, declinedByName, declineReason; version, updatedAt): never the status, the terms or the office's
--               answer. Its key columns are left to the policies; it never reads a Location (the workshop's place is
--               checked for the office's writes only) nor an operation (it never issues).
CREATE OR REPLACE FUNCTION "factory_subcontract_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  -- W2b (wave 22/22): the workshop's answer and the office's answer to a proposed date.
  answer CONSTANT text[] := ARRAY['acceptedAt', 'acceptedByName', 'proposedDate', 'proposedDateReason', 'declinedAt', 'declinedByName',
    'declineReason'];
  decided CONSTANT text[] := ARRAY['proposedDateDecision', 'proposedDateDecidedAt', 'proposedDateDecidedById'];
  progress CONSTANT text[] := ARRAY['status', 'issuedAt', 'issuedById', 'closedAt', 'cancelledAt', 'cancelReason', 'expectedBackDate',
    'note', 'internalNote', 'version', 'updatedAt'] || answer || decided;
  place record;
  op_count integer;
  op_total bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supply: subcontract order % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: subcontract order % starts as DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'supply: the company, number and creation of subcontract order % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b: a portal or link session (the workshop) only answers its job.
    IF current_user = 'factory_partner_runtime'
       AND (to_jsonb(NEW) - (kept || answer || ARRAY['version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer || ARRAY['version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'supply: a partner session only answers its job on subcontract order % (accept, propose another date, or decline)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('ISSUED', 'CANCELLED'))
                OR (OLD."status" = 'ISSUED' AND NEW."status" IN ('DRAFT', 'AT_WORKSHOP', 'CANCELLED'))
                OR (OLD."status" = 'AT_WORKSHOP' AND NEW."status" IN ('ISSUED', 'PARTLY_RECEIVED', 'RECEIVED'))
                OR (OLD."status" = 'PARTLY_RECEIVED' AND NEW."status" IN ('AT_WORKSHOP', 'RECEIVED'))
                OR (OLD."status" = 'RECEIVED' AND NEW."status" IN ('PARTLY_RECEIVED', 'CLOSED'))) THEN
      RAISE EXCEPTION 'supply: subcontract order % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - (kept || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || progress)) THEN
      RAISE EXCEPTION 'supply: subcontract order % is %; its terms change only while it is DRAFT', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'supply: subcontract order % is %; only its internal note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b: back to DRAFT (to be changed and issued again), the workshop's answer and the office's answer to its date go:
    -- the next issue asks again. The database clears them, so the W2a recall needs no change.
    IF OLD."status" <> 'DRAFT' AND NEW."status" = 'DRAFT' THEN
      NEW."acceptedAt" := NULL;
      NEW."acceptedByName" := NULL;
      NEW."proposedDate" := NULL;
      NEW."proposedDateReason" := NULL;
      NEW."declinedAt" := NULL;
      NEW."declinedByName" := NULL;
      NEW."declineReason" := NULL;
      NEW."proposedDateDecision" := NULL;
      NEW."proposedDateDecidedAt" := NULL;
      NEW."proposedDateDecidedById" := NULL;
    END IF;
    IF (NEW."issuedAt", NEW."issuedById") IS DISTINCT FROM (OLD."issuedAt", OLD."issuedById")
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'ISSUED') OR (OLD."status" = 'ISSUED' AND NEW."status" = 'DRAFT')) THEN
      RAISE EXCEPTION 'supply: subcontract order % gets its issue time when it is issued, and loses it when it goes back to DRAFT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b: the workshop's answer is given once, from none, while the order is out (accepted also once some came back);
    -- it is cleared only when the order goes back to DRAFT (the row rules below keep a DRAFT order without one).
    IF (NEW."acceptedAt", NEW."acceptedByName", NEW."proposedDate", NEW."proposedDateReason", NEW."declinedAt", NEW."declinedByName", NEW."declineReason")
       IS DISTINCT FROM
       (OLD."acceptedAt", OLD."acceptedByName", OLD."proposedDate", OLD."proposedDateReason", OLD."declinedAt", OLD."declinedByName", OLD."declineReason")
       AND NOT (NEW."status" = 'DRAFT')
       AND NOT (OLD."acceptedAt" IS NULL AND OLD."declinedAt" IS NULL
                AND ((NEW."acceptedAt" IS NOT NULL AND OLD."status" IN ('ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'))
                     OR (NEW."declinedAt" IS NOT NULL AND OLD."status" IN ('ISSUED', 'AT_WORKSHOP')))) THEN
      RAISE EXCEPTION 'supply: the workshop answers subcontract order % once: it accepts while the order is ISSUED, AT_WORKSHOP or PARTLY_RECEIVED, or declines while it is ISSUED or AT_WORKSHOP; the answer is cleared only when the order goes back to DRAFT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b: the office answers a proposed date once; ACCEPTED makes it the expected-back date in the same write.
    IF (NEW."proposedDateDecision", NEW."proposedDateDecidedAt", NEW."proposedDateDecidedById")
       IS DISTINCT FROM (OLD."proposedDateDecision", OLD."proposedDateDecidedAt", OLD."proposedDateDecidedById")
       AND NOT (NEW."status" = 'DRAFT')
       AND NOT (OLD."proposedDateDecision" IS NULL AND NEW."proposedDateDecision" IS NOT NULL AND OLD."proposedDate" IS NOT NULL
                AND NEW."proposedDate" IS NOT DISTINCT FROM OLD."proposedDate" AND OLD."status" NOT IN ('DRAFT', 'CLOSED', 'CANCELLED')
                AND (NEW."proposedDateDecision" <> 'ACCEPTED' OR NEW."expectedBackDate" IS NOT DISTINCT FROM NEW."proposedDate")) THEN
      RAISE EXCEPTION 'supply: the office answers the date the workshop proposed for subcontract order % once (ACCEPTED makes it the expected-back date), while the order is out', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'ISSUED' THEN
      SELECT count(*), coalesce(sum(o."netAmount"), 0) INTO op_count, op_total
        FROM "SubcontractOperation" o WHERE o."tenantId" = NEW."tenantId" AND o."subcontractOrderId" = NEW."id";
      IF op_count = 0 THEN
        RAISE EXCEPTION 'supply: subcontract order % has no operation; it cannot be issued', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF op_total <> NEW."netAmount" THEN
        RAISE EXCEPTION 'supply: the amount of subcontract order % (%) is not the sum of its operations (%)', NEW."id", NEW."netAmount", op_total
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF current_user <> 'factory_partner_runtime'
     AND (TG_OP = 'INSERT' OR (NEW."locationId", NEW."partyId") IS DISTINCT FROM (OLD."locationId", OLD."partyId")) THEN
    SELECT l."kind"::text AS kind, l."partyId" INTO place FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."locationId";
    IF FOUND AND (place.kind <> 'SUBCONTRACTOR' OR place."partyId" IS DISTINCT FROM NEW."partyId") THEN
      RAISE EXCEPTION 'supply: subcontract order % sends its work to a SUBCONTRACTOR location of its workshop', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."netAmount" < 0 OR NEW."currency" !~ '^[A-Z]{3}$' OR NEW."expectedBackDate" < NEW."orderDate"
     OR (NEW."status" IN ('ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED') AND NEW."issuedAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND NEW."issuedAt" IS NOT NULL)
     OR (NEW."issuedAt" IS NULL AND NEW."issuedById" IS NOT NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED' AND btrim(coalesce(NEW."cancelReason", '')) = '') THEN
    RAISE EXCEPTION 'supply: subcontract order % is % with the wrong fields (no negative amount, an ISO 4217 currency, due back after its date, issued from ISSUED on, closed or cancelled with its time and reason)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b (wave 22/22): the shape of the workshop's answer and of the office's answer to a proposed date.
  IF (NEW."acceptedAt" IS NOT NULL AND NEW."declinedAt" IS NOT NULL)
     OR (NEW."acceptedAt" IS NULL AND (NEW."acceptedByName" IS NOT NULL OR NEW."proposedDate" IS NOT NULL OR NEW."proposedDateReason" IS NOT NULL))
     OR (NEW."declinedAt" IS NULL AND (NEW."declinedByName" IS NOT NULL OR NEW."declineReason" IS NOT NULL))
     OR (NEW."declinedAt" IS NOT NULL AND btrim(coalesce(NEW."declineReason", '')) = '')
     OR (NEW."proposedDate" IS NULL) <> (btrim(coalesce(NEW."proposedDateReason", '')) = '')
     OR NEW."proposedDate" < NEW."orderDate"
     OR btrim(NEW."acceptedByName") = '' OR length(NEW."acceptedByName") > 200
     OR btrim(NEW."declinedByName") = '' OR length(NEW."declinedByName") > 200
     OR length(NEW."declineReason") > 2000 OR length(NEW."proposedDateReason") > 2000
     OR (NEW."proposedDateDecision" IS NOT NULL AND NEW."proposedDate" IS NULL)
     OR (NEW."proposedDateDecision" IS NULL) <> (NEW."proposedDateDecidedAt" IS NULL)
     OR (NEW."proposedDateDecision" IS NULL AND NEW."proposedDateDecidedById" IS NOT NULL)
     OR (NEW."status" = 'DRAFT' AND (NEW."acceptedAt" IS NOT NULL OR NEW."declinedAt" IS NOT NULL OR NEW."proposedDateDecision" IS NOT NULL)) THEN
    RAISE EXCEPTION 'supply: subcontract order % holds the workshop''s answer as accepted (a proposed date only with its reason, not before the order date) or declined (with its reason), never both and never while DRAFT; the office''s answer to a proposed date with its time; names at most 200 and reasons at most 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- SubcontractKitLine (subcontract.prisma), a NEW trigger beside W2a's SubcontractKitLine_guard (SCM-155): the workshop's
-- check of the kit, receivedByWorkshopAt, receivedByWorkshopQuantity and receivedByWorkshopNote:
--   every row  all three only while the line is SENT, the time and the count (0 or more, in the line's unit) together,
--              not before the line was sent; the words not blank, at most 2000 characters.
--   UPDATE     written once, from none, while the line is SENT; cleared only when the line goes back to PLANNED (its
--              transfer reversed). A partner session (the workshop) changes only these three.
CREATE FUNCTION "factory_kit_line_workshop_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  received CONSTANT text[] := ARRAY['receivedByWorkshopAt', 'receivedByWorkshopQuantity', 'receivedByWorkshopNote', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND (to_jsonb(NEW) - (kept || received)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || received)) THEN
      RAISE EXCEPTION 'supply: a partner session only checks the kit it received (kit line %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."receivedByWorkshopAt", NEW."receivedByWorkshopQuantity", NEW."receivedByWorkshopNote")
       IS DISTINCT FROM (OLD."receivedByWorkshopAt", OLD."receivedByWorkshopQuantity", OLD."receivedByWorkshopNote")
       AND NOT (OLD."receivedByWorkshopAt" IS NULL AND OLD."receivedByWorkshopQuantity" IS NULL AND OLD."receivedByWorkshopNote" IS NULL
                AND OLD."status" = 'SENT' AND NEW."status" = 'SENT')
       AND NOT (OLD."status" = 'SENT' AND NEW."status" = 'PLANNED' AND NEW."receivedByWorkshopAt" IS NULL
                AND NEW."receivedByWorkshopQuantity" IS NULL AND NEW."receivedByWorkshopNote" IS NULL) THEN
      RAISE EXCEPTION 'supply: the workshop checks kit line % once, while it is SENT; the check is cleared only when the line goes back to PLANNED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."receivedByWorkshopAt" IS NULL) <> (NEW."receivedByWorkshopQuantity" IS NULL)
     OR (NEW."receivedByWorkshopAt" IS NULL AND NEW."receivedByWorkshopNote" IS NOT NULL)
     OR (NEW."receivedByWorkshopAt" IS NOT NULL AND (NEW."status" <> 'SENT' OR NEW."receivedByWorkshopAt" < NEW."sentAt"))
     OR NEW."receivedByWorkshopQuantity" < 0
     OR btrim(NEW."receivedByWorkshopNote") = '' OR length(NEW."receivedByWorkshopNote") > 2000 THEN
    RAISE EXCEPTION 'supply: kit line % holds the workshop''s check (when and how much, 0 or more, with its words not blank and at most 2000 characters) only while SENT, not before it was sent', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SubcontractKitLine_workshop_check" AFTER INSERT OR UPDATE ON "SubcontractKitLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_kit_line_workshop_check"();

-- =====================================================================================================================
-- GoodsReceipt (inventory.prisma), a NEW trigger beside its guard (SCM-106): the ship notice it was prefilled from (its
-- reference already pins the notice to the receipt's site and supplier) delivers the receipt's purchase order and is SENT
-- or RECEIVED (by an earlier receipt), never a DRAFT or a cancelled one. It changes only while the receipt is OPEN
-- (factory_goods_receipt_guard: what was received changes only while OPEN).
CREATE FUNCTION "factory_goods_receipt_ship_notice_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  notice_order uuid;
  notice_state text;
BEGIN
  IF NEW."shipNoticeId" IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."shipNoticeId", NEW."purchaseOrderId") IS NOT DISTINCT FROM (OLD."shipNoticeId", OLD."purchaseOrderId") THEN
    RETURN NULL;
  END IF;
  SELECT n."purchaseOrderId", n."status"::text INTO notice_order, notice_state FROM "ShipNotice" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."shipNoticeId";
  IF notice_state IS NULL OR notice_order IS DISTINCT FROM NEW."purchaseOrderId" OR notice_state NOT IN ('SENT', 'RECEIVED') THEN
    RAISE EXCEPTION 'inventory: goods receipt % is prefilled from a SENT (or RECEIVED) ship notice of its own purchase order (notice %)', NEW."id", NEW."shipNoticeId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "GoodsReceipt_ship_notice_check" AFTER INSERT OR UPDATE ON "GoodsReceipt"
  FOR EACH ROW EXECUTE FUNCTION "factory_goods_receipt_ship_notice_check"();

-- =====================================================================================================================
-- ShipNotice (portal-supply.prisma; SCM-106)
--   INSERT   a DRAFT without a number, send, receipt or cancellation, version 1; its purchase order SENT, CONFIRMED or
--            PARTLY_RECEIVED (a party reads its own orders).
--   UPDATE   company, site, party, order and creation never change. DRAFT → SENT (with its number and send time, at least
--            one line, a ship date); SENT → RECEIVED (its receipt time; a POSTED goods receipt names it); RECEIVED → SENT
--            (no POSTED receipt names it any more); SENT → CANCELLED (with its time and reason; no POSTED receipt names
--            it: checked for the office, the partner role reads no receipt). The number and send time are written only in
--            DRAFT → SENT. A RECEIVED notice changes only its status and receipt time (back to SENT) and the office's note;
--            a CANCELLED one only the office's note. A partner session changes the supplier's terms and cancels a SENT
--            notice: never its number, the move to SENT or RECEIVED, nor the receipt time.
--   DELETE   only a DRAFT (its lines first).
--   every row  DRAFT without a number or send time; from SENT on a number (1..40), its send time and ship date; RECEIVED
--            exactly with its receipt time, CANCELLED exactly with its time and reason; expected not before shipped; a DDT
--            date only with its number; parcels 1..9999; the texts not blank and short (references 60, carrier and
--            tracking 100, notes and reason 2000).
CREATE FUNCTION "factory_ship_notice_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  partner_columns CONSTANT text[] := ARRAY['supplierRef', 'ddtNumber', 'ddtDate', 'shipDate', 'expectedDate', 'carrier', 'trackingNumber',
    'parcels', 'note', 'status', 'cancelledAt', 'cancelReason', 'version', 'updatedAt'];
  order_state text;
  line_count integer;
  posted integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'portal supply: ship notice % is %; only a DRAFT is deleted (a sent one is cancelled)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."number" IS NOT NULL OR NEW."sentAt" IS NOT NULL OR NEW."receivedAt" IS NOT NULL
       OR NEW."cancelledAt" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'portal supply: ship notice % starts as a DRAFT without a number, send, receipt or cancellation, version 1', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT o."status"::text INTO order_state FROM "PurchaseOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."purchaseOrderId";
    IF order_state IS NULL OR order_state NOT IN ('SENT', 'CONFIRMED', 'PARTLY_RECEIVED') THEN
      RAISE EXCEPTION 'portal supply: ship notice % announces goods of a SENT, CONFIRMED or PARTLY_RECEIVED purchase order (%)', NEW."id", coalesce(order_state, 'not visible')
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."siteId", NEW."partyId", NEW."purchaseOrderId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."siteId", OLD."partyId", OLD."purchaseOrderId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'portal supply: the company, site, supplier, purchase order and creation of ship notice % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND ((to_jsonb(NEW) - (kept || partner_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || partner_columns))
            OR (NEW."status" <> OLD."status" AND NOT (OLD."status" = 'SENT' AND NEW."status" = 'CANCELLED'))) THEN
      RAISE EXCEPTION 'portal supply: a partner session changes its ship notice % until it is received and cancels a sent one; the office numbers, sends and receives it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'SENT')
                OR (OLD."status" = 'SENT' AND NEW."status" IN ('RECEIVED', 'CANCELLED'))
                OR (OLD."status" = 'RECEIVED' AND NEW."status" = 'SENT')) THEN
      RAISE EXCEPTION 'portal supply: ship notice % cannot move from % to % (a DRAFT is deleted, not cancelled)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."number", NEW."sentAt") IS DISTINCT FROM (OLD."number", OLD."sentAt") AND NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'SENT') THEN
      RAISE EXCEPTION 'portal supply: ship notice % gets its number and send time when it is sent, and keeps them', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'RECEIVED'
       AND (to_jsonb(NEW) - (kept || ARRAY['status', 'receivedAt', 'internalNote', 'version', 'updatedAt']))
           IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['status', 'receivedAt', 'internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'portal supply: ship notice % is RECEIVED; it changes no more (but back to SENT when its receipt is reversed)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CANCELLED'
       AND (to_jsonb(NEW) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'portal supply: ship notice % is CANCELLED; only the office''s note changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'SENT' THEN
      SELECT count(*) INTO line_count FROM "ShipNoticeLine" l WHERE l."tenantId" = NEW."tenantId" AND l."shipNoticeId" = NEW."id";
      IF line_count = 0 THEN
        RAISE EXCEPTION 'portal supply: ship notice % has no line; it cannot be sent', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."status" <> OLD."status" AND NEW."status" IN ('RECEIVED', 'SENT', 'CANCELLED') AND OLD."status" <> 'DRAFT'
       AND current_user <> 'factory_partner_runtime' THEN
      SELECT count(*) INTO posted FROM "GoodsReceipt" r WHERE r."tenantId" = NEW."tenantId" AND r."shipNoticeId" = NEW."id" AND r."status" = 'POSTED';
      IF (NEW."status" = 'RECEIVED') <> (posted > 0) THEN
        RAISE EXCEPTION 'portal supply: ship notice % is RECEIVED exactly while a POSTED goods receipt names it (% do)', NEW."id", posted
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF (NEW."status" = 'DRAFT' AND (NEW."number" IS NOT NULL OR NEW."sentAt" IS NOT NULL))
     OR (NEW."status" <> 'DRAFT' AND (NEW."number" IS NULL OR NEW."sentAt" IS NULL OR NEW."shipDate" IS NULL))
     OR btrim(NEW."number") = '' OR length(NEW."number") > 40
     OR (NEW."status" = 'RECEIVED') <> (NEW."receivedAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '')
     OR NEW."expectedDate" < NEW."shipDate"
     OR (NEW."ddtDate" IS NOT NULL AND NEW."ddtNumber" IS NULL)
     OR NEW."parcels" < 1 OR NEW."parcels" > 9999
     OR btrim(NEW."supplierRef") = '' OR length(NEW."supplierRef") > 60
     OR btrim(NEW."ddtNumber") = '' OR length(NEW."ddtNumber") > 60
     OR btrim(NEW."carrier") = '' OR length(NEW."carrier") > 100
     OR btrim(NEW."trackingNumber") = '' OR length(NEW."trackingNumber") > 100
     OR length(NEW."note") > 2000 OR length(NEW."internalNote") > 2000 OR length(NEW."cancelReason") > 2000 THEN
    RAISE EXCEPTION 'portal supply: ship notice % is % with the wrong fields (a number, send time and ship date from SENT on; received or cancelled with its time and reason; expected not before shipped; a DDT date with its number; 1 to 9999 parcels; short texts)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ShipNotice_guard" AFTER INSERT OR UPDATE OR DELETE ON "ShipNotice"
  FOR EACH ROW EXECUTE FUNCTION "factory_ship_notice_guard"();

-- ShipNoticeLine (SCM-106)
--   any write  only while its notice is DRAFT or SENT.
--   INSERT     nothing received yet.
--   UPDATE     it never moves to another notice; its creation is fixed.
--   the order line  a line of the notice's purchase order, in the line's own unit, not cancelled or closed short (on
--              insert and when the line or unit changes; a row the session should see and does not is refused).
--   received   the received quantity is the office's (never a partner session's), written while the notice is SENT.
--   every row  a place from 1, a quantity above 0, a received quantity from 0; lot and dye batch not blank (60), note 2000.
CREATE FUNCTION "factory_ship_notice_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  notice_id uuid;
  tenant uuid;
  notice_state text;
  notice_order uuid;
  line_order uuid;
  line_uom text;
  line_ended boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    notice_id := OLD."shipNoticeId";
    tenant := OLD."tenantId";
  ELSE
    notice_id := NEW."shipNoticeId";
    tenant := NEW."tenantId";
  END IF;
  SELECT n."status"::text, n."purchaseOrderId" INTO notice_state, notice_order FROM "ShipNotice" n WHERE n."tenantId" = tenant AND n."id" = notice_id;
  IF notice_state IS NULL OR notice_state NOT IN ('DRAFT', 'SENT') THEN
    RAISE EXCEPTION 'portal supply: ship notice % is %; its lines change only while it is DRAFT or SENT', notice_id, coalesce(notice_state, 'not visible')
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."receivedQuantity" IS NOT NULL THEN
      RAISE EXCEPTION 'portal supply: ship notice line % is new; nothing of it was received yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (NEW."id", NEW."shipNoticeId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."shipNoticeId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'portal supply: ship notice line % never moves to another notice; its creation is fixed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."receivedQuantity" IS DISTINCT FROM OLD."receivedQuantity"
       AND (current_user = 'factory_partner_runtime' OR notice_state <> 'SENT') THEN
      RAISE EXCEPTION 'portal supply: what the receipt took of ship notice line % is the office''s, written while the notice is SENT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR (NEW."purchaseOrderLineId", NEW."uom") IS DISTINCT FROM (OLD."purchaseOrderLineId", OLD."uom") THEN
    SELECT l."purchaseOrderId", l."uom"::text, (l."cancelledAt" IS NOT NULL OR l."closedShortAt" IS NOT NULL)
      INTO line_order, line_uom, line_ended FROM "PurchaseOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."purchaseOrderLineId";
    IF line_order IS NULL OR line_order IS DISTINCT FROM notice_order OR line_uom IS DISTINCT FROM NEW."uom"::text OR line_ended THEN
      RAISE EXCEPTION 'portal supply: ship notice line % delivers an open line of its notice''s purchase order, in that line''s unit', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."seq" < 1 OR NEW."quantity" <= 0 OR NEW."receivedQuantity" < 0
     OR btrim(NEW."supplierLot") = '' OR length(NEW."supplierLot") > 60
     OR btrim(NEW."dyeBatch") = '' OR length(NEW."dyeBatch") > 60
     OR length(NEW."note") > 2000 THEN
    RAISE EXCEPTION 'portal supply: ship notice line % has a place from 1, a quantity above 0, a received quantity from 0, and short texts', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ShipNoticeLine_guard" AFTER INSERT OR UPDATE OR DELETE ON "ShipNoticeLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_ship_notice_line_guard"();

-- ShipNoticeHide (SCM-107): the tannery's packing list.
--   any write  only while its notice is DRAFT or SENT.
--   UPDATE     it never moves to another line; its creation is fixed.
--   every row  a place from 1; the tannery's number trimmed, 1..60 characters, no control character; an area above 0 in
--              M2, DM2 or FT2; a thickness above 0 and below 100 mm; grade and dye batch not blank (60); note 2000.
CREATE FUNCTION "factory_ship_notice_hide_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  notice_id uuid;
  tenant uuid;
  state text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    notice_id := OLD."shipNoticeId";
    tenant := OLD."tenantId";
  ELSE
    notice_id := NEW."shipNoticeId";
    tenant := NEW."tenantId";
  END IF;
  SELECT n."status"::text INTO state FROM "ShipNotice" n WHERE n."tenantId" = tenant AND n."id" = notice_id;
  IF state IS NULL OR state NOT IN ('DRAFT', 'SENT') THEN
    RAISE EXCEPTION 'portal supply: ship notice % is %; its packing list changes only while it is DRAFT or SENT', notice_id, coalesce(state, 'not visible')
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW."id", NEW."shipNoticeId", NEW."shipNoticeLineId", NEW."createdAt", NEW."createdById")
         IS DISTINCT FROM (OLD."id", OLD."shipNoticeId", OLD."shipNoticeLineId", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'portal supply: packing list hide % never moves to another line; its creation is fixed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 1
     OR NEW."hideNumber" <> btrim(NEW."hideNumber") OR length(NEW."hideNumber") NOT BETWEEN 1 AND 60 OR NEW."hideNumber" ~ '[[:cntrl:]]'
     OR NEW."area" <= 0 OR NEW."areaUom"::text NOT IN ('M2', 'DM2', 'FT2')
     OR NEW."thicknessMm" <= 0 OR NEW."thicknessMm" >= 100
     OR btrim(NEW."grade") = '' OR length(NEW."grade") > 60
     OR btrim(NEW."dyeBatch") = '' OR length(NEW."dyeBatch") > 60
     OR length(NEW."note") > 2000 THEN
    RAISE EXCEPTION 'portal supply: packing list hide % has a place from 1, the tannery''s number (1 to 60 characters, trimmed), an area above 0 in M2, DM2 or FT2, a thickness above 0 and below 100 mm, and short texts', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ShipNoticeHide_guard" AFTER INSERT OR UPDATE OR DELETE ON "ShipNoticeHide"
  FOR EACH ROW EXECUTE FUNCTION "factory_ship_notice_hide_guard"();

-- =====================================================================================================================
-- SubcontractProgressReport (SCM-156), append-only (above). INSERT: its order ISSUED, AT_WORKSHOP or PARTLY_RECEIVED and
-- not declined (a workshop reads its own orders); finished pieces 1..100000; the name 1..200 characters, not blank; the
-- finish-by day not before the order date; the note at most 2000 characters. Its operation, bundle and cell are the
-- order's, the work order's (their references).
CREATE FUNCTION "factory_subcontract_progress_report_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_state text;
  job_declined timestamptz;
  job_date date;
BEGIN
  SELECT o."status"::text, o."declinedAt", o."orderDate" INTO job_state, job_declined, job_date
    FROM "SubcontractOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."subcontractOrderId";
  IF job_state IS NULL OR job_state NOT IN ('ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED') OR job_declined IS NOT NULL THEN
    RAISE EXCEPTION 'portal supply: progress is reported on a subcontract order that is out (ISSUED, AT_WORKSHOP or PARTLY_RECEIVED) and not declined (order %)', NEW."subcontractOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."finishedQuantity" < 1 OR NEW."finishedQuantity" > 100000
     OR btrim(NEW."reportedByName") = '' OR length(NEW."reportedByName") > 200
     OR NEW."finishBy" < job_date
     OR length(NEW."note") > 2000 THEN
    RAISE EXCEPTION 'portal supply: progress report % has 1 to 100000 finished pieces, who reported it (1 to 200 characters), a finish-by day not before the order date and a short note', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SubcontractProgressReport_check" AFTER INSERT ON "SubcontractProgressReport"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontract_progress_report_check"();

-- SubcontractReturnNotice (SCM-157)
--   INSERT   ANNOUNCED, nothing received or cancelled, version 1; its order AT_WORKSHOP or PARTLY_RECEIVED and not
--            declined. What comes back: a list of at least one entry, each naming an operation (a uuid; bundle and cell
--            uuids or null), whole finished and scrapped pieces from 0, a reason code (no spaces) for scrapped pieces, at
--            least one piece in all; the unused material: each a kit line of the order (once) with a quantity above 0 as a
--            decimal string (up to 4 decimals).
--   UPDATE   what was announced never changes: only ANNOUNCED → RECEIVED (the receipt of the same order, by its
--            reference, and when) or → CANCELLED (when and why); both final.
--   DELETE   never.
--   every row  a place from 1; 1..9999 parcels; a DDT date only with its number (1..40); who announced it 1..200; note 2000.
CREATE FUNCTION "factory_subcontract_return_notice_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  outcome CONSTANT text[] := ARRAY['status', 'receiptId', 'receivedAt', 'cancelledAt', 'cancelReason', 'version', 'updatedAt'];
  uuid_shape CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  job_state text;
  job_declined timestamptz;
  entry jsonb;
  pieces numeric := 0;
  kit_lines uuid[] := ARRAY[]::uuid[];
  kit_line uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal supply: return notice % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ANNOUNCED' OR NEW."receiptId" IS NOT NULL OR NEW."receivedAt" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL
       OR NEW."cancelReason" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'portal supply: return notice % starts ANNOUNCED, nothing received or cancelled, version 1', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT o."status"::text, o."declinedAt" INTO job_state, job_declined FROM "SubcontractOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."subcontractOrderId";
    IF job_state IS NULL OR job_state NOT IN ('AT_WORKSHOP', 'PARTLY_RECEIVED') OR job_declined IS NOT NULL THEN
      RAISE EXCEPTION 'portal supply: goods come back from a subcontract order AT_WORKSHOP or PARTLY_RECEIVED and not declined (order %)', NEW."subcontractOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(NEW."quantities") IS DISTINCT FROM 'array' OR jsonb_array_length(NEW."quantities") = 0 THEN
      RAISE EXCEPTION 'portal supply: return notice % lists what comes back', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    FOR entry IN SELECT e FROM jsonb_array_elements(NEW."quantities") e LOOP
      IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
         OR jsonb_typeof(entry -> 'subcontractOperationId') IS DISTINCT FROM 'string' OR (entry ->> 'subcontractOperationId') !~ uuid_shape
         OR (entry ? 'bundleId' AND jsonb_typeof(entry -> 'bundleId') <> 'null' AND coalesce(entry ->> 'bundleId', '') !~ uuid_shape)
         OR (entry ? 'workOrderSizeId' AND jsonb_typeof(entry -> 'workOrderSizeId') <> 'null' AND coalesce(entry ->> 'workOrderSizeId', '') !~ uuid_shape)
         OR jsonb_typeof(entry -> 'finished') IS DISTINCT FROM 'number' OR jsonb_typeof(entry -> 'scrapped') IS DISTINCT FROM 'number'
         OR (entry ->> 'finished')::numeric < 0 OR (entry ->> 'scrapped')::numeric < 0
         OR (entry ->> 'finished')::numeric <> trunc((entry ->> 'finished')::numeric)
         OR (entry ->> 'scrapped')::numeric <> trunc((entry ->> 'scrapped')::numeric)
         OR ((entry ->> 'scrapped')::numeric > 0 AND coalesce(entry ->> 'reasonCode', '') !~ '^\S{1,40}$') THEN
        RAISE EXCEPTION 'portal supply: return notice % lists per operation (and bundle or cell) whole finished and scrapped pieces from 0, with a reason code for scrapped ones: %', NEW."id", entry
          USING ERRCODE = 'check_violation';
      END IF;
      pieces := pieces + (entry ->> 'finished')::numeric + (entry ->> 'scrapped')::numeric;
    END LOOP;
    IF pieces < 1 THEN
      RAISE EXCEPTION 'portal supply: return notice % announces at least one piece', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(NEW."materialBack") IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'portal supply: return notice % lists the unused material as a list', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    FOR entry IN SELECT e FROM jsonb_array_elements(NEW."materialBack") e LOOP
      IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
         OR jsonb_typeof(entry -> 'kitLineId') IS DISTINCT FROM 'string' OR (entry ->> 'kitLineId') !~ uuid_shape
         OR jsonb_typeof(entry -> 'quantity') IS DISTINCT FROM 'string' OR (entry ->> 'quantity') !~ '^[0-9]{1,14}(\.[0-9]{1,4})?$'
         OR (entry ->> 'quantity')::numeric <= 0 THEN
        RAISE EXCEPTION 'portal supply: return notice % names each unused material by its kit line, with a quantity above 0 as a decimal: %', NEW."id", entry
          USING ERRCODE = 'check_violation';
      END IF;
      kit_line := (entry ->> 'kitLineId')::uuid;
      IF kit_line = ANY (kit_lines)
         OR NOT EXISTS (SELECT 1 FROM "SubcontractKitLine" k WHERE k."tenantId" = NEW."tenantId" AND k."id" = kit_line AND k."subcontractOrderId" = NEW."subcontractOrderId") THEN
        RAISE EXCEPTION 'portal supply: return notice % names kit line % once, a line of its own order', NEW."id", kit_line
          USING ERRCODE = 'check_violation';
      END IF;
      kit_lines := kit_lines || kit_line;
    END LOOP;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (to_jsonb(NEW) - (kept || outcome)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || outcome))
       OR (NEW."siteId", NEW."partyId") IS DISTINCT FROM (OLD."siteId", OLD."partyId") THEN
      RAISE EXCEPTION 'portal supply: what the workshop announced in return notice % never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'ANNOUNCED'
       OR (NEW."status" = 'ANNOUNCED' AND (to_jsonb(NEW) - ARRAY['version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'portal supply: return notice % is %; it is received or cancelled once', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."seq" < 1 OR NEW."parcels" < 1 OR NEW."parcels" > 9999
     OR (NEW."workshopDdtDate" IS NOT NULL AND NEW."workshopDdtNumber" IS NULL)
     OR btrim(NEW."workshopDdtNumber") = '' OR length(NEW."workshopDdtNumber") > 40
     OR btrim(NEW."announcedByName") = '' OR length(NEW."announcedByName") > 200
     OR length(NEW."note") > 2000 OR length(NEW."cancelReason") > 2000
     OR (NEW."status" = 'RECEIVED') <> (NEW."receiptId" IS NOT NULL AND NEW."receivedAt" IS NOT NULL)
     OR (NEW."status" <> 'RECEIVED' AND (NEW."receiptId" IS NOT NULL OR NEW."receivedAt" IS NOT NULL))
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'portal supply: return notice % is % with the wrong fields (a place from 1; 1 to 9999 parcels; a DDT date with its number; who announced it; received with its receipt and time, cancelled with its time and reason)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SubcontractReturnNotice_guard" AFTER INSERT OR UPDATE OR DELETE ON "SubcontractReturnNotice"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontract_return_notice_guard"();

-- =====================================================================================================================
-- SupplierQuestionnaire (SCM-023)
--   UPDATE   company and creation never change; published once (its time, and who), then fixed: nothing changes but the
--            version.
--   DELETE   only an unpublished version.
--   every row  a version from 1; a title 1..200, not blank; the questions a list of at least one, each an object with a key
--            (`^[a-z][a-z0-9_.-]{0,99}$`) unique in the version; who published only with when.
CREATE FUNCTION "factory_supplier_questionnaire_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry jsonb;
  keys text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."publishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'portal supply: questionnaire version % was published; it is kept', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'portal supply: the company and creation of questionnaire version % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."publishedAt" IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version', 'updatedAt']) THEN
      RAISE EXCEPTION 'portal supply: questionnaire version % is published; it is fixed (a change is a new version)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."revision" < 1 OR btrim(NEW."title") = '' OR length(NEW."title") > 200
     OR (NEW."publishedAt" IS NULL AND NEW."publishedById" IS NOT NULL)
     OR jsonb_typeof(NEW."questions") IS DISTINCT FROM 'array' OR jsonb_array_length(NEW."questions") = 0 THEN
    RAISE EXCEPTION 'portal supply: questionnaire version % has a version from 1, a title (1 to 200 characters), a list of questions and who published it only with when', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  FOR entry IN SELECT e FROM jsonb_array_elements(NEW."questions") e LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR jsonb_typeof(entry -> 'key') IS DISTINCT FROM 'string'
       OR (entry ->> 'key') !~ '^[a-z][a-z0-9_.-]{0,99}$' OR (entry ->> 'key') = ANY (keys) THEN
      RAISE EXCEPTION 'portal supply: each question of questionnaire version % has its own key (lower case letters, digits, . _ -): %', NEW."id", entry
        USING ERRCODE = 'check_violation';
    END IF;
    keys := keys || (entry ->> 'key');
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SupplierQuestionnaire_guard" AFTER INSERT OR UPDATE OR DELETE ON "SupplierQuestionnaire"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_questionnaire_guard"();

-- SupplierQuestionnaireResponse (SCM-023)
--   INSERT   not reviewed yet, version 1; the questionnaire version published (checked for the office: the partner role
--            reads no questionnaire; the API offers published versions only); the link, when named, a SUPPLIER_ONBOARD link
--            of the party (its reference), not revoked.
--   UPDATE   only the buyer's review: the decision with its time (and who) set once, the note.
--   DELETE   never.
--   every row  the answers an object; sites and sub-tier sites lists of objects, each with a name (1..200) and a
--            two-letter country; the signer's name 1..200 and role up to 200, not blank; a decision exactly with its time,
--            who only with it; the note at most 2000 characters.
CREATE FUNCTION "factory_supplier_questionnaire_response_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  review CONSTANT text[] := ARRAY['decision', 'reviewedAt', 'reviewedById', 'reviewNote', 'version', 'updatedAt'];
  published timestamptz;
  questionnaire_found boolean;
  link_purpose text;
  link_revoked timestamptz;
  entry jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal supply: questionnaire answer % is kept, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."decision" IS NOT NULL OR NEW."reviewedAt" IS NOT NULL OR NEW."reviewedById" IS NOT NULL OR NEW."reviewNote" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'portal supply: questionnaire answer % is new; it is not reviewed yet (version 1)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user <> 'factory_partner_runtime' THEN
      SELECT true, q."publishedAt" INTO questionnaire_found, published FROM "SupplierQuestionnaire" q WHERE q."tenantId" = NEW."tenantId" AND q."id" = NEW."questionnaireId";
      IF questionnaire_found AND published IS NULL THEN
        RAISE EXCEPTION 'portal supply: questionnaire answer % answers a published version', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."linkId" IS NOT NULL THEN
      SELECT l."purpose"::text, l."revokedAt" INTO link_purpose, link_revoked FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."linkId";
      IF link_purpose IS DISTINCT FROM 'SUPPLIER_ONBOARD' OR link_revoked IS NOT NULL THEN
        RAISE EXCEPTION 'portal supply: questionnaire answer % comes through a SUPPLIER_ONBOARD link of its party that is not revoked', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (to_jsonb(NEW) - review) IS DISTINCT FROM (to_jsonb(OLD) - review) THEN
      RAISE EXCEPTION 'portal supply: what the supplier answered in % never changes (asked again, it answers again)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."decision", NEW."reviewedAt", NEW."reviewedById") IS DISTINCT FROM (OLD."decision", OLD."reviewedAt", OLD."reviewedById")
       AND OLD."decision" IS NOT NULL THEN
      RAISE EXCEPTION 'portal supply: questionnaire answer % is reviewed once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF jsonb_typeof(NEW."answers") IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW."sites") IS DISTINCT FROM 'array' OR jsonb_typeof(NEW."subTierSites") IS DISTINCT FROM 'array'
     OR btrim(NEW."signedName") = '' OR length(NEW."signedName") > 200
     OR btrim(NEW."signedRole") = '' OR length(NEW."signedRole") > 200
     OR (NEW."decision" IS NULL) <> (NEW."reviewedAt" IS NULL)
     OR (NEW."decision" IS NULL AND NEW."reviewedById" IS NOT NULL)
     OR length(NEW."reviewNote") > 2000 THEN
    RAISE EXCEPTION 'portal supply: questionnaire answer % holds its answers, its sites as lists, who signed it (1 to 200 characters) and a review with its time', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  FOR entry IN SELECT e FROM jsonb_array_elements(NEW."sites" || NEW."subTierSites") e LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR jsonb_typeof(entry -> 'name') IS DISTINCT FROM 'string'
       OR btrim(entry ->> 'name') = '' OR length(entry ->> 'name') > 200
       OR jsonb_typeof(entry -> 'country') IS DISTINCT FROM 'string' OR (entry ->> 'country') !~ '^[A-Z]{2}$' THEN
      RAISE EXCEPTION 'portal supply: each site of questionnaire answer % has a name (1 to 200 characters) and a two-letter country: %', NEW."id", entry
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SupplierQuestionnaireResponse_guard" AFTER INSERT OR UPDATE OR DELETE ON "SupplierQuestionnaireResponse"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_questionnaire_response_guard"();
