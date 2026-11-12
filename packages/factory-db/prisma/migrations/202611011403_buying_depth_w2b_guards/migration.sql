-- Written by hand (Prisma does not model triggers), after the generated 202611011402_buying_depth_w2b_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- W2b-5, schema wave 40/44 (B-W2b-285): buying and subcontracting in depth. Purchase orders that wait for a yes
-- (PENDING_APPROVAL), sample orders for a style or a sample round, foreign currency with the rate at order and the value in
-- the company's currency, delivery to a third party or straight to a workshop's location; line kinds (fabric by rolls, a
-- protector's certificate, a material variant); a delivery schedule per line with the supplier's confirmed date of each
-- delivery, and every move of a confirmed date as a row (PoDateChange); delivery tolerances; material variants (and a lot's);
-- requests to buy from anyone in the office; a kit line's material balance at the workshop and the workshop's cost booked
-- to the work order.
--
-- apps/factory-api checks all of this first, in words; these rules hold for every login, the owner included. Every refusal
-- is a check_violation (Prisma keeps its words) or, for kept data, a restrict_violation. The new triggers on the earlier
-- tables are AFTER triggers on their own columns (they never fire for a partner session's answer, which changes none of
-- them); the redefined functions keep their BEFORE triggers. A rule that reads another row reads what the role that fires it
-- may read. An UPDATE that changes nothing passes. The actor is not a database setting (B-W2b-F9): "who may decide" stays
-- the API's (B-W2b-282's engine holds "never your own request").
--
-- Earlier functions redefined here, each its whole body:
--   factory_purchase_order_guard       (…_portal_followups_w2b_guards, W2b schema wave 23; not redefined since):
--                                      PENDING_APPROVAL (DRAFT → PENDING_APPROVAL → SENT | DRAFT | CANCELLED; no send time,
--                                      no confirmation, its approval task), and the send's (or the ask's) checks of the
--                                      delivery schedule.
--   factory_purchase_order_line_guard  (…_portal_supply_w2b_guards, W2b wave 22/22; not redefined since): a confirmed date
--                                      moves after it was set, only with its date change.
-- NEW triggers (their own functions): PurchaseOrder_w2b5_depth(_change), PurchaseOrderLine_w2b5_depth(_change),
-- Lot_w2b5_variant(_change), the guards of the seven new tables, the append-only and TRUNCATE triggers.
--
-- Not hand-written here (the schema folder holds them as foreign keys): a sample round of the order's own style; a third
-- party's address of that party; a workshop location of the order's site; a variant of the line's or lot's own item (by
-- code: a code in use never changes); a delivery or date change of the line's own supplier and site; a request's work order
-- and purchase order line on its own site; a balance row's kit line, receipt and order of one site, work order and
-- workshop; a cost entry's operation, receipt and reversal of its own order.

-- =====================================================================================================================
-- 0. Helpers
-- =====================================================================================================================

CREATE FUNCTION "factory_buying_depth_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'buying: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- Append-only (scripts/factory/check-append-only.mjs): PoDateChange, SubcontractConsumption, SubcontractCostEntry. No login
-- may change or remove a row, the owner included; the runtime roles have no UPDATE, DELETE or TRUNCATE grant.
CREATE FUNCTION "factory_buying_depth_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a mistake is set right by a new row', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "PoDateChange_append_only" BEFORE UPDATE OR DELETE ON "PoDateChange"
  FOR EACH ROW EXECUTE FUNCTION "factory_buying_depth_refuse_change"();
CREATE TRIGGER "PoDateChange_no_truncate" BEFORE TRUNCATE ON "PoDateChange"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_buying_depth_refuse_change"();
CREATE TRIGGER "SubcontractConsumption_append_only" BEFORE UPDATE OR DELETE ON "SubcontractConsumption"
  FOR EACH ROW EXECUTE FUNCTION "factory_buying_depth_refuse_change"();
