-- Written by hand (Prisma does not model triggers or functions), after …_insights_depth_w2b_policies and before the
-- policy migration that follows it. No schema folder of its own. When the migrations are renumbered, keep this file as
-- it is under its new timestamp.

-- B-W2b-F54 — an erasure blanks the person's mail, messages and audit details through a guarded path (GDPR art. 17; PLT-203;
-- PV1:01 of B-W2b-405, its schema need 1). Until now the database kept a received mail, a message, an outbound mail and an
-- audit row unchanged for every login, so an erasure could only KEEP them (IMMUTABLE). From here exactly these columns may
-- go blank, and nothing else of these rows ever changes:
--
--   InboundEmail   fromAddress, fromName, subject, bodyText, bodyHtml                    → NULL
--   Message        authorName → NULL, bodyText → '' (the column is required), bodyHtml → NULL; only a message a person
--                  wrote (author PARTY, USER or WORKER), never the system's
--   EmailOutbound  to, cc: an address of the list → '' (the list keeps its length and every other address); subject → '';
--                  only once the mail is no longer on its way (not QUEUED, not SENDING: what is being sent never changes)
--   AuditLog       before, after: a value inside → JSON null (the column keeps its shape: every key and every list length
--                  stays; a nested part may go null whole); an audit row is never removed (the append-only ledgers are never purged: the Owner's
--                  answer of 15 Nov 2026)
--
-- and only when the SAME transaction wrote an ErasureRecord of an ERASURE request (the record's own check: of the request's
-- company, IN_PROGRESS, by an office person) that names the row ANONYMISED with every column blanked (`erasedFields`), and
-- only to the blank value: never another value, never another column, never a delete. Every other UPDATE, DELETE and TRUNCATE
-- stays refused for every login, the owner included. "The same transaction": the record's row was written by a transaction
-- still in progress, so by this one (a row of another open transaction is never visible), a savepoint of it included.
--
-- The door (`factory_privacy_erase_row`): the runtime roles have no UPDATE grant on the append-only Message and AuditLog
-- (scripts/factory/check-append-only.mjs; the policy migration), so an erasure blanks a row through this one function, which
-- the office role (factory_runtime) may execute and nobody else. It runs as its owner (the migration login) with a fixed
-- search path, takes the erasure record's id (a record of the caller's tenant, written in this transaction, ANONYMISED, of
-- an ERASURE request in progress) and blanks exactly the columns the record names, computing the blank values itself: the
-- caller only says which addresses (EmailOutbound) or which JSON keys (AuditLog) are the person's. Its UPDATE meets the same
-- triggers as any other. A row the function cannot see (not there) is refused, never skipped.
--
-- Hash chains: none of these tables carries a hash chain, signature or digest of its rows (AuditLog has none; the access
-- package's SHA256SUMS.txt covers the package's own files, written once), so blanking breaks no verification.
--
-- REDEFINED, word for word but for the erasure: email-in's `factory_inbound_email_guard` (its latest body, …_notify_depth_w2b_
-- guards), email's `factory_email_outbound_guard` (…_email_guards), threads' `factory_refuse_message_change` (…_threads_guards)
-- and audit's `factory_refuse_audit_change` (…_audit_append_only; it also guards other ledgers: the erasure branch is AuditLog's
-- only). No trigger is dropped, recreated or disabled. Reused: the privacy wave's ErasureRecord check, as it is.

-- =====================================================================================================================
-- The helpers

