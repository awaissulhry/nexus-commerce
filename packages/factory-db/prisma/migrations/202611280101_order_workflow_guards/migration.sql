-- Written by hand (Prisma does not model triggers), after the generated 202611280100_order_workflow_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The order workflow's ONE schema wave ("order workflow 1/1", lane owb-, base PR b1; design order-workflow-build-2026-11-27
-- plan.md § 4, plan/PL-schema.md § 3-5A, plan/PL-review.md § 2.8 and § 4; the Owner's yes of 2026-11-28 07:22 on plan.md,
-- § 5 A-K; lead 88's yes of 07:50 on G10 (b)). apps/factory-api checks all of this first and answers in words (the five
-- sessions' server steps); these rules are the last word, for every login, the owner included. The refusals are
-- check_violation (SQLSTATE 23514); their words name no other customer (the brand wall: "One brand must not be able to see
-- anything related to any other brand") and no office person. The new checks are AFTER triggers (the policies speak first);
-- the append-only triggers and the two redefined functions keep the BEFORE or AFTER of their neighbours. A rule that reads
-- another row reads only what the role that fires it may read and skips a row this session cannot see — except a file a
-- record names as its picture, its proof or its label: one this session cannot open is refused, never skipped.
--
-- NEW here (PL-schema § 5A, guards G2-G9 and G11):
--   factory_order_workflow_refuse_truncate        BEFORE TRUNCATE on every new table that is not append-only (the
--                                                 append-only ones use factory_refuse_production_ledger_change).
--   factory_order_picture_check (G2)              + triggers SalesOrder_picture_check, PortalOrderRequest_picture_check
--                                                 (AFTER INSERT OR UPDATE OF "pictureFileId", "pictureSetAt",
--                                                 "pictureSetById"): the three all or none; the file one everybody on the
--                                                 order may see (an image or a PDF; never a fiscal archive, a voice note,
--                                                 body data or a priced file; of no other customer).
--   factory_department_guard (G3)                 + triggers Department_guard, Department_no_truncate: a number of 1 or
--                                                 more, given once, never reused (no DELETE: CLOSED); a department ready
--                                                 on the floor keeps its name and never closes; one of the ten grid
--                                                 tones; an icon id.
--   index Operation_one_department_default (G3)   one default library operation per department.
--   factory_operation_department_check (G3)       + triggers Operation_department_check, RoutingOperation_department_check:
--                                                 the department named is open (not CLOSED) and of no other company; the
--                                                 default operation names its department.
--   factory_order_team_guard (G4)                 + triggers OrderTeam_guard, OrderTeam_no_truncate; indexes
--                                                 OrderTeam_one_in_charge, OrderTeam_team_once: one open team in charge
--                                                 per order, a team once per order among the open rows, a share of 1 or
--                                                 more, the baskets of the order's work orders at the team's site, a
--                                                 basket with one open team at a time, an ended row never changes, no
--                                                 DELETE.
--   OrderPrint, BasketMove, BasketRouteEdit (G5)  append-only: triggers <Table>_append_only, <Table>_no_truncate
--                                                 (factory_refuse_production_ledger_change, as BundleReprint's), and
--   factory_order_print_check                     + trigger OrderPrint_check: a first print gives no reason; a print
--                                                 again gives one; a small change says what in words.
--   factory_basket_move_check                     + trigger BasketMove_check; index BasketMove_undo_once: the steps are
--                                                 steps of the basket's work order; a move back gives its reason; an
--                                                 UNDO names an earlier hand move of the same basket, once.
--   factory_basket_route_edit_check               + trigger BasketRouteEdit_check: the step and the basket are of the
--                                                 edit's work order.
--   factory_floor_late_warning_guard (G6)         + triggers FloorLateWarning_guard, FloorLateWarning_no_truncate: born
--                                                 OPEN; answered once, OPEN → KEPT or CHANGED, with when and who.
--   factory_payment_notice_guard (G7)             + triggers PaymentNotice_guard, PaymentNotice_no_truncate: born OPEN;
--                                                 answered once by the office, OPEN → RECORDED or DISMISSED; nothing else
--                                                 changes; never deleted.
--   factory_party_line_column_guard (G8)          + triggers PartyLineColumn_guard, PartyLineColumn_no_truncate; index
--                                                 PartyLineColumn_open_name: a name of 1 to 40, once among the
--                                                 customer's open columns; the choices of a CHOICE column; closed once,
--                                                 never deleted.
--   factory_order_line_column_use_check (G8)      + triggers OrderLineColumnUse_check, OrderLineColumnUse_no_truncate:
--                                                 exactly one record, of its own company.
--   factory_order_line_own_value_check (G8)       + triggers OrderLineOwnValue_check, OrderLineOwnValue_no_truncate:
--                                                 exactly one line; only the field its column's kind needs.
--   factory_shipment_warehouse_leg_guard (G9)     + triggers ShipmentWarehouseLeg_guard, ShipmentWarehouseLeg_no_truncate:
--                                                 a WAREHOUSE site of the shipment's company; arrived only while the
--                                                 shipment is SHIPPED, once; sent on only after it arrived, once; the
--                                                 label a CUSTOMER_LABEL file of the shipment; no DELETE.
--   factory_shipment_warehouse_leg_delivered_check (G9) + trigger Shipment_warehouse_leg_delivered (BEFORE UPDATE OF
--                                                 "status" ON "Shipment", WHEN it becomes DELIVERED): refused while a leg
--                                                 waits to be sent on. No shipment function is redefined.
--   factory_party_office_person_guard (G11)       + triggers PartyOfficePerson_guard, PartyOfficePerson_no_truncate; index
--                                                 PartyOfficePerson_one_open: an active office person of the tenant, one
--                                                 open row per customer and person, ended once, never deleted.
--
-- Earlier functions REDEFINED here, each ONCE, from its newest body, word for word but for the lines marked owb G1 / owb G10:
--   factory_portal_order_request_guard  (…_order_start_guards, OD s.1: its newest; no later migration redefines it)
--                                       (a) the picture's three columns are draft columns (both doors); (b) SENT → SENT: the
--                                       office changes the style drafts and the picture, the customer the picture only (was:
--                                       nothing); (c) NEW SENT → DRAFT "Take it back" (both doors): only the status, when and
--                                       who sent it (cleared), the version and updatedAt — the number stays, and a later Send
--                                       keeps it; (c2) refused once the factory acted on it (the office named a style draft
--                                       for it, PL-review § 2.8); (d) SENT and after has its number, a DRAFT may keep the
--                                       number of an earlier Send (was: the number exactly from SENT on), and the number,
--                                       once given, never changes; (e) a DRAFT with a number is never deleted: it moves DRAFT
--                                       → WITHDRAWN instead.
--   factory_bundle_guard                (…_production_leftovers_guards, B-W1-40/41: its newest; no later migration redefines
--                                       it) (a) a basket made at Print and start the work (madeAtPrint) only on a site whose
--                                       ProductionSettings.basketsAtPrint is on, and with no cut log entry yet; (b) such a
--                                       basket, while ACTIVE, takes the cut log entries of the hides cut for it later, and
--                                       they only grow (every entry it names stays; each new one passes the insert's own
--                                       check) — every other bundle's entries still never change; (c) madeAtPrint never
--                                       changes (outside `changing`: the whole-row compare keeps it).
-- Their triggers stay as they are.
--
-- VERIFIED, NOT REDEFINED:
--   factory_portal_order_request_line_guard (…_order_start_guards), factory_portal_order_request_size_guard
--   (…_portal_sales_w2b_guards) and factory_portal_order_request_person_guard (…_customer_page_guards) read only the
--   request's status (a line, its sizes and its people change only while it is a DRAFT): a request taken back is a DRAFT
--   again and its lines are edited as before; none of them reads the number, sentAt or sentById.
--   factory_style_revision_part_guard (…_product_guards) freezes every column of a RoutingOperation of a revision that is
--   not DRAFT, departmentId included: a step's department is frozen with its revision.
--   factory_sales_order_guard (…_delivery_customs_w2b_guards) freezes a CLOSED or CANCELLED order whole (its picture and its
--   floor restriction too) and leaves an open order's new columns free.
--   No FileCategory list of an earlier guard is one the customer's label or the order's picture must pass (g.10: the
--   lists are the floor's maintenance photos, a change's photos, the supplier vault's categories and the made-to-measure
--   photos), so CUSTOMER_LABEL joins none.
-- USED FROM EARLIER WAVES, as they are: "factory_refuse_production_ledger_change" (…_production_guards),
-- "factory_file_record_party" (…_files_record_party_th_guards), "factory_files_type_of" and "factory_files_is_design_type"
-- (…_files_measurements_th_guards), "factory_money_rome_day" (…_money_w2a_guards, in the request guard as before).
-- The new enum value FileCategory.CUSTOMER_LABEL is added by the schema folder before this one (another transaction).

CREATE FUNCTION "factory_order_workflow_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order workflow: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- =====================================================================================================================
-- PortalOrderRequest (portal-sales.prisma): REDEFINES factory_portal_order_request_guard (…_order_start_guards, OD s.1: its
-- newest), word for word but for the lines marked owb G1 (a)-(e): the order's picture is a draft column of both doors and the
-- one thing the customer changes of a sent request; "Take it back" (SENT → DRAFT, both doors) keeps the number, refused once
-- the office named a style draft for it; a later Send keeps the number; a draft with a number is withdrawn, never discarded.
-- Its trigger stays as it is.
CREATE OR REPLACE FUNCTION "factory_portal_order_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  partner CONSTANT boolean := current_user = 'factory_partner_runtime';
  kept CONSTANT text[] := ARRAY['tenantId'];
  -- B-CP-005: the parts sent later and who saved it last are draft columns too. OD s.1 (5): and the subject (both doors).
  -- owb G1 (a): and the order's picture, its three columns (both doors).
  draft_columns CONSTANT text[] := ARRAY['source', 'customerRef', 'shipToAddressId', 'requestedDate', 'note', 'currency', 'laterParts', 'lastEditedById', 'lastEditedAt', 'subject', 'pictureFileId', 'pictureSetAt', 'pictureSetById', 'version', 'updatedAt'];
  send_columns CONSTANT text[] := ARRAY['status', 'number', 'sentAt', 'sentById', 'version', 'updatedAt'];
  decide_columns CONSTANT text[] := ARRAY['status', 'decidedAt', 'decidedById', 'refuseReason', 'salesOrderId', 'quoteId', 'version', 'updatedAt'];
  withdraw_columns CONSTANT text[] := ARRAY['status', 'withdrawnAt', 'version', 'updatedAt'];
  -- owb G1 (b): the picture of a sent request (both doors). owb G1 (c): "Take it back", SENT → DRAFT (both doors).
  picture_columns CONSTANT text[] := ARRAY['pictureFileId', 'pictureSetAt', 'pictureSetById'];
  take_back_columns CONSTANT text[] := ARRAY['status', 'sentAt', 'sentById', 'version', 'updatedAt'];
  -- end owb G1 (b), (c)
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
    -- owb G1 (e): a draft taken back keeps the number of its earlier Send: it is withdrawn, never discarded.
    IF OLD."number" IS NOT NULL THEN
      RAISE EXCEPTION 'portal: order request % was sent once and keeps its number; it is withdrawn, never discarded', OLD."number"
        USING ERRCODE = 'check_violation';
    END IF;
    -- end owb G1 (e)
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
      -- owb G1 (b): the order's picture changes while SENT too (design § 5zj A, O96: "change the thumbnails of the orders
      -- already sent"): the customer changes it and nothing else (was: nothing at all); the office the style drafts and it.
      IF partner THEN
        allowed := picture_columns || ARRAY['version', 'updatedAt'];
        IF (to_jsonb(NEW) - (kept || allowed)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || allowed)) THEN
          RAISE EXCEPTION 'portal: order request % was sent; the customer changes only its picture (the office names the style drafts it made for it)', OLD."number"
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        allowed := ARRAY['styleIds'] || picture_columns || ARRAY['version', 'updatedAt'];
      END IF;
      -- end owb G1 (b)
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
    -- owb G1 (c): NEW move SENT → DRAFT, "Take it back" (design § 5zi; the customer's portal or the office, before the factory
    -- decided): only the status, when and who sent it (both cleared, the state rule below), the version and updatedAt change;
    -- the number stays (it is not among them) and a later Send keeps it (the number rule below). A DRAFT again: its header,
    -- lines, sizes and people are edited as before (their guards read only the status).
    ELSIF OLD."status" = 'SENT' AND NEW."status" = 'DRAFT' THEN
      -- owb G1 (c2) (PL-review § 2.8): refused once the factory acted on it — the office named a style draft for it (taking it
      -- back would leave that work behind).
      IF coalesce(cardinality(OLD."styleIds"), 0) > 0 THEN
        RAISE EXCEPTION 'portal: the factory already started work on request %; ask the factory', OLD."number"
          USING ERRCODE = 'check_violation';
      END IF;
      -- end owb G1 (c2)
      allowed := take_back_columns;
    -- owb G1 (e): a draft taken back (it has the number of its earlier Send) is withdrawn as a sent one is, with when; a draft
    -- that was never sent is discarded instead (DELETE), never withdrawn.
    ELSIF OLD."status" = 'DRAFT' AND NEW."status" = 'WITHDRAWN' THEN
      IF OLD."number" IS NULL THEN
        RAISE EXCEPTION 'portal: order request % was never sent; a draft is discarded, not withdrawn', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      allowed := withdraw_columns;
    -- end owb G1 (c), (e)
    ELSE
      -- owb G1 (c), (e): the words name the two new moves.
      RAISE EXCEPTION 'portal: order request % moves DRAFT → SENT → ACCEPTED, REFUSED or WITHDRAWN (SENT → DRAFT when taken back; a draft taken back → WITHDRAWN), not % → %', coalesce(OLD."number", OLD."id"::text), OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - (kept || allowed)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || allowed)) THEN
      RAISE EXCEPTION 'portal: order request % (% → %) changes only %', coalesce(OLD."number", OLD."id"::text), OLD."status", NEW."status", array_to_string(allowed, ', ')
        USING ERRCODE = 'check_violation';
    END IF;
    -- owb G1 (c), (d): the number is given once, at the first Send, and never changes again: a Send after "Take it back" sends
    -- the request under the same number (only DRAFT → SENT may write the number at all).
    IF OLD."number" IS NOT NULL AND NEW."number" IS DISTINCT FROM OLD."number" THEN
      RAISE EXCEPTION 'portal: order request % keeps its number for ever; a Send after it was taken back sends it under the same number', OLD."number"
        USING ERRCODE = 'check_violation';
    END IF;
    -- end owb G1 (c), (d)
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
  -- owb G1 (d): every state after DRAFT has its number, and a DRAFT may keep the number of an earlier Send (taken back); a new
  -- request is still unnumbered (the INSERT rule above). When and who sent it: together; set while SENT and once decided;
  -- never on a DRAFT (taken back clears them); a request withdrawn keeps what it had (sent, or a draft taken back: none).
  -- Was: the number, when and who exactly from SENT on.
  IF (sent AND NEW."number" IS NULL)
     OR (NEW."sentAt" IS NULL) <> (NEW."sentById" IS NULL)
     OR (NEW."status" IN ('SENT', 'ACCEPTED', 'REFUSED') AND NEW."sentAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND NEW."sentAt" IS NOT NULL)
     OR NEW."sentAt" < NEW."createdAt" THEN
    RAISE EXCEPTION 'portal: order request % is %: its number, when and who sent it from SENT on, together (a draft taken back keeps its number only; a withdrawn one keeps what it had)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  -- end owb G1 (d)
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
-- SalesOrder and PortalOrderRequest: the order's picture (owb G2; PL-schema § 3, § 5A rows 1-2; design order-workflow § 5zi E:
-- "only a file that the customer can open can be the picture: never a file for the office only, never a priced file, never a
-- size sheet"; everybody on the order sees it: every list, the band, the chat, the floor's basket card).
--   every write   its file, when and who set it: all three or none (none: the first line's design, as before).
--   a new file    a file this session can open (a portal session: one shared with its own party; one it cannot see is
--                 refused); of the record's company or of the whole factory; shared with no other customer and of no other
--                 customer's record (factory_file_record_party: the brand wall); an image a browser shows (never a design
--                 file: download-only) or a PDF; never a fiscal archive or a voice note; never body data (a measurement
--                 sheet, a body, made-to-measure or fitting photo); never a priced file (the money wall: the floor and the
--                 designer see the picture); neither deleted nor quarantined.
-- On a request both doors write it while DRAFT or SENT (G1); on an order the office (Confirm copies the request's three; a
-- customer's choice is written by the API in the tenant's system context after the party check). A decided request and a
-- CLOSED or CANCELLED order never change (their own guards).
CREATE FUNCTION "factory_order_picture_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  what CONSTANT text := CASE TG_TABLE_NAME WHEN 'SalesOrder' THEN 'order ' || NEW."number" ELSE 'order request ' || coalesce(NEW."number", NEW."id"::text) END;
  picture record;
  picture_type text;
  record_known boolean;
  record_party uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."pictureFileId", NEW."pictureSetAt", NEW."pictureSetById") IS NOT DISTINCT FROM (OLD."pictureFileId", OLD."pictureSetAt", OLD."pictureSetById") THEN
    RETURN NULL;
  END IF;
  IF (NEW."pictureFileId" IS NULL) <> (NEW."pictureSetAt" IS NULL) OR (NEW."pictureFileId" IS NULL) <> (NEW."pictureSetById" IS NULL) THEN
    RAISE EXCEPTION 'sales: the picture of % names its file, when and who set it: all three or none', what
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."pictureFileId" IS NULL OR (TG_OP = 'UPDATE' AND NEW."pictureFileId" IS NOT DISTINCT FROM OLD."pictureFileId") THEN
    RETURN NULL;
  END IF;
  SELECT f."companyId" AS company, f."partyId" AS party, f."recordType" AS record_type, f."recordId" AS record, f."kind"::text AS kind,
         f."category"::text AS category, f."contentType" AS content_type, f."status"::text AS status, f."priced" AS priced
    INTO picture
    FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."pictureFileId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sales: the picture of % is a file this person can open', what
      USING ERRCODE = 'check_violation';
  END IF;
  picture_type := "factory_files_type_of"(picture.content_type);
  IF NOT ((picture_type LIKE 'image/%' AND NOT "factory_files_is_design_type"(picture_type)) OR picture_type = 'application/pdf')
     OR picture.kind IN ('FISCAL_ARCHIVE', 'AUDIO')
     OR coalesce(picture.category IN ('MEASUREMENTS', 'BODY_PHOTO', 'MTM_PHOTO', 'FITTING_PHOTO'), false)
     OR picture.status IN ('DELETED', 'QUARANTINED')
     OR picture.priced THEN
    RAISE EXCEPTION 'sales: the picture of % is an image or a PDF everybody on the order may see: never a fiscal archive, a voice note, body data (measurements, a body, made-to-measure or fitting photo) or a priced file, nor one deleted or quarantined', what
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.known, r.party INTO record_known, record_party FROM "factory_file_record_party"(NEW."tenantId", picture.record_type, picture.record) r;
  IF (picture.company IS NOT NULL AND picture.company <> NEW."companyId")
     OR (picture.party IS NOT NULL AND picture.party <> NEW."partyId")
     OR (record_known AND record_party IS NOT NULL AND record_party <> NEW."partyId") THEN
    RAISE EXCEPTION 'sales: the picture of % is a file of its own company and customer, or of the whole factory; never another customer''s', what
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SalesOrder_picture_check" AFTER INSERT OR UPDATE OF "pictureFileId", "pictureSetAt", "pictureSetById" ON "SalesOrder"
  FOR EACH ROW WHEN (NEW."pictureFileId" IS NOT NULL OR NEW."pictureSetAt" IS NOT NULL OR NEW."pictureSetById" IS NOT NULL)
  EXECUTE FUNCTION "factory_order_picture_check"();
