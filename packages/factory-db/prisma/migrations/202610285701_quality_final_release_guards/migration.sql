-- Written by hand (Prisma does not model triggers or deferred constraint triggers), after the generated
-- 202610285700_quality_final_release and before the policy migration. When the migrations are renumbered, keep this file
-- as it is under its new timestamp.
--
-- Quality › final inspection and release by an inspector who is not a maker (B-W1-45; QHS-013, QHS-050, QHS-051,
-- QHS-058, QHS-073, QHS-300, PLT-097; Owner answer Q1 (a): four eyes as a setting; Reg. (EU) 2016/425 arts. 8, 15; A1
-- §2.5 "Final release"). apps/factory-api's modules/quality/final checks all of this first and answers in words; these
-- rules hold for every login, the owner included. Every refusal is a check_violation (SQLSTATE 23514). This file
-- REDEFINES functions of 202610283901_quality_shipping_guards (CREATE OR REPLACE; their triggers stay):
--
--   makers        factory_quality_worker_made / _makers_unnamed / _check_not_maker: a worker who made a bundle of the
--                 work order (not VOID) made its garments too, as a cut log or a report or correction scan says; a
--                 bundle made on a device that names nobody (a station site) leaves a maker unnamed; an office user who
--                 made a bundle in the office made garments. The link of an office user to a worker (Worker.userId) is
--                 read only outside the floor role (the floor may not read that column and never names an office user).
--   Inspection    factory_inspection_guard: when decided, the database writes the computed result (QHS-013: any critical
--                 defect, more major or minor defective garments than the acceptance numbers, or a checklist item not
--                 ok FAILS); the decision differs from it exactly when the inspector wrote why (overrideReason). A PASS
--                 over a computed FAIL only when no critical defect and no checklist item not ok made it fail (the
--                 acceptance numbers alone); a critical defect is never accepted. An OPEN or CANCELLED inspection has
--                 neither a computed result nor an override reason.
--   QualityRelease  factory_quality_release_check: exactly one releaser, an office user or a floor inspector of the
--                 site (the floor names a worker, never an office user); the releaser made none of the garments. Four
--                 eyes as a setting: the database writes why a second person is needed (secondPersonReasons: OVERRIDE
--                 when the inspection overrode its computed result; CUSTOMER when the cell's customer is on the
--                 company's or the tenant-wide list in QualitySettings; ALWAYS when the company's rule, else the
--                 tenant-wide one, is ALWAYS; the default WHEN_REQUIRED), and then the releaser is not the inspector who
--                 signed the result: not the same worker or user, nor (read by the office) a worker linked to the other's
--                 user. The rest is as before (PASSED inspection, the cell and lot caps, the certificate gate).
--   QualityReleaseReversal  factory_quality_release_reversal_check: a reason's kind on every new reversal, and where the
--                 named serials go (serialsTo MADE or VOID) exactly when it names serials; at commit
--                 (factory_quality_release_reversal_serials_moved) each named serial is in that state.
--   GarmentSerial factory_garment_serial_guard: the floor moves a serial MADE → RELEASED too (a floor inspector's release
--                 names it); taking it back (RELEASED → MADE | VOID) and shipping stay the office's.
--   QualitySettings  (a new trigger) the customers that always need a second person are distinct parties of the tenant
--                 with the CUSTOMER or BRAND role.
--
-- No new table; the append-only ledgers (QualityRelease, QualityReleaseReversal) keep their triggers. The labels printed
-- and the material lots on hold are the API's release gate, not the database's: the label log and the issue ledger are
-- other modules' rows, and the generated isolation tests insert a copy of a release.

