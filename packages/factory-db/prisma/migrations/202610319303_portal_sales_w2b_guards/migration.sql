-- Written by hand (Prisma does not model triggers), after the generated 202610319302_portal_sales_w2b_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- W2b schema wave 21/22 (B-W2b-157): the customer portal (features SAL-072, SAL-073, SAL-074, SAL-077, SAL-078, SAL-096,
-- SAL-286, FIN-118, FIN-123; design 02 portal-links: portal.customer.neworder, portal.customer.orders, links.measure,
-- links.pay). A customer's order request (a draft kept with us, then sent with its number; the office makes the order or
-- a quote from it, or refuses it in words), its change and cancel requests on a confirmed order (the office answers; an
-- accepted change names its amendment), card and SEPA payment intents at the provider (no card data in our database),
-- the measurements a rider sends through a MEASUREMENTS link (a new MeasurementProfile revision with the notice shown and
-- three photos, whose deletion date the office sets later), and the cut-off rules of the sales settings.
--
-- apps/factory-api checks all of this first, in words; these rules hold for every login, the owner included. Every
-- refusal is a check_violation, so its words survive a Prisma model call. The guards are AFTER triggers: for the runtime
-- roles the row-level-security policies speak first (a row moved to another tenant or party fails their WITH CHECK), then
-- the guard holds for every login. A rule that reads another row reads only what the role that fires it may read (the
-- partner role: its own party's orders, order lines, addresses, links and files; never a table it has no grant on), and
-- skips a row this session cannot see. An UPDATE that changes nothing passes.
--
-- No earlier function is redefined: the new tables have their own functions, and MeasurementProfile and SalesSettings get
-- triggers of their own beside their existing ones.

CREATE FUNCTION "factory_portal_sales_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'portal: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['PortalOrderRequest', 'PortalOrderRequestLine', 'PortalOrderRequestSize', 'OrderChangeRequest', 'OrderChangeRequestLine', 'PaymentIntent'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_portal_sales_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- What the payment provider writes into our rows (its own ids, its reason codes): letters, digits, "_" and "-", up to 255,
-- never a run of twelve digits or more, so no card number can be kept in them (FIN-123). Null passes.
CREATE FUNCTION "factory_payment_provider_text_ok"(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NULL OR (value ~ '^[A-Za-z0-9_-]{1,255}$' AND value !~ '[0-9]{12}')
$$;

-- =====================================================================================================================
-- PortalOrderRequest (portal-sales.prisma).
--   INSERT    a DRAFT: no number, unsent, undecided, at version 1.
--   UPDATE    the company, the customer and the creation never change; the version goes up by one at most.
--             DRAFT → DRAFT    only the customer (a partner session) edits its draft's header: the way, its reference,
--                              the address, the date, the note, the currency.
--             DRAFT → SENT     the number, when and who sent it (the customer may edit the header in the same write; the
--                              office, sending for the portal with the number it allocated, only sends); at least one
--                              line, every line with its pieces; a date asked not before the day it is sent (Rome).
--             SENT → ACCEPTED  the office only: the order or quote it became (exactly one; a quote of its own company),
--                              when and who decided.
--             SENT → REFUSED   the office only: its words, when and who.
--             SENT → WITHDRAWN when; nothing else.
--             A decided or withdrawn request never changes again.
--   DELETE    a DRAFT only (the customer discards it; it has no number).
--   Every row: the shapes (an ISO currency, trimmed words in their limits); each state's columns exactly; the delivery
--   address, when chosen or changed, one of the customer's SHIP_TO addresses, not archived.
CREATE FUNCTION "factory_portal_order_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  partner CONSTANT boolean := current_user = 'factory_partner_runtime';
  kept CONSTANT text[] := ARRAY['tenantId'];
  draft_columns CONSTANT text[] := ARRAY['source', 'customerRef', 'shipToAddressId', 'requestedDate', 'note', 'currency', 'version', 'updatedAt'];
  send_columns CONSTANT text[] := ARRAY['status', 'number', 'sentAt', 'sentById', 'version', 'updatedAt'];
  decide_columns CONSTANT text[] := ARRAY['status', 'decidedAt', 'decidedById', 'refuseReason', 'salesOrderId', 'quoteId', 'version', 'updatedAt'];
  withdraw_columns CONSTANT text[] := ARRAY['status', 'withdrawnAt', 'version', 'updatedAt'];
  allowed text[];
  sent boolean;
  decided boolean;
  address_kinds text[];
  address_status text;
  quote_company uuid;
  line_count int;
  empty_lines int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'portal: order request % is %; only a draft is discarded', coalesce(OLD."number", OLD."id"::text), OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."number" IS NOT NULL OR NEW."sentAt" IS NOT NULL OR NEW."sentById" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'portal: a new order request is a DRAFT, unnumbered and unsent, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'portal: the company, customer and creation of order request % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'portal: the version of order request % goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('ACCEPTED', 'REFUSED', 'WITHDRAWN') THEN
      RAISE EXCEPTION 'portal: order request % is %; it never changes again', coalesce(OLD."number", OLD."id"::text), OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT' THEN
      IF NOT partner THEN
        RAISE EXCEPTION 'portal: draft % is the customer''s; the office only sends it for the portal', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      allowed := draft_columns;
    ELSIF OLD."status" = 'DRAFT' AND NEW."status" = 'SENT' THEN
      allowed := send_columns;
      IF partner THEN
        allowed := send_columns || draft_columns;
      END IF;
    ELSIF OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'REFUSED') THEN
      IF partner THEN
        RAISE EXCEPTION 'portal: the office decides order request %, not the customer', OLD."number"
          USING ERRCODE = 'check_violation';
      END IF;
      allowed := decide_columns;
    ELSIF OLD."status" = 'SENT' AND NEW."status" = 'WITHDRAWN' THEN
      allowed := withdraw_columns;
    ELSE
      RAISE EXCEPTION 'portal: order request % moves DRAFT → SENT → ACCEPTED, REFUSED or WITHDRAWN, not % → %', coalesce(OLD."number", OLD."id"::text), OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - (kept || allowed)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || allowed)) THEN
      RAISE EXCEPTION 'portal: order request % (% → %) changes only %', coalesce(OLD."number", OLD."id"::text), OLD."status", NEW."status", array_to_string(allowed, ', ')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."currency" !~ '^[A-Z]{3}$'
     OR (NEW."customerRef" IS NOT NULL AND (btrim(NEW."customerRef") <> NEW."customerRef" OR NEW."customerRef" = '' OR length(NEW."customerRef") > 100))
     OR (NEW."note" IS NOT NULL AND (btrim(NEW."note") = '' OR length(NEW."note") > 4000))
     OR (NEW."number" IS NOT NULL AND (btrim(NEW."number") <> NEW."number" OR NEW."number" = '' OR length(NEW."number") > 40)) THEN
    RAISE EXCEPTION 'portal: order request % has an ISO currency, a reference of 1 to 100 trimmed characters, a note of up to 4000, a number of up to 40', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  sent := NEW."status" <> 'DRAFT';
  decided := NEW."status" IN ('ACCEPTED', 'REFUSED');
  IF sent <> (NEW."number" IS NOT NULL) OR sent <> (NEW."sentAt" IS NOT NULL) OR sent <> (NEW."sentById" IS NOT NULL)
     OR NEW."sentAt" < NEW."createdAt" THEN
    RAISE EXCEPTION 'portal: order request % is %: its number, when and who sent it exactly from SENT on', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF decided <> (NEW."decidedAt" IS NOT NULL) OR decided <> (NEW."decidedById" IS NOT NULL) OR NEW."decidedAt" < NEW."sentAt"
     OR (NEW."status" = 'REFUSED') <> (btrim(coalesce(NEW."refuseReason", '')) <> '') OR length(NEW."refuseReason") > 2000
     OR (NEW."status" = 'ACCEPTED') <> ((NEW."salesOrderId" IS NULL) <> (NEW."quoteId" IS NULL))
     OR (NEW."status" <> 'ACCEPTED' AND (NEW."salesOrderId" IS NOT NULL OR NEW."quoteId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'portal: order request % is %: the decision (when, who) exactly when ACCEPTED or REFUSED, words exactly when REFUSED, the order or quote it became (one) exactly when ACCEPTED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL) OR NEW."withdrawnAt" < NEW."sentAt" THEN
    RAISE EXCEPTION 'portal: order request % is %: withdrawn (when) exactly when WITHDRAWN', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."shipToAddressId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."shipToAddressId" IS DISTINCT FROM OLD."shipToAddressId") THEN
    SELECT a."kinds"::text[], a."status"::text INTO address_kinds, address_status
      FROM "PartyAddress" a WHERE a."tenantId" = NEW."tenantId" AND a."partyId" = NEW."partyId" AND a."id" = NEW."shipToAddressId";
    IF FOUND AND (NOT ('SHIP_TO' = ANY (address_kinds)) OR address_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'portal: order request % is delivered to one of the customer''s SHIP_TO addresses, not archived', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'DRAFT' AND NEW."status" = 'SENT' THEN
    SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "PortalOrderRequestSize" s WHERE s."tenantId" = l."tenantId" AND s."lineId" = l."id"))
      INTO line_count, empty_lines
      FROM "PortalOrderRequestLine" l WHERE l."tenantId" = NEW."tenantId" AND l."requestId" = NEW."id";
    IF line_count = 0 OR empty_lines > 0 THEN
      RAISE EXCEPTION 'portal: order request % is sent with at least one line, each with its pieces (% lines, % without pieces)', NEW."id", line_count, empty_lines
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."requestedDate" < "factory_money_rome_day"(NEW."sentAt") THEN
      RAISE EXCEPTION 'portal: order request % asks for % , before the day it is sent', NEW."id", NEW."requestedDate"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."quoteId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."quoteId" IS DISTINCT FROM OLD."quoteId") THEN
    SELECT q."companyId" INTO quote_company FROM "Quote" q WHERE q."tenantId" = NEW."tenantId" AND q."id" = NEW."quoteId";
    IF FOUND AND quote_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'portal: order request % became a quote of its own company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PortalOrderRequest_guard" AFTER INSERT OR UPDATE OR DELETE ON "PortalOrderRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_portal_order_request_guard"();

-- =====================================================================================================================
-- PortalOrderRequestLine and PortalOrderRequestSize: written, changed and removed only while their request is a DRAFT
-- (its row locked FOR SHARE, so a send waits for them); a line stays on its request, a size on its line and its size code.
-- A line: its place 1 or more, the price shown at least 0, a note of up to 1000. A size: a trimmed code of 1 to 40, its
-- pieces 1 to 100 000.
CREATE FUNCTION "factory_portal_order_request_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_id uuid;
  request_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    request_id := OLD."requestId";
    SELECT r."status"::text INTO request_status FROM "PortalOrderRequest" r WHERE r."tenantId" = OLD."tenantId" AND r."id" = request_id FOR SHARE;
  ELSE
    request_id := NEW."requestId";
    SELECT r."status"::text INTO request_status FROM "PortalOrderRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = request_id FOR SHARE;
  END IF;
  IF request_status IS NOT NULL AND request_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'portal: the lines of order request % change only while it is a DRAFT (it is %)', request_id, request_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."partyId", NEW."requestId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."partyId", OLD."requestId", OLD."createdAt", OLD."createdById")
       OR NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'portal: line % stays on its request; its version goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."version" <> 1 THEN
    RAISE EXCEPTION 'portal: a new request line is at version 1'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 1 OR NEW."unitPriceShown" < 0
     OR (NEW."note" IS NOT NULL AND (btrim(NEW."note") = '' OR length(NEW."note") > 1000)) THEN
    RAISE EXCEPTION 'portal: request line % has its place (1 or more), a price shown of at least 0, a note of up to 1000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PortalOrderRequestLine_guard" AFTER INSERT OR UPDATE OR DELETE ON "PortalOrderRequestLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_portal_order_request_line_guard"();

CREATE FUNCTION "factory_portal_order_request_size_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_id uuid;
  request_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    line_id := OLD."lineId";
    SELECT r."status"::text INTO request_status
      FROM "PortalOrderRequestLine" l JOIN "PortalOrderRequest" r ON r."tenantId" = l."tenantId" AND r."id" = l."requestId"
     WHERE l."tenantId" = OLD."tenantId" AND l."id" = line_id FOR SHARE OF r;
  ELSE
    line_id := NEW."lineId";
    SELECT r."status"::text INTO request_status
      FROM "PortalOrderRequestLine" l JOIN "PortalOrderRequest" r ON r."tenantId" = l."tenantId" AND r."id" = l."requestId"
     WHERE l."tenantId" = NEW."tenantId" AND l."id" = line_id FOR SHARE OF r;
  END IF;
  IF request_status IS NOT NULL AND request_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'portal: the pieces of request line % change only while its request is a DRAFT (it is %)', line_id, request_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."partyId", NEW."lineId", NEW."size", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."partyId", OLD."lineId", OLD."size", OLD."createdAt", OLD."createdById")
       OR NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'portal: size row % keeps its line and its size (another size is another row); its version goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."version" <> 1 THEN
    RAISE EXCEPTION 'portal: a new size row is at version 1'
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."size") <> NEW."size" OR NEW."size" = '' OR length(NEW."size") > 40 OR NEW."quantity" < 1 OR NEW."quantity" > 100000 THEN
    RAISE EXCEPTION 'portal: size row % has a size code of 1 to 40 trimmed characters and 1 to 100000 pieces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PortalOrderRequestSize_guard" AFTER INSERT OR UPDATE OR DELETE ON "PortalOrderRequestSize"
  FOR EACH ROW EXECUTE FUNCTION "factory_portal_order_request_size_guard"();

