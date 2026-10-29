-- Written by hand (Prisma does not model triggers), after the generated 202610284600_sales_settings and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- SalesSettings (SAL-184, FIN-023: the quote rules of a company or of the tenant). apps/factory-api's
-- modules/sales/quotes checks all of this first; these rules hold for every login, the owner included. The tenant of a
-- row is held by the policies (USING and WITH CHECK on the tenant) and by the reference, not here. Every refusal is a
-- check_violation (SQLSTATE 23514). No runtime role has a DELETE grant on this table (the policy migration); the
-- triggers refuse a DELETE and a TRUNCATE for every login too.
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change.
--   every row  the margin floor and the discount limit are 0 to 100 percent; the default validity 1 to 365 days; the
--              default deposit, when set, above 0 and at most 100 percent.
--   DELETE     refused (the settings are changed, never removed). TRUNCATE refused.
-- At most one row per company and one tenant-wide row: the row's id is the company's id (the tenant's for the
-- tenant-wide row), as CostingSettings; modules/sales writes it so.
CREATE FUNCTION "factory_sales_settings_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_sales_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END
$$;

CREATE TRIGGER "SalesSettings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SalesSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_settings_guard"();
CREATE TRIGGER "SalesSettings_no_truncate" BEFORE TRUNCATE ON "SalesSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_settings_refuse_truncate"();
