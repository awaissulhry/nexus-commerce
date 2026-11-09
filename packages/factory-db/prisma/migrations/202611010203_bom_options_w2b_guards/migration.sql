-- Written by hand (Prisma does not model triggers), after the generated …_bom_options_w2b_schema and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- BOM depth and the option library (W2b-4, schema wave 28/33, B-W2b-211; features PRD-077, PRD-078, PRD-081, PRD-083,
-- PRD-084, PRD-088, PRD-099, PRD-106, PRD-108, PRD-206, PRD-207, PRD-208, PRD-211). apps/factory-api's modules/product checks
-- all of this first and says it in words (B-W2b-223 structure, B-W2b-228 lines in depth, B-W2b-229 options); these rules hold
-- for every login, the owner included. Every refusal is a check_violation, a write to frozen data a restrict_violation. The new
-- checks are AFTER triggers (the policies and W1's part rule speak first); an UPDATE that changes nothing passes; a rule that
-- reads a row the session cannot see skips it, unless the row it names must exist (the policies and references hold the
-- tenant). No earlier function is redefined: BomLine, StyleRevision and RoutingOperation get triggers of their own beside the
-- ones they have, and BomLineAlternate takes W1's factory_style_revision_part_guard as it is. Helpers of earlier waves are
-- called as they are: 205's factory_instruction_words_ok (words per language), 206's factory_styles_text_ok,
-- factory_styles_decimal_ok and factory_styles_revision_state. No data copy: every new column is null or its default on the
-- rows made before it (a revision makes 1 PCS, a line is in no section, group, option or kit).

-- =====================================================================================================================
-- Shared

CREATE FUNCTION "factory_bom_options_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'product: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- A code: 1 to `max_length` characters, no spaces, no control characters.
CREATE FUNCTION "factory_bom_options_code_ok"(value text, max_length int) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL AND length(value) BETWEEN 1 AND max_length AND value !~ '[[:space:][:cntrl:]]'
$$;

-- Words a person typed that may hold line breaks and tabs: not blank, at most `max_length` characters, no other control
-- characters (null: none, fine).
CREATE FUNCTION "factory_bom_options_words_ok"(value text, max_length int) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NULL OR (btrim(value) <> '' AND length(value) <= max_length AND value !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')
$$;

-- A regular expression PostgreSQL accepts (null: none, fine).
CREATE FUNCTION "factory_bom_options_regex_ok"(pattern text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF pattern IS NULL THEN
    RETURN true;
  END IF;
  PERFORM '' ~ pattern;
  RETURN true;
EXCEPTION WHEN invalid_regular_expression THEN
  RETURN false;
END
$$;

-- What is wrong with a BOM_ADD effect's quantities per size, in words; null: nothing. 1 to 100 size codes (1 to 40
-- characters without spaces) to decimal strings above 0 (at most 4 decimals).
CREATE FUNCTION "factory_option_size_quantities_problem"(quantities jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry record;
  n int := 0;
BEGIN
  IF quantities IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(quantities) <> 'object' THEN
    RETURN 'are an object of size codes to quantities';
  END IF;
  FOR entry IN SELECT e.key, e.value FROM jsonb_each(quantities) AS e LOOP
    n := n + 1;
    IF NOT "factory_bom_options_code_ok"(entry.key, 40) THEN
      RETURN 'are keyed by size codes of 1 to 40 characters without spaces';
    END IF;
    IF jsonb_typeof(entry.value) <> 'string' OR NOT "factory_styles_decimal_ok"(entry.value #>> '{}', 99999999) THEN
      RETURN format('give size %s a quantity above 0 as a decimal string ("1.2500")', entry.key);
    END IF;
  END LOOP;
  IF n = 0 OR n > 100 THEN
    RETURN 'name 1 to 100 sizes';
  END IF;
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- BomLine (PRD-077, PRD-078, PRD-081, PRD-084, PRD-088, PRD-106): its own trigger beside W1's part rule
-- ("BomLine_revision_guard": written only while the revision is DRAFT), 206's material approval and 210's made-to-measure
-- scale. Each rule runs when its columns are set or changed:
--   group row     the line it is grouped under is another line of the same revision (the reference) and never one grouped
--                 under it (no circle; walked up to 100 lines; the revision's grouping is taken in turns, a transaction
--                 advisory lock per revision).
--   sub-assembly  style and revision both or neither; another style; its revision DRAFT or RELEASED when named (locked FOR
--                 SHARE), never OBSOLETE; the line's material a COMPONENT we make (sourcing MAKE or MAKE_OR_BUY) counted in
--                 PCS, PAIR or SET; no circle: no style is both above the line (its own, and the styles whose revisions use
--                 its revision, walked up) and inside the revision it names (walked down); at most 10 levels from the top
--                 revision that uses it to the deepest part (the tenant's sub-assemblies are taken in turns, a transaction
--                 advisory lock per tenant). Not customer-supplied.
--   customer      a party with the CUSTOMER or BRAND role; never with a supplier (not bought).
--   source key    "<source>:<key>": 2 to 20 lower-case letters, a colon, 1 to 100 characters without spaces.
--   option        an ACTIVE value of a group the line's style offers (an ACTIVE StyleOptionGroup, locked FOR SHARE, so the
--                 offer is not removed or archived under it).
--   material      changed on a line with alternates: no alternate is the new material, and each is checked for the
--                 certificate when the new material is a PPE component.
CREATE FUNCTION "factory_bom_line_structure_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item record;
  state text;
  value_row record;
  circle boolean;
  deepest int;
  highest int;
BEGIN
  -- The group row.
  IF NEW."parentLineId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."parentLineId" IS DISTINCT FROM OLD."parentLineId") THEN
    IF NEW."parentLineId" = NEW."id" THEN
      RAISE EXCEPTION 'product: BOM line % is not grouped under itself', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.bom-group', NEW."tenantId", NEW."revisionId"), 0));
    IF EXISTS (
      WITH RECURSIVE up(id, depth) AS (
        SELECT NEW."parentLineId", 1
        UNION ALL
        SELECT b."parentLineId", up.depth + 1
          FROM up JOIN "BomLine" b ON b."tenantId" = NEW."tenantId" AND b."id" = up.id
         WHERE b."parentLineId" IS NOT NULL AND up.depth < 100
      )
      SELECT 1 FROM up WHERE up.id = NEW."id"
    ) THEN
      RAISE EXCEPTION 'product: BOM line % is not grouped under a line grouped under it (a circle)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The sub-assembly.
  IF (NEW."subAssemblyStyleId" IS NULL) <> (NEW."subAssemblyRevisionId" IS NULL) THEN
    RAISE EXCEPTION 'product: BOM line % names a sub-assembly by its style and its revision, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."subAssemblyRevisionId" IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR (NEW."subAssemblyStyleId", NEW."subAssemblyRevisionId", NEW."itemId", NEW."uom", NEW."customerSuppliedByPartyId")
             IS DISTINCT FROM (OLD."subAssemblyStyleId", OLD."subAssemblyRevisionId", OLD."itemId", OLD."uom", OLD."customerSuppliedByPartyId")) THEN
    IF NEW."subAssemblyStyleId" = NEW."styleId" THEN
      RAISE EXCEPTION 'product: BOM line % names its own style as a sub-assembly (a circle)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."customerSuppliedByPartyId" IS NOT NULL THEN
      RAISE EXCEPTION 'product: BOM line % is a sub-assembly we make, so the customer does not send it', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."uom" NOT IN ('PCS', 'PAIR', 'SET') THEN
      RAISE EXCEPTION 'product: BOM line % counts its sub-assembly in PCS, PAIR or SET, not %', NEW."id", NEW."uom"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."code", i."kind"::text AS kind, i."sourcing"::text AS sourcing INTO item
      FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND (item.kind <> 'COMPONENT' OR item.sourcing = 'BUY') THEN
      RAISE EXCEPTION 'product: the material of sub-assembly line % is a COMPONENT we make (sourcing MAKE or MAKE_OR_BUY), not % (% %)', NEW."id", item.code, item.kind, item.sourcing
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."subAssemblyRevisionId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."subAssemblyRevisionId" IS DISTINCT FROM OLD."subAssemblyRevisionId") THEN
    state := "factory_styles_revision_state"(NEW."tenantId", NEW."subAssemblyRevisionId");
    IF state IS NULL THEN
      RAISE EXCEPTION 'product: BOM line % names a sub-assembly revision % this session cannot see', NEW."id", NEW."subAssemblyRevisionId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF state NOT IN ('DRAFT', 'RELEASED') THEN
      RAISE EXCEPTION 'product: BOM line % names sub-assembly revision %, which is %: name its draft or released revision', NEW."id", NEW."subAssemblyRevisionId", state
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.bom-sub-assembly', NEW."tenantId"), 0));
    -- Down: the revisions inside the one it names (depth 1 = the one it names). Up: the revisions that use this line's
    -- revision (depth 0 = this one). A style on both sides is a style inside its own sub-assemblies.
    WITH RECURSIVE down(revision_id, style_id, depth) AS (
      SELECT r."id", r."styleId", 1 FROM "StyleRevision" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."subAssemblyRevisionId"
      UNION
      SELECT b."subAssemblyRevisionId", b."subAssemblyStyleId", down.depth + 1
        FROM down JOIN "BomLine" b ON b."tenantId" = NEW."tenantId" AND b."revisionId" = down.revision_id
       WHERE b."subAssemblyRevisionId" IS NOT NULL AND down.depth < 10
    ), up(revision_id, style_id, depth) AS (
      SELECT NEW."revisionId", NEW."styleId", 0
      UNION
      SELECT b."revisionId", b."styleId", up.depth + 1
        FROM up JOIN "BomLine" b ON b."tenantId" = NEW."tenantId" AND b."subAssemblyRevisionId" = up.revision_id
       WHERE up.depth < 10
    )
    SELECT EXISTS (SELECT 1 FROM up JOIN down ON down.style_id = up.style_id),
           (SELECT coalesce(max(down.depth), 0) FROM down),
           (SELECT coalesce(max(up.depth), 0) FROM up)
      INTO circle, deepest, highest;
    IF circle THEN
      RAISE EXCEPTION 'product: BOM line % makes a circle: a style would be inside its own sub-assemblies (through sub-assembly revision %)', NEW."id", NEW."subAssemblyRevisionId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF highest + 1 + deepest > 10 THEN
      RAISE EXCEPTION 'product: BOM line % would make a BOM of more than 10 levels (sub-assemblies inside sub-assemblies)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Customer-supplied material.
  IF NEW."customerSuppliedByPartyId" IS NOT NULL THEN
    IF NEW."supplierId" IS NOT NULL THEN
      RAISE EXCEPTION 'product: BOM line % is sent by the customer, so it is not bought: it names no supplier', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (TG_OP = 'INSERT' OR NEW."customerSuppliedByPartyId" IS DISTINCT FROM OLD."customerSuppliedByPartyId") AND EXISTS (
      SELECT 1 FROM "Party" p
       WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."customerSuppliedByPartyId"
         AND NOT ('CUSTOMER' = ANY (p."roles") OR 'BRAND' = ANY (p."roles"))
    ) THEN
      RAISE EXCEPTION 'product: the material of BOM line % is sent by a customer: a party with the CUSTOMER or BRAND role', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The rule that made it.
  IF NEW."sourceKey" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."sourceKey" IS DISTINCT FROM OLD."sourceKey")
     AND NEW."sourceKey" !~ '^[a-z]{2,20}:[^[:space:][:cntrl:]]{1,100}$' THEN
    RAISE EXCEPTION 'product: BOM line % names the rule that made it as "<source>:<key>" ("branding:polybag"), not %', NEW."id", NEW."sourceKey"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The option it is for.
  IF NEW."optionValueId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."optionValueId" IS DISTINCT FROM OLD."optionValueId") THEN
    SELECT v."code", v."groupId", v."status"::text AS status INTO value_row
      FROM "OptionValue" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."optionValueId";
    IF FOUND THEN
      IF value_row.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'product: BOM line % is for option %, which is archived', NEW."id", value_row.code
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM 1 FROM "StyleOptionGroup" o
        WHERE o."tenantId" = NEW."tenantId" AND o."styleId" = NEW."styleId" AND o."groupId" = value_row."groupId" AND o."status" = 'ACTIVE'
        FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'product: BOM line % is for option %, whose group its style does not offer', NEW."id", value_row.code
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- The material changed under its alternates.
  IF TG_OP = 'UPDATE' AND NEW."itemId" IS DISTINCT FROM OLD."itemId" THEN
    IF EXISTS (SELECT 1 FROM "BomLineAlternate" a WHERE a."tenantId" = NEW."tenantId" AND a."bomLineId" = NEW."id" AND a."itemId" = NEW."itemId") THEN
      RAISE EXCEPTION 'product: BOM line % takes a material that is one of its own alternates', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId" AND i."isPpeComponent")
       AND EXISTS (SELECT 1 FROM "BomLineAlternate" a WHERE a."tenantId" = NEW."tenantId" AND a."bomLineId" = NEW."id" AND NOT a."certificateCheck") THEN
      RAISE EXCEPTION 'product: BOM line % takes a PPE component, so each of its alternates needs a certificate check', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "BomLine_w2b4_structure" AFTER INSERT OR UPDATE OF "parentLineId", "subAssemblyStyleId", "subAssemblyRevisionId", "customerSuppliedByPartyId", "supplierId", "sourceKey", "optionValueId", "itemId", "uom" ON "BomLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_bom_line_structure_check"();

-- =====================================================================================================================
-- StyleRevision (PRD-099, PRD-106, PRD-083): its own trigger beside W1's guard (as B-W2b-205 redefines it: a released
-- revision's output is frozen with it), 205's effectivity and 206's blocked material.
--   output    1 to 1000 units of PCS, PAIR or SET (when set or changed).
--   release   DRAFT → RELEASED is refused while a line names a sub-assembly revision that is not RELEASED (no draft part
--             under a released parent; every named revision is locked FOR SHARE, so it is not made obsolete meanwhile), and
--             while an alternate names a BLOCKED material (as 206 holds the lines' own materials).
CREATE FUNCTION "factory_style_revision_bom_depth"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  part record;
  blocked text;
BEGIN
  IF (TG_OP = 'INSERT' OR (NEW."outputQuantity", NEW."outputUom") IS DISTINCT FROM (OLD."outputQuantity", OLD."outputUom"))
     AND (NEW."outputQuantity" NOT BETWEEN 1 AND 1000 OR NEW."outputUom" NOT IN ('PCS', 'PAIR', 'SET')) THEN
    RAISE EXCEPTION 'product: the BOM of revision % makes 1 to 1000 units of PCS, PAIR or SET, not % %', NEW."id", NEW."outputQuantity", NEW."outputUom"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."status" = 'RELEASED' AND OLD."status" IS DISTINCT FROM 'RELEASED' THEN
    PERFORM 1 FROM "StyleRevision" r
      WHERE r."tenantId" = NEW."tenantId"
        AND r."id" IN (SELECT b."subAssemblyRevisionId" FROM "BomLine" b
                        WHERE b."tenantId" = NEW."tenantId" AND b."revisionId" = NEW."id" AND b."subAssemblyRevisionId" IS NOT NULL)
      FOR SHARE;
    SELECT b."seq", s."code" AS style, r."revision", r."status"::text AS status INTO part
      FROM "BomLine" b
      JOIN "StyleRevision" r ON r."tenantId" = b."tenantId" AND r."id" = b."subAssemblyRevisionId"
      JOIN "Style" s ON s."tenantId" = r."tenantId" AND s."id" = r."styleId"
     WHERE b."tenantId" = NEW."tenantId" AND b."revisionId" = NEW."id" AND r."status" <> 'RELEASED'
     ORDER BY b."seq" LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'product: revision % is not released: BOM line % takes sub-assembly % revision %, which is % (no draft part under a released parent: release it, or take its released revision)', NEW."id", part.seq, part.style, part.revision, part.status
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."code" INTO blocked
      FROM "BomLineAlternate" a
      JOIN "BomLine" b ON b."tenantId" = a."tenantId" AND b."id" = a."bomLineId"
      JOIN "Item" i ON i."tenantId" = a."tenantId" AND i."id" = a."itemId"
     WHERE a."tenantId" = NEW."tenantId" AND a."revisionId" = NEW."id" AND i."approval" = 'BLOCKED'
     ORDER BY b."seq", a."priority" LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'product: revision % is not released: an alternate in its BOM is the blocked material %', NEW."id", blocked
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StyleRevision_w2b4_bom_depth" AFTER INSERT OR UPDATE OF "outputQuantity", "outputUom", "status" ON "StyleRevision"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_bom_depth"();

-- =====================================================================================================================
-- BomLineAlternate (PRD-083): a part of the revision under W1's factory_style_revision_part_guard as it is (insert, update,
-- delete only while the revision is DRAFT; the revision row FOR SHARE; never moved to another revision; TRUNCATE refused);
-- removed with its line (the reference's ON DELETE CASCADE). Its shape, AFTER:
--   UPDATE     the line and the creation never change.
--   every row  priority from 1 (unique per line: the key); the quantity, when set, above 0; the note 1 to 500 characters.
--   material   (when set or changed) not the line's own; not BLOCKED.
--   check      a certificate check when the line's material or the alternate is a PPE component (Item.isPpeComponent).
CREATE FUNCTION "factory_bom_line_alternate_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line record;
  alternate record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."bomLineId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."bomLineId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the line and creation of alternate % never change (another line''s alternate is another row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."priority" < 1 THEN
    RAISE EXCEPTION 'product: an alternate''s priority starts at 1 (1 = the first choice after the line''s own material), not %', NEW."priority"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."qty" IS NOT NULL AND NEW."qty" <= 0 THEN
    RAISE EXCEPTION 'product: the quantity of alternate % is above 0 (or none: the line''s)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."note", 500) THEN
    RAISE EXCEPTION 'product: the note of alternate % is 1 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT b."itemId", coalesce(i."isPpeComponent", false) AS ppe INTO line
    FROM "BomLine" b LEFT JOIN "Item" i ON i."tenantId" = b."tenantId" AND i."id" = b."itemId"
   WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."bomLineId";
  SELECT i."code", i."approval"::text AS approval, i."isPpeComponent" AS ppe INTO alternate
    FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
  IF TG_OP = 'INSERT' OR NEW."itemId" IS DISTINCT FROM OLD."itemId" THEN
    IF line."itemId" = NEW."itemId" THEN
      RAISE EXCEPTION 'product: alternate % is another material than its line''s own', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF alternate.approval = 'BLOCKED' THEN
      RAISE EXCEPTION 'product: material % is blocked: it is no alternate', alternate.code
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT NEW."certificateCheck" AND (coalesce(line.ppe, false) OR coalesce(alternate.ppe, false)) THEN
    RAISE EXCEPTION 'product: alternate % is or replaces a PPE component, so it needs a certificate check (the notified body may have to agree)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "BomLineAlternate_revision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BomLineAlternate"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "BomLineAlternate_no_truncate" BEFORE TRUNCATE ON "BomLineAlternate"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "BomLineAlternate_shape" AFTER INSERT OR UPDATE ON "BomLineAlternate"
  FOR EACH ROW EXECUTE FUNCTION "factory_bom_line_alternate_check"();

-- =====================================================================================================================
-- OptionGroup (PRD-206)
--   UPDATE     the company and the creation never change.
--   every row  the code 1 to 60 characters without spaces; the name 1 to 200; the names per language (205's words); the
--              description 1 to 2000 (line breaks allowed); picks: minimum 0 to 100, maximum 1 to 100 and not below the
--              minimum (null: none); SINGLE: maximum 1, minimum 0 or 1.
--   kind       changed to FREE_TEXT: every value takes a free text; to SINGLE: no ACTIVE style offer asks more than 1.
CREATE FUNCTION "factory_option_group_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the company and creation of option group % never change', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_bom_options_code_ok"(NEW."code", 60) THEN
    RAISE EXCEPTION 'product: an option group''s code is 1 to 60 characters without spaces, not %', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."name", 200) OR (NEW."nameI18n" IS NOT NULL AND NOT "factory_instruction_words_ok"(NEW."nameI18n"))
     OR NOT "factory_bom_options_words_ok"(NEW."description", 2000) THEN
    RAISE EXCEPTION 'product: option group % has a name of 1 to 200 characters, names per language ({ "it": "…" }) and a description of up to 2000', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."minPicks" NOT BETWEEN 0 AND 100 OR (NEW."maxPicks" IS NOT NULL AND (NEW."maxPicks" NOT BETWEEN 1 AND 100 OR NEW."maxPicks" < NEW."minPicks"))
     OR (NEW."kind" = 'SINGLE' AND (NEW."maxPicks" IS DISTINCT FROM 1 OR NEW."minPicks" > 1)) THEN
    RAISE EXCEPTION 'product: option group % takes 0 to 100 values at least and 1 to 100 at most, not fewer than at least (a SINGLE group at most 1), not % to %', NEW."code", NEW."minPicks", coalesce(NEW."maxPicks"::text, 'any')
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    IF NEW."kind" = 'FREE_TEXT' AND EXISTS (SELECT 1 FROM "OptionValue" v WHERE v."tenantId" = NEW."tenantId" AND v."groupId" = NEW."id" AND NOT v."freeText") THEN
      RAISE EXCEPTION 'product: option group % becomes FREE_TEXT only when every value of it takes a free text', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'SINGLE' AND EXISTS (
      SELECT 1 FROM "StyleOptionGroup" o WHERE o."tenantId" = NEW."tenantId" AND o."groupId" = NEW."id" AND o."status" = 'ACTIVE' AND (o."maxPicks" > 1 OR o."minPicks" > 1)
    ) THEN
      RAISE EXCEPTION 'product: option group % becomes SINGLE only when no style offers it with more than one value', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OptionGroup_check" AFTER INSERT OR UPDATE ON "OptionGroup"
  FOR EACH ROW EXECUTE FUNCTION "factory_option_group_check"();
CREATE TRIGGER "OptionGroup_no_truncate" BEFORE TRUNCATE ON "OptionGroup"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bom_options_refuse_truncate"();

-- =====================================================================================================================
-- OptionValue (PRD-206, PRD-211)
--   UPDATE     the group and the creation never change.
--   every row  the code 1 to 60 characters without spaces; the name 1 to 200; the names per language; the place from 0.
--   free text  with freeText: the maximum length 1 to 500, the pattern (null: none) 1 to 200 characters, a regular expression
--              PostgreSQL accepts; without it, neither. A value of a FREE_TEXT group takes a free text (the group row FOR
--              SHARE, so its kind does not change under it).
CREATE FUNCTION "factory_option_value_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  group_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."groupId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."groupId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the group and creation of option value % never change', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_bom_options_code_ok"(NEW."code", 60) THEN
    RAISE EXCEPTION 'product: an option value''s code is 1 to 60 characters without spaces, not %', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."name", 200) OR (NEW."nameI18n" IS NOT NULL AND NOT "factory_instruction_words_ok"(NEW."nameI18n")) OR NEW."seq" < 0 THEN
    RAISE EXCEPTION 'product: option value % has a name of 1 to 200 characters, names per language ({ "it": "…" }) and a place from 0', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."freeText" THEN
    IF NEW."freeTextMaxLength" IS NULL OR NEW."freeTextMaxLength" NOT BETWEEN 1 AND 500
       OR (NEW."freeTextPattern" IS NOT NULL AND (length(NEW."freeTextPattern") NOT BETWEEN 1 AND 200 OR NOT "factory_bom_options_regex_ok"(NEW."freeTextPattern"))) THEN
      RAISE EXCEPTION 'product: option value % takes a free text of 1 to 500 characters at most, with a pattern of up to 200 characters that is a regular expression (or none)', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."freeTextMaxLength" IS NOT NULL OR NEW."freeTextPattern" IS NOT NULL THEN
    RAISE EXCEPTION 'product: option value % has a free-text length and pattern only when it takes a free text', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT g."kind"::text INTO group_kind FROM "OptionGroup" g WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."groupId" FOR SHARE;
  IF group_kind = 'FREE_TEXT' AND NOT NEW."freeText" THEN
    RAISE EXCEPTION 'product: option value % is of a FREE_TEXT group, so it takes a free text', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OptionValue_check" AFTER INSERT OR UPDATE ON "OptionValue"
  FOR EACH ROW EXECUTE FUNCTION "factory_option_value_check"();
CREATE TRIGGER "OptionValue_no_truncate" BEFORE TRUNCATE ON "OptionValue"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bom_options_refuse_truncate"();

-- =====================================================================================================================
-- OptionRule (PRD-207)
--   UPDATE     the group and the creation never change.
--   every row  the subject value (when set) is not the other value; a rule about the whole group names a value of another
--              group; the message per language (205's words; null: the API's words).
--   values     (when set or changed) ACTIVE; the other value of the rule group's company or tenant-wide (a tenant-wide
--              group's: tenant-wide).
CREATE FUNCTION "factory_option_rule_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  own_company uuid;
  other record;
  subject_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."groupId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."groupId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the group and creation of option rule % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."valueId" = NEW."otherValueId" THEN
    RAISE EXCEPTION 'product: option rule % is about one value and another, not the same', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."messageI18n" IS NOT NULL AND NOT "factory_instruction_words_ok"(NEW."messageI18n") THEN
    RAISE EXCEPTION 'product: the message of option rule % is words per language ({ "it": "…", "en": "…" })', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT v."code", v."groupId", v."status"::text AS status, g."companyId" AS company INTO other
    FROM "OptionValue" v JOIN "OptionGroup" g ON g."tenantId" = v."tenantId" AND g."id" = v."groupId"
   WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."otherValueId";
  IF FOUND THEN
    IF NEW."valueId" IS NULL AND other."groupId" = NEW."groupId" THEN
      RAISE EXCEPTION 'product: option rule % about its whole group names a value of another group, not %', NEW."id", other.code
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' OR NEW."otherValueId" IS DISTINCT FROM OLD."otherValueId" THEN
      SELECT g."companyId" INTO own_company FROM "OptionGroup" g WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."groupId";
      IF other.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'product: option rule % names %, which is archived', NEW."id", other.code
          USING ERRCODE = 'check_violation';
      END IF;
      IF other.company IS NOT NULL AND other.company IS DISTINCT FROM own_company THEN
        RAISE EXCEPTION 'product: option rule % names % of another company (a value of its group''s company or a tenant-wide one)', NEW."id", other.code
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."valueId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."valueId" IS DISTINCT FROM OLD."valueId") THEN
    SELECT v."status"::text INTO subject_status FROM "OptionValue" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."valueId";
    IF subject_status = 'ARCHIVED' THEN
      RAISE EXCEPTION 'product: option rule % is about a value that is archived', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OptionRule_check" AFTER INSERT OR UPDATE ON "OptionRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_option_rule_check"();
CREATE TRIGGER "OptionRule_no_truncate" BEFORE TRUNCATE ON "OptionRule"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bom_options_refuse_truncate"();

-- =====================================================================================================================
-- OptionEffect (PRD-208, PRD-081)
--   UPDATE     the value and the creation never change.
--   kind       each kind fills its own columns and leaves every other null:
--                BOM_ADD        material (+ colour), unit, a quantity above 0 and/or quantities per size, a section;
--                BOM_REPLACE    the material put in (+ colour) for the target material, another one; a quantity above 0 with
--                               its unit, or neither;
--                BOM_REMOVE     the target material;
--                OPERATION_ADD  the operation, minutes above 0 or none (its standard minutes);
--                MINUTES        minutes not 0, at an operation or none (the garment);
--                PRICE          an amount not 0 with its currency (ISO 4217, three capitals), or a percent from -100 to
--                               1000, not 0: exactly one;
--                CERTIFICATE    the note (why).
--              A colour only with a material; the note 1 to 1000 characters.
--   names      (when set or changed) the material put in not BLOCKED; materials and the operation of the group's company or
--              tenant-wide (a tenant-wide group's: tenant-wide).
CREATE FUNCTION "factory_option_effect_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k text := NEW."kind"::text;
  own_company uuid;
  problem text;
  named record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."valueId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."valueId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the value and creation of option effect % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (k IN ('BOM_ADD', 'BOM_REPLACE')) <> (NEW."itemId" IS NOT NULL)
     OR (k IN ('BOM_REPLACE', 'BOM_REMOVE')) <> (NEW."targetItemId" IS NOT NULL)
     OR (NEW."itemColourId" IS NOT NULL AND NEW."itemId" IS NULL)
     OR (k NOT IN ('BOM_ADD', 'BOM_REPLACE') AND (NEW."qty" IS NOT NULL OR NEW."uom" IS NOT NULL))
     OR (k <> 'BOM_ADD' AND (NEW."sizeQuantities" IS NOT NULL OR NEW."section" IS NOT NULL))
     OR (k = 'OPERATION_ADD' AND NEW."operationId" IS NULL)
     OR (k NOT IN ('OPERATION_ADD', 'MINUTES') AND (NEW."operationId" IS NOT NULL OR NEW."minutes" IS NOT NULL))
     OR (k <> 'PRICE' AND (NEW."priceDelta" IS NOT NULL OR NEW."currency" IS NOT NULL OR NEW."pricePct" IS NOT NULL)) THEN
    RAISE EXCEPTION 'product: an option effect of kind % fills its own columns and no other (BOM_ADD: material, unit, quantity; BOM_REPLACE: material and target; BOM_REMOVE: target; OPERATION_ADD: operation; MINUTES: minutes; PRICE: an amount or a percent; CERTIFICATE: the note)', k
      USING ERRCODE = 'check_violation';
  END IF;

  IF k = 'BOM_ADD' THEN
    IF NEW."uom" IS NULL OR (NEW."qty" IS NULL AND NEW."sizeQuantities" IS NULL) OR NEW."qty" <= 0 THEN
      RAISE EXCEPTION 'product: option effect % adds a material with its unit and a quantity above 0, per garment or per size', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    problem := "factory_option_size_quantities_problem"(NEW."sizeQuantities");
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'product: the quantities per size of option effect % %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF k = 'BOM_REPLACE' THEN
    IF NEW."itemId" = NEW."targetItemId" OR (NEW."qty" IS NULL) <> (NEW."uom" IS NULL) OR NEW."qty" <= 0 THEN
      RAISE EXCEPTION 'product: option effect % puts another material in place of its target, with a quantity above 0 and its unit, or neither (the replaced line''s)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF k = 'OPERATION_ADD' THEN
    IF NEW."minutes" <= 0 THEN
      RAISE EXCEPTION 'product: option effect % adds an operation of minutes above 0 (or none: its standard minutes)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF k = 'MINUTES' THEN
    IF NEW."minutes" IS NULL OR NEW."minutes" = 0 THEN
      RAISE EXCEPTION 'product: option effect % adds or takes away minutes (not 0)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF k = 'PRICE' THEN
    IF (NEW."priceDelta" IS NULL) = (NEW."pricePct" IS NULL)
       OR (NEW."priceDelta" IS NOT NULL AND (NEW."priceDelta" = 0 OR NEW."currency" IS NULL OR NEW."currency" !~ '^[A-Z]{3}$'))
       OR (NEW."priceDelta" IS NULL AND NEW."currency" IS NOT NULL)
       OR (NEW."pricePct" IS NOT NULL AND (NEW."pricePct" = 0 OR NEW."pricePct" NOT BETWEEN -100 AND 1000)) THEN
      RAISE EXCEPTION 'product: option effect % moves the price by an amount (not 0) in its currency, or by a percent from -100 to 1000 (not 0): exactly one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF k = 'CERTIFICATE' THEN
    IF NEW."note" IS NULL THEN
      RAISE EXCEPTION 'product: option effect % says in its note what the certificate no longer covers', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."note", 1000) THEN
    RAISE EXCEPTION 'product: the note of option effect % is 1 to 1000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' OR (NEW."itemId", NEW."targetItemId", NEW."operationId") IS DISTINCT FROM (OLD."itemId", OLD."targetItemId", OLD."operationId") THEN
    SELECT g."companyId" INTO own_company
      FROM "OptionValue" v JOIN "OptionGroup" g ON g."tenantId" = v."tenantId" AND g."id" = v."groupId"
     WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."valueId";
    IF NEW."itemId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."itemId" IS DISTINCT FROM OLD."itemId") THEN
      SELECT i."code", i."companyId" AS company, i."approval"::text AS approval INTO named FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
      IF named.approval = 'BLOCKED' THEN
        RAISE EXCEPTION 'product: material % is blocked: no option puts it in', named.code
          USING ERRCODE = 'check_violation';
      END IF;
      IF named.company IS NOT NULL AND named.company IS DISTINCT FROM own_company THEN
        RAISE EXCEPTION 'product: option effect % names material % of another company (its group''s company or a tenant-wide one)', NEW."id", named.code
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."targetItemId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."targetItemId" IS DISTINCT FROM OLD."targetItemId") THEN
      SELECT i."code", i."companyId" AS company INTO named FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."targetItemId";
      IF named.company IS NOT NULL AND named.company IS DISTINCT FROM own_company THEN
        RAISE EXCEPTION 'product: option effect % names material % of another company (its group''s company or a tenant-wide one)', NEW."id", named.code
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."operationId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."operationId" IS DISTINCT FROM OLD."operationId") THEN
      SELECT o."code", o."companyId" AS company INTO named FROM "Operation" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."operationId";
      IF named.company IS NOT NULL AND named.company IS DISTINCT FROM own_company THEN
        RAISE EXCEPTION 'product: option effect % names operation % of another company (its group''s company or a tenant-wide one)', NEW."id", named.code
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OptionEffect_check" AFTER INSERT OR UPDATE ON "OptionEffect"
  FOR EACH ROW EXECUTE FUNCTION "factory_option_effect_check"();
CREATE TRIGGER "OptionEffect_no_truncate" BEFORE TRUNCATE ON "OptionEffect"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bom_options_refuse_truncate"();

-- =====================================================================================================================
-- StyleOptionGroup (PRD-206)
--   UPDATE     the style, the group and the creation never change.
--   every row  the place from 0; the style's own picks (null: the group's): minimum 0 to 100, maximum 1 to 100 and not below
--              the minimum, at most 1 each for a SINGLE group (the group row FOR SHARE, so its kind does not change under
--              it).
--   insert     a company's group only on that company's styles (a tenant-wide group on any style).
--   ACTIVE     (inserted or made ACTIVE) the group is ACTIVE; one ACTIVE offer per style and group (the partial unique index
--              below).
--   default    (when set or changed) an ACTIVE value; the reference keeps it a value of the group.
--   DELETE     refused while a BOM line or a routing step of the style is for one of the group's values: archive it.
CREATE FUNCTION "factory_style_option_group_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  grp record;
  style_company uuid;
  value_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM "BomLine" b JOIN "OptionValue" v ON v."tenantId" = b."tenantId" AND v."id" = b."optionValueId"
       WHERE b."tenantId" = OLD."tenantId" AND b."styleId" = OLD."styleId" AND v."groupId" = OLD."groupId"
    ) OR EXISTS (
      SELECT 1 FROM "RoutingOperation" r
       WHERE r."tenantId" = OLD."tenantId" AND r."styleId" = OLD."styleId" AND cardinality(r."appliesToOptionValueIds") > 0
         AND EXISTS (SELECT 1 FROM "OptionValue" v WHERE v."tenantId" = OLD."tenantId" AND v."groupId" = OLD."groupId" AND v."id" = ANY (r."appliesToOptionValueIds"))
    ) THEN
      RAISE EXCEPTION 'product: the style''s offer of option group % is kept while a BOM line or routing step of the style is for one of its values: archive it', OLD."groupId"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."styleId", NEW."groupId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."styleId", OLD."groupId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the style, group and creation of a style''s option group never change (another one is another row)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT g."code", g."kind"::text AS kind, g."status"::text AS status, g."companyId" AS company INTO grp
    FROM "OptionGroup" g WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."groupId" FOR SHARE;
  IF NEW."seq" < 0
     OR NEW."minPicks" NOT BETWEEN 0 AND 100 OR NEW."maxPicks" NOT BETWEEN 1 AND 100 OR NEW."maxPicks" < NEW."minPicks"
     OR (grp.kind = 'SINGLE' AND (NEW."maxPicks" > 1 OR NEW."minPicks" > 1)) THEN
    RAISE EXCEPTION 'product: a style offers option group % with a place from 0 and its own 0 to 100 values at least and 1 to 100 at most, not fewer than at least (a SINGLE group at most 1)', grp.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT s."companyId" INTO style_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF grp.company IS NOT NULL AND grp.company IS DISTINCT FROM style_company THEN
      RAISE EXCEPTION 'product: option group % is of a company: only that company''s styles offer it', grp.code
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" = 'ACTIVE' AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'ACTIVE') AND grp.status = 'ARCHIVED' THEN
    RAISE EXCEPTION 'product: option group % is archived: no style offers it anew', grp.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."defaultValueId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."defaultValueId" IS DISTINCT FROM OLD."defaultValueId") THEN
    SELECT v."status"::text INTO value_status FROM "OptionValue" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."defaultValueId";
    IF value_status = 'ARCHIVED' THEN
      RAISE EXCEPTION 'product: the default value of a style''s option group % is an active value', grp.code
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StyleOptionGroup_check" AFTER INSERT OR UPDATE ON "StyleOptionGroup"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_option_group_check"();
CREATE TRIGGER "StyleOptionGroup_delete_guard" BEFORE DELETE ON "StyleOptionGroup"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_option_group_check"();
CREATE TRIGGER "StyleOptionGroup_no_truncate" BEFORE TRUNCATE ON "StyleOptionGroup"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bom_options_refuse_truncate"();