-- =====================================================================================================================
-- OrderChangeRequest (portal-sales.prisma).
--   INSERT    OPEN, unanswered, at version 1, of an order that is CONFIRMED, IN_PRODUCTION or READY (the cut-off rules
--             of the sales settings are the API's: the partner role cannot read them); a date asked not before the day
--             it is asked (Rome).
--   UPDATE    the order, the kind, what was asked and the creation never change; the version goes up by one at most.
--             OPEN → ACCEPTED | REFUSED   the office only: the answer (words required to refuse), when and who; an
--                                        acceptance may name the amendment it made.
--             OPEN → WITHDRAWN           when; nothing else.
--             An answered or withdrawn request never changes again, but an accepted one names its amendment once.
--   DELETE    refused.
--   Every row: a CANCEL gives a code of the CANCEL reason list and asks no date or address; a CHANGE has no reason code;
--   each state's columns exactly; the amendment, when named, of the request's order (its reference) and made after it
--   was asked; the address asked, one of the customer's SHIP_TO addresses, not archived.
CREATE FUNCTION "factory_order_change_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  partner CONSTANT boolean := current_user = 'factory_partner_runtime';
  kept CONSTANT text[] := ARRAY['tenantId'];
  answer_columns CONSTANT text[] := ARRAY['status', 'answer', 'answeredAt', 'answeredById', 'amendmentId', 'version', 'updatedAt'];
  withdraw_columns CONSTANT text[] := ARRAY['status', 'withdrawnAt', 'version', 'updatedAt'];
  amendment_columns CONSTANT text[] := ARRAY['amendmentId', 'version', 'updatedAt'];
  answered boolean;
  order_status text;
  address_kinds text[];
  address_status text;
  amendment_made timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal: change request % is answered or withdrawn, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."answer" IS NOT NULL OR NEW."answeredAt" IS NOT NULL OR NEW."answeredById" IS NOT NULL
       OR NEW."amendmentId" IS NOT NULL OR NEW."withdrawnAt" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'portal: a new change request is OPEN, unanswered, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT o."status"::text INTO order_status FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."orderId";
    IF FOUND AND order_status NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY') THEN
      RAISE EXCEPTION 'portal: order % is %; a change or a cancel is asked only while it is CONFIRMED, IN_PRODUCTION or READY', NEW."orderId", order_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."requestedDate" < "factory_money_rome_day"(NEW."createdAt") THEN
      RAISE EXCEPTION 'portal: change request % asks for %, a day already past when it was asked', NEW."id", NEW."requestedDate"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."orderId", NEW."kind", NEW."reasonCode", NEW."reason", NEW."requestedDate", NEW."shipToAddressId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."orderId", OLD."kind", OLD."reasonCode", OLD."reason", OLD."requestedDate", OLD."shipToAddressId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'portal: the order, kind, ask and creation of change request % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'portal: the version of change request % goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' THEN
      IF partner OR OLD."status" <> 'ACCEPTED' OR OLD."amendmentId" IS NOT NULL OR NEW."amendmentId" IS NULL
         OR (to_jsonb(NEW) - (kept || amendment_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || amendment_columns)) THEN
        RAISE EXCEPTION 'portal: change request % is %; it never changes again (an accepted one names its amendment once)', OLD."id", OLD."status"
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
    ELSE
      RAISE EXCEPTION 'portal: an OPEN change request (%) changes only by its answer or its withdrawal', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."kind" = 'CANCEL' AND (NEW."reasonCode" IS NULL OR NEW."requestedDate" IS NOT NULL OR NEW."shipToAddressId" IS NOT NULL))
     OR (NEW."kind" = 'CHANGE' AND NEW."reasonCode" IS NOT NULL)
     OR NEW."reasonCode" !~ '^[A-Z][A-Z0-9_]{0,39}$'
     OR (NEW."reason" IS NOT NULL AND (btrim(NEW."reason") = '' OR length(NEW."reason") > 2000)) THEN
    RAISE EXCEPTION 'portal: change request % (%): a cancel gives a code of the CANCEL reason list and asks no date or address, a change has no reason code; their words up to 2000', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
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