CREATE TRIGGER "PortalOrderRequest_picture_check" AFTER INSERT OR UPDATE OF "pictureFileId", "pictureSetAt", "pictureSetById" ON "PortalOrderRequest"
  FOR EACH ROW WHEN (NEW."pictureFileId" IS NOT NULL OR NEW."pictureSetAt" IS NOT NULL OR NEW."pictureSetById" IS NOT NULL)
  EXECUTE FUNCTION "factory_order_picture_check"();

-- =====================================================================================================================
-- Department (product.prisma; owb G3; PL-schema § 2): the factory's numbered departments (1 Pattern … 9 Assembly), each on one
-- existing WorkCentreKind with one default library operation.
--   INSERT     ACTIVE, at version 1.
--   UPDATE     the number, the company and the creation never change (a number is given once, for ever: no DELETE, so no
--              number is given again — the unique key holds every number ever given); the version goes up by one; a
--              department ready on the floor stays so, keeps its name and never closes (the floor learnt it by that name).
--   every row  a number of 1 or more; one of the ten grid tones of the design system (packages/ui tokens.css,
--              --nds-grid-tone-<tone>-*); an icon id (a lucide name: lower-case words joined by "-", up to 60; the web chip
--              shows a plain dot for one it does not know); a name and a short name of 1 to 60 trimmed characters.
--   DELETE     refused (CLOSED instead). TRUNCATE refused.
CREATE FUNCTION "factory_department_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tones CONSTANT text[] := ARRAY['slate', 'purple', 'emerald', 'pink', 'orange', 'blue', 'yellow', 'red', 'violet', 'cyan'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product: department % is closed, never deleted (its number is never given again)', OLD."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> 'ACTIVE' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'product: a new department is ACTIVE, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the number, company and creation of department % never change (a number is given once, for ever)', OLD."number"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'product: the version of department % goes up by one', OLD."number"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."floorReady" AND (NOT NEW."floorReady" OR NEW."name" IS DISTINCT FROM OLD."name") THEN
      RAISE EXCEPTION 'product: department % is ready on the floor: it stays so and keeps its name', OLD."number"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."number" < 1 THEN
    RAISE EXCEPTION 'product: department % has a number of 1 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."floorReady" AND NEW."status"::text = 'CLOSED' THEN
    RAISE EXCEPTION 'product: department % is ready on the floor: it never closes', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT coalesce(NEW."tone"::text = ANY (tones), false)
     OR NEW."icon" IS NULL OR NEW."icon" !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(NEW."icon") > 60
     OR btrim(NEW."name") <> NEW."name" OR NEW."name" = '' OR length(NEW."name") > 60
     OR btrim(NEW."shortName") <> NEW."shortName" OR NEW."shortName" = '' OR length(NEW."shortName") > 60 THEN
    RAISE EXCEPTION 'product: department % has one of the ten grid tones (slate, purple, emerald, pink, orange, blue, yellow, red, violet, cyan), an icon id (lower-case words joined by -, up to 60), a name and a short name of 1 to 60 trimmed characters', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Department_guard" AFTER INSERT OR UPDATE OR DELETE ON "Department"
  FOR EACH ROW EXECUTE FUNCTION "factory_department_guard"();
