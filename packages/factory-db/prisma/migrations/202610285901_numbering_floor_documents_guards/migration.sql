-- Written by hand (Prisma does not model triggers), after the generated 202610285900_numbering_floor_documents and
-- before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Floor-safe document numbers (B-W1-33 floor receiving; B-W1-45 inspection and release numbers; design
-- 02-sections-floor "Receive creates the lot with our number", 02-sections-quality-compliance INS-2026-0412 /
-- REL-2026-0088). A floor tablet numbers goods receipts, lots, final inspections and quality releases from its own
-- command, online, through the same gapless series the office numbers from (apps/factory-api allocateNumber: the
-- series row's lock, the counter and the NumberAllocation row in the command's transaction).
--
-- The walls, in layers:
--   1. The floor's policies (generated from ownership/numbering.json, `onlyValues`) let factory_floor_runtime see, lock,
--      change and add ONLY the NumberSeries and NumberAllocation rows of the floor's document kinds (GOODS_RECEIPT,
--      LOT, INSPECTION, RELEASE), of its own tenant. A fiscal series (invoice, deposit invoice, credit note, DDT) or any
--      other kind is invisible to it: it can never read, lock or move one.
--   2. These triggers, behind the policies (AFTER the row is written, so a row the policies refuse is refused by them
--      first, in their words), hold for a floor session:
--        - never a fiscal series or number (the fiscal flag or a fiscal kind), even if the policies were ever widened;
--        - only for the company of the session's own site (factory.site_id);
--        - a counter moves one number at a time, and only past a number recorded in the ledger (NumberAllocation):
--          nothing else of a series changes, so a tablet never skips, repeats or rewrites a number;
--        - a new series row is only the first row of a new year of a yearly series the office set up (the rollover
--          allocateNumber makes on the year's first number): active, from 1, nothing issued, same pattern;
--        - a number it records is of its series' kind and company, and never ahead of the series' counter.
--   3. Inspection.number and QualityRelease.number (every login): a new row has its number; once given, it never
--      changes (QualityRelease is append-only anyway). A row from before the series existed keeps NULL until a number
--      is given once.
-- The tenant column is left to row-level security and the foreign keys.

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The numbers of inspections and releases: given when the row is made, never changed.
CREATE FUNCTION "factory_document_number_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  what text := TG_ARGV[0];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."number" IS NULL OR btrim(NEW."number") = '' THEN
      RAISE EXCEPTION '% %: a new % has its number, from its company''s % series', what, NEW."id", what, TG_ARGV[1]
        USING ERRCODE = 'not_null_violation';
    END IF;
  ELSIF OLD."number" IS NOT NULL AND NEW."number" IS DISTINCT FROM OLD."number" THEN
    RAISE EXCEPTION '% %: its number % never changes', what, OLD."id", OLD."number"
      USING ERRCODE = 'restrict_violation';
  ELSIF NEW."number" IS NOT NULL AND btrim(NEW."number") = '' THEN
    RAISE EXCEPTION '% %: a number is never blank', what, OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Inspection_number" BEFORE INSERT OR UPDATE ON "Inspection"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('inspection', 'INSPECTION');
CREATE TRIGGER "QualityRelease_number" BEFORE INSERT OR UPDATE ON "QualityRelease"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('release', 'RELEASE');

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. A floor session's series.
CREATE FUNCTION "factory_number_series_floor_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  site_company uuid;
BEGIN
  IF current_user <> 'factory_floor_runtime' THEN
    RETURN NULL;
  END IF;
  IF NEW."fiscal" OR NEW."kind"::text IN ('DDT', 'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE')
     OR NEW."kind"::text NOT IN ('GOODS_RECEIPT', 'LOT', 'INSPECTION', 'RELEASE') THEN
    RAISE EXCEPTION 'number series %: a tablet numbers goods receipts, lots, inspections and releases only, never from a fiscal series; a % series is the office''s', NEW."id", (CASE WHEN NEW."fiscal" THEN 'fiscal ' ELSE '' END) || NEW."kind"::text
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."companyId" INTO site_company FROM "Site" s WHERE s."id" = NULLIF(current_setting('factory.site_id', true), '')::uuid;
  IF site_company IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'number series %: a tablet numbers the documents of its own site''s company only', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."tenantId", NEW."companyId", NEW."kind", NEW."code", NEW."scopeKey", NEW."reset", NEW."pattern", NEW."fiscal",
        NEW."startValue", NEW."status", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."tenantId", OLD."companyId", OLD."kind", OLD."code", OLD."scopeKey", OLD."reset", OLD."pattern", OLD."fiscal",
        OLD."startValue", OLD."status", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'number series %: a tablet moves only its counter (the next number and the last date); the series is the office''s', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."nextValue" <> OLD."nextValue" AND NEW."nextValue" <> OLD."nextValue" + 1 THEN
      RAISE EXCEPTION 'number series %: a tablet moves the counter one number at a time (% to %)', OLD."id", OLD."nextValue", NEW."nextValue"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."nextValue" = OLD."nextValue" + 1 AND NOT EXISTS (
      SELECT 1 FROM "NumberAllocation" a WHERE a."tenantId" = OLD."tenantId" AND a."seriesId" = OLD."id" AND a."value" = OLD."nextValue"
    ) THEN
      RAISE EXCEPTION 'number series %: a tablet moves the counter only past a number it recorded (number % has no NumberAllocation)', OLD."id", OLD."nextValue"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  -- INSERT: the first row of a new year of a yearly series (allocateNumber's rollover on the year's first number).
  IF NEW."reset" <> 'YEARLY' OR NEW."status" <> 'ACTIVE' OR NEW."startValue" <> 1 OR NEW."nextValue" <> 1 OR NEW."lastIssuedDate" IS NOT NULL THEN
    RAISE EXCEPTION 'number series %: a tablet adds only a new year of a yearly series: active, counting from 1, nothing issued yet', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "NumberSeries" s
    WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId" AND s."kind" = NEW."kind" AND s."pattern" = NEW."pattern"
      AND s."reset" = 'YEARLY' AND s."id" <> NEW."id" AND s."scopeKey" < NEW."scopeKey"
  ) THEN
    RAISE EXCEPTION 'number series %: a tablet adds a new year only to a series the office set up (an earlier year of % %)', NEW."id", NEW."kind", NEW."pattern"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "NumberSeries_floor_documents" AFTER INSERT OR UPDATE ON "NumberSeries"
  FOR EACH ROW EXECUTE FUNCTION "factory_number_series_floor_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. A floor session's numbers.
