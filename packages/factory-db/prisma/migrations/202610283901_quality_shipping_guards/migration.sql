-- Written by hand (Prisma does not model triggers or deferred constraint triggers), after the generated
-- 202610283900_quality_shipping and before the policy migration. When the migrations are renumbered, keep this file as
-- it is under its new timestamp.

-- Quality and shipping (plan A1 §2.1 "Append-only", "Issued documents", §2.5 "Final release", "Shipment"; PLAN §2.8
-- "PPE", "DDT", "Limits on monitoring workers", §4.7 stages 13a-labels, 13b-release, 14-ship; Q19, Q31; features
-- QHS-050, QHS-058, QHS-073, QHS-118, LOG-001, LOG-039, LOG-054, LOG-059, LOG-117; Reg. (EU) 2016/425 arts. 8, 15;
-- DPR 472/1996). apps/factory-api's modules check all of this first; these rules hold for every login, the owner
-- included. The tenant, site and party of a row are held by the policies (USING and WITH CHECK) and by the references,
-- not here: the triggers leave "tenantId", "siteId" and "partyId" to them. Every refusal is a check_violation
-- (SQLSTATE 23514): a restrict_violation reaches a Prisma model call as P2003 without its message. A rule that reads
-- another row skips a row this session cannot see (another tenant's or site's): the policies refuse that write anyway.
-- A trigger reads only tables (and columns) the role that fires it may read, and locks a row FOR SHARE only where that
-- role may update it.
--
-- "Everything but these columns" is compared as jsonb (to_jsonb(row) minus the named keys), so a column added later is
-- frozen too unless a later migration names it.

CREATE FUNCTION "factory_quality_shipping_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'quality and shipping: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- The append-only ledgers of this module (plan A1 §2.1; scripts/factory/check-append-only.mjs): QualityRelease, Ddt,
-- DdtCancellation, TrackingEvent. No login may change or remove a row, the owner and superusers included; the runtime
-- roles have no UPDATE, DELETE or TRUNCATE grant either (the policy migration). A mistake is a new row: a DDT is
-- cancelled by a DdtCancellation and replaced by a new DDT; a tracking event is followed by the next one.
CREATE FUNCTION "factory_refuse_quality_shipping_ledger_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a release, a DDT, its cancellation and a tracking event are kept as they were written', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "QualityRelease_append_only" BEFORE UPDATE OR DELETE ON "QualityRelease"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_quality_shipping_ledger_change"();
CREATE TRIGGER "QualityRelease_no_truncate" BEFORE TRUNCATE ON "QualityRelease"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_quality_shipping_ledger_change"();
CREATE TRIGGER "Ddt_append_only" BEFORE UPDATE OR DELETE ON "Ddt"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_quality_shipping_ledger_change"();
CREATE TRIGGER "Ddt_no_truncate" BEFORE TRUNCATE ON "Ddt"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_quality_shipping_ledger_change"();
CREATE TRIGGER "DdtCancellation_append_only" BEFORE UPDATE OR DELETE ON "DdtCancellation"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_quality_shipping_ledger_change"();
CREATE TRIGGER "DdtCancellation_no_truncate" BEFORE TRUNCATE ON "DdtCancellation"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_quality_shipping_ledger_change"();
CREATE TRIGGER "TrackingEvent_append_only" BEFORE UPDATE OR DELETE ON "TrackingEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_quality_shipping_ledger_change"();
CREATE TRIGGER "TrackingEvent_no_truncate" BEFORE TRUNCATE ON "TrackingEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_quality_shipping_ledger_change"();

-- =====================================================================================================================
-- Quality
-- =====================================================================================================================

-- Four-eyes (Reg. 2016/425; PLAN §2.8, Q19; A1 §2.5 "Final release": the inspector made none of the units, from the
-- floor's records). A worker made garments of a work order when a cut log of it (not a reversal) or a REPORT or
-- CORRECTION scan of it names the worker; an office user did when a worker linked to the user (Worker.userId, which
-- only the office reads) did. The floor's records name every maker unless a cut log or such a scan names none (the site
-- records the station, MES-278): then only the inspector's signed statement can say it.
CREATE FUNCTION "factory_quality_worker_made"(tenant uuid, work_order uuid, worker uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "CutLog" c
                  WHERE c."tenantId" = tenant AND c."workOrderId" = work_order AND c."workerId" = worker AND c."reversalOfId" IS NULL)
      OR EXISTS (SELECT 1 FROM "OperationScan" s
                  WHERE s."tenantId" = tenant AND s."workOrderId" = work_order AND s."workerId" = worker
                    AND s."kind" IN ('REPORT', 'CORRECTION'))
$$;

CREATE FUNCTION "factory_quality_makers_unnamed"(tenant uuid, work_order uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "CutLog" c
                  WHERE c."tenantId" = tenant AND c."workOrderId" = work_order AND c."workerId" IS NULL AND c."reversalOfId" IS NULL)
      OR EXISTS (SELECT 1 FROM "OperationScan" s
                  WHERE s."tenantId" = tenant AND s."workOrderId" = work_order AND s."workerId" IS NULL
                    AND s."kind" IN ('REPORT', 'CORRECTION'))
$$;

