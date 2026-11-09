-- Written by hand (Prisma does not model triggers), after the generated …_styles_libraries_w2b_schema and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Styles and libraries in depth (W2b-4, schema wave 26/33, B-W2b-206; features PRD-006, PRD-007, PRD-008, PRD-010, PRD-016,
-- PRD-019, PRD-029, PRD-035, PRD-041, PRD-045, PRD-105, PRD-182, PRD-218). apps/factory-api's modules/product checks all of
-- this first and says it in words (B-W2b-221, -227, -236, -237, -238, -239, -247); these rules hold for every login, the owner
-- included. Every refusal is a check_violation, a write to frozen data a restrict_violation. The new triggers are AFTER
-- triggers (the policies speak first), except Style's, which fills the time a lifecycle moved (BEFORE). A rule that reads
-- another row of a table the session cannot read, or a row it cannot see, skips it (the policies and references hold the
-- tenant). No W1 or W2 function is redefined here: Style, Item, Colour, Variant, BomLine and StyleRevision get triggers of
-- their own beside the ones they have.

-- =====================================================================================================================
-- Data: the rows made before this wave (the triggers below are created after these statements, so they do not fire).

-- 1. Styles: their lifecycle from what they are (the record state `status` stays as it is): ARCHIVED → DISCONTINUED; with a
--    RELEASED revision → IN_PRODUCTION; else DEVELOPMENT. lifecycleChangedAt and ById stay null (not moved since W2b-4).
UPDATE "Style" s
   SET "lifecycle" = CASE
         WHEN s."status" = 'ARCHIVED' THEN 'DISCONTINUED'::"StyleLifecycle"
         WHEN EXISTS (SELECT 1 FROM "StyleRevision" r WHERE r."tenantId" = s."tenantId" AND r."styleId" = s."id" AND r."status" = 'RELEASED')
           THEN 'IN_PRODUCTION'::"StyleLifecycle"
         ELSE 'DEVELOPMENT'::"StyleLifecycle"
       END
 WHERE s."lifecycle" = 'CONCEPT';

-- 2. Materials: one a released BOM names was approved by that release: APPROVED at the first release of a revision whose BOM
--    names it, by its releaser (null when that release named none). The others stay PENDING.
UPDATE "Item" i
   SET "approval" = 'APPROVED', "approvedAt" = x."releasedAt", "approvedById" = x."releasedById"
  FROM (
    SELECT DISTINCT ON (b."tenantId", b."itemId") b."tenantId", b."itemId", r."releasedAt", r."releasedById"
      FROM "BomLine" b
      JOIN "StyleRevision" r ON r."tenantId" = b."tenantId" AND r."id" = b."revisionId"
     WHERE r."status" IN ('RELEASED', 'OBSOLETE') AND r."releasedAt" IS NOT NULL
     ORDER BY b."tenantId", b."itemId", r."releasedAt", r."id"
  ) x
 WHERE i."tenantId" = x."tenantId" AND i."id" = x."itemId" AND i."approval" = 'PENDING';

-- =====================================================================================================================
-- Shared

CREATE FUNCTION "factory_styles_libraries_w2b_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'product: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- A text a person typed: not blank, at most `max_length` characters, no control characters (null: none, fine).
CREATE FUNCTION "factory_styles_text_ok"(value text, max_length int) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NULL OR (btrim(value) <> '' AND length(value) <= max_length AND value !~ '[[:cntrl:]]')
$$;

-- An array with no NULL and no value twice (null: none, fine).
CREATE FUNCTION "factory_styles_distinct"(list anyarray) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT list IS NULL OR (array_position(list, NULL) IS NULL AND cardinality(list) = (SELECT count(DISTINCT v) FROM unnest(list) AS t(v)))
$$;

-- A decimal string above 0 and at most `max_value`, at most 4 decimals (no float in JSON). The cast only after the pattern.
CREATE FUNCTION "factory_styles_decimal_ok"(value text, max_value numeric) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value ~ '^[0-9]{1,8}(\.[0-9]{1,4})?$' THEN value::numeric > 0 AND value::numeric <= max_value ELSE false END
$$;

