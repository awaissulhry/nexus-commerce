-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202611011200_floor_work_w2b_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- Floor work, W2b schema wave 7/7 (B-W2b-12; plan W2B §6 row 7/7; MES-022…033, MES-067, MES-075, MES-087…102,
-- MES-117, MES-128, MES-142…148, MES-155…158, MES-161, MES-168, MES-181…196, MES-201…206, MES-293, MES-294, PLT-059,
-- PLT-227; Statuto dei Lavoratori, L. 300/1970, art. 4; GDPR arts. 5, 15): the hand-written rules of the timing of an
-- operation, team members and ticked steps, off-standard time and its codes, line days, labour edits and disputes,
-- dispatch, coupons, scan-pattern findings, crews, device modes, help calls and their routing, hourly targets, handover
-- notes, the floor checks of a site and a work order's rush flag and split. apps/factory-api checks all of this first;
-- these rules hold for every login, the owner included.
--
-- As every factory guard: every refusal is a check_violation (SQLSTATE 23514). The tenant and site of a row are held by
-- the policies (USING and WITH CHECK) and by the references, never compared here. A rule that reads another row skips
-- a row this session cannot see: each trigger first asks whether the row's site (or company) is visible to the session
-- (factory_floor_work_visible) and leaves a row outside the session's scope to the policies. A trigger reads only tables
-- the role that fires it may read (the floor reads every table these triggers read), and takes advisory locks, never
-- FOR SHARE, on tables the floor cannot update. An UPDATE that changes nothing passes. "Everything but these columns"
-- is compared as jsonb (to_jsonb(row) minus the named keys), so a column added later is frozen too unless a later
-- migration names it.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers
-- and dates moved) and insert the copy: so no rule here gives a unique key of ids alone (one row per X is then the
-- module's), a code in a unique key is checked for spaces only, an hour in a unique key only from 0 (the API keeps it
-- below 24), and a table with "one open row per Y" accepts a row inserted already closed (an offline record).

CREATE FUNCTION "factory_floor_work_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'floor work: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- The append-only ledgers of this wave (OperationScanMember, OperationChecklistResult, LabourEdit).
CREATE FUNCTION "factory_floor_work_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'floor work: "%" is append-only; % of row % is refused (a mistake is a new row)', TG_TABLE_NAME, TG_OP, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

-- Whether this session sees the site (of the tenant): a row of a site it cannot see is left to the policies.
CREATE FUNCTION "factory_floor_work_visible"(tenant uuid, site uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "Site" s WHERE s."tenantId" = tenant AND s."id" = site)
$$;

-- A line's day (MES-203): a write of a row of the day takes the day's lock SHARED, a close takes it EXCLUSIVE, so a close
-- waits for the writes in flight and a write after it sees it closed.
CREATE FUNCTION "factory_labour_day_lock"(tenant uuid, line uuid, day date, exclusive boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF exclusive THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.labour-day', tenant, line, day), 0));
  ELSE
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(concat_ws('|', 'factory.labour-day', tenant, line, day), 0));
  END IF;
END
$$;