-- Refuses a judge (an inspector, a releaser) who made garments of the work order: a worker named by its floor records,
-- or an office user linked to such a worker (read only for an office user: the floor never names one). Without a
-- signed statement it also refuses when the floor's records do not name every maker.
CREATE FUNCTION "factory_quality_check_not_maker"(tenant uuid, work_order uuid, worker uuid, office_user uuid, signed_statement boolean, what text, row_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  linked uuid;
BEGIN
  IF worker IS NOT NULL THEN
    IF "factory_quality_worker_made"(tenant, work_order, worker) THEN
      RAISE EXCEPTION 'quality: worker % made garments of work order % (its cut logs or scans name them); the % % is by someone who made none of them (four-eyes, Reg. 2016/425)', worker, work_order, what, row_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF office_user IS NOT NULL THEN
    SELECT w."id" INTO linked FROM "Worker" w
     WHERE w."tenantId" = tenant AND w."userId" = office_user AND "factory_quality_worker_made"(tenant, work_order, w."id")
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'quality: user % is worker %, who made garments of work order %; the % % is by someone who made none of them (four-eyes, Reg. 2016/425)', office_user, linked, work_order, what, row_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT signed_statement THEN
    IF "factory_quality_makers_unnamed"(tenant, work_order) THEN
      RAISE EXCEPTION 'quality: the floor records of work order % do not name every maker (the site records the station, MES-278); the % % carries the inspector''s signed statement that they made none of the garments (PLAN §2.8)', work_order, what, row_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Style.garmentTracking (Q31; PRD-025): a work order is traced one way. The setting changes only while none of the
-- style's work orders has a garment serial or a quality release.
CREATE FUNCTION "factory_style_garment_tracking_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "GarmentSerial" g JOIN "WorkOrder" w ON w."tenantId" = g."tenantId" AND w."id" = g."workOrderId"
              WHERE g."tenantId" = NEW."tenantId" AND w."styleId" = NEW."id")
     OR EXISTS (SELECT 1 FROM "QualityRelease" r JOIN "WorkOrder" w ON w."tenantId" = r."tenantId" AND w."id" = r."workOrderId"
                 WHERE r."tenantId" = NEW."tenantId" AND w."styleId" = NEW."id") THEN
    RAISE EXCEPTION 'quality: style % has work orders with serials or quality releases; how its garments are traced (%) no longer changes (Q31)', NEW."id", OLD."garmentTracking"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Style_garment_tracking_guard" BEFORE UPDATE OF "garmentTracking" ON "Style"
  FOR EACH ROW WHEN (NEW."garmentTracking" IS DISTINCT FROM OLD."garmentTracking")
  EXECUTE FUNCTION "factory_style_garment_tracking_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Inspection (QHS-050; A1 §2.5 "Final release")
