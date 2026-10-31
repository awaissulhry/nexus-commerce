-- Written by hand (Prisma does not model triggers or partial indexes), after the generated 202610316200_pay_w2b_schema
-- and before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp,
-- and keep it OUT of prisma/migrations while `npm run migration` runs (it needs the new tables).

-- Piece pay and the payroll export (W2b schema wave 6/7): the rules of its tables for every login, the owner included.
-- The API answers first, in words (B-W2b-34 rates and the legal switch, B-W2b-38 schemes, B-W2b-43 earnings, held scans,
-- periods and statements, B-W2b-54 the payroll export); these are the last word. Every refusal is a check_violation
-- (SQLSTATE 23514).
--
--   append-only    EarningsEntry, RateAcknowledgement: UPDATE, DELETE and TRUNCATE refused
--                  (scripts/factory/check-append-only.mjs); a wrong entry is reversed by a new row.
--   the law        a rate version leaves DRAFT only once a publication of it to the workers is dated on or before its
--                  first day (c.c. art. 2101 c.3); a period locks only with no scan held and an APPROVED statement for
--                  every worker paid in it (art. 2101 c.3); a site's legal switch turns ON only with its preconditions on
--                  record (CCNL article, c.c. art. 2100; the published worker notice, Statuto art. 4 c.3; the stored DPIA,
--                  GDPR art. 35; the labour consultant; an ACTIVE scheme; the site's floor rules naming workers with a
--                  legal basis and its PERFORMANCE legal gate in force, Statuto art. 4 c.1), from a day not in the past; the ledger refuses a piece-pay figure dated
--                  outside the site's ON window; a held scan never pays until it is counted.
--   frozen         a rate version from PROVISIONAL on (its status, last day and confirmation aside) and its rates; a
--                  publication (its sheet aside); an ACTIVE scheme (its last day aside); the switch's preconditions while
--                  ON; a LOCKED period; an APPROVED statement (superseded aside) and every statement of a LOCKED period
--                  (its PDF, named once, aside); an EXPORTED payroll export and its files.
--   never deleted  every table but these: a DRAFT version with no publication, the entries of a DRAFT version, a DRAFT
--                  scheme, the files of a DRAFT export. TRUNCATE refused everywhere.
--
-- The tenant (and site) of a row are held by the policies (USING and WITH CHECK) and by the references, not here: the
-- triggers leave "tenantId" (and "siteId") to them, so a row moved to another tenant or site is refused by row-level
-- security. A rule that reads another row skips a row this session cannot see (another tenant's). A trigger reads only
-- tables the role that fires it may read (no floor, portal or platform role touches these tables), and locks a row FOR SHARE only where that role may update it; elsewhere it takes a transaction
-- advisory lock. "Everything but these columns" is compared as jsonb (to_jsonb(row) minus the named keys), so a column
-- added later is frozen too unless a later migration names it. A row about one person names them by employeeId
-- (people.prisma Employee) and, where the floor did the work, the floor sign-in by workerId: the worker's employee must be
-- that person (Worker.employeeId; a worker with none is paid nothing until linked). The generated isolation tests insert a copy of the first
-- row of each table (a new id, unique text suffixed, unique numbers and dates moved): no rule here compares a unique
-- text, number or date with another row's.
--
-- Locks (pg_advisory_xact_lock, held to the end of the transaction): a rate version leaving DRAFT takes its table's
-- 'factory.pay.rate-table' key, a scheme becoming ACTIVE its company's 'factory.pay.scheme' key, so two of them never
-- overlap. Writes into a pay period (an earnings entry, a held scan, a statement) take the period row FOR SHARE, and the
-- lock UPDATEs it: the lock waits for the writes in flight and sees them, and a write after it sees LOCKED.

-- =====================================================================================================================
-- Shared
-- =====================================================================================================================

CREATE FUNCTION "factory_pay_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay: TRUNCATE on "%" is refused; its rows are never deleted', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_pay_refuse_ledger_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; it is kept as it was written (a wrong earnings entry is reversed by a new row, a receipt stands)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- One whole month: its first day and its last day (Europe/Rome days, as dates).
CREATE FUNCTION "factory_pay_one_month"(first_day date, last_day date) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT first_day IS NOT NULL AND last_day IS NOT NULL
     AND first_day = date_trunc('month', first_day)::date
     AND last_day = (date_trunc('month', first_day) + interval '1 month' - interval '1 day')::date
$$;

CREATE FUNCTION "factory_pay_lock"(kind text, tenant uuid, owner uuid) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', kind, tenant, owner), 0))
$$;

-- =====================================================================================================================
-- Piece-rate tables, versions and rates (MES-254, MES-262; c.c. art. 2101)
-- =====================================================================================================================

-- PieceRateTable
--   UPDATE   an UPDATE that changes nothing passes; the company, site and creation never change; its style, line and
--            currency are fixed once a version of it left DRAFT (its published rates mean what they said).
--   every    a code and a name; an ISO currency.
--   DELETE   refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_piece_rate_table_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay: piece-rate table % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."siteId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."siteId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pay: the company, site and creation of piece-rate table % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."styleId", NEW."lineId", NEW."currency") IS DISTINCT FROM (OLD."styleId", OLD."lineId", OLD."currency")
       AND EXISTS (SELECT 1 FROM "PieceRateVersion" v WHERE v."tenantId" = OLD."tenantId" AND v."tableId" = OLD."id" AND v."status" NOT IN ('DRAFT', 'CANCELLED')) THEN
      RAISE EXCEPTION 'pay: piece-rate table % has published rates; its style, line and currency stay as they were (make a new table)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."code") = '' OR btrim(NEW."name") = '' OR NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'pay: piece-rate table % has a code, a name and an ISO currency (three capitals)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PieceRateTable_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PieceRateTable"
  FOR EACH ROW EXECUTE FUNCTION "factory_piece_rate_table_guard"();
CREATE TRIGGER "PieceRateTable_no_truncate" BEFORE TRUNCATE ON "PieceRateTable"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- PieceRateVersion
--   INSERT     a DRAFT: not confirmed, superseded or cancelled.
--   UPDATE     an UPDATE that changes nothing passes; the table, number and creation never change. A DRAFT changes
--              freely and moves DRAFT → PROVISIONAL (provisional, with its trial end) | PUBLISHED (not provisional) |
--              CANCELLED (when, why); PROVISIONAL → PUBLISHED (confirmed: when, who) | SUPERSEDED; PUBLISHED →
--              SUPERSEDED. From PROVISIONAL on only the status, the last day (set once), the confirmation and the
--              supersession change; SUPERSEDED and CANCELLED are final.
--   every row  a number from 1; a last day not before the first; provisional exactly with a trial end after the first
--              day; the confirmation exactly on a provisional version confirmed; SUPERSEDED exactly with its time and a
--              last day; CANCELLED exactly with its time and why.
--   leaving    at least one rate; a PUBLISHED publication of it dated (Europe/Rome) on or before its first day (rates are
--   DRAFT      told before they apply, c.c. art. 2101 c.3); its table ACTIVE; no other version of the table in force
--              (PROVISIONAL, PUBLISHED, SUPERSEDED) overlaps its days (under the table's lock).
--   DELETE     only a DRAFT that was never published (its rates first). TRUNCATE refused.
CREATE FUNCTION "factory_piece_rate_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  late CONSTANT text[] := ARRAY['tenantId', 'status', 'effectiveTo', 'confirmedAt', 'confirmedById', 'supersededAt', 'updatedAt', 'version'];
  table_status text;
  clash record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT'
       OR EXISTS (SELECT 1 FROM "RatePublication" p WHERE p."tenantId" = OLD."tenantId" AND p."versionId" = OLD."id") THEN
      RAISE EXCEPTION 'pay: rate version % is %; only a DRAFT that was never published is deleted (cancel it instead)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'pay: rate version % starts as a DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."tableId", NEW."versionNo", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."tableId", OLD."versionNo", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pay: the table, number and creation of rate version % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('SUPERSEDED', 'CANCELLED') THEN
      RAISE EXCEPTION 'pay: rate version % is %; it never changes again', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' THEN
      IF (to_jsonb(NEW) - late) IS DISTINCT FROM (to_jsonb(OLD) - late) THEN
        RAISE EXCEPTION 'pay: rate version % is %; its rates and days never change (a new rate is a new version with a reason)', OLD."id", OLD."status"
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."effectiveTo" IS NOT NULL AND NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo" THEN
        RAISE EXCEPTION 'pay: the last day of rate version % is set once (%)', OLD."id", OLD."effectiveTo"
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."confirmedAt" IS NOT NULL AND (NEW."confirmedAt", NEW."confirmedById") IS DISTINCT FROM (OLD."confirmedAt", OLD."confirmedById") THEN
        RAISE EXCEPTION 'pay: rate version % was confirmed once; that never changes', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'DRAFT' AND NEW."status" IN ('PROVISIONAL', 'PUBLISHED', 'CANCELLED'))
      OR (OLD."status" = 'PROVISIONAL' AND NEW."status" IN ('PUBLISHED', 'SUPERSEDED'))
      OR (OLD."status" = 'PUBLISHED' AND NEW."status" = 'SUPERSEDED')) THEN
      RAISE EXCEPTION 'pay: rate version % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'PUBLISHED' AND NEW."provisional" THEN
      RAISE EXCEPTION 'pay: rate version % is provisional; it is published as PROVISIONAL and confirmed after its trial', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."versionNo" < 1
     OR (NEW."effectiveTo" IS NOT NULL AND NEW."effectiveTo" < NEW."effectiveFrom")
     OR NEW."provisional" <> (NEW."trialEndsOn" IS NOT NULL)
     OR (NEW."trialEndsOn" IS NOT NULL AND NEW."trialEndsOn" <= NEW."effectiveFrom") THEN
    RAISE EXCEPTION 'pay: rate version % has a number from 1, a last day not before its first, and a trial end (after its first day) exactly when provisional', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."confirmedAt" IS NULL) <> (NEW."confirmedById" IS NULL)
     OR (NEW."status" = 'PROVISIONAL' AND (NOT NEW."provisional" OR NEW."confirmedAt" IS NOT NULL))
     OR (NEW."status" = 'PUBLISHED' AND NEW."provisional" <> (NEW."confirmedAt" IS NOT NULL))
     OR (NEW."status" IN ('DRAFT', 'CANCELLED') AND NEW."confirmedAt" IS NOT NULL)
     OR (NEW."status" = 'SUPERSEDED') <> (NEW."supersededAt" IS NOT NULL)
     OR (NEW."status" = 'SUPERSEDED' AND NEW."effectiveTo" IS NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL) OR btrim(NEW."cancelReason") = '' THEN
    RAISE EXCEPTION 'pay: rate version % is % with the wrong columns (confirmed exactly when a provisional one is confirmed; superseded with its time and a last day; cancelled with its time and why)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" = 'DRAFT' AND NEW."status" IN ('PROVISIONAL', 'PUBLISHED') THEN
    PERFORM "factory_pay_lock"('factory.pay.rate-table', NEW."tenantId", NEW."tableId");
    IF NOT EXISTS (SELECT 1 FROM "PieceRateEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."versionId" = NEW."id") THEN
      RAISE EXCEPTION 'pay: rate version % has no rate; it cannot be put in force', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "RatePublication" p WHERE p."tenantId" = NEW."tenantId" AND p."versionId" = NEW."id" AND p."status" = 'PUBLISHED'
                    AND "factory_money_rome_day"(p."publishedAt") <= NEW."effectiveFrom") THEN
      RAISE EXCEPTION 'pay: rate version % was not published to the workers on or before its first day %; rates are told before they apply (c.c. art. 2101)', NEW."id", NEW."effectiveFrom"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT t."status"::text INTO table_status FROM "PieceRateTable" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."tableId";
    IF FOUND AND table_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'pay: the table of rate version % is %; an archived table puts no rate in force', NEW."id", table_status
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT v."id", v."versionNo", v."effectiveFrom", v."effectiveTo" INTO clash FROM "PieceRateVersion" v
     WHERE v."tenantId" = NEW."tenantId" AND v."tableId" = NEW."tableId" AND v."id" <> NEW."id"
       AND v."status" IN ('PROVISIONAL', 'PUBLISHED', 'SUPERSEDED')
       AND v."effectiveFrom" <= coalesce(NEW."effectiveTo", 'infinity'::date)
       AND NEW."effectiveFrom" <= coalesce(v."effectiveTo", 'infinity'::date)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'pay: rate version % (from %) overlaps version % of the same table (% to %); set its last day first', NEW."id", NEW."effectiveFrom", clash."versionNo", clash."effectiveFrom", coalesce(clash."effectiveTo"::text, 'open')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PieceRateVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PieceRateVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_piece_rate_version_guard"();
