-- Written by hand (Prisma does not model triggers or partial unique indexes), after the generated
-- 202610284300_costing_rates and before the policy migration. When the migrations are renumbered, keep this file as it
-- is under its new timestamp.

-- Costing (plan §2.4 B-W1-16; features FIN-004, FIN-005, PRD-125). apps/factory-api's modules/costing checks all of this
-- first; these rules hold for every login, the owner included. The tenant of a row is held by the policies (USING and
-- WITH CHECK on the tenant) and by the references, not here. Every refusal is a check_violation (SQLSTATE 23514): a
-- restrict_violation reaches a Prisma model call as P2003 without its message. No runtime role has a DELETE grant on
-- these tables (the policy migration); the triggers refuse a DELETE and a TRUNCATE for every login too.

CREATE FUNCTION "factory_costing_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'costing: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- LabourRate (FIN-004, FIN-005)
--   unique     one tenant-wide rate per kind of work centre and day (a company's: the generated unique key, whose NULL
--              company would not count).
--   UPDATE     an UPDATE that changes nothing passes; the company, the kind of work centre and the creation never change.
--   every row  the cost per minute is 0 or more; the planned efficiency is above 0 and at most 200 %; the currency is an
--              ISO 4217 code (three capital letters).
--   DELETE     refused (a rate is archived, never deleted). TRUNCATE refused.
CREATE UNIQUE INDEX "LabourRate_one_tenant_rate_per_kind_and_day" ON "LabourRate" ("tenantId", "workCentreKind", "validFrom") WHERE "companyId" IS NULL;

CREATE FUNCTION "factory_labour_rate_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'costing: the labour rate % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."workCentreKind", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."workCentreKind", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'costing: the company, kind of work centre and creation of the labour rate % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."costPerMinute" < 0 THEN
    RAISE EXCEPTION 'costing: the cost per minute of the labour rate % is 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."plannedEfficiencyPct" <= 0 OR NEW."plannedEfficiencyPct" > 200 THEN
    RAISE EXCEPTION 'costing: the planned efficiency of the labour rate % is above 0 and at most 200 percent', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'costing: the currency of the labour rate % is an ISO 4217 code', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LabourRate_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LabourRate"
  FOR EACH ROW EXECUTE FUNCTION "factory_labour_rate_guard"();
CREATE TRIGGER "LabourRate_no_truncate" BEFORE TRUNCATE ON "LabourRate"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_costing_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- CostingSettings (FIN-001: the overhead rule)
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change.
--   every row  the overhead is 0 to 100 percent.
--   DELETE     refused (the settings are changed, never removed). TRUNCATE refused.
-- At most one row per company and one tenant-wide row: the row's id is the company's id (the tenant's for the
-- tenant-wide row), as ShippingSettings is keyed by its site; modules/costing writes it so.
CREATE FUNCTION "factory_costing_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'costing: the costing settings % are changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'costing: the company and creation of the costing settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."overheadPct" < 0 OR NEW."overheadPct" > 100 THEN
    RAISE EXCEPTION 'costing: the overhead of the costing settings % is 0 to 100 percent', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CostingSettings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CostingSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_costing_settings_guard"();
CREATE TRIGGER "CostingSettings_no_truncate" BEFORE TRUNCATE ON "CostingSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_costing_refuse_truncate"();
