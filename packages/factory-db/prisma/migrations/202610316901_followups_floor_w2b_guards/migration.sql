-- Written by hand (Prisma does not model triggers), after the generated 202610316600_followups_floor_w2b_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- W2b-2 follow-ups for the floor (B-W2b-74, W2b schema wave 8/16; what B-W2b-39, -41, -47, -49, -53, -59, -35, -38, -43 and -70
-- built around with constants and audit rows). The API answers each refusal first, in words; these are the last word, for
-- every login. Redefined whole from their latest bodies: numbering's `factory_number_series_document_kind` and
-- `factory_number_block_guard` (COUPON), production's `factory_work_order_operation_guard` (unplanned operations, the
-- parallel group) and the scan records' `factory_scan_correction_request_guard` (a floor session reads no Worker.userId).
-- `OffStandardEntry_edit_recorded` is recreated with the work order among the facts. Everything else is a trigger of its
-- own, so the W2b-12 and pay bodies stay as they are.
--
--   NumberSeries, NumberBlock  COUPON is a scan-id kind: one tenant-wide counter (the NumberBlock ledger), never a series.
--                              Coupons printed before it keep their BN-… code from the BUNDLE counter: BundleCoupon.code
--                              has no format, nothing here touches them.
--   WorkOrderOperation         MES-086: on a RELEASED or IN_PROGRESS work order a row with no routing step may be added, a
--                              copy of an ACTIVE library operation of the company, with why, in no parallel group; MES-005's
--                              freeze stays for the routing's copies, and an added row is frozen like them. A floor
--                              session adds only such a row. The routing's copy now includes the parallel group.
--   RoutingOperation           a parallel group is a number from 1.
--   ScanCorrectionRequest      a team leader on the floor decides one (its grant is new): the columns it may change were
--                              the guard's already; the four-eyes check no longer reads Worker.userId in a floor session.
--   ScrapApproval              asked of a floor REPORT whose scrap is above the limit, decided once (WAITING → APPROVED |
--                              REFUSED), exact columns, four eyes, a voided scan's row is not decided, never deleted.
--   OffStandardEntry           its work order is not a DRAFT or CANCELLED one when it is named; a change of it after the
--                              block ended comes with a LabourEdit, like the other facts.
--   HelpCall                   the reason tile and the requested quantity (a material call's, above 0) are set once,
--                              while the call is open.
--   EarningsEntry              a scan of an unplanned operation pays a rate of that operation (the pay check compares only
--                              through the routing step, which it has none of).
-- The tenant and site columns are left to the policies: a row moved out of its scope is refused by row-level security.

-- ---------------------------------------------------------------------------------------------------------------------
-- NumberSeries and NumberBlock (…_numbering_floor_guards): COUPON among the scan-id kinds.
CREATE OR REPLACE FUNCTION "factory_number_series_document_kind"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind"::text IN ('BUNDLE', 'HIDE', 'GARMENT_SERIAL', 'COUPON') THEN
    RAISE EXCEPTION 'number series %: % is a scan-id kind; its numbers come from the tenant''s number blocks, never a series', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "factory_number_block_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  session_tenant uuid := NULLIF(current_setting('factory.tenant_id', true), '')::uuid;
  device_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'number block %: a block is closed, never deleted (its numbers stay handed out)', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."kind"::text NOT IN ('BUNDLE', 'HIDE', 'GARMENT_SERIAL', 'COUPON') THEN
    RAISE EXCEPTION 'number block %: % is a document kind; its numbers come from a number series', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW."kind", NEW."purpose", NEW."fromRef", NEW."toRef", NEW."deviceId", NEW."requestId", NEW."createdAt")
       IS DISTINCT FROM (OLD."kind", OLD."purpose", OLD."fromRef", OLD."toRef", OLD."deviceId", OLD."requestId", OLD."createdAt") THEN
      RAISE EXCEPTION 'number block %: its kind, purpose, range, tablet and origin never change; close it instead', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND (NEW."status", NEW."closedAt", NEW."closedReason") IS DISTINCT FROM (OLD."status", OLD."closedAt", OLD."closedReason") THEN
      RAISE EXCEPTION 'number block %: a closed block stays closed', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" = 'CLOSED' AND OLD."status" = 'ACTIVE' THEN
      -- The same lock as a use of its numbers: a use in flight lands before the closing, or sees the block closed.
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.number-block', OLD."tenantId"::text, OLD."id"::text), 0));
    END IF;
  ELSE
    IF NEW."fromRef" < 1 OR NEW."toRef" < NEW."fromRef" OR NEW."toRef" - NEW."fromRef" + 1 > 1000 THEN
      RAISE EXCEPTION 'number block %: a block holds 1 to 1000 references from 1 up (% to %)', NEW."id", NEW."fromRef", NEW."toRef"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'number block %: a block starts open', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."purpose" = 'DEVICE') <> (NEW."deviceId" IS NOT NULL) THEN
      RAISE EXCEPTION 'number block %: a DEVICE block names its tablet and an ONLINE block none', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" = 'CLOSED' AND (NEW."closedAt" IS NULL OR NEW."closedReason" IS NULL OR btrim(NEW."closedReason") = '') THEN
    RAISE EXCEPTION 'number block %: a closed block says when and why it was closed', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'ACTIVE' AND (NEW."closedAt" IS NOT NULL OR NEW."closedReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'number block %: an open block has no closing time or reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;

  -- INSERT, in the session's own tenant (another tenant's row is left to row-level security).
  IF NEW."tenantId" IS NULL OR (session_tenant IS NOT NULL AND NEW."tenantId" IS DISTINCT FROM session_tenant) THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.scan-ids', NEW."tenantId"::text, NEW."kind"::text), 0));
  IF EXISTS (SELECT 1 FROM "NumberBlock" b WHERE b."tenantId" = NEW."tenantId" AND b."kind" = NEW."kind" AND b."toRef" >= NEW."fromRef") THEN
    RAISE EXCEPTION 'number block %: % references from % were handed out already; a block starts above every block of its kind', NEW."id", NEW."kind", NEW."fromRef"
      USING ERRCODE = 'unique_violation';
  END IF;
  IF NEW."purpose" = 'DEVICE' THEN
    SELECT d."status"::text INTO device_status FROM "Device" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."deviceId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'number block %: tablet % is not one this session may reserve numbers for (unknown, or at another site)', NEW."id", NEW."deviceId"
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF device_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'number block %: tablet % is %; only an enrolled, active tablet gets numbers', NEW."id", NEW."deviceId", device_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- WorkOrderOperation (…_production_guards), whole.
--   INSERT, DELETE  while the work order is DRAFT (its row locked FOR SHARE); W2b-2: an INSERT of an unplanned operation
--                   only while it is RELEASED or IN_PROGRESS; a floor session inserts nothing else.
--   UPDATE          as before: an UPDATE that changes nothing passes; an operation never moves to another work order;
--                   after DRAFT only its work centre changes.
--   every row       a copy of its revision's routing step (W2b-2: the parallel group too), or of its library operation
--                   when it was added, at a work centre of the site of the right kind, with a place from 1.
CREATE OR REPLACE FUNCTION "factory_work_order_operation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  state text;
  part_of uuid;
  step record;
  library record;
  company uuid;
  centre_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."workOrderId" <> OLD."workOrderId" THEN
      RAISE EXCEPTION 'production: work order operation % never moves to another work order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF current_user = 'factory_floor_runtime' THEN
    -- W2b-2: a floor session only adds an unplanned operation (its grant is INSERT), and holds no UPDATE right to lock the
    -- work order FOR SHARE: the work order's issue lock in SHARED mode instead (a status move takes it, as for a scan).
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(concat_ws('|', 'factory.work-order-issue', NEW."tenantId"::text, NEW."workOrderId"::text), 0));
    part_of := NEW."workOrderId";
    SELECT w."status"::text, w."companyId" INTO state, company FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
    IF NOT FOUND THEN
      -- Outside this session's scope: the policies refuse the row.
      RETURN NEW;
    END IF;
    IF NEW."routingSeq" IS NOT NULL THEN
      RAISE EXCEPTION 'production: a floor session adds only an unplanned operation to work order %; the routing''s operations are the office''s', NEW."workOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    part_of := NEW."workOrderId";
    SELECT w."status"::text, w."companyId" INTO state, company FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId" FOR SHARE;
  ELSE
    part_of := OLD."workOrderId";
    SELECT w."status"::text, w."companyId" INTO state, company FROM "WorkOrder" w WHERE w."tenantId" = OLD."tenantId" AND w."id" = OLD."workOrderId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT'
     -- W2b-2 (MES-086): the one row added after DRAFT.
     AND NOT (TG_OP = 'INSERT' AND NEW."routingSeq" IS NULL AND state IN ('RELEASED', 'IN_PROGRESS'))
     AND (TG_OP <> 'UPDATE'
          OR (to_jsonb(NEW) - (kept || ARRAY['workCentreId', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['workCentreId', 'version', 'updatedAt']))) THEN
    RAISE EXCEPTION 'production: work order % is %; its operations are frozen (MES-005), only their work centre changes (another of the same kind)', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'production: work order operation % has a place from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-2 (MES-086): an unplanned operation is a copy of its operation of the library, when it was added (a later edit of
  -- the library leaves it), with why, at a work centre of the operation's kind.
  IF NEW."routingSeq" IS NULL THEN
    IF NEW."operationId" IS NULL OR NEW."unplannedReason" IS NULL OR NEW."unplannedReason" !~ '^\S+$' OR NEW."parallelGroup" IS NOT NULL THEN
      RAISE EXCEPTION 'production: work order operation % has no routing step: an unplanned operation names its operation of the library and why (a code, no spaces), in no parallel group', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF state = 'DRAFT' THEN
      RAISE EXCEPTION 'production: work order % is DRAFT; an unplanned operation is added once it is RELEASED or IN_PROGRESS (a draft follows its routing)', NEW."workOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT op."code", op."name", op."standardMinutes", op."workCentreKind"::text AS kind, op."status"::text AS status, op."companyId" INTO library
      FROM "Operation" op WHERE op."tenantId" = NEW."tenantId" AND op."id" = NEW."operationId";
    IF FOUND THEN
      IF TG_OP = 'INSERT' AND (library.status <> 'ACTIVE' OR library."companyId" <> company) THEN
        RAISE EXCEPTION 'production: work order operation % takes an active operation of the library of its company', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP = 'INSERT' AND (library."code", library."name", library."standardMinutes") IS DISTINCT FROM (NEW."code", NEW."name", NEW."standardMinutes") THEN
        RAISE EXCEPTION 'production: unplanned operation % is a copy of operation % of the library (code, name, standard minutes)', NEW."id", NEW."operationId"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT wc."kind"::text INTO centre_kind FROM "WorkCentre" wc WHERE wc."tenantId" = NEW."tenantId" AND wc."siteId" = NEW."siteId" AND wc."id" = NEW."workCentreId";
      IF FOUND AND centre_kind <> library.kind THEN
        RAISE EXCEPTION 'production: work order operation % runs at a work centre of kind % (its operation''s), not %', NEW."id", library.kind, centre_kind
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."operationId" IS NOT NULL OR NEW."unplannedReason" IS NOT NULL THEN
    RAISE EXCEPTION 'production: work order operation % is routing step %; only an unplanned operation names a library operation and a reason', NEW."id", NEW."routingSeq"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT ro."code", ro."name", ro."standardMinutes", ro."scanRequired", ro."parallelGroup", ro."workCentreKind"::text AS kind INTO step
    FROM "RoutingOperation" ro WHERE ro."tenantId" = NEW."tenantId" AND ro."revisionId" = NEW."styleRevisionId" AND ro."seq" = NEW."routingSeq";
  IF FOUND THEN
    -- The frozen copy of the parallel group is filled here, so a work order made from the routing needs no new column.
    NEW."parallelGroup" := coalesce(NEW."parallelGroup", step."parallelGroup");
    IF (step."code", step."name", step."standardMinutes", step."scanRequired", step."parallelGroup") IS DISTINCT FROM (NEW."code", NEW."name", NEW."standardMinutes", NEW."scanRequired", NEW."parallelGroup") THEN
      RAISE EXCEPTION 'production: work order operation % is a copy of routing step % of revision % (code, name, standard minutes, scan required, parallel group)', NEW."id", NEW."routingSeq", NEW."styleRevisionId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT wc."kind"::text INTO centre_kind FROM "WorkCentre" wc WHERE wc."tenantId" = NEW."tenantId" AND wc."siteId" = NEW."siteId" AND wc."id" = NEW."workCentreId";
    IF FOUND AND centre_kind <> step.kind THEN
      RAISE EXCEPTION 'production: work order operation % runs at a work centre of kind % (its routing step''s), not %', NEW."id", step.kind, centre_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- RoutingOperation: a parallel group is a number from 1 (MES-025). Own trigger: the revision's part guard is shared.
