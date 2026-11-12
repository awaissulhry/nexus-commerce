-- Written by hand (Prisma does not model triggers or indexes on an expression), after the generated
-- …_followups_product_w2b4_schema and before the policy migration. When the migrations are renumbered, keep this file as it is
-- under its new timestamp.
--
-- The W2b-4 follow-ups for product, samples and compliance, W2b-5 schema wave 34/44 (B-W2b-275; the B-W2b-212, -217, -218,
-- -221, -224, -239, -246, -252, -253, -254, -257, -258, -261, -266 and -267 notes). apps/factory-api checks all of this first and
-- answers in words (B-W2b-283, -284, -288); these rules are the last word, for every login, the owner included.
--
--   PointOfMeasure     unique in the tenant whatever the letter case: the index on (tenantId, lower(code)).
--   Style              the markets it is sold in: market codes, each once, at most 60, never null (empty: every market); a
--                      code added names a market of the tenant.
--   WorkOrderSize      REDEFINED `factory_work_order_size_guard` (…_changes_samples_w2b_guards, whole): the sales order line
--                      and its party both or neither; neither only on a SAMPLE work order (an internal or uncharged round).
--   InspectionMeasurement  REDEFINED `factory_inspection_measurement_guard` (…_inspection_plans_w2b_guards, whole): an
--                      asymmetric band both sides or neither, each from 0, the tolerance its larger side, never on a check
--                      with its own nominal; `pass` within the band when there is one.
--   LabResult          the lab's cost with its currency (ISO 4217), 0 or more, or neither (the row stays append-only:
--                      W1's and B-W2b-217's triggers untouched).
--   ComplianceDocument REDEFINED `factory_compliance_document_w2b4_check` (…_techfiles_labels_w2b_guards, whole): a GENERATED
--                      document is made a DRAFT (or WITHDRAWN) and leaves DRAFT only while a live PpeTextApproval of its
--                      template covers its language and its company (GATE-PPE-TEXTS; no approval: a draft, as before).
--   ComplianceDocumentBatch  REDEFINED `factory_compliance_document_batch_check` (…_techfiles_labels_w2b_guards, whole): a
--                      SUPERSEDED document is accepted for a batch made while it was in force (a work order made to its
--                      revision, or a batch already recorded with it).
--   PpeTextApproval    recorded live (no withdrawal), by a person, not in the future; the template key without spaces (1-80)
--                      and its version from 1, a LABEL_WARNING one a label template of the company (or tenant-wide) of that
--                      code and revision; the languages ISO 639, each once, 1 to 20; the consultant 1-300 characters on one
--                      line; the evidence an AVAILABLE file of the company (or tenant-wide). Append-only but for the
--                      withdrawal: when, by whom and why (1-2000 characters) together, once, not before it was recorded, not
--                      in the future. Never deleted, never truncated.
--
-- ProductSettings.updatedById and ProductTypeProfile.updatedById have no rule (B-W2b-283 writes them with every change);
-- SampleMeasurement and SampleComment.pointOfMeasureId are foreign keys of the generated migration (Restrict).
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words, a write to kept data a
-- restrict_violation; the new checks are AFTER triggers (the policies speak first), the refused deletes BEFORE; the
-- redefined functions keep their triggers (InspectionMeasurement's is a BEFORE trigger: it writes `pass`). An UPDATE that
-- changes nothing passes. A rule that reads another row skips a row this session cannot see, unless the row it names must
-- exist. No data copy: every new column is null, empty or its default on the rows made before it, and they keep every rule.
--
-- USED FROM EARLIER WAVES, as they are: "factory_styles_text_ok", "factory_styles_distinct" (…_styles_libraries_w2b_guards),
-- "factory_bom_options_code_ok", "factory_bom_options_words_ok" (…_bom_options_w2b_guards), "factory_market_code_ok",
-- "factory_market_code_known", "factory_language_list_ok" (…_compliance_rules_w2b_guards), "factory_recall_not_future"
-- (…_recall_claims_w2b_guards), "factory_techfiles_refuse_truncate" (…_techfiles_labels_w2b_guards).
--
-- Before deploying on a database with rows (the lead): `SELECT "tenantId", lower(code), count(*) FROM "PointOfMeasure" GROUP BY 1,
-- 2 HAVING count(*) > 1` and `SELECT count(*) FROM "SampleMeasurement" m WHERE m."pointOfMeasureId" IS NOT NULL AND NOT EXISTS
-- (SELECT 1 FROM "PointOfMeasure" p WHERE p."tenantId" = m."tenantId" AND p.id = m."pointOfMeasureId")` (and the same for
-- SampleComment) must find nothing: the API refused both since B-W2b-224 and B-W2b-252, so none is expected.

-- =====================================================================================================================
-- PointOfMeasure (B-W2b-224): "chest" and "CHEST" are one code; two writes at once can no longer make both.
CREATE UNIQUE INDEX "PointOfMeasure_tenantId_lower_code_key" ON "PointOfMeasure"("tenantId", lower("code"));

-- =====================================================================================================================
-- Style (B-W2b-254, -266): the markets it is sold in.
CREATE FUNCTION "factory_style_market_codes_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  code text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."marketCodes" IS NOT DISTINCT FROM OLD."marketCodes" THEN
    RETURN NULL;
  END IF;
  IF NEW."marketCodes" IS NULL OR cardinality(NEW."marketCodes") > 60 OR NOT "factory_styles_distinct"(NEW."marketCodes") THEN
    RAISE EXCEPTION 'product: style % names the markets it is sold in each once, at most 60 (none: every market)', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  FOREACH code IN ARRAY NEW."marketCodes" LOOP
    IF NOT "factory_market_code_ok"(code) THEN
      RAISE EXCEPTION 'product: style % names a market by its code ("DE", "US-CA"); "%" is not one', NEW."code", code
        USING ERRCODE = 'check_violation';
    END IF;
    IF (TG_OP = 'INSERT' OR NOT code = ANY (OLD."marketCodes")) AND NOT "factory_market_code_known"(NEW."tenantId", code) THEN
      RAISE EXCEPTION 'product: style % names market %, which is not a market of the tenant (Compliance › Rules & markets)', NEW."code", code
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Style_w2b5_market_codes" AFTER INSERT OR UPDATE OF "marketCodes" ON "Style"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_market_codes_check"();

-- =====================================================================================================================
-- LabResult (B-W2b-217, -267): the lab's cost of one result, typed with it (the row is append-only: W1's triggers refuse
-- every UPDATE).
CREATE FUNCTION "factory_lab_result_cost_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."costAmount" IS NULL) <> (NEW."costCurrency" IS NULL) OR NEW."costAmount" < 0 OR NEW."costCurrency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'quality: lab result % has the lab''s cost (minor units, 0 or more) with its currency (ISO 4217, "EUR"), or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "LabResult_w2b5_cost" AFTER INSERT ON "LabResult"
  FOR EACH ROW EXECUTE FUNCTION "factory_lab_result_cost_check"();

