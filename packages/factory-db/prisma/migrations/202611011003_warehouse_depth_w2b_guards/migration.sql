-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202611011002_warehouse_depth_w2b_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp, and keep it OUT of prisma/migrations while `npm run migration` runs (it needs the
-- new tables).

-- The warehouse in depth (W2b-5, schema wave 36/44, B-W2b-277): the rules of its tables for every login, the owner included.
-- The API answers first, in words (B-W2b-289 locations, -292 moves on the floor and tasks, -298 substitutes, -299 counts,
-- -300 goods without a PO, -313 lots, -314 posting dates, -326 transfers); these are the last word. Every refusal is a
-- check_violation (SQLSTATE 23514) that says why.
--
--   Location             (W1) a label code (1 to 64 letters, digits and . _ : / -, unique in the tenant: the Prisma unique);
--                        a block with when and why (COUNT, DAMAGE, CLEAN_UP; OTHER in words), by whom, until a day not
--                        before it; a CUSTOMER location names its customer or brand, as a SUBCONTRACTOR one its workshop
--                        (W2a's factory_location_party_guard redefined).
--   StockMove            (W1) its own trigger StockMove_warehouse_check: TRANSFER_OUT only leaves (the transfer's transit
--                        location), TRANSFER_IN only enters (the line's lot and hide made at the other site), both name their
--                        transfer line, which only a TRANSFER (onto the transit place: the ship), an ADJUSTMENT (off it: a
--                        difference written off) and they name, at the right site, of the line's goods, while the transfer
--                        is in that state; a reversal names its move's line; a TRANSIT location moves only with a transfer;
--                        a blocked location (until the end of its until-day) and a frozen count line (its location and item,
--                        while its count is COUNTING and it is not counted or its asked recount not done) take no move but a
--                        COUNT; a posting date not after the day it is entered, not before the company's back-dating limit,
--                        today's from the floor. W2a's factory_stock_move_period_lock redefined: it reads the posting date.
--   Lot                  (W1) its own trigger Lot_lifecycle: the lifecycle fits the quality status, and the database moves it
--                        when a quality decision leaves it unfitting; a parent lot of the same colour that is no child, set
--                        once; the attributes typed per kind of material. W1's factory_lot_guard redefined: a REJECTED lot's
--                        lifecycle still moves. Existing lots get their lifecycle from their quality status and the ledger.
--   GoodsReceipt         (W1) its own trigger GoodsReceipt_unplanned_check: the kind fixed; a holding place exactly when
--                        UNPLANNED (not archived, no outside or transit place); made without a purchase order, POSTED only once
--                        one names it; the buyer's task (UNPLANNED only, named once, by the office) a Task of the receipt.
--   StockCount           (W2a) factory_stock_count_guard redefined: freezeMoves chosen while DRAFT; leaving COUNTING takes the
--                        count's lock; the counter-not-approver rule follows the company's switch and reads the scans too.
--   StockCountLine       (W2a) factory_stock_count_line_guard redefined: a floor session takes the count's lock (not its row),
--                        works only while COUNTING, adds only ADDED lines and writes only the count and recount; frozenAt only
--                        on a line of a count that freezes moves (fixed, as the snapshot's columns are).
--   DefaultLocation      the site, kind, purpose and creation fixed; a location not archived and no SUBCONTRACTOR, CUSTOMER or
--                        TRANSIT place when named; one active per site, kind and purpose (two partial unique indexes).
--   TransferOrder        numbered (TRANSFER); DRAFT → SHIPPED | CANCELLED, SHIPPED → PARTLY_RECEIVED | RECEIVED, PARTLY_RECEIVED
--                        → RECEIVED; another site; the transit place a TRANSIT location of the sending site; shipped with its
--                        DDT (series of kind DDT, number, date, reason, carrier, packages, weight, appearance) exactly from
--                        SHIPPED on, then fixed; shipped once every line says what left; RECEIVED once every line arrived or
--                        says why not; RECEIVED and CANCELLED frozen but the note.
--   TransferLine         written and removed while DRAFT; then only what arrived (never back, at most what left), where it was
--                        put, what the receipt made there (named once) and the difference; the item's tracking, the lots'
--                        colour, a roll of its lot.
--   CountSchedule        at least one of location, class, kind; every 1 to 366 days; the last count a closed count.
--   StockCountScan       append-only; into a COUNTING count (under its lock, shared), above 0, by an office user or a worker
--                        (a floor session as its worker); a RECOUNT scan only once a recount was asked, and another person's
--                        while the switch is on.
--   InventorySettings    company and creation fixed; 0 to 366 days back; the threshold 0 or more; a separation rule switched
--                        off exactly with its reason.
--   WarehouseTask        born OPEN; OPEN → TAKEN | DONE | CANCELLED, TAKEN → OPEN | DONE | CANCELLED; who took and who did
--                        (a worker or an office user, exactly one; a floor session as its worker); a floor session only takes,
--                        gives back and does; a role of the floor or a worker, not both.
--   MaterialSubstitution born WAITING; WAITING → APPROVED | REFUSED | WITHDRAWN, APPROVED → ISSUED | WITHDRAWN; nobody decides
--                        their own request; an alternate of the line for another material, another lot of the same one;
--                        issued with ISSUE moves of the work order and the substitute; a floor session asks and issues only.
--   never deleted        DefaultLocation, TransferOrder, CountSchedule, InventorySettings, WarehouseTask, MaterialSubstitution
--                        (BEFORE DELETE, for the owner: the runtime roles have no DELETE grant); a TransferLine only while its
--                        transfer is DRAFT. TRUNCATE refused on all eight.
--
-- The tenant and site of a row are held by the policies (USING and WITH CHECK) and by the references, not here: the triggers
-- leave "tenantId" and "siteId" to them. A rule that reads another row skips a row this session cannot see. An UPDATE that
-- changes nothing passes. AFTER triggers on the new tables (the policies speak first); BEFORE where a trigger writes NEW (the
-- lot's lifecycle) or W1's own triggers do.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers and
-- dates moved) and insert the copy: so the first rows the seed gives are ones a copy may repeat (an inactive default, a DRAFT
-- transfer and its line, an OPEN task, a WAITING substitution, a COUNT scan and an ADDED line of a COUNTING count).
--
-- USED FROM EARLIER WAVES, as they are: "factory_document_number_guard" (…_numbering_floor_documents_guards),
-- "factory_money_rome_day" (…_money_w2a_guards), "factory_styles_decimal_ok" and "factory_styles_distinct"
-- (…_styles_libraries_w2b_guards), "factory_recall_words_ok", "factory_recall_not_future" and "factory_recall_model_name_ok"
-- (…_recall_claims_w2b_guards).

-- =====================================================================================================================
-- Shared
-- =====================================================================================================================

CREATE FUNCTION "factory_wh_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'warehouse: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_wh_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'warehouse: % % is kept, never deleted (retire, cancel, refuse or withdraw it)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_wh_refuse_scan_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a scan is kept as it was made (a wrong count is recounted)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- A count's lock (pg_advisory_xact_lock): shared by the floor's line and scan writes, exclusive when the count leaves COUNTING.
CREATE FUNCTION "factory_wh_count_key"(tenant uuid, count_id uuid) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended(concat_ws('|', 'factory.stock-count', tenant, count_id), 0)
$$;

-- The counter-not-approver switch of a company (SCM-293): its row's value, else the tenant-wide row's, else on.
CREATE FUNCTION "factory_wh_counter_not_approver"(tenant uuid, company uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT s."counterNotApprover" FROM "InventorySettings" s
      WHERE s."tenantId" = tenant AND s."companyId" = company AND s."counterNotApprover" IS NOT NULL ORDER BY s."createdAt", s."id" LIMIT 1),
    (SELECT s."counterNotApprover" FROM "InventorySettings" s
      WHERE s."tenantId" = tenant AND s."companyId" IS NULL AND s."counterNotApprover" IS NOT NULL ORDER BY s."createdAt", s."id" LIMIT 1),
    true)
$$;

-- The back-dating limit of a company's posting dates (SCM-196): its row's days, else the tenant-wide row's; NULL: none.
CREATE FUNCTION "factory_wh_back_dating_days"(tenant uuid, company uuid) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT s."backDatingDays" FROM "InventorySettings" s
      WHERE s."tenantId" = tenant AND s."companyId" = company AND s."backDatingDays" IS NOT NULL ORDER BY s."createdAt", s."id" LIMIT 1),
    (SELECT s."backDatingDays" FROM "InventorySettings" s
      WHERE s."tenantId" = tenant AND s."companyId" IS NULL AND s."backDatingDays" IS NOT NULL ORDER BY s."createdAt", s."id" LIMIT 1))
$$;

-- A reason code: a code without spaces, 1 to 60 characters (records keep the code of a reason list, never a reference).
CREATE FUNCTION "factory_wh_code_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NULL OR code ~ '^\S{1,60}$'
$$;

DO $$
DECLARE
  name text;
BEGIN
  -- StockCountScan's is written out below, beside its append-only trigger (scripts/factory/check-append-only.mjs reads it).
  FOREACH name IN ARRAY ARRAY['DefaultLocation', 'TransferOrder', 'TransferLine', 'CountSchedule', 'InventorySettings', 'WarehouseTask',
                              'MaterialSubstitution'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_wh_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['DefaultLocation', 'TransferOrder', 'CountSchedule', 'InventorySettings', 'WarehouseTask', 'MaterialSubstitution'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "factory_wh_never_deleted"()', name || '_never_deleted', name);
  END LOOP;
END
$$;

-- =====================================================================================================================
-- Location (W1; SCM-177, SCM-178, SCM-181)
-- =====================================================================================================================

-- W2a's factory_location_party_guard (…_supply_w2a_guards), its whole body, + a CUSTOMER location names its customer.
CREATE OR REPLACE FUNCTION "factory_location_party_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  party_roles text[];
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."partyId" IS DISTINCT FROM OLD."partyId" THEN
    RAISE EXCEPTION 'inventory: the workshop (or customer) of location % never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-5 (wave 36/44, SCM-177): a CUSTOMER location names the customer that holds it, as a SUBCONTRACTOR one its workshop.
  IF (NEW."kind" IN ('SUBCONTRACTOR', 'CUSTOMER')) <> (NEW."partyId" IS NOT NULL) THEN
    RAISE EXCEPTION 'inventory: location % is a SUBCONTRACTOR or CUSTOMER location exactly when it names the party that holds it (the workshop, the customer)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'CUSTOMER' AND (TG_OP = 'INSERT' OR NEW."kind" IS DISTINCT FROM OLD."kind") THEN
    SELECT p."roles"::text[] INTO party_roles FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND NOT (party_roles && ARRAY['CUSTOMER', 'BRAND']) THEN
      RAISE EXCEPTION 'inventory: location % is a CUSTOMER location of a customer or a brand, not of party %', NEW."id", NEW."partyId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- The label code and the block. A block is all or none (when and why; who, the words and the day optional, OTHER with its
-- words); unblocking clears all five.
CREATE FUNCTION "factory_location_w2b_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF NEW."labelCode" IS NOT NULL AND NEW."labelCode" !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$' THEN
    RAISE EXCEPTION 'inventory: the label code of location % is 1 to 64 letters, digits and . _ : / - without spaces (the code its bin label carries), not "%"', NEW."id", NEW."labelCode"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."blockedAt" IS NULL) <> (NEW."blockReason" IS NULL)
     OR (NEW."blockedAt" IS NULL AND (NEW."blockedById" IS NOT NULL OR NEW."blockNote" IS NOT NULL OR NEW."blockedUntil" IS NOT NULL))
     OR (NEW."blockReason" = 'OTHER' AND NEW."blockNote" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."blockNote", 500, true)
     OR NEW."blockedUntil" < "factory_money_rome_day"(NEW."blockedAt") THEN
    RAISE EXCEPTION 'inventory: location % is blocked with when and why (COUNT, DAMAGE, CLEAN_UP, or OTHER in words up to 500 characters), and optionally by whom and until a day not before it was blocked; or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."blockedAt" IS DISTINCT FROM OLD."blockedAt") AND NOT "factory_recall_not_future"(NEW."blockedAt") THEN
    RAISE EXCEPTION 'inventory: location % is blocked at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Location_w2b_check" AFTER INSERT OR UPDATE ON "Location"
  FOR EACH ROW EXECUTE FUNCTION "factory_location_w2b_check"();

-- =====================================================================================================================
-- Lot (W1; SCM-185, SCM-236, SCM-237)
-- =====================================================================================================================

