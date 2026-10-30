-- Written by hand (Prisma does not model triggers), after the generated 202610302200_sales_w2a_terms_returns and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- W2a schema wave 2/7: payment terms, price lists, the customer's commercial terms, order amendments and the payment
-- schedule, closing order lines short, returns, repairs, complaints and the return policy (pricing.prisma,
-- returns.prisma, complaints.prisma, and the W2a parts of sales.prisma and parties.prisma). The API modules check all of
-- this first and say it in words; these rules hold for every login, the owner included. The tenant of a row is held by
-- the policies (USING and WITH CHECK on the tenant) and by the tenant-safe references, not here; a guard never refuses a
-- change of a scope key (tenantId, and siteId where the floor works on the table): the policies refuse a move out of the
-- scope. A guard that reads another row skips its check when it cannot see that row (another tenant's: the policy then
-- refuses the write). Every refusal is a check_violation (SQLSTATE 23514).
--
-- It also redefines three functions of earlier hand-written migrations (their triggers stay):
--   "factory_sales_order_line_guard"   (202610283601_sales_guards): a line is closed short also once its order is
--                                      PARTLY_SHIPPED, the only change such a line takes; the short-close columns.
--   "factory_sales_settings_guard"     (202610284601_sales_settings_guards): the return policy's ranges.
--   "factory_ppe_register_entry_guard" (202610285101_quality_lab_guards): one more source type, a Complaint (a safety
--                                      complaint opens its register entry through openRegisterEntryFor).

CREATE FUNCTION "factory_sales_w2a_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- The ledgers of this wave (plan A1 §2.1; scripts/factory/check-append-only.mjs): SalesOrderAmendment (an order's
-- applied changes), ReturnReceipt (the goods' arrival at the dock), RepairStageEvent (a repair's history). No login may
-- change or remove a row, the owner and superusers included; the runtime roles have no UPDATE, DELETE or TRUNCATE grant
-- either (the policy migration).
CREATE FUNCTION "factory_sales_w2a_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a history row is kept as it was written', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- PaymentTerms (FIN-075)
--   every row  a code, a name and a FatturaPA payment method (MP01 … MP23); nameI18n, when set, an object; at least one
--              instalment, each { sharePct (above 0, at most 100), from (ORDER, BEFORE_SHIPPING, DELIVERY, INVOICE),
--              days (0 to 366), endOfMonth (a boolean, optional) }, the shares totalling 100; the early-payment discount
--              (above 0, below 100 percent) and its days (0 to 366) both or neither.
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change.
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_payment_terms_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item jsonb;
  share numeric;
  total numeric := 0;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pricing: payment terms % are archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pricing: the company and creation of payment terms % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."code") = '' OR btrim(NEW."name") = '' THEN
    RAISE EXCEPTION 'pricing: payment terms % have a code and a name', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."method" !~ '^MP(0[1-9]|1[0-9]|2[0-3])$' THEN
    RAISE EXCEPTION 'pricing: the method of payment terms % is a FatturaPA ModalitaPagamento code, MP01 to MP23 (not %)', NEW."id", NEW."method"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."nameI18n" IS NOT NULL AND jsonb_typeof(NEW."nameI18n") <> 'object' THEN
    RAISE EXCEPTION 'pricing: the printed texts of payment terms % are an object of language → text', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."instalments") IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'pricing: the instalments of payment terms % are a list', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_array_length(NEW."instalments") = 0 THEN
    RAISE EXCEPTION 'pricing: payment terms % have at least one instalment', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW."instalments") LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
       OR coalesce(item ->> 'sharePct', '') !~ '^[0-9]{1,3}(\.[0-9]{1,4})?$'
       OR coalesce(item ->> 'from', '') NOT IN ('ORDER', 'BEFORE_SHIPPING', 'DELIVERY', 'INVOICE')
       OR coalesce(jsonb_typeof(item -> 'days'), '') <> 'number'
       OR coalesce(item ->> 'days', '') !~ '^[0-9]{1,3}$'
       OR coalesce(jsonb_typeof(item -> 'endOfMonth'), 'boolean') <> 'boolean' THEN
      RAISE EXCEPTION 'pricing: each instalment of payment terms % is { sharePct, from, days, endOfMonth? } (from ORDER, BEFORE_SHIPPING, DELIVERY or INVOICE): %', NEW."id", item
        USING ERRCODE = 'check_violation';
    END IF;
    share := (item ->> 'sharePct')::numeric;
    IF share <= 0 OR share > 100 OR (item ->> 'days')::integer > 366 THEN
      RAISE EXCEPTION 'pricing: an instalment of payment terms % is a share above 0 and at most 100 percent, 0 to 366 days after its event: %', NEW."id", item
        USING ERRCODE = 'check_violation';
    END IF;
    total := total + share;
  END LOOP;
  IF total <> 100 THEN
    RAISE EXCEPTION 'pricing: the instalments of payment terms % total % percent, not 100', NEW."id", total
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."earlyPaymentDiscountPct" IS NULL) <> (NEW."earlyPaymentDays" IS NULL)
     OR (NEW."earlyPaymentDiscountPct" IS NOT NULL
         AND (NEW."earlyPaymentDiscountPct" <= 0 OR NEW."earlyPaymentDiscountPct" >= 100 OR NEW."earlyPaymentDays" < 0 OR NEW."earlyPaymentDays" > 366)) THEN
    RAISE EXCEPTION 'pricing: the early-payment discount of payment terms % is above 0 and below 100 percent with its days (0 to 366), or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PaymentTerms_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PaymentTerms"
  FOR EACH ROW EXECUTE FUNCTION "factory_payment_terms_guard"();
CREATE TRIGGER "PaymentTerms_no_truncate" BEFORE TRUNCATE ON "PaymentTerms"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_w2a_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- PriceList (SAL-165)
--   every row  a code, a name and an ISO 4217 currency; the list it falls back to is never itself, nor (through its
--              own fallbacks) a list that falls back to it, and is of the same currency.
--   UPDATE     an UPDATE that changes nothing passes; the company, the currency and the creation never change.
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_price_list_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base_currency text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pricing: price list % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."currency", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."currency", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pricing: the company, currency and creation of price list % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."code") = '' OR btrim(NEW."name") = '' OR NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'pricing: price list % has a code, a name and an ISO 4217 currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."baseListId" IS NOT NULL THEN
    IF NEW."baseListId" = NEW."id" THEN
      RAISE EXCEPTION 'pricing: price list % never falls back to itself', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT p."currency" INTO base_currency FROM "PriceList" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."baseListId";
    IF FOUND AND base_currency <> NEW."currency" THEN
      RAISE EXCEPTION 'pricing: price list % (%) falls back to a list in another currency (%)', NEW."id", NEW."currency", base_currency
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      WITH RECURSIVE up ("listId", depth) AS (
        SELECT p."baseListId", 1 FROM "PriceList" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."baseListId"
        UNION ALL
        SELECT p."baseListId", up.depth + 1 FROM "PriceList" p JOIN up ON p."tenantId" = NEW."tenantId" AND p."id" = up."listId"
        WHERE up.depth < 64
      )
      SELECT 1 FROM up WHERE up."listId" = NEW."id"
    ) THEN
      RAISE EXCEPTION 'pricing: price list % would fall back to itself through the lists it falls back to', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PriceList_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PriceList"
  FOR EACH ROW EXECUTE FUNCTION "factory_price_list_guard"();