CREATE TRIGGER "OrderChangeRequest_guard" AFTER INSERT OR UPDATE OR DELETE ON "OrderChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_change_request_guard"();

-- =====================================================================================================================
-- OrderChangeRequestLine: written while its request is OPEN (its row locked FOR SHARE), never changed or removed. A line of
-- the request's own order; the pieces before and asked 0 to 100 000; a cancel asks 0, a change a different number; a size
-- code trimmed, 1 to 40 (null: the line as a whole). Whether the line has that size is the API's.
CREATE FUNCTION "factory_order_change_request_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_status text;
  request_kind text;
  request_order uuid;
  line_order uuid;
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
  SELECT l."orderId" INTO line_order FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."orderLineId";
  IF request_order IS NOT NULL AND line_order IS NOT NULL AND line_order <> request_order THEN
    RAISE EXCEPTION 'portal: change request % asks for a line of its own order', NEW."requestId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."quantity" < 0 OR NEW."quantity" > 100000 OR NEW."quantityBefore" < 0 OR NEW."quantityBefore" > 100000
     OR (request_kind = 'CANCEL' AND NEW."quantity" <> 0)
     OR (request_kind = 'CHANGE' AND NEW."quantity" = NEW."quantityBefore")
     OR (NEW."size" IS NOT NULL AND (btrim(NEW."size") <> NEW."size" OR NEW."size" = '' OR length(NEW."size") > 40)) THEN
    RAISE EXCEPTION 'portal: change request % (%) asks 0 to 100000 pieces, before and asked: a cancel asks 0, a change a different number; a size of 1 to 40 trimmed characters', NEW."requestId", request_kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OrderChangeRequestLine_guard" AFTER INSERT OR UPDATE OR DELETE ON "OrderChangeRequestLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_change_request_line_guard"();

