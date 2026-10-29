-- Production › garment labels at the final operation (B-W1-44; MES-076, PRD-348, QHS-051; Q31; A1 §2.1 "Append-only"):
-- the hand-written rules of what 202610285600_production_garment_labels made, for every login (the owner included). The
-- API answers each refusal first, in words (apps/factory-api modules/production/serials); these are the last word.
--
--   GarmentLabelPrint   append-only (UPDATE, DELETE, TRUNCATE refused). An entry prints 1 label or more; a REPRINT has
--                       its reason, a PRINT none; it carries its work order's batch number and the tracking its style
--                       has; a PRINT is of a work order that is RELEASED, IN_PROGRESS or COMPLETED, a REPRINT also of a
--                       CLOSED one. A SERIAL entry names as many serials as labels, each once, each a serial of its cell
--                       that is neither VOID nor SHIPPED; a BATCH entry names none. The database does not hold "no more
--                       labels than finished garments" (finished comes from the scans, and the generated isolation tests
--                       insert a copy of an entry): the API does, under the cell's label lock.
--   GarmentSerial       its bundle (bundleId) is a whole-garment, ACTIVE bundle of its own cell (the reference already
--                       pins the tenant, site and work order), set when the serial is given and never changed.
--   Style               how a style traces its garments (garmentTracking, Q31) no longer changes once its work orders
--                       have garment labels printed, as already once they have serials or quality releases: this
--                       REDEFINES the quality step's factory_style_garment_tracking_guard (202610283901_quality_shipping_guards).
-- The tenant and site columns are left to the policies: a row outside the session's scope is refused by row-level security.

-- ---------------------------------------------------------------------------------------------------------------------
-- GarmentLabelPrint: append-only (scripts/factory/check-append-only.mjs), and its INSERT rules.
CREATE TRIGGER "GarmentLabelPrint_append_only" BEFORE UPDATE OR DELETE ON "GarmentLabelPrint"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "GarmentLabelPrint_no_truncate" BEFORE TRUNCATE ON "GarmentLabelPrint"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_production_ledger_change"();

CREATE FUNCTION "factory_garment_label_print_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
  order_batch text;
  style_tracking text;
  named integer;
  usable integer;
BEGIN
  IF NEW."quantity" < 1 THEN
    RAISE EXCEPTION 'production: label print % prints at least one label', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'REPRINT' AND btrim(coalesce(NEW."reason", '')) = '' THEN
    RAISE EXCEPTION 'production: label reprint % says why the labels are printed again (PRD-348)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'PRINT' AND NEW."reason" IS NOT NULL THEN
    RAISE EXCEPTION 'production: label print % is a first print; only a reprint has a reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."serialIds" IS NULL OR cardinality(NEW."serialIds") <> (SELECT count(DISTINCT s) FROM unnest(NEW."serialIds") AS s) THEN
    RAISE EXCEPTION 'production: label print % names each serial once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."batchNumber") = '' THEN
    RAISE EXCEPTION 'production: label print % carries its work order''s batch number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT w."status"::text, w."batchNumber", s."garmentTracking"::text INTO order_state, order_batch, style_tracking
    FROM "WorkOrder" w JOIN "Style" s ON s."tenantId" = w."tenantId" AND s."id" = w."styleId"
   WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  -- Outside this session's scope the policies refuse the row.
  IF FOUND THEN
    IF NEW."kind" = 'PRINT' AND order_state NOT IN ('RELEASED', 'IN_PROGRESS', 'COMPLETED') THEN
      RAISE EXCEPTION 'production: work order % is %; its garment labels are printed while it is RELEASED, IN_PROGRESS or COMPLETED', NEW."workOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'REPRINT' AND order_state NOT IN ('RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED') THEN
      RAISE EXCEPTION 'production: work order % is %; its garment labels are not printed again', NEW."workOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
    IF order_batch IS DISTINCT FROM NEW."batchNumber" THEN
      RAISE EXCEPTION 'production: label print % carries batch %, work order % has batch %', NEW."id", NEW."batchNumber", NEW."workOrderId", order_batch
        USING ERRCODE = 'check_violation';
    END IF;
    IF style_tracking <> NEW."tracking"::text THEN
      RAISE EXCEPTION 'production: label print % is %, the style of work order % traces by % (Q31)', NEW."id", NEW."tracking", NEW."workOrderId", style_tracking
        USING ERRCODE = 'check_violation';
    END IF;
    -- The serials it names, read in the session's scope like its work order (outside it the policies refuse the row).
    IF NEW."tracking" = 'SERIAL' THEN
      SELECT count(*) INTO usable FROM "GarmentSerial" g
       WHERE g."tenantId" = NEW."tenantId" AND g."workOrderSizeId" = NEW."workOrderSizeId" AND g."id" = ANY (NEW."serialIds")
         AND g."status" NOT IN ('VOID', 'SHIPPED');
      IF usable <> cardinality(NEW."serialIds") THEN
        RAISE EXCEPTION 'production: label print % names serials that are not of cell %, or are void or shipped', NEW."id", NEW."workOrderSizeId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  named := cardinality(NEW."serialIds");
  IF NEW."tracking" = 'BATCH' AND named > 0 THEN
    RAISE EXCEPTION 'production: label print % is of a batch-tracked style; it names no serial', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tracking" = 'SERIAL' AND named <> NEW."quantity" THEN
    RAISE EXCEPTION 'production: label print % prints % label(s) and names % serial(s): one label per serial', NEW."id", NEW."quantity", named
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "GarmentLabelPrint_check" BEFORE INSERT ON "GarmentLabelPrint"
  FOR EACH ROW EXECUTE FUNCTION "factory_garment_label_print_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- GarmentSerial.bundleId (MES-076: the serial's genealogy).
