-- Written by hand (Prisma does not model triggers), after the generated 202610284500_money_sdi_archive and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The legal archive of a send (conservazione at the SDI intermediary; DM 17.6.2014, c.c. art. 2220; FIN-092; B-W1-50):
-- SdiSubmission."archivedAt" and "archiveRef". They replace the send's guard of 202610284101_money_guards (the same rules,
-- word for word, and these):
--   INSERT     a send starts without an archive;
--   UPDATE     the archive is set once, both columns together (a time and a non-blank reference), only on a DELIVERED or
--              NOT_DELIVERABLE send (the file SDI handed to the buyer's side; a rejected file counts as never issued),
--              and never changed or cleared after. On a send with an outcome, that is the only change allowed (with its
--              version and update time);
--   every row  the two archive columns are both set or both empty.
-- Every refusal is a check_violation (SQLSTATE 23514), for every login, the owner included.

CREATE OR REPLACE FUNCTION "factory_sdi_submission_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  invoice_xml uuid;
  invoice_company uuid;
  account_provider text;
  account_company uuid;
  archive CONSTANT text[] := ARRAY['archivedAt', 'archiveRef', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sdi: send % of invoice % is kept, never deleted', OLD."id", OLD."invoiceId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('SENDING', 'SENT', 'FAILED') THEN
      RAISE EXCEPTION 'sdi: send % starts SENDING, SENT or FAILED, not % (SDI''s outcome comes later)', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."archivedAt" IS NOT NULL OR NEW."archiveRef" IS NOT NULL THEN
      RAISE EXCEPTION 'sdi: send % starts without a legal archive (it is archived once SDI delivered it)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."status"::text, i."xmlFileId", i."companyId" INTO state, invoice_xml, invoice_company
      FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";
    IF FOUND THEN
      IF state = 'DRAFT' THEN
        RAISE EXCEPTION 'sdi: invoice % is a DRAFT; only an issued invoice is sent', NEW."invoiceId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF invoice_xml IS DISTINCT FROM NEW."xmlFileId" THEN
        RAISE EXCEPTION 'sdi: send % of invoice % sends file %, not the invoice''s XML %', NEW."id", NEW."invoiceId", NEW."xmlFileId", invoice_xml
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT a."provider"::text, a."companyId" INTO account_provider, account_company
        FROM "IntegrationAccount" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."integrationAccountId";
      IF FOUND AND (account_provider <> 'SDI' OR account_company IS DISTINCT FROM invoice_company) THEN
        RAISE EXCEPTION 'sdi: send % goes through an SDI account of the invoice''s company, not a % account', NEW."id", account_provider
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."partyId", NEW."invoiceId", NEW."attempt", NEW."integrationAccountId", NEW."fileName", NEW."xmlFileId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."partyId", OLD."invoiceId", OLD."attempt", OLD."integrationAccountId", OLD."fileName", OLD."xmlFileId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sdi: the invoice, attempt, account, file name and XML of send % never change (a resend is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."providerRef" IS NOT NULL AND NEW."providerRef" IS DISTINCT FROM OLD."providerRef")
       OR (OLD."sdiIdentifier" IS NOT NULL AND NEW."sdiIdentifier" IS DISTINCT FROM OLD."sdiIdentifier") THEN
      RAISE EXCEPTION 'sdi: the provider''s id and SDI''s id of send % are named once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."archivedAt" IS NOT NULL OR OLD."archiveRef" IS NOT NULL)
       AND (NEW."archivedAt", NEW."archiveRef") IS DISTINCT FROM (OLD."archivedAt", OLD."archiveRef") THEN
      RAISE EXCEPTION 'sdi: the legal archive of send % is recorded once and never changed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."archivedAt" IS NOT NULL AND (NEW."status" NOT IN ('DELIVERED', 'NOT_DELIVERABLE') OR NEW."status" IS DISTINCT FROM OLD."status") THEN
      RAISE EXCEPTION 'sdi: send % is %; only a DELIVERED or NOT_DELIVERABLE send is archived (a rejected file counts as never issued)', OLD."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('DELIVERED', 'NOT_DELIVERABLE', 'REJECTED') AND (to_jsonb(NEW) - (ARRAY['tenantId'] || archive)) IS DISTINCT FROM (to_jsonb(OLD) - (ARRAY['tenantId'] || archive)) THEN
      RAISE EXCEPTION 'sdi: send % is %; it never changes (a resend is a new row)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('DELIVERED', 'NOT_DELIVERABLE', 'REJECTED') AND OLD."archivedAt" IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['tenantId']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['tenantId']) THEN
      RAISE EXCEPTION 'sdi: send % is % and archived; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'SENDING' AND NEW."status" IN ('SENT', 'FAILED'))
      OR (OLD."status" = 'SENT' AND NEW."status" IN ('FAILED', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED'))
      OR (OLD."status" = 'FAILED' AND NEW."status" IN ('DELIVERED', 'NOT_DELIVERABLE', 'REJECTED'))) THEN
      RAISE EXCEPTION 'sdi: send % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."attempt" < 1 OR btrim(NEW."fileName") = '' THEN
    RAISE EXCEPTION 'sdi: send % has an attempt from 1 and a file name', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'SENT' AND NEW."sentAt" IS NULL)
     OR (NEW."status" = 'FAILED' AND btrim(coalesce(NEW."failureReason", '')) = '')
     OR ((NEW."status" IN ('DELIVERED', 'NOT_DELIVERABLE', 'REJECTED')) <> (NEW."outcomeAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'sdi: send % is % with the wrong times or reason (SENT: its send time; FAILED: why; an outcome: its time)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."archivedAt" IS NULL) <> (NEW."archiveRef" IS NULL) OR btrim(coalesce(NEW."archiveRef", 'x')) = '' THEN
    RAISE EXCEPTION 'sdi: send % names its legal archive with both its time and its reference', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
