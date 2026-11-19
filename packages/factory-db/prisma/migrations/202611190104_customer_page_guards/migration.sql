-- Written by hand (Prisma does not model triggers), after the generated 202611190103_customer_page_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The customer page's ONE schema wave ("customer page 1/1", B-CP-005; design customer-page 11 §1.1, 12 §8, 15-steps-notes
-- §2 rows M1-M6, S1-S4, F1, G1-G5, D1, P1; lead change: "Saved measurements" comes later, so no PROFILE way). apps/factory-api
-- checks all of this first and answers in words (B-CP-014/015/023 the priced-file lock, B-CP-017/019/024 the customer's
-- prices, B-CP-075/076 the portal draft, B-CP-078 the factory designer); these rules are the last word, for every login,
-- the owner included. The refusals are check_violation (SQLSTATE 23514); their words name no other customer (the brand
-- wall: "One brand must not be able to see anything related to any other brand"). A rule that reads another row reads it
-- as the session sees it (the partner role: its own party's orders, lines, requests and the files shared with it).
--
--   OrderBrandPrice           NEW (M3, M4): a line row holds exactly one of unitPrice and netAmount, the total row
--                             netAmount only, both at least 0; one total row per order (the partial unique index
--                             "OrderBrandPrice_one_total"); the order's currency; a line of the row's own order; the order
--                             not CLOSED or CANCELLED (READY, PARTLY_SHIPPED, SHIPPED and DELIVERED stay open: the price is
--                             often checked at invoicing); the source file a file of the row's own order, not deleted, of
--                             no other customer; who in the office typed it exactly when the factory typed it; a portal
--                             session writes PORTAL line rows only, and the office writes PORTAL only as a carry of the
--                             customer's own price (inserted, or moved with its line by a split, never changed).
--                             TRUNCATE refused.
--   PortalOrderRequestPerson  NEW (G3): written only while its request is a DRAFT; on a by-person line of its own request;
--                             measured by SIZE (a size), SHEET (a MEASUREMENTS file of this request or one of its lines) or
--                             LATER (neither). TRUNCATE refused.
--
-- Earlier functions REDEFINED here, each ONCE, from its newest body, word for word but for the lines marked B-CP-005:
--   factory_portal_order_request_guard       (…_portal_sales_w2b_guards, B-W2b-157: its only body; G2) the parts sent
--                                            later and who saved it last change only while it is a DRAFT; Send needs every
--                                            line with its pieces by its kind (sizes; a described total; people or a
--                                            measurement sheet on a by-person line).
--   factory_portal_order_request_line_guard  (…_portal_sales_w2b_guards, B-W2b-157: its only body; G1) the kinds and their
--                                            shapes, the customer's own price at least 0 (frozen at Send with the rest of
--                                            the line: a line changes only while its request is a DRAFT, as before), a
--                                            by-person line keeps its people.
--   factory_portal_settings_guard            (…_order_apply_design_asks_guards, B-SA-005b: its newest; G4) the factory
--                                            designer slot.
--   factory_stored_file_guard                (…_followups_sales_w2b5_guards: its newest; G5) `priced` is not content (it
--                                            may change on a live file, as every tag) and a superseded version may still
--                                            take it, so a mark reaches every version of a series.
-- Their triggers stay as they are. VERIFIED, NOT REDEFINED: factory_portal_order_request_size_guard (…_portal_sales_w2b_guards):
-- it reads only its line's request, so a size row is taken on a line of any kind (a DESCRIBED line's sizes) as before.
-- None of the order page wave's functions (…_order_page_guards) is touched. USED FROM EARLIER WAVES, as they are:
-- "factory_sales_refuse_truncate" (…_sales_guards), "factory_portal_sales_refuse_truncate" (…_portal_sales_w2b_guards),
-- "factory_money_rome_day" (…_money_w2a_guards, in the request guard as before).
--
-- Data (D1, once; the Factory is not live, so only seed and test rows move): StoredFile.priced for the files that show
-- prices (order confirmations, price lists, proformas, commercial invoices, a shipment pack made with a priced part, invoice
-- copies, sent quotes, payment reminder letters, statements) and every copy and version of them; Role.requireMfa for the
-- custom office roles that see prices, costs or margins (plan O6). A NOTICE says how many rows moved.