-- Refuses a write into a CLOSED line day (closed days feed pay; reopening needs a reason).
CREATE FUNCTION "factory_labour_day_refuse_closed"(tenant uuid, line uuid, day date, what text, row_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF line IS NULL OR day IS NULL THEN
    RETURN;
  END IF;
  PERFORM "factory_labour_day_lock"(tenant, line, day, false);
  IF EXISTS (SELECT 1 FROM "LabourDay" d WHERE d."tenantId" = tenant AND d."lineId" = line AND d."workDate" = day AND d."status" = 'CLOSED') THEN
    RAISE EXCEPTION 'floor work: the day % of line % is CLOSED (closed days feed pay, MES-203); % % changes only after it is reopened with a reason', day, line, what, row_id
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- The running stretch of a worker (at a site that records workers) or of a station (at one that records stations): the
-- latest START or RESUME of theirs that is still the last row of its bundle and operation, within a day.
CREATE FUNCTION "factory_floor_running_stretch"(tenant uuid, site uuid, worker uuid, station uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT s."id"
    FROM "OperationScan" s
   WHERE s."tenantId" = tenant AND s."siteId" = site
     AND ((worker IS NOT NULL AND s."workerId" = worker) OR (worker IS NULL AND s."workerId" IS NULL AND s."stationId" = station))
     AND s."kind"::text IN ('START', 'RESUME')
     AND s."serverTime" > now() - interval '24 hours'
     AND NOT EXISTS (SELECT 1 FROM "OperationScan" n
                      WHERE n."tenantId" = s."tenantId" AND n."bundleId" = s."bundleId" AND n."workOrderOperationId" = s."workOrderOperationId"
                        AND (n."serverTime", n."id") > (s."serverTime", s."id"))
   ORDER BY s."serverTime" DESC
   LIMIT 1
$$;

-- =====================================================================================================================
-- OperationScan: the timing of an operation (production.prisma ScanKind START, PAUSE, RESUME, HAND_BACK, PARTIAL)
--
-- W1's "OperationScan_check" (factory_operation_scan_check, …_production_guards; B-W2b-01 redefines its body) is the
-- count ledger's rule: it is recreated to fire for REPORT, UNDO and CORRECTION only (its function is not touched). The
-- work-order gate (…_production_w2a_guards) and the quality hold (…_quality_plant_w2a_guards) are recreated so that a
-- PAUSE or a HAND_BACK is never refused: stopping the clock of a held bundle or work order must work (a hold placed
-- while work runs, the automatic pause at clock-out). Their functions are not touched either.
DROP TRIGGER "OperationScan_check" ON "OperationScan";
CREATE TRIGGER "OperationScan_check" BEFORE INSERT ON "OperationScan"
  FOR EACH ROW WHEN (NEW."kind"::text IN ('REPORT', 'UNDO', 'CORRECTION'))
  EXECUTE FUNCTION "factory_operation_scan_check"();
DROP TRIGGER "OperationScan_awaits_hold" ON "OperationScan";
CREATE TRIGGER "OperationScan_awaits_hold" BEFORE INSERT ON "OperationScan"
  FOR EACH ROW WHEN (NEW."kind"::text NOT IN ('PAUSE', 'HAND_BACK'))
  EXECUTE FUNCTION "factory_work_order_gate_check"();
DROP TRIGGER "OperationScan_awaits_quality_hold" ON "OperationScan";
CREATE TRIGGER "OperationScan_awaits_quality_hold" BEFORE INSERT ON "OperationScan"
  FOR EACH ROW WHEN (NEW."kind"::text NOT IN ('PAUSE', 'HAND_BACK'))
  EXECUTE FUNCTION "factory_operation_scan_quality_hold_check"();

-- OperationScan, INSERT, every kind:
--   count kinds   REPORT, UNDO and CORRECTION name no pause reason (the rest is W1's check).
--   timing kinds  name no scan they void, no approval and no subcontract receipt line, and have a client scan id; a
--                 PAUSE, and only a PAUSE, says why (a code); no counts but a PARTIAL's, from 1 to fewer than the
--                 bundle's garments together, and all the PARTIALs of the bundle at the operation stay below them
--                 (the REPORT reports the bundle); START, RESUME and PARTIAL only while the work order is RELEASED or
--                 IN_PROGRESS and the bundle ACTIVE (a PAUSE or HAND_BACK whenever); the subject is the signed-in
--                 worker who acknowledged the notice, or the station (factory_production_check_subject).
--   stretches     one open stretch per bundle and operation, by one subject (worker, else station), under W1's lock
--                 per bundle and operation: START only when none is open and the bundle is not reported there (no
--                 standing REPORT or CORRECTION); PAUSE only a RUNNING one (last START or RESUME), RESUME only a PAUSED
--                 one, HAND_BACK and PARTIAL either, each of the same subject. The rows of one bundle and operation are
--                 ordered by server time, then id (UUIDv7).
--   standard      START and RESUME are refused while the subject has an OPEN off-standard block (MES-156: scanning a
--                 bundle ends it first, in the same command).
CREATE FUNCTION "factory_operation_scan_timing_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
  bundle record;
  latest record;
  open_state text;
  same boolean;
  counted integer;
  earlier integer;
  open_block uuid;
BEGIN
  IF NEW."kind"::text IN ('REPORT', 'UNDO', 'CORRECTION') THEN
    IF NEW."pauseReasonCode" IS NOT NULL THEN
      RAISE EXCEPTION 'production: scan % is a %; only a PAUSE names a pause reason', NEW."id", NEW."kind"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF NOT FOUND THEN
    -- Outside this session's scope: the policies refuse the row.
    RETURN NEW;
  END IF;
  IF NEW."correctsId" IS NOT NULL OR NEW."approvedById" IS NOT NULL OR btrim(NEW."clientScanId") = ''
     OR (to_jsonb(NEW) ->> 'subcontractReceiptLineId') IS NOT NULL THEN
    RAISE EXCEPTION 'production: timing scan % (%) names no scan it voids, no approval and no receipt line, and has a client scan id', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'PAUSE') <> (NEW."pauseReasonCode" IS NOT NULL) OR NEW."pauseReasonCode" !~ '^\S+$' THEN
    RAISE EXCEPTION 'production: a PAUSE, and only a PAUSE, says why it stopped (a code of the PAUSE reason list, MES-088); scan % is a %', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind"::text IN ('START', 'RESUME', 'PARTIAL') AND order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'production: work order % is %; work on it starts or goes on only while it is RELEASED or IN_PROGRESS', NEW."workOrderId", order_state
      USING ERRCODE = 'check_violation';
  END IF;
  counted := NEW."goodQuantity" + NEW."scrapQuantity" + NEW."reworkQuantity";
  IF NEW."goodQuantity" < 0 OR NEW."scrapQuantity" < 0 OR NEW."reworkQuantity" < 0 OR (NEW."kind" <> 'PARTIAL' AND counted <> 0) THEN
    RAISE EXCEPTION 'production: timing scan % (%) carries no counts; only a PARTIAL carries the pieces done so far (from 0 each)', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT b."quantity", b."status"::text AS status INTO bundle
    FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."id" = NEW."bundleId";
  IF FOUND THEN
    IF NEW."kind"::text IN ('START', 'RESUME', 'PARTIAL') AND bundle.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'production: bundle % is %; work on it does not start or go on', NEW."bundleId", bundle.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'PARTIAL' AND (counted < 1 OR counted >= bundle."quantity") THEN
      RAISE EXCEPTION 'production: partial % reports the pieces done so far: from 1 to fewer than the % garment(s) of bundle % (the REPORT reports the bundle, MES-092)', NEW."id", bundle."quantity", NEW."bundleId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM "factory_production_check_subject"(NEW."tenantId", NEW."siteId", NEW."workerId", NEW."stationId", 'timing scan', NEW."id");
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.scan', NEW."tenantId", NEW."siteId", NEW."bundleId", NEW."workOrderOperationId"), 0));

  SELECT s."id", s."kind"::text AS kind, s."workerId", s."stationId" INTO latest
    FROM "OperationScan" s
   WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."bundleId" = NEW."bundleId" AND s."workOrderOperationId" = NEW."workOrderOperationId"
   ORDER BY s."serverTime" DESC, s."id" DESC
   LIMIT 1;
  open_state := CASE WHEN NOT FOUND THEN NULL WHEN latest.kind IN ('START', 'RESUME') THEN 'RUNNING' WHEN latest.kind = 'PAUSE' THEN 'PAUSED' ELSE NULL END;
  same := CASE WHEN NEW."workerId" IS NOT NULL THEN latest."workerId" IS NOT DISTINCT FROM NEW."workerId"
               ELSE latest."workerId" IS NULL AND latest."stationId" IS NOT DISTINCT FROM NEW."stationId" END;

  IF NEW."kind" = 'START' THEN
    IF EXISTS (SELECT 1 FROM "OperationScan" s
                WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."bundleId" = NEW."bundleId"
                  AND s."workOrderOperationId" = NEW."workOrderOperationId" AND s."kind"::text IN ('REPORT', 'CORRECTION')
                  AND NOT EXISTS (SELECT 1 FROM "OperationScan" v WHERE v."tenantId" = s."tenantId" AND v."siteId" = s."siteId" AND v."correctsId" = s."id")) THEN
      RAISE EXCEPTION 'production: bundle % is reported at operation % already; work on it does not start again (undo or correct the report)', NEW."bundleId", NEW."workOrderOperationId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF open_state IS NOT NULL THEN
      RAISE EXCEPTION 'production: work on bundle % at operation % is % (scan %); it is resumed, handed back or reported first (one open stretch per bundle and operation)', NEW."bundleId", NEW."workOrderOperationId", open_state, latest."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'PAUSE' THEN
    IF open_state IS DISTINCT FROM 'RUNNING' OR NOT same THEN
      RAISE EXCEPTION 'production: pause %: only work that runs, started by the same worker (or station), pauses (bundle %, operation %: %)', NEW."id", NEW."bundleId", NEW."workOrderOperationId", coalesce(open_state, 'not started')
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'RESUME' THEN
    IF open_state IS DISTINCT FROM 'PAUSED' OR NOT same THEN
      RAISE EXCEPTION 'production: resume %: only work paused by the same worker (or station) resumes (bundle %, operation %: %)', NEW."id", NEW."bundleId", NEW."workOrderOperationId", coalesce(open_state, 'not started')
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF open_state IS NULL OR NOT same THEN
      RAISE EXCEPTION 'production: % %: only open work (running or paused) of the same worker (or station) is handed back or reported in part (bundle %, operation %)', NEW."kind", NEW."id", NEW."bundleId", NEW."workOrderOperationId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."kind" = 'PARTIAL' AND bundle IS NOT NULL THEN
    SELECT coalesce(sum(s."goodQuantity" + s."scrapQuantity" + s."reworkQuantity"), 0) INTO earlier
      FROM "OperationScan" s
     WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."bundleId" = NEW."bundleId"
       AND s."workOrderOperationId" = NEW."workOrderOperationId" AND s."kind" = 'PARTIAL';
    IF earlier + counted >= bundle."quantity" THEN
      RAISE EXCEPTION 'production: the pieces done so far of bundle % at operation % (% before, % now) stay below its % garment(s); the REPORT reports the bundle', NEW."bundleId", NEW."workOrderOperationId", earlier, counted, bundle."quantity"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."kind"::text IN ('START', 'RESUME') THEN
    SELECT e."id" INTO open_block FROM "OffStandardEntry" e
     WHERE e."tenantId" = NEW."tenantId" AND e."siteId" = NEW."siteId" AND e."status" = 'OPEN'
       AND ((NEW."workerId" IS NOT NULL AND e."workerId" = NEW."workerId") OR (NEW."workerId" IS NULL AND e."workerId" IS NULL AND e."stationId" = NEW."stationId"))
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'production: % % starts standard work while off-standard block % is open; scanning a bundle ends the block first, in the same command (MES-156)', NEW."kind", NEW."id", open_block
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OperationScan_timing_check" BEFORE INSERT ON "OperationScan"
  FOR EACH ROW EXECUTE FUNCTION "factory_operation_scan_timing_check"();

-- =====================================================================================================================
-- OperationScanMember (MES-091), INSERT: the scan is a START, RESUME, PARTIAL or REPORT; the member is named only where
-- the site records workers, having acknowledged the notice. Append-only. TRUNCATE refused.
CREATE FUNCTION "factory_operation_scan_member_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scan_kind text;
BEGIN
  SELECT s."kind"::text INTO scan_kind FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."scanId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF scan_kind NOT IN ('START', 'RESUME', 'PARTIAL', 'REPORT') THEN
    RAISE EXCEPTION 'production: scan % is a %; a team''s members are named on its START, RESUME, PARTIAL or REPORT (MES-091)', NEW."scanId", scan_kind
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM "factory_production_check_subject"(NEW."tenantId", NEW."siteId", NEW."workerId", NULL, 'team member', NEW."id");
  RETURN NEW;
END
$$;

CREATE TRIGGER "OperationScanMember_check" BEFORE INSERT ON "OperationScanMember"
  FOR EACH ROW EXECUTE FUNCTION "factory_operation_scan_member_check"();
CREATE TRIGGER "OperationScanMember_append_only" BEFORE UPDATE OR DELETE ON "OperationScanMember"
  FOR EACH ROW EXECUTE FUNCTION "factory_floor_work_refuse_change"();
CREATE TRIGGER "OperationScanMember_no_truncate" BEFORE TRUNCATE ON "OperationScanMember"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- =====================================================================================================================
-- OperationChecklistResult (MES-102), INSERT: only while the work order is RELEASED or IN_PROGRESS (and not held: the
-- gate, as for scans), on an ACTIVE bundle; a step code without spaces; the subject as for scans. Append-only.
CREATE FUNCTION "factory_operation_checklist_result_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
  bundle_state text;
BEGIN
  SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'production: work order % is %; steps are ticked only while it is RELEASED or IN_PROGRESS', NEW."workOrderId", order_state
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT b."status"::text INTO bundle_state FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."id" = NEW."bundleId";
  IF FOUND AND bundle_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'production: bundle % is %; no step is ticked on it', NEW."bundleId", bundle_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stepCode" !~ '^\S+$' OR (NEW."clientEventId" IS NOT NULL AND btrim(NEW."clientEventId") = '') THEN
    RAISE EXCEPTION 'production: ticked step % names its step by a code without spaces (and a client event id that is not blank)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM "factory_production_check_subject"(NEW."tenantId", NEW."siteId", NEW."workerId", NEW."stationId", 'ticked step', NEW."id");
  RETURN NEW;
END
$$;

CREATE TRIGGER "OperationChecklistResult_awaits_hold" BEFORE INSERT ON "OperationChecklistResult"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_gate_check"();
CREATE TRIGGER "OperationChecklistResult_check" BEFORE INSERT ON "OperationChecklistResult"
  FOR EACH ROW EXECUTE FUNCTION "factory_operation_checklist_result_check"();
CREATE TRIGGER "OperationChecklistResult_append_only" BEFORE UPDATE OR DELETE ON "OperationChecklistResult"
  FOR EACH ROW EXECUTE FUNCTION "factory_floor_work_refuse_change"();
CREATE TRIGGER "OperationChecklistResult_no_truncate" BEFORE TRUNCATE ON "OperationChecklistResult"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- =====================================================================================================================
-- OffStandardCode (MES-155, MES-158): a code without spaces and its words in Italian and English; other languages as an
-- object of words keyed by language code; an icon id and a "#RRGGBB" colour, or none; its company, code and creation
-- never change; set inactive, never deleted. TRUNCATE refused.
CREATE FUNCTION "factory_off_standard_code_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'floor work: off-standard code % is set inactive, never deleted (entries keep it)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."companyId", NEW."code", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."code", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'floor work: off-standard code % keeps its company and its code (entries keep them)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."code" !~ '^\S+$' OR btrim(NEW."labelIt") = '' OR btrim(NEW."labelEn") = '' THEN
    RAISE EXCEPTION 'floor work: off-standard code % has a code without spaces and its words in Italian and English', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."labelI18n") <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(NEW."labelI18n") w WHERE w.key !~ '^[a-z]{2,3}$' OR jsonb_typeof(w.value) <> 'string' OR btrim(w.value #>> '{}') = '') THEN
    RAISE EXCEPTION 'floor work: off-standard code % keeps its other languages as words keyed by language code ({ "ro": "…" })', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."icon" !~ '^[a-z][a-z0-9-]*$' OR NEW."colour" !~ '^#[0-9A-Fa-f]{6}$' THEN
    RAISE EXCEPTION 'floor work: off-standard code % names its icon by its id and its colour as #RRGGBB', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OffStandardCode_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OffStandardCode"
  FOR EACH ROW EXECUTE FUNCTION "factory_off_standard_code_guard"();
CREATE TRIGGER "OffStandardCode_no_truncate" BEFORE TRUNCATE ON "OffStandardCode"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- =====================================================================================================================
-- OffStandardEntry (MES-148, MES-156, MES-157, MES-204)
--   INSERT     OPEN (running: no end), PENDING (ended), or APPROVED (ended, of a code that needs no approval); a
--              running block only while the subject has no running stretch (MES-156: "no bundle active") and none
--              other OPEN (the partial unique indexes); its code ACTIVE.
--   UPDATE     the company, source, help call, device, client event and creation never change. OPEN → PENDING |
--              APPROVED (a code that needs no approval) | REJECTED; PENDING → APPROVED | REJECTED; APPROVED | REJECTED
--              → PENDING (reopened). A changed code is ACTIVE.
--   every row  ended exactly when not OPEN, never before it started; its day is the site's day it started in; HELP_CALL
--              exactly with its help call; APPROVED exactly with when (and by whom: required, and never the worker it
--              is about, for a code that needs approval); REJECTED exactly with when, who and why; the subject is the
--              signed-in worker who acknowledged the notice, or the station (checked when it is set).
--   day        nothing of a block changes while its line's day (old or new) is CLOSED (factory_labour_day_refuse_closed).
--   edits      after it ended, a change of its facts (line, station, worker, code, day, start, end) or a reopening comes
--              with a LabourEdit of the block in the same transaction (the deferred "OffStandardEntry_edit_recorded").
--   DELETE     refused (rejected instead). TRUNCATE refused.
CREATE FUNCTION "factory_off_standard_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  code record;
  zone text;
  running uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'floor work: off-standard block % is rejected, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NOT "factory_floor_work_visible"(NEW."tenantId", NEW."siteId") THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('OPEN', 'PENDING', 'APPROVED') THEN
      RAISE EXCEPTION 'floor work: off-standard block % starts OPEN (running), PENDING or APPROVED (ended), not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (NEW."companyId", NEW."source", NEW."helpCallId", NEW."deviceId", NEW."clientEventId", NEW."deviceTime", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."source", OLD."helpCallId", OLD."deviceId", OLD."clientEventId", OLD."deviceTime", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'floor work: the company, source, help call, device and creation of off-standard block % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'OPEN' AND NEW."status" IN ('PENDING', 'APPROVED', 'REJECTED'))
                OR (OLD."status" = 'PENDING' AND NEW."status" IN ('APPROVED', 'REJECTED'))
                OR (OLD."status" IN ('APPROVED', 'REJECTED') AND NEW."status" = 'PENDING')) THEN
      RAISE EXCEPTION 'floor work: off-standard block % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT c."active", c."needsApproval" INTO code FROM "OffStandardCode" c WHERE c."tenantId" = NEW."tenantId" AND c."companyId" = NEW."companyId" AND c."id" = NEW."codeId";
  IF FOUND THEN
    IF NOT code."active" AND (TG_OP = 'INSERT' OR NEW."codeId" IS DISTINCT FROM OLD."codeId") THEN
      RAISE EXCEPTION 'floor work: off-standard code % is inactive; no block takes it', NEW."codeId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'APPROVED' AND code."needsApproval"
       AND (NEW."approvedById" IS NULL OR NEW."approvedById" IS NOT DISTINCT FROM NEW."workerId"
            OR (TG_OP = 'INSERT') OR (OLD."status" = 'OPEN')) THEN
      RAISE EXCEPTION 'floor work: off-standard block % is of a code the team leader approves (MES-157): it waits PENDING, and someone else than the worker approves it', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."status" = 'OPEN') <> (NEW."endedAt" IS NULL) OR NEW."endedAt" < NEW."startedAt" THEN
    RAISE EXCEPTION 'floor work: off-standard block % is % with the wrong end: running (OPEN) exactly without one, never ending before it started', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."source" = 'HELP_CALL') <> (NEW."helpCallId" IS NOT NULL) THEN
    RAISE EXCEPTION 'floor work: off-standard block % names a help call exactly when it is the waiting on one (MES-148)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'APPROVED') <> (NEW."approvedAt" IS NOT NULL) OR (NEW."status" <> 'APPROVED' AND NEW."approvedById" IS NOT NULL)
     OR (NEW."status" = 'REJECTED') <> (NEW."rejectedAt" IS NOT NULL)
     OR (NEW."status" = 'REJECTED') <> (NEW."rejectedById" IS NOT NULL)
     OR (NEW."status" = 'REJECTED') <> (btrim(coalesce(NEW."rejectReason", '')) <> '') THEN
    RAISE EXCEPTION 'floor work: off-standard block % is % with the wrong decision: APPROVED exactly with when (and who), REJECTED exactly with when, who and why', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."timezone" INTO zone FROM "Site" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."siteId";
  IF NEW."workDate" <> (NEW."startedAt" AT TIME ZONE zone)::date THEN
    RAISE EXCEPTION 'floor work: off-standard block % belongs to the site''s day it started in (%), not %', NEW."id", (NEW."startedAt" AT TIME ZONE zone)::date, NEW."workDate"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR (NEW."workerId", NEW."stationId") IS DISTINCT FROM (OLD."workerId", OLD."stationId") THEN
    PERFORM "factory_production_check_subject"(NEW."tenantId", NEW."siteId", NEW."workerId", NEW."stationId", 'off-standard block', NEW."id");
  END IF;
  IF TG_OP = 'INSERT' AND NEW."status" = 'OPEN' THEN
    running := "factory_floor_running_stretch"(NEW."tenantId", NEW."siteId", NEW."workerId", NEW."stationId");
    IF running IS NOT NULL THEN
      RAISE EXCEPTION 'floor work: off-standard block % starts only when no bundle runs (MES-156); work started by scan % runs: pause or hand it back first', NEW."id", running
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    PERFORM "factory_labour_day_refuse_closed"(OLD."tenantId", OLD."lineId", OLD."workDate", 'off-standard block', OLD."id");
  END IF;
  PERFORM "factory_labour_day_refuse_closed"(NEW."tenantId", NEW."lineId", NEW."workDate", 'off-standard block', NEW."id");
  RETURN NEW;