--   INSERT     an inspection starts OPEN, for a work order that is RELEASED, IN_PROGRESS or COMPLETED.
--   every row  a lot from 1 up to the work order's pieces, a sample from 1 up to the lot, acceptance numbers from 0 up
--              to the sample, AQLs from 0, an inspection level; exactly one inspector (a worker or an office user; a
--              floor session names a worker); decidedAt and the signature set exactly when PASSED or FAILED.
--   UPDATE     an UPDATE that changes nothing passes; the company, work order and creation never change; only an OPEN
--              inspection changes, and it moves to PASSED, FAILED or CANCELLED (all final: a decided inspection never
--              changes).
--   decision   (OPEN → PASSED or FAILED) the checklist is a list; the inspector made none of the garments (four-eyes,
--              above), or signed that statement where the records do not name every maker; per class, at most the
--              sample's garments are defective. A PASS: no critical defect, majors and minors within the acceptance
--              numbers, no checklist item "ok": false. The inspection row is locked by the UPDATE, so its defects (whose
--              triggers lock it FOR SHARE) cannot change under the decision.
--   DELETE     refused (an inspection is cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_inspection_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  order_state text;
  pieces bigint;
  critical bigint;
  major bigint;
  minor bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: inspection % is kept (cancelled when abandoned), never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'quality: inspection % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."workOrderId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."workOrderId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, work order and creation of inspection % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: inspection % is %; a decided or cancelled inspection never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."lotSize" < 1 OR NEW."sampleSize" < 1 OR NEW."sampleSize" > NEW."lotSize"
     OR NEW."acceptMajor" < 0 OR NEW."acceptMinor" < 0 OR NEW."acceptMajor" > NEW."sampleSize" OR NEW."acceptMinor" > NEW."sampleSize"
     OR NEW."aqlMajor" < 0 OR NEW."aqlMinor" < 0 OR btrim(NEW."inspectionLevel") = '' THEN
    RAISE EXCEPTION 'quality: inspection % has a lot from 1, a sample from 1 up to the lot, acceptance numbers from 0 up to the sample, AQLs from 0 and an inspection level (ISO 2859-1)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."inspectorWorkerId" IS NULL) = (NEW."inspectorUserId" IS NULL) THEN
    RAISE EXCEPTION 'quality: inspection % names exactly one inspector: a worker of the site or an office user', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'factory_floor_runtime' AND NEW."inspectorUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'quality: the floor records the inspection of a worker (the signed-in floor inspector), not of an office user (inspection %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('PASSED', 'FAILED')) <> (NEW."decidedAt" IS NOT NULL)
     OR (NEW."status" IN ('PASSED', 'FAILED')) <> (btrim(coalesce(NEW."signatureSha256", '')) <> '') THEN
    RAISE EXCEPTION 'quality: inspection % is % with the wrong decision: its time and signature are set exactly when PASSED or FAILED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT w."status"::text, (SELECT sum(c."quantity") FROM "WorkOrderSize" c WHERE c."tenantId" = w."tenantId" AND c."workOrderId" = w."id")
    INTO order_state, pieces
    FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF NOT FOUND THEN
    -- Outside this session's scope: the policies refuse the row.
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND order_state NOT IN ('RELEASED', 'IN_PROGRESS', 'COMPLETED') THEN
    RAISE EXCEPTION 'quality: work order % is %; its garments are inspected while it is RELEASED, IN_PROGRESS or COMPLETED', NEW."workOrderId", order_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lotSize" > coalesce(pieces, 0) THEN
    RAISE EXCEPTION 'quality: inspection % judges a lot of % garment(s); work order % has %', NEW."id", NEW."lotSize", NEW."workOrderId", coalesce(pieces, 0)
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" = 'OPEN' AND NEW."status" IN ('PASSED', 'FAILED') THEN
    IF NEW."checklist" IS NULL OR jsonb_typeof(NEW."checklist") <> 'array' OR jsonb_array_length(NEW."checklist") = 0 THEN
      RAISE EXCEPTION 'quality: inspection % is decided with its garment and label checklist (QHS-050): a list of checked items', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_quality_check_not_maker"(NEW."tenantId", NEW."workOrderId", NEW."inspectorWorkerId", NEW."inspectorUserId", NEW."notMakerStatement", 'inspection', NEW."id");
    SELECT coalesce(sum(d."quantity") FILTER (WHERE d."defectClass" = 'CRITICAL'), 0),
           coalesce(sum(d."quantity") FILTER (WHERE d."defectClass" = 'MAJOR'), 0),
           coalesce(sum(d."quantity") FILTER (WHERE d."defectClass" = 'MINOR'), 0)
      INTO critical, major, minor
      FROM "InspectionDefect" d WHERE d."tenantId" = NEW."tenantId" AND d."inspectionId" = NEW."id";
    IF critical > NEW."sampleSize" OR major > NEW."sampleSize" OR minor > NEW."sampleSize" THEN
      RAISE EXCEPTION 'quality: inspection % counts more defective garments in a class than its sample of %', NEW."id", NEW."sampleSize"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'PASSED' THEN
      IF critical > 0 THEN
        RAISE EXCEPTION 'quality: inspection % found % critical defect(s); a critical defect is never accepted, it FAILS', NEW."id", critical
          USING ERRCODE = 'check_violation';
      END IF;
      IF major > NEW."acceptMajor" OR minor > NEW."acceptMinor" THEN
        RAISE EXCEPTION 'quality: inspection % found % major and % minor defective garment(s); its plan accepts % and %, so it FAILS', NEW."id", major, minor, NEW."acceptMajor", NEW."acceptMinor"
          USING ERRCODE = 'check_violation';
      END IF;
      IF jsonb_path_exists(NEW."checklist", '$[*] ? (@.ok == false)') THEN
        RAISE EXCEPTION 'quality: inspection % has a checklist item that is not ok; it does not PASS', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Inspection_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Inspection"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_guard"();
CREATE TRIGGER "Inspection_no_truncate" BEFORE TRUNCATE ON "Inspection"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_quality_shipping_refuse_truncate"();

-- InspectionDefect
--   INSERT, UPDATE, DELETE  only while the inspection is OPEN (its row locked FOR SHARE); a defect never moves to
--                           another inspection. An UPDATE that changes nothing passes.
--   every row               from 1 garment, with a code.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_inspection_defect_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."inspectionId" <> OLD."inspectionId" OR NEW."workOrderId" <> OLD."workOrderId" THEN
      RAISE EXCEPTION 'quality: defect % never moves to another inspection', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    part_of := NEW."inspectionId";
    SELECT i."status"::text INTO state FROM "Inspection" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."inspectionId" FOR SHARE;
  ELSE
    part_of := OLD."inspectionId";
    SELECT i."status"::text INTO state FROM "Inspection" i WHERE i."tenantId" = OLD."tenantId" AND i."id" = OLD."inspectionId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'OPEN' THEN
    RAISE EXCEPTION 'quality: inspection % is %; its defects change only while it is OPEN', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW."quantity" < 1 OR btrim(NEW."code") = '' THEN
    RAISE EXCEPTION 'quality: defect % has a code and at least one garment', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InspectionDefect_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InspectionDefect"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_defect_guard"();
CREATE TRIGGER "InspectionDefect_no_truncate" BEFORE TRUNCATE ON "InspectionDefect"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_quality_shipping_refuse_truncate"();

-- QualityRelease, INSERT (QHS-058; A1 §2.5 "Final release"; append-only above)
--   every row     from 1 garment, a signature.
--   work order    RELEASED, IN_PROGRESS or COMPLETED; the inspection (of the same work order: the reference) PASSED.
--   quantities    under a transaction lock per work order: the cell's releases never pass its pieces, and the
--                 releases from one inspection never pass its lot.
--   four-eyes     the releasing user made none of the garments; nor did the inspection's inspector (checked again: a
--                 scan after the decision counts too).
--   certificates  a PPE style (not NOT_PPE): at least one certificate named; every certificate named is VALID on the
--                 release day (the company's zone); one of them covers the style with the cell's colourway and size in
--                 an ACTIVE coverage (and made-to-measure units, for a made-to-measure cell): the certificate gate.
CREATE FUNCTION "factory_quality_release_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
  style_id uuid;
  inspection record;
  cell record;
  released bigint;
  from_inspection bigint;
  category text;
  zone text;
  release_day date;
  stale uuid;
BEGIN
  IF NEW."quantity" < 1 OR btrim(NEW."signatureSha256") = '' THEN
    RAISE EXCEPTION 'quality: release % is of at least one garment, signed', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT w."status"::text, w."styleId" INTO order_state, style_id
    FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF NOT FOUND THEN
    -- Outside this session's scope: the policies refuse the row.
    RETURN NEW;
  END IF;
  IF order_state NOT IN ('RELEASED', 'IN_PROGRESS', 'COMPLETED') THEN
    RAISE EXCEPTION 'quality: work order % is %; its garments are released while it is RELEASED, IN_PROGRESS or COMPLETED', NEW."workOrderId", order_state
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."status"::text AS status, i."lotSize", i."inspectorWorkerId", i."inspectorUserId", i."notMakerStatement" INTO inspection
    FROM "Inspection" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."inspectionId";
  IF FOUND AND inspection.status <> 'PASSED' THEN
    RAISE EXCEPTION 'quality: inspection % is %; garments are released only from a PASSED inspection (QHS-058)', NEW."inspectionId", inspection.status
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.release', NEW."tenantId", NEW."workOrderId"), 0));
  SELECT c."quantity", c."colourwayId", c."size", c."measurementProfileId" INTO cell
    FROM "WorkOrderSize" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."workOrderSizeId";
  IF FOUND THEN
    SELECT coalesce(sum(r."quantity"), 0) INTO released
      FROM "QualityRelease" r WHERE r."tenantId" = NEW."tenantId" AND r."workOrderSizeId" = NEW."workOrderSizeId";
    IF released + NEW."quantity" > cell."quantity" THEN
      RAISE EXCEPTION 'quality: cell % has % piece(s) and % released; release % of % more is refused', NEW."workOrderSizeId", cell."quantity", released, NEW."id", NEW."quantity"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF inspection.status IS NOT NULL THEN
    SELECT coalesce(sum(r."quantity"), 0) INTO from_inspection
      FROM "QualityRelease" r WHERE r."tenantId" = NEW."tenantId" AND r."inspectionId" = NEW."inspectionId";
    IF from_inspection + NEW."quantity" > inspection."lotSize" THEN
      RAISE EXCEPTION 'quality: inspection % judged a lot of % garment(s), % released already; release % of % more is refused', NEW."inspectionId", inspection."lotSize", from_inspection, NEW."id", NEW."quantity"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_quality_check_not_maker"(NEW."tenantId", NEW."workOrderId", inspection."inspectorWorkerId", inspection."inspectorUserId", inspection."notMakerStatement", 'inspection', NEW."inspectionId");
  END IF;
  PERFORM "factory_quality_check_not_maker"(NEW."tenantId", NEW."workOrderId", NULL, NEW."releasedById", true, 'release', NEW."id");

  SELECT s."ppeCategory"::text INTO category FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = style_id;
  IF FOUND AND category <> 'NOT_PPE' THEN
    SELECT coalesce(co."timezone", 'Europe/Rome') INTO zone FROM "Company" co WHERE co."tenantId" = NEW."tenantId" AND co."id" = NEW."companyId";
    release_day := (NEW."releasedAt" AT TIME ZONE coalesce(zone, 'Europe/Rome'))::date;
    IF cardinality(NEW."certificateIds") = 0 THEN
      RAISE EXCEPTION 'quality: style % is PPE (%); release % names the certificates that cover it (the certificate gate, Reg. 2016/425)', style_id, category, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT x."id" INTO stale FROM unnest(NEW."certificateIds") AS x("id")
     WHERE NOT EXISTS (SELECT 1 FROM "Certificate" ce
                        WHERE ce."tenantId" = NEW."tenantId" AND ce."id" = x."id" AND ce."status" = 'VALID'
                          AND release_day BETWEEN ce."validFrom" AND ce."validTo")
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'quality: certificate % is not VALID on %; release % names only certificates valid that day', stale, release_day, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF cell."quantity" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "CertificateCoverage" v
                        WHERE v."tenantId" = NEW."tenantId" AND v."certificateId" = ANY (NEW."certificateIds") AND v."styleId" = style_id
                          AND v."status" = 'ACTIVE'
                          AND (cardinality(v."colourwayIds") = 0 OR cell."colourwayId" = ANY (v."colourwayIds"))
                          AND (cardinality(v."sizes") = 0 OR cell."size" = ANY (v."sizes"))
                          AND (cell."measurementProfileId" IS NULL OR v."allowsMadeToMeasure")) THEN
      RAISE EXCEPTION 'quality: no certificate named by release % covers style % in colourway % and size % (the certificate gate, A1 §2.5)', NEW."id", style_id, cell."colourwayId", cell."size"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QualityRelease_check" BEFORE INSERT ON "QualityRelease"
  FOR EACH ROW EXECUTE FUNCTION "factory_quality_release_check"();