CREATE TRIGGER "PriceList_no_truncate" BEFORE TRUNCATE ON "PriceList"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_w2a_refuse_truncate"();

-- PriceListVersion (design pricelist.versions: dated versions; an open quote keeps its version)
--   INSERT     a version starts as DRAFT.
--   every row  ACTIVE exactly with its activation time and who; ACTIVE from a day; it ends (validTo) on or after it
--              starts; the ACTIVE versions of one list never overlap (the list's row is locked, so two activations wait
--              for each other).
--   UPDATE     an UPDATE that changes nothing passes; the list, revision and creation never change; DRAFT → ACTIVE,
--              never back; an ACTIVE version changes only its end, its note and version: its prices are fixed.
--   DELETE     only a DRAFT. TRUNCATE refused.
CREATE FUNCTION "factory_price_list_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  movable CONSTANT text[] := ARRAY['validTo', 'note', 'version', 'updatedAt'];
  overlapping integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'pricing: price list version % is %; it is kept, never deleted', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'pricing: price list version % starts as DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."listId", NEW."revision", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."listId", OLD."revision", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pricing: the list, revision and creation of price list version % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'ACTIVE'
       AND (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
      RAISE EXCEPTION 'pricing: price list version % is ACTIVE: its prices and start are fixed, only its end changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."status" = 'ACTIVE') <> (NEW."activatedAt" IS NOT NULL) OR (NEW."status" = 'ACTIVE') <> (NEW."activatedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'pricing: price list version % is % with the wrong activation: an ACTIVE version has when and by whom', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'ACTIVE' AND NEW."validFrom" IS NULL THEN
    RAISE EXCEPTION 'pricing: price list version % is ACTIVE from a day', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."validFrom" IS NOT NULL AND NEW."validTo" IS NOT NULL AND NEW."validTo" < NEW."validFrom" THEN
    RAISE EXCEPTION 'pricing: price list version % ends (%) before it starts (%)', NEW."id", NEW."validTo", NEW."validFrom"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'ACTIVE' THEN
    PERFORM 1 FROM "PriceList" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."listId" FOR UPDATE;
    SELECT count(*) INTO overlapping FROM "PriceListVersion" v
      WHERE v."tenantId" = NEW."tenantId" AND v."listId" = NEW."listId" AND v."id" <> NEW."id" AND v."status" = 'ACTIVE'
        AND daterange(v."validFrom", v."validTo", '[]') && daterange(NEW."validFrom", NEW."validTo", '[]');
    IF overlapping > 0 THEN
      RAISE EXCEPTION 'pricing: price list version % (from % to %) overlaps another ACTIVE version of its list; end that one first', NEW."id", NEW."validFrom", coalesce(NEW."validTo"::text, 'open')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PriceListVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PriceListVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_price_list_version_guard"();
CREATE TRIGGER "PriceListVersion_no_truncate" BEFORE TRUNCATE ON "PriceListVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_w2a_refuse_truncate"();

-- PriceListEntry (design pricelist.prices: autosave per cell, DRAFT version only)
--   INSERT, UPDATE, DELETE  only while its version is a DRAFT (the version row is locked FOR SHARE, so an activation
--                           waits for the transaction that edits its prices); an entry never moves to another version.
--                           An UPDATE that changes nothing passes.
--   every row               a price above 0.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_price_list_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."versionId" IS DISTINCT FROM OLD."versionId" THEN
      RAISE EXCEPTION 'pricing: price list entry % never moves to another version', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    part_of := NEW."versionId";
    SELECT v."status"::text INTO state FROM "PriceListVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."versionId" FOR SHARE;
  ELSE
    part_of := OLD."versionId";
    SELECT v."status"::text INTO state FROM "PriceListVersion" v WHERE v."tenantId" = OLD."tenantId" AND v."id" = OLD."versionId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'pricing: price list version % is %; its prices are fixed (make the next version)', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW."unitPrice" <= 0 THEN
    RAISE EXCEPTION 'pricing: price list entry % has a price above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PriceListEntry_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PriceListEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_price_list_entry_guard"();
CREATE TRIGGER "PriceListEntry_no_truncate" BEFORE TRUNCATE ON "PriceListEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_w2a_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Party: the customer's commercial terms (SAL-012; the parties module checks them first)
--   every row  the default deposit above 0 and at most 100 percent, or none; the minimum order 0 or more, or none; the
--              Incoterms rule three capitals, or none; payment terms and a price list given (or changed) are ACTIVE ones.
--   An UPDATE that changes nothing passes.
CREATE FUNCTION "factory_party_commercial_terms_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW."defaultDepositPct" IS NOT NULL AND (NEW."defaultDepositPct" <= 0 OR NEW."defaultDepositPct" > 100) THEN
    RAISE EXCEPTION 'parties: the default deposit of party % is above 0 and at most 100 percent, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."minimumOrderAmount" IS NOT NULL AND NEW."minimumOrderAmount" < 0 THEN
    RAISE EXCEPTION 'parties: the minimum order of party % is 0 or more, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."incoterm" IS NOT NULL AND NEW."incoterm" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'parties: the Incoterms rule of party % is three capitals (EXW, DAP …), not %', NEW."id", NEW."incoterm"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."paymentTermsId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."paymentTermsId" IS DISTINCT FROM OLD."paymentTermsId") THEN
    SELECT t."status"::text INTO state FROM "PaymentTerms" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."paymentTermsId";
    IF FOUND AND state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'parties: party % is given payment terms that are %', NEW."id", state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."priceListId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."priceListId" IS DISTINCT FROM OLD."priceListId") THEN
    SELECT l."status"::text INTO state FROM "PriceList" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."priceListId";
    IF FOUND AND state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'parties: party % is given a price list that is %', NEW."id", state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Party_commercial_terms_guard" BEFORE INSERT OR UPDATE ON "Party"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_commercial_terms_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- SalesOrderLine (redefines 202610283601_sales_guards' "factory_sales_order_line_guard"; the trigger stays): its rules,
-- and closing short (SAL-210):
--   INSERT, UPDATE, DELETE  only while the order is CONFIRMED, IN_PRODUCTION or READY, as before; once it is
--                           PARTLY_SHIPPED an UPDATE that changes only the short-close columns (closing short, reopening)
--                           passes too; never once SHIPPED, CLOSED or CANCELLED.
--   every row               as before; closed short with its pieces (1 to the line's quantity), time, who and why, all
--                           four or none.
CREATE OR REPLACE FUNCTION "factory_sales_order_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  short CONSTANT text[] := ARRAY['closedShortQuantity', 'closedShortAt', 'closedShortById', 'closeShortReason', 'version', 'updatedAt'];
  state text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."orderId" IS DISTINCT FROM OLD."orderId" THEN
      RAISE EXCEPTION 'sales: sales order line % never moves to another order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    part_of := NEW."orderId";
    SELECT o."status"::text INTO state FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."orderId" FOR SHARE;
  ELSE
    part_of := OLD."orderId";
    SELECT o."status"::text INTO state FROM "SalesOrder" o WHERE o."tenantId" = OLD."tenantId" AND o."id" = OLD."orderId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY')
     AND NOT (TG_OP = 'UPDATE' AND state = 'PARTLY_SHIPPED' AND (to_jsonb(NEW) - short) = (to_jsonb(OLD) - short)) THEN
    RAISE EXCEPTION 'sales: sales order % is %; its lines change only while it is CONFIRMED, IN_PRODUCTION or READY (once PARTLY_SHIPPED, a line is only closed short or reopened)', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1
     OR (NEW."kind" = 'MADE_TO_MEASURE') <> (NEW."measurementProfileId" IS NOT NULL)
     OR (NEW."kind" = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1) THEN
    RAISE EXCEPTION 'sales: sales order line % is a size grid of at least one piece, or one made-to-measure unit with its measurement profile', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."closedShortAt" IS NULL) <> (NEW."closedShortQuantity" IS NULL)
     OR (NEW."closedShortAt" IS NULL) <> (NEW."closedShortById" IS NULL)
     OR (NEW."closedShortAt" IS NULL) <> (coalesce(btrim(NEW."closeShortReason"), '') = '') THEN
    RAISE EXCEPTION 'sales: sales order line % is closed short with its pieces, time, who and why, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."closedShortQuantity" IS NOT NULL AND (NEW."closedShortQuantity" < 1 OR NEW."closedShortQuantity" > NEW."quantity") THEN
    RAISE EXCEPTION 'sales: sales order line % closes short 1 to % pieces, not %', NEW."id", NEW."quantity", NEW."closedShortQuantity"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- SalesSettings (redefines 202610284601_sales_settings_guards' "factory_sales_settings_guard"; the triggers stay): its
-- rules, and the return policy (SAL-338, SAL-340, SAL-343): the return window and the days for the goods 1 to 365, or
-- none; the restocking fee above 0 and at most 100 percent, or none.
CREATE OR REPLACE FUNCTION "factory_sales_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales: the sales settings % are changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales: the company and creation of the sales settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."marginFloorPct" < 0 OR NEW."marginFloorPct" > 100 THEN
    RAISE EXCEPTION 'sales: the margin floor of the sales settings % is 0 to 100 percent', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."discountLimitPct" < 0 OR NEW."discountLimitPct" > 100 THEN
    RAISE EXCEPTION 'sales: the discount limit of the sales settings % is 0 to 100 percent', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."defaultValidityDays" < 1 OR NEW."defaultValidityDays" > 365 THEN
    RAISE EXCEPTION 'sales: the default validity of the sales settings % is 1 to 365 days', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."defaultDepositPct" IS NOT NULL AND (NEW."defaultDepositPct" <= 0 OR NEW."defaultDepositPct" > 100) THEN
    RAISE EXCEPTION 'sales: the default deposit of the sales settings % is above 0 and at most 100 percent, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."returnWindowDays" IS NOT NULL AND (NEW."returnWindowDays" < 1 OR NEW."returnWindowDays" > 365))
     OR (NEW."returnGoodsDueDays" IS NOT NULL AND (NEW."returnGoodsDueDays" < 1 OR NEW."returnGoodsDueDays" > 365)) THEN
    RAISE EXCEPTION 'sales: the return window and the days for the goods of the sales settings % are 1 to 365 days, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."returnRestockingFeePct" IS NOT NULL AND (NEW."returnRestockingFeePct" <= 0 OR NEW."returnRestockingFeePct" > 100) THEN
    RAISE EXCEPTION 'sales: the restocking fee of the sales settings % is above 0 and at most 100 percent, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- SalesOrderAmendment: append-only (above), and on INSERT (SAL-217): its order is CONFIRMED, IN_PRODUCTION or READY
-- (the order row is locked FOR SHARE, as its lines' writes lock it); a revision from 1, a reason, the request, and the
-- before and after snapshots as objects.
CREATE TRIGGER "SalesOrderAmendment_append_only" BEFORE UPDATE OR DELETE ON "SalesOrderAmendment"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_w2a_refuse_change"();
CREATE TRIGGER "SalesOrderAmendment_no_truncate" BEFORE TRUNCATE ON "SalesOrderAmendment"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_w2a_refuse_change"();

CREATE FUNCTION "factory_sales_order_amendment_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  IF NEW."revision" < 1 OR btrim(NEW."reason") = '' OR btrim(NEW."requestId") = '' THEN
    RAISE EXCEPTION 'sales: amendment % has a revision from 1, a reason and its request', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."before") IS DISTINCT FROM 'object' OR jsonb_typeof(NEW."after") IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'sales: amendment % keeps the order before and after as objects', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT o."status"::text INTO state FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."orderId" FOR SHARE;
  IF FOUND AND state NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY') THEN
    RAISE EXCEPTION 'sales: sales order % is %; it is amended only while CONFIRMED, IN_PRODUCTION or READY', NEW."orderId", state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SalesOrderAmendment_check" BEFORE INSERT ON "SalesOrderAmendment"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_order_amendment_check"();

-- SalesOrderMilestone (SAL-216)
--   INSERT     a step starts OPEN.
--   every row  an amount above 0; a share above 0 and at most 100 percent, or none; a deposit request only on the
--              DEPOSIT step; paidAt exactly when PAID; a note exactly when WAIVED or CANCELLED.
--   UPDATE     an UPDATE that changes nothing passes; the order, company, party and creation never change; OPEN →
--              PAID | WAIVED | CANCELLED, and those three never change.
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_sales_order_milestone_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales: payment schedule step % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'sales: payment schedule step % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."orderId", NEW."partyId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."orderId", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales: the order and creation of payment schedule step % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'sales: payment schedule step % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."amount" <= 0 OR (NEW."sharePct" IS NOT NULL AND (NEW."sharePct" <= 0 OR NEW."sharePct" > 100)) THEN
    RAISE EXCEPTION 'sales: payment schedule step % has an amount above 0 and a share above 0 and at most 100 percent, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."depositRequestId" IS NOT NULL AND NEW."kind" <> 'DEPOSIT' THEN
    RAISE EXCEPTION 'sales: payment schedule step % names a deposit request but is not the DEPOSIT step', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'PAID') <> (NEW."paidAt" IS NOT NULL)
     OR (NEW."status" IN ('WAIVED', 'CANCELLED')) <> (coalesce(btrim(NEW."statusNote"), '') <> '') THEN
    RAISE EXCEPTION 'sales: payment schedule step % is % with the wrong payment time or note', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SalesOrderMilestone_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SalesOrderMilestone"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_order_milestone_guard"();
CREATE TRIGGER "SalesOrderMilestone_no_truncate" BEFORE TRUNCATE ON "SalesOrderMilestone"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_w2a_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- ReturnAuthorisation (SAL-333, SAL-362, LOG-114)
--   INSERT     an RMA starts REQUESTED or AUTHORISED.
--   every row  a number; authorised (when and by whom) from AUTHORISED on and in CLOSED, never while REQUESTED or
--              REJECTED; received from RECEIVED on, never before the goods came (REQUESTED, AUTHORISED, REJECTED,
--              CANCELLED); inspectedAt when INSPECTED, never before the goods came; closedAt and the reason exactly in
--              a final status (CLOSED, REJECTED, CANCELLED).
--   UPDATE     an UPDATE that changes nothing passes; the company, party, number, request time and creation never
--              change; the authorisation and the first receipt are set once; REQUESTED → AUTHORISED | REJECTED |
--              CANCELLED, AUTHORISED → RECEIVED | CANCELLED | CLOSED, RECEIVED → INSPECTED | CLOSED, INSPECTED → RECEIVED
--              (more goods came) | CLOSED; a final one never changes. The dock (factory_floor_runtime) changes only the
--              status AUTHORISED → RECEIVED, RECEIVED ⇄ INSPECTED, receivedAt and inspectedAt.
--   At commit  RECEIVED has a dock receipt; INSPECTED has received goods and every received line has its disposition.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_return_authorisation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  dock CONSTANT text[] := ARRAY['status', 'receivedAt', 'inspectedAt', 'version', 'updatedAt'];
  final_states CONSTANT text[] := ARRAY['CLOSED', 'REJECTED', 'CANCELLED'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'returns: RMA % is closed, rejected or cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('REQUESTED', 'AUTHORISED') THEN
      RAISE EXCEPTION 'returns: RMA % starts REQUESTED or AUTHORISED, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."number", NEW."requestedAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."partyId", OLD."number", OLD."requestedAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'returns: the company, customer, number, request and creation of RMA % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status"::text = ANY (final_states) AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'returns: RMA % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'REQUESTED' AND NEW."status" IN ('AUTHORISED', 'REJECTED', 'CANCELLED'))
                OR (OLD."status" = 'AUTHORISED' AND NEW."status" IN ('RECEIVED', 'CANCELLED', 'CLOSED'))
                OR (OLD."status" = 'RECEIVED' AND NEW."status" IN ('INSPECTED', 'CLOSED'))
                OR (OLD."status" = 'INSPECTED' AND NEW."status" IN ('RECEIVED', 'CLOSED'))) THEN
      RAISE EXCEPTION 'returns: RMA % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."authorisedAt" IS NOT NULL AND (NEW."authorisedAt", NEW."authorisedById") IS DISTINCT FROM (OLD."authorisedAt", OLD."authorisedById"))
       OR (OLD."receivedAt" IS NOT NULL AND NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt") THEN
      RAISE EXCEPTION 'returns: the authorisation and the first receipt of RMA % are set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime'
       AND ((to_jsonb(NEW) - (kept || dock)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || dock))
            OR (NEW."status" <> OLD."status"
                AND NOT ((OLD."status" = 'AUTHORISED' AND NEW."status" = 'RECEIVED')
                         OR (OLD."status" = 'RECEIVED' AND NEW."status" = 'INSPECTED')
                         OR (OLD."status" = 'INSPECTED' AND NEW."status" = 'RECEIVED')))) THEN
      RAISE EXCEPTION 'returns: the dock only receives and inspects the goods of RMA %', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."number") = '' THEN
    RAISE EXCEPTION 'returns: RMA % has a number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."authorisedAt" IS NULL) <> (NEW."authorisedById" IS NULL)
     OR (NEW."status" IN ('AUTHORISED', 'RECEIVED', 'INSPECTED', 'CLOSED') AND NEW."authorisedAt" IS NULL)
     OR (NEW."status" IN ('REQUESTED', 'REJECTED') AND NEW."authorisedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'returns: RMA % is % with the wrong authorisation (when and by whom, from AUTHORISED on)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('RECEIVED', 'INSPECTED') AND NEW."receivedAt" IS NULL)
     OR (NEW."status" IN ('REQUESTED', 'AUTHORISED', 'REJECTED', 'CANCELLED') AND (NEW."receivedAt" IS NOT NULL OR NEW."inspectedAt" IS NOT NULL))
     OR (NEW."status" = 'INSPECTED' AND NEW."inspectedAt" IS NULL) THEN
    RAISE EXCEPTION 'returns: RMA % is % with the wrong receipt or inspection time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status"::text = ANY (final_states)) <> (NEW."closedAt" IS NOT NULL)
     OR (NEW."status"::text = ANY (final_states)) <> (coalesce(btrim(NEW."statusReason"), '') <> '') THEN
    RAISE EXCEPTION 'returns: RMA % is %: a closed, rejected or cancelled RMA has its time and reason, another has neither', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReturnAuthorisation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ReturnAuthorisation"
  FOR EACH ROW EXECUTE FUNCTION "factory_return_authorisation_guard"();
CREATE TRIGGER "ReturnAuthorisation_no_truncate" BEFORE TRUNCATE ON "ReturnAuthorisation"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_w2a_refuse_truncate"();

-- An RMA moved to RECEIVED has its dock receipt, and one moved to INSPECTED has every received line decided. Checked at
-- commit (a deferred constraint trigger), so the command may write the receipt, the lines and the RMA in any order.
CREATE FUNCTION "factory_return_authorisation_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'RECEIVED'
     AND NOT EXISTS (SELECT 1 FROM "ReturnReceipt" r WHERE r."tenantId" = NEW."tenantId" AND r."returnId" = NEW."id") THEN
    RAISE EXCEPTION 'returns: RMA % is RECEIVED without a dock receipt (a ReturnReceipt row in the same transaction)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'INSPECTED'
     AND (NOT EXISTS (SELECT 1 FROM "ReturnLine" l WHERE l."tenantId" = NEW."tenantId" AND l."returnId" = NEW."id" AND l."receivedQuantity" > 0)
          OR EXISTS (SELECT 1 FROM "ReturnLine" l WHERE l."tenantId" = NEW."tenantId" AND l."returnId" = NEW."id" AND l."receivedQuantity" > 0 AND l."disposition" IS NULL)) THEN
    RAISE EXCEPTION 'returns: RMA % is INSPECTED while it has no received goods or a received line has no disposition', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "ReturnAuthorisation_evidence" AFTER UPDATE ON "ReturnAuthorisation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" IN ('RECEIVED', 'INSPECTED') AND NEW."status" IS DISTINCT FROM OLD."status")
  EXECUTE FUNCTION "factory_return_authorisation_evidence"();

