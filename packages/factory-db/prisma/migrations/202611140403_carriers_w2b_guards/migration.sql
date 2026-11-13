-- Written by hand (Prisma does not model triggers or partial indexes), after the generated 202611140402_carriers_w2b_schema
-- and before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Carriers, labels and dispatch, W2b-6 schema wave 48/57 (B-W2b-367; LOG-013, LOG-026, LOG-027, LOG-031, LOG-033, LOG-035,
-- LOG-038, LOG-041, LOG-042, LOG-048, LOG-049, LOG-053, LOG-058, LOG-122). apps/factory-api checks all of this first and
-- answers in words (B-W2b-390, -391, -395, -400); these rules are the last word, for every login, the owner included.
--
--   CarrierAccount      its company, site, carrier and creation never change; the carrier's code 1 to 40 characters without
--                       spaces; a live contract has its sealed account number; a number given (or replaced) is a
--                       SecretValue of purpose `shipping.carrier_account`; one live contract per company, site (or every
--                       site) and carrier (a partial unique index). Never deleted (switched off).
--   PickupRequest       what was asked never changes (company, site, carrier, ready time, parcels and pallets, address,
--                       weekdays, creation); the carrier's code as above; 0 to 9999 parcels and pallets, at least one; the
--                       address an object with a name, a first line, a postal code, a city and a two-capital country; the
--                       weekdays each once; REQUESTED → CONFIRMED | FAILED | CANCELLED, CONFIRMED → FAILED | CANCELLED,
--                       FAILED and CANCELLED final (nothing changes); the provider's reference 1 to 100 characters on one
--                       line, set once and never changed; why it failed (1 to 2000 characters) exactly when FAILED; the
--                       note 1 to 2000 characters. Never deleted.
--   DispatchManifest    its company, site, carrier, day and creation never change; the carrier's code as above; closed once:
--                       when (not in the future) and the sheet as closed (a file of the manifest, of its company), both or
--                       neither, by whom only with them; once closed, frozen. Never deleted.
--   Shipment            REDEFINED `factory_shipment_guard` (…_portal_followups_w2b_guards, word for word) with two more
--                       columns that still change once the goods left: the manual carrier's tracking number and the day's
--                       sheet. Its own trigger Shipment_carriers_check: a tracking number typed by hand (1 to 100
--                       characters on one line) only for a CARRIER shipment with no Sendcloud shipment; who collected (1 to
--                       200 characters on one line), the plate (1 to 20 capitals, digits, spaces or hyphens) and the
--                       signature (a file of the shipment, of its company) only when the customer collects (RECIPIENT);
--                       on a day's sheet only a CARRIER shipment of the sheet's carrier (the reference holds the site) that
--                       is PACKED or left, put on or taken off only while the sheets concerned are open (each FOR SHARE: a
--                       sheet being closed finishes first, or waits); no move back to DRAFT nor CANCELLED while on a sheet.
--   Parcel              its own trigger Parcel_value_check (W1's guard untouched: a parcel changes until it leaves): the
--                       declared value 0 or more; the insured value above 0 and at most the declared value when that is
--                       given.
--   ShippingSettings    its own trigger ShippingSettings_carriers_check (W1's guard untouched): live (test mode off)
--                       exactly with when it went live (not in the future) and who switched it; both fixed while it stays
--                       live, cleared when it goes back to test mode; the insured-above value 0 or more.
--   Party               its own trigger Party_carrier_account_check (no party guard touched): the customer's carrier
--                       account only with its preferred carrier, a SecretValue of purpose `parties.carrier_account` when
--                       given or replaced; COLLECT and THIRD_PARTY only with that account; the default service 1 to 100
--                       characters on one line, only with the preferred carrier.
--   Printer             its own trigger Printer_mode_check (W0's guard untouched): DIRECT only for a label printer
--                       (LABEL_ZPL).
--   PrintJob            its own trigger PrintJob_reprint_check (W0's guard untouched): a reprint names an earlier job of the
--                       same record (the reference holds the company), not itself, with why (3 to 200 characters on one
--                       line), both or neither; both fixed once queued.
--   GeneratedDocument   REDEFINED `factory_generated_document_check` (…_followups_sales_w2b5_guards' body, word for word)
--                       with four more kinds: PROFORMA of a Shipment (its company and site), a SampleShipment (its round's
--                       company) or a DepositRequest (its company), neither of these two with a site, carrying the number
--                       its record took from the company's PROFORMA series (the record's NumberAllocation); MANIFEST of a
--                       DispatchManifest (its company and site); SHIPPING_MARKS and SHIPMENT_PACK of a Shipment.
--   TRUNCATE            refused on the three new tables.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the checks are AFTER triggers (the
-- policies speak first), but the refused deletes (BEFORE: the words come before a foreign key's; the runtime roles have no
-- DELETE grant on the new tables, so they speak to the owner); the redefined functions keep their triggers (BEFORE). A rule
-- that reads another row skips a row this session cannot see. An UPDATE that changes nothing passes. Nothing reads
-- factory.actor_id. No data to copy: every new column is null or takes its default on the rows before it (sites in test
-- mode, parties billed to us, printers through the relay), and none of them breaks a new rule.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers and
-- dates moved) and insert the copy: so the first rows the seed gives are ones a copy may repeat (a contract switched off
-- without its number, a pickup that failed, an open day's sheet), and the sealed numbers never sit on a table's first row
-- (a copy would repeat a unique secret).
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok" and "factory_recall_not_future"
-- (…_recall_claims_w2b_guards).

CREATE FUNCTION "factory_carriers_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'carriers: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_carriers_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'carriers: % % is kept, never deleted (switch it off, cancel it or close it)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['CarrierAccount', 'PickupRequest', 'DispatchManifest'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_carriers_refuse_truncate"()', name || '_no_truncate', name);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "factory_carriers_never_deleted"()', name || '_never_deleted', name);
  END LOOP;
END
$$;

-- A carrier's code, as ShippingSettings.defaultCarrierCode, Shipment.carrierCode and CarrierCutOff name it ("brt"): 1 to 40
-- characters, no space or control character.
CREATE FUNCTION "factory_carriers_code_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NOT NULL AND code ~ '^[^[:space:][:cntrl:]]{1,40}$'
$$;

-- A sealed secret of the purpose its column takes; a secret this session cannot see is left to the reference.
CREATE FUNCTION "factory_carriers_secret_ok"(tenant uuid, secret uuid, wanted text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  found_purpose text;
BEGIN
  IF secret IS NULL THEN
    RETURN true;
  END IF;
  SELECT s."purpose" INTO found_purpose FROM "SecretValue" s WHERE s."tenantId" = tenant AND s."id" = secret;
  RETURN NOT FOUND OR found_purpose = wanted;
END
$$;

-- =====================================================================================================================
-- CarrierAccount (LOG-033)
CREATE FUNCTION "factory_carrier_account_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."siteId", NEW."carrierCode", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."siteId", OLD."carrierCode", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'carriers: the company, site, carrier and creation of carrier contract % never change (a new contract is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_carriers_code_ok"(NEW."carrierCode") THEN
    RAISE EXCEPTION 'carriers: carrier contract % names its carrier by a code of 1 to 40 characters without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."active" AND NEW."accountNumberSecretId" IS NULL THEN
    RAISE EXCEPTION 'carriers: carrier contract % is live only with its account number (sealed)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."accountNumberSecretId" IS DISTINCT FROM OLD."accountNumberSecretId")
     AND NOT "factory_carriers_secret_ok"(NEW."tenantId", NEW."accountNumberSecretId", 'shipping.carrier_account') THEN
    RAISE EXCEPTION 'carriers: the account number of carrier contract % is a secret sealed for shipping.carrier_account', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "CarrierAccount_guard" AFTER INSERT OR UPDATE ON "CarrierAccount"
  FOR EACH ROW EXECUTE FUNCTION "factory_carrier_account_guard"();

-- One live contract per company, site (or every site: no site) and carrier.
CREATE UNIQUE INDEX "CarrierAccount_one_live" ON "CarrierAccount" (
  "tenantId", "companyId", (coalesce("siteId", '00000000-0000-0000-0000-000000000000'::uuid)), "carrierCode"
) WHERE "active";

-- =====================================================================================================================
-- PickupRequest (LOG-048)
CREATE FUNCTION "factory_pickup_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  moves CONSTANT text[] := ARRAY['status', 'providerReference', 'errorWords', 'note', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."status" IN ('FAILED', 'CANCELLED') THEN
      RAISE EXCEPTION 'carriers: pickup request % is %; it changes no more (a new try is a new request)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - moves) IS DISTINCT FROM (to_jsonb(OLD) - moves) THEN
      RAISE EXCEPTION 'carriers: what pickup request % asked never changes (site, carrier, ready time, parcels, pallets, address, weekdays); a change is a new request', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'REQUESTED' AND NEW."status" IN ('CONFIRMED', 'FAILED', 'CANCELLED'))
                OR (OLD."status" = 'CONFIRMED' AND NEW."status" IN ('FAILED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'carriers: pickup request % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."providerReference" IS NOT NULL AND NEW."providerReference" IS DISTINCT FROM OLD."providerReference" THEN
      RAISE EXCEPTION 'carriers: the carrier''s reference of pickup request % is set once, never changed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_carriers_code_ok"(NEW."carrierCode") THEN
    RAISE EXCEPTION 'carriers: pickup request % names its carrier by a code of 1 to 40 characters without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."parcels" < 0 OR NEW."pallets" < 0 OR NEW."parcels" > 9999 OR NEW."pallets" > 9999 OR NEW."parcels" + NEW."pallets" < 1 THEN
    RAISE EXCEPTION 'carriers: pickup request % asks 0 to 9999 parcels and 0 to 9999 pallets, at least one of either', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."address") IS DISTINCT FROM 'object'
     OR btrim(coalesce(NEW."address"->>'name', '')) = '' OR btrim(coalesce(NEW."address"->>'line1', '')) = ''
     OR btrim(coalesce(NEW."address"->>'postalCode', '')) = '' OR btrim(coalesce(NEW."address"->>'city', '')) = ''
     OR coalesce(NEW."address"->>'country', '') !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'carriers: pickup request % collects from an address with a name, a first line, a postal code, a city and a country (ISO 3166-1, two capitals)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."repeatWeekdays" IS NULL OR array_position(NEW."repeatWeekdays", NULL) IS NOT NULL
     OR cardinality(NEW."repeatWeekdays") <> (SELECT count(DISTINCT d) FROM unnest(NEW."repeatWeekdays") AS d) THEN
    RAISE EXCEPTION 'carriers: pickup request % repeats on each weekday once at most (none: a one-off)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."providerReference" IS NOT NULL AND NOT "factory_recall_words_ok"(NEW."providerReference", 100, false) THEN
    RAISE EXCEPTION 'carriers: the carrier''s reference of pickup request % is 1 to 100 characters on one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'FAILED') <> (NEW."errorWords" IS NOT NULL) OR NOT "factory_recall_words_ok"(NEW."errorWords", 2000, true) THEN
    RAISE EXCEPTION 'carriers: pickup request % says why it failed (1 to 2000 characters) exactly when it is FAILED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'carriers: the note of pickup request % is 1 to 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "PickupRequest_guard" AFTER INSERT OR UPDATE ON "PickupRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_pickup_request_guard"();

-- =====================================================================================================================
-- DispatchManifest (LOG-049)
CREATE FUNCTION "factory_dispatch_manifest_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  file record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."closedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'carriers: the day''s sheet % was closed; it changes no more', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."companyId", NEW."siteId", NEW."carrierCode", NEW."day", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."siteId", OLD."carrierCode", OLD."day", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'carriers: the company, site, carrier, day and creation of the day''s sheet % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_carriers_code_ok"(NEW."carrierCode") THEN
    RAISE EXCEPTION 'carriers: the day''s sheet % names its carrier by a code of 1 to 40 characters without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."closedAt" IS NULL) <> (NEW."fileId" IS NULL) OR (NEW."closedById" IS NOT NULL AND NEW."closedAt" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."closedAt") THEN
    RAISE EXCEPTION 'carriers: the day''s sheet % is closed with when (not in the future) and the sheet as closed, both or neither; by whom only with them', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."fileId" IS DISTINCT FROM OLD."fileId") THEN
    SELECT f."recordType", f."recordId", f."companyId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
    IF FOUND AND (file."recordType", file."recordId", file."companyId") IS DISTINCT FROM ('DispatchManifest', NEW."id", NEW."companyId") THEN
      RAISE EXCEPTION 'carriers: the day''s sheet % is closed with a file of its own (DispatchManifest) and company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "DispatchManifest_guard" AFTER INSERT OR UPDATE ON "DispatchManifest"
  FOR EACH ROW EXECUTE FUNCTION "factory_dispatch_manifest_guard"();

-- =====================================================================================================================
-- Shipment (LOG-041, LOG-049, LOG-053, LOG-122)

-- REDEFINES factory_shipment_guard (202610319703_portal_followups_w2b_guards, the last to redefine it), its whole body:
-- the manual carrier's tracking number and the day's sheet still change once the goods left. The trigger stays.
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
    'manualTrackingNumber', 'manifestId'];
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
-- Shipment (new trigger Shipment_carriers_check; the shipment guard keeps its own rules): the manual carrier, the customer's
-- collection and the day's sheet.
CREATE FUNCTION "factory_shipment_carriers_check"() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER "Shipment_carriers_check" AFTER INSERT OR UPDATE OF "manualTrackingNumber", "collectedByName", "vehiclePlate", "collectionSignatureFileId", "manifestId", "transportBy", "carrierCode", "carrierShipmentId", "status" ON "Shipment"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipment_carriers_check"();

-- =====================================================================================================================
-- Parcel (new trigger Parcel_value_check; W1's guard keeps a parcel changing only until it leaves): declared and insured
-- values (LOG-042).
CREATE FUNCTION "factory_parcel_value_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."declaredValue" < 0 OR NEW."insuredValue" <= 0 OR NEW."insuredValue" > NEW."declaredValue" THEN
    RAISE EXCEPTION 'carriers: parcel % declares a value of 0 or more and is insured for above 0, at most its declared value when one is given', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Parcel_value_check" AFTER INSERT OR UPDATE OF "declaredValue", "insuredValue" ON "Parcel"
  FOR EACH ROW EXECUTE FUNCTION "factory_parcel_value_check"();

-- =====================================================================================================================
-- ShippingSettings (new trigger ShippingSettings_carriers_check; W1's guard untouched): test mode and insurance (LOG-035,
-- LOG-042).
CREATE FUNCTION "factory_shipping_settings_carriers_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."testMode" <> (NEW."liveSince" IS NULL) OR NEW."testMode" <> (NEW."liveSetById" IS NULL) OR NOT "factory_recall_not_future"(NEW."liveSince") THEN
    RAISE EXCEPTION 'carriers: the shipping settings % are live (test mode off) exactly with when they went live (not in the future) and who switched them; in test mode, neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT OLD."testMode" AND NOT NEW."testMode"
     AND (NEW."liveSince", NEW."liveSetById") IS DISTINCT FROM (OLD."liveSince", OLD."liveSetById") THEN
    RAISE EXCEPTION 'carriers: when the shipping settings % went live and who switched them stay as they are while live', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."insureAbove" < 0 THEN
    RAISE EXCEPTION 'carriers: the shipping settings % insure parcels declared above 0 or more, or never', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ShippingSettings_carriers_check" AFTER INSERT OR UPDATE OF "testMode", "liveSince", "liveSetById", "insureAbove" ON "ShippingSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipping_settings_carriers_check"();

-- =====================================================================================================================
-- Party (new trigger Party_carrier_account_check; no party guard touched): the customer's carrier account (LOG-038).
CREATE FUNCTION "factory_party_carrier_account_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF NEW."carrierAccountSecretId" IS NOT NULL AND NEW."preferredCarrierCode" IS NULL THEN
    RAISE EXCEPTION 'parties: party % keeps a carrier account only with its preferred carrier', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."freightBilling" IN ('COLLECT', 'THIRD_PARTY') AND NEW."carrierAccountSecretId" IS NULL THEN
    RAISE EXCEPTION 'parties: party %''s shipments are billed % only on a carrier account it keeps (sealed)', NEW."id", NEW."freightBilling"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."defaultCarrierService" IS NOT NULL
     AND (NEW."preferredCarrierCode" IS NULL OR NOT "factory_recall_words_ok"(NEW."defaultCarrierService", 100, false)) THEN
    RAISE EXCEPTION 'parties: the default carrier service of party % is 1 to 100 characters on one line, with its preferred carrier', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."carrierAccountSecretId" IS DISTINCT FROM OLD."carrierAccountSecretId")
     AND NOT "factory_carriers_secret_ok"(NEW."tenantId", NEW."carrierAccountSecretId", 'parties.carrier_account') THEN
    RAISE EXCEPTION 'parties: the carrier account of party % is a secret sealed for parties.carrier_account', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Party_carrier_account_check" AFTER INSERT OR UPDATE OF "carrierAccountSecretId", "defaultCarrierService", "freightBilling", "preferredCarrierCode" ON "Party"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_carrier_account_check"();

-- =====================================================================================================================
-- Printer (new trigger Printer_mode_check; W0's guard untouched): DIRECT only for a label printer (LOG-026).
CREATE FUNCTION "factory_printer_mode_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."mode" = 'DIRECT' AND NEW."kind" <> 'LABEL_ZPL' THEN
    RAISE EXCEPTION 'print: printer % takes ZPL straight from the station (DIRECT) only as a label printer (LABEL_ZPL)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Printer_mode_check" AFTER INSERT OR UPDATE OF "mode", "kind" ON "Printer"
  FOR EACH ROW EXECUTE FUNCTION "factory_printer_mode_check"();

-- =====================================================================================================================
-- PrintJob (new trigger PrintJob_reprint_check; W0's guard untouched): a reprint (LOG-027).
CREATE FUNCTION "factory_print_job_reprint_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."reprintOfId", NEW."reprintReason") IS DISTINCT FROM (OLD."reprintOfId", OLD."reprintReason") THEN
      RAISE EXCEPTION 'print: which job job % prints again and why never change once it is queued', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF (NEW."reprintOfId" IS NULL) <> (NEW."reprintReason" IS NULL)
     OR (NEW."reprintReason" IS NOT NULL AND (char_length(btrim(NEW."reprintReason")) < 3 OR NOT "factory_recall_words_ok"(NEW."reprintReason", 200, false))) THEN
    RAISE EXCEPTION 'print: job % prints an earlier job again with why (3 to 200 characters on one line), both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reprintOfId" IS NOT NULL THEN
    IF NEW."reprintOfId" = NEW."id" THEN
      RAISE EXCEPTION 'print: job % does not print itself again', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT j."recordType", j."recordId" INTO original FROM "PrintJob" j WHERE j."tenantId" = NEW."tenantId" AND j."id" = NEW."reprintOfId";
    IF FOUND AND (original."recordType", original."recordId") IS DISTINCT FROM (NEW."recordType", NEW."recordId") THEN
      RAISE EXCEPTION 'print: job % prints again job % of the same record (% %)', NEW."id", NEW."reprintOfId", original."recordType", original."recordId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "PrintJob_reprint_check" AFTER INSERT OR UPDATE OF "reprintOfId", "reprintReason" ON "PrintJob"
  FOR EACH ROW EXECUTE FUNCTION "factory_print_job_reprint_check"();

-- =====================================================================================================================
-- GeneratedDocument: the proforma, the day's sheet, carton marks and the shipment pack (LOG-058, LOG-049, LOG-013, LOG-031)

-- REDEFINES factory_generated_document_check (202611140103_followups_sales_w2b5_guards, the last to redefine it), its whole
-- body: PROFORMA of a Shipment, SampleShipment or DepositRequest with its record's PROFORMA number, MANIFEST of a
-- DispatchManifest, SHIPPING_MARKS and SHIPMENT_PACK of a Shipment. The trigger stays.
CREATE OR REPLACE FUNCTION "factory_generated_document_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_company uuid;
  record_site uuid;
  record_kind text;
  file record;
BEGIN
  IF NEW."version" < 1 OR NEW."fingerprint" !~ '^[0-9a-f]{64}$' OR NEW."language" !~ '^[a-z]{2}$'
     OR btrim(coalesce(NEW."layout", 'x')) = '' OR btrim(coalesce(NEW."number", 'x')) = '' THEN
    RAISE EXCEPTION 'documents: generated document % has a version from 1, a SHA-256 fingerprint (lower-case hex), its two-letter language and, when given, a layout and a number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((NEW."kind" = 'PACKING_LIST' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'CLAIM_LETTER' AND NEW."recordType" = 'SupplierClaim')
          OR (NEW."kind" = 'JOB_SHEET' AND NEW."recordType" IN ('SubcontractOrder', 'MaintenanceJob'))
          OR (NEW."kind" = 'RMA_SHEET' AND NEW."recordType" = 'ReturnAuthorisation')
          OR (NEW."kind" = 'INSPECTION_REPORT' AND NEW."recordType" IN ('Inspection', 'IncomingInspection'))
          OR (NEW."kind" = 'CERTIFICATE_OF_CONFORMITY' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'NCR_REPORT' AND NEW."recordType" = 'Nonconformance')
          OR (NEW."kind" = 'EIGHT_D' AND NEW."recordType" = 'Capa')
          OR (NEW."kind" = 'COMPLAINT_ANSWER' AND NEW."recordType" = 'Complaint')
          OR (NEW."kind" = 'CHECK_REPORT' AND NEW."recordType" = 'MachineCheckResult')
          OR (NEW."kind" = 'DVR_FROZEN' AND NEW."recordType" = 'RiskAssessmentVersion')
          OR (NEW."kind" = 'PPE_RECEIPT' AND NEW."recordType" = 'PpeIssue')
          OR (NEW."kind" = 'COMPLIANCE_PACK' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'EVIDENCE_PACK' AND NEW."recordType" = 'EvidencePack')
          OR (NEW."kind" = 'TECH_PACK' AND NEW."recordType" = 'StyleRevision')
          OR (NEW."kind" = 'USER_INFORMATION' AND NEW."recordType" = 'ComplianceDocument')
          OR (NEW."kind" = 'ORDER_CONFIRMATION' AND NEW."recordType" = 'SalesOrder')
          OR (NEW."kind" = 'MTM_WORKSHEET' AND NEW."recordType" = 'MeasurementProfile')
          OR (NEW."kind" = 'PRICE_LIST' AND NEW."recordType" = 'PriceListVersion')
          OR (NEW."kind" = 'PROFORMA' AND NEW."recordType" IN ('Shipment', 'SampleShipment', 'DepositRequest'))
          OR (NEW."kind" = 'MANIFEST' AND NEW."recordType" = 'DispatchManifest')
          OR (NEW."kind" IN ('SHIPPING_MARKS', 'SHIPMENT_PACK') AND NEW."recordType" = 'Shipment')) THEN
    RAISE EXCEPTION 'documents: generated document % is a % of a %; a packing list is a Shipment''s, a claim letter a SupplierClaim''s, a job sheet a SubcontractOrder''s or a MaintenanceJob''s, an RMA sheet a ReturnAuthorisation''s, a certificate of conformity a Shipment''s, an inspection report an Inspection''s or an IncomingInspection''s, an NCR report a Nonconformance''s, an 8D a Capa''s, an answer letter a Complaint''s, a check report a MachineCheckResult''s, a frozen risk assessment a RiskAssessmentVersion''s, a PPE receipt a PpeIssue''s, a compliance pack a Shipment''s, an evidence pack an EvidencePack''s, a tech pack a StyleRevision''s, a user information leaflet a ComplianceDocument''s, an order confirmation a SalesOrder''s, a made-to-measure worksheet a MeasurementProfile''s, a price list a PriceListVersion''s, a proforma a Shipment''s, a SampleShipment''s or a DepositRequest''s, a day sheet a DispatchManifest''s, carton marks and a shipment pack a Shipment''s', NEW."id", NEW."kind", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  CASE NEW."recordType"
    -- W2b-6 wave 48/57 (B-W2b-367): a day sheet is of its manifest's company and site; a sample shipment's proforma of its
    -- round's company and a deposit request's of the request's company, neither with a site.
    WHEN 'DispatchManifest' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "DispatchManifest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'SampleShipment' THEN
      SELECT o."companyId", NULL::uuid INTO record_company, record_site
        FROM "SampleShipment" r JOIN "SampleRound" o ON o."tenantId" = r."tenantId" AND o."id" = r."roundId"
       WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'DepositRequest' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "DepositRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- W2b-6 wave 45/57 (B-W2b-363): a price list is of its version's list's company, or of any company of the tenant for a
    -- tenant-wide list (the company whose papers it is); a price list has no site.
    WHEN 'PriceListVersion' THEN
      SELECT coalesce(l."companyId", NEW."companyId"), NULL::uuid INTO record_company, record_site
        FROM "PriceListVersion" r JOIN "PriceList" l ON l."tenantId" = r."tenantId" AND l."id" = r."listId"
       WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- W2b-5 wave 44/44 (B-W2b-297): a made-to-measure worksheet is of a profile, which has no company (a rider's profile is
    -- the party's, tenant-wide): the document is of the company whose papers it is, any company of the tenant; no site.
    WHEN 'MeasurementProfile' THEN
      SELECT NEW."companyId", NULL::uuid INTO record_company, record_site FROM "MeasurementProfile" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- W2b-5 wave 39/44 (B-W2b-281): an order confirmation is of its order's company; an order has no site.
    WHEN 'SalesOrder' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "SalesOrder" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- W2b-4 wave 32/33 (B-W2b-218): an evidence pack is of its company; a tech pack of its revision's style's company and a
    -- leaflet of its document's company, either for any company of the tenant when the style or document is tenant-wide; the
    -- leaflet's document is user information. None of them has a site.
    WHEN 'EvidencePack' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "EvidencePack" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'StyleRevision' THEN
      SELECT coalesce(s."companyId", NEW."companyId"), NULL::uuid INTO record_company, record_site
        FROM "StyleRevision" r JOIN "Style" s ON s."tenantId" = r."tenantId" AND s."id" = r."styleId"
       WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'ComplianceDocument' THEN
      SELECT coalesce(r."companyId", NEW."companyId"), NULL::uuid, r."kind"::text INTO record_company, record_site, record_kind
        FROM "ComplianceDocument" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
      IF FOUND AND record_kind <> 'USER_INFORMATION' THEN
        RAISE EXCEPTION 'documents: generated document % is a user information leaflet of a ComplianceDocument of kind USER_INFORMATION (this one is %)', NEW."id", record_kind
          USING ERRCODE = 'check_violation';
      END IF;
    -- W2b wave 15/16 (B-W2b-87): a frozen risk assessment is of its version's company and site, a PPE receipt of its issue's.
    WHEN 'RiskAssessmentVersion' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "RiskAssessmentVersion" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'PpeIssue' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "PpeIssue" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- W2b wave 14/16 (B-W2b-86): a check report is of its result's company and site.
    WHEN 'MachineCheckResult' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "MachineCheckResult" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- A record of the whole company has no site, and neither has its document.
    WHEN 'Capa' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "Capa" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Complaint' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "Complaint" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Inspection' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Inspection" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'IncomingInspection' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "IncomingInspection" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Nonconformance' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Nonconformance" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Shipment' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Shipment" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'SupplierClaim' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "SupplierClaim" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'SubcontractOrder' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "SubcontractOrder" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'MaintenanceJob' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "MaintenanceJob" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    ELSE
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "ReturnAuthorisation" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
  END CASE;
  IF FOUND AND (record_company, record_site) IS DISTINCT FROM (NEW."companyId", NEW."siteId") THEN
    RAISE EXCEPTION 'documents: generated document % is of the company and site of its % %', NEW."id", NEW."recordType", NEW."recordId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT f."recordType", f."recordId", f."companyId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF FOUND AND (file."recordType", file."recordId", file."companyId") IS DISTINCT FROM (NEW."recordType", NEW."recordId", NEW."companyId") THEN
    RAISE EXCEPTION 'documents: the file of generated document % is a file of its own record (% %) and company', NEW."id", NEW."recordType", NEW."recordId"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-6 wave 48/57 (B-W2b-367; LOG-058): a proforma carries the number its record took from the company's PROFORMA series
  -- (the record's NumberAllocation of kind PROFORMA, as printed); its later versions keep it.
  IF NEW."kind" = 'PROFORMA'
     AND NOT EXISTS (SELECT 1 FROM "NumberAllocation" a
                      WHERE a."tenantId" = NEW."tenantId" AND a."recordType" = NEW."recordType" AND a."recordId" = NEW."recordId"
                        AND a."kind" = 'PROFORMA' AND a."companyId" = NEW."companyId" AND a."formatted" = NEW."number") THEN
    RAISE EXCEPTION 'documents: proforma % carries the number its % % took from the company''s PROFORMA series, not %', NEW."id", NEW."recordType", NEW."recordId", coalesce(NEW."number", 'none')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