CREATE FUNCTION "factory_routing_parallel_group_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."parallelGroup" < 1 THEN
    RAISE EXCEPTION 'product: routing step % names its parallel group by a number from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RoutingOperation_parallel_group" BEFORE INSERT OR UPDATE OF "parallelGroup" ON "RoutingOperation"
  FOR EACH ROW EXECUTE FUNCTION "factory_routing_parallel_group_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- ScanCorrectionRequest (…_production_scan_records_guards), whole: the four-eyes check of a floor session (W2b-2).
CREATE OR REPLACE FUNCTION "factory_scan_correction_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  deciding CONSTANT text[] := ARRAY['status', 'decidedById', 'decidedAt', 'decisionNote', 'correctionScanId', 'version', 'updatedAt'];
  order_state text;
  garments integer;
  target record;
  answer record;
  scan_worker uuid;
  scan_creator uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: correction request % is decided, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' OR NEW."decidedById" IS NOT NULL OR NEW."decidedAt" IS NOT NULL OR NEW."decisionNote" IS NOT NULL OR NEW."correctionScanId" IS NOT NULL THEN
      RAISE EXCEPTION 'production: correction request % is asked PENDING, undecided', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF btrim(NEW."reason") = '' OR btrim(NEW."clientRequestId") = '' THEN
      RAISE EXCEPTION 'production: correction request % says why and carries the device''s id for it', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF NOT FOUND THEN
      -- Outside this session's scope: the policies refuse the row.
      RETURN NEW;
    END IF;
    IF order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
      RAISE EXCEPTION 'production: work order % is %; its scans are corrected only while it is RELEASED or IN_PROGRESS', NEW."workOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT b."quantity" INTO garments FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."id" = NEW."bundleId";
    IF NEW."goodQuantity" < 0 OR NEW."scrapQuantity" < 0 OR NEW."reworkQuantity" < 0
       OR NEW."goodQuantity" + NEW."scrapQuantity" + NEW."reworkQuantity" NOT BETWEEN 1 AND coalesce(garments, 0) THEN
      RAISE EXCEPTION 'production: correction request % asks from 1 to the % garment(s) of bundle % (good, scrap and rework together)', NEW."id", garments, NEW."bundleId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT s."kind"::text AS kind, s."bundleId", s."workOrderOperationId" INTO target
      FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."scanId";
    IF target.kind NOT IN ('REPORT', 'CORRECTION')
       OR (target."bundleId", target."workOrderOperationId") IS DISTINCT FROM (NEW."bundleId", NEW."workOrderOperationId") THEN
      RAISE EXCEPTION 'production: correction request % names a report or correction of its own bundle and operation', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "OperationScan" v WHERE v."tenantId" = NEW."tenantId" AND v."siteId" = NEW."siteId" AND v."correctsId" = NEW."scanId") THEN
      RAISE EXCEPTION 'production: scan % is undone or corrected already; ask a correction of the scan that stands', NEW."scanId"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_production_check_subject"(NEW."tenantId", NEW."siteId", NEW."askedById", NEW."stationId", 'correction request', NEW."id");
    RETURN NEW;
  END IF;

  -- UPDATE: a write that changes nothing (beyond the policy keys) passes; otherwise only the decision, once.
  IF (to_jsonb(NEW) - kept) IS NOT DISTINCT FROM (to_jsonb(OLD) - kept) THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - (kept || deciding)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || deciding)) THEN
    RAISE EXCEPTION 'production: correction request % changes only by its decision', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'production: correction request % is % already; a decision is final', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'PENDING' OR NEW."decidedById" IS NULL OR NEW."decidedAt" IS NULL THEN
    RAISE EXCEPTION 'production: correction request % is decided APPROVED or REFUSED, with who decided it and when', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'REFUSED' AND (btrim(coalesce(NEW."decisionNote", '')) = '' OR NEW."correctionScanId" IS NOT NULL) THEN
    RAISE EXCEPTION 'production: a refusal of correction request % says why and writes no correction', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'APPROVED' THEN
    SELECT s."kind"::text AS kind, s."correctsId" INTO answer
      FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."correctionScanId";
    IF NEW."correctionScanId" IS NULL OR answer.kind IS DISTINCT FROM 'CORRECTION' OR answer."correctsId" IS DISTINCT FROM NEW."scanId" THEN
      RAISE EXCEPTION 'production: correction request % is approved with the CORRECTION scan that voids scan %', OLD."id", NEW."scanId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Four eyes (MES-096): not the scan's worker or creator, not the asker, not the office account of either worker.
  SELECT s."workerId", s."createdById" INTO scan_worker, scan_creator
    FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."scanId";
  IF NEW."decidedById" IN (scan_worker, scan_creator, NEW."askedById", NEW."createdById") THEN
    RAISE EXCEPTION 'production: correction request % is decided by another person than the one who took the scan or asked (four eyes)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-2: a team leader on the floor decides too (decidedById: the worker). A floor session reads no Worker.userId (the
  -- column is hidden from it, and a statement naming it is refused whatever it finds): the office answers for that link
  -- here, B-W2b-83's route for the floor (it reads the link in the tenant's system scope, as involvedOf does).
  IF current_user <> 'factory_floor_runtime' THEN
    IF EXISTS (SELECT 1 FROM "Worker" k WHERE k."tenantId" = NEW."tenantId" AND k."id" IN (scan_worker, NEW."askedById") AND k."userId" = NEW."decidedById") THEN
      RAISE EXCEPTION 'production: correction request % is decided by another person than the one who took the scan or asked (four eyes)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- ScrapApproval (MES-128)