END
$$;

CREATE TRIGGER "OffStandardEntry_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OffStandardEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_off_standard_entry_guard"();
CREATE TRIGGER "OffStandardEntry_no_truncate" BEFORE TRUNCATE ON "OffStandardEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- One running block per worker (where the site records workers) and per station (where it records stations).
CREATE UNIQUE INDEX "OffStandardEntry_one_open_per_worker" ON "OffStandardEntry" ("tenantId", "workerId") WHERE "status" = 'OPEN' AND "workerId" IS NOT NULL;
CREATE UNIQUE INDEX "OffStandardEntry_one_open_per_station" ON "OffStandardEntry" ("tenantId", "stationId") WHERE "status" = 'OPEN' AND "workerId" IS NULL;

-- MES-204: an ended block's facts change (or it is reopened) only with a LabourEdit of it written in the same transaction
-- (its createdAt, now() kept to the millisecond, is the transaction's time: never before now() truncated to the
-- millisecond). Checked at commit, so the command may write the edit before or after.
CREATE FUNCTION "factory_off_standard_entry_edit_recorded"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "LabourEdit" e
                  WHERE e."tenantId" = NEW."tenantId" AND e."recordType" = 'OffStandardEntry' AND e."recordId" = NEW."id"
                    AND e."createdAt" >= date_trunc('milliseconds', now())) THEN
    RAISE EXCEPTION 'floor work: off-standard block % ended; a change of it keeps before and after, who and why: write its LabourEdit in the same command (MES-204)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "OffStandardEntry_edit_recorded" AFTER UPDATE ON "OffStandardEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."endedAt" IS NOT NULL
        AND ((NEW."lineId", NEW."stationId", NEW."workerId", NEW."codeId", NEW."workDate", NEW."startedAt", NEW."endedAt")
             IS DISTINCT FROM (OLD."lineId", OLD."stationId", OLD."workerId", OLD."codeId", OLD."workDate", OLD."startedAt", OLD."endedAt")
             OR (OLD."status" IN ('APPROVED', 'REJECTED') AND NEW."status" = 'PENDING')))
  EXECUTE FUNCTION "factory_off_standard_entry_edit_recorded"();

