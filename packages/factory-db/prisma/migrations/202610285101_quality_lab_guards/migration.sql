-- Written by hand (Prisma does not model triggers or partial indexes), after the generated 202610285100_quality_lab and
-- before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The lab step for incoming lots (B-W1-34; QHS-029, QHS-030, SCM-117; REACH Annex XVII entry 47: chromium VI in leather
-- "equal to or greater than 3 mg/kg" is prohibited; Owner question Q14). apps/factory-api's modules/quality/lab checks
-- all of this first, in words; these rules hold for every login, the owner included. The tenant and site of a row are
-- held by the policies and the references, not here. Every refusal is a check_violation (SQLSTATE 23514). A trigger
-- reads only tables the role that fires it may read (the office's).
--
-- LabResult (append-only: no login changes or removes a row; a mistake is a new result)
--   INSERT     a chromium VI result in mg/kg; exactly one of a measured value (from 0) and "below the detection limit"
--              with that limit (above 0); the limit is the lot's own Cr VI limit (a lot that needs the test); the verdict
--              is the value against that limit (below PASS, at or above FAIL), and "below the detection limit" is a PASS
--              only when that limit is at or below the lot's; a supplier report names its article and a period (from ≤
--              to), a lab report on the lot neither; the report is a CERTIFICATE file; it supersedes only a PASS of the
--              same lot (the reference holds the lot), and only as a FAIL.
-- LotDocument
--   INSERT     ACTIVE; its file is a CERTIFICATE file of its own lot; OTHER says what it is (a note).
--   UPDATE     an UPDATE that changes nothing passes; only the status moves, ACTIVE → ARCHIVED.
--   DELETE     refused (archived instead). TRUNCATE refused. (One ACTIVE document per lot and file is the API's rule,
--              under the lot's row lock.)
-- PpeRegisterEntry (redefines 202610285001_quality_ppe_register_guards' "factory_ppe_register_entry_guard"; the trigger
--   stays): its rules, with one more source type: a LabResult (a later chromium VI FAIL on a lot whose stock was issued
--   opens the register entry of the garments made from it).
-- QualitySettings
--   UPDATE     its id and company never change (the id is the company's, or the tenant's own for the tenant-wide row:
--              the API's key). DELETE and TRUNCATE refused.

CREATE FUNCTION "factory_quality_lab_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'quality lab: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- The append-only ledger of this step (plan A1 §2.1; scripts/factory/check-append-only.mjs): LabResult. The runtime roles
-- have no UPDATE, DELETE or TRUNCATE grant either (the policy migration).
CREATE FUNCTION "factory_refuse_lab_result_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a lab result is kept as it was written (a later finding is a new result)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "LabResult_append_only" BEFORE UPDATE OR DELETE ON "LabResult"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_lab_result_change"();
CREATE TRIGGER "LabResult_no_truncate" BEFORE TRUNCATE ON "LabResult"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_lab_result_change"();

CREATE FUNCTION "factory_lab_result_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lot_limit numeric;
  lot_needs_test boolean;
  file_kind text;
  earlier_verdict text;
BEGIN
  IF NEW."test" <> 'CR_VI' OR NEW."unit" <> 'mg/kg' OR NEW."method" NOT IN ('EN ISO 17075-1', 'EN ISO 17075-2') THEN
    RAISE EXCEPTION 'quality lab: lab result % is a chromium VI result in mg/kg, by EN ISO 17075-1 or -2', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."belowDetectionLimit" <> (NEW."valueMgKg" IS NULL)
     OR NEW."belowDetectionLimit" <> (NEW."detectionLimitMgKg" IS NOT NULL)
     OR NEW."valueMgKg" < 0 OR NEW."detectionLimitMgKg" <= 0 THEN
    RAISE EXCEPTION 'quality lab: lab result % has a measured value (from 0) or is below a detection limit (above 0), exactly one of them', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."crViLimitMgKg", l."requiresCrViTest" INTO lot_limit, lot_needs_test
    FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."lotId";
  IF FOUND AND (NOT lot_needs_test OR lot_limit IS DISTINCT FROM NEW."limitMgKg") THEN
    RAISE EXCEPTION 'quality lab: lab result % is judged against its lot''s own chromium VI limit (% mg/kg), on a lot that needs the test', NEW."id", lot_limit
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."valueMgKg" IS NOT NULL AND NEW."verdict"::text <> CASE WHEN NEW."valueMgKg" < NEW."limitMgKg" THEN 'PASS' ELSE 'FAIL' END)
     OR (NEW."belowDetectionLimit" AND (NEW."verdict" <> 'PASS' OR NEW."detectionLimitMgKg" > NEW."limitMgKg")) THEN
    RAISE EXCEPTION 'quality lab: lab result % is the value against the limit of % mg/kg (below PASS, at or above FAIL; below a detection limit only at or below the limit)', NEW."id", NEW."limitMgKg"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."evidence" = 'SUPPLIER_REPORT' AND (coalesce(btrim(NEW."article"), '') = '' OR NEW."periodFrom" IS NULL OR NEW."periodTo" IS NULL OR NEW."periodFrom" > NEW."periodTo"))
     OR (NEW."evidence" = 'LOT_REPORT' AND (NEW."article" IS NOT NULL OR NEW."periodFrom" IS NOT NULL OR NEW."periodTo" IS NOT NULL)) THEN
    RAISE EXCEPTION 'quality lab: lab result % names the article and the period of a supplier report, and none for a lab report on the lot', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT f."kind"::text INTO file_kind FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF FOUND AND file_kind <> 'CERTIFICATE' THEN
    RAISE EXCEPTION 'quality lab: the report of lab result % is a CERTIFICATE file, not %', NEW."id", file_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supersedesId" IS NOT NULL THEN
    SELECT r."verdict"::text INTO earlier_verdict FROM "LabResult" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."supersedesId";
    IF NEW."verdict" <> 'FAIL' OR earlier_verdict IS DISTINCT FROM 'PASS' THEN
      RAISE EXCEPTION 'quality lab: lab result % supersedes a PASS of its lot, and only as a FAIL on later evidence', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LabResult_guard" BEFORE INSERT ON "LabResult"
  FOR EACH ROW EXECUTE FUNCTION "factory_lab_result_guard"();

