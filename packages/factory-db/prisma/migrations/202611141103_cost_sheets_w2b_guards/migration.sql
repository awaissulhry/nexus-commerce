-- Written by hand (Prisma does not model triggers or partial unique indexes), after the generated …_cost_sheets_w2b_schema
-- and before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Cost sheets in depth (W2b-6, schema wave 55/57, B-W2b-378; cost-sheets.prisma; FIN-003, FIN-005, FIN-006, FIN-007,
-- FIN-008, FIN-009, FIN-013, FIN-014, FIN-015, FIN-016, FIN-018, FIN-020; GATE-PIECE-PAY). These rules hold for every login,
-- the owner included; apps/factory-api's commands (B-W2b-418, B-W2b-419, B-W2b-420, B-W2b-423) check them first in words.
-- Every refusal is a check_violation (SQLSTATE 23514) in words. The row guards are AFTER triggers (the policies speak
-- first); the refused deletes are BEFORE triggers. An UPDATE that changes nothing passes.
--
-- An APPROVED cost sheet is never edited (FIN-015): it only freezes; a change is a new version. Nobody approves a sheet they
-- made (Owner answer Q3 = A, the Owner included); with a request of the approval engine, the person who decided it. At most
-- one APPROVED sheet per style, company and season (the partial unique index CostSheet_one_approved).
--
-- Reused as they are: recall's `factory_recall_words_ok`, `factory_recall_not_future`, `factory_recall_model_name_ok`;
-- styles' `factory_styles_decimal_ok`. Own triggers on tables of other waves: `CostingSettings_piece_rate_check`
-- (costing.prisma; its W1 and W2a triggers stay as they are) and `OptionValue_cost_delta_check` (options.prisma; B-W2b-211's
-- `OptionValue_check` stays as it is). No earlier function is redefined.

CREATE FUNCTION "factory_cost_sheets_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'costing: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_cost_sheets_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'costing: % % is archived, never deleted (cost sheets name it in their inputs)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