-- GarmentSerial (Q31 (b), PRD-025, MES-076)
--   INSERT     MADE, not released, not packed; the work order's style is SERIAL-tracked and the work order RELEASED,
--              IN_PROGRESS or COMPLETED; under a transaction lock per cell, the cell's live (not VOID) serials never pass
--              its pieces. The serial is unique in the tenant (the unique key).
--   UPDATE     an UPDATE that changes nothing passes; the work order, cell, serial and creation never change; MADE →
--              RELEASED | VOID, RELEASED → SHIPPED | VOID; SHIPPED and VOID are final. RELEASED names a release of its
--              cell (once), whose serials never pass its garments (a lock per release). Packing (the shipment line set
--              or cleared) happens only while RELEASED and the shipment is a DRAFT, and a line never holds more serials
--              than garments (a lock per line). SHIPPED keeps its line, whose shipment SHIPPED (or later DELIVERED).
--              A floor session packs, unpacks and voids a MADE serial; releasing and shipping are the office's.
--   every row  a serial; MADE has no release and no line; RELEASED and SHIPPED a release; SHIPPED a line; VOID no line,
--              and its time and reason exactly when VOID.
--   DELETE     refused (a serial is voided, never reused). TRUNCATE refused.
CREATE FUNCTION "factory_garment_serial_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  order_state text;
  tracking text;
  pieces integer;
  live bigint;
  allowed integer;
  taken bigint;
  shipment_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: serial % is voided, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'MADE' OR NEW."releaseId" IS NOT NULL OR NEW."shipmentLineId" IS NOT NULL THEN
      RAISE EXCEPTION 'quality: serial % starts MADE, not released and not packed', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT w."status"::text, s."garmentTracking"::text INTO order_state, tracking
      FROM "WorkOrder" w JOIN "Style" s ON s."tenantId" = w."tenantId" AND s."id" = w."styleId"
     WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF FOUND THEN
      IF tracking <> 'SERIAL' THEN
        RAISE EXCEPTION 'quality: the style of work order % traces its garments by batch (%: Q31); serials are given only for a SERIAL style', NEW."workOrderId", tracking
          USING ERRCODE = 'check_violation';
      END IF;
      IF order_state NOT IN ('RELEASED', 'IN_PROGRESS', 'COMPLETED') THEN
        RAISE EXCEPTION 'quality: work order % is %; serials are given while it is RELEASED, IN_PROGRESS or COMPLETED', NEW."workOrderId", order_state
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.serial-cell', NEW."tenantId", NEW."workOrderSizeId"), 0));
      SELECT c."quantity" INTO pieces FROM "WorkOrderSize" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."workOrderSizeId";
      SELECT count(*) INTO live FROM "GarmentSerial" g
       WHERE g."tenantId" = NEW."tenantId" AND g."workOrderSizeId" = NEW."workOrderSizeId" AND g."status" <> 'VOID';
      IF pieces IS NOT NULL AND live + 1 > pieces THEN
        RAISE EXCEPTION 'quality: cell % has % piece(s) and % live serial(s); serial % is one too many', NEW."workOrderSizeId", pieces, live, NEW."serial"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."workOrderId", NEW."workOrderSizeId", NEW."serial", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."workOrderId", OLD."workOrderSizeId", OLD."serial", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the work order, cell, serial and creation of serial % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('SHIPPED', 'VOID') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: serial % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'MADE' AND NEW."status" IN ('RELEASED', 'VOID'))
                OR (OLD."status" = 'RELEASED' AND NEW."status" IN ('SHIPPED', 'VOID'))) THEN
      RAISE EXCEPTION 'quality: serial % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."releaseId" IS NOT NULL AND NEW."releaseId" IS DISTINCT FROM OLD."releaseId" THEN
      RAISE EXCEPTION 'quality: the release of serial % is named once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime' AND NEW."status" <> OLD."status" AND NOT (OLD."status" = 'MADE' AND NEW."status" = 'VOID') THEN
      RAISE EXCEPTION 'quality: the floor packs, unpacks and voids serials; releasing and shipping serial % are the office''s', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'MADE' AND NEW."status" = 'RELEASED' AND NEW."releaseId" IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.serial-release', NEW."tenantId", NEW."releaseId"), 0));
      SELECT r."quantity" INTO allowed FROM "QualityRelease" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."releaseId";
      SELECT count(*) INTO taken FROM "GarmentSerial" g
       WHERE g."tenantId" = NEW."tenantId" AND g."releaseId" = NEW."releaseId" AND g."id" <> NEW."id";
      IF allowed IS NOT NULL AND taken + 1 > allowed THEN
        RAISE EXCEPTION 'quality: release % released % garment(s), and % serial(s) name it; serial % is one too many', NEW."releaseId", allowed, taken, NEW."serial"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    IF NEW."shipmentLineId" IS DISTINCT FROM OLD."shipmentLineId" THEN
      IF OLD."status" <> 'RELEASED' OR NEW."status" <> 'RELEASED' THEN
        RAISE EXCEPTION 'quality: serial % is packed and unpacked only while RELEASED (QHS-073: only released garments are packed)', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."shipmentLineId" IS NOT NULL THEN
        SELECT sh."status"::text INTO shipment_state
          FROM "ShipmentLine" l JOIN "Shipment" sh ON sh."tenantId" = l."tenantId" AND sh."id" = l."shipmentId"
         WHERE l."tenantId" = OLD."tenantId" AND l."id" = OLD."shipmentLineId" FOR SHARE OF sh;
        IF FOUND AND shipment_state <> 'DRAFT' THEN
          RAISE EXCEPTION 'quality: serial % is in a % shipment; it is unpacked only while the shipment is a DRAFT', OLD."id", shipment_state
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      IF NEW."shipmentLineId" IS NOT NULL THEN
        SELECT sh."status"::text, l."quantity" INTO shipment_state, allowed
          FROM "ShipmentLine" l JOIN "Shipment" sh ON sh."tenantId" = l."tenantId" AND sh."id" = l."shipmentId"
         WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."shipmentLineId" FOR SHARE OF sh;
        IF FOUND THEN
          IF shipment_state <> 'DRAFT' THEN
            RAISE EXCEPTION 'quality: shipment line % is in a % shipment; serials are packed only while it is a DRAFT', NEW."shipmentLineId", shipment_state
              USING ERRCODE = 'check_violation';
          END IF;
          PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.serial-line', NEW."tenantId", NEW."shipmentLineId"), 0));
          SELECT count(*) INTO taken FROM "GarmentSerial" g
           WHERE g."tenantId" = NEW."tenantId" AND g."shipmentLineId" = NEW."shipmentLineId" AND g."id" <> NEW."id";
          IF taken + 1 > allowed THEN
            RAISE EXCEPTION 'quality: shipment line % ships % garment(s) and holds % serial(s); serial % is one too many', NEW."shipmentLineId", allowed, taken, NEW."serial"
              USING ERRCODE = 'check_violation';
          END IF;
        END IF;
      END IF;
    END IF;

    IF OLD."status" = 'RELEASED' AND NEW."status" = 'SHIPPED' AND NEW."shipmentLineId" IS NOT NULL THEN
      SELECT sh."status"::text INTO shipment_state
        FROM "ShipmentLine" l JOIN "Shipment" sh ON sh."tenantId" = l."tenantId" AND sh."id" = l."shipmentId"
       WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."shipmentLineId";
      IF FOUND AND shipment_state NOT IN ('SHIPPED', 'DELIVERED') THEN
        RAISE EXCEPTION 'quality: serial % is SHIPPED only with its shipment (which is %)', NEW."id", shipment_state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF btrim(NEW."serial") = ''
     OR (NEW."status" = 'MADE' AND (NEW."releaseId" IS NOT NULL OR NEW."shipmentLineId" IS NOT NULL))
     OR (NEW."status" IN ('RELEASED', 'SHIPPED') AND NEW."releaseId" IS NULL)
     OR (NEW."status" = 'SHIPPED' AND NEW."shipmentLineId" IS NULL)
     OR (NEW."status" = 'VOID' AND NEW."shipmentLineId" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: serial % is % with the wrong release or shipment line (MADE: neither; RELEASED: its release; SHIPPED: its release and line; VOID: no line)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'VOID') <> (NEW."voidedAt" IS NOT NULL) OR (NEW."status" = 'VOID') <> (btrim(coalesce(NEW."voidReason", '')) <> '') THEN
    RAISE EXCEPTION 'quality: serial % is % with the wrong voiding: a void serial has its time and reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "GarmentSerial_guard" BEFORE INSERT OR UPDATE OR DELETE ON "GarmentSerial"
  FOR EACH ROW EXECUTE FUNCTION "factory_garment_serial_guard"();