-- W1's factory_lot_guard (…_supply_guards), its whole body, + a REJECTED lot's lifecycle still moves (BLOCKED until its stock
-- left, then RETURNED or DEPLETED).
CREATE OR REPLACE FUNCTION "factory_lot_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  item_tracking text;
  item_needs_test boolean;
  item_limit numeric;
  line_item uuid;
  line_colour uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory: lot % is rejected, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."qualityStatus" NOT IN ('QUARANTINE', 'RELEASED') THEN
      RAISE EXCEPTION 'inventory: lot % starts in QUARANTINE (or RELEASED), not %', NEW."id", NEW."qualityStatus"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."tracking"::text, i."requiresCrViTest", i."crViLimitMgKg" INTO item_tracking, item_needs_test, item_limit
      FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND THEN
      IF item_tracking NOT IN ('LOT', 'HIDE') THEN
        RAISE EXCEPTION 'inventory: item % is tracked by %; only an item tracked by LOT or HIDE has lots (lot %)', NEW."itemId", item_tracking, NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF item_needs_test AND NOT NEW."requiresCrViTest" THEN
        RAISE EXCEPTION 'inventory: item % needs Cr VI evidence (REACH Annex XVII entry 47), so does its lot %', NEW."itemId", NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."crViLimitMgKg" > item_limit THEN
        RAISE EXCEPTION 'inventory: the Cr VI limit of lot % is its item''s (% mg/kg) or lower', NEW."id", item_limit
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."receiptLineId" IS NOT NULL THEN
      SELECT l."itemId", l."itemColourId" INTO line_item, line_colour
        FROM "GoodsReceiptLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."receiptLineId";
      IF FOUND AND (line_item <> NEW."itemId" OR line_colour IS DISTINCT FROM NEW."itemColourId") THEN
        RAISE EXCEPTION 'inventory: lot % is of its receipt line''s item and colour', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."itemId", NEW."itemColourId", NEW."code", NEW."supplierId", NEW."receiptLineId",
        NEW."requiresCrViTest", NEW."crViLimitMgKg", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."itemId", OLD."itemColourId", OLD."code", OLD."supplierId", OLD."receiptLineId",
        OLD."requiresCrViTest", OLD."crViLimitMgKg", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'inventory: the item, colour, number, supplier, receipt, Cr VI requirement and creation of lot % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."qualityStatus" <> OLD."qualityStatus"
       AND NOT ((OLD."qualityStatus" = 'QUARANTINE' AND NEW."qualityStatus" IN ('RELEASED', 'REJECTED', 'BLOCKED'))
                OR (OLD."qualityStatus" = 'RELEASED' AND NEW."qualityStatus" = 'BLOCKED')
                OR (OLD."qualityStatus" = 'BLOCKED' AND NEW."qualityStatus" IN ('RELEASED', 'REJECTED'))) THEN
      RAISE EXCEPTION 'inventory: lot % cannot move from % to %', OLD."id", OLD."qualityStatus", NEW."qualityStatus"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."qualityStatus" = 'REJECTED'
       AND (to_jsonb(NEW) - (kept || ARRAY['qualityNote', 'lifecycle', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['qualityNote', 'lifecycle', 'version', 'updatedAt'])) THEN
      -- W2b-5 (wave 36/44): and its lifecycle (BLOCKED until its stock left, then RETURNED or DEPLETED).
      RAISE EXCEPTION 'inventory: lot % is REJECTED; only its quality note (and W2b-5: its lifecycle) changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."crViStatus" <> OLD."crViStatus"
       AND NOT ((OLD."crViStatus" = 'PENDING' AND NEW."crViStatus" IN ('PASS', 'FAIL'))
                OR (OLD."crViStatus" = 'PASS' AND NEW."crViStatus" = 'FAIL')) THEN
      RAISE EXCEPTION 'inventory: the Cr VI result of lot % cannot move from % to %', OLD."id", OLD."crViStatus", NEW."crViStatus"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."crViMgKg", NEW."crViEvidence", NEW."crViTestedAt") IS DISTINCT FROM (OLD."crViMgKg", OLD."crViEvidence", OLD."crViTestedAt")
       AND OLD."crViStatus" <> 'PENDING' AND NOT (OLD."crViStatus" = 'PASS' AND NEW."crViStatus" = 'FAIL') THEN
      RAISE EXCEPTION 'inventory: the Cr VI result of lot % is %; it changes only to FAIL, on later evidence', OLD."id", OLD."crViStatus"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."requiresCrViTest" <> (NEW."crViStatus" <> 'NOT_REQUIRED') OR NEW."requiresCrViTest" <> (NEW."crViLimitMgKg" IS NOT NULL)
     OR NEW."crViLimitMgKg" <= 0 OR NEW."crViLimitMgKg" > 3 OR NEW."crViMgKg" < 0 THEN
    RAISE EXCEPTION 'inventory: lot % needs the Cr VI test exactly when it has a limit (above 0, at most 3 mg/kg: REACH Annex XVII entry 47) and a result other than NOT_REQUIRED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."crViStatus" = 'PASS' AND NEW."crViMgKg" >= NEW."crViLimitMgKg") OR (NEW."crViStatus" = 'FAIL' AND NEW."crViMgKg" < NEW."crViLimitMgKg") THEN
    RAISE EXCEPTION 'inventory: lot % measured % mg/kg of Cr VI against a limit of %: below the limit is a PASS, at or above it a FAIL', NEW."id", NEW."crViMgKg", NEW."crViLimitMgKg"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."crViStatus" IN ('PASS', 'FAIL') AND NEW."crViEvidence" IS NULL THEN
    RAISE EXCEPTION 'inventory: the Cr VI result of lot % names its evidence (a report on the lot, or the supplier''s report)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."qualityStatus" = 'RELEASED' AND NEW."requiresCrViTest" AND NEW."crViStatus" <> 'PASS' THEN
    RAISE EXCEPTION 'inventory: lot % needs Cr VI evidence (REACH Annex XVII entry 47); its result is %, and it is released only with a PASS', NEW."id", NEW."crViStatus"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."qualityStatus" <> 'QUARANTINE') <> (NEW."qualityDecidedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'inventory: lot % is % with the wrong quality decision time', NEW."id", NEW."qualityStatus"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- The attributes of a lot, typed per kind of material (SCM-185): NULL when they fit, else what is wrong (the message's end).
CREATE FUNCTION "factory_lot_attributes_problem"(item_kind text, attrs jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  allowed text[];
  entry record;
  grade record;
  total numeric := 0;
BEGIN
  IF attrs IS NULL OR jsonb_typeof(attrs) <> 'object' THEN
    RETURN 'are an object of its kind''s attributes ({} for none)';
  END IF;
  allowed := CASE
    WHEN item_kind = 'LEATHER' THEN ARRAY['thicknessMinMm', 'thicknessMaxMm', 'finish', 'tannage', 'gradeMix', 'origin']
    WHEN item_kind IN ('TEXTILE', 'LINING', 'MEMBRANE', 'PADDING') THEN ARRAY['widthCm', 'weightGsm', 'origin']
    ELSE ARRAY['origin'] END;
  FOR entry IN SELECT e.key, e.value FROM jsonb_each(attrs) AS e LOOP
    IF NOT (entry.key = ANY (allowed)) THEN
      RETURN format('name "%s", not an attribute of a lot of %s (%s)', entry.key, coalesce(item_kind, 'this kind'), array_to_string(allowed, ', '));
    END IF;
    IF entry.key IN ('thicknessMinMm', 'thicknessMaxMm')
       AND NOT (jsonb_typeof(entry.value) = 'string' AND "factory_styles_decimal_ok"(entry.value #>> '{}', 20)) THEN
      RETURN format('give %s as a decimal string above 0 and at most 20 (mm)', entry.key);
    END IF;
    IF entry.key IN ('widthCm', 'weightGsm')
       AND NOT (jsonb_typeof(entry.value) = 'string' AND "factory_styles_decimal_ok"(entry.value #>> '{}', 100000)) THEN
      RETURN format('give %s as a decimal string above 0', entry.key);
    END IF;
    IF entry.key IN ('finish', 'origin')
       AND NOT (jsonb_typeof(entry.value) = 'string' AND "factory_recall_words_ok"(entry.value #>> '{}', 100, false)) THEN
      RETURN format('give %s as words of 1 to 100 characters', entry.key);
    END IF;
    IF entry.key = 'tannage'
       AND NOT (jsonb_typeof(entry.value) = 'string' AND (entry.value #>> '{}') IN ('CHROME', 'VEGETABLE', 'CHROME_FREE', 'COMBINATION')) THEN
      RETURN 'give the tannage as CHROME, VEGETABLE, CHROME_FREE or COMBINATION';
    END IF;
    IF entry.key = 'gradeMix' THEN
      IF jsonb_typeof(entry.value) <> 'object' OR entry.value = '{}'::jsonb THEN
        RETURN 'give the grade mix as { "<grade code>": "<percent>" }, at least one grade';
      END IF;
      FOR grade IN SELECT g.key, g.value FROM jsonb_each(entry.value) AS g LOOP
        IF grade.key !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$' OR jsonb_typeof(grade.value) <> 'string'
           OR NOT "factory_styles_decimal_ok"(grade.value #>> '{}', 100) THEN
          RETURN 'give the grade mix as { "<grade code>": "<percent above 0, at most 100>" }';
        END IF;
        total := total + (grade.value #>> '{}')::numeric;
      END LOOP;
      IF total > 100 THEN
        RETURN format('have a grade mix of %s percent; it adds up to at most 100', total);
      END IF;
    END IF;
  END LOOP;
  IF attrs ? 'thicknessMinMm' AND attrs ? 'thicknessMaxMm'
     AND (attrs ->> 'thicknessMinMm')::numeric > (attrs ->> 'thicknessMaxMm')::numeric THEN
    RETURN 'have a thickness range whose minimum is above its maximum';
  END IF;
  RETURN NULL;
END
$$;

-- Lot_lifecycle (BEFORE: it writes NEW; after W1's Lot_guard, by name)
--   lifecycle  it fits the quality status: QUARANTINE {QUARANTINE}; RELEASED {RELEASED, IN_USE, DEPLETED, RETURNED};
--              BLOCKED and REJECTED {BLOCKED, DEPLETED, RETURNED}. A new lot, or a quality decision that leaves the lifecycle
--              unfitting while the same update does not move it, moves it: QUARANTINE, RELEASED, BLOCKED (a REJECTED lot is
--              held until its stock left). The inventory module moves it further by the events (B-W2b-313).
--   parent     set when the lot is made, never changed; not itself; of the same colour; a parent that is no child itself.
--   attributes typed per kind of material (factory_lot_attributes_problem).
CREATE FUNCTION "factory_lot_w2b_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fits text[];
  parent record;
  item_kind text;
  problem text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  fits := CASE NEW."qualityStatus"::text
            WHEN 'QUARANTINE' THEN ARRAY['QUARANTINE']
            WHEN 'RELEASED' THEN ARRAY['RELEASED', 'IN_USE', 'DEPLETED', 'RETURNED']
            ELSE ARRAY['BLOCKED', 'DEPLETED', 'RETURNED'] END;
  IF (TG_OP = 'INSERT' OR (NEW."qualityStatus" <> OLD."qualityStatus" AND NEW."lifecycle" = OLD."lifecycle"))
     AND NOT (NEW."lifecycle"::text = ANY (fits)) THEN
    NEW."lifecycle" := (CASE NEW."qualityStatus"::text WHEN 'QUARANTINE' THEN 'QUARANTINE' WHEN 'RELEASED' THEN 'RELEASED' ELSE 'BLOCKED' END)::"LotLifecycle";
  END IF;
  IF NOT (NEW."lifecycle"::text = ANY (fits)) THEN
    RAISE EXCEPTION 'inventory: lot % is % (quality) and cannot be % (QUARANTINE exactly while in quarantine; RELEASED and IN_USE only released; BLOCKED only blocked or rejected)', NEW."id", NEW."qualityStatus", NEW."lifecycle"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."parentLotId" IS DISTINCT FROM OLD."parentLotId" THEN
    RAISE EXCEPTION 'inventory: the lot lot % was split from is set when it is made, never changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."parentLotId" IS NOT NULL THEN
    IF NEW."parentLotId" = NEW."id" THEN
      RAISE EXCEPTION 'inventory: lot % is not split from itself', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT p."itemColourId", p."parentLotId" INTO parent FROM "Lot" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."parentLotId";
    IF FOUND AND (parent."itemColourId" IS DISTINCT FROM NEW."itemColourId" OR parent."parentLotId" IS NOT NULL) THEN
      RAISE EXCEPTION 'inventory: lot % is split from a lot of its own colour that is not itself split from another (lot %)', NEW."id", NEW."parentLotId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW."attributes" IS DISTINCT FROM OLD."attributes" THEN
    SELECT i."kind"::text INTO item_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    problem := "factory_lot_attributes_problem"(item_kind, NEW."attributes");
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'inventory: the attributes of lot % %', NEW."code", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Lot_lifecycle" BEFORE INSERT OR UPDATE ON "Lot"
  FOR EACH ROW EXECUTE FUNCTION "factory_lot_w2b_check"();

-- The lots made before this wave: their lifecycle from their quality status and the ledger (a lot whose moves add up to
-- nothing is DEPLETED; a released one issued from is IN_USE; a rejected one sent back is RETURNED; else as its status).
UPDATE "Lot" l
   SET "lifecycle" = (CASE
     WHEN l."qualityStatus" = 'QUARANTINE' THEN 'QUARANTINE'
     WHEN l."qualityStatus" = 'REJECTED' AND EXISTS (SELECT 1 FROM "StockMove" m WHERE m."tenantId" = l."tenantId" AND m."lotId" = l."id" AND m."reason" = 'SUPPLIER_RETURN') THEN 'RETURNED'
     WHEN EXISTS (SELECT 1 FROM "StockMove" m WHERE m."tenantId" = l."tenantId" AND m."lotId" = l."id")
          AND (SELECT coalesce(sum(CASE WHEN m."toLocationId" IS NOT NULL THEN m."baseQuantity" ELSE 0 END)
                             - sum(CASE WHEN m."fromLocationId" IS NOT NULL THEN m."baseQuantity" ELSE 0 END), 0)
                 FROM "StockMove" m WHERE m."tenantId" = l."tenantId" AND m."lotId" = l."id") = 0 THEN 'DEPLETED'
     WHEN l."qualityStatus" = 'RELEASED' AND EXISTS (SELECT 1 FROM "StockMove" m WHERE m."tenantId" = l."tenantId" AND m."lotId" = l."id" AND m."reason" = 'ISSUE') THEN 'IN_USE'
     WHEN l."qualityStatus" = 'RELEASED' THEN 'RELEASED'
     ELSE 'BLOCKED' END)::"LotLifecycle"
 WHERE l."lifecycle" = 'QUARANTINE' AND l."qualityStatus" <> 'QUARANTINE';

-- =====================================================================================================================
-- GoodsReceipt (W1; SCM-122)
--   kind       fixed once made.
--   UNPLANNED  exactly with a holding place (a location of the site, not archived, no SUBCONTRACTOR, CUSTOMER or TRANSIT
--              place, when named); made without a purchase order; POSTED only once a purchase order names it (nothing of it
--              is in stock, so nothing is used, until then).
--   buyer task UNPLANNED only; named once, by the office (a floor session cannot read tasks): a Task of this receipt.
-- =====================================================================================================================
CREATE FUNCTION "factory_goods_receipt_unplanned_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  place_status text;
  place_kind text;
  task_type text;
  task_record uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."kind" <> OLD."kind" THEN
    RAISE EXCEPTION 'inventory: goods receipt % is %; its kind never changes', OLD."id", OLD."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'UNPLANNED') <> (NEW."holdingLocationId" IS NOT NULL) THEN
    RAISE EXCEPTION 'inventory: goods receipt % names the place its goods wait in exactly when it is UNPLANNED (goods nobody ordered)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."buyerTaskId" IS NOT NULL AND NEW."kind" <> 'UNPLANNED' THEN
    RAISE EXCEPTION 'inventory: goods receipt % is %; only goods nobody ordered wait for a buyer''s task', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."kind" = 'UNPLANNED' AND NEW."purchaseOrderId" IS NOT NULL THEN
    RAISE EXCEPTION 'inventory: goods receipt % holds goods nobody ordered: it is made without a purchase order (a buyer names one later)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'UNPLANNED' AND NEW."status" = 'POSTED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'POSTED') AND NEW."purchaseOrderId" IS NULL THEN
    RAISE EXCEPTION 'inventory: goods receipt % holds goods nobody ordered; it is posted once a purchase order names them (nothing of it is used until then)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."buyerTaskId" IS NOT NULL AND NEW."buyerTaskId" IS DISTINCT FROM OLD."buyerTaskId" THEN
    RAISE EXCEPTION 'inventory: the buyer''s task of goods receipt % is named once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."holdingLocationId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."holdingLocationId" IS DISTINCT FROM OLD."holdingLocationId") THEN
    SELECT l."status"::text, l."kind"::text INTO place_status, place_kind
      FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."holdingLocationId";
    IF FOUND AND (place_status = 'ARCHIVED' OR place_kind IN ('SUBCONTRACTOR', 'CUSTOMER', 'TRANSIT')) THEN
      RAISE EXCEPTION 'inventory: goods without a purchase order wait in a place of the site that is not archived and not a workshop''s, a customer''s or a transit place (receipt %)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."buyerTaskId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."buyerTaskId" IS DISTINCT FROM OLD."buyerTaskId") THEN
    IF current_user = 'factory_floor_runtime' THEN
      RAISE EXCEPTION 'inventory: the buyer''s task of goods receipt % is named by the office', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT t."recordType", t."recordId" INTO task_type, task_record FROM "Task" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."buyerTaskId";
    IF FOUND AND (task_type IS DISTINCT FROM 'GoodsReceipt' OR task_record IS DISTINCT FROM NEW."id") THEN
      RAISE EXCEPTION 'inventory: the buyer''s task of goods receipt % is a task on that receipt', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "GoodsReceipt_unplanned_check" AFTER INSERT OR UPDATE ON "GoodsReceipt"
  FOR EACH ROW EXECUTE FUNCTION "factory_goods_receipt_unplanned_check"();

-- =====================================================================================================================
-- StockMove (W1; SCM-181, SCM-196, SCM-219, SCM-220, SCM-226)
-- =====================================================================================================================

-- W2a's factory_stock_move_period_lock (…_money_w2a_guards), its whole body, + the posting date.
CREATE OR REPLACE FUNCTION "factory_stock_move_period_lock"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'factory_floor_runtime' THEN
    RETURN NEW;
  END IF;
  -- W2b-5 (wave 36/44, SCM-196): the day it counts on in the books: its posting date, else the day it happened.
  PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", coalesce(NEW."postingDate", "factory_money_rome_day"(NEW."occurredAt")), format('stock move %s (%s)', NEW."id", NEW."reason"));
  RETURN NEW;
END
$$;

-- StockMove_warehouse_check (BEFORE INSERT; W1's StockMove_check is untouched)
--   transfers  TRANSFER_OUT and TRANSFER_IN name their transfer line; only they, a TRANSFER and an ADJUSTMENT name one; a
--              TRANSFER_OUT only leaves, a TRANSFER_IN only enters (a reversal swaps them; W1's check compares it with its move),
--              and a reversal names the line its move names. Never from a floor session. Of the line's item and colour; a
--              TRANSFER_IN at the receiving site, as the lot and hide the line names there (toLotId, toHideId), into no transit
--              place; the others at the sending site, of the lot and hide the line sends: the ship (TRANSFER) onto the
--              transfer's transit location while it is DRAFT or SHIPPED, the receipt (TRANSFER_OUT, with its TRANSFER_IN)
--              off it while SHIPPED or PARTLY_RECEIVED, a difference written off (ADJUSTMENT) off it from SHIPPED on.
--   transit    a TRANSIT location moves only with a transfer line.
--   blocked    a blocked location takes no move in or out but a COUNT, until the end of its until-day.
--   frozen     a frozen line of a COUNTING count that is not counted, or whose asked recount is not done, takes no move but a
--              COUNT of its item into or out of its location.
--   posting    a posting date not after the day the move is entered (Europe/Rome), not before the company's back-dating
--              limit; a floor session's is today's.
CREATE FUNCTION "factory_stock_move_warehouse_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  floor_session boolean := current_user = 'factory_floor_runtime';
  line record;
  original_line uuid;
  blocked record;
  frozen record;
  limit_days integer;
  entered date;
BEGIN
  -- 1. The transfer line.
  IF NEW."reason" IN ('TRANSFER_OUT', 'TRANSFER_IN') AND NEW."transferLineId" IS NULL THEN
    RAISE EXCEPTION 'inventory: stock move % is a % and names its transfer line', NEW."id", NEW."reason"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."transferLineId" IS NOT NULL AND NEW."reason" NOT IN ('TRANSFER', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT') THEN
    RAISE EXCEPTION 'inventory: stock move % is a %; only a TRANSFER, TRANSFER_OUT, TRANSFER_IN or ADJUSTMENT names a transfer line', NEW."id", NEW."reason"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reversalOfId" IS NULL
     AND ((NEW."reason" = 'TRANSFER_OUT' AND NOT (NEW."fromLocationId" IS NOT NULL AND NEW."toLocationId" IS NULL))
          OR (NEW."reason" = 'TRANSFER_IN' AND NOT (NEW."toLocationId" IS NOT NULL AND NEW."fromLocationId" IS NULL))) THEN
    RAISE EXCEPTION 'inventory: stock move % is a % with the wrong locations (a TRANSFER_OUT only leaves one, a TRANSFER_IN only enters one)', NEW."id", NEW."reason"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reversalOfId" IS NOT NULL THEN
    SELECT m."transferLineId" INTO original_line FROM "StockMove" m
     WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."reversalOfId";
    IF FOUND AND original_line IS DISTINCT FROM NEW."transferLineId" THEN
      RAISE EXCEPTION 'inventory: stock move % reverses move % and names its transfer line', NEW."id", NEW."reversalOfId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."transferLineId" IS NOT NULL THEN
    IF floor_session THEN
      RAISE EXCEPTION 'inventory: transfers between sites are posted by the office (stock move %)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT l."fromSiteId", l."toSiteId", l."itemId", l."itemColourId", l."lotId", l."hideId", l."toLotId", l."toHideId",
           t."status"::text AS status, t."transitLocationId", t."number"
      INTO line
      FROM "TransferLine" l JOIN "TransferOrder" t ON t."tenantId" = l."tenantId" AND t."id" = l."transferId"
     WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."transferLineId";
    IF FOUND THEN
      IF NEW."itemId" <> line."itemId" OR NEW."itemColourId" IS DISTINCT FROM line."itemColourId" THEN
        RAISE EXCEPTION 'inventory: stock move % carries a line of transfer %: its item in its colour', NEW."id", line."number"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."reason" = 'TRANSFER_IN' THEN
        IF NEW."siteId" <> line."toSiteId" OR NEW."lotId" IS DISTINCT FROM line."toLotId" OR NEW."hideId" IS DISTINCT FROM line."toHideId" THEN
          RAISE EXCEPTION 'inventory: stock move % receives a line of transfer % at the receiving site, as the lot and hide the line names there (name them on the line first)', NEW."id", line."number"
            USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM "Location" x WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId"
                    AND x."id" = coalesce(NEW."toLocationId", NEW."fromLocationId") AND x."kind" = 'TRANSIT') THEN
          RAISE EXCEPTION 'inventory: stock move % receives a line of transfer % into a place of the site, not a transit one', NEW."id", line."number"
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        IF NEW."siteId" <> line."fromSiteId" OR NEW."lotId" IS DISTINCT FROM line."lotId" OR NEW."hideId" IS DISTINCT FROM line."hideId" THEN
          RAISE EXCEPTION 'inventory: stock move % moves a line of transfer % at the sending site, of the lot and hide the line sends', NEW."id", line."number"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."reversalOfId" IS NULL
           AND ((NEW."reason" = 'TRANSFER' AND NEW."toLocationId" IS DISTINCT FROM line."transitLocationId")
                OR (NEW."reason" IN ('TRANSFER_OUT', 'ADJUSTMENT')
                    AND (NEW."fromLocationId" IS DISTINCT FROM line."transitLocationId" OR NEW."toLocationId" IS NOT NULL))) THEN
          RAISE EXCEPTION 'inventory: stock move % of transfer %: the ship moves its goods onto the transfer''s transit location (a TRANSFER), the receipt (TRANSFER_OUT) and a difference written off (an ADJUSTMENT) take them off it', NEW."id", line."number"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      IF NEW."reversalOfId" IS NULL
         AND ((NEW."reason" = 'TRANSFER' AND line.status NOT IN ('DRAFT', 'SHIPPED'))
              OR (NEW."reason" IN ('TRANSFER_OUT', 'TRANSFER_IN') AND line.status NOT IN ('SHIPPED', 'PARTLY_RECEIVED'))
              OR (NEW."reason" = 'ADJUSTMENT' AND line.status NOT IN ('SHIPPED', 'PARTLY_RECEIVED', 'RECEIVED'))) THEN
        RAISE EXCEPTION 'inventory: transfer % is %: its goods leave with the ship (while it is DRAFT, in the ship''s command), are received while it is SHIPPED or PARTLY_RECEIVED, and a difference is written off from SHIPPED on (stock move %, a %)', line."number", line.status, NEW."id", NEW."reason"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- 2. A TRANSIT location moves only with a transfer.
  IF NEW."transferLineId" IS NULL
     AND EXISTS (SELECT 1 FROM "Location" x WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId"
                  AND x."id" IN (NEW."fromLocationId", NEW."toLocationId") AND x."kind" = 'TRANSIT') THEN
    RAISE EXCEPTION 'inventory: stock move % enters or leaves a transit location without its transfer; goods in transit move only with their transfer (the ship, the receipt, a difference written off)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- 3. A blocked location (SCM-181).
  IF NEW."reason" <> 'COUNT' THEN
    SELECT x."code", x."blockReason"::text AS why INTO blocked FROM "Location" x
     WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId" AND x."id" IN (NEW."fromLocationId", NEW."toLocationId")
       AND x."blockedAt" IS NOT NULL AND (x."blockedUntil" IS NULL OR x."blockedUntil" >= "factory_money_rome_day"(now()))
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'inventory: location % is blocked (%); it takes no move in or out until it is unblocked (stock move %)', blocked."code", blocked.why, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- 4. A frozen count line (SCM-226).
  IF NEW."reason" <> 'COUNT' THEN
    SELECT c."number", x."code" INTO frozen
      FROM "StockCountLine" l
      JOIN "StockCount" c ON c."tenantId" = l."tenantId" AND c."id" = l."countId"
      JOIN "Location" x ON x."tenantId" = l."tenantId" AND x."id" = l."locationId"
     WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."itemId" = NEW."itemId"
       AND l."locationId" IN (NEW."fromLocationId", NEW."toLocationId") AND l."frozenAt" IS NOT NULL
       AND c."status" = 'COUNTING'
       AND (l."countedAt" IS NULL OR (l."recountRequestedAt" IS NOT NULL AND l."recountedAt" IS NULL))
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'inventory: count % is counting this material at location % (a frozen line); its moves wait until the line is counted (stock move %)', frozen."number", frozen."code", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- 5. The posting date (SCM-196).
  IF NEW."postingDate" IS NOT NULL THEN
    entered := "factory_money_rome_day"(now());
    IF floor_session AND NEW."postingDate" <> entered THEN
      RAISE EXCEPTION 'inventory: a move posted from the floor counts on the day it is entered (%), not % (stock move %)', entered, NEW."postingDate", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."postingDate" > entered THEN
      RAISE EXCEPTION 'inventory: the posting date % of stock move % is not after the day it is entered (%)', NEW."postingDate", NEW."id", entered
        USING ERRCODE = 'check_violation';
    END IF;
    limit_days := "factory_wh_back_dating_days"(NEW."tenantId", NEW."companyId");
    IF limit_days IS NOT NULL AND NEW."postingDate" < entered - limit_days THEN
      RAISE EXCEPTION 'inventory: the posting date % of stock move % goes back further than its company allows (% days: from %)', NEW."postingDate", NEW."id", limit_days, entered - limit_days
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "StockMove_warehouse_check" BEFORE INSERT ON "StockMove"
  FOR EACH ROW EXECUTE FUNCTION "factory_stock_move_warehouse_check"();

-- =====================================================================================================================
-- StockCount and StockCountLine (W2a; SCM-226, SCM-228, SCM-229, SCM-293)
-- =====================================================================================================================

-- W2a's factory_stock_count_guard (…_stock_plan_w2a_guards), its whole body, + freezeMoves chosen while DRAFT, the count's
-- lock when it leaves COUNTING, and the counter-not-approver rule with the company's switch and the scans.
CREATE OR REPLACE FUNCTION "factory_stock_count_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  submit_cols CONSTANT text[] := ARRAY['submittedAt', 'submittedById', 'differenceAmount', 'approvalRequired'];
  approve_cols CONSTANT text[] := ARRAY['approvedAt', 'approvedById', 'approvalNote'];
  reject_cols CONSTANT text[] := ARRAY['rejectedAt', 'rejectedById', 'rejectReason'];
  apply_cols CONSTANT text[] := ARRAY['appliedAt', 'appliedById'];
  sign_cols CONSTANT text[] := ARRAY['signedOffAt', 'signedOffById', 'valuedListFileId'];
  cancel_cols CONSTANT text[] := ARRAY['cancelledAt', 'cancelReason'];
  moved boolean;
  file_type text;
  file_record uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'counts: stock count % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('DRAFT', 'COUNTING') OR NEW."submittedAt" IS NOT NULL OR NEW."approvedAt" IS NOT NULL
       OR NEW."rejectedAt" IS NOT NULL OR NEW."appliedAt" IS NOT NULL OR NEW."signedOffAt" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN
      RAISE EXCEPTION 'counts: stock count % starts DRAFT or COUNTING, with nothing submitted, decided, applied or signed off', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."kind", NEW."locationId", NEW."itemId", NEW."lotId", NEW."itemKind",
        NEW."inventoryDate", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."number", OLD."kind", OLD."locationId", OLD."itemId", OLD."lotId", OLD."itemKind",
        OLD."inventoryDate", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'counts: the company, number, kind, scope, inventory date and creation of stock count % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    moved := NEW."status" <> OLD."status";
    -- W2b-5 (wave 36/44): the floor writes lines and scans of a COUNTING count under the count's lock, shared; a count leaves
    -- COUNTING under it exclusively, so the writes in flight finish first and none follows (the floor cannot lock the row).
    IF moved AND OLD."status" = 'COUNTING' THEN
      PERFORM pg_advisory_xact_lock("factory_wh_count_key"(OLD."tenantId", OLD."id"));
    END IF;
    -- W2b-5 (SCM-226): whether it freezes what it counts is chosen while DRAFT.
    IF OLD."status" <> 'DRAFT' AND NEW."freezeMoves" IS DISTINCT FROM OLD."freezeMoves" THEN
      RAISE EXCEPTION 'counts: stock count % counts already; whether it freezes moves was chosen while it was DRAFT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('SIGNED_OFF', 'CANCELLED') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'counts: stock count % is %; it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'APPLIED'
       AND (NEW."status" <> 'SIGNED_OFF'
            OR (to_jsonb(NEW) - (kept || sign_cols || ARRAY['status', 'version', 'updatedAt']))
               IS DISTINCT FROM (to_jsonb(OLD) - (kept || sign_cols || ARRAY['status', 'version', 'updatedAt']))) THEN
      RAISE EXCEPTION 'counts: stock count % is APPLIED: its history changes no more, but the year-end sign-off', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF moved AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('COUNTING', 'CANCELLED'))
                      OR (OLD."status" = 'COUNTING' AND NEW."status" IN ('SUBMITTED', 'CANCELLED'))
                      OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('APPROVED', 'COUNTING', 'CANCELLED'))
                      OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('APPLIED', 'CANCELLED'))
                      OR (OLD."status" = 'APPLIED' AND NEW."status" = 'SIGNED_OFF')) THEN
      RAISE EXCEPTION 'counts: stock count % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."startedAt" IS NOT NULL AND NEW."startedAt" IS DISTINCT FROM OLD."startedAt")
       OR (OLD."snapshotAt" IS NOT NULL AND NEW."snapshotAt" IS DISTINCT FROM OLD."snapshotAt") THEN
      RAISE EXCEPTION 'counts: the start and snapshot of stock count % are set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (moved AND ((OLD."status" = 'COUNTING' AND NEW."status" = 'SUBMITTED') OR (OLD."status" = 'SUBMITTED' AND NEW."status" = 'COUNTING')))
       AND (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY (submit_cols))
           IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY (submit_cols)) THEN
      RAISE EXCEPTION 'counts: stock count % is submitted (and its differences valued) only in the move COUNTING → SUBMITTED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (moved AND OLD."status" = 'SUBMITTED' AND NEW."status" = 'APPROVED')
       AND (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY (approve_cols))
           IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY (approve_cols)) THEN
      RAISE EXCEPTION 'counts: stock count % is approved only in the move SUBMITTED → APPROVED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF moved AND OLD."status" = 'SUBMITTED' AND NEW."status" = 'COUNTING' THEN
      IF NEW."rejectedAt" IS NULL OR NEW."rejectedAt" IS NOT DISTINCT FROM OLD."rejectedAt" THEN
        RAISE EXCEPTION 'counts: stock count % goes back to COUNTING with a new rejection (when, by whom, why)', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY (reject_cols))
          IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY (reject_cols)) THEN
      RAISE EXCEPTION 'counts: the rejection of stock count % is written only in the move SUBMITTED → COUNTING', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (moved AND NEW."status" = 'APPLIED')
       AND (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY (apply_cols))
           IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY (apply_cols)) THEN
      RAISE EXCEPTION 'counts: stock count % is applied only in the move APPROVED → APPLIED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (moved AND NEW."status" = 'SIGNED_OFF')
       AND (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY (sign_cols))
           IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY (sign_cols)) THEN
      RAISE EXCEPTION 'counts: stock count % is signed off only in the move APPLIED → SIGNED_OFF', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (moved AND NEW."status" = 'CANCELLED')
       AND (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY (cancel_cols))
           IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY (cancel_cols)) THEN
      RAISE EXCEPTION 'counts: stock count % is cancelled only in its move to CANCELLED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF moved AND NEW."status" = 'SUBMITTED'
       AND EXISTS (SELECT 1 FROM "StockCountLine" l
                   WHERE l."tenantId" = NEW."tenantId" AND l."countId" = NEW."id"
                     AND (l."countedQuantity" IS NULL OR (l."recountRequestedAt" IS NOT NULL AND l."recountQuantity" IS NULL))) THEN
      RAISE EXCEPTION 'counts: stock count % is submitted once every line is counted and every recount asked for is done', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b-5 (wave 36/44, SCM-293): while the company's switch is on (InventorySettings.counterNotApprover; on without a
    -- row); and who counted is also who scanned a unit of the line (an office user, or the office user a worker is).
    IF moved AND NEW."status" = 'APPROVED' AND NEW."approvalRequired"
       AND "factory_wh_counter_not_approver"(NEW."tenantId", NEW."companyId")
       AND EXISTS (SELECT 1 FROM "StockCountLine" l
                   WHERE l."tenantId" = NEW."tenantId" AND l."countId" = NEW."id"
                     AND coalesce(l."recountQuantity", l."countedQuantity") <> l."expectedQuantity"
                     AND (l."countedById" = NEW."approvedById" OR l."recountedById" = NEW."approvedById"
                          OR EXISTS (SELECT 1 FROM "StockCountScan" s
                                       LEFT JOIN "Worker" w ON w."tenantId" = s."tenantId" AND w."id" = s."scannedByWorkerId"
                                      WHERE s."tenantId" = l."tenantId" AND s."lineId" = l."id"
                                        AND (s."scannedById" = NEW."approvedById" OR w."userId" = NEW."approvedById")))) THEN
      RAISE EXCEPTION 'counts: % counted a line of stock count % that differs; the counter never approves their own variance (SCM-229)', NEW."approvedById", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF moved AND NEW."status" = 'APPLIED'
       AND EXISTS (SELECT 1 FROM "StockCountLine" l
                   WHERE l."tenantId" = NEW."tenantId" AND l."countId" = NEW."id"
                     AND coalesce(l."recountQuantity", l."countedQuantity") <> l."expectedQuantity" AND l."moveId" IS NULL) THEN
      RAISE EXCEPTION 'counts: stock count % is applied once every line that differs names its COUNT move (write the lines first)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."number") = '' OR (NEW."kind" = 'YEAR_END') <> (NEW."inventoryDate" IS NOT NULL)
     OR (NEW."lotId" IS NOT NULL AND NEW."itemId" IS NULL) THEN
    RAISE EXCEPTION 'counts: stock count % has a number, an inventory date exactly when it is YEAR_END, and the item of a lot in its scope', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."startedAt" IS NULL) <> (NEW."snapshotAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND NEW."startedAt" IS NOT NULL)
     OR (NEW."status" NOT IN ('DRAFT', 'CANCELLED') AND NEW."startedAt" IS NULL) THEN
    RAISE EXCEPTION 'counts: stock count % has its start and snapshot exactly from COUNTING on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."submittedAt" IS NULL) <> (NEW."submittedById" IS NULL) OR (NEW."submittedAt" IS NULL) <> (NEW."differenceAmount" IS NULL)
     OR NEW."differenceAmount" < 0
     OR (NEW."status" IN ('DRAFT', 'COUNTING') AND NEW."submittedAt" IS NOT NULL)
     OR (NEW."status" IN ('SUBMITTED', 'APPROVED', 'APPLIED', 'SIGNED_OFF') AND NEW."submittedAt" IS NULL) THEN
    RAISE EXCEPTION 'counts: stock count % is submitted (when, by whom, the value of its differences, 0 or more) exactly from SUBMITTED on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL)
     OR (NEW."status" IN ('DRAFT', 'COUNTING', 'SUBMITTED') AND NEW."approvedAt" IS NOT NULL)
     OR (NEW."status" IN ('APPROVED', 'APPLIED', 'SIGNED_OFF') AND NEW."approvedAt" IS NULL) THEN
    RAISE EXCEPTION 'counts: stock count % is approved (when, by whom) exactly from APPROVED on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."appliedAt" IS NULL) <> (NEW."appliedById" IS NULL)
     OR (NEW."appliedAt" IS NOT NULL) <> (NEW."status" IN ('APPLIED', 'SIGNED_OFF')) THEN
    RAISE EXCEPTION 'counts: stock count % is applied (when, by whom) exactly from APPLIED on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."signedOffAt" IS NULL) <> (NEW."signedOffById" IS NULL) OR (NEW."signedOffAt" IS NULL) <> (NEW."valuedListFileId" IS NULL)
     OR (NEW."signedOffAt" IS NOT NULL) <> (NEW."status" = 'SIGNED_OFF')
     OR (NEW."status" = 'SIGNED_OFF' AND NEW."kind" <> 'YEAR_END') THEN
    RAISE EXCEPTION 'counts: stock count % is signed off (when, by whom, its valued list) exactly when SIGNED_OFF, a year-end count', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."cancelledAt" IS NOT NULL) <> (NEW."status" = 'CANCELLED')
     OR (NEW."cancelledAt" IS NULL) <> (btrim(coalesce(NEW."cancelReason", '')) = '') THEN
    RAISE EXCEPTION 'counts: stock count % is cancelled with its reason exactly when CANCELLED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."rejectedAt" IS NULL) <> (NEW."rejectedById" IS NULL)
     OR (NEW."rejectedAt" IS NULL) <> (btrim(coalesce(NEW."rejectReason", '')) = '') THEN
    RAISE EXCEPTION 'counts: the rejection of stock count % says when, by whom and why, or nothing', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."valuedListFileId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."valuedListFileId" IS DISTINCT FROM OLD."valuedListFileId") THEN
    SELECT f."recordType", f."recordId" INTO file_type, file_record
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."valuedListFileId";
    IF FOUND AND (file_type <> 'StockCount' OR file_record <> NEW."id") THEN
      RAISE EXCEPTION 'counts: the valued list of stock count % is a file of that count', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- W2a's factory_stock_count_line_guard (…_stock_plan_w2a_guards), its whole body, + a floor session (the count's lock, not its
-- row; COUNTING only; ADDED lines and the count and recount only), frozenAt only with a freezing count (fixed afterwards by
-- the snapshot rule: it is none of the counted columns).
CREATE OR REPLACE FUNCTION "factory_stock_count_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  counted CONSTANT text[] := ARRAY['countedQuantity', 'countedAt', 'countedById', 'recountRequestedAt', 'recountRequestedById',
    'recountQuantity', 'recountedAt', 'recountedById', 'reasonCode', 'reasonNote', 'version', 'updatedAt'];
  count_state text;
  count_item uuid;
  count_lot uuid;
  count_kind text;
  count_location uuid;
  count_found boolean;
  lot_colour uuid;
  difference numeric;
  posted record;
  -- W2b-5 (wave 36/44): a floor session counts by scan; the count's company (its separation switch) and its freeze.
  floor_session boolean := current_user = 'factory_floor_runtime';
  count_company uuid;
  count_freezes boolean;
  floor_counted CONSTANT text[] := ARRAY['countedQuantity', 'countedAt', 'countedById', 'recountQuantity', 'recountedAt', 'recountedById',
    'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT c."status"::text INTO count_state FROM "StockCount" c WHERE c."tenantId" = OLD."tenantId" AND c."id" = OLD."countId";
    IF FOUND AND count_state NOT IN ('DRAFT', 'COUNTING') THEN
      RAISE EXCEPTION 'counts: line % of a % count is history; it is never removed', OLD."id", count_state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  -- W2b-5: the floor may not lock the count's row (no UPDATE grant): it takes the count's lock, shared, which the count's
  -- move out of COUNTING takes exclusively (factory_stock_count_guard).
  IF floor_session THEN
    PERFORM pg_advisory_xact_lock_shared("factory_wh_count_key"(NEW."tenantId", NEW."countId"));
    SELECT c."status"::text, c."itemId", c."lotId", c."itemKind"::text, c."locationId", c."companyId", c."freezeMoves"
      INTO count_state, count_item, count_lot, count_kind, count_location, count_company, count_freezes
      FROM "StockCount" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."countId";
  ELSE
    SELECT c."status"::text, c."itemId", c."lotId", c."itemKind"::text, c."locationId", c."companyId", c."freezeMoves"
      INTO count_state, count_item, count_lot, count_kind, count_location, count_company, count_freezes
      FROM "StockCount" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."countId"
      FOR SHARE;
  END IF;
  count_found := FOUND;

  -- W2b-5 (SCM-228): a floor session adds the extra units it finds (ADDED lines) and writes what it counted and recounted,
  -- while the count is COUNTING; nothing else.
  IF floor_session THEN
    IF count_found AND count_state <> 'COUNTING' THEN
      RAISE EXCEPTION 'counts: the floor counts while the count is COUNTING, not % (line %)', count_state, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' AND NEW."origin" <> 'ADDED' THEN
      RAISE EXCEPTION 'counts: the floor adds only what it found that was not expected (an ADDED line), not line %', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - (kept || floor_counted)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || floor_counted)) THEN
      RAISE EXCEPTION 'counts: the floor writes what it counted and recounted on line %, nothing else (a recount is asked, and a reason given, in the office)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- W2b-5 (SCM-226): a frozen line is a line of a count that freezes moves (frozenAt is the snapshot's: fixed below).
  IF TG_OP = 'INSERT' AND NEW."frozenAt" IS NOT NULL AND count_found AND NOT count_freezes THEN
    RAISE EXCEPTION 'counts: line % is frozen only when its count freezes moves', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-5 (SCM-229): a recount by another person is held on the scans (StockCountScan_check: who scans is who counts); the
  -- line's countedById and recountedById are who typed the sheets in the office, so no rule compares them here.

  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - (kept || counted || ARRAY['moveId'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || counted || ARRAY['moveId'])) THEN
      RAISE EXCEPTION 'counts: the stock key, origin and expected quantity of count line % are its snapshot; they never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF count_found AND count_state = 'APPROVED' THEN
      IF OLD."moveId" IS NOT NULL
         OR (to_jsonb(NEW) - (kept || ARRAY['moveId', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['moveId', 'version', 'updatedAt'])) THEN
        RAISE EXCEPTION 'counts: line % of an APPROVED count takes only the COUNT move that posts its difference, once', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF count_found AND count_state NOT IN ('DRAFT', 'COUNTING') THEN
      RAISE EXCEPTION 'counts: line % of a % count is history; it never changes', OLD."id", count_state
        USING ERRCODE = 'check_violation';
    ELSIF NEW."moveId" IS DISTINCT FROM OLD."moveId" THEN
      RAISE EXCEPTION 'counts: line % names its COUNT move only while its count is APPROVED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF count_found AND count_state NOT IN ('DRAFT', 'COUNTING') THEN
      RAISE EXCEPTION 'counts: lines are added to a count while it is DRAFT or COUNTING, not % (line %)', count_state, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."moveId" IS NOT NULL THEN
      RAISE EXCEPTION 'counts: a new count line % names no move yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF count_found THEN
      IF (count_item IS NOT NULL AND count_item <> NEW."itemId") OR (count_lot IS NOT NULL AND count_lot IS DISTINCT FROM NEW."lotId")
         OR (count_kind IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId" AND i."kind"::text = count_kind))
         OR (count_location IS NOT NULL AND NOT EXISTS (
               WITH RECURSIVE up ("id", "parentId", depth) AS (
                 SELECT l."id", l."parentId", 0 FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."locationId"
                 UNION ALL
                 SELECT p."id", p."parentId", up.depth + 1 FROM "Location" p JOIN up ON p."tenantId" = NEW."tenantId" AND p."id" = up."parentId"
                 WHERE up.depth < 64
               )
               SELECT 1 FROM up WHERE up."id" = count_location)) THEN
        RAISE EXCEPTION 'counts: line % is outside the scope of its count (its location, item, lot or kind of material)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."lotId" IS NOT NULL THEN
      SELECT l."itemColourId" INTO lot_colour FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."lotId";
      IF FOUND AND lot_colour IS DISTINCT FROM NEW."itemColourId" THEN
        RAISE EXCEPTION 'counts: line % counts lot % in the lot''s own colour', NEW."id", NEW."lotId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."hideId" IS NOT NULL AND NEW."lotId" IS NULL THEN
    RAISE EXCEPTION 'counts: line % counts a hide with its lot', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expectedQuantity" < 0 OR NEW."countedQuantity" < 0 OR NEW."recountQuantity" < 0
     OR (NEW."origin" = 'ADDED' AND NEW."expectedQuantity" <> 0) THEN
    RAISE EXCEPTION 'counts: line % has no negative quantity, and expects 0 when it was ADDED while counting', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."countedQuantity" IS NULL) <> (NEW."countedAt" IS NULL) OR (NEW."countedById" IS NOT NULL AND NEW."countedAt" IS NULL)
     OR (NEW."recountQuantity" IS NULL) <> (NEW."recountedAt" IS NULL) OR (NEW."recountedById" IS NOT NULL AND NEW."recountedAt" IS NULL)
     OR (NEW."recountQuantity" IS NOT NULL AND NEW."countedQuantity" IS NULL)
     OR (NEW."recountRequestedById" IS NOT NULL AND NEW."recountRequestedAt" IS NULL) THEN
    RAISE EXCEPTION 'counts: line % is counted (and recounted, after a count) with its time; who only with it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reasonCode" IS NOT NULL AND (NEW."reasonCode" = '' OR NEW."reasonCode" ~ '\s') THEN
    RAISE EXCEPTION 'counts: the reason code of line % is a code without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  difference := coalesce(NEW."recountQuantity", NEW."countedQuantity") - NEW."expectedQuantity";
  IF NEW."moveId" IS NOT NULL AND (difference IS NULL OR difference = 0) THEN
    RAISE EXCEPTION 'counts: line % names a move only when what was counted differs from what was expected', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."moveId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."moveId" IS DISTINCT FROM OLD."moveId") THEN
    SELECT m."reason"::text AS reason, m."itemId", m."itemColourId", m."lotId", m."hideId", m."fromLocationId", m."toLocationId", m."baseQuantity"
      INTO posted
      FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."moveId";
    IF FOUND AND (posted.reason <> 'COUNT' OR posted."itemId" <> NEW."itemId" OR posted."itemColourId" IS DISTINCT FROM NEW."itemColourId"
                  OR posted."lotId" IS DISTINCT FROM NEW."lotId" OR posted."hideId" IS DISTINCT FROM NEW."hideId"
                  OR posted."baseQuantity" <> abs(difference)
                  OR (difference > 0 AND (posted."toLocationId" IS DISTINCT FROM NEW."locationId" OR posted."fromLocationId" IS NOT NULL))
                  OR (difference < 0 AND (posted."fromLocationId" IS DISTINCT FROM NEW."locationId" OR posted."toLocationId" IS NOT NULL))) THEN
      RAISE EXCEPTION 'counts: move % does not post the difference of line % (a COUNT move of its stock key and size, into its location for more, out of it for less)', NEW."moveId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- StockCountScan (SCM-228): append-only
--   every row  into a COUNTING count (under the count's lock, shared: a submission waits for the scans in flight) and a line of
--              it; above 0; a code without spaces, up to 120 characters (or none: typed); scanned at a time not in the future;
--              by an office user or a worker of the site, exactly one; a floor session scans as its worker.
--   RECOUNT    only once a recount of the line was asked; while the company's switch is on, by another person than the
--              line's counter and the people of its COUNT scans.
--   UPDATE, DELETE, TRUNCATE refused (scripts/factory/check-append-only.mjs).
-- =====================================================================================================================
CREATE FUNCTION "factory_stock_count_scan_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  count_state text;
  count_company uuid;
  line_counter uuid;
  line_recount_asked timestamptz;
BEGIN
  IF NEW."quantity" <= 0 THEN
    RAISE EXCEPTION 'counts: scan % adds above 0 to its line (a hide''s area, a roll''s length, a box''s pieces)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."scannedById" IS NULL) = (NEW."scannedByWorkerId" IS NULL)
     OR (current_user = 'factory_floor_runtime' AND NEW."scannedByWorkerId" IS NULL) THEN
    RAISE EXCEPTION 'counts: scan % is made by an office user or a worker of the site, exactly one (a floor session as its worker)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."code" IS NOT NULL AND NEW."code" !~ '^\S{1,120}$' THEN
    RAISE EXCEPTION 'counts: scan % names what was scanned by its code (1 to 120 characters, no spaces), or nothing when it was typed', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."scannedAt") THEN
    RAISE EXCEPTION 'counts: scan % was made at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock_shared("factory_wh_count_key"(NEW."tenantId", NEW."countId"));
  SELECT c."status"::text, c."companyId" INTO count_state, count_company
    FROM "StockCount" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."countId";
  IF FOUND AND count_state <> 'COUNTING' THEN
    RAISE EXCEPTION 'counts: units are scanned into a COUNTING count, not a % one (scan %)', count_state, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."countedById", l."recountRequestedAt" INTO line_counter, line_recount_asked
    FROM "StockCountLine" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."lineId";
  IF FOUND AND NEW."pass" = 'RECOUNT' THEN
    IF line_recount_asked IS NULL THEN
      RAISE EXCEPTION 'counts: scan % recounts line %, whose recount was not asked', NEW."id", NEW."lineId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF "factory_wh_counter_not_approver"(NEW."tenantId", count_company)
       AND ((NEW."scannedById" IS NOT NULL AND NEW."scannedById" = line_counter)
            OR EXISTS (SELECT 1 FROM "StockCountScan" s
                        WHERE s."tenantId" = NEW."tenantId" AND s."lineId" = NEW."lineId" AND s."pass" = 'COUNT'
                          AND (s."scannedById" = NEW."scannedById" OR s."scannedByWorkerId" = NEW."scannedByWorkerId"))) THEN
      RAISE EXCEPTION 'counts: line % was counted by the same person; its recount is another person''s (separation of duties, SCM-229)', NEW."lineId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StockCountScan_check" AFTER INSERT ON "StockCountScan"
  FOR EACH ROW EXECUTE FUNCTION "factory_stock_count_scan_check"();
CREATE TRIGGER "StockCountScan_append_only" BEFORE UPDATE OR DELETE ON "StockCountScan"
  FOR EACH ROW EXECUTE FUNCTION "factory_wh_refuse_scan_change"();
CREATE TRIGGER "StockCountScan_no_truncate" BEFORE TRUNCATE ON "StockCountScan"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_wh_refuse_scan_change"();

-- =====================================================================================================================
-- DefaultLocation (SCM-179)
--   UPDATE     the company, site, kind of material, purpose and creation never change (a new default is a new row).
--   location   when named (or made active again): not archived, no SUBCONTRACTOR, CUSTOMER or TRANSIT place.
--   one active per site, kind and purpose: two partial unique indexes (with a kind, and the site's fallback without one).
-- =====================================================================================================================
CREATE FUNCTION "factory_default_location_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  place_status text;
  place_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."siteId", NEW."itemKind", NEW."purpose", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."siteId", OLD."itemKind", OLD."purpose", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'warehouse: the site, kind of material, purpose and creation of default location % never change (a new default is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."active" AND (TG_OP = 'INSERT' OR NEW."locationId" IS DISTINCT FROM OLD."locationId" OR NOT OLD."active") THEN
    SELECT l."status"::text, l."kind"::text INTO place_status, place_kind
      FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."locationId";
    IF FOUND AND (place_status = 'ARCHIVED' OR place_kind IN ('SUBCONTRACTOR', 'CUSTOMER', 'TRANSIT')) THEN
      RAISE EXCEPTION 'warehouse: a default location is a place of the site that is not archived and not a workshop''s, a customer''s or a transit place (default %)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "DefaultLocation_guard" AFTER INSERT OR UPDATE ON "DefaultLocation"
  FOR EACH ROW EXECUTE FUNCTION "factory_default_location_guard"();

-- Prisma cannot express a partial unique index. A new default replaces the old one: the old one made inactive first, in one
-- command.
CREATE UNIQUE INDEX "DefaultLocation_one_active_per_kind" ON "DefaultLocation" ("tenantId", "siteId", "itemKind", "purpose")
  WHERE "active" AND "itemKind" IS NOT NULL;
CREATE UNIQUE INDEX "DefaultLocation_one_active_fallback" ON "DefaultLocation" ("tenantId", "siteId", "purpose")
  WHERE "active" AND "itemKind" IS NULL;

-- =====================================================================================================================
-- TransferOrder (SCM-219, SCM-220)
--   INSERT     DRAFT, not shipped, received or cancelled, no DDT.
--   UPDATE     an UPDATE that changes nothing passes; the companies, sites and creation never change. DRAFT → SHIPPED |
--              CANCELLED; SHIPPED → PARTLY_RECEIVED | RECEIVED; PARTLY_RECEIVED → RECEIVED. Once it left, where it was sent
--              from, its transit place, its ship day, the ship and its DDT never change (the expected day, the receiving
--              place, the tracking, the DDT's PDF (once) and the note still do); RECEIVED and CANCELLED never change but the
--              note.
--   every row  another site; shipped (when, by whom) exactly from SHIPPED on, with its DDT: a series of kind DDT, the number,
--              the date, the reason (OTHER in words), who carries it (a CARRIER named), packages from 1, a gross weight above
--              0, the goods' appearance; none of it before; received (when, by whom, not before it left) exactly when
--              RECEIVED; cancelled with why exactly when CANCELLED; expected not before the planned ship day; an https
--              tracking page; times not in the future.
--   names      the transit place a TRANSIT location of the sending site, not archived; the picking and receiving places
--              not archived and no transit place; the DDT's PDF a file of the transfer.
--   moves      SHIPPED once every line says what left, and something did; PARTLY_RECEIVED once something arrived; RECEIVED
--              once every line arrived in full or says why not (write the lines first).
-- =====================================================================================================================
CREATE TRIGGER "TransferOrder_number" BEFORE INSERT OR UPDATE ON "TransferOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('transfer', 'TRANSFER');

CREATE FUNCTION "factory_transfer_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  moved boolean := false;
  place record;
  series_kind text;
  series_company uuid;
  file_type text;
  file_record uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."shippedAt" IS NOT NULL OR NEW."shippedById" IS NOT NULL OR NEW."receivedAt" IS NOT NULL
       OR NEW."receivedById" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL OR NEW."cancelReason" IS NOT NULL THEN
      RAISE EXCEPTION 'warehouse: transfer % is drafted first (DRAFT, not shipped, received or cancelled)', NEW."number"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    moved := NEW."status" <> OLD."status";
    IF (NEW."companyId", NEW."fromSiteId", NEW."toCompanyId", NEW."toSiteId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."fromSiteId", OLD."toCompanyId", OLD."toSiteId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'warehouse: the companies, sites and creation of transfer % never change', OLD."number"
        USING ERRCODE = 'check_violation';
    END IF;
    IF moved AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('SHIPPED', 'CANCELLED'))
                      OR (OLD."status" = 'SHIPPED' AND NEW."status" IN ('PARTLY_RECEIVED', 'RECEIVED'))
                      OR (OLD."status" = 'PARTLY_RECEIVED' AND NEW."status" = 'RECEIVED')) THEN
      RAISE EXCEPTION 'warehouse: transfer % moves DRAFT → SHIPPED | CANCELLED, SHIPPED → PARTLY_RECEIVED | RECEIVED, PARTLY_RECEIVED → RECEIVED (not % → %)', OLD."number", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('RECEIVED', 'CANCELLED')
       AND (to_jsonb(NEW) - ARRAY['note', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['note', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'warehouse: transfer % is % and never changes (only the note)', OLD."number", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND (NEW."fromLocationId", NEW."transitLocationId", NEW."shipOn", NEW."shippedAt", NEW."shippedById", NEW."ddtNumberSeriesId",
            NEW."ddtNumber", NEW."ddtDate", NEW."ddtReason", NEW."ddtReasonText", NEW."transportBy", NEW."carrier", NEW."packages",
            NEW."grossWeightKg", NEW."appearance")
           IS DISTINCT FROM
           (OLD."fromLocationId", OLD."transitLocationId", OLD."shipOn", OLD."shippedAt", OLD."shippedById", OLD."ddtNumberSeriesId",
            OLD."ddtNumber", OLD."ddtDate", OLD."ddtReason", OLD."ddtReasonText", OLD."transportBy", OLD."carrier", OLD."packages",
            OLD."grossWeightKg", OLD."appearance") THEN
      RAISE EXCEPTION 'warehouse: transfer % left: where it was sent from, its transit place, the ship and its DDT never change', OLD."number"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."ddtFileId" IS NOT NULL AND NEW."ddtFileId" IS DISTINCT FROM OLD."ddtFileId" THEN
      RAISE EXCEPTION 'warehouse: the DDT''s PDF of transfer % is named once', OLD."number"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Every row.
  IF NEW."toSiteId" = NEW."fromSiteId" THEN
    RAISE EXCEPTION 'warehouse: transfer % goes to another site', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('SHIPPED', 'PARTLY_RECEIVED', 'RECEIVED')) <> (NEW."shippedAt" IS NOT NULL)
     OR (NEW."shippedAt" IS NULL) <> (NEW."shippedById" IS NULL) THEN
    RAISE EXCEPTION 'warehouse: transfer % is shipped (when, by whom) exactly from SHIPPED on', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shippedAt" IS NOT NULL
     AND (NEW."ddtNumberSeriesId" IS NULL OR NEW."ddtNumber" IS NULL OR btrim(NEW."ddtNumber") = '' OR NEW."ddtDate" IS NULL
          OR NEW."transportBy" IS NULL OR NEW."packages" IS NULL OR NEW."packages" < 1 OR NEW."grossWeightKg" IS NULL
          OR NEW."grossWeightKg" <= 0 OR NEW."appearance" IS NULL) THEN
    RAISE EXCEPTION 'warehouse: transfer % travels with its DDT (DPR 472/1996): a DDT series, the number, the date, the reason, who carries it, packages from 1, a gross weight above 0 and the goods'' appearance', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shippedAt" IS NULL
     AND (NEW."ddtNumberSeriesId" IS NOT NULL OR NEW."ddtNumber" IS NOT NULL OR NEW."ddtDate" IS NOT NULL OR NEW."transportBy" IS NOT NULL
          OR NEW."carrier" IS NOT NULL OR NEW."packages" IS NOT NULL OR NEW."grossWeightKg" IS NOT NULL OR NEW."appearance" IS NOT NULL
          OR NEW."ddtFileId" IS NOT NULL) THEN
    RAISE EXCEPTION 'warehouse: transfer % gets its DDT when it is shipped, not before', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."ddtReason" = 'OTHER' AND NEW."ddtReasonText" IS NULL) OR NOT "factory_recall_words_ok"(NEW."ddtReasonText", 200, false)
     OR NOT "factory_recall_words_ok"(NEW."appearance", 200, false) THEN
    RAISE EXCEPTION 'warehouse: the DDT of transfer % says its reason in words when it is OTHER (up to 200 characters) and the goods'' appearance (up to 200)', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."transportBy" = 'CARRIER'
      AND (NEW."carrier" IS NULL OR jsonb_typeof(NEW."carrier") <> 'object' OR btrim(coalesce(NEW."carrier" ->> 'name', '')) = ''))
     OR (NEW."carrier" IS NOT NULL AND jsonb_typeof(NEW."carrier") <> 'object') THEN
    RAISE EXCEPTION 'warehouse: the DDT of transfer % names its carrier { "name", "address"?, "vatNumber"? } when a carrier carries the goods', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'RECEIVED') <> (NEW."receivedAt" IS NOT NULL) OR (NEW."receivedAt" IS NULL) <> (NEW."receivedById" IS NULL)
     OR NEW."receivedAt" < NEW."shippedAt" THEN
    RAISE EXCEPTION 'warehouse: transfer % is received (when, by whom, not before it left) exactly when RECEIVED', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."cancelReason", 500, true) THEN
    RAISE EXCEPTION 'warehouse: transfer % is cancelled with when and why (1 to 500 characters) exactly when CANCELLED', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expectedOn" < NEW."shipOn" OR (NEW."trackingUrl" IS NOT NULL AND (NEW."trackingUrl" !~ '^https://\S+$' OR length(NEW."trackingUrl") > 500))
     OR NOT "factory_recall_words_ok"(NEW."trackingRef", 100, false) OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'warehouse: transfer % is expected not before it leaves; its tracking is a reference up to 100 characters and an https page; its note up to 2000', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."shippedAt" IS DISTINCT FROM OLD."shippedAt" OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt")
     AND NOT ("factory_recall_not_future"(NEW."shippedAt") AND "factory_recall_not_future"(NEW."receivedAt")) THEN
    RAISE EXCEPTION 'warehouse: transfer % records its ship and receipt at times not in the future', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it names (when set or changed; a row this session cannot see is skipped).
  IF TG_OP = 'INSERT' OR NEW."transitLocationId" IS DISTINCT FROM OLD."transitLocationId" THEN
    SELECT l."kind"::text AS kind, l."status"::text AS status INTO place
      FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."fromSiteId" AND l."id" = NEW."transitLocationId";
    IF FOUND AND (place.kind <> 'TRANSIT' OR place.status = 'ARCHIVED') THEN
      RAISE EXCEPTION 'warehouse: the goods of transfer % lie on a TRANSIT location of the sending site, not archived', NEW."number"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."fromLocationId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."fromLocationId" IS DISTINCT FROM OLD."fromLocationId") THEN
    SELECT l."kind"::text AS kind, l."status"::text AS status INTO place
      FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."fromSiteId" AND l."id" = NEW."fromLocationId";
    IF FOUND AND (place.kind = 'TRANSIT' OR place.status = 'ARCHIVED') THEN
      RAISE EXCEPTION 'warehouse: transfer % is picked from a place of the sending site that is not archived and not a transit place', NEW."number"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."toLocationId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."toLocationId" IS DISTINCT FROM OLD."toLocationId") THEN
    SELECT l."kind"::text AS kind, l."status"::text AS status INTO place
      FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."toSiteId" AND l."id" = NEW."toLocationId";
    IF FOUND AND (place.kind = 'TRANSIT' OR place.status = 'ARCHIVED') THEN
      RAISE EXCEPTION 'warehouse: transfer % is put into a place of the receiving site that is not archived and not a transit place', NEW."number"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."ddtNumberSeriesId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."ddtNumberSeriesId" IS DISTINCT FROM OLD."ddtNumberSeriesId") THEN
    SELECT s."kind"::text INTO series_kind FROM "NumberSeries" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."ddtNumberSeriesId";
    IF FOUND AND series_kind <> 'DDT' THEN
      RAISE EXCEPTION 'warehouse: the DDT of transfer % is numbered from a DDT series of its company, not a % series', NEW."number", series_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."ddtFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."ddtFileId" IS DISTINCT FROM OLD."ddtFileId") THEN
    SELECT f."recordType", f."recordId" INTO file_type, file_record FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."ddtFileId";
    IF FOUND AND (file_type IS DISTINCT FROM 'TransferOrder' OR file_record IS DISTINCT FROM NEW."id") THEN
      RAISE EXCEPTION 'warehouse: the DDT''s PDF of transfer % is a file of the transfer', NEW."number"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Its moves read its lines (written first, in the same command).
  IF moved AND NEW."status" = 'SHIPPED'
     AND (NOT EXISTS (SELECT 1 FROM "TransferLine" l WHERE l."tenantId" = NEW."tenantId" AND l."transferId" = NEW."id" AND l."shippedQuantity" > 0)
          OR EXISTS (SELECT 1 FROM "TransferLine" l WHERE l."tenantId" = NEW."tenantId" AND l."transferId" = NEW."id" AND l."shippedQuantity" IS NULL)) THEN
    RAISE EXCEPTION 'warehouse: transfer % ships once every line says what left, and something did', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF moved AND NEW."status" = 'PARTLY_RECEIVED'
     AND NOT EXISTS (SELECT 1 FROM "TransferLine" l WHERE l."tenantId" = NEW."tenantId" AND l."transferId" = NEW."id" AND l."receivedQuantity" > 0) THEN
    RAISE EXCEPTION 'warehouse: transfer % is PARTLY_RECEIVED once something of it arrived', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF moved AND NEW."status" = 'RECEIVED'
     AND EXISTS (SELECT 1 FROM "TransferLine" l WHERE l."tenantId" = NEW."tenantId" AND l."transferId" = NEW."id"
                   AND l."receivedQuantity" < coalesce(l."shippedQuantity", 0) AND l."differenceReasonCode" IS NULL) THEN
    RAISE EXCEPTION 'warehouse: transfer % is RECEIVED once every line arrived in full or says why it did not (its difference''s reason)', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "TransferOrder_guard" AFTER INSERT OR UPDATE ON "TransferOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_transfer_order_guard"();

