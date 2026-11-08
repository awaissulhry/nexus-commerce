-- Written by hand (Prisma does not model triggers), after the generated 202610319702_portal_followups_w2b_schema and
-- before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- W2b schema wave 23 (B-W2b-F12): the schema follow-ups of the portal steps. A purchase order confirmed or answered with
-- changes in the portal (channel PORTAL, the person instead of a link; B-W2b-174); a delivery address a customer adds that
-- waits for the office's check and is not used for an order meanwhile (B-W2b-157/-190); a supplier's document uploads and
-- profile change requests as tables (B-W2b-189); how a return request reached us and what the customer would like
-- (B-W2b-192); a DVR signature through the approval request an outside signer approved (SafetySignMethod LINK, B-W2b-184);
-- a partner task handed to a colleague (B-W2b-167), the carrier's ETA and tracking page (B-W2b-175), the cancel fee
-- (B-W2b-183) and a party's website (B-W2b-189).
--
-- apps/factory-api checks all of this first, in words; these rules hold for every login, the owner included. Every
-- refusal is a check_violation (Prisma keeps its words). The guards of the new tables, and the new triggers on the earlier
-- tables, are AFTER triggers (the redefined functions keep their BEFORE triggers): for the runtime roles the
-- row-level-security policies speak first (a row moved to another tenant or party fails their WITH CHECK), then the guard
-- holds for every login. A rule that reads another row reads what the role that fires it may read: the partner role reads
-- its own party's people (User), purchase orders, ship notices, subcontract orders and tasks; a row it should see and does
-- not is a refusal. The actor is not a database setting (B-W2b-F9): "the person writing is the one named on the row" stays
-- the API's. An UPDATE that changes nothing passes.
--
-- Earlier functions redefined here, each its whole body:
--   factory_purchase_order_guard           (…_supply_w2a_guards, W2a wave 3/7; not redefined since): the PORTAL
--                                          confirmation with its person, a proposal by a portal person instead of a link,
--                                          the acceptance of either.
--   factory_shipment_guard                 (…_followups_f1_w2b_guards, B-W2b-F1; not redefined since): the carrier's ETA
--                                          moves after the goods left.
--   factory_risk_assessment_signature_check (…_safety_w2b_guards, W2b wave 15/16; not redefined since): LINK names the
--                                          approval request the outside signer approved.
-- NEW triggers (their own functions): PartyAddress_approval_guard, QuoteVersion_address_usable(_change),
-- Shipment_address_usable(_change), Party_website_check, ReturnAuthorisation_request_check, the *_sign_method_not_link
-- triggers of the four other safety registers, PartnerTask_assignee_check, Parcel_tracking_url_check,
-- SalesSettings_cancel_fee_check, and the guards and TRUNCATE triggers of the two new tables.

CREATE FUNCTION "factory_portal_followups_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'portal follow-ups: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "SupplierDocumentUpload_no_truncate" BEFORE TRUNCATE ON "SupplierDocumentUpload"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_portal_followups_refuse_truncate"();
CREATE TRIGGER "PartyChangeRequest_no_truncate" BEFORE TRUNCATE ON "PartyChangeRequest"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_portal_followups_refuse_truncate"();

