-- Written by hand (Prisma does not model triggers), after the generated …_security_audit_w2b_schema and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Security and audit in depth (W2b-6, schema wave 52/57, B-W2b-373; security.prisma; PLT-031, PLT-063, PLT-064, PLT-068,
-- PLT-074, PLT-075; Owner answer W2b-6 question 3 = A). These rules hold for every login, the owner included;
-- apps/factory-api's commands (B-W2b-399, B-W2b-404) check them first in words. Every refusal is a check_violation (SQLSTATE
-- 23514) in words. The row guards are AFTER triggers (the policies speak first); the refused changes of the ledgers and the
-- refused deletes are BEFORE triggers. An UPDATE that changes nothing passes. A rule that reads another row skips one the
-- session cannot see (the isolation tests' copies): the policies or the references refuse that write anyway.
--
-- Reused as they are: recall's `factory_recall_words_ok`, `factory_recall_not_future`, `factory_recall_model_name_ok`.
-- No earlier function is redefined. Own triggers on W0 tables: `Role_archive_guard`, `Role_custom_never_deleted`
-- (roles.prisma), `RoleAssignment_role_archived`, `WorkerRole_role_archived` (a live holder of an archived role) and
-- `Session_device_check` (auth.prisma). Role's earlier triggers (`Role_require_mfa_since`, `Role_partner_guard`) and
-- Session's (`Session_audience_guard`: the partner session's 30 minutes and 12 hours) stay as they are: the portal lengths
-- of SecuritySettings never go beyond them.

CREATE FUNCTION "factory_security_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'security: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_security_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'security: % % is kept, never deleted (changed instead)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