-- =====================================================================================================================
-- LabourDay (MES-203)
--   INSERT     OPEN or CLOSED.
--   UPDATE     the line, the day and the creation never change; OPEN → CLOSED (a new close: when, who); CLOSED → OPEN
--              (a new reopening: when, who, why); while CLOSED only its note changes.
--   every row  closed (when, who) exactly while CLOSED; the latest reopening all or none, with its reason.
--   closing    (INSERT CLOSED or → CLOSED) under the day's lock EXCLUSIVE: no off-standard block of the line's day is
--              OPEN or PENDING ("off-standard time coded").
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_labour_day_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  open_blocks integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'floor work: line day % is reopened, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."lineId", NEW."workDate", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."lineId", OLD."workDate", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'floor work: the line, day and creation of line day % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND NEW."status" = 'CLOSED'
       AND (NEW."closedAt", NEW."closedById", NEW."reopenedAt", NEW."reopenedById", NEW."reopenReason")
           IS DISTINCT FROM (OLD."closedAt", OLD."closedById", OLD."reopenedAt", OLD."reopenedById", OLD."reopenReason") THEN
      RAISE EXCEPTION 'floor work: line day % is CLOSED; only its note changes until it is reopened', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND NEW."status" = 'OPEN' AND (NEW."reopenedAt" IS NOT DISTINCT FROM OLD."reopenedAt" OR NEW."reopenedAt" <= OLD."closedAt") THEN
      RAISE EXCEPTION 'floor work: reopening line day % records a new reopening after its close (when, who and why)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'OPEN' AND NEW."status" = 'OPEN'
       AND (NEW."reopenedAt", NEW."reopenedById", NEW."reopenReason") IS DISTINCT FROM (OLD."reopenedAt", OLD."reopenedById", OLD."reopenReason") THEN
      RAISE EXCEPTION 'floor work: line day % keeps its latest reopening until it is closed again', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."status" = 'CLOSED') <> (NEW."closedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'floor work: line day % is % with the wrong close: when and who exactly while CLOSED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."reopenedAt" IS NULL) <> (NEW."reopenedById" IS NULL) OR (NEW."reopenedAt" IS NULL) <> (btrim(coalesce(NEW."reopenReason", '')) = '') THEN
    RAISE EXCEPTION 'floor work: line day % records its latest reopening with when, who and why, or none of them', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'CLOSED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'CLOSED') THEN
    PERFORM "factory_labour_day_lock"(NEW."tenantId", NEW."lineId", NEW."workDate", true);
    SELECT count(*) INTO open_blocks FROM "OffStandardEntry" e
     WHERE e."tenantId" = NEW."tenantId" AND e."lineId" = NEW."lineId" AND e."workDate" = NEW."workDate" AND e."status" IN ('OPEN', 'PENDING');
    IF open_blocks > 0 THEN
      RAISE EXCEPTION 'floor work: the day % of line % closes once its off-standard time is coded (MES-203): % block(s) still running or waiting for approval', NEW."workDate", NEW."lineId", open_blocks
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LabourDay_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LabourDay"
  FOR EACH ROW EXECUTE FUNCTION "factory_labour_day_guard"();
CREATE TRIGGER "LabourDay_no_truncate" BEFORE TRUNCATE ON "LabourDay"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- =====================================================================================================================
-- LabourEdit (MES-204), INSERT: a record type (a model name) and why; who (createdById); before and after two JSON
-- objects with the same keys, at least one, not equal; a dispute it answers is of the same worker. Append-only.
CREATE FUNCTION "factory_labour_edit_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  disputer uuid;
BEGIN
  IF NEW."recordType" !~ '^[A-Z][A-Za-z]+$' OR btrim(NEW."reason") = '' OR NEW."createdById" IS NULL THEN
    RAISE EXCEPTION 'floor work: labour edit % names the record''s type, says why and who made it (MES-204)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."before") <> 'object' OR jsonb_typeof(NEW."after") <> 'object'
     OR NEW."after" = '{}'::jsonb
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(NEW."before") k) IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(NEW."after") k)
     OR NEW."before" = NEW."after" THEN
    RAISE EXCEPTION 'floor work: labour edit % keeps the changed fields before and after: two objects with the same keys, at least one, not equal', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."disputeId" IS NOT NULL THEN
    SELECT d."workerId" INTO disputer FROM "LabourDispute" d WHERE d."tenantId" = NEW."tenantId" AND d."siteId" = NEW."siteId" AND d."id" = NEW."disputeId";
    IF FOUND AND disputer IS DISTINCT FROM NEW."workerId" THEN
      RAISE EXCEPTION 'floor work: labour edit % answers dispute %, which is of another worker''s record', NEW."id", NEW."disputeId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LabourEdit_check" BEFORE INSERT ON "LabourEdit"
  FOR EACH ROW EXECUTE FUNCTION "factory_labour_edit_check"();
CREATE TRIGGER "LabourEdit_append_only" BEFORE UPDATE OR DELETE ON "LabourEdit"
  FOR EACH ROW EXECUTE FUNCTION "factory_floor_work_refuse_change"();
CREATE TRIGGER "LabourEdit_no_truncate" BEFORE TRUNCATE ON "LabourEdit"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- =====================================================================================================================
-- LabourDispute (MES-206; GDPR art. 15)
--   INSERT     OPEN, with the worker's words; a worker is named only where the site records workers, having
--              acknowledged the notice (no record names one elsewhere, so there is nothing to dispute).
--   UPDATE     the worker, the record, the words, the day, the device and the creation never change; OPEN → UPHELD |
--              REJECTED | WITHDRAWN; then final.
--   every row  the answer (words, when, who) exactly when UPHELD or REJECTED, and never by the worker; withdrawn (when)
--              exactly when WITHDRAWN; a record type (a model name).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_labour_dispute_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  moving CONSTANT text[] := ARRAY['status', 'answer', 'answeredAt', 'answeredById', 'withdrawnAt', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'floor work: dispute % is answered or withdrawn, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NOT "factory_floor_work_visible"(NEW."tenantId", NEW."siteId") THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'floor work: dispute % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_production_check_subject"(NEW."tenantId", NEW."siteId", NEW."workerId", NULL, 'dispute', NEW."id");
  ELSE
    IF (to_jsonb(NEW) - (kept || moving)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || moving)) THEN
      RAISE EXCEPTION 'floor work: the worker, record, words, day and creation of dispute % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' OR (NEW."status" <> OLD."status" AND NEW."status" NOT IN ('UPHELD', 'REJECTED', 'WITHDRAWN')) THEN
      RAISE EXCEPTION 'floor work: dispute % is %; an OPEN dispute is answered (UPHELD, REJECTED) or withdrawn, then final', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."recordType" !~ '^[A-Z][A-Za-z]+$' OR btrim(NEW."message") = '' THEN
    RAISE EXCEPTION 'floor work: dispute % names the record''s type and says what is wrong', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('UPHELD', 'REJECTED')) <> (btrim(coalesce(NEW."answer", '')) <> '')
     OR (NEW."status" IN ('UPHELD', 'REJECTED')) <> (NEW."answeredAt" IS NOT NULL)
     OR (NEW."status" IN ('UPHELD', 'REJECTED')) <> (NEW."answeredById" IS NOT NULL)
     OR (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'floor work: dispute % is % with the wrong answer: UPHELD or REJECTED exactly with the answer, when and who; WITHDRAWN exactly with when', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."answeredById" IS NOT NULL AND NEW."answeredById" = NEW."workerId" THEN
    RAISE EXCEPTION 'floor work: dispute % is answered by the team leader or HR, never by the worker who raised it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LabourDispute_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LabourDispute"
  FOR EACH ROW EXECUTE FUNCTION "factory_labour_dispute_guard"();
CREATE TRIGGER "LabourDispute_no_truncate" BEFORE TRUNCATE ON "LabourDispute"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- =====================================================================================================================
-- DispatchAssignment (MES-022, -023, -027, -028), INSERT and UPDATE (a plan: the office deletes a line):
--   shape      a station or an operation; an operator, or an operation queued at a station; the operation with its
--              work order (both or neither); some bundles only with an operation, distinct, each an ACTIVE bundle of
--              the work order; a lane order from 1; an override reason with who (both or neither).
--   the day    its creation never changes.
--   checked when set or changed: the station ACTIVE and on the named line (when both are named); the operator
--              ACTIVE; the work order RELEASED, IN_PROGRESS or ON_HOLD.
CREATE FUNCTION "factory_dispatch_assignment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  station record;
  worker_state text;
  order_state text;
  found_bundles integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NOT "factory_floor_work_visible"(NEW."tenantId", NEW."siteId") THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'floor work: the creation of dispatch line % never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."stationId" IS NULL AND NEW."workOrderOperationId" IS NULL)
     OR (NEW."workerId" IS NULL AND (NEW."stationId" IS NULL OR NEW."workOrderOperationId" IS NULL))
     OR (NEW."workOrderId" IS NULL) <> (NEW."workOrderOperationId" IS NULL)
     OR (cardinality(NEW."bundleIds") > 0 AND NEW."workOrderOperationId" IS NULL)
     OR NEW."sequence" < 1
     OR (NEW."overrideById" IS NULL) <> (btrim(coalesce(NEW."overrideReason", '')) = '') THEN
    RAISE EXCEPTION 'floor work: dispatch line % names a station or an operation (with its work order), an operator or an operation queued at a station, bundles only with an operation, a lane order from 1, and an override with its reason and who', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stationId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."stationId" IS DISTINCT FROM OLD."stationId" OR NEW."lineId" IS DISTINCT FROM OLD."lineId") THEN
    SELECT s."status"::text AS status, s."lineId" INTO station FROM "Station" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."stationId";
    IF FOUND AND (station.status <> 'ACTIVE' OR (NEW."lineId" IS NOT NULL AND station."lineId" IS DISTINCT FROM NEW."lineId")) THEN
      RAISE EXCEPTION 'floor work: dispatch line % names an ACTIVE station, of its line when both are named', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."workerId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."workerId" IS DISTINCT FROM OLD."workerId") THEN
    SELECT w."status"::text INTO worker_state FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workerId";
    IF FOUND AND worker_state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'floor work: worker % is %; no work is dispatched to them', NEW."workerId", worker_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."workOrderId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."workOrderOperationId" IS DISTINCT FROM OLD."workOrderOperationId") THEN
    SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF FOUND AND order_state NOT IN ('RELEASED', 'IN_PROGRESS', 'ON_HOLD') THEN
      RAISE EXCEPTION 'floor work: work order % is %; only a released work order is dispatched', NEW."workOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF cardinality(NEW."bundleIds") > 0 AND (TG_OP = 'INSERT' OR NEW."bundleIds" IS DISTINCT FROM OLD."bundleIds" OR NEW."workOrderId" IS DISTINCT FROM OLD."workOrderId") THEN
    IF (SELECT count(DISTINCT b) FROM unnest(NEW."bundleIds") b) <> cardinality(NEW."bundleIds") OR array_position(NEW."bundleIds", NULL) IS NOT NULL THEN
      RAISE EXCEPTION 'floor work: dispatch line % lists each bundle once', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO found_bundles FROM "Bundle" b
     WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."workOrderId" = NEW."workOrderId" AND b."status" = 'ACTIVE' AND b."id" = ANY (NEW."bundleIds");
    IF found_bundles <> cardinality(NEW."bundleIds") THEN
      RAISE EXCEPTION 'floor work: dispatch line % lists ACTIVE bundles of work order % only', NEW."id", NEW."workOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "DispatchAssignment_guard" BEFORE INSERT OR UPDATE ON "DispatchAssignment"
  FOR EACH ROW EXECUTE FUNCTION "factory_dispatch_assignment_guard"();