-- =====================================================================================================================
-- WorkOrderSize (B-W2b-212, -246): REDEFINED `factory_work_order_size_guard` (…_changes_samples_w2b_guards, whole, never
-- redefined since): as there, and the order line and its party both or neither, neither only on a SAMPLE work order. The
-- triggers stay.
CREATE OR REPLACE FUNCTION "factory_work_order_size_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  order_kind text;
  part_of uuid;
  line record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."workOrderId" <> OLD."workOrderId" THEN
      RAISE EXCEPTION 'production: work order cell % never moves to another work order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    part_of := NEW."workOrderId";
    SELECT w."status"::text, w."kind"::text INTO state, order_kind FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId" FOR SHARE;
  ELSE
    part_of := OLD."workOrderId";
    SELECT w."status"::text, w."kind"::text INTO state, order_kind FROM "WorkOrder" w WHERE w."tenantId" = OLD."tenantId" AND w."id" = OLD."workOrderId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'production: work order % is %; its size quantities are frozen (MES-005), they change only while it is DRAFT', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1 OR btrim(NEW."size") = '' THEN
    RAISE EXCEPTION 'production: work order cell % has a size and at least one piece', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF order_kind IS NOT NULL AND order_kind <> 'REPAIR'
     AND ((order_kind = 'MADE_TO_MEASURE') <> (NEW."measurementProfileId" IS NOT NULL)
          OR (order_kind = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1)) THEN
    RAISE EXCEPTION 'production: work order cell % is one made-to-measure unit with its measurement profile, or a size-grid cell without one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF order_kind = 'REPAIR' AND NEW."measurementProfileId" IS NOT NULL AND NEW."quantity" <> 1 THEN
    RAISE EXCEPTION 'production: repair cell % repairs one made-to-measure garment (one unit with its profile)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-5 (B-W2b-275): the order line and its party both or neither; neither only on a SAMPLE work order (which names its
  -- sample round: B-W2b-212's WorkOrder trigger), for an internal or uncharged round.
  IF (NEW."salesOrderLineId" IS NULL) <> (NEW."partyId" IS NULL) THEN
    RAISE EXCEPTION 'production: work order cell % names its sales order line with that line''s party, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."salesOrderLineId" IS NULL AND order_kind IS DISTINCT FROM 'SAMPLE' THEN
    RAISE EXCEPTION 'production: work order cell % makes a sales order line: only a SAMPLE work order''s cell may name none (an internal or uncharged sample round)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."styleId", l."colourwayId", l."kind"::text AS kind, l."measurementProfileId" INTO line
    FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
  IF FOUND
     AND ((line."styleId", line."colourwayId", line."measurementProfileId") IS DISTINCT FROM (NEW."styleId", NEW."colourwayId", NEW."measurementProfileId")
          OR (order_kind IS NOT NULL AND order_kind <> 'REPAIR'
              AND line.kind <> CASE WHEN order_kind = 'SAMPLE' THEN 'SIZE_GRID' ELSE order_kind END)) THEN
    RAISE EXCEPTION 'production: work order cell % makes its sales order line %: the same style, colourway, kind and measurement profile (a repair: any kind; a sample: a size grid''s)', NEW."id", NEW."salesOrderLineId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- InspectionMeasurement (B-W2b-224): REDEFINED `factory_inspection_measurement_guard` (…_inspection_plans_w2b_guards, whole,