-- The append-only ledgers of this wave (scripts/factory/check-append-only.mjs): StepUpAttempt, SecurityEvent and ReadLog. No
-- login changes or removes a row, the owner included; the runtime roles have no UPDATE, DELETE or TRUNCATE grant either.
CREATE FUNCTION "factory_security_ledger_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a step-up try, a security event and a read of a sensitive record are kept as they were written', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- A key of factory-domain's step-up actions (as a permission name: dotted words, e.g. `parties.bank.change`), 1 to 80
-- characters.
CREATE FUNCTION "factory_security_action_key_ok"(action text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT action IS NOT NULL AND char_length(action) <= 80 AND action ~ '^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$'
$$;

-- The record types a read of a sensitive record may name (PLT-074; Owner answer W2b-6 question 3 = A: cost sheets,
-- personal data, certificates, exports). Cost sheets: CostSheet (B-W2b-378's stored sheet). Personal data: Employee, Worker,
-- User, PartyContact, MeasurementProfile, LeaverCase, AbsenceEntry, AttendanceDay, EarningsEntry, WorkerStatement.
-- Certificates: Certificate, TrainingRecord. Exports: ExportJob, AccountingExport, PayrollExport. Protected safety data
-- (health visits, fitness judgements, incidents' people, INAIL filings) keeps its own log, ProtectedView. Another type is a
-- new migration: the read log never grows into a log of everything a person opens.
CREATE FUNCTION "factory_read_log_record_type_ok"(record_type text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT record_type IS NOT NULL AND record_type = ANY (ARRAY[
    'CostSheet',
    'Employee', 'Worker', 'User', 'PartyContact', 'MeasurementProfile', 'LeaverCase', 'AbsenceEntry', 'AttendanceDay', 'EarningsEntry', 'WorkerStatement',
    'Certificate', 'TrainingRecord',
    'ExportJob', 'AccountingExport', 'PayrollExport'
  ]::text[])
$$;

-- One value of a security event's details: a short word or code (1 to 200 characters on one line, never an e-mail address:
-- no `@`), a number, true or false, or null.
CREATE FUNCTION "factory_security_detail_value_ok"(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL
     AND ((jsonb_typeof(value) = 'string' AND btrim(value #>> '{}') <> '' AND char_length(value #>> '{}') <= 200
           AND (value #>> '{}') !~ '[[:cntrl:]]' AND strpos(value #>> '{}', '@') = 0)
          OR jsonb_typeof(value) IN ('number', 'boolean', 'null'))
$$;

-- A security event's details: an object of at most 20 keys (camelCase words), each value one value as above or a list of at
-- most 50 of them; at most 4,000 characters in all.
CREATE FUNCTION "factory_security_details_ok"(details jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry record;
  item jsonb;
BEGIN
  IF details IS NULL OR jsonb_typeof(details) <> 'object' OR char_length(details::text) > 4000 THEN
    RETURN false;
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(details)) > 20 THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT e.key, e.value FROM jsonb_each(details) e LOOP
    IF entry.key !~ '^[a-z][A-Za-z0-9]{0,39}$' THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(entry.value) = 'array' THEN
      IF jsonb_array_length(entry.value) > 50 THEN
        RETURN false;
      END IF;
      FOR item IN SELECT a.value FROM jsonb_array_elements(entry.value) a LOOP
        IF NOT "factory_security_detail_value_ok"(item) THEN
          RETURN false;
        END IF;
      END LOOP;
    ELSIF NOT "factory_security_detail_value_ok"(entry.value) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$$;

-- =====================================================================================================================
-- Role (PLT-031): a custom role is archived, never deleted
--   every row  archived at and by whom, both or neither; a system role is never archived (it follows its template); the
--              time of the archive not in the future.
--   UPDATE     an UPDATE that changes nothing passes; an archived role changes no more (restore it first); archiving and
--              restoring change nothing else (but the version and the time of the change); a role is archived only while
--              nobody holds it (no live assignment: not ended, its end not passed; no live floor role of a worker).
--   DELETE     a custom role is refused (archived instead); a system role may go with its template (the owner's sync).
CREATE FUNCTION "factory_role_archive_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (NEW."archivedAt" IS NULL) <> (NEW."archivedById" IS NULL) THEN
    RAISE EXCEPTION 'roles: role % names when it was archived and by whom, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."archivedAt" IS NOT NULL AND NEW."system" THEN
    RAISE EXCEPTION 'roles: system role % is never archived (it follows its template)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."archivedAt") THEN
    RAISE EXCEPTION 'roles: role % is not archived in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."archivedAt" IS NOT NULL AND NEW."archivedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'roles: role % is archived: it changes no more (restore it first)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."archivedAt" IS NULL) <> (NEW."archivedAt" IS NULL)
       AND (NEW."id", NEW."key", NEW."name", NEW."description", NEW."system", NEW."basedOn", NEW."audience", NEW."requireMfa", NEW."requireMfaSince", NEW."permissions", NEW."grains", NEW."createdAt", NEW."createdById")
           IS DISTINCT FROM (OLD."id", OLD."key", OLD."name", OLD."description", OLD."system", OLD."basedOn", OLD."audience", OLD."requireMfa", OLD."requireMfaSince", OLD."permissions", OLD."grains", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'roles: role % is archived or restored on its own, with no other change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."archivedAt" IS NULL AND NEW."archivedAt" IS NOT NULL
       AND (EXISTS (SELECT 1 FROM "RoleAssignment" a
                     WHERE a."tenantId" = NEW."tenantId" AND a."roleId" = NEW."id" AND a."endedAt" IS NULL AND (a."validTo" IS NULL OR a."validTo" > now()))
            OR EXISTS (SELECT 1 FROM "WorkerRole" w WHERE w."tenantId" = NEW."tenantId" AND w."roleId" = NEW."id" AND w."endedAt" IS NULL)) THEN
      RAISE EXCEPTION 'roles: role % is still held: end its assignments first, then archive it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Role_archive_guard" AFTER INSERT OR UPDATE ON "Role"
  FOR EACH ROW EXECUTE FUNCTION "factory_role_archive_guard"();

CREATE FUNCTION "factory_role_custom_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT OLD."system" THEN
    RAISE EXCEPTION 'roles: custom role % is archived, never deleted (its history is the record)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "Role_custom_never_deleted" BEFORE DELETE ON "Role"
  FOR EACH ROW EXECUTE FUNCTION "factory_role_custom_never_deleted"();

-- ---------------------------------------------------------------------------------------------------------------------
-- RoleAssignment and WorkerRole: an archived role is given to nobody
--   a live assignment (not ended; an office assignment's end not passed) never names an archived role: checked when it is
--   made, moved to another role, or made live again. The role's row is read FOR SHARE, so an archive and a new holder of
--   the same role take turns (the archive's own check then sees the holder).
CREATE FUNCTION "factory_role_assignment_archived_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  archived timestamptz;
BEGIN
  IF NEW."endedAt" IS NOT NULL OR (NEW."validTo" IS NOT NULL AND NEW."validTo" <= now()) THEN
    RETURN NEW;
  END IF;
  SELECT r."archivedAt" INTO archived FROM "Role" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."roleId" FOR SHARE;
  IF FOUND AND archived IS NOT NULL THEN
    RAISE EXCEPTION 'roles: role % is archived: it is given to nobody (assignment %)', NEW."roleId", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RoleAssignment_role_archived" AFTER INSERT OR UPDATE OF "roleId", "endedAt", "validTo" ON "RoleAssignment"
  FOR EACH ROW EXECUTE FUNCTION "factory_role_assignment_archived_check"();

CREATE FUNCTION "factory_worker_role_archived_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  archived timestamptz;
BEGIN
  IF NEW."endedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT r."archivedAt" INTO archived FROM "Role" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."roleId" FOR SHARE;
  IF FOUND AND archived IS NOT NULL THEN
    RAISE EXCEPTION 'roles: role % is archived: it is given to nobody (floor role %)', NEW."roleId", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkerRole_role_archived" AFTER INSERT OR UPDATE OF "roleId", "endedAt" ON "WorkerRole"
  FOR EACH ROW EXECUTE FUNCTION "factory_worker_role_archived_check"();

-- =====================================================================================================================
-- Session (PLT-064): the device and the place
--   every row  the device and the browser 1 to 80 characters on one line; the country ISO 3166-1 alpha-2 (two capitals);
--              the city 1 to 100 characters on one line, only with its country.
--   UPDATE     each is set once (from nothing), never changed or cleared.
CREATE FUNCTION "factory_session_device_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (OLD."deviceLabel" IS NOT NULL AND NEW."deviceLabel" IS DISTINCT FROM OLD."deviceLabel")
       OR (OLD."browser" IS NOT NULL AND NEW."browser" IS DISTINCT FROM OLD."browser")
       OR (OLD."ipCountry" IS NOT NULL AND NEW."ipCountry" IS DISTINCT FROM OLD."ipCountry")
       OR (OLD."ipCity" IS NOT NULL AND NEW."ipCity" IS DISTINCT FROM OLD."ipCity") THEN
      RAISE EXCEPTION 'security: the device, browser and place of session % are set once, never changed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."deviceLabel", 80, false) OR NOT "factory_recall_words_ok"(NEW."browser", 80, false) THEN
    RAISE EXCEPTION 'security: session % names its device and browser in 1 to 80 characters on one line (or not at all)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."ipCountry" IS NOT NULL AND NEW."ipCountry" !~ '^[A-Z]{2}$')
     OR NOT "factory_recall_words_ok"(NEW."ipCity", 100, false)
     OR (NEW."ipCity" IS NOT NULL AND NEW."ipCountry" IS NULL) THEN
    RAISE EXCEPTION 'security: session % names its place as a country (two capitals, ISO 3166-1) and, with it, a city of 1 to 100 characters on one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Session_device_check" AFTER INSERT OR UPDATE OF "deviceLabel", "browser", "ipCountry", "ipCity" ON "Session"
  FOR EACH ROW EXECUTE FUNCTION "factory_session_device_check"();

-- =====================================================================================================================
-- SecuritySettings (PLT-063, PLT-068)
--   every row  office: idle 15 minutes to 24 hours, longest 1 hour to 30 days, never shorter than the idle time; portal:
--              idle 5 to 30 minutes, longest 1 to 12 hours (A1 §3.10's limits, which Session_audience_guard holds on every
--              partner session); step-up: 3 to 10 failures in a row, a lock time of 5 minutes to 24 hours; the actions
--              switched off a list (never NULL) of at most 50 step-up action keys, each once.
--   UPDATE     an UPDATE that changes nothing passes; the creation never changes.
--   DELETE     refused (changed instead). TRUNCATE refused.
CREATE FUNCTION "factory_security_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'security: the creation of security settings % never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."officeIdleMinutes" NOT BETWEEN 15 AND 1440 OR NEW."officeLongestHours" NOT BETWEEN 1 AND 720
     OR NEW."officeIdleMinutes" > NEW."officeLongestHours" * 60 THEN
    RAISE EXCEPTION 'security: an office session of security settings % ends after 15 minutes to 24 hours without use and 1 hour to 30 days after sign-in, never sooner than its idle time (% minutes, % hours)', NEW."id", NEW."officeIdleMinutes", NEW."officeLongestHours"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."portalIdleMinutes" NOT BETWEEN 5 AND 30 OR NEW."portalLongestHours" NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'security: a portal session of security settings % ends after 5 to 30 minutes without use and 1 to 12 hours after sign-in (A1 §3.10; % minutes, % hours)', NEW."id", NEW."portalIdleMinutes", NEW."portalLongestHours"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stepUpMaxFailures" NOT BETWEEN 3 AND 10 OR NEW."stepUpLockMinutes" NOT BETWEEN 5 AND 1440 THEN
    RAISE EXCEPTION 'security: step-up of security settings % locks after 3 to 10 failures in a row, for 5 minutes to 24 hours (% failures, % minutes)', NEW."id", NEW."stepUpMaxFailures", NEW."stepUpLockMinutes"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stepUpOff" IS NULL OR cardinality(NEW."stepUpOff") > 50
     OR EXISTS (SELECT 1 FROM unnest(NEW."stepUpOff") k WHERE NOT "factory_security_action_key_ok"(k))
     OR cardinality(NEW."stepUpOff") <> (SELECT count(DISTINCT k) FROM unnest(NEW."stepUpOff") k) THEN
    RAISE EXCEPTION 'security: security settings % switch step-up off for at most 50 actions, each by its key (dotted words) and once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SecuritySettings_guard" AFTER INSERT OR UPDATE ON "SecuritySettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_security_settings_guard"();
CREATE TRIGGER "SecuritySettings_never_deleted" BEFORE DELETE ON "SecuritySettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_security_never_deleted"();
CREATE TRIGGER "SecuritySettings_no_truncate" BEFORE TRUNCATE ON "SecuritySettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_security_refuse_truncate"();

-- =====================================================================================================================
-- StepUpAttempt (PLT-063): append-only
--   INSERT     the code's fingerprint exactly on SUCCESS: 32 to 200 characters without white space, never digits only (a
--              keyed hash, never the code); a code works once per person (the unique key: a second SUCCESS with the same
--              fingerprint is a unique violation, 23505); the action, when named, a step-up action key; not in the
--              future; on the person's own session (when this session can see it).
--   the lock   step-up of a person is locked while the tenant's number of failures in a row (stepUpMaxFailures: WRONG_CODE
--              or REUSED_CODE since the person's last SUCCESS) fall within its lock time (stepUpLockMinutes) before the
--              try; the defaults 5 and 15 minutes without a SecuritySettings row. It lasts until the lock time has passed
--              since the failure that reached the number. While locked a try is only LOCKED (no code was checked); a LOCKED
--              try only while locked. The tries of one person take turns (a transaction-level advisory lock), so the
--              count is exact.
--   UPDATE, DELETE, TRUNCATE  refused for every login.
CREATE FUNCTION "factory_step_up_attempt_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  session_user_id uuid;
  max_failures integer;
  lock_minutes integer;
  last_success timestamptz;
  reached timestamptz;
BEGIN
  IF (NEW."result" = 'SUCCESS') <> (NEW."codeFingerprint" IS NOT NULL) THEN
    RAISE EXCEPTION 'security: step-up try % keeps the fingerprint of its code exactly when the code worked (SUCCESS)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."codeFingerprint" IS NOT NULL AND (NEW."codeFingerprint" !~ '^\S{32,200}$' OR NEW."codeFingerprint" ~ '^[0-9]+$') THEN
    RAISE EXCEPTION 'security: step-up try % keeps a keyed hash of its code (32 to 200 characters without white space), never the code', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."action" IS NOT NULL AND NOT "factory_security_action_key_ok"(NEW."action") THEN
    RAISE EXCEPTION 'security: step-up try % names its action by its key (dotted words, at most 80 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."at") THEN
    RAISE EXCEPTION 'security: step-up try % is not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."userId" INTO session_user_id FROM "Session" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sessionId";
  IF FOUND AND session_user_id <> NEW."userId" THEN
    RAISE EXCEPTION 'security: step-up try % is on a session of its own person (session % is another person''s)', NEW."id", NEW."sessionId"
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.step-up', NEW."tenantId", NEW."userId"), 0));
  SELECT s."stepUpMaxFailures", s."stepUpLockMinutes" INTO max_failures, lock_minutes
    FROM "SecuritySettings" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."tenantId";
  IF NOT FOUND THEN
    max_failures := 5;
    lock_minutes := 15;
  END IF;
  SELECT max(t."at") INTO last_success FROM "StepUpAttempt" t
   WHERE t."tenantId" = NEW."tenantId" AND t."userId" = NEW."userId" AND t."id" <> NEW."id" AND t."result" = 'SUCCESS' AND t."at" <= NEW."at";
  SELECT t."at" INTO reached FROM "StepUpAttempt" t
   WHERE t."tenantId" = NEW."tenantId" AND t."userId" = NEW."userId" AND t."id" <> NEW."id"
     AND t."result" IN ('WRONG_CODE', 'REUSED_CODE') AND t."at" <= NEW."at"
     AND t."at" > NEW."at" - make_interval(mins => lock_minutes)
     AND (last_success IS NULL OR t."at" > last_success)
   ORDER BY t."at" DESC, t."id" DESC OFFSET max_failures - 1 LIMIT 1;
  IF reached IS NOT NULL AND NEW."result" <> 'LOCKED' THEN
    RAISE EXCEPTION 'security: step-up of person % is locked until % (% failures in a row): try % is recorded as LOCKED, no code is checked', NEW."userId", reached + make_interval(mins => lock_minutes), max_failures, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF reached IS NULL AND NEW."result" = 'LOCKED' THEN
    RAISE EXCEPTION 'security: step-up of person % is not locked: try % is recorded with its result, LOCKED only while step-up is locked', NEW."userId", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "StepUpAttempt_check" AFTER INSERT ON "StepUpAttempt"
  FOR EACH ROW EXECUTE FUNCTION "factory_step_up_attempt_check"();
CREATE TRIGGER "StepUpAttempt_append_only" BEFORE UPDATE OR DELETE ON "StepUpAttempt"
  FOR EACH ROW EXECUTE FUNCTION "factory_security_ledger_change"();
CREATE TRIGGER "StepUpAttempt_no_truncate" BEFORE TRUNCATE ON "StepUpAttempt"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_security_ledger_change"();

-- =====================================================================================================================
-- SecurityEvent (PLT-075): append-only
--   INSERT     the site exactly on a FLOOR event (the device's); a party only on a PORTAL or LINK event; API_KEY_USED only
--              on the API surface; nobody known (no actor) only for SIGN_IN_FAILED and API_KEY_USED; the address as its
--              keyed hash (64 hex characters), never the address; the country two capitals (ISO 3166-1); the record a
--              model name and its id, both or neither; the details as codes (factory_security_details_ok: an object, no
--              e-mail address); not in the future.
--   UPDATE, DELETE, TRUNCATE  refused for every login.
CREATE FUNCTION "factory_security_event_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."surface" = 'FLOOR') <> (NEW."siteId" IS NOT NULL) THEN
    RAISE EXCEPTION 'security: security event % names a site exactly when it came from a floor device (its site)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."partyId" IS NOT NULL AND NEW."surface" NOT IN ('PORTAL', 'LINK') THEN
    RAISE EXCEPTION 'security: security event % names a party only when it came from a portal or a link', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'API_KEY_USED' AND NEW."surface" <> 'API' THEN
    RAISE EXCEPTION 'security: the use of an API key (security event %) comes in through the API', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."actorId" IS NULL AND NEW."kind" NOT IN ('SIGN_IN_FAILED', 'API_KEY_USED') THEN
    RAISE EXCEPTION 'security: security event % (%) names who; only a failed sign-in or an API key''s use may have nobody known', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."ipHash" IS NOT NULL AND NEW."ipHash" !~ '^[0-9a-f]{64}$') OR (NEW."ipCountry" IS NOT NULL AND NEW."ipCountry" !~ '^[A-Z]{2}$') THEN
    RAISE EXCEPTION 'security: security event % keeps the address as its keyed hash (64 hex characters), never the address, and its country as two capitals (ISO 3166-1)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."recordType" IS NULL) <> (NEW."recordId" IS NULL)
     OR (NEW."recordType" IS NOT NULL AND NOT "factory_recall_model_name_ok"(NEW."recordType")) THEN
    RAISE EXCEPTION 'security: security event % names its record by its model name ("Role") and id, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_security_details_ok"(NEW."details") THEN
    RAISE EXCEPTION 'security: the details of security event % are an object of at most 20 keys whose values are short codes, numbers, true or false or lists of them (never an e-mail address; 4,000 characters at most)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."at") THEN
    RAISE EXCEPTION 'security: security event % is not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SecurityEvent_check" AFTER INSERT ON "SecurityEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_security_event_check"();
CREATE TRIGGER "SecurityEvent_append_only" BEFORE UPDATE OR DELETE ON "SecurityEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_security_ledger_change"();
CREATE TRIGGER "SecurityEvent_no_truncate" BEFORE TRUNCATE ON "SecurityEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_security_ledger_change"();

-- =====================================================================================================================
-- ReadLog (PLT-074; Owner answer W2b-6 question 3 = A): append-only
--   INSERT     a record type of the list (factory_read_log_record_type_ok); read in the Office, through the API or sent by
--              a job (OFFICE, API, SYSTEM), never on the floor, in a portal or by a link; by an office person (when this
--              session can see them); not in the future.
--   UPDATE, DELETE, TRUNCATE  refused for every login.
CREATE FUNCTION "factory_read_log_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audience text;
BEGIN
  IF NOT "factory_read_log_record_type_ok"(NEW."recordType") THEN
    RAISE EXCEPTION 'security: read % names a record type that is not a sensitive one of the list (%): the read log keeps cost sheets, personal data, certificates and exports only', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."surface" NOT IN ('OFFICE', 'API', 'SYSTEM') THEN
    RAISE EXCEPTION 'security: read % is an office person''s: in the Office, through the API or sent by a job, never %', NEW."id", NEW."surface"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT u."audience"::text INTO audience FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
  IF FOUND AND audience <> 'OFFICE' THEN
    RAISE EXCEPTION 'security: read % is an office person''s; person % is a % person', NEW."id", NEW."userId", audience
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."at") THEN
    RAISE EXCEPTION 'security: read % is not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReadLog_check" AFTER INSERT ON "ReadLog"
  FOR EACH ROW EXECUTE FUNCTION "factory_read_log_check"();
CREATE TRIGGER "ReadLog_append_only" BEFORE UPDATE OR DELETE ON "ReadLog"
  FOR EACH ROW EXECUTE FUNCTION "factory_security_ledger_change"();
CREATE TRIGGER "ReadLog_no_truncate" BEFORE TRUNCATE ON "ReadLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_security_ledger_change"();