-- =====================================================================================================================
-- OrderBrandPrice (sales-brand-prices.prisma; design 11 §1.1; review B2, C3, G5)
--   INSERT     at version 1.
--   UPDATE     an UPDATE that changes nothing passes; the company, the customer and the creation never change; the
--              version goes up by one at most; a row moves to another order only with its line (a split): its order and
--              its line change together, a line row stays a line row and the total row never moves.
--   DELETE     only while its order is not CLOSED or CANCELLED; a portal session removes line rows only.
--   every row  the shapes above; the order not CLOSED or CANCELLED (also the order it leaves); the line one of its own
--              order; the source file, when named or changed, a file of its own order, not deleted, of no other customer.
--   who        a portal session (factory_partner_runtime) writes PORTAL line rows and changes only PORTAL rows (a row the
--              factory typed is removed and written again: the role cannot clear who typed it); the office writes every
--              source, PORTAL only as a carry (an insert: the accept, the take-over, a split; or a move with its line,
--              nothing else changed); enteredById exactly when the source is not PORTAL.
--   TRUNCATE   refused.
CREATE FUNCTION "factory_order_brand_price_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  partner CONSTANT boolean := current_user = 'factory_partner_runtime';
  -- What a carry moves with its line (a split): its order and its line; nothing else of a PORTAL row changes by the office.
  move_columns CONSTANT text[] := ARRAY['salesOrderId', 'salesOrderLineId', 'version', 'updatedAt'];
  order_status text;
  order_currency text;
  line_order uuid;
  file_record_type text;
  file_record uuid;
  file_status text;
  file_party uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF partner AND OLD."salesOrderLineId" IS NULL THEN
      RAISE EXCEPTION 'prices: the customer''s total of order % is the factory''s to remove', OLD."salesOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF partner THEN
      SELECT o."status"::text INTO order_status FROM "SalesOrder" o WHERE o."tenantId" = OLD."tenantId" AND o."id" = OLD."salesOrderId";
    ELSE
      SELECT o."status"::text INTO order_status FROM "SalesOrder" o WHERE o."tenantId" = OLD."tenantId" AND o."id" = OLD."salesOrderId" FOR SHARE;
    END IF;
    IF order_status IN ('CLOSED', 'CANCELLED') THEN
      RAISE EXCEPTION 'prices: order % is %; the customer''s prices stay as they were', OLD."salesOrderId", order_status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."version" <> 1 THEN
      RAISE EXCEPTION 'prices: a new customer''s price is at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."createdAt") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."createdAt") THEN
      RAISE EXCEPTION 'prices: the company, the customer and the creation of customer''s price % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'prices: the version of customer''s price % goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."salesOrderId" <> OLD."salesOrderId") <> (NEW."salesOrderLineId" IS DISTINCT FROM OLD."salesOrderLineId")
       OR (NEW."salesOrderId" <> OLD."salesOrderId" AND (OLD."salesOrderLineId" IS NULL OR NEW."salesOrderLineId" IS NULL))
       OR (partner AND NEW."salesOrderId" <> OLD."salesOrderId") THEN
      RAISE EXCEPTION 'prices: customer''s price % moves to another order only with its line (a split of the order)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."salesOrderId" <> OLD."salesOrderId" THEN
      SELECT o."status"::text INTO order_status FROM "SalesOrder" o WHERE o."tenantId" = OLD."tenantId" AND o."id" = OLD."salesOrderId" FOR SHARE;
      IF order_status IN ('CLOSED', 'CANCELLED') THEN
        RAISE EXCEPTION 'prices: order % is %; the customer''s prices stay as they were', OLD."salesOrderId", order_status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- Who writes which source.
  IF partner THEN
    IF NEW."source" <> 'PORTAL' OR NEW."salesOrderLineId" IS NULL OR (TG_OP = 'UPDATE' AND OLD."source" <> 'PORTAL') THEN
      RAISE EXCEPTION 'prices: the portal writes the customer''s own price per line (PORTAL); a price the factory typed is removed first'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."source" = 'PORTAL' AND TG_OP = 'UPDATE'
        AND (OLD."source" <> 'PORTAL' OR (to_jsonb(NEW) - move_columns) IS DISTINCT FROM (to_jsonb(OLD) - move_columns)) THEN
    RAISE EXCEPTION 'prices: customer''s price % came from the portal; the factory carries it with its line or types its own (CUSTOMER_PO, OFFICE)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."source" = 'PORTAL') <> (NEW."enteredById" IS NULL) THEN
    RAISE EXCEPTION 'prices: customer''s price % names who in the factory typed it exactly when the factory typed it (CUSTOMER_PO, OFFICE)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The shapes.
  IF (NEW."salesOrderLineId" IS NOT NULL AND (NEW."unitPrice" IS NULL) = (NEW."netAmount" IS NULL))
     OR (NEW."salesOrderLineId" IS NULL AND (NEW."unitPrice" IS NOT NULL OR NEW."netAmount" IS NULL))
     OR NEW."unitPrice" < 0 OR NEW."netAmount" < 0 THEN
    RAISE EXCEPTION 'prices: customer''s price % is a line''s unit price or line total (exactly one), or the order''s total (an amount), at least 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currency" !~ '^[A-Z]{3}$'
     OR (NEW."note" IS NOT NULL AND (btrim(NEW."note") = '' OR length(NEW."note") > 1000)) THEN
    RAISE EXCEPTION 'prices: customer''s price % has an ISO currency and a note of up to 1000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Its order: open, in the same currency (no exchange rate, ever). The partner role reads its own orders only (it holds no
  -- lock on them).
  IF partner THEN
    SELECT o."status"::text, o."currency" INTO order_status, order_currency FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."salesOrderId";
  ELSE
    SELECT o."status"::text, o."currency" INTO order_status, order_currency FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."salesOrderId" FOR SHARE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prices: customer''s price % is of an order this session does not see', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF order_status IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'prices: order % is %; the customer''s prices stay as they were', NEW."salesOrderId", order_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currency" <> order_currency THEN
    RAISE EXCEPTION 'prices: customer''s price % is in the order''s currency (%), not %', NEW."id", order_currency, NEW."currency"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Its line: one of its own order (the reference holds the customer, this the order).
  IF NEW."salesOrderLineId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."salesOrderLineId" IS DISTINCT FROM OLD."salesOrderLineId") THEN
    SELECT l."orderId" INTO line_order FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
    IF NOT FOUND OR line_order <> NEW."salesOrderId" THEN
      RAISE EXCEPTION 'prices: customer''s price % is of a line of its own order', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Its source file: a file of its own order, not deleted, shared with no other customer (a file this session does not see
  -- is not one of its order's).
  IF NEW."sourceFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."sourceFileId" IS DISTINCT FROM OLD."sourceFileId") THEN
    SELECT f."recordType", f."recordId", f."status"::text, f."partyId" INTO file_record_type, file_record, file_status, file_party
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."sourceFileId";
    IF NOT FOUND OR file_record_type <> 'SalesOrder' OR file_record <> NEW."salesOrderId" OR file_status = 'DELETED'
       OR (file_party IS NOT NULL AND file_party <> NEW."partyId") THEN
      RAISE EXCEPTION 'prices: the source of customer''s price % is a file of its own order', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OrderBrandPrice_guard" AFTER INSERT OR UPDATE OR DELETE ON "OrderBrandPrice"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_brand_price_guard"();
CREATE TRIGGER "OrderBrandPrice_no_truncate" BEFORE TRUNCATE ON "OrderBrandPrice"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_refuse_truncate"();

-- One total row per order (M3; Prisma cannot express a partial unique index, so it lives here). A line has one row at most
-- by the schema's unique key.
CREATE UNIQUE INDEX "OrderBrandPrice_one_total" ON "OrderBrandPrice" ("tenantId", "salesOrderId") WHERE "salesOrderLineId" IS NULL;

-- =====================================================================================================================
-- PortalOrderRequestPerson (portal-sales.prisma; design 12 §2 part 4, §8 S2, S6; W-CP-3)
--   INSERT, UPDATE, DELETE  only while its request is a DRAFT (its row locked FOR SHARE, so a send waits for them), as its
--                           lines and sizes; a cascade from its line or a discarded draft passes the same way.
--   INSERT     at version 1.
--   UPDATE     an UPDATE that changes nothing passes; it stays on its line of its request, its party and creation fixed;
--              the version goes up by one at most.
--   every row  on a by-person line of its own request; its place 1 or more; a trimmed name of 1 to 120, a trimmed number of
--              up to 10, a note of up to 1000; SIZE names a trimmed size of 1 to 40 and no sheet, SHEET a sheet and no size,
--              LATER neither; the sheet, when named or changed, a MEASUREMENTS file of this request or of one of its lines,
--              not deleted (a file this session does not see is not one of its request's).
--   TRUNCATE   refused.
CREATE FUNCTION "factory_portal_order_request_person_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_id uuid;
  request_status text;
  line_request uuid;
  line_by_person boolean;
  file_record_type text;
  file_record uuid;
  file_category text;
  file_status text;
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
    RAISE EXCEPTION 'portal: the people of order request % change only while it is a DRAFT (it is %)', request_id, request_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."partyId", NEW."requestId", NEW."lineId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."partyId", OLD."requestId", OLD."lineId", OLD."createdAt", OLD."createdById")
       OR NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'portal: person % stays on its line of its request; its version goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."version" <> 1 THEN
    RAISE EXCEPTION 'portal: a new person of a request line is at version 1'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."requestId", l."byPerson" INTO line_request, line_by_person
    FROM "PortalOrderRequestLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."lineId";
  IF FOUND AND (line_request <> NEW."requestId" OR NOT line_by_person) THEN
    RAISE EXCEPTION 'portal: person % is on a by-person line of its own request', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 1
     OR btrim(NEW."name") <> NEW."name" OR NEW."name" = '' OR length(NEW."name") > 120
     OR (NEW."number" IS NOT NULL AND (btrim(NEW."number") <> NEW."number" OR NEW."number" = '' OR length(NEW."number") > 10))
     OR (NEW."note" IS NOT NULL AND (btrim(NEW."note") = '' OR length(NEW."note") > 1000)) THEN
    RAISE EXCEPTION 'portal: person % has its place (1 or more), a name of 1 to 120 trimmed characters, a number of up to 10, a note of up to 1000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."measureBy" = 'SIZE') <> (NEW."size" IS NOT NULL)
     OR (NEW."measureBy" = 'SHEET') <> (NEW."measurementFileId" IS NOT NULL)
     OR (NEW."size" IS NOT NULL AND (btrim(NEW."size") <> NEW."size" OR NEW."size" = '' OR length(NEW."size") > 40)) THEN
    RAISE EXCEPTION 'portal: person % is measured by a size (1 to 40 trimmed characters), a measurement sheet or later, exactly one way (%)', NEW."id", NEW."measureBy"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."measurementFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."measurementFileId" IS DISTINCT FROM OLD."measurementFileId") THEN
    SELECT f."recordType", f."recordId", f."category"::text, f."status"::text INTO file_record_type, file_record, file_category, file_status
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."measurementFileId";
    IF NOT FOUND OR file_status = 'DELETED' OR file_category IS DISTINCT FROM 'MEASUREMENTS'
       OR NOT ((file_record_type = 'PortalOrderRequest' AND file_record = NEW."requestId")
               OR (file_record_type = 'PortalOrderRequestLine'
                   AND EXISTS (SELECT 1 FROM "PortalOrderRequestLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = file_record AND l."requestId" = NEW."requestId"))) THEN
      RAISE EXCEPTION 'portal: the measurement sheet of person % is a measurement sheet of its own request', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PortalOrderRequestPerson_guard" AFTER INSERT OR UPDATE OR DELETE ON "PortalOrderRequestPerson"
  FOR EACH ROW EXECUTE FUNCTION "factory_portal_order_request_person_guard"();
CREATE TRIGGER "PortalOrderRequestPerson_no_truncate" BEFORE TRUNCATE ON "PortalOrderRequestPerson"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_portal_sales_refuse_truncate"();

-- =====================================================================================================================
-- PortalOrderRequest (portal-sales.prisma): REDEFINES factory_portal_order_request_guard (…_portal_sales_w2b_guards, its
-- only body), word for word but for the lines marked B-CP-005 (G2): laterParts, lastEditedById and lastEditedAt are draft
-- columns (only the customer changes them, only while DRAFT, or with its Send); the parts each once, who saved it last with
-- when; Send needs every line with its pieces by its kind. Its trigger stays as it is.
CREATE OR REPLACE FUNCTION "factory_portal_order_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  partner CONSTANT boolean := current_user = 'factory_partner_runtime';
  kept CONSTANT text[] := ARRAY['tenantId'];
  -- B-CP-005: the parts sent later and who saved it last are draft columns too.
  draft_columns CONSTANT text[] := ARRAY['source', 'customerRef', 'shipToAddressId', 'requestedDate', 'note', 'currency', 'laterParts', 'lastEditedById', 'lastEditedAt', 'version', 'updatedAt'];
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
  -- B-CP-005: the parts sent later, each once (a list, maybe empty); who saved it last together with when.
  IF NEW."laterParts" IS NULL
     OR EXISTS (SELECT 1 FROM unnest(NEW."laterParts") p WHERE p IS NULL)
     OR cardinality(NEW."laterParts") <> (SELECT count(DISTINCT p) FROM unnest(NEW."laterParts") p)
     OR (NEW."lastEditedById" IS NULL) <> (NEW."lastEditedAt" IS NULL) THEN
    RAISE EXCEPTION 'portal: order request % names the parts it sends later each once, and who saved it last together with when (both or neither)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- end B-CP-005
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
    -- B-CP-005: a line's pieces by its kind: its size rows; a DESCRIBED line's total; a by-person line's people, or a
    -- measurement sheet on the line that stands for them ("People: in the attached sheet").
    SELECT count(*), count(*) FILTER (WHERE NOT (
             EXISTS (SELECT 1 FROM "PortalOrderRequestSize" s WHERE s."tenantId" = l."tenantId" AND s."lineId" = l."id")
             OR (l."kind" = 'DESCRIBED' AND l."quantity" IS NOT NULL)
             OR (l."byPerson"
                 AND (EXISTS (SELECT 1 FROM "PortalOrderRequestPerson" p WHERE p."tenantId" = l."tenantId" AND p."lineId" = l."id")
                      OR EXISTS (SELECT 1 FROM "StoredFile" f
                                  WHERE f."tenantId" = l."tenantId" AND f."recordType" = 'PortalOrderRequestLine' AND f."recordId" = l."id"
                                    AND f."category" = 'MEASUREMENTS' AND f."status" <> 'DELETED')))))
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

-- =====================================================================================================================
-- PortalOrderRequestLine (portal-sales.prisma): REDEFINES factory_portal_order_request_line_guard (…_portal_sales_w2b_guards,
-- its only body), word for word but for the lines marked B-CP-005 (G1, M6): every write still only while the request is a
-- DRAFT (so the customer's own price freezes at Send with the rest of the line); a CATALOGUE line names its style and
-- colourway, a DESCRIBED one the customer's words (1 to 2000), a MADE_TO_MEASURE one its garment type (a trimmed code of 1
-- to 40) and is by person; a colourway only with its style; colours in words up to 200; a total of pieces (1 to 100 000)
-- only on a DESCRIBED line; the customer's own price at least 0; a line that has people stays by person. Its trigger stays.
CREATE OR REPLACE FUNCTION "factory_portal_order_request_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- B-CP-005: the kinds and their shapes, the customer's own price, the people of a by-person line.
  IF (NEW."kind" = 'CATALOGUE' AND (NEW."styleId" IS NULL OR NEW."colourwayId" IS NULL))
     OR (NEW."kind" = 'DESCRIBED' AND NEW."description" IS NULL)
     OR (NEW."kind" = 'MADE_TO_MEASURE' AND (NEW."garmentType" IS NULL OR NOT NEW."byPerson"))
     OR (NEW."colourwayId" IS NOT NULL AND NEW."styleId" IS NULL) THEN
    RAISE EXCEPTION 'portal: request line % (%) names a style and colourway from the catalogue, the customer''s words when described, a garment type and its people when made to measure; a colourway only with its style', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."description" IS NOT NULL AND (btrim(NEW."description") = '' OR length(NEW."description") > 2000))
     OR (NEW."colourText" IS NOT NULL AND (btrim(NEW."colourText") = '' OR length(NEW."colourText") > 200))
     OR (NEW."garmentType" IS NOT NULL AND (btrim(NEW."garmentType") <> NEW."garmentType" OR NEW."garmentType" = '' OR length(NEW."garmentType") > 40))
     OR (NEW."quantity" IS NOT NULL AND (NEW."kind" <> 'DESCRIBED' OR NEW."quantity" < 1 OR NEW."quantity" > 100000))
     OR NEW."brandUnitPrice" < 0 THEN
    RAISE EXCEPTION 'portal: request line % has words of up to 2000, colours in words of up to 200, a garment type of 1 to 40 trimmed characters, a total of 1 to 100000 pieces only when described, its own price of at least 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."byPerson" AND NOT NEW."byPerson"
     AND EXISTS (SELECT 1 FROM "PortalOrderRequestPerson" p WHERE p."tenantId" = NEW."tenantId" AND p."lineId" = NEW."id") THEN
    RAISE EXCEPTION 'portal: request line % has its people; remove them before it is no longer by person', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- end B-CP-005
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- PortalSettings (portal-auth.prisma): REDEFINES factory_portal_settings_guard (…_order_apply_design_asks_guards, B-SA-005b:
-- its newest), word for word but for the lines marked B-CP-005 (G4): the factory designer with since when (both or
-- neither), its backup only beside a designer and never the same person, each an active office person when named or
-- changed, named only for a customer or a brand (whether the person reaches the customer is the API's). mtmDraftsOn takes
-- any value. Its trigger stays as it is; PortalSettings stays office only (the policy migration after this file).
CREATE OR REPLACE FUNCTION "factory_portal_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  party_roles text[];
  user_audience text; -- B-PR-12
  user_status text; -- B-PR-12
  user_party uuid; -- B-PR-12
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal: the portal settings % are changed, never deleted (switch the portal off)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."partyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'portal: the party and creation of the portal settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."maxUsers" IS NOT NULL AND NEW."maxUsers" NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'portal: the portal settings % hold 1 to 1000 people, or no limit, not %', NEW."id", NEW."maxUsers"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."allowedRoleKeys" IS NULL
     OR EXISTS (SELECT 1 FROM unnest(NEW."allowedRoleKeys") k WHERE k IS NULL OR k !~ '^[a-z][a-z0-9_.-]*$')
     OR cardinality(NEW."allowedRoleKeys") <> (SELECT count(DISTINCT k) FROM unnest(NEW."allowedRoleKeys") k) THEN
    RAISE EXCEPTION 'portal: the portal settings % name the allowed partner roles by their keys, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-40: production progress is the level's (PROGRESS or more), checked when a row is made at it or the level is raised to
  -- it; the old switch kept in step with it is dropped.
  IF NEW."productionLevel" >= 'PROGRESS'::"ProductionShareLevel" AND (TG_OP = 'INSERT' OR OLD."productionLevel" < 'PROGRESS'::"ProductionShareLevel") THEN
    SELECT p."roles"::text[] INTO party_roles FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND NOT (party_roles && ARRAY['CUSTOMER', 'BRAND']::text[]) THEN
      RAISE EXCEPTION 'portal: production progress is shared only with a customer or a brand (Owner answer C1); party % is %', NEW."partyId", party_roles
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- end B-PR-40
  -- B-PR-12: the production limits.
  IF NEW."productionUrgentMax" IS NULL OR NEW."productionUrgentMax" NOT BETWEEN 0 AND 20 THEN
    RAISE EXCEPTION 'portal: the portal settings % let 0 to 20 orders be urgent at once, not %', NEW."id", NEW."productionUrgentMax"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."productionSupervisorId" IS NULL) <> (NEW."productionSupervisorSetAt" IS NULL) THEN
    RAISE EXCEPTION 'portal: the portal settings % name a production supervisor together with since when, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."productionBackupId" IS NOT NULL AND (NEW."productionSupervisorId" IS NULL OR NEW."productionBackupId" = NEW."productionSupervisorId") THEN
    RAISE EXCEPTION 'portal: the portal settings % name a backup only beside a production supervisor, and never the supervisor', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-SA-005b: the design change DESIGN may be opened too (compared as text, as every other kind here).
  IF NEW."productionAskKinds" IS NULL
     OR EXISTS (SELECT 1 FROM unnest(NEW."productionAskKinds") k WHERE k IS NULL OR k::text NOT IN ('HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND', 'DESIGN'))
     OR cardinality(NEW."productionAskKinds") <> (SELECT count(DISTINCT k) FROM unnest(NEW."productionAskKinds") k) THEN
    RAISE EXCEPTION 'portal: the portal settings % open the production asks HOLD, RESUME, SPLIT_SHIPMENT and SAMPLE_ROUND and the design change DESIGN only, each once (RUSH follows the urgency switch; CHANGE and CANCEL the company''s cut-offs)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- end B-SA-005b
  IF NEW."productionSupervisorId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."productionSupervisorId" IS DISTINCT FROM OLD."productionSupervisorId") THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."productionSupervisorId";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'portal: the production supervisor of the portal settings % is an active office person, not one that is % (%)', NEW."id", user_status, user_audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."productionBackupId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."productionBackupId" IS DISTINCT FROM OLD."productionBackupId") THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."productionBackupId";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'portal: the production backup of the portal settings % is an active office person, not one that is % (%)', NEW."id", user_status, user_audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."productionApproverId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."productionApproverId" IS DISTINCT FROM OLD."productionApproverId") THEN
    SELECT u."audience"::text, u."status"::text, u."partyId" INTO user_audience, user_status, user_party FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."productionApproverId";
    IF FOUND AND (user_audience <> 'PARTNER' OR user_status <> 'ACTIVE' OR user_party IS DISTINCT FROM NEW."partyId") THEN
      RAISE EXCEPTION 'portal: the production approver of the portal settings % is an active portal person of its own party', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."productionUrgencyOn" OR cardinality(NEW."productionAskKinds") > 0 OR NEW."productionApproverId" IS NOT NULL
      OR NEW."productionSupervisorId" IS NOT NULL OR NEW."productionBackupId" IS NOT NULL)
     AND (TG_OP = 'INSERT'
          OR (NEW."productionUrgencyOn", NEW."productionAskKinds", NEW."productionApproverId", NEW."productionSupervisorId", NEW."productionBackupId")
             IS DISTINCT FROM (OLD."productionUrgencyOn", OLD."productionAskKinds", OLD."productionApproverId", OLD."productionSupervisorId", OLD."productionBackupId")) THEN
    SELECT p."roles"::text[] INTO party_roles FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND NOT (party_roles && ARRAY['CUSTOMER', 'BRAND']::text[]) THEN
      RAISE EXCEPTION 'portal: production limits (urgency, production asks, approver, supervisor, backup) are set only for a customer or a brand; party % is %', NEW."partyId", party_roles
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- end B-PR-12
  -- B-CP-005: the factory designer with since when (both or neither); the backup only beside a designer, never the same
  -- person; each an active office person when named or changed; named only for a customer or a brand.
  IF (NEW."factoryDesignerId" IS NULL) <> (NEW."factoryDesignerSetAt" IS NULL) THEN
    RAISE EXCEPTION 'portal: the portal settings % name a factory designer together with since when, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."factoryDesignerBackupId" IS NOT NULL AND (NEW."factoryDesignerId" IS NULL OR NEW."factoryDesignerBackupId" = NEW."factoryDesignerId") THEN
    RAISE EXCEPTION 'portal: the portal settings % name a factory designer''s backup only beside a factory designer, and never the designer', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."factoryDesignerId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."factoryDesignerId" IS DISTINCT FROM OLD."factoryDesignerId") THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."factoryDesignerId";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'portal: the factory designer of the portal settings % is an active office person, not one that is % (%)', NEW."id", user_status, user_audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."factoryDesignerBackupId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."factoryDesignerBackupId" IS DISTINCT FROM OLD."factoryDesignerBackupId") THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."factoryDesignerBackupId";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'portal: the factory designer''s backup of the portal settings % is an active office person, not one that is % (%)', NEW."id", user_status, user_audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."factoryDesignerId" IS NOT NULL OR NEW."factoryDesignerBackupId" IS NOT NULL)
     AND (TG_OP = 'INSERT' OR (NEW."factoryDesignerId", NEW."factoryDesignerBackupId") IS DISTINCT FROM (OLD."factoryDesignerId", OLD."factoryDesignerBackupId")) THEN
    SELECT p."roles"::text[] INTO party_roles FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND NOT (party_roles && ARRAY['CUSTOMER', 'BRAND']::text[]) THEN
      RAISE EXCEPTION 'portal: a factory designer is named only for a customer or a brand; party % is %', NEW."partyId", party_roles
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- end B-CP-005
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- StoredFile (files.prisma): REDEFINES factory_stored_file_guard (…_followups_sales_w2b5_guards, its newest), word for word
-- but for the line marked B-CP-005 (G5): `priced` may change on a superseded version too (a mark reaches every version of
-- its series). It is not in the content columns, so a live file takes it as every tag; a deleted file's frozen columns do
-- not name it either. Its trigger stays as it is.
CREATE OR REPLACE FUNCTION "factory_stored_file_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- What a superseded version may still change (everything else stays as it was when it was superseded).
  superseded_moves CONSTANT text[] := ARRAY['status', 'availableAt', 'deletedAt', 'quarantineReason', 'visibility', 'floorSiteId', 'partyId',
                                            'retainUntil', 'deleteAfter', 'legalHold', 'scanStatus', 'scannedAt', 'scanEngine', 'scanFinding',
                                            'thumbnailKey', 'exifStrippedAt', 'version', 'updatedAt',
                                            -- B-CP-005: the price lock reaches every version of a series.
                                            'priced'];
  root uuid;
  first_series uuid;
  first_company uuid;
  first_record_type text;
  first_record uuid;
  first_kind text;
  next_number integer;
  source_sha256 text;
  source_size integer;
  source_type text;
  source_status text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'files: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'files: file % is never deleted; it keeps its row in status DELETED', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."visibility" IS NULL OR NOT ('OFFICE' = ANY (NEW."visibility")) THEN
    RAISE EXCEPTION 'files: file % must be visible to the office', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF ('FLOOR' = ANY (NEW."visibility")) <> (NEW."floorSiteId" IS NOT NULL) THEN
    RAISE EXCEPTION 'files: file % names a floor site exactly when it is shared with the floor', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."floorSiteId" IS NOT NULL AND NEW."companyId" IS NULL THEN
    RAISE EXCEPTION 'files: file % is shared with a floor, so it belongs to that site''s company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF ('PARTNER' = ANY (NEW."visibility") OR 'LINK' = ANY (NEW."visibility")) <> (NEW."partyId" IS NOT NULL) THEN
    RAISE EXCEPTION 'files: file % names a party exactly when it is shared with a portal or a link', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'FISCAL_ARCHIVE') <> (NEW."storageKey" LIKE 'legal/%') THEN
    RAISE EXCEPTION 'files: file % is in the legal store exactly when it is a fiscal archive file', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'FISCAL_ARCHIVE' AND NEW."retainUntil" IS NULL THEN
    RAISE EXCEPTION 'files: fiscal archive file % needs its retention date', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sizeBytes" < 1 THEN
    RAISE EXCEPTION 'files: file % has no content', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'AVAILABLE' AND NEW."availableAt" IS NULL)
     OR (NEW."status" = 'QUARANTINED' AND NEW."quarantineReason" IS NULL)
     OR ((NEW."status" = 'DELETED') <> (NEW."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'files: file % is % without its time or reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."scanStatus" IN ('CLEAN', 'INFECTED', 'FAILED')) <> (NEW."scannedAt" IS NOT NULL)
     OR (NEW."scanStatus" IN ('CLEAN', 'INFECTED', 'FAILED')) <> (NEW."scanEngine" IS NOT NULL AND btrim(NEW."scanEngine") <> '')
     OR (NEW."scanStatus" IN ('INFECTED', 'FAILED')) <> (NEW."scanFinding" IS NOT NULL AND btrim(NEW."scanFinding") <> '') THEN
    RAISE EXCEPTION 'files: the scan of file % (%) has its time and scanner exactly with a verdict, and says what it found exactly when INFECTED or FAILED', NEW."id", NEW."scanStatus"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'AVAILABLE' AND NEW."scanStatus" = 'INFECTED' THEN
    RAISE EXCEPTION 'files: file % is infected; it is never available', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b wave 18/22: versions, copies, expiry, thumbnails.
  IF NEW."versionNo" < 1 OR (NEW."seriesId" IS NULL) <> (NEW."versionNo" = 1) OR NEW."seriesId" = NEW."id" THEN
    RAISE EXCEPTION 'files: file % is version %; a first version (1) names no series, a later one (2 and on) names its series'' first version, never itself', NEW."id", NEW."versionNo"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sourceFileId" = NEW."id" THEN
    RAISE EXCEPTION 'files: file % is not a copy of itself', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expiryRemindedAt" IS NOT NULL AND NEW."expiresOn" IS NULL THEN
    RAISE EXCEPTION 'files: file % has an expiry reminder but no expiry date', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."thumbnailKey" IS NULL) <> (NEW."exifStrippedAt" IS NULL)
     OR (NEW."thumbnailKey" IS NOT NULL AND (btrim(NEW."thumbnailKey") = '' OR NEW."thumbnailKey" = NEW."storageKey" OR NEW."thumbnailKey" LIKE 'legal/%')) THEN
    RAISE EXCEPTION 'files: the thumbnail of file % is a second object of its own (not blank, not the file''s key, never in the legal store), made with the EXIF and location data stripped (both or neither)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('PENDING_UPLOAD', 'AVAILABLE') THEN
      RAISE EXCEPTION 'files: a new file is PENDING_UPLOAD or AVAILABLE, not %', NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."scanStatus" <> 'NOT_SCANNED' THEN
      RAISE EXCEPTION 'files: a new file is NOT_SCANNED (its scan starts when the upload is confirmed), not %', NEW."scanStatus"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."supersededAt" IS NOT NULL OR NEW."expiryRemindedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'files: a new file % is neither superseded nor reminded of its expiry yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."thumbnailKey" IS NOT NULL AND NEW."status" <> 'AVAILABLE' THEN
      RAISE EXCEPTION 'files: a new file % has a thumbnail only when it is born AVAILABLE (a document the system made)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF "factory_quality_plant_in_scope"(NEW."tenantId", NULL) IS TRUE THEN
      IF NEW."seriesId" IS NOT NULL THEN
        SELECT f."seriesId", f."companyId", f."recordType", f."recordId", f."kind"::text
          INTO first_series, first_company, first_record_type, first_record, first_kind
          FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."seriesId";
        IF NOT FOUND OR first_series IS NOT NULL THEN
          RAISE EXCEPTION 'files: version % of file % names a series by its first version, which is not there', NEW."versionNo", NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF (first_company, first_record_type, first_record, first_kind) IS DISTINCT FROM (NEW."companyId", NEW."recordType", NEW."recordId", NEW."kind"::text) THEN
          RAISE EXCEPTION 'files: a version (file %) is of its first version''s record, company and kind', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF first_kind = 'FISCAL_ARCHIVE' THEN
          RAISE EXCEPTION 'files: a fiscal archive file has no later version (file %); a correction is a new document', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM "StoredFile" v
                    WHERE v."tenantId" = NEW."tenantId" AND (v."id" = NEW."seriesId" OR v."seriesId" = NEW."seriesId") AND v."status" = 'PENDING_UPLOAD') THEN
          RAISE EXCEPTION 'files: a new version (file %) waits until the upload of the series'' earlier version is confirmed or given up', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT max(v."versionNo") + 1 INTO next_number FROM "StoredFile" v
         WHERE v."tenantId" = NEW."tenantId" AND (v."id" = NEW."seriesId" OR v."seriesId" = NEW."seriesId");
        IF NEW."versionNo" <> next_number THEN
          RAISE EXCEPTION 'files: the next version of the series is %, not % (file %)', next_number, NEW."versionNo", NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      IF NEW."sourceFileId" IS NOT NULL THEN
        SELECT s."sha256", s."sizeBytes", s."contentType", s."status"::text INTO source_sha256, source_size, source_type, source_status
          FROM "StoredFile" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sourceFileId";
        IF NOT FOUND OR source_status <> 'AVAILABLE' THEN
          RAISE EXCEPTION 'files: copy % names a source that is not an available file', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF (source_sha256, source_size, source_type) IS DISTINCT FROM (NEW."sha256", NEW."sizeBytes", NEW."contentType") THEN
          RAISE EXCEPTION 'files: copy % has its source''s bytes (the same SHA-256, size and type)', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."companyId", NEW."recordType", NEW."recordId", NEW."kind", NEW."originalName", NEW."contentType",
      NEW."sizeBytes", NEW."sha256", NEW."storeAccountId", NEW."storageKey", NEW."createdAt", NEW."createdById",
      NEW."seriesId", NEW."versionNo", NEW."sourceFileId")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."recordType", OLD."recordId", OLD."kind", OLD."originalName", OLD."contentType",
      OLD."sizeBytes", OLD."sha256", OLD."storeAccountId", OLD."storageKey", OLD."createdAt", OLD."createdById",
      OLD."seriesId", OLD."versionNo", OLD."sourceFileId") THEN
    RAISE EXCEPTION 'files: the content of file % never changes; a new version is a new file', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'DELETED'
     AND (NEW."status", NEW."visibility", NEW."floorSiteId", NEW."partyId", NEW."retainUntil", NEW."legalHold",
          NEW."quarantineReason", NEW."availableAt", NEW."deletedAt", NEW."scanStatus", NEW."scannedAt", NEW."scanEngine", NEW."scanFinding",
          NEW."supersededAt", NEW."expiresOn", NEW."expiryRemindedAt", NEW."thumbnailKey", NEW."exifStrippedAt")
         IS DISTINCT FROM
         (OLD."status", OLD."visibility", OLD."floorSiteId", OLD."partyId", OLD."retainUntil", OLD."legalHold",
          OLD."quarantineReason", OLD."availableAt", OLD."deletedAt", OLD."scanStatus", OLD."scannedAt", OLD."scanEngine", OLD."scanFinding",
          OLD."supersededAt", OLD."expiresOn", OLD."expiryRemindedAt", OLD."thumbnailKey", OLD."exifStrippedAt") THEN
    RAISE EXCEPTION 'files: file % is deleted; it changes no more', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."scanStatus" <> OLD."scanStatus"
     AND NOT ((OLD."scanStatus" = 'NOT_SCANNED' AND NEW."scanStatus" = 'PENDING')
              OR (OLD."scanStatus" = 'PENDING' AND NEW."scanStatus" IN ('CLEAN', 'INFECTED', 'FAILED'))
              OR (OLD."scanStatus" IN ('CLEAN', 'FAILED') AND NEW."scanStatus" = 'PENDING')) THEN
    RAISE EXCEPTION 'files: the scan of file % cannot move from % to %', OLD."id", OLD."scanStatus", NEW."scanStatus"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status"
     AND NOT ((OLD."status" = 'PENDING_UPLOAD' AND NEW."status" IN ('AVAILABLE', 'QUARANTINED', 'DELETED'))
              OR (OLD."status" IN ('AVAILABLE', 'QUARANTINED') AND NEW."status" = 'DELETED')
              OR (OLD."status" = 'QUARANTINED' AND NEW."status" = 'AVAILABLE' AND OLD."quarantineReason" = 'scan_pending'
                  AND OLD."scanStatus" = 'PENDING' AND NEW."scanStatus" = 'CLEAN')
              OR (OLD."status" = 'AVAILABLE' AND NEW."status" = 'QUARANTINED' AND NEW."scanStatus" = 'INFECTED')) THEN
    RAISE EXCEPTION 'files: file % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'AVAILABLE' AND OLD."status" <> 'AVAILABLE' AND NEW."scanStatus" NOT IN ('NOT_SCANNED', 'CLEAN') THEN
    RAISE EXCEPTION 'files: file % becomes available only unscanned (no scanner) or clean, not %', OLD."id", NEW."scanStatus"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'DELETED' AND OLD."status" <> 'DELETED'
     AND (NEW."legalHold" OR (NEW."retainUntil" IS NOT NULL AND NEW."retainUntil" > now())) THEN
    RAISE EXCEPTION 'files: file % is retained (legal hold or retention date); it cannot be deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."retainUntil" IS NOT NULL AND (NEW."retainUntil" IS NULL OR NEW."retainUntil" < OLD."retainUntil") THEN
    RAISE EXCEPTION 'files: the retention date of file % only moves later', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- W2b wave 18/22.
  IF OLD."supersededAt" IS NOT NULL THEN
    IF (to_jsonb(NEW) - superseded_moves) IS DISTINCT FROM (to_jsonb(OLD) - superseded_moves) THEN
      RAISE EXCEPTION 'files: file % is a superseded version: it stays as it is (only its deletion, scan, retention, thumbnail and a narrower sharing change)', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT (NEW."visibility" <@ OLD."visibility")
       OR (NEW."floorSiteId" IS NOT NULL AND NEW."floorSiteId" IS DISTINCT FROM OLD."floorSiteId")
       OR (NEW."partyId" IS NOT NULL AND NEW."partyId" IS DISTINCT FROM OLD."partyId") THEN
      RAISE EXCEPTION 'files: file % is a superseded version: it is never shared more widely (no new audience, floor or party)', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW."supersededAt" IS NOT NULL AND "factory_quality_plant_in_scope"(NEW."tenantId", NULL) IS TRUE THEN
    root := coalesce(OLD."seriesId", OLD."id");
    IF NOT EXISTS (SELECT 1 FROM "StoredFile" l
                    WHERE l."tenantId" = NEW."tenantId" AND (l."id" = root OR l."seriesId" = root)
                      AND l."versionNo" > OLD."versionNo" AND l."status" = 'AVAILABLE') THEN
      RAISE EXCEPTION 'files: file % is superseded only once a later version of its series is available', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."expiresOn" IS DISTINCT FROM OLD."expiresOn" THEN
    IF NEW."expiryRemindedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'files: a new expiry date of file % starts without a reminder', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF OLD."expiryRemindedAt" IS NOT NULL AND (NEW."expiryRemindedAt" IS NULL OR NEW."expiryRemindedAt" < OLD."expiryRemindedAt") THEN
    RAISE EXCEPTION 'files: the expiry reminder of file % only moves later', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."thumbnailKey", NEW."exifStrippedAt") IS DISTINCT FROM (OLD."thumbnailKey", OLD."exifStrippedAt")
     AND (OLD."thumbnailKey" IS NOT NULL OR NEW."status" <> 'AVAILABLE') THEN
    RAISE EXCEPTION 'files: the thumbnail of file % is made once, while the file is AVAILABLE, and never changes', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- Data (D1), once. Only the new column (and requireMfa) is written: no version, no updatedAt. Every StoredFile and Role