-- A row written by this transaction (or a savepoint of it): its xmin is still in progress. The xid is widened to the 64-bit
-- form with the current epoch (a visible row is never newer than this transaction); a frozen or forgotten one is not.
CREATE FUNCTION "factory_privacy_ops_written_now"(row_xmin xid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  current_full bigint := pg_current_xact_id()::text::bigint;
  row_full bigint;
BEGIN
  IF row_xmin IS NULL THEN
    RETURN false;
  END IF;
  row_full := ((current_full >> 32) << 32) | row_xmin::text::bigint;
  IF row_full > current_full THEN
    row_full := row_full - 4294967296;
  END IF;
  IF row_full < 3 THEN
    RETURN false;
  END IF;
  RETURN coalesce(pg_xact_status(row_full::text::xid8) = 'in progress', false);
END
$$;

-- An address list blanked address by address: the same length, each address as it was or ''.
CREATE FUNCTION "factory_privacy_ops_list_blanked"(old_list jsonb, new_list jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(old_list) = 'array' AND jsonb_typeof(new_list) = 'array' AND jsonb_array_length(old_list) = jsonb_array_length(new_list)
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(old_list) WITH ORDINALITY o(old_value, n)
         JOIN jsonb_array_elements(new_list) WITH ORDINALITY w(new_value, n) USING (n)
        WHERE w.new_value IS DISTINCT FROM o.old_value AND w.new_value IS DISTINCT FROM '""'::jsonb)
$$;

-- A JSON value blanked value by value: as it was, or JSON null, or an object with the same keys (a list of the same length)
-- each blanked in turn.
CREATE FUNCTION "factory_privacy_ops_json_blanked"(old_value jsonb, new_value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  field text;
  item integer;
BEGIN
  IF new_value IS NOT DISTINCT FROM old_value OR jsonb_typeof(new_value) = 'null' THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(old_value) = 'object' AND jsonb_typeof(new_value) = 'object' THEN
    IF ARRAY(SELECT jsonb_object_keys(old_value) ORDER BY 1) IS DISTINCT FROM ARRAY(SELECT jsonb_object_keys(new_value) ORDER BY 1) THEN
      RETURN false;
    END IF;
    FOR field IN SELECT jsonb_object_keys(old_value) LOOP
      IF NOT "factory_privacy_ops_json_blanked"(old_value -> field, new_value -> field) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  IF jsonb_typeof(old_value) = 'array' AND jsonb_typeof(new_value) = 'array' THEN
    IF jsonb_array_length(old_value) <> jsonb_array_length(new_value) THEN
      RETURN false;
    END IF;
    FOR item IN 0 .. jsonb_array_length(old_value) - 1 LOOP
      IF NOT "factory_privacy_ops_json_blanked"(old_value -> item, new_value -> item) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  RETURN false;
END
$$;

-- A JSON value with the values of these keys (at any depth) made JSON null: what the door writes into an audit row.
CREATE FUNCTION "factory_privacy_ops_json_redact"(value jsonb, keys text[]) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(value) = 'object' THEN
    RETURN (SELECT coalesce(jsonb_object_agg(e.key, CASE WHEN e.key = ANY(keys) THEN 'null'::jsonb ELSE "factory_privacy_ops_json_redact"(e.value, keys) END), '{}'::jsonb)
              FROM jsonb_each(value) e);
  END IF;
  IF jsonb_typeof(value) = 'array' THEN
    RETURN (SELECT coalesce(jsonb_agg("factory_privacy_ops_json_redact"(e.value, keys) ORDER BY e.n), '[]'::jsonb)
              FROM jsonb_array_elements(value) WITH ORDINALITY e(value, n));
  END IF;
  RETURN value;
END
$$;

-- Whether an UPDATE of a mail, a message or an audit row is an erasure: every column but the erasable ones as it was; each
-- erasable one as it was or blanked (`blanks`: the column's blank value; `list_columns`: address by address; `json_columns`:
-- value by value, the column keeping its shape); at least one blanked; and an ErasureRecord written in this transaction, of an ERASURE request, names the row
-- ANONYMISED with every column blanked. The rows are compared as JSON (to_jsonb): a list is a JSON array, a JSON column a value.
CREATE FUNCTION "factory_privacy_ops_erasure_ok"(record_type text, old_row jsonb, new_row jsonb, blanks jsonb, list_columns text[], json_columns text[])
RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  erasable text[] := ARRAY(SELECT jsonb_object_keys(blanks)) || list_columns || json_columns;
  column_name text;
  blanked text[] := '{}';
BEGIN
  IF (old_row - erasable) IS DISTINCT FROM (new_row - erasable) THEN
    RETURN false;
  END IF;
  FOR column_name IN SELECT jsonb_object_keys(blanks) LOOP
    IF (new_row -> column_name) IS DISTINCT FROM (old_row -> column_name) THEN
      IF (new_row -> column_name) IS DISTINCT FROM (blanks -> column_name) THEN
        RETURN false;
      END IF;
      blanked := blanked || column_name;
    END IF;
  END LOOP;
  FOREACH column_name IN ARRAY list_columns LOOP
    IF (new_row -> column_name) IS DISTINCT FROM (old_row -> column_name) THEN
      IF NOT "factory_privacy_ops_list_blanked"(old_row -> column_name, new_row -> column_name) THEN
        RETURN false;
      END IF;
      blanked := blanked || column_name;
    END IF;
  END LOOP;
  FOREACH column_name IN ARRAY json_columns LOOP
    IF (new_row -> column_name) IS DISTINCT FROM (old_row -> column_name) THEN
      -- The column itself keeps its shape (an object stays an object with its keys); only values inside it go null.
      IF jsonb_typeof(new_row -> column_name) IS DISTINCT FROM jsonb_typeof(old_row -> column_name)
         OR NOT "factory_privacy_ops_json_blanked"(old_row -> column_name, new_row -> column_name) THEN
        RETURN false;
      END IF;
      blanked := blanked || column_name;
    END IF;
  END LOOP;
  IF cardinality(blanked) = 0 THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM "ErasureRecord" x JOIN "DataRequest" d ON d."tenantId" = x."tenantId" AND d."id" = x."dataRequestId"
     WHERE x."tenantId" = (old_row ->> 'tenantId')::uuid AND x."recordType" = record_type AND x."recordId" = (old_row ->> 'id')::uuid
       AND x."method" = 'ANONYMISED' AND x."erasedFields" @> blanked AND d."kind" = 'ERASURE'
       AND "factory_privacy_ops_written_now"(x.xmin));
END
$$;

-- =====================================================================================================================
-- InboundEmail: (…_notify_depth_w2b_guards, whole) + B-W2b-F54: an erasure blanks what the mail held of the person (From,
-- its name, subject, text, HTML); what SES said (the envelope sender among it), the recipients, the references and the
-- place stay as they came.
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
  IF TG_OP = 'UPDATE'
     AND (NEW."fromAddress", NEW."fromName", NEW."subject", NEW."bodyText", NEW."bodyHtml")
         IS DISTINCT FROM (OLD."fromAddress", OLD."fromName", OLD."subject", OLD."bodyText", OLD."bodyHtml")
     AND "factory_privacy_ops_erasure_ok"('InboundEmail', to_jsonb(OLD), to_jsonb(NEW),
           '{"fromAddress": null, "fromName": null, "subject": null, "bodyText": null, "bodyHtml": null}'::jsonb, '{}'::text[], '{}'::text[]) THEN
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
-- EmailOutbound: (…_email_guards, whole) + B-W2b-F54: an erasure blanks the person's addresses among the recipients (each
-- one '', the others as they were) and the subject, once the mail is no longer on its way; what was sent to whom otherwise,
-- and how it ended, stay.
CREATE OR REPLACE FUNCTION "factory_email_outbound_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'email: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email: mail % is never deleted; it records what went to whom', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- B-W2b-F54: an erasure (GDPR art. 17) blanks the person's addresses among the recipients and the subject of a mail no
  -- longer on its way; nothing else of the row moves.
  IF TG_OP = 'UPDATE' AND OLD."status" NOT IN ('QUEUED', 'SENDING')
     AND (NEW."to", NEW."cc", NEW."subject") IS DISTINCT FROM (OLD."to", OLD."cc", OLD."subject")
     AND "factory_privacy_ops_erasure_ok"('EmailOutbound', to_jsonb(OLD), to_jsonb(NEW), '{"subject": ""}'::jsonb, ARRAY['to', 'cc'], '{}'::text[]) THEN
    RETURN NEW;
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

