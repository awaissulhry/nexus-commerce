-- Written by hand (Prisma does not model triggers), after the generated 202610282900_email_outbound and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Email out (plan A1 §2.3 EmailOutbound, §3.7; features PLT-139, PLT-149). apps/factory-api's platform/email-out checks
-- all of this first; these rules hold for every login, the owner included.
--
-- EmailOutbound
--   INSERT     at least one recipient, and no list is null; a record mail names its thread AND the thread's OUTBOUND
--              EMAIL message that holds its text, with the same Message-ID (a sign-in mail names neither); attempts are
--              not negative.
--   UPDATE     what was sent never changes (identity, company, thread and message, record, template, language, From,
--              recipients, subject, Message-ID, In-Reply-To and References, when it was queued and by whom); SES's
--              message id is set once; attempts never go down; the status moves only forward:
--                QUEUED → SENDING | FAILED;   SENDING → QUEUED | SENT | FAILED;   SENT → DELIVERED | BOUNCED | COMPLAINED;
--                DELIVERED → BOUNCED | COMPLAINED;   BOUNCED → COMPLAINED;   COMPLAINED and FAILED are final.
--              tenantId is held by the policies (USING and WITH CHECK on the tenant).
--   DELETE     refused: a mail keeps its row (what went to whom, and how it ended).
--   TRUNCATE   refused.
CREATE FUNCTION "factory_email_outbound_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'email: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email: mail % is never deleted; it records what went to whom', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."to" IS NULL OR NEW."cc" IS NULL OR NEW."bcc" IS NULL OR NEW."referenceIds" IS NULL THEN
      RAISE EXCEPTION 'email: mail % lists its recipients and references (empty lists, not null)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF cardinality(NEW."to") = 0 THEN
      RAISE EXCEPTION 'email: mail % has no recipient', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."attempts" < 0 THEN
      RAISE EXCEPTION 'email: mail % cannot have negative attempts', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."threadId" IS NULL) <> (NEW."messageId" IS NULL) THEN
      RAISE EXCEPTION 'email: mail % names its thread and its message, or neither', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."messageId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "Message" m
       WHERE m."id" = NEW."messageId" AND m."tenantId" = NEW."tenantId" AND m."threadId" = NEW."threadId"
         AND m."direction" = 'OUTBOUND' AND m."channel" = 'EMAIL' AND m."emailMessageId" = NEW."emailMessageId"
    ) THEN
      RAISE EXCEPTION 'email: mail % must name its thread''s OUTBOUND email message with the same Message-ID', NEW."id"
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."companyId", NEW."identityId", NEW."threadId", NEW."messageId", NEW."recordType", NEW."recordId",
      NEW."templateKey", NEW."locale", NEW."fromAddress", NEW."fromName", NEW."to", NEW."cc", NEW."bcc", NEW."subject",
      NEW."emailMessageId", NEW."inReplyTo", NEW."referenceIds", NEW."queuedAt", NEW."createdAt", NEW."createdById")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."identityId", OLD."threadId", OLD."messageId", OLD."recordType", OLD."recordId",
      OLD."templateKey", OLD."locale", OLD."fromAddress", OLD."fromName", OLD."to", OLD."cc", OLD."bcc", OLD."subject",
      OLD."emailMessageId", OLD."inReplyTo", OLD."referenceIds", OLD."queuedAt", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'email: what mail % sends never changes; only its delivery state moves', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."sesMessageId" IS NOT NULL AND NEW."sesMessageId" IS DISTINCT FROM OLD."sesMessageId" THEN
    RAISE EXCEPTION 'email: the SES message id of mail % is set once', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'email: the attempts of mail % cannot go down', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'QUEUED' AND NEW."status" IN ('SENDING', 'FAILED'))
    OR (OLD."status" = 'SENDING' AND NEW."status" IN ('QUEUED', 'SENT', 'FAILED'))
    OR (OLD."status" = 'SENT' AND NEW."status" IN ('DELIVERED', 'BOUNCED', 'COMPLAINED'))
    OR (OLD."status" = 'DELIVERED' AND NEW."status" IN ('BOUNCED', 'COMPLAINED'))
    OR (OLD."status" = 'BOUNCED' AND NEW."status" = 'COMPLAINED')
  ) THEN
    RAISE EXCEPTION 'email: mail % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "EmailOutbound_guard" BEFORE INSERT OR UPDATE OR DELETE ON "EmailOutbound"
  FOR EACH ROW EXECUTE FUNCTION "factory_email_outbound_guard"();
CREATE TRIGGER "EmailOutbound_no_truncate" BEFORE TRUNCATE ON "EmailOutbound"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_email_outbound_guard"();

-- EmailIdentity and Suppression: never deleted (an identity is DISABLED; a suppression is a record of why mail stopped).
-- The runtime roles have no DELETE grant either (the policy migration); this holds for the owner too.
CREATE FUNCTION "factory_email_refuse_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'email: % on "%" is refused; rows of this table are never deleted', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER "EmailIdentity_no_delete" BEFORE DELETE ON "EmailIdentity"
  FOR EACH ROW EXECUTE FUNCTION "factory_email_refuse_delete"();
CREATE TRIGGER "EmailIdentity_no_truncate" BEFORE TRUNCATE ON "EmailIdentity"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_email_refuse_delete"();
CREATE TRIGGER "Suppression_no_delete" BEFORE DELETE ON "Suppression"
  FOR EACH ROW EXECUTE FUNCTION "factory_email_refuse_delete"();
CREATE TRIGGER "Suppression_no_truncate" BEFORE TRUNCATE ON "Suppression"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_email_refuse_delete"();