CREATE FUNCTION "factory_lot_document_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'status', 'version', 'updatedAt'];
  file_kind text;
  file_type text;
  file_record uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality lab: lot document % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'quality lab: lot document % starts ACTIVE', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT f."kind"::text, f."recordType", f."recordId" INTO file_kind, file_type, file_record
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
    IF FOUND AND (file_kind <> 'CERTIFICATE' OR file_type <> 'Lot' OR file_record <> NEW."lotId") THEN
      RAISE EXCEPTION 'quality lab: the file of lot document % is a CERTIFICATE file of its own lot', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'OTHER' AND coalesce(btrim(NEW."note"), '') = '' THEN
      RAISE EXCEPTION 'quality lab: lot document % of kind OTHER says what it is (a note)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
    RAISE EXCEPTION 'quality lab: lot document % never changes but its status', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (OLD."status" = 'ACTIVE' AND NEW."status" = 'ARCHIVED') THEN
    RAISE EXCEPTION 'quality lab: lot document % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LotDocument_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LotDocument"
  FOR EACH ROW EXECUTE FUNCTION "factory_lot_document_guard"();
CREATE TRIGGER "LotDocument_no_truncate" BEFORE TRUNCATE ON "LotDocument"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_quality_lab_refuse_truncate"();

CREATE FUNCTION "factory_quality_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality lab: the quality settings % are changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."id", NEW."companyId") IS DISTINCT FROM (OLD."id", OLD."companyId") THEN
    RAISE EXCEPTION 'quality lab: the id and company of the quality settings % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QualitySettings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "QualitySettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_quality_settings_guard"();
CREATE TRIGGER "QualitySettings_no_truncate" BEFORE TRUNCATE ON "QualitySettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_quality_lab_refuse_truncate"();