-- One ACTIVE offer of a group per style. A unique index is checked row by row: archive the old offer before making another
-- one ACTIVE.
CREATE UNIQUE INDEX "StyleOptionGroup_one_active_per_style" ON "StyleOptionGroup" ("tenantId", "styleId", "groupId") WHERE "status" = 'ACTIVE';

-- =====================================================================================================================
-- RoutingOperation (PRD-128, B-W2b-205's appliesToOptionValueIds, which had no reference until this wave): its own trigger
-- beside W1's part rule and 205's "RoutingOperation_w2b4_depth". Each value it newly names is an ACTIVE value of the library
-- (of this tenant) of a group the step's style offers (an ACTIVE StyleOptionGroup, locked FOR SHARE).
CREATE FUNCTION "factory_routing_operation_option_values"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  value_id uuid;
  value_row record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."appliesToOptionValueIds" IS NOT DISTINCT FROM OLD."appliesToOptionValueIds" THEN
    RETURN NULL;
  END IF;
  FOREACH value_id IN ARRAY coalesce(NEW."appliesToOptionValueIds", '{}'::uuid[]) LOOP
    CONTINUE WHEN TG_OP = 'UPDATE' AND value_id = ANY (coalesce(OLD."appliesToOptionValueIds", '{}'::uuid[]));
    SELECT v."code", v."groupId", v."status"::text AS status INTO value_row
      FROM "OptionValue" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = value_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'product: routing step % of revision % is for option value %, which is not in the option library', NEW."seq", NEW."revisionId", value_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF value_row.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'product: routing step % of revision % is for option %, which is archived', NEW."seq", NEW."revisionId", value_row.code
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1 FROM "StyleOptionGroup" o
      WHERE o."tenantId" = NEW."tenantId" AND o."styleId" = NEW."styleId" AND o."groupId" = value_row."groupId" AND o."status" = 'ACTIVE'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'product: routing step % of revision % is for option %, whose group its style does not offer', NEW."seq", NEW."revisionId", value_row.code
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER "RoutingOperation_option_values" AFTER INSERT OR UPDATE OF "appliesToOptionValueIds" ON "RoutingOperation"
  FOR EACH ROW EXECUTE FUNCTION "factory_routing_operation_option_values"();