-- ReturnLine (SAL-335, SAL-341, QHS-117)
--   INSERT, DELETE, and a change of what comes back (pieces, what was sold, reason, price)  only while the RMA is
--              REQUESTED or AUTHORISED (the RMA row is locked FOR SHARE); the receipt, inspection and decision also
--              while it is RECEIVED or INSPECTED; nothing once it is final. A line never moves to another RMA or
--              customer. The dock (factory_floor_runtime) changes only the receipt, the inspection and the outcome.
--   every row  1 piece or more, 0 to that many received; it names what was sold (an order line and/or an invoice line;
--              a size only with its order line, and a size-grid order line with its size); a reason and a description;
--              a price, a credit 0 or more and a discount above 0 and below 100 percent, or none; received pieces with
--              their time (a receipt only with them); a grade exactly with the inspection's time and inspector, and the
--              inspection only of received pieces; a disposition exactly with the decision's time and who, after the
--              inspection; a goods outcome only with a disposition, a replacement line only to REPLACE.
--   sold       never more pieces than were sold, less what other RMAs take back (an open one its pieces, a CLOSED one
--              what it received, a REJECTED or CANCELLED one nothing): the invoice line's quantity (and the invoice line
--              bills the order line and size it names), and what shipped (SHIPPED or DELIVERED shipments) of the order
--              line and size. Each count is taken under an advisory lock of its invoice line or order line and size, so
--              two RMAs cannot both take the last piece.
--   TRUNCATE   refused.
CREATE FUNCTION "factory_return_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  later CONSTANT text[] := ARRAY['receivedQuantity', 'receivedAt', 'receiptId', 'grade', 'cause', 'conditionNote', 'inspectedAt', 'inspectedById',
                                 'disposition', 'goodsOutcome', 'decidedAt', 'decidedById', 'creditAmount', 'replacementLineId', 'version', 'updatedAt'];
  dock CONSTANT text[] := ARRAY['receivedQuantity', 'receivedAt', 'receiptId', 'grade', 'cause', 'conditionNote', 'inspectedAt', 'inspectedById',
                                'disposition', 'goodsOutcome', 'decidedAt', 'decidedById', 'version', 'updatedAt'];
  state text;
  part_of uuid;
  sold numeric;
  taken numeric;
  billed_line uuid;
  billed_size text;
  line_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."returnId" IS DISTINCT FROM OLD."returnId" OR NEW."partyId" IS DISTINCT FROM OLD."partyId" THEN
      RAISE EXCEPTION 'returns: RMA line % never moves to another RMA or customer', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime' AND (to_jsonb(NEW) - (kept || dock)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || dock)) THEN
      RAISE EXCEPTION 'returns: the dock writes only what arrived, its grade and its outcome (RMA line %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    part_of := NEW."returnId";
    SELECT r."status"::text INTO state FROM "ReturnAuthorisation" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."returnId" FOR SHARE;
  ELSE
    part_of := OLD."returnId";
    SELECT r."status"::text INTO state FROM "ReturnAuthorisation" r WHERE r."tenantId" = OLD."tenantId" AND r."id" = OLD."returnId" FOR SHARE;
  END IF;
  IF state IN ('CLOSED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'returns: RMA % is %; its lines never change', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF state IN ('RECEIVED', 'INSPECTED')
     AND (TG_OP <> 'UPDATE' OR (to_jsonb(NEW) - (kept || later)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || later))) THEN
    RAISE EXCEPTION 'returns: the goods of RMA % arrived; what comes back is fixed (only the receipt, inspection and decision of a line change)', part_of
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1 OR NEW."receivedQuantity" < 0 OR NEW."receivedQuantity" > NEW."quantity" THEN
    RAISE EXCEPTION 'returns: RMA line % takes back 1 piece or more, and receives 0 to that many', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."salesOrderLineId" IS NULL AND NEW."invoiceLineId" IS NULL) OR (NEW."size" IS NOT NULL AND NEW."salesOrderLineId" IS NULL) THEN
    RAISE EXCEPTION 'returns: RMA line % names what was sold: an order line (with its size) and/or an invoice line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."reasonCode") = '' OR btrim(NEW."description") = '' THEN
    RAISE EXCEPTION 'returns: RMA line % has a reason and a description', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."unitPrice" < 0 OR NEW."creditAmount" < 0 OR NEW."discountPct" <= 0 OR NEW."discountPct" >= 100 THEN
    RAISE EXCEPTION 'returns: RMA line % has a price and a credit of 0 or more and a discount above 0 and below 100 percent, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."receivedQuantity" > 0) <> (NEW."receivedAt" IS NOT NULL) OR (NEW."receiptId" IS NOT NULL AND NEW."receivedQuantity" = 0) THEN
    RAISE EXCEPTION 'returns: the received pieces of RMA line % have their time (and receipt), and only received pieces do', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."grade" IS NULL) <> (NEW."inspectedAt" IS NULL) OR (NEW."inspectedAt" IS NULL) <> (NEW."inspectedById" IS NULL)
     OR ((NEW."grade" IS NOT NULL OR NEW."cause" IS NOT NULL OR NEW."conditionNote" IS NOT NULL) AND NEW."receivedQuantity" = 0) THEN
    RAISE EXCEPTION 'returns: RMA line % is graded with the inspection''s time and inspector, and only once pieces arrived', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."disposition" IS NULL) <> (NEW."decidedAt" IS NULL) OR (NEW."decidedAt" IS NULL) <> (NEW."decidedById" IS NULL)
     OR (NEW."disposition" IS NOT NULL AND NEW."grade" IS NULL)
     OR (NEW."goodsOutcome" IS NOT NULL AND NEW."disposition" IS NULL)
     OR (NEW."replacementLineId" IS NOT NULL AND NEW."disposition" IS DISTINCT FROM 'REPLACE') THEN
    RAISE EXCEPTION 'returns: RMA line % is decided with its time and who, after its inspection (an outcome only with a disposition, a replacement line only to REPLACE)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' OR (NEW."quantity", NEW."salesOrderLineId", NEW."size", NEW."invoiceLineId") IS DISTINCT FROM (OLD."quantity", OLD."salesOrderLineId", OLD."size", OLD."invoiceLineId") THEN
    IF NEW."invoiceLineId" IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.return-invoiced', NEW."tenantId", NEW."invoiceLineId"), 0));
      SELECT i."quantity", i."salesOrderLineId", i."size" INTO sold, billed_line, billed_size
        FROM "InvoiceLine" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceLineId";
      IF FOUND THEN
        IF NEW."salesOrderLineId" IS NOT NULL
           AND (billed_line IS DISTINCT FROM NEW."salesOrderLineId" OR (billed_size IS NOT NULL AND billed_size IS DISTINCT FROM NEW."size")) THEN
          RAISE EXCEPTION 'returns: RMA line % names invoice line %, which does not bill that order line and size', NEW."id", NEW."invoiceLineId"
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT coalesce(sum(CASE WHEN r."status" = 'CLOSED' THEN l."receivedQuantity" ELSE l."quantity" END), 0) INTO taken
          FROM "ReturnLine" l JOIN "ReturnAuthorisation" r ON r."tenantId" = l."tenantId" AND r."id" = l."returnId"
          WHERE l."tenantId" = NEW."tenantId" AND l."invoiceLineId" = NEW."invoiceLineId" AND l."id" <> NEW."id" AND r."status" NOT IN ('REJECTED', 'CANCELLED');
        IF taken + NEW."quantity" > sold THEN
          RAISE EXCEPTION 'returns: RMA line % takes back % pieces of invoice line %, which billed %, % of them already on other returns', NEW."id", NEW."quantity", NEW."invoiceLineId", sold, taken
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
    IF NEW."salesOrderLineId" IS NOT NULL THEN
      SELECT l."kind"::text INTO line_kind FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
      IF FOUND THEN
        IF line_kind = 'SIZE_GRID' AND NEW."size" IS NULL THEN
          RAISE EXCEPTION 'returns: RMA line % names a size-grid order line without its size', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.return-shipped', NEW."tenantId", NEW."salesOrderLineId", coalesce(NEW."size", '')), 0));
        SELECT coalesce(sum(sl."quantity"), 0) INTO sold
          FROM "ShipmentLine" sl JOIN "Shipment" s ON s."tenantId" = sl."tenantId" AND s."id" = sl."shipmentId"
          WHERE sl."tenantId" = NEW."tenantId" AND sl."salesOrderLineId" = NEW."salesOrderLineId"
            AND (NEW."size" IS NULL OR sl."size" = NEW."size") AND s."status" IN ('SHIPPED', 'DELIVERED');
        SELECT coalesce(sum(CASE WHEN r."status" = 'CLOSED' THEN l."receivedQuantity" ELSE l."quantity" END), 0) INTO taken
          FROM "ReturnLine" l JOIN "ReturnAuthorisation" r ON r."tenantId" = l."tenantId" AND r."id" = l."returnId"
          WHERE l."tenantId" = NEW."tenantId" AND l."salesOrderLineId" = NEW."salesOrderLineId" AND l."size" IS NOT DISTINCT FROM NEW."size"
            AND l."id" <> NEW."id" AND r."status" NOT IN ('REJECTED', 'CANCELLED');
        IF taken + NEW."quantity" > sold THEN
          RAISE EXCEPTION 'returns: RMA line % takes back % pieces of order line % (size %), of which % shipped, % of them already on other returns', NEW."id", NEW."quantity", NEW."salesOrderLineId", coalesce(NEW."size", '-'), sold, taken
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReturnLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ReturnLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_return_line_guard"();
CREATE TRIGGER "ReturnLine_no_truncate" BEFORE TRUNCATE ON "ReturnLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_w2a_refuse_truncate"();