-- ---------------------------------------------------------------------------------------------------------------------
-- The makers (four eyes): bundles count too (REDEFINES 202610283901's three functions).
CREATE OR REPLACE FUNCTION "factory_quality_worker_made"(tenant uuid, work_order uuid, worker uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "CutLog" c
                  WHERE c."tenantId" = tenant AND c."workOrderId" = work_order AND c."workerId" = worker AND c."reversalOfId" IS NULL)
      OR EXISTS (SELECT 1 FROM "OperationScan" s
                  WHERE s."tenantId" = tenant AND s."workOrderId" = work_order AND s."workerId" = worker
                    AND s."kind" IN ('REPORT', 'CORRECTION'))
      OR EXISTS (SELECT 1 FROM "Bundle" b
                  WHERE b."tenantId" = tenant AND b."workOrderId" = work_order AND b."createdById" = worker AND b."status" <> 'VOID')
$$;

CREATE OR REPLACE FUNCTION "factory_quality_makers_unnamed"(tenant uuid, work_order uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "CutLog" c
                  WHERE c."tenantId" = tenant AND c."workOrderId" = work_order AND c."workerId" IS NULL AND c."reversalOfId" IS NULL)
      OR EXISTS (SELECT 1 FROM "OperationScan" s
                  WHERE s."tenantId" = tenant AND s."workOrderId" = work_order AND s."workerId" IS NULL
                    AND s."kind" IN ('REPORT', 'CORRECTION'))
      OR EXISTS (SELECT 1 FROM "Bundle" b
                  WHERE b."tenantId" = tenant AND b."workOrderId" = work_order AND b."deviceId" IS NOT NULL AND b."createdById" IS NULL
                    AND b."status" <> 'VOID')
$$;

CREATE OR REPLACE FUNCTION "factory_quality_check_not_maker"(tenant uuid, work_order uuid, worker uuid, office_user uuid, signed_statement boolean, what text, row_id uuid)
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
  -- An office user: a bundle made in the office names them; a worker linked to them is read only by the office (the floor
  -- may not read Worker.userId, and never names an office user itself: the API checks the link for a floor release).
  IF office_user IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "Bundle" b
                WHERE b."tenantId" = tenant AND b."workOrderId" = work_order AND b."deviceId" IS NULL AND b."createdById" = office_user
                  AND b."status" <> 'VOID') THEN
      RAISE EXCEPTION 'quality: user % made bundles of work order %; the % % is by someone who made none of the garments (four-eyes, Reg. 2016/425)', office_user, work_order, what, row_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user <> 'factory_floor_runtime' THEN
      SELECT w."id" INTO linked FROM "Worker" w
       WHERE w."tenantId" = tenant AND w."userId" = office_user AND "factory_quality_worker_made"(tenant, work_order, w."id")
       LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'quality: user % is worker %, who made garments of work order %; the % % is by someone who made none of them (four-eyes, Reg. 2016/425)', office_user, linked, work_order, what, row_id
          USING ERRCODE = 'check_violation';
      END IF;
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
-- Inspection: the computed result and the override (REDEFINES 202610283901's factory_inspection_guard).
CREATE OR REPLACE FUNCTION "factory_inspection_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  order_state text;
  pieces bigint;
  critical bigint;
  major bigint;
  minor bigint;
  checklist_fails boolean;
  computed "InspectionResult";
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
  -- The computed result and an override's reason belong to the decision (an OPEN or CANCELLED inspection has neither;
  -- the decision below writes the computed result).
  IF NEW."status" NOT IN ('PASSED', 'FAILED') AND (NEW."computedResult" IS NOT NULL OR NEW."overrideReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: inspection % is %; only a decided inspection has a computed result or an override reason', NEW."id", NEW."status"
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
    -- The computed result (QHS-013): any critical defect, more major or minor defective garments than the acceptance
    -- numbers, or a checklist item not ok FAILS; written here, never by the API.
    checklist_fails := jsonb_path_exists(NEW."checklist", '$[*] ? (@.ok == false)');
    computed := CASE WHEN critical > 0 OR major > NEW."acceptMajor" OR minor > NEW."acceptMinor" OR checklist_fails THEN 'FAIL'::"InspectionResult" ELSE 'PASS'::"InspectionResult" END;
    NEW."computedResult" := computed;
    IF NEW."status" = 'PASSED' THEN
      IF critical > 0 THEN
        RAISE EXCEPTION 'quality: inspection % found % critical defect(s); a critical defect is never accepted, it FAILS', NEW."id", critical
          USING ERRCODE = 'check_violation';
      END IF;
      IF checklist_fails THEN
        RAISE EXCEPTION 'quality: inspection % has a checklist item that is not ok; it does not PASS', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (major > NEW."acceptMajor" OR minor > NEW."acceptMinor") AND btrim(coalesce(NEW."overrideReason", '')) = '' THEN
        RAISE EXCEPTION 'quality: inspection % found % major and % minor defective garment(s); its plan accepts % and %, so it FAILS (a PASS over it is an override with the inspector''s written reason, QHS-013)', NEW."id", major, minor, NEW."acceptMajor", NEW."acceptMinor"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    -- An override (QHS-013): the decision differs from the computed result exactly when the inspector wrote why.
    IF (NEW."status" = 'PASSED') <> (computed = 'PASS') AND btrim(coalesce(NEW."overrideReason", '')) = '' THEN
      RAISE EXCEPTION 'quality: inspection % is decided % against its computed result %; an override carries the inspector''s written reason (QHS-013)', NEW."id", NEW."status", computed
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."status" = 'PASSED') = (computed = 'PASS') AND NEW."overrideReason" IS NOT NULL THEN
      RAISE EXCEPTION 'quality: inspection % is decided % as computed; it has no override reason', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- QualityRelease: one releaser (office user or floor inspector), four eyes as a setting (REDEFINES 202610283901's
-- factory_quality_release_check).
CREATE OR REPLACE FUNCTION "factory_quality_release_check"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  reasons "ReleaseSecondPersonReason"[] := ARRAY[]::"ReleaseSecondPersonReason"[];
  company_rule text;
  tenant_rule text;
  company_parties uuid[];
  tenant_parties uuid[];
  same_person boolean;