-- A key made of a fixed beginning: the beginning itself, or the beginning and a dash with more after it (the generated
-- isolation tests copy a row with its unique texts suffixed).
CREATE FUNCTION "factory_cost_sheets_key_ok"(key text, beginning text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT key IS NOT NULL AND beginning IS NOT NULL AND char_length(key) <= 300 AND (key = beginning OR starts_with(key, beginning || '-'))
$$;

-- ISO 4217: three capitals.
CREATE FUNCTION "factory_cost_sheets_currency_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NOT NULL AND code ~ '^[A-Z]{3}$'
$$;

-- A period of whole months: from the first day of a month to the last day of a month, not before it (an open end: null).
CREATE FUNCTION "factory_cost_sheets_months_ok"(first_day date, last_day date) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT first_day IS NOT NULL AND extract(day FROM first_day) = 1
     AND (last_day IS NULL OR (extract(day FROM last_day + 1) = 1 AND last_day >= first_day))
$$;

-- An object of at most `largest` bytes as text (null: none, fine).
CREATE FUNCTION "factory_cost_sheets_object_ok"(value jsonb, largest integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NULL OR (jsonb_typeof(value) = 'object' AND octet_length(value::text) <= largest)
$$;

-- Weights per size: an object of 1 to 100 sizes of the style's range, each a decimal string above 0 (at most 4 decimals,
-- at most 99999.9999). Null: none, fine.
CREATE FUNCTION "factory_cost_sheets_weights_ok"(weights jsonb, sizes text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT weights IS NULL OR (
    jsonb_typeof(weights) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(weights)) BETWEEN 1 AND 100
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(weights) e
       WHERE NOT (e.key = ANY (COALESCE(sizes, ARRAY[]::text[])))
          OR jsonb_typeof(e.value) IS DISTINCT FROM 'string'
          OR NOT "factory_styles_decimal_ok"(e.value #>> '{}', 99999.9999)))
$$;

-- =====================================================================================================================
-- CostSheet (FIN-014, FIN-015, FIN-013, FIN-016)
--   INSERT     born DRAFT, neither approved nor frozen; the style of the sheet's company or tenant-wide; a season (when
--              named) OPEN; the currency the company's; the base size of the style's range; a copy of a lower version of
--              the same series.
--   every row  the key `costsheet:<style>:<company>:<season | none>`; the version from 1; ISO 4217; a target price above 0
--              and a target margin below 100 (above -1000); the note up to 2000 characters; the inputs an object of at most
--              256 KiB; the size weights of the style's range (decimals above 0); the size curve one of the style's scale, of
--              the company or every company; with an approval request, a COST_SHEET request of this sheet and company.
--   states     approved (when, by whom) exactly when APPROVED or FROZEN; frozen (when, why; by whom or the system) exactly
--              when FROZEN.
--   UPDATE     an UPDATE that changes nothing passes; the company, style, revision, season, series, version, copy, currency,
--              base size and creation never change; DRAFT → APPROVED → FROZEN only. While DRAFT anything else changes.
--              DRAFT → APPROVED: at least one line; approved now or before, never by its maker; with an approval request,
--              that request APPROVED and decided by the approver. An APPROVED sheet changes nothing but its freezing
--              (APPROVED → FROZEN, not before its approval); a FROZEN one changes no more.
--   DELETE     only a DRAFT (its lines go with it; a sheet another version was copied from stays: the foreign key).
--   TRUNCATE   refused.
CREATE FUNCTION "factory_cost_sheet_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  style_company uuid;
  style_sizes text[];
  style_scale uuid;
  company_currency text;
  season_status text;
  base_key text;
  base_version integer;
  curve_scale uuid;
  curve_company uuid;
  found boolean;
  task record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."styleId", NEW."revisionId", NEW."seasonId", NEW."key", NEW."sheetVersion", NEW."basedOnId", NEW."currency", NEW."baseSize", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."styleId", OLD."revisionId", OLD."seasonId", OLD."key", OLD."sheetVersion", OLD."basedOnId", OLD."currency", OLD."baseSize", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'costing: the company, style, revision, season, version, currency and base size of cost sheet % never change (a change is a new version)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'FROZEN' THEN
      RAISE EXCEPTION 'costing: cost sheet % is frozen: it changes no more', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'APPROVED' THEN
      IF NEW."state" <> 'FROZEN'
         OR (NEW."targetPrice", NEW."targetMarginPct", NEW."sizeCurveId", NEW."sizeWeights", NEW."inputs", NEW."note", NEW."approvalTaskId", NEW."approvedAt", NEW."approvedById")
            IS DISTINCT FROM (OLD."targetPrice", OLD."targetMarginPct", OLD."sizeCurveId", OLD."sizeWeights", OLD."inputs", OLD."note", OLD."approvalTaskId", OLD."approvedAt", OLD."approvedById") THEN
        RAISE EXCEPTION 'costing: cost sheet % is approved and locked: it is never edited, only frozen; a change is a new version', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF OLD."state" = 'DRAFT' AND NEW."state" NOT IN ('DRAFT', 'APPROVED') THEN
      RAISE EXCEPTION 'costing: cost sheet % moves DRAFT → APPROVED → FROZEN (not % → %); a draft nobody needs is deleted', OLD."id", OLD."state", NEW."state"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."state" <> 'DRAFT' THEN
      RAISE EXCEPTION 'costing: cost sheet % is made as a DRAFT, then approved', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT true, s."companyId", s."sizes" INTO found, style_company, style_sizes FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF found AND style_company IS NOT NULL AND style_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'costing: cost sheet % costs a style of another company (a tenant-wide style is costed for any company)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF found AND NOT (NEW."baseSize" = ANY (COALESCE(style_sizes, ARRAY[]::text[]))) THEN
      RAISE EXCEPTION 'costing: the base size % of cost sheet % is not in the style''s size range', NEW."baseSize", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."seasonId" IS NOT NULL THEN
      SELECT z."status"::text INTO season_status FROM "Season" z WHERE z."tenantId" = NEW."tenantId" AND z."id" = NEW."seasonId";
      IF season_status IS DISTINCT FROM 'OPEN' THEN
        RAISE EXCEPTION 'costing: cost sheet % is for a season that is closed: a new sheet is for an open season (or none)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    SELECT c."currency" INTO company_currency FROM "Company" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."companyId";
    IF company_currency IS NOT NULL AND company_currency <> NEW."currency" THEN
      RAISE EXCEPTION 'costing: cost sheet % is in %, its company''s currency is %', NEW."id", NEW."currency", company_currency
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."basedOnId" IS NOT NULL THEN
      SELECT b."key", b."sheetVersion" INTO base_key, base_version FROM "CostSheet" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."basedOnId";
      IF base_key IS DISTINCT FROM NEW."key" OR base_version >= NEW."sheetVersion" THEN
        RAISE EXCEPTION 'costing: cost sheet % is copied from a lower version of the same style, company and season', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NOT "factory_cost_sheets_key_ok"(NEW."key", 'costsheet:' || NEW."styleId" || ':' || NEW."companyId" || ':' || COALESCE(NEW."seasonId"::text, 'none')) THEN
    RAISE EXCEPTION 'costing: cost sheet %''s series is costsheet:<style>:<company>:<season | none>, not %', NEW."id", NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sheetVersion" < 1 OR NOT "factory_cost_sheets_currency_ok"(NEW."currency") THEN
    RAISE EXCEPTION 'costing: cost sheet % has a version from 1 and an ISO 4217 currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."targetPrice" IS NOT NULL AND NEW."targetPrice" <= 0) OR (NEW."targetMarginPct" IS NOT NULL AND (NEW."targetMarginPct" >= 100 OR NEW."targetMarginPct" <= -1000)) THEN
    RAISE EXCEPTION 'costing: cost sheet % has a target price above 0 and a target margin below 100 %%', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 2000, true) OR NOT "factory_cost_sheets_object_ok"(NEW."inputs", 262144) THEN
    RAISE EXCEPTION 'costing: cost sheet % has a note of up to 2000 characters and its inputs as an object of at most 256 KiB', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."sizeWeights" IS DISTINCT FROM OLD."sizeWeights" OR NEW."sizeCurveId" IS DISTINCT FROM OLD."sizeCurveId" THEN
    SELECT s."sizes", s."sizeScaleId" INTO style_sizes, style_scale FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF NOT "factory_cost_sheets_weights_ok"(NEW."sizeWeights", style_sizes) THEN
      RAISE EXCEPTION 'costing: the size weights of cost sheet % are sizes of the style''s range, each a decimal above 0', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."sizeCurveId" IS NOT NULL THEN
      SELECT true, k."sizeScaleId", k."companyId" INTO found, curve_scale, curve_company FROM "SizeCurve" k WHERE k."tenantId" = NEW."tenantId" AND k."id" = NEW."sizeCurveId";
      IF found IS NOT TRUE OR curve_scale IS DISTINCT FROM style_scale OR (curve_company IS NOT NULL AND curve_company <> NEW."companyId") THEN
        RAISE EXCEPTION 'costing: cost sheet % weights by a size curve of the style''s scale, of its company or every company', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."approvalTaskId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."approvalTaskId" IS DISTINCT FROM OLD."approvalTaskId" OR NEW."state" IS DISTINCT FROM OLD."state") THEN
    SELECT t."kind"::text AS kind, t."recordType", t."recordId", t."companyId", t."status"::text AS status, t."decidedById" INTO task
      FROM "ApprovalTask" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."approvalTaskId" FOR SHARE;
    IF task IS NULL OR task.kind <> 'COST_SHEET' OR task."recordType" <> 'CostSheet' OR task."recordId" <> NEW."id" OR task."companyId" <> NEW."companyId" THEN
      RAISE EXCEPTION 'costing: cost sheet % names a request for a yes that is not a COST_SHEET request of this sheet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."state" IN ('APPROVED', 'FROZEN')) <> (NEW."approvedAt" IS NOT NULL AND NEW."approvedById" IS NOT NULL)
     OR (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL) THEN
    RAISE EXCEPTION 'costing: cost sheet % carries when and by whom it was approved exactly once it is approved', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."state" = 'FROZEN') <> (NEW."frozenAt" IS NOT NULL AND NEW."frozenReason" IS NOT NULL)
     OR (NEW."state" <> 'FROZEN' AND (NEW."frozenAt" IS NOT NULL OR NEW."frozenById" IS NOT NULL OR NEW."frozenReason" IS NOT NULL)) THEN
    RAISE EXCEPTION 'costing: cost sheet % carries when and why it was frozen exactly once it is frozen', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."state" = 'DRAFT' AND NEW."state" = 'APPROVED' THEN
    IF NOT "factory_recall_not_future"(NEW."approvedAt") THEN
      RAISE EXCEPTION 'costing: cost sheet % is approved now or before, not in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."createdById" IS NOT NULL AND NEW."approvedById" = NEW."createdById" THEN
      RAISE EXCEPTION 'costing: cost sheet % is approved by someone other than the person who made it (nobody approves their own)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "CostSheetLine" l WHERE l."tenantId" = NEW."tenantId" AND l."costSheetId" = NEW."id") THEN
      RAISE EXCEPTION 'costing: cost sheet % has no line: there is nothing to approve', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."approvalTaskId" IS NOT NULL THEN
      IF task.status <> 'APPROVED' OR task."decidedById" IS DISTINCT FROM NEW."approvedById" THEN
        RAISE EXCEPTION 'costing: cost sheet % is approved on its request''s yes, by the person who decided it', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."state" = 'APPROVED' AND NEW."state" = 'FROZEN'
     AND (NEW."frozenAt" < NEW."approvedAt" OR NOT "factory_recall_not_future"(NEW."frozenAt")) THEN
    RAISE EXCEPTION 'costing: cost sheet % is frozen after its approval, now or before', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "CostSheet_guard" AFTER INSERT OR UPDATE ON "CostSheet"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_sheet_guard"();