CREATE OR REPLACE FUNCTION "factory_ppe_register_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  wanted integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: PPE register entry % is kept (closed), never deleted (Reg. 2016/425 art. 8(4))', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'quality: PPE register entry % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."reference", NEW."kind", NEW."reportedAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."reference", OLD."kind", OLD."reportedAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, reference, kind, report time and creation of PPE register entry % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: PPE register entry % is CLOSED; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."reference") = '' OR btrim(NEW."description") = '' THEN
    RAISE EXCEPTION 'quality: PPE register entry % has a reference and a description', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."status" = 'CLOSED') <> (NEW."closedById" IS NOT NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closeReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: PPE register entry % is % with the wrong closing: a closed entry has its time, who closed it and why', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The source, the authority's reference, the corrective action done.
  IF (NEW."sourceType" IS NULL) <> (NEW."sourceId" IS NULL)
     OR (NEW."sourceType" IS NOT NULL AND NEW."sourceType" NOT IN ('QualityReleaseReversal', 'QualityRelease', 'Inspection', 'Shipment', 'LabResult')) THEN
    RAISE EXCEPTION 'quality: PPE register entry % names its source as a known record type and an id, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."authorityReference" IS NOT NULL AND NEW."authorityNotifiedAt" IS NULL THEN
    RAISE EXCEPTION 'quality: PPE register entry % has an authority reference without the date the authority was told', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."actionCompletedAt" IS NOT NULL AND btrim(coalesce(NEW."actionTaken", '')) = '' THEN
    RAISE EXCEPTION 'quality: PPE register entry % marks a corrective action done without the action', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The id lists: rows of the entry's tenant and company (work orders also of its style).
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."lotIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."companyId" = NEW."companyId" AND l."id" = ANY(NEW."lotIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a material lot that is not of its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."workOrderIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."companyId" = NEW."companyId" AND w."styleId" = NEW."styleId" AND w."id" = ANY(NEW."workOrderIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a work order that is not of its company and style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."shipmentIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "Shipment" s WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId" AND s."id" = ANY(NEW."shipmentIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a shipment that is not of its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- OPEN → CLOSED: its duties met.
  IF TG_OP = 'UPDATE' AND OLD."status" = 'OPEN' AND NEW."status" = 'CLOSED' THEN
    IF btrim(NEW."closeReason") = '' THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes with a reason', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."risk" = 'ASSESSING' THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes once its risk is decided (yes or no)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF btrim(coalesce(NEW."actionTaken", '')) = '' OR NEW."actionCompletedAt" IS NULL THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes once its corrective action is written and done (Reg. 2016/425 art. 8(8))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."risk" = 'YES' AND (NEW."authorityNotifiedAt" IS NULL OR btrim(coalesce(NEW."authorityReference", '')) = '') THEN
      RAISE EXCEPTION 'quality: PPE register entry % may present a risk: it closes once the authorities were told, with the date and their reference (Reg. 2016/425 art. 8(8))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."distributorsInformedAt" IS NULL AND EXISTS (
      SELECT 1
      FROM "ShipmentLine" sl
      JOIN "Shipment" s ON s."tenantId" = sl."tenantId" AND s."id" = sl."shipmentId"
      JOIN "WorkOrder" w ON w."tenantId" = sl."tenantId" AND w."id" = sl."workOrderId"
      WHERE sl."tenantId" = NEW."tenantId"
        AND s."companyId" = NEW."companyId"
        AND s."status" IN ('SHIPPED', 'DELIVERED')
        AND w."companyId" = NEW."companyId"
        AND w."styleId" = NEW."styleId"
        AND (
          w."id" = ANY(coalesce(NEW."workOrderIds", '{}'::uuid[]))
          OR w."batchNumber" = ANY(coalesce(NEW."batchNumbers", '{}'::text[]))
          OR s."id" = ANY(coalesce(NEW."shipmentIds", '{}'::uuid[]))
          OR EXISTS (
            SELECT 1 FROM "StockMove" m
            WHERE m."tenantId" = NEW."tenantId" AND m."companyId" = NEW."companyId" AND m."workOrderId" = w."id"
              AND m."lotId" = ANY(coalesce(NEW."lotIds", '{}'::uuid[])) AND m."reason" = 'ISSUE' AND m."reversalOfId" IS NULL
              AND NOT EXISTS (SELECT 1 FROM "StockMove" r WHERE r."tenantId" = m."tenantId" AND r."siteId" = m."siteId" AND r."reversalOfId" = m."id")
          )
          OR EXISTS (
            SELECT 1 FROM "GarmentSerial" g
            WHERE g."tenantId" = sl."tenantId" AND g."shipmentLineId" = sl."id" AND g."serial" = ANY(coalesce(NEW."serials", '{}'::text[]))
          )
        )
    ) THEN
      RAISE EXCEPTION 'quality: garments PPE register entry % concerns left for customers: it closes once the distributors were informed (Reg. 2016/425 art. 8(4))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
