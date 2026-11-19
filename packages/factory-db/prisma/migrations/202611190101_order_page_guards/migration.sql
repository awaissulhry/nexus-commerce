-- Written by hand (Prisma does not model triggers), after the generated 202611190100_order_page_schema and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The order page (order page plan, schema wave "order page 1/1", B-OP-005; plan N5, N6 and decision D6 "from the garments";
-- review 17-review R-8, R-10, R-23; 15-steps-notes §3: N6 LINES-DERIVED, no table of its own). apps/factory-api checks all of
-- this first and answers in words (B-OP-040: several orders of one customer, refused by MULTI_ORDER_OFF until the switch
-- B-OP-047; B-OP-032: a shipment made elsewhere; B-OP-034: the typed tracking link); these rules are the last word, for every
-- login, the owner included. The refusals are check_violation (SQLSTATE 23514); their words name no other customer (the brand
-- wall: "One brand must not be able to see anything related to any other brand"). Every helper reads rows as the session sees
-- them: a row it cannot see reads as none.
--
--   ShipmentLine  (N6, R-8) a line ships garments of the shipment's first order (Shipment.salesOrderId) or of another OPEN
--                 order (CONFIRMED, IN_PRODUCTION, READY or PARTLY_SHIPPED; never PENDING_APPROVAL, SHIPPED, DELIVERED,
--                 CLOSED or CANCELLED) of the shipment's customer and company, in the first order's currency and tax mode.
--                 The line's references carry the party (shipping.prisma), so another customer's order never joins, for
--                 every login. Lines change only while the shipment is a DRAFT, as before. The floor's packing still skips
--                 the order check: the floor reads no sales order, and the guard reads, as the floor, only what it read
--                 before.
--   Shipment      (N5) origin NEXUS | ELSEWHERE: set when it is made, never changed. A shipment made ELSEWHERE is never
--                 split from another and never packed in Nexus: it moves DRAFT → SHIPPED in one step, with at least one
--                 line (each serial-tracked line holding a serial for each garment, Q31), packed and shipped at the same
--                 time, not in the future and at most 60 days back; a NEXUS shipment never moves DRAFT → SHIPPED (as
--                 before). Its paper DDT (externalDdtNumber, externalDdtDate): both or neither, only on an ELSEWHERE
--                 shipment, the number 1 to 40 characters on one line with no space at either end, dated on or before the
--                 day the goods left (Europe/Rome), written while it is a DRAFT (with the move at the latest), then fixed;
--                 recorded once per customer (the unique Shipment_external_ddt_key, R-10: two customers may share a number
--                 and date, and the conflict is always the customer's own). The typed tracking link (manualTrackingUrl):
--                 https, up to 500 characters on one line, no user name or password, only with the typed tracking number;
--                 it still changes after the goods left.
--                 It leaves with its DDT (R-23): a NEXUS shipment with a Nexus DDT that is not cancelled, an ELSEWHERE one
--                 with its paper DDT's number and date; either unless an immediate invoice travelled instead (ddtRequired
--                 false).
--   Ddt           (N5) Nexus never issues a DDT of a shipment made elsewhere: no second fiscal number for goods that left
--                 with paper (the new trigger Ddt_not_elsewhere; factory_ddt_check is untouched).
--   SalesOrder    (N6) DELIVERED once a shipment of it was delivered and none still travels, its shipments being those it is
--                 the first order of and those that carry a garment of one of its lines.
--   Message       (N6) a message of an order's thread may be about a shipment that carries a garment of that order: a
--                 shipment of two orders is a part of each.
--
-- Earlier functions REDEFINED here, each from its current body, word for word but for the lines marked B-OP-005:
--   factory_shipment_line_guard          (…_followups_f1_w2b_guards, B-W2b-F1: its latest)
--   factory_shipment_guard               (…_delivery_customs_w2b_guards, B-W2b-372: its latest)
--   factory_shipment_carriers_check      (…_carriers_w2b_guards, B-W2b-367: its only body; its trigger
--                                        Shipment_carriers_check is recreated with "manualTrackingUrl" among its columns)
--   factory_shipment_shipped_has_ddt     (…_quality_shipping_guards, W1: its only body)
--   factory_sales_order_delivered_check  (…_delivery_customs_w2b_guards, B-W2b-372: its only body)
--   factory_message_about_ok             (…_order_apply_guards, B-SA-005: its only body)
-- Their triggers stay as they are, but Shipment_carriers_check. New: the helper "factory_order_shipments" (the shipments of
-- an order, lines-derived; read by the delivered check and factory_message_about_ok) and the trigger Ddt_not_elsewhere
-- ("factory_ddt_not_elsewhere"). USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok" and
-- "factory_recall_not_future" (…_recall_claims_w2b_guards), "factory_money_rome_day" (…_money_w2a_guards).
--
-- The wave holds nothing else (15-steps-notes §3, the shrink): no table of a shipment's orders, no copy step, no seq, no
-- factory_shipment_order_guard, no Shipment_own_order trigger, no change to factory_shipment_packing_check (a split child
-- ships its parent's order, as before). Quality holds and the shipment's own holds still keep any shipment from leaving
-- (Shipment_awaits_quality_hold, Shipment_packing_check: untouched).

-- =====================================================================================================================
-- B-OP-005 helper.

-- The shipments of a sales order (N6, lines-derived): those it is the first order of (Shipment.salesOrderId) and those a line
-- of which ships garments of one of its lines. Read as the session: a row it cannot see reads as none (the floor never calls
-- it: it reads no sales order).
CREATE FUNCTION "factory_order_shipments"(p_tenant uuid, p_order uuid) RETURNS TABLE ("shipment_id" uuid)
LANGUAGE sql STABLE AS $$
  SELECT s."id" FROM "Shipment" s WHERE s."tenantId" = p_tenant AND s."salesOrderId" = p_order
  UNION
  SELECT l."shipmentId"
    FROM "SalesOrderLine" o JOIN "ShipmentLine" l ON l."tenantId" = o."tenantId" AND l."salesOrderLineId" = o."id"
   WHERE o."tenantId" = p_tenant AND o."orderId" = p_order
$$;

-- =====================================================================================================================
-- ShipmentLine (N6, R-8): REDEFINES factory_shipment_line_guard (202610316401_followups_f1_w2b_guards, the last to redefine
-- it), its whole body. Its rules stand; B-OP-005: a line of another order of the shipment's customer is no longer refused for
-- that alone: it joins while the order is open, of the shipment's company, in the first order's currency and tax mode. The
-- floor's packing still skips the order check (it reads no sales order) and reads only what it read before. The trigger
-- stays.
CREATE OR REPLACE FUNCTION "factory_shipment_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shipment record;
  part_of uuid;
  cell record;
  line_order uuid;
  -- B-OP-005: the order a line of another order is of, and the shipment's first order (the shipment's company and party are
  -- read with its status).
  joining record;
  first_order record;
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
    SELECT sh."status"::text AS status, sh."salesOrderId", sh."companyId", sh."partyId" INTO shipment
      FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."shipmentId" FOR SHARE;
  ELSE
    part_of := OLD."shipmentId";
    SELECT sh."status"::text AS status, sh."salesOrderId", sh."companyId", sh."partyId" INTO shipment
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
    -- B-OP-005 (N6, lines-derived): a line of another order travels with the shipment's first order only while that order is
    -- open (CONFIRMED, IN_PRODUCTION, READY, PARTLY_SHIPPED), of the shipment's company, in the first order's currency and tax
    -- mode (the shipment is a DRAFT: checked above). Its customer is the shipment's: checked here too, beside the line's
    -- references, which carry the party.
    IF FOUND AND line_order <> shipment."salesOrderId" THEN
      SELECT o."companyId", o."partyId", o."status"::text AS status, o."currency", o."taxMode"::text AS tax_mode INTO joining
        FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = line_order;
      SELECT o."currency", o."taxMode"::text AS tax_mode INTO first_order
        FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = shipment."salesOrderId";
      IF (joining."companyId", joining."partyId") IS DISTINCT FROM (shipment."companyId", shipment."partyId")
         OR coalesce(joining.status, 'NONE') NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED')
         OR (joining."currency", joining.tax_mode) IS DISTINCT FROM (first_order."currency", first_order.tax_mode) THEN
        RAISE EXCEPTION 'shipping: shipment line % ships sales order line %, of an order that cannot travel in shipment %: another order joins a DRAFT shipment only while it is open (CONFIRMED, IN_PRODUCTION, READY or PARTLY_SHIPPED), of the same customer and company, in the first order''s currency and tax mode', NEW."id", NEW."salesOrderLineId", NEW."shipmentId"
          USING ERRCODE = 'check_violation';
      END IF;
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