-- ReturnReceipt: append-only (above), and on INSERT (LOG-114): its RMA is AUTHORISED, RECEIVED or INSPECTED (the RMA
-- row is locked FOR SHARE); one parcel or more; its request.
CREATE TRIGGER "ReturnReceipt_append_only" BEFORE UPDATE OR DELETE ON "ReturnReceipt"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_w2a_refuse_change"();
CREATE TRIGGER "ReturnReceipt_no_truncate" BEFORE TRUNCATE ON "ReturnReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_w2a_refuse_change"();

CREATE FUNCTION "factory_return_receipt_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  IF NEW."parcels" < 1 OR btrim(NEW."requestId") = '' THEN
    RAISE EXCEPTION 'returns: dock receipt % counts one parcel or more and names its request', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r."status"::text INTO state FROM "ReturnAuthorisation" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."returnId" FOR SHARE;
  IF FOUND AND state NOT IN ('AUTHORISED', 'RECEIVED', 'INSPECTED') THEN
    RAISE EXCEPTION 'returns: RMA % is %; goods are received only while it is AUTHORISED, RECEIVED or INSPECTED', NEW."returnId", state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReturnReceipt_check" BEFORE INSERT ON "ReturnReceipt"
  FOR EACH ROW EXECUTE FUNCTION "factory_return_receipt_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- RepairOrder (SAL-383, SAL-390, LOG-116)