CREATE FUNCTION "factory_number_allocation_floor_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  series record;
  site_company uuid;
BEGIN
  IF current_user <> 'factory_floor_runtime' THEN
    RETURN NULL;
  END IF;
  IF NEW."kind"::text NOT IN ('GOODS_RECEIPT', 'LOT', 'INSPECTION', 'RELEASE') THEN
    RAISE EXCEPTION 'number % (%): a tablet numbers goods receipts, lots, inspections and releases only', NEW."formatted", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."companyId", s."kind"::text AS "kind", s."fiscal", s."nextValue" INTO series
    FROM "NumberSeries" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."seriesId";
  IF NOT FOUND OR series."fiscal" THEN
    RAISE EXCEPTION 'number % (%): series % is not one a tablet numbers from (a goods receipt, lot, inspection or release series)', NEW."formatted", NEW."kind", NEW."seriesId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF series."kind" <> NEW."kind"::text OR series."companyId" <> NEW."companyId" THEN
    RAISE EXCEPTION 'number % (%): a number is of its series'' kind and company', NEW."formatted", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."companyId" INTO site_company FROM "Site" s WHERE s."id" = NULLIF(current_setting('factory.site_id', true), '')::uuid;
  IF site_company IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'number % (%): a tablet numbers the documents of its own site''s company only', NEW."formatted", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."value" > series."nextValue" THEN
    RAISE EXCEPTION 'number % (%): a tablet takes its series'' next number (%), never one ahead of it (%)', NEW."formatted", NEW."kind", series."nextValue", NEW."value"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "NumberAllocation_floor_documents" AFTER INSERT ON "NumberAllocation"
  FOR EACH ROW EXECUTE FUNCTION "factory_number_allocation_floor_guard"();
