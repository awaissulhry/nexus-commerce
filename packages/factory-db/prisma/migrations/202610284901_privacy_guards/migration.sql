-- Written by hand (Prisma does not model triggers or partial indexes), after the generated 202610284900_privacy and
-- before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Privacy (PLAN §2.8 "Privacy notices, DPIA, processing register" (GDPR arts. 13, 30, 35) and "Limits on monitoring
-- workers" (Statuto dei Lavoratori, L. 300/1970, art. 4); B-W1-36; features PLT-208, MES-277, GAP-004, GAP-005, GAP-009).
-- apps/factory-api's platform/privacy checks all of this first; these rules hold for every login, the owner included.
-- The tenant of a row is held by the policies (USING and WITH CHECK) and by the references, not here: the triggers leave
-- "tenantId" to them. Every refusal is a check_violation (SQLSTATE 23514). A rule that reads another row skips a row
-- this session cannot see (another tenant's): the policies refuse that write anyway. A trigger reads only tables (and
-- columns) the role that fires it may read, and locks a row FOR SHARE only where that role may update it.
--
-- It also redefines production's subject check (202610283801_production_guards): once a company has published a worker
-- notice, a scan or a cut log names a worker only when that worker acknowledged the version in force.

CREATE FUNCTION "factory_privacy_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'privacy: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- PrivacyNotice (GDPR art. 13; Statuto dei Lavoratori art. 4 c.3; SCR-086)
--   INSERT     a DRAFT, unpublished.
--   UPDATE     an UPDATE that changes nothing passes; the company, kind, version number and creation never change; the
--              label only while a DRAFT; DRAFT → PUBLISHED with an Italian text (a worker notice also an English one,
--              Q15), when and by whom; PUBLISHED → SUPERSEDED, when, and only by a later version of the same company
--              and kind; a SUPERSEDED notice never changes. Its languages are frozen by the PrivacyNoticeText trigger.
--   every row  a version number from 1 and a label (at most 40 characters); published (and only then) when and by
--              whom; superseded (and only then) when.
--   DELETE     only a DRAFT. TRUNCATE refused. One PUBLISHED per company and kind (the partial unique index).
CREATE FUNCTION "factory_privacy_notice_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'privacy: notice % is %; only a DRAFT is deleted (acknowledgements name the published ones)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."publishedAt" IS NOT NULL OR NEW."publishedById" IS NOT NULL OR NEW."supersededAt" IS NOT NULL THEN
      RAISE EXCEPTION 'privacy: notice % starts as a DRAFT, unpublished', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."kind", NEW."versionNo", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."kind", OLD."versionNo", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'privacy: the company, kind, version number and creation of notice % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'SUPERSEDED' THEN
      RAISE EXCEPTION 'privacy: notice % is SUPERSEDED; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (NEW."label", NEW."publishedAt", NEW."publishedById") IS DISTINCT FROM (OLD."label", OLD."publishedAt", OLD."publishedById") THEN
      RAISE EXCEPTION 'privacy: notice % is published; its label and when and by whom it was published never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'PUBLISHED') OR (OLD."status" = 'PUBLISHED' AND NEW."status" = 'SUPERSEDED')) THEN
      RAISE EXCEPTION 'privacy: notice % moves DRAFT → PUBLISHED → SUPERSEDED, not % → %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'PUBLISHED' THEN
      IF NOT EXISTS (SELECT 1 FROM "PrivacyNoticeText" t WHERE t."tenantId" = NEW."tenantId" AND t."noticeId" = NEW."id" AND t."locale" = 'it' AND t."body" IS NOT NULL)
         OR (NEW."kind" = 'WORKER_FLOOR' AND NOT EXISTS (SELECT 1 FROM "PrivacyNoticeText" t WHERE t."tenantId" = NEW."tenantId" AND t."noticeId" = NEW."id" AND t."locale" = 'en' AND t."body" IS NOT NULL)) THEN
        RAISE EXCEPTION 'privacy: notice % is published with its text in Italian, and a worker notice in English too (the floor screens, Q15)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF OLD."status" = 'PUBLISHED' AND NEW."status" = 'SUPERSEDED' THEN
      IF NOT EXISTS (SELECT 1 FROM "PrivacyNotice" n WHERE n."tenantId" = NEW."tenantId" AND n."companyId" = NEW."companyId" AND n."kind" = NEW."kind" AND n."versionNo" > NEW."versionNo" AND n."status" IN ('DRAFT', 'PUBLISHED')) THEN
        RAISE EXCEPTION 'privacy: notice % is superseded only by a later version of the same company and kind', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."versionNo" < 1 OR btrim(NEW."label") = '' OR length(NEW."label") > 40 THEN
    RAISE EXCEPTION 'privacy: notice % has a version number from 1 and a label of at most 40 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DRAFT') <> (NEW."publishedAt" IS NULL) OR (NEW."publishedAt" IS NULL) <> (NEW."publishedById" IS NULL) THEN
    RAISE EXCEPTION 'privacy: notice % names when and by whom it was published exactly when it was', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'SUPERSEDED') <> (NEW."supersededAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'privacy: notice % names when it was superseded exactly when it was', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PrivacyNotice_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PrivacyNotice"
  FOR EACH ROW EXECUTE FUNCTION "factory_privacy_notice_guard"();
CREATE TRIGGER "PrivacyNotice_no_truncate" BEFORE TRUNCATE ON "PrivacyNotice"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_privacy_refuse_truncate"();

-- One notice in force per company and kind.
CREATE UNIQUE INDEX "PrivacyNotice_one_published" ON "PrivacyNotice" ("tenantId", "companyId", "kind") WHERE "status" = 'PUBLISHED';

-- ---------------------------------------------------------------------------------------------------------------------
-- PrivacyNoticeText (Q15; the fingerprint acknowledgements store)
--   any write  only while its notice is a DRAFT (the notice read FOR SHARE: a publish and a write take turns); an UPDATE
--              that changes nothing passes; the notice and language of a row never change.
--   every row  a language code, a text or a PDF, and the SHA-256 (hex) of what is shown: of the text as UTF-8 when there
--              is one, else of the PDF; the PDF is an AVAILABLE file of the notice (PrivacyNotice, its id).
--   TRUNCATE   refused.
CREATE FUNCTION "factory_privacy_notice_text_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  notice_status text;
  pdf record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT n."status"::text INTO notice_status FROM "PrivacyNotice" n WHERE n."tenantId" = OLD."tenantId" AND n."id" = OLD."noticeId" FOR SHARE;
    IF FOUND AND notice_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'privacy: notice % is %; its languages never change', OLD."noticeId", notice_status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."id", NEW."noticeId", NEW."locale", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."noticeId", OLD."locale", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'privacy: the notice and language of text % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT n."status"::text INTO notice_status FROM "PrivacyNotice" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."noticeId" FOR SHARE;
  IF FOUND AND notice_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'privacy: notice % is %; its languages never change', NEW."noticeId", notice_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."locale") = '' OR (NEW."body" IS NULL AND NEW."fileId" IS NULL) OR NEW."sha256" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'privacy: text % has its language, a text or a PDF, and the SHA-256 of what is shown', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."body" IS NOT NULL AND (btrim(NEW."body") = '' OR NEW."sha256" <> encode(sha256(convert_to(NEW."body", 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'privacy: the fingerprint of text % is the SHA-256 of its text (UTF-8), which is not empty', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fileId" IS NOT NULL THEN
    SELECT f."recordType", f."recordId", f."status"::text AS status, f."sha256" INTO pdf FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
    IF FOUND THEN
      IF pdf."recordType" <> 'PrivacyNotice' OR pdf."recordId" <> NEW."noticeId" OR pdf.status <> 'AVAILABLE' THEN
        RAISE EXCEPTION 'privacy: the PDF of text % is an available file of its notice %', NEW."id", NEW."noticeId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."body" IS NULL AND pdf."sha256" <> NEW."sha256" THEN
        RAISE EXCEPTION 'privacy: text % is a PDF only; its fingerprint is the PDF''s SHA-256', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PrivacyNoticeText_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PrivacyNoticeText"
  FOR EACH ROW EXECUTE FUNCTION "factory_privacy_notice_text_guard"();
CREATE TRIGGER "PrivacyNoticeText_no_truncate" BEFORE TRUNCATE ON "PrivacyNoticeText"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_privacy_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- PrivacyDpia (GDPR art. 35; GAP-004, MES-282)
--   INSERT     a DRAFT without its signed PDF, unstored.
--   UPDATE     an UPDATE that changes nothing passes; the company, version number and creation never change; DRAFT →
--              STORED (the floor gate opens) → SUPERSEDED (when, only by a later version of the same company); once
--              stored nothing but its status and when it was superseded changes.
--   every row  a version number from 1 and a scope; stored (and later): its signed PDF (an AVAILABLE file of this DPIA
--              with that SHA-256, checked when it is named and when it is stored), who signed it, the day signed (on
--              or before the day stored), the review day (after it), who stored it when; superseded (and only then)
--              when.
--   DELETE     only a DRAFT. TRUNCATE refused. One STORED per company (the partial unique index).
CREATE FUNCTION "factory_privacy_dpia_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pdf record;
  check_pdf boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'privacy: DPIA % is %; only a DRAFT is deleted', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."fileId" IS NOT NULL OR NEW."fileSha256" IS NOT NULL OR NEW."storedAt" IS NOT NULL OR NEW."storedById" IS NOT NULL OR NEW."supersededAt" IS NOT NULL THEN
      RAISE EXCEPTION 'privacy: DPIA % starts as a DRAFT, without its signed PDF', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."versionNo", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."versionNo", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'privacy: the company, version number and creation of DPIA % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'STORED') OR (OLD."status" = 'STORED' AND NEW."status" = 'SUPERSEDED')) THEN
      RAISE EXCEPTION 'privacy: DPIA % moves DRAFT → STORED → SUPERSEDED, not % → %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND (to_jsonb(NEW) - 'tenantId' - 'status' - 'supersededAt' - 'version' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'tenantId' - 'status' - 'supersededAt' - 'version' - 'updatedAt') THEN
      RAISE EXCEPTION 'privacy: DPIA % is %; it never changes (a later version replaces it)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'SUPERSEDED' THEN
      RAISE EXCEPTION 'privacy: DPIA % is SUPERSEDED; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    check_pdf := NEW."fileId" IS DISTINCT FROM OLD."fileId" OR NEW."fileSha256" IS DISTINCT FROM OLD."fileSha256" OR (OLD."status" = 'DRAFT' AND NEW."status" = 'STORED');
    IF OLD."status" = 'STORED' AND NEW."status" = 'SUPERSEDED'
       AND NOT EXISTS (SELECT 1 FROM "PrivacyDpia" d WHERE d."tenantId" = NEW."tenantId" AND d."companyId" = NEW."companyId" AND d."versionNo" > NEW."versionNo" AND d."status" IN ('DRAFT', 'STORED')) THEN
      RAISE EXCEPTION 'privacy: DPIA % is superseded only by a later version of the same company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."versionNo" < 1 OR btrim(NEW."scope") = '' OR (NEW."fileSha256" IS NOT NULL AND NEW."fileSha256" !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'privacy: DPIA % has a version number from 1, a scope, and the SHA-256 (hex) of its PDF', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'DRAFT' AND (NEW."storedAt" IS NOT NULL OR NEW."storedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'privacy: DPIA % is a DRAFT; it is not stored yet', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> 'DRAFT' THEN
    IF NEW."fileId" IS NULL OR NEW."fileSha256" IS NULL OR btrim(coalesce(NEW."signedByName", '')) = '' OR NEW."signedOn" IS NULL OR NEW."reviewDueOn" IS NULL
       OR NEW."storedAt" IS NULL OR NEW."storedById" IS NULL THEN
      RAISE EXCEPTION 'privacy: a stored DPIA (%) names its signed PDF, who signed it and on which day, its review day, and who stored it when', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signedOn" > (NEW."storedAt" AT TIME ZONE 'Europe/Rome')::date OR NEW."reviewDueOn" <= NEW."signedOn" THEN
      RAISE EXCEPTION 'privacy: DPIA % was signed on or before the day it is stored, and is reviewed after it was signed', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."status" = 'SUPERSEDED') <> (NEW."supersededAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'privacy: DPIA % names when it was superseded exactly when it was', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."fileId" IS NULL) <> (NEW."fileSha256" IS NULL) THEN
    RAISE EXCEPTION 'privacy: DPIA % names its PDF with the PDF''s SHA-256', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fileId" IS NOT NULL AND check_pdf THEN
    SELECT f."recordType", f."recordId", f."status"::text AS status, f."sha256" INTO pdf FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
    IF FOUND AND (pdf."recordType" <> 'PrivacyDpia' OR pdf."recordId" <> NEW."id" OR pdf.status <> 'AVAILABLE' OR pdf."sha256" <> NEW."fileSha256") THEN
      RAISE EXCEPTION 'privacy: the signed PDF of DPIA % is an available file of that DPIA, with its SHA-256', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PrivacyDpia_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PrivacyDpia"
  FOR EACH ROW EXECUTE FUNCTION "factory_privacy_dpia_guard"();
CREATE TRIGGER "PrivacyDpia_no_truncate" BEFORE TRUNCATE ON "PrivacyDpia"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_privacy_refuse_truncate"();

-- One stored DPIA per company: the one the floor gate reads.
CREATE UNIQUE INDEX "PrivacyDpia_one_stored" ON "PrivacyDpia" ("tenantId", "companyId") WHERE "status" = 'STORED';

-- ---------------------------------------------------------------------------------------------------------------------
-- ProcessingActivity (GDPR art. 30(1); GAP-009)
--   UPDATE     an UPDATE that changes nothing passes; the company, code and creation never change; an ARCHIVED
--              activity never changes.
--   every row  a code, a name, a purpose, a lawful basis, the transfers, the retention and the security measures in
--              words, and at least one category of data subjects and of personal data.
--   DELETE     refused (archived instead: the record keeps what was processed). TRUNCATE refused.
CREATE FUNCTION "factory_processing_activity_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'privacy: processing activity % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."code", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."code", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'privacy: the company, code and creation of processing activity % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'ARCHIVED' THEN
      RAISE EXCEPTION 'privacy: processing activity % is ARCHIVED; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."code") = '' OR btrim(NEW."name") = '' OR btrim(NEW."purpose") = '' OR btrim(NEW."legalBasis") = '' OR btrim(NEW."transfers") = ''
     OR btrim(NEW."retention") = '' OR btrim(NEW."security") = '' OR coalesce(cardinality(NEW."dataSubjects"), 0) = 0 OR coalesce(cardinality(NEW."dataCategories"), 0) = 0 THEN
    RAISE EXCEPTION 'privacy: processing activity % says what, why, on which basis, about whom, which data, the transfers, how long and how it is protected (GDPR art. 30(1))', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ProcessingActivity_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ProcessingActivity"
  FOR EACH ROW EXECUTE FUNCTION "factory_processing_activity_guard"();
CREATE TRIGGER "ProcessingActivity_no_truncate" BEFORE TRUNCATE ON "ProcessingActivity"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_privacy_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- StaffNoticeAck: append-only (plan A1 §2.1; scripts/factory/check-append-only.mjs). No login may change or remove a
-- row, the owner and superusers included; the runtime roles have no UPDATE, DELETE or TRUNCATE grant either.
CREATE FUNCTION "factory_refuse_privacy_ledger_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; an acknowledgement stays as it was given (a new version is acknowledged anew)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "StaffNoticeAck_append_only" BEFORE UPDATE OR DELETE ON "StaffNoticeAck"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_privacy_ledger_change"();
CREATE TRIGGER "StaffNoticeAck_no_truncate" BEFORE TRUNCATE ON "StaffNoticeAck"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_privacy_ledger_change"();

-- StaffNoticeAck, INSERT (GDPR art. 13; B-W1-36)
--   the OFFICE_STAFF notice in force of its company; a label, a language (ISO 639-1) and the SHA-256 of the notice's
--   text in that language, as shown; an ACTIVE person. One per person, company and label (the unique key).
CREATE FUNCTION "factory_staff_notice_ack_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  notice record;
  user_status text;
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
  SELECT u."status"::text INTO user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
  IF FOUND AND user_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'privacy: person % is %; only an ACTIVE person acknowledges the notice', NEW."userId", user_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "StaffNoticeAck_check" BEFORE INSERT ON "StaffNoticeAck"
  FOR EACH ROW EXECUTE FUNCTION "factory_staff_notice_ack_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- WorkerNoticeAck, INSERT, the notice it names (PLT-208, SCR-025; Statuto dei Lavoratori art. 4 c.3; GDPR art. 13). Beside
-- production's own check (factory_worker_notice_ack_check): an acknowledgement that names a notice names the
-- WORKER_FLOOR notice in force of the worker's site's company, by its label, and the fingerprint of one of its texts in
-- the language shown. One without a notice (recorded before the company published one in Nexus) is not checked here:
-- it counts only while the company has never published one (factory_production_check_subject, below).
CREATE FUNCTION "factory_worker_notice_ack_notice_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  notice record;
  site_company uuid;
BEGIN
  IF NEW."noticeId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT n."kind"::text AS kind, n."status"::text AS status, n."companyId", n."label" INTO notice FROM "PrivacyNotice" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."noticeId";
  IF NOT FOUND THEN
    -- Outside this session's scope: the policies refuse the row.
    RETURN NEW;
  END IF;
  SELECT s."companyId" INTO site_company FROM "Site" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."siteId";
  IF notice.kind <> 'WORKER_FLOOR' OR notice.status <> 'PUBLISHED' OR (site_company IS NOT NULL AND notice."companyId" <> site_company) THEN
    RAISE EXCEPTION 'privacy: a worker acknowledges the worker notice in force of their site''s company; notice % is a % % one', NEW."noticeId", notice.status, notice.kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."noticeVersion" <> notice."label" THEN
    RAISE EXCEPTION 'privacy: notice acknowledgement % names notice % by its label %', NEW."id", NEW."noticeId", notice."label"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "PrivacyNoticeText" t WHERE t."tenantId" = NEW."tenantId" AND t."noticeId" = NEW."noticeId" AND t."locale" = NEW."locale" AND t."sha256" = NEW."noticeSha256") THEN
    RAISE EXCEPTION 'privacy: notice acknowledgement % stores the fingerprint of notice % in language %', NEW."id", NEW."noticeId", NEW."locale"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkerNoticeAck_notice_check" BEFORE INSERT ON "WorkerNoticeAck"
  FOR EACH ROW EXECUTE FUNCTION "factory_worker_notice_ack_notice_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Who a floor record names (Statuto dei Lavoratori art. 4; PLAN §2.8; MES-278, PLT-208; Q16), as
-- 202610283801_production_guards defined it, now with the notice in force (B-W1-36). A site whose floor rules record the
-- STATION names its station and no worker; any other site (WORKER, the default, also without a row) names the
-- signed-in worker, and only a worker who has acknowledged the information notice: once the site's company has
-- published a worker notice in Nexus, the version in force (an acknowledgement of an earlier version, or of none, does
-- not count: art. 4 c.3, the workers are told what the tools record before anything is recorded; GDPR art. 13);
-- before that, any acknowledgement on record (as in B-W1-37; the floor is not ready then anyway: platform/privacy
-- floorPrivacyReady). Called by the cut log and scan triggers for a row inside the session's scope.
CREATE OR REPLACE FUNCTION "factory_production_check_subject"(tenant uuid, site uuid, worker uuid, station uuid, what text, row_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  subject text;
  company uuid;
  in_force record;
BEGIN
  SELECT s."scanSubject"::text INTO subject FROM "ProductionSettings" s WHERE s."tenantId" = tenant AND s."siteId" = site AND s."id" = site;
  IF coalesce(subject, 'WORKER') = 'STATION' THEN
    IF worker IS NOT NULL OR station IS NULL THEN
      RAISE EXCEPTION 'production: site % records the station, not the worker (the monitoring switch, MES-278; Statuto dei Lavoratori art. 4); % % names its station and no worker', site, what, row_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;
  IF worker IS NULL THEN
    RAISE EXCEPTION 'production: site % records the worker; % % names the signed-in worker', site, what, row_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT st."companyId" INTO company FROM "Site" st WHERE st."tenantId" = tenant AND st."id" = site;
  SELECT n."id", n."label" INTO in_force FROM "PrivacyNotice" n
   WHERE n."tenantId" = tenant AND n."companyId" = company AND n."kind" = 'WORKER_FLOOR' AND n."status" = 'PUBLISHED';
  IF FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM "WorkerNoticeAck" a WHERE a."tenantId" = tenant AND a."siteId" = site AND a."workerId" = worker AND a."noticeId" = in_force."id") THEN
      RAISE EXCEPTION 'production: worker % has not acknowledged the information notice in force (version %); no % names a worker before that (Statuto dei Lavoratori art. 4 c.3, GDPR art. 13)', worker, in_force."label", what
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM "PrivacyNotice" n WHERE n."tenantId" = tenant AND n."companyId" = company AND n."kind" = 'WORKER_FLOOR' AND n."status" = 'SUPERSEDED') THEN
    RAISE EXCEPTION 'production: the company of site % has no worker notice in force; no % names a worker (Statuto dei Lavoratori art. 4 c.3, GDPR art. 13)', site, what
      USING ERRCODE = 'check_violation';
  ELSIF NOT EXISTS (SELECT 1 FROM "WorkerNoticeAck" a WHERE a."tenantId" = tenant AND a."siteId" = site AND a."workerId" = worker) THEN
    RAISE EXCEPTION 'production: worker % has not acknowledged the information notice; no % names a worker before that (Statuto dei Lavoratori art. 4 c.3, GDPR art. 13)', worker, what
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
