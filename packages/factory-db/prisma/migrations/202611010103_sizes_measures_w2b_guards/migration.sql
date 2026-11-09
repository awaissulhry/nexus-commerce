-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202611010102_sizes_measures_w2b_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- Sizes, measurements and made-to-measure rules, W2b-4 schema wave 27/33 (B-W2b-210; PRD-049, PRD-051, PRD-052, PRD-055,
-- PRD-062, PRD-063, PRD-069, PRD-074, PRD-201, PRD-202, PRD-203, PRD-204). apps/factory-api checks all of this first and
-- answers in words (B-W2b-224, -233, -248); these rules are the last word, for every login, the owner included.
--
--   SizeScale, Size          a scale has 1 dimension or 2 (size and fit); the number changes only while the scale has no
--                            size; a size has a fit (1-10 letters or digits) exactly when its scale has two.
--   PointOfMeasure           its company and creation never change; a code without spaces, a name, words per language;
--                            a length (CM or MM); a default tolerance of 0 or more; only a GARMENT point names a body
--                            point, a BODY one, never itself; its kind and unit change only while nothing names it (a
--                            template point, a spec value, a grade step, a garment point); its picture is an AVAILABLE
--                            PHOTO of this point (StoredFile recordType "PointOfMeasure").
--   MeasurementSpec,         parts of the style revision: the …_product_guards part rule (factory_style_revision_part_guard,
--   MeasurementSpecValue,    as it is) refuses any insert, change or removal once the revision is released.
--   ProtectorPlacement
--   MeasurementSpec          its style and creation never change; the base size is one of the style's sizes; DRAFT →
--                            APPROVED | ARCHIVED, APPROVED → DRAFT (reopened) | ARCHIVED, ARCHIVED final; an approved
--                            spec changes only by those moves; APPROVED names who and when (DRAFT neither); approved with
--                            at least one value, every value of one of the style's sizes and every point with a value
--                            for the base size; its grade rule is of the style's size scale and not archived when given;
--                            one live (DRAFT or APPROVED) spec per revision: a partial unique index.
--   MeasurementSpecValue     keeps its spec, point, size and creation; written only while the spec is DRAFT (its row FOR
--                            SHARE: an approval waits for an edit in flight), removed while it is DRAFT or ARCHIVED (an
--                            abandoned draft revision's archived spec goes with it); a GARMENT point; a size code without
--                            spaces; a place from 1; a nominal above 0, tolerances of 0 or more.
--   GradeRule                its company, scale and creation never change; a code without spaces, a name; the base size
--                            is a size of the scale; a company's scale only for that company's rule.
--   GradeRuleStep            keeps its rule, point and creation; both sizes or neither (the standard increment, one per
--                            rule and point: a partial unique index), never the same; size codes without spaces.
--   Prepack                  its scale, style and creation never change; a code without spaces, a name; a style's
--                            prepack is of the style's scale.
--   PrepackLine              keeps its prepack, size, colourway and creation; written only while the prepack is ACTIVE
--                            (its row FOR SHARE); a size code without spaces; 1 to 10 000 pieces; a colourway with its
--                            style, only the prepack's style (a scale's prepack names none); one line per size without a
--                            colourway: a partial unique index.
--   ProtectorPlacement       a place from 1; a PROTECTOR material; a standard and a level ("1" or "2"); its sizes once
--                            each, of the style's sizes; a position note.
--   MeasurementPoint         its library point is a BODY point of its unit; tolerance and alteration limits 0 or more.
--   MeasurementRule          keeps its template and creation; a code without spaces; ORDER compares two points of one
--                            unit, RATIO two points between factors above 0, RANGE one point between values; never a
--                            point with itself; words per language.
--   MeasurementTemplate      its base size rule: {"points": [1-10 of its points' codes, once each], "tie": "LARGER" |
--                            "SMALLER"}.
--   BomLine                  its made-to-measure point and factor come together; the factor above 0 and at most 10; the
--                            point is of the style's measurement template.
--   every new table          TRUNCATE refused.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words (the W1 part rule's restrict_violation
-- as it is). The tenant of a row is left to the policies and the references, never compared here: a rule that reads another
-- row skips a row this session cannot see. An UPDATE that changes nothing passes. The new checks are AFTER triggers, so the
-- policies (and the W1 part rule) speak first.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers
-- moved) and insert the copy: so a size code in a unique key (spec value, grade step, prepack line) is checked for its shape
-- only (whether the style or the scale has it is the API's; a spec's approval checks its values' sizes), the base size rule
-- names the points of its own template (the seed's first template has none), and the one-live-spec, one-standard-step and
-- one-line-per-size rules are partial unique indexes the seeds' first rows stay outside of.

CREATE FUNCTION "factory_sizes_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'product: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- A code: no spaces, at most max_length characters.
CREATE FUNCTION "factory_sizes_code_ok"(code text, max_length int) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code ~ '^\S+$' AND length(code) <= max_length
$$;

-- Words: not blank, at most max_length characters, no control characters but line breaks and tabs.
CREATE FUNCTION "factory_sizes_text_ok"(words text, max_length int) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(words) <> '' AND length(words) <= max_length AND words !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- SizeScale, Size (PRD-049): one dimension, or two (size and fit).
CREATE FUNCTION "factory_size_scale_dimensions_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."dimensions" NOT IN (1, 2) THEN
    RAISE EXCEPTION 'product: size scale % has 1 dimension, or 2 (size and fit), not %', NEW."id", NEW."dimensions"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."dimensions" <> OLD."dimensions"
     AND EXISTS (SELECT 1 FROM "Size" s WHERE s."tenantId" = NEW."tenantId" AND s."scaleId" = NEW."id") THEN
    RAISE EXCEPTION 'product: the dimensions of size scale % change only while it has no size (a size and fit scale is a new scale)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SizeScale_dimensions" AFTER INSERT OR UPDATE OF "dimensions" ON "SizeScale"
  FOR EACH ROW EXECUTE FUNCTION "factory_size_scale_dimensions_check"();

CREATE FUNCTION "factory_size_fit_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  dims int;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."fitCode", NEW."scaleId") IS NOT DISTINCT FROM (OLD."fitCode", OLD."scaleId") THEN
    RETURN NULL;
  END IF;
  IF NEW."fitCode" IS NOT NULL AND NEW."fitCode" !~ '^[A-Za-z0-9]{1,10}$' THEN
    RAISE EXCEPTION 'product: the fit of size % is 1 to 10 letters or digits ("S", "R", "L")', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- The scale's row FOR SHARE: a change of its dimensions waits for this size, and this size for it.
  SELECT sc."dimensions" INTO dims FROM "SizeScale" sc WHERE sc."tenantId" = NEW."tenantId" AND sc."id" = NEW."scaleId" FOR SHARE;
  IF dims IS NOT NULL AND (dims = 2) <> (NEW."fitCode" IS NOT NULL) THEN
    RAISE EXCEPTION 'product: size % has a fit exactly when its scale has two dimensions (size and fit); its scale has %', NEW."id", dims
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Size_fit" AFTER INSERT OR UPDATE OF "fitCode", "scaleId" ON "Size"
  FOR EACH ROW EXECUTE FUNCTION "factory_size_fit_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- PointOfMeasure (PRD-062, PRD-069).
CREATE FUNCTION "factory_point_of_measure_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  body_kind text;
  file_kind text;
  file_type text;
  file_record uuid;
  file_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the company and creation of point of measure % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."kind", NEW."uom") IS DISTINCT FROM (OLD."kind", OLD."uom")
       AND (EXISTS (SELECT 1 FROM "MeasurementPoint" p WHERE p."tenantId" = NEW."tenantId" AND p."pointOfMeasureId" = NEW."id")
            OR EXISTS (SELECT 1 FROM "MeasurementSpecValue" v WHERE v."tenantId" = NEW."tenantId" AND v."pointOfMeasureId" = NEW."id")
            OR EXISTS (SELECT 1 FROM "GradeRuleStep" g WHERE g."tenantId" = NEW."tenantId" AND g."pointOfMeasureId" = NEW."id")
            OR EXISTS (SELECT 1 FROM "PointOfMeasure" g WHERE g."tenantId" = NEW."tenantId" AND g."bodyPointId" = NEW."id")) THEN
      RAISE EXCEPTION 'product: point of measure % is in use (a template point, a spec value, a grade step or a garment point names it): its kind and unit never change; make a new point', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NOT "factory_sizes_code_ok"(NEW."code", 60) THEN
    RAISE EXCEPTION 'product: the code of point of measure % has no spaces and at most 60 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_sizes_text_ok"(NEW."name", 200)
     OR (NEW."description" IS NOT NULL AND NOT "factory_sizes_text_ok"(NEW."description", 2000))
     OR (NEW."howTo" IS NOT NULL AND NOT "factory_sizes_text_ok"(NEW."howTo", 2000)) THEN
    RAISE EXCEPTION 'product: point of measure % has a name (at most 200 characters), and its description and how to measure say something (at most 2000)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."nameI18n" IS NOT NULL AND NOT "factory_instruction_words_ok"(NEW."nameI18n"))
     OR (NEW."howToI18n" IS NOT NULL AND NOT "factory_instruction_words_ok"(NEW."howToI18n")) THEN
    RAISE EXCEPTION 'product: point of measure % says its name and how to measure per language: {"it": "…", "en": "…"}, none blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."uom" NOT IN ('CM', 'MM') THEN
    RAISE EXCEPTION 'product: point of measure % is a length, in CM or MM, not %', NEW."id", NEW."uom"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."defaultTolerance" < 0 THEN
    RAISE EXCEPTION 'product: the default tolerance of point of measure % is 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."bodyPointId" IS NOT NULL THEN
    IF NEW."kind" <> 'GARMENT' OR NEW."bodyPointId" = NEW."id" THEN
      RAISE EXCEPTION 'product: only a GARMENT point of measure names its body point, never itself (point %)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' OR NEW."bodyPointId" IS DISTINCT FROM OLD."bodyPointId" THEN
      SELECT b."kind"::text INTO body_kind FROM "PointOfMeasure" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."bodyPointId";
      IF body_kind IS NOT NULL AND body_kind <> 'BODY' THEN
        RAISE EXCEPTION 'product: the body point of point of measure % is a BODY point', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."pictureFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."pictureFileId" IS DISTINCT FROM OLD."pictureFileId") THEN
    SELECT f."kind"::text, f."recordType", f."recordId", f."status"::text INTO file_kind, file_type, file_record, file_status
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."pictureFileId";
    IF file_kind IS NOT NULL
       AND (file_kind <> 'PHOTO' OR file_type <> 'PointOfMeasure' OR file_record <> NEW."id" OR file_status <> 'AVAILABLE') THEN
      RAISE EXCEPTION 'product: the picture of point of measure % is an AVAILABLE photo of the point (recordType PointOfMeasure)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PointOfMeasure_check" AFTER INSERT OR UPDATE ON "PointOfMeasure"
  FOR EACH ROW EXECUTE FUNCTION "factory_point_of_measure_check"();
CREATE TRIGGER "PointOfMeasure_no_truncate" BEFORE TRUNCATE ON "PointOfMeasure"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sizes_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- MeasurementSpec (PRD-063, PRD-052): a part of its revision; one live spec per revision; approved with its values.
CREATE TRIGGER "MeasurementSpec_revision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "MeasurementSpec"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "MeasurementSpec_no_truncate" BEFORE TRUNCATE ON "MeasurementSpec"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_part_guard"();

CREATE FUNCTION "factory_measurement_spec_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  style_sizes text[];
  style_scale uuid;
  rule_scale uuid;
  rule_status text;
  outside text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."styleId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."styleId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the style and creation of measurement spec % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'ARCHIVED' THEN
      RAISE EXCEPTION 'product: measurement spec % is archived; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('APPROVED', 'ARCHIVED'))
                OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('DRAFT', 'ARCHIVED'))) THEN
      RAISE EXCEPTION 'product: measurement spec % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'APPROVED' AND NEW."status" = 'APPROVED' THEN
      RAISE EXCEPTION 'product: measurement spec % is approved; reopen it (DRAFT) to change it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."status" = 'APPROVED' AND (NEW."approvedAt" IS NULL OR NEW."approvedById" IS NULL))
     OR (NEW."status" = 'DRAFT' AND (NEW."approvedAt" IS NOT NULL OR NEW."approvedById" IS NOT NULL))
     OR ((NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL)) THEN
    RAISE EXCEPTION 'product: measurement spec % names who approved it and when while APPROVED, and nobody while DRAFT', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s."sizes", s."sizeScaleId" INTO style_sizes, style_scale FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
  IF style_scale IS NULL THEN
    RETURN NULL;
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."baseSize" IS DISTINCT FROM OLD."baseSize")
     AND NOT (NEW."baseSize" = ANY (coalesce(style_sizes, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'product: the base size % of measurement spec % is one of the style''s sizes (%)', NEW."baseSize", NEW."id", array_to_string(style_sizes, ', ')
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."gradeRuleId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."gradeRuleId" IS DISTINCT FROM OLD."gradeRuleId") THEN
    SELECT r."sizeScaleId", r."status"::text INTO rule_scale, rule_status FROM "GradeRule" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."gradeRuleId";
    IF rule_scale IS NOT NULL AND (rule_scale <> style_scale OR rule_status = 'ARCHIVED') THEN
      RAISE EXCEPTION 'product: the grade rule of measurement spec % is an active rule of the style''s size scale', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" = 'APPROVED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'APPROVED') THEN
    IF NOT EXISTS (SELECT 1 FROM "MeasurementSpecValue" v WHERE v."tenantId" = NEW."tenantId" AND v."specId" = NEW."id") THEN
      RAISE EXCEPTION 'product: measurement spec % is approved with at least one value', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT v."size" INTO outside FROM "MeasurementSpecValue" v
      WHERE v."tenantId" = NEW."tenantId" AND v."specId" = NEW."id" AND NOT (v."size" = ANY (coalesce(style_sizes, ARRAY[]::text[])))
      ORDER BY v."size" LIMIT 1;
    IF outside IS NOT NULL THEN
      RAISE EXCEPTION 'product: measurement spec % is approved only when every value is of one of the style''s sizes (%): % is not', NEW."id", array_to_string(style_sizes, ', '), outside
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "MeasurementSpecValue" v
                WHERE v."tenantId" = NEW."tenantId" AND v."specId" = NEW."id"
                  AND NOT EXISTS (SELECT 1 FROM "MeasurementSpecValue" b
                                   WHERE b."tenantId" = v."tenantId" AND b."specId" = v."specId"
                                     AND b."pointOfMeasureId" = v."pointOfMeasureId" AND b."size" = NEW."baseSize")) THEN
      RAISE EXCEPTION 'product: measurement spec % is approved only when every point has a value for its base size %', NEW."id", NEW."baseSize"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MeasurementSpec_shape" AFTER INSERT OR UPDATE ON "MeasurementSpec"
  FOR EACH ROW EXECUTE FUNCTION "factory_measurement_spec_check"();

-- One live spec per revision: DRAFT or APPROVED (an ARCHIVED one is kept beside it). A unique index is checked row by row:
-- archive the old spec first, then start the new one.
CREATE UNIQUE INDEX "MeasurementSpec_one_live_per_revision" ON "MeasurementSpec" ("tenantId", "revisionId") WHERE "status" <> 'ARCHIVED';

-- ---------------------------------------------------------------------------------------------------------------------
-- MeasurementSpecValue (PRD-063): a part of its revision; written only while its spec is DRAFT.
CREATE TRIGGER "MeasurementSpecValue_revision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "MeasurementSpecValue"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "MeasurementSpecValue_no_truncate" BEFORE TRUNCATE ON "MeasurementSpecValue"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_part_guard"();

CREATE FUNCTION "factory_measurement_spec_value_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  spec_status text;
  point_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."specId", NEW."pointOfMeasureId", NEW."size", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."specId", OLD."pointOfMeasureId", OLD."size", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: a measurement spec value keeps its spec, point of measure, size and creation; another cell is a new row'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT m."status"::text INTO spec_status FROM "MeasurementSpec" m WHERE m."tenantId" = OLD."tenantId" AND m."id" = OLD."specId" FOR SHARE;
    IF spec_status = 'APPROVED' THEN
      RAISE EXCEPTION 'product: measurement spec % is approved: its values change only while it is DRAFT (reopen it first)', OLD."specId"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  SELECT m."status"::text INTO spec_status FROM "MeasurementSpec" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."specId" FOR SHARE;
  IF spec_status IS NOT NULL AND spec_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'product: measurement spec % is %: its values change only while it is DRAFT (reopen it first)', NEW."specId", spec_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_sizes_code_ok"(NEW."size", 40) THEN
    RAISE EXCEPTION 'product: the size of measurement spec value % is a size code without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'product: the place of measurement spec value % counts from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."nominal" <= 0 OR NEW."toleranceMinus" < 0 OR NEW."tolerancePlus" < 0 THEN
    RAISE EXCEPTION 'product: measurement spec value % has a nominal above 0 and tolerances of 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT p."kind"::text INTO point_kind FROM "PointOfMeasure" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."pointOfMeasureId";
    IF point_kind IS NOT NULL AND point_kind <> 'GARMENT' THEN
      RAISE EXCEPTION 'product: a measurement spec measures the garment: point of measure % is a % point (body measures stay on the size scale)', NEW."pointOfMeasureId", point_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MeasurementSpecValue_shape" AFTER INSERT OR UPDATE OR DELETE ON "MeasurementSpecValue"
  FOR EACH ROW EXECUTE FUNCTION "factory_measurement_spec_value_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- GradeRule, GradeRuleStep (PRD-051, PRD-049).
CREATE FUNCTION "factory_grade_rule_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scale_company uuid;
  scale_found boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."sizeScaleId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."sizeScaleId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the company, size scale and creation of grade rule % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_sizes_code_ok"(NEW."code", 60) OR NOT "factory_sizes_text_ok"(NEW."name", 200) THEN
    RAISE EXCEPTION 'product: grade rule % has a code without spaces (at most 60 characters) and a name (at most 200)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT true, sc."companyId" INTO scale_found, scale_company FROM "SizeScale" sc WHERE sc."tenantId" = NEW."tenantId" AND sc."id" = NEW."sizeScaleId";
  IF NOT coalesce(scale_found, false) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' AND scale_company IS NOT NULL AND scale_company IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'product: grade rule % of a company''s size scale belongs to that company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."baseSize" IS DISTINCT FROM OLD."baseSize")
     AND NOT EXISTS (SELECT 1 FROM "Size" s WHERE s."tenantId" = NEW."tenantId" AND s."scaleId" = NEW."sizeScaleId" AND s."code" = NEW."baseSize") THEN
    RAISE EXCEPTION 'product: the base size % of grade rule % is a size of its scale', NEW."baseSize", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "GradeRule_check" AFTER INSERT OR UPDATE ON "GradeRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_grade_rule_check"();
CREATE TRIGGER "GradeRule_no_truncate" BEFORE TRUNCATE ON "GradeRule"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sizes_refuse_truncate"();

CREATE FUNCTION "factory_grade_rule_step_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."ruleId", NEW."pointOfMeasureId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."ruleId", OLD."pointOfMeasureId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: grade rule step % keeps its rule, point of measure and creation', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."fromSize" IS NULL) <> (NEW."toSize" IS NULL) THEN
    RAISE EXCEPTION 'product: grade rule step % names both sizes (from, to), or neither (the standard increment of every step)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fromSize" IS NOT NULL
     AND (NOT "factory_sizes_code_ok"(NEW."fromSize", 40) OR NOT "factory_sizes_code_ok"(NEW."toSize", 40) OR NEW."fromSize" = NEW."toSize") THEN
    RAISE EXCEPTION 'product: grade rule step % goes from one size code to another (no spaces)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "GradeRuleStep_check" AFTER INSERT OR UPDATE ON "GradeRuleStep"
  FOR EACH ROW EXECUTE FUNCTION "factory_grade_rule_step_check"();
CREATE TRIGGER "GradeRuleStep_no_truncate" BEFORE TRUNCATE ON "GradeRuleStep"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sizes_refuse_truncate"();

-- One standard increment (no sizes) per rule and point of measure.
CREATE UNIQUE INDEX "GradeRuleStep_one_standard_per_point" ON "GradeRuleStep" ("tenantId", "ruleId", "pointOfMeasureId") WHERE "fromSize" IS NULL;

-- ---------------------------------------------------------------------------------------------------------------------
-- Prepack, PrepackLine (PRD-055).
CREATE FUNCTION "factory_prepack_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  style_scale uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."sizeScaleId", NEW."styleId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."sizeScaleId", OLD."styleId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the size scale, style and creation of prepack % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_sizes_code_ok"(NEW."code", 60) OR NOT "factory_sizes_text_ok"(NEW."name", 200) THEN
    RAISE EXCEPTION 'product: prepack % has a code without spaces (at most 60 characters) and a name (at most 200)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."styleId" IS NOT NULL THEN
    SELECT s."sizeScaleId" INTO style_scale FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF style_scale IS NOT NULL AND style_scale <> NEW."sizeScaleId" THEN
      RAISE EXCEPTION 'product: prepack % of a style is of the style''s size scale', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Prepack_check" AFTER INSERT OR UPDATE ON "Prepack"
  FOR EACH ROW EXECUTE FUNCTION "factory_prepack_check"();
CREATE TRIGGER "Prepack_no_truncate" BEFORE TRUNCATE ON "Prepack"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sizes_refuse_truncate"();

CREATE FUNCTION "factory_prepack_line_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pack_status text;
  pack_style uuid;
  pack_id uuid;
  pack_tenant uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."prepackId", NEW."size", NEW."styleId", NEW."colourwayId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."prepackId", OLD."size", OLD."styleId", OLD."colourwayId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: prepack line % keeps its prepack, size, colourway and creation; another is a new line', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    pack_id := OLD."prepackId";
    pack_tenant := OLD."tenantId";
  ELSE
    pack_id := NEW."prepackId";
    pack_tenant := NEW."tenantId";
  END IF;
  SELECT p."status"::text, p."styleId" INTO pack_status, pack_style FROM "Prepack" p WHERE p."tenantId" = pack_tenant AND p."id" = pack_id FOR SHARE;
  IF pack_status IS NOT NULL AND pack_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'product: prepack % is %: its lines never change', pack_id, pack_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF NOT "factory_sizes_code_ok"(NEW."size", 40) THEN
    RAISE EXCEPTION 'product: the size of prepack line % is a size code without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."quantity" < 1 OR NEW."quantity" > 10000 THEN
    RAISE EXCEPTION 'product: prepack line % has 1 to 10 000 pieces, not %', NEW."id", NEW."quantity"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."styleId" IS NULL) <> (NEW."colourwayId" IS NULL) THEN
    RAISE EXCEPTION 'product: prepack line % names a colourway with its style, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."styleId" IS NOT NULL AND pack_status IS NOT NULL AND NEW."styleId" IS DISTINCT FROM pack_style THEN
    RAISE EXCEPTION 'product: the colourway of prepack line % is one of its prepack''s style (a size scale''s prepack names none)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PrepackLine_check" AFTER INSERT OR UPDATE OR DELETE ON "PrepackLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_prepack_line_check"();