--   INSERT     a repair starts AWAITING_GOODS or RECEIVED.
--   every row  a number and the problem; a colourway only with its style; arrived (receivedAt) from RECEIVED on, not
--              while AWAITING_GOODS; repairedAt while REPAIRED, none before (it is cleared when the garment goes back
--              into repair); shippedAt exactly when SHIPPED; cancelledAt and the reason exactly when CANCELLED; the
--              safety check's points (an object), result, time and who all set or none; a repaired garment that needs
--              a safety check ships only after a PASS made after the repair.
--   UPDATE     an UPDATE that changes nothing passes; the company, customer, number and creation never change; the
--              stages move AWAITING_GOODS → RECEIVED | CANCELLED, RECEIVED → ESTIMATED | IN_REPAIR | SHIPPED |
--              CANCELLED, ESTIMATED → APPROVED | SHIPPED | CANCELLED, APPROVED → IN_REPAIR | CANCELLED, IN_REPAIR →
--              REPAIRED | CANCELLED, REPAIRED → IN_REPAIR | SHIPPED; SHIPPED and CANCELLED never change.
--   At commit  every stage change has its RepairStageEvent row (from the old stage to the new one, at the repair's new
--              version).
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_repair_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'returns: repair order % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."stage" NOT IN ('AWAITING_GOODS', 'RECEIVED') THEN
      RAISE EXCEPTION 'returns: repair order % starts AWAITING_GOODS or RECEIVED, not %', NEW."id", NEW."stage"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."number", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."partyId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'returns: the company, customer, number and creation of repair order % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."stage" IN ('SHIPPED', 'CANCELLED') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'returns: repair order % is %; it never changes', OLD."id", OLD."stage"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."stage" <> OLD."stage"
       AND NOT ((OLD."stage" = 'AWAITING_GOODS' AND NEW."stage" IN ('RECEIVED', 'CANCELLED'))
                OR (OLD."stage" = 'RECEIVED' AND NEW."stage" IN ('ESTIMATED', 'IN_REPAIR', 'SHIPPED', 'CANCELLED'))
                OR (OLD."stage" = 'ESTIMATED' AND NEW."stage" IN ('APPROVED', 'SHIPPED', 'CANCELLED'))
                OR (OLD."stage" = 'APPROVED' AND NEW."stage" IN ('IN_REPAIR', 'CANCELLED'))
                OR (OLD."stage" = 'IN_REPAIR' AND NEW."stage" IN ('REPAIRED', 'CANCELLED'))
                OR (OLD."stage" = 'REPAIRED' AND NEW."stage" IN ('IN_REPAIR', 'SHIPPED'))) THEN
      RAISE EXCEPTION 'returns: repair order % cannot move from % to %', OLD."id", OLD."stage", NEW."stage"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."number") = '' OR btrim(NEW."problem") = '' THEN
    RAISE EXCEPTION 'returns: repair order % has a number and the problem', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."colourwayId" IS NOT NULL AND NEW."styleId" IS NULL THEN
    RAISE EXCEPTION 'returns: repair order % names a colourway without its style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."stage" NOT IN ('AWAITING_GOODS', 'CANCELLED') AND NEW."receivedAt" IS NULL)
     OR (NEW."stage" = 'AWAITING_GOODS' AND NEW."receivedAt" IS NOT NULL)
     OR (NEW."stage" = 'REPAIRED' AND NEW."repairedAt" IS NULL)
     OR (NEW."stage" IN ('AWAITING_GOODS', 'RECEIVED', 'ESTIMATED', 'APPROVED', 'IN_REPAIR') AND NEW."repairedAt" IS NOT NULL)
     OR (NEW."stage" = 'SHIPPED') <> (NEW."shippedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'returns: repair order % is % with the wrong arrival, repair or shipping time', NEW."id", NEW."stage"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."stage" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."stage" = 'CANCELLED') <> (coalesce(btrim(NEW."cancelReason"), '') <> '') THEN
    RAISE EXCEPTION 'returns: repair order % has its cancel time and reason exactly when it is CANCELLED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."safetyCheckResult" IS NULL) <> (NEW."safetyCheckedAt" IS NULL)
     OR (NEW."safetyCheckResult" IS NULL) <> (NEW."safetyCheckedById" IS NULL)
     OR (NEW."safetyCheckResult" IS NULL) <> (NEW."safetyChecklist" IS NULL)
     OR (NEW."safetyChecklist" IS NOT NULL AND jsonb_typeof(NEW."safetyChecklist") <> 'object') THEN
    RAISE EXCEPTION 'returns: the safety check of repair order % has its points (an object), result, time and who, or none of them', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stage" = 'SHIPPED' AND NEW."repairedAt" IS NOT NULL AND NEW."safetyCheckRequired"
     AND (NEW."safetyCheckResult" IS DISTINCT FROM 'PASS' OR NEW."safetyCheckedAt" < NEW."repairedAt") THEN
    RAISE EXCEPTION 'returns: repair order % is a PPE garment: it goes back only after a passed safety check made after the repair', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RepairOrder_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RepairOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_repair_order_guard"();
CREATE TRIGGER "RepairOrder_no_truncate" BEFORE TRUNCATE ON "RepairOrder"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_w2a_refuse_truncate"();

-- A repair's stage change has its event: checked at commit (a deferred constraint trigger), so the command moves the
-- repair first and writes the event after it.
CREATE FUNCTION "factory_repair_order_stage_has_event"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "RepairStageEvent" e
    WHERE e."tenantId" = NEW."tenantId" AND e."repairId" = NEW."id" AND e."stage" = NEW."stage"
      AND e."fromStage" IS NOT DISTINCT FROM OLD."stage" AND e."repairVersion" = NEW."version"
  ) THEN
    RAISE EXCEPTION 'returns: repair order % moved from % to % without its stage event (a RepairStageEvent row at version % in the same transaction)', NEW."id", OLD."stage", NEW."stage", NEW."version"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "RepairOrder_stage_has_event" AFTER UPDATE ON "RepairOrder"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."stage" IS DISTINCT FROM OLD."stage")
  EXECUTE FUNCTION "factory_repair_order_stage_has_event"();

