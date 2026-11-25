-- Written by hand (Prisma does not model triggers), after the generated 202611250100_order_start_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The order start's ONE schema wave ("order start 1/1", OD s.1; design order-start-2026-11-25 13-backend §1, plan §5; Owner's
-- yes 2026-11-25 1a + 2a: the office writes a customer's draft with orders.manage and may confirm a draft the customer never
-- sent; the Owner's change of 2026-11-25 10:12, build/briefs/od-addendum-r1.md R1-R3: "we should not keep any requirements
-- at all" — a draft is a mail (a subject, a message, attachments) and ONE products table whose every cell is optional, and
-- Send needs nothing). apps/factory-api checks all of this first and answers in words (OD s.2 the writer, s.3 the office routes and Make style
-- draft, s.4 the Send rule, the choices and Confirm); these rules are the last word, for every login, the owner included. The
-- refusals are check_violation (SQLSTATE 23514); their words name no other customer (the brand wall: "One brand must not be
-- able to see anything related to any other brand") and no office person.
--
-- DATA, first (before anything is redefined): PortalOrderRequestLine.sizing back-filled once from each existing line's kind
-- and pieces — MADE_TO_MEASURE kind → MADE_TO_MEASURE; else a line with size rows, a total, or by person with its people or a
-- measurement sheet on it → STANDARD; else null ("Not decided yet"). A line of a sent or decided request never changes for any
-- login (PortalOrderRequestLine_guard), so that guard is off for this one statement: only the new column is written (no
-- version, no updatedAt). It lives here, not in the generated 202611250100_order_start_schema: a generated folder is deleted
-- and generated again when the lead re-stamps the wave (CLAUDE.md "A schema change" step 4), a hand-written one is kept.
-- A NOTICE says how many lines took each value.
--
-- NEW here:
--   factory_portal_draft_choices_ok(jsonb)            IMMUTABLE: a draft line's open choices — an array of 1 to 10 objects,
--                                                     each with exactly topic (a string of 1 to 60 trimmed characters),
--                                                     options (an array of 2 to 6 distinct strings of 1 to 60 trimmed
--                                                     characters) and picked (null: "Not decided yet", or one of the
--                                                     options). '[]' is refused: no choice at all is SQL null, one way only.
--   factory_portal_order_request_style_drafts_check   + trigger PortalOrderRequest_style_drafts_check (AFTER INSERT OR UPDATE
--                                                     OF "styleIds"): a copy of factory_inquiry_style_drafts_check
--                                                     (…_sales_intake_orders_th_guards, B-TH-026) without its party-change
--                                                     part (a request's customer never changes): at most 50 styles, each
--                                                     once, none at insert, only added after the ones named before; each a
--                                                     style of the tenant, of the request's company or tenant-wide, never
--                                                     another customer's private label (factory_intake_style_allowed).
--
-- Earlier functions REDEFINED here, each ONCE, from its newest body, word for word but for the lines marked OD s.1:
--   factory_portal_order_request_guard       (…_customer_page_guards, B-CP-005: its newest; no later migration redefines it)
--                                            (1) the office edits a DRAFT (the raise "draft % is the customer's" is dropped;
--                                            the partner keeps the draft columns, the office gets them + styleIds);
--                                            (2) NEW move SENT → SENT, office only: styleIds, version, updatedAt (design work
--                                            on a sent, undecided request; a partner raises); (3) a new request starts with
--                                            no style draft (cardinality("styleIds") = 0); (4) the B-CP-005 count of lines
--                                            without pieces is dropped; (5) NEW draft column subject (both doors; NULL or 1 to
--                                            200 trimmed characters); (6) Send needs NOTHING: the "at least one line" raise
--                                            and its count are dropped too (addendum R1); the date rule stays.
--   factory_portal_order_request_line_guard  (…_customer_page_guards, B-CP-005: its newest; no later migration redefines it)
--                                            (1) the line's choices are null or pass factory_portal_draft_choices_ok; RELAXED
--                                            (addendum R3, every cell optional): (2) a CATALOGUE line needs its style, its
--                                            colourway may wait; (3) a DESCRIBED line may have no words yet; (4) a
--                                            MADE_TO_MEASURE line may have no garment type yet (still by person); NEW (5) the
--                                            kind is MADE_TO_MEASURE exactly when sizing is MADE_TO_MEASURE. Kept: a colourway
--                                            only with its style; a line that has people stays by person; every write only
--                                            while the request is a DRAFT (frozen at Send). Nothing pins a line's kind: it
--                                            changes with its sizing in one update, while DRAFT.
-- Their triggers stay as they are. VERIFIED, NOT REDEFINED: factory_portal_order_request_size_guard (…_portal_sales_w2b_guards)
-- and factory_portal_order_request_person_guard (…_customer_page_guards) check no role: an office write of a DRAFT's sizes and
-- people passes them as the customer's does (the grants come with the policy migration after this file). The office already
-- sends a draft (its send columns) and SENT → ACCEPTED in the same command passes (decidedAt is not before sentAt at the same
-- instant). USED FROM EARLIER WAVES, as they are: "factory_styles_distinct" (…_styles_libraries_w2b_guards),
-- "factory_intake_style_allowed" (…_sales_intake_portal_th_guards), "factory_money_rome_day" (…_money_w2a_guards, in the
-- request guard as before). The other new columns start empty (styleIds []) or null (subject, choices).

-- =====================================================================================================================
-- DATA (OD s.1, addendum R3): every existing line's sizing, once. The line guard is off for this one statement only.
ALTER TABLE "PortalOrderRequestLine" DISABLE TRIGGER "PortalOrderRequestLine_guard";
UPDATE "PortalOrderRequestLine" l
   SET "sizing" = x.sizing
  FROM (
    SELECT c."id",
           CASE
             WHEN c."kind" = 'MADE_TO_MEASURE' THEN 'MADE_TO_MEASURE'::"PortalDraftSizing"
             WHEN EXISTS (SELECT 1 FROM "PortalOrderRequestSize" s WHERE s."tenantId" = c."tenantId" AND s."lineId" = c."id")
                  OR c."quantity" IS NOT NULL
                  OR (c."byPerson"
                      AND (EXISTS (SELECT 1 FROM "PortalOrderRequestPerson" p WHERE p."tenantId" = c."tenantId" AND p."lineId" = c."id")
                           OR EXISTS (SELECT 1 FROM "StoredFile" f
                                       WHERE f."tenantId" = c."tenantId" AND f."recordType" = 'PortalOrderRequestLine' AND f."recordId" = c."id"
                                         AND f."category" = 'MEASUREMENTS' AND f."status" <> 'DELETED')))
               THEN 'STANDARD'::"PortalDraftSizing"
             ELSE NULL
           END AS sizing
      FROM "PortalOrderRequestLine" c
  ) x
 WHERE x."id" = l."id" AND x.sizing IS NOT NULL;
ALTER TABLE "PortalOrderRequestLine" ENABLE TRIGGER "PortalOrderRequestLine_guard";

DO $$
DECLARE
  standard integer;
  made_to_measure integer;
  open_lines integer;
BEGIN
  SELECT count(*) FILTER (WHERE "sizing" = 'STANDARD'), count(*) FILTER (WHERE "sizing" = 'MADE_TO_MEASURE'), count(*) FILTER (WHERE "sizing" IS NULL)
    INTO standard, made_to_measure, open_lines FROM "PortalOrderRequestLine";
  RAISE NOTICE 'order start (OD s.1): % request line(s) sized STANDARD, % MADE_TO_MEASURE, % not decided yet', standard, made_to_measure, open_lines;
END
$$;

-- =====================================================================================================================
-- A draft line's open choices (OD s.1; 13-backend §1a): null is none (the line guard checks a non-null value only).
CREATE FUNCTION "factory_portal_draft_choices_ok"(choices jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry jsonb;
  option jsonb;
  topic text;
  options text[];
  value text;
BEGIN
  IF choices IS NULL OR jsonb_typeof(choices) <> 'array' OR jsonb_array_length(choices) < 1 OR jsonb_array_length(choices) > 10 THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT e FROM jsonb_array_elements(choices) AS t(e) LOOP
    IF jsonb_typeof(entry) <> 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(entry) AS t(k)) IS DISTINCT FROM ARRAY['options', 'picked', 'topic']
       OR jsonb_typeof(entry -> 'topic') <> 'string'
       OR jsonb_typeof(entry -> 'options') <> 'array'
       OR jsonb_typeof(entry -> 'picked') NOT IN ('string', 'null') THEN
      RETURN false;
    END IF;
    topic := entry ->> 'topic';
    IF btrim(topic) <> topic OR length(topic) < 1 OR length(topic) > 60 THEN
      RETURN false;
    END IF;
    IF jsonb_array_length(entry -> 'options') < 2 OR jsonb_array_length(entry -> 'options') > 6 THEN
      RETURN false;
    END IF;
    options := ARRAY[]::text[];
    FOR option IN SELECT o FROM jsonb_array_elements(entry -> 'options') AS t(o) LOOP
      IF jsonb_typeof(option) <> 'string' THEN
        RETURN false;
      END IF;
      value := option #>> '{}';
      IF btrim(value) <> value OR length(value) < 1 OR length(value) > 60 OR value = ANY (options) THEN
        RETURN false;
      END IF;
      options := options || value;
    END LOOP;
    IF jsonb_typeof(entry -> 'picked') = 'string' AND NOT ((entry ->> 'picked') = ANY (options)) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$$;

-- =====================================================================================================================
-- PortalOrderRequest (portal-sales.prisma): REDEFINES factory_portal_order_request_guard (…_customer_page_guards, B-CP-005:
-- its newest), word for word but for the lines marked OD s.1 (1)-(6): the office edits a DRAFT and names its style drafts;
-- SENT → SENT for the style drafts, office only; a new request starts with none; its subject; Send needs nothing (no line, no
-- pieces). Its trigger stays as it is.
CREATE OR REPLACE FUNCTION "factory_portal_order_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  partner CONSTANT boolean := current_user = 'factory_partner_runtime';
  kept CONSTANT text[] := ARRAY['tenantId'];
  -- B-CP-005: the parts sent later and who saved it last are draft columns too. OD s.1 (5): and the subject (both doors).
  draft_columns CONSTANT text[] := ARRAY['source', 'customerRef', 'shipToAddressId', 'requestedDate', 'note', 'currency', 'laterParts', 'lastEditedById', 'lastEditedAt', 'subject', 'version', 'updatedAt'];
  send_columns CONSTANT text[] := ARRAY['status', 'number', 'sentAt', 'sentById', 'version', 'updatedAt'];
  decide_columns CONSTANT text[] := ARRAY['status', 'decidedAt', 'decidedById', 'refuseReason', 'salesOrderId', 'quoteId', 'version', 'updatedAt'];
  withdraw_columns CONSTANT text[] := ARRAY['status', 'withdrawnAt', 'version', 'updatedAt'];
  allowed text[];
  sent boolean;
  decided boolean;
  address_kinds text[];
  address_status text;
  quote_company uuid;
  -- OD s.1 (4), (6): line_count and empty_lines dropped with the rules that counted them (Send needs nothing).
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
    -- OD s.1 (3): a new request starts with no style draft made for it (the style drafts check says the same: it also reads
    -- every later change of the list; this guard keeps the insert's whole shape in one place).
    IF coalesce(cardinality(NEW."styleIds"), -1) <> 0 THEN
      RAISE EXCEPTION 'portal: a new order request starts with no style draft made for it yet'
        USING ERRCODE = 'check_violation';
    END IF;
    -- end OD s.1 (3)
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
      -- OD s.1 (1): the office edits a DRAFT too (the API checks orders.manage over the company and the customer, Owner's yes
      -- 1a); only the office names the style drafts it made for it.
      allowed := draft_columns;
      IF NOT partner THEN
        allowed := draft_columns || ARRAY['styleIds'];
      END IF;
      -- end OD s.1 (1)
    -- OD s.1 (2): a SENT request, not decided yet, stays SENT while the office names the style drafts it made for it (design
    -- work goes on after the customer's Send); nothing else of it changes, and the customer changes nothing of it.
    ELSIF OLD."status" = 'SENT' AND NEW."status" = 'SENT' THEN
      IF partner THEN
        RAISE EXCEPTION 'portal: order request % was sent; only the office names the style drafts it made for it', OLD."number"
          USING ERRCODE = 'check_violation';
      END IF;
      allowed := ARRAY['styleIds', 'version', 'updatedAt'];
    -- end OD s.1 (2)
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
  -- OD s.1 (5): the subject, as a mail's: none (null) or 1 to 200 trimmed characters.
  IF NEW."subject" IS NOT NULL AND (btrim(NEW."subject") <> NEW."subject" OR NEW."subject" = '' OR length(NEW."subject") > 200) THEN
    RAISE EXCEPTION 'portal: order request % has a subject of 1 to 200 trimmed characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- end OD s.1 (5)
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
    -- OD s.1 (4), (6) (addendum R1): Send needs NOTHING — no line, no pieces (what the order needs is asked at the office's
    -- Confirm). The B-CP-005 count of the lines and of the lines without pieces, and both its raises, are dropped.
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
-- PortalOrderRequestLine (portal-sales.prisma): REDEFINES factory_portal_order_request_line_guard (…_customer_page_guards,
-- B-CP-005: its newest), word for word but for the lines marked OD s.1 (1)-(5): the line's open choices (choices, names only)
-- are none (null) or 1 to 10 {topic, options, picked}; every cell optional (addendum R3: a catalogue line's colourway, a
-- described line's words, a made-to-measure line's garment type may wait); made to measure exactly when its sizing says so.
-- Like every line column they change only while the request is a DRAFT. Its trigger stays as it is.
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
  -- OD s.1 (2): a CATALOGUE line names its style, its colourway may wait (was: both). OD s.1 (3): a DESCRIBED line may have no
  -- words yet (was: required). OD s.1 (4): a MADE_TO_MEASURE line may have no garment type yet (was: required); still by person.
  IF (NEW."kind" = 'CATALOGUE' AND NEW."styleId" IS NULL)
     OR (NEW."kind" = 'MADE_TO_MEASURE' AND NOT NEW."byPerson")
     OR (NEW."colourwayId" IS NOT NULL AND NEW."styleId" IS NULL) THEN
    RAISE EXCEPTION 'portal: request line % (%) names its style when from the catalogue (its colourway may wait), its people when made to measure; a colourway only with its style', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  -- end OD s.1 (2)-(4)
  -- OD s.1 (5): made to measure exactly when its sizing says so (null sizing: not decided yet, never made to measure).
  IF (NEW."kind" = 'MADE_TO_MEASURE') <> (NEW."sizing" IS NOT DISTINCT FROM 'MADE_TO_MEASURE') THEN
    RAISE EXCEPTION 'portal: request line % is made to measure exactly when its sizing is MADE_TO_MEASURE (it is %, sized %)', NEW."id", NEW."kind", coalesce(NEW."sizing"::text, 'not yet')
      USING ERRCODE = 'check_violation';
  END IF;
  -- end OD s.1 (5)
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
  -- OD s.1 (1): the line's open choices, names only: none (null), or 1 to 10 {topic, options, picked} (factory_portal_draft_choices_ok).
  IF NEW."choices" IS NOT NULL AND NOT "factory_portal_draft_choices_ok"(NEW."choices") THEN
    RAISE EXCEPTION 'portal: request line % has its open choices as 1 to 10 entries, each a topic of 1 to 60 trimmed characters, 2 to 6 distinct options of 1 to 60 trimmed characters, and the one picked (one of them) or none yet; no choice at all is null', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- end OD s.1 (1)
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- PortalOrderRequest: the style drafts the office made for it (OD s.1; 13-backend §1c; a copy of
-- factory_inquiry_style_drafts_check, B-TH-026, without its party-change part: a request's customer never changes).
CREATE FUNCTION "factory_portal_order_request_style_drafts_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  before_count integer := CASE WHEN TG_OP = 'UPDATE' THEN coalesce(cardinality(OLD."styleIds"), 0) ELSE 0 END;
  added uuid[];
  style_company uuid;
  style_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."styleIds" IS NOT DISTINCT FROM OLD."styleIds" THEN
    RETURN NULL;
  END IF;
  IF NEW."styleIds" IS NULL OR cardinality(NEW."styleIds") > 50 OR NOT "factory_styles_distinct"(NEW."styleIds") THEN
    RAISE EXCEPTION 'portal: the style drafts made for order request % are at most 50 styles, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND cardinality(NEW."styleIds") > 0 THEN
    RAISE EXCEPTION 'portal: order request % starts with no style draft made for it yet', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (cardinality(NEW."styleIds") < before_count OR NEW."styleIds"[1:before_count] IS DISTINCT FROM OLD."styleIds"[1:before_count]) THEN
    RAISE EXCEPTION 'portal: the style drafts made for order request % are only added, after the ones named before; none is taken off or moved', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  added := NEW."styleIds"[before_count + 1:cardinality(NEW."styleIds")];
  FOREACH style_id IN ARRAY coalesce(added, ARRAY[]::uuid[]) LOOP
    SELECT s."companyId" INTO style_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = style_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'portal: order request % names %, which is not a style of the tenant, as a style draft made for it', NEW."id", style_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF style_company IS NOT NULL AND style_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'portal: order request % names style % of another company as a style draft made for it', NEW."id", style_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_intake_style_allowed"(NEW."tenantId", style_id, NEW."partyId") THEN
      RAISE EXCEPTION 'portal: order request % names another customer''s private-label style as a style draft made for it; a private-label style is made only for its own customer', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
CREATE TRIGGER "PortalOrderRequest_style_drafts_check" AFTER INSERT OR UPDATE OF "styleIds" ON "PortalOrderRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_portal_order_request_style_drafts_check"();
