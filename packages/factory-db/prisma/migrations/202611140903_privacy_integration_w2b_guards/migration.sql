-- Written by hand (Prisma does not model triggers), after the generated …_privacy_integration_w2b_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Privacy duties and what fails at the edges (W2b-6, schema wave 53/57, B-W2b-375; privacy-ops.prisma; PLT-201, PLT-202,
-- PLT-203, PLT-204, PLT-221; GDPR arts. 5(1)(e), 12, 15, 16, 17; GATE-PRIVACY). These rules hold for every login, the owner
-- included; apps/factory-api's commands (B-W2b-405, B-W2b-415) check them first in words. Every refusal is a check_violation
-- (SQLSTATE 23514) in words. The row guards are AFTER triggers (the policies speak first); the refused deletes and the
-- append-only ledger's refused changes are BEFORE triggers. An UPDATE that changes nothing passes.
--
-- Reused as they are: recall's `factory_recall_words_ok`, `factory_recall_not_future`, `factory_recall_model_name_ok`, and
-- money's `factory_money_rome_day`.
-- Redefined, word for word but for the change: wave 16's `factory_protected_view_check` (a view of a safety report's injury,
-- PRODUCT_SAFETY_INJURY, names the ProductSafetyInjury and no employee) and wave 52's `factory_read_log_record_type_ok`
-- (DataRequest joins the list: the download of a person's access package is a read of a sensitive record). Own trigger on a
-- table of another wave: `SalesSettings_safety_report_form_check` (sales.prisma; SalesSettings' earlier triggers stay as
-- they are).
--
-- GATE-PRIVACY: a retention rule only reports until a person switches it on (RetentionRule.applyOn); an APPLY sweep runs only
-- on a rule switched on, and only an APPLY sweep erases anything. The outside doors of safety reports open per company, and
-- only once the company's SAFETY_REPORT notice is published.

CREATE FUNCTION "factory_privacy_ops_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'privacy: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_privacy_ops_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'privacy: % % is kept, never deleted (it is the record of what was asked and done)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

-- The append-only ledger of this wave (scripts/factory/check-append-only.mjs): ErasureRecord. No login changes or removes a
-- row, the owner included; the runtime roles have no UPDATE, DELETE or TRUNCATE grant either.
CREATE FUNCTION "factory_privacy_ops_ledger_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; what was erased of a record, and what stays and why, is kept as it was written', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- A record type: a model name ("Invoice", "ReportRun") that is a table of this database.
CREATE FUNCTION "factory_privacy_ops_table_ok"(record_type text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT "factory_recall_model_name_ok"(record_type) AND to_regclass(quote_ident(record_type)) IS NOT NULL
$$;

-- A code (ours or a provider's): `timeout`, `account_paused`, `00404`, `sdi.send_invoice`; 1 to `longest` characters, letters,
-- digits and _ . : - only, starting with a letter or a digit.
CREATE FUNCTION "factory_privacy_ops_code_ok"(code text, longest integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NOT NULL AND char_length(code) <= longest AND code ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'
$$;

-- A key made of a fixed beginning: the beginning itself, or the beginning and a dash with more after it (the generated
-- isolation tests copy a row with its unique texts suffixed).
CREATE FUNCTION "factory_privacy_ops_key_ok"(key text, beginning text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT key IS NOT NULL AND beginning IS NOT NULL AND char_length(key) <= 300 AND (key = beginning OR starts_with(key, beginning || '-'))
$$;

-- The columns an erasure names: never NULL, at most 100, each once, each a column of the record's table (never its id or
-- tenantId): names only, never a value.
CREATE FUNCTION "factory_privacy_ops_fields_ok"(fields text[], record_type text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT fields IS NOT NULL AND cardinality(fields) <= 100
     AND cardinality(fields) = (SELECT count(DISTINCT f) FROM unnest(fields) f)
     AND NOT EXISTS (
       SELECT 1 FROM unnest(fields) f
        WHERE f IS NULL OR f IN ('id', 'tenantId')
           OR NOT EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a."attrelid" = to_regclass(quote_ident(record_type)) AND a."attname" = f AND a."attnum" > 0 AND NOT a."attisdropped"))
$$;

-- A sweep's failures: a list of at most 100 objects, each `{ "code": <a code of 1 to 80> }` with, at most, `"recordId": <a
-- uuid>`; never a value of the record.
CREATE FUNCTION "factory_privacy_ops_failures_ok"(failures jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT failures IS NOT NULL AND jsonb_typeof(failures) = 'array' AND jsonb_array_length(failures) <= 100
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(failures) e
        WHERE jsonb_typeof(e.value) <> 'object'
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(e.value) k WHERE k NOT IN ('code', 'recordId'))
           OR jsonb_typeof(e.value -> 'code') IS DISTINCT FROM 'string'
           OR NOT "factory_privacy_ops_code_ok"(e.value ->> 'code', 80)
           OR (e.value ? 'recordId' AND (jsonb_typeof(e.value -> 'recordId') IS DISTINCT FROM 'string'
               OR (e.value ->> 'recordId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
$$;

-- =====================================================================================================================
-- DataRequest (PLT-202, PLT-203; GDPR arts. 12, 15, 16, 17)
--   INSERT     born RECEIVED; the person's record exists: WORKER a Worker or an Employee, USER a User, CONTACT a
--              PartyContact, PROSPECT an Inquiry, REPORTER a ProductSafetyReport, of the request's company when the record
--              has one.
--   every row  received not in the future; due exactly 30 days after (art. 12(3)); an extension once, after the due time and
--              at most 90 days after receipt, with its reason (3 to 1000 characters), both or neither; the note up to 2000
--              characters; the identity check with when and by whom, both or neither, not before receipt nor in the future;
--              the decision (when and by whom) exactly when DONE, REFUSED or WITHDRAWN, not before receipt nor in the future;
--              the refusal's reason (3 to 2000 characters) exactly when REFUSED; a package only on an ACCESS request, a file
--              of this request, AVAILABLE; DONE only with the identity checked, an ACCESS request with its package, an
--              ERASURE request with at least one ErasureRecord.
--   UPDATE     an UPDATE that changes nothing passes; RECEIVED → IN_PROGRESS → DONE, or to REFUSED or WITHDRAWN while
--              open; a closed request changes no more; the company, the person, the kind and the clock never change; the
--              extension and the identity check, once set, never change.
--   DELETE     refused (kept). TRUNCATE refused.
CREATE FUNCTION "factory_data_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_company uuid;
  file_type text;
  file_record uuid;
  file_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."status" IN ('DONE', 'REFUSED', 'WITHDRAWN') THEN
      RAISE EXCEPTION 'privacy: data request % is closed (%): it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."id", NEW."companyId", NEW."personKind", NEW."personRecordType", NEW."personRecordId", NEW."kind", NEW."receivedAt", NEW."dueAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."personKind", OLD."personRecordType", OLD."personRecordId", OLD."kind", OLD."receivedAt", OLD."dueAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'privacy: the company, the person, the kind and the clock of data request % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."extendedDueAt" IS NOT NULL AND (NEW."extendedDueAt", NEW."extensionReason") IS DISTINCT FROM (OLD."extendedDueAt", OLD."extensionReason") THEN
      RAISE EXCEPTION 'privacy: data request % was extended once; the extension never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."identityCheckedAt" IS NOT NULL AND (NEW."identityCheckedAt", NEW."identityCheckedById") IS DISTINCT FROM (OLD."identityCheckedAt", OLD."identityCheckedById") THEN
      RAISE EXCEPTION 'privacy: the identity check of data request % is recorded once, never changed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT ((OLD."status" = 'RECEIVED' AND NEW."status" IN ('IN_PROGRESS', 'REFUSED', 'WITHDRAWN'))
                OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('DONE', 'REFUSED', 'WITHDRAWN'))) THEN
      RAISE EXCEPTION 'privacy: data request % moves RECEIVED → IN_PROGRESS → DONE, or to REFUSED or WITHDRAWN while open (not % → %)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."status" <> 'RECEIVED' THEN
      RAISE EXCEPTION 'privacy: data request % is recorded as it comes in (RECEIVED), then worked on', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((NEW."personKind" = 'WORKER' AND NEW."personRecordType" IN ('Worker', 'Employee'))
            OR (NEW."personKind" = 'USER' AND NEW."personRecordType" = 'User')
            OR (NEW."personKind" = 'CONTACT' AND NEW."personRecordType" = 'PartyContact')
            OR (NEW."personKind" = 'PROSPECT' AND NEW."personRecordType" = 'Inquiry')
            OR (NEW."personKind" = 'REPORTER' AND NEW."personRecordType" = 'ProductSafetyReport')) THEN
      RAISE EXCEPTION 'privacy: data request % names the person by the record of their kind: a worker a Worker or an Employee, a user a User, a contact a PartyContact, a prospect an Inquiry, a reporter a ProductSafetyReport (not % for %)', NEW."id", NEW."personRecordType", NEW."personKind"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."personRecordType" = 'Worker' THEN
      SELECT w."companyId" INTO record_company FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."personRecordId";
    ELSIF NEW."personRecordType" = 'Employee' THEN
      SELECT e."companyId" INTO record_company FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."personRecordId";
    ELSIF NEW."personRecordType" = 'Inquiry' THEN
      SELECT i."companyId" INTO record_company FROM "Inquiry" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."personRecordId";
    ELSIF NEW."personRecordType" = 'ProductSafetyReport' THEN
      SELECT r."companyId" INTO record_company FROM "ProductSafetyReport" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."personRecordId";
    ELSIF NEW."personRecordType" = 'User' THEN
      PERFORM 1 FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."personRecordId";
    ELSE
      PERFORM 1 FROM "PartyContact" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."personRecordId";
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'privacy: data request % names a % % that does not exist', NEW."id", NEW."personRecordType", NEW."personRecordId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF record_company IS NOT NULL AND record_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'privacy: data request % is made to the company of the person''s % (company %)', NEW."id", NEW."personRecordType", record_company
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NOT "factory_recall_not_future"(NEW."receivedAt") THEN
    RAISE EXCEPTION 'privacy: data request % did not come in in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."dueAt" <> NEW."receivedAt" + interval '720 hours' THEN
    RAISE EXCEPTION 'privacy: data request % is due 30 days after it came in (GDPR art. 12(3))', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."extendedDueAt" IS NULL) <> (NEW."extensionReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."extensionReason", 1000, true) OR char_length(btrim(NEW."extensionReason")) < 3
     OR NEW."extendedDueAt" <= NEW."dueAt" OR NEW."extendedDueAt" > NEW."receivedAt" + interval '2160 hours' THEN
    RAISE EXCEPTION 'privacy: data request % is extended once by up to two further months (after its due time, at most 90 days after it came in) with the reason (3 to 1000 characters), both or neither (GDPR art. 12(3))', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'privacy: the note of data request % is 1 to 2000 characters (or none)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."identityCheckedAt" IS NULL) <> (NEW."identityCheckedById" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."identityCheckedAt") OR NEW."identityCheckedAt" < NEW."receivedAt" THEN
    RAISE EXCEPTION 'privacy: the identity check of data request % has when and by whom, both or neither, not before it came in nor in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('DONE', 'REFUSED', 'WITHDRAWN')) <> (NEW."decidedAt" IS NOT NULL)
     OR (NEW."decidedAt" IS NULL) <> (NEW."decidedById" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."decidedAt") OR NEW."decidedAt" < NEW."receivedAt" THEN
    RAISE EXCEPTION 'privacy: data request % names when and by whom it was closed exactly once it is DONE, REFUSED or WITHDRAWN, not before it came in nor in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'REFUSED') <> (NEW."refusalReason" IS NOT NULL)
     OR NOT "factory_recall_words_ok"(NEW."refusalReason", 2000, true) OR char_length(btrim(NEW."refusalReason")) < 3 THEN
    RAISE EXCEPTION 'privacy: data request % names why it was refused (3 to 2000 characters) exactly when REFUSED (GDPR art. 12(4))', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."packageFileId" IS NOT NULL AND NEW."kind" <> 'ACCESS' THEN
    RAISE EXCEPTION 'privacy: only an access request has a package (data request % is %)', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."packageFileId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."packageFileId" IS DISTINCT FROM OLD."packageFileId" OR NEW."status" IS DISTINCT FROM OLD."status") THEN
    SELECT f."recordType", f."recordId", f."status"::text INTO file_type, file_record, file_status
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."packageFileId";
    IF FOUND AND ((file_type, file_record) IS DISTINCT FROM ('DataRequest', NEW."id") OR file_status <> 'AVAILABLE') THEN
      RAISE EXCEPTION 'privacy: the package of data request % is an available file of the request (file % is %, of % %)', NEW."id", NEW."packageFileId", file_status, file_type, file_record
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" = 'DONE' THEN
    IF NEW."identityCheckedAt" IS NULL THEN
      RAISE EXCEPTION 'privacy: data request % is done only once the person''s identity was checked (GDPR art. 12(6))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'ACCESS' AND NEW."packageFileId" IS NULL THEN
      RAISE EXCEPTION 'privacy: access request % is done with the package handed over', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'ERASURE' AND NOT EXISTS (SELECT 1 FROM "ErasureRecord" x WHERE x."tenantId" = NEW."tenantId" AND x."dataRequestId" = NEW."id") THEN
      RAISE EXCEPTION 'privacy: erasure request % is done once each record looked at is recorded: what was erased, and what stays and why', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "DataRequest_guard" AFTER INSERT OR UPDATE ON "DataRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_data_request_guard"();
CREATE TRIGGER "DataRequest_never_deleted" BEFORE DELETE ON "DataRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_privacy_ops_never_deleted"();
CREATE TRIGGER "DataRequest_no_truncate" BEFORE TRUNCATE ON "DataRequest"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_privacy_ops_refuse_truncate"();

-- =====================================================================================================================
-- RetentionRule (PLT-204; GDPR art. 5(1)(e); GATE-PRIVACY)
--   every row  the record type a table of the database; the key `retention:<recordType>:<companyId | all>` (each record type
--              once per company and once tenant-wide: the unique key); kept 1 to 1200 months; the legal reason 3 to 1000
--              characters; switched on (applyOn) only while active, with when (not in the future) and by whom, exactly while
--              on.
--   UPDATE     an UPDATE that changes nothing passes; the company, the key, the record type and the creation never change;
--              while switched on, when and by whom stay as they were.
--   DELETE     refused (switched off instead). TRUNCATE refused.
CREATE FUNCTION "factory_retention_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."key", NEW."recordType", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."key", OLD."recordType", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'privacy: the company, the key, the record type and the creation of retention rule % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."applyOn" AND NEW."applyOn" AND (NEW."applyOnAt", NEW."applyOnById") IS DISTINCT FROM (OLD."applyOnAt", OLD."applyOnById") THEN
      RAISE EXCEPTION 'privacy: retention rule % was switched on at % by %; that stays while it is on', OLD."id", OLD."applyOnAt", OLD."applyOnById"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_privacy_ops_table_ok"(NEW."recordType") THEN
    RAISE EXCEPTION 'privacy: retention rule % is for a record type that is a table of the database (a model name), not %', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_key_ok"(NEW."key", concat('retention:', NEW."recordType", ':', coalesce(NEW."companyId"::text, 'all'))) THEN
    RAISE EXCEPTION 'privacy: the key of retention rule % is retention:<record type>:<company or all> (each record type once per company and once for all)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."keepMonths" NOT BETWEEN 1 AND 1200 THEN
    RAISE EXCEPTION 'privacy: retention rule % keeps a record 1 to 1200 months (not %)', NEW."id", NEW."keepMonths"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."legalReason", 1000, true) OR char_length(btrim(NEW."legalReason")) < 3 THEN
    RAISE EXCEPTION 'privacy: retention rule % names its legal reason in 3 to 1000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."applyOn" AND (NEW."applyOnAt" IS NULL OR NEW."applyOnById" IS NULL))
     OR (NOT NEW."applyOn" AND (NEW."applyOnAt" IS NOT NULL OR NEW."applyOnById" IS NOT NULL))
     OR NOT "factory_recall_not_future"(NEW."applyOnAt") THEN
    RAISE EXCEPTION 'privacy: retention rule % names when and by whom it was switched on exactly while it is on (GATE-PRIVACY)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."applyOn" AND NOT NEW."active" THEN
    RAISE EXCEPTION 'privacy: retention rule % is switched off, so it is not applied either (switch it on again first)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RetentionRule_guard" AFTER INSERT OR UPDATE ON "RetentionRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_retention_rule_guard"();
CREATE TRIGGER "RetentionRule_never_deleted" BEFORE DELETE ON "RetentionRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_privacy_ops_never_deleted"();
CREATE TRIGGER "RetentionRule_no_truncate" BEFORE TRUNCATE ON "RetentionRule"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_privacy_ops_refuse_truncate"();

-- =====================================================================================================================
-- RetentionSweep (PLT-204; GATE-PRIVACY)
--   INSERT     of an active rule (read FOR SHARE: a sweep and a change of its rule take turns); an APPLY sweep only of a rule
--              switched on; its months and action the rule's, its cut-off the business day (Europe/Rome) it started on
--              less those months (money's `factory_money_rome_day`; a month end clamped).
-- The clocks of this wave count exact hours (30 days = 720 hours, 90 days = 2160 hours, 7 days = 168 hours), never the
-- session's calendar: the same instant whatever time zone a session runs in.
--   every row  started not in the future; finished exactly once DONE or FAILED, not before the start nor in the future; the
--              counts 0 or more, applied + held + failed at most due, nothing applied by a REPORT sweep; the failures as
--              codes (factory_privacy_ops_failures_ok), at least one on a FAILED sweep.
--   UPDATE     an UPDATE that changes nothing passes; a finished sweep changes no more; RUNNING → DONE | FAILED; the rule,
--              the mode, the months, the action, the cut-off, the start and who asked never change; the counts never go
--              down.
--   DELETE     refused (kept). TRUNCATE refused.
CREATE FUNCTION "factory_retention_sweep_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rule_active boolean;
  rule_apply boolean;
  rule_months integer;
  rule_action text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."status" <> 'RUNNING' THEN
      RAISE EXCEPTION 'privacy: retention sweep % is finished (%): it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."id", NEW."ruleId", NEW."mode", NEW."keepMonths", NEW."thenAction", NEW."cutoffOn", NEW."startedAt", NEW."requestedById")
       IS DISTINCT FROM (OLD."id", OLD."ruleId", OLD."mode", OLD."keepMonths", OLD."thenAction", OLD."cutoffOn", OLD."startedAt", OLD."requestedById") THEN
      RAISE EXCEPTION 'privacy: the rule, the mode, the period, the cut-off, the start and who asked of retention sweep % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."dueCount" < OLD."dueCount" OR NEW."appliedCount" < OLD."appliedCount" OR NEW."heldCount" < OLD."heldCount" OR NEW."failedCount" < OLD."failedCount" THEN
      RAISE EXCEPTION 'privacy: the counts of retention sweep % never go down', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" NOT IN ('DONE', 'FAILED') THEN
      RAISE EXCEPTION 'privacy: retention sweep % moves RUNNING → DONE or FAILED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT r."active", r."applyOn", r."keepMonths", r."thenAction"::text INTO rule_active, rule_apply, rule_months, rule_action
      FROM "RetentionRule" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."ruleId" FOR SHARE;
    IF FOUND THEN
      IF NOT rule_active THEN
        RAISE EXCEPTION 'privacy: retention rule % is switched off: it is not swept (sweep %)', NEW."ruleId", NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."mode" = 'APPLY' AND NOT rule_apply THEN
        RAISE EXCEPTION 'privacy: retention rule % only reports until a person switches it on (GATE-PRIVACY): sweep % is a REPORT, not APPLY', NEW."ruleId", NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (NEW."keepMonths", NEW."thenAction"::text) IS DISTINCT FROM (rule_months, rule_action) THEN
        RAISE EXCEPTION 'privacy: retention sweep % keeps the period and the action of its rule as they stand (% months, then %)', NEW."id", rule_months, rule_action
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."cutoffOn" <> ("factory_money_rome_day"(NEW."startedAt") - make_interval(months => NEW."keepMonths"))::date THEN
      RAISE EXCEPTION 'privacy: the cut-off of retention sweep % is the business day it started on less its % months (Europe/Rome; a month end clamped)', NEW."id", NEW."keepMonths"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_not_future"(NEW."startedAt") THEN
    RAISE EXCEPTION 'privacy: retention sweep % did not start in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" <> 'RUNNING') <> (NEW."finishedAt" IS NOT NULL)
     OR NEW."finishedAt" < NEW."startedAt" OR NOT "factory_recall_not_future"(NEW."finishedAt") THEN
    RAISE EXCEPTION 'privacy: retention sweep % names when it finished exactly once it is DONE or FAILED, not before its start nor in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."dueCount" < 0 OR NEW."appliedCount" < 0 OR NEW."heldCount" < 0 OR NEW."failedCount" < 0
     OR NEW."appliedCount" + NEW."heldCount" + NEW."failedCount" > NEW."dueCount" THEN
    RAISE EXCEPTION 'privacy: retention sweep % counts what was due and, of it, what was applied, held and failed (0 or more, at most what was due)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."mode" = 'REPORT' AND NEW."appliedCount" <> 0 THEN
    RAISE EXCEPTION 'privacy: retention sweep % only reports: it applies nothing', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_failures_ok"(NEW."failures") OR (NEW."status" = 'FAILED' AND jsonb_array_length(NEW."failures") = 0) THEN
    RAISE EXCEPTION 'privacy: the failures of retention sweep % are a list of at most 100 codes ({ code, recordId? }), at least one when it FAILED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RetentionSweep_guard" AFTER INSERT OR UPDATE ON "RetentionSweep"
  FOR EACH ROW EXECUTE FUNCTION "factory_retention_sweep_guard"();
CREATE TRIGGER "RetentionSweep_never_deleted" BEFORE DELETE ON "RetentionSweep"
  FOR EACH ROW EXECUTE FUNCTION "factory_privacy_ops_never_deleted"();
CREATE TRIGGER "RetentionSweep_no_truncate" BEFORE TRUNCATE ON "RetentionSweep"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_privacy_ops_refuse_truncate"();

-- =====================================================================================================================
-- ErasureRecord (PLT-203; GDPR art. 17(3)): append-only
--   INSERT     exactly one of an erasure request (an ERASURE request of the record's company, IN_PROGRESS, read FOR SHARE so
--              its closing waits; done by an office person) and an APPLY sweep (RUNNING, read FOR SHARE; its rule of the
--              record type and of the record's company or of every company; a DELETE rule deletes or keeps, an ANONYMISE
--              rule anonymises or keeps, an ARCHIVE rule erases nothing); the record type a table of the database;
--              ANONYMISED names the columns erased (at least one), DELETED and KEPT none, DELETED keeps none; the columns
--              (factory_privacy_ops_fields_ok) never both erased and kept; why they stay (3 to 1000 characters) exactly when
--              something is kept; not in the future.
--   UPDATE, DELETE, TRUNCATE  refused for every login.
CREATE FUNCTION "factory_erasure_record_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_company uuid;
  request_kind text;
  request_status text;
  sweep_mode text;
  sweep_status text;
  sweep_action text;
  rule_type text;
  rule_company uuid;
BEGIN
  IF (NEW."dataRequestId" IS NULL) = (NEW."sweepId" IS NULL) THEN
    RAISE EXCEPTION 'privacy: erasure % is done for exactly one erasure request or one sweep', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_table_ok"(NEW."recordType") THEN
    RAISE EXCEPTION 'privacy: erasure % names its record by a table of the database (a model name), not %', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_fields_ok"(NEW."erasedFields", NEW."recordType") OR NOT "factory_privacy_ops_fields_ok"(NEW."keptFields", NEW."recordType") THEN
    RAISE EXCEPTION 'privacy: erasure % names columns of the % table only (never its id or tenant), each once, at most 100: names, never values', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."erasedFields" && NEW."keptFields" THEN
    RAISE EXCEPTION 'privacy: erasure % never names a column both erased and kept', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."method" = 'ANONYMISED' AND cardinality(NEW."erasedFields") = 0)
     OR (NEW."method" IN ('DELETED', 'KEPT') AND cardinality(NEW."erasedFields") > 0)
     OR (NEW."method" = 'DELETED' AND cardinality(NEW."keptFields") > 0) THEN
    RAISE EXCEPTION 'privacy: erasure % (%) names the columns it erased when ANONYMISED (at least one), none when the row was DELETED (which keeps none) or KEPT', NEW."id", NEW."method"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."keptWhy" IS NOT NULL) <> (cardinality(NEW."keptFields") > 0 OR NEW."method" = 'KEPT')
     OR NOT "factory_recall_words_ok"(NEW."keptWhy", 1000, true) OR char_length(btrim(NEW."keptWhy")) < 3 THEN
    RAISE EXCEPTION 'privacy: erasure % says why something stays (the law, 3 to 1000 characters) exactly when a column or the record is kept', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."erasedAt") THEN
    RAISE EXCEPTION 'privacy: erasure % is not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."dataRequestId" IS NOT NULL THEN
    IF NEW."erasedById" IS NULL THEN
      RAISE EXCEPTION 'privacy: erasure % of a request names the office person who did it', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT d."companyId", d."kind"::text, d."status"::text INTO request_company, request_kind, request_status
      FROM "DataRequest" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."dataRequestId" FOR SHARE;
    IF FOUND AND (request_kind <> 'ERASURE' OR request_status <> 'IN_PROGRESS' OR request_company <> NEW."companyId") THEN
      RAISE EXCEPTION 'privacy: erasure % is done for an erasure request of its company that is in progress (request % is a % request, %, of company %)', NEW."id", NEW."dataRequestId", request_kind, request_status, request_company
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT s."mode"::text, s."status"::text, s."thenAction"::text, r."recordType", r."companyId"
      INTO sweep_mode, sweep_status, sweep_action, rule_type, rule_company
      FROM "RetentionSweep" s JOIN "RetentionRule" r ON r."tenantId" = s."tenantId" AND r."id" = s."ruleId"
     WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sweepId" FOR SHARE OF s;
    IF FOUND THEN
      IF sweep_mode <> 'APPLY' OR sweep_status <> 'RUNNING' THEN
        RAISE EXCEPTION 'privacy: erasure % is done by a sweep that applies its rule and is running (sweep % is a %, %)', NEW."id", NEW."sweepId", sweep_mode, sweep_status
          USING ERRCODE = 'check_violation';
      END IF;
      IF rule_type <> NEW."recordType" OR (rule_company IS NOT NULL AND rule_company <> NEW."companyId") THEN
        RAISE EXCEPTION 'privacy: erasure % is of a record of its sweep''s rule (a % of %)', NEW."id", rule_type, coalesce(rule_company::text, 'every company')
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT ((sweep_action = 'DELETE' AND NEW."method" IN ('DELETED', 'KEPT')) OR (sweep_action = 'ANONYMISE' AND NEW."method" IN ('ANONYMISED', 'KEPT'))) THEN
        RAISE EXCEPTION 'privacy: erasure % does what its sweep''s rule says (%: the record %), or keeps the record the law keeps', NEW."id", sweep_action, NEW."method"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ErasureRecord_check" AFTER INSERT ON "ErasureRecord"
  FOR EACH ROW EXECUTE FUNCTION "factory_erasure_record_check"();
CREATE TRIGGER "ErasureRecord_append_only" BEFORE UPDATE OR DELETE ON "ErasureRecord"
  FOR EACH ROW EXECUTE FUNCTION "factory_privacy_ops_ledger_change"();
CREATE TRIGGER "ErasureRecord_no_truncate" BEFORE TRUNCATE ON "ErasureRecord"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_privacy_ops_ledger_change"();

-- =====================================================================================================================
-- IntegrationErrorItem (PLT-201)
--   INSERT     born OPEN, without a retry or a dismissal; the source row exists and failed: an OUTBOX event DEAD, or
--              PUBLISHED (its job failed), with no provider; a WEBHOOK delivery FAILED or REJECTED, a CALL FAILED,
--              TIMED_OUT or REFUSED, each with its provider (a call also with its operation); the company the source's when
--              it has one.
--   every row  the key `<outbox | webhook | call>:<sourceId>`; the operation a code of 1 to 100; the record a table and an
--              id, both or neither; the reason a code of 1 to 80, the provider's message up to 2000 characters; tries 1 or
--              more; the first failure not after the latest, neither in the future; the latest retry with when and by whom,
--              both or neither, set while RETRIED; the dismissal (when, by whom, why: 3 to 500 characters) exactly when
--              DISMISSED, not before the first failure nor in the future.
--   UPDATE     an UPDATE that changes nothing passes; a DISMISSED item changes no more; the company, the key, the source,
--              the provider, the operation, the record and the first failure never change; tries never go down and the
--              latest failure never back; OPEN → RETRIED (a retry after the latest failure) | DISMISSED; RETRIED → OPEN
--              (one more try, failed after the retry) | DISMISSED.
--   DELETE     only a closed item (DISMISSED, or RETRIED and not failed again) 30 days after it closed. TRUNCATE refused.
CREATE FUNCTION "factory_integration_error_item_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_status text;
  source_company uuid;
  source_provider text;
  source_operation text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."state" = 'DISMISSED' THEN
      RAISE EXCEPTION 'connections: failed message % was dismissed: it changes no more', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."id", NEW."companyId", NEW."key", NEW."source", NEW."sourceId", NEW."provider", NEW."operation", NEW."recordType", NEW."recordId", NEW."firstFailedAt", NEW."createdAt")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."key", OLD."source", OLD."sourceId", OLD."provider", OLD."operation", OLD."recordType", OLD."recordId", OLD."firstFailedAt", OLD."createdAt") THEN
      RAISE EXCEPTION 'connections: the source, the service, what failed, its record and its first failure of failed message % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."tries" < OLD."tries" OR NEW."lastFailedAt" < OLD."lastFailedAt" THEN
      RAISE EXCEPTION 'connections: the tries of failed message % never go down, nor its latest failure back', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'RETRIED' AND NEW."state" = 'RETRIED' AND (NEW."retriedAt", NEW."retriedById", NEW."tries", NEW."lastFailedAt") IS DISTINCT FROM (OLD."retriedAt", OLD."retriedById", OLD."tries", OLD."lastFailedAt") THEN
      RAISE EXCEPTION 'connections: failed message % was sent again; it fails again (back to OPEN) or is dismissed before another retry', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" <> 'RETRIED' AND NEW."state" = 'RETRIED'
       AND (NEW."retriedAt" IS NULL OR NEW."retriedAt" IS NOT DISTINCT FROM OLD."retriedAt" OR NEW."retriedAt" < NEW."lastFailedAt") THEN
      RAISE EXCEPTION 'connections: failed message % is sent again after its latest failure, with when and by whom', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'RETRIED' AND NEW."state" = 'OPEN'
       AND (NEW."tries" <= OLD."tries" OR NEW."lastFailedAt" <= OLD."retriedAt" OR (NEW."retriedAt", NEW."retriedById") IS DISTINCT FROM (OLD."retriedAt", OLD."retriedById")) THEN
      RAISE EXCEPTION 'connections: failed message % is open again only when its retry failed too (one more try, after the retry; the retry kept)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'OPEN' AND NEW."state" = 'OPEN' AND (NEW."retriedAt", NEW."retriedById") IS DISTINCT FROM (OLD."retriedAt", OLD."retriedById") THEN
      RAISE EXCEPTION 'connections: a retry of failed message % marks it RETRIED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."state" <> 'OPEN' OR NEW."retriedAt" IS NOT NULL OR NEW."retriedById" IS NOT NULL THEN
      RAISE EXCEPTION 'connections: failed message % is born OPEN, never retried yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."source" = 'OUTBOX' THEN
      SELECT o."status"::text, o."companyId", NULL, NULL INTO source_status, source_company, source_provider, source_operation
        FROM "OutboxEvent" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."sourceId";
    ELSIF NEW."source" = 'WEBHOOK' THEN
      SELECT w."status"::text, w."companyId", w."provider"::text, NULL INTO source_status, source_company, source_provider, source_operation
        FROM "InboundWebhook" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."sourceId";
    ELSE
      SELECT c."status"::text, c."companyId", c."provider"::text, c."operation" INTO source_status, source_company, source_provider, source_operation
        FROM "IntegrationCall" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."sourceId";
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'connections: failed message % names a % row % that does not exist', NEW."id", NEW."source", NEW."sourceId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((NEW."source" = 'OUTBOX' AND source_status IN ('DEAD', 'PUBLISHED'))
            OR (NEW."source" = 'WEBHOOK' AND source_status IN ('FAILED', 'REJECTED'))
            OR (NEW."source" = 'CALL' AND source_status IN ('FAILED', 'TIMED_OUT', 'REFUSED'))) THEN
      RAISE EXCEPTION 'connections: failed message % is of a % that failed (it is %)', NEW."id", NEW."source", source_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."provider"::text IS DISTINCT FROM source_provider OR (NEW."source" = 'CALL' AND NEW."operation" <> source_operation) THEN
      RAISE EXCEPTION 'connections: failed message % names the service of its % (%) and, for a call, its operation (%)', NEW."id", NEW."source", coalesce(source_provider, 'none'), coalesce(source_operation, 'any')
        USING ERRCODE = 'check_violation';
    END IF;
    IF source_company IS NOT NULL AND NEW."companyId" IS DISTINCT FROM source_company THEN
      RAISE EXCEPTION 'connections: failed message % is of the company of its % (company %)', NEW."id", NEW."source", source_company
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NOT "factory_privacy_ops_key_ok"(NEW."key", concat(lower(NEW."source"::text), ':', NEW."sourceId")) THEN
    RAISE EXCEPTION 'connections: the key of failed message % is <outbox, webhook or call>:<its source row> (one item per source row)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_code_ok"(NEW."operation", 100) THEN
    RAISE EXCEPTION 'connections: failed message % names what failed as a code (sdi.send_invoice, an event type), 1 to 100 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."recordType" IS NULL) <> (NEW."recordId" IS NULL)
     OR (NEW."recordType" IS NOT NULL AND NOT "factory_privacy_ops_table_ok"(NEW."recordType")) THEN
    RAISE EXCEPTION 'connections: failed message % names its record by a table of the database and its id, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_code_ok"(NEW."reasonCode", 80) OR NOT "factory_recall_words_ok"(NEW."reasonText", 2000, true) THEN
    RAISE EXCEPTION 'connections: failed message % says why as a code (1 to 80 characters) and, at most, the provider''s message (up to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tries" < 1 OR NEW."firstFailedAt" > NEW."lastFailedAt"
     OR NOT "factory_recall_not_future"(NEW."firstFailedAt") OR NOT "factory_recall_not_future"(NEW."lastFailedAt") THEN
    RAISE EXCEPTION 'connections: failed message % failed 1 or more times, its first failure not after its latest, neither in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."retriedAt" IS NULL) <> (NEW."retriedById" IS NULL) OR (NEW."state" = 'RETRIED' AND NEW."retriedAt" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."retriedAt") OR NEW."retriedAt" < NEW."firstFailedAt" THEN
    RAISE EXCEPTION 'connections: the retry of failed message % has when and by whom, both or neither, after its first failure and not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."state" = 'DISMISSED') <> (NEW."dismissedAt" IS NOT NULL)
     OR (NEW."dismissedAt" IS NULL) <> (NEW."dismissedById" IS NULL) OR (NEW."dismissedAt" IS NULL) <> (NEW."dismissReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."dismissReason", 500, true) OR char_length(btrim(NEW."dismissReason")) < 3
     OR NOT "factory_recall_not_future"(NEW."dismissedAt") OR NEW."dismissedAt" < NEW."firstFailedAt" THEN
    RAISE EXCEPTION 'connections: failed message % is dismissed with when, by whom and why (3 to 500 characters), exactly when DISMISSED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_integration_error_item_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT ((OLD."state" = 'DISMISSED' AND OLD."dismissedAt" <= now() - interval '720 hours')
          OR (OLD."state" = 'RETRIED' AND OLD."retriedAt" <= now() - interval '720 hours')) THEN
    RAISE EXCEPTION 'connections: failed message % is %: an open one is never deleted, a closed one only 30 days after it closed', OLD."id", OLD."state"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "IntegrationErrorItem_guard" AFTER INSERT OR UPDATE ON "IntegrationErrorItem"
  FOR EACH ROW EXECUTE FUNCTION "factory_integration_error_item_guard"();
CREATE TRIGGER "IntegrationErrorItem_delete_guard" BEFORE DELETE ON "IntegrationErrorItem"
  FOR EACH ROW EXECUTE FUNCTION "factory_integration_error_item_delete_guard"();
CREATE TRIGGER "IntegrationErrorItem_no_truncate" BEFORE TRUNCATE ON "IntegrationErrorItem"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_privacy_ops_refuse_truncate"();

-- =====================================================================================================================
-- CronRun (PLT-221)
--   every row  the job a cron name (`<area>.<job>`, as apps/factory-api core/cron.ts) of at most 100 characters; the key
--              `<jobKey>@<the tick's epoch seconds>` for SCHEDULE, `<jobKey>@now:<request>` for RUN_NOW (one row per tick
--              and tenant: the unique key); who asked exactly for RUN_NOW; due and started not in the future; finished
--              exactly once SUCCEEDED or FAILED, not before the start nor in the future; the error (1 to 4000 characters)
--              exactly when FAILED; the replica 1 to 200 characters on one line.
--   UPDATE     an UPDATE that changes nothing passes; a finished run changes no more; RUNNING → SUCCEEDED | FAILED; the job,
--              the trigger, the key, the tick, who asked, the start and the replica never change.
--   DELETE     only a finished run, 7 days after it finished (the jobs page counts the failures of 7 days). TRUNCATE refused.
CREATE FUNCTION "factory_cron_run_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."status" <> 'RUNNING' THEN
      RAISE EXCEPTION 'jobs: run % of % is finished (%): it changes no more', OLD."id", OLD."jobKey", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."id", NEW."jobKey", NEW."trigger", NEW."key", NEW."scheduledAt", NEW."requestedById", NEW."startedAt", NEW."ranOn", NEW."createdAt")
       IS DISTINCT FROM (OLD."id", OLD."jobKey", OLD."trigger", OLD."key", OLD."scheduledAt", OLD."requestedById", OLD."startedAt", OLD."ranOn", OLD."createdAt") THEN
      RAISE EXCEPTION 'jobs: the job, the trigger, the tick, who asked, the start and the replica of run % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" NOT IN ('SUCCEEDED', 'FAILED') THEN
      RAISE EXCEPTION 'jobs: run % moves RUNNING → SUCCEEDED or FAILED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."jobKey" IS NULL OR char_length(NEW."jobKey") > 100 OR NEW."jobKey" !~ '^[a-z][a-zA-Z0-9]*([.-][a-zA-Z0-9]+)+$' THEN
    RAISE EXCEPTION 'jobs: run % names its job by its cron name (<area>.<job>, at most 100 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."trigger" = 'SCHEDULE' AND NOT "factory_privacy_ops_key_ok"(NEW."key", concat(NEW."jobKey", '@', floor(extract(epoch FROM NEW."scheduledAt"))::bigint)))
     OR (NEW."trigger" = 'RUN_NOW' AND (char_length(NEW."key") > 300 OR NOT starts_with(NEW."key", NEW."jobKey" || '@now:') OR char_length(NEW."key") = char_length(NEW."jobKey") + 5)) THEN
    RAISE EXCEPTION 'jobs: the key of run % is <job>@<the tick''s epoch seconds> for a scheduled run, <job>@now:<request> for a run a person asked for (one row per tick)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."trigger" = 'RUN_NOW') <> (NEW."requestedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'jobs: run % names who asked for it exactly when a person asked (RUN_NOW)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."scheduledAt") OR NOT "factory_recall_not_future"(NEW."startedAt") THEN
    RAISE EXCEPTION 'jobs: run % was not due nor started in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" <> 'RUNNING') <> (NEW."finishedAt" IS NOT NULL)
     OR NEW."finishedAt" < NEW."startedAt" OR NOT "factory_recall_not_future"(NEW."finishedAt") THEN
    RAISE EXCEPTION 'jobs: run % names when it finished exactly once it SUCCEEDED or FAILED, not before its start nor in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'FAILED') <> (NEW."error" IS NOT NULL) OR NOT "factory_recall_words_ok"(NEW."error", 4000, true) THEN
    RAISE EXCEPTION 'jobs: run % keeps its error (1 to 4000 characters) exactly when it FAILED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ranOn" IS NULL OR NOT "factory_recall_words_ok"(NEW."ranOn", 200, false) THEN
    RAISE EXCEPTION 'jobs: run % names the replica that ran it in 1 to 200 characters on one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_cron_run_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'RUNNING' OR OLD."finishedAt" > now() - interval '168 hours' THEN
    RAISE EXCEPTION 'jobs: run % of % is deleted only once finished, 7 days after it finished (the failures of 7 days are counted)', OLD."id", OLD."jobKey"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "CronRun_guard" AFTER INSERT OR UPDATE ON "CronRun"
  FOR EACH ROW EXECUTE FUNCTION "factory_cron_run_guard"();
CREATE TRIGGER "CronRun_delete_guard" BEFORE DELETE ON "CronRun"
  FOR EACH ROW EXECUTE FUNCTION "factory_cron_run_delete_guard"();
CREATE TRIGGER "CronRun_no_truncate" BEFORE TRUNCATE ON "CronRun"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_privacy_ops_refuse_truncate"();

-- =====================================================================================================================
-- SalesSettings.safetyReportFormOn (B-W2b-351, -357; GATE-PRIVACY): the outside doors of safety reports
--   switched on (an insert that is on, or off → on) only on a company's own row, never on the tenant-wide one, and only while
--   the company's SAFETY_REPORT privacy notice is published (a notice is never unpublished: a later version replaces it).
--   Switching off is always allowed.
CREATE FUNCTION "factory_sales_settings_safety_report_form_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW."safetyReportFormOn" OR (TG_OP = 'UPDATE' AND OLD."safetyReportFormOn") THEN
    RETURN NEW;
  END IF;
  IF NEW."companyId" IS NULL THEN
    RAISE EXCEPTION 'sales: the outside doors of safety reports are switched on per company, never in the tenant-wide sales settings %', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "PrivacyNotice" n
                  WHERE n."tenantId" = NEW."tenantId" AND n."companyId" = NEW."companyId" AND n."kind" = 'SAFETY_REPORT' AND n."status" = 'PUBLISHED') THEN
    RAISE EXCEPTION 'sales: the outside doors of safety reports of company % open only once its safety-report privacy notice is published (GATE-PRIVACY)', NEW."companyId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SalesSettings_safety_report_form_check" AFTER INSERT OR UPDATE OF "safetyReportFormOn" ON "SalesSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_settings_safety_report_form_check"();