-- RepairStageEvent: append-only (above), and on INSERT (SAL-390): it moves to another stage than it comes from, names
-- its request, and is the repair's stage and version as they are now (the command moved the repair first).
CREATE TRIGGER "RepairStageEvent_append_only" BEFORE UPDATE OR DELETE ON "RepairStageEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_w2a_refuse_change"();
CREATE TRIGGER "RepairStageEvent_no_truncate" BEFORE TRUNCATE ON "RepairStageEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_w2a_refuse_change"();

CREATE FUNCTION "factory_repair_stage_event_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_stage text;
  current_version integer;
BEGIN
  IF NEW."fromStage" IS NOT DISTINCT FROM NEW."stage" OR btrim(NEW."requestId") = '' THEN
    RAISE EXCEPTION 'returns: stage event % moves to another stage than it comes from and names its request', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT o."stage"::text, o."version" INTO current_stage, current_version FROM "RepairOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."repairId";
  IF FOUND AND (current_stage <> NEW."stage"::text OR current_version <> NEW."repairVersion") THEN
    RAISE EXCEPTION 'returns: stage event % names stage % at version %, but repair order % is % at version % (move the repair first)', NEW."id", NEW."stage", NEW."repairVersion", NEW."repairId", current_stage, current_version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RepairStageEvent_check" BEFORE INSERT ON "RepairStageEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_repair_stage_event_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Complaint (SAL-416, QHS-113, QHS-115)