--   INSERT     of a floor REPORT (from a tablet, not an outside operation's) of its own site, whose scrap is above the
--              limit (a limit from 1), with its key. WAITING, or already decided: the audit rows' decisions moved here.
--   UPDATE     an UPDATE that changes nothing passes; only the decision changes, once, from WAITING, and not after the scan
--              was voided (it waits for nothing).
--   every row  decided exactly when APPROVED or REFUSED: where, when and who; REFUSED with its reason tile (no spaces),
--              and no reason otherwise; never decided by who took the scan (its worker, the account that wrote it and,
--              in the office, the office user that worker is; four eyes); a floor session decides as FLOOR.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_scrap_approval_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  deciding CONSTANT text[] := ARRAY['status', 'decidedOn', 'decidedAt', 'decidedById', 'reasonCode', 'note', 'version', 'updatedAt'];
  scan record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: scrap approval % is decided, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - kept) IS NOT DISTINCT FROM (to_jsonb(OLD) - kept) THEN
    RETURN NEW;
  END IF;
  IF NOT "factory_floor_work_visible"(NEW."tenantId", NEW."siteId") THEN
    RETURN NEW;
  END IF;
  SELECT s."kind"::text AS kind, s."deviceId", s."subcontractReceiptLineId", s."scrapQuantity", s."workerId", s."createdById" INTO scan
    FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."scanId";

  IF TG_OP = 'INSERT' THEN
    IF NEW."limitPieces" < 1 OR position(('scrap:' || NEW."scanId"::text) IN NEW."key") <> 1 THEN
      RAISE EXCEPTION 'production: scrap approval % keeps the limit in force, from 1 piece, and the key scrap:<scan> (one per scan)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND (scan.kind <> 'REPORT' OR scan."deviceId" IS NULL OR scan."subcontractReceiptLineId" IS NOT NULL OR scan."scrapQuantity" <= NEW."limitPieces") THEN
      RAISE EXCEPTION 'production: scrap approval % is of a floor report whose scrap (% piece(s)) is above the limit of %', NEW."id", scan."scrapQuantity", NEW."limitPieces"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - (kept || deciding)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || deciding)) THEN
      RAISE EXCEPTION 'production: scrap approval % changes only by its decision', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'WAITING' THEN
      RAISE EXCEPTION 'production: scrap approval % is % already; a decision is final', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "OperationScan" v WHERE v."tenantId" = NEW."tenantId" AND v."siteId" = NEW."siteId" AND v."correctsId" = NEW."scanId") THEN
      RAISE EXCEPTION 'production: scan % was undone or corrected since; its scrap waits for nothing', NEW."scanId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."status" = 'WAITING' AND (NEW."decidedOn" IS NOT NULL OR NEW."decidedAt" IS NOT NULL OR NEW."decidedById" IS NOT NULL OR NEW."note" IS NOT NULL))
     OR (NEW."status" <> 'WAITING' AND (NEW."decidedOn" IS NULL OR NEW."decidedAt" IS NULL OR NEW."decidedById" IS NULL))
     OR (NEW."status" = 'REFUSED') <> (NEW."reasonCode" IS NOT NULL) OR NEW."reasonCode" !~ '^\S+$' OR btrim(NEW."note") = '' THEN
    RAISE EXCEPTION 'production: scrap approval % is % with the wrong columns: decided exactly when APPROVED or REFUSED (where, when, who), a refusal with its reason (a code, no spaces)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> 'WAITING' THEN
    IF current_user = 'factory_floor_runtime' AND NEW."decidedOn" <> 'FLOOR' THEN
      RAISE EXCEPTION 'production: scrap approval % is decided on the floor; a floor session writes no office decision', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."decidedById" IN (scan."workerId", scan."createdById") THEN
      RAISE EXCEPTION 'production: the scrap of scan % is decided by another person than the one who took it (four eyes)', NEW."scanId"
        USING ERRCODE = 'check_violation';
    END IF;
    -- Its own statement: a floor session may not name Worker.userId at all (hidden from it), whatever the row.
    IF current_user <> 'factory_floor_runtime' THEN
      IF EXISTS (SELECT 1 FROM "Worker" k WHERE k."tenantId" = NEW."tenantId" AND k."id" = scan."workerId" AND k."userId" = NEW."decidedById") THEN
        RAISE EXCEPTION 'production: the scrap of scan % is decided by another person than the one who took it (four eyes)', NEW."scanId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ScrapApproval_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ScrapApproval"
  FOR EACH ROW EXECUTE FUNCTION "factory_scrap_approval_guard"();