CREATE TRIGGER "PieceRateVersion_no_truncate" BEFORE TRUNCATE ON "PieceRateVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- PieceRateEntry
--   any write  only while its version is a DRAFT (the version's row FOR SHARE: putting it in force waits for these and
--              sees them). An UPDATE that changes nothing passes; its version and creation never change.
--   every row  a size band; SMV_RATE: standard minutes above 0, a rate per minute of 0 or more, and the rate per piece =
--              minutes × rate per minute rounded to six decimals; FIXED: no rate per minute, a rate per piece of 0 or more,
--              standard minutes (when given) of 0 or more.
--   TRUNCATE   refused.
CREATE FUNCTION "factory_piece_rate_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."versionId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."versionId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pay: the version and creation of rate % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT v."status"::text INTO state FROM "PieceRateVersion" v
   WHERE v."tenantId" = CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END
     AND v."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."versionId" ELSE NEW."versionId" END
   FOR SHARE;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'pay: rate version % is %; its rates are written only while it is a DRAFT (a new rate is a new version)', CASE WHEN TG_OP = 'DELETE' THEN OLD."versionId" ELSE NEW."versionId" END, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF btrim(NEW."sizeBand") = '' THEN
    RAISE EXCEPTION 'pay: rate % names its size band ("ALL" for every size)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."basis" = 'SMV_RATE' AND (NEW."standardMinutes" IS NULL OR NEW."standardMinutes" <= 0 OR NEW."ratePerMinute" IS NULL OR NEW."ratePerMinute" < 0
                                   OR NEW."ratePerPiece" <> round(NEW."standardMinutes" * NEW."ratePerMinute", 6)) THEN
    RAISE EXCEPTION 'pay: rate % (SMV × rate per minute) has standard minutes above 0, a rate per minute of 0 or more, and a rate per piece of exactly their product rounded to six decimals (%, not %)', NEW."id", round(NEW."standardMinutes" * NEW."ratePerMinute", 6), NEW."ratePerPiece"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."basis" = 'FIXED' AND (NEW."ratePerMinute" IS NOT NULL OR NEW."ratePerPiece" < 0 OR NEW."standardMinutes" < 0) THEN
    RAISE EXCEPTION 'pay: rate % (fixed per piece) has no rate per minute, a rate per piece of 0 or more and no negative standard minutes', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PieceRateEntry_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PieceRateEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_piece_rate_entry_guard"();
CREATE TRIGGER "PieceRateEntry_no_truncate" BEFORE TRUNCATE ON "PieceRateEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- =====================================================================================================================
-- Publication to the workers and their receipts (MES-255; c.c. art. 2101 c.3)
-- =====================================================================================================================

-- RatePublication
--   INSERT     PUBLISHED, not withdrawn; of a version not SUPERSEDED or CANCELLED; on the floor and/or printed; to at
--              least one worker, each once, each an ACTIVE worker of the site.
--   UPDATE     an UPDATE that changes nothing passes; nothing changes but the printed sheet (named once: a StoredFile of
--              the publication) and PUBLISHED → WITHDRAWN (when, who, why), only while its version is still a DRAFT.
--   every row  withdrawn exactly when WITHDRAWN, with why.
--   DELETE     refused (its receipts name it). TRUNCATE refused.
CREATE FUNCTION "factory_rate_publication_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  late CONSTANT text[] := ARRAY['tenantId', 'sheetFileId', 'status', 'withdrawnAt', 'withdrawnById', 'withdrawReason', 'updatedAt', 'version'];
  version_status text;
  seen_workers int;
  active_workers int;
  file_type text;
  file_record uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay: rate publication % is withdrawn or kept, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT v."status"::text INTO version_status FROM "PieceRateVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."versionId";
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'pay: rate publication % starts PUBLISHED, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF version_status IN ('SUPERSEDED', 'CANCELLED') THEN
      RAISE EXCEPTION 'pay: rate version % is %; it is published no more', NEW."versionId", version_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (NEW."onFloor" OR NEW."printed") THEN
      RAISE EXCEPTION 'pay: rate publication % goes on the floor, on paper or both', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- The workers this session can see (none: another tenant's row, which the policy refuses).
    SELECT count(*)::int, count(*) FILTER (WHERE w."siteId" = NEW."siteId" AND w."status" = 'ACTIVE')::int INTO seen_workers, active_workers FROM "Worker" w
     WHERE w."tenantId" = NEW."tenantId" AND w."id" = ANY (NEW."workerIds");
    IF cardinality(NEW."workerIds") IS NULL OR cardinality(NEW."workerIds") < 1
       OR cardinality(NEW."workerIds") <> (SELECT count(DISTINCT w) FROM unnest(NEW."workerIds") AS t(w))
       OR (seen_workers > 0 AND active_workers <> cardinality(NEW."workerIds")) THEN
      RAISE EXCEPTION 'pay: rate publication % goes to at least one worker, each once, each an ACTIVE worker of its site (% of % are)', NEW."id", active_workers, coalesce(cardinality(NEW."workerIds"), 0)
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - late) IS DISTINCT FROM (to_jsonb(OLD) - late) THEN
      RAISE EXCEPTION 'pay: rate publication % never changes (its printed sheet and a withdrawal aside)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."sheetFileId" IS NOT NULL AND NEW."sheetFileId" IS DISTINCT FROM OLD."sheetFileId" THEN
      RAISE EXCEPTION 'pay: the printed sheet of rate publication % is named once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'WITHDRAWN' AND (NEW."status", NEW."withdrawnAt", NEW."withdrawnById", NEW."withdrawReason") IS DISTINCT FROM (OLD."status", OLD."withdrawnAt", OLD."withdrawnById", OLD."withdrawReason") THEN
      RAISE EXCEPTION 'pay: rate publication % was withdrawn; that is final', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'WITHDRAWN' AND OLD."status" = 'PUBLISHED' AND version_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'pay: rate version % is %; its publications stand (the receipts and the rates in force rest on them)', NEW."versionId", version_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL)
     OR (NEW."withdrawnAt" IS NULL) <> (NEW."withdrawnById" IS NULL)
     OR (NEW."withdrawnAt" IS NULL) <> (NEW."withdrawReason" IS NULL) OR btrim(NEW."withdrawReason") = '' THEN
    RAISE EXCEPTION 'pay: rate publication % is % with the wrong columns (withdrawn exactly when WITHDRAWN: when, who, why)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sheetFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."sheetFileId" IS NULL) THEN
    SELECT f."recordType", f."recordId" INTO file_type, file_record FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."sheetFileId";
    IF FOUND AND (file_type <> 'RatePublication' OR file_record <> NEW."id") THEN
      RAISE EXCEPTION 'pay: the sheet of rate publication % is a stored file of the publication (recordType RatePublication), not of % %', NEW."id", file_type, file_record
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RatePublication_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RatePublication"
  FOR EACH ROW EXECUTE FUNCTION "factory_rate_publication_guard"();