-- =====================================================================================================================
-- Shipment (N5): REDEFINES factory_shipment_guard (202611140703_delivery_customs_w2b_guards, the last to redefine it), its
-- whole body. Its rules stand; B-OP-005: where it was made never changes; a shipment made elsewhere is never split and never
-- packed in Nexus, and moves DRAFT → SHIPPED in one step as recorded; its paper DDT (both or neither, as printed, dated by the
-- day it left) is fixed once it left; the typed tracking link still changes after the goods left. The trigger stays.
CREATE OR REPLACE FUNCTION "factory_shipment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  -- W2a: what still changes once the goods left.
  after_leaving CONSTANT text[] := ARRAY['freightCharge', 'transportEvidence', 'transportEvidenceAt', 'transportEvidenceById', 'transportEvidenceNote',
    -- W2b: how the charge was decided, what the carrier charged us (its invoice comes later) and the mode of transport.
    'freightBasis', 'freightCost', 'freightCostCurrency', 'transportMode',
    -- W2b schema wave 23: the carrier's ETA (it moves while the goods travel).
    'expectedDeliveryAt',
    -- W2b-6 schema wave 48/57: the tracking number of a carrier booked by hand (it may come after the goods left) and the
    -- day's sheet it was handed over on (closed once the goods left).
    'manualTrackingNumber', 'manifestId',
    -- W2b-6 schema wave 51/57: the carrier's proof of delivery (it comes with the delivery, or after it).
    'podSignedBy', 'podAt', 'podFileId',
    -- B-OP-005 (N5): the tracking link typed for a carrier booked by hand (it may come after the goods left, with its number).
    'manualTrackingUrl'];
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
    -- B-OP-005 (N5): a shipment made elsewhere is recorded whole, never split from another shipment.
    IF NEW."origin" = 'ELSEWHERE' AND NEW."splitFromId" IS NOT NULL THEN
      RAISE EXCEPTION 'shipping: shipment % was made elsewhere; it is recorded whole, never split from another shipment', NEW."id"
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
    -- B-OP-005 (N5): where it was made is set when it is made, never changed.
    IF NEW."origin" <> OLD."origin" THEN
      RAISE EXCEPTION 'shipping: where shipment % was made (%) never changes', OLD."id", OLD."origin"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-OP-005 (N5): a shipment made elsewhere is recorded as it left (DRAFT → SHIPPED in one step), never packed in Nexus.
    IF NEW."origin" = 'ELSEWHERE' AND NEW."status" <> OLD."status" AND NEW."status" = 'PACKED' THEN
      RAISE EXCEPTION 'shipping: shipment % was made elsewhere; it is recorded as it left (DRAFT → SHIPPED), never packed in Nexus', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('PACKED', 'CANCELLED'))
                -- B-OP-005 (N5): a shipment made elsewhere leaves from DRAFT, in one step.
                OR (OLD."status" = 'DRAFT' AND NEW."status" = 'SHIPPED' AND NEW."origin" = 'ELSEWHERE')
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
    -- B-OP-005 (N5): the paper DDT a shipment made elsewhere left with is written while it is a DRAFT (with the move to
    -- SHIPPED at the latest), then fixed.
    IF OLD."status" <> 'DRAFT'
       AND (NEW."externalDdtNumber", NEW."externalDdtDate") IS DISTINCT FROM (OLD."externalDdtNumber", OLD."externalDdtDate") THEN
      RAISE EXCEPTION 'shipping: the paper DDT of shipment % is fixed once it left (or was cancelled)', OLD."id"
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

    -- B-OP-005 (N5): a shipment made elsewhere leaves as it is recorded: with the garments that left (at least one line; a
    -- serial-tracked line with a serial for each garment, Q31), packed when it left (packedAt = shippedAt), at most 60 days
    -- back and not in the future. No parcel or weight is asked: they travelled with the paper DDT.
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'SHIPPED' AND NEW."origin" = 'ELSEWHERE' THEN
      SELECT count(*) INTO lines FROM "ShipmentLine" l WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id";
      IF lines = 0 THEN
        RAISE EXCEPTION 'shipping: shipment % made elsewhere is recorded with the garments that left (it has no line)', NEW."id"
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
      IF NEW."shippedAt" IS NULL OR NEW."packedAt" IS DISTINCT FROM NEW."shippedAt"
         OR NOT "factory_recall_not_future"(NEW."shippedAt") OR NEW."shippedAt" < now() - interval '60 days' THEN
        RAISE EXCEPTION 'shipping: shipment % made elsewhere is recorded packed and shipped at the time it left (the same time), not in the future and at most 60 days back', NEW."id"
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
  -- B-OP-005 (N5; R-10, R-23): the paper DDT of a shipment made elsewhere, as printed: number and date, both or neither, only
  -- on an ELSEWHERE shipment; the number 1 to 40 characters on one line with no space at either end; dated on or before
  -- the day the goods left (Europe/Rome). One paper DDT per customer: the unique Shipment_external_ddt_key.
  IF (NEW."externalDdtNumber" IS NULL) <> (NEW."externalDdtDate" IS NULL)
     OR (NEW."externalDdtNumber" IS NOT NULL AND NEW."origin" <> 'ELSEWHERE') THEN
    RAISE EXCEPTION 'shipping: shipment % names the paper DDT it left with, number and date (both or neither), only when it was made elsewhere', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."externalDdtNumber", 40, false) OR NEW."externalDdtNumber" <> btrim(NEW."externalDdtNumber") THEN
    RAISE EXCEPTION 'shipping: the paper DDT number of shipment % is 1 to 40 characters on one line, as printed (no space at either end)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."externalDdtDate" IS NOT NULL AND NEW."shippedAt" IS NOT NULL AND NEW."externalDdtDate" > "factory_money_rome_day"(NEW."shippedAt") THEN
    RAISE EXCEPTION 'shipping: the paper DDT of shipment % is dated on or before the day the goods left', NEW."id"
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

