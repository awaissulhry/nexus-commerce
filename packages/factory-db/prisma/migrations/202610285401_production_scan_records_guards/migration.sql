-- Production › scan records (B-W1-42; MES-069, MES-090, MES-095, MES-096; A1 §2.1 "Append-only", §3.8; PLAN risk 17):
-- the hand-written rules of the tables 202610285400_production_scan_records made, for every login (the owner included).
-- The API answers each refusal first, in words (apps/factory-api modules/production/scans); these are the last word.
--
--   ScrapReason             a code and its kind never change (scans and their lines keep the code); a reason is never
--                           deleted (set inactive).
--   OperationScanDefect     append-only; a line names exactly one of a scan or a correction request, an ACTIVE reason
--                           of its kind, and from 1 garment up to its owner's count of that kind. The API writes a scan's
--                           counts from its lines (factory-domain production/scans normaliseDefects), so they add up; the
--                           database does not hold the sum (the generated isolation tests insert a copy of a line).
--   ScanCorrectionRequest   asked PENDING for a work order that is RELEASED or IN_PROGRESS, of a standing REPORT or
--                           CORRECTION of the same bundle and operation, with counts from 1 to the bundle's garments and
--                           a reason; it names its asker only by the site's floor rules (factory_production_check_subject:
--                           the signed-in worker who acknowledged the notice in force, or only the station); decided once:
--                           APPROVED with the CORRECTION scan that voids its scan, or REFUSED with a note; never by the
--                           scan's worker or creator, the asker, or the office account either of those workers is
--                           (four eyes, MES-096); otherwise it never changes and is never deleted.
--   FloorScanRefusal        kept open; what the device sent never changes; discarded once; resolved once, by a scan of the
--                           same device and client scan id (or a correction request of that client id); never deleted.
-- The tenant and site columns are left to the policies: a row moved out of its scope is refused by row-level security.

CREATE FUNCTION "factory_scan_records_refuse_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'production: % on "%" is refused; % rows are never removed', TG_OP, TG_TABLE_NAME, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- ScrapReason
CREATE FUNCTION "factory_scrap_reason_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: scrap reason % % is set inactive, never deleted (scans keep its code)', OLD."kind", OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."code") = '' OR btrim(NEW."labelIt") = '' OR btrim(NEW."labelEn") = '' THEN
    RAISE EXCEPTION 'production: scrap reason % has a code and its Italian and English labels', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."kind", NEW."code") IS DISTINCT FROM (OLD."kind", OLD."code") THEN
    RAISE EXCEPTION 'production: scrap reason % % keeps its kind and code (scans keep them); add a new reason instead', OLD."kind", OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ScrapReason_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ScrapReason"
  FOR EACH ROW EXECUTE FUNCTION "factory_scrap_reason_guard"();
CREATE TRIGGER "ScrapReason_no_truncate" BEFORE TRUNCATE ON "ScrapReason"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_scan_records_refuse_delete"();

-- ---------------------------------------------------------------------------------------------------------------------
-- OperationScanDefect: append-only (scripts/factory/check-append-only.mjs), and its INSERT rules.
CREATE TRIGGER "OperationScanDefect_append_only" BEFORE UPDATE OR DELETE ON "OperationScanDefect"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "OperationScanDefect_no_truncate" BEFORE TRUNCATE ON "OperationScanDefect"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_production_ledger_change"();

CREATE FUNCTION "factory_operation_scan_defect_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  counted integer;
  reason_active boolean;
BEGIN
  IF (NEW."scanId" IS NULL) = (NEW."correctionRequestId" IS NULL) THEN
    RAISE EXCEPTION 'production: scan line % belongs to exactly one scan or one correction request', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."quantity" < 1 THEN
    RAISE EXCEPTION 'production: scan line % counts at least one garment', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r."active" INTO reason_active FROM "ScrapReason" r WHERE r."tenantId" = NEW."tenantId" AND r."kind" = NEW."kind" AND r."code" = NEW."reasonCode";
  IF FOUND AND NOT reason_active THEN
    RAISE EXCEPTION 'production: % reason % is not in use any more; pick an active one', NEW."kind", NEW."reasonCode"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."scanId" IS NOT NULL THEN
    SELECT CASE WHEN NEW."kind" = 'SCRAP' THEN s."scrapQuantity" ELSE s."reworkQuantity" END INTO counted
      FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."scanId";
  ELSE
    SELECT CASE WHEN NEW."kind" = 'SCRAP' THEN q."scrapQuantity" ELSE q."reworkQuantity" END INTO counted
      FROM "ScanCorrectionRequest" q WHERE q."tenantId" = NEW."tenantId" AND q."siteId" = NEW."siteId" AND q."id" = NEW."correctionRequestId";
  END IF;
  -- Outside this session's scope the policies refuse the row.
  IF FOUND AND NEW."quantity" > counted THEN
    RAISE EXCEPTION 'production: scan line % counts % % garment(s); its scan or request counts %', NEW."id", NEW."quantity", NEW."kind", counted
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OperationScanDefect_check" BEFORE INSERT ON "OperationScanDefect"
  FOR EACH ROW EXECUTE FUNCTION "factory_operation_scan_defect_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- ScanCorrectionRequest
