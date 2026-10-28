-- Written by hand (Prisma does not model triggers), after the generated 202610281500_numbering_series and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Number series (PLAN §2.8, DPR 633/1972 art. 21 c.2: never the same number twice). The app checks all of this first
-- (apps/factory-api src/platform/numbering); these rules hold for every login, the owner included:
--   - the start is at least 1 and the next number never below it;
--   - once the counter left its start (a number was issued, or an admin moved it past one), it never moves back, and
--     the series' company, kind, code, period, reset, pattern, fiscal flag and start are fixed. A fixed pattern keeps
--     the printed number one-to-one with the value, so NumberAllocation's unique printed number per series is a unique
--     value. The tenant column is left to row-level security and the foreign keys.
CREATE FUNCTION "factory_number_series_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."startValue" < 1 OR NEW."nextValue" < NEW."startValue" THEN
    RAISE EXCEPTION 'number series %: the start (%) is at least 1 and the next number (%) is not below it', NEW."id", NEW."startValue", NEW."nextValue"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."nextValue" > OLD."startValue" THEN
    IF NEW."nextValue" < OLD."nextValue" THEN
      RAISE EXCEPTION 'number series %: the counter never moves back (% to %)', OLD."id", OLD."nextValue", NEW."nextValue"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW."companyId", NEW."kind", NEW."code", NEW."scopeKey", NEW."reset", NEW."pattern", NEW."fiscal", NEW."startValue")
       IS DISTINCT FROM (OLD."companyId", OLD."kind", OLD."code", OLD."scopeKey", OLD."reset", OLD."pattern", OLD."fiscal", OLD."startValue") THEN
      RAISE EXCEPTION 'number series %: its company, kind, code, period, reset, pattern, fiscal flag and start are fixed once a number is issued', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "NumberSeries_guard" BEFORE INSERT OR UPDATE ON "NumberSeries"
  FOR EACH ROW EXECUTE FUNCTION "factory_number_series_guard"();

-- Append-only (plan A1 §2.1, feature PLT-073): an issued number is never changed or removed; a voided document keeps
-- its number. The function is the audit module's (…_audit_append_only), which raises for any row change or truncate.
-- scripts/factory/check-append-only.mjs requires both triggers on every table marked @append-only.
CREATE TRIGGER "NumberAllocation_append_only" BEFORE UPDATE OR DELETE ON "NumberAllocation"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_audit_change"();
CREATE TRIGGER "NumberAllocation_no_truncate" BEFORE TRUNCATE ON "NumberAllocation"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_audit_change"();
