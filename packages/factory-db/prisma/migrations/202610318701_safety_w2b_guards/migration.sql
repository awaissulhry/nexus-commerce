-- Written by hand (Prisma does not model triggers or partial indexes), after the generated 202610318700_safety_w2b_schema and
-- before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- W2b schema wave 15/16 (B-W2b-87): safety at work. The safety organisation and the RLS notice, typed legal deadlines, risk
-- assessments with their frozen versions, signatures (append-only) and the improvement plan, role sheets with their risks,
-- kits and courses, the course catalogue and requirements, training sessions, attendance signed on the floor, training records
-- (append-only), the instruction register, the PPE catalogue and PPE handed over (append-only, voided by a VOID row) (features
-- QHS-224, QHS-226, QHS-227, QHS-230, QHS-234, QHS-236, QHS-241, QHS-242, QHS-243, QHS-244, QHS-246, QHS-247, QHS-248,
-- QHS-259, QHS-260, QHS-261; D.Lgs. 81/2008 arts. 17, 18, 28, 29, 37, 77). apps/factory-api's modules/safety checks all of this
-- first, in words; these rules hold for every login, the owner included. Every refusal is a check_violation (SQLSTATE 23514).
--
-- As in every guards migration: the tenant and site of a row are held by the policies (USING and WITH CHECK) and the
-- references, not here (no trigger compares "tenantId" or "siteId" of the row it guards, so a row moved out of a session's
-- scope meets row-level security first); a rule that reads another row skips a row this session cannot see (another
-- tenant's or site's: the policies refuse that write anyway); an UPDATE that changes nothing passes. A trigger reads only
-- tables (and columns) the role that fires it may read, and locks a row FOR SHARE only where that role may update it.
-- "Everything but these columns" is compared as jsonb, so a column added later is frozen too unless a later migration names
-- it. "Today" is Europe/Rome's (factory_people_today, …_people_w2b_guards).
--
-- Signatures: FLOOR_PIN is written only by a floor session (current_user factory_floor_runtime: the person's own floor
-- sign-in, after their PIN), OFFICE and PAPER only by the office; a signature is written once. A floor insert of a row of
-- another site than the session's is left to the policies (they refuse it), as wave 14's floor files are. A floor session signs an
-- attendance, countersigns it as the trainer, signs an instruction entry and records PPE received, and changes nothing else.
--
-- REDEFINED, from its whole latest body (rules and words kept; the trigger stays):
--   factory_generated_document_check  (202610318601_plant_care_w2b_guards) a frozen risk assessment (DVR_FROZEN) is of its
--                                     RiskAssessmentVersion's company and site, a PPE receipt (PPE_RECEIPT) of its PpeIssue's
--                                     (the last two record types: no no-op branch is left).
-- NEW TRIGGER on a table of an earlier wave (no earlier function touched):
--   "Employee_role_sheet_check"       the role sheet a person is given is ACTIVE (its site is the reference's).
-- USED FROM EARLIER WAVES, as they are: "factory_people_today" (…_people_w2b_guards).

CREATE FUNCTION "factory_safety_w2b_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'safety: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['SafetyAppointment', 'RlsNotice', 'SafetyDeadline', 'RiskAssessment', 'RiskAssessmentVersion', 'RiskMeasure', 'RoleSheet',
                              'RoleSheetItem', 'SafetyCourse', 'TrainingRequirement', 'TrainingSession', 'TrainingAttendance', 'InstructionRecord',
                              'PpeItem', 'PpeKitLine'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_safety_w2b_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- Words: not blank (NULL: not given, which the caller allows or not).
CREATE FUNCTION "factory_safety_text_ok"(words text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT words IS NULL OR btrim(words) <> ''
$$;

-- A code: not blank, no spaces.
CREATE FUNCTION "factory_safety_code_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(code) <> '' AND code !~ '\s'
$$;

-- A name in other languages: NULL, or an object of language code → words.
CREATE FUNCTION "factory_safety_i18n_ok"(names jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT names IS NULL
      OR (jsonb_typeof(names) = 'object'
          AND NOT EXISTS (SELECT 1 FROM jsonb_each(names) e WHERE e.key !~ '^[a-z]{2,3}$' OR jsonb_typeof(e.value) <> 'string' OR btrim(e.value #>> '{}') = ''))
$$;

-- A SHA-256 in lower-case hex (NULL: not given).
CREATE FUNCTION "factory_safety_sha_ok"(sha text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT sha IS NULL OR sha ~ '^[0-9a-f]{64}$'
$$;

-- The worker a floor signature names is the person's own floor sign-in at the row's site (NULL: not visible here, so the
-- policies decide).
CREATE FUNCTION "factory_safety_worker_is"(tenant uuid, site uuid, worker uuid, employee uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT w."employeeId" = employee FROM "Worker" w WHERE w."tenantId" = tenant AND w."siteId" = site AND w."id" = worker), true)
$$;

-- =====================================================================================================================
-- SafetyAppointment (QHS-224)
--   every row  a person of the company or an outside contact by name (with its party and contact when known), exactly one; an
--              RLS is a person of the company, an RLST an outside contact; only a first-aid or fire team names a shift; it
--              ends on or after its first day, with the reason only when it has a last day; the appointee's signature has its
--              time, method (OFFICE or PAPER), the name as signed and the office user, all together.
--   INSERT     a person who works for the company (ACTIVE).
--   UPDATE     the company, role, appointee, shift, first day and creation never change (a new term is a new appointment); the
--              signature is written once.
--   DELETE     refused (ended). TRUNCATE refused.
CREATE FUNCTION "factory_safety_appointment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['untilDate', 'endReason', 'signedAt', 'signMethod', 'signedName', 'signedById', 'note', 'version', 'updatedAt'];
  person_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety: appointment % is ended (its last day), never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (NEW."employeeId" IS NOT NULL) = (NEW."outsideName" IS NOT NULL)
     OR (NEW."employeeId" IS NOT NULL AND (NEW."outsidePartyId" IS NOT NULL OR NEW."outsideContactId" IS NOT NULL))
     OR (NEW."outsideContactId" IS NOT NULL AND NEW."outsidePartyId" IS NULL)
     OR NOT "factory_safety_text_ok"(NEW."outsideName") THEN
    RAISE EXCEPTION 'safety: appointment % names a person of the company or an outside contact by name (with its party and contact when known), exactly one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."role" = 'RLS' AND NEW."employeeId" IS NULL THEN
    RAISE EXCEPTION 'safety: an RLS is a person of the company, elected or designated among the workers (D.Lgs. 81/2008 art. 47); a territorial RLS is an RLST (appointment %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."role" = 'RLST' AND NEW."employeeId" IS NOT NULL THEN
    RAISE EXCEPTION 'safety: a territorial RLS (RLST, art. 48) is an outside contact, not a person of the company (appointment %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shiftPatternId" IS NOT NULL AND NEW."role" NOT IN ('FIRST_AID', 'FIRE_EMERGENCY') THEN
    RAISE EXCEPTION 'safety: only a first-aid or fire and emergency team is appointed per shift (appointment % is %)', NEW."id", NEW."role"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."untilDate" IS NOT NULL AND NEW."untilDate" < NEW."fromDate")
     OR (NEW."endReason" IS NOT NULL AND (NEW."untilDate" IS NULL OR btrim(NEW."endReason") = '')) THEN
    RAISE EXCEPTION 'safety: appointment % ends on or after its first day, and says why it ended only with its last day', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."signedAt" IS NULL) <> (NEW."signMethod" IS NULL) OR (NEW."signedAt" IS NULL) <> (NEW."signedName" IS NULL)
     OR (NEW."signedAt" IS NULL) <> (NEW."signedById" IS NULL) OR NEW."signMethod" = 'FLOOR_PIN' OR NOT "factory_safety_text_ok"(NEW."signedName") THEN
    RAISE EXCEPTION 'safety: the appointee''s signature of appointment % has its time, its method (OFFICE or PAPER), the name as signed and the office user who signed or recorded it, all together', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."employeeId" IS NOT NULL THEN
      SELECT e."status"::text INTO person_status FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."employeeId";
      IF FOUND AND person_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'safety: appointment % appoints a person who works for the company (employee % is %)', NEW."id", NEW."employeeId", person_status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'safety: the company, role, appointee, shift, first day and creation of appointment % never change; a new term is a new appointment', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."signedAt" IS NOT NULL
     AND (NEW."signedAt", NEW."signMethod", NEW."signedName", NEW."signedById") IS DISTINCT FROM (OLD."signedAt", OLD."signMethod", OLD."signedName", OLD."signedById") THEN
    RAISE EXCEPTION 'safety: the appointee''s signature of appointment % is written once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SafetyAppointment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SafetyAppointment"
  FOR EACH ROW EXECUTE FUNCTION "factory_safety_appointment_guard"();

-- =====================================================================================================================
-- RlsNotice (QHS-226; art. 18 c.1 aa)
--   every row  FILED exactly with its day, INAIL's reference and who recorded it; CANCELLED exactly with its time and reason.
--   INSERT     PENDING, or FILED (a notice filed before it was recorded here); of an RLS or RLST appointment.
--   UPDATE     the company, appointment and creation never change; PENDING → FILED | CANCELLED; FILED and CANCELLED are final
--              (only the note changes).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_rls_notice_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  movable CONSTANT text[] := ARRAY['dueOn', 'status', 'filedOn', 'reference', 'filedById', 'cancelledAt', 'cancelReason', 'note', 'version', 'updatedAt'];
  appointed text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety: RLS notice % is filed or cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (NEW."status" = 'FILED') <> (NEW."filedOn" IS NOT NULL AND NEW."reference" IS NOT NULL AND btrim(NEW."reference") <> '' AND NEW."filedById" IS NOT NULL)
     OR (NEW."status" <> 'FILED' AND (NEW."filedOn" IS NOT NULL OR NEW."reference" IS NOT NULL OR NEW."filedById" IS NOT NULL))
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL AND NEW."cancelReason" IS NOT NULL AND btrim(NEW."cancelReason") <> '')
     OR (NEW."status" <> 'CANCELLED' AND (NEW."cancelledAt" IS NOT NULL OR NEW."cancelReason" IS NOT NULL)) THEN
    RAISE EXCEPTION 'safety: RLS notice % is FILED exactly with its day, INAIL''s reference and who recorded it, and CANCELLED exactly with its time and reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'safety: RLS notice % starts PENDING (or FILED, when it was filed before it was recorded)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT a."role"::text INTO appointed FROM "SafetyAppointment" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."appointmentId";
    IF FOUND AND appointed NOT IN ('RLS', 'RLST') THEN
      RAISE EXCEPTION 'safety: RLS notice % notifies an RLS or RLST appointment, not a % one', NEW."id", appointed
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'safety: the company, appointment and creation of RLS notice % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'PENDING'
     AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
    RAISE EXCEPTION 'safety: RLS notice % is %; only its note changes', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RlsNotice_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RlsNotice"
  FOR EACH ROW EXECUTE FUNCTION "factory_rls_notice_guard"();

-- =====================================================================================================================
-- SafetyDeadline (QHS-227)
--   every row  a title; repeat every 1 to 120 weeks, months or years (both or neither); DONE exactly with when and who (a note
--              only then); CANCELLED exactly with its time and reason.
--   INSERT     OPEN; the occurrence before (when named) of the same company and kind, repeating, DONE or CANCELLED; one next
--              per occurrence (the partial unique index below).
--   UPDATE     the company, kind, occurrence before and creation never change; OPEN → DONE (with an AVAILABLE file of the row
--              when evidence is required) | CANCELLED; DONE and CANCELLED are final (only the note changes).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_safety_deadline_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['title', 'dueOn', 'repeatEvery', 'repeatUnit', 'ownerId', 'evidenceRequired', 'status', 'doneAt', 'doneById', 'doneNote',
                                   'cancelledAt', 'cancelReason', 'note', 'version', 'updatedAt'];
  before record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety: deadline % is done or cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF btrim(NEW."title") = '' THEN
    RAISE EXCEPTION 'safety: deadline % has a title', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."repeatEvery" IS NULL) <> (NEW."repeatUnit" IS NULL) OR NEW."repeatEvery" < 1 OR NEW."repeatEvery" > 120 THEN
    RAISE EXCEPTION 'safety: deadline % repeats every 1 to 120 weeks, months or years (both or neither), not % %', NEW."id", coalesce(NEW."repeatEvery"::text, '-'), coalesce(NEW."repeatUnit"::text, '-')
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DONE') <> (NEW."doneAt" IS NOT NULL AND NEW."doneById" IS NOT NULL)
     OR (NEW."status" <> 'DONE' AND (NEW."doneAt" IS NOT NULL OR NEW."doneById" IS NOT NULL OR NEW."doneNote" IS NOT NULL))
     OR NOT "factory_safety_text_ok"(NEW."doneNote")
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL AND NEW."cancelReason" IS NOT NULL AND btrim(NEW."cancelReason") <> '')
     OR (NEW."status" <> 'CANCELLED' AND (NEW."cancelledAt" IS NOT NULL OR NEW."cancelReason" IS NOT NULL)) THEN
    RAISE EXCEPTION 'safety: deadline % is DONE exactly with when and who (a note only then), and CANCELLED exactly with its time and reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'safety: deadline % starts OPEN', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."previousId" IS NOT NULL THEN
      SELECT d."companyId", d."kind"::text AS kind, d."status"::text AS status, d."repeatEvery" INTO before
        FROM "SafetyDeadline" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."previousId";
      IF FOUND AND (before."companyId" <> NEW."companyId" OR before.kind <> NEW."kind"::text OR before."repeatEvery" IS NULL OR before.status = 'OPEN') THEN
        RAISE EXCEPTION 'safety: deadline % follows a repeating deadline of its company and kind that is done or cancelled (deadline % is %)', NEW."id", NEW."previousId", before.status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'safety: the company, kind, occurrence before and creation of deadline % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'OPEN'
     AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
    RAISE EXCEPTION 'safety: deadline % is %; only its note changes', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'DONE' AND OLD."status" = 'OPEN' AND NEW."evidenceRequired"
     AND NOT EXISTS (SELECT 1 FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."recordType" = 'SafetyDeadline' AND f."recordId" = NEW."id" AND f."status" = 'AVAILABLE') THEN
    RAISE EXCEPTION 'safety: deadline % asks for evidence; it is done once a file of it is uploaded', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SafetyDeadline_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SafetyDeadline"
  FOR EACH ROW EXECUTE FUNCTION "factory_safety_deadline_guard"();

-- One next occurrence per deadline.
CREATE UNIQUE INDEX "SafetyDeadline_one_next" ON "SafetyDeadline" ("tenantId", "previousId") WHERE "previousId" IS NOT NULL;

-- =====================================================================================================================
-- RiskAssessment (QHS-230)
--   every row  a name.  INSERT  ACTIVE.  UPDATE  the company and creation never change.  DELETE, TRUNCATE  refused (archived).
CREATE FUNCTION "factory_risk_assessment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['name', 'nextReviewOn', 'status', 'note', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety: risk assessment % is archived, never deleted (its versions are the DVR''s history)', OLD."name"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF btrim(NEW."name") = '' THEN
    RAISE EXCEPTION 'safety: risk assessment % has a name (the site or production unit it covers)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'safety: risk assessment % starts ACTIVE', NEW."name"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'safety: the company and creation of risk assessment % never change', OLD."name"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RiskAssessment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RiskAssessment"
  FOR EACH ROW EXECUTE FUNCTION "factory_risk_assessment_guard"();

-- =====================================================================================================================
-- RiskAssessmentVersion (QHS-230; art. 28 c.2)
--   every row  a number from 1, a label and an author; a summary not blank when given; a SHA-256; the signers: the employer,
--              and of RSPP, RLS or RLST (not both), DOCTOR, each once; SIGNED exactly with its certain date and time; WITHDRAWN
--              exactly with its time and reason.
--   INSERT     AWAITING_SIGNATURES, on an ACTIVE assessment, numbered above every earlier version of it; the PDF is an
--              AVAILABLE file of the assessment and of its company, and the SHA-256 is the file's when the file has one.
--   UPDATE     nothing but the status and its columns ever changes (frozen); AWAITING_SIGNATURES → SIGNED (every listed signer
--              signed; the certain date is the day of the last of those signatures) | WITHDRAWN; SIGNED and WITHDRAWN are final.
--   DELETE     refused (superseded versions stay). TRUNCATE refused.
CREATE FUNCTION "factory_risk_assessment_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['status', 'certainDateOn', 'signedAt', 'withdrawnAt', 'withdrawnReason', 'version', 'updatedAt'];
  assessment_status text;
  file record;
  signed_roles text[];
  last_day date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety: DVR version % is never deleted; a superseded version stays', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW."versionNo" < 1 OR btrim(NEW."label") = '' OR btrim(NEW."authorName") = '' OR NOT "factory_safety_text_ok"(NEW."changeSummary")
     OR NEW."sha256" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'safety: DVR version % has a number from 1, a label, an author, a summary when given and the SHA-256 of its PDF (lower-case hex)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ('EMPLOYER' = ANY (NEW."signersRequired"))
     OR EXISTS (SELECT 1 FROM unnest(NEW."signersRequired") r WHERE r::text NOT IN ('EMPLOYER', 'RSPP', 'RLS', 'RLST', 'DOCTOR'))
     OR cardinality(NEW."signersRequired") <> (SELECT count(DISTINCT r) FROM unnest(NEW."signersRequired") r)
     OR ('RLS' = ANY (NEW."signersRequired") AND 'RLST' = ANY (NEW."signersRequired")) THEN
    RAISE EXCEPTION 'safety: DVR version % is signed by the employer and, for the proof of its date, by those of the RSPP, the RLS or RLST and the doctor the company has, each once (art. 28 c.2)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'SIGNED') <> (NEW."certainDateOn" IS NOT NULL AND NEW."signedAt" IS NOT NULL)
     OR (NEW."status" <> 'SIGNED' AND (NEW."certainDateOn" IS NOT NULL OR NEW."signedAt" IS NOT NULL))
     OR (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL AND NEW."withdrawnReason" IS NOT NULL AND btrim(NEW."withdrawnReason") <> '')
     OR (NEW."status" <> 'WITHDRAWN' AND (NEW."withdrawnAt" IS NOT NULL OR NEW."withdrawnReason" IS NOT NULL)) THEN
    RAISE EXCEPTION 'safety: DVR version % is SIGNED exactly with its certain date and time, WITHDRAWN exactly with its time and reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'AWAITING_SIGNATURES' THEN
      RAISE EXCEPTION 'safety: DVR version % starts AWAITING_SIGNATURES (frozen, then signed)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT a."status"::text INTO assessment_status FROM "RiskAssessment" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."assessmentId";
    IF FOUND AND assessment_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'safety: risk assessment % is archived; it takes no new version', NEW."assessmentId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "RiskAssessmentVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."assessmentId" = NEW."assessmentId" AND v."id" <> NEW."id" AND v."versionNo" >= NEW."versionNo") THEN
      RAISE EXCEPTION 'safety: DVR version % is numbered above every earlier version of its assessment (not %)', NEW."id", NEW."versionNo"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT f."recordType", f."recordId", f."companyId", f."status"::text AS status, f."sha256" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
    IF FOUND AND ((file."recordType", file."recordId", file."companyId") IS DISTINCT FROM ('RiskAssessment', NEW."assessmentId", NEW."companyId")
                  OR file.status <> 'AVAILABLE' OR (file."sha256" IS NOT NULL AND lower(file."sha256") <> NEW."sha256")) THEN
      RAISE EXCEPTION 'safety: the PDF of DVR version % is an uploaded (AVAILABLE) file of its assessment and company, and its SHA-256 is the file''s', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'safety: DVR version % is frozen: its PDF, SHA-256, number, label, dates, author and signers never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'AWAITING_SIGNATURES' THEN
    RAISE EXCEPTION 'safety: DVR version % is %; it changes no more', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'SIGNED' THEN
    SELECT array_agg(s."role"::text), max(s."signedOn") INTO signed_roles, last_day
      FROM "RiskAssessmentSignature" s WHERE s."tenantId" = NEW."tenantId" AND s."versionId" = NEW."id" AND s."role" = ANY (NEW."signersRequired");
    IF NOT (NEW."signersRequired"::text[] <@ coalesce(signed_roles, '{}'::text[])) THEN
      RAISE EXCEPTION 'safety: DVR version % is signed once each of its signers (%) has signed (signed so far: %)', NEW."id", array_to_string(NEW."signersRequired"::text[], ', '), coalesce(array_to_string(signed_roles, ', '), 'none')
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."certainDateOn" <> last_day THEN
      RAISE EXCEPTION 'safety: the certain date of DVR version % is the day of its last signature (%), not %', NEW."id", last_day, NEW."certainDateOn"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RiskAssessmentVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RiskAssessmentVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_risk_assessment_version_guard"();