CREATE TRIGGER "Department_no_truncate" BEFORE TRUNCATE ON "Department"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();

-- Operation (product.prisma; owb G3): ONE default library operation per department (a route step stays a RoutingOperation
-- with an operationId; a department's own step is its default operation).
CREATE UNIQUE INDEX "Operation_one_department_default" ON "Operation" ("tenantId", "departmentId") WHERE "departmentDefault";

-- Operation and RoutingOperation (product.prisma; owb G3): the department a library operation or a route step names.
--   Operation         the default operation of a department names that department.
--   both, a new or another department named
--                     an open department (not CLOSED) of the tenant (the reference) and of no other company than the
--                     operation's or the style's (a department of the whole factory fits every company).
-- A step's department is frozen with its revision once the revision leaves DRAFT (factory_style_revision_part_guard). Old
-- released routes keep no department (none is back-filled): the domain's departmentOfKind() names one by the step's kind.
CREATE FUNCTION "factory_operation_department_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_company uuid;
  department_company uuid;
  department_status text;
  department_number integer;
BEGIN
  IF TG_TABLE_NAME = 'Operation' THEN
    IF NEW."departmentDefault" AND NEW."departmentId" IS NULL THEN
      RAISE EXCEPTION 'product: operation % is the default operation of a department only when it names that department', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
    owner_company := NEW."companyId";
  ELSE
    SELECT s."companyId" INTO owner_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
  END IF;
  IF NEW."departmentId" IS NULL OR (TG_OP = 'UPDATE' AND NEW."departmentId" IS NOT DISTINCT FROM OLD."departmentId") THEN
    RETURN NULL;
  END IF;
  SELECT d."companyId", d."status"::text, d."number" INTO department_company, department_status, department_number
    FROM "Department" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."departmentId";
  IF FOUND AND (department_status = 'CLOSED'
                OR (department_company IS NOT NULL AND owner_company IS NOT NULL AND department_company <> owner_company)) THEN
    RAISE EXCEPTION 'product: % % names department %, which is closed or of another company; it names an open department of its own company or of the whole factory', CASE TG_TABLE_NAME WHEN 'Operation' THEN 'operation' ELSE 'route step' END, NEW."code", department_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Operation_department_check" AFTER INSERT OR UPDATE OF "departmentId", "departmentDefault" ON "Operation"
  FOR EACH ROW EXECUTE FUNCTION "factory_operation_department_check"();
CREATE TRIGGER "RoutingOperation_department_check" AFTER INSERT OR UPDATE OF "departmentId" ON "RoutingOperation"
  FOR EACH ROW EXECUTE FUNCTION "factory_operation_department_check"();

-- =====================================================================================================================
-- OrderTeam (brand-production.prisma; owb G4; PL-schema § 5A row 10): the teams an order is given to — one in charge, the
-- others with a share of its baskets (bundleIds, filled at Print in SPLIT).
--   INSERT     open (no end), at version 1.
--   UPDATE     the company, customer, site, order, team, how it was given and the creation never change; the version goes up by one;
--              an ended row never changes again; ending writes when and who together, once.
--   every row  a share of 1 or more, or none; each basket once; the order of the row's company; the team of the row's
--              company and site; the baskets (when they change) baskets of the order's work orders at the team's site — a
--              work order of the order: one with a cell of a line of the order; a basket with at most one open team (read
--              under a transaction lock per tenant, so two writes at once wait for each other).
--   DELETE     refused (ended instead: the order's history keeps who had it). TRUNCATE refused.
-- Partial uniques: one open team in charge per order (OrderTeam_one_in_charge); a team once per order among the open rows
-- (OrderTeam_team_once).
CREATE FUNCTION "factory_order_team_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_company uuid;
  team_company uuid;
  team_site uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: a team of an order is ended, never deleted (order team %)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."endedAt" IS NOT NULL OR NEW."endedById" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'production: a new order team is open (not ended), at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."endedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'production: order team % was ended; it never changes again', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."siteId", NEW."salesOrderId", NEW."teamId", NEW."givenBy", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."siteId", OLD."salesOrderId", OLD."teamId", OLD."givenBy", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: the order, customer, team, site, company, how it was given and the creation of order team % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'production: the version of order team % goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."endedAt" IS NULL) <> (NEW."endedById" IS NULL) THEN
    RAISE EXCEPTION 'production: order team % is ended with when and who, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."basketShare" IS NOT NULL AND NEW."basketShare" < 1)
     OR NEW."bundleIds" IS NULL
     OR cardinality(NEW."bundleIds") <> (SELECT count(DISTINCT x) FROM unnest(NEW."bundleIds") AS x) THEN
    RAISE EXCEPTION 'production: order team % has a share of its order''s baskets of 1 or more (or none), and names each basket once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT o."companyId" INTO order_company FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."salesOrderId";
  IF FOUND AND order_company <> NEW."companyId" THEN
    RAISE EXCEPTION 'production: order team % is of its order''s company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT t."companyId", t."siteId" INTO team_company, team_site FROM "Team" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."teamId";
  IF FOUND AND (team_company <> NEW."companyId" OR team_site <> NEW."siteId") THEN
    RAISE EXCEPTION 'production: order team % names a team of its own company and site', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."bundleIds") > 0 AND (TG_OP = 'INSERT' OR NEW."bundleIds" IS DISTINCT FROM OLD."bundleIds")
     AND EXISTS (SELECT 1 FROM unnest(NEW."bundleIds") AS x(id)
                  WHERE NOT EXISTS (SELECT 1 FROM "Bundle" b
                                     WHERE b."tenantId" = NEW."tenantId" AND b."id" = x.id AND b."siteId" = NEW."siteId"
                                       AND EXISTS (SELECT 1 FROM "WorkOrderSize" s
                                                     JOIN "SalesOrderLine" l ON l."tenantId" = s."tenantId" AND l."id" = s."salesOrderLineId"
                                                    WHERE s."tenantId" = b."tenantId" AND s."workOrderId" = b."workOrderId" AND l."orderId" = NEW."salesOrderId"))) THEN
    RAISE EXCEPTION 'production: the baskets of order team % are baskets of its order''s work orders at the team''s site', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."endedAt" IS NULL AND cardinality(NEW."bundleIds") > 0 THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.order-team-baskets', NEW."tenantId"), 0));
    IF EXISTS (SELECT 1 FROM "OrderTeam" o
                WHERE o."tenantId" = NEW."tenantId" AND o."id" <> NEW."id" AND o."endedAt" IS NULL AND o."bundleIds" && NEW."bundleIds") THEN
      RAISE EXCEPTION 'production: a basket is with one team at a time; order team % names a basket another open team has', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OrderTeam_guard" AFTER INSERT OR UPDATE OR DELETE ON "OrderTeam"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_team_guard"();