CREATE FUNCTION "factory_cost_sheet_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'costing: cost sheet % is % and kept; only a draft is deleted', OLD."id", OLD."state"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "CostSheet_delete_guard" BEFORE DELETE ON "CostSheet"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_sheet_delete_guard"();
CREATE TRIGGER "CostSheet_no_truncate" BEFORE TRUNCATE ON "CostSheet"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_sheets_refuse_truncate"();

-- One approved sheet per style, company and season (a series): the one prices are released from.
CREATE UNIQUE INDEX "CostSheet_one_approved" ON "CostSheet" ("tenantId", "key") WHERE "state" = 'APPROVED';

-- =====================================================================================================================
-- CostSheetLine (FIN-020, FIN-003, FIN-006, FIN-008, FIN-009, FIN-011, FIN-012)
--   write      only while its sheet is a DRAFT (the sheet FOR SHARE: an approval waits for the write, and a write after the
--              approval sees it approved); an UPDATE that changes nothing passes; the sheet and the creation never change.
--   every row  the place from 1; quantity and unit cost 0 or more, cost = quantity × unit cost rounded once, half up, to 6
--              places; a percent (above 0, at most 1000) only on an OVERHEAD, FREIGHT, DUTY or COMMISSION line, with quantity
--              1 and no unit; a size of the style's range (or none: every size); the label one line up to 200 characters,
--              the note up to 1000.
--   source     TYPED names no record; BOM_LINE a BomLine and ROUTING a RoutingOperation of the sheet's revision;
--              OVERHEAD_RULE an OverheadRule, COSTING_SETTINGS a CostingSettings, UPLIFT a MaterialCostUplift (each named);
--              PIECE_RATE, LANDED_COST and PACKAGING a record of any table, or none; the record exists in the tenant. The
--              source fits the category: BOM_LINE a MATERIAL, LEATHER or PACKAGING line; ROUTING a LABOUR or SUBCONTRACT
--              line; PIECE_RATE a LABOUR line; OVERHEAD_RULE and COSTING_SETTINGS an OVERHEAD line; UPLIFT a FREIGHT, DUTY
--              or SUBCONTRACT line; LANDED_COST a FREIGHT or DUTY line; PACKAGING a PACKAGING line.
--   what       a LEATHER line names a material of kind LEATHER; a MATERIAL line that is not typed names its material; a
--              LABOUR line names its kind of work centre and counts minutes (no unit).
--   gate       a PIECE_RATE line only while the sheet company's costing settings (its own row, else the tenant-wide one)
--              switch piece-rate labour on (GATE-PIECE-PAY).
--   DELETE     only while its sheet is a DRAFT (removed with a draft sheet). TRUNCATE refused.
CREATE FUNCTION "factory_cost_sheet_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sheet record;
  style_sizes text[];
  item_kind text;
  record_revision uuid;
  record_found boolean;
  piece_rate boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."costSheetId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."costSheetId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'costing: cost sheet line % never moves to another sheet', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT c."state"::text AS state, c."companyId", c."styleId", c."revisionId" INTO sheet
    FROM "CostSheet" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."costSheetId" FOR SHARE;
  IF sheet.state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'costing: the lines of cost sheet % are written only while it is a DRAFT (an approved sheet is locked: a change is a new version)', NEW."costSheetId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'costing: cost sheet line % has its place from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."quantity" < 0 OR NEW."unitCost" < 0 OR NEW."cost" <> round(NEW."quantity" * NEW."unitCost", 6) THEN
    RAISE EXCEPTION 'costing: cost sheet line % has a quantity and a unit cost of 0 or more, and a cost of quantity × unit cost rounded to 6 places (%)', NEW."id", round(NEW."quantity" * NEW."unitCost", 6)
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."pct" IS NOT NULL AND (NEW."category" NOT IN ('OVERHEAD', 'FREIGHT', 'DUTY', 'COMMISSION') OR NEW."pct" <= 0 OR NEW."pct" > 1000 OR NEW."quantity" <> 1 OR NEW."uom" IS NOT NULL) THEN
    RAISE EXCEPTION 'costing: cost sheet line % is a percent line only for overhead, freight, duty or a commission: a percent above 0 and at most 1000, quantity 1, no unit', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."label", 200, false) OR NOT "factory_recall_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'costing: cost sheet line % has a label of one line up to 200 characters and a note up to 1000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."size" IS NOT NULL THEN
    SELECT s."sizes" INTO style_sizes FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = sheet."styleId";
    IF NOT (NEW."size" = ANY (COALESCE(style_sizes, ARRAY[]::text[]))) THEN
      RAISE EXCEPTION 'costing: cost sheet line % is for size %, which is not in the style''s size range', NEW."id", NEW."size"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."sourceRecordType" IS NULL) <> (NEW."sourceRecordId" IS NULL) THEN
    RAISE EXCEPTION 'costing: cost sheet line % names its source record by its type and id, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."source" = 'TYPED' AND NEW."sourceRecordType" IS NOT NULL)
     OR (NEW."source" = 'BOM_LINE' AND NEW."sourceRecordType" IS DISTINCT FROM 'BomLine')
     OR (NEW."source" = 'ROUTING' AND NEW."sourceRecordType" IS DISTINCT FROM 'RoutingOperation')
     OR (NEW."source" = 'OVERHEAD_RULE' AND NEW."sourceRecordType" IS DISTINCT FROM 'OverheadRule')
     OR (NEW."source" = 'COSTING_SETTINGS' AND NEW."sourceRecordType" IS DISTINCT FROM 'CostingSettings')
     OR (NEW."source" = 'UPLIFT' AND NEW."sourceRecordType" IS DISTINCT FROM 'MaterialCostUplift') THEN
    RAISE EXCEPTION 'costing: cost sheet line % from % names %: a typed line names no record; BOM_LINE a BomLine, ROUTING a RoutingOperation, OVERHEAD_RULE an OverheadRule, COSTING_SETTINGS a CostingSettings, UPLIFT a MaterialCostUplift', NEW."id", NEW."source", COALESCE(NEW."sourceRecordType", 'no record')
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((NEW."source" = 'BOM_LINE' AND NEW."category" IN ('MATERIAL', 'LEATHER', 'PACKAGING'))
          OR (NEW."source" = 'ROUTING' AND NEW."category" IN ('LABOUR', 'SUBCONTRACT'))
          OR (NEW."source" = 'PIECE_RATE' AND NEW."category" = 'LABOUR')
          OR (NEW."source" IN ('OVERHEAD_RULE', 'COSTING_SETTINGS') AND NEW."category" = 'OVERHEAD')
          OR (NEW."source" = 'UPLIFT' AND NEW."category" IN ('FREIGHT', 'DUTY', 'SUBCONTRACT'))
          OR (NEW."source" = 'LANDED_COST' AND NEW."category" IN ('FREIGHT', 'DUTY'))
          OR (NEW."source" = 'PACKAGING' AND NEW."category" = 'PACKAGING')
          OR NEW."source" = 'TYPED') THEN
    RAISE EXCEPTION 'costing: cost sheet line % is a % line, which does not come from %', NEW."id", NEW."category", NEW."source"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sourceRecordType" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."sourceRecordType", NEW."sourceRecordId") IS DISTINCT FROM (OLD."sourceRecordType", OLD."sourceRecordId")) THEN
    IF NOT "factory_recall_model_name_ok"(NEW."sourceRecordType") OR to_regclass(quote_ident(NEW."sourceRecordType")) IS NULL THEN
      RAISE EXCEPTION 'costing: cost sheet line % names a source record of %, which is not a table', NEW."id", NEW."sourceRecordType"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."sourceRecordType" IN ('BomLine', 'RoutingOperation') THEN
      EXECUTE format('SELECT true, r."revisionId" FROM %I r WHERE r."tenantId" = $1 AND r."id" = $2', NEW."sourceRecordType")
        INTO record_found, record_revision USING NEW."tenantId", NEW."sourceRecordId";
      IF record_found IS NOT TRUE OR record_revision IS DISTINCT FROM sheet."revisionId" THEN
        RAISE EXCEPTION 'costing: cost sheet line % names a % that is not of the sheet''s revision', NEW."id", NEW."sourceRecordType"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I r WHERE r."tenantId" = $1 AND r."id" = $2)', NEW."sourceRecordType")
        INTO record_found USING NEW."tenantId", NEW."sourceRecordId";
      IF record_found IS NOT TRUE THEN
        RAISE EXCEPTION 'costing: cost sheet line % names a % that does not exist', NEW."id", NEW."sourceRecordType"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."itemId" IS NOT NULL THEN
    SELECT i."kind"::text INTO item_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
  END IF;
  IF (NEW."category" = 'LEATHER' AND item_kind IS DISTINCT FROM 'LEATHER')
     OR (NEW."category" = 'MATERIAL' AND NEW."source" <> 'TYPED' AND NEW."itemId" IS NULL) THEN
    RAISE EXCEPTION 'costing: cost sheet line % names its material: a LEATHER line a leather article, a MATERIAL line the material it costs', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."category" = 'LABOUR' AND (NEW."workCentreKind" IS NULL OR NEW."uom" IS NOT NULL) THEN
    RAISE EXCEPTION 'costing: labour line % names its kind of work centre and counts minutes (no unit)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."source" = 'PIECE_RATE' THEN
    SELECT s."pieceRateLabour" INTO piece_rate FROM "CostingSettings" s
     WHERE s."tenantId" = NEW."tenantId" AND (s."companyId" = sheet."companyId" OR s."companyId" IS NULL)
     ORDER BY s."companyId" NULLS LAST LIMIT 1;
    IF piece_rate IS NOT TRUE THEN
      RAISE EXCEPTION 'costing: cost sheet line % costs labour by piece rate, which the company''s costing settings keep switched off (GATE-PIECE-PAY)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "CostSheetLine_guard" AFTER INSERT OR UPDATE ON "CostSheetLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_sheet_line_guard"();