-- =====================================================================================================================
-- RiskAssessmentSignature (QHS-230), append-only
--   INSERT     its key starts `signature:<version>:<role>` (one per role per version); a signer name and the SHA-256 signed;
--              OFFICE and PAPER name the office user (never a worker), FLOOR_PIN a worker of the site (never a user); the
--              version is AWAITING_SIGNATURES, lists the role, and its SHA-256 is the one signed; signed on a day from the day
--              it was frozen up to today; the appointment (when named) is to that role.
--   UPDATE, DELETE, TRUNCATE  refused for every login.
CREATE FUNCTION "factory_risk_assessment_signature_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'safety: a DVR signature is never changed or removed (%)', TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_risk_assessment_signature_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  dvr record;
  appointed text;
BEGIN
  IF position(('signature:' || NEW."versionId"::text || ':' || NEW."role"::text) IN NEW."key") <> 1 THEN
    RAISE EXCEPTION 'safety: DVR signature % has the key signature:<its version>:<its role> (one per role per version)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."signerName") = '' OR NEW."signatureSha256" !~ '^[0-9a-f]{64}$'
     OR (NEW."method" = 'FLOOR_PIN') <> (NEW."signedByWorkerId" IS NOT NULL)
     OR (NEW."method" <> 'FLOOR_PIN') <> (NEW."signedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'safety: DVR signature % has the signer''s name, the SHA-256 signed and who signed: the office user (OFFICE, PAPER) or the worker (FLOOR_PIN), exactly one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."signedOn" > "factory_people_today"() THEN
    RAISE EXCEPTION 'safety: DVR signature % is dated today at the latest, not %', NEW."id", NEW."signedOn"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT v."status"::text AS status, v."signersRequired"::text[] AS signers, v."sha256", (v."frozenAt" AT TIME ZONE 'Europe/Rome')::date AS frozen_on INTO dvr
    FROM "RiskAssessmentVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."versionId";
  IF FOUND THEN
    IF dvr.status <> 'AWAITING_SIGNATURES' THEN
      RAISE EXCEPTION 'safety: DVR version % is %; it takes no more signatures', NEW."versionId", dvr.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (NEW."role"::text = ANY (dvr.signers)) THEN
      RAISE EXCEPTION 'safety: DVR version % is not signed by the % (its signers: %)', NEW."versionId", NEW."role", array_to_string(dvr.signers, ', ')
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signatureSha256" <> dvr."sha256" THEN
      RAISE EXCEPTION 'safety: DVR signature % signs the version''s SHA-256 (the frozen PDF), not another', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signedOn" < dvr.frozen_on THEN
      RAISE EXCEPTION 'safety: DVR signature % is dated on or after the version was frozen (%)', NEW."id", dvr.frozen_on
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."appointmentId" IS NOT NULL THEN
    SELECT a."role"::text INTO appointed FROM "SafetyAppointment" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."appointmentId";
    IF FOUND AND appointed <> NEW."role"::text THEN
      RAISE EXCEPTION 'safety: DVR signature % for the % names an appointment to that role, not a % one', NEW."id", NEW."role", appointed
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RiskAssessmentSignature_check" BEFORE INSERT ON "RiskAssessmentSignature"
  FOR EACH ROW EXECUTE FUNCTION "factory_risk_assessment_signature_check"();
CREATE TRIGGER "RiskAssessmentSignature_append_only" BEFORE UPDATE OR DELETE ON "RiskAssessmentSignature"
  FOR EACH ROW EXECUTE FUNCTION "factory_risk_assessment_signature_append_only"();
CREATE TRIGGER "RiskAssessmentSignature_no_truncate" BEFORE TRUNCATE ON "RiskAssessmentSignature"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_risk_assessment_signature_append_only"();

-- =====================================================================================================================
-- RiskMeasure (QHS-234; art. 28 c.2 c-d)
--   every row  a title; the risk not blank when given; cost from 0; DVR exactly with its version (of this assessment); the source
--              record both or neither, an INCIDENT always with its record; role sheets each once; done (when and who) exactly from
--              DONE on; verified exactly when VERIFIED; cancelled exactly with its time and reason.
--   INSERT     PLANNED or IN_PROGRESS; its role sheets are of its site.
--   UPDATE     the company, assessment, source and creation never change; PLANNED ↔ IN_PROGRESS, either → DONE | CANCELLED, DONE →
--              VERIFIED | IN_PROGRESS; VERIFIED and CANCELLED are final (only the note changes); new role sheets of its site.
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_risk_measure_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['title', 'risk', 'roleSheetIds', 'ownerId', 'dueOn', 'cost', 'status', 'doneAt', 'doneById', 'evidenceNote', 'verifiedAt',
                                   'verifiedById', 'cancelledAt', 'cancelReason', 'note', 'version', 'updatedAt'];
  sheets_found int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety: measure % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF btrim(NEW."title") = '' OR NOT "factory_safety_text_ok"(NEW."risk") OR NEW."cost" < 0 THEN
    RAISE EXCEPTION 'safety: measure % has a title, the risk when given and a cost from 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."source" = 'DVR') <> (NEW."versionId" IS NOT NULL)
     OR (NEW."sourceRecordType" IS NULL) <> (NEW."sourceRecordId" IS NULL) OR NOT "factory_safety_code_ok"(coalesce(NEW."sourceRecordType", 'x'))
     OR (NEW."source" = 'DVR' AND NEW."sourceRecordType" IS NOT NULL)
     OR (NEW."source" = 'INCIDENT' AND NEW."sourceRecordType" IS NULL) THEN
    RAISE EXCEPTION 'safety: measure % from % names its source: a DVR version (only), an incident''s record, another record when there is one (type and id together)', NEW."id", NEW."source"
      USING ERRCODE = 'check_violation';
  END IF;
  IF array_position(NEW."roleSheetIds", NULL) IS NOT NULL OR cardinality(NEW."roleSheetIds") <> (SELECT count(DISTINCT r) FROM unnest(NEW."roleSheetIds") r) THEN
    RAISE EXCEPTION 'safety: measure % names each role sheet once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('DONE', 'VERIFIED')) <> (NEW."doneAt" IS NOT NULL AND NEW."doneById" IS NOT NULL)
     OR (NEW."status" NOT IN ('DONE', 'VERIFIED') AND (NEW."doneAt" IS NOT NULL OR NEW."doneById" IS NOT NULL))
     OR (NEW."status" = 'VERIFIED') <> (NEW."verifiedAt" IS NOT NULL AND NEW."verifiedById" IS NOT NULL)
     OR (NEW."status" <> 'VERIFIED' AND (NEW."verifiedAt" IS NOT NULL OR NEW."verifiedById" IS NOT NULL))
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL AND NEW."cancelReason" IS NOT NULL AND btrim(NEW."cancelReason") <> '')
     OR (NEW."status" <> 'CANCELLED' AND (NEW."cancelledAt" IS NOT NULL OR NEW."cancelReason" IS NOT NULL))
     OR NOT "factory_safety_text_ok"(NEW."evidenceNote") THEN
    RAISE EXCEPTION 'safety: measure % is % with the wrong times: done (when and who) from DONE on, verified exactly when VERIFIED, cancelled exactly with its time and reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('PLANNED', 'IN_PROGRESS') THEN
      RAISE EXCEPTION 'safety: measure % starts PLANNED or IN_PROGRESS', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
      RAISE EXCEPTION 'safety: the company, assessment, source and creation of measure % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('VERIFIED', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'safety: measure % is %; only its note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'PLANNED' AND NEW."status" IN ('IN_PROGRESS', 'DONE', 'CANCELLED'))
                OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('PLANNED', 'DONE', 'CANCELLED'))
                OR (OLD."status" = 'DONE' AND NEW."status" IN ('VERIFIED', 'IN_PROGRESS'))) THEN
      RAISE EXCEPTION 'safety: measure % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF cardinality(NEW."roleSheetIds") > 0 AND (TG_OP = 'INSERT' OR NEW."roleSheetIds" IS DISTINCT FROM OLD."roleSheetIds") THEN
    SELECT count(*) INTO sheets_found FROM "RoleSheet" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = ANY (NEW."roleSheetIds");
    IF sheets_found <> cardinality(NEW."roleSheetIds") THEN
      RAISE EXCEPTION 'safety: measure % names role sheets of its own site only', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RiskMeasure_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RiskMeasure"
  FOR EACH ROW EXECUTE FUNCTION "factory_risk_measure_guard"();

