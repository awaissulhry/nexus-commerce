-- Written by hand (Prisma does not model triggers), after the generated 202610316400_followups_f1_w2b_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp, and keep it
-- OUT of prisma/migrations while `npm run migration` runs (it needs Shipment."carrierReturnReceivedAt").
--
-- W2b schema follow-ups (B-W2b-F1) that the W2b-0 steps named (B-W2b-17 quality, B-W2b-19 shipping, B-W2b-16 returns).
-- Every function below is REDEFINED whole (CREATE OR REPLACE, copied from its latest definition; its triggers stay);
-- what changes is named in the comment above each one (B-W2b-F1). Every refusal is a check_violation (SQLSTATE 23514);
-- the API answers first, in words.
--
--   holds      factory_quality_hold_number_guard (…_followups_quality_money_w2b_guards): a NEW hold comes numbered
--              (every API path numbers it since B-W2b-17). A guard, not NOT NULL: the holds placed before numbering keep
--              their null (a NOT NULL would need their numbers allocated from the HOLD series inside this migration, and
--              would make the client's `number` a string for every reader of an older hold).
--   shipping   factory_shipment_guard (…_followups_stock_w2b_guards): Shipment."carrierReturnReceivedAt" (the warehouse
--              had a RETURNED shipment's garments back: apps/factory-api's carrier return) is set once, only while
--              RETURNED, never changed or cleared.
--              factory_shipment_line_guard (…_quality_shipping_guards): the release cap (QHS-058: a cell's lines over
--              its shipments never pass its releases less reversals) no longer counts a RETURNED shipment whose garments
--              came back, so the same cell ships them again. The release reversal check keeps counting it (its API
--              twin in modules/quality/final does too): a returned garment's release is not taken back yet.
--              factory_garment_serial_guard (…_quality_final_release_guards): a SHIPPED serial of such a shipment goes
--              back to RELEASED, unpacked (the office's; nothing else changes), to be packed on a new shipment.
--   register   factory_ppe_register_entry_guard (…_quality_plant_w2a_guards): one more source type, the customer's
--              return (ReturnAuthorisation, B-W2a-43's RMA: Z4:02). The partial unique index stays one entry per source,
--              so one entry per return: apps/factory-api's modules/sales/returns names every shipment its lines came
--              from in that one entry.
-- Data: a RETURNED shipment whose carrier return was received before this migration (its ADJUSTMENT moves with the
-- key `shipping.carrierReturn:<shipment id>:<n>`, B-W2b-19) gets the time of its first such move.

-- =====================================================================================================================
-- Holds: a new hold comes numbered
-- =====================================================================================================================

-- QualityHold.number (HLD-…): given when the hold is placed, or once later for a hold placed before the series existed
-- (while ACTIVE: …_quality_plant_w2a_guards freezes a released or closed hold, and the floor changes only its quarantine
-- move and release); never changed, never blank. B-W2b-F1: a new hold always comes with it.
CREATE OR REPLACE FUNCTION "factory_quality_hold_number_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- B-W2b-F1: a new hold comes numbered (every API path numbers it since B-W2b-17; the floor's bench takes the number in
  -- its own command first).
  IF TG_OP = 'INSERT' AND NEW."number" IS NULL THEN
    RAISE EXCEPTION 'quality: hold % is numbered when it is placed (its company''s HOLD series gives the number)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."number" IS NOT NULL AND NEW."number" IS DISTINCT FROM OLD."number" THEN
    RAISE EXCEPTION 'quality: hold % has number %; it never changes', OLD."id", OLD."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."number" IS NOT NULL AND btrim(NEW."number") = '' THEN
    RAISE EXCEPTION 'quality: hold %''s number is never blank (its company''s HOLD series gives it)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- Shipping: the garments of a carrier-returned shipment ship again
-- =====================================================================================================================

-- Shipment: REDEFINES factory_shipment_guard (202610311001_followups_stock_w2b_guards), its whole body. Its rules stand;
-- B-W2b-F1: carrierReturnReceivedAt is set once while the shipment is RETURNED (the carrier return of
-- apps/factory-api's modules/shipping, after the carrier's tracking said RETURNED), never changed or cleared, and only a
-- RETURNED shipment has it. The floor still changes nothing but DRAFT ⇄ PACKED.
CREATE OR REPLACE FUNCTION "factory_shipment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  -- W2a: what still changes once the goods left.
  after_leaving CONSTANT text[] := ARRAY['freightCharge', 'transportEvidence', 'transportEvidenceAt', 'transportEvidenceById', 'transportEvidenceNote',
    -- W2b: how the charge was decided, what the carrier charged us (its invoice comes later) and the mode of transport.
    'freightBasis', 'freightCost', 'freightCostCurrency', 'transportMode'];
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
    -- B-W2b-F1: the garments of a shipment the carrier brought back are received once, while it is RETURNED; that time
    -- never changes and never goes back to null.
    IF NEW."carrierReturnReceivedAt" IS DISTINCT FROM OLD."carrierReturnReceivedAt"
       AND NOT (OLD."status" = 'RETURNED' AND NEW."status" = 'RETURNED' AND OLD."carrierReturnReceivedAt" IS NULL) THEN
      RAISE EXCEPTION 'shipping: shipment %''s garments are received back once, after the carrier returned it (RETURNED); that time never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CANCELLED'
       AND (to_jsonb(NEW) - (kept || ARRAY['internalNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'shipping: shipment % is %; only its internal note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2a: after delivery (or the return) the freight charged and the transport evidence still change (LOG-105, LOG-090).
    IF OLD."status" IN ('DELIVERED', 'RETURNED')
       AND (to_jsonb(NEW) - (kept || after_leaving || ARRAY['internalNote', 'version', 'updatedAt', 'carrierReturnReceivedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || after_leaving || ARRAY['internalNote', 'version', 'updatedAt', 'carrierReturnReceivedAt'])) THEN
      RAISE EXCEPTION 'shipping: shipment % is %; only its internal note changes (and, W2a, the freight charged and its transport evidence)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'SHIPPED'
       AND (to_jsonb(NEW) - (kept || after_leaving || ARRAY['status', 'deliveredAt', 'returnedAt', 'internalNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || after_leaving || ARRAY['status', 'deliveredAt', 'returnedAt', 'internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'shipping: shipment % left; only its delivery or return and its internal note change (and, W2a, the freight charged and its transport evidence)', OLD."id"
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
  IF NEW."carrierReturnReceivedAt" IS NOT NULL AND NEW."status" <> 'RETURNED' THEN
    RAISE EXCEPTION 'shipping: shipment % is %; its garments are received back only once the carrier returned it (RETURNED)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'shipping: shipment % is % with the wrong cancellation (a cancelled shipment has its time and reason)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2a: the freight charged from 0 (LOG-105); transport evidence only once the goods left, COMPLETE exactly with when and
  -- who checked it (LOG-090; art. 41 DL 331/93).
  IF coalesce(NEW."freightCharge", 0) < 0 THEN
    RAISE EXCEPTION 'shipping: the freight charged for shipment % is 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b (B-W2a-48): the freight basis only with a freight charge; the freight cost from 0 with its ISO 4217 currency
  -- (both or neither).
  IF NEW."freightBasis" IS NOT NULL AND NEW."freightCharge" IS NULL THEN
    RAISE EXCEPTION 'shipping: shipment % says how its freight charge was decided only when it has one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(NEW."freightCost", 0) < 0 OR (NEW."freightCost" IS NULL) <> (NEW."freightCostCurrency" IS NULL)
     OR coalesce(NEW."freightCostCurrency", 'EUR') !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'shipping: the freight cost of shipment % is 0 or more, with its ISO 4217 currency (both or neither)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."transportEvidence" <> 'NOT_NEEDED' AND NEW."status" NOT IN ('SHIPPED', 'DELIVERED', 'RETURNED'))
     OR (NEW."transportEvidence" = 'COMPLETE') <> (NEW."transportEvidenceAt" IS NOT NULL)
     OR (NEW."transportEvidence" = 'COMPLETE') <> (NEW."transportEvidenceById" IS NOT NULL) THEN
    RAISE EXCEPTION 'shipping: shipment % is % with transport evidence %: evidence is kept once the goods left, and COMPLETE exactly with when and who checked it', NEW."id", NEW."status", NEW."transportEvidence"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ShipmentLine: REDEFINES factory_shipment_line_guard (202610283901_quality_shipping_guards), its whole body. Its rules
-- stand; B-W2b-F1: the release cap counts the lines of every shipment that is not CANCELLED, but a RETURNED one whose
-- garments the warehouse received back (carrierReturnReceivedAt): those garments are in finished goods again and ship
-- on a new shipment of the same cell. The cell's shipping lock and its order stay as they were.
CREATE OR REPLACE FUNCTION "factory_shipment_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  SELECT (SELECT coalesce(sum(r."quantity"), 0) FROM "QualityRelease" r WHERE r."tenantId" = NEW."tenantId" AND r."workOrderSizeId" = NEW."workOrderSizeId")
       - (SELECT coalesce(sum(v."quantity"), 0) FROM "QualityReleaseReversal" v WHERE v."tenantId" = NEW."tenantId" AND v."workOrderSizeId" = NEW."workOrderSizeId")
    INTO released;
  SELECT coalesce(sum(l."quantity"), 0) INTO shipped
    FROM "ShipmentLine" l JOIN "Shipment" sh ON sh."tenantId" = l."tenantId" AND sh."id" = l."shipmentId"
   WHERE l."tenantId" = NEW."tenantId" AND l."workOrderSizeId" = NEW."workOrderSizeId" AND l."id" <> NEW."id" AND sh."status" <> 'CANCELLED'
     AND NOT (sh."status" = 'RETURNED' AND sh."carrierReturnReceivedAt" IS NOT NULL);
  IF shipped + NEW."quantity" > released THEN
    RAISE EXCEPTION 'shipping: only released garments ship (QHS-058): cell % has % released (less reversals) and % on other shipments; shipment line % of % is refused', NEW."workOrderSizeId", released, shipped, NEW."id", NEW."quantity"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- GarmentSerial: REDEFINES factory_garment_serial_guard (202610285701_quality_final_release_guards), its whole body. Its
-- rules stand; B-W2b-F1: SHIPPED is final but for a serial whose line's shipment is RETURNED with its garments received
-- back (carrierReturnReceivedAt): it goes back to RELEASED with its line cleared (status, line, version and updatedAt
-- change; its release stays), by the office (the floor's moves are unchanged), and is packed again like any released
-- serial.
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
  came_back boolean := false;
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
    -- B-W2b-F1: a SHIPPED serial of a shipment the carrier brought back, once the warehouse received it
    -- (Shipment.carrierReturnReceivedAt), goes back to RELEASED, unpacked (its line cleared, nothing else changed), to
    -- ship again. A shipment this session cannot read leaves it SHIPPED.
    IF OLD."status" = 'SHIPPED' AND NEW."status" = 'RELEASED' AND OLD."shipmentLineId" IS NOT NULL AND NEW."shipmentLineId" IS NULL THEN
      SELECT sh."status" = 'RETURNED' AND sh."carrierReturnReceivedAt" IS NOT NULL INTO came_back
        FROM "ShipmentLine" l JOIN "Shipment" sh ON sh."tenantId" = l."tenantId" AND sh."id" = l."shipmentId"
       WHERE l."tenantId" = OLD."tenantId" AND l."id" = OLD."shipmentLineId";
      came_back := coalesce(came_back, false)
        AND (to_jsonb(NEW) - (kept || ARRAY['status', 'shipmentLineId', 'version', 'updatedAt']))
            IS NOT DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['status', 'shipmentLineId', 'version', 'updatedAt']));
    END IF;
    IF OLD."status" IN ('SHIPPED', 'VOID') AND NOT came_back AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: serial % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'MADE' AND NEW."status" IN ('RELEASED', 'VOID'))
                OR (OLD."status" = 'RELEASED' AND NEW."status" IN ('SHIPPED', 'MADE', 'VOID'))
                OR came_back) THEN
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

    IF NEW."shipmentLineId" IS DISTINCT FROM OLD."shipmentLineId" AND NOT came_back THEN
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

-- =====================================================================================================================
-- The PPE register: the customer's return as a source
-- =====================================================================================================================

-- PpeRegisterEntry: REDEFINES factory_ppe_register_entry_guard (202610306001_quality_plant_w2a_guards), its whole body;
-- the trigger stays. One more source type, ReturnAuthorisation (B-W2b-16's Z4:02: a protective garment returned for a
-- defect, or found defective or misused at the return's inspection, opens its return's entry; Reg. 2016/425 art. 8(4)).
-- The partial unique index PpeRegisterEntry_tenantId_sourceType_sourceId_key (…_quality_ppe_register_guards) keeps one
-- entry per source: one per return, naming every shipment its safety lines came from.
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
     OR (NEW."sourceType" IS NOT NULL AND NEW."sourceType" NOT IN ('QualityReleaseReversal', 'QualityRelease', 'Inspection', 'Shipment', 'LabResult', 'Complaint', 'Nonconformance', 'ReturnAuthorisation')) THEN
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

-- =====================================================================================================================
-- Data: carrier returns received before this migration
-- =====================================================================================================================

UPDATE "Shipment" s
   SET "carrierReturnReceivedAt" = r."receivedAt"
  FROM (SELECT m."tenantId", substring(m."idempotencyKey" FROM '^shipping\.carrierReturn:([0-9a-f-]{36}):')::uuid AS "shipmentId", min(m."createdAt") AS "receivedAt"
          FROM "StockMove" m
         WHERE m."reason" = 'ADJUSTMENT' AND m."reversalOfId" IS NULL AND m."idempotencyKey" LIKE 'shipping.carrierReturn:%'
         GROUP BY 1, 2) r
 WHERE s."tenantId" = r."tenantId" AND s."id" = r."shipmentId" AND s."status" = 'RETURNED' AND s."carrierReturnReceivedAt" IS NULL;