CREATE TRIGGER "PrepackLine_no_truncate" BEFORE TRUNCATE ON "PrepackLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sizes_refuse_truncate"();

-- One line per size without a colourway (the colourway lines: the unique key of prepack, size and colourway).
CREATE UNIQUE INDEX "PrepackLine_one_per_size" ON "PrepackLine" ("tenantId", "prepackId", "size") WHERE "colourwayId" IS NULL;

-- ---------------------------------------------------------------------------------------------------------------------
-- ProtectorPlacement (PRD-074): a part of its revision.
CREATE TRIGGER "ProtectorPlacement_revision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ProtectorPlacement"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "ProtectorPlacement_no_truncate" BEFORE TRUNCATE ON "ProtectorPlacement"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_part_guard"();

CREATE FUNCTION "factory_protector_placement_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  style_sizes text[];
  item_kind text;
  outside text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'product: the place of protector placement % counts from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_sizes_text_ok"(NEW."standard", 60) OR NEW."level" NOT IN ('1', '2') THEN
    RAISE EXCEPTION 'product: protector placement % names the standard with its edition ("EN 1621-1:2012", at most 60 characters) and the level "1" or "2"', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."positionNote" IS NOT NULL AND NOT "factory_sizes_text_ok"(NEW."positionNote", 500) THEN
    RAISE EXCEPTION 'product: the position note of protector placement % says something (at most 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."protectorItemId" IS DISTINCT FROM OLD."protectorItemId" THEN
    SELECT i."kind"::text INTO item_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."protectorItemId";
    IF item_kind IS NOT NULL AND item_kind <> 'PROTECTOR' THEN
      RAISE EXCEPTION 'product: protector placement % names a PROTECTOR material, not a % one', NEW."id", item_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW."sizes" IS DISTINCT FROM OLD."sizes" THEN
    IF EXISTS (SELECT 1 FROM unnest(coalesce(NEW."sizes", ARRAY[]::text[])) AS z(size) GROUP BY z.size HAVING z.size IS NULL OR count(*) > 1) THEN
      RAISE EXCEPTION 'product: protector placement % names each size once', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT s."sizes" INTO style_sizes FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND THEN
      SELECT z.size INTO outside FROM unnest(coalesce(NEW."sizes", ARRAY[]::text[])) AS z(size)
        WHERE NOT (z.size = ANY (coalesce(style_sizes, ARRAY[]::text[]))) LIMIT 1;
      IF outside IS NOT NULL THEN
        RAISE EXCEPTION 'product: protector placement % is for the style''s sizes (%): % is not one', NEW."id", array_to_string(style_sizes, ', '), outside
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ProtectorPlacement_shape" AFTER INSERT OR UPDATE ON "ProtectorPlacement"
  FOR EACH ROW EXECUTE FUNCTION "factory_protector_placement_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- MeasurementPoint (PRD-203, PRD-069): its library point, inspection tolerance and alteration limits.
