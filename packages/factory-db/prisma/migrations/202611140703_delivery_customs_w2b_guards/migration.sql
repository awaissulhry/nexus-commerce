-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202611140702_delivery_customs_w2b_schema and before the policy migration. When the migrations are renumbered, keep this file
-- as it is under its new timestamp.

-- Delivery, returns and customs, W2b-6 schema wave 51/57 (B-W2b-372; LOG-061, LOG-063, LOG-065, LOG-067, LOG-086, LOG-087,
-- LOG-088, LOG-089, LOG-095, LOG-097, LOG-112). apps/factory-api checks all of this first and answers in words (B-W2b-398,
-- -409); these rules are the last word, for every login, the owner included.
--
--   TrackingException   its site, party, shipment, kind, raise time and creation never change; raised (not in the future) only
--                       on a shipment that left (SHIPPED, DELIVERED, RETURNED), an open one only while it travels (SHIPPED);
--                       one open per shipment and kind (a partial unique index); its task named once, a Task of the
--                       shipment; resolved once (not before it was raised, not in the future), then frozen. Never deleted.
--   ReturnLabel         its company, site, party, RMA, carrier, link and creation never change; made OFFERED (exactly with
--                       its link: a RETURN_LABEL link of the RMA, of its company, not revoked) or BOOKED (no link) while the
--                       RMA is AUTHORISED or RECEIVED; the carrier's code 1 to 40 characters without spaces; OFFERED →
--                       BOOKED (while the RMA still is AUTHORISED or RECEIVED) | CANCELLED, BOOKED → USED | CANCELLED, USED
--                       and CANCELLED frozen; the booking reference (1 to 100 characters on one line) and the label (a file
--                       of the RMA, of its company) both or neither, from BOOKED on, nothing while OFFERED, each set once;
--                       used (not in the future) exactly when USED. Never deleted.
--   CustomsDeclaration  its company, site, party, shipment, broker and creation never change; made PACK_SENT for a shipment
--                       that is not CANCELLED; PACK_SENT → FILED → EXITED, never back, EXITED frozen; the MRN (two digits,
--                       two capitals, 14 capitals or digits) exactly from FILED on, set once; the invoice named once; the
--                       exit confirmed (not in the future, not before the goods left) and its proof (a file of the
--                       declaration, of its company) exactly when EXITED, which needs the invoice issued (not a DRAFT) and
--                       the shipment gone (SHIPPED or DELIVERED); the alert after 1 to 365 days. Removed only while
--                       PACK_SENT (a BEFORE trigger).
--   Shipment            REDEFINED `factory_shipment_guard` (…_carriers_w2b_guards, word for word) with the proof of delivery
--                       among what still changes once the goods left. Its own trigger Shipment_pod_check: who signed (1 to
--                       200 characters on one line), when (not in the future, not before it left) and the image (a file
--                       of the shipment, of its company) only on a DELIVERED shipment, each set once.
--   SalesOrder          REDEFINED `factory_sales_order_guard` (…_sales_orders_depth_w2b_guards, word for word) with DELIVERED:
--                       only from SHIPPED, and out of it only CLOSED (CLOSED from SHIPPED or DELIVERED). Its own trigger
--                       SalesOrder_delivered_check: deliveredAt exactly while DELIVERED (and kept once CLOSED from it), set
--                       in the move SHIPPED → DELIVERED (not in the future) and never changed; that move needs one
--                       DELIVERED shipment of the order and none still travelling (SHIPPED).
--   Company             its own trigger Company_eori_check: the EORI two capitals then 1 to 15 capitals or digits.
--   GeneratedDocument   REDEFINED `factory_generated_document_check` (…_carriers_w2b_guards' body, word for word) with
--                       COMMERCIAL_INVOICE, CN22 and CN23 of a Shipment (its company and site).
--   LinkFile            REDEFINED `factory_link_file_guard` (…_links_depth_w2b_guards, word for word) with BROKER_PACK among
--                       the links that carry a set of files.
--   OneOffLink          its own trigger OneOffLink_delivery_customs_check (W0's and wave 19's guard untouched): a BROKER_PACK
--                       link opens a CustomsDeclaration of its company whose broker is the link's party, while its pack is
--                       merely sent and the shipment's site switched the broker pack on (ShippingSettings.brokerPackOn,
--                       OFF by default: the Owner's rule of 11-13); a RETURN_LABEL link opens a ReturnAuthorisation of its
--                       company and party that is AUTHORISED or RECEIVED.
--   TRUNCATE            refused on the three new tables.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the checks are AFTER triggers (the
-- policies speak first), but the refused deletes (BEFORE: the words come before a foreign key's); the redefined functions keep
-- their triggers. A rule that reads another row skips a row this session cannot see. An UPDATE that changes nothing passes.
-- Nothing reads factory.actor_id. No data to copy: every new column is null or takes its default on the rows before it (the
-- two switches OFF), and none of them breaks a new rule.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed) and insert the copy:
-- so the first rows the seed gives are ones a copy may repeat (a resolved tracking problem, a label offered by link on the
-- waiting RMA, a declaration whose pack is merely sent), and a label's link and file are the RMA's (not the label's own).
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok" and "factory_recall_not_future" (…_recall_claims_w2b_guards),
-- "factory_carriers_code_ok" (…_carriers_w2b_guards).

CREATE FUNCTION "factory_delivery_customs_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_delivery_customs_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery: % % is kept, never deleted (resolve it or cancel it)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['TrackingException', 'ReturnLabel', 'CustomsDeclaration'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_delivery_customs_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['TrackingException', 'ReturnLabel'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "factory_delivery_customs_never_deleted"()', name || '_never_deleted', name);
  END LOOP;
END
$$;

-- =====================================================================================================================
-- TrackingException (LOG-063)
CREATE FUNCTION "factory_tracking_exception_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shipment_state text;
  task record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."siteId", NEW."partyId", NEW."shipmentId", NEW."kind", NEW."raisedAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."siteId", OLD."partyId", OLD."shipmentId", OLD."kind", OLD."raisedAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'delivery: the shipment, kind, raise time and creation of tracking problem % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."resolvedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'delivery: tracking problem % was resolved at %; it never changes', OLD."id", OLD."resolvedAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."taskId" IS NOT NULL AND NEW."taskId" IS DISTINCT FROM OLD."taskId" THEN
      RAISE EXCEPTION 'delivery: tracking problem % names its task once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_not_future"(NEW."raisedAt") THEN
    RAISE EXCEPTION 'delivery: tracking problem % is raised in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."resolvedAt" IS NOT NULL AND (NEW."resolvedAt" < NEW."raisedAt" OR NOT "factory_recall_not_future"(NEW."resolvedAt")) THEN
    RAISE EXCEPTION 'delivery: tracking problem % is resolved after it was raised, not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT s."status"::text INTO shipment_state FROM "Shipment" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."shipmentId";
    IF FOUND AND (shipment_state NOT IN ('SHIPPED', 'DELIVERED', 'RETURNED') OR (NEW."resolvedAt" IS NULL AND shipment_state <> 'SHIPPED')) THEN
      RAISE EXCEPTION 'delivery: shipment % is %; a tracking problem is raised only once it left, and an open one only while it travels (SHIPPED)', NEW."shipmentId", shipment_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."taskId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."taskId" IS NULL) THEN
    SELECT t."recordType", t."recordId" INTO task FROM "Task" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."taskId";
    IF FOUND AND (task."recordType", task."recordId") IS DISTINCT FROM ('Shipment'::text, NEW."shipmentId") THEN
      RAISE EXCEPTION 'delivery: tracking problem % is worked in a task of its shipment %, not of % %', NEW."id", NEW."shipmentId", coalesce(task."recordType", 'no record'), task."recordId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "TrackingException_guard" AFTER INSERT OR UPDATE ON "TrackingException"
  FOR EACH ROW EXECUTE FUNCTION "factory_tracking_exception_guard"();

-- One open problem per shipment and kind (a resolved one may be raised again).
CREATE UNIQUE INDEX "TrackingException_one_open" ON "TrackingException" ("tenantId", "shipmentId", "kind") WHERE "resolvedAt" IS NULL;

-- =====================================================================================================================
-- ReturnLabel (LOG-112)
CREATE FUNCTION "factory_return_label_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  return_state text;
  link record;
  file record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."siteId", NEW."partyId", NEW."returnId", NEW."carrierCode", NEW."linkId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."siteId", OLD."partyId", OLD."returnId", OLD."carrierCode", OLD."linkId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'delivery: the return, carrier, link and creation of return label % never change (a new label is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('USED', 'CANCELLED') THEN
      RAISE EXCEPTION 'delivery: return label % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'OFFERED' AND NEW."status" IN ('BOOKED', 'CANCELLED'))
                OR (OLD."status" = 'BOOKED' AND NEW."status" IN ('USED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'delivery: return label % cannot move from % to % (OFFERED → BOOKED or CANCELLED, BOOKED → USED or CANCELLED)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."bookingReference" IS NOT NULL AND NEW."bookingReference" IS DISTINCT FROM OLD."bookingReference")
       OR (OLD."labelFileId" IS NOT NULL AND NEW."labelFileId" IS DISTINCT FROM OLD."labelFileId") THEN
      RAISE EXCEPTION 'delivery: the booking reference and the label of return label % are set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."status" NOT IN ('OFFERED', 'BOOKED') OR (NEW."status" = 'OFFERED') <> (NEW."linkId" IS NOT NULL) THEN
      RAISE EXCEPTION 'delivery: return label % is made OFFERED with its link, or BOOKED without one (not %)', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_carriers_code_ok"(NEW."carrierCode") THEN
    RAISE EXCEPTION 'delivery: return label % names its carrier by a code of 1 to 40 characters without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."bookingReference" IS NULL) <> (NEW."labelFileId" IS NULL)
     OR (NEW."status" = 'OFFERED' AND NEW."bookingReference" IS NOT NULL)
     OR (NEW."status" IN ('BOOKED', 'USED') AND NEW."bookingReference" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."bookingReference", 100, false) THEN
    RAISE EXCEPTION 'delivery: return label % is % with the wrong booking: the booking reference (1 to 100 characters on one line) and the label come together, from BOOKED on', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'USED') <> (NEW."usedAt" IS NOT NULL) OR NOT "factory_recall_not_future"(NEW."usedAt") THEN
    RAISE EXCEPTION 'delivery: return label % has the time the carrier had the parcel exactly when USED, not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- Made, or booked: the customer may still send the goods.
  IF TG_OP = 'INSERT' OR (NEW."status" = 'BOOKED' AND OLD."status" = 'OFFERED') THEN
    SELECT r."status"::text INTO return_state FROM "ReturnAuthorisation" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."returnId";
    IF FOUND AND return_state NOT IN ('AUTHORISED', 'RECEIVED') THEN
      RAISE EXCEPTION 'delivery: return % is %; a return label is made and booked only while the goods may come back (AUTHORISED or RECEIVED)', NEW."returnId", return_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND NEW."linkId" IS NOT NULL THEN
    SELECT l."purpose"::text AS purpose, l."companyId", l."recordType", l."recordId", l."revokedAt" INTO link
      FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."partyId" = NEW."partyId" AND l."id" = NEW."linkId";
    IF FOUND AND (link.purpose <> 'RETURN_LABEL' OR (link."companyId", link."recordType", link."recordId") IS DISTINCT FROM (NEW."companyId", 'ReturnAuthorisation'::text, NEW."returnId")
                  OR link."revokedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'delivery: return label % is offered by a RETURN_LABEL link of its return % that is not revoked', NEW."id", NEW."returnId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."labelFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."labelFileId" IS NULL) THEN
    SELECT f."recordType", f."recordId", f."companyId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."labelFileId";
    IF FOUND AND (file."recordType", file."recordId", file."companyId") IS DISTINCT FROM ('ReturnAuthorisation'::text, NEW."returnId", NEW."companyId") THEN
      RAISE EXCEPTION 'delivery: the label of return label % is a file of its return % and company', NEW."id", NEW."returnId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ReturnLabel_guard" AFTER INSERT OR UPDATE ON "ReturnLabel"
  FOR EACH ROW EXECUTE FUNCTION "factory_return_label_guard"();

-- =====================================================================================================================
-- CustomsDeclaration (LOG-088, LOG-089)
CREATE FUNCTION "factory_customs_declaration_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shipment record;
  invoice_state text;
  file record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."siteId", NEW."partyId", NEW."shipmentId", NEW."brokerPartyId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."siteId", OLD."partyId", OLD."shipmentId", OLD."brokerPartyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'customs: the shipment, broker and creation of customs declaration % never change (another broker is a new declaration)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'EXITED' THEN
      RAISE EXCEPTION 'customs: customs declaration % is EXITED; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND (OLD."status" = 'FILED' AND NEW."status" = 'PACK_SENT') THEN
      RAISE EXCEPTION 'customs: customs declaration % cannot move from % back to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."mrn" IS NOT NULL AND NEW."mrn" IS DISTINCT FROM OLD."mrn")
       OR (OLD."invoiceId" IS NOT NULL AND NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId") THEN
      RAISE EXCEPTION 'customs: the MRN and the invoice of customs declaration % are set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."status" <> 'PACK_SENT' THEN
      RAISE EXCEPTION 'customs: customs declaration % starts with its pack sent (PACK_SENT), not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."status" IN ('FILED', 'EXITED')) <> (NEW."mrn" IS NOT NULL) OR coalesce(NEW."mrn", '00IT00000000000000') !~ '^[0-9]{2}[A-Z]{2}[A-Z0-9]{14}$' THEN
    RAISE EXCEPTION 'customs: customs declaration % is % with the wrong MRN: from FILED on it has its MRN (two digits, two capitals, 14 capitals or digits), before none', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'EXITED') <> (NEW."exitConfirmedAt" IS NOT NULL) OR (NEW."exitConfirmedAt" IS NULL) <> (NEW."exitFileId" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."exitConfirmedAt") THEN
    RAISE EXCEPTION 'customs: customs declaration % has its exit confirmed (when, not in the future, and its proof) exactly when EXITED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."alertAfterDays" NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'customs: customs declaration % raises its alert after 1 to 365 days', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR (NEW."status" = 'EXITED' AND OLD."status" <> 'EXITED') THEN
    SELECT s."status"::text AS status, s."shippedAt" INTO shipment FROM "Shipment" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."shipmentId";
    IF FOUND AND TG_OP = 'INSERT' AND shipment.status = 'CANCELLED' THEN
      RAISE EXCEPTION 'customs: shipment % is CANCELLED; no customs declaration is made for it', NEW."shipmentId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND NEW."status" = 'EXITED' AND (shipment.status NOT IN ('SHIPPED', 'DELIVERED') OR NEW."exitConfirmedAt" < shipment."shippedAt") THEN
      RAISE EXCEPTION 'customs: shipment % is %; the exit of customs declaration % is confirmed once the goods left (SHIPPED or DELIVERED), not before', NEW."shipmentId", shipment.status, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" = 'EXITED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'EXITED') THEN
    IF NEW."invoiceId" IS NULL THEN
      RAISE EXCEPTION 'customs: customs declaration % is EXITED against its invoice (name it first)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."status"::text INTO invoice_state FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";
    IF FOUND AND invoice_state = 'DRAFT' THEN
      RAISE EXCEPTION 'customs: customs declaration % is EXITED against an issued invoice (invoice % is a DRAFT)', NEW."id", NEW."invoiceId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."exitFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."exitFileId" IS DISTINCT FROM NEW."exitFileId") THEN
    SELECT f."recordType", f."recordId", f."companyId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."exitFileId";
    IF FOUND AND (file."recordType", file."recordId", file."companyId") IS DISTINCT FROM ('CustomsDeclaration'::text, NEW."id", NEW."companyId") THEN
      RAISE EXCEPTION 'customs: the proof of exit of customs declaration % is a file of the declaration and its company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "CustomsDeclaration_guard" AFTER INSERT OR UPDATE ON "CustomsDeclaration"
  FOR EACH ROW EXECUTE FUNCTION "factory_customs_declaration_guard"();

-- A declaration whose pack went by mistake is removed while merely sent; once filed it is kept.
CREATE FUNCTION "factory_customs_declaration_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PACK_SENT' THEN
    RAISE EXCEPTION 'customs: customs declaration % is %; it is kept (only a declaration whose pack is merely sent is removed)', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER "CustomsDeclaration_delete" BEFORE DELETE ON "CustomsDeclaration"
  FOR EACH ROW EXECUTE FUNCTION "factory_customs_declaration_delete"();

-- =====================================================================================================================
-- Shipment: the proof of delivery (LOG-065)

-- REDEFINES factory_shipment_guard (202611140403_carriers_w2b_guards, the last to redefine it), its whole body: the carrier's
-- proof of delivery still changes once the goods left. The trigger stays.
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
    'podSignedBy', 'podAt', 'podFileId'];
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
-- Shipment (new trigger Shipment_pod_check; the shipment guard keeps its own rules): the proof of delivery.
CREATE FUNCTION "factory_shipment_pod_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  file record;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."podSignedBy", NEW."podAt", NEW."podFileId", NEW."status") IS NOT DISTINCT FROM (OLD."podSignedBy", OLD."podAt", OLD."podFileId", OLD."status") THEN
    RETURN NULL;
  END IF;
  IF (NEW."podSignedBy" IS NOT NULL OR NEW."podAt" IS NOT NULL OR NEW."podFileId" IS NOT NULL) AND NEW."status" <> 'DELIVERED' THEN
    RAISE EXCEPTION 'delivery: shipment % is %; the carrier''s proof of delivery is kept on a DELIVERED shipment only', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE'
     AND ((OLD."podSignedBy" IS NOT NULL AND NEW."podSignedBy" IS DISTINCT FROM OLD."podSignedBy")
          OR (OLD."podAt" IS NOT NULL AND NEW."podAt" IS DISTINCT FROM OLD."podAt")
          OR (OLD."podFileId" IS NOT NULL AND NEW."podFileId" IS DISTINCT FROM OLD."podFileId")) THEN
    RAISE EXCEPTION 'delivery: who signed for shipment %, when and the image are each set once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."podSignedBy", 200, false) THEN
    RAISE EXCEPTION 'delivery: who signed for shipment % is 1 to 200 characters on one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."podAt" IS NOT NULL AND (NOT "factory_recall_not_future"(NEW."podAt") OR NEW."podAt" < NEW."shippedAt") THEN
    RAISE EXCEPTION 'delivery: shipment % was signed for after it left, not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."podFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."podFileId" IS NULL) THEN
    SELECT f."recordType", f."recordId", f."companyId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."podFileId";
    IF FOUND AND (file."recordType", file."recordId", file."companyId") IS DISTINCT FROM ('Shipment'::text, NEW."id", NEW."companyId") THEN
      RAISE EXCEPTION 'delivery: the proof of delivery of shipment % is a file of the shipment and its company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Shipment_pod_check" AFTER INSERT OR UPDATE OF "podSignedBy", "podAt", "podFileId", "status" ON "Shipment"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipment_pod_check"();

-- =====================================================================================================================
-- SalesOrder: delivered (LOG-067)

-- REDEFINES factory_sales_order_guard (202611011303_sales_orders_depth_w2b_guards, the last to redefine it), its whole body:
-- DELIVERED only from SHIPPED, out of it only CLOSED. The trigger stays.
CREATE OR REPLACE FUNCTION "factory_sales_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  state text;
  quote_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales: sales order % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."quoteVersionId" IS NOT NULL THEN
      SELECT v."status"::text, q."companyId" INTO state, quote_company
        FROM "QuoteVersion" v JOIN "Quote" q ON q."tenantId" = v."tenantId" AND q."id" = v."quoteId"
        WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."quoteVersionId";
      IF FOUND AND (state <> 'ACCEPTED' OR quote_company <> NEW."companyId") THEN
        RAISE EXCEPTION 'sales: sales order % is made only from an ACCEPTED version of a quote of its own company (version % is %)', NEW."id", NEW."quoteVersionId", state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."number", NEW."quoteVersionId", NEW."currency", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."partyId", OLD."number", OLD."quoteVersionId", OLD."currency", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales: the company, party, number, quote version, currency and creation of sales order % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."originalPromiseDate" IS NOT NULL AND NEW."originalPromiseDate" IS DISTINCT FROM OLD."originalPromiseDate" THEN
      RAISE EXCEPTION 'sales: the first promised date of sales order % is set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'sales: sales order % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND ((NEW."status" = 'CLOSED' AND OLD."status" NOT IN ('SHIPPED', 'DELIVERED'))
            OR (NEW."status" = 'CANCELLED' AND OLD."status" NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PENDING_APPROVAL'))
            -- W2b-6 (B-W2b-372; LOG-067): DELIVERED only from SHIPPED; out of it only CLOSED.
            OR (NEW."status" = 'DELIVERED' AND OLD."status" <> 'SHIPPED')
            OR (OLD."status" = 'DELIVERED' AND NEW."status" <> 'CLOSED')) THEN
      RAISE EXCEPTION 'sales: sales order % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b-5 (B-W2b-281; SAL-205): an order waits for a yes only from its making; the yes confirms it, a no cancels it.
    IF NEW."status" <> OLD."status"
       AND (NEW."status" = 'PENDING_APPROVAL' OR (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" NOT IN ('CONFIRMED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'sales: sales order % cannot move from % to %: an order waits for a yes (PENDING_APPROVAL) only from its making, and leaves it CONFIRMED with the yes or CANCELLED with a no', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."status" = 'CANCELLED') <> (coalesce(btrim(NEW."cancelReason"), '') <> '') THEN
    RAISE EXCEPTION 'sales: sales order % has a cancel reason exactly when it is CANCELLED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('CLOSED', 'CANCELLED')) <> (NEW."closedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'sales: sales order % is % with the wrong closing time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
-- SalesOrder (new trigger SalesOrder_delivered_check; the order guard keeps its own rules): the delivered time.
CREATE FUNCTION "factory_sales_order_delivered_check"() RETURNS trigger LANGUAGE plpgsql AS $$
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
    SELECT count(*) FILTER (WHERE s."status" = 'DELIVERED'), count(*) FILTER (WHERE s."status" = 'SHIPPED') INTO delivered, travelling
      FROM "Shipment" s WHERE s."tenantId" = NEW."tenantId" AND s."salesOrderId" = NEW."id";
    IF delivered = 0 OR travelling > 0 THEN
      RAISE EXCEPTION 'sales: sales order % is DELIVERED once a shipment of it was delivered and none still travels (% delivered, % on the way)', NEW."id", delivered, travelling
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "SalesOrder_delivered_check" AFTER INSERT OR UPDATE OF "status", "deliveredAt" ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_order_delivered_check"();

-- =====================================================================================================================
-- Company: the EORI (LOG-095)
CREATE FUNCTION "factory_company_eori_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."eori" IS NOT NULL AND NEW."eori" !~ '^[A-Z]{2}[A-Z0-9]{1,15}$' THEN
    RAISE EXCEPTION 'customs: the EORI of company % is the country''s two capitals then 1 to 15 capitals or digits', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Company_eori_check" AFTER INSERT OR UPDATE OF "eori" ON "Company"
  FOR EACH ROW EXECUTE FUNCTION "factory_company_eori_check"();

-- =====================================================================================================================
-- GeneratedDocument: the commercial invoice, CN22 and CN23 (LOG-086, LOG-087)

-- REDEFINES factory_generated_document_check (202611140403_carriers_w2b_guards, the last to redefine it), its whole body:
-- COMMERCIAL_INVOICE, CN22 and CN23 of a Shipment. The trigger stays.
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
          OR (NEW."kind" IN ('SHIPPING_MARKS', 'SHIPMENT_PACK') AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" IN ('COMMERCIAL_INVOICE', 'CN22', 'CN23') AND NEW."recordType" = 'Shipment')) THEN
    RAISE EXCEPTION 'documents: generated document % is a % of a %; a packing list is a Shipment''s, a claim letter a SupplierClaim''s, a job sheet a SubcontractOrder''s or a MaintenanceJob''s, an RMA sheet a ReturnAuthorisation''s, a certificate of conformity a Shipment''s, an inspection report an Inspection''s or an IncomingInspection''s, an NCR report a Nonconformance''s, an 8D a Capa''s, an answer letter a Complaint''s, a check report a MachineCheckResult''s, a frozen risk assessment a RiskAssessmentVersion''s, a PPE receipt a PpeIssue''s, a compliance pack a Shipment''s, an evidence pack an EvidencePack''s, a tech pack a StyleRevision''s, a user information leaflet a ComplianceDocument''s, an order confirmation a SalesOrder''s, a made-to-measure worksheet a MeasurementProfile''s, a price list a PriceListVersion''s, a proforma a Shipment''s, a SampleShipment''s or a DepositRequest''s, a day sheet a DispatchManifest''s, carton marks, a shipment pack, a commercial invoice, a CN22 and a CN23 a Shipment''s', NEW."id", NEW."kind", NEW."recordType"
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
-- =====================================================================================================================
-- LinkFile: the broker's pack (LOG-097)

-- REDEFINES factory_link_file_guard (202610319103_links_depth_w2b_guards, never redefined since), its whole body: a
-- BROKER_PACK link carries a set of files too. The trigger stays.
CREATE OR REPLACE FUNCTION "factory_link_file_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  link_purpose text;
  link_company uuid;
  link_uses integer;
  link_revoked timestamptz;
  file_company uuid;
  file_status text;
  file_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'links: file % of link % is never removed (the link''s evidence names what it shared)', OLD."fileId", OLD."linkId"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'links: the files of link % never change', OLD."linkId"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."position" < 1 THEN
    RAISE EXCEPTION 'links: the files of link % are numbered from 1', NEW."linkId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."purpose"::text, l."companyId", l."uses", l."revokedAt" INTO link_purpose, link_company, link_uses, link_revoked
    FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."partyId" = NEW."partyId" AND l."id" = NEW."linkId";
  IF FOUND THEN
    IF link_purpose NOT IN ('DOCUMENT_VIEW', 'SECURE_FILE', 'BROKER_PACK') THEN
      RAISE EXCEPTION 'links: only a DOCUMENT_VIEW or SECURE_FILE link has a set of files, and a BROKER_PACK link its papers (link %, %)', NEW."linkId", link_purpose
        USING ERRCODE = 'check_violation';
    END IF;
    IF link_uses > 0 OR link_revoked IS NOT NULL THEN
      RAISE EXCEPTION 'links: link % is used or revoked; its files are fixed', NEW."linkId"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  SELECT f."companyId", f."status"::text, f."recordType" INTO file_company, file_status, file_type
    FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF FOUND THEN
    IF file_status <> 'AVAILABLE' THEN
      RAISE EXCEPTION 'links: file % is %; a link shares an available file only', NEW."fileId", file_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF file_company IS NOT NULL AND link_company IS NOT NULL AND file_company <> link_company THEN
      RAISE EXCEPTION 'links: file % is another company''s; link % shares its own company''s files', NEW."fileId", NEW."linkId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF "factory_link_pay_record"(file_type) THEN
      RAISE EXCEPTION 'links: file % is a file of a % (pay figures never go by link)', NEW."fileId", file_type
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
-- =====================================================================================================================
-- OneOffLink: the broker's pack and the return label (LOG-097, LOG-112)
CREATE FUNCTION "factory_one_off_link_delivery_customs_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  declaration record;
  return_row record;
BEGIN
  IF NEW."purpose"::text = 'BROKER_PACK' THEN
    IF NEW."recordType" <> 'CustomsDeclaration' THEN
      RAISE EXCEPTION 'links: a BROKER_PACK link opens a CustomsDeclaration, not a % (link %)', NEW."recordType", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT d."companyId", d."brokerPartyId", d."status"::text AS status, coalesce(s."brokerPackOn", false) AS switched_on INTO declaration
      FROM "CustomsDeclaration" d
      LEFT JOIN "ShippingSettings" s ON s."tenantId" = d."tenantId" AND s."id" = d."siteId"
     WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."recordId";
    IF FOUND THEN
      IF declaration."companyId" <> NEW."companyId" OR declaration."brokerPartyId" IS DISTINCT FROM NEW."partyId" THEN
        RAISE EXCEPTION 'links: BROKER_PACK link % goes to the broker of customs declaration % of its company', NEW."id", NEW."recordId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF declaration.status <> 'PACK_SENT' THEN
        RAISE EXCEPTION 'links: customs declaration % is %; its broker''s pack goes by link only while it waits to be filed (PACK_SENT)', NEW."recordId", declaration.status
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT declaration.switched_on THEN
        RAISE EXCEPTION 'links: the broker pack is switched off at the site of customs declaration % (shipping settings); no BROKER_PACK link is made', NEW."recordId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."purpose"::text = 'RETURN_LABEL' THEN
    IF NEW."recordType" <> 'ReturnAuthorisation' THEN
      RAISE EXCEPTION 'links: a RETURN_LABEL link opens a ReturnAuthorisation, not a % (link %)', NEW."recordType", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT r."companyId", r."partyId", r."status"::text AS status INTO return_row
      FROM "ReturnAuthorisation" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    IF FOUND THEN
      IF (return_row."companyId", return_row."partyId") IS DISTINCT FROM (NEW."companyId", NEW."partyId") THEN
        RAISE EXCEPTION 'links: RETURN_LABEL link % goes to the customer of return % of its company', NEW."id", NEW."recordId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF return_row.status NOT IN ('AUTHORISED', 'RECEIVED') THEN
        RAISE EXCEPTION 'links: return % is %; a return label is offered only while the goods may come back (AUTHORISED or RECEIVED)', NEW."recordId", return_row.status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "OneOffLink_delivery_customs_check" AFTER INSERT ON "OneOffLink"
  FOR EACH ROW EXECUTE FUNCTION "factory_one_off_link_delivery_customs_check"();