BEGIN
  IF NEW."quantity" < 1 OR btrim(NEW."signatureSha256") = '' THEN
    RAISE EXCEPTION 'quality: release % is of at least one garment, signed', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."releasedById" IS NULL) = (NEW."releasedByWorkerId" IS NULL) THEN
    RAISE EXCEPTION 'quality: release % names exactly one releaser: an office user or a floor inspector of the site', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'factory_floor_runtime' AND NEW."releasedById" IS NOT NULL THEN
    RAISE EXCEPTION 'quality: the floor records the release of a worker (the signed-in floor inspector), not of an office user (release %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- Why a second person is needed (Owner answer Q1 (a)): written here from the inspection and the company's rules.
  NEW."secondPersonReasons" := ARRAY[]::"ReleaseSecondPersonReason"[];
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
  SELECT i."status"::text AS status, i."lotSize", i."inspectorWorkerId", i."inspectorUserId", i."notMakerStatement", i."overrideReason" INTO inspection
    FROM "Inspection" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."inspectionId";
  IF FOUND AND inspection.status <> 'PASSED' THEN
    RAISE EXCEPTION 'quality: inspection % is %; garments are released only from a PASSED inspection (QHS-058)', NEW."inspectionId", inspection.status
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.release', NEW."tenantId", NEW."workOrderId"), 0));
  SELECT c."quantity", c."colourwayId", c."size", c."measurementProfileId", c."partyId" INTO cell
    FROM "WorkOrderSize" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."workOrderSizeId";
  IF FOUND THEN
    SELECT (SELECT coalesce(sum(r."quantity"), 0) FROM "QualityRelease" r WHERE r."tenantId" = NEW."tenantId" AND r."workOrderSizeId" = NEW."workOrderSizeId")
         - (SELECT coalesce(sum(v."quantity"), 0) FROM "QualityReleaseReversal" v WHERE v."tenantId" = NEW."tenantId" AND v."workOrderSizeId" = NEW."workOrderSizeId")
      INTO released;
    IF released + NEW."quantity" > cell."quantity" THEN
      RAISE EXCEPTION 'quality: cell % has % piece(s) and % released (less reversals); release % of % more is refused', NEW."workOrderSizeId", cell."quantity", released, NEW."id", NEW."quantity"
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
  PERFORM "factory_quality_check_not_maker"(NEW."tenantId", NEW."workOrderId", NEW."releasedByWorkerId", NEW."releasedById", true, 'release', NEW."id");

  -- Four eyes as a setting (Owner answer Q1 (a); QualitySettings: the company's row, else the tenant-wide one, else
  -- WHEN_REQUIRED; the customers listed on either row): OVERRIDE when the inspection overrode its computed result,
  -- CUSTOMER when the cell's customer is listed, ALWAYS when the rule asks it for every release.
  IF inspection.status IS NOT NULL AND inspection."overrideReason" IS NOT NULL THEN
    reasons := reasons || 'OVERRIDE'::"ReleaseSecondPersonReason";
  END IF;
  SELECT q."releaseFourEyes"::text, q."secondPersonPartyIds" INTO company_rule, company_parties
    FROM "QualitySettings" q WHERE q."tenantId" = NEW."tenantId" AND q."id" = NEW."companyId";
  SELECT q."releaseFourEyes"::text, q."secondPersonPartyIds" INTO tenant_rule, tenant_parties
    FROM "QualitySettings" q WHERE q."tenantId" = NEW."tenantId" AND q."id" = NEW."tenantId";
  IF cell."partyId" IS NOT NULL AND cell."partyId" = ANY (coalesce(company_parties, ARRAY[]::uuid[]) || coalesce(tenant_parties, ARRAY[]::uuid[])) THEN
    reasons := reasons || 'CUSTOMER'::"ReleaseSecondPersonReason";
  END IF;
  IF coalesce(company_rule, tenant_rule, 'WHEN_REQUIRED') = 'ALWAYS' THEN
    reasons := reasons || 'ALWAYS'::"ReleaseSecondPersonReason";
  END IF;
  NEW."secondPersonReasons" := reasons;
  -- Then the release is the second signature: the releaser is not the inspector who signed the result (the same worker,
  -- the same user, or, read only by the office, a worker linked to the other's user).
  IF cardinality(reasons) > 0 AND inspection.status IS NOT NULL THEN
    same_person := (NEW."releasedByWorkerId" IS NOT NULL AND NEW."releasedByWorkerId" = inspection."inspectorWorkerId")
                OR (NEW."releasedById" IS NOT NULL AND NEW."releasedById" = inspection."inspectorUserId");
    IF NOT same_person AND current_user <> 'factory_floor_runtime' THEN
      same_person := EXISTS (SELECT 1 FROM "Worker" w
                              WHERE w."tenantId" = NEW."tenantId"
                                AND ((w."id" = inspection."inspectorWorkerId" AND w."userId" = NEW."releasedById")
                                     OR (w."id" = NEW."releasedByWorkerId" AND w."userId" = inspection."inspectorUserId")));
    END IF;
    IF same_person THEN
      RAISE EXCEPTION 'quality: release % needs a second person (%): the inspector who signed inspection % does not release it alone (four eyes, Owner answer Q1)', NEW."id", array_to_string(reasons, ', '), NEW."inspectionId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

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

-- ---------------------------------------------------------------------------------------------------------------------
-- QualityReleaseReversal: the reason's kind, where the serials go (REDEFINES 202610283901's two reversal functions).
CREATE OR REPLACE FUNCTION "factory_quality_release_reversal_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  release record;
  tracking text;
  reversed bigint;
  released bigint;
  shipped bigint;
  wrong uuid;