CREATE TRIGGER "OrderTeam_no_truncate" BEFORE TRUNCATE ON "OrderTeam"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();
CREATE UNIQUE INDEX "OrderTeam_one_in_charge" ON "OrderTeam" ("tenantId", "salesOrderId") WHERE "inCharge" AND "endedAt" IS NULL;
CREATE UNIQUE INDEX "OrderTeam_team_once" ON "OrderTeam" ("tenantId", "salesOrderId", "teamId") WHERE "endedAt" IS NULL;

-- =====================================================================================================================
-- OrderPrint, BasketMove, BasketRouteEdit (production.prisma, baskets.prisma; owb G5): append-only
-- (scripts/factory/check-append-only.mjs) and their INSERT rules.
CREATE TRIGGER "OrderPrint_append_only" BEFORE UPDATE OR DELETE ON "OrderPrint"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "OrderPrint_no_truncate" BEFORE TRUNCATE ON "OrderPrint"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "BasketMove_append_only" BEFORE UPDATE OR DELETE ON "BasketMove"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "BasketMove_no_truncate" BEFORE TRUNCATE ON "BasketMove"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "BasketRouteEdit_append_only" BEFORE UPDATE OR DELETE ON "BasketRouteEdit"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "BasketRouteEdit_no_truncate" BEFORE TRUNCATE ON "BasketRouteEdit"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_production_ledger_change"();