CREATE TRIGGER "RatePublication_no_truncate" BEFORE TRUNCATE ON "RatePublication"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- RateAcknowledgement: append-only (no login changes or removes a receipt).
CREATE TRIGGER "RateAcknowledgement_append_only" BEFORE UPDATE OR DELETE ON "RateAcknowledgement"
  FOR EACH ROW EXECUTE FUNCTION "factory_pay_refuse_ledger_change"();
CREATE TRIGGER "RateAcknowledgement_no_truncate" BEFORE TRUNCATE ON "RateAcknowledgement"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- RateAcknowledgement, INSERT: a PUBLISHED publication; its version; one of its workers, ACTIVE, whose employee is the
-- receipt's person; DEVICE: a device and no paper; PAPER: no device, clock or event id, and the signed copy (when named) a
-- StoredFile of the publication.
CREATE FUNCTION "factory_rate_acknowledgement_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  publication record;
  worker record;
  file_type text;
  file_record uuid;
BEGIN
  SELECT p."status"::text AS status, p."versionId" AS version_id, p."workerIds" AS worker_ids INTO publication FROM "RatePublication" p
   WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."publicationId";
  IF FOUND THEN
    IF publication.status <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'pay: rate publication % is %; nobody acknowledges it', NEW."publicationId", publication.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF publication.version_id <> NEW."versionId" OR NOT (NEW."workerId" = ANY (publication.worker_ids)) THEN
      RAISE EXCEPTION 'pay: receipt % names the version of publication % and one of the workers it went to', NEW."id", NEW."publicationId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT w."status"::text AS status, w."employeeId" AS employee_id INTO worker FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workerId";
  IF FOUND AND worker.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'pay: worker % is %; an inactive worker acknowledges nothing', NEW."workerId", worker.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF FOUND AND worker.employee_id IS DISTINCT FROM NEW."employeeId" THEN
    RAISE EXCEPTION 'pay: receipt % names employee %, but worker % is the floor sign-in of %', NEW."id", NEW."employeeId", NEW."workerId", coalesce(worker.employee_id::text, 'no employee yet')
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."channel" = 'DEVICE' AND (NEW."deviceId" IS NULL OR NEW."paperFileId" IS NOT NULL))
     OR (NEW."channel" = 'PAPER' AND (NEW."deviceId" IS NOT NULL OR NEW."deviceTime" IS NOT NULL OR NEW."clientEventId" IS NOT NULL))
     OR btrim(NEW."clientEventId") = '' THEN
    RAISE EXCEPTION 'pay: receipt % on a device names the device (no paper); on paper it names no device, clock or event id', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."paperFileId" IS NOT NULL THEN
    SELECT f."recordType", f."recordId" INTO file_type, file_record FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."paperFileId";
    IF FOUND AND (file_type <> 'RatePublication' OR file_record <> NEW."publicationId") THEN
      RAISE EXCEPTION 'pay: the signed copy of receipt % is a stored file of publication % (recordType RatePublication), not of % %', NEW."id", NEW."publicationId", file_type, file_record
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RateAcknowledgement_check" BEFORE INSERT ON "RateAcknowledgement"
  FOR EACH ROW EXECUTE FUNCTION "factory_rate_acknowledgement_check"();

-- =====================================================================================================================
-- Incentive schemes (MES-253, MES-257…MES-259, MES-264, MES-148)
-- =====================================================================================================================

-- IncentiveScheme
--   INSERT     a DRAFT, not activated.
--   UPDATE     an UPDATE that changes nothing passes; the company, line and creation never change. A DRAFT changes
--              freely and moves DRAFT → ACTIVE (when, who); ACTIVE → RETIRED. From ACTIVE on only its last day (set
--              once) and the move to RETIRED change; RETIRED is final.
--   every row  a name; a line exactly with its site, a site of the company; an ISO currency; a last day not before the
--              first; STANDARD_MINUTE_BONUS exactly with a threshold (above 0, at most 200); TEAM_INCENTIVE exactly with a
--              team split; a reduced own-fault rate (above 0, below 100) exactly when rework or scrap is REDUCED_RATE;
--              rates of 0 or more; activated exactly when ACTIVE or RETIRED; RETIRED with a last day.
--   ACTIVE     a guaranteed basis given and its rate per hour; no other ACTIVE or RETIRED scheme of the company and line
--              overlaps its days (under the company's lock).
--   DELETE     only a DRAFT. TRUNCATE refused.
CREATE FUNCTION "factory_incentive_scheme_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  late CONSTANT text[] := ARRAY['tenantId', 'status', 'validTo', 'updatedAt', 'version'];
  site_company uuid;
  clash record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'pay: incentive scheme % is %; only a DRAFT is deleted (retire it instead)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'pay: incentive scheme % starts as a DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."siteId", NEW."lineId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."siteId", OLD."lineId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pay: the company, line and creation of incentive scheme % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'RETIRED' THEN
      RAISE EXCEPTION 'pay: incentive scheme % is RETIRED; it never changes again', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'ACTIVE' THEN
      IF (to_jsonb(NEW) - late) IS DISTINCT FROM (to_jsonb(OLD) - late) THEN
        RAISE EXCEPTION 'pay: incentive scheme % is ACTIVE; it changes only by a later scheme (its last day aside)', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."validTo" IS NOT NULL AND NEW."validTo" IS DISTINCT FROM OLD."validTo" THEN
        RAISE EXCEPTION 'pay: the last day of incentive scheme % is set once (%)', OLD."id", OLD."validTo"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."status" <> OLD."status" AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE') OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED')) THEN
      RAISE EXCEPTION 'pay: incentive scheme % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."name") = '' OR NEW."currency" !~ '^[A-Z]{3}$' OR (NEW."siteId" IS NULL) <> (NEW."lineId" IS NULL)
     OR (NEW."validTo" IS NOT NULL AND NEW."validTo" < NEW."validFrom") THEN
    RAISE EXCEPTION 'pay: incentive scheme % has a name, an ISO currency, a line exactly with its site, and a last day not before its first', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."siteId" IS NOT NULL AND (TG_OP = 'INSERT') THEN
    SELECT s."companyId" INTO site_company FROM "Site" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."siteId";
    IF FOUND AND site_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'pay: the line of incentive scheme % is on a site of another company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."kind" = 'STANDARD_MINUTE_BONUS') <> (NEW."efficiencyThresholdPct" IS NOT NULL)
     OR NEW."efficiencyThresholdPct" <= 0 OR NEW."efficiencyThresholdPct" > 200
     OR (NEW."kind" = 'TEAM_INCENTIVE') <> (NEW."teamSplit" IS NOT NULL)
     OR ('REDUCED_RATE' IN (NEW."reworkOwnFault", NEW."scrapOwnFault")) <> (NEW."ownFaultRatePct" IS NOT NULL)
     OR NEW."ownFaultRatePct" <= 0 OR NEW."ownFaultRatePct" >= 100
     OR NEW."guaranteedHourlyRate" < 0 OR NEW."traineeHourlyRate" < 0 THEN
    RAISE EXCEPTION 'pay: incentive scheme % has a threshold (above 0, at most 200) exactly for a standard-minute bonus, a team split exactly for a team incentive, a reduced own-fault rate (above 0, below 100) exactly when one is reduced, and no negative rate', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('ACTIVE', 'RETIRED')) <> (NEW."activatedAt" IS NOT NULL)
     OR (NEW."activatedAt" IS NULL) <> (NEW."activatedById" IS NULL)
     OR (NEW."status" = 'RETIRED' AND NEW."validTo" IS NULL) THEN
    RAISE EXCEPTION 'pay: incentive scheme % is % with the wrong columns (activated exactly when ACTIVE or RETIRED; retired with a last day)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'ACTIVE' AND (TG_OP = 'INSERT' OR OLD."status" = 'DRAFT') THEN
    IF NEW."guaranteedBasis" = 'UNDECIDED' OR NEW."guaranteedHourlyRate" IS NULL THEN
      RAISE EXCEPTION 'pay: incentive scheme % has no guaranteed pay yet (its basis and rate per hour: the labour consultant''s); it cannot be ACTIVE', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_pay_lock"('factory.pay.scheme', NEW."tenantId", NEW."companyId");
    SELECT s."name", s."validFrom", s."validTo" INTO clash FROM "IncentiveScheme" s
     WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId" AND s."lineId" IS NOT DISTINCT FROM NEW."lineId"
       AND s."id" <> NEW."id" AND s."status" IN ('ACTIVE', 'RETIRED')
       AND s."validFrom" <= coalesce(NEW."validTo", 'infinity'::date)
       AND NEW."validFrom" <= coalesce(s."validTo", 'infinity'::date)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'pay: incentive scheme % (from %) overlaps scheme "%" of the same company and line (% to %); set its last day first', NEW."id", NEW."validFrom", clash."name", clash."validFrom", coalesce(clash."validTo"::text, 'open')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "IncentiveScheme_guard" BEFORE INSERT OR UPDATE OR DELETE ON "IncentiveScheme"
  FOR EACH ROW EXECUTE FUNCTION "factory_incentive_scheme_guard"();