CREATE TRIGGER "SubcontractConsumption_no_truncate" BEFORE TRUNCATE ON "SubcontractConsumption"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_buying_depth_refuse_change"();
CREATE TRIGGER "SubcontractCostEntry_append_only" BEFORE UPDATE OR DELETE ON "SubcontractCostEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_buying_depth_refuse_change"();
CREATE TRIGGER "SubcontractCostEntry_no_truncate" BEFORE TRUNCATE ON "SubcontractCostEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_buying_depth_refuse_change"();

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['PurchaseOrderLineDelivery', 'DeliveryTolerance', 'ItemVariant', 'PurchaseRequest'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_buying_depth_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- Never deleted (archived or cancelled instead): the runtime roles have no DELETE grant; this holds for the owner too.
CREATE FUNCTION "factory_buying_depth_refuse_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'buying: % % is never deleted (%)', TG_TABLE_NAME, OLD."id", TG_ARGV[0]
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER "DeliveryTolerance_kept" BEFORE DELETE ON "DeliveryTolerance"
  FOR EACH ROW EXECUTE FUNCTION "factory_buying_depth_refuse_delete"('archive it');
CREATE TRIGGER "ItemVariant_kept" BEFORE DELETE ON "ItemVariant"
  FOR EACH ROW EXECUTE FUNCTION "factory_buying_depth_refuse_delete"('archive it');
CREATE TRIGGER "PurchaseRequest_kept" BEFORE DELETE ON "PurchaseRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_buying_depth_refuse_delete"('cancel it');

-- Words a person typed (line breaks and tabs allowed): not blank, at most `max_length` characters (null: none, fine).
CREATE FUNCTION "factory_buying_depth_words_ok"(value text, max_length int) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NULL OR (btrim(value) <> '' AND length(value) <= max_length AND value !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')
$$;

-- A code: 1 to `max_length` characters, no space or control character (null: none, fine).
CREATE FUNCTION "factory_buying_depth_code_ok"(value text, max_length int) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NULL OR (length(value) BETWEEN 1 AND max_length AND value !~ '[[:space:][:cntrl:]]')
$$;

-- One line of words: not blank, at most `max_length` characters, no control character (null: none, fine).
CREATE FUNCTION "factory_buying_depth_line_ok"(value text, max_length int) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NULL OR (btrim(value) <> '' AND length(value) <= max_length AND value !~ '[[:cntrl:]]')
$$;

-- Not later than now (5 minutes allowed for clocks).
CREATE FUNCTION "factory_buying_depth_not_future"(at timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT at IS NULL OR at <= now() + interval '5 minutes'
$$;

-- Does the newest date change of a line (delivery null: the line's own date) or of one of its deliveries move it from
-- `from_date` to `to_date`?
CREATE FUNCTION "factory_po_date_change_backs"(tenant uuid, line uuid, delivery uuid, from_date date, to_date date) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT c."fromDate" = from_date AND c."toDate" = to_date
                     FROM "PoDateChange" c
                    WHERE c."tenantId" = tenant AND c."purchaseOrderLineId" = line AND c."deliveryId" IS NOT DISTINCT FROM delivery
                    ORDER BY c."seq" DESC
                    LIMIT 1), false)
$$;

-- =====================================================================================================================
-- 1. PurchaseOrder (supply.prisma): waiting for a yes; the send's new checks
-- =====================================================================================================================

-- PurchaseOrder: REDEFINES factory_purchase_order_guard (202610319703_portal_followups_w2b_guards), its whole body. Its rules
-- stand; W2b-5 (schema wave 40/44):
--   PENDING_APPROVAL  DRAFT → PENDING_APPROVAL (a rule asked a yes) → SENT (sent with the yes) | DRAFT (refused, withdrawn,
--                     or to change it; its revision stays: it was never sent) | CANCELLED. While it waits its terms and
--                     lines are frozen (it is not DRAFT); it has no send time and no confirmation, and names its approval
--                     task (approvalTaskId, set in the move from DRAFT, kept after).
--   the checks        the move to PENDING_APPROVAL runs the send's checks (lines, their sum, no earlier confirmation), and
--                     so does the send: each live line's deliveries add up to it (quantity, base quantity, the first on its
--                     need date) and no delivery holds an earlier revision's confirmed date. A foreign currency's rate is
--                     NOT required at the send here: W1's create takes the supplier's currency and no route writes the
--                     rate yet (B-W2b-296 asks for it before its send); once written, rate and value are frozen terms.
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
  -- W2b-5 (schema wave 40/44): the send's checks of the delivery schedule.
  still_scheduled integer;
  unscheduled_seq integer;
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
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('SENT', 'PENDING_APPROVAL', 'CANCELLED'))
                -- W2b-5: a yes asked before the send; sent with the yes, or back to DRAFT (refused, withdrawn, to change it).
                OR (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('SENT', 'DRAFT', 'CANCELLED'))
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
       AND NOT ((OLD."status" IN ('DRAFT', 'PENDING_APPROVAL') AND NEW."status" = 'SENT') OR (OLD."status" IN ('SENT', 'DECLINED', 'CONFIRMED', 'CHANGES_PROPOSED') AND NEW."status" = 'DRAFT')) THEN
      RAISE EXCEPTION 'supply: purchase order % gets its send time when it is sent, and loses it when it goes back to DRAFT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."revision" NOT IN (OLD."revision", OLD."revision" + 1)
       OR (NEW."status" = 'DRAFT' AND OLD."status" IN ('SENT', 'DECLINED', 'CONFIRMED', 'CHANGES_PROPOSED')) <> (NEW."revision" = OLD."revision" + 1) THEN
      RAISE EXCEPTION 'supply: the revision of purchase order % goes up by one exactly when a SENT, DECLINED, CONFIRMED or CHANGES_PROPOSED order goes back to DRAFT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b-5: the same checks when it asks its yes (the approver sees the order as it will be sent) and when it is sent with it.
    IF OLD."status" IN ('DRAFT', 'PENDING_APPROVAL') AND NEW."status" IN ('SENT', 'PENDING_APPROVAL') AND NEW."status" <> OLD."status" THEN
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
      -- W2b-5 (SCM-052): each live line's deliveries add up to the line (quantity and base quantity), the first on its
      -- need date; none still holds an earlier revision's confirmed date.
      SELECT count(*) FILTER (WHERE d."confirmedDate" IS NOT NULL) INTO still_scheduled
        FROM "PurchaseOrderLineDelivery" d JOIN "PurchaseOrderLine" l ON l."tenantId" = d."tenantId" AND l."id" = d."purchaseOrderLineId"
       WHERE l."tenantId" = NEW."tenantId" AND l."purchaseOrderId" = NEW."id" AND l."cancelledAt" IS NULL AND l."closedShortAt" IS NULL;
      IF still_scheduled > 0 THEN
        RAISE EXCEPTION 'supply: % delivery(ies) of purchase order % still hold the confirmed date of an earlier revision; clear it before sending revision %', still_scheduled, NEW."id", NEW."revision"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT l."seq" INTO unscheduled_seq
        FROM "PurchaseOrderLine" l
        JOIN LATERAL (SELECT count(*) AS n, sum(d."quantity") AS quantity, sum(d."baseQuantity") AS base, min(d."needDate") AS first
                        FROM "PurchaseOrderLineDelivery" d WHERE d."tenantId" = l."tenantId" AND d."purchaseOrderLineId" = l."id") s ON true
       WHERE l."tenantId" = NEW."tenantId" AND l."purchaseOrderId" = NEW."id" AND l."cancelledAt" IS NULL AND s.n > 0
         AND (s.quantity <> l."quantity" OR s.base <> l."baseQuantity" OR s.first <> l."needDate")
       ORDER BY l."seq" LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'supply: the deliveries of line % of purchase order % do not add up to the line (its quantity and base quantity, the first delivery on its need date); it cannot be sent or asked a yes for', unscheduled_seq, NEW."id"
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
  IF (NEW."status" IN ('DRAFT', 'PENDING_APPROVAL') AND NEW."sentAt" IS NOT NULL) OR (NEW."status" NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED') AND NEW."sentAt" IS NULL) THEN
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
     OR (NEW."status" IN ('DRAFT', 'PENDING_APPROVAL', 'SENT', 'DECLINED', 'CHANGES_PROPOSED') AND NEW."confirmedAt" IS NOT NULL) THEN
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
  -- W2b-5 (SCM-078): an order waiting for its yes names the approval task (by id: another wave's table).
  IF NEW."status" = 'PENDING_APPROVAL' AND NEW."approvalTaskId" IS NULL THEN
    RAISE EXCEPTION 'supply: purchase order % waits for a yes (PENDING_APPROVAL) and names its approval task', NEW."id"
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


-- PurchaseOrder (new triggers PurchaseOrder_w2b5_depth and _change; their own function), on insert and when one of these
-- columns changes (a partner session's answer changes none of them; the guard above freezes them outside DRAFT):
--   kind         a STANDARD order names no development style or sample round; a sample round only with its style (the
--                foreign key keeps the round of that style); the style tenant-wide or of the order's company, the round of
--                the order's company.
--   currency     the rate (above 0) and the value in the company's currency (0 or more) together or neither; neither for an
--                order in its company's own currency.
--   ship to      a third party other than the supplier; its address (one of its own: the foreign key) and its location only
--                with it; the address usable (ACTIVE, not waiting for the office's check nor refused); the location a
--                SUBCONTRACTOR place of that party on the order's site, ACTIVE.
CREATE FUNCTION "factory_purchase_order_depth_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  company_currency text;
  place record;
  address record;
  owner_company uuid;
BEGIN
  IF NEW."kind" = 'STANDARD' AND (NEW."developmentStyleId" IS NOT NULL OR NEW."sampleRoundId" IS NOT NULL) THEN
    RAISE EXCEPTION 'supply: purchase order % is a STANDARD order; only a SAMPLE order names a development style or sample round', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sampleRoundId" IS NOT NULL AND NEW."developmentStyleId" IS NULL THEN
    RAISE EXCEPTION 'supply: purchase order % names a sample round with its style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."developmentStyleId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."developmentStyleId" IS DISTINCT FROM OLD."developmentStyleId" OR NEW."sampleRoundId" IS DISTINCT FROM OLD."sampleRoundId") THEN
    SELECT s."companyId" INTO owner_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."developmentStyleId";
    IF owner_company IS NOT NULL AND owner_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'supply: purchase order % develops a style of another company; a style of its own company or tenant-wide', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."sampleRoundId" IS NOT NULL THEN
      SELECT r."companyId" INTO owner_company FROM "SampleRound" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."sampleRoundId";
      IF FOUND AND owner_company <> NEW."companyId" THEN
        RAISE EXCEPTION 'supply: purchase order % buys for a sample round of another company; a round of its own company', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF (NEW."rateAtOrder" IS NULL) <> (NEW."companyNetAmount" IS NULL) OR NEW."rateAtOrder" <= 0 OR NEW."companyNetAmount" < 0 THEN
    RAISE EXCEPTION 'supply: purchase order % carries its rate at order (above 0) and its value in the company''s currency (0 or more) together, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."rateAtOrder" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."rateAtOrder" IS DISTINCT FROM OLD."rateAtOrder") THEN
    SELECT c."currency" INTO company_currency FROM "Company" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."companyId";
    IF FOUND AND company_currency = NEW."currency" THEN
      RAISE EXCEPTION 'supply: purchase order % is in its company''s own currency (%); it takes no rate at order', NEW."id", NEW."currency"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."shipToPartyId" IS NULL AND (NEW."shipToAddressId" IS NOT NULL OR NEW."shipToLocationId" IS NOT NULL))
     OR NEW."shipToPartyId" = NEW."partyId" THEN
    RAISE EXCEPTION 'supply: purchase order % ships to a third party other than its supplier, and names an address or a workshop location only with that party', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shipToAddressId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."shipToAddressId" IS DISTINCT FROM OLD."shipToAddressId") THEN
    SELECT a."status"::text AS status, a."approvalStatus"::text AS approval INTO address
      FROM "PartyAddress" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."shipToAddressId";
    IF FOUND AND (address.status <> 'ACTIVE' OR address.approval IN ('WAITING', 'REFUSED')) THEN
      RAISE EXCEPTION 'supply: purchase order % ships to address %, which is % (%); an order uses an active address of the office''s own or one it approved', NEW."id", NEW."shipToAddressId", address.status, coalesce(address.approval, 'no check')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."shipToLocationId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."shipToLocationId" IS DISTINCT FROM OLD."shipToLocationId" OR NEW."shipToPartyId" IS DISTINCT FROM OLD."shipToPartyId") THEN
    SELECT l."kind"::text AS kind, l."partyId", l."status"::text AS status INTO place
      FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."shipToLocationId";
    IF FOUND AND (place.kind <> 'SUBCONTRACTOR' OR place."partyId" IS DISTINCT FROM NEW."shipToPartyId" OR place.status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'supply: purchase order % lands at location %: an active SUBCONTRACTOR place of the party it ships to, on the order''s site', NEW."id", NEW."shipToLocationId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PurchaseOrder_w2b5_depth" AFTER INSERT ON "PurchaseOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_purchase_order_depth_check"();
CREATE TRIGGER "PurchaseOrder_w2b5_depth_change"
  AFTER UPDATE OF "kind", "developmentStyleId", "sampleRoundId", "currency", "rateAtOrder", "companyNetAmount", "shipToPartyId", "shipToAddressId", "shipToLocationId" ON "PurchaseOrder"
  FOR EACH ROW
  WHEN ((NEW."kind", NEW."developmentStyleId", NEW."sampleRoundId", NEW."currency", NEW."rateAtOrder", NEW."companyNetAmount", NEW."shipToPartyId", NEW."shipToAddressId", NEW."shipToLocationId")
        IS DISTINCT FROM
        (OLD."kind", OLD."developmentStyleId", OLD."sampleRoundId", OLD."currency", OLD."rateAtOrder", OLD."companyNetAmount", OLD."shipToPartyId", OLD."shipToAddressId", OLD."shipToLocationId"))
  EXECUTE FUNCTION "factory_purchase_order_depth_check"();

-- =====================================================================================================================
-- 2. PurchaseOrderLine (supply.prisma): a confirmed date moves with its date change; rolls, certificate, variant
-- =====================================================================================================================

-- PurchaseOrderLine: REDEFINES factory_purchase_order_line_guard (202610319403_portal_supply_w2b_guards), its whole body.
-- Its rules stand; W2b-5 (SCM-088): once set, a line's confirmed date (its quantity as it is) moves while the order is SENT,
-- CHANGES_PROPOSED, CONFIRMED or PARTLY_RECEIVED only to the toDate of the line's newest date change (deliveryId null) whose
-- fromDate is the date it had (factory_po_date_change_backs); a partner session never moves it. The new columns (rolls,
-- roll length and width, certificate, variant) are terms: they change only while the order is DRAFT, as before.

CREATE OR REPLACE FUNCTION "factory_purchase_order_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  answer CONSTANT text[] := ARRAY['confirmedQuantity', 'confirmedDate', 'proposedQuantity', 'proposedDate', 'proposedSplitQuantity',
    'proposedSplitDate', 'proposalReason', 'proposedSubstituteItemId', 'proposedSubstituteNote', 'proposalNeedsBuyer', 'version', 'updatedAt'];
  ending CONSTANT text[] := ARRAY['cancelledAt', 'cancelledById', 'cancelReason', 'closedShortAt', 'closedShortById', 'closeShortReason'];
  state text;
  part_of uuid;
  item_needs_test boolean;
  -- W2b-5 (schema wave 40/44, SCM-088): a confirmed date moved after it was set, with its date change.
  redated boolean := false;
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
    -- W2b-5 (SCM-088): once set, the confirmed date moves (the quantity as it is) only to the toDate of the line's newest
    -- date change, whose fromDate is the date it had, while the order is open (SENT, CHANGES_PROPOSED, CONFIRMED,
    -- PARTLY_RECEIVED); a partner session never moves it (it records no date change).
    IF OLD."confirmedDate" IS NOT NULL AND NEW."confirmedDate" IS NOT NULL AND NEW."confirmedDate" <> OLD."confirmedDate"
       AND NEW."confirmedQuantity" IS NOT DISTINCT FROM OLD."confirmedQuantity"
       AND state IN ('SENT', 'CHANGES_PROPOSED', 'CONFIRMED', 'PARTLY_RECEIVED') AND current_user <> 'factory_partner_runtime' THEN
      IF NOT "factory_po_date_change_backs"(NEW."tenantId", NEW."id", NULL, OLD."confirmedDate", NEW."confirmedDate") THEN
        RAISE EXCEPTION 'supply: the confirmed date of purchase order line % moves from % to % only with its date change (the line''s newest PoDateChange from % to %)', OLD."id", OLD."confirmedDate", NEW."confirmedDate", OLD."confirmedDate", NEW."confirmedDate"
          USING ERRCODE = 'check_violation';
      END IF;
      redated := true;
    END IF;
    IF (NEW."confirmedQuantity", NEW."confirmedDate") IS DISTINCT FROM (OLD."confirmedQuantity", OLD."confirmedDate")
       AND NOT redated
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

-- PurchaseOrderLine (new triggers PurchaseOrderLine_w2b5_depth and _change; their own function), on insert and when one of
-- these columns changes (a partner session's answer changes none of them):
--   rolls        a fabric line's rolls, roll length (m) and usable width (cm) each above 0; a length or width only with the
--                rolls.
--   certificate  named on a PPE component's line (a PROTECTOR, or an item marked isPpeComponent): a VALID certificate with an
--                ACTIVE coverage of the line's item.
--   variant      ACTIVE when named, and of the line's colour when the variant has one (the foreign key keeps it a variant of
--                the line's own item).
CREATE FUNCTION "factory_purchase_order_line_depth_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_kind text;
  item_ppe boolean;
  certificate_status text;
  variant record;
BEGIN
  IF NEW."rolls" <= 0 OR NEW."rollLengthM" <= 0 OR NEW."rollWidthCm" <= 0
     OR (NEW."rolls" IS NULL AND (NEW."rollLengthM" IS NOT NULL OR NEW."rollWidthCm" IS NOT NULL)) THEN
    RAISE EXCEPTION 'supply: purchase order line % buys whole rolls (above 0) with each roll''s length and width above 0, a length or width only with the rolls', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."certificateId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."certificateId" IS DISTINCT FROM OLD."certificateId" OR NEW."itemId" IS DISTINCT FROM OLD."itemId") THEN
    SELECT i."kind"::text, i."isPpeComponent" INTO item_kind, item_ppe FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND item_kind <> 'PROTECTOR' AND NOT item_ppe THEN
      RAISE EXCEPTION 'supply: purchase order line % names a certificate; only a PPE component''s line (a protector) does', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT c."status"::text INTO certificate_status FROM "Certificate" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."certificateId";
    IF FOUND AND (certificate_status <> 'VALID'
                  OR NOT EXISTS (SELECT 1 FROM "CertificateCoverage" v
                                  WHERE v."tenantId" = NEW."tenantId" AND v."certificateId" = NEW."certificateId" AND v."itemId" = NEW."itemId" AND v."status" = 'ACTIVE')) THEN
      RAISE EXCEPTION 'supply: purchase order line % names certificate % (%), which must be VALID and cover the line''s item', NEW."id", NEW."certificateId", certificate_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."variantCode" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."variantCode" IS DISTINCT FROM OLD."variantCode" OR NEW."itemColourId" IS DISTINCT FROM OLD."itemColourId") THEN
    SELECT v."status"::text AS status, v."itemColourId" INTO variant
      FROM "ItemVariant" v WHERE v."tenantId" = NEW."tenantId" AND v."itemId" = NEW."itemId" AND v."code" = NEW."variantCode";
    IF FOUND AND (variant.status <> 'ACTIVE' OR (variant."itemColourId" IS NOT NULL AND variant."itemColourId" IS DISTINCT FROM NEW."itemColourId")) THEN
      RAISE EXCEPTION 'supply: purchase order line % buys variant %: an ACTIVE variant of its item, of the line''s colour when the variant has one', NEW."id", NEW."variantCode"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PurchaseOrderLine_w2b5_depth" AFTER INSERT ON "PurchaseOrderLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_purchase_order_line_depth_check"();
CREATE TRIGGER "PurchaseOrderLine_w2b5_depth_change"
  AFTER UPDATE OF "rolls", "rollLengthM", "rollWidthCm", "certificateId", "variantCode", "itemId", "itemColourId" ON "PurchaseOrderLine"
  FOR EACH ROW
  WHEN ((NEW."rolls", NEW."rollLengthM", NEW."rollWidthCm", NEW."certificateId", NEW."variantCode", NEW."itemId", NEW."itemColourId")
        IS DISTINCT FROM
        (OLD."rolls", OLD."rollLengthM", OLD."rollWidthCm", OLD."certificateId", OLD."variantCode", OLD."itemId", OLD."itemColourId"))
  EXECUTE FUNCTION "factory_purchase_order_line_depth_check"();

-- =====================================================================================================================
-- 3. PurchaseOrderLineDelivery: the delivery schedule
-- =====================================================================================================================

-- PurchaseOrderLineDelivery (factory_po_line_delivery_guard, BEFORE):
--   INSERT, DELETE  only while the order is DRAFT (a removed line's deliveries first); a new one on a live line, with no
--                   confirmed date.
--   UPDATE          never to another line; its day, quantities, place and note change only while the order is DRAFT and
--                   the line is live. The confirmed date: set once from none while the order is SENT, CHANGES_PROPOSED or
--                   CONFIRMED (with the confirmation); cleared only while DRAFT (a new revision); once set it moves while
--                   the order is SENT, CHANGES_PROPOSED, CONFIRMED or PARTLY_RECEIVED only to the toDate of the
--                   delivery's newest date change whose fromDate is the date it had. A cancelled or closed-short line's
--                   deliveries change no more. A partner session only sets a confirmed date from none, while SENT.
--   every row       quantities above 0, a place from 1, the note's words at most 2000 characters.
CREATE FUNCTION "factory_po_line_delivery_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId', 'version', 'updatedAt'];
  order_id uuid;
  line_ended boolean;
  state text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT l."purchaseOrderId" INTO order_id FROM "PurchaseOrderLine" l WHERE l."tenantId" = OLD."tenantId" AND l."id" = OLD."purchaseOrderLineId";
    SELECT o."status"::text INTO state FROM "PurchaseOrder" o WHERE o."tenantId" = OLD."tenantId" AND o."id" = order_id FOR SHARE;
    IF state IS NOT NULL AND state <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: purchase order % is %; its deliveries are removed only while it is DRAFT', order_id, state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  SELECT l."purchaseOrderId", (l."cancelledAt" IS NOT NULL OR l."closedShortAt" IS NOT NULL) INTO order_id, line_ended
    FROM "PurchaseOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."purchaseOrderLineId";
  SELECT o."status"::text INTO state FROM "PurchaseOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = order_id FOR SHARE;

  IF TG_OP = 'INSERT' THEN
    IF state IS NOT NULL AND state <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: purchase order % is %; deliveries are planned only while it is DRAFT', order_id, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF line_ended THEN
      RAISE EXCEPTION 'supply: purchase order line % is cancelled or closed short; it takes no delivery', NEW."purchaseOrderLineId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."confirmedDate" IS NOT NULL THEN
      RAISE EXCEPTION 'supply: delivery % is new; the supplier has not confirmed it yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."id" <> OLD."id" OR NEW."purchaseOrderLineId" <> OLD."purchaseOrderLineId" THEN
      RAISE EXCEPTION 'supply: delivery % never moves to another line', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF line_ended AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'supply: the line of delivery % is cancelled or closed short; the delivery changes no more', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF state IS NOT NULL AND state <> 'DRAFT'
       AND (to_jsonb(NEW) - (kept || ARRAY['confirmedDate'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['confirmedDate'])) THEN
      RAISE EXCEPTION 'supply: purchase order % is %; its deliveries change only while it is DRAFT (recall it to change them)', order_id, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."confirmedDate" IS DISTINCT FROM OLD."confirmedDate" THEN
      IF OLD."confirmedDate" IS NULL THEN
        IF state IS NOT NULL AND state NOT IN ('SENT', 'CHANGES_PROPOSED', 'CONFIRMED') THEN
          RAISE EXCEPTION 'supply: the confirmed date of delivery % is set while its order is SENT, CHANGES_PROPOSED or CONFIRMED (it is %)', OLD."id", state
            USING ERRCODE = 'check_violation';
        END IF;
      ELSIF NEW."confirmedDate" IS NULL THEN
        IF state IS NOT NULL AND state <> 'DRAFT' THEN
          RAISE EXCEPTION 'supply: the confirmed date of delivery % is cleared only while its order is DRAFT for a new revision', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
      ELSIF current_user = 'factory_partner_runtime'
            OR (state IS NOT NULL AND state NOT IN ('SENT', 'CHANGES_PROPOSED', 'CONFIRMED', 'PARTLY_RECEIVED'))
            OR NOT "factory_po_date_change_backs"(NEW."tenantId", NEW."purchaseOrderLineId", NEW."id", OLD."confirmedDate", NEW."confirmedDate") THEN
        RAISE EXCEPTION 'supply: the confirmed date of delivery % moves from % to % only with its date change (the delivery''s newest PoDateChange from % to %), while its order is open', OLD."id", OLD."confirmedDate", NEW."confirmedDate", OLD."confirmedDate", NEW."confirmedDate"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND ((to_jsonb(NEW) - (kept || ARRAY['confirmedDate'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['confirmedDate']))
            OR (NEW."confirmedDate" IS DISTINCT FROM OLD."confirmedDate" AND (state IS DISTINCT FROM 'SENT' OR OLD."confirmedDate" IS NOT NULL))) THEN
      RAISE EXCEPTION 'supply: a partner session only confirms the date of a delivery of its SENT purchase order, once (delivery %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."quantity" <= 0 OR NEW."baseQuantity" <= 0 OR NEW."seq" < 1 OR NOT "factory_buying_depth_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'supply: delivery % has quantities above 0, a place from 1 and a note of at most 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PurchaseOrderLineDelivery_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PurchaseOrderLineDelivery"
  FOR EACH ROW EXECUTE FUNCTION "factory_po_line_delivery_guard"();

-- =====================================================================================================================
-- 4. PoDateChange: the history of confirmed dates (append-only, above)
-- =====================================================================================================================

-- PoDateChange (factory_po_date_change_check, BEFORE INSERT): a change of a confirmed date that is set, of a live line of an
-- open order (SENT, CHANGES_PROPOSED, CONFIRMED, PARTLY_RECEIVED); a delivery's change names a delivery of the line (the
-- foreign key) with a confirmed date; its place above every earlier one of the line (under a lock per line); two different
-- days; SUPPLIER alone may name the supplier's person (one line, at most 200 characters); the reason's words 1 to 2000
-- characters; when, not in the future.
-- PoDateChange_applied (a deferred constraint trigger, at commit): the newest change of a line's (or delivery's) date is the
-- date it holds: a change is recorded in the command that moves the date (the line or delivery guard checks the other way).
CREATE FUNCTION "factory_po_date_change_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_id uuid;
  line_ended boolean;
  line_date date;
  target_date date;
  state text;
  last_seq integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('PoDateChange:' || NEW."purchaseOrderLineId"::text, 0));
  SELECT l."purchaseOrderId", (l."cancelledAt" IS NOT NULL OR l."closedShortAt" IS NOT NULL), l."confirmedDate" INTO order_id, line_ended, line_date
    FROM "PurchaseOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."purchaseOrderLineId";
  IF NOT FOUND THEN
    -- A line the session cannot see (another tenant's): the policies and the foreign key refuse the row.
    RETURN NEW;
  END IF;
  SELECT o."status"::text INTO state FROM "PurchaseOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = order_id;
  IF state IS NOT NULL AND state NOT IN ('SENT', 'CHANGES_PROPOSED', 'CONFIRMED', 'PARTLY_RECEIVED') THEN
    RAISE EXCEPTION 'supply: purchase order % is %; a confirmed date moves only while it is SENT, CHANGES_PROPOSED, CONFIRMED or PARTLY_RECEIVED', order_id, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF line_ended THEN
    RAISE EXCEPTION 'supply: purchase order line % is cancelled or closed short; its dates move no more', NEW."purchaseOrderLineId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."deliveryId" IS NULL THEN
    target_date := line_date;
  ELSE
    SELECT d."confirmedDate" INTO target_date FROM "PurchaseOrderLineDelivery" d
     WHERE d."tenantId" = NEW."tenantId" AND d."purchaseOrderLineId" = NEW."purchaseOrderLineId" AND d."id" = NEW."deliveryId";
  END IF;
  IF target_date IS NULL THEN
    RAISE EXCEPTION 'supply: % of purchase order line % has no confirmed date yet; its first confirmation is not a change', CASE WHEN NEW."deliveryId" IS NULL THEN 'the line' ELSE 'delivery ' || NEW."deliveryId"::text END, NEW."purchaseOrderLineId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(c."seq") INTO last_seq FROM "PoDateChange" c WHERE c."tenantId" = NEW."tenantId" AND c."purchaseOrderLineId" = NEW."purchaseOrderLineId";
  IF NEW."seq" < 1 OR NEW."seq" <= coalesce(last_seq, 0) THEN
    RAISE EXCEPTION 'supply: date change % of purchase order line % takes a place above the line''s last one (%)', NEW."id", NEW."purchaseOrderLineId", coalesce(last_seq, 0)
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fromDate" = NEW."toDate" THEN
    RAISE EXCEPTION 'supply: date change % moves the date (from % to the same day)', NEW."id", NEW."fromDate"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."supplierContactName" IS NOT NULL AND NEW."source" <> 'SUPPLIER') OR NOT "factory_buying_depth_line_ok"(NEW."supplierContactName", 200)
     OR NEW."reason" IS NULL OR NOT "factory_buying_depth_words_ok"(NEW."reason", 2000) OR NOT "factory_buying_depth_not_future"(NEW."changedAt") THEN
    RAISE EXCEPTION 'supply: date change % says why (1 to 2000 characters) and when (not in the future); only the supplier''s names its person (at most 200 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PoDateChange_check" BEFORE INSERT ON "PoDateChange"
  FOR EACH ROW EXECUTE FUNCTION "factory_po_date_change_check"();

CREATE FUNCTION "factory_po_date_change_applied"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  newest uuid;
  held date;
BEGIN
  SELECT c."id" INTO newest FROM "PoDateChange" c
   WHERE c."tenantId" = NEW."tenantId" AND c."purchaseOrderLineId" = NEW."purchaseOrderLineId" AND c."deliveryId" IS NOT DISTINCT FROM NEW."deliveryId"
   ORDER BY c."seq" DESC LIMIT 1;
  IF newest IS DISTINCT FROM NEW."id" THEN
    RETURN NULL;
  END IF;
  IF NEW."deliveryId" IS NULL THEN
    SELECT l."confirmedDate" INTO held FROM "PurchaseOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."purchaseOrderLineId";
  ELSE
    SELECT d."confirmedDate" INTO held FROM "PurchaseOrderLineDelivery" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."deliveryId";
  END IF;
  IF held IS DISTINCT FROM NEW."toDate" THEN
    RAISE EXCEPTION 'supply: date change % moves the confirmed date to %, but % of line % holds %; move the date in the same command', NEW."id", NEW."toDate", CASE WHEN NEW."deliveryId" IS NULL THEN 'the line' ELSE 'its delivery' END, NEW."purchaseOrderLineId", held
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "PoDateChange_applied" AFTER INSERT ON "PoDateChange"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "factory_po_date_change_applied"();

-- =====================================================================================================================
-- 5. DeliveryTolerance, ItemVariant, a lot's variant
-- =====================================================================================================================

-- DeliveryTolerance (factory_delivery_tolerance_check, AFTER INSERT OR UPDATE; never deleted, above): over and under from 0
-- to 100 percent; one material or one kind of material (never FINISHED), not both; the note's words at most 2000
-- characters; its creation never changes.
CREATE FUNCTION "factory_delivery_tolerance_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'buying: the creation of delivery tolerance % never changes', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."overPct" < 0 OR NEW."overPct" > 100 OR NEW."underPct" < 0 OR NEW."underPct" > 100 THEN
    RAISE EXCEPTION 'buying: delivery tolerance % is from 0 to 100 percent over and under', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."itemId" IS NOT NULL AND NEW."itemKind" IS NOT NULL) OR NEW."itemKind" = 'FINISHED' THEN
    RAISE EXCEPTION 'buying: delivery tolerance % is for one material or one kind of material (not finished garments), not both', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."itemId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."itemId" IS DISTINCT FROM OLD."itemId") THEN
    SELECT i."kind"::text INTO item_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF item_kind = 'FINISHED' THEN
      RAISE EXCEPTION 'buying: delivery tolerance % is for a material; % is a finished garment', NEW."id", NEW."itemId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_buying_depth_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'buying: the note of delivery tolerance % is at most 2000 characters, not blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "DeliveryTolerance_check" AFTER INSERT OR UPDATE ON "DeliveryTolerance"
  FOR EACH ROW EXECUTE FUNCTION "factory_delivery_tolerance_check"();

-- ItemVariant (factory_item_variant_check, AFTER INSERT OR UPDATE; never deleted, above): a variant of a material (never a
-- FINISHED item) with a colour (one of the item's: the foreign key), a size (one line, 1 to 40 characters) or both; its code
-- 1 to 60 characters without spaces, the supplier's 1 to 60 without control characters. What it is (item, colour, size,
-- code) and its creation never change: only the supplier's code and the status (ACTIVE ⇄ ARCHIVED) do.
CREATE FUNCTION "factory_item_variant_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."itemId", NEW."itemColourId", NEW."size", NEW."code", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."itemId", OLD."itemColourId", OLD."size", OLD."code", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'buying: variant % stays what it is (item, colour, size, code); another one is a new variant', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    SELECT i."kind"::text INTO item_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF item_kind = 'FINISHED' THEN
      RAISE EXCEPTION 'buying: variant % is of a material; % is a finished garment (its SKUs are the style''s)', NEW."id", NEW."itemId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."itemColourId" IS NULL AND NEW."size" IS NULL) OR NOT "factory_buying_depth_line_ok"(NEW."size", 40)
     OR NEW."code" IS NULL OR NOT "factory_buying_depth_code_ok"(NEW."code", 60)
     OR NOT "factory_buying_depth_line_ok"(NEW."supplierCode", 60) THEN
    RAISE EXCEPTION 'buying: variant % names a colour, a size (at most 40 characters) or both, a code of 1 to 60 characters without spaces, and a supplier''s code of at most 60', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ItemVariant_check" AFTER INSERT OR UPDATE ON "ItemVariant"
  FOR EACH ROW EXECUTE FUNCTION "factory_item_variant_check"();

-- Lot (new triggers Lot_w2b5_variant and _change; their own function; W1's factory_lot_guard untouched): a lot's variant is
-- set when the lot is made, or once on an older lot, and never changes; ACTIVE when named, of the lot's colour when the
-- variant has one; a lot received on a purchase order line of a variant is of that variant.
CREATE FUNCTION "factory_lot_variant_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  variant record;
  line_variant text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."variantCode" IS NOT NULL AND NEW."variantCode" IS DISTINCT FROM OLD."variantCode" THEN
    RAISE EXCEPTION 'inventory: lot % is of variant %; its variant never changes', OLD."id", OLD."variantCode"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."variantCode" IS NOT NULL THEN
    SELECT v."status"::text AS status, v."itemColourId" INTO variant
      FROM "ItemVariant" v WHERE v."tenantId" = NEW."tenantId" AND v."itemId" = NEW."itemId" AND v."code" = NEW."variantCode";
    IF FOUND AND (variant.status <> 'ACTIVE' OR (variant."itemColourId" IS NOT NULL AND variant."itemColourId" IS DISTINCT FROM NEW."itemColourId")) THEN
      RAISE EXCEPTION 'inventory: lot % is of variant %: an ACTIVE variant of its item, of the lot''s colour when the variant has one', NEW."id", NEW."variantCode"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."receiptLineId" IS NOT NULL THEN
    SELECT p."variantCode" INTO line_variant
      FROM "GoodsReceiptLine" r JOIN "PurchaseOrderLine" p ON p."tenantId" = r."tenantId" AND p."id" = r."purchaseOrderLineId"
     WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."receiptLineId";
    IF line_variant IS NOT NULL AND NEW."variantCode" IS DISTINCT FROM line_variant THEN
      RAISE EXCEPTION 'inventory: lot % comes from a purchase order line of variant %; it is of that variant', NEW."id", line_variant
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Lot_w2b5_variant" AFTER INSERT ON "Lot"
  FOR EACH ROW WHEN (NEW."variantCode" IS NOT NULL OR NEW."receiptLineId" IS NOT NULL)
  EXECUTE FUNCTION "factory_lot_variant_check"();
CREATE TRIGGER "Lot_w2b5_variant_change" AFTER UPDATE OF "variantCode" ON "Lot"
  FOR EACH ROW WHEN (NEW."variantCode" IS DISTINCT FROM OLD."variantCode")
  EXECUTE FUNCTION "factory_lot_variant_check"();

-- =====================================================================================================================
-- 6. PurchaseRequest: requests to buy from anyone in the office
-- =====================================================================================================================

-- PurchaseRequest (factory_purchase_request_guard, BEFORE INSERT OR UPDATE; never deleted, above):
--   INSERT    OPEN, or PENDING_APPROVAL when a rule asks a yes; nothing refused, converted or cancelled yet; asked not in
--             the future.
--   UPDATE    who asked, when, for which company, site and work order, from where (and the shortage as seen) and its
--             creation never change; what is asked (material, colour, words, quantity, unit, day, reason) changes only
--             while OPEN; OPEN → PENDING_APPROVAL | CONVERTED | REJECTED | CANCELLED, PENDING_APPROVAL → OPEN (the yes) |
--             REJECTED | CANCELLED; CONVERTED, REJECTED and CANCELLED are final. The approval task is named in the move to
--             PENDING_APPROVAL and kept after; the refusal, the conversion and the cancellation are written in their move.
--   every row a material (its colour only with it) or words for one not in the library (at most 2000 characters); a
--             quantity above 0; the reason 1 to 2000 characters; a SHORTAGE names its work order and material and the
--             shortage as seen (an object), an OFFICE request no shortage; PENDING_APPROVAL with its approval task;
--             REJECTED exactly with when, by whom and why; CONVERTED exactly with when, by whom and the purchase order line
--             (of the request's material when it names one); CANCELLED exactly with when and why.
CREATE FUNCTION "factory_purchase_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_item uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('OPEN', 'PENDING_APPROVAL')
       OR NEW."rejectedAt" IS NOT NULL OR NEW."rejectedById" IS NOT NULL OR NEW."rejectReason" IS NOT NULL
       OR NEW."convertedAt" IS NOT NULL OR NEW."convertedById" IS NOT NULL OR NEW."purchaseOrderLineId" IS NOT NULL
       OR NEW."cancelledAt" IS NOT NULL OR NEW."cancelReason" IS NOT NULL THEN
      RAISE EXCEPTION 'buying: request to buy % starts OPEN (or PENDING_APPROVAL when a rule asks a yes), not yet refused, converted or cancelled', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_buying_depth_not_future"(NEW."requestedAt") THEN
      RAISE EXCEPTION 'buying: request to buy % is asked now or before, not in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."siteId", NEW."requestedById", NEW."requestedAt", NEW."source", NEW."workOrderId", NEW."shortage", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."siteId", OLD."requestedById", OLD."requestedAt", OLD."source", OLD."workOrderId", OLD."shortage", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'buying: who asked for request to buy %, when, where, for which work order and from where never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'OPEN' AND NEW."status" IN ('PENDING_APPROVAL', 'CONVERTED', 'REJECTED', 'CANCELLED'))
                OR (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('OPEN', 'REJECTED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'buying: request to buy % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CONVERTED', 'REJECTED', 'CANCELLED')
       AND (to_jsonb(NEW) - ARRAY['version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version', 'updatedAt']) THEN
      RAISE EXCEPTION 'buying: request to buy % is %; it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD."status" = 'OPEN' AND NEW."status" = 'OPEN')
       AND (NEW."itemId", NEW."itemColourId", NEW."description", NEW."quantity", NEW."uom", NEW."needDate", NEW."reason")
           IS DISTINCT FROM (OLD."itemId", OLD."itemColourId", OLD."description", OLD."quantity", OLD."uom", OLD."needDate", OLD."reason") THEN
      RAISE EXCEPTION 'buying: what request to buy % asks changes only while it is OPEN (it is %)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."approvalTaskId" IS DISTINCT FROM OLD."approvalTaskId" AND NOT (NEW."status" = 'PENDING_APPROVAL' AND OLD."status" <> 'PENDING_APPROVAL') THEN
      RAISE EXCEPTION 'buying: request to buy % names its approval task when it asks its yes, and keeps it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."rejectedAt", NEW."rejectedById", NEW."rejectReason") IS DISTINCT FROM (OLD."rejectedAt", OLD."rejectedById", OLD."rejectReason")
       AND NOT (NEW."status" = 'REJECTED' AND OLD."status" <> 'REJECTED') THEN
      RAISE EXCEPTION 'buying: the refusal of request to buy % is written once, when it is refused', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."convertedAt", NEW."convertedById", NEW."purchaseOrderLineId") IS DISTINCT FROM (OLD."convertedAt", OLD."convertedById", OLD."purchaseOrderLineId")
       AND NOT (NEW."status" = 'CONVERTED' AND OLD."status" <> 'CONVERTED') THEN
      RAISE EXCEPTION 'buying: the conversion of request to buy % is written once, when the buyer converts it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."cancelledAt", NEW."cancelReason") IS DISTINCT FROM (OLD."cancelledAt", OLD."cancelReason")
       AND NOT (NEW."status" = 'CANCELLED' AND OLD."status" <> 'CANCELLED') THEN
      RAISE EXCEPTION 'buying: the cancellation of request to buy % is written once, when it is cancelled', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."itemId" IS NULL AND NEW."description" IS NULL) OR (NEW."itemColourId" IS NOT NULL AND NEW."itemId" IS NULL)
     OR NOT "factory_buying_depth_words_ok"(NEW."description", 2000) OR NEW."quantity" <= 0
     OR NEW."reason" IS NULL OR NOT "factory_buying_depth_words_ok"(NEW."reason", 2000) THEN
    RAISE EXCEPTION 'buying: request to buy % names a material (its colour only with it) or says what in words (at most 2000 characters), a quantity above 0 and why (1 to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."source" = 'SHORTAGE' AND (NEW."workOrderId" IS NULL OR NEW."itemId" IS NULL OR NEW."shortage" IS NULL OR jsonb_typeof(NEW."shortage") <> 'object'))
     OR (NEW."source" = 'OFFICE' AND NEW."shortage" IS NOT NULL) THEN
    RAISE EXCEPTION 'buying: request to buy % from a shortage names its work order, its material and the shortage as seen (an object); one asked in the office holds no shortage', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'PENDING_APPROVAL' AND NEW."approvalTaskId" IS NULL)
     OR (NEW."status" = 'REJECTED') <> (NEW."rejectedAt" IS NOT NULL)
     OR (NEW."rejectedAt" IS NULL AND (NEW."rejectedById" IS NOT NULL OR NEW."rejectReason" IS NOT NULL))
     OR (NEW."status" = 'REJECTED' AND (NEW."rejectedById" IS NULL OR NEW."rejectReason" IS NULL OR NOT "factory_buying_depth_words_ok"(NEW."rejectReason", 2000)))
     OR (NEW."status" = 'CONVERTED') <> (NEW."convertedAt" IS NOT NULL)
     OR (NEW."convertedAt" IS NULL AND (NEW."convertedById" IS NOT NULL OR NEW."purchaseOrderLineId" IS NOT NULL))
     OR (NEW."status" = 'CONVERTED' AND (NEW."convertedById" IS NULL OR NEW."purchaseOrderLineId" IS NULL))
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."cancelledAt" IS NULL AND NEW."cancelReason" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED' AND (NEW."cancelReason" IS NULL OR NOT "factory_buying_depth_words_ok"(NEW."cancelReason", 2000))) THEN
    RAISE EXCEPTION 'buying: request to buy % is % with the wrong approval task, refusal, conversion or cancellation (each exactly with its state: when, by whom, why or the line)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."purchaseOrderLineId" IS NOT NULL AND NEW."itemId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."purchaseOrderLineId" IS DISTINCT FROM OLD."purchaseOrderLineId") THEN
    SELECT l."itemId" INTO line_item FROM "PurchaseOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."purchaseOrderLineId";
    IF FOUND AND line_item <> NEW."itemId" THEN
      RAISE EXCEPTION 'buying: request to buy % is converted into a purchase order line of its own material', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PurchaseRequest_guard" BEFORE INSERT OR UPDATE ON "PurchaseRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_purchase_request_guard"();

-- =====================================================================================================================
-- 7. At the workshop: the material balance and the cost (append-only, above)
-- =====================================================================================================================

-- SubcontractConsumption (factory_subcontract_consumption_check, BEFORE INSERT): a row of a SENT kit line (what was sent);
-- its place above every earlier one of the line; DECLARED: each quantity 0 or more, at least one above 0; ADJUSTMENT: at
-- least one not 0, after a declaration of the line, with its reason (words 1 to 2000 characters; a code of 1 to 40
-- characters without spaces when given); reported not in the future. Over every row of the kit line (under a lock per line)
-- used, returned and scrapped each stay 0 or more and together never pass the quantity sent.
CREATE FUNCTION "factory_subcontract_consumption_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_status text;
  sent numeric;
  last_seq integer;
  declared integer;
  used numeric;
  returned numeric;
  scrapped numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('SubcontractConsumption:' || NEW."kitLineId"::text, 0));
  SELECT k."status"::text, k."quantity" INTO line_status, sent
    FROM "SubcontractKitLine" k WHERE k."tenantId" = NEW."tenantId" AND k."id" = NEW."kitLineId";
  IF NOT FOUND THEN
    -- A kit line the session cannot see (another tenant's): the policies and the foreign key refuse the row.
    RETURN NEW;
  END IF;
  IF line_status <> 'SENT' THEN
    RAISE EXCEPTION 'supply: kit line % is %; its material balance starts once it is SENT', NEW."kitLineId", line_status
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(c."seq"), count(*) FILTER (WHERE c."kind" = 'DECLARED'),
         coalesce(sum(c."usedQuantity"), 0), coalesce(sum(c."returnedQuantity"), 0), coalesce(sum(c."scrappedQuantity"), 0)
    INTO last_seq, declared, used, returned, scrapped
    FROM "SubcontractConsumption" c WHERE c."tenantId" = NEW."tenantId" AND c."kitLineId" = NEW."kitLineId";
  IF NEW."seq" < 1 OR NEW."seq" <= coalesce(last_seq, 0) THEN
    RAISE EXCEPTION 'supply: material balance row % of kit line % takes a place above the line''s last one (%)', NEW."id", NEW."kitLineId", coalesce(last_seq, 0)
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'DECLARED'
     AND (NEW."usedQuantity" < 0 OR NEW."returnedQuantity" < 0 OR NEW."scrappedQuantity" < 0
          OR (NEW."usedQuantity" = 0 AND NEW."returnedQuantity" = 0 AND NEW."scrappedQuantity" = 0)) THEN
    RAISE EXCEPTION 'supply: the workshop''s declaration % holds quantities of 0 or more, at least one above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'ADJUSTMENT'
     AND ((NEW."usedQuantity" = 0 AND NEW."returnedQuantity" = 0 AND NEW."scrappedQuantity" = 0) OR declared = 0 OR NEW."reason" IS NULL) THEN
    RAISE EXCEPTION 'supply: adjustment % of kit line % changes a quantity, comes after the workshop''s declaration and says why', NEW."id", NEW."kitLineId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_buying_depth_words_ok"(NEW."reason", 2000) OR NOT "factory_buying_depth_code_ok"(NEW."reasonCode", 40)
     OR (NEW."reasonCode" IS NOT NULL AND NEW."reason" IS NULL) OR NOT "factory_buying_depth_not_future"(NEW."reportedAt") THEN
    RAISE EXCEPTION 'supply: material balance row % says why in words (at most 2000 characters; a code of at most 40 characters without spaces only with them) and was reported not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  used := used + NEW."usedQuantity";
  returned := returned + NEW."returnedQuantity";
  scrapped := scrapped + NEW."scrappedQuantity";
  IF used < 0 OR returned < 0 OR scrapped < 0 OR used + returned + scrapped > sent THEN
    RAISE EXCEPTION 'supply: kit line % sent %; used % + returned % + scrapped % would pass it or go below 0', NEW."kitLineId", sent, used, returned, scrapped
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SubcontractConsumption_check" BEFORE INSERT ON "SubcontractConsumption"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontract_consumption_check"();

-- SubcontractCostEntry (factory_subcontract_cost_entry_check, BEFORE INSERT): of an order that went out (not DRAFT or
-- CANCELLED), in its currency; a FEE names the order's operation, another kind none; a quantity above 0, a price of 0 or
-- more; an entry's amount 0 or more, OTHER with its reason; a reversal takes back an entry of the same order that is no
-- reversal (its kind, operation, quantity, price and currency; the opposite amount; once: the unique key) with its reason;
-- the reason's words at most 2000 characters; incurred not in the future.
CREATE FUNCTION "factory_subcontract_cost_entry_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_status text;
  order_currency text;
  original record;
BEGIN
  SELECT s."status"::text, s."currency" INTO order_status, order_currency
    FROM "SubcontractOrder" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."subcontractOrderId";
  IF NOT FOUND THEN
    -- An order the session cannot see (another tenant's): the policies and the foreign key refuse the row.
    RETURN NEW;
  END IF;
  IF order_status IN ('DRAFT', 'CANCELLED') THEN
    RAISE EXCEPTION 'supply: subcontract order % is %; its work costs nothing yet', NEW."subcontractOrderId", order_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currency" IS DISTINCT FROM order_currency THEN
    RAISE EXCEPTION 'supply: cost entry % is in its order''s currency (%)', NEW."id", order_currency
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'FEE') <> (NEW."subcontractOperationId" IS NOT NULL) OR NEW."quantity" <= 0 OR NEW."unitPrice" < 0 THEN
    RAISE EXCEPTION 'supply: cost entry % is a FEE with its operation (another kind names none), a quantity above 0 and a price of 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_buying_depth_words_ok"(NEW."reason", 2000) OR NOT "factory_buying_depth_not_future"(NEW."occurredAt") THEN
    RAISE EXCEPTION 'supply: cost entry % says why in at most 2000 characters and was incurred not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reversalOfId" IS NULL THEN
    IF NEW."amount" < 0 OR (NEW."kind" = 'OTHER' AND NEW."reason" IS NULL) THEN
      RAISE EXCEPTION 'supply: cost entry % has an amount of 0 or more (a mistake is taken back by a reversal); OTHER says what it is', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT e."kind"::text AS kind, e."subcontractOperationId", e."quantity", e."unitPrice", e."amount", e."currency", e."reversalOfId" INTO original
      FROM "SubcontractCostEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."reversalOfId";
    IF FOUND AND (original."reversalOfId" IS NOT NULL OR original.kind <> NEW."kind"::text
                  OR original."subcontractOperationId" IS DISTINCT FROM NEW."subcontractOperationId"
                  OR original."quantity" <> NEW."quantity" OR original."unitPrice" <> NEW."unitPrice" OR original."currency" <> NEW."currency"
                  OR NEW."amount" <> -original."amount" OR NEW."reason" IS NULL) THEN
      RAISE EXCEPTION 'supply: cost entry % takes back entry % with its kind, operation, quantity, price and currency, the opposite amount and the reason (a reversal is never taken back)', NEW."id", NEW."reversalOfId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SubcontractCostEntry_check" BEFORE INSERT ON "SubcontractCostEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontract_cost_entry_check"();