-- OrderPrint (owb G5; PL-schema § 5A row 11): one print of an order's pages and basket cards ("Print and start the work",
-- "Print again").
--   INSERT    a FIRST print gives no reason; a print AGAIN gives one (LOST, DAMAGED, SMALL_CHANGE, ONE_MORE_COPY); a SMALL_CHANGE
--             says what changed in words (it reaches the floor as the work order's "for the floor" note); words, when given,
--             are 1 to 2000 characters, not blank; the pages and the cards are lists; of its order's company.
CREATE FUNCTION "factory_order_print_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_company uuid;
BEGIN
  IF (NEW."kind"::text = 'FIRST') <> (NEW."reason" IS NULL) THEN
    RAISE EXCEPTION 'production: print % of an order gives a reason exactly when it prints AGAIN (a first print gives none)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."reason" IS NOT DISTINCT FROM 'SMALL_CHANGE' AND btrim(coalesce(NEW."note", '')) = '')
     OR (NEW."note" IS NOT NULL AND (btrim(NEW."note") = '' OR length(NEW."note") > 2000)) THEN
    RAISE EXCEPTION 'production: print % for a small change says what changed in words (1 to 2000 characters, not blank)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."pages"::jsonb) IS DISTINCT FROM 'array' OR jsonb_typeof(NEW."cards"::jsonb) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'production: print % names its pages and its basket cards as lists', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT o."companyId" INTO order_company FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."salesOrderId";
  IF FOUND AND order_company <> NEW."companyId" THEN
    RAISE EXCEPTION 'production: print % is of its order''s company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OrderPrint_check" AFTER INSERT ON "OrderPrint"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_print_check"();

-- BasketMove (owb G5; PL-schema § 4, § 5A row 12): a basket moved by hand on the floor (no scan, no pay, no cost entry; the
-- standing-report rule of the scan guard does not change).
--   INSERT    the basket of the move's work order and site; the step it leaves and the step it goes to (none: Ready to ship)
--             are steps of that work order; a move BACK gives its reason (REDO, MISTAKE, OTHER); an UNDO names exactly one
--             earlier hand move (FORWARD, BACK or TAKEN_HERE) of the same basket, which nothing else undid (BasketMove_undo_once),
--             and only an UNDO names one; words, when given, are 1 to 500 characters, not blank.
CREATE FUNCTION "factory_basket_move_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  undone_bundle uuid;
  undone_kind text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."bundleId" AND b."siteId" = NEW."siteId" AND b."workOrderId" = NEW."workOrderId")
     OR (NEW."fromOperationId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "WorkOrderOperation" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."fromOperationId" AND o."siteId" = NEW."siteId" AND o."workOrderId" = NEW."workOrderId"))
     OR (NEW."toOperationId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "WorkOrderOperation" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."toOperationId" AND o."siteId" = NEW."siteId" AND o."workOrderId" = NEW."workOrderId")) THEN
    RAISE EXCEPTION 'production: basket move % moves a basket of its work order between steps of that work order', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind"::text = 'BACK' AND NEW."reason" IS NULL THEN
    RAISE EXCEPTION 'production: basket move % back to an earlier step gives its reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."note" IS NOT NULL AND (btrim(NEW."note") = '' OR length(NEW."note") > 500) THEN
    RAISE EXCEPTION 'production: basket move % has words of 1 to 500 characters, not blank, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind"::text = 'UNDO') <> (NEW."undoesId" IS NOT NULL) THEN
    RAISE EXCEPTION 'production: basket move % names the move it undoes exactly when it is an UNDO', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."undoesId" IS NOT NULL THEN
    SELECT m."bundleId", m."kind"::text INTO undone_bundle, undone_kind
      FROM "BasketMove" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."undoesId" AND m."id" <> NEW."id";
    IF NOT FOUND OR undone_bundle <> NEW."bundleId" OR undone_kind = 'UNDO' THEN
      RAISE EXCEPTION 'production: basket move % undoes an earlier hand move of the same basket (not an undo)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "BasketMove_check" AFTER INSERT ON "BasketMove"
  FOR EACH ROW EXECUTE FUNCTION "factory_basket_move_check"();
CREATE UNIQUE INDEX "BasketMove_undo_once" ON "BasketMove" ("tenantId", "undoesId") WHERE "undoesId" IS NOT NULL;

-- BasketRouteEdit (owb G5; PL-schema § 5A row 12): a change of a basket's steps on the floor (skip a step, put it back, add
-- one, back to normal).
--   INSERT    the step is a step of the edit's work order and the basket a basket of it, at its site (the references hold
--             both too; this says it in words); words, when given, are 1 to 500 characters, not blank.
CREATE FUNCTION "factory_basket_route_edit_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "WorkOrderOperation" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."operationId" AND o."siteId" = NEW."siteId" AND o."workOrderId" = NEW."workOrderId")
     OR NOT EXISTS (SELECT 1 FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."bundleId" AND b."siteId" = NEW."siteId" AND b."workOrderId" = NEW."workOrderId") THEN
    RAISE EXCEPTION 'production: route change % changes a step of its work order for a basket of it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."note" IS NOT NULL AND (btrim(NEW."note") = '' OR length(NEW."note") > 500) THEN
    RAISE EXCEPTION 'production: route change % has words of 1 to 500 characters, not blank, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "BasketRouteEdit_check" AFTER INSERT ON "BasketRouteEdit"
  FOR EACH ROW EXECUTE FUNCTION "factory_basket_route_edit_check"();

-- =====================================================================================================================
-- FloorLateWarning (baskets.prisma; owb G6; PL-schema § 5A row 12): "this will be late" from the floor, answered by the office.
--   INSERT    OPEN, unanswered, at version 1; late by 1, 2, 3 or 5 days; its basket, when it names one, a basket of its work
--             order and site.
--   UPDATE    the office answers once: OPEN → KEPT (the date holds) or CHANGED (the date moves), with when and who; nothing
--             else changes; an answered warning never changes again.
--   DELETE    refused. TRUNCATE refused.
CREATE FUNCTION "factory_floor_late_warning_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  answer CONSTANT text[] := ARRAY['state', 'answeredAt', 'answeredById', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: late warning % is answered, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state"::text <> 'OPEN' OR NEW."answeredAt" IS NOT NULL OR NEW."answeredById" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'production: a new late warning is OPEN, unanswered, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."days" NOT IN (1, 2, 3, 5) THEN
      RAISE EXCEPTION 'production: late warning % says late by 1, 2, 3 or 5 days', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."bundleId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."bundleId" AND b."siteId" = NEW."siteId" AND b."workOrderId" = NEW."workOrderId") THEN
      RAISE EXCEPTION 'production: late warning % names a basket of its own work order', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF OLD."state"::text <> 'OPEN' THEN
    RAISE EXCEPTION 'production: late warning % was answered (%); it never changes again', OLD."id", OLD."state"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."state"::text NOT IN ('KEPT', 'CHANGED') OR NEW."answeredAt" IS NULL OR NEW."answeredById" IS NULL
     OR (NEW."version" <> OLD."version" + 1 AND NEW."version" <> OLD."version")
     OR (to_jsonb(NEW) - answer - 'tenantId') IS DISTINCT FROM (to_jsonb(OLD) - answer - 'tenantId') THEN
    RAISE EXCEPTION 'production: late warning % is answered once, OPEN → KEPT or CHANGED, with when and who; nothing else of it changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "FloorLateWarning_guard" AFTER INSERT OR UPDATE OR DELETE ON "FloorLateWarning"
  FOR EACH ROW EXECUTE FUNCTION "factory_floor_late_warning_guard"();
CREATE TRIGGER "FloorLateWarning_no_truncate" BEFORE TRUNCATE ON "FloorLateWarning"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();

