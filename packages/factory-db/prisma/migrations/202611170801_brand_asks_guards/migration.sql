-- Written by hand (Prisma does not model triggers), after the generated 202611170800_brand_asks_schema and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- A customer's asks and our answers (production plan, schema wave 4/5, B-PR-23; lead picks L18, L26, R-50, R-65; review fixes
-- R-09, R-14, R-35, R-36; 08-backend §4.2, §4.4, §4.6; wall test PW-12 DB part). apps/factory-api checks all of this first and
-- answers in words (B-PR-24 rules, B-PR-25 the portal's asks, B-PR-26/27a/27b the office's answers, B-PR-29 the new approvals,
-- B-PR-30a/30b decide for a customer and reverse, B-PR-46a bulk asks); these rules are the last word, for every login, the
-- owner included. The refusals are check_violation (SQLSTATE 23514, links' moves a restrict_violation as before); their words
-- name no other customer (the brand wall: "One brand must not be able to see anything related to any other brand").
--
--   OrderChangeRequest     the production asks' own columns: a reason code only on a CANCEL (required) or a HOLD (optional);
--                          the date on a CHANGE, a RUSH (the need-by date of "Urgent – asked") or a SPLIT_SHIPMENT (its first
--                          part's); the address on a CHANGE only; the kind of round exactly on a SAMPLE_ROUND (PRE_PRODUCTION,
--                          SIZE_SET, TOP_OF_PRODUCTION or BRAND) and the round it made only once ACCEPTED (of that kind, for the
--                          request's customer, made after it was asked; named once, as the amendment); a PARTLY_SHIPPED order
--                          may still ask CANCEL (its unshipped lines: the API's), RUSH, HOLD and RESUME; a RESUME only of an
--                          order whose HOLD request was ACCEPTED (whether its holds are still on is the API's: the partner role
--                          reads no hold); the impact shown at Send kept as a JSON object holding no number (never an amount),
--                          up to 8000 characters, never changed; the batch of a bulk ask holds the requests of ONE customer and
--                          ONE kind (asked of every request of the tenant by a SECURITY DEFINER helper that answers yes or no
--                          only), never changed;
--                          the counter-offer: OPEN → COUNTERED by the office only, writing the counter columns and nothing
--                          else: an OPEN COUNTER_OFFER approval request about this request (of its company and customer: the
--                          reference), when (not before it was asked) and by whom (an active office person), and what it offers
--                          (a date not before the day it was countered, a fee of 0 or more, words of 1 to 2000: at least one);
--                          the counter is kept after the answer and never changes; COUNTERED → ACCEPTED (the office, exactly
--                          when the customer said yes to the counter-offer) | REFUSED (the office) | WITHDRAWN (anyone) — never
--                          refused or withdrawn after that yes; answered or withdrawn not before it was countered.
--                          One OPEN or COUNTERED request per order and kind stays the API's (serialised per order, an advisory
--                          lock): a partial unique cannot stand beside the generated isolation tests, whose copy of the first
--                          seeded request is the OPEN one.
--   OrderChangeRequestLine a change asks a different number, or the same number in another colourway of the line's own style
--                          (styleId with colourwayId, both or neither, a change only, not the colourway the line has); a
--                          SPLIT_SHIPMENT's rows are its first part (1 to the pieces before); a SAMPLE_ROUND names one line; a
--                          RUSH, HOLD or RESUME asks for the whole order (no rows).
--   ApprovalRequest        COUNTER_OFFER about an OPEN OrderChangeRequest of its own company and customer, REPROMISE about a
--                          SalesOrder of its own company and customer; decided for the party (Owner answer 11-10 Q3): exactly one
--                          answerer of three (the portal user, the link, the office person who decided for it), that person an
--                          active office person who did not ask it, with why (1 to 1000), never on a CONCESSION, REVISED_ORDER,
--                          SIGNATURE or PROOF; reversed: when (not before the answer), by whom (an active office person) and why
--                          (1 to 1000), all or none, only on an answered request, once, never on those four kinds — the answer
--                          itself never changes; a partner session still only answers (it writes neither).
--   SampleSwatch           a FABRIC swatch of a textile, lining, membrane or padding; a TRIM swatch of a trim, hardware, thread
--                          or label (the material's item kind, a guess on the kinds that 08-backend §4.4 leaves open); asked
--                          with an approval request of its own kind, as before.
--   OrderGate              a SIZE_SET gate names a SIZE_SET round (or none) and passes by it once approved, as PP_SAMPLE by its
--                          PRE_PRODUCTION round; one per order, as every kind but OTHER (the partial unique OrderGate_one_per_kind
--                          already covers it).
--
-- Earlier functions REDEFINED here, each from its current (only) body, word for word but for the lines marked B-PR-23:
--   factory_order_change_request_guard       (…_portal_sales_w2b_guards, W2b wave 21/22; not redefined since)
--   factory_order_change_request_line_guard  (…_portal_sales_w2b_guards; not redefined since): the colourway and the
--                                            production asks' rows (the row names four functions; the colourway needs this one)
--   factory_approval_request_guard           (…_links_depth_w2b_guards, W2b wave 19/22; not redefined since)
--   factory_sample_swatch_guard              (…_changes_samples_w2b_guards, W2b-4 wave 29/33; not redefined since)
--   factory_order_gate_guard                 (…_changes_samples_w2b_guards; not redefined since)
-- Their triggers stay as they are. New helpers: "factory_order_change_request_batch_ok" (SECURITY DEFINER with a fixed search
-- path, the privacy erasure door's pattern; EXECUTE for the runtime roles that write requests) and
-- "factory_order_change_request_impact_ok". USED FROM EARLIER WAVES, as they are: "factory_money_rome_day" (…_money_w2a_guards),
-- "factory_link_pay_record" (…_links_depth_w2b_guards), "factory_changes_words_ok" and "factory_sample_decision_problem"
-- (…_changes_samples_w2b_guards).

-- =====================================================================================================================
-- B-PR-23 helpers.

-- May this request join this batch? A batch holds the requests of one customer and one kind (lead picks L26, R-65). The partner
-- role sees only its own customer's requests, so the question is asked of every request of the tenant here (SECURITY DEFINER,
-- a fixed search path); it answers yes or no, never which customer. The batch is locked for the transaction, so two requests
-- written into one batch at once wait for each other. Another tenant's batch is never read (the scope's tenant, when set).
CREATE FUNCTION "factory_order_change_request_batch_ok"(p_tenant uuid, p_batch uuid, p_party uuid, p_kind text, p_request uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scope_tenant uuid := NULLIF(current_setting('factory.tenant_id', true), '')::uuid;
BEGIN
  IF p_tenant IS NULL OR p_batch IS NULL OR p_party IS NULL OR p_kind IS NULL OR (scope_tenant IS NOT NULL AND scope_tenant <> p_tenant) THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('factory.order-change-request-batch|' || p_batch::text));
  RETURN NOT EXISTS (
    SELECT 1 FROM public."OrderChangeRequest" r
     WHERE r."tenantId" = p_tenant AND r."batchId" = p_batch AND r."id" IS DISTINCT FROM p_request
       AND (r."partyId" <> p_party OR r."kind"::text <> p_kind));
END
$$;
REVOKE ALL ON FUNCTION "factory_order_change_request_batch_ok"(uuid, uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "factory_order_change_request_batch_ok"(uuid, uuid, uuid, text, uuid) TO "factory_partner_runtime", "factory_runtime";

-- The impact shown at Send (B-PR-24's: the frozen fields, priced yes or no, the earliest date), kept as it was shown: a JSON
-- object of words, codes, dates and yes or no, up to 8000 characters, holding no number anywhere (so never an amount: review
-- fix R-09 "the impact never stores an amount").
CREATE FUNCTION "factory_order_change_request_impact_ok"(impact jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT impact IS NULL
      OR (jsonb_typeof(impact) = 'object' AND length(impact::text) <= 8000
          AND NOT jsonb_path_exists(impact, 'lax $.** ? (@.type() == "number")'))
$$;

-- =====================================================================================================================
-- OrderChangeRequest (portal-sales.prisma): REDEFINED from …_portal_sales_w2b_guards (its header there says the rest).
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
    IF OLD."status" = 'COUNTERED' AND NEW."status" <> 'COUNTERED' THEN
      SELECT a."status"::text AS status INTO counter FROM "ApprovalRequest" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."counterApprovalId";
      IF FOUND AND (NEW."status" = 'ACCEPTED') <> (counter.status IN ('APPROVED', 'APPROVED_WITH_CHANGES')) THEN
        RAISE EXCEPTION 'portal: change request % is ACCEPTED exactly when the customer said yes to its counter-offer (it is now %, the counter-offer %)', OLD."id", NEW."status", counter.status
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

-- =====================================================================================================================
-- OrderChangeRequestLine: REDEFINED from …_portal_sales_w2b_guards. Written while its request is OPEN (its row locked FOR
-- SHARE), never changed or removed. A line of the request's own order; the pieces before and asked 0 to 100 000; a cancel
-- asks 0, a change a different number; a size code trimmed, 1 to 40 (null: the line as a whole). Whether the line has that
-- size is the API's. B-PR-23: a change may ask the same number in another colourway of the line's own style; a split
-- shipment's first part ships 1 to the pieces of each cell; a sample round names one line; a rush, a pause or a resume no line.
CREATE OR REPLACE FUNCTION "factory_order_change_request_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_status text;
  request_kind text;
  request_order uuid;
  line_order uuid;
  -- B-PR-23
  line_style uuid;
  line_colourway uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'portal: what change request % asked is never changed or removed', OLD."requestId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r."status"::text, r."kind"::text, r."orderId" INTO request_status, request_kind, request_order
    FROM "OrderChangeRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."requestId" FOR SHARE;
  IF FOUND AND request_status <> 'OPEN' THEN
    RAISE EXCEPTION 'portal: change request % is %; what it asks is written while it is OPEN', NEW."requestId", request_status
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: and the line's style and colourway.
  SELECT l."orderId", l."styleId", l."colourwayId" INTO line_order, line_style, line_colourway
    FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."orderLineId";
  IF request_order IS NOT NULL AND line_order IS NOT NULL AND line_order <> request_order THEN
    RAISE EXCEPTION 'portal: change request % asks for a line of its own order', NEW."requestId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."quantity" < 0 OR NEW."quantity" > 100000 OR NEW."quantityBefore" < 0 OR NEW."quantityBefore" > 100000
     OR (request_kind = 'CANCEL' AND NEW."quantity" <> 0)
     -- B-PR-23: a change asks a different number, or the same number in another colourway.
     OR (request_kind = 'CHANGE' AND NEW."quantity" = NEW."quantityBefore" AND NEW."colourwayId" IS NULL)
     OR (NEW."size" IS NOT NULL AND (btrim(NEW."size") <> NEW."size" OR NEW."size" = '' OR length(NEW."size") > 40)) THEN
    RAISE EXCEPTION 'portal: change request % (%) asks 0 to 100000 pieces, before and asked: a cancel asks 0, a change a different number; a size of 1 to 40 trimmed characters', NEW."requestId", request_kind
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: another colourway only on a change: of the line's own style (the colourway's reference key), both or neither, not
  -- the one the line has.
  IF (NEW."styleId" IS NULL) <> (NEW."colourwayId" IS NULL)
     OR (NEW."colourwayId" IS NOT NULL AND request_kind IS NOT NULL AND request_kind <> 'CHANGE')
     OR (NEW."colourwayId" IS NOT NULL AND line_style IS NOT NULL AND (NEW."styleId" <> line_style OR NEW."colourwayId" = line_colourway)) THEN
    RAISE EXCEPTION 'portal: change request % asks another colourway only on a change: one of the line''s own style (style and colourway, both or neither), not the one the line has', NEW."requestId"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: a rush, a pause or a resume asks for the whole order (no lines); a split shipment's first part ships 1 to the
  -- pieces of each cell; a sample round names one line.
  IF request_kind IN ('RUSH', 'HOLD', 'RESUME')
     OR (request_kind = 'SPLIT_SHIPMENT' AND (NEW."quantity" < 1 OR NEW."quantity" > NEW."quantityBefore"))
     OR (request_kind = 'SAMPLE_ROUND'
         AND EXISTS (SELECT 1 FROM "OrderChangeRequestLine" x WHERE x."tenantId" = NEW."tenantId" AND x."requestId" = NEW."requestId" AND x."id" <> NEW."id")) THEN
    RAISE EXCEPTION 'portal: change request % (%): a rush, a pause or a resume asks for the whole order (no lines), a split shipment''s first part ships 1 to the pieces of each cell, a sample round names one line', NEW."requestId", request_kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- ApprovalRequest (links-depth.prisma): REDEFINED from …_links_depth_w2b_guards (its header there says the rest).
CREATE OR REPLACE FUNCTION "factory_approval_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  answer_columns CONSTANT text[] := ARRAY['status', 'answer', 'typedName', 'markupFileId', 'answeredAt', 'answeredByUserId',
                                          'answeredViaLinkId', 'answerRequestId', 'answerIpHash', 'answerUserAgent', 'version', 'updatedAt'];
  -- B-PR-23: an answered request's reversal, written once; the kinds nobody decides for the party or reverses (the law, or
  -- the consumer's own sign-off).
  reversal_columns CONSTANT text[] := ARRAY['reversedAt', 'reversedById', 'reverseReason', 'version', 'updatedAt'];
  own_word_kinds CONSTANT text[] := ARRAY['CONCESSION', 'REVISED_ORDER', 'SIGNATURE', 'PROOF'];
  answered boolean;
  concession_party uuid;
  concession_status text;
  link_purpose text;
  link_type text;
  link_record uuid;
  link_revoked timestamptz;
  -- B-PR-23
  record_party uuid;
  record_company uuid;
  record_status text;
  user_audience text;
  user_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'links: approval request % is withdrawn, never deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."answeredAt" IS NOT NULL OR NEW."withdrawnAt" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'links: a new approval request is OPEN, unanswered, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    IF "factory_link_pay_record"(NEW."recordType") THEN
      RAISE EXCEPTION 'links: no approval is asked outside on a % (it holds pay figures)', NEW."recordType"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'CONCESSION' THEN
      IF NEW."recordType" <> 'NcrConcession' THEN
        RAISE EXCEPTION 'links: a CONCESSION request names an NCR''s concession (record type NcrConcession), not a %', NEW."recordType"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT c."partyId", c."status"::text INTO concession_party, concession_status
        FROM "NcrConcession" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."recordId";
      IF FOUND AND (concession_party <> NEW."partyId" OR concession_status <> 'ASKED') THEN
        RAISE EXCEPTION 'links: request % asks concession % of its own customer, while the concession is ASKED', NEW."id", NEW."recordId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    -- B-PR-23: a COUNTER_OFFER counters an OPEN change request of its own company and customer.
    IF NEW."kind" = 'COUNTER_OFFER' THEN
      IF NEW."recordType" <> 'OrderChangeRequest' THEN
        RAISE EXCEPTION 'links: a COUNTER_OFFER request names a change request (record type OrderChangeRequest), not a %', NEW."recordType"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."partyId", r."companyId", r."status"::text INTO record_party, record_company, record_status
        FROM "OrderChangeRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
      IF FOUND AND (record_party <> NEW."partyId" OR record_company <> NEW."companyId" OR record_status <> 'OPEN') THEN
        RAISE EXCEPTION 'links: request % counters change request % of its own company and customer, while it is OPEN', NEW."id", NEW."recordId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    -- B-PR-23: a REPROMISE asks about a sales order of its own company and customer (the date stands either way).
    IF NEW."kind" = 'REPROMISE' THEN
      IF NEW."recordType" <> 'SalesOrder' THEN
        RAISE EXCEPTION 'links: a REPROMISE request names a sales order (record type SalesOrder), not a %', NEW."recordType"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT o."partyId", o."companyId" INTO record_party, record_company
        FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."recordId";
      IF FOUND AND (record_party <> NEW."partyId" OR record_company <> NEW."companyId") THEN
        RAISE EXCEPTION 'links: request % asks about sales order % of its own company and customer', NEW."id", NEW."recordId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."recordType", NEW."recordId", NEW."partyId", NEW."kind", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."recordType", OLD."recordId", OLD."partyId", OLD."kind", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'links: the record, party, kind and asking of approval request % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept)
       -- B-PR-23: but an answered one may be reversed, once (its reversal columns only).
       AND NOT (OLD."status" IN ('APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED') AND OLD."reversedAt" IS NULL AND NEW."reversedAt" IS NOT NULL
                AND (to_jsonb(NEW) - (kept || reversal_columns)) IS NOT DISTINCT FROM (to_jsonb(OLD) - (kept || reversal_columns))) THEN
      RAISE EXCEPTION 'links: approval request % is %; it never changes again (an answered one may be reversed, once)', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'links: the version of approval request % goes up by one', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" = 'EXPIRED' AND OLD."status" = 'OPEN' AND now() < NEW."dueAt" THEN
      RAISE EXCEPTION 'links: approval request % is due at %; it expires only after that', OLD."id", NEW."dueAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND (NEW."status" NOT IN ('APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED')
            OR (to_jsonb(NEW) - (kept || answer_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer_columns))) THEN
      RAISE EXCEPTION 'links: a partner session only answers its OPEN approval request (request %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."question") = '' OR length(NEW."question") > 4000 THEN
    RAISE EXCEPTION 'links: approval request % asks its question in words, up to 4000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."dueAt" <= NEW."createdAt" THEN
    RAISE EXCEPTION 'links: approval request % is due after it was made', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  answered := NEW."status" IN ('APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED');
  IF answered <> (NEW."answeredAt" IS NOT NULL)
     OR answered <> (btrim(coalesce(NEW."typedName", '')) <> '')
     OR answered <> (btrim(coalesce(NEW."answerRequestId", '')) <> '')
     -- B-PR-23: exactly one answerer of three when answered (the portal user, the link, the office person who decided for
     -- the party), none otherwise.
     OR num_nonnulls(NEW."answeredByUserId", NEW."answeredViaLinkId", NEW."decidedForPartyById") <> answered::integer
     OR (NOT answered AND (NEW."answer" IS NOT NULL OR NEW."markupFileId" IS NOT NULL OR NEW."answerIpHash" IS NOT NULL OR NEW."answerUserAgent" IS NOT NULL))
     OR (NEW."status" IN ('APPROVED_WITH_CHANGES', 'REFUSED') AND btrim(coalesce(NEW."answer", '')) = '')
     OR (answered AND NEW."answeredAt" < NEW."createdAt")
     OR length(NEW."typedName") > 200 OR length(NEW."answer") > 4000 OR length(NEW."answerRequestId") > 200 OR length(NEW."answerUserAgent") > 512 THEN
    RAISE EXCEPTION 'links: approval request % is % with the wrong answer: time, typed name, request and one answerer exactly when answered, words for a change or a refusal, nothing of an answer otherwise', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: decided for the party with why (1 to 1000), never by the person who asked it, never on a concession, a revised
  -- order, a signature or a proof (the law, or the consumer's own sign-off).
  IF (NEW."decidedForPartyById" IS NULL) <> (NEW."decidedForPartyReason" IS NULL)
     OR (NEW."decidedForPartyReason" IS NOT NULL AND (btrim(NEW."decidedForPartyReason") = '' OR length(NEW."decidedForPartyReason") > 1000))
     OR NEW."decidedForPartyById" = NEW."createdById"
     OR (NEW."decidedForPartyById" IS NOT NULL AND NEW."kind"::text = ANY (own_word_kinds)) THEN
    RAISE EXCEPTION 'links: approval request % is decided for its party only by someone who did not ask it, with why (up to 1000 characters), and never on a concession, a revised order, a signature or a proof', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: reversed with when, by whom and why (1 to 1000), all or none, only once answered (not before the answer), never
  -- on a concession, a revised order, a signature or a proof.
  IF (NEW."reversedAt" IS NULL) <> (NEW."reversedById" IS NULL) OR (NEW."reversedAt" IS NULL) <> (NEW."reverseReason" IS NULL)
     OR (NEW."reverseReason" IS NOT NULL AND (btrim(NEW."reverseReason") = '' OR length(NEW."reverseReason") > 1000))
     OR (NEW."reversedAt" IS NOT NULL AND (NOT answered OR NEW."reversedAt" < NEW."answeredAt" OR NEW."kind"::text = ANY (own_word_kinds))) THEN
    RAISE EXCEPTION 'links: approval request % is reversed with when, by whom and why (up to 1000 characters), only once answered, and never on a concession, a revised order, a signature or a proof', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL)
     OR (NEW."withdrawnAt" IS NULL AND (NEW."withdrawnById" IS NOT NULL OR NEW."withdrawReason" IS NOT NULL)) THEN
    RAISE EXCEPTION 'links: approval request % is % with the wrong withdrawal: its time exactly when WITHDRAWN', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF answered AND (TG_OP = 'INSERT' OR OLD."status" = 'OPEN') THEN
    IF NEW."answeredViaLinkId" IS NOT NULL THEN
      SELECT l."purpose"::text, l."recordType", l."recordId", l."revokedAt" INTO link_purpose, link_type, link_record, link_revoked
        FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."partyId" = NEW."partyId" AND l."id" = NEW."answeredViaLinkId";
      IF FOUND AND (link_purpose <> 'APPROVAL' OR link_revoked IS NOT NULL
                    OR NOT ((link_type = 'ApprovalRequest' AND link_record = NEW."id") OR (link_type = NEW."recordType" AND link_record = NEW."recordId"))) THEN
        RAISE EXCEPTION 'links: approval request % is answered through an APPROVAL link of it or of its record, not revoked', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."markupFileId" IS NOT NULL
       AND EXISTS (SELECT 1 FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."markupFileId"
                    AND (f."recordType" <> 'ApprovalRequest' OR f."recordId" <> NEW."id")) THEN
      RAISE EXCEPTION 'links: the markup of approval request % is a file of the request (record type ApprovalRequest)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-PR-23: the person who decides for the party is an active office person.
    IF NEW."decidedForPartyById" IS NOT NULL THEN
      SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."decidedForPartyById";
      IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
        RAISE EXCEPTION 'links: approval request % is decided for its party by an active office person', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  -- B-PR-23: the person who reverses an answer is an active office person.
  IF NEW."reversedById" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."reversedById" IS NULL) THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."reversedById";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'links: the answer of approval request % is reversed by an active office person', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- SampleSwatch (SAL-314): REDEFINED from …_changes_samples_w2b_guards (its header there says the rest).
CREATE OR REPLACE FUNCTION "factory_sample_swatch_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  after_decision CONSTANT text[] := ARRAY['tenantId', 'note', 'version', 'updatedAt'];
  problem text;
  material_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."sentAt" IS NOT NULL THEN
      RAISE EXCEPTION 'samples: swatch % was sent; it is kept', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."styleId", NEW."roundId", NEW."partyId", NEW."kind", NEW."itemId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."styleId", OLD."roundId", OLD."partyId", OLD."kind", OLD."itemId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'samples: the style, round, brand, kind, material and creation of swatch % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."sentAt" IS NOT NULL AND (NEW."sentAt", NEW."itemColourId", NEW."lotSiteId", NEW."lotId") IS DISTINCT FROM (OLD."sentAt", OLD."itemColourId", OLD."lotSiteId", OLD."lotId") THEN
      RAISE EXCEPTION 'samples: swatch % was sent; what was sent and when never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."decision" IS NOT NULL AND (to_jsonb(NEW) - after_decision) IS DISTINCT FROM (to_jsonb(OLD) - after_decision) THEN
      RAISE EXCEPTION 'samples: swatch % is decided; only its note changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."itemColourId" IS NULL AND NEW."lotId" IS NULL) OR (NEW."lotSiteId" IS NULL) <> (NEW."lotId" IS NULL)
     OR NOT "factory_changes_words_ok"(NEW."note", 500, true) THEN
    RAISE EXCEPTION 'samples: swatch % is of a colour and/or a lot (with its site) of its material, with a note up to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sentAt" IS NULL AND (NEW."approvalRequestId" IS NOT NULL OR NEW."decision" IS NOT NULL) THEN
    RAISE EXCEPTION 'samples: swatch % is asked and decided once it is sent', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: FABRIC and TRIM read their material's kind too.
  IF TG_OP = 'INSERT' AND NEW."kind" IN ('LEATHER', 'FABRIC', 'TRIM') THEN
    SELECT i."kind"::text INTO material_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND NEW."kind" = 'LEATHER' AND material_kind <> 'LEATHER' THEN
      RAISE EXCEPTION 'samples: a LEATHER swatch (%) is of a leather material, not of a %', NEW."id", material_kind
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-PR-23: a FABRIC swatch of a textile, lining, membrane or padding; a TRIM swatch of a trim, hardware, thread or label.
    IF FOUND AND NEW."kind" = 'FABRIC' AND material_kind NOT IN ('TEXTILE', 'LINING', 'MEMBRANE', 'PADDING') THEN
      RAISE EXCEPTION 'samples: a FABRIC swatch (%) is of a textile, lining, membrane or padding, not of a %', NEW."id", material_kind
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND NEW."kind" = 'TRIM' AND material_kind NOT IN ('TRIM', 'HARDWARE', 'THREAD', 'LABEL') THEN
      RAISE EXCEPTION 'samples: a TRIM swatch (%) is of a trim, hardware, thread or label, not of a %', NEW."id", material_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT'
     OR (NEW."approvalRequestId", NEW."decision", NEW."decisionComments", NEW."decidedAt", NEW."decidedVia", NEW."decidedById")
        IS DISTINCT FROM (OLD."approvalRequestId", OLD."decision", OLD."decisionComments", OLD."decidedAt", OLD."decidedVia", OLD."decidedById") THEN
    problem := "factory_sample_decision_problem"(NEW."tenantId", 'SampleSwatch', NEW."id", NEW."kind"::text, NEW."approvalRequestId", NEW."decision"::text,
      NEW."decisionComments", NEW."decidedAt", NEW."decidedVia"::text, NEW."decidedById");
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'samples: swatch % is wrong in its decision: %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- OrderGate (PLN-186): REDEFINED from …_changes_samples_w2b_guards (its header there says the rest).
CREATE OR REPLACE FUNCTION "factory_order_gate_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  round record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."passedAt" IS NOT NULL OR OLD."overriddenAt" IS NOT NULL THEN
      RAISE EXCEPTION 'planning: gate % was passed or started before; it is kept', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."salesOrderId", NEW."kind", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."salesOrderId", OLD."kind", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'planning: the order, kind and creation of gate % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."passedAt" IS NOT NULL AND (NEW."passedAt", NEW."passedById") IS DISTINCT FROM (OLD."passedAt", OLD."passedById"))
       OR (OLD."overriddenAt" IS NOT NULL AND (NEW."overriddenAt", NEW."overriddenById", NEW."overrideReason") IS DISTINCT FROM (OLD."overriddenAt", OLD."overriddenById", OLD."overrideReason")) THEN
      RAISE EXCEPTION 'planning: gate % is passed, and started before, each once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."kind" = 'OTHER' AND NEW."label" IS NULL) OR NOT "factory_changes_words_ok"(NEW."label", 200, false) THEN
    RAISE EXCEPTION 'planning: gate % says what it is (up to 200 characters; required for OTHER)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: a SIZE_SET gate names its size set round too.
  IF NEW."sampleRoundId" IS NOT NULL AND NEW."kind" NOT IN ('SAMPLE_APPROVED', 'PP_SAMPLE', 'SIZE_SET') THEN
    RAISE EXCEPTION 'planning: only a sample gate (SAMPLE_APPROVED, PP_SAMPLE, SIZE_SET) names a sample round (gate %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."passedAt" IS NULL) <> (NEW."passedById" IS NULL)
     OR (NEW."overriddenAt" IS NULL) <> (NEW."overriddenById" IS NULL) OR (NEW."overriddenAt" IS NULL) <> (NEW."overrideReason" IS NULL)
     OR NOT "factory_changes_words_ok"(NEW."overrideReason", 1000, true) THEN
    RAISE EXCEPTION 'planning: gate % is passed with when and by whom, and started before with when, by whom and why (up to 1000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."overriddenById" = NEW."ownerId" OR NEW."overriddenById" = NEW."createdById" THEN
    RAISE EXCEPTION 'planning: the order of gate % starts before it only by the word of someone who is neither its owner nor its maker', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sampleRoundId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."sampleRoundId" IS DISTINCT FROM OLD."sampleRoundId" OR NEW."passedAt" IS DISTINCT FROM OLD."passedAt") THEN
    SELECT r."kind"::text AS kind, r."decision"::text AS decision INTO round
      FROM "SampleRound" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."sampleRoundId";
    IF FOUND AND NEW."kind" = 'PP_SAMPLE' AND round.kind <> 'PRE_PRODUCTION' THEN
      RAISE EXCEPTION 'planning: gate % waits for a PRE_PRODUCTION round, not a % one', NEW."id", round.kind
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-PR-23: a SIZE_SET gate waits for a SIZE_SET round.
    IF FOUND AND NEW."kind" = 'SIZE_SET' AND round.kind <> 'SIZE_SET' THEN
      RAISE EXCEPTION 'planning: gate % waits for a SIZE_SET round, not a % one', NEW."id", round.kind
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND NEW."passedAt" IS NOT NULL AND round.decision IS DISTINCT FROM 'APPROVED' AND round.decision IS DISTINCT FROM 'APPROVED_WITH_COMMENTS' THEN
      RAISE EXCEPTION 'planning: gate % passes once its sample round is approved (it is %)', NEW."id", coalesce(round.decision, 'not decided')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