CREATE TRIGGER "GarmentSerial_no_truncate" BEFORE TRUNCATE ON "GarmentSerial"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_quality_shipping_refuse_truncate"();

-- PpeRegisterEntry (QHS-118; Reg. 2016/425 art. 8(4))
--   INSERT     an entry starts OPEN.
--   UPDATE     an UPDATE that changes nothing passes; the company, reference, kind, report time and creation never
--              change; the status moves only OPEN → CLOSED; a CLOSED entry never changes.
--   every row  a reference and a description; closed (time and who) exactly when CLOSED.
--   DELETE     refused (the register is kept). TRUNCATE refused.
CREATE FUNCTION "factory_ppe_register_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
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
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."status" = 'CLOSED') <> (NEW."closedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: PPE register entry % is % with the wrong closing: a closed entry has its time and who closed it', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PpeRegisterEntry_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PpeRegisterEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_ppe_register_entry_guard"();
CREATE TRIGGER "PpeRegisterEntry_no_truncate" BEFORE TRUNCATE ON "PpeRegisterEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_quality_shipping_refuse_truncate"();

-- =====================================================================================================================
-- Shipping
-- =====================================================================================================================

-- ShippingSettings (LOG-117)
--   UPDATE     an UPDATE that changes nothing passes; the company and creation never change.
--   every row  the sender's address is an object; a cut-off is HH:MM.
--   DELETE     refused (the settings are changed, never removed). TRUNCATE refused.
CREATE FUNCTION "factory_shipping_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shipping: the shipping settings % are changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'shipping: the company and creation of the shipping settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF jsonb_typeof(NEW."senderAddress") <> 'object' OR (NEW."returnAddress" IS NOT NULL AND jsonb_typeof(NEW."returnAddress") <> 'object') THEN
    RAISE EXCEPTION 'shipping: the shipping settings % hold the sender''s (and the return) address as an object', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."cutOffTime" IS NOT NULL AND NEW."cutOffTime" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RAISE EXCEPTION 'shipping: the cut-off of the shipping settings % is a time of day, HH:MM', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ShippingSettings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ShippingSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipping_settings_guard"();
CREATE TRIGGER "ShippingSettings_no_truncate" BEFORE TRUNCATE ON "ShippingSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_quality_shipping_refuse_truncate"();

-- Shipment (LOG-001, LOG-039; A1 §2.5 "Shipment")
--   INSERT     a shipment starts as a DRAFT, of an order that is neither CANCELLED nor CLOSED.
--   UPDATE     an UPDATE that changes nothing passes; the company, order, number and creation never change; the status
--              moves DRAFT → PACKED | CANCELLED, PACKED → DRAFT | SHIPPED | CANCELLED, SHIPPED → DELIVERED |
--              RETURNED; DELIVERED, RETURNED and CANCELLED are final (only the internal note changes); a SHIPPED
--              shipment changes only its status, delivery or return and internal note. A floor session (packing) only
--              moves DRAFT ⇄ PACKED.
--   packing    (DRAFT → PACKED) it has lines, every line is in a parcel, it has parcels and every parcel is weighed,
--              and a line of a SERIAL-tracked style holds as many serials as garments (QHS-073).
--   every row  a number; packed from PACKED on (none while a DRAFT), shipped from SHIPPED on, delivered exactly when
--              DELIVERED, returned exactly when RETURNED, cancelled (time and reason) exactly when CANCELLED.
--   DELETE     refused (a shipment is cancelled). TRUNCATE refused.
-- Leaving: a shipment that becomes SHIPPED with ddtRequired has a DDT that is not cancelled, at commit (below).
CREATE FUNCTION "factory_shipment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  order_state text;
  lines bigint;
  unpacked bigint;
  parcels bigint;
  unweighed bigint;
  unserialled bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shipping: shipment % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'shipping: shipment % starts as a DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT o."status"::text INTO order_state FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."salesOrderId";
    IF FOUND AND order_state IN ('CANCELLED', 'CLOSED') THEN
      RAISE EXCEPTION 'shipping: sales order % is %; nothing more ships for it', NEW."salesOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."salesOrderId", NEW."number", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."salesOrderId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'shipping: the company, order, number and creation of shipment % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('PACKED', 'CANCELLED'))
                OR (OLD."status" = 'PACKED' AND NEW."status" IN ('DRAFT', 'SHIPPED', 'CANCELLED'))
                OR (OLD."status" = 'SHIPPED' AND NEW."status" IN ('DELIVERED', 'RETURNED'))) THEN
      RAISE EXCEPTION 'shipping: shipment % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('DELIVERED', 'RETURNED', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['internalNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'shipping: shipment % is %; only its internal note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'SHIPPED'
       AND (to_jsonb(NEW) - (kept || ARRAY['status', 'deliveredAt', 'returnedAt', 'internalNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['status', 'deliveredAt', 'returnedAt', 'internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'shipping: shipment % left; only its delivery or return and its internal note change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime'
       AND ((to_jsonb(NEW) - (kept || ARRAY['status', 'packedAt', 'version', 'updatedAt']))
            IS DISTINCT FROM
            (to_jsonb(OLD) - (kept || ARRAY['status', 'packedAt', 'version', 'updatedAt']))
            OR (NEW."status" <> OLD."status"
                AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'PACKED') OR (OLD."status" = 'PACKED' AND NEW."status" = 'DRAFT')))) THEN
      RAISE EXCEPTION 'shipping: the floor packs and unpacks shipment % (DRAFT ⇄ PACKED), nothing else', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'DRAFT' AND NEW."status" = 'PACKED' THEN
      SELECT count(*), count(*) FILTER (WHERE l."parcelId" IS NULL) INTO lines, unpacked
        FROM "ShipmentLine" l WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id";
      SELECT count(*), count(*) FILTER (WHERE p."grossWeightKg" IS NULL) INTO parcels, unweighed
        FROM "Parcel" p WHERE p."tenantId" = NEW."tenantId" AND p."shipmentId" = NEW."id";
      IF lines = 0 OR unpacked > 0 OR parcels = 0 OR unweighed > 0 THEN
        RAISE EXCEPTION 'shipping: shipment % is PACKED with its lines, each in a parcel, and its parcels, each weighed (% line(s), % not in a parcel; % parcel(s), % not weighed)', NEW."id", lines, unpacked, parcels, unweighed
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*) INTO unserialled
        FROM "ShipmentLine" l
        JOIN "WorkOrder" w ON w."tenantId" = l."tenantId" AND w."id" = l."workOrderId"
        JOIN "Style" s ON s."tenantId" = w."tenantId" AND s."id" = w."styleId"
       WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id" AND s."garmentTracking" = 'SERIAL'
         AND l."quantity" <> (SELECT count(*) FROM "GarmentSerial" g WHERE g."tenantId" = l."tenantId" AND g."shipmentLineId" = l."id");
      IF unserialled > 0 THEN
        RAISE EXCEPTION 'shipping: shipment % has % line(s) of a serial-tracked style without a serial for each garment (Q31)', NEW."id", unserialled
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF btrim(NEW."number") = '' THEN
    RAISE EXCEPTION 'shipping: shipment % has a number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED') AND NEW."packedAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND NEW."packedAt" IS NOT NULL)
     OR (NEW."status" IN ('SHIPPED', 'DELIVERED', 'RETURNED')) <> (NEW."shippedAt" IS NOT NULL)
     OR (NEW."status" = 'DELIVERED') <> (NEW."deliveredAt" IS NOT NULL)
     OR (NEW."status" = 'RETURNED') <> (NEW."returnedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'shipping: shipment % is % with the wrong packing, shipping, delivery or return time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'shipping: shipment % is % with the wrong cancellation (a cancelled shipment has its time and reason)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Shipment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Shipment"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipment_guard"();
CREATE TRIGGER "Shipment_no_truncate" BEFORE TRUNCATE ON "Shipment"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_quality_shipping_refuse_truncate"();

-- A shipment leaves with its DDT (DPR 472/1996; A1 §2.5 "Shipment"): the transaction that moves it to SHIPPED, with
-- ddtRequired, has a DDT of it that no DdtCancellation names. Checked at commit (a deferred constraint trigger), so the
-- DDT may be issued before or after the move in the same command.
CREATE FUNCTION "factory_shipment_shipped_has_ddt"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."ddtRequired"
     AND NOT EXISTS (SELECT 1 FROM "Ddt" d
                      WHERE d."tenantId" = NEW."tenantId" AND d."shipmentId" = NEW."id"
                        AND NOT EXISTS (SELECT 1 FROM "DdtCancellation" x WHERE x."tenantId" = d."tenantId" AND x."ddtId" = d."id")) THEN
    RAISE EXCEPTION 'shipping: shipment % left without its DDT (DPR 472/1996); issue one, or mark that an immediate invoice travels with the goods', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "Shipment_shipped_has_ddt" AFTER UPDATE ON "Shipment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" = 'SHIPPED' AND OLD."status" <> 'SHIPPED')
  EXECUTE FUNCTION "factory_shipment_shipped_has_ddt"();