--   INSERT     a complaint starts NEW or TRIAGED.
--   every row  a number and the customer's words; triaged (category, severity, owner, answer due, when and by whom)
--              while TRIAGED, INVESTIGATING or ANSWERED; a SAFETY one has its alert raised; the owner's acknowledgement
--              (when and by whom) only of a raised alert; answeredAt while ANSWERED, none before; closedAt and the
--              reason exactly when CLOSED; the shipment it names is one of the complaint's company and customer.
--   UPDATE     an UPDATE that changes nothing passes; the company, customer, number and creation never change; the
--              safety alert and its acknowledgement are set once; a CLOSED complaint never changes, and one whose
--              safety alert was raised closes only once its PPE register entry exists (Reg. (EU) 2016/425 art. 8(4):
--              the entry whose source is the complaint, of its company).
--   DELETE     refused (closed). TRUNCATE refused.
CREATE FUNCTION "factory_complaint_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  shipment_company uuid;
  shipment_party uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'complaints: complaint % is closed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('NEW', 'TRIAGED') THEN
      RAISE EXCEPTION 'complaints: complaint % starts NEW or TRIAGED, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."number", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."partyId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'complaints: the company, customer, number and creation of complaint % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'complaints: complaint % is CLOSED; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."safetyRaisedAt" IS NOT NULL AND NEW."safetyRaisedAt" IS DISTINCT FROM OLD."safetyRaisedAt")
       OR (OLD."safetyAcknowledgedAt" IS NOT NULL
           AND (NEW."safetyAcknowledgedAt", NEW."safetyAcknowledgedById") IS DISTINCT FROM (OLD."safetyAcknowledgedAt", OLD."safetyAcknowledgedById")) THEN
      RAISE EXCEPTION 'complaints: the safety alert of complaint % and its acknowledgement are set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."number") = '' OR btrim(NEW."description") = '' THEN
    RAISE EXCEPTION 'complaints: complaint % has a number and the customer''s words', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."triagedAt" IS NULL) <> (NEW."triagedById" IS NULL)
     OR (NEW."status" IN ('TRIAGED', 'INVESTIGATING', 'ANSWERED')
         AND (NEW."category" IS NULL OR NEW."severity" IS NULL OR NEW."ownerId" IS NULL OR NEW."answerDueOn" IS NULL OR NEW."triagedAt" IS NULL)) THEN
    RAISE EXCEPTION 'complaints: complaint % is % without its triage (category, severity, owner, answer due, when and by whom)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."category" = 'SAFETY' AND NEW."safetyRaisedAt" IS NULL)
     OR (NEW."safetyAcknowledgedAt" IS NULL) <> (NEW."safetyAcknowledgedById" IS NULL)
     OR (NEW."safetyAcknowledgedAt" IS NOT NULL AND NEW."safetyRaisedAt" IS NULL) THEN
    RAISE EXCEPTION 'complaints: complaint % about safety raises its alert, and only a raised alert is acknowledged (when and by whom)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ANSWERED' AND NEW."answeredAt" IS NULL) OR (NEW."status" IN ('NEW', 'TRIAGED', 'INVESTIGATING') AND NEW."answeredAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'complaints: complaint % is % with the wrong answer time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."status" = 'CLOSED') <> (coalesce(btrim(NEW."closeReason"), '') <> '') THEN
    RAISE EXCEPTION 'complaints: complaint % has its closing time and reason exactly when it is CLOSED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shipmentId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."shipmentId" IS DISTINCT FROM OLD."shipmentId") THEN
    SELECT s."companyId", s."partyId" INTO shipment_company, shipment_party FROM "Shipment" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."shipmentId";
    IF FOUND AND (shipment_company <> NEW."companyId" OR shipment_party <> NEW."partyId") THEN
      RAISE EXCEPTION 'complaints: complaint % names a shipment of another company or customer', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- Not found in the complaint's own tenant: no such shipment. (A row of another tenant than the session's is refused
    -- by the policy instead.)
    IF NOT FOUND AND coalesce(current_setting('factory.tenant_id', true), '') IN ('', NEW."tenantId"::text) THEN
      RAISE EXCEPTION 'complaints: complaint % names a shipment that does not exist', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" = 'CLOSED' AND TG_OP = 'UPDATE' AND OLD."status" <> 'CLOSED' AND NEW."safetyRaisedAt" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "PpeRegisterEntry" e
       WHERE e."tenantId" = NEW."tenantId" AND e."companyId" = NEW."companyId" AND e."sourceType" = 'Complaint' AND e."sourceId" = NEW."id"
     ) THEN
    RAISE EXCEPTION 'complaints: complaint % is about safety: it closes once it is in the PPE register (Reg. (EU) 2016/425 art. 8(4))', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Complaint_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Complaint"
  FOR EACH ROW EXECUTE FUNCTION "factory_complaint_guard"();