-- =====================================================================================================================
-- TransferLine (SCM-219, SCM-220)
--   INSERT, DELETE  while the transfer is DRAFT.
--   UPDATE     the transfer, sites and creation never change; from SHIPPED on only what arrived, where it was put, what the
--              receipt made there and the difference (its reason, words and settlement) change; once the transfer is RECEIVED
--              or CANCELLED only the difference and the note. What arrived never goes back; the lot, hide and roll made at the
--              other site are named once; a difference is settled once.
--   every row  quantities above 0; what left 0 or more; what arrived 0 to what left; a hide or a roll with its lot, not both;
--              the lot (and hide) the item's tracking asks; the lots in the line's colour; a roll of its lot; a difference's
--              reason a code, given once something left; settled (how, when; by whom optional) only after its reason.
--   places     the picking and receiving places not archived, no transit place (when set or changed).
-- =====================================================================================================================
CREATE FUNCTION "factory_transfer_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receiving CONSTANT text[] := ARRAY['receivedQuantity', 'toLocationId', 'toLotId', 'toHideId', 'toRollId'];
  difference CONSTANT text[] := ARRAY['differenceReasonCode', 'differenceNote', 'differenceResolution', 'resolvedAt', 'resolvedById'];
  state text;
  found_transfer boolean;
  tracking text;
  lot_colour uuid;
  roll_lot uuid;
  place record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT t."status"::text INTO state FROM "TransferOrder" t WHERE t."tenantId" = OLD."tenantId" AND t."id" = OLD."transferId";
    IF FOUND AND state <> 'DRAFT' THEN
      RAISE EXCEPTION 'warehouse: line % of a % transfer is kept; lines are removed while the transfer is DRAFT', OLD."id", state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  SELECT t."status"::text INTO state FROM "TransferOrder" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."transferId" FOR SHARE;
  found_transfer := FOUND;
  IF TG_OP = 'INSERT' AND found_transfer AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'warehouse: lines are added to a transfer while it is DRAFT, not % (line %)', state, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."transferId", NEW."fromSiteId", NEW."toSiteId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."transferId", OLD."fromSiteId", OLD."toSiteId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'warehouse: the transfer and creation of line % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF found_transfer AND state <> 'DRAFT'
       AND (to_jsonb(NEW) - (receiving || difference || ARRAY['note', 'version', 'updatedAt']))
           IS DISTINCT FROM (to_jsonb(OLD) - (receiving || difference || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'warehouse: line % of a % transfer: what was sent is fixed once it left; what arrived, where it was put and the difference change', OLD."id", state
        USING ERRCODE = 'check_violation';
    END IF;
    IF found_transfer AND state IN ('RECEIVED', 'CANCELLED')
       AND (to_jsonb(NEW) - (difference || ARRAY['note', 'version', 'updatedAt']))
           IS DISTINCT FROM (to_jsonb(OLD) - (difference || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'warehouse: line % of a % transfer: only its difference and note change', OLD."id", state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."receivedQuantity" < OLD."receivedQuantity"
       OR (OLD."toLotId" IS NOT NULL AND NEW."toLotId" IS DISTINCT FROM OLD."toLotId")
       OR (OLD."toHideId" IS NOT NULL AND NEW."toHideId" IS DISTINCT FROM OLD."toHideId")
       OR (OLD."toRollId" IS NOT NULL AND NEW."toRollId" IS DISTINCT FROM OLD."toRollId") THEN
      RAISE EXCEPTION 'warehouse: on line %, what arrived never goes back, and the lot, hide and roll made at the other site are named once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."resolvedAt" IS NOT NULL
       AND (NEW."differenceReasonCode", NEW."differenceResolution", NEW."resolvedAt", NEW."resolvedById")
           IS DISTINCT FROM (OLD."differenceReasonCode", OLD."differenceResolution", OLD."resolvedAt", OLD."resolvedById") THEN
      RAISE EXCEPTION 'warehouse: the difference of line % was settled; it is settled once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Every row.
  IF NEW."seq" < 1 OR NEW."quantity" <= 0 OR NEW."baseQuantity" <= 0 OR NEW."shippedQuantity" < 0 OR NEW."receivedQuantity" < 0
     OR NEW."receivedQuantity" > coalesce(NEW."shippedQuantity", 0) THEN
    RAISE EXCEPTION 'warehouse: line % has a place from 1 and quantities above 0; what left 0 or more; what arrived 0 to what left', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."hideId" IS NOT NULL AND NEW."lotId" IS NULL) OR (NEW."rollId" IS NOT NULL AND NEW."lotId" IS NULL)
     OR (NEW."hideId" IS NOT NULL AND NEW."rollId" IS NOT NULL)
     OR (NEW."toHideId" IS NOT NULL AND NEW."toLotId" IS NULL) OR (NEW."toRollId" IS NOT NULL AND NEW."toLotId" IS NULL)
     OR (NEW."toHideId" IS NOT NULL AND NEW."toRollId" IS NOT NULL) THEN
    RAISE EXCEPTION 'warehouse: line % sends (and receives) a hide or a roll with its lot, not both', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_wh_code_ok"(NEW."differenceReasonCode") OR NOT "factory_recall_words_ok"(NEW."differenceNote", 1000, true)
     OR NOT "factory_recall_words_ok"(NEW."note", 1000, true)
     OR ((NEW."differenceReasonCode" IS NOT NULL OR NEW."differenceNote" IS NOT NULL) AND NEW."shippedQuantity" IS NULL) THEN
    RAISE EXCEPTION 'warehouse: the difference of line % is said once something left: a reason code without spaces (up to 60) and words (up to 1000)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."resolvedAt" IS NULL) <> (NEW."differenceResolution" IS NULL) OR (NEW."resolvedById" IS NOT NULL AND NEW."resolvedAt" IS NULL)
     OR (NEW."differenceResolution" IS NOT NULL AND NEW."differenceReasonCode" IS NULL)
     OR ((TG_OP = 'INSERT' OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt") AND NOT "factory_recall_not_future"(NEW."resolvedAt")) THEN
    RAISE EXCEPTION 'warehouse: the difference of line % is settled with how and when (by whom optional), after its reason, at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it names (when set or changed; a row this session cannot see is skipped).
  IF TG_OP = 'INSERT' OR (NEW."itemId", NEW."lotId", NEW."hideId") IS DISTINCT FROM (OLD."itemId", OLD."lotId", OLD."hideId") THEN
    SELECT i."tracking"::text INTO tracking FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND ((tracking IN ('LOT', 'HIDE') AND NEW."lotId" IS NULL) OR (tracking = 'HIDE' AND NEW."hideId" IS NULL)
                  OR (tracking = 'NONE' AND NEW."lotId" IS NOT NULL)) THEN
      RAISE EXCEPTION 'warehouse: line % sends an item tracked by %: its lot (LOT, HIDE) and its hide (HIDE: one line per hide) exactly then', NEW."id", tracking
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."lotId" IS NOT NULL AND (TG_OP = 'INSERT' OR (NEW."lotId", NEW."itemColourId") IS DISTINCT FROM (OLD."lotId", OLD."itemColourId")) THEN
    SELECT l."itemColourId" INTO lot_colour FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."lotId";
    IF FOUND AND lot_colour IS DISTINCT FROM NEW."itemColourId" THEN
      RAISE EXCEPTION 'warehouse: line % sends lot % in the lot''s own colour', NEW."id", NEW."lotId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."toLotId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."toLotId" IS DISTINCT FROM OLD."toLotId") THEN
    SELECT l."itemColourId" INTO lot_colour FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."toLotId";
    IF FOUND AND lot_colour IS DISTINCT FROM NEW."itemColourId" THEN
      RAISE EXCEPTION 'warehouse: line % arrives as lot % in the line''s colour', NEW."id", NEW."toLotId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."rollId" IS NOT NULL AND (TG_OP = 'INSERT' OR (NEW."rollId", NEW."lotId") IS DISTINCT FROM (OLD."rollId", OLD."lotId")) THEN
    SELECT r."lotId" INTO roll_lot FROM "FabricRoll" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."rollId";
    IF FOUND AND roll_lot IS DISTINCT FROM NEW."lotId" THEN
      RAISE EXCEPTION 'warehouse: line % sends roll % of its own lot', NEW."id", NEW."rollId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."toRollId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."toRollId" IS DISTINCT FROM OLD."toRollId") THEN
    SELECT r."lotId" INTO roll_lot FROM "FabricRoll" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."toRollId";
    IF FOUND AND roll_lot IS DISTINCT FROM NEW."toLotId" THEN
      RAISE EXCEPTION 'warehouse: line % arrives as roll % of the lot it arrived as', NEW."id", NEW."toRollId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."fromLocationId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."fromLocationId" IS DISTINCT FROM OLD."fromLocationId") THEN
    SELECT l."kind"::text AS kind, l."status"::text AS status INTO place
      FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."fromSiteId" AND l."id" = NEW."fromLocationId";
    IF FOUND AND (place.kind = 'TRANSIT' OR place.status = 'ARCHIVED') THEN
      RAISE EXCEPTION 'warehouse: line % is picked from a place of the sending site that is not archived and not a transit place', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."toLocationId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."toLocationId" IS DISTINCT FROM OLD."toLocationId") THEN
    SELECT l."kind"::text AS kind, l."status"::text AS status INTO place
      FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."toSiteId" AND l."id" = NEW."toLocationId";
    IF FOUND AND (place.kind = 'TRANSIT' OR place.status = 'ARCHIVED') THEN
      RAISE EXCEPTION 'warehouse: line % is put into a place of the receiving site that is not archived and not a transit place', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "TransferLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TransferLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_transfer_line_guard"();

-- =====================================================================================================================
-- CountSchedule (SCM-227)
--   UPDATE     the company, site and creation never change.
--   every row  a name (1 to 200 characters); at least one of location, class and kind; every 1 to 366 days; the last count
--              only with its day; a note up to 2000.
--   names      the location not archived and no SUBCONTRACTOR, CUSTOMER or TRANSIT place; the last count a closed one (APPLIED
--              or SIGNED_OFF) (when set or changed).
-- =====================================================================================================================
CREATE FUNCTION "factory_count_schedule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  place record;
  last_state text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."siteId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."siteId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'warehouse: the site and creation of count schedule % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."name" IS NULL OR NOT "factory_recall_words_ok"(NEW."name", 200, false) OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'warehouse: count schedule % has a name of 1 to 200 characters and a note up to 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."locationId" IS NULL AND NEW."abcClass" IS NULL AND NEW."itemKind" IS NULL THEN
    RAISE EXCEPTION 'warehouse: count schedule % counts a location, a class or a kind of material (at least one)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."everyDays" < 1 OR NEW."everyDays" > 366 OR (NEW."lastCountId" IS NOT NULL AND NEW."lastCountedOn" IS NULL) THEN
    RAISE EXCEPTION 'warehouse: count schedule % counts every 1 to 366 days, and names its last count with its day', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."locationId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."locationId" IS DISTINCT FROM OLD."locationId") THEN
    SELECT l."kind"::text AS kind, l."status"::text AS status INTO place
      FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."locationId";
    IF FOUND AND (place.status = 'ARCHIVED' OR place.kind IN ('SUBCONTRACTOR', 'CUSTOMER', 'TRANSIT')) THEN
      RAISE EXCEPTION 'warehouse: count schedule % counts a place of the site that is not archived and not a workshop''s, a customer''s or a transit place', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."lastCountId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."lastCountId" IS DISTINCT FROM OLD."lastCountId") THEN
    SELECT c."status"::text INTO last_state FROM "StockCount" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."lastCountId";
    IF FOUND AND last_state NOT IN ('APPLIED', 'SIGNED_OFF') THEN
      RAISE EXCEPTION 'warehouse: the last count of count schedule % is a count that closed (APPLIED or SIGNED_OFF), not a % one', NEW."id", last_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "CountSchedule_guard" AFTER INSERT OR UPDATE ON "CountSchedule"
  FOR EACH ROW EXECUTE FUNCTION "factory_count_schedule_guard"();

-- =====================================================================================================================
-- InventorySettings (SCM-196, SCM-281, SCM-293; the design's ws-adjust)
--   UPDATE     the company and the creation never change.
--   every row  0 to 366 days back; the threshold 0 or more; a separation rule switched off (false) exactly with the reason it
--              was (1 to 500 characters): it widens what one person can do.
-- =====================================================================================================================
CREATE FUNCTION "factory_inventory_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'warehouse: the company and creation of the warehouse rules % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."backDatingDays" < 0 OR NEW."backDatingDays" > 366 OR NEW."adjustmentApprovalAmount" < 0 THEN
    RAISE EXCEPTION 'warehouse: the warehouse rules % allow 0 to 366 days back and an adjustment threshold of 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."receiverNotMatcher" IS FALSE OR NEW."counterNotApprover" IS FALSE) <> (NEW."separationOffReason" IS NOT NULL)
     OR NOT "factory_recall_words_ok"(NEW."separationOffReason", 500, true) THEN
    RAISE EXCEPTION 'warehouse: the warehouse rules % switch a separation of duties off exactly with the reason (1 to 500 characters): it widens what one person can do', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "InventorySettings_guard" AFTER INSERT OR UPDATE ON "InventorySettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_inventory_settings_guard"();

-- =====================================================================================================================
-- WarehouseTask (SCM-274)
--   INSERT     OPEN, nothing taken, done or cancelled.
--   UPDATE     an UPDATE that changes nothing passes; the company, site, kind, source and creation never change. OPEN → TAKEN |
--              DONE | CANCELLED; TAKEN → OPEN (given back: who took it cleared) | DONE | CANCELLED; DONE and CANCELLED never
--              change but the note. A floor session only takes, gives back and does (never cancels, reassigns or edits).
--   every row  the source's model name and id, both or neither; how much (above 0) with its unit, both or neither; a hide with
--              its lot, a lot or colour with its item; a role or a worker, not both (a role of the floor); two different
--              places; TAKEN with when and by whom (a worker or an office user, exactly one; a floor session as its worker),
--              kept when DONE, none while OPEN; DONE with when (not before it was taken) and by whom (the same way); CANCELLED
--              with when and why (by whom optional); none of them otherwise; times not in the future; a note up to 2000.
--   places     not archived (when named or changed).
-- =====================================================================================================================
CREATE FUNCTION "factory_warehouse_task_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  floor_session boolean := current_user = 'factory_floor_runtime';
  floor_moves CONSTANT text[] := ARRAY['status', 'takenAt', 'takenById', 'takenByWorkerId', 'doneAt', 'doneById', 'doneByWorkerId', 'version', 'updatedAt'];
  moved boolean := false;
  role_audience text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."takenAt" IS NOT NULL OR NEW."takenById" IS NOT NULL OR NEW."takenByWorkerId" IS NOT NULL
       OR NEW."doneAt" IS NOT NULL OR NEW."doneById" IS NOT NULL OR NEW."doneByWorkerId" IS NOT NULL
       OR NEW."cancelledAt" IS NOT NULL OR NEW."cancelledById" IS NOT NULL OR NEW."cancelReason" IS NOT NULL THEN
      RAISE EXCEPTION 'warehouse: warehouse task % is made OPEN, nothing taken, done or cancelled', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    moved := NEW."status" <> OLD."status";
    IF (NEW."companyId", NEW."siteId", NEW."kind", NEW."sourceType", NEW."sourceId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."siteId", OLD."kind", OLD."sourceType", OLD."sourceId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'warehouse: the site, kind, source and creation of warehouse task % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF moved AND NOT ((OLD."status" = 'OPEN' AND NEW."status" IN ('TAKEN', 'DONE', 'CANCELLED'))
                      OR (OLD."status" = 'TAKEN' AND NEW."status" IN ('OPEN', 'DONE', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'warehouse: warehouse task % moves OPEN → TAKEN | DONE | CANCELLED, TAKEN → OPEN | DONE | CANCELLED (not % → %)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('DONE', 'CANCELLED')
       AND (to_jsonb(NEW) - ARRAY['note', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['note', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'warehouse: warehouse task % is % and never changes (only the note)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF floor_session
       AND ((moved AND NEW."status" = 'CANCELLED')
            OR (to_jsonb(NEW) - floor_moves) IS DISTINCT FROM (to_jsonb(OLD) - floor_moves)) THEN
      RAISE EXCEPTION 'warehouse: on the floor warehouse task % is taken, given back or done; the office changes or cancels it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'TAKEN' AND NEW."status" IN ('TAKEN', 'DONE', 'CANCELLED')
       AND (NEW."takenAt", NEW."takenById", NEW."takenByWorkerId") IS DISTINCT FROM (OLD."takenAt", OLD."takenById", OLD."takenByWorkerId") THEN
      RAISE EXCEPTION 'warehouse: who took warehouse task % and when stay (give it back first)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Every row.
  IF (NEW."sourceType" IS NULL) <> (NEW."sourceId" IS NULL)
     OR (NEW."sourceType" IS NOT NULL AND NOT "factory_recall_model_name_ok"(NEW."sourceType")) THEN
    RAISE EXCEPTION 'warehouse: warehouse task % names the record that made it by its model name and id, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."quantity" IS NULL) <> (NEW."uom" IS NULL) OR NEW."quantity" <= 0 THEN
    RAISE EXCEPTION 'warehouse: warehouse task % says how much (above 0) with its unit, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."hideId" IS NOT NULL AND NEW."lotId" IS NULL) OR ((NEW."lotId" IS NOT NULL OR NEW."itemColourId" IS NOT NULL) AND NEW."itemId" IS NULL) THEN
    RAISE EXCEPTION 'warehouse: warehouse task % names a hide with its lot, a lot or a colour with its item', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."assignedRoleId" IS NOT NULL AND NEW."assignedWorkerId" IS NOT NULL) OR NEW."fromLocationId" = NEW."toLocationId" THEN
    RAISE EXCEPTION 'warehouse: warehouse task % is for a role or a worker (not both), between two different places', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'TAKEN' AND NEW."takenAt" IS NULL) OR (NEW."status" = 'OPEN' AND (NEW."takenAt" IS NOT NULL OR NEW."takenById" IS NOT NULL OR NEW."takenByWorkerId" IS NOT NULL))
     OR (NEW."takenAt" IS NOT NULL AND (NEW."takenById" IS NULL) = (NEW."takenByWorkerId" IS NULL))
     OR (NEW."takenAt" IS NULL AND (NEW."takenById" IS NOT NULL OR NEW."takenByWorkerId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'warehouse: warehouse task % is taken (when, by a worker or an office user, exactly one) exactly while TAKEN, and kept once DONE', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DONE') <> (NEW."doneAt" IS NOT NULL)
     OR (NEW."doneAt" IS NOT NULL AND (NEW."doneById" IS NULL) = (NEW."doneByWorkerId" IS NULL))
     OR (NEW."doneAt" IS NULL AND (NEW."doneById" IS NOT NULL OR NEW."doneByWorkerId" IS NOT NULL))
     OR NEW."doneAt" < NEW."takenAt" THEN
    RAISE EXCEPTION 'warehouse: warehouse task % is done (when, not before it was taken, by a worker or an office user, exactly one) exactly when DONE', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL)
     OR (NEW."cancelledById" IS NOT NULL AND NEW."cancelledAt" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."cancelReason", 500, true) OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'warehouse: warehouse task % is cancelled with when and why (1 to 500 characters) exactly when CANCELLED; its note is up to 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF floor_session AND ((NEW."takenAt" IS NOT NULL AND NEW."takenByWorkerId" IS NULL AND (TG_OP = 'INSERT' OR NEW."takenAt" IS DISTINCT FROM OLD."takenAt"))
                        OR (NEW."doneAt" IS NOT NULL AND NEW."doneByWorkerId" IS NULL)) THEN
    RAISE EXCEPTION 'warehouse: on the floor warehouse task % is taken and done by the signed-in worker', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."takenAt" IS DISTINCT FROM OLD."takenAt" OR NEW."doneAt" IS DISTINCT FROM OLD."doneAt" OR NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt")
     AND NOT ("factory_recall_not_future"(NEW."takenAt") AND "factory_recall_not_future"(NEW."doneAt") AND "factory_recall_not_future"(NEW."cancelledAt")) THEN
    RAISE EXCEPTION 'warehouse: warehouse task % is taken, done or cancelled at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it names (when set or changed; a row this session cannot see is skipped).
  IF NEW."assignedRoleId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."assignedRoleId" IS DISTINCT FROM OLD."assignedRoleId") THEN
    SELECT r."audience"::text INTO role_audience FROM "Role" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."assignedRoleId";
    IF FOUND AND role_audience <> 'FLOOR' THEN
      RAISE EXCEPTION 'warehouse: warehouse task % is for a floor role (its workers), not a % one', NEW."id", role_audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (TG_OP = 'INSERT' OR (NEW."fromLocationId", NEW."toLocationId") IS DISTINCT FROM (OLD."fromLocationId", OLD."toLocationId"))
     AND EXISTS (SELECT 1 FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId"
                  AND l."id" IN (NEW."fromLocationId", NEW."toLocationId") AND l."status" = 'ARCHIVED') THEN
    RAISE EXCEPTION 'warehouse: warehouse task % names places that are not archived', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WarehouseTask_guard" AFTER INSERT OR UPDATE ON "WarehouseTask"
  FOR EACH ROW EXECUTE FUNCTION "factory_warehouse_task_guard"();

-- =====================================================================================================================
-- MaterialSubstitution (MES-139)
--   INSERT     WAITING, nothing decided, issued or withdrawn; of a work order that is not done (DRAFT, RELEASED,
--              IN_PROGRESS, ON_HOLD).
--   UPDATE     an UPDATE that changes nothing passes; what is replaced and by what, how much, why, the rule's answer, who
--              asked and the creation never change; WAITING → APPROVED | REFUSED | WITHDRAWN, APPROVED → ISSUED | WITHDRAWN;
--              ISSUED, REFUSED and WITHDRAWN never change but the note; the approval task named once while WAITING; the lot
--              until it is issued. A floor session asks (inserts) and issues (APPROVED → ISSUED with its moves and lot) only.
--   every row  quantities above 0; why in words (1 to 1000) and a code without spaces; the rule's answer an object with "may"
--              true or false; asked by an office user or a worker of the site, exactly one (a floor session as its worker);
--              another material with its alternate, the same one with another lot; decided (when) exactly from APPROVED or
--              REFUSED on (kept when WITHDRAWN after a yes), by whom (never the person who asked; required for REFUSED, with
--              why, and when a yes was asked); issued (when, its moves: at least one, each once) exactly when ISSUED;
--              withdrawn with when and why exactly when WITHDRAWN; times not in the future.
--   names      the alternate an alternate of the line, of the substitute; the lot not rejected, in the substitute's colour;
--              the moves ISSUE moves (not reversals) of the work order and the substitute (its lot when named).
-- =====================================================================================================================
CREATE FUNCTION "factory_material_substitution_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  floor_session boolean := current_user = 'factory_floor_runtime';
  floor_issue CONSTANT text[] := ARRAY['status', 'issuedAt', 'moveIds', 'toLotId', 'version', 'updatedAt'];
  moved boolean := false;
  order_state text;
  alternate record;
  lot record;
  asker_user uuid;
  wanted integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'WAITING' OR NEW."decidedAt" IS NOT NULL OR NEW."decidedById" IS NOT NULL OR NEW."refuseReason" IS NOT NULL
       OR NEW."issuedAt" IS NOT NULL OR cardinality(NEW."moveIds") > 0 OR NEW."withdrawnAt" IS NOT NULL OR NEW."withdrawReason" IS NOT NULL THEN
      RAISE EXCEPTION 'warehouse: substitution % is asked first (WAITING, nothing decided, issued or withdrawn)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
    IF FOUND AND order_state NOT IN ('DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD') THEN
      RAISE EXCEPTION 'warehouse: work order % is %; a substitute is asked for a work order that is not done', NEW."workOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    moved := NEW."status" <> OLD."status";
    IF (NEW."siteId", NEW."workOrderId", NEW."styleRevisionId", NEW."bomLineId", NEW."fromItemId", NEW."toItemId", NEW."toItemColourId",
        NEW."alternateId", NEW."quantity", NEW."uom", NEW."baseQuantity", NEW."reasonCode", NEW."reason", NEW."ruleAnswer",
        NEW."requestedById", NEW."requestedByWorkerId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."siteId", OLD."workOrderId", OLD."styleRevisionId", OLD."bomLineId", OLD."fromItemId", OLD."toItemId", OLD."toItemColourId",
        OLD."alternateId", OLD."quantity", OLD."uom", OLD."baseQuantity", OLD."reasonCode", OLD."reason", OLD."ruleAnswer",
        OLD."requestedById", OLD."requestedByWorkerId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'warehouse: what substitution % replaces and by what, how much, why, the rule''s answer, who asked and its creation never change (ask again)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF moved AND NOT ((OLD."status" = 'WAITING' AND NEW."status" IN ('APPROVED', 'REFUSED', 'WITHDRAWN'))
                      OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('ISSUED', 'WITHDRAWN'))) THEN
      RAISE EXCEPTION 'warehouse: substitution % moves WAITING → APPROVED | REFUSED | WITHDRAWN, APPROVED → ISSUED | WITHDRAWN (not % → %)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('ISSUED', 'REFUSED', 'WITHDRAWN')
       AND (to_jsonb(NEW) - ARRAY['note', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['note', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'warehouse: substitution % is % and never changes (only the note)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."approvalTaskId" IS NOT NULL OR OLD."status" <> 'WAITING') AND NEW."approvalTaskId" IS DISTINCT FROM OLD."approvalTaskId" THEN
      RAISE EXCEPTION 'warehouse: the approval task of substitution % is named once, while it waits', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'APPROVED' AND NEW."status" IN ('APPROVED', 'ISSUED', 'WITHDRAWN')
       AND (NEW."decidedAt", NEW."decidedById") IS DISTINCT FROM (OLD."decidedAt", OLD."decidedById") THEN
      RAISE EXCEPTION 'warehouse: the yes of substitution % is given once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF floor_session
       AND (NOT (moved AND OLD."status" = 'APPROVED' AND NEW."status" = 'ISSUED')
            OR (to_jsonb(NEW) - floor_issue) IS DISTINCT FROM (to_jsonb(OLD) - floor_issue)) THEN
      RAISE EXCEPTION 'warehouse: on the floor substitution % is asked for and, once approved, issued; the office decides and withdraws it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Every row.
  IF NEW."quantity" <= 0 OR NEW."baseQuantity" <= 0 OR NEW."reason" IS NULL OR NOT "factory_recall_words_ok"(NEW."reason", 1000, true)
     OR NOT "factory_wh_code_ok"(NEW."reasonCode") OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'warehouse: substitution % says how much (above 0) and why (1 to 1000 characters; a reason code without spaces)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."ruleAnswer") IS DISTINCT FROM 'object' OR jsonb_typeof(NEW."ruleAnswer" -> 'may') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'warehouse: substitution % keeps the alternate rule''s answer as it was given ({ "may": true | false, … })', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."requestedById" IS NULL) = (NEW."requestedByWorkerId" IS NULL) OR (floor_session AND TG_OP = 'INSERT' AND NEW."requestedByWorkerId" IS NULL) THEN
    RAISE EXCEPTION 'warehouse: substitution % is asked by an office user or a worker of the site, exactly one (a floor session as its worker)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."toItemId" = NEW."fromItemId") <> (NEW."alternateId" IS NULL) OR (NEW."toItemId" = NEW."fromItemId" AND NEW."toLotId" IS NULL) THEN
    RAISE EXCEPTION 'warehouse: substitution % uses another material as an alternate of its BOM line, or another lot of the line''s own material', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('APPROVED', 'ISSUED', 'REFUSED')) AND NEW."decidedAt" IS NULL
     OR (NEW."status" = 'WAITING' AND (NEW."decidedAt" IS NOT NULL OR NEW."decidedById" IS NOT NULL))
     OR (NEW."decidedById" IS NOT NULL AND NEW."decidedAt" IS NULL)
     OR (NEW."status" = 'REFUSED') <> (NEW."refuseReason" IS NOT NULL)
     OR (NEW."status" = 'REFUSED' AND NEW."decidedById" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."refuseReason", 1000, true)
     OR (NEW."status" IN ('APPROVED', 'ISSUED') AND NEW."approvalTaskId" IS NOT NULL AND NEW."decidedById" IS NULL) THEN
    RAISE EXCEPTION 'warehouse: substitution % is decided (when) from APPROVED or REFUSED on; by whom when a yes was asked, and a no with who and why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decidedById" IS NOT NULL AND (NEW."decidedById" = NEW."requestedById" OR NEW."decidedById" = NEW."createdById") THEN
    RAISE EXCEPTION 'warehouse: % asked for substitution %; nobody decides their own request', NEW."decidedById", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ISSUED') <> (NEW."issuedAt" IS NOT NULL) OR (NEW."status" = 'ISSUED') <> (cardinality(NEW."moveIds") > 0)
     OR NOT "factory_styles_distinct"(NEW."moveIds") OR NEW."moveIds" IS NULL THEN
    RAISE EXCEPTION 'warehouse: substitution % is issued (when, and its moves: at least one, each once) exactly when ISSUED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL) OR (NEW."withdrawnAt" IS NULL) <> (NEW."withdrawReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."withdrawReason", 500, true) THEN
    RAISE EXCEPTION 'warehouse: substitution % is withdrawn with when and why (1 to 500 characters) exactly when WITHDRAWN', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt" OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt" OR NEW."withdrawnAt" IS DISTINCT FROM OLD."withdrawnAt")
     AND NOT ("factory_recall_not_future"(NEW."decidedAt") AND "factory_recall_not_future"(NEW."issuedAt") AND "factory_recall_not_future"(NEW."withdrawnAt")) THEN
    RAISE EXCEPTION 'warehouse: substitution % is decided, issued or withdrawn at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it names (when set or changed; a row this session cannot see is skipped).
  IF NEW."decidedById" IS NOT NULL AND NEW."requestedByWorkerId" IS NOT NULL AND NOT floor_session
     AND (TG_OP = 'INSERT' OR NEW."decidedById" IS DISTINCT FROM OLD."decidedById") THEN
    SELECT w."userId" INTO asker_user FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."requestedByWorkerId";
    IF FOUND AND asker_user = NEW."decidedById" THEN
      RAISE EXCEPTION 'warehouse: % asked for substitution % on the floor; nobody decides their own request', NEW."decidedById", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."alternateId" IS NOT NULL AND TG_OP = 'INSERT' THEN
    SELECT a."bomLineId", a."itemId" INTO alternate FROM "BomLineAlternate" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."alternateId";
    IF FOUND AND (alternate."bomLineId" <> NEW."bomLineId" OR alternate."itemId" <> NEW."toItemId") THEN
      RAISE EXCEPTION 'warehouse: substitution % uses an alternate of its own BOM line, of the substitute''s material', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."toLotId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."toLotId" IS DISTINCT FROM OLD."toLotId") THEN
    SELECT l."qualityStatus"::text AS quality, l."itemColourId" INTO lot FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."toLotId";
    IF FOUND AND (lot.quality = 'REJECTED' OR lot."itemColourId" IS DISTINCT FROM NEW."toItemColourId") THEN
      RAISE EXCEPTION 'warehouse: substitution % uses a lot that is not rejected, in the substitute''s colour', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" = 'ISSUED' AND (TG_OP = 'INSERT' OR NEW."moveIds" IS DISTINCT FROM OLD."moveIds") THEN
    wanted := cardinality(NEW."moveIds");
    IF (SELECT count(*) FROM "StockMove" m
         WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = ANY (NEW."moveIds")
           AND m."reason" = 'ISSUE' AND m."reversalOfId" IS NULL AND m."workOrderId" = NEW."workOrderId"
           AND m."itemId" = NEW."toItemId" AND (NEW."toLotId" IS NULL OR m."lotId" = NEW."toLotId")) <> wanted THEN
      RAISE EXCEPTION 'warehouse: substitution % is issued by ISSUE moves of its work order and of the substitute (its lot, when named)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MaterialSubstitution_guard" AFTER INSERT OR UPDATE ON "MaterialSubstitution"
  FOR EACH ROW EXECUTE FUNCTION "factory_material_substitution_guard"();