-- =====================================================================================================================
-- ProtectedView (QHS-256, QHS-270; B-W2b-291, -351): a view of a safety report's injury
-- Redefines wave 16's `factory_protected_view_check` (202610318801_protected_safety_w2b_guards), word for word but for the
-- PRODUCT_SAFETY_INJURY branch: the record is the ProductSafetyInjury (OPEN, COPY or PRINT, never a LIST), of the view's
-- company; the person hurt is outside the company, so the view names no employee.
CREATE OR REPLACE FUNCTION "factory_protected_view_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_company uuid;
  record_person uuid;
BEGIN
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NULL) IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF NEW."recordType" IN ('INCIDENT_PEOPLE_LIST', 'HEALTH_VISIT_LIST') THEN
    IF NEW."recordId" IS NOT NULL OR NEW."what" NOT IN ('LIST', 'PRINT') THEN
      RAISE EXCEPTION 'protected safety data: view % of a list names no record and is a LIST or a PRINT', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."recordId" IS NULL OR NEW."what" = 'LIST' THEN
    RAISE EXCEPTION 'protected safety data: view % of a % names the record, and is OPEN, COPY or PRINT', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."recordType" = 'HEALTH_VISIT' THEN
    SELECT v."companyId", v."employeeId" INTO record_company, record_person FROM "HealthVisit" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."recordId";
  ELSIF NEW."recordType" = 'FITNESS_JUDGEMENT' THEN
    SELECT j."companyId", j."employeeId" INTO record_company, record_person FROM "FitnessJudgement" j WHERE j."tenantId" = NEW."tenantId" AND j."id" = NEW."recordId";
  ELSIF NEW."recordType" = 'INCIDENT_PERSON' THEN
    SELECT i."companyId", p."employeeId" INTO record_company, record_person
      FROM "IncidentPerson" p JOIN "Incident" i ON i."tenantId" = p."tenantId" AND i."id" = p."incidentId"
     WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."recordId";
  ELSIF NEW."recordType" = 'PRODUCT_SAFETY_INJURY' THEN
    IF NEW."employeeId" IS NOT NULL THEN
      RAISE EXCEPTION 'protected safety data: view % of a safety report''s injury names no employee (the person hurt is outside the company)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT x."companyId", NULL::uuid INTO record_company, record_person FROM "ProductSafetyInjury" x WHERE x."tenantId" = NEW."tenantId" AND x."id" = NEW."recordId";
  ELSE
    SELECT i."companyId", p."employeeId" INTO record_company, record_person
      FROM "InailFiling" f JOIN "Incident" i ON i."tenantId" = f."tenantId" AND i."id" = f."incidentId"
      JOIN "IncidentPerson" p ON p."tenantId" = f."tenantId" AND p."id" = f."incidentPersonId"
     WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."recordId";
  END IF;
  IF FOUND AND (record_company, record_person) IS DISTINCT FROM (NEW."companyId", NEW."employeeId") THEN
    RAISE EXCEPTION 'protected safety data: view % names the company and the person of the % it is of', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- ReadLog (PLT-074): the read log's record types
-- Redefines wave 52's `factory_read_log_record_type_ok` (202611140803_security_audit_w2b_guards), word for word but for
-- DataRequest in the personal data: the download of a person's access package (everything the company keeps about them) is
-- a read of a sensitive record.
CREATE OR REPLACE FUNCTION "factory_read_log_record_type_ok"(record_type text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT record_type IS NOT NULL AND record_type = ANY (ARRAY[
    'CostSheet',
    'Employee', 'Worker', 'User', 'PartyContact', 'MeasurementProfile', 'LeaverCase', 'AbsenceEntry', 'AttendanceDay', 'EarningsEntry', 'WorkerStatement', 'DataRequest',
    'Certificate', 'TrainingRecord',
    'ExportJob', 'AccountingExport', 'PayrollExport'
  ]::text[])
$$;