CREATE TRIGGER "DispatchAssignment_no_truncate" BEFORE TRUNCATE ON "DispatchAssignment"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- =====================================================================================================================
-- BundleCoupon (MES-067)
--   INSERT     ACTIVE, of an ACTIVE bundle; or VOID already (when and why: a coupon voided at once, an offline record).
--   UPDATE     only ACTIVE → VOID, with when and why; everything else never changes; VOID is final.
--   every row  a code that is not blank; VOID exactly with when and why; the coupon it replaces is VOID, of the same
--              bundle and operation; one ACTIVE coupon per bundle and operation (the partial unique index).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_bundle_coupon_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  moving CONSTANT text[] := ARRAY['status', 'voidedAt', 'voidReason', 'version', 'updatedAt'];
  bundle_state text;
  replaced record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'floor work: coupon % is voided, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Nothing but the tenant or site changed: the policies' to refuse.
    IF (to_jsonb(NEW) - kept) IS NOT DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || moving)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || moving))
       OR OLD."status" = 'VOID' OR (NEW."status" = OLD."status" AND (NEW."voidedAt", NEW."voidReason") IS DISTINCT FROM (OLD."voidedAt", OLD."voidReason")) THEN
      RAISE EXCEPTION 'floor work: coupon % only becomes VOID, with when and why; nothing else of it changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."code") = '' OR (NEW."status" = 'VOID') <> (NEW."voidedAt" IS NOT NULL) OR (NEW."status" = 'VOID') <> (btrim(coalesce(NEW."voidReason", '')) <> '') THEN
    RAISE EXCEPTION 'floor work: coupon % has a code, and VOID exactly with when and why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT b."status"::text INTO bundle_state FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."id" = NEW."bundleId";
    IF FOUND AND NEW."status" = 'ACTIVE' AND bundle_state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'floor work: bundle % is %; it gets no coupon', NEW."bundleId", bundle_state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."replacesId" IS NOT NULL THEN
      SELECT c."bundleId", c."workOrderOperationId", c."status"::text AS status INTO replaced
        FROM "BundleCoupon" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."replacesId";
      IF FOUND AND (replaced."bundleId", replaced."workOrderOperationId") IS DISTINCT FROM (NEW."bundleId", NEW."workOrderOperationId") THEN
        RAISE EXCEPTION 'floor work: coupon % replaces a coupon of the same bundle and operation', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF FOUND AND replaced.status <> 'VOID' THEN
        RAISE EXCEPTION 'floor work: coupon % replaces coupon %, which is still ACTIVE: void it first', NEW."id", NEW."replacesId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "BundleCoupon_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BundleCoupon"
  FOR EACH ROW EXECUTE FUNCTION "factory_bundle_coupon_guard"();
CREATE TRIGGER "BundleCoupon_no_truncate" BEFORE TRUNCATE ON "BundleCoupon"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

CREATE UNIQUE INDEX "BundleCoupon_one_active" ON "BundleCoupon" ("tenantId", "bundleId", "workOrderOperationId") WHERE "status" = 'ACTIVE';

-- =====================================================================================================================
-- ScanPatternFinding (MES-075)
--   INSERT     OPEN; a window that ends after it starts; what was seen as a JSON object.
--   UPDATE     its facts (bundle, operation, kind, window, what was seen) and creation never change; OPEN → REVIEWED |
--              DISMISSED (when, who; a dismissal says why), then final.
--   every row  reviewed (when, who) exactly when not OPEN.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_scan_pattern_finding_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  moving CONSTANT text[] := ARRAY['status', 'reviewedAt', 'reviewedById', 'reviewNote', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'floor work: scan finding % is reviewed or dismissed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'floor work: scan finding % starts OPEN, not %', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Nothing but the tenant or site changed: the policies' to refuse.
    IF (to_jsonb(NEW) - kept) IS NOT DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || moving)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || moving)) THEN
      RAISE EXCEPTION 'floor work: what scan finding % saw never changes; it is reviewed or dismissed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'floor work: scan finding % is %; it is final', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."windowEnd" <= NEW."windowStart" OR jsonb_typeof(NEW."detail") <> 'object' THEN
    RAISE EXCEPTION 'floor work: scan finding % has a window that ends after it starts and what was seen as an object', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" <> 'OPEN') <> (NEW."reviewedAt" IS NOT NULL) OR (NEW."status" <> 'OPEN') <> (NEW."reviewedById" IS NOT NULL)
     OR (NEW."status" = 'DISMISSED' AND btrim(coalesce(NEW."reviewNote", '')) = '') THEN
    RAISE EXCEPTION 'floor work: scan finding % is % with the wrong review: when and who exactly once reviewed or dismissed, and a dismissal says why', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ScanPatternFinding_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ScanPatternFinding"
  FOR EACH ROW EXECUTE FUNCTION "factory_scan_pattern_finding_guard"();
CREATE TRIGGER "ScanPatternFinding_no_truncate" BEFORE TRUNCATE ON "ScanPatternFinding"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- =====================================================================================================================
-- CrewSession (PLT-059)
--   INSERT     open on an ACTIVE device in STATION mode; or ended already (an offline record).
--   UPDATE     the device, the start and the creation never change; an open crew ends (when, why) once every member
--              has left; an ended crew is final.
--   every row  ended (when, why) both or neither, never before it started; one open crew per device (the partial
--              unique index).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_crew_session_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  device record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'floor work: crew % is ended, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NOT "factory_floor_work_visible"(NEW."tenantId", NEW."siteId") THEN
    RETURN NEW;
  END IF;
  IF (NEW."endedAt" IS NULL) <> (NEW."endReason" IS NULL) OR NEW."endedAt" < NEW."startedAt" THEN
    RAISE EXCEPTION 'floor work: crew % ends with when and why (both or neither), never before it started', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."endedAt" IS NULL THEN
      SELECT d."status"::text AS status, d."mode"::text AS mode INTO device FROM "Device" d WHERE d."tenantId" = NEW."tenantId" AND d."siteId" = NEW."siteId" AND d."id" = NEW."deviceId";
      IF FOUND AND (device.status <> 'ACTIVE' OR device.mode <> 'STATION') THEN
        RAISE EXCEPTION 'floor work: device % is % in % mode; crews sign in on an ACTIVE station tablet (PLT-059)', NEW."deviceId", device.status, device.mode
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF (NEW."deviceId", NEW."startedAt", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."deviceId", OLD."startedAt", OLD."createdAt", OLD."createdById")
       OR (OLD."endedAt" IS NOT NULL AND (NEW."endedAt", NEW."endReason") IS DISTINCT FROM (OLD."endedAt", OLD."endReason")) THEN
      RAISE EXCEPTION 'floor work: the device, start and creation of crew % never change, and an ended crew is final', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."endedAt" IS NULL AND NEW."endedAt" IS NOT NULL
       AND EXISTS (SELECT 1 FROM "CrewMember" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."crewSessionId" = NEW."id" AND m."leftAt" IS NULL) THEN
      RAISE EXCEPTION 'floor work: crew % ends once every member has left (in the same command)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CrewSession_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CrewSession"
  FOR EACH ROW EXECUTE FUNCTION "factory_crew_session_guard"();
CREATE TRIGGER "CrewSession_no_truncate" BEFORE TRUNCATE ON "CrewSession"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

CREATE UNIQUE INDEX "CrewSession_one_open_per_device" ON "CrewSession" ("tenantId", "deviceId") WHERE "endedAt" IS NULL;