-- =====================================================================================================================
-- Message: append-only (…_threads_guards, whole) + B-W2b-F54: an erasure blanks the name, the text and the HTML of a message
-- a person wrote (author PARTY, USER or WORKER); a correction is still a new message, and nothing else ever changes.
CREATE OR REPLACE FUNCTION "factory_refuse_message_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' THEN
    IF OLD."authorKind" IN ('PARTY', 'USER', 'WORKER')
       AND "factory_privacy_ops_erasure_ok"('Message', to_jsonb(OLD), to_jsonb(NEW), '{"authorName": null, "bodyText": "", "bodyHtml": null}'::jsonb, '{}'::text[], '{}'::text[]) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'append-only: % on "%" is refused; a correction is a new message', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- =====================================================================================================================
-- AuditLog: append-only (…_audit_append_only, whole) + B-W2b-F54: an erasure blanks values inside an audit row's before and
-- after (the person's details), never its keys, its other columns or the row. The function also guards the other ledgers
-- that reuse it (numbering, integration, links, the floor's numbers, the receipts' TRUNCATE): for them nothing changes.
CREATE OR REPLACE FUNCTION "factory_refuse_audit_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'AuditLog' THEN
    IF "factory_privacy_ops_erasure_ok"('AuditLog', to_jsonb(OLD), to_jsonb(NEW), '{}'::jsonb, '{}'::text[], ARRAY['before', 'after']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'append-only: % on "%" is refused; record a correction as a new row', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- =====================================================================================================================
-- The door: blank one row an erasure record names (see the top). `addresses`: the person's addresses (EmailOutbound: each
-- one in to and cc becomes '', compared without case and spaces); `json_keys`: the person's columns as keys (AuditLog: their
-- values in before and after become JSON null, at any depth). Answers whether the row changed (false: it held nothing more
-- to blank). Every refusal is a check_violation in words.
CREATE FUNCTION "factory_privacy_erase_row"(erasure_id uuid, addresses text[], json_keys text[]) RETURNS boolean
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
    IF NOT fields <@ ARRAY['fromAddress', 'fromName', 'subject', 'bodyText', 'bodyHtml'] THEN
      RAISE EXCEPTION 'privacy: a received mail blanks only its sender, sender name, subject, text and HTML (erasure % names %)', erasure_id, fields
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
           "bodyHtml" = CASE WHEN 'bodyHtml' = ANY(fields) THEN NULL ELSE m."bodyHtml" END
     WHERE m."tenantId" = erasure."tenantId" AND m."id" = erasure."recordId"
       AND ((m."fromAddress" IS NOT NULL AND 'fromAddress' = ANY(fields)) OR (m."fromName" IS NOT NULL AND 'fromName' = ANY(fields))
         OR (m."subject" IS NOT NULL AND 'subject' = ANY(fields)) OR (m."bodyText" IS NOT NULL AND 'bodyText' = ANY(fields))
         OR (m."bodyHtml" IS NOT NULL AND 'bodyHtml' = ANY(fields)));

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