CREATE TRIGGER "ScrapApproval_no_truncate" BEFORE TRUNCATE ON "ScrapApproval"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_floor_work_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- OffStandardEntry: the work order it names. A block typed afterwards may name a finished work order; not one still DRAFT
-- or CANCELLED. Own trigger: the block's guard stays as it is. A change of it after the block ended is a fact like the
-- others (the deferred trigger is recreated with it; its function is unchanged).
CREATE FUNCTION "factory_off_standard_work_order_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
BEGIN
  IF NEW."workOrderId" IS NULL OR (TG_OP = 'UPDATE' AND NEW."workOrderId" IS NOT DISTINCT FROM OLD."workOrderId") THEN
    RETURN NEW;
  END IF;
  SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF order_state IN ('DRAFT', 'CANCELLED') THEN
    RAISE EXCEPTION 'floor work: off-standard block % names work order %, which is %', NEW."id", NEW."workOrderId", order_state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OffStandardEntry_work_order" BEFORE INSERT OR UPDATE OF "workOrderId" ON "OffStandardEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_off_standard_work_order_check"();

DROP TRIGGER "OffStandardEntry_edit_recorded" ON "OffStandardEntry";
CREATE CONSTRAINT TRIGGER "OffStandardEntry_edit_recorded" AFTER UPDATE ON "OffStandardEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."endedAt" IS NOT NULL
        AND ((NEW."lineId", NEW."stationId", NEW."workerId", NEW."employeeId", NEW."codeId", NEW."workDate", NEW."startedAt", NEW."endedAt", NEW."workOrderId")
             IS DISTINCT FROM (OLD."lineId", OLD."stationId", OLD."workerId", OLD."employeeId", OLD."codeId", OLD."workDate", OLD."startedAt", OLD."endedAt", OLD."workOrderId")
             OR (OLD."status" IN ('APPROVED', 'REJECTED') AND NEW."status" = 'PENDING')))
  EXECUTE FUNCTION "factory_off_standard_entry_edit_recorded"();