-- ShipmentLine (LOG-001; QHS-058, QHS-073: only released garments ship)
--   INSERT, UPDATE, DELETE  only while the shipment is a DRAFT (its row locked FOR SHARE); a line never moves to another
--                           shipment. An UPDATE that changes nothing passes. A line that holds serials is removed
--                           only after they are unpacked.
--   every row               from 1 garment; it ships its cell: the cell's party, sales order line and size; an office
--                           session also checks that the line is of the shipment's order (the floor reads no sales
--                           order). It holds at most its garments' serials.
--   released only           under a transaction lock per cell: the cell's lines over every shipment that is not
--                           CANCELLED never pass the cell's quality releases.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_shipment_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shipment record;
  part_of uuid;
  cell record;
  line_order uuid;
  released bigint;
  shipped bigint;
  serials bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."shipmentId" <> OLD."shipmentId" THEN
      RAISE EXCEPTION 'shipping: shipment line % never moves to another shipment', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    part_of := NEW."shipmentId";
    SELECT sh."status"::text AS status, sh."salesOrderId" INTO shipment
      FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."shipmentId" FOR SHARE;
  ELSE
    part_of := OLD."shipmentId";
    SELECT sh."status"::text AS status, sh."salesOrderId" INTO shipment
      FROM "Shipment" sh WHERE sh."tenantId" = OLD."tenantId" AND sh."id" = OLD."shipmentId" FOR SHARE;
  END IF;
  IF shipment.status IS NOT NULL AND shipment.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'shipping: shipment % is %; its lines change only while it is a DRAFT', part_of, shipment.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "GarmentSerial" g WHERE g."tenantId" = OLD."tenantId" AND g."shipmentLineId" = OLD."id") THEN
      RAISE EXCEPTION 'shipping: shipment line % holds serials; unpack them first', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1 THEN
    RAISE EXCEPTION 'shipping: shipment line % ships at least one garment', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c."partyId", c."salesOrderLineId", c."size" INTO cell
    FROM "WorkOrderSize" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."workOrderSizeId";
  IF NOT FOUND THEN
    -- Outside this session's scope: the policies refuse the row.
    RETURN NEW;
  END IF;
  IF (cell."partyId", cell."salesOrderLineId", cell."size") IS DISTINCT FROM (NEW."partyId", NEW."salesOrderLineId", NEW."size") THEN
    RAISE EXCEPTION 'shipping: shipment line % ships its work order cell %: that cell''s party, sales order line and size', NEW."id", NEW."workOrderSizeId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_user <> 'factory_floor_runtime' AND shipment.status IS NOT NULL THEN
    SELECT l."orderId" INTO line_order FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
    IF FOUND AND line_order <> shipment."salesOrderId" THEN
      RAISE EXCEPTION 'shipping: shipment line % ships sales order line %, which is not of the shipment''s order %', NEW."id", NEW."salesOrderLineId", shipment."salesOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT count(*) INTO serials FROM "GarmentSerial" g WHERE g."tenantId" = NEW."tenantId" AND g."shipmentLineId" = NEW."id";
    IF serials > NEW."quantity" THEN
      RAISE EXCEPTION 'shipping: shipment line % holds % serial(s); it ships at least as many garments', NEW."id", serials
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.ship-cell', NEW."tenantId", NEW."workOrderSizeId"), 0));
  SELECT coalesce(sum(r."quantity"), 0) INTO released
    FROM "QualityRelease" r WHERE r."tenantId" = NEW."tenantId" AND r."workOrderSizeId" = NEW."workOrderSizeId";
  SELECT coalesce(sum(l."quantity"), 0) INTO shipped
    FROM "ShipmentLine" l JOIN "Shipment" sh ON sh."tenantId" = l."tenantId" AND sh."id" = l."shipmentId"
   WHERE l."tenantId" = NEW."tenantId" AND l."workOrderSizeId" = NEW."workOrderSizeId" AND l."id" <> NEW."id" AND sh."status" <> 'CANCELLED';
  IF shipped + NEW."quantity" > released THEN
    RAISE EXCEPTION 'shipping: only released garments ship (QHS-058): cell % has % released and % on other shipments; shipment line % of % is refused', NEW."workOrderSizeId", released, shipped, NEW."id", NEW."quantity"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ShipmentLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ShipmentLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipment_line_guard"();
