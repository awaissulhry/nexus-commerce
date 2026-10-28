-- Written by hand (Prisma does not model triggers), after the generated 202610281300_audit_log and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Append-only (plan A1 §2.1, feature PLT-073): no login may change or remove an audit row or a receipt, the owner and
-- superusers included. The runtime roles have no UPDATE, DELETE or TRUNCATE grant either (the policy migration); these
-- triggers hold for everyone else. A mistake is fixed with a new row.
-- scripts/factory/check-append-only.mjs requires both triggers on every table marked @append-only.
CREATE FUNCTION "factory_refuse_audit_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; record a correction as a new row', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- A receipt is kept until its expiresAt; after it, and only then, a purge (the owner, a later job) may delete it.
CREATE FUNCTION "factory_refuse_receipt_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."expiresAt" <= now() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append-only: % on "%" is refused before the receipt expires', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_audit_change"();
CREATE TRIGGER "AuditLog_no_truncate" BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_audit_change"();

CREATE TRIGGER "IdempotencyReceipt_append_only" BEFORE UPDATE OR DELETE ON "IdempotencyReceipt"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_receipt_change"();
CREATE TRIGGER "IdempotencyReceipt_no_truncate" BEFORE TRUNCATE ON "IdempotencyReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_audit_change"();