CREATE FUNCTION "factory_measurement_point_mtm_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  point_kind text;
  point_uom text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW."pointOfMeasureId", NEW."uom", NEW."tolerance", NEW."alterationMinus", NEW."alterationPlus")
         IS NOT DISTINCT FROM (OLD."pointOfMeasureId", OLD."uom", OLD."tolerance", OLD."alterationMinus", OLD."alterationPlus") THEN
    RETURN NULL;
  END IF;
  IF NEW."tolerance" < 0 OR NEW."alterationMinus" < 0 OR NEW."alterationPlus" < 0 THEN
    RAISE EXCEPTION 'product: the tolerance and alteration limits of template point % are 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."pointOfMeasureId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."pointOfMeasureId", NEW."uom") IS DISTINCT FROM (OLD."pointOfMeasureId", OLD."uom")) THEN
    SELECT p."kind"::text, p."uom"::text INTO point_kind, point_uom FROM "PointOfMeasure" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."pointOfMeasureId";
    IF point_kind IS NOT NULL AND (point_kind <> 'BODY' OR point_uom <> NEW."uom"::text) THEN
      RAISE EXCEPTION 'product: template point % takes a BODY point of measure in its own unit (%)', NEW."id", NEW."uom"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MeasurementPoint_mtm_depth" AFTER INSERT OR UPDATE OF "pointOfMeasureId", "uom", "tolerance", "alterationMinus", "alterationPlus" ON "MeasurementPoint"
  FOR EACH ROW EXECUTE FUNCTION "factory_measurement_point_mtm_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- MeasurementRule (PRD-201): plausibility between a rider's measures.