-- =====================================================================================================================
-- PaymentNotice (portal-sales.prisma; owb G7; PL-schema § 5A row 4): the customer's "I paid" — a notice, not a payment.
--   INSERT    OPEN, unanswered, at version 1 (a portal session for its own party, portal.payments.notify); an amount above 0
--             in an ISO currency; what it pays, when it says, of its own order (a deposit request of the order; a step of the
--             order's payment plan, where this session may read the plan — the partner role may not, and the reference keeps
--             the step its customer's); the proof a file this session can open, shared with no other customer and of no other
--             customer's record.
--   UPDATE    the office answers once (the partner role has no update grant): OPEN → RECORDED (it recorded the payment with its
--             own command) or DISMISSED (no such payment), with when and who; nothing else changes; an answered notice never
--             changes again.
--   DELETE    refused. TRUNCATE refused.
CREATE FUNCTION "factory_payment_notice_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  answer CONSTANT text[] := ARRAY['state', 'answeredAt', 'answeredById', 'version', 'updatedAt'];
  paid_order uuid;
  proof record;
  record_known boolean;
  record_party uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal: payment notice % is answered, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."state"::text <> 'OPEN' THEN
      RAISE EXCEPTION 'portal: payment notice % was answered (%); it never changes again', OLD."id", OLD."state"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."state"::text NOT IN ('RECORDED', 'DISMISSED') OR NEW."answeredAt" IS NULL OR NEW."answeredById" IS NULL
       OR (NEW."version" <> OLD."version" + 1 AND NEW."version" <> OLD."version")
       OR (to_jsonb(NEW) - answer - 'tenantId') IS DISTINCT FROM (to_jsonb(OLD) - answer - 'tenantId') THEN
      RAISE EXCEPTION 'portal: payment notice % is answered once, OPEN → RECORDED or DISMISSED, with when and who; nothing else of it changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW."state"::text <> 'OPEN' OR NEW."answeredAt" IS NOT NULL OR NEW."answeredById" IS NOT NULL OR NEW."version" <> 1 THEN
    RAISE EXCEPTION 'portal: a new payment notice is OPEN, unanswered, at version 1'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amount" <= 0 OR NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'portal: payment notice % names an amount above 0 in an ISO currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."depositRequestId" IS NOT NULL THEN
    SELECT d."orderId" INTO paid_order FROM "DepositRequest" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."depositRequestId";
    IF FOUND AND paid_order IS DISTINCT FROM NEW."salesOrderId" THEN
      RAISE EXCEPTION 'portal: payment notice % pays a deposit request of its own order', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."milestoneId" IS NOT NULL AND has_table_privilege('"SalesOrderMilestone"', 'SELECT') THEN
    SELECT m."orderId" INTO paid_order FROM "SalesOrderMilestone" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."milestoneId";
    IF FOUND AND paid_order <> NEW."salesOrderId" THEN
      RAISE EXCEPTION 'portal: payment notice % pays a step of its own order''s payment plan', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."fileId" IS NOT NULL THEN
    SELECT f."partyId" AS party, f."recordType" AS record_type, f."recordId" AS record INTO proof
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'portal: the proof of payment notice % is a file this person can open', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT r.known, r.party INTO record_known, record_party FROM "factory_file_record_party"(NEW."tenantId", proof.record_type, proof.record) r;
    IF (proof.party IS NOT NULL AND proof.party <> NEW."partyId")
       OR (record_known AND record_party IS NOT NULL AND record_party <> NEW."partyId") THEN
      RAISE EXCEPTION 'portal: the proof of payment notice % is a file of its own customer, never another customer''s', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PaymentNotice_guard" AFTER INSERT OR UPDATE OR DELETE ON "PaymentNotice"
  FOR EACH ROW EXECUTE FUNCTION "factory_payment_notice_guard"();
CREATE TRIGGER "PaymentNotice_no_truncate" BEFORE TRUNCATE ON "PaymentNotice"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();

-- =====================================================================================================================
-- The customer's own columns (order-columns.prisma; owb G8; PL-schema § 5A row 5). Every row carries the customer's partyId in
-- its references, so a use and a value name a column, a record and a line of the same customer (a foreign key, for every
-- login); one use per column and record and one value per column and line are the API's (DB-A's schema note).
--
-- PartyLineColumn
--   INSERT     open (no closedAt), at version 1.
--   UPDATE     the customer, the kind and the creation never change (a value is always of its column's kind); the version
--              goes up by one; a closed column never changes again (closed once, kept with its values).
--   every row  a name of 1 to 40 trimmed characters; a CHOICE column has at least one choice, each of 1 to 40 trimmed
--              characters, each once; every other kind has none; its place 1 or more.
--   DELETE     refused (closed instead). TRUNCATE refused.
-- Partial unique PartyLineColumn_open_name: one open column of a name per customer, whatever its case.
CREATE FUNCTION "factory_party_line_column_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales: own column % is closed, never deleted (its values stay)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."closedAt" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'sales: a new own column is open, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."closedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'sales: own column % was closed; it never changes again', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."id", NEW."partyId", NEW."kind", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."partyId", OLD."kind", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales: the customer, kind and creation of own column % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'sales: the version of own column % goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."name") <> NEW."name" OR NEW."name" = '' OR length(NEW."name") > 40 OR NEW."seq" < 1 THEN
    RAISE EXCEPTION 'sales: own column % has a name of 1 to 40 trimmed characters and its place (1 or more)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."choices" IS NULL
     OR (NEW."kind"::text = 'CHOICE') <> (cardinality(NEW."choices") > 0)
     OR EXISTS (SELECT 1 FROM unnest(NEW."choices") c WHERE c IS NULL OR btrim(c) <> c OR c = '' OR length(c) > 40)
     OR cardinality(NEW."choices") <> (SELECT count(DISTINCT c) FROM unnest(NEW."choices") c) THEN
    RAISE EXCEPTION 'sales: own column % has its choices exactly when it is a CHOICE column: at least one, each of 1 to 40 trimmed characters, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PartyLineColumn_guard" AFTER INSERT OR UPDATE OR DELETE ON "PartyLineColumn"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_line_column_guard"();
CREATE TRIGGER "PartyLineColumn_no_truncate" BEFORE TRUNCATE ON "PartyLineColumn"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();
CREATE UNIQUE INDEX "PartyLineColumn_open_name" ON "PartyLineColumn" ("tenantId", "partyId", lower(btrim("name"))) WHERE "closedAt" IS NULL;

-- OrderLineColumnUse
--   every row  exactly one record: a sales order or a portal order request; of the record's company (an order's by its
--              reference; a request's read here); its place 1 or more.
--   UPDATE     the customer, the company, the record, the column and the creation never change; the version goes up by one.
-- A use goes with its discarded draft (its reference cascades); nobody deletes one otherwise (no grant).
CREATE FUNCTION "factory_order_line_column_use_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."partyId", NEW."companyId", NEW."salesOrderId", NEW."portalOrderRequestId", NEW."columnId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."partyId", OLD."companyId", OLD."salesOrderId", OLD."portalOrderRequestId", OLD."columnId", OLD."createdAt", OLD."createdById")
       OR NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'sales: own column use % keeps its record and its column; its version goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."version" <> 1 THEN
    RAISE EXCEPTION 'sales: a new own column use is at version 1'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."salesOrderId" IS NULL) = (NEW."portalOrderRequestId" IS NULL) OR NEW."seq" < 1 THEN
    RAISE EXCEPTION 'sales: own column use % is on exactly one record (a sales order or an order request), in its place (1 or more)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."portalOrderRequestId" IS NOT NULL THEN
    SELECT r."companyId" INTO request_company FROM "PortalOrderRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."portalOrderRequestId";
    IF FOUND AND request_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'sales: own column use % is of its order request''s company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OrderLineColumnUse_check" AFTER INSERT OR UPDATE ON "OrderLineColumnUse"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_line_column_use_check"();
CREATE TRIGGER "OrderLineColumnUse_no_truncate" BEFORE TRUNCATE ON "OrderLineColumnUse"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();

-- OrderLineOwnValue
--   every row  exactly one line: a sales order line or a portal order request line; only the field its column's kind needs
--              holds a value (TEXT valueText, YES_NO valueBool, CHOICE valueText — one of the column's choices —, NUMBER
--              valueNumber, DATE valueDate), every other field none; that field may be none too (a value cleared: nobody
--              deletes a value but with its line); words of 1 to 1000 characters, not blank.
--   UPDATE     the customer, the column, the line and the creation never change; the version goes up by one.
CREATE FUNCTION "factory_order_line_own_value_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  column_kind text;
  column_choices text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."partyId", NEW."columnId", NEW."salesOrderLineId", NEW."portalOrderRequestLineId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."partyId", OLD."columnId", OLD."salesOrderLineId", OLD."portalOrderRequestLineId", OLD."createdAt", OLD."createdById")
       OR NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'sales: own column value % keeps its column and its line; its version goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."version" <> 1 THEN
    RAISE EXCEPTION 'sales: a new own column value is at version 1'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."salesOrderLineId" IS NULL) = (NEW."portalOrderRequestLineId" IS NULL) THEN
    RAISE EXCEPTION 'sales: own column value % is on exactly one line (of a sales order or of an order request)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c."kind"::text, c."choices" INTO column_kind, column_choices
    FROM "PartyLineColumn" c WHERE c."tenantId" = NEW."tenantId" AND c."partyId" = NEW."partyId" AND c."id" = NEW."columnId";
  IF FOUND AND ((NEW."valueText" IS NOT NULL AND column_kind NOT IN ('TEXT', 'CHOICE'))
                OR (NEW."valueBool" IS NOT NULL AND column_kind <> 'YES_NO')
                OR (NEW."valueNumber" IS NOT NULL AND column_kind <> 'NUMBER')
                OR (NEW."valueDate" IS NOT NULL AND column_kind <> 'DATE')
                OR (column_kind = 'CHOICE' AND NEW."valueText" IS NOT NULL AND NOT (NEW."valueText" = ANY (column_choices)))) THEN
    RAISE EXCEPTION 'sales: own column value % fills only the field its column''s kind needs (%), a CHOICE one of its choices', NEW."id", column_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."valueText" IS NOT NULL AND (btrim(NEW."valueText") = '' OR length(NEW."valueText") > 1000) THEN
    RAISE EXCEPTION 'sales: own column value % has words of 1 to 1000 characters, not blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OrderLineOwnValue_check" AFTER INSERT OR UPDATE ON "OrderLineOwnValue"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_line_own_value_check"();
CREATE TRIGGER "OrderLineOwnValue_no_truncate" BEFORE TRUNCATE ON "OrderLineOwnValue"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();

