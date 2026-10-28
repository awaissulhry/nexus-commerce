-- Written by hand (Prisma does not model triggers), after the generated 202610283200_parties_master_data and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- ViesCheck: append-only (plan A1 §2.1; scripts/factory/check-append-only.mjs). A VIES check is the proof that a VAT
-- number was valid when a sale was zero-rated (art. 41 DL 331/1993; feature SAL-006), so no login may change or remove
-- one, the owner and superusers included. The runtime roles have no UPDATE, DELETE or TRUNCATE grant either (the policy
-- migration). A new check is a new row.
CREATE FUNCTION "factory_refuse_vies_check_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a VIES check is kept as it was made, a new check is a new row', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER "ViesCheck_append_only" BEFORE UPDATE OR DELETE ON "ViesCheck"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_vies_check_change"();
CREATE TRIGGER "ViesCheck_no_truncate" BEFORE TRUNCATE ON "ViesCheck"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_vies_check_change"();