CREATE TRIGGER "ShipmentLine_no_truncate" BEFORE TRUNCATE ON "ShipmentLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_quality_shipping_refuse_truncate"();

-- Parcel (LOG-039)
--   INSERT, DELETE  only while the shipment is a DRAFT; a parcel that holds lines is removed only after they are moved.
--   UPDATE          an UPDATE that changes nothing passes; a parcel never moves to another shipment; it changes (weight,
--                   size, label) only while the shipment is a DRAFT or PACKED.
--   every row       a place from 1; a weight and sizes above 0 when given.
--   TRUNCATE        refused. The shipment's row is locked FOR SHARE.
CREATE FUNCTION "factory_parcel_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."shipmentId" <> OLD."shipmentId" THEN
      RAISE EXCEPTION 'shipping: parcel % never moves to another shipment', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    part_of := NEW."shipmentId";
    SELECT sh."status"::text INTO state FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."shipmentId" FOR SHARE;
  ELSE
    part_of := OLD."shipmentId";
    SELECT sh."status"::text INTO state FROM "Shipment" sh WHERE sh."tenantId" = OLD."tenantId" AND sh."id" = OLD."shipmentId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND (state <> 'DRAFT' AND (TG_OP <> 'UPDATE' OR state <> 'PACKED')) THEN
    RAISE EXCEPTION 'shipping: shipment % is %; its parcels are added and removed while it is a DRAFT, and change until it leaves', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "ShipmentLine" l WHERE l."tenantId" = OLD."tenantId" AND l."parcelId" = OLD."id") THEN
      RAISE EXCEPTION 'shipping: parcel % holds shipment lines; move them first', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."seq" < 1 OR NEW."grossWeightKg" <= 0 OR NEW."lengthCm" <= 0 OR NEW."widthCm" <= 0 OR NEW."heightCm" <= 0 THEN
    RAISE EXCEPTION 'shipping: parcel % has a place from 1, and a weight and sizes above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Parcel_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Parcel"
  FOR EACH ROW EXECUTE FUNCTION "factory_parcel_guard"();
