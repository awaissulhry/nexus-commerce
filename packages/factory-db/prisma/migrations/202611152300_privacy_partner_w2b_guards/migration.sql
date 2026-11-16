-- Written by hand (Prisma does not model triggers or functions), after …_config_document_kinds_w2b_policies and before the
-- policy migration that follows it. No schema folder of its own. When the migrations are renumbered, keep this file as
-- it is under its new timestamp.

-- B-W2b-GF1 — personal data and partner access are safe before real data (the watch-first rows of the gaps register and the
-- Owner's decisions of 15 Nov 2026 on B-W2b-F54's leftovers). Every function below is REDEFINED word for word but for the
-- lines marked B-W2b-GF1; no trigger is dropped, recreated or disabled; one helper is new.
--
--   G275  StaffNoticeAck: the office staff notice is acknowledged by an OFFICE person only (a partner person accepts the
--         portal terms). Privacy's `factory_staff_notice_ack_check` (…_privacy_guards).
--   G274  StoredFile.deleteAfter: a person's data package (a file of a DataRequest) takes a delete date too, as the
--         made-to-measure photos do; the privacy module's hourly purge deletes it then. Wave 6's
--         `factory_stored_file_w2b6_check` (…_followups_sales_w2b5_guards); found on the way: a file WITHOUT a category
--         passed its "only a made-to-measure photo" check (NULL), so any such file could take a delete date — closed.
--   F54   InboundEmail: an erasure blanks the envelope sender too (no column of the person's stays); and the retention sweep
--         may anonymise a settled mail (MATCHED, REJECTED or FAILED) past its rule's period, the same six columns to NULL and
--         nothing else, only inside the APPLY sweep of an active, switched-on InboundEmail ANONYMISE rule written in the same
--         transaction, of the mail's company (or of every company that has no rule of its own). Email-in's
--         `factory_inbound_email_guard` and the door `factory_privacy_erase_row` (…_privacy_erasure_w2b_guards); new helper
--         `factory_privacy_ops_mail_swept_ok`.

-- =====================================================================================================================
-- G275: StaffNoticeAck (…_privacy_guards, whole) + an office person only.
CREATE OR REPLACE FUNCTION "factory_staff_notice_ack_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  notice record;
  user_status text;
  user_audience text;
BEGIN
  IF btrim(NEW."noticeVersion") = '' OR NEW."locale" !~ '^[a-z]{2}$' OR NEW."noticeSha256" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'privacy: staff acknowledgement % names the version, the language (ISO 639-1) and the SHA-256 of the text as shown', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT n."kind"::text AS kind, n."status"::text AS status, n."companyId" INTO notice FROM "PrivacyNotice" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."noticeId";
  IF FOUND THEN
    IF notice.kind <> 'OFFICE_STAFF' OR notice.status <> 'PUBLISHED' OR notice."companyId" <> NEW."companyId" THEN
      RAISE EXCEPTION 'privacy: staff acknowledgement % names its company''s staff notice in force; notice % is a % % one', NEW."id", NEW."noticeId", notice.status, notice.kind
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "PrivacyNoticeText" t WHERE t."tenantId" = NEW."tenantId" AND t."noticeId" = NEW."noticeId" AND t."locale" = NEW."locale" AND t."sha256" = NEW."noticeSha256") THEN
      RAISE EXCEPTION 'privacy: staff acknowledgement % stores the fingerprint of notice % in language %', NEW."id", NEW."noticeId", NEW."locale"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT u."status"::text, u."audience"::text INTO user_status, user_audience FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
  -- B-W2b-GF1 (G275): the office staff notice is acknowledged by office people only; a partner person accepts the portal's
  -- terms (PartnerNoticeAck, PORTAL_TERMS), never the notice of the staff.
  IF FOUND AND user_audience <> 'OFFICE' THEN
    RAISE EXCEPTION 'privacy: person % signs in to a partner portal (%): the office staff notice is acknowledged by office people only; a partner accepts the portal terms', NEW."userId", user_audience
      USING ERRCODE = 'check_violation';
  END IF;
  IF FOUND AND user_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'privacy: person % is %; only an ACTIVE person acknowledges the notice', NEW."userId", user_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- G274: StoredFile (wave 6's check, whole) + a DataRequest's package takes a delete date.
CREATE OR REPLACE FUNCTION "factory_stored_file_w2b6_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- B-W2b-GF1: coalesce — a file without a category made `photo` NULL, so `NOT photo` let ANY uncategorised file take a delete date.
  photo boolean := coalesce(NEW."category" IN ('MTM_PHOTO', 'FITTING_PHOTO'), false);
  -- B-W2b-GF1 (G274): a person's data package (a file of their DataRequest) is deleted on its own date too.
  package boolean := NEW."recordType" = 'DataRequest';
BEGIN
  IF photo THEN
    IF NEW."kind" <> 'PHOTO'
       OR (NEW."category" = 'MTM_PHOTO' AND NEW."recordType" <> 'MeasurementProfile')
       OR (NEW."category" = 'FITTING_PHOTO' AND NEW."recordType" <> 'FittingResult') THEN
      RAISE EXCEPTION 'files: file % is a % of a %; a made-to-measure photo is a PHOTO of a MeasurementProfile (MTM_PHOTO) or of a FittingResult (FITTING_PHOTO)', NEW."id", NEW."category", NEW."recordType"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."visibility" <> ARRAY['OFFICE']::"FileAudience"[] THEN
      RAISE EXCEPTION 'files: file % is a rider''s photo (%): the office''s only, never shared with a floor, a portal or a link', NEW."id", NEW."category"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."deleteAfter" IS NOT NULL THEN
    IF NOT photo AND NOT package THEN
      RAISE EXCEPTION 'files: file % takes no delete date: only a made-to-measure photo (MTM_PHOTO, FITTING_PHOTO) or a person''s data package (a file of a DataRequest) has one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."retainUntil" IS NOT NULL AND NEW."deleteAfter" < NEW."retainUntil" THEN
      RAISE EXCEPTION 'files: file % is deleted from % on, never before it is retained until %', NEW."id", NEW."deleteAfter", NEW."retainUntil"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."deleteAfter" IS NOT NULL AND NEW."deleteAfter" IS DISTINCT FROM OLD."deleteAfter"
     AND (NEW."deleteAfter" IS NULL OR OLD."status" = 'DELETED') THEN
    RAISE EXCEPTION 'files: the delete date of file % moves but is never cleared, and a deleted file''s stays as it is', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."documentTypeCode" IS NOT NULL THEN
    IF NEW."category" IS NULL OR NEW."category" NOT IN ('SUPPLIER_CERTIFICATE', 'TEST_REPORT', 'DECLARATION') THEN
      RAISE EXCEPTION 'files: file % names a document type (%) only as a supplier certificate, a test report or a declaration', NEW."id", NEW."documentTypeCode"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."documentTypeCode" !~ '^[A-Z][A-Z0-9_]{0,59}$' THEN
      RAISE EXCEPTION 'files: the document type of file % is a code (upper-case letters, digits and underscores, at most 60), not %', NEW."id", NEW."documentTypeCode"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (TG_OP = 'INSERT' OR NEW."documentTypeCode" IS DISTINCT FROM OLD."documentTypeCode")
       AND NOT EXISTS (SELECT 1 FROM "ReasonCode" r
                        WHERE r."tenantId" = NEW."tenantId" AND r."list" = 'SUPPLIER_DOCUMENT_TYPE' AND r."code" = NEW."documentTypeCode" AND r."active") THEN
      RAISE EXCEPTION 'files: % is not an active document type of the tenant (the SUPPLIER_DOCUMENT_TYPE reasons)', NEW."documentTypeCode"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- F54: whether an UPDATE of a received mail is the retention sweep's anonymisation. Every column but the six as it was; each
-- of the six as it was or NULL; at least one made NULL; the mail settled (MATCHED, REJECTED or FAILED: nothing waits on it);
-- and a RetentionSweep written by this transaction (its xmin still in progress), RUNNING, APPLY, ANONYMISE, of an active,
-- switched-on InboundEmail ANONYMISE rule of the mail's company (or of every company, when the mail's company has no active
-- rule of its own), received before the sweep's cut-off day (its first instant, Europe/Rome). The sweep's row and its counts
-- are the record of what it did (no ErasureRecord per mail: a mail of a tenant-wide account has no company to name).
CREATE FUNCTION "factory_privacy_ops_mail_swept_ok"(old_row jsonb, new_row jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  erasable CONSTANT text[] := ARRAY['fromAddress', 'fromName', 'subject', 'bodyText', 'bodyHtml', 'envelopeFrom'];
  column_name text;
  blanked boolean := false;
BEGIN
  IF (old_row - erasable) IS DISTINCT FROM (new_row - erasable) THEN
    RETURN false;
  END IF;
  FOREACH column_name IN ARRAY erasable LOOP
    IF (new_row -> column_name) IS DISTINCT FROM (old_row -> column_name) THEN
      IF jsonb_typeof(new_row -> column_name) IS DISTINCT FROM 'null' THEN
        RETURN false;
      END IF;
      blanked := true;
    END IF;
  END LOOP;
  IF NOT blanked OR (old_row ->> 'status') NOT IN ('MATCHED', 'REJECTED', 'FAILED') THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM "RetentionSweep" s JOIN "RetentionRule" r ON r."tenantId" = s."tenantId" AND r."id" = s."ruleId"
     WHERE s."tenantId" = (old_row ->> 'tenantId')::uuid AND s."status" = 'RUNNING' AND s."mode" = 'APPLY' AND s."thenAction" = 'ANONYMISE'
       AND r."recordType" = 'InboundEmail' AND r."thenAction" = 'ANONYMISE' AND r."active" AND r."applyOn"
       AND "factory_privacy_ops_written_now"(s.xmin)
       AND (old_row ->> 'receivedAt')::timestamptz < (s."cutoffOn"::timestamp AT TIME ZONE 'Europe/Rome')
       AND (r."companyId" = (old_row ->> 'companyId')::uuid
            OR (r."companyId" IS NULL AND NOT EXISTS (
                  SELECT 1 FROM "RetentionRule" o
                   WHERE o."tenantId" = r."tenantId" AND o."recordType" = 'InboundEmail' AND o."active"
                     AND o."companyId" = (old_row ->> 'companyId')::uuid))));
