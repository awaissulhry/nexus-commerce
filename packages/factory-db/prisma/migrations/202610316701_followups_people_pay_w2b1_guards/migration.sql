-- Written by hand (Prisma does not model triggers), after the generated 202610316700_followups_people_pay_w2b1_schema and
-- before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp (only
-- this first comment names the schema folder).

-- The W2b-1 follow-ups for people and pay (B-W2b-75, W2b schema wave 9/16). The rules of the new values and columns; they
-- hold for every login, the owner included. Every refusal is a check_violation (SQLSTATE 23514). A rule that reads another
-- row skips a row the session cannot see (another tenant's: the foreign key or the policy refuses it).
--
-- Their readers come later (B-W2b-84 books the bonus; B-W2b-89 reads the settings and moves the JSON into the columns). This
-- file fills no existing row: `definition.confirmation`, `definition.companyCode` and the CARRIED row of `checks` stay
-- where B-W2b-54 reads them until B-W2b-89.

-- =====================================================================================================================
-- The people settings (…_people_w2b_guards' function, whole, with the three new rules at its end)
-- =====================================================================================================================

-- PeopleSettings, added:
--   every row  the standard review 1 to 100 percent off the standard, over 1 to 1000 bundles.
--   named      the printer of statements an A4 printer, ACTIVE when it is named (the foreign key: of the company); the
--              labour consultant a party with the CONSULTANT role, ACTIVE when it is named, of the company or tenant-wide.
--              Checked when the column changes, so a printer archived or a party blocked later does not stop an edit of the
--              other settings: the readers (B-W2b-89) say so.
CREATE OR REPLACE FUNCTION "factory_people_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  printer record;
  consultant record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'people: the people settings % are changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'people: the company and creation of the people settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."lateGraceMinutes" NOT BETWEEN 0 AND 60 OR NEW."overtimeUnitMinutes" NOT BETWEEN 1 AND 60
     OR NEW."roundingMinutes" NOT IN (0, 5, 15) OR NEW."autoClockOutAfterMinutes" NOT BETWEEN 0 AND 720 THEN
    RAISE EXCEPTION 'people: the people settings % round clock events to 0, 5 or 15 minutes, give 0 to 60 minutes of grace, count overtime in units of 1 to 60 minutes and close an open clock-in 0 to 720 minutes after the shift, or never', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."minimumGroupSize" NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'people: the minimum group size of the people settings % is 3 or more (a group of two shows one person to the other; ANA-075), not %', NEW."id", NEW."minimumGroupSize"
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW."figureRoleKeys") k WHERE k IS NULL OR k !~ '^[a-z][a-z0-9_.-]*$')
     OR cardinality(NEW."figureRoleKeys") <> (SELECT count(DISTINCT k) FROM unnest(NEW."figureRoleKeys") k) THEN
    RAISE EXCEPTION 'people: the people settings % name the roles that see one person''s figures by their keys (hr, custom.<slug>), each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."standardReviewPercent" NOT BETWEEN 1 AND 100 OR NEW."standardReviewMinBundles" NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'people: the standard review of the people settings % takes operations 1 to 100 percent off their standard, over 1 to 1000 bundles, not % percent over %', NEW."id", NEW."standardReviewPercent", NEW."standardReviewMinBundles"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."statementPrinterId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."statementPrinterId" IS DISTINCT FROM OLD."statementPrinterId") THEN
    SELECT p."kind"::text AS kind, p."status"::text AS status INTO printer FROM "Printer" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."statementPrinterId";
    IF FOUND AND (printer.kind <> 'A4_PDF' OR printer.status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'people: the people settings % print statements on an ACTIVE A4 printer, not on a % % one', NEW."id", printer.status, printer.kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."payrollConsultantPartyId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."payrollConsultantPartyId" IS DISTINCT FROM OLD."payrollConsultantPartyId") THEN
    SELECT q."companyId" AS company_id, q."roles"::text[] AS roles, q."status"::text AS status INTO consultant FROM "Party" q WHERE q."tenantId" = NEW."tenantId" AND q."id" = NEW."payrollConsultantPartyId";
    IF FOUND AND (NOT ('CONSULTANT' = ANY (consultant.roles)) OR consultant.status <> 'ACTIVE' OR consultant.company_id <> NEW."companyId") THEN
      RAISE EXCEPTION 'people: the labour consultant of the people settings % is an ACTIVE party with the CONSULTANT role, of the company or tenant-wide; party % is not', NEW."id", NEW."payrollConsultantPartyId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- The payroll layout (…_pay_w2b_guards' function, whole, with the confirmation's rule)
-- =====================================================================================================================

-- PayrollExportLayout, added:
--   every row  the confirmation's day exactly with who confirmed it: the user who recorded it, the name they go by, or both
--              (a name not blank). The name stands alone on a row copied from `definition.confirmation`, which holds no id.
CREATE OR REPLACE FUNCTION "factory_payroll_export_layout_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF (NEW."confirmedOn" IS NOT NULL) <> (NEW."confirmedById" IS NOT NULL OR NEW."confirmedByName" IS NOT NULL) OR btrim(NEW."confirmedByName") = '' THEN
    RAISE EXCEPTION 'pay: the confirmation of payroll layout % has its day exactly with who confirmed it (the user who recorded it, the name they go by, or both)', NEW."id"
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

-- =====================================================================================================================
-- The earnings ledger (…_floor_work_w2b_guards' function, whole, with the BONUS kind)
-- =====================================================================================================================

-- EarningsEntry, added:
--   BONUS      a STANDARD_MINUTE_BONUS scheme's bonus for the period: no scan, rate entry, hold, pieces or share; the
--              standard minutes above the threshold, above 0; an amount of 0 or more; a rate only if one applies (bonusOf
--              pays the earned value pro rata: no rate of its own). Inside a window of the site's legal switch, like every
--              piece-pay figure. Without this branch the ELSE below would take it for an adjustment, outside the switch.
CREATE OR REPLACE FUNCTION "factory_earnings_entry_check"() RETURNS trigger LANGUAGE plpgsql AS $$
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
      -- W2b wave 7/7: a PARTIAL (the pieces done so far, never voided) is paid like a report; the timing marks (START,
      -- PAUSE, RESUME, HAND_BACK) carry no pieces and pay nothing by the piece.
      IF scan.kind NOT IN ('REPORT', 'CORRECTION', 'PARTIAL') OR (NEW."kind" = 'SCAN' AND scan.worker_id IS DISTINCT FROM NEW."workerId")
         OR EXISTS (SELECT 1 FROM "OperationScan" v WHERE v."tenantId" = NEW."tenantId" AND v."correctsId" = NEW."operationScanId") THEN
        RAISE EXCEPTION 'pay: earnings entry % pays a standing report, correction or partial (scan % is a %, voided, or of another worker)', NEW."id", NEW."operationScanId", scan.kind
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
  ELSIF NEW."kind" = 'BONUS' THEN
    IF NEW."operationScanId" IS NOT NULL OR NEW."rateEntryId" IS NOT NULL OR NEW."heldScanId" IS NOT NULL OR NEW."pieces" IS NOT NULL OR NEW."sharePct" IS NOT NULL
       OR NEW."minutes" IS NULL OR NEW."minutes" <= 0 OR NEW."rate" < 0 OR NEW."amount" < 0 THEN
      RAISE EXCEPTION 'pay: bonus % names no scan, rate entry or hold, and has standard minutes above 0, an amount of 0 or more and no negative rate', NEW."id"
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
  IF NEW."kind" IN ('SCAN', 'TEAM_SPLIT', 'MAKE_UP', 'OFF_STANDARD', 'BONUS')
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

-- =====================================================================================================================
-- The company's payroll code
-- =====================================================================================================================

-- Company
--   every row  the payroll code (codice ditta) null, or not blank and 20 characters at most (factory-domain payroll
--              LAYOUT_LIMITS.companyCode).
CREATE FUNCTION "factory_company_payroll_code_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF btrim(NEW."payrollCode") = '' OR char_length(NEW."payrollCode") > 20 THEN
    RAISE EXCEPTION 'company: the payroll code of % is not blank and at most 20 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Company_payroll_code_guard" BEFORE INSERT OR UPDATE OF "payrollCode" ON "Company"
  FOR EACH ROW EXECUTE FUNCTION "factory_company_payroll_code_guard"();
