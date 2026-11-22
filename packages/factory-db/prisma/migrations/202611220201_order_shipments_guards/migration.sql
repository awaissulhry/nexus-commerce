-- Written by hand (Prisma does not model triggers), after the generated 202611220200_order_shipments_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The order shipments tab's ONE schema wave ("order shipments 1/1"; design order-shipments-2026-11-22 13-backend §3, lead settles
-- L12, L13; Owner D4, D6). apps/factory-api checks all of this first and answers in words (B-OS-022 the tracking number per parcel,
-- B-OS-021 the split child's first order, B-OS-017 travels without a DDT); these rules are the last word, for every login, the
-- owner included. The refusals are check_violation (SQLSTATE 23514); their words name no customer (the brand wall).
--
--   Parcel.manualTrackingNumber, manualTrackingUrl   NEW columns (B-OS-020): hidden from the floor (ownership/shipping.json),
--                    read by a portal or link session on its own party.
--   factory_parcel_guard            REDEFINED word for word from its only body (202610283901_quality_shipping_guards), two marked
--                    changes: (a) the floor never changes a carrier label's columns (X2-B3); (b) once the goods left
--                    (SHIPPED, DELIVERED, RETURNED) an UPDATE of the typed number and link alone passes. The words stay.
--   Parcel_manual_tracking_check    NEW: a typed number is 1 to 100 characters on one line, its link https only with it, never
--                    beside a carrier label, only on a CARRIER shipment from PACKED on.
--   Parcel_typed_kept               NEW: a parcel holding a typed number is not removed (clear its number first).
--   Shipment_typed_parcels_transport  NEW, on UPDATE OF "transportBy" ONLY (L12: no Shipment status trigger reads the new Parcel
--                    columns — the floor packs through status updates and cannot read them): no move away from CARRIER while
--                    a parcel holds a typed number. The floor never reaches it (factory_shipment_guard refuses a floor change
--                    of transportBy before).
--   factory_shipment_packing_check  REDEFINED word for word from its only body (202611140203_packing_w2b_guards), one marked
--                    change (B-OS-021, X1-B1; reverses B-OP-041's "a child keeps the parent's first order"): the split child
--                    ships the parent's first order or the order of a line the parent carries. The words stay. Its trigger
--                    Shipment_packing_check stays; it reads no new Parcel column.
--   Shipment_split_first_order      NEW deferred constraint trigger (the Shipment_shipped_has_ddt pattern): at commit a split
--                    child that carries garments carries one of its first order (a child with no line yet passes).
--   factory_ddt_not_elsewhere       REDEFINED word for word from its only body (202611190101_order_page_guards), one marked
--                    change (B-OS-024, L13): no DDT of a shipment set to travel without one. Its trigger Ddt_not_elsewhere stays.
--   Shipment_ddt_required_check     NEW, on UPDATE OF "ddtRequired" from true to false: no live DDT of it (cancel it first).
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok" (…_recall_claims_w2b_guards).

-- =====================================================================================================================
-- Parcel (B-OS-020): REDEFINES factory_parcel_guard (202610283901_quality_shipping_guards, its only body), its whole body; the
-- trigger Parcel_guard stays.
CREATE OR REPLACE FUNCTION "factory_parcel_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
  -- B-OS-020: what still changes of a parcel once its goods left (its typed tracking number and link).
  typed CONSTANT text[] := ARRAY['manualTrackingNumber', 'manualTrackingUrl', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."shipmentId" <> OLD."shipmentId" THEN
      RAISE EXCEPTION 'shipping: parcel % never moves to another shipment', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-OS-020 (X2-B3): the floor packs (cartons, weights, sizes); a carrier label's columns are written by the office alone.
    IF current_user = 'factory_floor_runtime'
       AND (NEW."trackingNumber", NEW."carrierParcelId", NEW."trackingUrl", NEW."labelledAt")
           IS DISTINCT FROM (OLD."trackingNumber", OLD."carrierParcelId", OLD."trackingUrl", OLD."labelledAt") THEN
      RAISE EXCEPTION 'shipping: the carrier label of parcel % is written by the office; the floor packs it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- end B-OS-020
  END IF;
  IF TG_OP = 'INSERT' THEN
    part_of := NEW."shipmentId";
    SELECT sh."status"::text INTO state FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."shipmentId" FOR SHARE;
  ELSE
    part_of := OLD."shipmentId";
    SELECT sh."status"::text INTO state FROM "Shipment" sh WHERE sh."tenantId" = OLD."tenantId" AND sh."id" = OLD."shipmentId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND (state <> 'DRAFT' AND (TG_OP <> 'UPDATE' OR state <> 'PACKED'))
     -- B-OS-020 (Owner D4): once the goods left (SHIPPED, DELIVERED, RETURNED), its typed tracking number and link still change,
     -- nothing else; a CANCELLED shipment's parcels never change.
     AND NOT (TG_OP = 'UPDATE' AND state IN ('SHIPPED', 'DELIVERED', 'RETURNED')
              AND (to_jsonb(NEW) - typed) IS NOT DISTINCT FROM (to_jsonb(OLD) - typed)) THEN
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

-- =====================================================================================================================
-- Parcel (B-OS-020): the tracking number typed by hand for a parcel no label tracks.
--   number     1 to 100 characters on one line; its link only with it: https, up to 500 characters on one line, no user name
--              or password in it (the rule of the Shipment's own typed link, 202611190101_order_page_guards).
--   label      never beside a carrier label of the parcel (a label and a typed number never both).
--   shipment   a CARRIER shipment (booked by hand), PACKED or left (SHIPPED, DELIVERED, RETURNED).
CREATE FUNCTION "factory_parcel_manual_tracking_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shipment record;
BEGIN
  IF NOT "factory_recall_words_ok"(NEW."manualTrackingNumber", 100, false)
     OR (NEW."manualTrackingUrl" IS NOT NULL
         AND (NEW."manualTrackingNumber" IS NULL OR char_length(NEW."manualTrackingUrl") > 500
              OR NEW."manualTrackingUrl" !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?([/?#][^[:space:][:cntrl:]]*)?$')) THEN
    RAISE EXCEPTION 'shipping: parcel % has a tracking number typed by hand of 1 to 100 characters on one line, and a tracking link only with it (https, up to 500 characters, no user name or password)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."trackingNumber" IS NOT NULL OR NEW."carrierParcelId" IS NOT NULL THEN
    RAISE EXCEPTION 'shipping: parcel % carries a carrier label; a label and a tracking number typed by hand never both', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT sh."status"::text AS status, sh."transportBy"::text AS transport_by INTO shipment
    FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."shipmentId";
  IF FOUND AND (shipment.transport_by <> 'CARRIER' OR shipment.status NOT IN ('PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED')) THEN
    RAISE EXCEPTION 'shipping: parcel % takes a tracking number typed by hand only when a carrier carries its shipment and it is packed or left (shipment %)', NEW."id", NEW."shipmentId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Parcel_manual_tracking_check" AFTER INSERT OR UPDATE OF "manualTrackingNumber", "manualTrackingUrl", "trackingNumber", "carrierParcelId" ON "Parcel"
  FOR EACH ROW WHEN (NEW."manualTrackingNumber" IS NOT NULL OR NEW."manualTrackingUrl" IS NOT NULL)
  EXECUTE FUNCTION "factory_parcel_manual_tracking_check"();

-- Parcel (B-OS-020): a parcel holding a typed number is not removed.
CREATE FUNCTION "factory_parcel_typed_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shipping: parcel % holds a tracking number typed by hand; clear its number first', OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "Parcel_typed_kept" BEFORE DELETE ON "Parcel"
  FOR EACH ROW WHEN (OLD."manualTrackingNumber" IS NOT NULL)
  EXECUTE FUNCTION "factory_parcel_typed_kept"();

-- =====================================================================================================================
-- Shipment (B-OS-020, L12): no move away from CARRIER while a parcel holds a typed number. On UPDATE OF "transportBy" only:
-- never a status trigger (the floor packs through status updates and reads none of the new Parcel columns).
CREATE FUNCTION "factory_shipment_typed_parcels_transport"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Parcel" p WHERE p."tenantId" = NEW."tenantId" AND p."shipmentId" = NEW."id" AND p."manualTrackingNumber" IS NOT NULL) THEN
    RAISE EXCEPTION 'shipping: a parcel of shipment % holds a tracking number typed by hand; clear the parcels'' numbers before it travels another way', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Shipment_typed_parcels_transport" AFTER UPDATE OF "transportBy" ON "Shipment"
  FOR EACH ROW WHEN (OLD."transportBy" IS DISTINCT FROM NEW."transportBy" AND NEW."transportBy" <> 'CARRIER')
  EXECUTE FUNCTION "factory_shipment_typed_parcels_transport"();

-- =====================================================================================================================
-- Shipment (B-OS-021): REDEFINES factory_shipment_packing_check (202611140203_packing_w2b_guards, its only body), its whole
-- body; the trigger Shipment_packing_check stays.
CREATE OR REPLACE FUNCTION "factory_shipment_packing_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  short_lines bigint;
  loose_serials bigint;
  crowded bigint;
  stray bigint;
  cartons bigint;
  numbered bigint;
  numbers bigint;
  miscounted bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW."splitFromId" IS NULL) <> (NEW."splitReason" IS NULL) OR coalesce(NEW."splitReason", 'X') !~ '^[^[:space:][:cntrl:]]{1,40}$' THEN
      RAISE EXCEPTION 'packing: shipment % names the shipment it was split from and why (a code of 1 to 40 characters without spaces), both or neither', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."splitFromId" IS NOT NULL THEN
      IF NEW."splitFromId" = NEW."id" THEN
        RAISE EXCEPTION 'packing: shipment % is not split from itself', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT sh."salesOrderId", sh."status"::text AS status INTO parent
        FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."splitFromId" FOR SHARE;
      IF FOUND THEN
        -- B-OS-021 (X1-B1): the child ships the parent's first order, or the order of a line the parent carries at that moment
        -- (the child is made before the parent's lines shrink); the deferred Shipment_split_first_order checks it carries one.
        IF parent."salesOrderId" <> NEW."salesOrderId"
           AND NOT EXISTS (SELECT 1 FROM "ShipmentLine" l
                             JOIN "SalesOrderLine" o ON o."tenantId" = l."tenantId" AND o."id" = l."salesOrderLineId"
                            WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."splitFromId" AND o."orderId" = NEW."salesOrderId") THEN
        -- end B-OS-021
          RAISE EXCEPTION 'packing: shipment % is split from shipment %, which ships another sales order', NEW."id", NEW."splitFromId"
            USING ERRCODE = 'check_violation';
        END IF;
        IF parent.status NOT IN ('DRAFT', 'PACKED') THEN
          RAISE EXCEPTION 'packing: shipment % is split from shipment %, which is %; only a shipment that has not left is split', NEW."id", NEW."splitFromId", parent.status
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
    RETURN NULL;
  END IF;

  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF (NEW."splitFromId", NEW."splitReason") IS DISTINCT FROM (OLD."splitFromId", OLD."splitReason") THEN
    RAISE EXCEPTION 'packing: the shipment % was split from, and why, never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NEW."status" IN ('PACKED', 'SHIPPED') THEN
    PERFORM "factory_packing_refuse_held"(NEW."tenantId", NEW."id",
      CASE WHEN NEW."status" = 'PACKED' THEN 'it is not packed until the hold is released' ELSE 'it is not sent until the hold is released' END);
  END IF;

  IF OLD."status" = 'DRAFT' AND NEW."status" = 'PACKED' THEN
    -- Every line with carton contents is counted exactly.
    SELECT count(*) INTO short_lines
      FROM "ShipmentLine" l
      JOIN (SELECT c."shipmentLineId", sum(c."quantity") AS packed FROM "ParcelLine" c
             WHERE c."tenantId" = NEW."tenantId" AND c."shipmentId" = NEW."id" GROUP BY c."shipmentLineId") c ON c."shipmentLineId" = l."id"
     WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id" AND c.packed <> l."quantity";
    IF short_lines > 0 THEN
      RAISE EXCEPTION 'packing: shipment % is PACKED with the contents of its cartons adding up to each line they hold (% line(s) do not)', NEW."id", short_lines
        USING ERRCODE = 'check_violation';
    END IF;
    -- Each serial of a line with contents lies in a carton that holds that line, no more of them than the contents say; a
    -- packed serial of a line without contents lies in the line's own parcel.
    SELECT count(*) FILTER (WHERE g."parcelId" IS NULL AND EXISTS (SELECT 1 FROM "ParcelLine" c WHERE c."tenantId" = l."tenantId" AND c."shipmentLineId" = l."id")),
           count(*) FILTER (WHERE g."parcelId" IS NOT NULL AND g."parcelId" IS DISTINCT FROM l."parcelId"
                                  AND NOT EXISTS (SELECT 1 FROM "ParcelLine" c WHERE c."tenantId" = l."tenantId" AND c."shipmentLineId" = l."id"))
      INTO loose_serials, stray
      FROM "GarmentSerial" g JOIN "ShipmentLine" l ON l."tenantId" = g."tenantId" AND l."id" = g."shipmentLineId"
     WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id";
    SELECT count(*) INTO crowded
      FROM (SELECT g."shipmentLineId", g."parcelId", count(*) AS n
              FROM "GarmentSerial" g JOIN "ShipmentLine" l ON l."tenantId" = g."tenantId" AND l."id" = g."shipmentLineId"
             WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id" AND g."parcelId" IS NOT NULL
               AND EXISTS (SELECT 1 FROM "ParcelLine" c WHERE c."tenantId" = l."tenantId" AND c."shipmentLineId" = l."id")
             GROUP BY g."shipmentLineId", g."parcelId") packed
     WHERE packed.n > coalesce((SELECT sum(c."quantity") FROM "ParcelLine" c
                                 WHERE c."tenantId" = NEW."tenantId" AND c."shipmentLineId" = packed."shipmentLineId" AND c."parcelId" = packed."parcelId"), 0);
    IF loose_serials > 0 OR crowded > 0 OR stray > 0 THEN
      RAISE EXCEPTION 'packing: shipment % is PACKED with each serial in a carton that holds its line (% serial(s) of a line with carton contents in no carton, % carton(s) holding more serials of a line than its contents, % serial(s) outside their line''s parcel)', NEW."id", loose_serials, crowded, stray
        USING ERRCODE = 'check_violation';
    END IF;
    -- The numbered cartons: each a different n, of N = the shipment's cartons.
    SELECT count(*), count(p."cartonNumber"), count(DISTINCT p."cartonNumber") INTO cartons, numbered, numbers
      FROM "Parcel" p WHERE p."tenantId" = NEW."tenantId" AND p."shipmentId" = NEW."id";
    SELECT count(*) INTO miscounted FROM "Parcel" p
     WHERE p."tenantId" = NEW."tenantId" AND p."shipmentId" = NEW."id" AND p."cartonCount" IS NOT NULL AND p."cartonCount" <> cartons;
    IF numbers <> numbered OR miscounted > 0 THEN
      RAISE EXCEPTION 'packing: shipment % is PACKED with its numbered cartons each a different n, of N = its % carton(s) (reprint the marks)', NEW."id", cartons
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- Shipment (B-OS-021): at commit a split child that carries garments carries one of its first order (the order it was made
-- for); a child with no line yet (made by hand, its lines to follow) passes.
CREATE FUNCTION "factory_shipment_split_first_order"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ShipmentLine" l WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id")
     AND NOT EXISTS (SELECT 1 FROM "ShipmentLine" l
                   JOIN "SalesOrderLine" o ON o."tenantId" = l."tenantId" AND o."id" = l."salesOrderLineId"
                  WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id" AND o."orderId" = NEW."salesOrderId") THEN
    RAISE EXCEPTION 'shipping: shipment % was split from shipment % for a sales order it carries no garment of; a split shipment is made for one of its own orders', NEW."id", NEW."splitFromId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "Shipment_split_first_order" AFTER INSERT ON "Shipment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."splitFromId" IS NOT NULL)
  EXECUTE FUNCTION "factory_shipment_split_first_order"();

-- =====================================================================================================================
-- Ddt (B-OS-024): REDEFINES factory_ddt_not_elsewhere (202611190101_order_page_guards, its only body), its whole body; the
-- trigger Ddt_not_elsewhere stays.
CREATE OR REPLACE FUNCTION "factory_ddt_not_elsewhere"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  made_where text;
  -- B-OS-024: whether a DDT travels with it.
  needs_ddt boolean;
BEGIN
  IF NEW."shipmentId" IS NOT NULL THEN
    SELECT s."origin"::text, s."ddtRequired" INTO made_where, needs_ddt FROM "Shipment" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."shipmentId";
    IF FOUND AND made_where = 'ELSEWHERE' THEN
      RAISE EXCEPTION 'shipping: shipment % was made elsewhere and left with its own papers; Nexus issues no DDT of it (DDT %)', NEW."shipmentId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-OS-024 (O7 B, L13): a shipment set to travel without a DDT gets none (else its goods are billed twice).
    IF FOUND AND NOT needs_ddt THEN
      RAISE EXCEPTION 'shipping: shipment % travels without a DDT; no DDT of it is issued (DDT %): put the DDT back on it first', NEW."shipmentId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- end B-OS-024
  END IF;
  RETURN NULL;
END
$$;

-- Shipment (B-OS-024, L13): the choice "travels without a DDT" is refused while a DDT of it is live (cancel the DDT first).
CREATE FUNCTION "factory_shipment_ddt_required_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Ddt" d
              WHERE d."tenantId" = NEW."tenantId" AND d."shipmentId" = NEW."id"
                AND NOT EXISTS (SELECT 1 FROM "DdtCancellation" x WHERE x."tenantId" = d."tenantId" AND x."ddtId" = d."id")) THEN
    RAISE EXCEPTION 'shipping: shipment % has a live DDT; it travels without one only once that DDT is cancelled', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Shipment_ddt_required_check" AFTER UPDATE OF "ddtRequired" ON "Shipment"
  FOR EACH ROW WHEN (OLD."ddtRequired" AND NOT NEW."ddtRequired")
  EXECUTE FUNCTION "factory_shipment_ddt_required_check"();