CREATE FUNCTION "factory_measurement_rule_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  point_uom text;
  other_uom text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."templateId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."templateId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: measurement rule % keeps its template and creation', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_sizes_code_ok"(NEW."code", 60) THEN
    RAISE EXCEPTION 'product: the code of measurement rule % has no spaces and at most 60 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_instruction_words_ok"(NEW."messageI18n") THEN
    RAISE EXCEPTION 'product: measurement rule % says what is wrong per language: {"it": "…", "en": "…"}, none blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."pointId" = NEW."otherPointId" THEN
    RAISE EXCEPTION 'product: measurement rule % compares two different points', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'ORDER'
     AND (NEW."otherPointId" IS NULL OR NEW."minFactor" IS NOT NULL OR NEW."maxFactor" IS NOT NULL OR NEW."minValue" IS NOT NULL OR NEW."maxValue" IS NOT NULL) THEN
    RAISE EXCEPTION 'product: ORDER rule % names the point that is not above the other, and no factor or value', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'RATIO'
     AND (NEW."otherPointId" IS NULL OR NEW."minValue" IS NOT NULL OR NEW."maxValue" IS NOT NULL
          OR (NEW."minFactor" IS NULL AND NEW."maxFactor" IS NULL) OR NEW."minFactor" <= 0 OR NEW."maxFactor" <= 0
          OR NEW."minFactor" > NEW."maxFactor") THEN
    RAISE EXCEPTION 'product: RATIO rule % names two points and at least one factor above 0 (the smallest first), and no value', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'RANGE'
     AND (NEW."otherPointId" IS NOT NULL OR NEW."minFactor" IS NOT NULL OR NEW."maxFactor" IS NOT NULL
          OR (NEW."minValue" IS NULL AND NEW."maxValue" IS NULL) OR NEW."minValue" < 0 OR NEW."maxValue" <= 0
          OR NEW."minValue" > NEW."maxValue") THEN
    RAISE EXCEPTION 'product: RANGE rule % names one point and at least one value (0 or more, the smallest first), and no factor', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'ORDER' THEN
    SELECT p."uom"::text INTO point_uom FROM "MeasurementPoint" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."pointId";
    SELECT p."uom"::text INTO other_uom FROM "MeasurementPoint" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."otherPointId";
    IF point_uom IS NOT NULL AND other_uom IS NOT NULL AND point_uom <> other_uom THEN
      RAISE EXCEPTION 'product: ORDER rule % compares two points of one unit (% and %)', NEW."id", point_uom, other_uom
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MeasurementRule_check" AFTER INSERT OR UPDATE ON "MeasurementRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_measurement_rule_check"();
CREATE TRIGGER "MeasurementRule_no_truncate" BEFORE TRUNCATE ON "MeasurementRule"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sizes_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- MeasurementTemplate.baseSizeRule (PRD-202): which measures pick the base size. Null: fine; else what is wrong, in words.
CREATE FUNCTION "factory_base_size_rule_problem"(tenant uuid, template uuid, rule jsonb) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  missing text;
BEGIN
  IF jsonb_typeof(rule) <> 'object' THEN
    RETURN 'is an object {"points": ["chest"], "tie": "LARGER"}';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(rule) AS k(name) WHERE k.name NOT IN ('points', 'tie')) THEN
    RETURN 'has only "points" and "tie"';
  END IF;
  IF jsonb_typeof(rule -> 'points') IS DISTINCT FROM 'array' OR jsonb_array_length(rule -> 'points') NOT BETWEEN 1 AND 10
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(rule -> 'points') AS e(value) WHERE jsonb_typeof(e.value) <> 'string') THEN
    RETURN 'names 1 to 10 point codes in "points"';
  END IF;
  IF (SELECT count(DISTINCT e.code) <> count(*) FROM jsonb_array_elements_text(rule -> 'points') AS e(code)) THEN
    RETURN 'names each point once';
  END IF;
  SELECT e.code INTO missing FROM jsonb_array_elements_text(rule -> 'points') AS e(code)
    WHERE NOT EXISTS (SELECT 1 FROM "MeasurementPoint" p WHERE p."tenantId" = tenant AND p."templateId" = template AND p."code" = e.code)
    LIMIT 1;
  IF missing IS NOT NULL THEN
    RETURN format('names %s, which is not a point of the template', missing);
  END IF;
  IF rule ? 'tie' AND (jsonb_typeof(rule -> 'tie') <> 'string' OR rule ->> 'tie' NOT IN ('LARGER', 'SMALLER')) THEN
    RETURN 'breaks a tie with "LARGER" or "SMALLER"';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_measurement_template_rule_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text;