BEGIN
  IF NEW."quantity" < 1 OR btrim(NEW."reason") = '' THEN
    RAISE EXCEPTION 'quality: reversal % takes back at least one garment and says why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reasonCode" IS NULL THEN
    RAISE EXCEPTION 'quality: reversal % says why as a kind too (wrong result, defect found later, certificate problem, customer complaint, recall)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (cardinality(NEW."serialIds") > 0) <> (NEW."serialsTo" IS NOT NULL) OR NEW."serialsTo" NOT IN ('MADE', 'VOID') THEN
    RAISE EXCEPTION 'quality: reversal % says where the serials it names go (MADE for rework, VOID for scrap), exactly when it names serials', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r."quantity", r."workOrderId" INTO release
    FROM "QualityRelease" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."releaseId";
  IF NOT FOUND THEN
    -- Outside this session's scope: the policies refuse the row.
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.release', NEW."tenantId", NEW."workOrderId"), 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.ship-cell', NEW."tenantId", NEW."workOrderSizeId"), 0));
  SELECT coalesce(sum(v."quantity"), 0) INTO reversed
    FROM "QualityReleaseReversal" v WHERE v."tenantId" = NEW."tenantId" AND v."releaseId" = NEW."releaseId";
  IF reversed + NEW."quantity" > release."quantity" THEN
    RAISE EXCEPTION 'quality: release % released % garment(s), % reversed already; reversal % of % more is refused', NEW."releaseId", release."quantity", reversed, NEW."id", NEW."quantity"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT (SELECT coalesce(sum(r."quantity"), 0) FROM "QualityRelease" r WHERE r."tenantId" = NEW."tenantId" AND r."workOrderSizeId" = NEW."workOrderSizeId")
       - (SELECT coalesce(sum(v."quantity"), 0) FROM "QualityReleaseReversal" v WHERE v."tenantId" = NEW."tenantId" AND v."workOrderSizeId" = NEW."workOrderSizeId")
    INTO released;
  SELECT coalesce(sum(l."quantity"), 0) INTO shipped
    FROM "ShipmentLine" l JOIN "Shipment" sh ON sh."tenantId" = l."tenantId" AND sh."id" = l."shipmentId"
   WHERE l."tenantId" = NEW."tenantId" AND l."workOrderSizeId" = NEW."workOrderSizeId" AND sh."status" <> 'CANCELLED';
  IF released - NEW."quantity" < shipped THEN
    RAISE EXCEPTION 'quality: cell % has % garment(s) released and % on shipments; reversal % of % would take back garments a shipment holds (remove the line or cancel the shipment first)', NEW."workOrderSizeId", released, shipped, NEW."id", NEW."quantity"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s."garmentTracking"::text INTO tracking
    FROM "WorkOrder" w JOIN "Style" s ON s."tenantId" = w."tenantId" AND s."id" = w."styleId"
   WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
  IF tracking = 'SERIAL' THEN
    IF cardinality(NEW."serialIds") <> NEW."quantity" OR (SELECT count(DISTINCT x) FROM unnest(NEW."serialIds") AS x) <> NEW."quantity" THEN
      RAISE EXCEPTION 'quality: reversal % of a serial-tracked release names exactly its % serial(s) (Q31)', NEW."id", NEW."quantity"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT x INTO wrong FROM unnest(NEW."serialIds") AS x
     WHERE NOT EXISTS (SELECT 1 FROM "GarmentSerial" g
                        WHERE g."tenantId" = NEW."tenantId" AND g."id" = x AND g."workOrderSizeId" = NEW."workOrderSizeId"
                          AND g."releaseId" = NEW."releaseId" AND g."status" = 'RELEASED' AND g."shipmentLineId" IS NULL)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'quality: reversal % names serial %, which is not a RELEASED, unpacked serial of release %', NEW."id", wrong, NEW."releaseId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF cardinality(NEW."serialIds") > 0 THEN
    RAISE EXCEPTION 'quality: reversal % is of a batch-tracked release; it names no serial', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "factory_quality_release_reversal_serials_moved"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  still uuid;