-- trigger holds as it is (the StoredFile guard above lets a superseded or deleted file take the mark).

-- The files that show prices: the confirmations, price lists, proformas (of a shipment, a sample shipment or a deposit
-- request) and commercial invoices the documents platform made (GeneratedDocument), a shipment pack made once the
-- shipment had a proforma or a commercial invoice (it may hold one), every invoice's PDF copy, every sent quote (the
-- quote's fiscal archive PDF), every payment reminder letter, every statement sent (its audit row names the file).
UPDATE "StoredFile" f
   SET "priced" = true
 WHERE NOT f."priced"
   AND (f."id" IN (SELECT g."fileId" FROM "GeneratedDocument" g WHERE g."kind" IN ('ORDER_CONFIRMATION', 'PRICE_LIST', 'PROFORMA', 'COMMERCIAL_INVOICE'))
        OR f."id" IN (SELECT g."fileId" FROM "GeneratedDocument" g
                       WHERE g."kind" = 'SHIPMENT_PACK'
                         AND EXISTS (SELECT 1 FROM "GeneratedDocument" p
                                      WHERE p."tenantId" = g."tenantId" AND p."recordType" = g."recordType" AND p."recordId" = g."recordId"
                                        AND p."kind" IN ('PROFORMA', 'COMMERCIAL_INVOICE') AND p."createdAt" <= g."createdAt"))
        OR f."id" IN (SELECT i."pdfFileId" FROM "Invoice" i WHERE i."pdfFileId" IS NOT NULL)
        OR (f."recordType" = 'Quote' AND f."kind" = 'FISCAL_ARCHIVE')
        OR f."recordType" = 'PaymentReminder'
        OR f."id" IN (SELECT (a."after"->>'fileId')::uuid FROM "AuditLog" a
                       WHERE a."action" = 'receivables.sendStatement'
                         AND a."after"->>'fileId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));

-- Their copies and every version of their series, until nothing more moves (a copy of a copy, a version of a copy).
DO $$
DECLARE
  moved integer;
  rounds integer := 0;
BEGIN
  LOOP
    UPDATE "StoredFile" f
       SET "priced" = true
     WHERE NOT f."priced"
       AND EXISTS (SELECT 1 FROM "StoredFile" p
                    WHERE p."tenantId" = f."tenantId" AND p."priced"
                      AND (p."id" = f."sourceFileId"
                           OR p."id" = f."seriesId" OR p."seriesId" = f."id"
                           OR (p."seriesId" IS NOT NULL AND p."seriesId" = f."seriesId")));
    GET DIAGNOSTICS moved = ROW_COUNT;
    rounds := rounds + 1;
    EXIT WHEN moved = 0 OR rounds >= 20;
  END LOOP;
END
$$;

-- Two-factor for every custom office role that sees prices, costs or margins (plan O6; system roles follow their templates,
-- B-CP-011). An archived role changes no more (…_security_audit_w2b_guards), so it is left as it is. requireMfaSince is the
-- database's (…_followups_platform_w2b_guards).
UPDATE "Role" r
   SET "requireMfa" = true
 WHERE r."audience" = 'OFFICE' AND NOT r."system" AND NOT r."requireMfa" AND r."archivedAt" IS NULL
   AND r."grains" && ARRAY['price', 'cost', 'margin']::text[];

DO $$
DECLARE
  priced_files integer;
  mfa_roles integer;
BEGIN
  SELECT count(*) INTO priced_files FROM "StoredFile" WHERE "priced";
  SELECT count(*) INTO mfa_roles FROM "Role" WHERE "audience" = 'OFFICE' AND NOT "system" AND "requireMfa" AND "grains" && ARRAY['price', 'cost', 'margin']::text[];
  RAISE NOTICE 'customer page (B-CP-005): % file(s) are priced; % custom office role(s) that see prices, costs or margins ask for two-factor', priced_files, mfa_roles;
END
$$;