-- =====================================================================================================================
-- PaymentIntent (portal-sales.prisma). No card data: the provider's id and reason code are its own words, never a card
-- number (factory_payment_provider_text_ok).
--   INSERT    CREATED, unfinished, without a payment, at version 1; on an ACTIVE PAYMENT_FAKE or STRIPE account of its
--             company or the tenant; paying exactly one of an OPEN deposit request or an issued TD01 / TD24 invoice (not
--             REJECTED: a rejected file counts as never issued), in its currency, at most its amount; started from a
--             PAYMENT or DEPOSIT_INFO link of its company, when a link.
--   UPDATE    what it pays, how, how much, where and from where never change; the version goes up by one at most; the
--             provider's id is set once. CREATED → WAITING | SUCCEEDED | FAILED | CANCELLED, WAITING → SUCCEEDED | FAILED |
--             CANCELLED; the last three are final, but a SUCCEEDED intent names its payment once.
--   DELETE    refused.
--   Every row: an amount above 0, an ISO currency; finishedAt exactly when final; a reason code only when FAILED; the
--   provider's id once it is WAITING or SUCCEEDED; the payment only when SUCCEEDED, of its amount and currency.
CREATE FUNCTION "factory_payment_intent_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  move_columns CONSTANT text[] := ARRAY['status', 'providerRef', 'failureCode', 'finishedAt', 'paymentId', 'version', 'updatedAt'];
  payment_columns CONSTANT text[] := ARRAY['paymentId', 'version', 'updatedAt'];
  finished boolean;
  account_provider text;
  account_company uuid;
  account_status text;
  target_amount int;
  target_currency text;
  target_status text;
  target_doc text;
  link_purpose text;
  link_company uuid;
  paid_amount int;
  paid_currency text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments: payment intent % is never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'CREATED' OR NEW."finishedAt" IS NOT NULL OR NEW."failureCode" IS NOT NULL OR NEW."paymentId" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'payments: a new payment intent is CREATED, unfinished, without a payment, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (to_jsonb(NEW) - (kept || move_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || move_columns)) THEN
      RAISE EXCEPTION 'payments: what payment intent % pays, how, how much, on which account and from where never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'payments: the version of payment intent % goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."providerRef" IS NOT NULL AND NEW."providerRef" IS DISTINCT FROM OLD."providerRef" THEN
      RAISE EXCEPTION 'payments: the provider''s id of payment intent % is set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN
      IF OLD."status" <> 'SUCCEEDED' OR OLD."paymentId" IS NOT NULL OR NEW."paymentId" IS NULL
         OR (to_jsonb(NEW) - (kept || payment_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || payment_columns)) THEN
        RAISE EXCEPTION 'payments: payment intent % is %; it never changes again (a succeeded one names its payment once)', OLD."id", OLD."status"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."status" = 'WAITING' AND NEW."status" = 'CREATED' THEN
      RAISE EXCEPTION 'payments: payment intent % is WAITING; it never goes back to CREATED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."depositRequestId" IS NULL) = (NEW."invoiceId" IS NULL) OR NEW."amount" <= 0 OR NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'payments: payment intent % pays exactly one deposit request or invoice, an amount above 0, in an ISO currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_payment_provider_text_ok"(NEW."providerRef") OR NOT "factory_payment_provider_text_ok"(NEW."failureCode") THEN
    RAISE EXCEPTION 'payments: the provider''s id and reason code of payment intent % are letters, digits, _ and - (up to 255), never a card number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  finished := NEW."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED');
  IF finished <> (NEW."finishedAt" IS NOT NULL) OR NEW."finishedAt" < NEW."createdAt"
     OR (NEW."failureCode" IS NOT NULL AND NEW."status" <> 'FAILED')
     OR (NEW."status" IN ('WAITING', 'SUCCEEDED') AND NEW."providerRef" IS NULL)
     OR (NEW."paymentId" IS NOT NULL AND NEW."status" <> 'SUCCEEDED') THEN
    RAISE EXCEPTION 'payments: payment intent % is %: finished (when) exactly when SUCCEEDED, FAILED or CANCELLED; a reason code only when FAILED; the provider''s id once WAITING or SUCCEEDED; a payment only when SUCCEEDED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT a."provider"::text, a."companyId", a."status"::text INTO account_provider, account_company, account_status
      FROM "IntegrationAccount" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."providerAccountId";
    IF FOUND AND (account_provider NOT IN ('PAYMENT_FAKE', 'STRIPE') OR account_status <> 'ACTIVE' OR account_company <> NEW."companyId") THEN
      RAISE EXCEPTION 'payments: payment intent % runs on an ACTIVE payment provider account (PAYMENT_FAKE or STRIPE) of its company or of the tenant', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."depositRequestId" IS NOT NULL THEN
      SELECT d."amount", d."currency", d."status"::text INTO target_amount, target_currency, target_status
        FROM "DepositRequest" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."depositRequestId";
      IF FOUND AND (target_status <> 'OPEN' OR NEW."currency" <> target_currency OR NEW."amount" > target_amount) THEN
        RAISE EXCEPTION 'payments: payment intent % pays an OPEN deposit request, in its currency, at most its amount', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT i."grossTotal", i."currency", i."status"::text, i."docType"::text INTO target_amount, target_currency, target_status, target_doc
        FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";
      IF FOUND AND (target_doc NOT IN ('TD01', 'TD24') OR target_status IN ('DRAFT', 'REJECTED') OR NEW."currency" <> target_currency OR NEW."amount" > target_amount) THEN
        RAISE EXCEPTION 'payments: payment intent % pays an issued TD01 or TD24 invoice (not rejected), in its currency, at most its gross total', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."linkId" IS NOT NULL THEN
      SELECT l."purpose"::text, l."companyId" INTO link_purpose, link_company
        FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."partyId" = NEW."partyId" AND l."id" = NEW."linkId";
      IF FOUND AND (link_purpose NOT IN ('PAYMENT', 'DEPOSIT_INFO') OR link_company <> NEW."companyId") THEN
        RAISE EXCEPTION 'payments: payment intent % is started from a PAYMENT or DEPOSIT_INFO link of its company', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."paymentId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."paymentId" IS NULL) THEN
    SELECT p."amount", p."currency" INTO paid_amount, paid_currency FROM "Payment" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId";
    IF FOUND AND (paid_amount <> NEW."amount" OR paid_currency <> NEW."currency") THEN
      RAISE EXCEPTION 'payments: the payment of payment intent % is of its amount and currency', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PaymentIntent_guard" AFTER INSERT OR UPDATE OR DELETE ON "PaymentIntent"
  FOR EACH ROW EXECUTE FUNCTION "factory_payment_intent_guard"();