CREATE TRIGGER "IncentiveScheme_no_truncate" BEFORE TRUNCATE ON "IncentiveScheme"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- =====================================================================================================================
-- The legal switch of each site (GATE-PIECE-PAY, GATE-LABOUR)
-- =====================================================================================================================

-- PiecePaySwitch
--   INSERT     OFF, with no window; or ON through the same gate as turning it on (below).
--   UPDATE     an UPDATE that changes nothing passes; the company, site and creation never change. While ON nothing
--              changes but its note (its basis never changes while it runs). OFF → ON: every precondition on record (see
--              below), from a day (onFrom) not before the day it is turned on nor before the last window's end; the off
--              columns cleared. ON → OFF: the window's start kept; when, who, why, and the first day it no longer counts
--              (offFrom), not before the window's start nor the day it is turned off. While OFF the last window's columns
--              never change; the preconditions may. The earlier windows change only when it is turned on again: the
--              window just closed is appended ({ from, to }).
--   every row  ON: a window start, no end; OFF: no window, or a whole one (start and end); each group of columns
--              together; texts not blank.
--   ON needs   the CCNL and its article; the company's PUBLISHED worker notice (WORKER_FLOOR); the company's STORED DPIA;
--              the labour consultant and the day they agreed (not after the day it is turned on); an ACTIVE scheme of the
--              company (its own or a line's of this site) in force on the first day; the site's floor rules naming workers
--              with a legal basis on record (production.prisma ProductionSettings: scanSubject WORKER, monitoringBasis);
--              the site's PERFORMANCE legal gate in force (people.prisma PeopleLegalGate, not switched off: one person's
--              work figures, Statuto art. 4 c.1).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_piece_pay_switch_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  note_only CONSTANT text[] := ARRAY['tenantId', 'preconditionsNote', 'updatedAt', 'version'];
  window_columns CONSTANT text[] := ARRAY['onFrom', 'switchedOnAt', 'switchedOnById', 'offFrom', 'switchedOffAt', 'switchedOffById', 'offReason'];
  notice record;
  dpia record;
  scheme record;
  rules record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay: the legal switch % of piece pay is turned off, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."offFrom" IS NOT NULL OR NEW."switchedOffAt" IS NOT NULL OR NEW."earlierWindows" <> '[]'::jsonb
       OR (NEW."state" = 'OFF' AND (NEW."onFrom" IS NOT NULL OR NEW."switchedOnAt" IS NOT NULL)) THEN
      RAISE EXCEPTION 'pay: the legal switch % of piece pay starts OFF with no window (or ON, through the same gate as turning it on)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."siteId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."siteId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pay: the company, site and creation of legal switch % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'ON' AND NEW."state" = 'ON' AND (to_jsonb(NEW) - note_only) IS DISTINCT FROM (to_jsonb(OLD) - note_only) THEN
      RAISE EXCEPTION 'pay: piece pay is ON at site % (from %); its preconditions never change while it runs (turn it off first)', OLD."siteId", OLD."onFrom"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'OFF' AND NEW."state" = 'OFF'
       AND (NEW."onFrom", NEW."switchedOnAt", NEW."switchedOnById", NEW."offFrom", NEW."switchedOffAt", NEW."switchedOffById", NEW."offReason", NEW."earlierWindows")
           IS DISTINCT FROM (OLD."onFrom", OLD."switchedOnAt", OLD."switchedOnById", OLD."offFrom", OLD."switchedOffAt", OLD."switchedOffById", OLD."offReason", OLD."earlierWindows") THEN
      RAISE EXCEPTION 'pay: legal switch % is OFF; the record of its last window never changes (turning it on starts a new one)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'ON' AND NEW."state" = 'OFF' THEN
      IF (to_jsonb(NEW) - window_columns - note_only - 'state') IS DISTINCT FROM (to_jsonb(OLD) - window_columns - note_only - 'state')
         OR (NEW."onFrom", NEW."switchedOnAt", NEW."switchedOnById") IS DISTINCT FROM (OLD."onFrom", OLD."switchedOnAt", OLD."switchedOnById") THEN
        RAISE EXCEPTION 'pay: turning legal switch % off changes only the off columns (the window''s start and the preconditions stay on record)', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."offFrom" IS NULL OR NEW."switchedOffAt" IS NULL
         OR NEW."offFrom" < greatest(OLD."onFrom", "factory_money_rome_day"(NEW."switchedOffAt")) THEN
        RAISE EXCEPTION 'pay: piece pay at site % stops from a day not before its start (%) nor before the day it is turned off; never in the past', OLD."siteId", OLD."onFrom"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."state" = 'ON' AND (TG_OP = 'INSERT' OR OLD."state" = 'OFF') THEN
      IF NEW."switchedOnAt" IS NULL OR NEW."onFrom" IS NULL
         OR (TG_OP = 'UPDATE' AND OLD."switchedOnAt" IS NOT NULL AND NEW."switchedOnAt" <= OLD."switchedOnAt")
         OR NEW."onFrom" < "factory_money_rome_day"(NEW."switchedOnAt")
         OR (TG_OP = 'UPDATE' AND OLD."offFrom" IS NOT NULL AND NEW."onFrom" < OLD."offFrom") THEN
        RAISE EXCEPTION 'pay: piece pay at site % starts from a day not before the day it is turned on (never in the past) nor before its last window ended', NEW."siteId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."earlierWindows" IS DISTINCT FROM (CASE
           WHEN TG_OP = 'UPDATE' AND OLD."onFrom" IS NOT NULL THEN OLD."earlierWindows" || jsonb_build_array(jsonb_build_object('from', OLD."onFrom", 'to', OLD."offFrom"))
           WHEN TG_OP = 'UPDATE' THEN OLD."earlierWindows"
           ELSE '[]'::jsonb END) THEN
        RAISE EXCEPTION 'pay: turning legal switch % on again keeps its earlier windows and appends the one just closed ({ from, to })', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF btrim(coalesce(NEW."ccnlName", '')) = '' OR btrim(coalesce(NEW."ccnlArticle", '')) = '' THEN
        RAISE EXCEPTION 'pay: piece pay at site % needs the CCNL and its article that allow piece work on record (c.c. art. 2100)', NEW."siteId"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT n."kind"::text AS kind, n."status"::text AS status INTO notice FROM "PrivacyNotice" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."workerNoticeId";
      IF NEW."workerNoticeId" IS NULL OR (FOUND AND (notice.kind <> 'WORKER_FLOOR' OR notice.status <> 'PUBLISHED')) THEN
        RAISE EXCEPTION 'pay: piece pay at site % needs the company''s PUBLISHED worker notice that covers it (Statuto art. 4 c.3; GDPR art. 13)', NEW."siteId"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT d."companyId" AS company_id, d."status"::text AS status INTO dpia FROM "PrivacyDpia" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."dpiaId";
      IF NEW."dpiaId" IS NULL OR (FOUND AND (dpia.company_id <> NEW."companyId" OR dpia.status <> 'STORED')) THEN
        RAISE EXCEPTION 'pay: piece pay at site % needs the company''s STORED DPIA that covers it (GDPR art. 35)', NEW."siteId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF btrim(coalesce(NEW."consultantName", '')) = '' OR NEW."consultantAgreedOn" IS NULL
         OR NEW."consultantAgreedOn" > "factory_money_rome_day"(NEW."switchedOnAt") THEN
        RAISE EXCEPTION 'pay: piece pay at site % needs the labour consultant''s agreement on record (who, and a day not after today)', NEW."siteId"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT s."status"::text AS status, s."siteId" AS site_id, s."validFrom" AS valid_from, s."validTo" AS valid_to INTO scheme FROM "IncentiveScheme" s
       WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."schemeId";
      IF NEW."schemeId" IS NULL
         OR (FOUND AND (scheme.status <> 'ACTIVE' OR (scheme.site_id IS NOT NULL AND scheme.site_id <> NEW."siteId")
                        OR scheme.valid_from > NEW."onFrom" OR (scheme.valid_to IS NOT NULL AND scheme.valid_to < NEW."onFrom"))) THEN
        RAISE EXCEPTION 'pay: piece pay at site % needs an ACTIVE incentive scheme of the company (its own or a line''s of this site) in force from %', NEW."siteId", NEW."onFrom"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."scanSubject"::text AS subject, r."monitoringBasis"::text AS basis INTO rules FROM "ProductionSettings" r
       WHERE r."tenantId" = NEW."tenantId" AND r."siteId" = NEW."siteId"
       ORDER BY (r."id" = NEW."siteId") DESC
       LIMIT 1;
      IF NOT FOUND OR rules.subject <> 'WORKER' OR rules.basis IS NULL THEN
        RAISE EXCEPTION 'pay: piece pay at site % needs its floor rules to name workers with a legal basis on record (Statuto art. 4 c.1: a union agreement or the Ispettorato''s authorisation; Production › Settings)', NEW."siteId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM "PeopleLegalGate" g WHERE g."tenantId" = NEW."tenantId" AND g."siteId" = NEW."siteId"
                       AND g."purpose" = 'PERFORMANCE' AND g."switchedOffAt" IS NULL) THEN
        RAISE EXCEPTION 'pay: piece pay at site % needs the site''s PERFORMANCE legal gate switched on (one person''s work figures: Statuto art. 4 c.1; People › Settings)', NEW."siteId"
          USING ERRCODE = 'check_violation';
      END IF;
  END IF;

  IF (NEW."onFrom" IS NULL) <> (NEW."switchedOnAt" IS NULL) OR (NEW."onFrom" IS NULL) <> (NEW."switchedOnById" IS NULL)
     OR (NEW."offFrom" IS NULL) <> (NEW."switchedOffAt" IS NULL) OR (NEW."offFrom" IS NULL) <> (NEW."switchedOffById" IS NULL)
     OR (NEW."offFrom" IS NULL) <> (NEW."offReason" IS NULL) OR btrim(NEW."offReason") = ''
     OR (NEW."state" = 'ON' AND (NEW."onFrom" IS NULL OR NEW."offFrom" IS NOT NULL))
     OR (NEW."state" = 'OFF' AND (NEW."onFrom" IS NULL) <> (NEW."offFrom" IS NULL))
     OR btrim(NEW."ccnlName") = '' OR btrim(NEW."ccnlArticle") = '' OR btrim(NEW."consultantName") = ''
     OR jsonb_typeof(NEW."earlierWindows") <> 'array' THEN
    RAISE EXCEPTION 'pay: legal switch % is % with the wrong columns (ON: a window start and no end; OFF: no window or a whole one with when, who and why; no blank text; the earlier windows a list)', NEW."id", NEW."state"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PiecePaySwitch_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PiecePaySwitch"
  FOR EACH ROW EXECUTE FUNCTION "factory_piece_pay_switch_guard"();
