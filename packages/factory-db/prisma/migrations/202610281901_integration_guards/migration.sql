-- Written by hand (Prisma does not model triggers), after the generated 202610281900_integration_accounts and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The call ledger is append-only (plan A1 §2.1 "Append-only", §4; feature PLT-195): no login may change or remove a
-- row, the owner included. It reuses factory_refuse_audit_change() of the …_audit_append_only migration.
-- scripts/factory/check-append-only.mjs requires both triggers on every table marked @append-only.
CREATE TRIGGER "IntegrationCall_append_only" BEFORE UPDATE OR DELETE ON "IntegrationCall"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_audit_change"();
CREATE TRIGGER "IntegrationCall_no_truncate" BEFORE TRUNCATE ON "IntegrationCall"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_audit_change"();

-- The webhook ledger (feature PLT-194) keeps every receipt exactly as the inbound route stored it; only the processing
-- state moves, and only forward. For every login, the owner included:
--   INSERT    a verified receipt is RECEIVED with its dedupe key and its body; a rejected one (verified false) is
--             REJECTED with neither (a forged request never takes a real event's key, and its body is not kept);
--             nothing is born processed, attempted or failed.
--   UPDATE    refused when any column but status, attempts, processedAt or lastError changes; when a PROCESSED or
--             REJECTED receipt changes its state; when a receipt becomes REJECTED; when attempts goes down; when a
--             receipt becomes PROCESSED without processedAt. tenantId is held by the policies (USING and WITH CHECK on
--             the tenant): a runtime role cannot move a row. A FAILED receipt may go back to RECEIVED (a person
--             re-queues it after fixing the cause).
--   DELETE    refused: a receipt is never deleted.
--   TRUNCATE  refused.
CREATE FUNCTION "factory_guard_inbound_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'inbound: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inbound: receipt % is never deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."attempts" <> 0 OR NEW."processedAt" IS NOT NULL OR NEW."lastError" IS NOT NULL THEN
      RAISE EXCEPTION 'inbound: a new receipt has no processing attempt yet'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."verified" AND (NEW."status" <> 'RECEIVED' OR NEW."dedupeKey" IS NULL OR NEW."body" IS NULL OR NEW."rejectReason" IS NOT NULL) THEN
      RAISE EXCEPTION 'inbound: a verified receipt is RECEIVED, with its dedupe key and its body'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT NEW."verified" AND (NEW."status" <> 'REJECTED' OR NEW."dedupeKey" IS NOT NULL OR NEW."body" IS NOT NULL) THEN
      RAISE EXCEPTION 'inbound: a receipt that failed its signature is REJECTED, with no dedupe key and no body'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."companyId", NEW."accountId", NEW."provider", NEW."verified", NEW."dedupeKey", NEW."externalId",
      NEW."eventType", NEW."bodySha256", NEW."bodyBytes", NEW."contentType", NEW."body", NEW."rejectReason",
      NEW."receivedAt", NEW."requestId")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."accountId", OLD."provider", OLD."verified", OLD."dedupeKey", OLD."externalId",
      OLD."eventType", OLD."bodySha256", OLD."bodyBytes", OLD."contentType", OLD."body", OLD."rejectReason",
      OLD."receivedAt", OLD."requestId") THEN
    RAISE EXCEPTION 'inbound: receipt % is fixed once received; only its processing state may change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('PROCESSED', 'REJECTED')
     AND (NEW."status", NEW."attempts", NEW."processedAt", NEW."lastError") IS DISTINCT FROM
         (OLD."status", OLD."attempts", OLD."processedAt", OLD."lastError") THEN
    RAISE EXCEPTION 'inbound: receipt % is %; its state is final', OLD."id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'REJECTED' AND OLD."status" <> 'REJECTED' THEN
    RAISE EXCEPTION 'inbound: receipt % was verified; it cannot become REJECTED', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'inbound: the attempts of receipt % cannot go down', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'PROCESSED' AND NEW."processedAt" IS NULL THEN
    RAISE EXCEPTION 'inbound: receipt % cannot be processed without processedAt', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InboundWebhook_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InboundWebhook"
  FOR EACH ROW EXECUTE FUNCTION "factory_guard_inbound_change"();
CREATE TRIGGER "InboundWebhook_no_truncate" BEFORE TRUNCATE ON "InboundWebhook"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_guard_inbound_change"();
