-- Written by hand (B-PR-40, EXTRA 2; no schema folder of its own), after 202611180002_production_wave5_samples_guards and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Putting back a customer's yes to our counter-offer (production plan, schema wave 5/5, B-PR-40 EXTRA 2 for B-PR-30b; lead
-- decision from build/notes pr3g "Guard line"; plan §3 "decide for a brand or undo, always with a reason it reads"): the office
-- may put back the customer's answer to a COUNTER_OFFER approval request (platform/approvals-out reverse) while the change
-- request it countered was not carried out yet (still COUNTERED). For every login, the owner included. The refusals are
-- check_violation (SQLSTATE 23514); their words name no other customer.
--
--   OrderChangeRequest  a COUNTERED request is ACCEPTED exactly when the customer said yes to the counter-offer AND that yes was
--                       not put back (the counter's approval request names no reversal); a yes put back is no yes: the request
--                       is then refused by the office (or withdrawn), never accepted. Every other rule as it was (B-PR-23).
--
-- Earlier function REDEFINED here, from its current body (…_brand_asks_guards, B-PR-23), word for word but for the lines marked
-- B-PR-40: factory_order_change_request_guard. Its trigger stays as it is. USED FROM EARLIER WAVES, as they are:
-- "factory_money_rome_day" (…_money_w2a_guards), "factory_order_change_request_batch_ok" and
-- "factory_order_change_request_impact_ok" (…_brand_asks_guards).

-- =====================================================================================================================
-- OrderChangeRequest (portal-sales.prisma): REDEFINED from …_brand_asks_guards (its header and …_portal_sales_w2b_guards' say
-- the rest).
CREATE OR REPLACE FUNCTION "factory_order_change_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  partner CONSTANT boolean := current_user = 'factory_partner_runtime';
  kept CONSTANT text[] := ARRAY['tenantId'];
  -- B-PR-23: an acceptance may also name the sample round it made (a SAMPLE_ROUND).
  answer_columns CONSTANT text[] := ARRAY['status', 'answer', 'answeredAt', 'answeredById', 'amendmentId', 'sampleRoundId', 'version', 'updatedAt'];
  withdraw_columns CONSTANT text[] := ARRAY['status', 'withdrawnAt', 'version', 'updatedAt'];
  -- B-PR-23: what an accepted request may still name, each once: its amendment, the sample round it made.
  amendment_columns CONSTANT text[] := ARRAY['amendmentId', 'sampleRoundId', 'version', 'updatedAt'];
  -- B-PR-23: the counter-offer, written once (OPEN → COUNTERED).
  counter_columns CONSTANT text[] := ARRAY['status', 'counterApprovalId', 'counteredAt', 'counteredById', 'counterDate', 'counterFee', 'counterNote', 'version', 'updatedAt'];
  answered boolean;
  order_status text;
  address_kinds text[];
  address_status text;
  amendment_made timestamptz;
  -- B-PR-23
  countered boolean;
  counter record;
  round record;
  user_audience text;
  user_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal: change request % is answered or withdrawn, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."answer" IS NOT NULL OR NEW."answeredAt" IS NOT NULL OR NEW."answeredById" IS NOT NULL
       OR NEW."amendmentId" IS NOT NULL OR NEW."withdrawnAt" IS NOT NULL OR NEW."version" <> 1
       -- B-PR-23: not countered, no sample round made yet.
       OR NEW."counterApprovalId" IS NOT NULL OR NEW."counteredAt" IS NOT NULL OR NEW."counteredById" IS NOT NULL OR NEW."sampleRoundId" IS NOT NULL THEN
      RAISE EXCEPTION 'portal: a new change request is OPEN, unanswered, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT o."status"::text INTO order_status FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."orderId";
    -- B-PR-23: a PARTLY_SHIPPED order may still ask to cancel (its unshipped lines), rush, pause and resume (review fix R-35).
    IF FOUND AND order_status NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY')
       AND NOT (order_status = 'PARTLY_SHIPPED' AND NEW."kind" IN ('CANCEL', 'RUSH', 'HOLD', 'RESUME')) THEN
      RAISE EXCEPTION 'portal: order % is %; a change or a cancel is asked only while it is CONFIRMED, IN_PRODUCTION or READY (a PARTLY_SHIPPED order: a cancel, a rush, a pause or a resume)', NEW."orderId", order_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."requestedDate" < "factory_money_rome_day"(NEW."createdAt") THEN
      RAISE EXCEPTION 'portal: change request % asks for %, a day already past when it was asked', NEW."id", NEW."requestedDate"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-PR-23: a RESUME only of an order whose pause was accepted (an ACCEPTED HOLD request; whether its holds are still on is
    -- the API's: the partner role reads no hold).
    IF NEW."kind" = 'RESUME'
       AND NOT EXISTS (SELECT 1 FROM "OrderChangeRequest" r
                        WHERE r."tenantId" = NEW."tenantId" AND r."orderId" = NEW."orderId" AND r."kind" = 'HOLD' AND r."status" = 'ACCEPTED') THEN
      RAISE EXCEPTION 'portal: change request % asks to resume order %, whose pause was never accepted', NEW."id", NEW."orderId"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-PR-23: a batch holds the requests of one customer and one kind (the words name no other customer).
    IF NEW."batchId" IS NOT NULL
       AND NOT "factory_order_change_request_batch_ok"(NEW."tenantId", NEW."batchId", NEW."partyId", NEW."kind"::text, NEW."id") THEN
      RAISE EXCEPTION 'portal: change request % cannot join batch %: a batch holds the requests of one customer and one kind', NEW."id", NEW."batchId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."orderId", NEW."kind", NEW."reasonCode", NEW."reason", NEW."requestedDate", NEW."shipToAddressId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."orderId", OLD."kind", OLD."reasonCode", OLD."reason", OLD."requestedDate", OLD."shipToAddressId", OLD."createdAt", OLD."createdById")
       -- B-PR-23: nor the impact shown, the kind of round asked and the batch.
       OR (NEW."impact", NEW."sampleKind", NEW."batchId") IS DISTINCT FROM (OLD."impact", OLD."sampleKind", OLD."batchId") THEN
      RAISE EXCEPTION 'portal: the order, kind, ask and creation of change request % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'portal: the version of change request % goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-PR-23: a COUNTERED request waits, as an OPEN one does.
    IF OLD."status" NOT IN ('OPEN', 'COUNTERED') THEN
      IF partner OR OLD."status" <> 'ACCEPTED'
         -- B-PR-23: its amendment, or the sample round it made, each named once.
         OR NOT ((OLD."amendmentId" IS NULL AND NEW."amendmentId" IS NOT NULL) OR (OLD."sampleRoundId" IS NULL AND NEW."sampleRoundId" IS NOT NULL))
         OR (OLD."amendmentId" IS NOT NULL AND NEW."amendmentId" IS DISTINCT FROM OLD."amendmentId")
         OR (OLD."sampleRoundId" IS NOT NULL AND NEW."sampleRoundId" IS DISTINCT FROM OLD."sampleRoundId")
         OR (to_jsonb(NEW) - (kept || amendment_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || amendment_columns)) THEN
        RAISE EXCEPTION 'portal: change request % is %; it never changes again (an accepted one names its amendment, or the sample round it made, once)', OLD."id", OLD."status"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."status" IN ('ACCEPTED', 'REFUSED') THEN
      IF partner THEN
        RAISE EXCEPTION 'portal: the office answers change request %, not the customer', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (to_jsonb(NEW) - (kept || answer_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer_columns)) THEN
        RAISE EXCEPTION 'portal: answering change request % changes only %', OLD."id", array_to_string(answer_columns, ', ')
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."status" = 'WITHDRAWN' THEN
      IF (to_jsonb(NEW) - (kept || withdraw_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || withdraw_columns)) THEN
        RAISE EXCEPTION 'portal: withdrawing change request % changes only %', OLD."id", array_to_string(withdraw_columns, ', ')
          USING ERRCODE = 'check_violation';
      END IF;
    -- B-PR-23: the office counters an OPEN request, once.
    ELSIF NEW."status" = 'COUNTERED' AND OLD."status" = 'OPEN' THEN
      IF partner THEN
        RAISE EXCEPTION 'portal: the office counters change request %, not the customer', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (to_jsonb(NEW) - (kept || counter_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || counter_columns)) THEN
        RAISE EXCEPTION 'portal: countering change request % changes only %', OLD."id", array_to_string(counter_columns, ', ')
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      -- B-PR-23: … or its counter-offer (a COUNTERED request: by its answer or its withdrawal).
      RAISE EXCEPTION 'portal: an OPEN change request (%) changes only by its answer or its withdrawal, or by our counter-offer (a COUNTERED one by its answer or its withdrawal)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-PR-23: a COUNTERED request is ACCEPTED exactly when the customer said yes to the counter-offer: never refused or
    -- withdrawn after that yes.
    -- B-PR-40: … while that yes stands: once we put it back (the counter's answer reversed, B-PR-30b) it is no yes any more,
    -- and the request is refused (or withdrawn), never accepted.
    IF OLD."status" = 'COUNTERED' AND NEW."status" <> 'COUNTERED' THEN
      SELECT a."status"::text AS status, a."reversedAt" AS reversed_at INTO counter FROM "ApprovalRequest" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."counterApprovalId"; -- B-PR-40: + reversedAt
      IF FOUND AND (NEW."status" = 'ACCEPTED') <> (counter.status IN ('APPROVED', 'APPROVED_WITH_CHANGES') AND counter.reversed_at IS NULL) THEN -- B-PR-40: a yes put back is no yes
        RAISE EXCEPTION 'portal: change request % is ACCEPTED exactly when the customer said yes to its counter-offer, a yes we did not put back (it is now %, the counter-offer %)', OLD."id", NEW."status", counter.status || CASE WHEN counter.reversed_at IS NOT NULL THEN ', put back' ELSE '' END
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF (NEW."kind" = 'CANCEL' AND (NEW."reasonCode" IS NULL OR NEW."requestedDate" IS NOT NULL OR NEW."shipToAddressId" IS NOT NULL))
     OR (NEW."kind" = 'CHANGE' AND NEW."reasonCode" IS NOT NULL)
     OR NEW."reasonCode" !~ '^[A-Z][A-Z0-9_]{0,39}$'
     OR (NEW."reason" IS NOT NULL AND (btrim(NEW."reason") = '' OR length(NEW."reason") > 2000)) THEN
    RAISE EXCEPTION 'portal: change request % (%): a cancel gives a code of the CANCEL reason list and asks no date or address, a change has no reason code; their words up to 2000', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: the production asks' own columns: a code only on a cancel (required, above) or a pause (optional); the date on a
  -- change, a rush (the need-by date) or a split shipment (its first part's); the address on a change only; the kind of round
  -- exactly on a sample round, one of the four a customer asks; the round it made only on an ACCEPTED sample round.
  IF (NEW."kind" IN ('RUSH', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND') AND NEW."reasonCode" IS NOT NULL)
     OR (NEW."kind" NOT IN ('CHANGE', 'RUSH', 'SPLIT_SHIPMENT') AND NEW."requestedDate" IS NOT NULL)
     OR (NEW."kind" <> 'CHANGE' AND NEW."shipToAddressId" IS NOT NULL)
     OR (NEW."kind" = 'SAMPLE_ROUND') <> (NEW."sampleKind" IS NOT NULL)
     OR NEW."sampleKind"::text NOT IN ('PRE_PRODUCTION', 'SIZE_SET', 'TOP_OF_PRODUCTION', 'BRAND')
     OR (NEW."sampleRoundId" IS NOT NULL AND (NEW."kind" <> 'SAMPLE_ROUND' OR NEW."status" <> 'ACCEPTED')) THEN
    RAISE EXCEPTION 'portal: change request % (%): a code only on a cancel or a pause, a date only on a change, a rush or a split shipment, an address only on a change, the kind of round (pre-production, size set, top of production or the brand''s) exactly on a sample round, the round it made only once accepted', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: the impact shown at Send holds no number (never an amount).
  IF NOT "factory_order_change_request_impact_ok"(NEW."impact") THEN
    RAISE EXCEPTION 'portal: change request % keeps the impact shown at Send as a JSON object of words, codes, dates and yes or no, up to 8000 characters: no number in it, so never an amount', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: the counter-offer: its approval, when and by whom, all or none; COUNTERED always with it, an OPEN request never;
  -- what it offers (a date, a fee, words: at least one) only with it; the fee 0 or more; its words 1 to 2000; its date not
  -- before the day it was countered (Rome); countered not before it was asked, answered or withdrawn not before it was
  -- countered.
  countered := NEW."counterApprovalId" IS NOT NULL;
  IF countered <> (NEW."counteredAt" IS NOT NULL) OR countered <> (NEW."counteredById" IS NOT NULL)
     OR (NEW."status" = 'COUNTERED' AND NOT countered) OR (NEW."status" = 'OPEN' AND countered)
     OR (NOT countered AND (NEW."counterDate" IS NOT NULL OR NEW."counterFee" IS NOT NULL OR NEW."counterNote" IS NOT NULL))
     OR (countered AND NEW."counterDate" IS NULL AND NEW."counterFee" IS NULL AND NEW."counterNote" IS NULL)
     OR NEW."counterFee" < 0
     OR (NEW."counterNote" IS NOT NULL AND (btrim(NEW."counterNote") = '' OR length(NEW."counterNote") > 2000))
     OR NEW."counterDate" < "factory_money_rome_day"(NEW."counteredAt")
     OR NEW."counteredAt" < NEW."createdAt" OR NEW."answeredAt" < NEW."counteredAt" OR NEW."withdrawnAt" < NEW."counteredAt" THEN
    RAISE EXCEPTION 'portal: change request % is % with the wrong counter-offer: its approval request, when and by whom exactly when countered (always when COUNTERED), with a date, a fee of 0 or more or words up to 2000 (at least one), the date not before the day it was countered', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF countered AND (TG_OP = 'INSERT' OR OLD."counterApprovalId" IS NULL) THEN
    SELECT a."kind"::text AS kind, a."recordType" AS record_type, a."recordId" AS record_id, a."companyId" AS company_id, a."status"::text AS status
      INTO counter FROM "ApprovalRequest" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."counterApprovalId";
    IF FOUND AND (counter.kind <> 'COUNTER_OFFER' OR counter.record_type <> 'OrderChangeRequest' OR counter.record_id <> NEW."id"
                  OR counter.company_id <> NEW."companyId" OR counter.status <> 'OPEN') THEN
      RAISE EXCEPTION 'portal: change request % is countered by an OPEN COUNTER_OFFER approval request about it, of its own company and customer', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."counteredById";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'portal: change request % is countered by an active office person', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- B-PR-23: the round an accepted sample round ask made: of the kind asked, for the request's customer, made after it was asked.
  IF NEW."sampleRoundId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."sampleRoundId" IS NULL) THEN
    SELECT r."kind"::text AS kind, r."partyId" AS party_id, r."createdAt" AS created_at INTO round
      FROM "SampleRound" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."sampleRoundId";
    IF FOUND AND (round.kind IS DISTINCT FROM NEW."sampleKind"::text OR round.party_id IS DISTINCT FROM NEW."partyId" OR round.created_at < NEW."createdAt") THEN
      RAISE EXCEPTION 'portal: change request % names the sample round it made: of the kind asked, for its own customer, made after it was asked', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  answered := NEW."status" IN ('ACCEPTED', 'REFUSED');
  IF answered <> (NEW."answeredAt" IS NOT NULL) OR answered <> (NEW."answeredById" IS NOT NULL) OR NEW."answeredAt" < NEW."createdAt"
     OR (NOT answered AND NEW."answer" IS NOT NULL)
     OR (NEW."status" = 'REFUSED' AND btrim(coalesce(NEW."answer", '')) = '')
     OR (NEW."answer" IS NOT NULL AND (btrim(NEW."answer") = '' OR length(NEW."answer") > 2000))
     OR (NEW."amendmentId" IS NOT NULL AND NEW."status" <> 'ACCEPTED') THEN
    RAISE EXCEPTION 'portal: change request % is %: the answer (when, who) exactly when ACCEPTED or REFUSED, words to refuse (up to 2000), an amendment only when ACCEPTED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL) OR NEW."withdrawnAt" < NEW."createdAt" THEN
    RAISE EXCEPTION 'portal: change request % is %: withdrawn (when) exactly when WITHDRAWN', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."shipToAddressId" IS NOT NULL AND TG_OP = 'INSERT' THEN
    SELECT a."kinds"::text[], a."status"::text INTO address_kinds, address_status
      FROM "PartyAddress" a WHERE a."tenantId" = NEW."tenantId" AND a."partyId" = NEW."partyId" AND a."id" = NEW."shipToAddressId";
    IF FOUND AND (NOT ('SHIP_TO' = ANY (address_kinds)) OR address_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'portal: change request % asks for one of the customer''s SHIP_TO addresses, not archived', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."amendmentId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."amendmentId" IS NULL) THEN
    SELECT m."createdAt" INTO amendment_made FROM "SalesOrderAmendment" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."amendmentId";
    IF FOUND AND amendment_made < NEW."createdAt" THEN
      RAISE EXCEPTION 'portal: change request % names an amendment made after it was asked', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
