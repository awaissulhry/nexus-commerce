-- Written by hand (Prisma does not model triggers), after the generated 202610283500_email_in_received and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Email in (plan A1 §2.3 EmailInbound, §3.7; features COL-020, COL-022, COL-023, COL-025, COL-026). apps/factory-api's
-- platform/email-in checks all of this first; these rules hold for every login, the owner included.
--
-- InboundEmail
--   every row  the address and reference lists are never null and attempts are not negative; each place has what it
--              needs, and nothing it does not: FETCHED, MATCHED, TRIAGE and HELD were read (fetchedAt); exactly MATCHED
--              names its message and how it matched, and its message is an INBOUND email message of its thread with
--              the mail's own Message-ID; exactly HELD has a held reason; exactly REJECTED a reject reason.
--   UPDATE     what SES said never changes (account, company, receipt, SES's id, the raw mail's place, when, the
--              envelope, the verdicts, the creation); what the mail held (From, To, Cc, subject, Message-ID,
--              In-Reply-To, References, size, text, HTML, when it was read) is written while it is read (from RECEIVED)
--              and never after; its attachments only while it is read or sorted (from RECEIVED or FETCHED); attempts
--              never go down; the status moves only along the machine:
--                RECEIVED → FETCHED | REJECTED | FAILED;   FETCHED → MATCHED | TRIAGE | HELD | REJECTED;
--                TRIAGE → MATCHED | REJECTED;   HELD → MATCHED | TRIAGE | REJECTED;   FAILED → REJECTED;
--              MATCHED and REJECTED are final: such a row changes no more. tenantId is held by the policies (USING and
--              WITH CHECK on the tenant).
--   DELETE     refused: a received mail keeps its row (what arrived, from whom, and where it went).
--   TRUNCATE   refused.
CREATE FUNCTION "factory_inbound_email_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'email-in: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email-in: received mail % is never deleted; it records what arrived and where it went', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."envelopeTo" IS NULL OR NEW."to" IS NULL OR NEW."cc" IS NULL OR NEW."referenceIds" IS NULL THEN
    RAISE EXCEPTION 'email-in: mail % lists its recipients and references (empty lists, not null)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attempts" < 0 THEN
    RAISE EXCEPTION 'email-in: mail % cannot have negative attempts', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('FETCHED', 'MATCHED', 'TRIAGE', 'HELD') AND NEW."fetchedAt" IS NULL THEN
    RAISE EXCEPTION 'email-in: mail % is % but was never read', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'MATCHED') <> (NEW."messageId" IS NOT NULL AND NEW."threadId" IS NOT NULL AND NEW."matchedBy" IS NOT NULL)
     OR (NEW."status" <> 'MATCHED' AND (NEW."messageId" IS NOT NULL OR NEW."matchedBy" IS NOT NULL)) THEN
    RAISE EXCEPTION 'email-in: mail % names its thread, message and match exactly when it is MATCHED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'HELD') <> (NEW."heldReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'email-in: mail % has a held reason exactly when it is HELD', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'REJECTED') <> (NEW."rejectReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'email-in: mail % has a reject reason exactly when it is REJECTED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."messageId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Message" m
     WHERE m."id" = NEW."messageId" AND m."tenantId" = NEW."tenantId" AND m."threadId" = NEW."threadId"
       AND m."direction" = 'INBOUND' AND m."channel" = 'EMAIL' AND m."emailMessageId" IS NOT DISTINCT FROM NEW."emailMessageId"
  ) THEN
    RAISE EXCEPTION 'email-in: mail % must name an INBOUND email message of its thread with its own Message-ID', NEW."id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('MATCHED', 'REJECTED')
     AND (to_jsonb(NEW) - 'version' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'version' - 'updatedAt') THEN
    RAISE EXCEPTION 'email-in: mail % is %; it changes no more', OLD."id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."accountId", NEW."receiptId", NEW."sesMessageId", NEW."s3Bucket", NEW."s3Key",
      NEW."receivedAt", NEW."envelopeFrom", NEW."envelopeTo", NEW."spfVerdict", NEW."dkimVerdict", NEW."dmarcVerdict",
      NEW."dmarcPolicy", NEW."spamVerdict", NEW."virusVerdict", NEW."createdAt", NEW."createdById")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."accountId", OLD."receiptId", OLD."sesMessageId", OLD."s3Bucket", OLD."s3Key",
      OLD."receivedAt", OLD."envelopeFrom", OLD."envelopeTo", OLD."spfVerdict", OLD."dkimVerdict", OLD."dmarcVerdict",
      OLD."dmarcPolicy", OLD."spamVerdict", OLD."virusVerdict", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'email-in: what SES said about mail % never changes', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'RECEIVED'
     AND (NEW."fromAddress", NEW."fromName", NEW."to", NEW."cc", NEW."subject", NEW."emailMessageId", NEW."inReplyTo",
          NEW."referenceIds", NEW."sizeBytes", NEW."bodyText", NEW."bodyHtml", NEW."fetchedAt")
         IS DISTINCT FROM
         (OLD."fromAddress", OLD."fromName", OLD."to", OLD."cc", OLD."subject", OLD."emailMessageId", OLD."inReplyTo",
          OLD."referenceIds", OLD."sizeBytes", OLD."bodyText", OLD."bodyHtml", OLD."fetchedAt") THEN
    RAISE EXCEPTION 'email-in: what mail % held was written when it was read; it never changes', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" NOT IN ('RECEIVED', 'FETCHED') AND NEW."attachments" IS DISTINCT FROM OLD."attachments" THEN
    RAISE EXCEPTION 'email-in: the attachments of mail % were kept when it was read and sorted; they never change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'email-in: the attempts of mail % cannot go down', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'RECEIVED' AND NEW."status" IN ('FETCHED', 'REJECTED', 'FAILED'))
    OR (OLD."status" = 'FETCHED' AND NEW."status" IN ('MATCHED', 'TRIAGE', 'HELD', 'REJECTED'))
    OR (OLD."status" = 'TRIAGE' AND NEW."status" IN ('MATCHED', 'REJECTED'))
    OR (OLD."status" = 'HELD' AND NEW."status" IN ('MATCHED', 'TRIAGE', 'REJECTED'))
    OR (OLD."status" = 'FAILED' AND NEW."status" = 'REJECTED')
  ) THEN
    RAISE EXCEPTION 'email-in: mail % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InboundEmail_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InboundEmail"
  FOR EACH ROW EXECUTE FUNCTION "factory_inbound_email_guard"();
CREATE TRIGGER "InboundEmail_no_truncate" BEFORE TRUNCATE ON "InboundEmail"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_inbound_email_guard"();