END
$$;

-- =====================================================================================================================
-- F54: InboundEmail (…_privacy_erasure_w2b_guards, whole) + the envelope sender in the erasure, and the sweep's branch.
CREATE OR REPLACE FUNCTION "factory_inbound_email_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'email-in: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email-in: received mail % is never deleted; it records what arrived and where it went', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- B-W2b-F54: an erasure (GDPR art. 17) blanks what the mail held of the person; nothing else of the row moves.
  -- B-W2b-GF1 (F54, the Owner's decision of 15 Nov 2026): the envelope sender goes blank with them.
  IF TG_OP = 'UPDATE'
     AND (NEW."fromAddress", NEW."fromName", NEW."subject", NEW."bodyText", NEW."bodyHtml", NEW."envelopeFrom")
         IS DISTINCT FROM (OLD."fromAddress", OLD."fromName", OLD."subject", OLD."bodyText", OLD."bodyHtml", OLD."envelopeFrom")
     AND "factory_privacy_ops_erasure_ok"('InboundEmail', to_jsonb(OLD), to_jsonb(NEW),
           '{"fromAddress": null, "fromName": null, "subject": null, "bodyText": null, "bodyHtml": null, "envelopeFrom": null}'::jsonb, '{}'::text[], '{}'::text[]) THEN
    RETURN NEW;
  END IF;
  -- B-W2b-GF1 (F54): the retention sweep anonymises a settled mail past its rule's period (factory_privacy_ops_mail_swept_ok).
  IF TG_OP = 'UPDATE'
     AND (NEW."fromAddress", NEW."fromName", NEW."subject", NEW."bodyText", NEW."bodyHtml", NEW."envelopeFrom")
         IS DISTINCT FROM (OLD."fromAddress", OLD."fromName", OLD."subject", OLD."bodyText", OLD."bodyHtml", OLD."envelopeFrom")
     AND "factory_privacy_ops_mail_swept_ok"(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
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

  -- W2b-6 (wave 47/57): the team-inbox columns of a MATCHED mail still move (a REJECTED mail keeps them too).
  IF OLD."status" IN ('MATCHED', 'REJECTED')
     AND (to_jsonb(NEW) - ARRAY['version', 'updatedAt'] - CASE WHEN OLD."status" = 'MATCHED' THEN ARRAY['teamInboxId', 'assigneeId', 'assignedAt', 'closedAt', 'closedById', 'snoozedUntil', 'followUpUntil'] ELSE ARRAY[]::text[] END)
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['version', 'updatedAt'] - CASE WHEN OLD."status" = 'MATCHED' THEN ARRAY['teamInboxId', 'assigneeId', 'assignedAt', 'closedAt', 'closedById', 'snoozedUntil', 'followUpUntil'] ELSE ARRAY[]::text[] END) THEN
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


-- =====================================================================================================================
-- F54: the door (…_privacy_erasure_w2b_guards, whole) + a received mail's envelope sender.
CREATE OR REPLACE FUNCTION "factory_privacy_erase_row"(erasure_id uuid, addresses text[], json_keys text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  erasure record;
  request_kind text;
  request_status text;
  fields text[];
  wanted text[] := ARRAY(SELECT lower(btrim(a)) FROM unnest(coalesce(addresses, '{}'::text[])) a WHERE btrim(a) <> '');
  keys text[] := coalesce(json_keys, '{}'::text[]);
  author text;
  mail_status text;
  changed integer;
BEGIN
  SELECT x."tenantId", x."recordType", x."recordId", x."method"::text AS method, x."erasedFields", x."dataRequestId", x.xmin AS written
    INTO erasure FROM public."ErasureRecord" x WHERE x."id" = erasure_id;
  IF NOT FOUND OR erasure."tenantId" IS DISTINCT FROM NULLIF(current_setting('factory.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'privacy: erasure % is not an erasure record of this tenant', erasure_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public."factory_privacy_ops_written_now"(erasure.written) THEN
    RAISE EXCEPTION 'privacy: erasure % was not written in this transaction: a row is blanked only together with its erasure record', erasure_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF erasure.method <> 'ANONYMISED' OR erasure."dataRequestId" IS NULL THEN
    RAISE EXCEPTION 'privacy: erasure % blanks a row only when it anonymises it for an erasure request (it is %)', erasure_id, erasure.method
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT d."kind"::text, d."status"::text INTO request_kind, request_status
    FROM public."DataRequest" d WHERE d."tenantId" = erasure."tenantId" AND d."id" = erasure."dataRequestId";
  IF request_kind IS DISTINCT FROM 'ERASURE' OR request_status IS DISTINCT FROM 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'privacy: erasure % is done for an erasure request in progress (request % is a % request, %)', erasure_id, erasure."dataRequestId", request_kind, request_status
      USING ERRCODE = 'check_violation';
  END IF;
  fields := erasure."erasedFields";

  IF erasure."recordType" = 'InboundEmail' THEN
    IF NOT fields <@ ARRAY['fromAddress', 'fromName', 'subject', 'bodyText', 'bodyHtml', 'envelopeFrom'] THEN
      RAISE EXCEPTION 'privacy: a received mail blanks only its sender, sender name, subject, text, HTML and envelope sender (erasure % names %)', erasure_id, fields
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1 FROM public."InboundEmail" m WHERE m."tenantId" = erasure."tenantId" AND m."id" = erasure."recordId" FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'privacy: received mail % of erasure % is not there', erasure."recordId", erasure_id
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public."InboundEmail" m
       SET "fromAddress" = CASE WHEN 'fromAddress' = ANY(fields) THEN NULL ELSE m."fromAddress" END,
           "fromName" = CASE WHEN 'fromName' = ANY(fields) THEN NULL ELSE m."fromName" END,
           "subject" = CASE WHEN 'subject' = ANY(fields) THEN NULL ELSE m."subject" END,
           "bodyText" = CASE WHEN 'bodyText' = ANY(fields) THEN NULL ELSE m."bodyText" END,
           "bodyHtml" = CASE WHEN 'bodyHtml' = ANY(fields) THEN NULL ELSE m."bodyHtml" END,
           "envelopeFrom" = CASE WHEN 'envelopeFrom' = ANY(fields) THEN NULL ELSE m."envelopeFrom" END
     WHERE m."tenantId" = erasure."tenantId" AND m."id" = erasure."recordId"
       AND ((m."fromAddress" IS NOT NULL AND 'fromAddress' = ANY(fields)) OR (m."fromName" IS NOT NULL AND 'fromName' = ANY(fields))
         OR (m."subject" IS NOT NULL AND 'subject' = ANY(fields)) OR (m."bodyText" IS NOT NULL AND 'bodyText' = ANY(fields))
         OR (m."bodyHtml" IS NOT NULL AND 'bodyHtml' = ANY(fields)) OR (m."envelopeFrom" IS NOT NULL AND 'envelopeFrom' = ANY(fields)));

  ELSIF erasure."recordType" = 'Message' THEN
    IF NOT fields <@ ARRAY['authorName', 'bodyText', 'bodyHtml'] THEN
      RAISE EXCEPTION 'privacy: a message blanks only its author''s name, its text and its HTML (erasure % names %)', erasure_id, fields
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT m."authorKind"::text INTO author FROM public."Message" m WHERE m."tenantId" = erasure."tenantId" AND m."id" = erasure."recordId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'privacy: message % of erasure % is not there', erasure."recordId", erasure_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF author NOT IN ('PARTY', 'USER', 'WORKER') THEN
      RAISE EXCEPTION 'privacy: message % was written by the system, not by a person: nothing of it is erased', erasure."recordId"
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public."Message" m
       SET "authorName" = CASE WHEN 'authorName' = ANY(fields) THEN NULL ELSE m."authorName" END,
           "bodyText" = CASE WHEN 'bodyText' = ANY(fields) THEN '' ELSE m."bodyText" END,
           "bodyHtml" = CASE WHEN 'bodyHtml' = ANY(fields) THEN NULL ELSE m."bodyHtml" END
     WHERE m."tenantId" = erasure."tenantId" AND m."id" = erasure."recordId"
       AND ((m."authorName" IS NOT NULL AND 'authorName' = ANY(fields)) OR (m."bodyText" <> '' AND 'bodyText' = ANY(fields))
         OR (m."bodyHtml" IS NOT NULL AND 'bodyHtml' = ANY(fields)));

  ELSIF erasure."recordType" = 'EmailOutbound' THEN
    IF NOT fields <@ ARRAY['to', 'cc', 'subject'] THEN
      RAISE EXCEPTION 'privacy: a sent mail blanks only the person''s addresses among its recipients and its subject (erasure % names %)', erasure_id, fields
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT m."status"::text INTO mail_status FROM public."EmailOutbound" m WHERE m."tenantId" = erasure."tenantId" AND m."id" = erasure."recordId" FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'privacy: mail % of erasure % is not there', erasure."recordId", erasure_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF mail_status IN ('QUEUED', 'SENDING') THEN
      RAISE EXCEPTION 'privacy: mail % is still on its way (%): what is being sent never changes', erasure."recordId", mail_status
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public."EmailOutbound" m
       SET "to" = CASE WHEN 'to' = ANY(fields) THEN ARRAY(SELECT CASE WHEN lower(btrim(t.address)) = ANY(wanted) THEN '' ELSE t.address END FROM unnest(m."to") WITH ORDINALITY t(address, n) ORDER BY t.n) ELSE m."to" END,
           "cc" = CASE WHEN 'cc' = ANY(fields) THEN ARRAY(SELECT CASE WHEN lower(btrim(t.address)) = ANY(wanted) THEN '' ELSE t.address END FROM unnest(m."cc") WITH ORDINALITY t(address, n) ORDER BY t.n) ELSE m."cc" END,
           "subject" = CASE WHEN 'subject' = ANY(fields) THEN '' ELSE m."subject" END
     WHERE m."tenantId" = erasure."tenantId" AND m."id" = erasure."recordId"
       AND ((m."subject" <> '' AND 'subject' = ANY(fields))
         OR ('to' = ANY(fields) AND EXISTS (SELECT 1 FROM unnest(m."to") a WHERE lower(btrim(a)) = ANY(wanted)))
         OR ('cc' = ANY(fields) AND EXISTS (SELECT 1 FROM unnest(m."cc") a WHERE lower(btrim(a)) = ANY(wanted))));

  ELSIF erasure."recordType" = 'AuditLog' THEN
    IF NOT fields <@ ARRAY['before', 'after'] THEN
      RAISE EXCEPTION 'privacy: an audit row blanks only values inside its before and after (erasure % names %)', erasure_id, fields
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1 FROM public."AuditLog" m WHERE m."tenantId" = erasure."tenantId" AND m."id" = erasure."recordId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'privacy: audit row % of erasure % is not there', erasure."recordId", erasure_id
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public."AuditLog" m
       SET "before" = CASE WHEN 'before' = ANY(fields) THEN public."factory_privacy_ops_json_redact"(m."before", keys) ELSE m."before" END,
           "after" = CASE WHEN 'after' = ANY(fields) THEN public."factory_privacy_ops_json_redact"(m."after", keys) ELSE m."after" END
     WHERE m."tenantId" = erasure."tenantId" AND m."id" = erasure."recordId"
       AND (('before' = ANY(fields) AND m."before" IS DISTINCT FROM public."factory_privacy_ops_json_redact"(m."before", keys))
         OR ('after' = ANY(fields) AND m."after" IS DISTINCT FROM public."factory_privacy_ops_json_redact"(m."after", keys)));

  ELSE
    RAISE EXCEPTION 'privacy: erasure % names a %: only received and sent mail, messages and audit rows are blanked through this door', erasure_id, erasure."recordType"
      USING ERRCODE = 'check_violation';
  END IF;

  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END
$$;

REVOKE ALL ON FUNCTION "factory_privacy_erase_row"(uuid, text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "factory_privacy_erase_row"(uuid, text[], text[]) TO "factory_runtime";
