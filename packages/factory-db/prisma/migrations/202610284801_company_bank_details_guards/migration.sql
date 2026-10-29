-- Written by hand (Prisma does not model triggers), after the generated 202610284800_company_bank_details and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Company's bank account (Q12: deposits are paid by bank transfer; FatturaPA DatiPagamento MP05). apps/factory-api's
-- modules/sales/deposits checks all of this first (factory-domain sales/deposits/bank: the IBAN's country and length and
-- its ISO 7064 mod 97-10 check digits); these rules hold for every login, the owner included. Every refusal is a
-- check_violation (SQLSTATE 23514).
--   every row  no bank account (all four columns null), or the holder and the IBAN set; the IBAN upper case without
--              spaces, a country, two check digits and 11 to 30 letters or digits; the BIC, when set, 8 or 11 upper-case
--              letters and digits (bank, country, location, branch).
CREATE FUNCTION "factory_company_bank_details_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."iban" IS NULL THEN
    IF NEW."bankAccountHolder" IS NOT NULL OR NEW."bic" IS NOT NULL OR NEW."bankName" IS NOT NULL THEN
      RAISE EXCEPTION 'company: % has bank details without an IBAN', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."iban" !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' THEN
    RAISE EXCEPTION 'company: the IBAN of % is not an IBAN (country, check digits, account; upper case, no spaces)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."bankAccountHolder" IS NULL OR btrim(NEW."bankAccountHolder") = '' THEN
    RAISE EXCEPTION 'company: the bank account of % names its holder', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."bic" IS NOT NULL AND NEW."bic" !~ '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$' THEN
    RAISE EXCEPTION 'company: the BIC of % is not a BIC (8 or 11 letters and digits)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Company_bank_details_guard" BEFORE INSERT OR UPDATE OF "bankAccountHolder", "iban", "bic", "bankName" ON "Company"
  FOR EACH ROW EXECUTE FUNCTION "factory_company_bank_details_guard"();