-- =====================================================================================================================
-- RoleSheet (QHS-236)
--   every row  a code (no spaces), a name, its names in other languages, a description not blank when given.
--   INSERT     ACTIVE.
--   UPDATE     the company, code and creation never change; ARCHIVED only when no ACTIVE person is in the role.
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_role_sheet_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['name', 'nameI18n', 'description', 'status', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety: role sheet % is archived, never deleted', OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NOT "factory_safety_code_ok"(NEW."code") OR btrim(NEW."name") = '' OR NOT "factory_safety_i18n_ok"(NEW."nameI18n") OR NOT "factory_safety_text_ok"(NEW."description") THEN
    RAISE EXCEPTION 'safety: role sheet % has a code (no spaces), a name, its names in other languages ({ "it": "…" }) and a description when given', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'safety: role sheet % starts ACTIVE', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'safety: the company, code and creation of role sheet % never change', OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'ARCHIVED' AND OLD."status" = 'ACTIVE'
     AND EXISTS (SELECT 1 FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."roleSheetId" = NEW."id" AND e."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'safety: role sheet % is archived once nobody active is in the role (move them to another sheet first)', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RoleSheet_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RoleSheet"
  FOR EACH ROW EXECUTE FUNCTION "factory_role_sheet_guard"();

-- The role sheet a person is given is ACTIVE (a sheet of their site: the reference). Employee's own guard is untouched.
CREATE FUNCTION "factory_employee_role_sheet_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sheet_status text;
BEGIN
  IF NEW."roleSheetId" IS NULL OR (TG_OP = 'UPDATE' AND NEW."roleSheetId" IS NOT DISTINCT FROM OLD."roleSheetId") THEN
    RETURN NEW;
  END IF;
  SELECT s."status"::text INTO sheet_status FROM "RoleSheet" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."roleSheetId";
  IF FOUND AND sheet_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'safety: employee % is given an ACTIVE role sheet (role sheet % is archived)', NEW."id", NEW."roleSheetId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Employee_role_sheet_check" BEFORE INSERT OR UPDATE OF "roleSheetId" ON "Employee"
  FOR EACH ROW EXECUTE FUNCTION "factory_employee_role_sheet_check"();

-- =====================================================================================================================
-- RoleSheetItem (QHS-236)
--   every row  a place from 1 and words.
--   INSERT, UPDATE, DELETE  only while its sheet is ACTIVE (FOR SHARE); its sheet and creation never change.
CREATE FUNCTION "factory_role_sheet_item_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sheet record;
  row_now "RoleSheetItem";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  row_now := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_OP <> 'DELETE' AND (NEW."seq" < 1 OR btrim(NEW."title") = '' OR NOT "factory_safety_text_ok"(NEW."note")) THEN
    RAISE EXCEPTION 'safety: role sheet item % has a place from 1 and its words', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."roleSheetId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."roleSheetId", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'safety: role sheet item % stays on its sheet', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."code", s."status"::text AS status INTO sheet FROM "RoleSheet" s WHERE s."tenantId" = row_now."tenantId" AND s."id" = row_now."roleSheetId" FOR SHARE;
  IF FOUND AND sheet.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'safety: role sheet % is archived; its risks and surveillance needs no longer change', sheet."code"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER "RoleSheetItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RoleSheetItem"
  FOR EACH ROW EXECUTE FUNCTION "factory_role_sheet_item_guard"();

-- =====================================================================================================================
-- SafetyCourse (QHS-241)
--   every row  a code (no spaces), a name and the legal basis; names in other languages; hours above 0, at most 200; a refresher
--              every 1 to 120 months, its hours (above 0, at most 200) only with it; a provider not blank when given.
--   INSERT     ACTIVE.  UPDATE  the company, code, type and creation never change.  DELETE, TRUNCATE  refused (archived).
CREATE FUNCTION "factory_safety_course_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  movable CONSTANT text[] := ARRAY['name', 'nameI18n', 'hours', 'refresherMonths', 'refresherHours', 'inPersonRequired', 'provider', 'legalBasis', 'sortOrder',
                                   'status', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety: course % is archived, never deleted (training records name it)', OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NOT "factory_safety_code_ok"(NEW."code") OR btrim(NEW."name") = '' OR btrim(NEW."legalBasis") = '' OR NOT "factory_safety_i18n_ok"(NEW."nameI18n")
     OR NOT "factory_safety_text_ok"(NEW."provider") THEN
    RAISE EXCEPTION 'safety: course % has a code (no spaces), a name, the legal basis it rests on, its names in other languages and a provider when given', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."hours" <= 0 OR NEW."hours" > 200 OR NEW."refresherMonths" < 1 OR NEW."refresherMonths" > 120
     OR (NEW."refresherHours" IS NOT NULL AND (NEW."refresherMonths" IS NULL OR NEW."refresherHours" <= 0 OR NEW."refresherHours" > 200)) THEN
    RAISE EXCEPTION 'safety: course % lasts above 0 and at most 200 hours, and its refresher comes every 1 to 120 months (its hours only with it)', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'safety: course % starts ACTIVE', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'safety: the company, code, type and creation of course % never change', OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SafetyCourse_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SafetyCourse"
  FOR EACH ROW EXECUTE FUNCTION "factory_safety_course_guard"();

-- =====================================================================================================================
-- TrainingRequirement (QHS-242)
--   every row  a role sheet exactly for ROLE_SHEET, a machine class exactly for MACHINE_CLASS; within 0 to 365 days when given.
--   INSERT     an ACTIVE course (tenant-wide or of the sheet's company), an ACTIVE sheet, an active class.
--   UPDATE     only the days and the note change.
--   DELETE     allowed (the requirement is no longer asked).
CREATE FUNCTION "factory_training_requirement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  course record;
  sheet record;
  class_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (NEW."source" = 'ROLE_SHEET') <> (NEW."roleSheetId" IS NOT NULL) OR (NEW."source" = 'MACHINE_CLASS') <> (NEW."machineClassId" IS NOT NULL)
     OR NEW."withinDays" < 0 OR NEW."withinDays" > 365 OR NOT "factory_safety_text_ok"(NEW."note") THEN
    RAISE EXCEPTION 'safety: requirement % names its role sheet (ROLE_SHEET) or its machine class (MACHINE_CLASS), exactly one, and is due within 0 to 365 days when given', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['tenantId', 'withinDays', 'note', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['tenantId', 'withinDays', 'note', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'safety: requirement % keeps its source and course; another course is another requirement', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT c."code", c."companyId", c."status"::text AS status INTO course FROM "SafetyCourse" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."courseId";
  IF FOUND AND course.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'safety: course % is archived; no role or machine asks it anew', course."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."roleSheetId" IS NOT NULL THEN
    SELECT s."code", s."companyId", s."status"::text AS status INTO sheet FROM "RoleSheet" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."roleSheetId";
    IF FOUND AND sheet.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'safety: role sheet % is archived; it asks no new course', sheet."code"
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND course."companyId" IS NOT NULL AND course."companyId" <> sheet."companyId" THEN
      RAISE EXCEPTION 'safety: role sheet % asks a course of its company or of the whole group (course % is another company''s)', sheet."code", course."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."machineClassId" IS NOT NULL THEN
    SELECT m."active" INTO class_active FROM "MachineClass" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."machineClassId";
    IF FOUND AND NOT class_active THEN
      RAISE EXCEPTION 'safety: machine class % is retired; it asks no new course', NEW."machineClassId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "TrainingRequirement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TrainingRequirement"
  FOR EACH ROW EXECUTE FUNCTION "factory_training_requirement_guard"();

-- =====================================================================================================================
-- TrainingSession (QHS-248)
--   every row  hours above 0, at most 24; a two-letter language; the trainer's name; closed (when, who) exactly when CLOSED,
--              cancelled (when, why) exactly when CANCELLED.
--   INSERT     OPEN; an ACTIVE course of the whole group or the session's company; an ACTIVE trainer.
--   UPDATE     the company, course, who opened it and creation never change; OPEN → CLOSED (held today at the latest) |
--              CANCELLED (while no training record came from it); CLOSED and CANCELLED are final (only the note changes).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_training_session_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['heldOn', 'hours', 'language', 'trainerEmployeeId', 'trainerName', 'providerPartyId', 'location', 'status', 'closedAt',
                                   'closedById', 'cancelledAt', 'cancelReason', 'note', 'version', 'updatedAt'];
  course record;
  trainer_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety: training session % is closed or cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW."hours" <= 0 OR NEW."hours" > 24 OR NEW."language" !~ '^[a-z]{2}$' OR btrim(NEW."trainerName") = '' OR NOT "factory_safety_text_ok"(NEW."location") THEN
    RAISE EXCEPTION 'safety: training session % lasts above 0 and at most 24 hours, in a two-letter language, with its trainer''s name', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL AND NEW."closedById" IS NOT NULL)
     OR (NEW."status" <> 'CLOSED' AND (NEW."closedAt" IS NOT NULL OR NEW."closedById" IS NOT NULL))
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL AND NEW."cancelReason" IS NOT NULL AND btrim(NEW."cancelReason") <> '')
     OR (NEW."status" <> 'CANCELLED' AND (NEW."cancelledAt" IS NOT NULL OR NEW."cancelReason" IS NOT NULL)) THEN
    RAISE EXCEPTION 'safety: training session % is CLOSED exactly with when and who, CANCELLED exactly with its time and reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."trainerEmployeeId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."trainerEmployeeId" IS DISTINCT FROM OLD."trainerEmployeeId") THEN
    SELECT e."status"::text INTO trainer_status FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."trainerEmployeeId";
    IF FOUND AND trainer_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'safety: the trainer of session % works for the company (ACTIVE)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'safety: training session % starts OPEN', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT c."code", c."companyId", c."status"::text AS status INTO course FROM "SafetyCourse" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."courseId";
    IF FOUND AND (course.status <> 'ACTIVE' OR (course."companyId" IS NOT NULL AND course."companyId" <> NEW."companyId")) THEN
      RAISE EXCEPTION 'safety: training session % gives an ACTIVE course of the whole group or of its company (course % is not)', NEW."id", course."code"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'safety: the company, course, opener and creation of training session % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'OPEN'
     AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
    RAISE EXCEPTION 'safety: training session % is %; only its note changes', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'CLOSED' AND OLD."status" = 'OPEN' AND NEW."heldOn" > "factory_people_today"() THEN
    RAISE EXCEPTION 'safety: training session % is held on %; it is closed once it was held', NEW."id", NEW."heldOn"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'CANCELLED' AND OLD."status" = 'OPEN'
     AND EXISTS (SELECT 1 FROM "TrainingRecord" r WHERE r."tenantId" = NEW."tenantId" AND r."sessionId" = NEW."id") THEN
    RAISE EXCEPTION 'safety: training session % has training records; it is closed, not cancelled', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "TrainingSession_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TrainingSession"
  FOR EACH ROW EXECUTE FUNCTION "factory_training_session_guard"();

-- =====================================================================================================================
-- TrainingAttendance (QHS-248, QHS-247)
--   every row  its key starts `attendance:<session>:<person>` (one per person per session); FLOOR_PIN names the person's worker,
--              the device and the SHA-256 signed (OFFICE is not a way to sign an attendance), PAPER none of them; the
--              countersignature all together, FLOOR_PIN with the trainer's worker, OFFICE or PAPER with the office user; voided
--              exactly with when, who and why.
--   INSERT     not countersigned, not voided; a floor session signs only with FLOOR_PIN, the office records only PAPER; the
--              session is OPEN; the person works for the session's company (ACTIVE); the worker is their own floor sign-in.
--   UPDATE     only the countersignature, the language check and the voiding change, while the session is OPEN; the
--              countersignature is written once (FLOOR_PIN only by a floor session, by the session's trainer's worker; OFFICE and
--              PAPER only by the office); a voided attendance changes no more; a floor session changes only the countersignature
--              and the language check and never voids.
--   DELETE     refused (voided). TRUNCATE refused.
CREATE FUNCTION "factory_training_attendance_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  countersign CONSTANT text[] := ARRAY['countersignedAt', 'countersignMethod', 'countersignedByWorkerId', 'countersignedById'];
  movable CONSTANT text[] := ARRAY['countersignedAt', 'countersignMethod', 'countersignedByWorkerId', 'countersignedById', 'languageUnderstood', 'voidedAt',
                                   'voidedById', 'voidReason', 'version', 'updatedAt'];
  floor_moves CONSTANT text[] := ARRAY['countersignedAt', 'countersignMethod', 'countersignedByWorkerId', 'countersignedById', 'languageUnderstood', 'version', 'updatedAt'];
  on_floor CONSTANT boolean := current_user = 'factory_floor_runtime';
  session record;
  person record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety: attendance % is voided, never deleted (it is a signature)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- A floor insert at another site than the session's is the policies' to refuse.
  IF TG_OP = 'INSERT' AND on_floor AND NEW."siteId" IS DISTINCT FROM NULLIF(current_setting('factory.site_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF position(('attendance:' || NEW."sessionId"::text || ':' || NEW."employeeId"::text) IN NEW."key") <> 1 THEN
    RAISE EXCEPTION 'safety: attendance % has the key attendance:<its session>:<its person> (one per person per session)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."method" = 'OFFICE'
     OR (NEW."method" = 'FLOOR_PIN') <> (NEW."signedByWorkerId" IS NOT NULL AND NEW."deviceId" IS NOT NULL AND NEW."signatureSha256" IS NOT NULL)
     OR (NEW."method" = 'PAPER' AND (NEW."signedByWorkerId" IS NOT NULL OR NEW."deviceId" IS NOT NULL OR NEW."clientEventId" IS NOT NULL OR NEW."signatureSha256" IS NOT NULL))
     OR NOT "factory_safety_sha_ok"(NEW."signatureSha256") OR NOT "factory_safety_text_ok"(NEW."clientEventId") THEN
    RAISE EXCEPTION 'safety: attendance % is signed with badge and PIN (FLOOR_PIN: the worker, the device and the SHA-256 signed) or recorded from the paper sheet (PAPER: none of them)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."countersignedAt" IS NULL) <> (NEW."countersignMethod" IS NULL)
     OR (NEW."countersignMethod" = 'FLOOR_PIN') <> (NEW."countersignedByWorkerId" IS NOT NULL)
     OR (NEW."countersignMethod" IN ('OFFICE', 'PAPER')) <> (NEW."countersignedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'safety: the trainer''s countersignature of attendance % has its time and method with the trainer''s worker (FLOOR_PIN) or the office user (OFFICE, PAPER), all together', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."voidedAt" IS NULL) <> (NEW."voidedById" IS NULL) OR (NEW."voidedAt" IS NULL) <> (NEW."voidReason" IS NULL) OR NOT "factory_safety_text_ok"(NEW."voidReason") THEN
    RAISE EXCEPTION 'safety: attendance % is voided exactly with when, who and why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s."companyId", s."status"::text AS status, s."trainerEmployeeId" INTO session
    FROM "TrainingSession" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."sessionId";
  IF FOUND AND session.status <> 'OPEN' THEN
    RAISE EXCEPTION 'safety: training session % is %; signing has stopped', NEW."sessionId", session.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."countersignedAt" IS NOT NULL OR NEW."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'safety: attendance % starts signed by the person only: the trainer countersigns it after', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF on_floor <> (NEW."method" = 'FLOOR_PIN') THEN
      RAISE EXCEPTION 'safety: an attendance is signed on the floor with badge and PIN, and recorded from paper only by the office (attendance %)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT e."companyId", e."status"::text AS status INTO person FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."employeeId";
    IF FOUND AND (person.status <> 'ACTIVE' OR (session."companyId" IS NOT NULL AND person."companyId" <> session."companyId")) THEN
      RAISE EXCEPTION 'safety: attendance % is of a person who works for the session''s company (ACTIVE)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."method" = 'FLOOR_PIN' AND NOT "factory_safety_worker_is"(NEW."tenantId", NEW."siteId", NEW."signedByWorkerId", NEW."employeeId") THEN
      RAISE EXCEPTION 'safety: attendance % is signed by the person themselves: worker % is not their floor sign-in', NEW."id", NEW."signedByWorkerId"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'safety: the session, person and signature of attendance % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'safety: attendance % is voided; it changes no more', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF on_floor AND (to_jsonb(NEW) - (kept || floor_moves)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || floor_moves)) THEN
    RAISE EXCEPTION 'safety: on the floor an attendance is only countersigned by the trainer (with the language check); the office voids it (attendance %)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) -> 'countersignedAt', to_jsonb(NEW) -> 'countersignMethod', to_jsonb(NEW) -> 'countersignedByWorkerId', to_jsonb(NEW) -> 'countersignedById')
     IS DISTINCT FROM (to_jsonb(OLD) -> 'countersignedAt', to_jsonb(OLD) -> 'countersignMethod', to_jsonb(OLD) -> 'countersignedByWorkerId', to_jsonb(OLD) -> 'countersignedById') THEN
    IF OLD."countersignedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'safety: attendance % is countersigned once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF on_floor <> (NEW."countersignMethod" = 'FLOOR_PIN') THEN
      RAISE EXCEPTION 'safety: the trainer countersigns on the floor with the PIN, and the office records OFFICE or PAPER (attendance %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."countersignMethod" = 'FLOOR_PIN' AND (session."trainerEmployeeId" IS NULL OR NOT "factory_safety_worker_is"(NEW."tenantId", NEW."siteId", NEW."countersignedByWorkerId", session."trainerEmployeeId")) THEN
      RAISE EXCEPTION 'safety: attendance % is countersigned on the floor by the session''s trainer (their floor sign-in)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "TrainingAttendance_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TrainingAttendance"
  FOR EACH ROW EXECUTE FUNCTION "factory_training_attendance_guard"();

-- =====================================================================================================================
-- TrainingRecord (QHS-243, QHS-244, QHS-247), append-only
--   INSERT     the trainer's name and a two-letter language; completed today at the latest; hours above 0 (from 0 for VOID), at
--              most 200; VOID only as a correction; a correction exactly with its reason, of the same person and course (once:
--              the partial unique index below); FAILED and VOID have no validity; PASSED is valid until the day plus the
--              course's refresher period (none without one), another day only with its reason, after the day; the course is the
--              whole group's or the person's company's; a session gives that course, of that company, and is not CANCELLED; an
--              attendance needs its session, is of it and of the person, countersigned and not voided (one record per
--              attendance, corrections aside: the partial unique index below).
--   UPDATE, DELETE, TRUNCATE  refused for every login.
CREATE FUNCTION "factory_training_record_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'safety: a training record is never changed or removed (%); a mistake is a correction (a new record)', TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_training_record_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  course record;
  session record;
  attended record;
  corrected record;
  expected date;
BEGIN
  IF btrim(NEW."trainerName") = '' OR NEW."language" !~ '^[a-z]{2}$' OR NEW."completedOn" > "factory_people_today"() THEN
    RAISE EXCEPTION 'safety: training record % has the trainer''s name, a two-letter language, and was completed today at the latest', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."hours" < 0 OR NEW."hours" > 200 OR (NEW."hours" = 0 AND NEW."result" <> 'VOID') THEN
    RAISE EXCEPTION 'safety: training record % lasts above 0 and at most 200 hours (0 only on a VOID correction)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."correctsId" IS NULL) <> (NEW."correctionReason" IS NULL) OR NOT "factory_safety_text_ok"(NEW."correctionReason")
     OR (NEW."result" = 'VOID' AND NEW."correctsId" IS NULL) THEN
    RAISE EXCEPTION 'safety: training record % corrects another exactly with the reason, and VOID is only a correction (the record it corrects never happened)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attendanceId" IS NOT NULL AND NEW."sessionId" IS NULL THEN
    RAISE EXCEPTION 'safety: training record % names an attendance with its session', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."result" <> 'PASSED' AND (NEW."validUntil" IS NOT NULL OR NEW."validUntilReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'safety: training record % is %; it is valid for nothing', NEW."id", NEW."result"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."validUntil" IS NOT NULL AND NEW."validUntil" <= NEW."completedOn" THEN
    RAISE EXCEPTION 'safety: training record % is valid until a day after it was completed', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT c."code", c."companyId", c."refresherMonths" INTO course FROM "SafetyCourse" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."courseId";
  IF FOUND THEN
    IF course."companyId" IS NOT NULL AND course."companyId" <> NEW."companyId" THEN
      RAISE EXCEPTION 'safety: training record % is of a course of the whole group or of the person''s company (course % is another company''s)', NEW."id", course."code"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."result" = 'PASSED' THEN
      expected := CASE WHEN course."refresherMonths" IS NULL THEN NULL ELSE (NEW."completedOn" + make_interval(months => course."refresherMonths"))::date END;
      IF (NEW."validUntil" IS DISTINCT FROM expected) <> (NEW."validUntilReason" IS NOT NULL AND btrim(NEW."validUntilReason") <> '')
         OR (NEW."validUntilReason" IS NOT NULL AND btrim(NEW."validUntilReason") = '') THEN
        RAISE EXCEPTION 'safety: training record % is valid until the day plus the course''s refresher period (%); another day only with its reason, and the reason only then', NEW."id", coalesce(expected::text, 'no expiry')
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."sessionId" IS NOT NULL THEN
    SELECT s."courseId", s."companyId", s."status"::text AS status INTO session FROM "TrainingSession" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sessionId";
    IF FOUND AND (session."courseId" <> NEW."courseId" OR session."companyId" <> NEW."companyId" OR session.status = 'CANCELLED') THEN
      RAISE EXCEPTION 'safety: training record % comes from a session of its course and company that was not cancelled', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."attendanceId" IS NOT NULL THEN
    SELECT a."sessionId", a."employeeId", a."countersignedAt", a."voidedAt" INTO attended FROM "TrainingAttendance" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."attendanceId";
    IF FOUND AND (attended."sessionId" <> NEW."sessionId" OR attended."employeeId" <> NEW."employeeId" OR attended."countersignedAt" IS NULL OR attended."voidedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'safety: training record % comes from the person''s own attendance at its session, countersigned by the trainer and not voided', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."correctsId" IS NOT NULL THEN
    SELECT r."employeeId", r."courseId" INTO corrected FROM "TrainingRecord" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."correctsId";
    IF FOUND AND (corrected."employeeId" <> NEW."employeeId" OR corrected."courseId" <> NEW."courseId") THEN
      RAISE EXCEPTION 'safety: training record % corrects a record of the same person and course (VOID it and record the right one)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "TrainingRecord_check" BEFORE INSERT ON "TrainingRecord"
  FOR EACH ROW EXECUTE FUNCTION "factory_training_record_check"();
CREATE TRIGGER "TrainingRecord_append_only" BEFORE UPDATE OR DELETE ON "TrainingRecord"
  FOR EACH ROW EXECUTE FUNCTION "factory_training_record_append_only"();
CREATE TRIGGER "TrainingRecord_no_truncate" BEFORE TRUNCATE ON "TrainingRecord"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_training_record_append_only"();

-- Each record is corrected once (a correction of a correction names the newest); one record per attendance, corrections aside.
CREATE UNIQUE INDEX "TrainingRecord_corrected_once" ON "TrainingRecord" ("tenantId", "correctsId") WHERE "correctsId" IS NOT NULL;
CREATE UNIQUE INDEX "TrainingRecord_one_per_attendance" ON "TrainingRecord" ("tenantId", "attendanceId") WHERE "attendanceId" IS NOT NULL AND "correctsId" IS NULL;

-- =====================================================================================================================
-- InstructionRecord (QHS-246; art. 37 c.5)
--   every row  the task and the instructor's name; 1 to 1440 minutes; a two-letter language; the instructor is not the person;
--              the machine (when named) of the class (when named); the signature all together: FLOOR_PIN with the person's
--              worker and the SHA-256 signed, PAPER with neither (OFFICE is not a way to sign it); voided exactly with when, who
--              and why.
--   INSERT     not voided; unsigned, or PAPER; instructed today at the latest; the person works for the company (ACTIVE).
--   UPDATE     the company, person and creation never change; a voided entry changes no more; a signed one changes only to be
--              voided (and its note); the signature is written once (FLOOR_PIN only by a floor session, by the person's own floor
--              sign-in; PAPER only by the office); a floor session only signs an unsigned entry and never voids.
--   DELETE     refused (voided). TRUNCATE refused.
CREATE FUNCTION "factory_instruction_record_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  signature CONSTANT text[] := ARRAY['signedAt', 'signMethod', 'signedByWorkerId', 'signatureSha256'];
  voiding CONSTANT text[] := ARRAY['voidedAt', 'voidedById', 'voidReason'];
  movable CONSTANT text[] := ARRAY['instructedOn', 'task', 'machineClassId', 'machineId', 'instructorEmployeeId', 'instructorName', 'minutes', 'language',
                                   'languageChecked', 'note', 'version', 'updatedAt'];
  on_floor CONSTANT boolean := current_user = 'factory_floor_runtime';
  machine_class uuid;
  person_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety: instruction entry % is voided, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF btrim(NEW."task") = '' OR btrim(NEW."instructorName") = '' OR NEW."minutes" < 1 OR NEW."minutes" > 1440 OR NEW."language" !~ '^[a-z]{2}$'
     OR NEW."instructorEmployeeId" = NEW."employeeId" THEN
    RAISE EXCEPTION 'safety: instruction entry % has its task, the instructor''s name (never the person instructed), 1 to 1440 minutes and a two-letter language', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."signMethod" = 'OFFICE' OR (NEW."signedAt" IS NULL) <> (NEW."signMethod" IS NULL)
     OR (NEW."signMethod" = 'FLOOR_PIN') <> (NEW."signedByWorkerId" IS NOT NULL AND NEW."signatureSha256" IS NOT NULL)
     OR (NEW."signMethod" IS DISTINCT FROM 'FLOOR_PIN' AND (NEW."signedByWorkerId" IS NOT NULL OR NEW."signatureSha256" IS NOT NULL))
     OR NOT "factory_safety_sha_ok"(NEW."signatureSha256") THEN
    RAISE EXCEPTION 'safety: instruction entry % is signed by the person with badge and PIN (FLOOR_PIN: the worker and the SHA-256 signed) or on paper (PAPER), with its time', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."voidedAt" IS NULL) <> (NEW."voidedById" IS NULL) OR (NEW."voidedAt" IS NULL) <> (NEW."voidReason" IS NULL) OR NOT "factory_safety_text_ok"(NEW."voidReason") THEN
    RAISE EXCEPTION 'safety: instruction entry % is voided exactly with when, who and why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."machineId" IS NOT NULL AND NEW."machineClassId" IS NOT NULL THEN
    SELECT m."classId" INTO machine_class FROM "Machine" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."machineId";
    IF FOUND AND machine_class <> NEW."machineClassId" THEN
      RAISE EXCEPTION 'safety: the machine of instruction entry % is of the class it names', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."voidedAt" IS NOT NULL OR NEW."signMethod" = 'FLOOR_PIN' THEN
      RAISE EXCEPTION 'safety: instruction entry % starts unsigned (the person signs it on the floor) or with its signed paper, not voided', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."instructedOn" > "factory_people_today"() THEN
      RAISE EXCEPTION 'safety: instruction entry % records instruction given today at the latest, not on %', NEW."id", NEW."instructedOn"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT e."status"::text INTO person_status FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."employeeId";
    IF FOUND AND person_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'safety: instruction entry % is of a person who works for the company (ACTIVE)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || signature || voiding || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || signature || voiding || movable)) THEN
    RAISE EXCEPTION 'safety: the company, person and creation of instruction entry % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'safety: instruction entry % is voided; it changes no more', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF on_floor AND ((to_jsonb(NEW) - (kept || signature || ARRAY['version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || signature || ARRAY['version', 'updatedAt']))) THEN
    RAISE EXCEPTION 'safety: on the floor an instruction entry is only signed by the person; the office writes and voids it (entry %)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."signedAt" IS NOT NULL
     AND (to_jsonb(NEW) - (kept || voiding || ARRAY['note', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || voiding || ARRAY['note', 'version', 'updatedAt'])) THEN
    RAISE EXCEPTION 'safety: instruction entry % is signed; it is only voided now (its signature is written once)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."signedAt" IS NULL AND NEW."signedAt" IS NOT NULL THEN
    IF on_floor <> (NEW."signMethod" = 'FLOOR_PIN') THEN
      RAISE EXCEPTION 'safety: the person signs instruction entry % on the floor with the PIN; the office records only a signed paper', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signMethod" = 'FLOOR_PIN' AND NOT "factory_safety_worker_is"(NEW."tenantId", NEW."siteId", NEW."signedByWorkerId", NEW."employeeId") THEN
      RAISE EXCEPTION 'safety: instruction entry % is signed by the person instructed: worker % is not their floor sign-in', OLD."id", NEW."signedByWorkerId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InstructionRecord_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InstructionRecord"
  FOR EACH ROW EXECUTE FUNCTION "factory_instruction_record_guard"();

-- =====================================================================================================================
-- PpeItem (QHS-259)
--   every row  a code (no spaces), a name, its names in other languages; PPE (never NOT_PPE); the standard not blank when given;
--              sizes none blank or twice; it lasts 1 to 120 months when given; a unit cost from 0.
--   INSERT     ACTIVE.  UPDATE  the company, code and creation never change.  DELETE, TRUNCATE  refused (archived).
CREATE FUNCTION "factory_ppe_item_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  movable CONSTANT text[] := ARRAY['name', 'nameI18n', 'category', 'standard', 'sizes', 'lifeMonths', 'supplierPartyId', 'unitCost', 'status', 'note', 'version',
                                   'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety: PPE item % is archived, never deleted (issues name it)', OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NOT "factory_safety_code_ok"(NEW."code") OR btrim(NEW."name") = '' OR NOT "factory_safety_i18n_ok"(NEW."nameI18n") OR NOT "factory_safety_text_ok"(NEW."standard") THEN
    RAISE EXCEPTION 'safety: PPE item % has a code (no spaces), a name, its names in other languages and the standard it meets when given', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."category" = 'NOT_PPE' THEN
    RAISE EXCEPTION 'safety: PPE item % is of category I, II or III', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW."sizes") s WHERE s IS NULL OR btrim(s) = '') OR cardinality(NEW."sizes") <> (SELECT count(DISTINCT s) FROM unnest(NEW."sizes") s)
     OR NEW."lifeMonths" < 1 OR NEW."lifeMonths" > 120 OR NEW."unitCost" < 0 THEN
    RAISE EXCEPTION 'safety: PPE item % has its sizes each once, lasts 1 to 120 months when given, and costs from 0', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'safety: PPE item % starts ACTIVE', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'safety: the company, code and creation of PPE item % never change', OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PpeItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PpeItem"
  FOR EACH ROW EXECUTE FUNCTION "factory_ppe_item_guard"();

-- =====================================================================================================================
-- PpeKitLine (QHS-260)
--   every row  a place from 1; when to wear it; 1 to 99.
--   INSERT, UPDATE, DELETE  only while its sheet is ACTIVE (FOR SHARE); its sheet, item and creation never change; a new line names
--              an ACTIVE item of the sheet's company.
CREATE FUNCTION "factory_ppe_kit_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sheet record;
  item record;
  row_now "PpeKitLine";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  row_now := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_OP <> 'DELETE' AND (NEW."seq" < 1 OR btrim(NEW."whenToWear") = '' OR NEW."quantity" < 1 OR NEW."quantity" > 99 OR NOT "factory_safety_text_ok"(NEW."note")) THEN
    RAISE EXCEPTION 'safety: kit line % has a place from 1, when to wear it and 1 to 99 of the item', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."roleSheetId", NEW."ppeItemId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."roleSheetId", OLD."ppeItemId", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'safety: kit line % keeps its role sheet and item; another item is another line', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."code", s."companyId", s."status"::text AS status INTO sheet FROM "RoleSheet" s WHERE s."tenantId" = row_now."tenantId" AND s."id" = row_now."roleSheetId" FOR SHARE;
  IF FOUND AND sheet.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'safety: role sheet % is archived; its kit no longer changes', sheet."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT i."code", i."companyId", i."status"::text AS status INTO item FROM "PpeItem" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."ppeItemId";
    IF FOUND AND (item.status <> 'ACTIVE' OR (sheet."companyId" IS NOT NULL AND item."companyId" <> sheet."companyId")) THEN
      RAISE EXCEPTION 'safety: role sheet % takes an ACTIVE PPE item of its company into its kit (item % is not)', sheet."code", item."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER "PpeKitLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PpeKitLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_ppe_kit_line_guard"();

-- =====================================================================================================================
-- PpeIssue (QHS-261; arts. 18 c.1 d, 77 c.4), append-only
--   INSERT     1 to 99; handed over by at most one (an office user or a worker); an ISSUE has its reason and its receipt: FLOOR_PIN
--              with the person's own worker, the device and the SHA-256 signed (only by a floor session, which names no office
--              user), PAPER with none of them (only by the office); a VOID names the issue it voids and why, and nothing of a
--              receipt (only by the office); an ISSUE is of a person who works for the company (ACTIVE), of an ACTIVE item, in one
--              of its sizes (none for a one-size item); a VOID copies its issue's person, item, size and quantity and voids an
--              ISSUE, once (the partial unique index below).
--   UPDATE, DELETE, TRUNCATE  refused for every login.
CREATE FUNCTION "factory_ppe_issue_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'safety: a PPE issue is never changed or removed (%); a wrong one is voided by a VOID row and its receipt stays', TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_ppe_issue_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  on_floor CONSTANT boolean := current_user = 'factory_floor_runtime';
  person_status text;
  item record;
  voided record;
BEGIN
  -- A floor insert at another site than the session's is the policies' to refuse.
  IF on_floor AND NEW."siteId" IS DISTINCT FROM NULLIF(current_setting('factory.site_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NEW."quantity" < 1 OR NEW."quantity" > 99 OR (NEW."issuedById" IS NOT NULL AND NEW."issuedByWorkerId" IS NOT NULL) THEN
    RAISE EXCEPTION 'safety: PPE issue % hands over 1 to 99, by at most one person (an office user or a worker)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'ISSUE' THEN
    IF NEW."reason" IS NULL OR NEW."voidsId" IS NOT NULL OR NEW."voidReason" IS NOT NULL OR NEW."method" IS NULL OR NEW."method" = 'OFFICE'
       OR (NEW."method" = 'FLOOR_PIN') <> (NEW."signedByWorkerId" IS NOT NULL AND NEW."deviceId" IS NOT NULL AND NEW."signatureSha256" IS NOT NULL)
       OR (NEW."method" = 'PAPER' AND (NEW."signedByWorkerId" IS NOT NULL OR NEW."deviceId" IS NOT NULL OR NEW."clientEventId" IS NOT NULL OR NEW."signatureSha256" IS NOT NULL))
       OR NOT "factory_safety_sha_ok"(NEW."signatureSha256") OR NOT "factory_safety_text_ok"(NEW."clientEventId") THEN
      RAISE EXCEPTION 'safety: PPE issue % has its reason and its receipt: signed with badge and PIN (FLOOR_PIN: the worker, the device and the SHA-256 signed) or on paper (PAPER: none of them)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF on_floor <> (NEW."method" = 'FLOOR_PIN') OR (on_floor AND NEW."issuedById" IS NOT NULL) THEN
      RAISE EXCEPTION 'safety: PPE received on the floor is signed with badge and PIN; the office records only a paper receipt (issue %)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT e."status"::text INTO person_status FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."employeeId";
    IF FOUND AND person_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'safety: PPE issue % is to a person who works for the company (ACTIVE)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."code", i."status"::text AS status, i."sizes" INTO item FROM "PpeItem" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."ppeItemId";
    IF FOUND AND item.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'safety: PPE item % is archived; it is no longer handed over', item."code"
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND ((cardinality(item."sizes") = 0) <> (NEW."size" IS NULL) OR (NEW."size" IS NOT NULL AND NOT (NEW."size" = ANY (item."sizes")))) THEN
      RAISE EXCEPTION 'safety: PPE issue % is in one of item %''s sizes (%), or none for a one-size item', NEW."id", item."code", coalesce(nullif(array_to_string(item."sizes", ', '), ''), 'one size')
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."method" = 'FLOOR_PIN' AND NOT "factory_safety_worker_is"(NEW."tenantId", NEW."siteId", NEW."signedByWorkerId", NEW."employeeId") THEN
      RAISE EXCEPTION 'safety: PPE issue % is signed by the person who received it: worker % is not their floor sign-in', NEW."id", NEW."signedByWorkerId"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."voidsId" IS NULL OR NEW."voidReason" IS NULL OR btrim(NEW."voidReason") = '' OR NEW."reason" IS NOT NULL OR NEW."method" IS NOT NULL
     OR NEW."signedByWorkerId" IS NOT NULL OR NEW."deviceId" IS NOT NULL OR NEW."clientEventId" IS NOT NULL OR NEW."signatureSha256" IS NOT NULL THEN
    RAISE EXCEPTION 'safety: VOID % names the issue it voids and why, and nothing of a receipt', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF on_floor THEN
    RAISE EXCEPTION 'safety: a PPE issue is voided by the office, not on the floor (VOID %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT v."kind"::text AS kind, v."employeeId", v."ppeItemId", v."size", v."quantity" INTO voided
    FROM "PpeIssue" v WHERE v."tenantId" = NEW."tenantId" AND v."siteId" = NEW."siteId" AND v."id" = NEW."voidsId";
  IF FOUND AND (voided.kind <> 'ISSUE' OR (voided."employeeId", voided."ppeItemId", voided."size", voided."quantity") IS DISTINCT FROM (NEW."employeeId", NEW."ppeItemId", NEW."size", NEW."quantity")) THEN
    RAISE EXCEPTION 'safety: VOID % voids an ISSUE and copies its person, item, size and quantity', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PpeIssue_check" BEFORE INSERT ON "PpeIssue"
  FOR EACH ROW EXECUTE FUNCTION "factory_ppe_issue_check"();
CREATE TRIGGER "PpeIssue_append_only" BEFORE UPDATE OR DELETE ON "PpeIssue"
  FOR EACH ROW EXECUTE FUNCTION "factory_ppe_issue_append_only"();
CREATE TRIGGER "PpeIssue_no_truncate" BEFORE TRUNCATE ON "PpeIssue"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_ppe_issue_append_only"();

-- An issue is voided once.
CREATE UNIQUE INDEX "PpeIssue_voided_once" ON "PpeIssue" ("tenantId", "voidsId") WHERE "voidsId" IS NOT NULL;

-- =====================================================================================================================
-- GeneratedDocument (redefines …_plant_care_w2b_guards' function, whole body; the trigger stays): its rules, and now a frozen
-- risk assessment (DVR_FROZEN) is of its RiskAssessmentVersion's company and site and a PPE receipt (PPE_RECEIPT) of its
-- PpeIssue's. Every record type of the function is now checked.
CREATE OR REPLACE FUNCTION "factory_generated_document_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_company uuid;
  record_site uuid;
  file record;
BEGIN
  IF NEW."version" < 1 OR NEW."fingerprint" !~ '^[0-9a-f]{64}$' OR NEW."language" !~ '^[a-z]{2}$'
     OR btrim(coalesce(NEW."layout", 'x')) = '' OR btrim(coalesce(NEW."number", 'x')) = '' THEN
    RAISE EXCEPTION 'documents: generated document % has a version from 1, a SHA-256 fingerprint (lower-case hex), its two-letter language and, when given, a layout and a number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((NEW."kind" = 'PACKING_LIST' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'CLAIM_LETTER' AND NEW."recordType" = 'SupplierClaim')
          OR (NEW."kind" = 'JOB_SHEET' AND NEW."recordType" IN ('SubcontractOrder', 'MaintenanceJob'))
          OR (NEW."kind" = 'RMA_SHEET' AND NEW."recordType" = 'ReturnAuthorisation')
          OR (NEW."kind" = 'INSPECTION_REPORT' AND NEW."recordType" IN ('Inspection', 'IncomingInspection'))
          OR (NEW."kind" = 'CERTIFICATE_OF_CONFORMITY' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'NCR_REPORT' AND NEW."recordType" = 'Nonconformance')
          OR (NEW."kind" = 'EIGHT_D' AND NEW."recordType" = 'Capa')
          OR (NEW."kind" = 'COMPLAINT_ANSWER' AND NEW."recordType" = 'Complaint')
          OR (NEW."kind" = 'CHECK_REPORT' AND NEW."recordType" = 'MachineCheckResult')
          OR (NEW."kind" = 'DVR_FROZEN' AND NEW."recordType" = 'RiskAssessmentVersion')
          OR (NEW."kind" = 'PPE_RECEIPT' AND NEW."recordType" = 'PpeIssue')) THEN
    RAISE EXCEPTION 'documents: generated document % is a % of a %; a packing list is a Shipment''s, a claim letter a SupplierClaim''s, a job sheet a SubcontractOrder''s or a MaintenanceJob''s, an RMA sheet a ReturnAuthorisation''s, a certificate of conformity a Shipment''s, an inspection report an Inspection''s or an IncomingInspection''s, an NCR report a Nonconformance''s, an 8D a Capa''s, an answer letter a Complaint''s, a check report a MachineCheckResult''s, a frozen risk assessment a RiskAssessmentVersion''s, a PPE receipt a PpeIssue''s', NEW."id", NEW."kind", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  CASE NEW."recordType"
    -- W2b wave 15/16 (B-W2b-87): a frozen risk assessment is of its version's company and site, a PPE receipt of its issue's.
    WHEN 'RiskAssessmentVersion' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "RiskAssessmentVersion" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'PpeIssue' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "PpeIssue" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- W2b wave 14/16 (B-W2b-86): a check report is of its result's company and site.
    WHEN 'MachineCheckResult' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "MachineCheckResult" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- A record of the whole company has no site, and neither has its document.
    WHEN 'Capa' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "Capa" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Complaint' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "Complaint" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Inspection' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Inspection" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'IncomingInspection' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "IncomingInspection" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Nonconformance' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Nonconformance" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Shipment' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Shipment" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'SupplierClaim' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "SupplierClaim" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'SubcontractOrder' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "SubcontractOrder" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'MaintenanceJob' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "MaintenanceJob" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    ELSE
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "ReturnAuthorisation" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
  END CASE;
  IF FOUND AND (record_company, record_site) IS DISTINCT FROM (NEW."companyId", NEW."siteId") THEN
    RAISE EXCEPTION 'documents: generated document % is of the company and site of its % %', NEW."id", NEW."recordType", NEW."recordId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT f."recordType", f."recordId", f."companyId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF FOUND AND (file."recordType", file."recordId", file."companyId") IS DISTINCT FROM (NEW."recordType", NEW."recordId", NEW."companyId") THEN
    RAISE EXCEPTION 'documents: the file of generated document % is a file of its own record (% %) and company', NEW."id", NEW."recordType", NEW."recordId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
