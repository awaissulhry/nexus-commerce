-- Written by hand (Prisma does not model triggers), after the generated …_techfiles_labels_w2b_schema and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Declarations, technical files and labels (W2b-4, schema wave 32/33, B-W2b-218; features PRD-292, PRD-293, PRD-295, PRD-296,
-- PRD-299, PRD-300, PRD-301, PRD-302, PRD-336, PRD-346, PRD-347, PRD-349, PRD-350 to PRD-354, QHS-048, QHS-110, MES-140).
-- apps/factory-api's modules/compliance checks all of this first and says it in words (B-W2b-251, B-W2b-257, B-W2b-258,
-- B-W2b-259); these rules hold for every login, the owner included. Every refusal is a check_violation, a write to frozen or
-- kept data a restrict_violation. The checks are AFTER triggers (the policies speak first); a removal is refused by a BEFORE
-- DELETE trigger; an UPDATE that changes nothing passes; a rule that reads a row the session cannot see skips it, unless the
-- row it names must exist.
--
-- Kept 10 years (PPE Reg. (EU) 2016/425 art. 8(3); QHS-110): a batch record, a recorded production-control test, a built
-- evidence pack and an archived technical file carry retainUntil, at least ten years after the Rome day of the fact they
-- record; it only ever moves later, and nothing removes the row before it (an open or complete technical file, a signed risk
-- assessment and an approved artwork are never removed at all). The day is Europe/Rome's (W2a money's factory_money_rome_day).
--
-- GATE-PPE-TEXTS (Owner answers 11-09): a GENERATED compliance document stays a DRAFT (or is withdrawn) until a PPE consultant
-- has checked the generated texts; the signed W1 document stays the live route. The step that takes generated documents live
-- lifts that one rule, on the Owner's word. A generated document names the brand as its maker when the brand sells the style
-- under its own name (Style.soldUnderOurName false), our company otherwise.
--
-- Earlier functions: W1's ComplianceDocument and LabelTemplate guards (…_product_guards) are untouched: both tables get a trigger
-- of their own for their new columns. W1's GarmentLabelPrint triggers are untouched. One redefinition: wave 15's
-- factory_generated_document_check (…_safety_w2b_guards), whole body, for the four new kinds. Helpers of earlier waves are called
-- as they are: 206's factory_styles_text_ok, 211's factory_bom_options_words_ok and factory_bom_options_code_ok, 216's
-- factory_market_code_ok and factory_market_code_known, W2a money's factory_money_rome_day, and numbering's
-- factory_document_number_guard. No data copy: every new column is null or its default on the rows made before it (a W1
-- document is SIGNED, a W1 label template a PPE_GARMENT label with no QR code).

-- =====================================================================================================================
-- Shared

CREATE FUNCTION "factory_techfiles_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'compliance: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- Today in Rome, and the first day a record kept ten years from `since` may go.
CREATE FUNCTION "factory_techfiles_today"() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT "factory_money_rome_day"(now())
$$;
CREATE FUNCTION "factory_techfiles_ten_years"(since date) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT (since + interval '10 years')::date
$$;