-- A line goes only while its sheet is a DRAFT; when the sheet itself is deleted (a draft), the sheet is gone by then.
CREATE FUNCTION "factory_cost_sheet_line_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sheet_state text;
BEGIN
  SELECT c."state"::text INTO sheet_state FROM "CostSheet" c WHERE c."tenantId" = OLD."tenantId" AND c."id" = OLD."costSheetId" FOR SHARE;
  IF sheet_state IS NOT NULL AND sheet_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'costing: the lines of cost sheet % are removed only while it is a DRAFT (it is %)', OLD."costSheetId", sheet_state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "CostSheetLine_delete_guard" BEFORE DELETE ON "CostSheetLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_sheet_line_delete_guard"();
CREATE TRIGGER "CostSheetLine_no_truncate" BEFORE TRUNCATE ON "CostSheetLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_sheets_refuse_truncate"();

-- =====================================================================================================================
-- LeatherCostBasis (FIN-003)
--   INSERT     a material of kind LEATHER and a style (when named), each of the basis' company or tenant-wide.
--   every row  the key `leather:<item>:<style | all>:<company | all>`; the unit FT2 or DM2; the expected yield above 0 and at
--              most 100 percent; the grade mix an object of 1 to 20 grade codes of the tenant (active when the mix is
--              written), each a share above 0 (at most 4 decimals) totalling exactly 100; the note up to 1000 characters.
--   UPDATE     an UPDATE that changes nothing passes; the company, material, style, key, first day and creation never change.
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_leather_cost_basis_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_company uuid;
  item_kind text;
  style_company uuid;
  found boolean;
  total numeric := 0;
  entry record;
  n integer := 0;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."itemId", NEW."styleId", NEW."key", NEW."validFrom", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."itemId", OLD."styleId", OLD."key", OLD."validFrom", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'costing: the company, material, style and first day of leather cost basis % never change (a new basis is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT true, i."companyId", i."kind"::text INTO found, item_company, item_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF found AND (item_kind <> 'LEATHER' OR (item_company IS NOT NULL AND item_company IS DISTINCT FROM NEW."companyId")) THEN
      RAISE EXCEPTION 'costing: leather cost basis % is for a leather article of its company, or a tenant-wide one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."styleId" IS NOT NULL THEN
      SELECT s."companyId" INTO style_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
      IF style_company IS NOT NULL AND style_company IS DISTINCT FROM NEW."companyId" THEN
        RAISE EXCEPTION 'costing: leather cost basis % is for a style of its company, or a tenant-wide one', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NOT "factory_cost_sheets_key_ok"(NEW."key", 'leather:' || NEW."itemId" || ':' || COALESCE(NEW."styleId"::text, 'all') || ':' || COALESCE(NEW."companyId"::text, 'all')) THEN
    RAISE EXCEPTION 'costing: leather cost basis %''s key is leather:<material>:<style | all>:<company | all>, not %', NEW."id", NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."areaUnit" NOT IN ('FT2', 'DM2') OR NEW."expectedYieldPct" <= 0 OR NEW."expectedYieldPct" > 100 THEN
    RAISE EXCEPTION 'costing: leather cost basis % is priced in FT2 or DM2 and expects a yield above 0 and at most 100 %%', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'costing: leather cost basis % has a note of up to 1000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."gradeMix" IS DISTINCT FROM OLD."gradeMix" THEN
    IF jsonb_typeof(NEW."gradeMix") IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'costing: the grade mix of leather cost basis % is an object of grade codes and shares ({ "A": "60.0000" })', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    FOR entry IN SELECT e.key, e.value FROM jsonb_each(NEW."gradeMix") e LOOP
      n := n + 1;
      IF jsonb_typeof(entry.value) IS DISTINCT FROM 'string' OR NOT "factory_styles_decimal_ok"(entry.value #>> '{}', 100)
         OR NOT EXISTS (SELECT 1 FROM "LeatherGrade" g WHERE g."tenantId" = NEW."tenantId" AND g."code" = entry.key AND g."active") THEN
        RAISE EXCEPTION 'costing: the grade mix of leather cost basis % names % with %: an active grade of the tenant, a share above 0 with at most 4 decimals', NEW."id", entry.key, entry.value
          USING ERRCODE = 'check_violation';
      END IF;
      total := total + (entry.value #>> '{}')::numeric;
    END LOOP;
    IF n NOT BETWEEN 1 AND 20 OR total <> 100 THEN
      RAISE EXCEPTION 'costing: the grade mix of leather cost basis % has 1 to 20 grades whose shares total exactly 100 (not %)', NEW."id", total
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "LeatherCostBasis_guard" AFTER INSERT OR UPDATE ON "LeatherCostBasis"
  FOR EACH ROW EXECUTE FUNCTION "factory_leather_cost_basis_guard"();
CREATE TRIGGER "LeatherCostBasis_never_deleted" BEFORE DELETE ON "LeatherCostBasis"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_sheets_never_deleted"();
CREATE TRIGGER "LeatherCostBasis_no_truncate" BEFORE TRUNCATE ON "LeatherCostBasis"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_sheets_refuse_truncate"();

-- =====================================================================================================================
-- OverheadRule (FIN-007)
--   every row  the key `overhead:<company | all>:<basis>:<kind | all>`; PERCENT_OF_LABOUR a percent above 0 and at most
--              1000 with no currency, the other bases an amount above 0 with its ISO 4217 currency; whole months (from the
--              first day of a month to the last day of a month, or open-ended); the note up to 1000 characters; the ACTIVE
--              rules of one key never overlap in time (a transaction advisory lock per key, so two writers take turns).
--   UPDATE     an UPDATE that changes nothing passes; the company, key, basis, kind, first day and creation never change.
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_overhead_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."key", NEW."basis", NEW."workCentreKind", NEW."periodStart", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."key", OLD."basis", OLD."workCentreKind", OLD."periodStart", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'costing: the company, basis, kind of work centre and first day of overhead rule % never change (a new rule is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_cost_sheets_key_ok"(NEW."key", 'overhead:' || COALESCE(NEW."companyId"::text, 'all') || ':' || NEW."basis" || ':' || COALESCE(NEW."workCentreKind"::text, 'all')) THEN
    RAISE EXCEPTION 'costing: overhead rule %''s key is overhead:<company | all>:<basis>:<kind | all>, not %', NEW."id", NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."basis" = 'PERCENT_OF_LABOUR' THEN
    IF NEW."value" <= 0 OR NEW."value" > 1000 OR NEW."currency" IS NOT NULL THEN
      RAISE EXCEPTION 'costing: overhead rule % is a percent of labour above 0 and at most 1000, with no currency', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."value" <= 0 OR NOT "factory_cost_sheets_currency_ok"(NEW."currency") THEN
    RAISE EXCEPTION 'costing: overhead rule % is an amount above 0 per minute, garment or machine hour, with its ISO 4217 currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_cost_sheets_months_ok"(NEW."periodStart", NEW."periodEnd") THEN
    RAISE EXCEPTION 'costing: overhead rule % covers whole months: from the first day of a month to the last day of a month (or open-ended)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'costing: overhead rule % has a note of up to 1000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'ACTIVE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('factory.overhead-rule|' || NEW."tenantId" || '|' || NEW."key", 0));
    IF EXISTS (SELECT 1 FROM "OverheadRule" o
                WHERE o."tenantId" = NEW."tenantId" AND o."key" = NEW."key" AND o."id" <> NEW."id" AND o."status" = 'ACTIVE'
                  AND daterange(o."periodStart", o."periodEnd", '[]') && daterange(NEW."periodStart", NEW."periodEnd", '[]')) THEN
      RAISE EXCEPTION 'costing: overhead rule % overlaps another active rule of the same company, basis and kind of work centre; end that one first', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OverheadRule_guard" AFTER INSERT OR UPDATE ON "OverheadRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_overhead_rule_guard"();
CREATE TRIGGER "OverheadRule_never_deleted" BEFORE DELETE ON "OverheadRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_sheets_never_deleted"();
CREATE TRIGGER "OverheadRule_no_truncate" BEFORE TRUNCATE ON "OverheadRule"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_sheets_refuse_truncate"();

-- =====================================================================================================================
-- CostPerMinuteCalc (FIN-005; Statuto dei Lavoratori art. 4: a department's totals, never one person's)
--   every row  the key `cpm:<company>:<kind>:<work centre | all>`; a work centre (when named, with its site) of the company
--              and of the kind; whole months; ISO 4217; the direct labour cost, indirect labour and overhead per minute 0 or
--              more, the available minutes above 0, and cost per minute = direct ÷ minutes + indirect + overhead rounded
--              once, half up, to 6 places; the minutes' basis an object of at most 64 KiB; the note up to 1000 characters.
--   applied    the labour rate, when and by whom: all three or none, applied now or before; the rate of the calculation's
--              company and kind, with its cost per minute and currency.
--   UPDATE     an UPDATE that changes nothing passes; the company, kind, work centre, key and creation never change; once
--              applied nothing changes.
--   DELETE     only while not applied. TRUNCATE refused. One applied calculation per key and period (a partial unique).
CREATE FUNCTION "factory_cost_per_minute_calc_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  centre_company uuid;
  centre_kind text;
  rate record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."appliedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'costing: cost-per-minute calculation % was applied as a labour rate: it changes no more', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."companyId", NEW."workCentreKind", NEW."siteId", NEW."workCentreId", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."workCentreKind", OLD."siteId", OLD."workCentreId", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'costing: the company, department and work centre of cost-per-minute calculation % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."siteId" IS NULL) <> (NEW."workCentreId" IS NULL) THEN
    RAISE EXCEPTION 'costing: cost-per-minute calculation % names a work centre with its site, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."workCentreId" IS NOT NULL AND (TG_OP = 'INSERT') THEN
    SELECT w."companyId", w."kind"::text INTO centre_company, centre_kind FROM "WorkCentre" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workCentreId";
    IF centre_company IS DISTINCT FROM NEW."companyId" OR centre_kind IS DISTINCT FROM NEW."workCentreKind"::text THEN
      RAISE EXCEPTION 'costing: cost-per-minute calculation % is for a work centre of its company and of its kind', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_cost_sheets_key_ok"(NEW."key", 'cpm:' || NEW."companyId" || ':' || NEW."workCentreKind" || ':' || COALESCE(NEW."workCentreId"::text, 'all')) THEN
    RAISE EXCEPTION 'costing: cost-per-minute calculation %''s key is cpm:<company>:<kind>:<work centre | all>, not %', NEW."id", NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_cost_sheets_months_ok"(NEW."periodStart", NEW."periodEnd") OR NOT "factory_cost_sheets_currency_ok"(NEW."currency") THEN
    RAISE EXCEPTION 'costing: cost-per-minute calculation % covers whole months (the first day of a month to the last day of a month) in an ISO 4217 currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."directLabourCost" < 0 OR NEW."availableMinutes" <= 0 OR NEW."indirectPerMinute" < 0 OR NEW."overheadPerMinute" < 0 THEN
    RAISE EXCEPTION 'costing: cost-per-minute calculation % has costs of 0 or more over minutes above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."costPerMinute" <> round(NEW."directLabourCost" / NEW."availableMinutes" + NEW."indirectPerMinute" + NEW."overheadPerMinute", 6) THEN
    RAISE EXCEPTION 'costing: cost-per-minute calculation % has a cost per minute of direct ÷ minutes + indirect + overhead rounded to 6 places (%)', NEW."id",
      round(NEW."directLabourCost" / NEW."availableMinutes" + NEW."indirectPerMinute" + NEW."overheadPerMinute", 6)
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_cost_sheets_object_ok"(NEW."minutesBasis", 65536) OR NOT "factory_recall_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'costing: cost-per-minute calculation % keeps how its minutes were counted as an object of at most 64 KiB and a note of up to 1000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."labourRateId" IS NULL) <> (NEW."appliedAt" IS NULL) OR (NEW."appliedAt" IS NULL) <> (NEW."appliedById" IS NULL) THEN
    RAISE EXCEPTION 'costing: cost-per-minute calculation % is applied with its labour rate, when and by whom (all three or none)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."labourRateId" IS NOT NULL THEN
    IF NOT "factory_recall_not_future"(NEW."appliedAt") THEN
      RAISE EXCEPTION 'costing: cost-per-minute calculation % is applied now or before, not in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT r."companyId", r."workCentreKind"::text AS kind, r."costPerMinute", r."currency" INTO rate
      FROM "LabourRate" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."labourRateId" FOR SHARE;
    IF rate IS NULL OR rate."companyId" IS DISTINCT FROM NEW."companyId" OR rate.kind <> NEW."workCentreKind"::text
       OR rate."costPerMinute" <> NEW."costPerMinute" OR rate."currency" <> NEW."currency" THEN
      RAISE EXCEPTION 'costing: cost-per-minute calculation % is applied as a labour rate of its company and department, with its cost per minute and currency', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "CostPerMinuteCalc_guard" AFTER INSERT OR UPDATE ON "CostPerMinuteCalc"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_per_minute_calc_guard"();

CREATE FUNCTION "factory_cost_per_minute_calc_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."appliedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'costing: cost-per-minute calculation % was applied as a labour rate and is kept', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "CostPerMinuteCalc_delete_guard" BEFORE DELETE ON "CostPerMinuteCalc"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_per_minute_calc_delete_guard"();
CREATE TRIGGER "CostPerMinuteCalc_no_truncate" BEFORE TRUNCATE ON "CostPerMinuteCalc"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_sheets_refuse_truncate"();

-- One applied calculation per department (or work centre) and period: the one its labour rate came from.
CREATE UNIQUE INDEX "CostPerMinuteCalc_one_applied" ON "CostPerMinuteCalc" ("tenantId", "key", "periodStart") WHERE "appliedAt" IS NOT NULL;

-- =====================================================================================================================
-- MaterialCostUplift (FIN-008, FIN-009)
--   INSERT     a material of the uplift's company or tenant-wide; a workshop with the SUBCONTRACTOR role, of the company or
--              tenant-wide.
--   every row  exactly its target's column (MATERIAL a material, CATEGORY a kind, WORKSHOP a party) and its key
--              (`uplift:<company | all>:item:<material>` | `…:kind:<kind>` | `…:workshop:<party>`); a material or a kind:
--              percents of 0 to 100 (at least one), no transport and no currency, TYPED or LANDED_COST, the receipt days
--              exactly for LANDED_COST (from ≤ to ≤ the first day); a workshop: transport out and back per piece of 0 or more
--              (at least one) with its ISO 4217 currency, no percent, TYPED; the note up to 1000 characters.
--   UPDATE     an UPDATE that changes nothing passes; the company, target, key, first day and creation never change.
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_material_cost_uplift_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_company uuid;
  party_roles text[];
  found boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."target", NEW."itemId", NEW."itemKind", NEW."partyId", NEW."key", NEW."validFrom", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."target", OLD."itemId", OLD."itemKind", OLD."partyId", OLD."key", OLD."validFrom", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'costing: the company, target and first day of cost uplift % never change (a new uplift is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT ((NEW."target" = 'MATERIAL' AND NEW."itemId" IS NOT NULL AND NEW."itemKind" IS NULL AND NEW."partyId" IS NULL)
          OR (NEW."target" = 'CATEGORY' AND NEW."itemId" IS NULL AND NEW."itemKind" IS NOT NULL AND NEW."partyId" IS NULL)
          OR (NEW."target" = 'WORKSHOP' AND NEW."itemId" IS NULL AND NEW."itemKind" IS NULL AND NEW."partyId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'costing: cost uplift % names exactly its target: a material, a kind of material or a workshop', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_cost_sheets_key_ok"(NEW."key", 'uplift:' || COALESCE(NEW."companyId"::text, 'all') || ':'
           || CASE NEW."target" WHEN 'MATERIAL' THEN 'item:' || NEW."itemId" WHEN 'CATEGORY' THEN 'kind:' || NEW."itemKind" ELSE 'workshop:' || NEW."partyId" END) THEN
    RAISE EXCEPTION 'costing: cost uplift %''s key is uplift:<company | all>:item:<material> | kind:<kind> | workshop:<party>, not %', NEW."id", NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."target" IN ('MATERIAL', 'CATEGORY') THEN
    IF COALESCE(NEW."freightPct", NEW."dutyPct", NEW."insurancePct") IS NULL
       OR NEW."freightPct" NOT BETWEEN 0 AND 100 OR NEW."dutyPct" NOT BETWEEN 0 AND 100 OR NEW."insurancePct" NOT BETWEEN 0 AND 100
       OR NEW."transportOutPerPiece" IS NOT NULL OR NEW."transportBackPerPiece" IS NOT NULL OR NEW."currency" IS NOT NULL THEN
      RAISE EXCEPTION 'costing: cost uplift % of a material lands freight, duty and insurance percents of 0 to 100 (at least one), no transport', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."source" = 'LANDED_COST') <> (NEW."landedFrom" IS NOT NULL AND NEW."landedTo" IS NOT NULL)
       OR (NEW."landedFrom" IS NULL) <> (NEW."landedTo" IS NULL)
       OR NEW."landedFrom" > NEW."landedTo" OR NEW."landedTo" > NEW."validFrom" THEN
      RAISE EXCEPTION 'costing: cost uplift % names the receipt days it read exactly when it comes from landed cost (from ≤ to ≤ its first day)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF COALESCE(NEW."transportOutPerPiece", NEW."transportBackPerPiece") IS NULL
       OR NEW."transportOutPerPiece" < 0 OR NEW."transportBackPerPiece" < 0 OR NOT "factory_cost_sheets_currency_ok"(NEW."currency")
       OR NEW."freightPct" IS NOT NULL OR NEW."dutyPct" IS NOT NULL OR NEW."insurancePct" IS NOT NULL
       OR NEW."source" <> 'TYPED' OR NEW."landedFrom" IS NOT NULL OR NEW."landedTo" IS NOT NULL THEN
      RAISE EXCEPTION 'costing: cost uplift % of a workshop is a typed transport out and back per piece of 0 or more (at least one), with its ISO 4217 currency and no percent', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'costing: cost uplift % has a note of up to 1000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."itemId" IS NOT NULL THEN
      SELECT true, i."companyId" INTO found, owner_company FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
      IF found AND owner_company IS NOT NULL AND owner_company IS DISTINCT FROM NEW."companyId" THEN
        RAISE EXCEPTION 'costing: cost uplift % is for a material of its company, or a tenant-wide one', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."partyId" IS NOT NULL THEN
      SELECT true, p."companyId", p."roles"::text[] INTO found, owner_company, party_roles FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
      IF found AND (NOT ('SUBCONTRACTOR' = ANY (party_roles)) OR (owner_company IS NOT NULL AND owner_company IS DISTINCT FROM NEW."companyId")) THEN
        RAISE EXCEPTION 'costing: cost uplift % is for a workshop (a party with the SUBCONTRACTOR role) of its company, or a tenant-wide one', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MaterialCostUplift_guard" AFTER INSERT OR UPDATE ON "MaterialCostUplift"
  FOR EACH ROW EXECUTE FUNCTION "factory_material_cost_uplift_guard"();
CREATE TRIGGER "MaterialCostUplift_never_deleted" BEFORE DELETE ON "MaterialCostUplift"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_sheets_never_deleted"();
CREATE TRIGGER "MaterialCostUplift_no_truncate" BEFORE TRUNCATE ON "MaterialCostUplift"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_sheets_refuse_truncate"();

-- =====================================================================================================================
-- SizeWeight (FIN-016)
--   INSERT     a size of the style's range; a season (when named) of the style's company (any company for a tenant-wide
--              style).
--   every row  the key `sizeweight:<style>:<season | all>:<size>`; the weight above 0.
--   UPDATE     an UPDATE that changes nothing passes; the style, season, key, size and creation never change (only the
--              weight).
--   DELETE     free (the office writes a mix again). TRUNCATE refused.
CREATE FUNCTION "factory_size_weight_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  style_company uuid;
  style_sizes text[];
  season_company uuid;
  found boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."styleId", NEW."seasonId", NEW."key", NEW."size", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."styleId", OLD."seasonId", OLD."key", OLD."size", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'costing: only the weight of size weight % changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT true, s."companyId", s."sizes" INTO found, style_company, style_sizes FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF found AND NOT (NEW."size" = ANY (COALESCE(style_sizes, ARRAY[]::text[]))) THEN
      RAISE EXCEPTION 'costing: size weight % is for size %, which is not in the style''s size range', NEW."id", NEW."size"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."seasonId" IS NOT NULL THEN
      SELECT z."companyId" INTO season_company FROM "Season" z WHERE z."tenantId" = NEW."tenantId" AND z."id" = NEW."seasonId";
      IF style_company IS NOT NULL AND season_company IS DISTINCT FROM style_company THEN
        RAISE EXCEPTION 'costing: size weight % is for a season of the style''s company', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NOT "factory_cost_sheets_key_ok"(NEW."key", 'sizeweight:' || NEW."styleId" || ':' || COALESCE(NEW."seasonId"::text, 'all') || ':' || NEW."size") THEN
    RAISE EXCEPTION 'costing: size weight %''s key is sizeweight:<style>:<season | all>:<size>, not %', NEW."id", NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."weight" <= 0 THEN
    RAISE EXCEPTION 'costing: size weight % is above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SizeWeight_guard" AFTER INSERT OR UPDATE ON "SizeWeight"
  FOR EACH ROW EXECUTE FUNCTION "factory_size_weight_guard"();
CREATE TRIGGER "SizeWeight_no_truncate" BEFORE TRUNCATE ON "SizeWeight"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_sheets_refuse_truncate"();

-- =====================================================================================================================
-- CostingSettings: piece-rate labour on the cost sheet (FIN-006; GATE-PIECE-PAY; beside W1's "CostingSettings_guard")
--   every row  on exactly with when and by whom; off with neither.
--   on         switched on (made on, or off → on) only on a company's own row, and only while a site of that company has
--              piece pay ON (pay.prisma PiecePaySwitch, FOR SHARE: a switch turned off waits); now or before. While on,
--              when and by whom never change. Off is always allowed.
CREATE FUNCTION "factory_costing_settings_piece_rate_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."pieceRateLabour", NEW."pieceRateLabourAt", NEW."pieceRateLabourById") IS NOT DISTINCT FROM (OLD."pieceRateLabour", OLD."pieceRateLabourAt", OLD."pieceRateLabourById") THEN
    RETURN NULL;
  END IF;
  IF NEW."pieceRateLabour" <> (NEW."pieceRateLabourAt" IS NOT NULL AND NEW."pieceRateLabourById" IS NOT NULL)
     OR (NEW."pieceRateLabourAt" IS NULL) <> (NEW."pieceRateLabourById" IS NULL) THEN
    RAISE EXCEPTION 'costing: piece-rate labour of costing settings % is on exactly with when and by whom it was switched on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."pieceRateLabour" THEN
    IF TG_OP = 'UPDATE' AND OLD."pieceRateLabour" THEN
      RAISE EXCEPTION 'costing: piece-rate labour of costing settings % is on: when and by whom it was switched on never change', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."companyId" IS NULL
       OR NOT EXISTS (SELECT 1 FROM "PiecePaySwitch" p WHERE p."tenantId" = NEW."tenantId" AND p."companyId" = NEW."companyId" AND p."state" = 'ON' FOR SHARE) THEN
      RAISE EXCEPTION 'costing: piece-rate labour is switched on only for a company with piece pay ON at one of its sites (GATE-PIECE-PAY)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_recall_not_future"(NEW."pieceRateLabourAt") THEN
      RAISE EXCEPTION 'costing: piece-rate labour of costing settings % is switched on now or before, not in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "CostingSettings_piece_rate_check" AFTER INSERT OR UPDATE OF "pieceRateLabour", "pieceRateLabourAt", "pieceRateLabourById" ON "CostingSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_costing_settings_piece_rate_check"();

-- =====================================================================================================================
-- OptionValue: an option's cost delta (FIN-018; beside B-W2b-211's "OptionValue_check")
--   every row  the material cost delta never 0, exactly with its ISO 4217 currency; the minutes delta never 0, at most 10000
--              either way.
CREATE FUNCTION "factory_option_value_cost_delta_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."materialDelta", NEW."materialDeltaCurrency", NEW."minutesDelta") IS NOT DISTINCT FROM (OLD."materialDelta", OLD."materialDeltaCurrency", OLD."minutesDelta") THEN
    RETURN NULL;
  END IF;
  IF NEW."materialDelta" = 0 OR (NEW."materialDelta" IS NULL) <> (NEW."materialDeltaCurrency" IS NULL)
     OR (NEW."materialDeltaCurrency" IS NOT NULL AND NOT "factory_cost_sheets_currency_ok"(NEW."materialDeltaCurrency")) THEN
    RAISE EXCEPTION 'product: option value % adds or takes off a material cost that is never 0, with its ISO 4217 currency (both or neither)', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."minutesDelta" = 0 OR NEW."minutesDelta" NOT BETWEEN -10000 AND 10000 THEN
    RAISE EXCEPTION 'product: option value % adds or takes off minutes that are never 0, at most 10000 either way', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OptionValue_cost_delta_check" AFTER INSERT OR UPDATE OF "materialDelta", "materialDeltaCurrency", "minutesDelta" ON "OptionValue"
  FOR EACH ROW EXECUTE FUNCTION "factory_option_value_cost_delta_check"();