-- =====================================================================================================================
-- Shipment (N5): REDEFINES factory_shipment_carriers_check (202611140403_carriers_w2b_guards, its only body), its whole body.
-- Its rules stand; B-OP-005: the typed tracking link. Its trigger is recreated with "manualTrackingUrl" among its columns.
CREATE OR REPLACE FUNCTION "factory_shipment_carriers_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  file record;
  sheet record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  -- A carrier booked by hand: its tracking number typed, only for a CARRIER shipment with no Sendcloud shipment.
  IF NEW."manualTrackingNumber" IS NOT NULL
     AND (NEW."transportBy" <> 'CARRIER' OR NEW."carrierShipmentId" IS NOT NULL OR NOT "factory_recall_words_ok"(NEW."manualTrackingNumber", 100, false)) THEN
    RAISE EXCEPTION 'carriers: shipment % has a tracking number typed by hand (1 to 100 characters on one line) only when a carrier booked outside Sendcloud carries it (CARRIER, no Sendcloud shipment)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-OP-005 (N5): the tracking link typed for it, only with its typed tracking number: https, up to 500 characters on one
  -- line, no user name or password in it (the host is letters, digits, dots and hyphens, a port at most; then a path, a
  -- query or a fragment without spaces).
  IF NEW."manualTrackingUrl" IS NOT NULL
     AND (NEW."manualTrackingNumber" IS NULL OR char_length(NEW."manualTrackingUrl") > 500
          OR NEW."manualTrackingUrl" !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?([/?#][^[:space:][:cntrl:]]*)?$') THEN
    RAISE EXCEPTION 'carriers: shipment % has a tracking link typed by hand only with its typed tracking number: https, up to 500 characters on one line, no user name or password in it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- The customer's own collection: who, the plate and the signature, only when the customer collects (RECIPIENT).
  IF (NEW."collectedByName" IS NOT NULL OR NEW."vehiclePlate" IS NOT NULL OR NEW."collectionSignatureFileId" IS NOT NULL)
     AND NEW."transportBy" <> 'RECIPIENT' THEN
    RAISE EXCEPTION 'carriers: shipment % records who collected it, the plate and the signature only when the customer collects (RECIPIENT)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."collectedByName", 200, false) THEN
    RAISE EXCEPTION 'carriers: who collected shipment % is 1 to 200 characters on one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."vehiclePlate" IS NOT NULL AND NEW."vehiclePlate" !~ '^[A-Z0-9][A-Z0-9 -]{0,19}$' THEN
    RAISE EXCEPTION 'carriers: the plate of the vehicle that collected shipment % is 1 to 20 capitals, digits, spaces or hyphens', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."collectionSignatureFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."collectionSignatureFileId" IS DISTINCT FROM OLD."collectionSignatureFileId") THEN
    SELECT f."recordType", f."recordId", f."companyId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."collectionSignatureFileId";
    IF FOUND AND (file."recordType", file."recordId", file."companyId") IS DISTINCT FROM ('Shipment', NEW."id", NEW."companyId") THEN
      RAISE EXCEPTION 'carriers: the signature of shipment %''s collection is a file of the shipment and its company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- The day's sheet: a CARRIER shipment of the sheet's carrier, PACKED or gone; on or off only while the sheets are open.
  IF NEW."manifestId" IS NOT NULL THEN
    IF NEW."transportBy" <> 'CARRIER' OR NEW."status" IN ('DRAFT', 'CANCELLED') THEN
      RAISE EXCEPTION 'carriers: shipment % is on a day''s sheet only while a carrier carries it and it is PACKED or left (take it off the sheet first)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' OR NEW."manifestId" IS DISTINCT FROM OLD."manifestId" OR NEW."carrierCode" IS DISTINCT FROM OLD."carrierCode" THEN
      SELECT m."carrierCode", m."closedAt" INTO sheet FROM "DispatchManifest" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."manifestId" FOR SHARE;
      IF FOUND AND NEW."carrierCode" IS DISTINCT FROM sheet."carrierCode" THEN
        RAISE EXCEPTION 'carriers: shipment % goes with carrier %, not on the day''s sheet of %', NEW."id", coalesce(NEW."carrierCode", 'none'), sheet."carrierCode"
          USING ERRCODE = 'check_violation';
      END IF;
      IF FOUND AND (TG_OP = 'INSERT' OR NEW."manifestId" IS DISTINCT FROM OLD."manifestId") AND sheet."closedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'carriers: the day''s sheet % is closed; shipment % goes on the next one', NEW."manifestId", NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."manifestId" IS NOT NULL AND NEW."manifestId" IS DISTINCT FROM OLD."manifestId" THEN
    SELECT m."closedAt" INTO sheet FROM "DispatchManifest" m WHERE m."tenantId" = OLD."tenantId" AND m."id" = OLD."manifestId" FOR SHARE;
    IF FOUND AND sheet."closedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'carriers: the day''s sheet % is closed; shipment % stays on it', OLD."manifestId", OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER "Shipment_carriers_check" ON "Shipment";
CREATE TRIGGER "Shipment_carriers_check" AFTER INSERT OR UPDATE OF "manualTrackingNumber", "manualTrackingUrl", "collectedByName", "vehiclePlate", "collectionSignatureFileId", "manifestId", "transportBy", "carrierCode", "carrierShipmentId", "status" ON "Shipment"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipment_carriers_check"();

-- =====================================================================================================================
-- Shipment (N5, R-23): REDEFINES factory_shipment_shipped_has_ddt (202610283901_quality_shipping_guards, its only body), its
-- whole body. Its rule stands for a shipment made in Nexus; B-OP-005: one made elsewhere leaves with its paper DDT's number
-- and date instead. The deferred trigger Shipment_shipped_has_ddt stays.
CREATE OR REPLACE FUNCTION "factory_shipment_shipped_has_ddt"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- B-OP-005 (N5, R-23): a shipment made elsewhere left with its paper DDT: its number and date (Nexus issues no DDT of it),
  -- unless an immediate invoice travelled instead (ddtRequired false).
  IF NEW."origin" = 'ELSEWHERE' THEN
    IF NEW."ddtRequired" AND NEW."externalDdtNumber" IS NULL THEN
      RAISE EXCEPTION 'shipping: shipment % was made elsewhere and left without the number and date of its paper DDT (DPR 472/1996); type them, or mark that an immediate invoice travelled with the goods', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
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

-- =====================================================================================================================
-- Ddt (N5): Nexus never issues a DDT of a shipment made elsewhere — no second fiscal number for goods that left with paper
-- (new trigger Ddt_not_elsewhere; factory_ddt_check keeps its own rules). A DDT is written once (append-only), so INSERT only.
CREATE FUNCTION "factory_ddt_not_elsewhere"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  made_where text;
BEGIN
  IF NEW."shipmentId" IS NOT NULL THEN
    SELECT s."origin"::text INTO made_where FROM "Shipment" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."shipmentId";
    IF FOUND AND made_where = 'ELSEWHERE' THEN
      RAISE EXCEPTION 'shipping: shipment % was made elsewhere and left with its own papers; Nexus issues no DDT of it (DDT %)', NEW."shipmentId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Ddt_not_elsewhere" AFTER INSERT ON "Ddt"
  FOR EACH ROW EXECUTE FUNCTION "factory_ddt_not_elsewhere"();

-- =====================================================================================================================
-- SalesOrder (N6): REDEFINES factory_sales_order_delivered_check (202611140703_delivery_customs_w2b_guards, its only body), its
-- whole body. Its rules stand; B-OP-005: the order's shipments are counted through its lines (factory_order_shipments). The
-- trigger SalesOrder_delivered_check stays.
CREATE OR REPLACE FUNCTION "factory_sales_order_delivered_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delivered bigint;
  travelling bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."status", NEW."deliveredAt") IS NOT DISTINCT FROM (OLD."status", OLD."deliveredAt") THEN
    RETURN NULL;
  END IF;
  IF (NEW."status" = 'DELIVERED' AND NEW."deliveredAt" IS NULL)
     OR (NEW."deliveredAt" IS NOT NULL AND NEW."status" NOT IN ('DELIVERED', 'CLOSED')) THEN
    RAISE EXCEPTION 'sales: sales order % is % with the wrong delivered time: it has one exactly while DELIVERED, and keeps it once closed', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."deliveredAt" IS NOT NULL AND NEW."deliveredAt" IS DISTINCT FROM OLD."deliveredAt" THEN
    RAISE EXCEPTION 'sales: the delivered time of sales order % never changes', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."deliveredAt" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."deliveredAt" IS NULL) THEN
    IF TG_OP = 'INSERT' OR OLD."status" <> 'SHIPPED' OR NEW."status" <> 'DELIVERED' THEN
      RAISE EXCEPTION 'sales: sales order % takes its delivered time with the move from SHIPPED to DELIVERED', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_recall_not_future"(NEW."deliveredAt") THEN
      RAISE EXCEPTION 'sales: sales order % is delivered in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-OP-005 (N6, lines-derived): its shipments are those it is the first order of and those that carry its garments.
    SELECT count(*) FILTER (WHERE s."status" = 'DELIVERED'), count(*) FILTER (WHERE s."status" = 'SHIPPED') INTO delivered, travelling
      FROM "Shipment" s
     WHERE s."tenantId" = NEW."tenantId"
       AND s."id" IN (SELECT x."shipment_id" FROM "factory_order_shipments"(NEW."tenantId", NEW."id") x);
    IF delivered = 0 OR travelling > 0 THEN
      RAISE EXCEPTION 'sales: sales order % is DELIVERED once a shipment of it was delivered and none still travels (% delivered, % on the way)', NEW."id", delivered, travelling
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- Message (N6): REDEFINES factory_message_about_ok (202611180101_order_apply_guards, its only body), its whole body. Its rules
-- stand; B-OP-005: a shipment that carries a garment of the order is a part of it. Message_about_check stays.
CREATE OR REPLACE FUNCTION "factory_message_about_ok"(p_tenant uuid, p_order uuid, p_kind text, p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_kind = 'SalesOrderLine' THEN
    RETURN EXISTS (SELECT 1 FROM "SalesOrderLine" x WHERE x."tenantId" = p_tenant AND x."id" = p_id AND x."orderId" = p_order);
  ELSIF p_kind = 'Shipment' THEN
    -- B-OP-005 (N6): a shipment of the order: the order is its first order, or it carries a garment of one of its lines (a
    -- shipment shared by two orders is a part of each).
    RETURN EXISTS (SELECT 1 FROM "Shipment" x WHERE x."tenantId" = p_tenant AND x."id" = p_id
                      AND x."id" IN (SELECT o."shipment_id" FROM "factory_order_shipments"(p_tenant, p_order) o));
  ELSIF p_kind = 'Invoice' THEN
    RETURN EXISTS (SELECT 1 FROM "Invoice" x WHERE x."tenantId" = p_tenant AND x."id" = p_id AND x."salesOrderId" = p_order);
  ELSIF p_kind = 'DepositRequest' THEN
    RETURN EXISTS (SELECT 1 FROM "DepositRequest" x WHERE x."tenantId" = p_tenant AND x."id" = p_id AND x."orderId" = p_order);
  ELSIF p_kind = 'OrderGate' THEN
    RETURN EXISTS (SELECT 1 FROM "OrderGate" x WHERE x."tenantId" = p_tenant AND x."id" = p_id AND x."salesOrderId" = p_order);
  ELSIF p_kind = 'OrderChangeRequest' THEN
    RETURN EXISTS (SELECT 1 FROM "OrderChangeRequest" x WHERE x."tenantId" = p_tenant AND x."id" = p_id AND x."orderId" = p_order);
  ELSIF p_kind = 'WorkOrder' THEN
    -- A work order of the order: one that makes a line of it (a cell of one of its lines).
    RETURN EXISTS (SELECT 1 FROM "WorkOrderSize" c JOIN "SalesOrderLine" l ON l."tenantId" = c."tenantId" AND l."id" = c."salesOrderLineId"
                    WHERE c."tenantId" = p_tenant AND c."workOrderId" = p_id AND l."orderId" = p_order);
  END IF;
  RETURN false;
END
$$;