CREATE TRIGGER "Parcel_no_truncate" BEFORE TRUNCATE ON "Parcel"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_quality_shipping_refuse_truncate"();

-- Ddt, INSERT (DPR 472/1996 art. 1 c.3 with DPR 627/1978; LOG-054; append-only above)
--   number      from a DDT series of its company (the reference holds the company); a number and an appearance.
--   transport   a reason (OTHER in words), the carrier's name when a carrier carries it, packages from 1, a gross
--               weight above 0, a net weight above 0 and at most the gross.
--   document    the sender and the recipient as objects; the goods as a list of at least one line.
--   shipment    PACKED or SHIPPED (a DDT is issued when the goods leave, or replaces a cancelled one while they
--               travel); its packages are the shipment's parcels.
CREATE FUNCTION "factory_ddt_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  series_kind text;
  state text;
  parcels bigint;
BEGIN
  IF btrim(NEW."number") = '' OR btrim(NEW."appearance") = '' THEN
    RAISE EXCEPTION 'shipping: DDT % has a number and the goods'' appearance (DPR 472/1996)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reason" = 'OTHER' AND btrim(coalesce(NEW."reasonText", '')) = '' THEN
    RAISE EXCEPTION 'shipping: DDT % says its reason for the transport in words (causale OTHER)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."transportBy" = 'CARRIER'
     AND (NEW."carrier" IS NULL OR jsonb_typeof(NEW."carrier") <> 'object' OR btrim(coalesce(NEW."carrier" ->> 'name', '')) = '') THEN
    RAISE EXCEPTION 'shipping: DDT % names its carrier (DPR 472/1996: the carrier''s identity)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."packages" < 1 OR NEW."grossWeightKg" <= 0
     OR (NEW."netWeightKg" IS NOT NULL AND (NEW."netWeightKg" <= 0 OR NEW."netWeightKg" > NEW."grossWeightKg")) THEN
    RAISE EXCEPTION 'shipping: DDT % has packages from 1, a gross weight above 0 and a net weight above 0 and at most the gross', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."sender") <> 'object' OR jsonb_typeof(NEW."recipient") <> 'object'
     OR (NEW."destination" IS NOT NULL AND jsonb_typeof(NEW."destination") <> 'object')
     OR jsonb_typeof(NEW."lines") <> 'array' OR jsonb_array_length(NEW."lines") = 0 THEN
    RAISE EXCEPTION 'shipping: DDT % holds its sender, recipient (and place of delivery) as objects and its goods as a list of at least one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."kind"::text INTO series_kind FROM "NumberSeries" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."numberSeriesId";
  IF FOUND AND series_kind <> 'DDT' THEN
    RAISE EXCEPTION 'shipping: DDT % is numbered from a DDT series, not a % series', NEW."id", series_kind
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT sh."status"::text INTO state FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."shipmentId";
  IF FOUND THEN
    IF state NOT IN ('PACKED', 'SHIPPED') THEN
      RAISE EXCEPTION 'shipping: shipment % is %; a DDT is issued for a PACKED or SHIPPED shipment', NEW."shipmentId", state
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO parcels FROM "Parcel" p WHERE p."tenantId" = NEW."tenantId" AND p."shipmentId" = NEW."shipmentId";
    IF parcels > 0 AND NEW."packages" <> parcels THEN
      RAISE EXCEPTION 'shipping: DDT % states % package(s); shipment % has % parcel(s)', NEW."id", NEW."packages", NEW."shipmentId", parcels
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Ddt_check" BEFORE INSERT ON "Ddt"
  FOR EACH ROW EXECUTE FUNCTION "factory_ddt_check"();

-- DdtCancellation, INSERT (append-only above): it says why. One per DDT is the shipping module's (a unique key of ids
-- alone cannot be copied by the generated isolation tests); a second one changes nothing (the DDT is cancelled).
CREATE FUNCTION "factory_ddt_cancellation_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF btrim(NEW."reason") = '' THEN
    RAISE EXCEPTION 'shipping: the cancellation % of DDT % says why', NEW."id", NEW."ddtId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "DdtCancellation_check" BEFORE INSERT ON "DdtCancellation"
  FOR EACH ROW EXECUTE FUNCTION "factory_ddt_cancellation_check"();

-- TrackingEvent, INSERT (LOG-059; append-only above): its shipment is neither a DRAFT nor CANCELLED (a label exists
-- from PACKED on).
CREATE FUNCTION "factory_tracking_event_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  SELECT sh."status"::text INTO state FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."shipmentId";
  IF FOUND AND state IN ('DRAFT', 'CANCELLED') THEN
    RAISE EXCEPTION 'shipping: shipment % is %; it has no tracking', NEW."shipmentId", state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "TrackingEvent_check" BEFORE INSERT ON "TrackingEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_tracking_event_check"();
