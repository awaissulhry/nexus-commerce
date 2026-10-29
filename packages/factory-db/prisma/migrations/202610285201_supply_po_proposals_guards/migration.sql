-- Written by hand (Prisma does not model triggers), after the generated …_supply_po_proposals and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The supplier's proposed changes (B-W1-31; SCM-086; Owner question P2, answer A: the BUYER decides). This migration
-- redefines the two purchase order guards of …_supply_guards (same rules, plus the proposal); their triggers stay.
--
-- PurchaseOrder, in addition to …_supply_guards:
--   moves      SENT → CHANGES_PROPOSED (the supplier's answer with changes, also by a partner session);
--              CHANGES_PROPOSED → CONFIRMED (the buyer ACCEPTS: the proposal becomes the confirmation, channel LINK, the
--              link it came through) or → SENT (the buyer REFUSES: the office sends a new link or cancels). Nothing else
--              leaves CHANGES_PROPOSED.
--   proposal   when, through which link, the typed name, the supplier's reference and note: written only in the move
--              SENT → CHANGES_PROPOSED; kept after the decision; a new proposal replaces it.
--   decision   ACCEPTED or REFUSED, when, by whom, the buyer's note: written only in the move out of CHANGES_PROPOSED
--              (ACCEPTED exactly to CONFIRMED, REFUSED exactly to SENT); cleared by this trigger when a new proposal
--              comes in (SENT → CHANGES_PROPOSED).
--   every row  CHANGES_PROPOSED with its time and link and no decision; no proposal, no decision; a decision with its
--              time; no confirmation in CHANGES_PROPOSED.
CREATE OR REPLACE FUNCTION "factory_purchase_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  proposal_columns CONSTANT text[] := ARRAY['proposedAt', 'proposalLinkId', 'proposedByName', 'proposalSupplierRef', 'proposalNote',
    'proposalDecision', 'proposalDecidedAt', 'proposalDecidedById', 'proposalDecisionNote'];
  progress CONSTANT text[] := ARRAY['status', 'revision', 'sentAt', 'sentById', 'confirmedAt', 'confirmedVia', 'confirmLinkId',
    'confirmedByName', 'supplierRef', 'confirmNote', 'declinedAt', 'declineReason', 'closedAt', 'cancelledAt', 'cancelReason',
    'internalNote', 'version', 'updatedAt'] || proposal_columns;
  answer CONSTANT text[] := ARRAY['status', 'confirmedAt', 'confirmedVia', 'confirmLinkId', 'confirmedByName', 'supplierRef',
    'confirmNote', 'declinedAt', 'declineReason', 'version', 'updatedAt'] || proposal_columns;
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
    -- A new proposal replaces the last one: the buyer's last decision is cleared with it.
    IF OLD."status" = 'SENT' AND NEW."status" = 'CHANGES_PROPOSED' THEN
      NEW."proposalDecision" := NULL;
      NEW."proposalDecidedAt" := NULL;
      NEW."proposalDecidedById" := NULL;
      NEW."proposalDecisionNote" := NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'supply: the company, number and creation of purchase order % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('SENT', 'CANCELLED'))
                OR (OLD."status" = 'SENT' AND NEW."status" IN ('CONFIRMED', 'DECLINED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED', 'RECEIVED', 'DRAFT', 'CANCELLED'))
                OR (OLD."status" = 'CHANGES_PROPOSED' AND NEW."status" IN ('CONFIRMED', 'SENT'))
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
       AND NOT (OLD."status" IN ('SENT', 'CHANGES_PROPOSED') AND NEW."status" = 'CONFIRMED' AND OLD."confirmedAt" IS NULL) THEN
      RAISE EXCEPTION 'supply: the supplier''s confirmation of purchase order % is set once, when it moves from SENT to CONFIRMED (or from CHANGES_PROPOSED, accepted)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."proposedAt", NEW."proposalLinkId", NEW."proposedByName", NEW."proposalSupplierRef", NEW."proposalNote")
       IS DISTINCT FROM
       (OLD."proposedAt", OLD."proposalLinkId", OLD."proposedByName", OLD."proposalSupplierRef", OLD."proposalNote")
       AND NOT (OLD."status" = 'SENT' AND NEW."status" = 'CHANGES_PROPOSED') THEN
      RAISE EXCEPTION 'supply: the supplier''s proposal for purchase order % is written only when it moves from SENT to CHANGES_PROPOSED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."proposalDecision", NEW."proposalDecidedAt", NEW."proposalDecidedById", NEW."proposalDecisionNote")
       IS DISTINCT FROM
       (OLD."proposalDecision", OLD."proposalDecidedAt", OLD."proposalDecidedById", OLD."proposalDecisionNote")
       AND NOT ((OLD."status" = 'CHANGES_PROPOSED' AND NEW."status" IN ('CONFIRMED', 'SENT')) OR (OLD."status" = 'SENT' AND NEW."status" = 'CHANGES_PROPOSED')) THEN
      RAISE EXCEPTION 'supply: the buyer''s decision on the proposal for purchase order % is written only when it leaves CHANGES_PROPOSED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CHANGES_PROPOSED' AND NEW."status" <> OLD."status"
       AND ((NEW."status" = 'CONFIRMED' AND (NEW."proposalDecision" IS DISTINCT FROM 'ACCEPTED' OR NEW."confirmedVia" IS DISTINCT FROM 'LINK' OR NEW."confirmLinkId" IS DISTINCT FROM NEW."proposalLinkId"))
            OR (NEW."status" = 'SENT' AND NEW."proposalDecision" IS DISTINCT FROM 'REFUSED')) THEN
      RAISE EXCEPTION 'supply: purchase order % leaves CHANGES_PROPOSED only by the buyer''s decision: ACCEPTED to CONFIRMED (through the proposal''s link) or REFUSED back to SENT', OLD."id"
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
            OR (NEW."status" <> OLD."status" AND NOT (OLD."status" = 'SENT' AND NEW."status" IN ('CONFIRMED', 'DECLINED', 'CHANGES_PROPOSED')))) THEN
      RAISE EXCEPTION 'supply: a partner session only confirms or declines its SENT purchase order, or answers it with changes (order %)', OLD."id"
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
     OR (NEW."status" IN ('DRAFT', 'SENT', 'DECLINED', 'CHANGES_PROPOSED') AND NEW."confirmedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'supply: purchase order % is % with an inconsistent confirmation (its time, channel and link go together, from CONFIRMED on)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CHANGES_PROPOSED' AND (NEW."proposedAt" IS NULL OR NEW."proposalLinkId" IS NULL OR NEW."proposalDecision" IS NOT NULL))
     OR (NEW."proposedAt" IS NULL AND (NEW."proposalLinkId" IS NOT NULL OR NEW."proposedByName" IS NOT NULL OR NEW."proposalSupplierRef" IS NOT NULL OR NEW."proposalNote" IS NOT NULL OR NEW."proposalDecision" IS NOT NULL))
     OR (NEW."proposalDecision" IS NULL) <> (NEW."proposalDecidedAt" IS NULL)
     OR (NEW."proposalDecision" IS NULL AND (NEW."proposalDecidedById" IS NOT NULL OR NEW."proposalDecisionNote" IS NOT NULL)) THEN
    RAISE EXCEPTION 'supply: purchase order % is % with an inconsistent proposal (CHANGES_PROPOSED with its time and link and no decision yet; a decision with its time)', NEW."id", NEW."status"
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

-- PurchaseOrderLine, in addition to …_supply_guards:
--   proposal   the supplier's proposal for the line (the quantity and date of its delivery, a second delivery for a
--              split, the reason): written only while the order is SENT (before the order moves to CHANGES_PROPOSED),
--              by a partner session too; a new line has none; kept after the buyer's decision.
--   confirmed  the confirmation is set once while the order is SENT, CHANGES_PROPOSED (the buyer accepts: the proposal
--              is copied, then the order moves) or CONFIRMED; a partner session confirms only while the order is SENT.
--   every row  no negative proposed quantity; a second delivery has both its quantity (above 0) and its date, and only
--              after a first one with its date.
CREATE OR REPLACE FUNCTION "factory_purchase_order_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  answer CONSTANT text[] := ARRAY['confirmedQuantity', 'confirmedDate', 'proposedQuantity', 'proposedDate', 'proposedSplitQuantity',
    'proposedSplitDate', 'proposalReason', 'version', 'updatedAt'];
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
       OR NEW."proposedSplitDate" IS NOT NULL OR NEW."proposalReason" IS NOT NULL THEN
      RAISE EXCEPTION 'supply: purchase order line % is new; the supplier has not confirmed it yet (nor proposed a change)', NEW."id"
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
            OR (state IS NOT NULL AND state NOT IN ('SENT', 'CHANGES_PROPOSED', 'CONFIRMED'))) THEN
      RAISE EXCEPTION 'supply: the supplier''s confirmation of purchase order line % is set once, while its order is SENT or CONFIRMED (or CHANGES_PROPOSED, when the buyer accepts the supplier''s changes)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."proposedQuantity", NEW."proposedDate", NEW."proposedSplitQuantity", NEW."proposedSplitDate", NEW."proposalReason")
       IS DISTINCT FROM
       (OLD."proposedQuantity", OLD."proposedDate", OLD."proposedSplitQuantity", OLD."proposedSplitDate", OLD."proposalReason")
       AND state IS NOT NULL AND state <> 'SENT' THEN
      RAISE EXCEPTION 'supply: the supplier''s proposal for purchase order line % is written only while its order is SENT', OLD."id"
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