-- ---------------------------------------------------------------------------------------------------------------------
-- HelpCall: what a material call asks (MES-137). Told when it is sent, or added as a detail while the call is open, then
-- set once. A quantity only on a MATERIAL call. Own trigger: the call's guard stays as it is.
CREATE FUNCTION "factory_help_call_request_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  call_kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."reasonCode", NEW."requestedQuantity") IS NOT DISTINCT FROM (OLD."reasonCode", OLD."requestedQuantity") THEN
    RETURN NEW;
  END IF;
  IF NEW."reasonCode" !~ '^\S+$' OR NEW."requestedQuantity" <= 0 THEN
    RAISE EXCEPTION 'andon: help call % names its reason by a code, no spaces, and asks a quantity above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (OLD."reasonCode" IS NOT NULL AND NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode")
       OR (OLD."requestedQuantity" IS NOT NULL AND NEW."requestedQuantity" IS DISTINCT FROM OLD."requestedQuantity") THEN
      RAISE EXCEPTION 'andon: the reason and quantity of help call % are set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status"::text IN ('SOLVED', 'CANCELLED') THEN
      RAISE EXCEPTION 'andon: help call % is %; details are added while it is open', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."requestedQuantity" IS NOT NULL THEN
    SELECT t."kind"::text INTO call_kind FROM "HelpCallType" t WHERE t."tenantId" = NEW."tenantId" AND t."siteId" = NEW."siteId" AND t."id" = NEW."typeId";
    IF call_kind <> 'MATERIAL' THEN
      RAISE EXCEPTION 'andon: help call % is a % call; only a material call asks a quantity', NEW."id", call_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "HelpCall_request" BEFORE INSERT OR UPDATE OF "reasonCode", "requestedQuantity" ON "HelpCall"
  FOR EACH ROW EXECUTE FUNCTION "factory_help_call_request_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- EarningsEntry: a scan of an unplanned operation pays a rate of that operation. The pay check compares a rate's operation
-- with the routing step's, which an unplanned operation has none of. Own trigger: its body is the pay steps' to redefine.
CREATE FUNCTION "factory_earnings_entry_unplanned_rate"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unplanned uuid;
  rate_operation uuid;
BEGIN
  SELECT o."operationId" INTO unplanned
    FROM "OperationScan" s JOIN "WorkOrderOperation" o ON o."tenantId" = s."tenantId" AND o."id" = s."workOrderOperationId"
   WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."operationScanId" AND o."routingSeq" IS NULL;
  IF unplanned IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT e."operationId" INTO rate_operation FROM "PieceRateEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."rateEntryId";
  IF rate_operation IS DISTINCT FROM unplanned THEN
    RAISE EXCEPTION 'pay: earnings entry % pays the rate of another operation than scan %', NEW."id", NEW."operationScanId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "EarningsEntry_unplanned_rate" BEFORE INSERT ON "EarningsEntry"
  FOR EACH ROW WHEN (NEW."operationScanId" IS NOT NULL AND NEW."rateEntryId" IS NOT NULL)
  EXECUTE FUNCTION "factory_earnings_entry_unplanned_rate"();