BEGIN
  SELECT g."id" INTO still FROM "GarmentSerial" g
   WHERE g."tenantId" = NEW."tenantId" AND g."id" = ANY (NEW."serialIds") AND g."releaseId" = NEW."releaseId" AND g."status" = 'RELEASED'
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'quality: serial % is still RELEASED; reversal % takes it back to MADE or VOID in the same transaction', still, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT g."id" INTO still FROM "GarmentSerial" g
   WHERE g."tenantId" = NEW."tenantId" AND g."id" = ANY (NEW."serialIds") AND g."releaseId" = NEW."releaseId" AND g."status"::text <> NEW."serialsTo"::text
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'quality: serial % did not go to % as reversal % says', still, NEW."serialsTo", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- GarmentSerial: a floor release moves its serials MADE → RELEASED (REDEFINES 202610283901's factory_garment_serial_guard;
-- one line changed).
CREATE OR REPLACE FUNCTION "factory_garment_serial_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
                OR (OLD."status" = 'RELEASED' AND NEW."status" IN ('SHIPPED', 'MADE', 'VOID'))) THEN
      RAISE EXCEPTION 'quality: serial % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."releaseId" IS DISTINCT FROM OLD."releaseId" AND NOT (OLD."status" = 'MADE' AND NEW."status" = 'RELEASED') THEN
      RAISE EXCEPTION 'quality: the release of serial % is named only when it is released', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime' AND NEW."status" <> OLD."status" AND NOT (OLD."status" = 'MADE' AND NEW."status" IN ('VOID', 'RELEASED')) THEN
      RAISE EXCEPTION 'quality: the floor releases, packs, unpacks and voids serials; taking back and shipping serial % are the office''s', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'MADE' AND NEW."status" = 'RELEASED' AND NEW."releaseId" IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.serial-release', NEW."tenantId", NEW."releaseId"), 0));
      IF EXISTS (SELECT 1 FROM "QualityReleaseReversal" v WHERE v."tenantId" = NEW."tenantId" AND v."releaseId" = NEW."releaseId" AND NEW."id" = ANY (v."serialIds")) THEN
        RAISE EXCEPTION 'quality: release % took serial % back; it is released again only by a new release (after a new inspection)', NEW."releaseId", NEW."serial"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."quantity" - (SELECT coalesce(sum(v."quantity"), 0) FROM "QualityReleaseReversal" v WHERE v."tenantId" = r."tenantId" AND v."releaseId" = r."id")
        INTO allowed FROM "QualityRelease" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."releaseId";
      SELECT count(*) INTO taken FROM "GarmentSerial" g
       WHERE g."tenantId" = NEW."tenantId" AND g."releaseId" = NEW."releaseId" AND g."status" IN ('RELEASED', 'SHIPPED') AND g."id" <> NEW."id";
      IF allowed IS NOT NULL AND taken + 1 > allowed THEN
        RAISE EXCEPTION 'quality: release % holds % garment(s) (less reversals), and % serial(s) name it; serial % is one too many', NEW."releaseId", allowed, taken, NEW."serial"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    IF OLD."status" = 'RELEASED' AND NEW."status" IN ('MADE', 'VOID')
       AND NOT EXISTS (SELECT 1 FROM "QualityReleaseReversal" v WHERE v."tenantId" = OLD."tenantId" AND v."releaseId" = OLD."releaseId" AND OLD."id" = ANY (v."serialIds")) THEN
      RAISE EXCEPTION 'quality: serial % is RELEASED by release %; it goes back to % only through a reversal of that release that names it (corrective action)', OLD."id", OLD."releaseId", NEW."status"
        USING ERRCODE = 'check_violation';
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
     OR (NEW."status" = 'MADE' AND NEW."shipmentLineId" IS NOT NULL)
     OR (NEW."status" IN ('RELEASED', 'SHIPPED') AND NEW."releaseId" IS NULL)
     OR (NEW."status" = 'SHIPPED' AND NEW."shipmentLineId" IS NULL)
     OR (NEW."status" = 'VOID' AND NEW."shipmentLineId" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: serial % is % with the wrong release or shipment line (MADE: no line; RELEASED: its release; SHIPPED: its release and line; VOID: no line)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'VOID') <> (NEW."voidedAt" IS NOT NULL) OR (NEW."status" = 'VOID') <> (btrim(coalesce(NEW."voidReason", '')) <> '') THEN
    RAISE EXCEPTION 'quality: serial % is % with the wrong voiding: a void serial has its time and reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- QualitySettings: the customers whose garments always need a second person at release (Owner answer Q1 (a)).