-- =====================================================================================================================
-- ShipmentWarehouseLeg (shipping.prisma; owb G9; PL-schema § 5A row 13): a shipment that goes through our own warehouse first
-- and is sent on from there (a 1:1 table beside Shipment, so no shipment function is redefined).
--   INSERT     not arrived, not sent on, at version 1; for a shipment not yet delivered, returned or cancelled, of the leg's
--              customer and site.
--   UPDATE     the shipment, company, customer, site and creation never change; the version goes up by one; the warehouse never
--              changes once the goods arrived; arrived (when, who) only while the shipment is SHIPPED, set once; sent on
--              (when, who) only after it arrived, set once; the customer's label never changes once sent on.
--   every row  the warehouse a WAREHOUSE site of the shipment's company; arrived and sent on each with when and who
--              together, sent on not before arrived; the label, when it names one, with when and who, a CUSTOMER_LABEL file of
--              the shipment, neither deleted nor quarantined; sent on with the customer's label or as sent on without it
--              (forwardedWithoutLabel), never both; "without it" only once sent on.
--   DELETE     refused. TRUNCATE refused.
-- And Shipment: DELIVERED only once its leg sent it on (Shipment_warehouse_leg_delivered, below).
CREATE FUNCTION "factory_shipment_warehouse_leg_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shipment_company uuid;
  shipment_party uuid;
  shipment_site uuid;
  shipment_status text;
  warehouse_kind text;
  warehouse_company uuid;
  label record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shipping: the warehouse leg of shipment % is kept, never deleted', OLD."shipmentId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."companyId", s."partyId", s."siteId", s."status"::text INTO shipment_company, shipment_party, shipment_site, shipment_status
    FROM "Shipment" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."shipmentId";
  IF TG_OP = 'INSERT' THEN
    IF NEW."arrivedAt" IS NOT NULL OR NEW."arrivedById" IS NOT NULL OR NEW."forwardedAt" IS NOT NULL OR NEW."forwardedById" IS NOT NULL
       OR NEW."forwardedWithoutLabel" OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'shipping: a new warehouse leg has not arrived and was not sent on, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    IF shipment_status IN ('DELIVERED', 'RETURNED', 'CANCELLED') OR shipment_party <> NEW."partyId" OR shipment_site <> NEW."siteId" THEN
      RAISE EXCEPTION 'shipping: a warehouse leg is planned for a shipment of its own customer and site that is not delivered, returned or cancelled (shipment %)', NEW."shipmentId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."shipmentId", NEW."companyId", NEW."partyId", NEW."siteId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."shipmentId", OLD."companyId", OLD."partyId", OLD."siteId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'shipping: the shipment, company, customer, site and creation of the warehouse leg of shipment % never change', OLD."shipmentId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'shipping: the version of the warehouse leg of shipment % goes up by one', OLD."shipmentId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."arrivedAt" IS NOT NULL AND (NEW."arrivedAt", NEW."arrivedById", NEW."warehouseSiteId") IS DISTINCT FROM (OLD."arrivedAt", OLD."arrivedById", OLD."warehouseSiteId"))
       OR (OLD."forwardedAt" IS NOT NULL AND (NEW."forwardedAt", NEW."forwardedById", NEW."forwardedWithoutLabel", NEW."customerLabelFileId", NEW."customerLabelAt", NEW."customerLabelById")
                                              IS DISTINCT FROM (OLD."forwardedAt", OLD."forwardedById", OLD."forwardedWithoutLabel", OLD."customerLabelFileId", OLD."customerLabelAt", OLD."customerLabelById")) THEN
      RAISE EXCEPTION 'shipping: the warehouse leg of shipment % records its arrival (and the warehouse) once and its sending on (and the label) once', OLD."shipmentId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."arrivedAt" IS NULL AND NEW."arrivedAt" IS NOT NULL AND shipment_status IS DISTINCT FROM 'SHIPPED' THEN
      RAISE EXCEPTION 'shipping: the goods of shipment % arrive at our warehouse only once it left (SHIPPED; it is %)', NEW."shipmentId", shipment_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."arrivedAt" IS NULL) <> (NEW."arrivedById" IS NULL) OR (NEW."forwardedAt" IS NULL) <> (NEW."forwardedById" IS NULL)
     OR (NEW."forwardedAt" IS NOT NULL AND (NEW."arrivedAt" IS NULL OR NEW."forwardedAt" < NEW."arrivedAt")) THEN
    RAISE EXCEPTION 'shipping: the warehouse leg of shipment % records its arrival and its sending on each with when and who, sent on only after it arrived', NEW."shipmentId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."customerLabelFileId" IS NULL) <> (NEW."customerLabelAt" IS NULL) OR (NEW."customerLabelFileId" IS NULL) <> (NEW."customerLabelById" IS NULL)
     OR (NEW."forwardedWithoutLabel" AND (NEW."forwardedAt" IS NULL OR NEW."customerLabelFileId" IS NOT NULL))
     OR (NEW."forwardedAt" IS NOT NULL AND NEW."customerLabelFileId" IS NULL AND NOT NEW."forwardedWithoutLabel") THEN
    RAISE EXCEPTION 'shipping: the warehouse leg of shipment % names the customer''s label with when and who, and is sent on with it or as sent on without it, never both', NEW."shipmentId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."warehouseSiteId" IS DISTINCT FROM OLD."warehouseSiteId" THEN
    SELECT w."kind"::text, w."companyId" INTO warehouse_kind, warehouse_company FROM "Site" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."warehouseSiteId";
    IF FOUND AND (warehouse_kind <> 'WAREHOUSE' OR warehouse_company IS DISTINCT FROM shipment_company) THEN
      RAISE EXCEPTION 'shipping: the warehouse leg of shipment % goes through a WAREHOUSE site of the shipment''s company', NEW."shipmentId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."customerLabelFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."customerLabelFileId" IS DISTINCT FROM OLD."customerLabelFileId") THEN
    SELECT f."recordType" AS record_type, f."recordId" AS record, f."category"::text AS category, f."status"::text AS status INTO label
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."customerLabelFileId";
    IF NOT FOUND OR label.record_type <> 'Shipment' OR label.record <> NEW."shipmentId"
       OR label.category IS DISTINCT FROM 'CUSTOMER_LABEL' OR label.status IN ('DELETED', 'QUARANTINED') THEN
      RAISE EXCEPTION 'shipping: the customer''s label of shipment % is a CUSTOMER_LABEL file of that shipment, neither deleted nor quarantined', NEW."shipmentId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ShipmentWarehouseLeg_guard" AFTER INSERT OR UPDATE OR DELETE ON "ShipmentWarehouseLeg"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipment_warehouse_leg_guard"();
CREATE TRIGGER "ShipmentWarehouseLeg_no_truncate" BEFORE TRUNCATE ON "ShipmentWarehouseLeg"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();