CREATE TRIGGER "PiecePaySwitch_no_truncate" BEFORE TRUNCATE ON "PiecePaySwitch"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- =====================================================================================================================
-- Pay periods, held scans, statements (MES-260, MES-261, MES-264; c.c. art. 2101 c.3)
-- =====================================================================================================================

-- PayPeriod
--   INSERT     OPEN: not previewed, reviewed or locked.
--   UPDATE     an UPDATE that changes nothing passes; the company, month and creation never change; OPEN → PREVIEW;
--              PREVIEW → OPEN | REVIEW; REVIEW → PREVIEW | LOCKED; LOCKED is final (nothing changes).
--   every row  one whole month; the latest run (when, who) from PREVIEW on; the review's start exactly while REVIEW or
--              LOCKED; the lock exactly when LOCKED.
--   LOCKED     no scan of the period still held; no statement of it in DRAFT; an APPROVED statement for every person with
--              an entry in it.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_pay_period_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held int;
  drafts int;
  unstated int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay: pay period % is kept, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'pay: pay period % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."periodStart", NEW."periodEnd", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."periodStart", OLD."periodEnd", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pay: the company, month and creation of pay period % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'LOCKED' THEN
      RAISE EXCEPTION 'pay: pay period % (%) is LOCKED; it never changes (a change is a new entry in a later period that names it)', OLD."id", to_char(OLD."periodStart", 'YYYY-MM')
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'OPEN' AND NEW."status" = 'PREVIEW')
      OR (OLD."status" = 'PREVIEW' AND NEW."status" IN ('OPEN', 'REVIEW'))
      OR (OLD."status" = 'REVIEW' AND NEW."status" IN ('PREVIEW', 'LOCKED'))) THEN
      RAISE EXCEPTION 'pay: pay period % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_pay_one_month"(NEW."periodStart", NEW."periodEnd") THEN
    RAISE EXCEPTION 'pay: pay period % is one whole month: its first day to its last day, not % to %', NEW."id", NEW."periodStart", NEW."periodEnd"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."previewedAt" IS NULL) <> (NEW."previewedById" IS NULL)
     OR (NEW."status" IN ('PREVIEW', 'REVIEW', 'LOCKED') AND NEW."previewedAt" IS NULL)
     OR (NEW."reviewStartedAt" IS NULL) <> (NEW."reviewStartedById" IS NULL)
     OR (NEW."status" IN ('REVIEW', 'LOCKED')) <> (NEW."reviewStartedAt" IS NOT NULL)
     OR (NEW."status" = 'LOCKED') <> (NEW."lockedAt" IS NOT NULL)
     OR (NEW."lockedAt" IS NULL) <> (NEW."lockedById" IS NULL) THEN
    RAISE EXCEPTION 'pay: pay period % is % with the wrong columns (its latest run from PREVIEW on; the review''s start exactly while REVIEW or LOCKED; the lock exactly when LOCKED)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'LOCKED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'LOCKED') THEN
    SELECT count(*)::int INTO held FROM "HeldScan" h WHERE h."tenantId" = NEW."tenantId" AND h."payPeriodId" = NEW."id" AND h."status" = 'OPEN';
    SELECT count(*)::int INTO drafts FROM "WorkerStatement" s WHERE s."tenantId" = NEW."tenantId" AND s."payPeriodId" = NEW."id" AND s."status" = 'DRAFT';
    SELECT count(DISTINCT e."employeeId")::int INTO unstated FROM "EarningsEntry" e
     WHERE e."tenantId" = NEW."tenantId" AND e."payPeriodId" = NEW."id"
       AND NOT EXISTS (SELECT 1 FROM "WorkerStatement" s WHERE s."tenantId" = e."tenantId" AND s."payPeriodId" = e."payPeriodId" AND s."employeeId" = e."employeeId" AND s."status" = 'APPROVED');
    IF held > 0 OR drafts > 0 OR unstated > 0 THEN
      RAISE EXCEPTION 'pay: pay period % (%) cannot lock: % scan(s) still held, % statement(s) in DRAFT, % person(s) paid without an APPROVED statement (c.c. art. 2101)', NEW."id", to_char(NEW."periodStart", 'YYYY-MM'), held, drafts, unstated
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PayPeriod_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PayPeriod"
  FOR EACH ROW EXECUTE FUNCTION "factory_pay_period_guard"();
CREATE TRIGGER "PayPeriod_no_truncate" BEFORE TRUNCATE ON "PayPeriod"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- HeldScan
--   any write  its period not LOCKED (the period's row FOR SHARE: the lock waits and sees it).
--   INSERT     OPEN, not resolved; a key; a REPORT or CORRECTION scan that names its worker; the worker's employee is the
--              hold's person.
--   UPDATE     an UPDATE that changes nothing passes; nothing changes but the decision: OPEN → COUNTED | NOT_PAID, once.
--   every row  resolved (when, who) exactly once decided; COUNTED with the record of the fix (together); NOT_PAID with
--              why.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_held_scan_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  decision CONSTANT text[] := ARRAY['tenantId', 'status', 'resolvedAt', 'resolvedById', 'resolutionNote', 'fixRecordType', 'fixRecordId', 'updatedAt', 'version'];
  period_status text;
  scan record;
  worker_employee uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay: held scan % is decided, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - decision) IS DISTINCT FROM (to_jsonb(OLD) - decision) THEN
      RAISE EXCEPTION 'pay: held scan % changes only by its decision', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'pay: held scan % was decided (%); that is final', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT p."status"::text INTO period_status FROM "PayPeriod" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."payPeriodId" FOR SHARE;
  IF period_status = 'LOCKED' THEN
    RAISE EXCEPTION 'pay: pay period % is LOCKED; its held scans are decided before the lock', NEW."payPeriodId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR btrim(NEW."key") = '' THEN
      RAISE EXCEPTION 'pay: held scan % starts OPEN, with its key', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT s."kind"::text AS kind, s."workerId" AS worker_id INTO scan FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."operationScanId";
    IF FOUND AND (scan.kind NOT IN ('REPORT', 'CORRECTION') OR scan.worker_id IS DISTINCT FROM NEW."workerId") THEN
      RAISE EXCEPTION 'pay: held scan % holds a report or correction scan of its own worker (scan % is a % of another worker or of the station)', NEW."id", NEW."operationScanId", scan.kind
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT w."employeeId" INTO worker_employee FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workerId";
    IF FOUND AND worker_employee IS DISTINCT FROM NEW."employeeId" THEN
      RAISE EXCEPTION 'pay: held scan % names employee %, but worker % is the floor sign-in of %', NEW."id", NEW."employeeId", NEW."workerId", coalesce(worker_employee::text, 'no employee yet')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."status" <> 'OPEN') <> (NEW."resolvedAt" IS NOT NULL) OR (NEW."resolvedAt" IS NULL) <> (NEW."resolvedById" IS NULL)
     OR (NEW."fixRecordType" IS NULL) <> (NEW."fixRecordId" IS NULL) OR btrim(NEW."fixRecordType") = ''
     OR (NEW."status" = 'COUNTED') <> (NEW."fixRecordType" IS NOT NULL)
     OR (NEW."status" = 'NOT_PAID' AND btrim(coalesce(NEW."resolutionNote", '')) = '')
     OR btrim(NEW."resolutionNote") = '' THEN
    RAISE EXCEPTION 'pay: held scan % is % with the wrong columns (decided once: when and who; counted with the record of the attendance fix; not paid with why)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "HeldScan_guard" BEFORE INSERT OR UPDATE OR DELETE ON "HeldScan"
  FOR EACH ROW EXECUTE FUNCTION "factory_held_scan_guard"();