BEGIN
  IF NEW."baseSizeRule" IS NULL OR (TG_OP = 'UPDATE' AND NEW."baseSizeRule" IS NOT DISTINCT FROM OLD."baseSizeRule") THEN
    RETURN NULL;
  END IF;
  problem := "factory_base_size_rule_problem"(NEW."tenantId", NEW."id", NEW."baseSizeRule");
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'product: the base size rule of measurement template % %', NEW."id", problem
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MeasurementTemplate_base_size_rule" AFTER INSERT OR UPDATE OF "baseSizeRule" ON "MeasurementTemplate"
  FOR EACH ROW EXECUTE FUNCTION "factory_measurement_template_rule_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- BomLine (PRD-204): a made-to-measure unit's quantity follows one measure of the style's template.
CREATE FUNCTION "factory_bom_line_mtm_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  style_template uuid;
  style_found boolean;
  point_template uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."mtmScalePointId", NEW."mtmScaleFactor") IS NOT DISTINCT FROM (OLD."mtmScalePointId", OLD."mtmScaleFactor") THEN
    RETURN NULL;
  END IF;
  IF (NEW."mtmScalePointId" IS NULL) <> (NEW."mtmScaleFactor" IS NULL) THEN
    RAISE EXCEPTION 'product: BOM line % names its made-to-measure point with its factor, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."mtmScaleFactor" <= 0 OR NEW."mtmScaleFactor" > 10 THEN
    RAISE EXCEPTION 'product: the made-to-measure factor of BOM line % is above 0 and at most 10', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."mtmScalePointId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."mtmScalePointId" IS DISTINCT FROM OLD."mtmScalePointId") THEN
    SELECT true, s."measurementTemplateId" INTO style_found, style_template FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    SELECT p."templateId" INTO point_template FROM "MeasurementPoint" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."mtmScalePointId";
    IF coalesce(style_found, false) AND point_template IS NOT NULL AND point_template IS DISTINCT FROM style_template THEN
      RAISE EXCEPTION 'product: the made-to-measure point of BOM line % is a point of its style''s measurement template', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "BomLine_mtm_scale" AFTER INSERT OR UPDATE OF "mtmScalePointId", "mtmScaleFactor" ON "BomLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_bom_line_mtm_check"();