-- Shipment (shipping.prisma; owb G9): a shipment that goes through our warehouse is DELIVERED only once the warehouse sent it
-- on (its leg's forwardedAt). Beside factory_shipment_guard (BEFORE, its name sorts first: it speaks first), not instead of it.
CREATE FUNCTION "factory_shipment_warehouse_leg_delivered_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ShipmentWarehouseLeg" l WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id" AND l."forwardedAt" IS NULL) THEN
    RAISE EXCEPTION 'shipping: shipment % goes through our warehouse; it is DELIVERED only after the warehouse sent it on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Shipment_warehouse_leg_delivered" BEFORE UPDATE OF "status" ON "Shipment"
  FOR EACH ROW WHEN (NEW."status" = 'DELIVERED' AND OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "factory_shipment_warehouse_leg_delivered_check"();

-- =====================================================================================================================
-- PartyOfficePerson (parties.prisma; owb G11; settle 10, PL-schema § 5A row 16): the office people of a customer's pool
-- ("People by customer").
--   INSERT     open (no end), at version 1; the person an active office user of the tenant (User.audience OFFICE: a portal
--              user is PARTNER; a floor worker is no User at all).
--   UPDATE     the company, customer, person and creation never change; the version goes up by one; ending writes when and
--              who together, once; an ended row never changes again.
--   DELETE     refused (ended instead). TRUNCATE refused.
-- Partial unique PartyOfficePerson_one_open: one open row per customer and person.
CREATE FUNCTION "factory_party_office_person_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  user_audience text;
  user_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'parties: a person of a customer''s pool is ended, never deleted (row %)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."endedAt" IS NOT NULL OR NEW."endedById" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'parties: a new person of a customer''s pool is open (not ended), at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'parties: a customer''s pool names an active office person, not one that is % (%)', user_status, user_audience
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."endedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'parties: row % of a customer''s pool was ended; it never changes again', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."userId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."userId", OLD."createdAt", OLD."createdById")
       OR NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'parties: row % of a customer''s pool only ends (its company, customer, person and creation never change; its version goes up by one)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."endedAt" IS NULL) <> (NEW."endedById" IS NULL) THEN
    RAISE EXCEPTION 'parties: row % of a customer''s pool is ended with when and who, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PartyOfficePerson_guard" AFTER INSERT OR UPDATE OR DELETE ON "PartyOfficePerson"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_office_person_guard"();
CREATE TRIGGER "PartyOfficePerson_no_truncate" BEFORE TRUNCATE ON "PartyOfficePerson"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();
CREATE UNIQUE INDEX "PartyOfficePerson_one_open" ON "PartyOfficePerson" ("tenantId", "partyId", "userId") WHERE "endedAt" IS NULL;

-- =====================================================================================================================
-- Bundle (MES-065, MES-068, MES-073; owb G10): REDEFINES factory_bundle_guard (…_production_leftovers_guards, B-W1-40/41: its
-- newest), word for word but for the lines marked owb G10 (a)-(c): a basket made at "Print and start the work" (madeAtPrint)
-- only where the site turned it on (ProductionSettings.basketsAtPrint), before its cut (no cut log entry); while ACTIVE it
-- takes the entries of the hides cut for it later and they only grow (a cell is cut from several hides over time), so the
-- lot trace and the final evidence keep reading its hide and lot; madeAtPrint never changes. Its trigger stays as it is.
-- (The comment block of …_production_leftovers_guards, with owb G10:)
--   INSERT     ACTIVE, with its first ticket (no replaced code), for a RELEASED or IN_PROGRESS work order; at least one
--              garment, exactly one for a made-to-measure unit (single-piece mode); its cut log entries are entries of
--              its work order, neither reversals nor named twice. owb G10 (a): made at print only on a site whose floor rules
--              turn baskets at print on (none: off), and with no cut log entry yet.
--   UPDATE     an UPDATE that changes nothing passes; only a reprint (a new code; the old one appended to the replaced
--              codes, MES-073) of an ACTIVE bundle, with its BundleReprint row (the reason), or ACTIVE → VOID with its
--              time and reason; a VOID bundle never changes. Its client event id never changes (a frozen column).
--              owb G10 (b): and an ACTIVE basket made at print adds cut log entries (every one it names stays; each new one
--              an entry of its work order, not a reversal, none named twice). owb G10 (c): madeAtPrint never changes.
--   every row  VOID exactly with its time and reason; a client event id, when it has one, is not blank.
--   DELETE     refused (voided). TRUNCATE refused.
CREATE OR REPLACE FUNCTION "factory_bundle_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  changing CONSTANT text[] := ARRAY['code', 'replacedCodes', 'status', 'voidedAt', 'voidReason', 'version', 'updatedAt'];
  order_state text;
  order_kind text;
  -- owb G10 (a): the site's switch "baskets at print". owb G10 (b): cutLogIds while a basket made at print takes entries.
  baskets_at_print boolean;
  attaching text[] := ARRAY[]::text[];
  -- end owb G10 (a), (b)
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: bundle % is voided, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' OR cardinality(NEW."replacedCodes") > 0 THEN
      RAISE EXCEPTION 'production: bundle % starts ACTIVE with its first ticket', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."quantity" < 1 THEN
      RAISE EXCEPTION 'production: bundle % carries at least one garment', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT w."status"::text, w."kind"::text INTO order_state, order_kind
      FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF FOUND THEN
      IF order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
        RAISE EXCEPTION 'production: work order % is %; bundles are made only for a RELEASED or IN_PROGRESS work order', NEW."workOrderId", order_state
          USING ERRCODE = 'check_violation';
      END IF;
      IF order_kind = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1 THEN
        RAISE EXCEPTION 'production: bundle % of made-to-measure work order % is the one garment (single-piece mode, MES-068)', NEW."id", NEW."workOrderId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (SELECT count(DISTINCT x) FROM unnest(NEW."cutLogIds") AS x) <> cardinality(NEW."cutLogIds")
         OR EXISTS (SELECT 1 FROM unnest(NEW."cutLogIds") AS x(id)
                     WHERE NOT EXISTS (SELECT 1 FROM "CutLog" c
                                        WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."workOrderId" = NEW."workOrderId"
                                          AND c."id" = x.id AND c."reversalOfId" IS NULL)) THEN
        RAISE EXCEPTION 'production: bundle % names cut log entries of its work order, each once, none a reversal', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    -- owb G10 (a) (plan.md § 4 G10; PL-review § 4 guard 5): a basket made at "Print and start the work", before cutting, only
    -- where the site turned it on (its ProductionSettings row, read by the site's id; no row: off, as every site starts), and
    -- with no cut log entry yet (its entries are added as its hides are cut, (b)).
    IF NEW."madeAtPrint" THEN
      SELECT s."basketsAtPrint" INTO baskets_at_print
        FROM "ProductionSettings" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."siteId";
      IF NOT coalesce(baskets_at_print, false) THEN
        RAISE EXCEPTION 'production: baskets are made at print only where the site turned it on (bundle %)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF cardinality(NEW."cutLogIds") > 0 THEN
        RAISE EXCEPTION 'production: bundle % is made at print, before its cut: it names no cut log entry yet', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    -- end owb G10 (a)
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    -- owb G10 (b) (plan.md § 4 G10; PL-review § 4 guard 1; lead 88's yes 07:50 to S3's ask of 07:33): an ACTIVE basket made at
    -- print takes the cut log entries of the hides cut for it, as they are cut — a cell is cut from several hides over time, so
    -- the list only grows: every entry it names stays (OLD ⊆ NEW) and each new one passes the insert's own check (an entry of
    -- its work order, not a reversal, none named twice). Any other bundle's entries still never change: for it cutLogIds stays
    -- outside the columns that may change, so the whole-row compare below refuses it with its words, as before.
    IF NEW."cutLogIds" IS DISTINCT FROM OLD."cutLogIds" AND OLD."madeAtPrint" THEN
      IF OLD."status" <> 'ACTIVE' OR NEW."status" <> 'ACTIVE' OR NOT (OLD."cutLogIds" <@ NEW."cutLogIds") THEN
        RAISE EXCEPTION 'production: basket % made at print only adds cut log entries, while ACTIVE; every entry it names stays', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (SELECT count(DISTINCT x) FROM unnest(NEW."cutLogIds") AS x) <> cardinality(NEW."cutLogIds")
         OR EXISTS (SELECT 1 FROM unnest(NEW."cutLogIds") AS x(id)
                     WHERE NOT (x.id = ANY (OLD."cutLogIds"))
                       AND NOT EXISTS (SELECT 1 FROM "CutLog" c
                                        WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."workOrderId" = NEW."workOrderId"
                                          AND c."id" = x.id AND c."reversalOfId" IS NULL)) THEN
        RAISE EXCEPTION 'production: bundle % names cut log entries of its work order, each once, none a reversal', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      attaching := ARRAY['cutLogIds'];
    END IF;
    -- end owb G10 (b)
    -- owb G10 (c): madeAtPrint is in neither `changing` nor `attaching`: this compare keeps it as the bundle was made.
    IF (to_jsonb(NEW) - (kept || changing || attaching)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || changing || attaching)) THEN
      RAISE EXCEPTION 'production: bundle % changes only by a reprint of its ticket or by being voided', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- end owb G10 (c)
    IF OLD."status" = 'VOID' THEN
      RAISE EXCEPTION 'production: bundle % is VOID; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."code", NEW."replacedCodes") IS DISTINCT FROM (OLD."code", OLD."replacedCodes")
       AND (NEW."code" = OLD."code" OR NEW."replacedCodes" IS DISTINCT FROM (OLD."replacedCodes" || OLD."code")
            OR NEW."code" = ANY (NEW."replacedCodes") OR NEW."status" <> 'ACTIVE') THEN
      RAISE EXCEPTION 'production: a reprint of bundle % gives its ticket a new code and voids the old one (MES-073)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."code" IS DISTINCT FROM OLD."code"
       AND NOT EXISTS (SELECT 1 FROM "BundleReprint" r
                        WHERE r."tenantId" = NEW."tenantId" AND r."bundleId" = NEW."id" AND r."code" = NEW."code" AND r."replacedCode" = OLD."code") THEN
      RAISE EXCEPTION 'production: a reprint of bundle % says why: its BundleReprint row (% replacing %, with the reason) comes first (MES-073)', OLD."id", NEW."code", OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."code") = '' THEN
    RAISE EXCEPTION 'production: bundle % has a code', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."clientEventId" IS NOT NULL AND btrim(NEW."clientEventId") = '' THEN
    RAISE EXCEPTION 'production: bundle % has a client event id that is not blank, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'VOID') <> (NEW."voidedAt" IS NOT NULL)
     OR (NEW."status" = 'VOID') <> (btrim(coalesce(NEW."voidReason", '')) <> '') THEN
    RAISE EXCEPTION 'production: bundle % is % with the wrong void (a VOID bundle has its time and reason)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