-- The revision's state, its row locked FOR SHARE (a release waits for the transaction that edits what it freezes, and an edit
-- after the release sees it released); null when the session cannot see it.
CREATE FUNCTION "factory_styles_revision_state"(p_tenant uuid, p_revision uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  SELECT r."status"::text INTO state FROM "StyleRevision" r WHERE r."tenantId" = p_tenant AND r."id" = p_revision FOR SHARE;
  RETURN state;
END
$$;

-- =====================================================================================================================
-- Style (PRD-007 lifecycle, PRD-008 product type, PRD-010 private label; B-W2b-190's replacement)
--   UPDATE     the lifecycle moves with its time: the writer's (never before the last move), else the transaction's; the time
--              and the mover change only with the lifecycle; a move to IN_PRODUCTION needs a RELEASED revision of the style
--              ("Only a released revision can be ordered and produced"). Which moves a person may make, and when, is the
--              product module's (B-W2b-221); an INSERT may start in any state (a copy, an import).
--   every row  the replacing style is another style, named only while PHASE_OUT or DISCONTINUED; sold under our name only
--              with a brand (brandPartyId).
--   product type, when set or changed, or the style's product type or company changes: the type's kind of garment is the
--              style's; a company's type only for that company's styles (a tenant-wide type for any); an archived type is not
--              given to a style.
CREATE FUNCTION "factory_style_depth_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  profile record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."lifecycle" IS DISTINCT FROM OLD."lifecycle" THEN
      IF NEW."lifecycleChangedAt" IS NOT DISTINCT FROM OLD."lifecycleChangedAt" THEN
        NEW."lifecycleChangedAt" := now();
      ELSIF NEW."lifecycleChangedAt" IS NULL OR NEW."lifecycleChangedAt" < OLD."lifecycleChangedAt" THEN
        RAISE EXCEPTION 'product: style % moved to % at a time on or after its last move (%)', NEW."id", NEW."lifecycle", OLD."lifecycleChangedAt"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."lifecycle" = 'IN_PRODUCTION' AND NOT EXISTS (
        SELECT 1 FROM "StyleRevision" r WHERE r."tenantId" = NEW."tenantId" AND r."styleId" = NEW."id" AND r."status" = 'RELEASED'
      ) THEN
        RAISE EXCEPTION 'product: style % goes into production only with a released revision (only a released revision can be ordered and produced)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF (NEW."lifecycleChangedAt", NEW."lifecycleChangedById") IS DISTINCT FROM (OLD."lifecycleChangedAt", OLD."lifecycleChangedById") THEN
      RAISE EXCEPTION 'product: when and by whom style % last moved in its lifecycle change only with a move', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."replacedById" IS NOT NULL THEN
    IF NEW."replacedById" = NEW."id" THEN
      RAISE EXCEPTION 'product: style % is not replaced by itself', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."lifecycle" NOT IN ('PHASE_OUT', 'DISCONTINUED') THEN
      RAISE EXCEPTION 'product: style % names the style that replaces it only while it is phased out or discontinued, not %', NEW."id", NEW."lifecycle"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."soldUnderOurName" AND NEW."brandPartyId" IS NULL THEN
    RAISE EXCEPTION 'product: style % is sold under our name only as a brand''s private-label style (name its brand)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."productTypeProfileId" IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR (NEW."productTypeProfileId", NEW."productType", NEW."companyId") IS DISTINCT FROM (OLD."productTypeProfileId", OLD."productType", OLD."companyId")) THEN
    SELECT p."productType"::text AS kind, p."companyId" AS company, p."status"::text AS status INTO profile
      FROM "ProductTypeProfile" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."productTypeProfileId";
    IF FOUND THEN
      IF profile.kind <> NEW."productType"::text THEN
        RAISE EXCEPTION 'product: style % is a %, so its product type is one of that kind, not of %', NEW."id", NEW."productType", profile.kind
          USING ERRCODE = 'check_violation';
      END IF;
      IF profile.company IS NOT NULL AND profile.company IS DISTINCT FROM NEW."companyId" THEN
        RAISE EXCEPTION 'product: the product type of style % is of its company or tenant-wide', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF profile.status <> 'ACTIVE' AND (TG_OP = 'INSERT' OR NEW."productTypeProfileId" IS DISTINCT FROM OLD."productTypeProfileId") THEN
        RAISE EXCEPTION 'product: product type % is archived: it is given to no style', NEW."productTypeProfileId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Style_w2b4_depth" BEFORE INSERT OR UPDATE OF "lifecycle", "lifecycleChangedAt", "lifecycleChangedById", "replacedById", "soldUnderOurName", "brandPartyId", "productTypeProfileId", "productType", "companyId" ON "Style"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_depth_guard"();

-- =====================================================================================================================
-- Variant (PRD-006): its GTIN
--   when set or changed  a GTIN-8, GTIN-13 or GTIN-14 in its shortest form (as apps/factory-api's parseGtin writes it: a
--                        12-digit UPC as 13 digits, a GTIN-14 or -13 with the zeros a shorter one drops removed), not all
--                        zeros, ending with its check digit. Unique in the tenant: W1's unique key.
--   UPDATE               once garments of the SKU have shipped (a shipment line of its colourway and size, the shipment out),
--                        its GTIN never changes or clears: their labels carry it, and no other SKU may ever be given it. A SKU
--                        that shipped without one may be given one.
CREATE FUNCTION "factory_gtin_problem"(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  n int;
  total int := 0;
BEGIN
  IF value IS NULL THEN
    RETURN NULL;
  END IF;
  IF value !~ '^([0-9]{8}|[0-9]{13}|[0-9]{14})$' THEN
    RETURN 'is 8, 13 or 14 digits';
  END IF;
  IF value ~ '^0+$' THEN
    RETURN 'is not all zeros';
  END IF;
  n := length(value);
  IF (n = 13 AND value LIKE '00000%') OR (n = 14 AND value LIKE '0%') THEN
    RETURN 'is written without the leading zeros a shorter GTIN drops';
  END IF;
  -- The check digit (GS1): from the digit before it leftwards, weights 3, 1, 3, 1 …
  FOR i IN 1 .. n - 1 LOOP
    total := total + substr(value, n - i, 1)::int * CASE WHEN i % 2 = 1 THEN 3 ELSE 1 END;
  END LOOP;
  IF (10 - total % 10) % 10 <> substr(value, n, 1)::int THEN
    RETURN 'ends with its check digit';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_variant_gtin_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text;
BEGIN
  IF NEW."gtin" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."gtin" IS DISTINCT FROM OLD."gtin") THEN
    problem := "factory_gtin_problem"(NEW."gtin");
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'product: the GTIN % of SKU % %', NEW."gtin", NEW."sku", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."gtin" IS NOT NULL AND NEW."gtin" IS DISTINCT FROM OLD."gtin" AND EXISTS (
    SELECT 1
      FROM "WorkOrderSize" w
      JOIN "ShipmentLine" l ON l."tenantId" = w."tenantId" AND l."workOrderSizeId" = w."id"
      JOIN "Shipment" s ON s."tenantId" = l."tenantId" AND s."id" = l."shipmentId"
     WHERE w."tenantId" = OLD."tenantId" AND w."styleId" = OLD."styleId" AND w."colourwayId" = OLD."colourwayId" AND w."size" = OLD."size"
       AND s."shippedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'product: SKU % keeps its GTIN %: garments with it have shipped, and a GTIN is never given to anything else', OLD."sku", OLD."gtin"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Variant_gtin_guard" AFTER INSERT OR UPDATE OF "gtin" ON "Variant"
  FOR EACH ROW EXECUTE FUNCTION "factory_variant_gtin_guard"();

-- =====================================================================================================================
-- Colour (PRD-041): its system and reference
--   every row  a reference only with its system, and one for PANTONE, RAL and NCS (OWN: our own swatch, a reference of our
--              own optional); the reference and the family 1 to 40 characters, no control characters.
CREATE FUNCTION "factory_colour_system_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."reference" IS NOT NULL AND NEW."system" IS NULL THEN
    RAISE EXCEPTION 'product: colour % has a reference only with the colour system it is in', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."system" IN ('PANTONE', 'RAL', 'NCS') AND NEW."reference" IS NULL THEN
    RAISE EXCEPTION 'product: colour % names its % reference', NEW."code", NEW."system"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."reference", 40) OR NOT "factory_styles_text_ok"(NEW."family", 40) THEN
    RAISE EXCEPTION 'product: the reference and family of colour % have 1 to 40 characters each', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Colour_system_check" AFTER INSERT OR UPDATE OF "system", "reference", "family" ON "Colour"
  FOR EACH ROW EXECUTE FUNCTION "factory_colour_system_check"();

-- =====================================================================================================================
-- Item (PRD-035 approval, PRD-029 properties)
--   every row  decided (approvedAt) exactly when not PENDING, PENDING with nobody named; CONDITIONAL and BLOCKED say why
--              (approvalNote, 1 to 1000 characters); the properties typed per kind (factory_item_properties_problem).
--   decision   an insert or a change of the approval to APPROVED, CONDITIONAL or BLOCKED names who decided (approvedById);
--              when and by whom change only with the approval (a material approved by its release before W2b-4 may name
--              nobody).
CREATE FUNCTION "factory_item_properties_problem"(item_kind text, props jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  allowed text[];
  k text;
  v jsonb;
BEGIN
  IF props IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(props) <> 'object' THEN
    RETURN 'are an object of its kind''s properties';
  END IF;
  allowed := CASE
    WHEN item_kind IN ('TEXTILE', 'LINING', 'MEMBRANE', 'PADDING') THEN ARRAY['weightGsm', 'widthCm', 'construction']
    WHEN item_kind = 'PROTECTOR' THEN ARRAY['standard', 'type', 'level', 'size']
    WHEN item_kind IN ('TRIM', 'HARDWARE') THEN ARRAY['material', 'finish', 'size', 'nickelFree']
    ELSE ARRAY[]::text[]
  END;
  FOR k, v IN SELECT e.key, e.value FROM jsonb_each(props) AS e LOOP
    IF NOT (k = ANY (allowed)) THEN
      RETURN format('have no "%s" for a %s material', k, item_kind);
    END IF;
    IF k IN ('weightGsm', 'widthCm') THEN
      IF jsonb_typeof(v) <> 'string' OR NOT "factory_styles_decimal_ok"(v #>> '{}', 99999999) THEN
        RETURN format('give "%s" as a decimal above 0, in a string', k);
      END IF;
    ELSIF k = 'level' THEN
      IF jsonb_typeof(v) <> 'string' OR (v #>> '{}') NOT IN ('1', '2') THEN
        RETURN 'give "level" as "1" or "2" (EN 1621)';
      END IF;
    ELSIF k = 'nickelFree' THEN
      IF jsonb_typeof(v) <> 'boolean' THEN
        RETURN 'give "nickelFree" as true or false';
      END IF;
    ELSIF jsonb_typeof(v) <> 'string' OR NOT "factory_styles_text_ok"(v #>> '{}', 100) THEN
      RETURN format('give "%s" as a text of 1 to 100 characters', k);
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_item_depth_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text;
  decided boolean := TG_OP = 'INSERT' OR NEW."approval" IS DISTINCT FROM OLD."approval";
BEGIN
  IF (NEW."approval" = 'PENDING') <> (NEW."approvedAt" IS NULL) OR (NEW."approval" = 'PENDING' AND NEW."approvedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'product: material % is decided (when, by whom) exactly when it is not PENDING', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."approvalNote", 1000) OR (NEW."approval" IN ('CONDITIONAL', 'BLOCKED') AND NEW."approvalNote" IS NULL) THEN
    RAISE EXCEPTION 'product: material % says why it is % (1 to 1000 characters)', NEW."code", NEW."approval"
      USING ERRCODE = 'check_violation';
  END IF;
  IF decided AND NEW."approval" <> 'PENDING' AND NEW."approvedById" IS NULL THEN
    RAISE EXCEPTION 'product: material % names who decided it is %', NEW."code", NEW."approval"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT decided AND (NEW."approvedAt", NEW."approvedById") IS DISTINCT FROM (OLD."approvedAt", OLD."approvedById") THEN
    RAISE EXCEPTION 'product: when and by whom material % was decided change only with its approval', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  problem := "factory_item_properties_problem"(NEW."kind"::text, NEW."properties");
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'product: the properties of material % %', NEW."code", problem
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Item_w2b4_depth" AFTER INSERT OR UPDATE OF "approval", "approvedAt", "approvedById", "approvalNote", "properties", "kind" ON "Item"
  FOR EACH ROW EXECUTE FUNCTION "factory_item_depth_check"();

-- BomLine (PRD-035): a BLOCKED material is refused on a line (a new line, or a line changed to it). A line whose material is
-- blocked later stays (a released BOM is frozen); its revision's release is held (StyleRevision below).
CREATE FUNCTION "factory_bom_line_material_approval"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."itemId" IS NOT DISTINCT FROM OLD."itemId" THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId" AND i."approval" = 'BLOCKED') THEN
    RAISE EXCEPTION 'product: material % is blocked: no BOM line takes it', NEW."itemId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "BomLine_material_approval" AFTER INSERT OR UPDATE OF "itemId" ON "BomLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_bom_line_material_approval"();

-- StyleRevision (PRD-035, design material.cp.approval "a released BOM can't hold a blocked one"): DRAFT → RELEASED is refused
-- while its BOM names a BLOCKED material. Its own trigger: W1's factory_style_revision_guard (as B-W2b-205 redefines it) is
-- untouched.
CREATE FUNCTION "factory_style_revision_blocked_material"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  blocked text;
BEGIN
  IF NEW."status" = 'RELEASED' AND OLD."status" IS DISTINCT FROM 'RELEASED' THEN
    SELECT i."code" INTO blocked
      FROM "BomLine" b JOIN "Item" i ON i."tenantId" = b."tenantId" AND i."id" = b."itemId"
     WHERE b."tenantId" = NEW."tenantId" AND b."revisionId" = NEW."id" AND i."approval" = 'BLOCKED'
     ORDER BY b."seq" LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'product: revision % is not released: its BOM names the blocked material %', NEW."id", blocked
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StyleRevision_blocked_material" AFTER UPDATE OF "status" ON "StyleRevision"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_blocked_material"();

-- =====================================================================================================================
-- StyleText (PRD-019)
--   UPDATE     the style, the language and the creation never change.
--   every row  the language a BCP 47 tag ("it", "en", "de-CH"); the name 1 to 200 characters, the short description 1 to 500,
--              the long one 1 to 10 000 (null: none); no control characters but the long description's line breaks.
CREATE FUNCTION "factory_style_text_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."styleId", NEW."language", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."styleId", OLD."language", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'product: the style and language of text % never change (another language is another row)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."language" !~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$' THEN
    RAISE EXCEPTION 'product: the language of a style''s text is a BCP 47 tag ("it", "en", "de-CH"), not %', NEW."language"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."name", 200) OR NOT "factory_styles_text_ok"(NEW."shortDescription", 500)
     OR (NEW."longDescription" IS NOT NULL AND (btrim(NEW."longDescription") = '' OR length(NEW."longDescription") > 10000
                                               OR NEW."longDescription" ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')) THEN
    RAISE EXCEPTION 'product: the % text of style % has a name of 1 to 200 characters, a short description of up to 500 and a long one of up to 10 000', NEW."language", NEW."styleId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StyleText_check" AFTER INSERT OR UPDATE ON "StyleText"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_text_check"();

-- =====================================================================================================================
-- StyleImage (PRD-016)
--   UPDATE     the style and the creation never change.
--   frozen     a picture of a revision that is not DRAFT (OLD's or NEW's revision): not added, not removed, and nothing but its
--              place (seq) and the main mark changes. The revision row is locked FOR SHARE.
--   every row  the place from 0; the caption 1 to 200 characters; the callouts' shape (factory_style_callouts_problem).
--   file       when set or changed: a picture or a drawing (PHOTO, DOCUMENT or ATTACHMENT) of the style, of one of its
--              colourways or of one of its revisions.
--   At most one main picture per style: the partial unique index below. TRUNCATE refused.
CREATE FUNCTION "factory_style_callouts_problem"(callouts jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  c jsonb;
  k text;
  n int;
  seen int[] := '{}';
BEGIN
  IF callouts IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(callouts) <> 'array' OR jsonb_array_length(callouts) > 60 THEN
    RETURN 'are a list of at most 60 callouts';
  END IF;
  FOR c IN SELECT e.value FROM jsonb_array_elements(callouts) AS e LOOP
    IF jsonb_typeof(c) <> 'object' THEN
      RETURN 'are objects { n, x, y, text }';
    END IF;
    FOR k IN SELECT jsonb_object_keys(c) LOOP
      IF k NOT IN ('n', 'x', 'y', 'text') THEN
        RETURN format('have no "%s"', k);
      END IF;
    END LOOP;
    IF jsonb_typeof(c -> 'n') IS DISTINCT FROM 'number' OR (c ->> 'n') !~ '^[1-9][0-9]{0,2}$' THEN
      RETURN 'are numbered with whole numbers from 1';
    END IF;
    n := (c ->> 'n')::int;
    IF n = ANY (seen) THEN
      RETURN format('number callout %s once', n);
    END IF;
    seen := seen || n;
    IF jsonb_typeof(c -> 'x') IS DISTINCT FROM 'string' OR jsonb_typeof(c -> 'y') IS DISTINCT FROM 'string'
       OR (c ->> 'x') !~ '^(0(\.[0-9]{1,4})?|1(\.0{1,4})?)$' OR (c ->> 'y') !~ '^(0(\.[0-9]{1,4})?|1(\.0{1,4})?)$' THEN
      RETURN format('place callout %s with x and y from "0" to "1" (decimal strings)', n);
    END IF;
    IF jsonb_typeof(c -> 'text') IS DISTINCT FROM 'string' OR NOT "factory_styles_text_ok"(c ->> 'text', 500) THEN
      RETURN format('give callout %s a text of 1 to 500 characters', n);
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_style_image_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rev uuid;
  state text;
  problem text;
  f record;
  frozen_columns text[] := ARRAY['seq', 'isMain', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."revisionId" IS NOT NULL THEN
      state := "factory_styles_revision_state"(OLD."tenantId", OLD."revisionId");
      IF state IS NOT NULL AND state <> 'DRAFT' THEN
        RAISE EXCEPTION 'product: revision % is %; its pictures are kept with it', OLD."revisionId", state
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."styleId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."styleId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: picture % never moves to another style', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  FOREACH rev IN ARRAY ARRAY[CASE WHEN TG_OP = 'UPDATE' THEN OLD."revisionId" END, NEW."revisionId"] LOOP
    CONTINUE WHEN rev IS NULL;
    state := "factory_styles_revision_state"(NEW."tenantId", rev);
    IF state IS NOT NULL AND state <> 'DRAFT'
       AND (TG_OP = 'INSERT' OR (to_jsonb(NEW) - frozen_columns) IS DISTINCT FROM (to_jsonb(OLD) - frozen_columns)) THEN
      RAISE EXCEPTION 'product: revision % is %; its pictures change no more (only their place and the main mark), a change is a new revision', rev, state
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;

  IF NEW."seq" < 0 OR NOT "factory_styles_text_ok"(NEW."caption", 200) THEN
    RAISE EXCEPTION 'product: picture % has a place from 0 and a caption of 1 to 200 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  problem := "factory_style_callouts_problem"(NEW."callouts");
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'product: the callouts of picture % %', NEW."id", problem
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' OR NEW."fileId" IS DISTINCT FROM OLD."fileId" THEN
    SELECT s."recordType", s."recordId", s."kind"::text AS kind INTO f FROM "StoredFile" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."fileId";
    IF FOUND THEN
      IF f.kind NOT IN ('PHOTO', 'DOCUMENT', 'ATTACHMENT') THEN
        RAISE EXCEPTION 'product: picture % is a picture or a drawing (PHOTO, DOCUMENT or ATTACHMENT), not a % file', NEW."id", f.kind
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT ((f."recordType" = 'Style' AND f."recordId" = NEW."styleId")
              OR (f."recordType" = 'Colourway' AND EXISTS (SELECT 1 FROM "Colourway" c WHERE c."tenantId" = NEW."tenantId" AND c."styleId" = NEW."styleId" AND c."id" = f."recordId"))
              OR (f."recordType" = 'StyleRevision' AND EXISTS (SELECT 1 FROM "StyleRevision" r WHERE r."tenantId" = NEW."tenantId" AND r."styleId" = NEW."styleId" AND r."id" = f."recordId"))) THEN
        RAISE EXCEPTION 'product: picture % shows a file of its style, of one of its colourways or of one of its revisions', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StyleImage_guard" AFTER INSERT OR UPDATE OR DELETE ON "StyleImage"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_image_guard"();
CREATE TRIGGER "StyleImage_no_truncate" BEFORE TRUNCATE ON "StyleImage"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_styles_libraries_w2b_refuse_truncate"();

-- One main picture per style (PRD-016: the list's thumbnail). Prisma cannot express a partial unique index. A unique index is
-- checked row by row: the API clears the old main picture before it marks the new one, in one command.
CREATE UNIQUE INDEX "StyleImage_one_main_per_style" ON "StyleImage" ("tenantId", "styleId") WHERE "isMain";

-- =====================================================================================================================
-- StyleRevisionFile (PRD-218)
--   UPDATE     the style, the revision and the creation never change.
--   frozen     a PATTERN or CAD row (OLD's or NEW's kind) of a revision that is not DRAFT is not added, changed or removed: the
--              revision's specification. MARKER and OTHER rows may be, on any revision. The revision row is locked FOR SHARE.
--   every row  the sizes, each once, are codes of the style's range (when set or changed); the note 1 to 500 characters.
--   file       when set or changed: a document, drawing or picture (DOCUMENT, ATTACHMENT or PHOTO) of the revision or of its
--              style. TRUNCATE refused.
CREATE FUNCTION "factory_style_revision_file_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  range text[];
  f record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."kind" IN ('PATTERN', 'CAD') THEN
      state := "factory_styles_revision_state"(OLD."tenantId", OLD."revisionId");
      IF state IS NOT NULL AND state <> 'DRAFT' THEN
        RAISE EXCEPTION 'product: revision % is %; its % files are kept with it', OLD."revisionId", state, OLD."kind"
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."styleId", NEW."revisionId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."styleId", OLD."revisionId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: file row % never moves to another revision', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."kind" IN ('PATTERN', 'CAD') OR (TG_OP = 'UPDATE' AND OLD."kind" IN ('PATTERN', 'CAD')) THEN
    state := "factory_styles_revision_state"(NEW."tenantId", NEW."revisionId");
    IF state IS NOT NULL AND state <> 'DRAFT' THEN
      RAISE EXCEPTION 'product: revision % is %; its pattern and CAD files change no more, a change is a new revision', NEW."revisionId", state
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NOT "factory_styles_distinct"(NEW."sizes") OR NOT "factory_styles_text_ok"(NEW."note", 500) THEN
    RAISE EXCEPTION 'product: file row % names each size once and has a note of 1 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."sizes") > 0 AND (TG_OP = 'INSERT' OR NEW."sizes" IS DISTINCT FROM OLD."sizes") THEN
    SELECT s."sizes" INTO range FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND AND NOT (NEW."sizes" <@ range) THEN
      RAISE EXCEPTION 'product: file row % is for sizes of its style''s range (%), not %', NEW."id", array_to_string(range, ', '), array_to_string(NEW."sizes", ', ')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW."fileId" IS DISTINCT FROM OLD."fileId" THEN
    SELECT s."recordType", s."recordId", s."kind"::text AS kind INTO f FROM "StoredFile" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."fileId";
    IF FOUND AND (f.kind NOT IN ('DOCUMENT', 'ATTACHMENT', 'PHOTO')
                  OR NOT ((f."recordType" = 'StyleRevision' AND f."recordId" = NEW."revisionId") OR (f."recordType" = 'Style' AND f."recordId" = NEW."styleId"))) THEN
      RAISE EXCEPTION 'product: file row % names a document, drawing or picture of its revision or style, not a % file of % %', NEW."id", f.kind, f."recordType", f."recordId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StyleRevisionFile_guard" AFTER INSERT OR UPDATE OR DELETE ON "StyleRevisionFile"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_file_guard"();
CREATE TRIGGER "StyleRevisionFile_no_truncate" BEFORE TRUNCATE ON "StyleRevisionFile"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_styles_libraries_w2b_refuse_truncate"();

-- =====================================================================================================================
-- ProductTypeProfile (PRD-008)
--   UPDATE     the company and the creation never change; the kind of garment changes only while no style and no child type
--              of the type is of another kind.
--   every row  the code 1 to 60 characters without spaces, the name 1 to 200; the required attributes names
--              (`^[a-z][A-Za-z0-9]{0,59}$`), each once, at most 50; the PPE standard 1 to 60 characters, the class 1 to 10.
--   parent     when set or changed (or the kind changes): not itself, of the same kind of garment, of the type's company or
--              tenant-wide (a tenant-wide type's parent tenant-wide), not archived when newly given, and no circle.
--   defaults   each, when set or changed: of the type's company or tenant-wide (a tenant-wide type's tenant-wide); the
--              measurement template of the same kind of garment.
CREATE FUNCTION "factory_product_type_profile_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  ref_company uuid;
  ref_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the company of product type % never changes', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."productType" <> OLD."productType"
       AND (EXISTS (SELECT 1 FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."productTypeProfileId" = NEW."id" AND s."productType" <> NEW."productType")
            OR EXISTS (SELECT 1 FROM "ProductTypeProfile" c WHERE c."tenantId" = NEW."tenantId" AND c."parentId" = NEW."id" AND c."productType" <> NEW."productType")) THEN
      RAISE EXCEPTION 'product: product type % keeps its kind of garment (%): styles or child types of it are of that kind', NEW."code", OLD."productType"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NOT "factory_styles_text_ok"(NEW."code", 60) OR NEW."code" ~ '\s' OR NOT "factory_styles_text_ok"(NEW."name", 200)
     OR NOT "factory_styles_text_ok"(NEW."defaultPpeStandard", 60) OR NOT "factory_styles_text_ok"(NEW."defaultPpeClass", 10) THEN
    RAISE EXCEPTION 'product: product type % has a code of 1 to 60 characters without spaces, a name of 1 to 200, a PPE standard of up to 60 and a class of up to 10', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_distinct"(NEW."requiredAttributes") OR cardinality(NEW."requiredAttributes") > 50
     OR EXISTS (SELECT 1 FROM unnest(NEW."requiredAttributes") AS a(name) WHERE a.name !~ '^[a-z][A-Za-z0-9]{0,59}$') THEN
    RAISE EXCEPTION 'product: product type % names at most 50 required attributes, each once, as names ("gender", "hsCode")', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."parentId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."parentId", NEW."productType") IS DISTINCT FROM (OLD."parentId", OLD."productType")) THEN
    IF NEW."parentId" = NEW."id" THEN
      RAISE EXCEPTION 'product: product type % is not its own parent', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT p."productType"::text AS kind, p."companyId" AS company, p."status"::text AS status, p."code" INTO parent
      FROM "ProductTypeProfile" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."parentId";
    IF FOUND THEN
      IF parent.kind <> NEW."productType"::text THEN
        RAISE EXCEPTION 'product: product type % refines a type of its own kind of garment (%), not %', NEW."code", NEW."productType", parent.kind
          USING ERRCODE = 'check_violation';
      END IF;
      IF parent.company IS NOT NULL AND parent.company IS DISTINCT FROM NEW."companyId" THEN
        RAISE EXCEPTION 'product: the parent of product type % is of its company or tenant-wide', NEW."code"
          USING ERRCODE = 'check_violation';
      END IF;
      IF parent.status <> 'ACTIVE' AND (TG_OP = 'INSERT' OR NEW."parentId" IS DISTINCT FROM OLD."parentId") THEN
        RAISE EXCEPTION 'product: product type % is archived: no type refines it any more', parent.code
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF EXISTS (
      WITH RECURSIVE up(id, "parentId", depth) AS (
        SELECT p."id", p."parentId", 1 FROM "ProductTypeProfile" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."parentId"
        UNION ALL
        SELECT p."id", p."parentId", up.depth + 1 FROM "ProductTypeProfile" p JOIN up ON p."tenantId" = NEW."tenantId" AND p."id" = up."parentId" WHERE up.depth < 100
      )
      SELECT 1 FROM up WHERE up.id = NEW."id"
    ) THEN
      RAISE EXCEPTION 'product: product type % would be its own ancestor (a circle of parents)', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."defaultSizeScaleId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."defaultSizeScaleId" IS DISTINCT FROM OLD."defaultSizeScaleId") THEN
    SELECT s."companyId" INTO ref_company FROM "SizeScale" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."defaultSizeScaleId";
    IF FOUND AND ref_company IS NOT NULL AND ref_company IS DISTINCT FROM NEW."companyId" THEN
      RAISE EXCEPTION 'product: the default size scale of product type % is of its company or tenant-wide', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."labelTemplateId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."labelTemplateId" IS DISTINCT FROM OLD."labelTemplateId") THEN
    SELECT t."companyId" INTO ref_company FROM "LabelTemplate" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."labelTemplateId";
    IF FOUND AND ref_company IS NOT NULL AND ref_company IS DISTINCT FROM NEW."companyId" THEN
      RAISE EXCEPTION 'product: the label template of product type % is of its company or tenant-wide', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."measurementTemplateId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."measurementTemplateId", NEW."productType") IS DISTINCT FROM (OLD."measurementTemplateId", OLD."productType")) THEN
    SELECT m."companyId", m."productType"::text INTO ref_company, ref_kind FROM "MeasurementTemplate" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."measurementTemplateId";
    IF FOUND AND ((ref_company IS NOT NULL AND ref_company IS DISTINCT FROM NEW."companyId") OR ref_kind <> NEW."productType"::text) THEN
      RAISE EXCEPTION 'product: the measurement template of product type % is of its kind of garment and of its company or tenant-wide', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ProductTypeProfile_check" AFTER INSERT OR UPDATE ON "ProductTypeProfile"
  FOR EACH ROW EXECUTE FUNCTION "factory_product_type_profile_check"();
CREATE TRIGGER "ProductTypeProfile_no_truncate" BEFORE TRUNCATE ON "ProductTypeProfile"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_styles_libraries_w2b_refuse_truncate"();

-- =====================================================================================================================
-- GtinRange (PRD-006)
--   every row  the prefix 4 to 12 digits; 0 ≤ first ≤ last < 10^(12 − its digits); first ≤ next ≤ last + 1; the name 1 to 100
--              characters.
--   UPDATE     the company and the creation never change; the next reference never goes back (a number given is never given
--              again); once a number was given (next above first) the prefix and the limits never change.
--   DELETE     refused (archived, never deleted: the numbers it gave stay explained). TRUNCATE refused.
--   Two ranges are not checked against each other: Variant.gtin, unique in the tenant, is what keeps a GTIN on one SKU.
CREATE FUNCTION "factory_gtin_range_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  references_left bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product: GTIN range % is archived, never deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the company of GTIN range % never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."nextReference" < OLD."nextReference" THEN
      RAISE EXCEPTION 'product: the next reference of GTIN range % never goes back (% given): a GTIN is never given twice', OLD."id", OLD."nextReference"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."nextReference" > OLD."firstReference"
       AND (NEW."gs1Prefix", NEW."firstReference", NEW."lastReference") IS DISTINCT FROM (OLD."gs1Prefix", OLD."firstReference", OLD."lastReference") THEN
      RAISE EXCEPTION 'product: GTIN range % has given numbers: its prefix and limits never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."gs1Prefix" !~ '^[0-9]{4,12}$' THEN
    RAISE EXCEPTION 'product: the GS1 company prefix of GTIN range % is 4 to 12 digits, not %', NEW."id", NEW."gs1Prefix"
      USING ERRCODE = 'check_violation';
  END IF;
  references_left := power(10::numeric, 12 - length(NEW."gs1Prefix"))::bigint;
  IF NEW."firstReference" < 0 OR NEW."firstReference" > NEW."lastReference" OR NEW."lastReference" >= references_left
     OR NEW."nextReference" < NEW."firstReference" OR NEW."nextReference"::bigint > NEW."lastReference"::bigint + 1 THEN
    RAISE EXCEPTION 'product: GTIN range % runs from % to % (next %) inside the % item references its prefix leaves', NEW."id", NEW."firstReference", NEW."lastReference", NEW."nextReference", references_left
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."name", 100) THEN
    RAISE EXCEPTION 'product: GTIN range % has a name of 1 to 100 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "GtinRange_guard" AFTER INSERT OR UPDATE OR DELETE ON "GtinRange"
  FOR EACH ROW EXECUTE FUNCTION "factory_gtin_range_guard"();
CREATE TRIGGER "GtinRange_no_truncate" BEFORE TRUNCATE ON "GtinRange"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_styles_libraries_w2b_refuse_truncate"();

-- =====================================================================================================================
-- BrandingSet (PRD-045)
--   UPDATE     the company, the brand and the creation never change.
--   every row  the brand a party with the CUSTOMER or BRAND role (at insert); the code 1 to 60 characters without spaces, the
--              name 1 to 200, the note 1 to 2000; each list without a repeat; the packaging rules' shape
--              (factory_packaging_rules_problem).
--   lists      each file it adds: a file of the set (recordType "BrandingSet", recordId its id), a picture (PHOTO) for a logo,
--              a picture or a document (PHOTO, DOCUMENT, ATTACHMENT) for label artwork; each colour it adds: a colour of the
--              tenant's library; each material a packaging rule names: a material of the library.
--   At most one ACTIVE set per company and brand: the partial unique index below. TRUNCATE refused.
CREATE FUNCTION "factory_packaging_rules_problem"(rules jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  r jsonb;
  k text;
  rule_key text;
  seen text[] := '{}';
  parts int;
BEGIN
  IF rules IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(rules) <> 'array' OR jsonb_array_length(rules) > 50 THEN
    RETURN 'are a list of at most 50 rules';
  END IF;
  FOR r IN SELECT e.value FROM jsonb_array_elements(rules) AS e LOOP
    IF jsonb_typeof(r) <> 'object' THEN
      RETURN 'are objects { key, text, itemId, quantity, per }';
    END IF;
    FOR k IN SELECT jsonb_object_keys(r) LOOP
      IF k NOT IN ('key', 'text', 'itemId', 'quantity', 'per') THEN
        RETURN format('have no "%s"', k);
      END IF;
    END LOOP;
    rule_key := r ->> 'key';
    IF jsonb_typeof(r -> 'key') IS DISTINCT FROM 'string' OR rule_key !~ '^[a-z0-9][a-z0-9-]{0,39}$' THEN
      RETURN 'have each a key of lower-case letters, digits and dashes (1 to 40)';
    END IF;
    IF rule_key = ANY (seen) THEN
      RETURN format('use the key "%s" once', rule_key);
    END IF;
    seen := seen || rule_key;
    IF jsonb_typeof(r -> 'text') IS DISTINCT FROM 'string' OR NOT "factory_styles_text_ok"(r ->> 'text', 500) THEN
      RETURN format('give rule "%s" a text of 1 to 500 characters', rule_key);
    END IF;
    parts := (CASE WHEN r ? 'itemId' THEN 1 ELSE 0 END) + (CASE WHEN r ? 'quantity' THEN 1 ELSE 0 END) + (CASE WHEN r ? 'per' THEN 1 ELSE 0 END);
    IF parts NOT IN (0, 3) THEN
      RETURN format('give rule "%s" a material, a quantity and what it is per, all three or none', rule_key);
    END IF;
    IF parts = 3 AND (jsonb_typeof(r -> 'itemId') IS DISTINCT FROM 'string'
                      OR (r ->> 'itemId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      OR jsonb_typeof(r -> 'quantity') IS DISTINCT FROM 'string' OR NOT "factory_styles_decimal_ok"(r ->> 'quantity', 99999999)
                      OR jsonb_typeof(r -> 'per') IS DISTINCT FROM 'string' OR (r ->> 'per') NOT IN ('GARMENT', 'PACK', 'CARTON')) THEN
      RETURN format('give rule "%s" a material id, a quantity above 0 (a decimal string) and GARMENT, PACK or CARTON', rule_key);
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_branding_set_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text;
  file_id uuid;
  colour_id uuid;
  f record;
  item_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."partyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the company and brand of branding set % never change', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId" AND NOT ('CUSTOMER' = ANY (p."roles") OR 'BRAND' = ANY (p."roles"))
  ) THEN
    RAISE EXCEPTION 'product: branding set % is of a brand: a party with the CUSTOMER or BRAND role', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."code", 60) OR NEW."code" ~ '\s' OR NOT "factory_styles_text_ok"(NEW."name", 200)
     OR (NEW."note" IS NOT NULL AND (btrim(NEW."note") = '' OR length(NEW."note") > 2000)) THEN
    RAISE EXCEPTION 'product: branding set % has a code of 1 to 60 characters without spaces, a name of 1 to 200 and a note of up to 2000', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_distinct"(NEW."logoFileIds") OR NOT "factory_styles_distinct"(NEW."labelArtworkFileIds") OR NOT "factory_styles_distinct"(NEW."brandColourIds") THEN
    RAISE EXCEPTION 'product: branding set % names each logo, artwork file and colour once', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  problem := "factory_packaging_rules_problem"(NEW."packagingRules");
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'product: the packaging rules of branding set % %', NEW."code", problem
      USING ERRCODE = 'check_violation';
  END IF;

  -- The files and colours this write adds (one kept was checked when it was added).
  FOREACH file_id IN ARRAY coalesce(NEW."logoFileIds", '{}') || coalesce(NEW."labelArtworkFileIds", '{}') LOOP
    CONTINUE WHEN TG_OP = 'UPDATE' AND (file_id = ANY (coalesce(OLD."logoFileIds", '{}')) AND file_id = ANY (coalesce(NEW."logoFileIds", '{}'))
                                        OR file_id = ANY (coalesce(OLD."labelArtworkFileIds", '{}')) AND file_id = ANY (coalesce(NEW."labelArtworkFileIds", '{}')));
    SELECT s."recordType", s."recordId", s."kind"::text AS kind INTO f FROM "StoredFile" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = file_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'product: branding set % names its own files (recordType BrandingSet); % is no file', NEW."code", file_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF f."recordType" <> 'BrandingSet' OR f."recordId" <> NEW."id" THEN
      RAISE EXCEPTION 'product: branding set % names its own files (recordType BrandingSet); % is not one', NEW."code", file_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (file_id = ANY (coalesce(NEW."logoFileIds", '{}')) AND f.kind <> 'PHOTO') OR f.kind NOT IN ('PHOTO', 'DOCUMENT', 'ATTACHMENT') THEN
      RAISE EXCEPTION 'product: a logo of branding set % is a picture (PHOTO), its label artwork a picture or a document; file % is a % file', NEW."code", file_id, f.kind
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  FOREACH colour_id IN ARRAY coalesce(NEW."brandColourIds", '{}') LOOP
    CONTINUE WHEN TG_OP = 'UPDATE' AND colour_id = ANY (coalesce(OLD."brandColourIds", '{}'));
    IF NOT EXISTS (SELECT 1 FROM "Colour" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = colour_id) THEN
      RAISE EXCEPTION 'product: the brand colours of branding set % are colours of the library; % is not one', NEW."code", colour_id
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF NEW."packagingRules" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."packagingRules" IS DISTINCT FROM OLD."packagingRules") THEN
    FOR item_id IN SELECT (e.value ->> 'itemId')::uuid FROM jsonb_array_elements(NEW."packagingRules") AS e WHERE e.value ? 'itemId' LOOP
      IF NOT EXISTS (SELECT 1 FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = item_id) THEN
        RAISE EXCEPTION 'product: a packaging rule of branding set % names material %, which is not in the library', NEW."code", item_id
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "BrandingSet_check" AFTER INSERT OR UPDATE ON "BrandingSet"
  FOR EACH ROW EXECUTE FUNCTION "factory_branding_set_check"();
CREATE TRIGGER "BrandingSet_no_truncate" BEFORE TRUNCATE ON "BrandingSet"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_styles_libraries_w2b_refuse_truncate"();

-- One active branding set per company and brand (design products.colours › Branding sets: per private-label customer). Prisma
-- cannot express a partial unique index. A new set replaces an old one: archive the old first, in one command.
CREATE UNIQUE INDEX "BrandingSet_one_active_per_brand" ON "BrandingSet" ("tenantId", "companyId", "partyId") WHERE "status" = 'ACTIVE';

-- =====================================================================================================================
-- ProductSettings (PRD-182, PRD-105)
--   UPDATE     the company and the creation never change.
--   every row  a percent exactly with WARN_ABOVE, above 0 and at most 100; the per-kind rules' shape: { "<ItemKind>": { "rule":
--              MATCH | MAY_DIFFER | WARN_ABOVE, "percent": "<decimal above 0, at most 100>" exactly with WARN_ABOVE } }.
--   TRUNCATE refused.
CREATE FUNCTION "factory_product_settings_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k text;
  v jsonb;
  ok boolean;
  kinds text[] := ARRAY(SELECT e::text FROM unnest(enum_range(NULL::"ItemKind")) AS e);
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'product: the company of product settings % never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."consumptionTolerance" IS NOT DISTINCT FROM 'WARN_ABOVE') <> (NEW."consumptionTolerancePct" IS NOT NULL)
     OR NEW."consumptionTolerancePct" <= 0 OR NEW."consumptionTolerancePct" > 100 THEN
    RAISE EXCEPTION 'product: product settings % have a tolerance percent exactly with WARN_ABOVE, above 0 and at most 100', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."consumptionToleranceByKind" IS NOT NULL THEN
    IF jsonb_typeof(NEW."consumptionToleranceByKind") <> 'object' THEN
      RAISE EXCEPTION 'product: the tolerance per material kind of product settings % is an object of kinds', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    FOR k, v IN SELECT e.key, e.value FROM jsonb_each(NEW."consumptionToleranceByKind") AS e LOOP
      ok := k = ANY (kinds) AND jsonb_typeof(v) = 'object';
      IF ok THEN
        ok := NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v) AS x(name) WHERE x.name NOT IN ('rule', 'percent'))
              AND jsonb_typeof(v -> 'rule') IS NOT DISTINCT FROM 'string' AND (v ->> 'rule') IN ('MATCH', 'MAY_DIFFER', 'WARN_ABOVE')
              AND ((v ->> 'rule') = 'WARN_ABOVE') = (v ? 'percent')
              AND (NOT (v ? 'percent') OR (jsonb_typeof(v -> 'percent') = 'string' AND "factory_styles_decimal_ok"(v ->> 'percent', 100)));
      END IF;
      IF NOT ok THEN
        RAISE EXCEPTION 'product: the tolerance of product settings % for "%" is { "rule": MATCH | MAY_DIFFER | WARN_ABOVE, "percent": a decimal string above 0 and at most 100 exactly with WARN_ABOVE } of a material kind', NEW."id", k
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ProductSettings_check" AFTER INSERT OR UPDATE ON "ProductSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_product_settings_check"();
CREATE TRIGGER "ProductSettings_no_truncate" BEFORE TRUNCATE ON "ProductSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_styles_libraries_w2b_refuse_truncate"();