-- never redefined since): as there, and the asymmetric band (both sides or neither, each from 0, the tolerance its larger
-- side, never on a check with its own nominal) that `pass` is then written from. The BEFORE trigger stays.
CREATE OR REPLACE FUNCTION "factory_inspection_measurement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  asked record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO parent FROM "factory_inspection_record"(OLD."tenantId", OLD."inspectionId", OLD."incomingInspectionId", OLD."inProcessCheckId");
    IF parent.state IS NOT NULL AND parent.state <> 'OPEN' THEN
      RAISE EXCEPTION 'quality: measurement % stays: its record is % (a correction is an amendment)', OLD."id", parent.state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."id", NEW."inspectionId", NEW."incomingInspectionId", NEW."inProcessCheckId", NEW."planCheckId", NEW."pointCode", NEW."size", NEW."sampleIndex", NEW."createdAt", NEW."createdById")
     IS DISTINCT FROM (OLD."id", OLD."inspectionId", OLD."incomingInspectionId", OLD."inProcessCheckId", OLD."planCheckId", OLD."pointCode", OLD."size", OLD."sampleIndex", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'quality: the record, point, size, unit and creation of measurement % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nonnulls(NEW."inspectionId", NEW."incomingInspectionId", NEW."inProcessCheckId") <> 1 THEN
    RAISE EXCEPTION 'quality: measurement % is of exactly one record: a final inspection, an incoming inspection or an in-process check', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO parent FROM "factory_inspection_record"(NEW."tenantId", NEW."inspectionId", NEW."incomingInspectionId", NEW."inProcessCheckId");
  IF parent.state IS NOT NULL AND parent.state <> 'OPEN' THEN
    RAISE EXCEPTION 'quality: measurement % waits for an OPEN record; its record is % (a correction is an amendment)', NEW."id", parent.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_inspection_code_ok"(NEW."pointCode") OR NEW."sampleIndex" < 1 OR NEW."nominal" < 0 OR NEW."tolerance" < 0 OR NEW."measured" < 0 THEN
    RAISE EXCEPTION 'quality: measurement % has a point code without spaces, a unit of the sample from 1, and nominal, tolerance and value from 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-5 (B-W2b-275): an asymmetric band of the spec kept as it is: both sides or neither, each from 0; with it the tolerance
  -- is the larger side (what a reader of nominal ± tolerance shows).
  IF (NEW."toleranceMinus" IS NULL) <> (NEW."tolerancePlus" IS NULL) OR NEW."toleranceMinus" < 0 OR NEW."tolerancePlus" < 0 THEN
    RAISE EXCEPTION 'quality: measurement % gives how far below and above the nominal it may be both or neither, each from 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."toleranceMinus" IS NOT NULL AND NEW."tolerance" <> greatest(NEW."toleranceMinus", NEW."tolerancePlus") THEN
    RAISE EXCEPTION 'quality: measurement % with the band −% / +% has the larger side (%) as its tolerance, not %', NEW."id", NEW."toleranceMinus", NEW."tolerancePlus",
      greatest(NEW."toleranceMinus", NEW."tolerancePlus"), NEW."tolerance"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."planCheckId" IS NOT NULL THEN
    SELECT c."planVersionId", c."type"::text AS "type", c."nominal", c."tolerance", c."uom" INTO asked
      FROM "InspectionPlanCheck" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."planCheckId";
    IF FOUND THEN
      IF asked."type" <> 'MEASUREMENT' OR (parent.state IS NOT NULL AND asked."planVersionId" IS DISTINCT FROM parent.plan_version) THEN
        RAISE EXCEPTION 'quality: measurement % answers a MEASUREMENT check of the plan version frozen on its record (QHS-016)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF asked."nominal" IS NOT NULL AND (NEW."nominal", NEW."tolerance", NEW."uom") IS DISTINCT FROM (asked."nominal", asked."tolerance", asked."uom") THEN
        RAISE EXCEPTION 'quality: measurement % keeps its check''s nominal, tolerance and unit (% ± % %)', NEW."id", asked."nominal", asked."tolerance", asked."uom"
          USING ERRCODE = 'check_violation';
      END IF;
      -- W2b-5 (B-W2b-275): a check with its own nominal measures against its ± tolerance, never a band.
      IF asked."nominal" IS NOT NULL AND NEW."toleranceMinus" IS NOT NULL THEN
        RAISE EXCEPTION 'quality: measurement % answers a check with its own nominal: its ± tolerance applies, not a band', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  PERFORM "factory_inspection_recorder_check"(NEW."recordedById", NEW."recordedByWorkerId", NEW."deviceId", 'measurement', NEW."id");
  -- W2b-5 (B-W2b-275): within the band when the row has one, else within nominal ± tolerance.
  NEW."pass" := CASE
    WHEN NEW."toleranceMinus" IS NULL THEN abs(NEW."measured" - NEW."nominal") <= NEW."tolerance"
    ELSE NEW."measured" BETWEEN NEW."nominal" - NEW."toleranceMinus" AND NEW."nominal" + NEW."tolerancePlus"
  END;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- ComplianceDocument (GATE-PPE-TEXTS): REDEFINED `factory_compliance_document_w2b4_check` (…_techfiles_labels_w2b_guards,
-- whole, never redefined since): as there, but a generated document leaves DRAFT while a live PpeTextApproval of its
-- template covers its language and company. The trigger stays.
CREATE OR REPLACE FUNCTION "factory_compliance_document_w2b4_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text;
  original record;
  style record;
  expected_maker uuid;
  -- W2b-5 (B-W2b-275): the template a generated document names (content.template or sections.template).
  template text;
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

  -- GATE-PPE-TEXTS: a generated document is a draft until a PPE consultant has checked the generated texts. W2b-5
  -- (B-W2b-275): that yes is a PpeTextApproval. A generated document is made a DRAFT (or WITHDRAWN), and it leaves DRAFT for
  -- anything but WITHDRAWN only while a live approval of its template (`<templateKey>.<templateVersion>`) covers its language
  -- and its company (or the whole tenant). Later moves of an issued one (SUPERSEDED, WITHDRAWN) are W1's.
  IF NEW."origin" = 'GENERATED' AND NEW."status" NOT IN ('DRAFT', 'WITHDRAWN')
     AND (TG_OP = 'INSERT' OR OLD."status" IN ('DRAFT', 'WITHDRAWN')) THEN
    template := CASE WHEN NEW."kind" = 'DECLARATION_OF_CONFORMITY' THEN NEW."content" ->> 'template' ELSE NEW."sections" ->> 'template' END;
    IF TG_OP = 'INSERT' OR OLD."status" = 'WITHDRAWN' OR template IS NULL OR NOT EXISTS (
      SELECT 1 FROM "PpeTextApproval" a
       WHERE a."tenantId" = NEW."tenantId"
         AND a."templateKind"::text = CASE WHEN NEW."kind" = 'DECLARATION_OF_CONFORMITY' THEN 'DOC' ELSE 'USER_INFORMATION' END
         AND a."templateKey" || '.' || a."templateVersion" = template
         AND NEW."language" = ANY (a."languages")
         AND (a."companyId" IS NULL OR a."companyId" = NEW."companyId")
         AND a."withdrawnAt" IS NULL) THEN
      RAISE EXCEPTION 'compliance: document % was generated: it stays a DRAFT (or is withdrawn) until a PPE consultant has checked the generated texts (GATE-PPE-TEXTS): no live approval of its template % covers % for its company; the signed document is the live one',
        NEW."id", coalesce(template, '(none named)'), NEW."language"
        USING ERRCODE = 'check_violation';
    END IF;
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

-- =====================================================================================================================
-- ComplianceDocumentBatch (B-W2b-257): REDEFINED `factory_compliance_document_batch_check` (…_techfiles_labels_w2b_guards,
-- whole, never redefined since): as there, and a SUPERSEDED document is accepted for a batch made while it was in force.
-- The triggers stay.
CREATE OR REPLACE FUNCTION "factory_compliance_document_batch_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  found_company uuid;
  found_batch text;
  found_status text;
  -- W2b-5 (B-W2b-275): a superseded document's revision, the revision the work order made, and whether the batch was made
  -- while the document was in force.
  found_revision int;
  made_revision int;
  in_force boolean;
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
    SELECT d."status"::text, d."companyId", d."revision" INTO found_status, found_company, found_revision
      FROM "ComplianceDocument" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."documentId";
    -- W2b-5 (B-W2b-275; the B-W2b-257 note): a SUPERSEDED document goes with a batch made while it was in force, which ships
    -- late: a work order's batch made to the document's revision (the revision it froze), or a batch already recorded with
    -- this document (recorded while it was ISSUED; a batch number typed has no other trace of when it was made).
    IF FOUND AND found_status = 'SUPERSEDED' THEN
      in_force := EXISTS (SELECT 1 FROM "ComplianceDocumentBatch" b
                           WHERE b."tenantId" = NEW."tenantId" AND b."documentId" = NEW."documentId" AND b."batchNumber" = NEW."batchNumber" AND b."id" <> NEW."id");
      IF NOT in_force AND NEW."workOrderId" IS NOT NULL THEN
        SELECT r."revision" INTO made_revision
          FROM "WorkOrder" w JOIN "StyleRevision" r ON r."tenantId" = w."tenantId" AND r."id" = w."styleRevisionId"
         WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
        in_force := made_revision IS NOT DISTINCT FROM found_revision;
      END IF;
      IF NOT in_force THEN
        RAISE EXCEPTION 'compliance: batch record % names a SUPERSEDED document: only a batch made while it was in force ships with it (a work order made to its revision %, or a batch recorded with it before); a new batch goes with the declaration in force', NEW."id", found_revision
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF FOUND AND found_status <> 'ISSUED' THEN
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

-- =====================================================================================================================
-- PpeTextApproval (GATE-PPE-TEXTS; B-W2b-218, -253, -257, -258): the PPE consultant's yes per template.
CREATE FUNCTION "factory_ppe_text_approval_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- What the withdrawal writes; everything else stays as recorded.
  withdrawal CONSTANT text[] := ARRAY['withdrawnAt', 'withdrawnById', 'withdrawReason', 'version', 'updatedAt'];
  evidence record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (to_jsonb(NEW) - withdrawal) IS DISTINCT FROM (to_jsonb(OLD) - withdrawal) THEN
      RAISE EXCEPTION 'compliance: PPE text approval % stays as recorded; only its withdrawal is written', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."withdrawnAt" IS NOT NULL AND (NEW."withdrawnAt", NEW."withdrawnById", NEW."withdrawReason") IS DISTINCT FROM (OLD."withdrawnAt", OLD."withdrawnById", OLD."withdrawReason") THEN
      RAISE EXCEPTION 'compliance: PPE text approval % was withdrawn at %; its withdrawal never changes', OLD."id", OLD."withdrawnAt"
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    IF NEW."withdrawnAt" IS NOT NULL OR NEW."withdrawnById" IS NOT NULL OR NEW."withdrawReason" IS NOT NULL THEN
      RAISE EXCEPTION 'compliance: PPE text approval % is recorded in force; it is withdrawn later', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_bom_options_code_ok"(NEW."templateKey", 80) OR NEW."templateVersion" NOT BETWEEN 1 AND 9999 THEN
      RAISE EXCEPTION 'compliance: PPE text approval % names its template by its key ("annex-ix"; a label template''s code), 1 to 80 characters without spaces, and its version from 1', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."templateKind" = 'LABEL_WARNING' AND NOT EXISTS (
      SELECT 1 FROM "LabelTemplate" t
       WHERE t."tenantId" = NEW."tenantId" AND t."code" = NEW."templateKey" AND t."revision" = NEW."templateVersion"
         AND (t."companyId" IS NULL OR t."companyId" IS NOT DISTINCT FROM NEW."companyId")) THEN
      RAISE EXCEPTION 'compliance: PPE text approval % of label warnings names a label template of its company (or a tenant-wide one) by its code and revision (% revision %)', NEW."id", NEW."templateKey", NEW."templateVersion"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."languages" IS NULL OR cardinality(NEW."languages") = 0 OR NOT "factory_language_list_ok"(NEW."languages") THEN
      RAISE EXCEPTION 'compliance: PPE text approval % names the languages checked as ISO 639 codes ("it"), each once, 1 to 20', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_styles_text_ok"(NEW."checkedBy", 300) THEN
      RAISE EXCEPTION 'compliance: PPE text approval % names the consultant who checked the texts (name and firm, 1 to 300 characters on one line)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_recall_not_future"(NEW."recordedAt") THEN
      RAISE EXCEPTION 'compliance: PPE text approval % is recorded now, not at % (in the future)', NEW."id", NEW."recordedAt"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT f."companyId", f."status"::text AS status INTO evidence
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."evidenceFileId";
    IF FOUND AND (evidence.status <> 'AVAILABLE' OR (evidence."companyId" IS NOT NULL AND evidence."companyId" IS DISTINCT FROM NEW."companyId")) THEN
      RAISE EXCEPTION 'compliance: PPE text approval % rests on the consultant''s file: a stored file of its company (or a tenant-wide one), AVAILABLE (this one is %)', NEW."id", evidence.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."withdrawnAt" IS NULL) <> (NEW."withdrawnById" IS NULL) OR (NEW."withdrawnAt" IS NULL) <> (NEW."withdrawReason" IS NULL) THEN
    RAISE EXCEPTION 'compliance: PPE text approval % is withdrawn exactly with when, by whom and why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."withdrawnAt" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."withdrawnAt" IS NULL) THEN
    IF NEW."withdrawnAt" < NEW."recordedAt" OR NOT "factory_recall_not_future"(NEW."withdrawnAt") THEN
      RAISE EXCEPTION 'compliance: PPE text approval % is withdrawn after it was recorded (%) and not in the future', NEW."id", NEW."recordedAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_bom_options_words_ok"(NEW."withdrawReason", 2000) THEN
      RAISE EXCEPTION 'compliance: PPE text approval % says why it is withdrawn (1 to 2000 characters)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_ppe_text_approval_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'compliance: PPE text approval % is never deleted; withdraw it with a reason', OLD."id"
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER "PpeTextApproval_guard" AFTER INSERT OR UPDATE ON "PpeTextApproval"
  FOR EACH ROW EXECUTE FUNCTION "factory_ppe_text_approval_guard"();
CREATE TRIGGER "PpeTextApproval_kept" BEFORE DELETE ON "PpeTextApproval"
  FOR EACH ROW EXECUTE FUNCTION "factory_ppe_text_approval_kept"();
CREATE TRIGGER "PpeTextApproval_no_truncate" BEFORE TRUNCATE ON "PpeTextApproval"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_techfiles_refuse_truncate"();