-- =====================================================================================================================
-- MeasurementProfile (parties.prisma): a trigger of its own (the table had none). A profile is never edited in place:
--   UPDATE    only photosDeleteAfter moves (set or moved, never cleared once set).
--   INSERT    a link session (the partner role) adds only the revision the rider sent through a MEASUREMENTS link that
--             still opens (not revoked, before its expiry), without a deletion date (the office's). Any login: a revision
--             sent by link names the link of its party (MEASUREMENTS, sent between its making and its expiry, not after it
--             was revoked) and the notice shown; the notice (where the role may read notices: not the partner role) is a
--             notice for people outside the company (PRIVACY_PUBLIC or PORTAL_TERMS) of the link's company, in force when
--             it was shown; the photos are AVAILABLE PHOTO files of category BODY_PHOTO, not another party's.
--   Every row: the link and the send time both or neither, the notice with them; the notice shown no later than the
--   send; three different photo files; a deletion date only on a revision with a photo, after it was written.
CREATE FUNCTION "factory_measurement_profile_portal_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  partner CONSTANT boolean := current_user = 'factory_partner_runtime';
  kept CONSTANT text[] := ARRAY['tenantId'];
  moves CONSTANT text[] := ARRAY['photosDeleteAfter'];
  photos uuid[];
  link_purpose text;
  link_company uuid;
  link_made timestamptz;
  link_expires timestamptz;
  link_revoked timestamptz;
  notice_kind text;
  notice_company uuid;
  notice_published timestamptz;
  notice_superseded timestamptz;
  bad_photos int;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (to_jsonb(NEW) - (kept || moves)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || moves)) THEN
      RAISE EXCEPTION 'parties: measurement profile % is never edited in place (a change is a new revision); only when its photos are deleted moves', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."photosDeleteAfter" IS NOT NULL AND NEW."photosDeleteAfter" IS NULL THEN
      RAISE EXCEPTION 'parties: when the photos of measurement profile % are deleted is set; it is moved, never cleared', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."submittedViaLinkId" IS NULL) <> (NEW."submittedAt" IS NULL)
     OR (NEW."submittedViaLinkId" IS NOT NULL AND NEW."noticeVersionId" IS NULL)
     OR NEW."privacyNoticeAt" > NEW."submittedAt" THEN
    RAISE EXCEPTION 'parties: measurement profile % sent by link names the link, when it was sent and the notice shown (no later than the send)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  photos := array_remove(ARRAY[NEW."photoFrontFileId", NEW."photoSideFileId", NEW."photoBackFileId"], NULL);
  IF cardinality(photos) <> (SELECT count(DISTINCT photo) FROM unnest(photos) AS photo) THEN
    RAISE EXCEPTION 'parties: the front, side and back photos of measurement profile % are three different files', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."photosDeleteAfter" IS NOT NULL AND (cardinality(photos) = 0 OR NEW."photosDeleteAfter" < NEW."createdAt") THEN
    RAISE EXCEPTION 'parties: measurement profile % has a photo deletion date only with a photo, after it was written', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF partner AND (NEW."submittedViaLinkId" IS NULL OR NEW."photosDeleteAfter" IS NOT NULL) THEN
      RAISE EXCEPTION 'parties: a link session adds only the revision the rider sent through its MEASUREMENTS link, without a photo deletion date (the office sets it)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."submittedViaLinkId" IS NOT NULL THEN
      SELECT l."purpose"::text, l."companyId", l."createdAt", l."expiresAt", l."revokedAt"
        INTO link_purpose, link_company, link_made, link_expires, link_revoked
        FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."partyId" = NEW."partyId" AND l."id" = NEW."submittedViaLinkId";
      IF FOUND AND (link_purpose <> 'MEASUREMENTS' OR NEW."submittedAt" < link_made OR NEW."submittedAt" > link_expires OR link_revoked <= NEW."submittedAt") THEN
        RAISE EXCEPTION 'parties: measurement profile % is sent through a MEASUREMENTS link of its party, while the link opened', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF FOUND AND partner AND (link_revoked IS NOT NULL OR now() >= link_expires) THEN
        RAISE EXCEPTION 'parties: the MEASUREMENTS link of measurement profile % no longer opens', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."noticeVersionId" IS NOT NULL AND has_table_privilege('"PrivacyNotice"', 'SELECT') THEN
      SELECT n."kind"::text, n."companyId", n."publishedAt", n."supersededAt" INTO notice_kind, notice_company, notice_published, notice_superseded
        FROM "PrivacyNotice" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."noticeVersionId";
      IF FOUND AND (notice_kind NOT IN ('PRIVACY_PUBLIC', 'PORTAL_TERMS') OR notice_published IS NULL OR notice_published > NEW."privacyNoticeAt"
                    OR notice_superseded <= NEW."privacyNoticeAt" OR notice_company <> link_company) THEN
        RAISE EXCEPTION 'parties: the notice shown for measurement profile % is a notice for people outside the company (PRIVACY_PUBLIC or PORTAL_TERMS) of the link''s company, in force when it was shown', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF cardinality(photos) > 0 THEN
      SELECT count(*) INTO bad_photos FROM "StoredFile" f
       WHERE f."tenantId" = NEW."tenantId" AND f."id" = ANY (photos)
         AND (f."kind" <> 'PHOTO' OR f."category" IS DISTINCT FROM 'BODY_PHOTO' OR f."status" <> 'AVAILABLE' OR f."partyId" <> NEW."partyId");
      IF bad_photos > 0 THEN
        RAISE EXCEPTION 'parties: the photos of measurement profile % are AVAILABLE PHOTO files of category BODY_PHOTO, not another party''s', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MeasurementProfile_portal_guard" AFTER INSERT OR UPDATE ON "MeasurementProfile"
  FOR EACH ROW EXECUTE FUNCTION "factory_measurement_profile_portal_guard"();

-- =====================================================================================================================
-- SalesSettings (sales.prisma): the cut-off rules of portal change and cancel requests, a trigger of its own beside the
-- settings' guard (not redefined). A status cut-off is CONFIRMED, IN_PRODUCTION or READY (an order is asked about only
-- while in one of them); the days 1 to 365; null: no rule of that kind.
CREATE FUNCTION "factory_sales_settings_cutoffs_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."cancelCutoffStatus"::text NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY')
     OR NEW."changeCutoffStatus"::text NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY')
     OR NEW."cancelCutoffDays" < 1 OR NEW."cancelCutoffDays" > 365 THEN
    RAISE EXCEPTION 'sales: settings %: a cut-off status is CONFIRMED, IN_PRODUCTION or READY, the cancel''s days 1 to 365 (null: no rule)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SalesSettings_portal_cutoffs" AFTER INSERT OR UPDATE OF "cancelCutoffStatus", "cancelCutoffDays", "changeCutoffStatus" ON "SalesSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_settings_cutoffs_check"();