-- =====================================================================================================================
-- 1. Purchase orders: a portal confirmation (B-W2b-174's need)
-- =====================================================================================================================

-- PurchaseOrder: REDEFINES factory_purchase_order_guard (202610303001_supply_w2a_guards), its whole body. Its rules stand;
-- W2b schema wave 23:
--   PORTAL      a confirmation through the portal names the partner user who gave it (confirmedByUserId) and no link;
--               LINK names its link and no person, OFFICE neither. The person is set and cleared with the rest of the
--               confirmation (set once in the move to CONFIRMED, cleared when a confirmed order goes back to DRAFT).
--   proposal    a proposal names exactly one of its PO_CONFIRM link (proposalLinkId) and its portal person
--               (proposedByUserId), written with the rest of the proposal (SENT → CHANGES_PROPOSED; a new one replaces the
--               last, so the API clears the other one). Accepted, a link's proposal becomes a LINK confirmation through
--               that link, a portal one a PORTAL confirmation by that person.
--   person      a portal confirmer or proposer is an ACTIVE partner user of the order's own supplier (accepted, the
--               proposer confirms it even if they left since).
--   partner     a partner session writes the new columns with its answer, nothing else (the answer list).
CREATE OR REPLACE FUNCTION "factory_purchase_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  proposal_columns CONSTANT text[] := ARRAY['proposedAt', 'proposalLinkId', 'proposedByUserId', 'proposedByName', 'proposalSupplierRef', 'proposalNote',
    'proposalDecision', 'proposalDecidedAt', 'proposalDecidedById', 'proposalDecisionNote'];
  progress CONSTANT text[] := ARRAY['status', 'revision', 'sentAt', 'sentById', 'confirmBy', 'confirmedAt', 'confirmedVia', 'confirmLinkId', 'confirmedByUserId',
    'confirmedByName', 'supplierRef', 'confirmNote', 'declinedAt', 'declineReason', 'closedAt', 'cancelledAt', 'cancelReason',
    'internalNote', 'version', 'updatedAt'] || proposal_columns;
  answer CONSTANT text[] := ARRAY['status', 'confirmedAt', 'confirmedVia', 'confirmLinkId', 'confirmedByUserId', 'confirmedByName', 'supplierRef',
    'confirmNote', 'declinedAt', 'declineReason', 'version', 'updatedAt'] || proposal_columns;
  line_count integer;
  line_total bigint;
  still_confirmed integer;
  person_audience text;
  person_party uuid;
  person_status text;
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
                OR (OLD."status" = 'CHANGES_PROPOSED' AND NEW."status" IN ('CONFIRMED', 'SENT', 'DRAFT'))
                OR (OLD."status" = 'DECLINED' AND NEW."status" IN ('DRAFT', 'CANCELLED'))
                OR (OLD."status" = 'CONFIRMED' AND NEW."status" IN ('PARTLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'DRAFT'))
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
    IF (NEW."confirmedAt", NEW."confirmedVia", NEW."confirmLinkId", NEW."confirmedByUserId", NEW."confirmedByName", NEW."supplierRef", NEW."confirmNote")
       IS DISTINCT FROM
       (OLD."confirmedAt", OLD."confirmedVia", OLD."confirmLinkId", OLD."confirmedByUserId", OLD."confirmedByName", OLD."supplierRef", OLD."confirmNote")
       AND NOT (OLD."status" IN ('SENT', 'CHANGES_PROPOSED') AND NEW."status" = 'CONFIRMED' AND OLD."confirmedAt" IS NULL)
       -- W2a: a confirmed order going back to DRAFT as its next revision loses its confirmation (all of it).
       AND NOT (OLD."status" = 'CONFIRMED' AND NEW."status" = 'DRAFT' AND NEW."confirmedAt" IS NULL AND NEW."confirmedVia" IS NULL
                AND NEW."confirmLinkId" IS NULL AND NEW."confirmedByUserId" IS NULL AND NEW."confirmedByName" IS NULL AND NEW."supplierRef" IS NULL AND NEW."confirmNote" IS NULL) THEN
      RAISE EXCEPTION 'supply: the supplier''s confirmation of purchase order % is set once, when it moves from SENT to CONFIRMED (or from CHANGES_PROPOSED, accepted), and cleared only when a confirmed order goes back to DRAFT for a new revision', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."proposedAt", NEW."proposalLinkId", NEW."proposedByUserId", NEW."proposedByName", NEW."proposalSupplierRef", NEW."proposalNote")
       IS DISTINCT FROM
       (OLD."proposedAt", OLD."proposalLinkId", OLD."proposedByUserId", OLD."proposedByName", OLD."proposalSupplierRef", OLD."proposalNote")
       AND NOT (OLD."status" = 'SENT' AND NEW."status" = 'CHANGES_PROPOSED') THEN
      RAISE EXCEPTION 'supply: the supplier''s proposal for purchase order % is written only when it moves from SENT to CHANGES_PROPOSED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."proposalDecision", NEW."proposalDecidedAt", NEW."proposalDecidedById", NEW."proposalDecisionNote")
       IS DISTINCT FROM
       (OLD."proposalDecision", OLD."proposalDecidedAt", OLD."proposalDecidedById", OLD."proposalDecisionNote")
       AND NOT ((OLD."status" = 'CHANGES_PROPOSED' AND NEW."status" IN ('CONFIRMED', 'SENT', 'DRAFT')) OR (OLD."status" = 'SENT' AND NEW."status" = 'CHANGES_PROPOSED')) THEN
      RAISE EXCEPTION 'supply: the buyer''s decision on the proposal for purchase order % is written only when it leaves CHANGES_PROPOSED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CHANGES_PROPOSED' AND NEW."status" <> OLD."status"
       AND ((NEW."status" = 'CONFIRMED'
             AND (NEW."proposalDecision" IS DISTINCT FROM 'ACCEPTED'
                  OR NOT ((NEW."proposalLinkId" IS NOT NULL AND NEW."confirmedVia" IS NOT DISTINCT FROM 'LINK' AND NEW."confirmLinkId" IS NOT DISTINCT FROM NEW."proposalLinkId")
                          OR (NEW."proposedByUserId" IS NOT NULL AND NEW."confirmedVia" IS NOT DISTINCT FROM 'PORTAL' AND NEW."confirmedByUserId" IS NOT DISTINCT FROM NEW."proposedByUserId"))))
            OR (NEW."status" IN ('SENT', 'DRAFT') AND NEW."proposalDecision" IS DISTINCT FROM 'REFUSED')) THEN
      RAISE EXCEPTION 'supply: purchase order % leaves CHANGES_PROPOSED only by the buyer''s decision: ACCEPTED to CONFIRMED (through the proposal''s link, or PORTAL by the person who proposed it in the portal) or REFUSED back to SENT (or to DRAFT, to counter-propose a new revision)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."declinedAt", NEW."declineReason") IS DISTINCT FROM (OLD."declinedAt", OLD."declineReason")
       AND NOT (OLD."status" = 'SENT' AND NEW."status" = 'DECLINED') THEN
      RAISE EXCEPTION 'supply: the supplier''s decline of purchase order % is written only when it moves from SENT to DECLINED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."sentAt", NEW."sentById") IS DISTINCT FROM (OLD."sentAt", OLD."sentById")
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'SENT') OR (OLD."status" IN ('SENT', 'DECLINED', 'CONFIRMED', 'CHANGES_PROPOSED') AND NEW."status" = 'DRAFT')) THEN
      RAISE EXCEPTION 'supply: purchase order % gets its send time when it is sent, and loses it when it goes back to DRAFT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."revision" NOT IN (OLD."revision", OLD."revision" + 1)
       OR (NEW."status" = 'DRAFT' AND OLD."status" IN ('SENT', 'DECLINED', 'CONFIRMED', 'CHANGES_PROPOSED')) <> (NEW."revision" = OLD."revision" + 1) THEN
      RAISE EXCEPTION 'supply: the revision of purchase order % goes up by one exactly when a SENT, DECLINED, CONFIRMED or CHANGES_PROPOSED order goes back to DRAFT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'SENT' THEN
      SELECT count(*) FILTER (WHERE l."cancelledAt" IS NULL),
             coalesce(sum(l."netAmount") FILTER (WHERE l."cancelledAt" IS NULL), 0),
             count(*) FILTER (WHERE l."cancelledAt" IS NULL AND l."closedShortAt" IS NULL AND (l."confirmedQuantity" IS NOT NULL OR l."confirmedDate" IS NOT NULL))
        INTO line_count, line_total, still_confirmed
        FROM "PurchaseOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."purchaseOrderId" = NEW."id";
      IF line_count = 0 THEN
        RAISE EXCEPTION 'supply: purchase order % has no line; it cannot be sent (a cancelled line does not count)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF line_total <> NEW."netAmount" THEN
        RAISE EXCEPTION 'supply: the amount of purchase order % (%) is not the sum of its lines (%)', NEW."id", NEW."netAmount", line_total
          USING ERRCODE = 'check_violation';
      END IF;
      IF still_confirmed > 0 THEN
        RAISE EXCEPTION 'supply: % line(s) of purchase order % still hold the confirmation of an earlier revision; clear it before sending revision %', still_confirmed, NEW."id", NEW."revision"
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
  IF NEW."confirmBy" IS NOT NULL AND NEW."sentAt" IS NOT NULL AND NEW."confirmBy" <= NEW."sentAt" THEN
    RAISE EXCEPTION 'supply: purchase order % is to be confirmed by a time after it was sent', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."confirmedAt" IS NULL) <> (NEW."confirmedVia" IS NULL)
     OR (NEW."confirmedAt" IS NULL AND (NEW."confirmLinkId" IS NOT NULL OR NEW."confirmedByUserId" IS NOT NULL OR NEW."confirmedByName" IS NOT NULL OR NEW."supplierRef" IS NOT NULL OR NEW."confirmNote" IS NOT NULL))
     OR (NEW."confirmedVia" IS NOT DISTINCT FROM 'LINK') <> (NEW."confirmLinkId" IS NOT NULL)
     OR (NEW."confirmedVia" IS NOT DISTINCT FROM 'PORTAL') <> (NEW."confirmedByUserId" IS NOT NULL)
     OR (NEW."status" = 'CONFIRMED' AND NEW."confirmedAt" IS NULL)
     OR (NEW."status" IN ('DRAFT', 'SENT', 'DECLINED', 'CHANGES_PROPOSED') AND NEW."confirmedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'supply: purchase order % is % with an inconsistent confirmation (its time and channel go together, from CONFIRMED on: LINK with its link, PORTAL with its person, OFFICE with neither)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CHANGES_PROPOSED' AND (NEW."proposedAt" IS NULL OR (NEW."proposalLinkId" IS NULL AND NEW."proposedByUserId" IS NULL) OR NEW."proposalDecision" IS NOT NULL))
     OR (NEW."proposalLinkId" IS NOT NULL AND NEW."proposedByUserId" IS NOT NULL)
     OR (NEW."proposedAt" IS NULL AND (NEW."proposalLinkId" IS NOT NULL OR NEW."proposedByUserId" IS NOT NULL OR NEW."proposedByName" IS NOT NULL OR NEW."proposalSupplierRef" IS NOT NULL OR NEW."proposalNote" IS NOT NULL OR NEW."proposalDecision" IS NOT NULL))
     OR (NEW."proposalDecision" IS NULL) <> (NEW."proposalDecidedAt" IS NULL)
     OR (NEW."proposalDecision" IS NULL AND (NEW."proposalDecidedById" IS NOT NULL OR NEW."proposalDecisionNote" IS NOT NULL)) THEN
    RAISE EXCEPTION 'supply: purchase order % is % with an inconsistent proposal (CHANGES_PROPOSED with its time, its link or its portal person (exactly one) and no decision yet; a decision with its time)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."confirmedByUserId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."confirmedByUserId" IS DISTINCT FROM OLD."confirmedByUserId") THEN
    SELECT u."audience"::text, u."partyId", u."status"::text INTO person_audience, person_party, person_status
      FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."confirmedByUserId";
    -- Accepted, a portal proposal's person confirms it even if they left since (the buyer accepts what they proposed).
    IF NOT FOUND OR person_audience <> 'PARTNER' OR person_party IS DISTINCT FROM NEW."partyId"
       OR (person_status <> 'ACTIVE' AND NEW."confirmedByUserId" IS DISTINCT FROM NEW."proposedByUserId") THEN
      RAISE EXCEPTION 'supply: purchase order % is confirmed in the portal by an active person of its own supplier (or, accepted, by the one who proposed it)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."proposedByUserId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."proposedByUserId" IS DISTINCT FROM OLD."proposedByUserId") THEN
    SELECT u."audience"::text, u."partyId", u."status"::text INTO person_audience, person_party, person_status
      FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."proposedByUserId";
    IF NOT FOUND OR person_audience <> 'PARTNER' OR person_party IS DISTINCT FROM NEW."partyId" OR person_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'supply: the changes to purchase order % are proposed in the portal by an active person of its own supplier', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
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

-- =====================================================================================================================
-- 2. Delivery addresses that wait for the office's check (B-W2b-157's and -190's need)
-- =====================================================================================================================

-- PartyAddress (new trigger PartyAddress_approval_guard; no earlier guard on the table):
--   INSERT     an address is the office's own (approvalStatus null: no check, no requester, no decision) or WAITING with
--              who asked (an ACTIVE partner user of the address's party) and when; APPROVED and REFUSED come only from the
--              check. A partner session inserts only a WAITING SHIP_TO address (that one kind), ACTIVE, at version 1.
--   UPDATE     who asked and when never change; the check moves once, WAITING → APPROVED | REFUSED, with when (and by
--              whom), a refusal with its reason (3 to 500 characters); an office address never enters it; a REFUSED
--              address never changes again.
--   rows       a WAITING address is a SHIP_TO address and never a default; a REFUSED one is archived and never a default.
-- Not used for an order: QuoteVersion_address_usable and Shipment_address_usable below.
CREATE FUNCTION "factory_party_address_approval_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person_audience text;
  person_party uuid;
  person_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."requestedAt", NEW."requestedByUserId") IS DISTINCT FROM (OLD."requestedAt", OLD."requestedByUserId") THEN
      RAISE EXCEPTION 'parties: who asked for address % and when never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."approvalStatus" IS DISTINCT FROM OLD."approvalStatus"
       AND NOT (OLD."approvalStatus" IS NOT DISTINCT FROM 'WAITING' AND coalesce(NEW."approvalStatus"::text, '') IN ('APPROVED', 'REFUSED')) THEN
      RAISE EXCEPTION 'parties: address % is checked once, WAITING to APPROVED or REFUSED (an address of the office''s own is never checked), not % to %', OLD."id", coalesce(OLD."approvalStatus"::text, 'none'), coalesce(NEW."approvalStatus"::text, 'none')
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."decidedAt", NEW."decidedById", NEW."refuseReason") IS DISTINCT FROM (OLD."decidedAt", OLD."decidedById", OLD."refuseReason")
       AND NOT (OLD."approvalStatus" IS NOT DISTINCT FROM 'WAITING' AND coalesce(NEW."approvalStatus"::text, '') IN ('APPROVED', 'REFUSED')) THEN
      RAISE EXCEPTION 'parties: the office''s decision on address % is written once, when it leaves WAITING', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."approvalStatus" = 'REFUSED'
       AND (to_jsonb(NEW) - ARRAY['version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version', 'updatedAt']) THEN
      RAISE EXCEPTION 'parties: address % was refused; it never changes again', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."approvalStatus" IS NOT NULL AND NEW."approvalStatus" <> 'WAITING' THEN
      RAISE EXCEPTION 'parties: a new address % is the office''s own (no check) or WAITING for it; APPROVED and REFUSED come from the check', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND (NEW."approvalStatus" IS DISTINCT FROM 'WAITING' OR NEW."kinds" <> ARRAY['SHIP_TO']::"PartyAddressKind"[]
            OR NEW."status" <> 'ACTIVE' OR NEW."version" <> 1) THEN
      RAISE EXCEPTION 'parties: a portal session adds only a delivery address (SHIP_TO) of its own party that waits for the office''s check (address %)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."approvalStatus" IS NULL
      AND (NEW."requestedAt" IS NOT NULL OR NEW."requestedByUserId" IS NOT NULL OR NEW."decidedAt" IS NOT NULL OR NEW."decidedById" IS NOT NULL OR NEW."refuseReason" IS NOT NULL))
     OR (NEW."approvalStatus" IS NOT NULL AND (NEW."requestedAt" IS NULL OR NEW."requestedByUserId" IS NULL)) THEN
    RAISE EXCEPTION 'parties: address % is the office''s own (no requester, no decision) or asked for by a partner user, with when', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (coalesce(NEW."approvalStatus"::text, '') IN ('APPROVED', 'REFUSED')) <> (NEW."decidedAt" IS NOT NULL)
     OR (NEW."decidedAt" IS NULL AND NEW."decidedById" IS NOT NULL) OR NEW."decidedAt" < NEW."requestedAt"
     OR (NEW."approvalStatus" IS NOT DISTINCT FROM 'REFUSED') <> (NEW."refuseReason" IS NOT NULL)
     OR length(btrim(coalesce(NEW."refuseReason", 'xxx'))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'parties: address % is % with the wrong decision: decided (when, not before it was asked) exactly once APPROVED or REFUSED, a refusal with its reason (3 to 500 characters)', NEW."id", coalesce(NEW."approvalStatus"::text, 'the office''s own')
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."approvalStatus" = 'WAITING' AND (NOT ('SHIP_TO' = ANY (NEW."kinds")) OR NEW."isDefaultBillTo" OR NEW."isDefaultShipTo") THEN
    RAISE EXCEPTION 'parties: address % waits for the office''s check: a delivery address (SHIP_TO), never a default until approved', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."approvalStatus" = 'REFUSED' AND (NEW."status" <> 'ARCHIVED' OR NEW."isDefaultBillTo" OR NEW."isDefaultShipTo") THEN
    RAISE EXCEPTION 'parties: address % was refused: it is archived, never a default', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."requestedByUserId" IS NOT NULL THEN
    SELECT u."audience"::text, u."partyId", u."status"::text INTO person_audience, person_party, person_status
      FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."requestedByUserId";
    IF NOT FOUND OR person_audience <> 'PARTNER' OR person_party IS DISTINCT FROM NEW."partyId" OR person_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'parties: address % is asked for by an active person of its own party', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PartyAddress_approval_guard" AFTER INSERT OR UPDATE ON "PartyAddress"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_address_approval_guard"();

-- QuoteVersion, Shipment (new triggers): an order never uses an address that waits for the office's check or that it
-- refused: a quote version's bill-to and ship-to and a shipment's delivery address are the office's own or APPROVED ones.
-- The columns are the trigger's arguments; an UPDATE checks only an address that changed (the floor, which packs
-- shipments and reads no address, never changes one). A sales order keeps its addresses as snapshots (no reference): the
-- API makes it from an approved address (a portal request's WAITING address is approved in the command that accepts it).
CREATE FUNCTION "factory_party_address_usable_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  column_name text;
  address_id uuid;
  state text;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    address_id := (to_jsonb(NEW) ->> column_name)::uuid;
    IF address_id IS NOT NULL AND (TG_OP = 'INSERT' OR address_id IS DISTINCT FROM (to_jsonb(OLD) ->> column_name)::uuid) THEN
      SELECT a."approvalStatus"::text INTO state FROM "PartyAddress" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = address_id;
      IF state IN ('WAITING', 'REFUSED') THEN
        RAISE EXCEPTION '%: % % names address %, which is %; an order uses an address of the office''s own or one it approved',
          CASE TG_TABLE_NAME WHEN 'Shipment' THEN 'shipping' ELSE 'sales' END, TG_TABLE_NAME, NEW."id", address_id, state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QuoteVersion_address_usable" AFTER INSERT ON "QuoteVersion"
  FOR EACH ROW WHEN (NEW."billToAddressId" IS NOT NULL OR NEW."shipToAddressId" IS NOT NULL)
  EXECUTE FUNCTION "factory_party_address_usable_check"('billToAddressId', 'shipToAddressId');
CREATE TRIGGER "QuoteVersion_address_usable_change" AFTER UPDATE OF "billToAddressId", "shipToAddressId" ON "QuoteVersion"
  FOR EACH ROW WHEN (NEW."billToAddressId" IS DISTINCT FROM OLD."billToAddressId" OR NEW."shipToAddressId" IS DISTINCT FROM OLD."shipToAddressId")
  EXECUTE FUNCTION "factory_party_address_usable_check"('billToAddressId', 'shipToAddressId');
CREATE TRIGGER "Shipment_address_usable" AFTER INSERT ON "Shipment"
  FOR EACH ROW WHEN (NEW."shipToAddressId" IS NOT NULL)
  EXECUTE FUNCTION "factory_party_address_usable_check"('shipToAddressId');
CREATE TRIGGER "Shipment_address_usable_change" AFTER UPDATE OF "shipToAddressId" ON "Shipment"
  FOR EACH ROW WHEN (NEW."shipToAddressId" IS DISTINCT FROM OLD."shipToAddressId")
  EXECUTE FUNCTION "factory_party_address_usable_check"('shipToAddressId');

-- =====================================================================================================================
-- 3. Supplier documents and profile changes as tables (B-W2b-189's need)
-- =====================================================================================================================

-- Party (new trigger Party_website_check): a website is an http or https address without spaces, up to 200 characters.
CREATE FUNCTION "factory_party_website_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."website" IS NOT NULL AND (NEW."website" !~* '^https?://[^[:space:]]+$' OR length(NEW."website") > 200) THEN
    RAISE EXCEPTION 'parties: the website of party % is an http or https address without spaces, up to 200 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Party_website_check" AFTER INSERT OR UPDATE OF "website" ON "Party"
  FOR EACH ROW WHEN (NEW."website" IS NOT NULL)
  EXECUTE FUNCTION "factory_party_website_check"();

-- SupplierDocumentUpload (portal-followups.prisma; SCM-096):
--   INSERT     WAITING, not decided, at version 1; the kind a supplier document (SUPPLIER_CERTIFICATE, TEST_REPORT,
--              DECLARATION); the record the party itself (Party: its own id) or one of its purchase orders, ship notices or
--              subcontract orders (read as the role that writes: a partner session sees its own); the uploader an ACTIVE
--              partner user of the party; the task, when named, an UPLOAD_DOCUMENT task (of the party: the reference); the
--              file, when the role sees it, a file of that record (a partner session does not see an OFFICE-only file: the
--              API's), never the one it replaces.
--   UPDATE     what the supplier said, its record, its file, the uploader and the creation never change; the arrival
--              (receivedAt) is set once, while WAITING, never before the upload; the decision is made once, WAITING →
--              ACCEPTED (the file arrived; the kind confirmed among the three, the file in force, the expiry from the issue
--              day on) | REFUSED (its reason, 3 to 500 characters), with when (not before the upload); then nothing
--              changes. The version goes up by one at most.
--   DELETE     refused: an upload is decided, never deleted. TRUNCATE refused.
--   rows       texts trimmed and short (issuer 200, number 100, label 200, note 2000, names 200), up to 20 article and lot
--              codes of up to 60 characters each, an expiry not before the issue.
CREATE FUNCTION "factory_supplier_document_upload_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person_audience text;
  person_party uuid;
  person_status text;
  task_kind text;
  file_record text;
  record_found boolean;
  code text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal follow-ups: supplier upload % is decided, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."fileId", NEW."recordType", NEW."recordId", NEW."recordLabel", NEW."category", NEW."issuer",
        NEW."documentNumber", NEW."issuedOn", NEW."expiresOn", NEW."articleCodes", NEW."lotCodes", NEW."note", NEW."replacesFileId", NEW."taskId",
        NEW."uploadedById", NEW."uploadedByName", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."partyId", OLD."fileId", OLD."recordType", OLD."recordId", OLD."recordLabel", OLD."category", OLD."issuer",
        OLD."documentNumber", OLD."issuedOn", OLD."expiresOn", OLD."articleCodes", OLD."lotCodes", OLD."note", OLD."replacesFileId", OLD."taskId",
        OLD."uploadedById", OLD."uploadedByName", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'portal follow-ups: what the supplier said of upload %, its file, record and uploader never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'portal follow-ups: the version of supplier upload % goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" AND NOT (OLD."receivedAt" IS NULL AND OLD."status" = 'WAITING') THEN
      RAISE EXCEPTION 'portal follow-ups: the file of supplier upload % arrives once, while it waits', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'WAITING'
       AND (to_jsonb(NEW) - ARRAY['version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version', 'updatedAt']) THEN
      RAISE EXCEPTION 'portal follow-ups: supplier upload % is %; it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."status" <> 'WAITING' OR NEW."decidedAt" IS NOT NULL OR NEW."decidedById" IS NOT NULL OR NEW."decidedByName" IS NOT NULL
       OR NEW."acceptedCategory" IS NOT NULL OR NEW."acceptedExpiresOn" IS NOT NULL OR NEW."documentFileId" IS NOT NULL OR NEW."refuseReason" IS NOT NULL
       OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'portal follow-ups: a new supplier upload (%) WAITS for a person of ours, not decided, at version 1', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."recordType" = 'Party' THEN
      record_found := NEW."recordId" = NEW."partyId";
    ELSIF NEW."recordType" = 'PurchaseOrder' THEN
      record_found := EXISTS (SELECT 1 FROM "PurchaseOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."recordId" AND o."partyId" = NEW."partyId");
    ELSIF NEW."recordType" = 'ShipNotice' THEN
      record_found := EXISTS (SELECT 1 FROM "ShipNotice" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."recordId" AND n."partyId" = NEW."partyId");
    ELSIF NEW."recordType" = 'SubcontractOrder' THEN
      record_found := EXISTS (SELECT 1 FROM "SubcontractOrder" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."recordId" AND s."partyId" = NEW."partyId");
    ELSE
      record_found := false;
    END IF;
    IF NOT record_found THEN
      RAISE EXCEPTION 'portal follow-ups: supplier upload % is for the party itself or one of its purchase orders, ship notices or subcontract orders, not % %', NEW."id", NEW."recordType", NEW."recordId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT u."audience"::text, u."partyId", u."status"::text INTO person_audience, person_party, person_status
      FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."uploadedById";
    IF NOT FOUND OR person_audience <> 'PARTNER' OR person_party IS DISTINCT FROM NEW."partyId" OR person_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'portal follow-ups: supplier upload % is uploaded by an active person of its own party', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."taskId" IS NOT NULL THEN
      SELECT t."kind"::text INTO task_kind FROM "PartnerTask" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."taskId";
      IF FOUND AND task_kind <> 'UPLOAD_DOCUMENT' THEN
        RAISE EXCEPTION 'portal follow-ups: supplier upload % answers an UPLOAD_DOCUMENT request, not a % one', NEW."id", task_kind
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    SELECT f."recordType" || ':' || f."recordId"::text INTO file_record FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
    IF FOUND AND file_record <> NEW."recordType" || ':' || NEW."recordId"::text THEN
      RAISE EXCEPTION 'portal follow-ups: the file of supplier upload % is a file of the record it is for (%), not of %', NEW."id", NEW."recordType" || ':' || NEW."recordId"::text, file_record
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."category" NOT IN ('SUPPLIER_CERTIFICATE', 'TEST_REPORT', 'DECLARATION')
     OR (NEW."acceptedCategory" IS NOT NULL AND NEW."acceptedCategory" NOT IN ('SUPPLIER_CERTIFICATE', 'TEST_REPORT', 'DECLARATION')) THEN
    RAISE EXCEPTION 'portal follow-ups: supplier upload % is a certificate, a test report or a declaration', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."replacesFileId" = NEW."fileId" THEN
    RAISE EXCEPTION 'portal follow-ups: supplier upload % does not replace its own file', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."recordLabel") = '' OR length(NEW."recordLabel") > 200
     OR btrim(NEW."uploadedByName") = '' OR length(NEW."uploadedByName") > 200
     OR btrim(coalesce(NEW."issuer", 'x')) = '' OR length(NEW."issuer") > 200
     OR btrim(coalesce(NEW."documentNumber", 'x')) = '' OR length(NEW."documentNumber") > 100
     OR btrim(coalesce(NEW."note", 'x')) = '' OR length(NEW."note") > 2000
     OR btrim(coalesce(NEW."decidedByName", 'x')) = '' OR length(NEW."decidedByName") > 200 THEN
    RAISE EXCEPTION 'portal follow-ups: supplier upload % has short words, none blank (label and names up to 200, issuer 200, number 100, note 2000)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(cardinality(NEW."articleCodes"), 0) > 20 OR coalesce(cardinality(NEW."lotCodes"), 0) > 20 THEN
    RAISE EXCEPTION 'portal follow-ups: supplier upload % names up to 20 articles and 20 lots', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  FOREACH code IN ARRAY coalesce(NEW."articleCodes", ARRAY[]::text[]) || coalesce(NEW."lotCodes", ARRAY[]::text[]) LOOP
    IF code IS NULL OR btrim(code) = '' OR length(code) > 60 THEN
      RAISE EXCEPTION 'portal follow-ups: supplier upload % names its articles and lots by codes of 1 to 60 characters', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF NEW."expiresOn" < NEW."issuedOn" OR NEW."acceptedExpiresOn" < NEW."issuedOn" THEN
    RAISE EXCEPTION 'portal follow-ups: supplier upload % expires on or after the day it was issued', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."receivedAt" < NEW."createdAt" OR NEW."decidedAt" < NEW."createdAt" THEN
    RAISE EXCEPTION 'portal follow-ups: supplier upload % arrives and is decided after it was announced', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'WAITING') <> (NEW."decidedAt" IS NULL)
     OR (NEW."status" = 'WAITING' AND (NEW."decidedById" IS NOT NULL OR NEW."decidedByName" IS NOT NULL))
     OR (NEW."status" = 'ACCEPTED') <> (NEW."acceptedCategory" IS NOT NULL AND NEW."documentFileId" IS NOT NULL)
     OR (NEW."status" <> 'ACCEPTED' AND (NEW."acceptedCategory" IS NOT NULL OR NEW."acceptedExpiresOn" IS NOT NULL OR NEW."documentFileId" IS NOT NULL))
     OR (NEW."status" = 'ACCEPTED' AND NEW."receivedAt" IS NULL)
     OR (NEW."status" = 'REFUSED') <> (NEW."refuseReason" IS NOT NULL)
     OR length(btrim(coalesce(NEW."refuseReason", 'xxx'))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'portal follow-ups: supplier upload % is % with the wrong decision: decided (when) exactly once ACCEPTED (its file arrived; the kind confirmed and the file in force) or REFUSED (its reason, 3 to 500 characters)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SupplierDocumentUpload_guard" AFTER INSERT OR UPDATE ON "SupplierDocumentUpload"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_document_upload_guard"();
CREATE TRIGGER "SupplierDocumentUpload_no_delete" BEFORE DELETE ON "SupplierDocumentUpload"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_document_upload_guard"();

-- PartyChangeRequest (portal-followups.prisma; SCM-097):
--   INSERT     OPEN, not decided, at version 1; the changes a list of 1 to 20 objects; the summary 1 to 2000 characters; the
--              person who asked an ACTIVE partner user of the party.
--   UPDATE     who asked, the changes, the summary, the note and the creation never change; it leaves OPEN once, to
--              APPROVED | REFUSED (its reason, 3 to 500 characters) | WITHDRAWN, with when (not before it was asked); then
--              nothing changes; every change moves the version up by exactly one (compare and set). A partner session only
--              withdraws an OPEN request (no decider, no reason).
--   DELETE     refused: a request is decided or withdrawn, never deleted. TRUNCATE refused.
--   rows       a decider (and their name) only on APPROVED or REFUSED; the reason only on REFUSED.
CREATE FUNCTION "factory_party_change_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person_audience text;
  person_party uuid;
  person_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal follow-ups: change request % is decided or withdrawn, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."requestedById", NEW."requestedByName", NEW."changes", NEW."summary", NEW."note", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."partyId", OLD."requestedById", OLD."requestedByName", OLD."changes", OLD."summary", OLD."note", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'portal follow-ups: what change request % asks, who asked and when never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'portal follow-ups: every change of change request % moves its version up by one (it is at %)', OLD."id", OLD."version"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'portal follow-ups: change request % is %; it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'OPEN' THEN
      RAISE EXCEPTION 'portal follow-ups: change request % changes only by being approved, refused or withdrawn', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_partner_runtime' AND NEW."status" <> 'WITHDRAWN' THEN
      RAISE EXCEPTION 'portal follow-ups: a portal session only withdraws its open change request %', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."status" <> 'OPEN' OR NEW."decidedAt" IS NOT NULL OR NEW."decidedById" IS NOT NULL OR NEW."decidedByName" IS NOT NULL
       OR NEW."refuseReason" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'portal follow-ups: a new change request (%) is OPEN, not decided, at version 1', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT u."audience"::text, u."partyId", u."status"::text INTO person_audience, person_party, person_status
      FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."requestedById";
    IF NOT FOUND OR person_audience <> 'PARTNER' OR person_party IS DISTINCT FROM NEW."partyId" OR person_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'portal follow-ups: change request % is asked by an active person of its own party', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (CASE WHEN jsonb_typeof(NEW."changes") = 'array'
           THEN jsonb_array_length(NEW."changes") NOT BETWEEN 1 AND 20
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."changes") c WHERE jsonb_typeof(c) <> 'object')
           ELSE true END) THEN
    RAISE EXCEPTION 'portal follow-ups: change request % asks 1 to 20 changes, each an object', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."summary") = '' OR length(NEW."summary") > 2000 OR btrim(coalesce(NEW."note", 'x')) = '' OR length(NEW."note") > 2000
     OR btrim(NEW."requestedByName") = '' OR length(NEW."requestedByName") > 200
     OR btrim(coalesce(NEW."decidedByName", 'x')) = '' OR length(NEW."decidedByName") > 200 THEN
    RAISE EXCEPTION 'portal follow-ups: change request % has short words, none blank (summary and note up to 2000, names 200)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'OPEN') <> (NEW."decidedAt" IS NULL) OR NEW."decidedAt" < NEW."createdAt"
     OR (NEW."status" NOT IN ('APPROVED', 'REFUSED') AND (NEW."decidedById" IS NOT NULL OR NEW."decidedByName" IS NOT NULL))
     OR (NEW."status" = 'REFUSED') <> (NEW."refuseReason" IS NOT NULL)
     OR length(btrim(coalesce(NEW."refuseReason", 'xxx'))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'portal follow-ups: change request % is % with the wrong decision: decided (when, not before it was asked) exactly once it left OPEN, a decider only on APPROVED or REFUSED, a refusal with its reason (3 to 500 characters)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PartyChangeRequest_guard" AFTER INSERT OR UPDATE ON "PartyChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_change_request_guard"();
CREATE TRIGGER "PartyChangeRequest_no_delete" BEFORE DELETE ON "PartyChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_change_request_guard"();

-- =====================================================================================================================
-- 4. Returns: how the request came and what the customer would like (B-W2b-192's need)
-- =====================================================================================================================

-- ReturnAuthorisation (new trigger ReturnAuthorisation_request_check; W2a's RMA guard untouched): the channel, the wish
-- and the customer's words are written when the RMA is made and never change; a request from the portal or a claim link
-- starts REQUESTED (the office authorises it); the words are not blank, up to 2000 characters. The partner role reads its
-- own party's RMAs, lines and complaints (the policies; ownership/returns.json, complaints.json) and writes none.
CREATE FUNCTION "factory_return_request_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."channel", NEW."outcomeWanted", NEW."customerNote") IS DISTINCT FROM (OLD."channel", OLD."outcomeWanted", OLD."customerNote") THEN
      RAISE EXCEPTION 'sales: how return % was asked for, what the customer would like and their words never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW."channel" IN ('PORTAL', 'LINK') AND NEW."status" <> 'REQUESTED' THEN
    RAISE EXCEPTION 'sales: return % came from the customer (%): it starts REQUESTED, the office authorises it', NEW."id", NEW."channel"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(coalesce(NEW."customerNote", 'x')) = '' OR length(NEW."customerNote") > 2000 THEN
    RAISE EXCEPTION 'sales: the customer''s words on return % are not blank, up to 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ReturnAuthorisation_request_check" AFTER INSERT ON "ReturnAuthorisation"
  FOR EACH ROW EXECUTE FUNCTION "factory_return_request_check"();
CREATE TRIGGER "ReturnAuthorisation_request_change" AFTER UPDATE OF "channel", "outcomeWanted", "customerNote" ON "ReturnAuthorisation"
  FOR EACH ROW EXECUTE FUNCTION "factory_return_request_check"();

-- =====================================================================================================================
-- 5. A DVR signature by link (B-W2b-184's need)
-- =====================================================================================================================

-- RiskAssessmentSignature: REDEFINES factory_risk_assessment_signature_check (202610318701_safety_w2b_guards), its whole
-- body (the trigger RiskAssessmentSignature_check stays). Its rules stand; W2b schema wave 23: the signer is named by
-- exactly one of the office user (OFFICE, PAPER), the worker (FLOOR_PIN) and the approval request (LINK); a LINK signature
-- is the approval of a request on this version (its company: the reference) answered APPROVED, for the appointment of
-- that request's party, with the name typed and the day of the answer (Europe/Rome), signed no earlier than the answer.
CREATE OR REPLACE FUNCTION "factory_risk_assessment_signature_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  dvr record;
  appointed text;
  asked record;
  appointee uuid;
BEGIN
  IF position(('signature:' || NEW."versionId"::text || ':' || NEW."role"::text) IN NEW."key") <> 1 THEN
    RAISE EXCEPTION 'safety: DVR signature % has the key signature:<its version>:<its role> (one per role per version)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."signerName") = '' OR NEW."signatureSha256" !~ '^[0-9a-f]{64}$'
     OR (NEW."method" = 'FLOOR_PIN') <> (NEW."signedByWorkerId" IS NOT NULL)
     OR (NEW."method" IN ('OFFICE', 'PAPER')) <> (NEW."signedById" IS NOT NULL)
     OR (NEW."method" = 'LINK') <> (NEW."approvalRequestId" IS NOT NULL) THEN
    RAISE EXCEPTION 'safety: DVR signature % has the signer''s name, the SHA-256 signed and who signed: the office user (OFFICE, PAPER), the worker (FLOOR_PIN) or the approval request the outside signer approved (LINK), exactly one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."signedOn" > "factory_people_today"() THEN
    RAISE EXCEPTION 'safety: DVR signature % is dated today at the latest, not %', NEW."id", NEW."signedOn"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT v."status"::text AS status, v."signersRequired"::text[] AS signers, v."sha256", (v."frozenAt" AT TIME ZONE 'Europe/Rome')::date AS frozen_on INTO dvr
    FROM "RiskAssessmentVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."versionId";
  IF FOUND THEN
    IF dvr.status <> 'AWAITING_SIGNATURES' THEN
      RAISE EXCEPTION 'safety: DVR version % is %; it takes no more signatures', NEW."versionId", dvr.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (NEW."role"::text = ANY (dvr.signers)) THEN
      RAISE EXCEPTION 'safety: DVR version % is not signed by the % (its signers: %)', NEW."versionId", NEW."role", array_to_string(dvr.signers, ', ')
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signatureSha256" <> dvr."sha256" THEN
      RAISE EXCEPTION 'safety: DVR signature % signs the version''s SHA-256 (the frozen PDF), not another', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signedOn" < dvr.frozen_on THEN
      RAISE EXCEPTION 'safety: DVR signature % is dated on or after the version was frozen (%)', NEW."id", dvr.frozen_on
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."appointmentId" IS NOT NULL THEN
    SELECT a."role"::text, a."outsidePartyId" INTO appointed, appointee FROM "SafetyAppointment" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."appointmentId";
    IF FOUND AND appointed <> NEW."role"::text THEN
      RAISE EXCEPTION 'safety: DVR signature % for the % names an appointment to that role, not a % one', NEW."id", NEW."role", appointed
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- W2b schema wave 23 (B-W2b-184's need): a LINK signature is an outside signer's approval of our approval request on this
  -- very version (its company: the reference), answered APPROVED (by its APPROVAL link or in the portal: the request holds
  -- the evidence); the appointment it signs for is that party's; the name is the one typed and the day the day of the answer
  -- (Europe/Rome), signed no earlier than the answer.
  IF NEW."method" = 'LINK' THEN
    SELECT r."recordType" AS record_type, r."recordId" AS record_id, r."status"::text AS status, r."partyId" AS party_id, r."typedName" AS typed_name,
           r."answeredAt" AS answered_at
      INTO asked
      FROM "ApprovalRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."approvalRequestId";
    IF FOUND THEN
      IF asked.record_type <> 'RiskAssessmentVersion' OR asked.record_id <> NEW."versionId" OR asked.status <> 'APPROVED' THEN
        RAISE EXCEPTION 'safety: DVR signature % by link names an approval request of its own version %, answered APPROVED (request % is % on % %)', NEW."id", NEW."versionId", NEW."approvalRequestId", asked.status, asked.record_type, asked.record_id
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."appointmentId" IS NULL OR appointee IS DISTINCT FROM asked.party_id THEN
        RAISE EXCEPTION 'safety: DVR signature % by link names the outside appointment of the party that approved it', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF btrim(NEW."signerName") <> btrim(coalesce(asked.typed_name, '')) OR asked.answered_at IS NULL
         OR NEW."signedOn" <> (asked.answered_at AT TIME ZONE 'Europe/Rome')::date OR NEW."signedAt" < asked.answered_at THEN
        RAISE EXCEPTION 'safety: DVR signature % by link carries the name the signer typed and the day it approved (Europe/Rome), signed no earlier than the answer', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- The other safety registers (new triggers *_sign_method_not_link; their guards untouched): SafetySignMethod is shared, and
-- LINK is only a DVR signature's. An appointment's, an attendance's (and its countersignature), an instruction entry's
-- and a PPE issue's signature is OFFICE, FLOOR_PIN or PAPER, as before. The columns are the trigger's arguments.
CREATE FUNCTION "factory_safety_sign_method_not_link"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  column_name text;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    IF to_jsonb(NEW) ->> column_name = 'LINK' THEN
      RAISE EXCEPTION 'safety: % % is signed in the office, on paper or on the floor; LINK (an outside signer''s approval request) is only a DVR signature''s', TG_TABLE_NAME, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SafetyAppointment_sign_method_not_link" BEFORE INSERT OR UPDATE OF "signMethod" ON "SafetyAppointment"
  FOR EACH ROW EXECUTE FUNCTION "factory_safety_sign_method_not_link"('signMethod');
CREATE TRIGGER "TrainingAttendance_sign_method_not_link" BEFORE INSERT OR UPDATE OF "method", "countersignMethod" ON "TrainingAttendance"
  FOR EACH ROW EXECUTE FUNCTION "factory_safety_sign_method_not_link"('method', 'countersignMethod');
CREATE TRIGGER "InstructionRecord_sign_method_not_link" BEFORE INSERT OR UPDATE OF "signMethod" ON "InstructionRecord"
  FOR EACH ROW EXECUTE FUNCTION "factory_safety_sign_method_not_link"('signMethod');
CREATE TRIGGER "PpeIssue_sign_method_not_link" BEFORE INSERT OR UPDATE OF "method" ON "PpeIssue"
  FOR EACH ROW EXECUTE FUNCTION "factory_safety_sign_method_not_link"('method');

-- =====================================================================================================================
-- 6. Small follow-ups: a task handed to a colleague (B-W2b-167), the carrier's ETA and tracking page (B-W2b-175), the
--    cancel fee (B-W2b-183)
-- =====================================================================================================================

-- PartnerTask (new trigger PartnerTask_assignee_check; portal-frame's factory_partner_task_guard untouched: a partner
-- session still only marks a task done, and a closed task changes only by being reopened): the colleague a task is
-- handed to is an ACTIVE partner user of the task's own party, named or moved only while the task is OPEN.
CREATE FUNCTION "factory_partner_task_assignee_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person_audience text;
  person_party uuid;
  person_status text;
BEGIN
  IF NEW."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'portal: partner task % is %; it is handed to a colleague only while OPEN', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."assigneeId" IS NOT NULL THEN
    SELECT u."audience"::text, u."partyId", u."status"::text INTO person_audience, person_party, person_status
      FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."assigneeId";
    IF NOT FOUND OR person_audience <> 'PARTNER' OR person_party IS DISTINCT FROM NEW."partyId" OR person_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'portal: partner task % is handed to an active person of its own partner', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PartnerTask_assignee_check" AFTER INSERT ON "PartnerTask"
  FOR EACH ROW WHEN (NEW."assigneeId" IS NOT NULL)
  EXECUTE FUNCTION "factory_partner_task_assignee_check"();
CREATE TRIGGER "PartnerTask_assignee_change" AFTER UPDATE OF "assigneeId" ON "PartnerTask"
  FOR EACH ROW WHEN (NEW."assigneeId" IS DISTINCT FROM OLD."assigneeId")
  EXECUTE FUNCTION "factory_partner_task_assignee_check"();

-- Shipment: REDEFINES factory_shipment_guard (202610316401_followups_f1_w2b_guards), its whole body. Its rules stand;
-- W2b schema wave 23: the carrier's ETA (expectedDeliveryAt) joins what still changes once the goods left (the carrier
-- moves it while they travel); a cancelled shipment still changes only its internal note.
CREATE OR REPLACE FUNCTION "factory_shipment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  -- W2a: what still changes once the goods left.
  after_leaving CONSTANT text[] := ARRAY['freightCharge', 'transportEvidence', 'transportEvidenceAt', 'transportEvidenceById', 'transportEvidenceNote',
    -- W2b: how the charge was decided, what the carrier charged us (its invoice comes later) and the mode of transport.
    'freightBasis', 'freightCost', 'freightCostCurrency', 'transportMode',
    -- W2b schema wave 23: the carrier's ETA (it moves while the goods travel).
    'expectedDeliveryAt'];
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
    -- B-W2b-F1: the garments of a shipment the carrier brought back are received once, while it is RETURNED; that time
    -- never changes and never goes back to null.
    IF NEW."carrierReturnReceivedAt" IS DISTINCT FROM OLD."carrierReturnReceivedAt"
       AND NOT (OLD."status" = 'RETURNED' AND NEW."status" = 'RETURNED' AND OLD."carrierReturnReceivedAt" IS NULL) THEN
      RAISE EXCEPTION 'shipping: shipment %''s garments are received back once, after the carrier returned it (RETURNED); that time never changes', OLD."id"
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
       AND (to_jsonb(NEW) - (kept || after_leaving || ARRAY['internalNote', 'version', 'updatedAt', 'carrierReturnReceivedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || after_leaving || ARRAY['internalNote', 'version', 'updatedAt', 'carrierReturnReceivedAt'])) THEN
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
  IF NEW."carrierReturnReceivedAt" IS NOT NULL AND NEW."status" <> 'RETURNED' THEN
    RAISE EXCEPTION 'shipping: shipment % is %; its garments are received back only once the carrier returned it (RETURNED)', NEW."id", NEW."status"
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

-- Parcel (new trigger Parcel_tracking_url_check; the parcel guard untouched: a parcel changes until its shipment leaves):
-- the carrier's tracking page is an https address without spaces, up to 2000 characters.
CREATE FUNCTION "factory_parcel_tracking_url_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."trackingUrl" !~* '^https://[^[:space:]]+$' OR length(NEW."trackingUrl") > 2000 THEN
    RAISE EXCEPTION 'shipping: the tracking page of parcel % is an https address without spaces, up to 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Parcel_tracking_url_check" AFTER INSERT OR UPDATE OF "trackingUrl" ON "Parcel"
  FOR EACH ROW WHEN (NEW."trackingUrl" IS NOT NULL)
  EXECUTE FUNCTION "factory_parcel_tracking_url_check"();

-- SalesSettings (new trigger SalesSettings_cancel_fee_check, beside the settings' guard and the portal cut-offs' trigger,
-- neither redefined): the cancel fee is 0 to 100 percent of the cancelled lines' net value; null: free.
CREATE FUNCTION "factory_sales_settings_cancel_fee_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."cancelFeePct" < 0 OR NEW."cancelFeePct" > 100 THEN
    RAISE EXCEPTION 'sales: the cancel fee of the sales settings % is 0 to 100 percent (null: free)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SalesSettings_cancel_fee_check" AFTER INSERT OR UPDATE OF "cancelFeePct" ON "SalesSettings"
  FOR EACH ROW WHEN (NEW."cancelFeePct" IS NOT NULL)
  EXECUTE FUNCTION "factory_sales_settings_cancel_fee_check"();