CREATE TRIGGER "Complaint_no_truncate" BEFORE TRUNCATE ON "Complaint"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_w2a_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- PpeRegisterEntry (redefines 202610285101_quality_lab_guards' "factory_ppe_register_entry_guard"; the trigger stays):
--   its rules, with one more source type: a Complaint (a safety complaint opens its register entry, QHS-115).
CREATE OR REPLACE FUNCTION "factory_ppe_register_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  wanted integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: PPE register entry % is kept (closed), never deleted (Reg. 2016/425 art. 8(4))', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'quality: PPE register entry % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."reference", NEW."kind", NEW."reportedAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."reference", OLD."kind", OLD."reportedAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, reference, kind, report time and creation of PPE register entry % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: PPE register entry % is CLOSED; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."reference") = '' OR btrim(NEW."description") = '' THEN
    RAISE EXCEPTION 'quality: PPE register entry % has a reference and a description', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."status" = 'CLOSED') <> (NEW."closedById" IS NOT NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closeReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: PPE register entry % is % with the wrong closing: a closed entry has its time, who closed it and why', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The source, the authority's reference, the corrective action done.
  IF (NEW."sourceType" IS NULL) <> (NEW."sourceId" IS NULL)
     OR (NEW."sourceType" IS NOT NULL AND NEW."sourceType" NOT IN ('QualityReleaseReversal', 'QualityRelease', 'Inspection', 'Shipment', 'LabResult', 'Complaint')) THEN
    RAISE EXCEPTION 'quality: PPE register entry % names its source as a known record type and an id, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."authorityReference" IS NOT NULL AND NEW."authorityNotifiedAt" IS NULL THEN
    RAISE EXCEPTION 'quality: PPE register entry % has an authority reference without the date the authority was told', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."actionCompletedAt" IS NOT NULL AND btrim(coalesce(NEW."actionTaken", '')) = '' THEN
    RAISE EXCEPTION 'quality: PPE register entry % marks a corrective action done without the action', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The id lists: rows of the entry's tenant and company (work orders also of its style).
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."lotIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."companyId" = NEW."companyId" AND l."id" = ANY(NEW."lotIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a material lot that is not of its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."workOrderIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."companyId" = NEW."companyId" AND w."styleId" = NEW."styleId" AND w."id" = ANY(NEW."workOrderIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a work order that is not of its company and style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."shipmentIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "Shipment" s WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId" AND s."id" = ANY(NEW."shipmentIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a shipment that is not of its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- OPEN → CLOSED: its duties met.
  IF TG_OP = 'UPDATE' AND OLD."status" = 'OPEN' AND NEW."status" = 'CLOSED' THEN
    IF btrim(NEW."closeReason") = '' THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes with a reason', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."risk" = 'ASSESSING' THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes once its risk is decided (yes or no)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF btrim(coalesce(NEW."actionTaken", '')) = '' OR NEW."actionCompletedAt" IS NULL THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes once its corrective action is written and done (Reg. 2016/425 art. 8(8))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."risk" = 'YES' AND (NEW."authorityNotifiedAt" IS NULL OR btrim(coalesce(NEW."authorityReference", '')) = '') THEN
      RAISE EXCEPTION 'quality: PPE register entry % may present a risk: it closes once the authorities were told, with the date and their reference (Reg. 2016/425 art. 8(8))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."distributorsInformedAt" IS NULL AND EXISTS (
      SELECT 1
      FROM "ShipmentLine" sl
      JOIN "Shipment" s ON s."tenantId" = sl."tenantId" AND s."id" = sl."shipmentId"
      JOIN "WorkOrder" w ON w."tenantId" = sl."tenantId" AND w."id" = sl."workOrderId"
      WHERE sl."tenantId" = NEW."tenantId"
        AND s."companyId" = NEW."companyId"
        AND s."status" IN ('SHIPPED', 'DELIVERED')
        AND w."companyId" = NEW."companyId"
        AND w."styleId" = NEW."styleId"
        AND (
          w."id" = ANY(coalesce(NEW."workOrderIds", '{}'::uuid[]))
          OR w."batchNumber" = ANY(coalesce(NEW."batchNumbers", '{}'::text[]))
          OR s."id" = ANY(coalesce(NEW."shipmentIds", '{}'::uuid[]))
          OR EXISTS (
            SELECT 1 FROM "StockMove" m
            WHERE m."tenantId" = NEW."tenantId" AND m."companyId" = NEW."companyId" AND m."workOrderId" = w."id"
              AND m."lotId" = ANY(coalesce(NEW."lotIds", '{}'::uuid[])) AND m."reason" = 'ISSUE' AND m."reversalOfId" IS NULL
              AND NOT EXISTS (SELECT 1 FROM "StockMove" r WHERE r."tenantId" = m."tenantId" AND r."siteId" = m."siteId" AND r."reversalOfId" = m."id")
          )
          OR EXISTS (
            SELECT 1 FROM "GarmentSerial" g
            WHERE g."tenantId" = sl."tenantId" AND g."shipmentLineId" = sl."id" AND g."serial" = ANY(coalesce(NEW."serials", '{}'::text[]))
          )
        )
    ) THEN
      RAISE EXCEPTION 'quality: garments PPE register entry % concerns left for customers: it closes once the distributors were informed (Reg. 2016/425 art. 8(4))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