CREATE FUNCTION "factory_garment_serial_bundle_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bundle_cell uuid;
  bundle_part text;
  bundle_state text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."bundleId" IS DISTINCT FROM OLD."bundleId" THEN
      RAISE EXCEPTION 'quality: the bundle of serial % is set when it is given and never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."bundleId" IS NOT NULL THEN
    SELECT b."workOrderSizeId", b."part", b."status"::text INTO bundle_cell, bundle_part, bundle_state
      FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."id" = NEW."bundleId";
    IF FOUND AND (bundle_cell <> NEW."workOrderSizeId" OR bundle_part IS NOT NULL OR bundle_state <> 'ACTIVE') THEN
      RAISE EXCEPTION 'quality: serial % names bundle %, which is not an active whole-garment bundle of its cell', NEW."id", NEW."bundleId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "GarmentSerial_bundle_guard" BEFORE INSERT OR UPDATE ON "GarmentSerial"
  FOR EACH ROW EXECUTE FUNCTION "factory_garment_serial_bundle_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Style.garmentTracking (Q31): REDEFINED from 202610283901_quality_shipping_guards, with the garment labels printed.
CREATE OR REPLACE FUNCTION "factory_style_garment_tracking_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "GarmentSerial" g JOIN "WorkOrder" w ON w."tenantId" = g."tenantId" AND w."id" = g."workOrderId"
              WHERE g."tenantId" = NEW."tenantId" AND w."styleId" = NEW."id")
     OR EXISTS (SELECT 1 FROM "QualityRelease" r JOIN "WorkOrder" w ON w."tenantId" = r."tenantId" AND w."id" = r."workOrderId"
                 WHERE r."tenantId" = NEW."tenantId" AND w."styleId" = NEW."id")
     OR EXISTS (SELECT 1 FROM "GarmentLabelPrint" p JOIN "WorkOrder" w ON w."tenantId" = p."tenantId" AND w."id" = p."workOrderId"
                 WHERE p."tenantId" = NEW."tenantId" AND w."styleId" = NEW."id") THEN
    RAISE EXCEPTION 'quality: style % has work orders with garment labels, serials or quality releases; how its garments are traced (%) no longer changes (Q31)', NEW."id", OLD."garmentTracking"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