-- CrewMember (PLT-059)
--   INSERT     into an open crew, from its start, an ACTIVE worker who is in no other open crew, the crew holding at most
--              four members still in (under a lock per crew and one per worker); or a member who has left already
--              (an offline record: inside the crew's time). Their floor session (when named) is the worker's, on the
--              crew's device.
--   UPDATE     the crew, worker, joining and creation never change; the floor session is named once; a member leaves
--              once (never before joining); the active flag moves only while the member is in (one active per crew:
--              the partial unique index); a member who left is final, not active.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_crew_member_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  crew record;
  worker_state text;
  session record;
  members_in integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'floor work: crew member % leaves, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NOT "factory_floor_work_visible"(NEW."tenantId", NEW."siteId") THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."crewSessionId", NEW."workerId", NEW."joinedAt", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."crewSessionId", OLD."workerId", OLD."joinedAt", OLD."createdAt", OLD."createdById")
       OR (OLD."floorSessionId" IS NOT NULL AND NEW."floorSessionId" IS DISTINCT FROM OLD."floorSessionId")
       OR (OLD."leftAt" IS NOT NULL AND (NEW."leftAt", NEW."active") IS DISTINCT FROM (OLD."leftAt", OLD."active")) THEN
      RAISE EXCEPTION 'floor work: the crew, worker, joining and creation of crew member % never change; its floor session is named once; a member who left is final', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."leftAt" < NEW."joinedAt" OR (NEW."leftAt" IS NOT NULL AND NEW."active") THEN
    RAISE EXCEPTION 'floor work: crew member % leaves after joining, and is no longer the active one then', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c."deviceId", c."startedAt", c."endedAt" INTO crew FROM "CrewSession" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."crewSessionId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW."floorSessionId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."floorSessionId" IS NULL) THEN
    SELECT f."workerId", f."deviceId" INTO session FROM "FloorSession" f WHERE f."tenantId" = NEW."tenantId" AND f."siteId" = NEW."siteId" AND f."id" = NEW."floorSessionId";
    IF FOUND AND (session."workerId", session."deviceId") IS DISTINCT FROM (NEW."workerId", crew."deviceId") THEN
      RAISE EXCEPTION 'floor work: crew member % names a floor session of the same worker on the crew''s device', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."joinedAt" < crew."startedAt" OR (crew."endedAt" IS NOT NULL AND (NEW."leftAt" IS NULL OR NEW."leftAt" > crew."endedAt")) THEN
      RAISE EXCEPTION 'floor work: crew member % joins crew % while it is open (from its start), or is recorded inside its time', NEW."id", NEW."crewSessionId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."leftAt" IS NULL THEN
      SELECT w."status"::text INTO worker_state FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workerId";
      IF FOUND AND worker_state <> 'ACTIVE' THEN
        RAISE EXCEPTION 'floor work: worker % is %; they do not join a crew', NEW."workerId", worker_state
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.crew', NEW."tenantId", NEW."crewSessionId"), 0));
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.crew-worker', NEW."tenantId", NEW."workerId"), 0));
      SELECT count(*) INTO members_in FROM "CrewMember" m WHERE m."tenantId" = NEW."tenantId" AND m."crewSessionId" = NEW."crewSessionId" AND m."leftAt" IS NULL;
      IF members_in >= 4 THEN
        RAISE EXCEPTION 'floor work: crew % holds four workers already (PLT-059: up to four on one tablet)', NEW."crewSessionId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "CrewMember" m JOIN "CrewSession" c ON c."tenantId" = m."tenantId" AND c."id" = m."crewSessionId"
                  WHERE m."tenantId" = NEW."tenantId" AND m."workerId" = NEW."workerId" AND m."leftAt" IS NULL AND c."endedAt" IS NULL) THEN
        RAISE EXCEPTION 'floor work: worker % is in another open crew; they leave it first', NEW."workerId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CrewMember_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CrewMember"
  FOR EACH ROW EXECUTE FUNCTION "factory_crew_member_guard"();
CREATE TRIGGER "CrewMember_no_truncate" BEFORE TRUNCATE ON "CrewMember"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

CREATE UNIQUE INDEX "CrewMember_one_active" ON "CrewMember" ("tenantId", "crewSessionId") WHERE "active";

-- =====================================================================================================================
-- Device, its mode (MES-181, MES-186): a line only for a LINE or DISPLAY device, a personal worker only for a PHONE; an
-- ACTIVE line and an ACTIVE worker when set or changed; the floor (factory_floor_runtime) never changes the mode, the
-- line or the personal worker (the office chooses them at enrolment).
CREATE FUNCTION "factory_device_mode_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."mode", NEW."lineId", NEW."personalWorkerId") IS NOT DISTINCT FROM (OLD."mode", OLD."lineId", OLD."personalWorkerId") THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND current_user = 'factory_floor_runtime' THEN
    RAISE EXCEPTION 'devices: the mode, line and personal worker of device % are chosen in the office, never on the floor', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."lineId" IS NOT NULL AND NEW."mode" NOT IN ('LINE', 'DISPLAY')) OR (NEW."personalWorkerId" IS NOT NULL AND NEW."mode" <> 'PHONE') THEN
    RAISE EXCEPTION 'devices: device % is in % mode; a line is for a LINE or DISPLAY device, a personal worker only for a PHONE (MES-186)', NEW."id", NEW."mode"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lineId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."lineId" IS DISTINCT FROM OLD."lineId") THEN
    SELECT l."status"::text INTO state FROM "Line" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."lineId";
    IF FOUND AND state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'devices: line % is %; device % shows an ACTIVE line', NEW."lineId", state, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."personalWorkerId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."personalWorkerId" IS DISTINCT FROM OLD."personalWorkerId") THEN
    SELECT w."status"::text INTO state FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."personalWorkerId";
    IF FOUND AND state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'devices: worker % is %; device % is the phone of an ACTIVE worker', NEW."personalWorkerId", state, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Device_mode_check" BEFORE INSERT OR UPDATE ON "Device"
  FOR EACH ROW EXECUTE FUNCTION "factory_device_mode_check"();

-- =====================================================================================================================
-- HelpCallType (MES-142, MES-144, MES-148)
--   UPDATE     its company, site, code and creation never change.
--   every row  a code without spaces; the responder group as "Team" or "Role" with its id, or neither (a role of the
--              tenant, when it is one); escalation after 1-240 minutes or never; the off-standard code of the waiting an
--              OFF_STANDARD code of the company, ACTIVE when set or changed.
--   DELETE     refused (set inactive). TRUNCATE refused.
CREATE FUNCTION "factory_help_call_type_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  code record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'andon: help-call type % is set inactive, never deleted (calls keep it)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."companyId", NEW."code", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."code", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'andon: help-call type % keeps its company, site and code', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_floor_work_visible"(NEW."tenantId", NEW."siteId") THEN
    RETURN NEW;
  END IF;
  IF NEW."code" !~ '^\S+$'
     OR (NEW."responderRecordType" IS NULL) <> (NEW."responderRecordId" IS NULL)
     OR NEW."responderRecordType" NOT IN ('Team', 'Role')
     OR NEW."escalateAfterMinutes" NOT BETWEEN 1 AND 240 THEN
    RAISE EXCEPTION 'andon: help-call type % has a code without spaces, a responder group as Team or Role with its id (or neither), and escalates after 1-240 minutes or never', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."responderRecordType" = 'Role' AND (TG_OP = 'INSERT' OR NEW."responderRecordId" IS DISTINCT FROM OLD."responderRecordId")
     AND NOT EXISTS (SELECT 1 FROM "Role" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."responderRecordId") THEN
    RAISE EXCEPTION 'andon: help-call type % is answered by role %, which is not a role of the tenant', NEW."id", NEW."responderRecordId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."offStandardCodeId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."offStandardCodeId" IS DISTINCT FROM OLD."offStandardCodeId") THEN
    SELECT c."kind"::text AS kind, c."active" INTO code FROM "OffStandardCode" c WHERE c."tenantId" = NEW."tenantId" AND c."companyId" = NEW."companyId" AND c."id" = NEW."offStandardCodeId";
    IF FOUND AND (code.kind <> 'OFF_STANDARD' OR NOT code.active) THEN
      RAISE EXCEPTION 'andon: help-call type % books its waiting to an ACTIVE OFF_STANDARD code (MES-148)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "HelpCallType_guard" BEFORE INSERT OR UPDATE OR DELETE ON "HelpCallType"
  FOR EACH ROW EXECUTE FUNCTION "factory_help_call_type_guard"();