CREATE FUNCTION "factory_scan_correction_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW."decidedById" IN (scan_worker, scan_creator, NEW."askedById", NEW."createdById")
     OR EXISTS (SELECT 1 FROM "Worker" k WHERE k."tenantId" = NEW."tenantId" AND k."id" IN (scan_worker, NEW."askedById") AND k."userId" = NEW."decidedById") THEN
    RAISE EXCEPTION 'production: correction request % is decided by another person than the one who took the scan or asked (four eyes)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ScanCorrectionRequest_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ScanCorrectionRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_scan_correction_request_guard"();
CREATE TRIGGER "ScanCorrectionRequest_no_truncate" BEFORE TRUNCATE ON "ScanCorrectionRequest"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_scan_records_refuse_delete"();

-- ---------------------------------------------------------------------------------------------------------------------
-- FloorScanRefusal
CREATE FUNCTION "factory_floor_scan_refusal_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  closing CONSTANT text[] := ARRAY['discardedAt', 'discardedById', 'resolvedByScanId', 'resolvedByRequestId', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: refused scan % is discarded, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."discardedAt" IS NOT NULL OR NEW."discardedById" IS NOT NULL OR NEW."resolvedByScanId" IS NOT NULL OR NEW."resolvedByRequestId" IS NOT NULL THEN
      RAISE EXCEPTION 'production: refused scan % is kept open', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF btrim(NEW."clientScanId") = '' OR btrim(NEW."code") = '' OR btrim(NEW."message") = '' OR btrim(NEW."fix") = '' THEN
      RAISE EXCEPTION 'production: refused scan % keeps the device''s id for it, its code, its words and its fix', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."goodQuantity" < 0 OR NEW."scrapQuantity" < 0 OR NEW."reworkQuantity" < 0 THEN
      RAISE EXCEPTION 'production: refused scan % keeps counts from 0', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - kept) IS NOT DISTINCT FROM (to_jsonb(OLD) - kept) THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - (kept || closing)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || closing)) THEN
    RAISE EXCEPTION 'production: refused scan % keeps what the device sent; it is only discarded or resolved', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."discardedAt" IS NOT NULL AND (NEW."discardedAt", NEW."discardedById") IS DISTINCT FROM (OLD."discardedAt", OLD."discardedById"))
     OR (OLD."resolvedByScanId" IS NOT NULL AND NEW."resolvedByScanId" IS DISTINCT FROM OLD."resolvedByScanId")
     OR (OLD."resolvedByRequestId" IS NOT NULL AND NEW."resolvedByRequestId" IS DISTINCT FROM OLD."resolvedByRequestId") THEN
    RAISE EXCEPTION 'production: refused scan % is discarded or resolved once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."discardedAt" IS NULL AND NEW."discardedById" IS NOT NULL THEN
    RAISE EXCEPTION 'production: refused scan % names who discarded it only with when', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."resolvedByScanId" IS DISTINCT FROM OLD."resolvedByScanId" AND NOT EXISTS (
       SELECT 1 FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."resolvedByScanId"
          AND s."deviceId" = NEW."deviceId" AND s."clientScanId" = NEW."clientScanId") THEN
    RAISE EXCEPTION 'production: refused scan % is resolved by the scan its device sent again under the same id', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."resolvedByRequestId" IS DISTINCT FROM OLD."resolvedByRequestId" AND NOT EXISTS (
       SELECT 1 FROM "ScanCorrectionRequest" q WHERE q."tenantId" = NEW."tenantId" AND q."siteId" = NEW."siteId" AND q."id" = NEW."resolvedByRequestId"
          AND q."deviceId" = NEW."deviceId" AND q."clientRequestId" = NEW."clientScanId") THEN
    RAISE EXCEPTION 'production: refused scan % is resolved by the correction request its device sent again under the same id', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "FloorScanRefusal_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FloorScanRefusal"
  FOR EACH ROW EXECUTE FUNCTION "factory_floor_scan_refusal_guard"();
CREATE TRIGGER "FloorScanRefusal_no_truncate" BEFORE TRUNCATE ON "FloorScanRefusal"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_scan_records_refuse_delete"();
