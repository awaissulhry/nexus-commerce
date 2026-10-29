-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202610285000_quality_ppe_register and before the policy migration. When the migrations are renumbered, keep this file
-- as it is under its new timestamp.

-- The PPE register (B-W1-43; QHS-118; Reg. (EU) 2016/425 art. 8(4): the register of complaints, non-conforming PPE and
-- recalls, distributors kept informed; art. 8(8): corrective action, and the authorities told where the PPE presents a
-- risk). apps/factory-api's modules/compliance/register checks all of this first, in words; these rules hold for every
-- login, the owner included. The tenant of a row is held by the policies and the references, not here. Every refusal is
-- a check_violation (SQLSTATE 23514). A trigger reads only tables the role that fires it may read (the office's).
--
-- It redefines 202610283901_quality_shipping_guards' "factory_ppe_register_entry_guard" (the trigger stays): its rules,
-- plus
--   every row   the id lists name rows of the entry's tenant and company (lots, shipments; work orders also of its
--               style: an array element has no foreign key); the source is both a type of the list and an id, or
--               neither; an authority reference only with the date it was told; a corrective action done only with
--               the action written; a close reason exactly when CLOSED.
--   OPEN → CLOSED  a reason; the risk decided (not ASSESSING); the corrective action written and done; when the PPE may
--               present a risk (YES), the authority's date and reference; when garments it concerns left on a SHIPPED
--               or DELIVERED shipment, the distributors informed. "Concerns" is the trace's rule
--               (apps/factory-api modules/compliance/register/trace.ts, factory-domain compliance/register/trace.ts):
--               lines of the work orders it names, of the style's work orders of its batch numbers or that its lots were
--               issued to (an ISSUE not reversed), its named shipments' lines of the style, and lines that hold its
--               serials (garments of the style).
-- and one entry per source record: a partial unique index (tenant, source type, source id).

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
     OR (NEW."sourceType" IS NOT NULL AND NEW."sourceType" NOT IN ('QualityReleaseReversal', 'QualityRelease', 'Inspection', 'Shipment')) THEN
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

-- One entry per source record (a release reversal opens one; a repeated hook finds it).
CREATE UNIQUE INDEX "PpeRegisterEntry_tenantId_sourceType_sourceId_key" ON "PpeRegisterEntry" ("tenantId", "sourceType", "sourceId")
  WHERE "sourceId" IS NOT NULL;