CREATE TRIGGER "HeldScan_no_truncate" BEFORE TRUNCATE ON "HeldScan"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- WorkerStatement
--   any write  its period's row FOR SHARE; while the period is LOCKED nothing changes but the PDF named once, and nothing
--              is inserted.
--   INSERT     a DRAFT, not approved or superseded; a revision from 1.
--   UPDATE     an UPDATE that changes nothing passes; the period, person, revision and creation never change; the PDF is
--              named once (a StoredFile of the statement). A DRAFT changes freely and moves DRAFT → APPROVED (when, who) |
--              SUPERSEDED; APPROVED → SUPERSEDED (nothing else changes); SUPERSEDED is final.
--   every row  approved exactly once APPROVED (kept when superseded); superseded exactly when SUPERSEDED; APPROVED with its
--              summary and amounts (make-up 0 or more); an ISO currency.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_worker_statement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  file_only CONSTANT text[] := ARRAY['tenantId', 'fileId', 'updatedAt', 'version'];
  supersession CONSTANT text[] := ARRAY['tenantId', 'fileId', 'status', 'supersededAt', 'updatedAt', 'version'];
  period_status text;
  file_type text;
  file_record uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay: worker statement % is superseded or kept, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  SELECT p."status"::text INTO period_status FROM "PayPeriod" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."payPeriodId" FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF period_status = 'LOCKED' THEN
      RAISE EXCEPTION 'pay: pay period % is LOCKED; no statement is added to it', NEW."payPeriodId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'DRAFT' OR NEW."revision" < 1 THEN
      RAISE EXCEPTION 'pay: worker statement % starts as a DRAFT, with a revision from 1', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (NEW."id", NEW."companyId", NEW."siteId", NEW."payPeriodId", NEW."employeeId", NEW."revision", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."siteId", OLD."payPeriodId", OLD."employeeId", OLD."revision", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pay: the period, person, revision and creation of worker statement % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."fileId" IS NOT NULL AND NEW."fileId" IS DISTINCT FROM OLD."fileId" THEN
      RAISE EXCEPTION 'pay: the PDF of worker statement % is named once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (period_status = 'LOCKED' OR OLD."status" = 'SUPERSEDED') AND (to_jsonb(NEW) - file_only) IS DISTINCT FROM (to_jsonb(OLD) - file_only) THEN
      RAISE EXCEPTION 'pay: worker statement % is final (its period is % and it is %); a change goes in a later period''s statement', OLD."id", period_status, OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'APPROVED' AND (to_jsonb(NEW) - supersession) IS DISTINCT FROM (to_jsonb(OLD) - supersession) THEN
      RAISE EXCEPTION 'pay: worker statement % is APPROVED; it never changes (a later revision supersedes it)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('APPROVED', 'SUPERSEDED')) OR (OLD."status" = 'APPROVED' AND NEW."status" = 'SUPERSEDED')) THEN
      RAISE EXCEPTION 'pay: worker statement % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL)
     OR (NEW."status" = 'APPROVED' AND NEW."approvedAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND NEW."approvedAt" IS NOT NULL)
     OR (NEW."status" = 'SUPERSEDED') <> (NEW."supersededAt" IS NOT NULL)
     OR (NEW."status" = 'APPROVED' AND (NEW."summary" IS NULL OR jsonb_typeof(NEW."summary") NOT IN ('object', 'array') OR NEW."earningsAmount" IS NULL OR NEW."makeUpAmount" IS NULL))
     OR NEW."makeUpAmount" < 0 OR NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'pay: worker statement % is % with the wrong columns (approved: when, who, its summary and amounts, make-up 0 or more; superseded exactly when SUPERSEDED; an ISO currency)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fileId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."fileId" IS NULL) THEN
    SELECT f."recordType", f."recordId" INTO file_type, file_record FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
    IF FOUND AND (file_type <> 'WorkerStatement' OR file_record <> NEW."id") THEN
      RAISE EXCEPTION 'pay: the PDF of worker statement % is a stored file of the statement (recordType WorkerStatement), not of % %', NEW."id", file_type, file_record
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkerStatement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkerStatement"
  FOR EACH ROW EXECUTE FUNCTION "factory_worker_statement_guard"();
CREATE TRIGGER "WorkerStatement_no_truncate" BEFORE TRUNCATE ON "WorkerStatement"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- =====================================================================================================================
-- The earnings ledger (MES-256, MES-257, MES-259, MES-264, MES-148)
-- =====================================================================================================================

-- A reversal reverses an entry once.
CREATE UNIQUE INDEX "EarningsEntry_reversed_once" ON "EarningsEntry" ("tenantId", "reversalOfId") WHERE "reversalOfId" IS NOT NULL;

-- EarningsEntry: append-only (no login changes or removes an entry; a wrong one is reversed).
CREATE TRIGGER "EarningsEntry_append_only" BEFORE UPDATE OR DELETE ON "EarningsEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_pay_refuse_ledger_change"();
CREATE TRIGGER "EarningsEntry_no_truncate" BEFORE TRUNCATE ON "EarningsEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- EarningsEntry, INSERT
--   period      not LOCKED (its row FOR SHARE); the work day inside its month, or else inside the month of a LOCKED
--               earlier period of the company the entry names (correctsPeriodId), and only then.
--   every row   an ISO currency; a key; a source exactly with its id; the worker's employee is the entry's person.
--   reversal    of an entry of the same worker and kind that is no reversal (once: the partial unique index): the same
--               scan, rate, hold, source, day, rate applied, share and currency, the opposite pieces, minutes and amount,
--               and why. No switch check: a reversal corrects.
--   SCAN        a scan and a rate; pieces, rate and amount of 0 or more; no minutes or share; the scan a REPORT or
--   TEAM_SPLIT  CORRECTION no later scan voids (SCAN: the entry's worker's); the rate of a version in force on the work
--               day (PROVISIONAL, PUBLISHED or SUPERSEDED, between its first and last day) for the scan's operation (the
--               library operation of its routing step) and, when the table is a style's, the work order's style; no hold
--               of the scan that is not COUNTED, and the hold named a COUNTED one of the scan. TEAM_SPLIT: a share above 0,
--               at most 100.
--   MAKE_UP     no scan, rate or hold; minutes above 0; rate and amount 0 or more.
--   OFF_STANDARD its source record; no rate entry or hold; minutes above 0; rate and amount 0 or more.
--   ADJUSTMENT  why; no rate entry or hold.
--   the switch  SCAN, TEAM_SPLIT, MAKE_UP and OFF_STANDARD only on a work day inside one of the site's piece-pay windows
--               (the legal switch: from onFrom, before offFrom; or an earlier window).
CREATE FUNCTION "factory_earnings_entry_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  period record;
  corrected record;
  original record;
  scan record;
  rate record;
  routing_operation uuid;
  work_style uuid;
  worker_employee uuid;
BEGIN
  SELECT p."status"::text AS status, p."periodStart" AS first_day, p."periodEnd" AS last_day INTO period FROM "PayPeriod" p
   WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."payPeriodId" FOR SHARE;
  IF FOUND THEN
    IF period.status = 'LOCKED' THEN
      RAISE EXCEPTION 'pay: pay period % (%) is LOCKED; a change is paid in a later period that names it', NEW."payPeriodId", to_char(period.first_day, 'YYYY-MM')
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."workDate" BETWEEN period.first_day AND period.last_day THEN
      IF NEW."correctsPeriodId" IS NOT NULL THEN
        RAISE EXCEPTION 'pay: earnings entry % is work of its own period (%); it corrects no other period', NEW."id", NEW."workDate"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT c."status"::text AS status, c."periodStart" AS first_day, c."periodEnd" AS last_day INTO corrected FROM "PayPeriod" c
       WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."correctsPeriodId";
      IF NEW."correctsPeriodId" IS NULL
         OR (FOUND AND (corrected.status <> 'LOCKED' OR NOT (NEW."workDate" BETWEEN corrected.first_day AND corrected.last_day) OR corrected.first_day >= period.first_day)) THEN
        RAISE EXCEPTION 'pay: earnings entry % is work of % outside its period (%); it names the LOCKED earlier period of that day it corrects', NEW."id", NEW."workDate", to_char(period.first_day, 'YYYY-MM')
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."currency" !~ '^[A-Z]{3}$' OR btrim(NEW."idempotencyKey") = ''
     OR (NEW."sourceType" IS NULL) <> (NEW."sourceId" IS NULL) OR btrim(NEW."sourceType") = '' OR btrim(NEW."reason") = '' THEN
    RAISE EXCEPTION 'pay: earnings entry % has an ISO currency, a key, a source exactly with its id, and no blank reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT w."employeeId" INTO worker_employee FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workerId";
  IF FOUND AND worker_employee IS DISTINCT FROM NEW."employeeId" THEN
    RAISE EXCEPTION 'pay: earnings entry % pays employee %, but worker % is the floor sign-in of % (link the worker to its employee first)', NEW."id", NEW."employeeId", NEW."workerId", coalesce(worker_employee::text, 'no employee yet')
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."reversalOfId" IS NOT NULL THEN
    SELECT e.* INTO original FROM "EarningsEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."reversalOfId";
    IF FOUND AND (original."reversalOfId" IS NOT NULL OR original."workerId" <> NEW."workerId" OR original."employeeId" <> NEW."employeeId" OR original."kind" <> NEW."kind"
                  OR (original."operationScanId", original."rateEntryId", original."heldScanId", original."sourceType", original."sourceId", original."workDate", original."rate", original."sharePct", original."currency")
                     IS DISTINCT FROM (NEW."operationScanId", NEW."rateEntryId", NEW."heldScanId", NEW."sourceType", NEW."sourceId", NEW."workDate", NEW."rate", NEW."sharePct", NEW."currency")
                  OR NEW."pieces" IS DISTINCT FROM -original."pieces" OR NEW."minutes" IS DISTINCT FROM -original."minutes" OR NEW."amount" <> -original."amount") THEN
      RAISE EXCEPTION 'pay: reversal % mirrors entry % (same worker, kind, scan, rate, day; the opposite pieces, minutes and amount) and reverses no reversal', NEW."id", NEW."reversalOfId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."reason" IS NULL THEN
      RAISE EXCEPTION 'pay: reversal % says why', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."kind" IN ('SCAN', 'TEAM_SPLIT') THEN
    IF NEW."operationScanId" IS NULL OR NEW."rateEntryId" IS NULL OR NEW."pieces" IS NULL OR NEW."pieces" < 0
       OR NEW."rate" IS NULL OR NEW."rate" < 0 OR NEW."amount" < 0 OR NEW."minutes" IS NOT NULL
       OR (NEW."kind" = 'SCAN' AND NEW."sharePct" IS NOT NULL)
       OR (NEW."kind" = 'TEAM_SPLIT' AND (NEW."sharePct" IS NULL OR NEW."sharePct" <= 0 OR NEW."sharePct" > 100)) THEN
      RAISE EXCEPTION 'pay: earnings entry % (%) names its scan and rate, with pieces, rate and amount of 0 or more, no minutes, and a share (above 0, at most 100) exactly for a team split', NEW."id", NEW."kind"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT s."kind"::text AS kind, s."workerId" AS worker_id, s."workOrderId" AS work_order_id, s."workOrderOperationId" AS operation_id INTO scan
      FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."operationScanId";
    IF FOUND THEN
      IF scan.kind NOT IN ('REPORT', 'CORRECTION') OR (NEW."kind" = 'SCAN' AND scan.worker_id IS DISTINCT FROM NEW."workerId")
         OR EXISTS (SELECT 1 FROM "OperationScan" v WHERE v."tenantId" = NEW."tenantId" AND v."correctsId" = NEW."operationScanId") THEN
        RAISE EXCEPTION 'pay: earnings entry % pays a standing report or correction (scan % is a %, voided, or of another worker)', NEW."id", NEW."operationScanId", scan.kind
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."operationId" INTO routing_operation FROM "WorkOrderOperation" o
        JOIN "RoutingOperation" r ON r."tenantId" = o."tenantId" AND r."revisionId" = o."styleRevisionId" AND r."seq" = o."routingSeq"
       WHERE o."tenantId" = NEW."tenantId" AND o."id" = scan.operation_id;
      SELECT w."styleId" INTO work_style FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = scan.work_order_id;
    END IF;
    SELECT e."operationId" AS operation_id, v."status"::text AS status, v."effectiveFrom" AS first_day, v."effectiveTo" AS last_day, t."styleId" AS style_id INTO rate
      FROM "PieceRateEntry" e
      JOIN "PieceRateVersion" v ON v."tenantId" = e."tenantId" AND v."id" = e."versionId"
      JOIN "PieceRateTable" t ON t."tenantId" = v."tenantId" AND t."id" = v."tableId"
     WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."rateEntryId";
    IF FOUND THEN
      IF rate.status NOT IN ('PROVISIONAL', 'PUBLISHED', 'SUPERSEDED') OR NEW."workDate" < rate.first_day OR NEW."workDate" > coalesce(rate.last_day, NEW."workDate") THEN
        RAISE EXCEPTION 'pay: earnings entry % pays a rate of a version in force on %; its version is % (% to %): rates apply only once published', NEW."id", NEW."workDate", rate.status, rate.first_day, coalesce(rate.last_day::text, 'open')
          USING ERRCODE = 'check_violation';
      END IF;
      IF (routing_operation IS NOT NULL AND rate.operation_id <> routing_operation) OR (rate.style_id IS NOT NULL AND work_style IS NOT NULL AND rate.style_id <> work_style) THEN
        RAISE EXCEPTION 'pay: earnings entry % pays the rate of another operation or style than scan %', NEW."id", NEW."operationScanId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM "HeldScan" h WHERE h."tenantId" = NEW."tenantId" AND h."operationScanId" = NEW."operationScanId" AND h."status" <> 'COUNTED') THEN
      RAISE EXCEPTION 'pay: scan % is held (its worker was not clocked in); a held scan pays nothing until it is counted', NEW."operationScanId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."heldScanId" IS NOT NULL AND EXISTS (SELECT 1 FROM "HeldScan" h WHERE h."tenantId" = NEW."tenantId" AND h."id" = NEW."heldScanId"
                                                  AND (h."operationScanId" <> NEW."operationScanId" OR h."status" <> 'COUNTED')) THEN
      RAISE EXCEPTION 'pay: earnings entry % names hold %, which is no COUNTED hold of scan %', NEW."id", NEW."heldScanId", NEW."operationScanId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'MAKE_UP' THEN
    IF NEW."operationScanId" IS NOT NULL OR NEW."rateEntryId" IS NOT NULL OR NEW."heldScanId" IS NOT NULL OR NEW."pieces" IS NOT NULL OR NEW."sharePct" IS NOT NULL
       OR NEW."minutes" IS NULL OR NEW."minutes" <= 0 OR NEW."rate" IS NULL OR NEW."rate" < 0 OR NEW."amount" < 0 THEN
      RAISE EXCEPTION 'pay: make-up % names no scan, rate or hold, and has minutes above 0, a rate per minute and an amount of 0 or more', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'OFF_STANDARD' THEN
    IF NEW."sourceType" IS NULL OR NEW."rateEntryId" IS NOT NULL OR NEW."heldScanId" IS NOT NULL OR NEW."pieces" IS NOT NULL OR NEW."sharePct" IS NOT NULL
       OR NEW."minutes" IS NULL OR NEW."minutes" <= 0 OR NEW."rate" IS NULL OR NEW."rate" < 0 OR NEW."amount" < 0 THEN
      RAISE EXCEPTION 'pay: off-standard entry % names its source record, no rate entry or hold, and has minutes above 0, a rate per minute and an amount of 0 or more', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."reason" IS NULL OR NEW."rateEntryId" IS NOT NULL OR NEW."heldScanId" IS NOT NULL THEN
      RAISE EXCEPTION 'pay: adjustment % says why and names no rate entry or hold', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- (A site this session cannot see is another tenant's: the policy refuses the row.)
  IF NEW."kind" IN ('SCAN', 'TEAM_SPLIT', 'MAKE_UP', 'OFF_STANDARD')
     AND EXISTS (SELECT 1 FROM "Site" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."siteId")
     AND NOT EXISTS (SELECT 1 FROM "PiecePaySwitch" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId"
                       AND ((w."onFrom" IS NOT NULL AND w."onFrom" <= NEW."workDate" AND (w."offFrom" IS NULL OR NEW."workDate" < w."offFrom"))
                            OR EXISTS (SELECT 1 FROM jsonb_array_elements(w."earlierWindows") AS x(span)
                                        WHERE (x.span ->> 'from')::date <= NEW."workDate" AND NEW."workDate" < (x.span ->> 'to')::date))) THEN
    RAISE EXCEPTION 'pay: piece pay is not ON at site % on % (the legal switch, GATE-PIECE-PAY); no piece-pay figure is recorded outside its window', NEW."siteId", NEW."workDate"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "EarningsEntry_check" BEFORE INSERT ON "EarningsEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_earnings_entry_check"();

-- =====================================================================================================================
-- The payroll export (MES-267…MES-274; GATE-PAYROLL)
-- =====================================================================================================================

-- PayrollExportLayout
--   UPDATE     an UPDATE that changes nothing passes; the company and creation never change.
--   every row  a name; a provider not blank when named; a definition { columns: [...] } with at least one column, each an
--              object with a key (FIXED_WIDTH: each with a whole width above 0).
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_payroll_export_layout_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bad jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay: payroll layout % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pay: the company and creation of payroll layout % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."name") = '' OR btrim(NEW."provider") = ''
     OR jsonb_typeof(NEW."definition") <> 'object' OR jsonb_typeof(NEW."definition" -> 'columns') IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW."definition" -> 'columns') < 1 THEN
    RAISE EXCEPTION 'pay: payroll layout % has a name, no blank provider, and a definition { "columns": [...] } with at least one column', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c INTO bad FROM jsonb_array_elements(NEW."definition" -> 'columns') AS t(c)
   WHERE jsonb_typeof(c) <> 'object' OR jsonb_typeof(c -> 'key') IS DISTINCT FROM 'string' OR btrim(c ->> 'key') = ''
      OR (NEW."format" = 'FIXED_WIDTH' AND (jsonb_typeof(c -> 'width') IS DISTINCT FROM 'number' OR (c ->> 'width')::numeric <> trunc((c ->> 'width')::numeric) OR (c ->> 'width')::numeric < 1))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'pay: payroll layout % has a column that is no { key } (a fixed-width layout: { key, width } with a whole width above 0): %', NEW."id", bad
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PayrollExportLayout_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollExportLayout"
  FOR EACH ROW EXECUTE FUNCTION "factory_payroll_export_layout_guard"();