CREATE TRIGGER "HelpCallType_no_truncate" BEFORE TRUNCATE ON "HelpCallType"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- HelpCall (MES-142…147)
--   INSERT     any state with its times (a call made and answered while the tablet was offline arrives whole); its type
--              ACTIVE; its line the station's; a caller named only where the site records workers, having acknowledged
--              the notice.
--   UPDATE     the type, station, line, caller, work order, bundle, sending, device and creation never change; SENT →
--              SEEN → ON_THE_WAY → SOLVED forward (steps may be skipped), or CANCELLED from an open state; a time and its
--              taker, once set, never change; SOLVED and CANCELLED change only what the call led to (named once).
--   every row  a bundle with its work order; each time after the one before (sent ≤ seen ≤ on the way ≤ solved;
--              cancelled after sending); SEEN with its time, ON_THE_WAY with its, SOLVED exactly with its, CANCELLED
--              exactly with its; a taker only with its time; no later time than the state reached; a resolution only
--              when SOLVED (a code without spaces); what it led to as type and id (both or neither); one open call per
--              station and type (the partial unique index).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_help_call_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rank_old integer;
  rank_new integer;
  type_active boolean;
  station_line uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'andon: help call % is solved or cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NOT "factory_floor_work_visible"(NEW."tenantId", NEW."siteId") THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT t."active" INTO type_active FROM "HelpCallType" t WHERE t."tenantId" = NEW."tenantId" AND t."siteId" = NEW."siteId" AND t."id" = NEW."typeId";
    IF FOUND AND NOT type_active THEN
      RAISE EXCEPTION 'andon: help-call type % is inactive; no call is sent with it', NEW."typeId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT s."lineId" INTO station_line FROM "Station" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."stationId";
    IF FOUND AND NEW."lineId" IS DISTINCT FROM station_line THEN
      RAISE EXCEPTION 'andon: help call % carries the line of its station (%)', NEW."id", coalesce(station_line::text, 'none')
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."workerId" IS NOT NULL THEN
      PERFORM "factory_production_check_subject"(NEW."tenantId", NEW."siteId", NEW."workerId", NEW."stationId", 'help call', NEW."id");
    END IF;
  ELSE
    IF (NEW."typeId", NEW."stationId", NEW."lineId", NEW."workerId", NEW."workOrderId", NEW."bundleId", NEW."sentAt", NEW."deviceId", NEW."clientEventId", NEW."deviceTime", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."typeId", OLD."stationId", OLD."lineId", OLD."workerId", OLD."workOrderId", OLD."bundleId", OLD."sentAt", OLD."deviceId", OLD."clientEventId", OLD."deviceTime", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'andon: the type, station, caller, subject and sending of help call % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."seenAt" IS NOT NULL AND (NEW."seenAt", NEW."seenById") IS DISTINCT FROM (OLD."seenAt", OLD."seenById"))
       OR (OLD."onTheWayAt" IS NOT NULL AND (NEW."onTheWayAt", NEW."onTheWayById") IS DISTINCT FROM (OLD."onTheWayAt", OLD."onTheWayById"))
       OR (OLD."solvedAt" IS NOT NULL AND (NEW."solvedAt", NEW."solvedById", NEW."resolutionCode", NEW."resolutionNote") IS DISTINCT FROM (OLD."solvedAt", OLD."solvedById", OLD."resolutionCode", OLD."resolutionNote"))
       OR (OLD."cancelledAt" IS NOT NULL AND (NEW."cancelledAt", NEW."cancelledById") IS DISTINCT FROM (OLD."cancelledAt", OLD."cancelledById"))
       OR (OLD."escalatedAt" IS NOT NULL AND NEW."escalatedAt" IS DISTINCT FROM OLD."escalatedAt")
       OR (OLD."outcomeRecordType" IS NOT NULL AND (NEW."outcomeRecordType", NEW."outcomeRecordId") IS DISTINCT FROM (OLD."outcomeRecordType", OLD."outcomeRecordId")) THEN
      RAISE EXCEPTION 'andon: a time of help call % (and who took it), its escalation and what it led to are set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    rank_old := array_position(ARRAY['SENT', 'SEEN', 'ON_THE_WAY', 'SOLVED'], OLD."status"::text);
    rank_new := array_position(ARRAY['SENT', 'SEEN', 'ON_THE_WAY', 'SOLVED'], NEW."status"::text);
    IF OLD."status"::text IN ('SOLVED', 'CANCELLED') AND NEW."status" <> OLD."status" THEN
      RAISE EXCEPTION 'andon: help call % is %; it is final', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'CANCELLED' AND rank_new < rank_old THEN
      RAISE EXCEPTION 'andon: help call % moves forward only (Sent → Seen → On the way → Solved), not from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status"::text IN ('SOLVED', 'CANCELLED') AND NEW."escalatedAt" IS DISTINCT FROM OLD."escalatedAt" THEN
      RAISE EXCEPTION 'andon: help call % is %; it is no longer escalated', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."bundleId" IS NOT NULL AND NEW."workOrderId" IS NULL)
     OR NEW."seenAt" < NEW."sentAt" OR NEW."onTheWayAt" < coalesce(NEW."seenAt", NEW."sentAt")
     OR NEW."solvedAt" < coalesce(NEW."onTheWayAt", NEW."seenAt", NEW."sentAt") OR NEW."cancelledAt" < NEW."sentAt" THEN
    RAISE EXCEPTION 'andon: help call % names a bundle with its work order, and each time after the one before it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'SENT' AND (NEW."seenAt" IS NOT NULL OR NEW."onTheWayAt" IS NOT NULL))
     OR (NEW."status" = 'SEEN' AND (NEW."seenAt" IS NULL OR NEW."onTheWayAt" IS NOT NULL))
     OR (NEW."status" = 'ON_THE_WAY' AND NEW."onTheWayAt" IS NULL)
     OR (NEW."status" = 'SOLVED') <> (NEW."solvedAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."seenById" IS NOT NULL AND NEW."seenAt" IS NULL) OR (NEW."onTheWayById" IS NOT NULL AND NEW."onTheWayAt" IS NULL)
     OR (NEW."solvedById" IS NOT NULL AND NEW."solvedAt" IS NULL) OR (NEW."cancelledById" IS NOT NULL AND NEW."cancelledAt" IS NULL)
     OR (NEW."status" <> 'SOLVED' AND (NEW."resolutionCode" IS NOT NULL OR NEW."resolutionNote" IS NOT NULL))
     OR NEW."resolutionCode" !~ '^\S+$'
     OR (NEW."outcomeRecordType" IS NULL) <> (NEW."outcomeRecordId" IS NULL) OR NEW."outcomeRecordType" !~ '^[A-Z][A-Za-z]+$'
     OR (NEW."clientEventId" IS NOT NULL AND btrim(NEW."clientEventId") = '') THEN
    RAISE EXCEPTION 'andon: help call % is % with the wrong times: each state with its time (and who took it), no time beyond the state reached, a resolution only when SOLVED, what it led to as type and id', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "HelpCall_guard" BEFORE INSERT OR UPDATE OR DELETE ON "HelpCall"
  FOR EACH ROW EXECUTE FUNCTION "factory_help_call_guard"();
CREATE TRIGGER "HelpCall_no_truncate" BEFORE TRUNCATE ON "HelpCall"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- One open call per station and type (MES-143: a second tap shows the open call, never a duplicate).
CREATE UNIQUE INDEX "HelpCall_one_open_per_station_type" ON "HelpCall" ("tenantId", "stationId", "typeId") WHERE "status" IN ('SENT', 'SEEN', 'ON_THE_WAY');

-- =====================================================================================================================
-- LineTarget (MES-161, MES-162, ANA-007)
--   UPDATE     the line, day, hour and creation never change; the floor (the team leader) changes only the reason of a
--              short hour.
--   every row  an hour from 0 (the API keeps it below 24; the isolation copy test moves it), pieces from 0; a short
--              hour's reason as a code without spaces and/or words, with when and who exactly when either is given.
--   DELETE     the office removes a target (no trigger). TRUNCATE refused.
CREATE FUNCTION "factory_line_target_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  reason CONSTANT text[] := ARRAY['shortReasonCode', 'shortNote', 'shortReasonAt', 'shortReasonById', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."lineId", NEW."workDate", NEW."hour", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."lineId", OLD."workDate", OLD."hour", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'andon: the line, day, hour and creation of target % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime' AND (to_jsonb(NEW) - (kept || reason)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || reason)) THEN
      RAISE EXCEPTION 'andon: on the floor the team leader gives the reason of a short hour; target % itself is set in the office', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."hour" < 0 OR NEW."targetPieces" < 0 THEN
    RAISE EXCEPTION 'andon: target % is for an hour of the day, in pieces from 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shortReasonCode" !~ '^\S+$' OR btrim(NEW."shortNote") = ''
     OR (NEW."shortReasonCode" IS NULL AND NEW."shortNote" IS NULL) <> (NEW."shortReasonAt" IS NULL)
     OR (NEW."shortReasonAt" IS NULL) <> (NEW."shortReasonById" IS NULL) THEN
    RAISE EXCEPTION 'andon: target % gives the reason of a short hour as a code and/or words, with when and who', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LineTarget_guard" BEFORE INSERT OR UPDATE ON "LineTarget"
  FOR EACH ROW EXECUTE FUNCTION "factory_line_target_guard"();
CREATE TRIGGER "LineTarget_no_truncate" BEFORE TRUNCATE ON "LineTarget"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- =====================================================================================================================
-- HandoverNote (MES-033): the line, day, shift, device and creation never change; at least a topic or a text, each topic
-- once, a text of at most 1000 characters, a shift label that is not blank. DELETE refused. TRUNCATE refused.
CREATE FUNCTION "factory_handover_note_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'andon: handover note % is edited, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."lineId", NEW."shiftDate", NEW."shiftLabel", NEW."deviceId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."lineId", OLD."shiftDate", OLD."shiftLabel", OLD."deviceId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'andon: the line, shift and creation of handover note % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."shiftLabel") = ''
     OR (cardinality(NEW."topics") = 0 AND btrim(coalesce(NEW."text", '')) = '')
     OR (SELECT count(DISTINCT t) FROM unnest(NEW."topics") t) <> cardinality(NEW."topics")
     OR char_length(NEW."text") > 1000 THEN
    RAISE EXCEPTION 'andon: handover note % names its shift and gives a topic or a short text (each topic once, at most 1000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "HandoverNote_guard" BEFORE INSERT OR UPDATE OR DELETE ON "HandoverNote"
  FOR EACH ROW EXECUTE FUNCTION "factory_handover_note_guard"();
CREATE TRIGGER "HandoverNote_no_truncate" BEFORE TRUNCATE ON "HandoverNote"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- =====================================================================================================================
-- ProductionSettings, the floor checks of a site (MES-097, MES-098, MES-128, MES-168): a scrap approval limit from 1
-- piece (or none), a stuck bundle after 1-720 hours. A trigger of its own (production's settings guard is untouched).
CREATE FUNCTION "factory_production_settings_floor_checks"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."scrapApprovalLimit" < 1 OR NEW."stuckBundleHours" NOT BETWEEN 1 AND 720 THEN
    RAISE EXCEPTION 'production: the floor rules % ask the lead''s approval from 1 scrapped piece (or never) and call a bundle stuck after 1-720 hours', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ProductionSettings_floor_checks" BEFORE INSERT OR UPDATE ON "ProductionSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_production_settings_floor_checks"();

-- =====================================================================================================================
-- WorkOrder: factory_work_order_guard of …_production_w2a_guards, redefined whole, with W2b's rush flag and split
-- (MES-009, MES-010). The changes, each marked "W2b" below:
--   rush       changes like the priority (in `progress`): until the work order is CLOSED or CANCELLED.
--   split      the work order it was split from never changes; when it is made, that is another work order of the same
--              style and kind (the reference keeps the site), not CANCELLED, CLOSED or COMPLETED.
CREATE OR REPLACE FUNCTION "factory_work_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  -- W2b: rush moves with the priority.
  progress CONSTANT text[] := ARRAY['status', 'dueDate', 'priority', 'rush', 'note', 'startedAt', 'completedAt', 'closedAt', 'cancelledAt',
    'cancelReason', 'lineId', 'heldFromStatus', 'holdReason', 'heldAt', 'heldById', 'holdRecordType', 'holdRecordId', 'version', 'updatedAt'];
  effective text;
  revision_state text;
  revision_label uuid;
  label_state text;
  line_state text;
  cells integer;
  wrong_cells integer;
  operations integer;
  unmapped integer;
  parent record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: work order % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'production: work order % starts as DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b (MES-010): a split's parent is another work order of the same style and kind, still open.
    IF NEW."splitFromId" IS NOT NULL THEN
      SELECT w."styleId", w."kind"::text AS kind, w."status"::text AS status INTO parent
        FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."splitFromId";
      IF NEW."splitFromId" = NEW."id" OR (FOUND AND (parent."styleId" <> NEW."styleId" OR parent.kind <> NEW."kind"::text)) THEN
        RAISE EXCEPTION 'production: work order % is split from another work order of the same style and kind (MES-010)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF FOUND AND parent.status IN ('CANCELLED', 'CLOSED', 'COMPLETED') THEN
        RAISE EXCEPTION 'production: work order % is %; nothing is split from it', NEW."splitFromId", parent.status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    -- W2b: the split it came from never changes either.
    IF (NEW."id", NEW."companyId", NEW."number", NEW."kind", NEW."styleId", NEW."splitFromId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."number", OLD."kind", OLD."styleId", OLD."splitFromId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: the company, number, kind, style, split and creation of work order % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('RELEASED', 'CANCELLED', 'ON_HOLD'))
                OR (OLD."status" = 'RELEASED' AND NEW."status" IN ('IN_PROGRESS', 'CANCELLED', 'ON_HOLD'))
                OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('COMPLETED', 'CANCELLED', 'ON_HOLD'))
                OR (OLD."status" = 'COMPLETED' AND NEW."status" = 'CLOSED')
                OR (OLD."status" = 'ON_HOLD' AND (NEW."status" = OLD."heldFromStatus" OR NEW."status" = 'CANCELLED'))) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('production: work order %s cannot move from %s to %s%s', OLD."id", OLD."status", NEW."status",
          CASE WHEN OLD."status" = 'ON_HOLD' THEN format(' (lifting its hold puts it back to %s, MES-008)', OLD."heldFromStatus") ELSE '' END);
    END IF;
    IF NEW."status" = 'ON_HOLD' AND OLD."status" <> 'ON_HOLD' AND NEW."heldFromStatus" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'production: work order % is held from the status it is in (%), the status lifting the hold goes back to (MES-008)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'ON_HOLD' AND OLD."status" = 'ON_HOLD'
       AND (NEW."heldFromStatus", NEW."heldAt", NEW."heldById") IS DISTINCT FROM (OLD."heldFromStatus", OLD."heldAt", OLD."heldById") THEN
      RAISE EXCEPTION 'production: the hold of work order % keeps where it was held from, when and by whom; a new hold comes after this one is lifted', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - (kept || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || progress)) THEN
      RAISE EXCEPTION 'production: work order % is %; its frozen specification (revision, label template, batch number) and release never change (MES-005); a different specification is a new work order', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'production: work order % is %; only its note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'COMPLETED' AND NEW."lineId" IS DISTINCT FROM OLD."lineId" THEN
      RAISE EXCEPTION 'production: work order % is COMPLETED; the line it was made on stays (output is counted per line)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'DRAFT' AND NEW."status" = 'RELEASED' THEN
      IF NEW."styleRevisionId" IS NULL THEN
        RAISE EXCEPTION 'production: work order % is released with a RELEASED revision of its style', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."status"::text, r."labelTemplateId" INTO revision_state, revision_label
        FROM "StyleRevision" r WHERE r."tenantId" = NEW."tenantId" AND r."styleId" = NEW."styleId" AND r."id" = NEW."styleRevisionId";
      IF FOUND THEN
        IF revision_state <> 'RELEASED' THEN
          RAISE EXCEPTION 'production: revision % is %; work order % is released only with a RELEASED revision of its style', NEW."styleRevisionId", revision_state, NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."labelTemplateId" IS DISTINCT FROM revision_label THEN
          RAISE EXCEPTION 'production: work order % carries the label template of its revision % (%), frozen with it', NEW."id", NEW."styleRevisionId", coalesce(revision_label::text, 'none')
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      IF NEW."labelTemplateId" IS NOT NULL THEN
        SELECT t."status"::text INTO label_state FROM "LabelTemplate" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."labelTemplateId";
        IF FOUND AND label_state <> 'ACTIVE' THEN
          RAISE EXCEPTION 'production: label template % is %; work order % is released with an ACTIVE one', NEW."labelTemplateId", label_state, NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      SELECT count(*),
             count(*) FILTER (WHERE CASE WHEN NEW."kind" = 'REPAIR'
                                         THEN c."measurementProfileId" IS NOT NULL AND c."quantity" <> 1
                                         ELSE (c."measurementProfileId" IS NOT NULL) <> (NEW."kind" = 'MADE_TO_MEASURE')
                                              OR (NEW."kind" = 'MADE_TO_MEASURE' AND c."quantity" <> 1) END)
        INTO cells, wrong_cells
        FROM "WorkOrderSize" c WHERE c."tenantId" = NEW."tenantId" AND c."workOrderId" = NEW."id";
      IF cells = 0 OR wrong_cells > 0 OR (NEW."kind" = 'MADE_TO_MEASURE' AND cells <> 1) THEN
        RAISE EXCEPTION 'production: work order % is released with its cells: a size grid without measurement profiles, one made-to-measure unit of quantity 1 with its profile, or a repair''s garments (a made-to-measure one a single unit with its profile)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*) INTO operations FROM "WorkOrderOperation" o WHERE o."tenantId" = NEW."tenantId" AND o."workOrderId" = NEW."id";
      SELECT count(*) INTO unmapped
        FROM "RoutingOperation" ro
       WHERE ro."tenantId" = NEW."tenantId" AND ro."revisionId" = NEW."styleRevisionId"
         AND NOT EXISTS (SELECT 1 FROM "WorkOrderOperation" o
                          WHERE o."tenantId" = NEW."tenantId" AND o."workOrderId" = NEW."id" AND o."routingSeq" = ro."seq");
      IF operations = 0 OR (NEW."kind" <> 'REPAIR' AND unmapped > 0) THEN
        RAISE EXCEPTION 'production: work order % is released with every step of its revision''s routing as an operation at a work centre of its site (% step(s) missing); a repair with at least one', NEW."id", unmapped
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  effective := CASE WHEN NEW."status" = 'ON_HOLD' THEN NEW."heldFromStatus"::text ELSE NEW."status"::text END;

  IF btrim(NEW."number") = '' OR (NEW."batchNumber" IS NOT NULL AND btrim(NEW."batchNumber") = '') THEN
    RAISE EXCEPTION 'production: work order % has a number, and a batch number that is not blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ON_HOLD') <> (NEW."heldFromStatus" IS NOT NULL)
     OR (NEW."status" = 'ON_HOLD') <> (NEW."heldAt" IS NOT NULL)
     OR (NEW."status" = 'ON_HOLD') <> (btrim(coalesce(NEW."holdReason", '')) <> '')
     OR (NEW."status" <> 'ON_HOLD' AND (NEW."heldById" IS NOT NULL OR NEW."holdRecordType" IS NOT NULL OR NEW."holdRecordId" IS NOT NULL))
     OR (NEW."heldFromStatus" IS NOT NULL AND NEW."heldFromStatus" NOT IN ('DRAFT', 'RELEASED', 'IN_PROGRESS'))
     OR (NEW."holdRecordType" IS NULL) <> (NEW."holdRecordId" IS NULL)
     OR btrim(coalesce(NEW."holdRecordType", '-')) = '' THEN
    RAISE EXCEPTION 'production: work order % is % with the wrong hold: ON_HOLD exactly with the status it was held from (DRAFT, RELEASED or IN_PROGRESS), when and why (MES-008), and the record behind it as type and id or neither; no hold otherwise', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lineId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."lineId" IS DISTINCT FROM OLD."lineId") THEN
    SELECT l."status"::text INTO line_state FROM "Line" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."lineId";
    IF FOUND AND line_state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'production: line % is %; work order % is allocated to an ACTIVE line of its site (PLN-160)', NEW."lineId", line_state, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (effective IN ('RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED') AND NEW."releasedAt" IS NULL)
     OR (effective = 'DRAFT' AND (NEW."releasedAt" IS NOT NULL OR NEW."releasedById" IS NOT NULL))
     OR (NEW."releasedAt" IS NULL) <> (NEW."batchNumber" IS NULL)
     OR (NEW."releasedAt" IS NOT NULL AND NEW."styleRevisionId" IS NULL) THEN
    RAISE EXCEPTION 'production: work order % is % with the wrong release: its release time, revision and batch number (MES-076) are set exactly from RELEASED on', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (effective IN ('IN_PROGRESS', 'COMPLETED', 'CLOSED') AND NEW."startedAt" IS NULL)
     OR (effective IN ('DRAFT', 'RELEASED') AND NEW."startedAt" IS NOT NULL)
     OR (effective IN ('COMPLETED', 'CLOSED')) <> (NEW."completedAt" IS NOT NULL)
     OR (effective = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'production: work order % is % with the wrong start, completion or closing time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'production: work order % is % with the wrong cancellation (a cancelled work order has its time and reason, MES-007)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