-- A record's model name ("Certificate", "StyleRevisionFile") and a uuid as text.
CREATE FUNCTION "factory_techfiles_record_type_ok"(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL AND value ~ '^[A-Z][A-Za-z0-9]{1,62}$'
$$;
CREATE FUNCTION "factory_techfiles_uuid_ok"(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL AND value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- Where a generated value came from: { "kind": "CERTIFICATE", "recordType": "Certificate", "recordId": "…" } (kind in capitals;
-- TYPED: a person typed it). Written in plpgsql so that nothing is evaluated on a value of the wrong JSON type.
CREATE FUNCTION "factory_techfiles_source_ok"(source jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF source IS NULL OR jsonb_typeof(source) <> 'object' THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(source -> 'kind') IS DISTINCT FROM 'string' OR (source ->> 'kind') !~ '^[A-Z][A-Z_]{1,39}$' THEN
    RETURN false;
  END IF;
  IF source ? 'recordType' AND (jsonb_typeof(source -> 'recordType') IS DISTINCT FROM 'string' OR NOT "factory_techfiles_record_type_ok"(source ->> 'recordType')) THEN
    RETURN false;
  END IF;
  IF source ? 'recordId' AND (jsonb_typeof(source -> 'recordId') IS DISTINCT FROM 'string' OR NOT "factory_techfiles_uuid_ok"(source ->> 'recordId')) THEN
    RETURN false;
  END IF;
  RETURN true;
END
$$;

-- Words in a JSON value: a string, not blank, at most `max_length` characters.
CREATE FUNCTION "factory_techfiles_json_words_ok"(value jsonb, max_length int) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN value IS NOT NULL AND jsonb_typeof(value) = 'string' AND "factory_bom_options_words_ok"(value #>> '{}', max_length);
END
$$;

-- =====================================================================================================================
-- ComplianceDocument (W1's table, its new columns; PRD-292, PRD-293, PRD-350 to PRD-354; GATE-PPE-TEXTS)
--   every row  a GENERATED document is a DRAFT or WITHDRAWN; a DoC's Annex IX content (required when generated) is
--              { "points": [{ point, text, source }] }, 1 to 30 points, each once; a user information's sections (required
--              when generated) are { "sections": [{ key, text, source }], "protectorPositions": [{ zone, … }],
--              "spareProtectors": [{ name, … }] }; content only on a DoC, sections only on user information; a generated
--              document's maker is the style's brand when the brand sells it under its own name, else none (our company);
--              a translation (translationOfId) has its state, an original none; it translates an original (not a translation)
--              of the same style (the reference) and kind in another language; CHECKED exactly with when and by whom, the
--              checker not its author (createdById); a translation is ISSUED only CHECKED; a checked translation's words
--              (content, sections, product identification) change only with the check undone; the market is a market code
--              of the tenant.
--   UPDATE     the origin never changes; once out of DRAFT none of the new columns changes (W1's guard keeps its own).
CREATE FUNCTION "factory_compliance_content_problem"(content jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  point jsonb;
  seen text[] := '{}';
BEGIN
  -- Each test on its own: jsonb_array_length fails on anything but an array.
  IF jsonb_typeof(content) IS DISTINCT FROM 'object' OR jsonb_typeof(content -> 'points') IS DISTINCT FROM 'array' THEN
    RETURN 'its content is { "points": [ … ] }, 1 to 30 Annex IX points';
  END IF;
  IF jsonb_array_length(content -> 'points') NOT BETWEEN 1 AND 30 THEN
    RETURN 'its content is { "points": [ … ] }, 1 to 30 Annex IX points';
  END IF;
  FOR point IN SELECT value FROM jsonb_array_elements(content -> 'points') LOOP
    IF jsonb_typeof(point) <> 'object'
       OR jsonb_typeof(point -> 'point') IS DISTINCT FROM 'string' OR (point ->> 'point') !~ '^[1-9]([.][0-9a-z]{1,3})?$'
       OR NOT "factory_techfiles_json_words_ok"(point -> 'text', 4000)
       OR NOT "factory_techfiles_source_ok"(point -> 'source') THEN
      RETURN 'each Annex IX point names its point ("1" … "9", "7.1"), its words (1 to 4000 characters) and where its value came from ({ "kind": "CERTIFICATE", "recordType": "Certificate", "recordId": "…" }; TYPED: typed by a person)';
    END IF;
    IF (point ->> 'point') = ANY (seen) THEN
      RETURN format('Annex IX point %s is given twice', point ->> 'point');
    END IF;
    seen := seen || (point ->> 'point');
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_compliance_sections_problem"(sections jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  part jsonb;
  seen text[] := '{}';
BEGIN
  IF jsonb_typeof(sections) IS DISTINCT FROM 'object' OR jsonb_typeof(sections -> 'sections') IS DISTINCT FROM 'array' THEN
    RETURN 'its sections are { "sections": [ … ] }, 1 to 60 Annex II 1.4 sections';
  END IF;
  IF jsonb_array_length(sections -> 'sections') NOT BETWEEN 1 AND 60 THEN
    RETURN 'its sections are { "sections": [ … ] }, 1 to 60 Annex II 1.4 sections';
  END IF;
  FOR part IN SELECT value FROM jsonb_array_elements(sections -> 'sections') LOOP
    IF jsonb_typeof(part) <> 'object'
       OR jsonb_typeof(part -> 'key') IS DISTINCT FROM 'string' OR (part ->> 'key') !~ '^[a-z][a-zA-Z0-9_.-]{0,59}$'
       OR NOT "factory_techfiles_json_words_ok"(part -> 'text', 8000)
       OR NOT "factory_techfiles_source_ok"(part -> 'source') THEN
      RETURN 'each section names its key ("maker", "storage", "protectors"), its words (1 to 8000 characters) and where they came from ({ "kind": "PHRASE", … })';
    END IF;
    IF (part ->> 'key') = ANY (seen) THEN
      RETURN format('section %s is given twice', part ->> 'key');
    END IF;
    seen := seen || (part ->> 'key');
  END LOOP;
  IF sections ? 'protectorPositions' THEN
    IF jsonb_typeof(sections -> 'protectorPositions') <> 'array' THEN
      RETURN 'its protector positions are a list of at most 50';
    END IF;
    IF jsonb_array_length(sections -> 'protectorPositions') > 50 THEN
      RETURN 'its protector positions are a list of at most 50';
    END IF;
    FOR part IN SELECT value FROM jsonb_array_elements(sections -> 'protectorPositions') LOOP
      IF jsonb_typeof(part) <> 'object' OR NOT "factory_techfiles_json_words_ok"(part -> 'zone', 60) THEN
        RETURN 'each protector position names its zone ({ "zone": "shoulder", … })';
      END IF;
    END LOOP;
  END IF;
  IF sections ? 'spareProtectors' THEN
    IF jsonb_typeof(sections -> 'spareProtectors') <> 'array' THEN
      RETURN 'its spare protectors are a list of at most 50';
    END IF;
    IF jsonb_array_length(sections -> 'spareProtectors') > 50 THEN
      RETURN 'its spare protectors are a list of at most 50';
    END IF;
    FOR part IN SELECT value FROM jsonb_array_elements(sections -> 'spareProtectors') LOOP
      IF jsonb_typeof(part) <> 'object' OR NOT "factory_techfiles_json_words_ok"(part -> 'name', 200) THEN
        RETURN 'each spare protector names its model ({ "name": "…", "standard": "EN 1621-1:2012", "level": "2" })';
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_compliance_document_w2b4_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text;
  original record;
  style record;
  expected_maker uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF NEW."origin" <> OLD."origin" THEN
      RAISE EXCEPTION 'compliance: document % was % when made; that never changes', OLD."id", OLD."origin"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND (NEW."content", NEW."sections", NEW."translationOfId", NEW."translationStatus", NEW."translationCheckedAt",
            NEW."translationCheckedById", NEW."marketCode")
           IS DISTINCT FROM
           (OLD."content", OLD."sections", OLD."translationOfId", OLD."translationStatus", OLD."translationCheckedAt",
            OLD."translationCheckedById", OLD."marketCode") THEN
      RAISE EXCEPTION 'compliance: document % is %; its content, sections, translation and market change no more (a new document is a new revision)', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- GATE-PPE-TEXTS: a generated document is a draft until a PPE consultant has checked the generated texts.
  IF NEW."origin" = 'GENERATED' AND NEW."status" NOT IN ('DRAFT', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'compliance: document % was generated: it stays a DRAFT (or is withdrawn) until a PPE consultant has checked the generated texts (GATE-PPE-TEXTS); the signed document is the live one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."content" IS NOT NULL AND NEW."kind" <> 'DECLARATION_OF_CONFORMITY' THEN
    RAISE EXCEPTION 'compliance: document % is %; only a Declaration of Conformity has Annex IX content', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sections" IS NOT NULL AND NEW."kind" <> 'USER_INFORMATION' THEN
    RAISE EXCEPTION 'compliance: document % is %; only the user information has Annex II 1.4 sections', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."origin" = 'GENERATED' AND ((NEW."kind" = 'DECLARATION_OF_CONFORMITY' AND NEW."content" IS NULL)
                                     OR (NEW."kind" = 'USER_INFORMATION' AND NEW."sections" IS NULL)) THEN
    RAISE EXCEPTION 'compliance: generated document % carries what it was generated from: a DoC its Annex IX content, the user information its sections', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."content" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."content" IS DISTINCT FROM OLD."content") THEN
    problem := "factory_compliance_content_problem"(NEW."content");
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'compliance: document %: %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."sections" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."sections" IS DISTINCT FROM OLD."sections") THEN
    problem := "factory_compliance_sections_problem"(NEW."sections");
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'compliance: document %: %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Owner 11-09 (question 3): the brand is the maker of a style it sells under its own name; our company otherwise.
  IF NEW."origin" = 'GENERATED' AND (TG_OP = 'INSERT' OR NEW."makerPartyId" IS DISTINCT FROM OLD."makerPartyId") THEN
    SELECT s."brandPartyId", s."soldUnderOurName" INTO style FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND THEN
      expected_maker := CASE WHEN style."brandPartyId" IS NOT NULL AND NOT style."soldUnderOurName" THEN style."brandPartyId" END;
      IF NEW."makerPartyId" IS DISTINCT FROM expected_maker THEN
        RAISE EXCEPTION 'compliance: generated document % names as its maker the brand that sells the style under its own name, and no party (our company) for our own styles and the styles a brand sells under our name', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- Translations (PRD-293).
  IF (NEW."translationOfId" IS NULL) <> (NEW."translationStatus" IS NULL) THEN
    RAISE EXCEPTION 'compliance: document % has a translation state exactly when it translates another document', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."translationOfId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."translationOfId" IS DISTINCT FROM OLD."translationOfId") THEN
    IF NEW."translationOfId" = NEW."id" THEN
      RAISE EXCEPTION 'compliance: document % does not translate itself', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT d."kind", d."language", d."translationOfId" INTO original
      FROM "ComplianceDocument" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."translationOfId";
    IF FOUND AND (original."kind" <> NEW."kind" OR original."language" = NEW."language" OR original."translationOfId" IS NOT NULL) THEN
      RAISE EXCEPTION 'compliance: document % translates an original (not a translation) of the same style and kind in another language', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."translationStatus" IS NOT DISTINCT FROM 'CHECKED') <> (NEW."translationCheckedAt" IS NOT NULL)
     OR (NEW."translationCheckedAt" IS NULL) <> (NEW."translationCheckedById" IS NULL) THEN
    RAISE EXCEPTION 'compliance: translation % is CHECKED exactly with when and by whom it was checked', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."translationCheckedById" IS NOT NULL AND NEW."translationCheckedById" = NEW."createdById"
     AND (TG_OP = 'INSERT' OR NEW."translationCheckedById" IS DISTINCT FROM OLD."translationCheckedById") THEN
    RAISE EXCEPTION 'compliance: translation % is checked by a person other than its author', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."translationStatus" = 'CHECKED' AND NEW."translationStatus" = 'CHECKED'
     AND (NEW."content", NEW."sections", NEW."productIdentification", NEW."translationCheckedAt", NEW."translationCheckedById")
         IS DISTINCT FROM (OLD."content", OLD."sections", OLD."productIdentification", OLD."translationCheckedAt", OLD."translationCheckedById") THEN
    RAISE EXCEPTION 'compliance: translation % is CHECKED; its words change only with its check undone (back to DRAFT or IN_TRANSLATION)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'ISSUED' AND NEW."translationOfId" IS NOT NULL AND NEW."translationStatus" <> 'CHECKED' THEN
    RAISE EXCEPTION 'compliance: translation % is issued only once a person has CHECKED it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The market (PRD-351), named by its code.
  IF NEW."marketCode" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."marketCode" IS DISTINCT FROM OLD."marketCode") THEN
    IF NOT "factory_market_code_ok"(NEW."marketCode") OR NOT "factory_market_code_known"(NEW."tenantId", NEW."marketCode") THEN
      RAISE EXCEPTION 'compliance: document % names a market of the tenant by its code ("DE", "CH"), or none', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ComplianceDocument_w2b4_rules" AFTER INSERT OR UPDATE ON "ComplianceDocument"
  FOR EACH ROW EXECUTE FUNCTION "factory_compliance_document_w2b4_check"();

-- =====================================================================================================================
-- LabelTemplate (W1's table, its new columns; PRD-336, PRD-346, PRD-349)
--   every row  the GPSR contact 1 to 500 characters (lines allowed), or none; the origin claim a phrase key (1 to 100, no
--              spaces), or none.
--   UPDATE     the kind, GPSR contact, QR target and origin claim change only while DRAFT (W1's guard keeps the rest).
CREATE FUNCTION "factory_label_template_w2b4_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."kind", NEW."gpsrContact", NEW."qrTarget", NEW."originClaimKey")
       IS NOT DISTINCT FROM (OLD."kind", OLD."gpsrContact", OLD."qrTarget", OLD."originClaimKey") THEN
      RETURN NULL;
    END IF;
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'compliance: label template % is %; its kind, GPSR contact, QR target and origin claim change no more (a change is a new revision)', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."gpsrContact", 500) THEN
    RAISE EXCEPTION 'compliance: label template % prints a GPSR contact of 1 to 500 characters (the postal and electronic address), or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."originClaimKey" IS NOT NULL AND NOT "factory_bom_options_code_ok"(NEW."originClaimKey", 100) THEN
    RAISE EXCEPTION 'compliance: label template % names its origin claim by a phrase key ("claim.made-in-italy"), or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "LabelTemplate_w2b4_rules" AFTER INSERT OR UPDATE ON "LabelTemplate"
  FOR EACH ROW EXECUTE FUNCTION "factory_label_template_w2b4_check"();

-- =====================================================================================================================
-- ComplianceDocumentBatch (PRD-295, PRD-352)
--   INSERT     the batch number 1 to 60 characters; a work order with its site (or neither: a batch number typed), the
--              work order's batch number; the document ISSUED and of the batch's company (or tenant-wide); the style of
--              the company (or tenant-wide); the shipment a Shipment of the tenant and company.
--   every row  kept at least ten years after the Rome day it was recorded; a note up to 2000 characters.
--   UPDATE     only the note and a later retainUntil.
--   DELETE     refused until the day after retainUntil. TRUNCATE refused.
-- A batch as made (no shipment) is recorded once per document; the generated key covers the rows with a shipment.
CREATE UNIQUE INDEX "ComplianceDocumentBatch_one_without_shipment" ON "ComplianceDocumentBatch"("tenantId", "documentId", "batchNumber") WHERE "shipmentId" IS NULL;

CREATE FUNCTION "factory_compliance_document_batch_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  found_company uuid;
  found_batch text;
  found_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."styleId", NEW."documentId", NEW."siteId", NEW."workOrderId", NEW."batchNumber", NEW."shipmentId",
        NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."companyId", OLD."styleId", OLD."documentId", OLD."siteId", OLD."workOrderId", OLD."batchNumber", OLD."shipmentId",
        OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: batch record % is written once; only its note and a later keep-until day change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."retainUntil" < OLD."retainUntil" THEN
      RAISE EXCEPTION 'compliance: batch record % is kept until %; that day never moves earlier', OLD."id", OLD."retainUntil"
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    IF NEW."batchNumber" IS NULL OR NOT "factory_styles_text_ok"(NEW."batchNumber", 60) THEN
      RAISE EXCEPTION 'compliance: batch record % names its batch number (1 to 60 characters)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."siteId" IS NULL) <> (NEW."workOrderId" IS NULL) THEN
      RAISE EXCEPTION 'compliance: batch record % names a work order with its site, or neither (a batch number typed)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."workOrderId" IS NOT NULL THEN
      SELECT w."batchNumber" INTO found_batch FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
      IF FOUND AND found_batch IS DISTINCT FROM NEW."batchNumber" THEN
        RAISE EXCEPTION 'compliance: batch record % carries its work order''s batch number (given at release)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    SELECT d."status"::text, d."companyId" INTO found_status, found_company
      FROM "ComplianceDocument" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."documentId";
    IF FOUND AND found_status <> 'ISSUED' THEN
      RAISE EXCEPTION 'compliance: batch record % names an ISSUED document (this one is %): a batch goes with a declaration in force', NEW."id", found_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND found_company IS NOT NULL AND found_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'compliance: batch record % names a document of its own company (or a tenant-wide one)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT s."companyId" INTO found_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND AND found_company IS NOT NULL AND found_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'compliance: batch record % is of its style''s company (or of a tenant-wide style)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."shipmentId" IS NOT NULL THEN
      SELECT sh."companyId" INTO found_company FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."shipmentId";
      IF NOT FOUND OR found_company <> NEW."companyId" THEN
        RAISE EXCEPTION 'compliance: batch record % names a shipment of its company', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."retainUntil" < "factory_techfiles_ten_years"("factory_money_rome_day"(NEW."createdAt")) THEN
    RAISE EXCEPTION 'compliance: batch record % is kept at least ten years after it was recorded (until % or later; PPE Reg. art. 8(3))', NEW."id", "factory_techfiles_ten_years"("factory_money_rome_day"(NEW."createdAt"))
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: the note of batch record % is 1 to 2000 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

-- A record kept until its retainUntil (a date column of the row): removed only from the day after.
CREATE FUNCTION "factory_techfiles_kept_until"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."retainUntil" >= "factory_techfiles_today"() THEN
    RAISE EXCEPTION 'compliance: % % is kept until % (PPE Reg. art. 8(3): ten years); it is not removed before', TG_TABLE_NAME, OLD."id", OLD."retainUntil"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "ComplianceDocumentBatch_check" AFTER INSERT OR UPDATE ON "ComplianceDocumentBatch"
  FOR EACH ROW EXECUTE FUNCTION "factory_compliance_document_batch_check"();
CREATE TRIGGER "ComplianceDocumentBatch_kept" BEFORE DELETE ON "ComplianceDocumentBatch"
  FOR EACH ROW EXECUTE FUNCTION "factory_techfiles_kept_until"();
CREATE TRIGGER "ComplianceDocumentBatch_no_truncate" BEFORE TRUNCATE ON "ComplianceDocumentBatch"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_techfiles_refuse_truncate"();

-- =====================================================================================================================
-- TechnicalFile (PRD-296; Annex III, art. 8(3))
--   INSERT/UPDATE  the number from the TECHNICAL_FILE series, given at insert, never changed (factory_document_number_guard).
--   every row  the style of its company (or tenant-wide); the certificate (when named or changed) covers the style; OPEN has
--              no completion, COMPLETE its completion (when, by whom), ARCHIVED either; ARCHIVED exactly with when, why (3 to
--              500 characters) and retainUntil at least ten years after the Rome day it was archived; a note up to 2000.
--   UPDATE     the company, style and creation never change; OPEN ⇄ COMPLETE, OPEN | COMPLETE → ARCHIVED; ARCHIVED changes no
--              more but its note and a later retainUntil; OPEN → COMPLETE needs every Annex III point (a) to (m) with at least
--              one item, every item REVIEWED or NOT_APPLICABLE, and for a category II or III style the certificate.
--   DELETE     only an ARCHIVED file, from the day after retainUntil (no runtime role has the grant). TRUNCATE refused.
-- One live (not archived) file per style.
CREATE UNIQUE INDEX "TechnicalFile_one_live_per_style" ON "TechnicalFile"("tenantId", "styleId") WHERE "status" <> 'ARCHIVED';

CREATE FUNCTION "factory_technical_file_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  found_company uuid;
  category text;
  points_done int;
  open_item record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."styleId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."styleId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the company, style and creation of technical file % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'ARCHIVED'
       AND (NEW."status", NEW."certificateId", NEW."keeperId", NEW."completedAt", NEW."completedById", NEW."archivedAt",
            NEW."archivedById", NEW."archiveReason")
           IS DISTINCT FROM
           (OLD."status", OLD."certificateId", OLD."keeperId", OLD."completedAt", OLD."completedById", OLD."archivedAt",
            OLD."archivedById", OLD."archiveReason") THEN
      RAISE EXCEPTION 'compliance: technical file % is ARCHIVED; it changes no more but its note and a later keep-until day', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'OPEN' AND NEW."status" IN ('COMPLETE', 'ARCHIVED'))
                OR (OLD."status" = 'COMPLETE' AND NEW."status" IN ('OPEN', 'ARCHIVED'))) THEN
      RAISE EXCEPTION 'compliance: technical file % cannot move from % to % (OPEN ⇄ COMPLETE, then ARCHIVED)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."retainUntil" < OLD."retainUntil" THEN
      RAISE EXCEPTION 'compliance: technical file % is kept until %; that day never moves earlier', OLD."id", OLD."retainUntil"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  SELECT s."companyId", s."ppeCategory"::text INTO found_company, category FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
  IF FOUND AND found_company IS NOT NULL AND found_company <> NEW."companyId" THEN
    RAISE EXCEPTION 'compliance: technical file % is of its style''s company (or of a tenant-wide style)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."certificateId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."certificateId" IS DISTINCT FROM OLD."certificateId")
     AND NOT EXISTS (SELECT 1 FROM "CertificateCoverage" c
                      WHERE c."tenantId" = NEW."tenantId" AND c."certificateId" = NEW."certificateId" AND c."styleId" = NEW."styleId") THEN
    RAISE EXCEPTION 'compliance: technical file % names a certificate that covers its style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'OPEN' AND (NEW."completedAt" IS NOT NULL OR NEW."completedById" IS NOT NULL))
     OR (NEW."status" = 'COMPLETE' AND (NEW."completedAt" IS NULL OR NEW."completedById" IS NULL))
     OR ((NEW."completedAt" IS NULL) <> (NEW."completedById" IS NULL)) THEN
    RAISE EXCEPTION 'compliance: technical file % is COMPLETE with when and by whom it was completed, OPEN without', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ARCHIVED') <> (NEW."archivedAt" IS NOT NULL)
     OR (NEW."status" = 'ARCHIVED') <> (NEW."retainUntil" IS NOT NULL)
     OR (NEW."status" <> 'ARCHIVED' AND (NEW."archivedById" IS NOT NULL OR NEW."archiveReason" IS NOT NULL)) THEN
    RAISE EXCEPTION 'compliance: technical file % is ARCHIVED exactly with when, why and how long it is kept', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'ARCHIVED' THEN
    IF NEW."archiveReason" IS NULL OR length(btrim(NEW."archiveReason")) < 3 OR NOT "factory_bom_options_words_ok"(NEW."archiveReason", 500) THEN
      RAISE EXCEPTION 'compliance: technical file % says why it was archived in words (3 to 500 characters: the style left the market)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."retainUntil" < "factory_techfiles_ten_years"("factory_money_rome_day"(NEW."archivedAt")) THEN
      RAISE EXCEPTION 'compliance: technical file % is kept at least ten years after it was archived (until % or later; PPE Reg. art. 8(3))', NEW."id", "factory_techfiles_ten_years"("factory_money_rome_day"(NEW."archivedAt"))
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: the note of technical file % is 1 to 2000 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Complete: every point reviewed or not applicable.
  IF NEW."status" = 'COMPLETE' AND (TG_OP = 'INSERT' OR OLD."status" <> 'COMPLETE') THEN
    SELECT i."point"::text AS point, i."state"::text AS state INTO open_item
      FROM "TechnicalFileItem" i
     WHERE i."tenantId" = NEW."tenantId" AND i."technicalFileId" = NEW."id" AND i."state" IN ('MISSING', 'LINKED')
     ORDER BY i."point", i."seq" LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'compliance: technical file % is complete only when every item is reviewed or not applicable (point % has one %)', NEW."id", open_item.point, open_item.state
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(DISTINCT i."point") INTO points_done FROM "TechnicalFileItem" i WHERE i."tenantId" = NEW."tenantId" AND i."technicalFileId" = NEW."id";
    IF points_done < 13 THEN
      RAISE EXCEPTION 'compliance: technical file % is complete only when each Annex III point (a) to (m) has its evidence reviewed or is marked not applicable (% of 13)', NEW."id", points_done
        USING ERRCODE = 'check_violation';
    END IF;
    IF category IN ('CATEGORY_II', 'CATEGORY_III') AND NEW."certificateId" IS NULL THEN
      RAISE EXCEPTION 'compliance: technical file % of a category II or III style is complete only with the EU type-examination certificate it supports', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_technical_file_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'ARCHIVED' OR OLD."retainUntil" >= "factory_techfiles_today"() THEN
    RAISE EXCEPTION 'compliance: technical file % is % (kept until %); it is removed only once archived and kept ten years (PPE Reg. art. 8(3))', OLD."id", OLD."status", coalesce(OLD."retainUntil"::text, 'archived and ten years')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "TechnicalFile_number" BEFORE INSERT OR UPDATE ON "TechnicalFile"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('technical file', 'TECHNICAL_FILE');
CREATE TRIGGER "TechnicalFile_check" AFTER INSERT OR UPDATE ON "TechnicalFile"
  FOR EACH ROW EXECUTE FUNCTION "factory_technical_file_check"();
CREATE TRIGGER "TechnicalFile_kept" BEFORE DELETE ON "TechnicalFile"
  FOR EACH ROW EXECUTE FUNCTION "factory_technical_file_kept"();
CREATE TRIGGER "TechnicalFile_no_truncate" BEFORE TRUNCATE ON "TechnicalFile"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_techfiles_refuse_truncate"();

-- =====================================================================================================================
-- TechnicalFileItem (PRD-296)
--   every write  only while its file is OPEN (the file locked FOR SHARE: a completion waits for it).
--   every row  seq 1 or more; a record (its model name and id, together) or a file; MISSING: no evidence, no review; LINKED:
--              one evidence, no review; REVIEWED: one evidence, when and by whom; NOT_APPLICABLE: no evidence, why (3 to
--              2000 characters), when and by whom; the file of its file's company (or of none); a note up to 2000.
--   UPDATE     the file, point and creation never change.
--   DELETE     only while its file is OPEN. TRUNCATE refused.
CREATE FUNCTION "factory_technical_file_item_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item "TechnicalFileItem" := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  file_status text;
  file_company uuid;
  found_company uuid;
  evidence int;
  reviewed boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  SELECT f."status"::text, f."companyId" INTO file_status, file_company
    FROM "TechnicalFile" f WHERE f."tenantId" = item."tenantId" AND f."id" = item."technicalFileId" FOR SHARE;
  IF FOUND AND file_status <> 'OPEN' THEN
    RAISE EXCEPTION 'compliance: technical file % is %; its evidence changes only while it is OPEN (reopen it first)', item."technicalFileId", file_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW."technicalFileId", NEW."point", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."technicalFileId", OLD."point", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'compliance: the technical file, point and creation of item % never change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'compliance: item % has a place of 1 or more within its point', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."recordType" IS NULL) <> (NEW."recordId" IS NULL)
     OR (NEW."recordType" IS NOT NULL AND NOT "factory_techfiles_record_type_ok"(NEW."recordType")) THEN
    RAISE EXCEPTION 'compliance: item % names an evidence record by its model name ("Certificate", "StyleRevisionFile") and id together', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  evidence := (NEW."recordId" IS NOT NULL)::int + (NEW."fileId" IS NOT NULL)::int;
  reviewed := NEW."reviewedAt" IS NOT NULL AND NEW."reviewedById" IS NOT NULL;
  IF (NEW."reviewedAt" IS NULL) <> (NEW."reviewedById" IS NULL)
     OR (NEW."state" = 'MISSING' AND (evidence <> 0 OR reviewed))
     OR (NEW."state" = 'LINKED' AND (evidence <> 1 OR reviewed))
     OR (NEW."state" = 'REVIEWED' AND (evidence <> 1 OR NOT reviewed))
     OR (NEW."state" = 'NOT_APPLICABLE' AND (evidence <> 0 OR NOT reviewed)) THEN
    RAISE EXCEPTION 'compliance: item % is % (MISSING: no evidence; LINKED: one record or file; REVIEWED: one, with when and by whom; NOT_APPLICABLE: none, with why, when and by whom)', NEW."id", NEW."state"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."state" = 'NOT_APPLICABLE' AND (NEW."note" IS NULL OR length(btrim(NEW."note")) < 3) THEN
    RAISE EXCEPTION 'compliance: item % says why its point does not apply, in words (3 to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: the note of item % is 1 to 2000 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."fileId" IS DISTINCT FROM OLD."fileId") THEN
    SELECT s."companyId" INTO found_company FROM "StoredFile" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."fileId";
    IF FOUND AND found_company IS NOT NULL AND found_company IS DISTINCT FROM file_company THEN
      RAISE EXCEPTION 'compliance: item % links a file of its technical file''s company (or of none)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "TechnicalFileItem_check" AFTER INSERT OR UPDATE ON "TechnicalFileItem"
  FOR EACH ROW EXECUTE FUNCTION "factory_technical_file_item_check"();
CREATE TRIGGER "TechnicalFileItem_delete_guard" BEFORE DELETE ON "TechnicalFileItem"
  FOR EACH ROW EXECUTE FUNCTION "factory_technical_file_item_check"();
CREATE TRIGGER "TechnicalFileItem_no_truncate" BEFORE TRUNCATE ON "TechnicalFileItem"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_techfiles_refuse_truncate"();

-- =====================================================================================================================
-- ProductRiskAssessment (PRD-301)
--   INSERT     made DRAFT, on a file that is not ARCHIVED.
--   every row  revision 1 or more; DRAFT not signed, SIGNED and SUPERSEDED signed (when, by whom, the typed name 1 to 200,
--              the function up to 200); SUPERSEDED exactly with when; the class reasoning up to 8000, a note up to 2000.
--   UPDATE     the file, revision and creation never change; DRAFT → SIGNED (with at least one row, on a file that is not
--              ARCHIVED) → SUPERSEDED; once signed nothing changes but the move to SUPERSEDED.
--   DELETE     only a DRAFT (its rows first). TRUNCATE refused.
-- One SIGNED per file.
CREATE UNIQUE INDEX "ProductRiskAssessment_one_signed_per_file" ON "ProductRiskAssessment"("tenantId", "technicalFileId") WHERE "status" = 'SIGNED';

CREATE FUNCTION "factory_product_risk_assessment_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  file_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'compliance: a risk assessment is made as a DRAFT and signed once its rows are written'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."technicalFileId", NEW."revision", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."technicalFileId", OLD."revision", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the technical file, revision and creation of risk assessment % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'SIGNED') OR (OLD."status" = 'SIGNED' AND NEW."status" = 'SUPERSEDED')) THEN
      RAISE EXCEPTION 'compliance: risk assessment % cannot move from % to % (DRAFT → SIGNED → SUPERSEDED)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND (NEW."classReasoning", NEW."signedAt", NEW."signedById", NEW."signedByName", NEW."signedByFunction", NEW."note")
           IS DISTINCT FROM (OLD."classReasoning", OLD."signedAt", OLD."signedById", OLD."signedByName", OLD."signedByFunction", OLD."note") THEN
      RAISE EXCEPTION 'compliance: risk assessment % is %; it changes no more (a change is the next revision)', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."status" IN ('DRAFT', 'SIGNED') AND (TG_OP = 'INSERT' OR NEW."status" <> OLD."status" OR NEW."status" = 'DRAFT') THEN
    SELECT f."status"::text INTO file_status FROM "TechnicalFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."technicalFileId" FOR SHARE;
    IF FOUND AND file_status = 'ARCHIVED' THEN
      RAISE EXCEPTION 'compliance: technical file % is ARCHIVED; its risk assessments change no more', NEW."technicalFileId"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."revision" < 1 THEN
    RAISE EXCEPTION 'compliance: risk assessment % has a revision of 1 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DRAFT' AND (NEW."signedAt" IS NOT NULL OR NEW."signedById" IS NOT NULL OR NEW."signedByName" IS NOT NULL OR NEW."signedByFunction" IS NOT NULL))
     OR (NEW."status" <> 'DRAFT' AND (NEW."signedAt" IS NULL OR NEW."signedById" IS NULL OR NEW."signedByName" IS NULL)) THEN
    RAISE EXCEPTION 'compliance: risk assessment % is signed (when, by whom, the typed name) exactly from SIGNED on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."signedByName", 200) OR NOT "factory_styles_text_ok"(NEW."signedByFunction", 200) THEN
    RAISE EXCEPTION 'compliance: risk assessment % is signed with a name and a function of 1 to 200 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'SUPERSEDED') <> (NEW."supersededAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'compliance: risk assessment % is SUPERSEDED exactly with when', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."classReasoning", 8000) OR NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: risk assessment % has a class reasoning of 1 to 8000 characters and a note of 1 to 2000, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'SIGNED' AND (TG_OP = 'INSERT' OR OLD."status" = 'DRAFT')
     AND NOT EXISTS (SELECT 1 FROM "ProductRiskRow" r WHERE r."tenantId" = NEW."tenantId" AND r."assessmentId" = NEW."id") THEN
    RAISE EXCEPTION 'compliance: risk assessment % is signed with at least one hazard', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_product_risk_assessment_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'compliance: risk assessment % is %; it is kept, never removed', OLD."id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "ProductRiskAssessment_check" AFTER INSERT OR UPDATE ON "ProductRiskAssessment"
  FOR EACH ROW EXECUTE FUNCTION "factory_product_risk_assessment_check"();
CREATE TRIGGER "ProductRiskAssessment_kept" BEFORE DELETE ON "ProductRiskAssessment"
  FOR EACH ROW EXECUTE FUNCTION "factory_product_risk_assessment_kept"();
CREATE TRIGGER "ProductRiskAssessment_no_truncate" BEFORE TRUNCATE ON "ProductRiskAssessment"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_techfiles_refuse_truncate"();

-- =====================================================================================================================
-- ProductRiskRow (PRD-301)
--   every write  only while its assessment is a DRAFT (locked FOR SHARE: signing waits for it).
--   every row  seq 1 or more; OTHER names its hazard in words (3 to 300), a detail up to 300; the garment zone a zone code
--              ("shoulder", "knee-left"), or none; intended use and control 1 to 2000 characters, foreseeable misuse and note
--              up to 2000; the standard clause up to 100.
--   UPDATE     the assessment and creation never change.
--   DELETE     only while its assessment is a DRAFT. TRUNCATE refused.
CREATE FUNCTION "factory_product_risk_row_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_ "ProductRiskRow" := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  assessment_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  SELECT a."status"::text INTO assessment_status FROM "ProductRiskAssessment" a WHERE a."tenantId" = row_."tenantId" AND a."id" = row_."assessmentId" FOR SHARE;
  IF FOUND AND assessment_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'compliance: risk assessment % is %; its rows change no more (a change is the next revision)', row_."assessmentId", assessment_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."assessmentId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."assessmentId", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'compliance: the assessment and creation of risk row % never change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'compliance: risk row % has a place of 1 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."hazard" = 'OTHER' AND (NEW."hazardNote" IS NULL OR length(btrim(NEW."hazardNote")) < 3)) OR NOT "factory_styles_text_ok"(NEW."hazardNote", 300) THEN
    RAISE EXCEPTION 'compliance: risk row % names an OTHER hazard in words (3 to 300 characters); a detail is up to 300', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."garmentZone" IS NOT NULL AND NEW."garmentZone" !~ '^[a-z][a-z0-9_-]{0,39}$' THEN
    RAISE EXCEPTION 'compliance: risk row % names its garment zone by the zone code of the garment zone map ("shoulder", "knee-left"), or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."intendedUse" IS NULL OR NOT "factory_bom_options_words_ok"(NEW."intendedUse", 2000)
     OR NEW."control" IS NULL OR NOT "factory_bom_options_words_ok"(NEW."control", 2000)
     OR NOT "factory_bom_options_words_ok"(NEW."foreseeableMisuse", 2000)
     OR NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: risk row % says the intended use and how the hazard is controlled (1 to 2000 characters each), the foreseeable misuse and a note up to 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."standardClause", 100) THEN
    RAISE EXCEPTION 'compliance: risk row % cites a standard clause of 1 to 100 characters ("EN 17092-4:2020 6.3"), or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ProductRiskRow_check" AFTER INSERT OR UPDATE ON "ProductRiskRow"
  FOR EACH ROW EXECUTE FUNCTION "factory_product_risk_row_check"();
CREATE TRIGGER "ProductRiskRow_delete_guard" BEFORE DELETE ON "ProductRiskRow"
  FOR EACH ROW EXECUTE FUNCTION "factory_product_risk_row_check"();
CREATE TRIGGER "ProductRiskRow_no_truncate" BEFORE TRUNCATE ON "ProductRiskRow"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_techfiles_refuse_truncate"();

-- =====================================================================================================================
-- ProductionControlTest (QHS-048, PRD-302, QHS-110)
--   every row  a work order with its site, or neither; a work order or a batch number typed (1 to 60), not both; the style of
--              its company (or tenant-wide); OTHER names its test (1 to 200), a detail up to 200; the standard clause up to
--              100, the sample up to 500, the report number up to 100, the result note and note up to 2000; the lab report a
--              file of its company (or of none). Due (no result): no test day, tester, report, result note or keep-until.
--              Recorded: the day (not after today in Rome), the tester (1 to 200), retainUntil at least ten years after the
--              test day; a FAIL says what failed (3 or more characters).
--   UPDATE     the company, style and creation never change; once recorded nothing changes but the note and a later
--              retainUntil.
--   DELETE     a due test; a recorded one from the day after retainUntil. TRUNCATE refused.
CREATE FUNCTION "factory_production_control_test_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  found_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."styleId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."styleId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the company, style and creation of production-control test % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."result" IS NOT NULL
       AND (NEW."siteId", NEW."workOrderId", NEW."batchNumber", NEW."test", NEW."testName", NEW."standardClause", NEW."frequency",
            NEW."dueOn", NEW."sample", NEW."result", NEW."testedOn", NEW."testedBy", NEW."labReportFileId", NEW."reportNumber",
            NEW."resultNote")
           IS DISTINCT FROM
           (OLD."siteId", OLD."workOrderId", OLD."batchNumber", OLD."test", OLD."testName", OLD."standardClause", OLD."frequency",
            OLD."dueOn", OLD."sample", OLD."result", OLD."testedOn", OLD."testedBy", OLD."labReportFileId", OLD."reportNumber",
            OLD."resultNote") THEN
      RAISE EXCEPTION 'compliance: production-control test % is recorded (%); it changes no more but its note and a later keep-until day', OLD."id", OLD."result"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."retainUntil" < OLD."retainUntil" THEN
      RAISE EXCEPTION 'compliance: production-control test % is kept until %; that day never moves earlier', OLD."id", OLD."retainUntil"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF (NEW."siteId" IS NULL) <> (NEW."workOrderId" IS NULL) THEN
    RAISE EXCEPTION 'compliance: production-control test % names a work order with its site, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."workOrderId" IS NOT NULL AND NEW."batchNumber" IS NOT NULL THEN
    RAISE EXCEPTION 'compliance: production-control test % names a work order (its batch) or a batch number typed, not both', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."batchNumber", 60) THEN
    RAISE EXCEPTION 'compliance: production-control test % names a batch number of 1 to 60 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT s."companyId" INTO found_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND AND found_company IS NOT NULL AND found_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'compliance: production-control test % is of its style''s company (or of a tenant-wide style)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."test" = 'OTHER' AND NEW."testName" IS NULL) OR NOT "factory_styles_text_ok"(NEW."testName", 200) THEN
    RAISE EXCEPTION 'compliance: production-control test % names an OTHER test (1 to 200 characters); a detail is up to 200', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."standardClause", 100) OR NOT "factory_styles_text_ok"(NEW."reportNumber", 100)
     OR NOT "factory_bom_options_words_ok"(NEW."sample", 500) OR NOT "factory_bom_options_words_ok"(NEW."resultNote", 2000)
     OR NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: production-control test % has a standard clause and a report number of up to 100 characters, a sample up to 500, a result note and a note up to 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."result" IS NULL THEN
    IF NEW."testedOn" IS NOT NULL OR NEW."testedBy" IS NOT NULL OR NEW."labReportFileId" IS NOT NULL OR NEW."reportNumber" IS NOT NULL
       OR NEW."resultNote" IS NOT NULL OR NEW."retainUntil" IS NOT NULL THEN
      RAISE EXCEPTION 'compliance: production-control test % is due: it has no test day, tester, report, result note or keep-until day until its result is recorded', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."testedOn" IS NULL OR NEW."testedBy" IS NULL OR NOT "factory_styles_text_ok"(NEW."testedBy", 200) THEN
      RAISE EXCEPTION 'compliance: production-control test % is recorded with its test day and who tested it (the lab or the person, 1 to 200 characters)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (TG_OP = 'INSERT' OR OLD."result" IS NULL) AND NEW."testedOn" > "factory_techfiles_today"() THEN
      RAISE EXCEPTION 'compliance: production-control test % was tested on a day that has come (not %)', NEW."id", NEW."testedOn"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."retainUntil" IS NULL OR NEW."retainUntil" < "factory_techfiles_ten_years"(NEW."testedOn") THEN
      RAISE EXCEPTION 'compliance: production-control test % is kept at least ten years after its test day (until % or later; QHS-110, PPE Reg. art. 8(3))', NEW."id", "factory_techfiles_ten_years"(NEW."testedOn")
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."result" = 'FAIL' AND (NEW."resultNote" IS NULL OR length(btrim(NEW."resultNote")) < 3) THEN
      RAISE EXCEPTION 'compliance: production-control test % failed: its result note says what failed', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."labReportFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."labReportFileId" IS DISTINCT FROM OLD."labReportFileId") THEN
    SELECT s."companyId" INTO found_company FROM "StoredFile" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."labReportFileId";
    IF FOUND AND found_company IS NOT NULL AND found_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'compliance: production-control test % has a lab report of its company (or of none)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_production_control_test_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."result" IS NOT NULL AND OLD."retainUntil" >= "factory_techfiles_today"() THEN
    RAISE EXCEPTION 'compliance: production-control test % is recorded and kept until % (QHS-110, PPE Reg. art. 8(3)); it is not removed before', OLD."id", OLD."retainUntil"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "ProductionControlTest_check" AFTER INSERT OR UPDATE ON "ProductionControlTest"
  FOR EACH ROW EXECUTE FUNCTION "factory_production_control_test_check"();
