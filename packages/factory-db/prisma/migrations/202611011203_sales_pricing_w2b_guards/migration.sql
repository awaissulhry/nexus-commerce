-- Written by hand (Prisma does not model triggers or partial indexes), after the generated 202611011202_sales_pricing_w2b_schema
-- and before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Quotes, pricing and configuration in depth, W2b-5 schema wave 38/44 (B-W2b-280; SAL-133, SAL-136, SAL-139, SAL-144,
-- SAL-145, SAL-151, SAL-162, SAL-166, SAL-167, SAL-170, SAL-174, SAL-175, SAL-178, SAL-180, SAL-181, SAL-189, SAL-252,
-- SAL-269). apps/factory-api checks all of this first and answers in words (B-W2b-294, -302, -325, -330, -340); these rules
-- are the last word, for every login, the owner included.
--
--   QuoteTemplate          its company and creation never change; a name of one line; language, currency, validity 1 to 365
--                          days, a deposit above 0 and at most 100 percent with its kind (both or neither), an acceptance
--                          that asks a payment only with a deposit, the Incoterm (three capitals) with its place (both or
--                          neither); its payment terms tenant-wide or of its company (a template of every company: tenant-
--                          wide). Never deleted (archived): quotes name it.
--   QuoteTemplateLine      its template and creation never change; seq from 1; SIZE_GRID or FEE (a template has no rider),
--                          a fee kind exactly on a FEE line, sizes only on a SIZE_GRID line (1 to 100 size codes, whole
--                          pieces); a price above 0; its style tenant-wide or of the template's company (a template of every
--                          company: tenant-wide).
--   Quote                  `Quote_template` (beside W1's guard): the template is named when the quote is made, never
--                          changed; ACTIVE, of the quote's company or of every company.
--   QuoteVersion           REDEFINED `factory_quote_version_guard` (…_sales_guards' whole body, never redefined since; the
--                          trigger stays): word for word, but a SENT version takes one more change besides its decision: its
--                          reminder (reminderSentAt). `QuoteVersion_w2b5_terms` (AFTER): the Incoterm with its place (both or
--                          neither), an acceptance that asks a payment only with a deposit; the reminder set or moved later
--                          only while SENT (never at insert, never cleared, not before the send, not in the future) and never
--                          by a partner session.
--   QuoteLine,             `…_price_steps_drop` (BEFORE UPDATE OF the prices): a price changed by a writer that leaves the
--   SalesOrderLine         waterfall as it was drops it (it no longer explains the price; W1 and W2a routes change prices
--                          without it). `…_w2b5_pricing` (AFTER): a fee kind exactly on a FEE line; a FEE line has no
--                          delivery schedule and no options; the section one line (quote lines); the waterfall adds up
--                          (`factory_price_steps_problem`, below).
--   QuoteLineDelivery,     parts of their line, written while the version is DRAFT (the order CONFIRMED, IN_PRODUCTION or
--   SalesOrderLineDelivery READY: as the line's sizes; the parent row FOR SHARE); line and creation fixed; not on a FEE line; a
--                          size grid's delivery brings sizes of the line's size rows, whole pieces, its quantity their sum,
--                          and the deliveries of a size never more than the line has of it (a line's deliveries in turns: a
--                          transaction advisory lock); a made-to-measure line's one delivery brings its one unit. Removed
--                          with the line (ON DELETE CASCADE).
--   QuoteLineOption,       parts of their line in the same states; line, group, value and creation fixed; not on a FEE line;
--   SalesOrderLineOption   the group offered (or once offered) by the line's style; a free text exactly when the value takes
--                          one, at most its length and matching its pattern; a material's colour only with the material; the
--                          surcharge never 0, a percent (-100 to 1000, never 0) only with the amount it gave.
--   PriceListEntry         `PriceListEntry_validity` (beside the W2a guard): its days (SAL-167) end on or after they start.
--   PriceBreak             written while its version is a DRAFT (the version row FOR SHARE); version, entry and creation
--                          fixed; from 2 pieces; a unit price above 0 or a discount above 0 and below 100, exactly one; a
--                          break of every entry (no entry) a discount. One per entry (or version) and quantity: the unique
--                          key, and for the version-wide ones the partial unique index below.
--   SizeSurcharge          a version's written while the version is a DRAFT; version, style, size and creation fixed; a
--                          version or a style or both; a size code; an amount above 0 with its currency (a version's: its
--                          list's) or a percent above 0 and at most 100, exactly one. One per scope and size: the unique key
--                          and two partial unique indexes below.
--   MoqRule                company, subject and creation fixed; exactly one subject (style, kind of garment, material) of the
--                          company or tenant-wide (a rule of every company: tenant-wide); a price list of the company or
--                          tenant-wide; from 2 pieces; a surcharge exactly when SURCHARGE (an amount with its currency or a
--                          percent above 0 and at most 100).
--   SizeCurve              company, scale and creation fixed; a name of one line; per size of its scale a percent above 0
--                          with up to 4 decimals, totalling exactly 100; its scale tenant-wide or of its company.
--   SalesSettings          `SalesSettings_margin_floors` (beside the W1/W2a guard and the portal cut-offs): the floors by role
--                          are role keys of the tenant's office roles, each 0 to 100 percent with up to 4 decimals, 50 at most.
--   WorkOrderSize          `WorkOrderSize_option_values` (beside production's guard, never redefined here): the option values
--                          each once, values of the tenant, each chosen on the cell's order line when it names one; a cell
--                          never makes a FEE line.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the checks are AFTER triggers (the
-- policies speak first), but the waterfall's drop (BEFORE: it changes the row) and the refused delete of a template. The tenant
-- of a row is left to the policies and the references, never compared here: a rule that reads another row skips a row this
-- session cannot see (and a part removed with its line finds no line). An UPDATE that changes nothing passes.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers and
-- dates moved) and insert the copy: so the first rows the seed gives are ones a copy may repeat (deliveries that bring at most
-- half of each size, options and parts of a DRAFT quote and a CONFIRMED order, breaks and surcharges of a DRAFT price list
-- version); and one option per line and value, one break or surcharge per scope, are the API's or the unique keys that hold
-- a number, a date or a text (one delivery per line and day).
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok", "factory_recall_model_name_ok", "factory_recall_not_future"
-- (…_recall_claims_w2b_guards), "factory_styles_distinct", "factory_styles_decimal_ok" (…_styles_libraries_w2b_guards).

CREATE FUNCTION "factory_sales_pricing_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales pricing: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['QuoteTemplate', 'QuoteTemplateLine', 'QuoteLineDelivery', 'SalesOrderLineDelivery', 'QuoteLineOption',
                              'SalesOrderLineOption', 'PriceBreak', 'SizeSurcharge', 'MoqRule', 'SizeCurve'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_pricing_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- =====================================================================================================================
-- Helpers

-- A size code: 1 to 40 characters, no space or control character.
CREATE FUNCTION "factory_sales_pricing_size_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NOT NULL AND code ~ '^[^[:space:][:cntrl:]]{1,40}$'
$$;

-- An Incoterms 2020 rule as written on documents: three capitals (EXW, FCA, CPT, CIP, DAP, DPU, DDP, FAS, FOB, CFR, CIF). NULL:
-- none.
CREATE FUNCTION "factory_sales_pricing_incoterm_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NULL OR code ~ '^[A-Z]{3}$'
$$;

-- A signed decimal written as a JSON string ("-20.500000"): up to 12 digits before the point and `places` after it. NULL when
-- it is not one (a JSON number is never a price: no float).
CREATE FUNCTION "factory_sales_pricing_decimal"(value jsonb, places integer) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'string' AND (value #>> '{}') ~ ('^-?[0-9]{1,12}(\.[0-9]{1,' || places || '})?$')
              THEN (value #>> '{}')::numeric END
$$;

-- Pieces per size ({ "50": 2, "52": 4 }): an object of 1 to `most` size codes, each a whole number of pieces from 1 to 100000.
-- NULL when it is fine, else what is wrong.
CREATE FUNCTION "factory_sales_pricing_pieces_problem"(pieces jsonb, most integer) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry record;
  n integer := 0;
BEGIN
  IF pieces IS NULL OR jsonb_typeof(pieces) <> 'object' THEN
    RETURN 'the pieces per size are an object of size codes';
  END IF;
  FOR entry IN SELECT e.key, e.value FROM jsonb_each(pieces) AS e LOOP
    n := n + 1;
    IF NOT "factory_sales_pricing_size_ok"(entry.key) THEN
      RETURN format('"%s" is not a size code', left(entry.key, 60));
    END IF;
    IF jsonb_typeof(entry.value) <> 'number' OR (entry.value #>> '{}') !~ '^[0-9]{1,6}$'
       OR (entry.value #>> '{}')::integer < 1 OR (entry.value #>> '{}')::integer > 100000 THEN
      RETURN format('size %s takes a whole number of pieces from 1 to 100000', entry.key);
    END IF;
  END LOOP;
  IF n = 0 OR n > most THEN
    RETURN format('the pieces name 1 to %s sizes', most);
  END IF;
  RETURN NULL;
END
$$;

-- The sum of the pieces of a checked pieces object.
CREATE FUNCTION "factory_sales_pricing_pieces_total"(pieces jsonb) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(sum((e.value #>> '{}')::integer), 0)::integer FROM jsonb_each(pieces) AS e
$$;

-- A step's source: exactly { "type": a model name ("PriceListEntry"), "id": a UUID }.
CREATE FUNCTION "factory_sales_pricing_source_ok"(source jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(source) = 'object'
     AND (SELECT array_agg(k.name ORDER BY k.name) FROM jsonb_object_keys(source) AS k(name)) = ARRAY['id', 'type']
     AND jsonb_typeof(source -> 'type') = 'string' AND "factory_recall_model_name_ok"(source ->> 'type')
     AND jsonb_typeof(source -> 'id') = 'string'
     AND (source ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- The price waterfall of a line (QuoteLine.priceSteps, SalesOrderLine.priceSteps; SAL-174, SAL-175). NULL when it is fine,
-- else what is wrong. A list of 2 to 50 steps, each an object of the known fields:
--   kind        LIST | SUGGESTED | MANUAL (the start, first and only first), BREAK | SIZE_SURCHARGE | OPTION | DISCOUNT |
--               MANUAL (a change), NET (last, and only last);
--   unitPrice   the unit price after the step, a decimal string (6 places) of 0 or more: on the start, every change but
--               SIZE_SURCHARGE, and NET;
--   delta       what a change adds or takes off the running unit price (never 0): unitPrice = the previous one + delta;
--   pct         the percent a change came from: a DISCOUNT's (above 0, at most 100, required), a BREAK's or an OPTION's
--               (-100 to 1000, never 0), up to 4 decimals;
--   sizes       SIZE_SURCHARGE only (required): what it adds per size, { size code: decimal string, never 0 }, 1 to 100 sizes;
--               beside the running price (a size's own price is its size row's), it moves no unitPrice;
--   source      { type, id }: required on LIST, SUGGESTED, BREAK, SIZE_SURCHARGE and OPTION, allowed on DISCOUNT; never on
--               MANUAL or NET;
--   reasonCode  a reason code (PRICE_ADJUSTMENT list, shape only): required on MANUAL, allowed on DISCOUNT;
--   label       one line, up to 200 characters; note: up to 500, line breaks allowed.
-- A LIST start is the line's list price when it has one; NET is the running price and the line's unit price.
CREATE FUNCTION "factory_price_steps_problem"(steps jsonb, unit_price numeric, list_price numeric) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  known CONSTANT text[] := ARRAY['kind', 'unitPrice', 'delta', 'pct', 'sizes', 'source', 'reasonCode', 'label', 'note'];
  step jsonb;
  entry record;
  i integer := 0;
  n integer;
  kind text;
  running numeric;
  price numeric;
  change numeric;
  pct numeric;
  sizes integer;
BEGIN
  IF steps IS NULL OR jsonb_typeof(steps) <> 'array' THEN
    RETURN 'the waterfall is a list of steps';
  END IF;
  n := jsonb_array_length(steps);
  IF n < 2 OR n > 50 THEN
    RETURN 'the waterfall has 2 to 50 steps: a start, the changes, and NET';
  END IF;
  FOR step IN SELECT e.value FROM jsonb_array_elements(steps) WITH ORDINALITY AS e(value, ord) ORDER BY e.ord LOOP
    i := i + 1;
    IF jsonb_typeof(step) <> 'object' THEN
      RETURN format('step %s is not an object', i);
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(step) AS k(name) WHERE k.name <> ALL (known)) THEN
      RETURN format('step %s has a field the waterfall does not know (it knows %s)', i, array_to_string(known, ', '));
    END IF;
    kind := CASE WHEN jsonb_typeof(step -> 'kind') = 'string' THEN step ->> 'kind' END;
    IF kind IS NULL OR kind NOT IN ('LIST', 'SUGGESTED', 'BREAK', 'SIZE_SURCHARGE', 'OPTION', 'DISCOUNT', 'MANUAL', 'NET') THEN
      RETURN format('step %s has no kind of the waterfall (LIST, SUGGESTED, BREAK, SIZE_SURCHARGE, OPTION, DISCOUNT, MANUAL, NET)', i);
    END IF;
    IF step ? 'label' AND (jsonb_typeof(step -> 'label') <> 'string' OR NOT "factory_recall_words_ok"(step ->> 'label', 200, false)) THEN
      RETURN format('step %s (%s): its label is one line of 1 to 200 characters', i, kind);
    END IF;
    IF step ? 'note' AND (jsonb_typeof(step -> 'note') <> 'string' OR NOT "factory_recall_words_ok"(step ->> 'note', 500, true)) THEN
      RETURN format('step %s (%s): its note is 1 to 500 characters', i, kind);
    END IF;
    IF step ? 'source' AND NOT "factory_sales_pricing_source_ok"(step -> 'source') THEN
      RETURN format('step %s (%s): its source is { "type": a record type, "id": a UUID }', i, kind);
    END IF;
    IF (kind IN ('LIST', 'SUGGESTED', 'BREAK', 'SIZE_SURCHARGE', 'OPTION') AND NOT step ? 'source')
       OR (kind IN ('MANUAL', 'NET') AND step ? 'source') THEN
      RETURN format('step %s (%s): a list price, a suggested price, a break, a size surcharge and an option name their source; a manual change and NET name none', i, kind);
    END IF;
    IF step ? 'reasonCode' AND (kind NOT IN ('MANUAL', 'DISCOUNT') OR jsonb_typeof(step -> 'reasonCode') <> 'string'
                                OR (step ->> 'reasonCode') !~ '^[A-Z][A-Z0-9_]{1,39}$') THEN
      RETURN format('step %s (%s): a reason code (capitals, digits and _) belongs to a manual change or a discount', i, kind);
    END IF;
    IF kind = 'MANUAL' AND NOT step ? 'reasonCode' THEN
      RETURN format('step %s: a manual change of the price names its reason code (SAL-175)', i);
    END IF;
    IF step ? 'sizes' AND kind <> 'SIZE_SURCHARGE' THEN
      RETURN format('step %s (%s): sizes belong to a size surcharge', i, kind);
    END IF;
    IF step ? 'pct' THEN
      pct := "factory_sales_pricing_decimal"(step -> 'pct', 4);
      IF kind NOT IN ('BREAK', 'OPTION', 'DISCOUNT') OR pct IS NULL OR pct = 0 OR pct < -100 OR pct > 1000
         OR (kind = 'DISCOUNT' AND (pct <= 0 OR pct > 100)) THEN
        RETURN format('step %s (%s): a percent belongs to a break, an option (-100 to 1000, never 0) or a discount (above 0, at most 100), with up to 4 decimals', i, kind);
      END IF;
    ELSIF kind = 'DISCOUNT' THEN
      RETURN format('step %s: a discount says its percent', i);
    END IF;

    IF i = 1 THEN
      IF kind NOT IN ('LIST', 'SUGGESTED', 'MANUAL') THEN
        RETURN 'the waterfall starts with LIST (the list price), SUGGESTED (from the cost) or MANUAL (typed)';
      END IF;
      IF step ? 'delta' OR step ? 'pct' THEN
        RETURN format('step 1 (%s) is the start: a unit price, no change', kind);
      END IF;
      price := "factory_sales_pricing_decimal"(step -> 'unitPrice', 6);
      IF price IS NULL OR price < 0 THEN
        RETURN format('step 1 (%s): its unit price is a decimal string of 0 or more, up to 6 decimals', kind);
      END IF;
      IF kind = 'LIST' AND list_price IS NOT NULL AND price <> list_price THEN
        RETURN format('step 1 (LIST) starts at %s, not at the line''s list price %s', price, list_price);
      END IF;
      running := price;
    ELSIF i = n THEN
      IF kind <> 'NET' THEN
        RETURN format('the last step (%s) is NET: the unit price the steps reach', kind);
      END IF;
      IF step ? 'delta' OR step ? 'pct' OR step ? 'reasonCode' THEN
        RETURN 'NET is the result: a unit price, no change';
      END IF;
      price := "factory_sales_pricing_decimal"(step -> 'unitPrice', 6);
      IF price IS NULL OR price <> running THEN
        RETURN format('NET says %s but the steps reach %s', coalesce(step ->> 'unitPrice', 'nothing'), running);
      END IF;
      IF unit_price IS NULL OR price <> unit_price THEN
        RETURN format('NET %s is not the line''s unit price %s', price, coalesce(unit_price::text, 'none'));
      END IF;
    ELSE
      IF kind IN ('LIST', 'SUGGESTED', 'NET') THEN
        RETURN format('step %s is %s: only the first step is the start and only the last is NET', i, kind);
      END IF;
      IF kind = 'SIZE_SURCHARGE' THEN
        IF step ? 'delta' OR step ? 'unitPrice' OR NOT step ? 'sizes' OR jsonb_typeof(step -> 'sizes') <> 'object' THEN
          RETURN format('step %s (SIZE_SURCHARGE): what it adds per size, beside the running price (no delta, no unit price)', i);
        END IF;
        sizes := 0;
        FOR entry IN SELECT e.key, e.value FROM jsonb_each(step -> 'sizes') AS e LOOP
          sizes := sizes + 1;
          change := "factory_sales_pricing_decimal"(entry.value, 6);
          IF NOT "factory_sales_pricing_size_ok"(entry.key) OR change IS NULL OR change = 0 THEN
            RETURN format('step %s (SIZE_SURCHARGE): size "%s" adds a decimal string, never 0', i, left(entry.key, 60));
          END IF;
        END LOOP;
        IF sizes = 0 OR sizes > 100 THEN
          RETURN format('step %s (SIZE_SURCHARGE) names 1 to 100 sizes', i);
        END IF;
      ELSE
        change := "factory_sales_pricing_decimal"(step -> 'delta', 6);
        price := "factory_sales_pricing_decimal"(step -> 'unitPrice', 6);
        IF change IS NULL OR change = 0 THEN
          RETURN format('step %s (%s): its delta is a decimal string, never 0', i, kind);
        END IF;
        IF price IS NULL OR price < 0 OR price <> running + change THEN
          RETURN format('step %s (%s): %s %s %s makes %s, not %s', i, kind, running, CASE WHEN change < 0 THEN '-' ELSE '+' END, abs(change), running + change, coalesce(step ->> 'unitPrice', 'nothing'));
        END IF;
        running := price;
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- QuoteTemplate (SAL-144, SAL-252)
CREATE FUNCTION "factory_quote_template_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  terms_company uuid;
  terms_status text;
  found boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales pricing: quote template % is kept, never deleted (archive it): quotes name it', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales pricing: the company and creation of quote template % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."name", 120, false) OR NEW."name" IS NULL THEN
    RAISE EXCEPTION 'sales pricing: quote template % has a name of one line, 1 to 120 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."description", 2000, true) OR NOT "factory_recall_words_ok"(NEW."termsText", 20000, true)
     OR NOT "factory_recall_words_ok"(NEW."termsVersion", 40, false) THEN
    RAISE EXCEPTION 'sales pricing: quote template % has a description up to 2000 characters, terms up to 20000 and a terms version of one line up to 40', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."language" !~ '^[a-z]{2}$' OR NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'sales pricing: quote template % has a language (ISO 639-1, "it") and a currency (ISO 4217, "EUR")', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."validityDays" IS NOT NULL AND (NEW."validityDays" < 1 OR NEW."validityDays" > 365) THEN
    RAISE EXCEPTION 'sales pricing: a quote from template % stands 1 to 365 days, or the sales settings'' default', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."depositPct" IS NULL) <> (NEW."depositKind" IS NULL) OR (NEW."depositPct" IS NOT NULL AND (NEW."depositPct" <= 0 OR NEW."depositPct" > 100)) THEN
    RAISE EXCEPTION 'sales pricing: quote template % asks a deposit above 0 and at most 100 percent with its kind, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."acceptanceMode" IN ('PAY', 'SIGN_AND_PAY') AND NEW."depositPct" IS NULL THEN
    RAISE EXCEPTION 'sales pricing: quote template % is accepted by paying (%), so it asks a deposit', NEW."id", NEW."acceptanceMode"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_sales_pricing_incoterm_ok"(NEW."incoterm") OR (NEW."incoterm" IS NULL) <> (NEW."incotermPlace" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."incotermPlace", 120, false) THEN
    RAISE EXCEPTION 'sales pricing: quote template % names an Incoterm (three capitals, "EXW") with its place (one line, up to 120 characters), or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."paymentTermsId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."paymentTermsId" IS DISTINCT FROM OLD."paymentTermsId") THEN
    SELECT true, p."companyId", p."status"::text INTO found, terms_company, terms_status
      FROM "PaymentTerms" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentTermsId";
    IF found AND (terms_company IS DISTINCT FROM NEW."companyId" AND terms_company IS NOT NULL) THEN
      RAISE EXCEPTION 'sales pricing: quote template % takes payment terms of its own company or tenant-wide ones', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF found AND terms_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'sales pricing: quote template % cannot start with archived payment terms', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QuoteTemplate_never_deleted" BEFORE DELETE ON "QuoteTemplate"
  FOR EACH ROW EXECUTE FUNCTION "factory_quote_template_guard"();
CREATE TRIGGER "QuoteTemplate_guard" AFTER INSERT OR UPDATE ON "QuoteTemplate"
  FOR EACH ROW EXECUTE FUNCTION "factory_quote_template_guard"();

-- QuoteTemplateLine
CREATE FUNCTION "factory_quote_template_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  template_company uuid;
  style_company uuid;
  found boolean;
  problem text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."templateId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."templateId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales pricing: quote template line % never moves to another template', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'sales pricing: quote template line % has its place from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" NOT IN ('SIZE_GRID', 'FEE') THEN
    RAISE EXCEPTION 'sales pricing: quote template line % is a size grid or a fee (a template has no rider: no made-to-measure line)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'FEE') <> (NEW."feeKind" IS NOT NULL) THEN
    RAISE EXCEPTION 'sales pricing: quote template line % has a fee kind exactly when it is a FEE line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sizeQuantities" IS NOT NULL THEN
    IF NEW."kind" <> 'SIZE_GRID' THEN
      RAISE EXCEPTION 'sales pricing: quote template line % is a fee: it has no sizes', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    problem := "factory_sales_pricing_pieces_problem"(NEW."sizeQuantities", 100);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'sales pricing: quote template line %: %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."unitPrice" IS NOT NULL AND NEW."unitPrice" <= 0 THEN
    RAISE EXCEPTION 'sales pricing: quote template line % starts with a price above 0, or the price list''s', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."section", 120, false) OR NOT "factory_recall_words_ok"(NEW."description", 500, true)
     OR NOT "factory_recall_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'sales pricing: quote template line % has a section of one line up to 120 characters, a description up to 500 and a note up to 1000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."styleId" IS DISTINCT FROM OLD."styleId" THEN
    SELECT t."companyId" INTO template_company FROM "QuoteTemplate" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."templateId";
    SELECT true, s."companyId" INTO found, style_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF found AND style_company IS NOT NULL AND style_company IS DISTINCT FROM template_company THEN
      RAISE EXCEPTION 'sales pricing: quote template line % names a style of another company (a template of every company takes tenant-wide styles)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QuoteTemplateLine_guard" AFTER INSERT OR UPDATE ON "QuoteTemplateLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_quote_template_line_guard"();

-- Quote: the template it was started from (beside W1's "Quote_guard")
CREATE FUNCTION "factory_quote_template_named"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  template_company uuid;
  template_status text;
  found boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."templateId" IS NOT DISTINCT FROM OLD."templateId" THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'sales pricing: the template quote % was started from is named when it is made, never changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."templateId" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT true, t."companyId", t."status"::text INTO found, template_company, template_status
    FROM "QuoteTemplate" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."templateId";
  IF found AND (template_status <> 'ACTIVE' OR (template_company IS NOT NULL AND template_company IS DISTINCT FROM NEW."companyId")) THEN
    RAISE EXCEPTION 'sales pricing: quote % starts from an ACTIVE template of its own company or of every company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Quote_template" AFTER INSERT OR UPDATE OF "templateId" ON "Quote"
  FOR EACH ROW EXECUTE FUNCTION "factory_quote_template_named"();

-- =====================================================================================================================
-- QuoteVersion: REDEFINES …_sales_guards' "factory_quote_version_guard" (its whole body, never redefined since; the trigger
-- "QuoteVersion_guard" stays). Word for word, but a SENT version takes one more change besides its decision: its reminder
-- (reminderSentAt, SAL-145; the rules of the reminder are "QuoteVersion_w2b5_terms" below).
CREATE OR REPLACE FUNCTION "factory_quote_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'partyId'];
  sent_states CONSTANT text[] := ARRAY['SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED'];
  final_states CONSTANT text[] := ARRAY['ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'sales: quote version % is %; it is kept, never deleted', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'sales: quote version % starts as DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."quoteId", NEW."revision", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."quoteId", OLD."revision", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales: the quote, number and creation of quote version % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('PENDING_APPROVAL', 'SENT', 'CANCELLED'))
                OR (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('APPROVED', 'DRAFT', 'CANCELLED'))
                OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('SENT', 'DRAFT', 'CANCELLED'))
                OR (OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'sales: quote version % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'SENT'
       AND (to_jsonb(NEW) - (kept || ARRAY['status', 'closedAt', 'decisionNote', 'reminderSentAt', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['status', 'closedAt', 'decisionNote', 'reminderSentAt', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'sales: quote version % was sent; only its decision changes, a change is a new version', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status"::text = ANY (final_states) AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'sales: quote version % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept)
       AND NOT (OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'DECLINED')) THEN
      RAISE EXCEPTION 'sales: a partner session only accepts or declines a SENT quote version (version %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status"::text = ANY (sent_states) AND (NEW."sentAt" IS NULL OR NEW."validUntil" IS NULL OR NEW."documentSha256" IS NULL) THEN
    RAISE EXCEPTION 'sales: quote version % is % without its send time, validity or document hash', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED') AND NEW."sentAt" IS NOT NULL THEN
    RAISE EXCEPTION 'sales: quote version % is % but has a send time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status"::text = ANY (final_states)) <> (NEW."closedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'sales: quote version % is % with the wrong closing time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- QuoteVersion: the delivery terms, the acceptance mode and the reminder (beside the guard above)
CREATE FUNCTION "factory_quote_version_w2b5_terms"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF NOT "factory_sales_pricing_incoterm_ok"(NEW."incoterm") OR (NEW."incoterm" IS NULL) <> (NEW."incotermPlace" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."incotermPlace", 120, false) THEN
    RAISE EXCEPTION 'sales pricing: quote version % names an Incoterm (three capitals, "EXW") with its place (one line, up to 120 characters), or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."acceptanceMode" IN ('PAY', 'SIGN_AND_PAY') AND NEW."depositPct" IS NULL THEN
    RAISE EXCEPTION 'sales pricing: quote version % is accepted by paying (%), so it asks a deposit', NEW."id", NEW."acceptanceMode"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."reminderSentAt" IS NOT NULL THEN
      RAISE EXCEPTION 'sales pricing: quote version % is new: no reminder was sent of it', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."reminderSentAt" IS DISTINCT FROM OLD."reminderSentAt" THEN
    IF current_user = 'factory_partner_runtime' THEN
      RAISE EXCEPTION 'sales pricing: only the office reminds a customer of quote version %', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."reminderSentAt" IS NULL OR (OLD."reminderSentAt" IS NOT NULL AND NEW."reminderSentAt" < OLD."reminderSentAt") THEN
      RAISE EXCEPTION 'sales pricing: the reminder of quote version % is kept: it only moves later, never cleared', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'SENT' OR NEW."status" <> 'SENT' THEN
      RAISE EXCEPTION 'sales pricing: quote version % is %: a customer is reminded only of a SENT version', OLD."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."reminderSentAt" < NEW."sentAt" OR NOT "factory_recall_not_future"(NEW."reminderSentAt") THEN
      RAISE EXCEPTION 'sales pricing: the reminder of quote version % is after its send and not in the future', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QuoteVersion_w2b5_terms" AFTER INSERT OR UPDATE OF "incoterm", "incotermPlace", "acceptanceMode", "depositPct", "reminderSentAt" ON "QuoteVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_quote_version_w2b5_terms"();

-- SalesOrder: the delivery terms (beside W1's guard)
CREATE FUNCTION "factory_sales_order_w2b5_terms"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF NOT "factory_sales_pricing_incoterm_ok"(NEW."incoterm") OR (NEW."incoterm" IS NULL) <> (NEW."incotermPlace" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."incotermPlace", 120, false) THEN
    RAISE EXCEPTION 'sales pricing: sales order % names an Incoterm (three capitals, "EXW") with its place (one line, up to 120 characters), or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SalesOrder_w2b5_terms" AFTER INSERT OR UPDATE OF "incoterm", "incotermPlace" ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_order_w2b5_terms"();

-- =====================================================================================================================
-- QuoteLine, SalesOrderLine: the waterfall dropped when a price changes without it (BEFORE: it changes the row)
CREATE FUNCTION "factory_price_steps_drop"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."priceSteps" IS NOT NULL AND NEW."priceSteps" IS NOT DISTINCT FROM OLD."priceSteps"
     AND (NEW."unitPrice" IS DISTINCT FROM OLD."unitPrice" OR (TG_TABLE_NAME = 'QuoteLine' AND to_jsonb(NEW) -> 'listUnitPrice' IS DISTINCT FROM to_jsonb(OLD) -> 'listUnitPrice')) THEN
    NEW."priceSteps" := NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QuoteLine_price_steps_drop" BEFORE UPDATE OF "unitPrice", "listUnitPrice" ON "QuoteLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_price_steps_drop"();
CREATE TRIGGER "SalesOrderLine_price_steps_drop" BEFORE UPDATE OF "unitPrice" ON "SalesOrderLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_price_steps_drop"();

-- QuoteLine, SalesOrderLine: the fee kind, the section and the waterfall (beside their guards)
CREATE FUNCTION "factory_sales_line_w2b5_pricing"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  list_price numeric;
  problem text;
  parts integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF (NEW."kind" = 'FEE') <> (NEW."feeKind" IS NOT NULL) THEN
    RAISE EXCEPTION 'sales pricing: % % has a fee kind exactly when it is a FEE line', TG_TABLE_NAME, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'QuoteLine' AND NOT "factory_recall_words_ok"(to_jsonb(NEW) ->> 'section', 120, false) THEN
    RAISE EXCEPTION 'sales pricing: quote line % has a section of one line, up to 120 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."kind" = 'FEE' AND OLD."kind" <> 'FEE' THEN
    IF TG_TABLE_NAME = 'QuoteLine' THEN
      SELECT (SELECT count(*) FROM "QuoteLineDelivery" d WHERE d."tenantId" = NEW."tenantId" AND d."lineId" = NEW."id")
           + (SELECT count(*) FROM "QuoteLineOption" o WHERE o."tenantId" = NEW."tenantId" AND o."lineId" = NEW."id") INTO parts;
    ELSE
      SELECT (SELECT count(*) FROM "SalesOrderLineDelivery" d WHERE d."tenantId" = NEW."tenantId" AND d."lineId" = NEW."id")
           + (SELECT count(*) FROM "SalesOrderLineOption" o WHERE o."tenantId" = NEW."tenantId" AND o."lineId" = NEW."id") INTO parts;
    END IF;
    IF parts > 0 THEN
      RAISE EXCEPTION 'sales pricing: % % has a delivery schedule or options: a FEE line has neither', TG_TABLE_NAME, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."priceSteps" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."priceSteps" IS DISTINCT FROM OLD."priceSteps" OR NEW."unitPrice" IS DISTINCT FROM OLD."unitPrice"
          OR to_jsonb(NEW) -> 'listUnitPrice' IS DISTINCT FROM to_jsonb(OLD) -> 'listUnitPrice') THEN
    list_price := (to_jsonb(NEW) ->> 'listUnitPrice')::numeric;
    problem := "factory_price_steps_problem"(NEW."priceSteps", NEW."unitPrice", list_price);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'sales pricing: the price waterfall of % %: %', TG_TABLE_NAME, NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QuoteLine_w2b5_pricing" AFTER INSERT OR UPDATE ON "QuoteLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_line_w2b5_pricing"();
CREATE TRIGGER "SalesOrderLine_w2b5_pricing" AFTER INSERT OR UPDATE ON "SalesOrderLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_line_w2b5_pricing"();

-- =====================================================================================================================
-- QuoteLineDelivery, SalesOrderLineDelivery (SAL-151)
CREATE FUNCTION "factory_sales_line_delivery_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_tenant uuid;
  row_line uuid;
  state text;
  line_kind text;
  part_of uuid;
  problem text;
  entry record;
  have integer;
  planned integer;
  deliveries integer;
  is_quote CONSTANT boolean := TG_TABLE_NAME = 'QuoteLineDelivery';
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_tenant := OLD."tenantId";
    row_line := OLD."lineId";
  ELSE
    row_tenant := NEW."tenantId";
    row_line := NEW."lineId";
  END IF;
  IF is_quote THEN
    SELECT v."status"::text, l."kind"::text, v."id" INTO state, line_kind, part_of
      FROM "QuoteLine" l JOIN "QuoteVersion" v ON v."tenantId" = l."tenantId" AND v."id" = l."versionId"
      WHERE l."tenantId" = row_tenant AND l."id" = row_line FOR SHARE OF v;
    IF state IS NOT NULL AND state <> 'DRAFT' THEN
      RAISE EXCEPTION 'sales pricing: quote version % is %; its delivery schedule changes only while it is DRAFT', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT o."status"::text, l."kind"::text, o."id" INTO state, line_kind, part_of
      FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."orderId"
      WHERE l."tenantId" = row_tenant AND l."id" = row_line FOR SHARE OF o;
    IF state IS NOT NULL AND state NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY') THEN
      RAISE EXCEPTION 'sales pricing: sales order % is %; its delivery schedule changes only while it is CONFIRMED, IN_PRODUCTION or READY', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."lineId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."lineId", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'sales pricing: delivery % never moves to another line', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 500, true) THEN
    RAISE EXCEPTION 'sales pricing: delivery % has a note of 1 to 500 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF line_kind IS NULL THEN
    RETURN NULL;
  END IF;
  IF line_kind = 'FEE' THEN
    RAISE EXCEPTION 'sales pricing: line % is a fee: it has no delivery schedule', row_line
      USING ERRCODE = 'check_violation';
  END IF;
  -- The line's deliveries in turns, so that two schedules written at once never bring more than the line has.
  PERFORM pg_advisory_xact_lock(hashtextextended('factory.sales-line-delivery:' || row_line::text, 0));
  IF line_kind = 'MADE_TO_MEASURE' THEN
    IF NEW."sizeQuantities" IS NOT NULL OR NEW."quantity" <> 1 THEN
      RAISE EXCEPTION 'sales pricing: delivery % of made-to-measure line % brings its one unit (no sizes)', NEW."id", row_line
        USING ERRCODE = 'check_violation';
    END IF;
    IF is_quote THEN
      SELECT count(*) INTO deliveries FROM "QuoteLineDelivery" d WHERE d."tenantId" = row_tenant AND d."lineId" = row_line;
    ELSE
      SELECT count(*) INTO deliveries FROM "SalesOrderLineDelivery" d WHERE d."tenantId" = row_tenant AND d."lineId" = row_line;
    END IF;
    IF deliveries > 1 THEN
      RAISE EXCEPTION 'sales pricing: made-to-measure line % has one delivery: its one unit', row_line
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  problem := "factory_sales_pricing_pieces_problem"(NEW."sizeQuantities", 100);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'sales pricing: delivery % of size grid line %: %', NEW."id", row_line, problem
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."quantity" <> "factory_sales_pricing_pieces_total"(NEW."sizeQuantities") THEN
    RAISE EXCEPTION 'sales pricing: delivery % brings % pieces, the sum of its sizes, not %', NEW."id", "factory_sales_pricing_pieces_total"(NEW."sizeQuantities"), NEW."quantity"
      USING ERRCODE = 'check_violation';
  END IF;
  FOR entry IN SELECT e.key AS size FROM jsonb_each(NEW."sizeQuantities") AS e LOOP
    IF is_quote THEN
      SELECT s."quantity" INTO have FROM "QuoteLineSize" s WHERE s."tenantId" = row_tenant AND s."lineId" = row_line AND s."size" = entry.size;
      SELECT coalesce(sum((d."sizeQuantities" ->> entry.size)::integer), 0) INTO planned
        FROM "QuoteLineDelivery" d WHERE d."tenantId" = row_tenant AND d."lineId" = row_line;
    ELSE
      SELECT s."quantity" INTO have FROM "SalesOrderLineSize" s WHERE s."tenantId" = row_tenant AND s."lineId" = row_line AND s."size" = entry.size;
      SELECT coalesce(sum((d."sizeQuantities" ->> entry.size)::integer), 0) INTO planned
        FROM "SalesOrderLineDelivery" d WHERE d."tenantId" = row_tenant AND d."lineId" = row_line;
    END IF;
    IF have IS NULL THEN
      RAISE EXCEPTION 'sales pricing: delivery % brings size %, which line % does not have', NEW."id", entry.size, row_line
        USING ERRCODE = 'check_violation';
    END IF;
    IF planned > have THEN
      RAISE EXCEPTION 'sales pricing: the deliveries of line % bring % pieces of size %, but the line has %', row_line, planned, entry.size, have
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QuoteLineDelivery_guard" AFTER INSERT OR UPDATE OR DELETE ON "QuoteLineDelivery"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_line_delivery_guard"();
CREATE TRIGGER "SalesOrderLineDelivery_guard" AFTER INSERT OR UPDATE OR DELETE ON "SalesOrderLineDelivery"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_line_delivery_guard"();

-- =====================================================================================================================
-- QuoteLineOption, SalesOrderLineOption (SAL-133, SAL-136, SAL-139)
CREATE FUNCTION "factory_sales_line_option_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_tenant uuid;
  row_line uuid;
  state text;
  line_kind text;
  line_style uuid;
  part_of uuid;
  takes_text boolean;
  text_length integer;
  text_pattern text;
  is_quote CONSTANT boolean := TG_TABLE_NAME = 'QuoteLineOption';
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_tenant := OLD."tenantId";
    row_line := OLD."lineId";
  ELSE
    row_tenant := NEW."tenantId";
    row_line := NEW."lineId";
  END IF;
  IF is_quote THEN
    SELECT v."status"::text, l."kind"::text, l."styleId", v."id" INTO state, line_kind, line_style, part_of
      FROM "QuoteLine" l JOIN "QuoteVersion" v ON v."tenantId" = l."tenantId" AND v."id" = l."versionId"
      WHERE l."tenantId" = row_tenant AND l."id" = row_line FOR SHARE OF v;
    IF state IS NOT NULL AND state <> 'DRAFT' THEN
      RAISE EXCEPTION 'sales pricing: quote version % is %; the options of its lines change only while it is DRAFT', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT o."status"::text, l."kind"::text, l."styleId", o."id" INTO state, line_kind, line_style, part_of
      FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."orderId"
      WHERE l."tenantId" = row_tenant AND l."id" = row_line FOR SHARE OF o;
    IF state IS NOT NULL AND state NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY') THEN
      RAISE EXCEPTION 'sales pricing: sales order % is %; the options of its lines change only while it is CONFIRMED, IN_PRODUCTION or READY', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."lineId", NEW."groupId", NEW."valueId", NEW."createdAt", NEW."createdById")
                          IS DISTINCT FROM (OLD."lineId", OLD."groupId", OLD."valueId", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'sales pricing: option % keeps its line, group and value (another choice is another row)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF line_kind = 'FEE' THEN
    RAISE EXCEPTION 'sales pricing: line % is a fee: it takes no options', row_line
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND line_style IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "StyleOptionGroup" g WHERE g."tenantId" = row_tenant AND g."styleId" = line_style AND g."groupId" = NEW."groupId") THEN
    RAISE EXCEPTION 'sales pricing: option % is of a group the style of line % does not offer', NEW."id", row_line
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."freeText" IS DISTINCT FROM OLD."freeText" THEN
    SELECT v."freeText", v."freeTextMaxLength", v."freeTextPattern" INTO takes_text, text_length, text_pattern
      FROM "OptionValue" v WHERE v."tenantId" = row_tenant AND v."id" = NEW."valueId";
    IF takes_text IS NOT NULL AND takes_text <> (NEW."freeText" IS NOT NULL) THEN
      RAISE EXCEPTION 'sales pricing: option % has the customer''s text exactly when its value takes one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."freeText" IS NOT NULL
       AND (NOT "factory_recall_words_ok"(NEW."freeText", coalesce(text_length, 500), false)
            OR (text_pattern IS NOT NULL AND NEW."freeText" !~ text_pattern)) THEN
      RAISE EXCEPTION 'sales pricing: the text of option % is one line of at most % characters%', NEW."id", coalesce(text_length, 500),
        CASE WHEN text_pattern IS NULL THEN '' ELSE ' matching the value''s pattern' END
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."itemColourId" IS NOT NULL AND NEW."itemId" IS NULL THEN
    RAISE EXCEPTION 'sales pricing: option % names a material''s colour only with the material', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."surchargeAmount" IS NOT NULL AND (NEW."surchargeAmount" = 0 OR abs(NEW."surchargeAmount") >= 1000000000000))
     OR (NEW."surchargePct" IS NOT NULL AND (NEW."surchargePct" = 0 OR NEW."surchargePct" < -100 OR NEW."surchargePct" > 1000 OR NEW."surchargeAmount" IS NULL)) THEN
    RAISE EXCEPTION 'sales pricing: option % has a surcharge never 0, and a percent (-100 to 1000, never 0) only with the amount it gave', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QuoteLineOption_guard" AFTER INSERT OR UPDATE OR DELETE ON "QuoteLineOption"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_line_option_guard"();
CREATE TRIGGER "SalesOrderLineOption_guard" AFTER INSERT OR UPDATE OR DELETE ON "SalesOrderLineOption"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_line_option_guard"();

-- =====================================================================================================================
-- PriceListEntry: its validity inside its version (SAL-167; beside the W2a guard, which keeps it to a DRAFT version)
CREATE FUNCTION "factory_price_list_entry_validity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."validFrom" IS NOT DISTINCT FROM OLD."validFrom" AND NEW."validTo" IS NOT DISTINCT FROM OLD."validTo" THEN
    RETURN NULL;
  END IF;
  IF NEW."validFrom" IS NOT NULL AND NEW."validTo" IS NOT NULL AND NEW."validTo" < NEW."validFrom" THEN
    RAISE EXCEPTION 'pricing: price list entry % ends (%) before it starts (%)', NEW."id", NEW."validTo", NEW."validFrom"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PriceListEntry_validity" AFTER INSERT OR UPDATE OF "validFrom", "validTo" ON "PriceListEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_price_list_entry_validity"();

-- PriceBreak (SAL-166)
CREATE FUNCTION "factory_price_break_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    part_of := OLD."versionId";
    SELECT v."status"::text INTO state FROM "PriceListVersion" v WHERE v."tenantId" = OLD."tenantId" AND v."id" = OLD."versionId" FOR SHARE;
  ELSE
    part_of := NEW."versionId";
    SELECT v."status"::text INTO state FROM "PriceListVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."versionId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'pricing: price list version % is %; its quantity breaks are fixed (make the next version)', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."versionId", NEW."entryId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."versionId", OLD."entryId", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'pricing: quantity break % keeps its version and entry', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."minQuantity" < 2 THEN
    RAISE EXCEPTION 'pricing: quantity break % applies from 2 pieces or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."unitPrice" IS NULL) = (NEW."discountPct" IS NULL)
     OR (NEW."unitPrice" IS NOT NULL AND NEW."unitPrice" <= 0)
     OR (NEW."discountPct" IS NOT NULL AND (NEW."discountPct" <= 0 OR NEW."discountPct" >= 100)) THEN
    RAISE EXCEPTION 'pricing: quantity break % gives a unit price above 0 or a discount above 0 and below 100 percent, exactly one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."entryId" IS NULL AND NEW."unitPrice" IS NOT NULL THEN
    RAISE EXCEPTION 'pricing: quantity break % is for every entry of its version: it gives a discount, not one unit price', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PriceBreak_guard" AFTER INSERT OR UPDATE OR DELETE ON "PriceBreak"
  FOR EACH ROW EXECUTE FUNCTION "factory_price_break_guard"();

-- One version-wide break per quantity (the unique key compares no null entry).
CREATE UNIQUE INDEX "PriceBreak_one_per_version_quantity" ON "PriceBreak" ("tenantId", "versionId", "minQuantity") WHERE "entryId" IS NULL;

-- SizeSurcharge (SAL-180)
CREATE FUNCTION "factory_size_surcharge_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
  list_currency text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    part_of := OLD."versionId";
    IF part_of IS NOT NULL THEN
      SELECT v."status"::text INTO state FROM "PriceListVersion" v WHERE v."tenantId" = OLD."tenantId" AND v."id" = part_of FOR SHARE;
    END IF;
  ELSE
    part_of := NEW."versionId";
    IF part_of IS NOT NULL THEN
      SELECT v."status"::text, l."currency" INTO state, list_currency
        FROM "PriceListVersion" v JOIN "PriceList" l ON l."tenantId" = v."tenantId" AND l."id" = v."listId"
        WHERE v."tenantId" = NEW."tenantId" AND v."id" = part_of FOR SHARE OF v;
    END IF;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'pricing: price list version % is %; its size surcharges are fixed (make the next version)', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."versionId", NEW."styleId", NEW."size", NEW."createdAt", NEW."createdById")
                          IS DISTINCT FROM (OLD."versionId", OLD."styleId", OLD."size", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'pricing: size surcharge % keeps its version, style and size', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."versionId" IS NULL AND NEW."styleId" IS NULL THEN
    RAISE EXCEPTION 'pricing: size surcharge % is of a price list version, a style, or both', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_sales_pricing_size_ok"(NEW."size") THEN
    RAISE EXCEPTION 'pricing: size surcharge % names a size code (1 to 40 characters, no space)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."surchargeAmount" IS NULL) = (NEW."surchargePct" IS NULL)
     OR (NEW."surchargeAmount" IS NOT NULL AND (NEW."surchargeAmount" <= 0 OR NEW."currency" IS NULL OR NEW."currency" !~ '^[A-Z]{3}$'))
     OR (NEW."surchargePct" IS NOT NULL AND (NEW."surchargePct" <= 0 OR NEW."surchargePct" > 100 OR NEW."currency" IS NOT NULL)) THEN
    RAISE EXCEPTION 'pricing: size surcharge % adds an amount above 0 with its currency, or a percent above 0 and at most 100, exactly one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."surchargeAmount" IS NOT NULL AND list_currency IS NOT NULL AND NEW."currency" <> list_currency THEN
    RAISE EXCEPTION 'pricing: size surcharge % is in %, its price list in %', NEW."id", NEW."currency", list_currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SizeSurcharge_guard" AFTER INSERT OR UPDATE OR DELETE ON "SizeSurcharge"
  FOR EACH ROW EXECUTE FUNCTION "factory_size_surcharge_guard"();

-- One surcharge per scope and size (the unique key compares no null version or style).
CREATE UNIQUE INDEX "SizeSurcharge_one_per_version_size" ON "SizeSurcharge" ("tenantId", "versionId", "size") WHERE "styleId" IS NULL;
CREATE UNIQUE INDEX "SizeSurcharge_one_per_style_size" ON "SizeSurcharge" ("tenantId", "styleId", "size") WHERE "versionId" IS NULL;

-- MoqRule (SAL-178)
CREATE FUNCTION "factory_moq_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  other_company uuid;
  found boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."styleId", NEW."productType", NEW."itemId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."styleId", OLD."productType", OLD."itemId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pricing: minimum order rule % keeps its company and what it is about (another subject is another rule)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."styleId" IS NOT NULL)::int + (NEW."productType" IS NOT NULL)::int + (NEW."itemId" IS NOT NULL)::int <> 1 THEN
    RAISE EXCEPTION 'pricing: minimum order rule % is about one style, one kind of garment or one material: exactly one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."minQuantity" < 2 THEN
    RAISE EXCEPTION 'pricing: minimum order rule % asks 2 pieces or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."action" = 'SURCHARGE') <> (NEW."surchargeAmount" IS NOT NULL OR NEW."surchargePct" IS NOT NULL)
     OR (NEW."surchargeAmount" IS NOT NULL AND NEW."surchargePct" IS NOT NULL)
     OR (NEW."surchargeAmount" IS NOT NULL AND (NEW."surchargeAmount" <= 0 OR NEW."currency" IS NULL OR NEW."currency" !~ '^[A-Z]{3}$'))
     OR (NEW."surchargePct" IS NOT NULL AND (NEW."surchargePct" <= 0 OR NEW."surchargePct" > 100))
     OR (NEW."surchargeAmount" IS NULL AND NEW."currency" IS NOT NULL) THEN
    RAISE EXCEPTION 'pricing: minimum order rule % adds a small-run surcharge exactly when it is a SURCHARGE: an amount above 0 with its currency, or a percent above 0 and at most 100', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 500, true) THEN
    RAISE EXCEPTION 'pricing: minimum order rule % has a note of 1 to 500 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    found := false;
    IF NEW."styleId" IS NOT NULL THEN
      SELECT true, s."companyId" INTO found, other_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    ELSIF NEW."itemId" IS NOT NULL THEN
      SELECT true, i."companyId" INTO found, other_company FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    END IF;
    IF found AND other_company IS NOT NULL AND other_company IS DISTINCT FROM NEW."companyId" THEN
      RAISE EXCEPTION 'pricing: minimum order rule % is about a style or material of another company (a rule of every company: tenant-wide ones)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."priceListId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."priceListId" IS DISTINCT FROM OLD."priceListId") THEN
    found := false;
    SELECT true, l."companyId" INTO found, other_company FROM "PriceList" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."priceListId";
    IF found AND other_company IS NOT NULL AND other_company IS DISTINCT FROM NEW."companyId" THEN
      RAISE EXCEPTION 'pricing: minimum order rule % binds a price list of another company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MoqRule_guard" AFTER INSERT OR UPDATE ON "MoqRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_moq_rule_guard"();

-- SizeCurve (SAL-269)
CREATE FUNCTION "factory_size_curve_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry record;
  n integer := 0;
  total numeric := 0;
  scale_company uuid;
  found boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."sizeScaleId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."sizeScaleId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales pricing: size curve % keeps its company and scale', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."name" IS NULL OR NOT "factory_recall_words_ok"(NEW."name", 120, false) THEN
    RAISE EXCEPTION 'sales pricing: size curve % has a name of one line, 1 to 120 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."shares") <> 'object' THEN
    RAISE EXCEPTION 'sales pricing: size curve % gives a percent per size: { "50": "25.0000", … }', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  FOR entry IN SELECT e.key, e.value FROM jsonb_each(NEW."shares") AS e LOOP
    n := n + 1;
    IF jsonb_typeof(entry.value) <> 'string' OR NOT "factory_styles_decimal_ok"(entry.value #>> '{}', 100) THEN
      RAISE EXCEPTION 'sales pricing: size % of size curve % has a percent above 0 and at most 100, up to 4 decimals, as a string', left(entry.key, 60), NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Size" s WHERE s."tenantId" = NEW."tenantId" AND s."scaleId" = NEW."sizeScaleId" AND s."code" = entry.key) THEN
      RAISE EXCEPTION 'sales pricing: size curve % names "%", not a size of its scale', NEW."id", left(entry.key, 60)
        USING ERRCODE = 'check_violation';
    END IF;
    total := total + (entry.value #>> '{}')::numeric;
  END LOOP;
  IF n = 0 OR n > 100 OR total <> 100 THEN
    RAISE EXCEPTION 'sales pricing: the percents of size curve % total %, not 100 (1 to 100 sizes)', NEW."id", total
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT true, s."companyId" INTO found, scale_company FROM "SizeScale" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sizeScaleId";
    IF found AND scale_company IS NOT NULL AND scale_company IS DISTINCT FROM NEW."companyId" THEN
      RAISE EXCEPTION 'sales pricing: size curve % is over a scale of another company (a curve of every company: tenant-wide scales)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SizeCurve_guard" AFTER INSERT OR UPDATE ON "SizeCurve"
  FOR EACH ROW EXECUTE FUNCTION "factory_size_curve_guard"();

-- =====================================================================================================================
-- SalesSettings: the margin floors by role (SAL-189; beside the W1/W2a guard and the portal cut-offs)
CREATE FUNCTION "factory_sales_settings_margin_floors"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry record;
  n integer := 0;
  floor_pct numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."marginFloorByRole" IS NOT DISTINCT FROM OLD."marginFloorByRole" THEN
    RETURN NULL;
  END IF;
  IF NEW."marginFloorByRole" IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(NEW."marginFloorByRole") <> 'object' THEN
    RAISE EXCEPTION 'sales pricing: the margin floors by role of the sales settings % are { role key: percent }', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  FOR entry IN SELECT e.key, e.value FROM jsonb_each(NEW."marginFloorByRole") AS e LOOP
    n := n + 1;
    floor_pct := "factory_sales_pricing_decimal"(entry.value, 4);
    IF floor_pct IS NULL OR floor_pct < 0 OR floor_pct > 100 THEN
      RAISE EXCEPTION 'sales pricing: the margin floor of role % in the sales settings % is a percent 0 to 100, up to 4 decimals, as a string', left(entry.key, 60), NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Role" r WHERE r."tenantId" = NEW."tenantId" AND r."key" = entry.key AND r."audience" = 'OFFICE') THEN
      RAISE EXCEPTION 'sales pricing: the sales settings % give a margin floor to "%", not an office role of the tenant', NEW."id", left(entry.key, 60)
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF n > 50 THEN
    RAISE EXCEPTION 'sales pricing: the sales settings % give margin floors to 50 roles at most', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SalesSettings_margin_floors" AFTER INSERT OR UPDATE OF "marginFloorByRole" ON "SalesSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_settings_margin_floors"();

-- WorkOrderSize: the option values of a cell (B-W2b-225; beside production's guard, never redefined here)
CREATE FUNCTION "factory_work_order_size_option_values"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  value_id uuid;
  line_kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."optionValueIds" IS NOT DISTINCT FROM OLD."optionValueIds"
     AND NEW."salesOrderLineId" IS NOT DISTINCT FROM OLD."salesOrderLineId" THEN
    RETURN NULL;
  END IF;
  IF NEW."salesOrderLineId" IS NOT NULL THEN
    SELECT l."kind"::text INTO line_kind FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
    IF line_kind = 'FEE' THEN
      RAISE EXCEPTION 'sales pricing: work order cell % names order line %, a fee: a fee is never made', NEW."id", NEW."salesOrderLineId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."optionValueIds" IS NULL OR NOT "factory_styles_distinct"(NEW."optionValueIds") OR cardinality(NEW."optionValueIds") > 100 THEN
    RAISE EXCEPTION 'sales pricing: work order cell % names each option value once, 100 at most', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  FOREACH value_id IN ARRAY NEW."optionValueIds" LOOP
    IF TG_OP = 'UPDATE' AND value_id = ANY (coalesce(OLD."optionValueIds", ARRAY[]::uuid[])) AND NEW."salesOrderLineId" IS NOT DISTINCT FROM OLD."salesOrderLineId" THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "OptionValue" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = value_id) THEN
      RAISE EXCEPTION 'sales pricing: work order cell % names %, not an option value', NEW."id", value_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."salesOrderLineId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "SalesOrderLineOption" o WHERE o."tenantId" = NEW."tenantId" AND o."lineId" = NEW."salesOrderLineId" AND o."valueId" = value_id) THEN
      RAISE EXCEPTION 'sales pricing: work order cell % names option value %, which its order line % did not choose', NEW."id", value_id, NEW."salesOrderLineId"
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WorkOrderSize_option_values" AFTER INSERT OR UPDATE OF "optionValueIds", "salesOrderLineId" ON "WorkOrderSize"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_size_option_values"();