CREATE TRIGGER "PayrollExportLayout_no_truncate" BEFORE TRUNCATE ON "PayrollExportLayout"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- One first export per company and month; an exported export is corrected by at most one exported correction.
CREATE UNIQUE INDEX "PayrollExport_one_first_export_per_month" ON "PayrollExport" ("tenantId", "companyId", "periodStart")
  WHERE "status" = 'EXPORTED' AND "correctionOfId" IS NULL;
CREATE UNIQUE INDEX "PayrollExport_one_correction_each" ON "PayrollExport" ("tenantId", "correctionOfId")
  WHERE "status" = 'EXPORTED' AND "correctionOfId" IS NOT NULL;

-- PayrollExport
--   INSERT     a DRAFT: no number, no export, no cancellation; its layout ACTIVE.
--   UPDATE     an UPDATE that changes nothing passes; the company and creation never change. A DRAFT changes freely and
--              moves DRAFT → EXPORTED (its number from the company's PAYROLL_EXPORT series, who, when) | CANCELLED (when,
--              why). EXPORTED and CANCELLED are final.
--   every row  one whole month; a layout snapshot (an object), the checks and the values as lists; revision 1 exactly for
--              a first export; a correction names an EXPORTED export of the same company and month (not itself), with its
--              revision + 1; its pay period (when named) the company's of the same month; the number, series and export
--              exactly from EXPORTED on, the cancellation (with why) exactly when CANCELLED.
--   export     at least one DATA file; every check { code, blocking, passed } and every blocking one passed; its pay
--              period (when named) LOCKED.
--   DELETE     refused (a draft is cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_payroll_export_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  layout_status text;
  corrected record;
  period record;
  series_kind text;
  bad jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay: payroll export % is cancelled (a draft) or kept (exported), never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'pay: payroll export % starts as a DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pay: the company and creation of payroll export % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'pay: payroll export % (number %) is %; it never changes (a correction export corrects an exported one)', OLD."id", OLD."number", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (OLD."status" = 'DRAFT' AND NEW."status" IN ('EXPORTED', 'CANCELLED')) THEN
      RAISE EXCEPTION 'pay: payroll export % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NOT "factory_pay_one_month"(NEW."periodStart", NEW."periodEnd") THEN
    RAISE EXCEPTION 'pay: payroll export % is one whole month: its first day to its last day, not % to %', NEW."id", NEW."periodStart", NEW."periodEnd"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."layoutSnapshot") <> 'object' OR jsonb_typeof(NEW."checks") <> 'array' OR jsonb_typeof(NEW."values") <> 'array'
     OR NEW."revision" < 1 OR (NEW."correctionOfId" IS NULL) <> (NEW."revision" = 1) OR NEW."correctionOfId" = NEW."id" THEN
    RAISE EXCEPTION 'pay: payroll export % has its layout as used, its checks and values as lists, and revision 1 exactly when it corrects nothing', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'EXPORTED') <> (NEW."number" IS NOT NULL)
     OR (NEW."number" IS NULL) <> (NEW."numberSeriesId" IS NULL)
     OR (NEW."number" IS NULL) <> (NEW."exportedAt" IS NULL)
     OR (NEW."number" IS NULL) <> (NEW."exportedById" IS NULL)
     OR btrim(NEW."number") = ''
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL) OR btrim(NEW."cancelReason") = '' THEN
    RAISE EXCEPTION 'pay: payroll export % is % with the wrong columns (its number, series and export exactly from EXPORTED on; its cancellation, with why, exactly when CANCELLED)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."layoutId" IS DISTINCT FROM OLD."layoutId" THEN
    SELECT l."status"::text INTO layout_status FROM "PayrollExportLayout" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."layoutId";
    IF FOUND AND layout_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'pay: payroll export % uses an ACTIVE layout, not an % one', NEW."id", layout_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."correctionOfId" IS NOT NULL AND (TG_OP = 'INSERT' OR (NEW."correctionOfId", NEW."revision", NEW."periodStart") IS DISTINCT FROM (OLD."correctionOfId", OLD."revision", OLD."periodStart") OR NEW."status" <> OLD."status") THEN
    SELECT x."status"::text AS status, x."periodStart" AS first_day, x."revision" AS revision INTO corrected FROM "PayrollExport" x
     WHERE x."tenantId" = NEW."tenantId" AND x."id" = NEW."correctionOfId";
    IF FOUND AND (corrected.status <> 'EXPORTED' OR corrected.first_day <> NEW."periodStart" OR NEW."revision" <> corrected.revision + 1) THEN
      RAISE EXCEPTION 'pay: correction % corrects export % of the same company and month, which is EXPORTED, as its revision + 1', NEW."id", NEW."correctionOfId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."payPeriodId" IS NOT NULL THEN
    SELECT p."status"::text AS status, p."periodStart" AS first_day INTO period FROM "PayPeriod" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."payPeriodId";
    IF FOUND AND period.first_day <> NEW."periodStart" THEN
      RAISE EXCEPTION 'pay: payroll export % (%) names the pay period of its own month, not %', NEW."id", to_char(NEW."periodStart", 'YYYY-MM'), to_char(period.first_day, 'YYYY-MM')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" = 'EXPORTED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'EXPORTED') THEN
    SELECT s."kind"::text INTO series_kind FROM "NumberSeries" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."numberSeriesId";
    IF FOUND AND series_kind <> 'PAYROLL_EXPORT' THEN
      RAISE EXCEPTION 'pay: payroll export % is numbered from the company''s PAYROLL_EXPORT series, not from a % series', NEW."id", series_kind
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "PayrollExportFile" f WHERE f."tenantId" = NEW."tenantId" AND f."exportId" = NEW."id" AND f."kind" = 'DATA') THEN
      RAISE EXCEPTION 'pay: payroll export % has no data file; the export job stores it before the export is EXPORTED', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT c INTO bad FROM jsonb_array_elements(NEW."checks") AS t(c)
     WHERE jsonb_typeof(c) <> 'object' OR jsonb_typeof(c -> 'code') IS DISTINCT FROM 'string'
        OR jsonb_typeof(c -> 'blocking') IS DISTINCT FROM 'boolean' OR jsonb_typeof(c -> 'passed') IS DISTINCT FROM 'boolean'
        OR ((c ->> 'blocking') = 'true' AND (c ->> 'passed') = 'false')
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'pay: payroll export % has a blocking check that did not pass (or a check that is no { code, blocking, passed }): %; nothing reaches the consultant broken', NEW."id", bad
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."payPeriodId" IS NOT NULL THEN
      IF period.status IS DISTINCT FROM 'LOCKED' THEN
        RAISE EXCEPTION 'pay: payroll export % carries piece pay of pay period %, which is % (lock it first)', NEW."id", NEW."payPeriodId", period.status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PayrollExport_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollExport"
  FOR EACH ROW EXECUTE FUNCTION "factory_payroll_export_guard"();