CREATE TRIGGER "ProductionControlTest_kept" BEFORE DELETE ON "ProductionControlTest"
  FOR EACH ROW EXECUTE FUNCTION "factory_production_control_test_kept"();
CREATE TRIGGER "ProductionControlTest_no_truncate" BEFORE TRUNCATE ON "ProductionControlTest"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_techfiles_refuse_truncate"();

-- =====================================================================================================================
-- EvidencePack (PRD-299, PRD-300)
--   INSERT/UPDATE  the number from the EVIDENCE_PACK series, given at insert, never changed (factory_document_number_guard).
--   INSERT     made BUILDING.
--   every row  a technical file of its company or a shipment of its company, exactly one; a SHIPMENT pack a shipment's; the
--              scope a JSON object; the language ISO 639 (two or three small letters); the recipient 1 to 300 characters; a
--              note up to 2000. BUILDING: nothing of a result. BUILT: the contents (1 to 5000 documents, each with its title
--              and SHA-256), the pack's SHA-256, its PDF, when, and retainUntil at least ten years after that Rome day; no
--              failure. FAILED: why (1 to 500) and when; nothing else of a result. Its PDF and ZIP are files of this pack (and
--              its company).
--   UPDATE     what it is built from and for (purpose, file or shipment, scope, language, recipient) and the creation never
--              change; BUILDING → BUILT | FAILED; a built or failed pack changes no more but its note and a later
--              retainUntil.
--   DELETE     a BUILDING or FAILED pack; a BUILT one from the day after retainUntil. TRUNCATE refused.
CREATE FUNCTION "factory_evidence_pack_contents_problem"(contents jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry jsonb;
BEGIN
  IF jsonb_typeof(contents) IS DISTINCT FROM 'array' THEN
    RETURN 'its contents are a list of 1 to 5000 documents';
  END IF;
  IF jsonb_array_length(contents) NOT BETWEEN 1 AND 5000 THEN
    RETURN 'its contents are a list of 1 to 5000 documents';
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(contents) LOOP
    IF jsonb_typeof(entry) <> 'object'
       OR NOT "factory_techfiles_json_words_ok"(entry -> 'title', 300)
       OR jsonb_typeof(entry -> 'sha256') IS DISTINCT FROM 'string' OR (entry ->> 'sha256') !~ '^[0-9a-f]{64}$'
       OR (entry ? 'recordType' AND (jsonb_typeof(entry -> 'recordType') IS DISTINCT FROM 'string' OR NOT "factory_techfiles_record_type_ok"(entry ->> 'recordType')))
       OR (entry ? 'recordId' AND (jsonb_typeof(entry -> 'recordId') IS DISTINCT FROM 'string' OR NOT "factory_techfiles_uuid_ok"(entry ->> 'recordId')))
       OR (entry ? 'fileId' AND (jsonb_typeof(entry -> 'fileId') IS DISTINCT FROM 'string' OR NOT "factory_techfiles_uuid_ok"(entry ->> 'fileId'))) THEN
      RETURN 'each document of it has its title (1 to 300 characters) and SHA-256 (lower-case hex), and may name its record (model name and id) and file';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_evidence_pack_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text;
  found_company uuid;
  file record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'BUILDING' THEN
      RAISE EXCEPTION 'compliance: an evidence pack is made BUILDING when its build starts, then BUILT or FAILED'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."purpose", NEW."technicalFileId", NEW."shipmentId", NEW."scope", NEW."language", NEW."recipient",
        NEW."recipientPartyId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."companyId", OLD."purpose", OLD."technicalFileId", OLD."shipmentId", OLD."scope", OLD."language", OLD."recipient",
        OLD."recipientPartyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: what evidence pack % is built from and for, and its creation, never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (OLD."status" = 'BUILDING' AND NEW."status" IN ('BUILT', 'FAILED')) THEN
      RAISE EXCEPTION 'compliance: evidence pack % cannot move from % to % (BUILDING → BUILT or FAILED)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'BUILDING'
       AND (NEW."contents", NEW."fingerprint", NEW."fileId", NEW."zipFileId", NEW."failureReason", NEW."builtAt")
           IS DISTINCT FROM (OLD."contents", OLD."fingerprint", OLD."fileId", OLD."zipFileId", OLD."failureReason", OLD."builtAt") THEN
      RAISE EXCEPTION 'compliance: evidence pack % is %; it changes no more but its note and a later keep-until day', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."retainUntil" < OLD."retainUntil" THEN
      RAISE EXCEPTION 'compliance: evidence pack % is kept until %; that day never moves earlier', OLD."id", OLD."retainUntil"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF (NEW."technicalFileId" IS NULL) = (NEW."shipmentId" IS NULL) THEN
    RAISE EXCEPTION 'compliance: evidence pack % is built from a technical file or from a shipment, exactly one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."purpose" = 'SHIPMENT' AND NEW."shipmentId" IS NULL THEN
    RAISE EXCEPTION 'compliance: evidence pack % goes with a shipment, so it is built from that shipment', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."technicalFileId" IS NOT NULL THEN
      SELECT f."companyId" INTO found_company FROM "TechnicalFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."technicalFileId";
      IF FOUND AND found_company <> NEW."companyId" THEN
        RAISE EXCEPTION 'compliance: evidence pack % is built from a technical file of its company', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT sh."companyId" INTO found_company FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."shipmentId";
      IF NOT FOUND OR found_company <> NEW."companyId" THEN
        RAISE EXCEPTION 'compliance: evidence pack % is built from a shipment of its company', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF jsonb_typeof(NEW."scope") IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'compliance: evidence pack % keeps what was asked as a JSON object ({ "batchNumbers": […], "include": […] })', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."language" IS NULL OR NEW."language" !~ '^[a-z]{2,3}$' THEN
      RAISE EXCEPTION 'compliance: evidence pack % is in the recipient''s language (ISO 639: "de", "it")', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."recipient" IS NULL OR NOT "factory_styles_text_ok"(NEW."recipient", 300) THEN
      RAISE EXCEPTION 'compliance: evidence pack % names its recipient in words (1 to 300 characters)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: the note of evidence pack % is 1 to 2000 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'BUILDING' THEN
    IF NEW."contents" IS NOT NULL OR NEW."fingerprint" IS NOT NULL OR NEW."fileId" IS NOT NULL OR NEW."zipFileId" IS NOT NULL
       OR NEW."failureReason" IS NOT NULL OR NEW."builtAt" IS NOT NULL OR NEW."retainUntil" IS NOT NULL THEN
      RAISE EXCEPTION 'compliance: evidence pack % is BUILDING: it has no contents, fingerprint, file, failure or keep-until day yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'BUILT' THEN
    IF NEW."contents" IS NULL OR NEW."fingerprint" IS NULL OR NEW."fingerprint" !~ '^[0-9a-f]{64}$' OR NEW."fileId" IS NULL
       OR NEW."builtAt" IS NULL OR NEW."failureReason" IS NOT NULL THEN
      RAISE EXCEPTION 'compliance: evidence pack % is BUILT with its contents, its SHA-256 (lower-case hex), its PDF and when, and no failure', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' OR OLD."status" = 'BUILDING' THEN
      problem := "factory_evidence_pack_contents_problem"(NEW."contents");
      IF problem IS NOT NULL THEN
        RAISE EXCEPTION 'compliance: evidence pack %: %', NEW."id", problem
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."retainUntil" IS NULL OR NEW."retainUntil" < "factory_techfiles_ten_years"("factory_money_rome_day"(NEW."builtAt")) THEN
      RAISE EXCEPTION 'compliance: evidence pack % is kept at least ten years after it was built (until % or later; PPE Reg. art. 8(3))', NEW."id", "factory_techfiles_ten_years"("factory_money_rome_day"(NEW."builtAt"))
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."failureReason" IS NULL OR NOT "factory_bom_options_words_ok"(NEW."failureReason", 500) OR NEW."builtAt" IS NULL
       OR NEW."contents" IS NOT NULL OR NEW."fingerprint" IS NOT NULL OR NEW."fileId" IS NOT NULL OR NEW."zipFileId" IS NOT NULL
       OR NEW."retainUntil" IS NOT NULL THEN
      RAISE EXCEPTION 'compliance: evidence pack % FAILED with why (1 to 500 characters) and when, and nothing of a result', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  FOR file IN
    SELECT s."id", s."recordType", s."recordId", s."companyId"
      FROM "StoredFile" s
     WHERE s."tenantId" = NEW."tenantId" AND s."id" IN (NEW."fileId", NEW."zipFileId")
       AND (TG_OP = 'INSERT' OR s."id" IS DISTINCT FROM OLD."fileId" AND s."id" IS DISTINCT FROM OLD."zipFileId")
  LOOP
    IF (file."recordType", file."recordId", file."companyId") IS DISTINCT FROM ('EvidencePack'::text, NEW."id", NEW."companyId") THEN
      RAISE EXCEPTION 'compliance: the PDF and ZIP of evidence pack % are files of the pack itself (StoredFile recordType "EvidencePack", its id and company)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_evidence_pack_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'BUILT' AND OLD."retainUntil" >= "factory_techfiles_today"() THEN
    RAISE EXCEPTION 'compliance: evidence pack % was built and is kept until % (PPE Reg. art. 8(3)); it is not removed before', OLD."id", OLD."retainUntil"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "EvidencePack_number" BEFORE INSERT OR UPDATE ON "EvidencePack"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('evidence pack', 'EVIDENCE_PACK');
CREATE TRIGGER "EvidencePack_check" AFTER INSERT OR UPDATE ON "EvidencePack"
  FOR EACH ROW EXECUTE FUNCTION "factory_evidence_pack_check"();
CREATE TRIGGER "EvidencePack_kept" BEFORE DELETE ON "EvidencePack"
  FOR EACH ROW EXECUTE FUNCTION "factory_evidence_pack_kept"();
CREATE TRIGGER "EvidencePack_no_truncate" BEFORE TRUNCATE ON "EvidencePack"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_techfiles_refuse_truncate"();

-- =====================================================================================================================
-- LabelArtworkVersion (PRD-347)
--   INSERT     made DRAFT, of a template that is not RETIRED.
--   every row  versionNo 1 or more; the proof a file of its template (StoredFile recordType "LabelTemplate" and the template's
--              id) of the template's company (or of none); DRAFT: no approval, not retired; APPROVED: when and by whom, not
--              retired; RETIRED: when, approved or not; a note up to 2000.
--   UPDATE     the template, number and creation never change; DRAFT → APPROVED | RETIRED, APPROVED → RETIRED; approving needs
--              a person other than its author (authorId, else createdById; an artwork with no known author is not approved)
--              and a template that is not RETIRED; once out of DRAFT nothing changes but the retirement.
--   DELETE     only a DRAFT. TRUNCATE refused.
-- One APPROVED per template revision.
CREATE UNIQUE INDEX "LabelArtworkVersion_one_approved" ON "LabelArtworkVersion"("tenantId", "templateId") WHERE "status" = 'APPROVED';

CREATE FUNCTION "factory_label_artwork_version_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  template record;
  file record;
  approving boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'compliance: an artwork version is made as a DRAFT and approved by a second person'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."templateId", NEW."versionNo", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."templateId", OLD."versionNo", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the template, number and creation of artwork version % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('APPROVED', 'RETIRED')) OR (OLD."status" = 'APPROVED' AND NEW."status" = 'RETIRED')) THEN
      RAISE EXCEPTION 'compliance: artwork version % cannot move from % to % (DRAFT → APPROVED → RETIRED)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND (NEW."fileId", NEW."authorId", NEW."approvedAt", NEW."approvedById", NEW."note")
           IS DISTINCT FROM (OLD."fileId", OLD."authorId", OLD."approvedAt", OLD."approvedById", OLD."note") THEN
      RAISE EXCEPTION 'compliance: artwork version % is %; it changes no more but its retirement (a change is the next version)', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."versionNo" < 1 THEN
    RAISE EXCEPTION 'compliance: artwork version % has a number of 1 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL)
     OR (NEW."status" = 'DRAFT' AND NEW."approvedAt" IS NOT NULL)
     OR (NEW."status" = 'APPROVED' AND NEW."approvedAt" IS NULL)
     OR (NEW."status" = 'RETIRED') <> (NEW."retiredAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'compliance: artwork version % is APPROVED with when and by whom (kept when retired) and RETIRED exactly with when', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: the note of artwork version % is 1 to 2000 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  approving := NEW."status" = 'APPROVED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'APPROVED');
  SELECT t."status"::text AS status, t."companyId" AS company INTO template FROM "LabelTemplate" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."templateId";
  IF FOUND AND template.status = 'RETIRED' AND (TG_OP = 'INSERT' OR approving) THEN
    RAISE EXCEPTION 'compliance: label template % is RETIRED; it takes no new or approved artwork', NEW."templateId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF approving AND (coalesce(NEW."authorId", NEW."createdById") IS NULL OR NEW."approvedById" = coalesce(NEW."authorId", NEW."createdById")) THEN
    RAISE EXCEPTION 'compliance: artwork version % is approved by a person other than its author (PRD-347)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."fileId" IS DISTINCT FROM OLD."fileId" THEN
    SELECT s."recordType", s."recordId", s."companyId" INTO file FROM "StoredFile" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."fileId";
    IF FOUND AND ((file."recordType", file."recordId") IS DISTINCT FROM ('LabelTemplate'::text, NEW."templateId")
                  OR (file."companyId" IS NOT NULL AND template.company IS NOT NULL AND file."companyId" <> template.company)) THEN
      RAISE EXCEPTION 'compliance: the proof of artwork version % is a file of its label template (and of the template''s company)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_label_artwork_version_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'compliance: artwork version % is %; it is kept, never removed', OLD."id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "LabelArtworkVersion_check" AFTER INSERT OR UPDATE ON "LabelArtworkVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_label_artwork_version_check"();
CREATE TRIGGER "LabelArtworkVersion_kept" BEFORE DELETE ON "LabelArtworkVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_label_artwork_version_kept"();
CREATE TRIGGER "LabelArtworkVersion_no_truncate" BEFORE TRUNCATE ON "LabelArtworkVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_techfiles_refuse_truncate"();

-- =====================================================================================================================
-- GarmentLabelSpoil (MES-140)
--   UPDATE, DELETE, TRUNCATE  refused for every login (append-only).
--   INSERT     a quantity of 1 or more; SPOILED says why (3 to 200 characters), RETURNED may (up to 200); a print's spoiled and
--              returned labels together at most its quantity (counted under a transaction lock of the print, so two at once
--              wait for each other).
CREATE FUNCTION "factory_garment_label_spoil_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'production: spoiled and returned labels are append-only: "%" is never changed, removed or truncated (a mistake is told by a new row)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE FUNCTION "factory_garment_label_spoil_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  printed int;
  accounted int;
BEGIN
  IF NEW."quantity" < 1 THEN
    RAISE EXCEPTION 'production: spoiled or returned labels % count 1 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'SPOILED' AND (NEW."reason" IS NULL OR length(btrim(NEW."reason")) < 3)) OR NOT "factory_styles_text_ok"(NEW."reason", 200) THEN
    RAISE EXCEPTION 'production: spoiled labels % say why in words (3 to 200 characters); returned ones may (up to 200)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('GarmentLabelSpoil:' || NEW."printId"::text, 0));
  SELECT p."quantity" INTO printed FROM "GarmentLabelPrint" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."printId";
  IF FOUND THEN
    SELECT coalesce(sum(s."quantity"), 0) INTO accounted FROM "GarmentLabelSpoil" s WHERE s."tenantId" = NEW."tenantId" AND s."printId" = NEW."printId";
    IF accounted > printed THEN
      RAISE EXCEPTION 'production: print % gave % labels; its spoiled and returned labels are at most that (% with these)', NEW."printId", printed, accounted
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "GarmentLabelSpoil_append_only" BEFORE UPDATE OR DELETE ON "GarmentLabelSpoil"
  FOR EACH ROW EXECUTE FUNCTION "factory_garment_label_spoil_append_only"();
CREATE TRIGGER "GarmentLabelSpoil_no_truncate" BEFORE TRUNCATE ON "GarmentLabelSpoil"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_garment_label_spoil_append_only"();
CREATE TRIGGER "GarmentLabelSpoil_check" AFTER INSERT ON "GarmentLabelSpoil"
  FOR EACH ROW EXECUTE FUNCTION "factory_garment_label_spoil_check"();

-- =====================================================================================================================
-- GeneratedDocument (redefines …_safety_w2b_guards' function, whole body; the trigger stays): its rules, and now a shipment's
-- compliance pack (COMPLIANCE_PACK) is of its Shipment's company and site, an evidence pack's PDF (EVIDENCE_PACK) of its
-- EvidencePack's company, a tech pack (TECH_PACK) of its StyleRevision's style's company (any company of the tenant for a
-- tenant-wide style) and a generated leaflet (USER_INFORMATION) of its ComplianceDocument's company (any for a tenant-wide one),
-- a document of kind USER_INFORMATION; none of the three has a site.
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
          OR (NEW."kind" = 'USER_INFORMATION' AND NEW."recordType" = 'ComplianceDocument')) THEN
    RAISE EXCEPTION 'documents: generated document % is a % of a %; a packing list is a Shipment''s, a claim letter a SupplierClaim''s, a job sheet a SubcontractOrder''s or a MaintenanceJob''s, an RMA sheet a ReturnAuthorisation''s, a certificate of conformity a Shipment''s, an inspection report an Inspection''s or an IncomingInspection''s, an NCR report a Nonconformance''s, an 8D a Capa''s, an answer letter a Complaint''s, a check report a MachineCheckResult''s, a frozen risk assessment a RiskAssessmentVersion''s, a PPE receipt a PpeIssue''s, a compliance pack a Shipment''s, an evidence pack an EvidencePack''s, a tech pack a StyleRevision''s, a user information leaflet a ComplianceDocument''s', NEW."id", NEW."kind", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  CASE NEW."recordType"
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
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- TRUNCATE on the batch records, technical files, items, assessments, rows, tests, packs and artwork is refused above; the
-- spoiled labels' by their append-only function.
