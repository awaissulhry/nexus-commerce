-- Written by hand (Prisma does not model triggers or partial indexes), after the generated 202611140202_packing_w2b_schema
-- and before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Packing and the shipment queue, W2b-6 schema wave 46/57 (B-W2b-364; LOG-003, LOG-005, LOG-007, LOG-008, LOG-010,
-- LOG-013, LOG-017, LOG-018, LOG-110, FIN-011, FIN-079). apps/factory-api checks all of this first and answers in words
-- (B-W2b-384, -386, -387); these rules are the last word, for every login, the owner included.
--
--   PackagingType         its company, kind and creation never change; a name of 1 to 100 characters on one line; the
--                         inner length, width and height above 0, all three or none; the tare 0 or more, the maximum
--                         weight above 0 and above the tare; a pallet kind exactly on a PALLET; the cost per unit 0 or
--                         more with its ISO 4217 currency, both or neither. Never deleted (switched off).
--   PackagingDefault      its company, kind and creation never change (the reference keeps the kind its packaging's); a
--                         style or a size scale, at least one; a size run from … to only with the scale, both or
--                         neither, sizes of the scale, the first not after the last; the style of the company or
--                         tenant-wide, not archived when named, and with a scale the style's own; the scale of the
--                         company or tenant-wide; a live default names an ACTIVE packaging when it is named or switched
--                         on; one live default per company, kind, style and run (a partial unique index). Never deleted.
--   ParcelLine            written, changed and removed only while its shipment is a DRAFT (the shipment FOR SHARE); its
--                         shipment and creation never change; a garment or more; the size its line's; nothing goes in
--                         (a new row, more garments, another carton or line) while the shipment is on hold.
--   ShippingMarkTemplate  its company, customer and creation never change; 1 to 16 fields, each once; the language two
--                         lower-case letters (ISO 639-1); its customer a CUSTOMER or BRAND party of the company or
--                         tenant-wide, not archived when the template is made; one live template per company and customer
--                         and one live default (a partial unique index). Never deleted.
--   ShipmentHold          placed only on a DRAFT or PACKED shipment (the shipment FOR NO KEY UPDATE: a write that packs,
--                         labels or sends it takes the shipment too, so it finishes first or waits and then sees the
--                         hold), not in the future; never edited: released once (when, why; by whom or the system), not
--                         before it was placed and not in the future, then frozen; words required for OTHER, 1 to 2000
--                         characters; at most one in force per shipment and reason (a partial unique index). Never
--                         deleted.
--   CarrierCutOff         its company, site and creation never change; the carrier's code 1 to 40 characters without
--                         spaces; the time HH:MM (24 hours). One per site, carrier and weekday (the schema's unique key).
--   Shipment              its own trigger (the shipment guard untouched): the shipment it was split from and why, both or
--                         neither, given at insert and never changed: of the same order (the reference holds the site
--                         and party), not itself, DRAFT or PACKED then; the reason a code of 1 to 40 characters without
--                         spaces. No move to PACKED or SHIPPED while a hold is in force. The move DRAFT → PACKED also
--                         needs: every line with carton contents counted exactly (they add up to it); each serial of
--                         such a line in a carton that holds that line, no carton holding more of a line's serials than
--                         its contents say; a packed serial of a line without contents in the line's own parcel; the
--                         numbered cartons each a different n, of N = the shipment's cartons.
--   Parcel                its own trigger (W1's guard untouched: a parcel changes until its shipment leaves): its
--                         packaging, when named, a CARTON, BOX or PALLET of the shipment's company, ACTIVE; "n of N"
--                         both or neither, 1 ≤ n ≤ N ≤ 9999; its marks printed not in the future; no carrier label (its
--                         label time or tracking number set or changed) while the shipment is on hold. Not removed
--                         while it holds contents or packed serials (BEFORE DELETE: words before the foreign key's).
--   ShipmentLine          its own triggers (the line guard untouched): not put into a parcel (a new line in one, another
--                         parcel, more garments in one) while the shipment is on hold; its size not changed under its
--                         carton contents; not removed while it has carton contents (BEFORE DELETE).
--   GarmentSerial         its own triggers (F1's guard untouched): a carton (parcelId) and its time both or neither, a
--                         packer only with them, only with a shipment line, the carton a parcel of the line's shipment;
--                         put into a carton or moved to another only while RELEASED, the shipment a DRAFT and not on
--                         hold, at a time not in the future; the time and packer change only with the carton. When its
--                         shipment line is cleared (unpacked, or a carrier return received: F1's SHIPPED → RELEASED), a
--                         BEFORE trigger that fires after the guard clears its carton, time and packer with it, so W1's
--                         and F1's paths need no change.
--   TRUNCATE              refused on the six new tables.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the checks are AFTER triggers (the
-- policies speak first), but the refused deletes (BEFORE: the words come before a foreign key's; the runtime roles have
-- no DELETE grant on those tables, so they speak to the owner) and the carton cleared with the line (BEFORE: it writes the
-- row). The tenant of a row is left to the policies and the references, never compared here: a rule that reads another
-- row skips a row this session cannot see. An UPDATE that changes nothing passes. A trigger reads only columns the role
-- that fires it may read (the floor reads PackagingType without its cost, ShipmentHold without its words) and locks the
-- shipment FOR SHARE only where that role may update it (the office and the floor).
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers
-- and dates moved) and insert the copy: so the first rows the seed gives are ones a copy may repeat (a switched-off
-- default and template, a released hold, carton contents of a DRAFT shipment; no cap on contents while DRAFT, which is
-- why the line's total is checked when the shipment moves to PACKED).
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok" and "factory_recall_not_future"
-- (…_recall_claims_w2b_guards).

CREATE FUNCTION "factory_packing_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'packing: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_packing_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'packing: % % is kept, never deleted (switch it off, or release it)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['PackagingType', 'PackagingDefault', 'ParcelLine', 'ShippingMarkTemplate', 'ShipmentHold', 'CarrierCutOff'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_packing_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['PackagingType', 'PackagingDefault', 'ShippingMarkTemplate', 'ShipmentHold'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "factory_packing_never_deleted"()', name || '_never_deleted', name);
  END LOOP;
END
$$;

-- A shipment on hold refuses the write that called this (what: what waits, in words). It first locks the shipment FOR
-- SHARE (the caller's role may update it: the office or the floor), so a hold being placed (FOR NO KEY UPDATE) is
-- either committed and seen here, or waits until this write is done. A shipment this session cannot see is left to the
-- policies.
CREATE FUNCTION "factory_packing_refuse_held"(tenant uuid, shipment uuid, what text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  held text;
BEGIN
  PERFORM 1 FROM "Shipment" sh WHERE sh."tenantId" = tenant AND sh."id" = shipment FOR SHARE;
  SELECT h."reason"::text INTO held FROM "ShipmentHold" h
   WHERE h."tenantId" = tenant AND h."shipmentId" = shipment AND h."releasedAt" IS NULL
   ORDER BY h."placedAt", h."id" LIMIT 1;
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'packing: shipment % is on hold (%); %', shipment, held, what
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- =====================================================================================================================
-- PackagingType (LOG-008, FIN-011)
CREATE FUNCTION "factory_packaging_type_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."kind", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."kind", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'packing: the company, kind and creation of packaging type % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."name" IS NULL OR NOT "factory_recall_words_ok"(NEW."name", 100, false) THEN
    RAISE EXCEPTION 'packing: packaging type % has a name of 1 to 100 characters on one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."innerLengthCm" IS NULL) <> (NEW."innerWidthCm" IS NULL) OR (NEW."innerLengthCm" IS NULL) <> (NEW."innerHeightCm" IS NULL)
     OR NEW."innerLengthCm" <= 0 OR NEW."innerWidthCm" <= 0 OR NEW."innerHeightCm" <= 0 THEN
    RAISE EXCEPTION 'packing: packaging type % has its inner length, width and height above 0 cm, all three or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tareKg" < 0 OR NEW."maxWeightKg" <= 0 OR NEW."maxWeightKg" <= coalesce(NEW."tareKg", 0) THEN
    RAISE EXCEPTION 'packing: packaging type % weighs 0 kg or more empty, and may weigh more full (its maximum weight) than empty', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'PALLET') <> (NEW."palletKind" IS NOT NULL) THEN
    RAISE EXCEPTION 'packing: packaging type % has a pallet kind exactly when it is a PALLET', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."costPerUnit" < 0 OR (NEW."costPerUnit" IS NULL) <> (NEW."costCurrency" IS NULL) OR coalesce(NEW."costCurrency", 'EUR') !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'packing: the cost per unit of packaging type % is 0 or more, with its ISO 4217 currency (both or neither)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "PackagingType_guard" AFTER INSERT OR UPDATE ON "PackagingType"
  FOR EACH ROW EXECUTE FUNCTION "factory_packaging_type_guard"();

-- =====================================================================================================================
-- PackagingDefault (LOG-008)
CREATE FUNCTION "factory_packaging_default_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  type_active boolean;
  style_company uuid;
  style_scale uuid;
  style_status text;
  scale_company uuid;
  from_seq integer;
  to_seq integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."kind", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."kind", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'packing: the company, kind and creation of packaging default % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."styleId" IS NULL AND NEW."sizeScaleId" IS NULL THEN
    RAISE EXCEPTION 'packing: packaging default % is for a style or a size run (a size scale), at least one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."fromSize" IS NULL) <> (NEW."toSize" IS NULL) OR (NEW."fromSize" IS NOT NULL AND NEW."sizeScaleId" IS NULL) THEN
    RAISE EXCEPTION 'packing: packaging default % names its size run from one size to another of a size scale, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- A live default names an ACTIVE packaging when it is named or switched on.
  IF NEW."active" AND (TG_OP = 'INSERT' OR NEW."packagingTypeId" <> OLD."packagingTypeId" OR NOT OLD."active") THEN
    SELECT t."active" INTO type_active FROM "PackagingType" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."packagingTypeId";
    IF FOUND AND NOT type_active THEN
      RAISE EXCEPTION 'packing: packaging default % names packaging type %, which is switched off', NEW."id", NEW."packagingTypeId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR (NEW."styleId", NEW."sizeScaleId", NEW."fromSize", NEW."toSize") IS DISTINCT FROM (OLD."styleId", OLD."sizeScaleId", OLD."fromSize", OLD."toSize") THEN
    IF NEW."styleId" IS NOT NULL THEN
      SELECT s."companyId", s."sizeScaleId", s."status"::text INTO style_company, style_scale, style_status
        FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
      IF FOUND THEN
        IF style_company IS NOT NULL AND style_company <> NEW."companyId" THEN
          RAISE EXCEPTION 'packing: packaging default % is for style %, which belongs to another company', NEW."id", NEW."styleId"
            USING ERRCODE = 'check_violation';
        END IF;
        IF style_status = 'ARCHIVED' AND (TG_OP = 'INSERT' OR NEW."styleId" IS DISTINCT FROM OLD."styleId") THEN
          RAISE EXCEPTION 'packing: packaging default % is for style %, which is archived', NEW."id", NEW."styleId"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."sizeScaleId" IS NOT NULL AND NEW."sizeScaleId" <> style_scale THEN
          RAISE EXCEPTION 'packing: packaging default % runs over sizes of the style''s own scale %', NEW."id", style_scale
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
    IF NEW."sizeScaleId" IS NOT NULL THEN
      SELECT z."companyId" INTO scale_company FROM "SizeScale" z WHERE z."tenantId" = NEW."tenantId" AND z."id" = NEW."sizeScaleId";
      IF FOUND THEN
        IF scale_company IS NOT NULL AND scale_company <> NEW."companyId" THEN
          RAISE EXCEPTION 'packing: packaging default % runs over size scale %, which belongs to another company', NEW."id", NEW."sizeScaleId"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."fromSize" IS NOT NULL THEN
          SELECT z."seq" INTO from_seq FROM "Size" z WHERE z."tenantId" = NEW."tenantId" AND z."scaleId" = NEW."sizeScaleId" AND z."code" = NEW."fromSize";
          SELECT z."seq" INTO to_seq FROM "Size" z WHERE z."tenantId" = NEW."tenantId" AND z."scaleId" = NEW."sizeScaleId" AND z."code" = NEW."toSize";
          IF from_seq IS NULL OR to_seq IS NULL OR from_seq > to_seq THEN
            RAISE EXCEPTION 'packing: packaging default % runs from size % to size %: sizes of scale %, the first not after the last', NEW."id", NEW."fromSize", NEW."toSize", NEW."sizeScaleId"
              USING ERRCODE = 'check_violation';
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "PackagingDefault_guard" AFTER INSERT OR UPDATE ON "PackagingDefault"
  FOR EACH ROW EXECUTE FUNCTION "factory_packaging_default_guard"();

-- One live default per company, kind, style and size run.
CREATE UNIQUE INDEX "PackagingDefault_one_live" ON "PackagingDefault" (
  "tenantId", "companyId", "kind", (coalesce("styleId", '00000000-0000-0000-0000-000000000000'::uuid)),
  (coalesce("sizeScaleId", '00000000-0000-0000-0000-000000000000'::uuid)), (coalesce("fromSize", '')), (coalesce("toSize", ''))
) WHERE "active";

-- =====================================================================================================================
-- ParcelLine (LOG-007, LOG-010)
CREATE FUNCTION "factory_parcel_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  part_of uuid;
  state text;
  line_size text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."shipmentId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."shipmentId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'packing: carton contents % never move to another shipment, and their creation never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    part_of := OLD."shipmentId";
    SELECT sh."status"::text INTO state FROM "Shipment" sh WHERE sh."tenantId" = OLD."tenantId" AND sh."id" = OLD."shipmentId" FOR SHARE;
  ELSE
    part_of := NEW."shipmentId";
    SELECT sh."status"::text INTO state FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."shipmentId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'packing: shipment % is %; its cartons'' contents change only while it is a DRAFT', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;

  IF NEW."quantity" < 1 THEN
    RAISE EXCEPTION 'packing: carton contents % hold at least one garment', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."size" INTO line_size FROM "ShipmentLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."shipmentLineId";
  IF FOUND AND line_size <> NEW."size" THEN
    RAISE EXCEPTION 'packing: carton contents % are garments of shipment line %, of size %: that size, not %', NEW."id", NEW."shipmentLineId", line_size, NEW."size"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."quantity" > OLD."quantity" OR NEW."parcelId" <> OLD."parcelId" OR NEW."shipmentLineId" <> OLD."shipmentLineId" THEN
    PERFORM "factory_packing_refuse_held"(NEW."tenantId", NEW."shipmentId", 'nothing more goes into its cartons until the hold is released');
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ParcelLine_guard" AFTER INSERT OR UPDATE OR DELETE ON "ParcelLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_parcel_line_guard"();

-- =====================================================================================================================
-- ShippingMarkTemplate (LOG-013)
CREATE FUNCTION "factory_shipping_mark_template_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  party_roles text[];
  party_company uuid;
  party_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."partyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'packing: the company, customer and creation of mark template % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."fields" IS NULL OR cardinality(NEW."fields") NOT BETWEEN 1 AND 16
     OR (SELECT count(DISTINCT f) FROM unnest(NEW."fields") f) <> cardinality(NEW."fields") THEN
    RAISE EXCEPTION 'packing: mark template % shows 1 to 16 fields, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."language" !~ '^[a-z]{2}$' THEN
    RAISE EXCEPTION 'packing: mark template % is printed in a language of two lower-case letters (ISO 639-1), not %', NEW."id", NEW."language"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."partyId" IS NOT NULL THEN
    SELECT p."roles"::text[], p."companyId", p."status"::text INTO party_roles, party_company, party_status
      FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND THEN
      IF NOT (coalesce(party_roles, ARRAY[]::text[]) && ARRAY['CUSTOMER', 'BRAND']) OR party_status = 'ARCHIVED'
         OR (party_company IS NOT NULL AND party_company <> NEW."companyId") THEN
        RAISE EXCEPTION 'packing: mark template % is for party %: a customer or brand of its company or of every company, not archived', NEW."id", NEW."partyId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ShippingMarkTemplate_guard" AFTER INSERT OR UPDATE ON "ShippingMarkTemplate"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipping_mark_template_guard"();

-- One live template per company and customer, and one live default.
CREATE UNIQUE INDEX "ShippingMarkTemplate_one_live" ON "ShippingMarkTemplate" ("tenantId", "companyId", (coalesce("partyId", '00000000-0000-0000-0000-000000000000'::uuid)))
  WHERE "active";

-- =====================================================================================================================
-- ShipmentHold (LOG-017, FIN-079)
CREATE FUNCTION "factory_shipment_hold_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  loose CONSTANT text[] := ARRAY['version', 'updatedAt'];
  release CONSTANT text[] := ARRAY['releasedAt', 'releasedById', 'releaseWords'];
  state text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- FOR NO KEY UPDATE: a write that packs, labels or sends the shipment locks it FOR SHARE (or updates it) and waits, or
    -- is done first; two holds placed at once take turns (the foreign key's FOR KEY SHARE does not block this lock).
    SELECT sh."status"::text INTO state FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."shipmentId" FOR NO KEY UPDATE;
    IF FOUND AND state NOT IN ('DRAFT', 'PACKED') THEN
      RAISE EXCEPTION 'packing: shipment % is %; a hold is placed only on a shipment that has not left (DRAFT or PACKED)', NEW."shipmentId", state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_recall_not_future"(NEW."placedAt") THEN
      RAISE EXCEPTION 'packing: hold % is placed at a time not in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."releasedAt" IS NOT NULL AND (to_jsonb(NEW) - loose) IS DISTINCT FROM (to_jsonb(OLD) - loose) THEN
      RAISE EXCEPTION 'packing: hold % was released and never changes; a new hold is placed as its own', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - (loose || release)) IS DISTINCT FROM (to_jsonb(OLD) - (loose || release)) THEN
      RAISE EXCEPTION 'packing: hold % is never edited: it is released once with why, and a new one placed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."reason" = 'OTHER' AND NEW."words" IS NULL) OR NOT "factory_recall_words_ok"(NEW."words", 2000, true) THEN
    RAISE EXCEPTION 'packing: hold % says why in words (1 to 2000 characters; required for OTHER)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."releasedAt" IS NULL) <> (NEW."releaseWords" IS NULL) OR (NEW."releasedById" IS NOT NULL AND NEW."releasedAt" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."releaseWords", 2000, true) THEN
    RAISE EXCEPTION 'packing: hold % is released with when and why (1 to 2000 characters), both or neither, and by whom only with them', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."releasedAt" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."releasedAt" IS NULL)
     AND (NEW."releasedAt" < NEW."placedAt" OR NOT "factory_recall_not_future"(NEW."releasedAt")) THEN
    RAISE EXCEPTION 'packing: hold % is released not before it was placed and not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ShipmentHold_guard" AFTER INSERT OR UPDATE ON "ShipmentHold"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipment_hold_guard"();

-- At most one hold in force per shipment and reason.
CREATE UNIQUE INDEX "ShipmentHold_one_in_force" ON "ShipmentHold" ("tenantId", "shipmentId", "reason") WHERE "releasedAt" IS NULL;

-- =====================================================================================================================
-- CarrierCutOff (LOG-018, LOG-110)
CREATE FUNCTION "factory_carrier_cut_off_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."siteId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."siteId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'packing: the company, site and creation of cut-off % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."carrierCode" !~ '^[^[:space:][:cntrl:]]{1,40}$' THEN
    RAISE EXCEPTION 'packing: cut-off % names its carrier by a code of 1 to 40 characters without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."cutOffTime" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RAISE EXCEPTION 'packing: cut-off % is a time of day HH:MM (24 hours), not %', NEW."id", NEW."cutOffTime"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "CarrierCutOff_guard" AFTER INSERT OR UPDATE ON "CarrierCutOff"
  FOR EACH ROW EXECUTE FUNCTION "factory_carrier_cut_off_guard"();

-- =====================================================================================================================
-- Shipment (LOG-005, LOG-010, LOG-013, LOG-017): its own trigger; the shipment guard stays as it is.
CREATE FUNCTION "factory_shipment_packing_check"() RETURNS trigger LANGUAGE plpgsql AS $$
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
        IF parent."salesOrderId" <> NEW."salesOrderId" THEN
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
CREATE TRIGGER "Shipment_packing_check" AFTER INSERT OR UPDATE OF "status", "splitFromId", "splitReason" ON "Shipment"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipment_packing_check"();

-- =====================================================================================================================
-- Parcel (LOG-008, LOG-013, LOG-017): its own triggers; the parcel guard and the tracking page check stay as they are.
CREATE FUNCTION "factory_parcel_packing_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shipment_company uuid;
  type_company uuid;
  type_kind text;
  type_active boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF NEW."packagingTypeId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."packagingTypeId" IS DISTINCT FROM OLD."packagingTypeId") THEN
    SELECT t."companyId", t."kind"::text, t."active" INTO type_company, type_kind, type_active
      FROM "PackagingType" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."packagingTypeId";
    IF FOUND THEN
      SELECT sh."companyId" INTO shipment_company FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."shipmentId";
      IF shipment_company IS NOT NULL AND type_company <> shipment_company THEN
        RAISE EXCEPTION 'packing: parcel % is packed in packaging type % of another company than its shipment''s', NEW."id", NEW."packagingTypeId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF type_kind NOT IN ('CARTON', 'BOX', 'PALLET') THEN
        RAISE EXCEPTION 'packing: parcel % is a CARTON, a BOX or a PALLET, not a %', NEW."id", type_kind
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT type_active THEN
        RAISE EXCEPTION 'packing: parcel % names packaging type %, which is switched off', NEW."id", NEW."packagingTypeId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF (NEW."cartonNumber" IS NULL) <> (NEW."cartonCount" IS NULL) OR NEW."cartonNumber" < 1 OR NEW."cartonNumber" > NEW."cartonCount" OR NEW."cartonCount" > 9999 THEN
    RAISE EXCEPTION 'packing: parcel % is carton n of N as printed: n from 1 and at most N, N at most 9999, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."marksPrintedAt" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."marksPrintedAt" IS DISTINCT FROM OLD."marksPrintedAt")
     AND NOT "factory_recall_not_future"(NEW."marksPrintedAt") THEN
    RAISE EXCEPTION 'packing: the marks of parcel % were printed at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."labelledAt" IS NOT NULL OR NEW."trackingNumber" IS NOT NULL)
     AND (TG_OP = 'INSERT' OR NEW."labelledAt" IS DISTINCT FROM OLD."labelledAt" OR NEW."trackingNumber" IS DISTINCT FROM OLD."trackingNumber") THEN
    PERFORM "factory_packing_refuse_held"(NEW."tenantId", NEW."shipmentId", 'its parcels get no carrier label until the hold is released');
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Parcel_packing_check" AFTER INSERT OR UPDATE OF "packagingTypeId", "cartonNumber", "cartonCount", "marksPrintedAt", "labelledAt", "trackingNumber" ON "Parcel"
  FOR EACH ROW EXECUTE FUNCTION "factory_parcel_packing_check"();

-- A parcel that holds carton contents or packed serials is not removed (the words before the foreign key's).
CREATE FUNCTION "factory_parcel_contents_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ParcelLine" c WHERE c."tenantId" = OLD."tenantId" AND c."parcelId" = OLD."id")
     OR EXISTS (SELECT 1 FROM "GarmentSerial" g WHERE g."tenantId" = OLD."tenantId" AND g."parcelId" = OLD."id") THEN
    RAISE EXCEPTION 'packing: parcel % holds carton contents or packed serials; take them out first', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER "Parcel_contents_kept" BEFORE DELETE ON "Parcel"
  FOR EACH ROW EXECUTE FUNCTION "factory_parcel_contents_kept"();

-- =====================================================================================================================
-- ShipmentLine (LOG-010, LOG-017): its own triggers; the line guard and the quality hold check stay as they are.
CREATE FUNCTION "factory_shipment_line_packing_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF NEW."size" <> OLD."size"
       AND EXISTS (SELECT 1 FROM "ParcelLine" c WHERE c."tenantId" = NEW."tenantId" AND c."shipmentLineId" = NEW."id" AND c."size" <> NEW."size") THEN
      RAISE EXCEPTION 'packing: shipment line % has carton contents of size %; take them out before its size changes', NEW."id", OLD."size"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."parcelId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."parcelId" IS DISTINCT FROM OLD."parcelId" OR NEW."quantity" > OLD."quantity") THEN
    PERFORM "factory_packing_refuse_held"(NEW."tenantId", NEW."shipmentId", 'nothing more goes into its parcels until the hold is released');
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ShipmentLine_packing_check" AFTER INSERT OR UPDATE OF "parcelId", "quantity", "size" ON "ShipmentLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipment_line_packing_check"();

-- A line with carton contents is not removed (the words before the foreign key's).
CREATE FUNCTION "factory_shipment_line_contents_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ParcelLine" c WHERE c."tenantId" = OLD."tenantId" AND c."shipmentLineId" = OLD."id") THEN
    RAISE EXCEPTION 'packing: shipment line % has carton contents; take them out first', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER "ShipmentLine_contents_kept" BEFORE DELETE ON "ShipmentLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipment_line_contents_kept"();

-- =====================================================================================================================
-- GarmentSerial (LOG-003, LOG-007): its own triggers; the serial guard and its quality hold check stay as they are.

-- The carton goes with the line: when an UPDATE clears the serial's shipment line (unpacked, or F1's carrier return
-- received), its carton, time and packer are cleared too. Named to fire after GarmentSerial_guard (BEFORE triggers fire
-- in name order), so the guard judges the change as it was asked.
CREATE FUNCTION "factory_garment_serial_unpack_carton"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."parcelId" := NULL;
  NEW."packedAt" := NULL;
  NEW."packedById" := NULL;
  RETURN NEW;
END
$$;
CREATE TRIGGER "GarmentSerial_unpack_carton" BEFORE UPDATE OF "shipmentLineId" ON "GarmentSerial"
  FOR EACH ROW WHEN (NEW."shipmentLineId" IS NULL AND NEW."parcelId" IS NOT NULL)
  EXECUTE FUNCTION "factory_garment_serial_unpack_carton"();

CREATE FUNCTION "factory_garment_serial_carton_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_shipment uuid;
  parcel_shipment uuid;
  state text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF (NEW."parcelId" IS NULL) <> (NEW."packedAt" IS NULL) OR (NEW."packedById" IS NOT NULL AND NEW."parcelId" IS NULL)
     OR (NEW."parcelId" IS NOT NULL AND NEW."shipmentLineId" IS NULL) THEN
    RAISE EXCEPTION 'packing: serial % lies in a carton with the time it was packed (both or neither), its packer only with them, and only on a shipment line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."parcelId" IS NOT DISTINCT FROM OLD."parcelId"
     AND (NEW."packedAt", NEW."packedById") IS DISTINCT FROM (OLD."packedAt", OLD."packedById") THEN
    RAISE EXCEPTION 'packing: the packing time and packer of serial % change only with its carton', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."parcelId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."parcelId" IS DISTINCT FROM OLD."parcelId" OR NEW."shipmentLineId" IS DISTINCT FROM OLD."shipmentLineId") THEN
    IF NEW."status" <> 'RELEASED' THEN
      RAISE EXCEPTION 'packing: serial % is %; only a RELEASED serial goes into a carton (QHS-073)', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_recall_not_future"(NEW."packedAt") THEN
      RAISE EXCEPTION 'packing: serial % was packed at a time not in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT l."shipmentId" INTO line_shipment FROM "ShipmentLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."shipmentLineId";
    SELECT p."shipmentId" INTO parcel_shipment FROM "Parcel" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."parcelId";
    IF line_shipment IS NOT NULL AND parcel_shipment IS NOT NULL AND line_shipment <> parcel_shipment THEN
      RAISE EXCEPTION 'packing: serial % goes into a carton of its shipment line''s shipment %', NEW."id", line_shipment
        USING ERRCODE = 'check_violation';
    END IF;
    IF parcel_shipment IS NOT NULL THEN
      SELECT sh."status"::text INTO state FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = parcel_shipment FOR SHARE;
      IF FOUND AND state <> 'DRAFT' THEN
        RAISE EXCEPTION 'packing: shipment % is %; serials go into its cartons only while it is a DRAFT', parcel_shipment, state
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM "factory_packing_refuse_held"(NEW."tenantId", parcel_shipment, 'nothing more goes into its cartons until the hold is released');
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "GarmentSerial_carton_check" AFTER INSERT OR UPDATE OF "parcelId", "packedAt", "packedById", "shipmentLineId" ON "GarmentSerial"
  FOR EACH ROW EXECUTE FUNCTION "factory_garment_serial_carton_check"();