--   INSERT, UPDATE  secondPersonPartyIds is a list (not null) of distinct parties of the tenant with the CUSTOMER or
--                   BRAND role (a party this session cannot read is refused: the office reads every party), checked when
--                   the row is made and whenever the list changes (a later change of a party's roles never blocks the
--                   row's other settings).
CREATE FUNCTION "factory_quality_settings_release_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wrong uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."secondPersonPartyIds" IS NOT DISTINCT FROM OLD."secondPersonPartyIds" THEN
    RETURN NEW;
  END IF;
  IF NEW."secondPersonPartyIds" IS NULL THEN
    RAISE EXCEPTION 'quality: settings % list the customers that need a second person as a list (empty: none)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(NEW."secondPersonPartyIds") AS x) <> cardinality(NEW."secondPersonPartyIds") THEN
    RAISE EXCEPTION 'quality: settings % list each customer that needs a second person once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT x INTO wrong FROM unnest(NEW."secondPersonPartyIds") AS x
   WHERE NOT EXISTS (SELECT 1 FROM "Party" p
                      WHERE p."tenantId" = NEW."tenantId" AND p."id" = x AND ('CUSTOMER' = ANY (p."roles") OR 'BRAND' = ANY (p."roles")))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'quality: party % is not a customer of the tenant; settings % list customers whose garments need a second person', wrong, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QualitySettings_release_guard" BEFORE INSERT OR UPDATE ON "QualitySettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_quality_settings_release_guard"();