CREATE TRIGGER "PayrollExport_no_truncate" BEFORE TRUNCATE ON "PayrollExport"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- PayrollExportFile
--   INSERT, DELETE  only while its export is a DRAFT (the export's row FOR SHARE: the move to EXPORTED waits for the job
--                   that writes its files, and sees them).
--   UPDATE          an UPDATE that changes nothing passes; nothing else (a file of an export never changes).
--   INSERT          a place from 1; a format CSV, XLSX, TXT or PDF; a row count of 0 or more; a StoredFile of the export
--                   (recordType "PayrollExport", recordId the export).
--   TRUNCATE        refused.
CREATE FUNCTION "factory_payroll_export_file_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  file_type text;
  file_record uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'pay: file % of payroll export % never changes', OLD."id", OLD."exportId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT e."status"::text INTO state FROM "PayrollExport" e
   WHERE e."tenantId" = CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END
     AND e."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."exportId" ELSE NEW."exportId" END
   FOR SHARE;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'pay: payroll export % is %; its files are added (or removed) only while it is a DRAFT', CASE WHEN TG_OP = 'DELETE' THEN OLD."exportId" ELSE NEW."exportId" END, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW."seq" < 1 OR NEW."rowCount" < 0 OR NEW."format" NOT IN ('CSV', 'XLSX', 'TXT', 'PDF') THEN
    RAISE EXCEPTION 'pay: file % of payroll export % has a place from 1, a format CSV, XLSX, TXT or PDF and a row count of 0 or more', NEW."id", NEW."exportId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT f."recordType", f."recordId" INTO file_type, file_record FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF FOUND AND (file_type <> 'PayrollExport' OR file_record <> NEW."exportId") THEN
    RAISE EXCEPTION 'pay: file % of payroll export % is a stored file of the export (recordType PayrollExport), not of % %', NEW."id", NEW."exportId", file_type, file_record
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PayrollExportFile_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollExportFile"
  FOR EACH ROW EXECUTE FUNCTION "factory_payroll_export_file_guard"();
CREATE TRIGGER "PayrollExportFile_no_truncate" BEFORE TRUNCATE ON "PayrollExportFile"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();

-- PayrollCodeMapping
--   UPDATE     an UPDATE that changes nothing passes; the company, kind, our code and creation never change.
--   every row  our code and its meaning; the provider's code not blank when given (null: not mapped yet).
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_payroll_code_mapping_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay: payroll code mapping % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."kind", NEW."ourCode", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."kind", OLD."ourCode", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pay: the company, kind, our code and creation of payroll code mapping % never change (archive it and map the code anew)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."ourCode") = '' OR btrim(NEW."meaning") = '' OR btrim(NEW."providerCode") = '' THEN
    RAISE EXCEPTION 'pay: payroll code mapping % has our code, its meaning, and the provider''s code not blank when given', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PayrollCodeMapping_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollCodeMapping"
  FOR EACH ROW EXECUTE FUNCTION "factory_payroll_code_mapping_guard"();
CREATE TRIGGER "PayrollCodeMapping_no_truncate" BEFORE TRUNCATE ON "PayrollCodeMapping"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_pay_refuse_truncate"();
