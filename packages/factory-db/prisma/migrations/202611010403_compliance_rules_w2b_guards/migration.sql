-- Written by hand (Prisma does not model triggers), after the generated …_compliance_rules_w2b_schema and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The compliance rule library (W2b-4, schema wave 30/33, B-W2b-216; features PRD-271, PRD-272, PRD-273, PRD-274, PRD-275,
-- PRD-286, PRD-287, PRD-290, PRD-298, PRD-343, QHS-106). apps/factory-api's modules/compliance checks all of this first and
-- says it in words (B-W2b-249 register, markets, operators and phrases; B-W2b-254 requirements and gates; B-W2b-255
-- certificates in depth); these rules hold for every login, the owner included. Every refusal is a check_violation, a write to
-- frozen or kept data a restrict_violation. The checks are AFTER triggers (the policies speak first); a removal is refused by a
-- BEFORE DELETE trigger; an UPDATE that changes nothing passes; a rule that reads a row the session cannot see skips it, unless
-- the row it names must exist (the policies and references hold the tenant). No earlier function is redefined: Certificate and
-- CertificateCoverage get triggers of their own beside W1's guards (which freeze a registered certificate's W1 columns and a
-- coverage's certificate, style and item). Helpers of earlier waves are called as they are: 205's factory_instruction_words_ok
-- (words per language), 206's factory_styles_text_ok and factory_styles_distinct, 211's factory_bom_options_code_ok and
-- factory_bom_options_words_ok. No data copy: every new column is null or its default on the rows made before it.

-- =====================================================================================================================
-- Shared

CREATE FUNCTION "factory_compliance_rules_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'compliance: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- A row of a register that is kept: archived (or ended), never removed.
CREATE FUNCTION "factory_compliance_rules_keep"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'compliance: a row of "%" is kept, never removed (archive it, or end it)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- A market's code: a country (two capitals), optionally parts of it ("US-CA"); at most 40 characters.
CREATE FUNCTION "factory_market_code_ok"(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL AND length(value) <= 40 AND value ~ '^[A-Z]{2}(-[A-Za-z0-9]{1,8})*$'
$$;

-- A list of ISO 639 language codes (two or three small letters), each once, at most 20 (null: fine).
CREATE FUNCTION "factory_language_list_ok"(list text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT list IS NULL
      OR (cardinality(list) <= 20
          AND "factory_styles_distinct"(list)
          AND NOT EXISTS (SELECT 1 FROM unnest(list) AS l(code) WHERE l.code !~ '^[a-z]{2,3}$'))
$$;

-- An https address of at most 2000 characters, no spaces (null: none, fine).
CREATE FUNCTION "factory_https_ok"(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NULL OR (length(value) <= 2000 AND value ~ '^https://[^[:space:][:cntrl:]]+$')
$$;

-- A switch: OFF names its reason in words (3 to 500 characters), ON names none.
CREATE FUNCTION "factory_switch_problem"(switched_on boolean, off_reason text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN switched_on AND off_reason IS NOT NULL THEN 'a switched-on row names no reason to be off'
    WHEN NOT switched_on AND (off_reason IS NULL OR length(btrim(off_reason)) < 3 OR NOT "factory_bom_options_words_ok"(off_reason, 500))
      THEN 'a switched-off row says why in words (3 to 500 characters: the Owner question it waits for)'
  END
$$;

-- Whether the session sees a market of that code in the tenant (any status: an archived market may still be named).
CREATE FUNCTION "factory_market_code_known"(p_tenant uuid, p_code text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "MarketProfile" m WHERE m."tenantId" = p_tenant AND m."code" = p_code)
$$;

-- =====================================================================================================================
-- RegulationOrStandard (PRD-273)
--   every row  code 1-100 characters (spaces allowed), edition 1-40, title 1-300, titles per language, the Official
--              Journal citation 1-200, an https link, a note up to 2000; the successor only while SUPERSEDED, never itself
--              and no circle of successors (walked up to 50).
--   UPDATE     the creation never changes.
--   DELETE     allowed (a row typed by mistake), unless something names it (the references refuse). TRUNCATE refused.
-- One row per code without an edition (the generated key covers the rows with one).
CREATE UNIQUE INDEX "RegulationOrStandard_one_without_edition" ON "RegulationOrStandard"("tenantId", "code") WHERE "edition" IS NULL;

CREATE FUNCTION "factory_regulation_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the creation of register entry % never changes', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."code" IS NULL OR NOT "factory_styles_text_ok"(NEW."code", 100) THEN
    RAISE EXCEPTION 'compliance: register entry % has a code of 1 to 100 characters ("EN 17092-4", "Reg. (EU) 2016/425")', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."edition", 40) THEN
    RAISE EXCEPTION 'compliance: register entry % has an edition of 1 to 40 characters ("2020"), or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."title" IS NULL OR NOT "factory_styles_text_ok"(NEW."title", 300) THEN
    RAISE EXCEPTION 'compliance: register entry % has a title of 1 to 300 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."titleI18n" IS NOT NULL AND NOT "factory_instruction_words_ok"(NEW."titleI18n") THEN
    RAISE EXCEPTION 'compliance: register entry % gives its titles as words per language ({ "it": "…", "en": "…" })', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."ojReference", 200) THEN
    RAISE EXCEPTION 'compliance: register entry % has an Official Journal citation of 1 to 200 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_https_ok"(NEW."link") THEN
    RAISE EXCEPTION 'compliance: register entry % links to an https address (no spaces), or to none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: the note of register entry % is 1 to 2000 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supersededById" IS NOT NULL THEN
    IF NEW."status" <> 'SUPERSEDED' THEN
      RAISE EXCEPTION 'compliance: register entry % names what superseded it only while it is SUPERSEDED', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."supersededById" = NEW."id" OR EXISTS (
      WITH RECURSIVE up(id, depth) AS (
        SELECT NEW."supersededById", 1
        UNION ALL
        SELECT r."supersededById", up.depth + 1
          FROM up JOIN "RegulationOrStandard" r ON r."tenantId" = NEW."tenantId" AND r."id" = up.id
         WHERE r."supersededById" IS NOT NULL AND up.depth < 50
      )
      SELECT 1 FROM up WHERE up.id = NEW."id"
    ) THEN
      RAISE EXCEPTION 'compliance: register entry % is not superseded by itself or by an entry it superseded (a circle)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "RegulationOrStandard_check" AFTER INSERT OR UPDATE ON "RegulationOrStandard"
  FOR EACH ROW EXECUTE FUNCTION "factory_regulation_check"();
CREATE TRIGGER "RegulationOrStandard_no_truncate" BEFORE TRUNCATE ON "RegulationOrStandard"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_compliance_rules_refuse_truncate"();

-- =====================================================================================================================
-- StandardChange (PRD-274; PPE Annex V 7.1-7.3)
--   every row  what changed in words (1-4000), the source 1-300; the new edition never the standard itself; OPEN has no
--              assessment, ASSESSED and CLOSED have all of it (impact, the words 1-4000, when, by whom); CLOSED has its
--              time and person, the others none; the certificates each once, the reviews each once.
--   UPDATE     the standard and the creation never change; the status moves only OPEN → ASSESSED → CLOSED; the
--              assessment is fixed once made; a CLOSED change never changes; the impact task is named once. A newly named
--              certificate is a registered (not DRAFT) certificate of the tenant; a newly named review is a type-change
--              review of one of the change's certificates.
--   DELETE     refused (kept). TRUNCATE refused.
CREATE FUNCTION "factory_standard_change_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  missing uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."status" = 'CLOSED' THEN
      RAISE EXCEPTION 'compliance: standard change % is CLOSED; it never changes', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW."standardId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."standardId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the standard and the creation of standard change % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'OPEN' AND NEW."status" = 'ASSESSED') OR (OLD."status" = 'ASSESSED' AND NEW."status" = 'CLOSED')) THEN
      RAISE EXCEPTION 'compliance: standard change % cannot move from % to % (OPEN → ASSESSED → CLOSED)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN'
       AND (NEW."impact", NEW."assessment", NEW."assessedAt", NEW."assessedById")
           IS DISTINCT FROM (OLD."impact", OLD."assessment", OLD."assessedAt", OLD."assessedById") THEN
      RAISE EXCEPTION 'compliance: the assessment of standard change % is filed; it never changes', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."taskId" IS NOT NULL AND NEW."taskId" IS DISTINCT FROM OLD."taskId" THEN
      RAISE EXCEPTION 'compliance: standard change % names its impact task once', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."newStandardId" = NEW."standardId" THEN
    RAISE EXCEPTION 'compliance: standard change % names another entry as the new edition, not the standard itself', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."whatChanged" IS NULL OR NOT "factory_bom_options_words_ok"(NEW."whatChanged", 4000) THEN
    RAISE EXCEPTION 'compliance: standard change % says what changed in 1 to 4000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_text_ok"(NEW."sourceReference", 300) THEN
    RAISE EXCEPTION 'compliance: standard change % names its source in 1 to 300 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'OPEN' THEN
    IF NOT (NEW."impact" IS NULL AND NEW."assessment" IS NULL AND NEW."assessedAt" IS NULL AND NEW."assessedById" IS NULL) THEN
      RAISE EXCEPTION 'compliance: standard change % is OPEN: its impact is not assessed yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."impact" IS NULL OR NEW."assessedAt" IS NULL OR NEW."assessedById" IS NULL
        OR NEW."assessment" IS NULL OR NOT "factory_bom_options_words_ok"(NEW."assessment", 4000) THEN
    RAISE EXCEPTION 'compliance: standard change % is %: its impact, the assessment in words (1 to 4000 characters), when and by whom are filed', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL AND NEW."closedById" IS NOT NULL)
     OR (NEW."status" <> 'CLOSED' AND (NEW."closedAt" IS NOT NULL OR NEW."closedById" IS NOT NULL)) THEN
    RAISE EXCEPTION 'compliance: standard change % names when and by whom it was closed exactly when it is CLOSED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_distinct"(NEW."certificateIds") OR NOT "factory_styles_distinct"(NEW."typeChangeReviewIds")
     OR cardinality(NEW."certificateIds") > 500 OR cardinality(NEW."typeChangeReviewIds") > 500 THEN
    RAISE EXCEPTION 'compliance: standard change % names each certificate and each review once (at most 500)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.id INTO missing
    FROM unnest(NEW."certificateIds") AS c(id)
   WHERE (TG_OP = 'INSERT' OR NOT c.id = ANY (OLD."certificateIds"))
     AND NOT EXISTS (SELECT 1 FROM "Certificate" x WHERE x."tenantId" = NEW."tenantId" AND x."id" = c.id AND x."status" <> 'DRAFT')
   LIMIT 1;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'compliance: standard change % names certificate %, which is not a registered certificate of the tenant', NEW."id", missing
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.id INTO missing
    FROM unnest(NEW."typeChangeReviewIds") AS r(id)
   WHERE (TG_OP = 'INSERT' OR NOT r.id = ANY (OLD."typeChangeReviewIds") OR NEW."certificateIds" IS DISTINCT FROM OLD."certificateIds")
     AND NOT EXISTS (SELECT 1 FROM "TypeChangeReview" t
                      WHERE t."tenantId" = NEW."tenantId" AND t."id" = r.id AND t."certificateId" = ANY (NEW."certificateIds"))
   LIMIT 1;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'compliance: standard change % names type-change review %, which is not a review of one of its certificates', NEW."id", missing
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StandardChange_check" AFTER INSERT OR UPDATE ON "StandardChange"
  FOR EACH ROW EXECUTE FUNCTION "factory_standard_change_check"();
CREATE TRIGGER "StandardChange_kept" BEFORE DELETE ON "StandardChange"
  FOR EACH ROW EXECUTE FUNCTION "factory_compliance_rules_keep"();
CREATE TRIGGER "StandardChange_no_truncate" BEFORE TRUNCATE ON "StandardChange"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_compliance_rules_refuse_truncate"();

-- =====================================================================================================================
-- MarketProfile (PRD-275)
--   every row  a market code (two capitals, optionally parts: "US-CA"); a name 1-200, names per language; the label, DoC
--              and user information languages (ISO 639, each once, at most 20); marks of 2-20 capitals, digits, _ or -,
--              each once, at most 20; the national rules a list (at most 50) of { key, words per language, law?, href? }
--              with unique keys of 1-60 characters without spaces, the law 1-300 characters, the href https; its place 0 or
--              more; switched OFF with its reason in words (3-500), ON with none; a switch names its time; a note up to 2000.
--   UPDATE     the code, the company and the creation never change.
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_market_national_rules_problem"(rules jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry jsonb;
  keys text[] := '{}';
BEGIN
  IF jsonb_typeof(rules) <> 'array' OR jsonb_array_length(rules) > 50 THEN
    RETURN 'are a list of at most 50 rules';
  END IF;
  FOR entry IN SELECT e FROM jsonb_array_elements(rules) AS e LOOP
    IF jsonb_typeof(entry) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(entry) AS k WHERE k NOT IN ('key', 'words', 'law', 'href')) THEN
      RETURN 'are objects of { "key", "words", "law", "href" } only';
    END IF;
    IF jsonb_typeof(entry -> 'key') <> 'string' OR NOT "factory_bom_options_code_ok"(entry ->> 'key', 60) OR (entry ->> 'key') = ANY (keys) THEN
      RETURN 'each have their own key of 1 to 60 characters without spaces';
    END IF;
    keys := keys || (entry ->> 'key');
    IF NOT "factory_instruction_words_ok"(entry -> 'words') THEN
      RETURN format('give rule %s its words per language ({ "it": "…", "en": "…" })', entry ->> 'key');
    END IF;
    IF entry ? 'law' AND (jsonb_typeof(entry -> 'law') <> 'string' OR NOT "factory_styles_text_ok"(entry ->> 'law', 300)) THEN
      RETURN format('cite the law of rule %s in 1 to 300 characters', entry ->> 'key');
    END IF;
    IF entry ? 'href' AND (jsonb_typeof(entry -> 'href') <> 'string' OR NOT "factory_https_ok"(entry ->> 'href')) THEN
      RETURN format('link rule %s to an https address', entry ->> 'key');
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_market_profile_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."code", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."code", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the code, the company and the creation of market % never change', OLD."code"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."switchedOn" <> OLD."switchedOn" AND (NEW."switchedAt" IS NULL OR NEW."switchedAt" IS NOT DISTINCT FROM OLD."switchedAt") THEN
      RAISE EXCEPTION 'compliance: market % is switched with the time of the switch', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_market_code_ok"(NEW."code") THEN
    RAISE EXCEPTION 'compliance: market % has a code of two capitals (a country: "DE", "UK"), optionally parts of it ("US-CA")', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."name" IS NULL OR NOT "factory_styles_text_ok"(NEW."name", 200) THEN
    RAISE EXCEPTION 'compliance: market % has a name of 1 to 200 characters', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."nameI18n" IS NOT NULL AND NOT "factory_instruction_words_ok"(NEW."nameI18n") THEN
    RAISE EXCEPTION 'compliance: market % gives its names as words per language ({ "it": "…", "en": "…" })', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ("factory_language_list_ok"(NEW."labelLanguages") AND "factory_language_list_ok"(NEW."docLanguages") AND "factory_language_list_ok"(NEW."userInfoLanguages")) THEN
    RAISE EXCEPTION 'compliance: market % lists its label, DoC and user information languages as ISO 639 codes ("de"), each once, at most 20', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."markings") > 20 OR NOT "factory_styles_distinct"(NEW."markings")
     OR EXISTS (SELECT 1 FROM unnest(NEW."markings") AS m(code) WHERE m.code !~ '^[A-Z][A-Z0-9_-]{1,19}$') THEN
    RAISE EXCEPTION 'compliance: market % lists its marks as codes of 2 to 20 capitals ("CE", "UKCA"), each once, at most 20', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  problem := "factory_market_national_rules_problem"(NEW."nationalRules");
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'compliance: the national rules of market % %', NEW."code", problem
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 0 THEN
    RAISE EXCEPTION 'compliance: market % has a place of 0 or more', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  problem := "factory_switch_problem"(NEW."switchedOn", NEW."offReason");
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'compliance: market %: %', NEW."code", problem
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: the note of market % is 1 to 2000 characters, or none', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MarketProfile_check" AFTER INSERT OR UPDATE ON "MarketProfile"
  FOR EACH ROW EXECUTE FUNCTION "factory_market_profile_check"();
CREATE TRIGGER "MarketProfile_kept" BEFORE DELETE ON "MarketProfile"
  FOR EACH ROW EXECUTE FUNCTION "factory_compliance_rules_keep"();
CREATE TRIGGER "MarketProfile_no_truncate" BEFORE TRUNCATE ON "MarketProfile"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_compliance_rules_refuse_truncate"();

-- =====================================================================================================================
-- ComplianceRequirement (PRD-271, PRD-272)
--   every row  a code of 1-60 characters without spaces; a name 1-300, names and the plain explanation per language; the
--              check key "area.check" (small letters and digits, 2 to 4 parts, at most 100); the operator role exactly for an
--              OPERATOR_ROLE requirement; product types, PPE categories, gates, locked gates and override roles each once;
--              the locked gates among the gates it blocks; override roles of 1-60 characters without spaces (at most 20) and
--              1-7 days; the legal reference 1-300; the dates in order; its place 0 or more; switched OFF with its reason in
--              words, ON with none (a switch names its time); a requirement with a locked gate is switched on and ACTIVE;
--              a note up to 2000.
--              The refined product type (set or changed, or the company or product types changed): tenant-wide or of the
--              requirement's company (a tenant-wide requirement: tenant-wide only), and the product types none or exactly
--              its type. The market (set or changed): a market of the tenant.
--   UPDATE     the code, the company and the creation never change. Once a gate is locked it stays locked (and blocked),
--              and the requirement's kind, check, operator role, scope and dates never change (the law does not loosen).
--   DELETE     refused (archived; gate events name it). TRUNCATE refused.
CREATE FUNCTION "factory_compliance_requirement_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text;
  profile record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."code", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."code", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the code, the company and the creation of requirement % never change', OLD."code"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF cardinality(OLD."lockedBlocks") > 0 THEN
      IF NOT (OLD."lockedBlocks" <@ NEW."lockedBlocks") THEN
        RAISE EXCEPTION 'compliance: requirement % is locked by law at %; a locked gate stays locked', OLD."code", array_to_string(OLD."lockedBlocks", ', ')
          USING ERRCODE = 'restrict_violation';
      END IF;
      IF (NEW."kind", NEW."checkKey", NEW."operatorRole", NEW."productTypes", NEW."productTypeProfileId", NEW."ppeCategories",
          NEW."marketCode", NEW."appliesFrom", NEW."appliesUntil")
         IS DISTINCT FROM
         (OLD."kind", OLD."checkKey", OLD."operatorRole", OLD."productTypes", OLD."productTypeProfileId", OLD."ppeCategories",
          OLD."marketCode", OLD."appliesFrom", OLD."appliesUntil") THEN
        RAISE EXCEPTION 'compliance: requirement % is locked by law; its kind, check, scope and dates never change', OLD."code"
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
    IF NEW."switchedOn" <> OLD."switchedOn" AND (NEW."switchedAt" IS NULL OR NEW."switchedAt" IS NOT DISTINCT FROM OLD."switchedAt") THEN
      RAISE EXCEPTION 'compliance: requirement % is switched with the time of the switch', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_bom_options_code_ok"(NEW."code", 60) THEN
    RAISE EXCEPTION 'compliance: requirement % has a code of 1 to 60 characters without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."name" IS NULL OR NOT "factory_styles_text_ok"(NEW."name", 300) THEN
    RAISE EXCEPTION 'compliance: requirement % says what it asks in 1 to 300 characters', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."nameI18n" IS NOT NULL AND NOT "factory_instruction_words_ok"(NEW."nameI18n"))
     OR (NEW."explanationI18n" IS NOT NULL AND NOT "factory_instruction_words_ok"(NEW."explanationI18n")) THEN
    RAISE EXCEPTION 'compliance: requirement % gives its names and its explanation as words per language ({ "it": "…", "en": "…" })', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."checkKey" IS NOT NULL AND (length(NEW."checkKey") > 100 OR NEW."checkKey" !~ '^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){1,3}$') THEN
    RAISE EXCEPTION 'compliance: requirement % names its check as "area.check" ("certificate.coverage", "textile.careLabel")', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'OPERATOR_ROLE') <> (NEW."operatorRole" IS NOT NULL) THEN
    RAISE EXCEPTION 'compliance: requirement % names an operator role exactly when it asks for an economic operator (OPERATOR_ROLE)', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ("factory_styles_distinct"(NEW."productTypes") AND "factory_styles_distinct"(NEW."ppeCategories")
          AND "factory_styles_distinct"(NEW."blocks") AND "factory_styles_distinct"(NEW."lockedBlocks")
          AND "factory_styles_distinct"(NEW."overrideRoleKeys")) THEN
    RAISE EXCEPTION 'compliance: requirement % names each product type, PPE category, gate and role once', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (NEW."lockedBlocks" <@ NEW."blocks") THEN
    RAISE EXCEPTION 'compliance: requirement % locks only gates it blocks', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."overrideRoleKeys") > 20
     OR EXISTS (SELECT 1 FROM unnest(NEW."overrideRoleKeys") AS r(code) WHERE NOT "factory_bom_options_code_ok"(r.code, 60))
     OR NEW."overrideMaxDays" NOT BETWEEN 1 AND 7 THEN
    RAISE EXCEPTION 'compliance: requirement % names at most 20 override roles by their keys, and overrides last 1 to 7 days', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."legalReference" IS NULL OR NOT "factory_styles_text_ok"(NEW."legalReference", 300) THEN
    RAISE EXCEPTION 'compliance: requirement % cites its legal reference in 1 to 300 characters ("Reg. (EU) 2016/425 art. 8(7)")', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."appliesUntil" < NEW."appliesFrom" THEN
    RAISE EXCEPTION 'compliance: requirement % applies until a day not before it starts', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 0 THEN
    RAISE EXCEPTION 'compliance: requirement % has a place of 0 or more', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  problem := "factory_switch_problem"(NEW."switchedOn", NEW."offReason");
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'compliance: requirement %: %', NEW."code", problem
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."lockedBlocks") > 0 AND (NOT NEW."switchedOn" OR NEW."status" <> 'ACTIVE') THEN
    RAISE EXCEPTION 'compliance: requirement % is locked by law at %; it is never switched off or archived', NEW."code", array_to_string(NEW."lockedBlocks", ', ')
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: the note of requirement % is 1 to 2000 characters, or none', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."productTypeProfileId" IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR (NEW."productTypeProfileId", NEW."productTypes") IS DISTINCT FROM (OLD."productTypeProfileId", OLD."productTypes")) THEN
    SELECT p."companyId", p."productType"::text AS "productType" INTO profile
      FROM "ProductTypeProfile" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."productTypeProfileId";
    IF FOUND THEN
      IF profile."companyId" IS NOT NULL AND profile."companyId" IS DISTINCT FROM NEW."companyId" THEN
        RAISE EXCEPTION 'compliance: requirement % names a product type of another company (a requirement takes its company''s types or tenant-wide ones)', NEW."code"
          USING ERRCODE = 'check_violation';
      END IF;
      IF cardinality(NEW."productTypes") > 0 AND NEW."productTypes"::text[] <> ARRAY[profile."productType"] THEN
        RAISE EXCEPTION 'compliance: requirement % names the product type %''s kind of garment (%) or none beside it', NEW."code", NEW."productTypeProfileId", profile."productType"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."marketCode" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."marketCode" IS DISTINCT FROM OLD."marketCode") THEN
    IF NOT "factory_market_code_ok"(NEW."marketCode") OR NOT "factory_market_code_known"(NEW."tenantId", NEW."marketCode") THEN
      RAISE EXCEPTION 'compliance: requirement % is for market %, which is not a market of the tenant (Rules & markets)', NEW."code", NEW."marketCode"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ComplianceRequirement_check" AFTER INSERT OR UPDATE ON "ComplianceRequirement"
  FOR EACH ROW EXECUTE FUNCTION "factory_compliance_requirement_check"();
CREATE TRIGGER "ComplianceRequirement_kept" BEFORE DELETE ON "ComplianceRequirement"
  FOR EACH ROW EXECUTE FUNCTION "factory_compliance_rules_keep"();
CREATE TRIGGER "ComplianceRequirement_no_truncate" BEFORE TRUNCATE ON "ComplianceRequirement"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_compliance_rules_refuse_truncate"();

-- =====================================================================================================================
-- GateEvent (PRD-272): append-only, for every login (check-append-only reads these two triggers).
--   INSERT     the subject's model name (a capital, then letters and digits, 2-60); a market code or none; the reason in
--              words (1-2000); the facts an object or none.
--              REFUSED: no refusal, step-up or end; the requirement (read as the session sees it) ACTIVE, switched on and
--              blocking that gate.
--              OVERRIDDEN: never from the floor; a person; the refusal it lifts is a REFUSED event of the same company,
--              gate, subject and requirement; the gate is not one the law locks and the requirement names override roles;
--              the step-up at most 15 minutes before it and not after it; its end after it and at most the requirement's
--              days later.
--   UPDATE, DELETE, TRUNCATE refused.
CREATE FUNCTION "factory_gate_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'compliance: "%" is append-only; % refused (a gate event is never changed or removed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE FUNCTION "factory_gate_event_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  requirement record;
  known boolean;
  refusal record;
BEGIN
  IF NEW."subjectType" IS NULL OR NEW."subjectType" !~ '^[A-Z][A-Za-z0-9]{1,59}$' THEN
    RAISE EXCEPTION 'compliance: gate event % names its subject by its model name ("WorkOrder", "Shipment")', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."marketCode" IS NOT NULL AND NOT "factory_market_code_ok"(NEW."marketCode") THEN
    RAISE EXCEPTION 'compliance: gate event % names a market by its code ("DE"), or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reason" IS NULL OR NOT "factory_bom_options_words_ok"(NEW."reason", 2000) THEN
    RAISE EXCEPTION 'compliance: gate event % says why in words (1 to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."explanation" IS NOT NULL AND jsonb_typeof(NEW."explanation") <> 'object' THEN
    RAISE EXCEPTION 'compliance: gate event % gives its facts as an object, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- The requirement as the session sees it (the reference holds that it exists).
  SELECT r."code", r."status"::text AS status, r."switchedOn", r."blocks"::text[] AS blocks, r."lockedBlocks"::text[] AS locked,
         cardinality(r."overrideRoleKeys") AS roles, r."overrideMaxDays"
    INTO requirement
    FROM "ComplianceRequirement" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."requirementId";
  known := FOUND;

  IF NEW."outcome" = 'REFUSED' THEN
    IF NEW."refusedEventId" IS NOT NULL OR NEW."stepUpAt" IS NOT NULL OR NEW."overrideUntil" IS NOT NULL THEN
      RAISE EXCEPTION 'compliance: refusal % names no refusal, step-up or end (an override does)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF known AND (requirement.status <> 'ACTIVE' OR NOT requirement."switchedOn" OR NOT NEW."gate"::text = ANY (requirement.blocks)) THEN
      RAISE EXCEPTION 'compliance: requirement % does not block % (it is archived, switched off, or blocks other gates); the gate does not refuse by it', requirement."code", NEW."gate"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  -- OVERRIDDEN
  IF current_user = 'factory_floor_runtime' THEN
    RAISE EXCEPTION 'compliance: the floor never overrides a gate (a named role does, in the office)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."createdById" IS NULL OR NEW."refusedEventId" IS NULL OR NEW."stepUpAt" IS NULL OR NEW."overrideUntil" IS NULL THEN
    RAISE EXCEPTION 'compliance: override % names its person, the refusal it lifts, the step-up and its end', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT e."outcome"::text AS outcome, e."gate"::text AS gate, e."companyId", e."subjectType", e."subjectId", e."requirementId"
    INTO refusal
    FROM "GateEvent" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."refusedEventId";
  IF NOT FOUND OR refusal.outcome <> 'REFUSED'
     OR (refusal.gate, refusal."companyId", refusal."subjectType", refusal."subjectId", refusal."requirementId")
        IS DISTINCT FROM (NEW."gate"::text, NEW."companyId", NEW."subjectType", NEW."subjectId", NEW."requirementId") THEN
    RAISE EXCEPTION 'compliance: override % lifts a refusal of the same gate, subject and requirement', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF known THEN
    IF NEW."gate"::text = ANY (requirement.locked) THEN
      RAISE EXCEPTION 'compliance: requirement % is locked by law at %; nobody overrides it there', requirement."code", NEW."gate"
        USING ERRCODE = 'check_violation';
    END IF;
    IF requirement.roles = 0 THEN
      RAISE EXCEPTION 'compliance: requirement % names no role that may override it', requirement."code"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."overrideUntil" <= NEW."createdAt" OR NEW."overrideUntil" > NEW."createdAt" + make_interval(days => requirement."overrideMaxDays") THEN
      RAISE EXCEPTION 'compliance: override % ends after it is made and at most % days later (requirement %)', NEW."id", requirement."overrideMaxDays", requirement."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."stepUpAt" > NEW."createdAt" OR NEW."stepUpAt" < NEW."createdAt" - interval '15 minutes' THEN
    RAISE EXCEPTION 'compliance: override % needs a fresh step-up (at most 15 minutes before it)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "GateEvent_check" AFTER INSERT ON "GateEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_gate_event_check"();
CREATE TRIGGER "GateEvent_append_only" BEFORE UPDATE OR DELETE ON "GateEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_gate_event_append_only"();
CREATE TRIGGER "GateEvent_no_truncate" BEFORE TRUNCATE ON "GateEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_gate_event_append_only"();

-- =====================================================================================================================
-- EconomicOperatorRole (PRD-298; Reg. (EU) 2019/1020 art. 4)
--   every row  a style or a brand, not both; an operator party for every role but MANUFACTURER; the printed name 1-200,
--              address 1-500 (line breaks allowed), contact 1-200; the last day not before the first; a note up to 2000.
--              The style (set or changed, or the company changed): the row's company is the style's. The brand (set or
--              changed): a party with the BRAND role. The market (set or changed): a market of the tenant.
--   UPDATE     the creation never changes.
--   DELETE     refused (ended by its last day). TRUNCATE refused.
CREATE FUNCTION "factory_economic_operator_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  style_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the creation of economic operator % never changes', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."styleId" IS NOT NULL AND NEW."brandPartyId" IS NOT NULL THEN
    RAISE EXCEPTION 'compliance: economic operator % is set for a style or for a brand, not both', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."role" <> 'MANUFACTURER' AND NEW."partyId" IS NULL THEN
    RAISE EXCEPTION 'compliance: economic operator % (%) names its party: only the manufacturer may be our own company', NEW."id", NEW."role"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."printedName" IS NULL OR NOT "factory_styles_text_ok"(NEW."printedName", 200)
     OR NEW."printedAddress" IS NULL OR NOT "factory_bom_options_words_ok"(NEW."printedAddress", 500)
     OR NOT "factory_styles_text_ok"(NEW."contact", 200) THEN
    RAISE EXCEPTION 'compliance: economic operator % prints a name (1 to 200 characters), a postal address (1 to 500) and a contact (1 to 200, or none)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."validTo" < NEW."validFrom" THEN
    RAISE EXCEPTION 'compliance: economic operator % ends on a day not before it starts', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: the note of economic operator % is 1 to 2000 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."styleId" IS NOT NULL AND (TG_OP = 'INSERT' OR (NEW."styleId", NEW."companyId") IS DISTINCT FROM (OLD."styleId", OLD."companyId")) THEN
    SELECT s."companyId" INTO style_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND AND style_company IS DISTINCT FROM NEW."companyId" THEN
      RAISE EXCEPTION 'compliance: economic operator % of a style is for the style''s company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."brandPartyId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."brandPartyId" IS DISTINCT FROM OLD."brandPartyId")
     AND EXISTS (SELECT 1 FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."brandPartyId" AND NOT 'BRAND' = ANY (p."roles")) THEN
    RAISE EXCEPTION 'compliance: economic operator % is set for a party that is not a brand', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."marketCode" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."marketCode" IS DISTINCT FROM OLD."marketCode") THEN
    IF NOT "factory_market_code_ok"(NEW."marketCode") OR NOT "factory_market_code_known"(NEW."tenantId", NEW."marketCode") THEN
      RAISE EXCEPTION 'compliance: economic operator % is for market %, which is not a market of the tenant (Rules & markets)', NEW."id", NEW."marketCode"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "EconomicOperatorRole_check" AFTER INSERT OR UPDATE ON "EconomicOperatorRole"
  FOR EACH ROW EXECUTE FUNCTION "factory_economic_operator_check"();
CREATE TRIGGER "EconomicOperatorRole_kept" BEFORE DELETE ON "EconomicOperatorRole"
  FOR EACH ROW EXECUTE FUNCTION "factory_compliance_rules_keep"();
CREATE TRIGGER "EconomicOperatorRole_no_truncate" BEFORE TRUNCATE ON "EconomicOperatorRole"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_compliance_rules_refuse_truncate"();

-- =====================================================================================================================
-- Phrase (PRD-343)
--   every row  a key of 1-100 characters without spaces; the source language ISO 639 (two or three small letters); the
--              source words 1-4000 (line breaks allowed); a revision of 1 or more; a note up to 2000.
--   UPDATE     the key, the company and the creation never change; the revision moves up by exactly one when the source
--              words or their language change, and only then.
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_phrase_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."key", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."key", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the key, the company and the creation of phrase % never change', OLD."key"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW."sourceText", NEW."sourceLanguage") IS DISTINCT FROM (OLD."sourceText", OLD."sourceLanguage") THEN
      IF NEW."revision" <> OLD."revision" + 1 THEN
        RAISE EXCEPTION 'compliance: phrase % takes revision % with its new source words', OLD."key", OLD."revision" + 1
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."revision" <> OLD."revision" THEN
      RAISE EXCEPTION 'compliance: phrase % keeps its revision while its source words stay', OLD."key"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_bom_options_code_ok"(NEW."key", 100) THEN
    RAISE EXCEPTION 'compliance: phrase % has a key of 1 to 100 characters without spaces ("warning.class-b")', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sourceLanguage" IS NULL OR NEW."sourceLanguage" !~ '^[a-z]{2,3}$' THEN
    RAISE EXCEPTION 'compliance: phrase % names its source language by its ISO 639 code ("it")', NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sourceText" IS NULL OR NOT "factory_bom_options_words_ok"(NEW."sourceText", 4000) THEN
    RAISE EXCEPTION 'compliance: phrase % has source words of 1 to 4000 characters', NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revision" < 1 THEN
    RAISE EXCEPTION 'compliance: phrase % has a revision of 1 or more', NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: the note of phrase % is 1 to 2000 characters, or none', NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Phrase_check" AFTER INSERT OR UPDATE ON "Phrase"
  FOR EACH ROW EXECUTE FUNCTION "factory_phrase_check"();
CREATE TRIGGER "Phrase_kept" BEFORE DELETE ON "Phrase"
  FOR EACH ROW EXECUTE FUNCTION "factory_compliance_rules_keep"();
CREATE TRIGGER "Phrase_no_truncate" BEFORE TRUNCATE ON "Phrase"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_compliance_rules_refuse_truncate"();

-- =====================================================================================================================
-- PhraseTranslation (PRD-343)
--   every row  a BCP 47 language (at most 35 characters), never the phrase's source language; a revision of 1 or more; the
--              words 1-4000; the source revision 1 up to the phrase's (when set or changed); DRAFT names no approval,
--              APPROVED and SUPERSEDED name when and by whom.
--   INSERT     as DRAFT.
--   UPDATE     the phrase, the language, the revision and the creation never change; the status moves only DRAFT →
--              APPROVED → SUPERSEDED; approving it takes the phrase's current revision (its row locked FOR SHARE) and a
--              person other than its author (the translator, else its creator); once approved only its status moves.
--   DELETE     only a DRAFT. TRUNCATE refused.
-- One APPROVED and one DRAFT translation per phrase and language.
CREATE UNIQUE INDEX "PhraseTranslation_one_approved" ON "PhraseTranslation"("tenantId", "phraseId", "language") WHERE "status" = 'APPROVED';
CREATE UNIQUE INDEX "PhraseTranslation_one_draft" ON "PhraseTranslation"("tenantId", "phraseId", "language") WHERE "status" = 'DRAFT';

CREATE FUNCTION "factory_phrase_translation_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  phrase record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'compliance: a translation is proposed as DRAFT and approved by a second person'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."phraseId", NEW."language", NEW."revision", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."phraseId", OLD."language", OLD."revision", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the phrase, language, revision and creation of translation % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'APPROVED') OR (OLD."status" = 'APPROVED' AND NEW."status" = 'SUPERSEDED')) THEN
      RAISE EXCEPTION 'compliance: translation % cannot move from % to % (DRAFT → APPROVED → SUPERSEDED)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND (NEW."text", NEW."sourceRevision", NEW."translatedById", NEW."approvedAt", NEW."approvedById")
           IS DISTINCT FROM (OLD."text", OLD."sourceRevision", OLD."translatedById", OLD."approvedAt", OLD."approvedById") THEN
      RAISE EXCEPTION 'compliance: translation % is %; only its status moves (new words are the next revision)', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."language" IS NULL OR length(NEW."language") > 35 OR NEW."language" !~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$' THEN
    RAISE EXCEPTION 'compliance: translation % names its language by its BCP 47 tag ("de", "pt-BR")', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revision" < 1 THEN
    RAISE EXCEPTION 'compliance: translation % has a revision of 1 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."text" IS NULL OR NOT "factory_bom_options_words_ok"(NEW."text", 4000) THEN
    RAISE EXCEPTION 'compliance: translation % has words of 1 to 4000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DRAFT') <> (NEW."approvedAt" IS NULL AND NEW."approvedById" IS NULL)
     OR (NEW."status" <> 'DRAFT' AND (NEW."approvedAt" IS NULL OR NEW."approvedById" IS NULL)) THEN
    RAISE EXCEPTION 'compliance: translation % names when and by whom it was approved exactly once it is approved', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR (NEW."sourceRevision", NEW."status") IS DISTINCT FROM (OLD."sourceRevision", OLD."status") THEN
    SELECT p."sourceLanguage", p."revision" INTO phrase
      FROM "Phrase" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."phraseId" FOR SHARE;
    IF FOUND THEN
      IF NEW."language" = phrase."sourceLanguage" THEN
        RAISE EXCEPTION 'compliance: translation % is in the phrase''s source language (%); the source words are the phrase''s', NEW."id", NEW."language"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."sourceRevision" < 1 OR NEW."sourceRevision" > phrase."revision" THEN
        RAISE EXCEPTION 'compliance: translation % translates revision % of a phrase at revision %', NEW."id", NEW."sourceRevision", phrase."revision"
          USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP = 'UPDATE' AND NEW."status" = 'APPROVED' AND OLD."status" = 'DRAFT' AND NEW."sourceRevision" <> phrase."revision" THEN
        RAISE EXCEPTION 'compliance: translation % translates revision % of the source words; the phrase is at revision %: translate it again first', NEW."id", NEW."sourceRevision", phrase."revision"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" = 'APPROVED' AND OLD."status" = 'DRAFT'
     AND NEW."approvedById" = COALESCE(NEW."translatedById", NEW."createdById") THEN
    RAISE EXCEPTION 'compliance: translation % is approved by a second person, not by its author', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_phrase_translation_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'compliance: translation % is %; it is kept (only a draft is removed)', OLD."id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "PhraseTranslation_check" AFTER INSERT OR UPDATE ON "PhraseTranslation"
  FOR EACH ROW EXECUTE FUNCTION "factory_phrase_translation_check"();
CREATE TRIGGER "PhraseTranslation_delete_guard" BEFORE DELETE ON "PhraseTranslation"
  FOR EACH ROW EXECUTE FUNCTION "factory_phrase_translation_delete_guard"();
CREATE TRIGGER "PhraseTranslation_no_truncate" BEFORE TRUNCATE ON "PhraseTranslation"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_compliance_rules_refuse_truncate"();

-- =====================================================================================================================
-- NotifiedBody (PRD-286)
--   every row  four digits; a name 1-300, a postal address 1-500 (line breaks allowed), a country of two capitals; the NANDO
--              entry https; the scopes 1-300 characters each, each once, at most 50; an e-mail address, a phone 1-40; a note
--              up to 2000.
--   UPDATE     the creation never changes; the number never changes once a certificate names the body.
--   DELETE     refused (archived). TRUNCATE refused.
-- One ACTIVE body per number.
CREATE UNIQUE INDEX "NotifiedBody_one_active_per_number" ON "NotifiedBody"("tenantId", "number") WHERE "status" = 'ACTIVE';

CREATE FUNCTION "factory_notified_body_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the creation of notified body % never changes', OLD."number"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."number" <> OLD."number"
       AND EXISTS (SELECT 1 FROM "Certificate" c WHERE c."tenantId" = OLD."tenantId" AND c."notifiedBodyId" = OLD."id") THEN
      RAISE EXCEPTION 'compliance: notified body % is named by certificates; its number never changes', OLD."number"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."number" IS NULL OR NEW."number" !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'compliance: notified body % has its four-digit NANDO number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."name" IS NULL OR NOT "factory_styles_text_ok"(NEW."name", 300)
     OR NEW."address" IS NULL OR NOT "factory_bom_options_words_ok"(NEW."address", 500)
     OR NEW."country" IS NULL OR NEW."country" !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'compliance: notified body % has a name (1 to 300 characters), a postal address (1 to 500) and a country (two capitals)', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_https_ok"(NEW."nandoUrl") THEN
    RAISE EXCEPTION 'compliance: notified body % links its NANDO entry by an https address, or none', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."scopes") > 50 OR NOT "factory_styles_distinct"(NEW."scopes")
     OR EXISTS (SELECT 1 FROM unnest(NEW."scopes") AS s(words) WHERE NOT "factory_styles_text_ok"(s.words, 300)) THEN
    RAISE EXCEPTION 'compliance: notified body % lists its scopes in 1 to 300 characters each, each once, at most 50', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."contactEmail" IS NOT NULL AND (length(NEW."contactEmail") > 200 OR NEW."contactEmail" !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'))
     OR NOT "factory_styles_text_ok"(NEW."contactPhone", 40) THEN
    RAISE EXCEPTION 'compliance: notified body % has an e-mail address and a phone of 1 to 40 characters, or none', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bom_options_words_ok"(NEW."note", 2000) THEN
    RAISE EXCEPTION 'compliance: the note of notified body % is 1 to 2000 characters, or none', NEW."number"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "NotifiedBody_check" AFTER INSERT OR UPDATE ON "NotifiedBody"
  FOR EACH ROW EXECUTE FUNCTION "factory_notified_body_check"();
CREATE TRIGGER "NotifiedBody_kept" BEFORE DELETE ON "NotifiedBody"
  FOR EACH ROW EXECUTE FUNCTION "factory_compliance_rules_keep"();
CREATE TRIGGER "NotifiedBody_no_truncate" BEFORE TRUNCATE ON "NotifiedBody"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_compliance_rules_refuse_truncate"();

-- =====================================================================================================================
-- Certificate (PRD-286, PRD-287, PRD-290): its own trigger beside W1's "Certificate_guard" (which freezes a registered
-- certificate's W1 columns) and W2a's "Certificate_successor_guard".
--   notified body  (set or changed, or the typed number changed) the body's number is the certificate's typed number; a
--                  body newly named is ACTIVE.
--   levels         (set or changed) an object of 1 to 30 properties (a small letter, then letters and digits, at most 40)
--                  to levels of 1 to 20 characters.
--   base           (set or changed, or the holder changed) another certificate, held by a company (not a party) and with no
--                  base of its own; this one is held by a party with the BRAND role, and no own-brand certificate rests on it.
--   registered     once out of DRAFT, each of the three may be filled in once (from null) and never changes after.
CREATE FUNCTION "factory_certificate_levels_problem"(levels jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  n int := 0;
  entry record;
BEGIN
  IF levels IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(levels) <> 'object' THEN
    RETURN 'are an object of properties to levels ({ "level": "2", "knuckle": "KP" })';
  END IF;
  FOR entry IN SELECT e.key, e.value FROM jsonb_each(levels) AS e LOOP
    n := n + 1;
    IF entry.key !~ '^[a-z][A-Za-z0-9]{0,39}$' THEN
      RETURN format('name each property in letters and digits starting small ("knuckle"), not %s', entry.key);
    END IF;
    IF jsonb_typeof(entry.value) <> 'string' OR NOT "factory_styles_text_ok"(entry.value #>> '{}', 20) THEN
      RETURN format('give property %s a level of 1 to 20 characters ("2", "KP")', entry.key);
    END IF;
  END LOOP;
  IF n = 0 OR n > 30 THEN
    RETURN 'name 1 to 30 properties';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_certificate_w2b4_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  body record;
  base record;
  problem text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND ((OLD."notifiedBodyId" IS NOT NULL AND NEW."notifiedBodyId" IS DISTINCT FROM OLD."notifiedBodyId")
            OR (OLD."performanceLevels" IS NOT NULL AND NEW."performanceLevels" IS DISTINCT FROM OLD."performanceLevels")
            OR (OLD."baseCertificateId" IS NOT NULL AND NEW."baseCertificateId" IS DISTINCT FROM OLD."baseCertificateId")) THEN
      RAISE EXCEPTION 'compliance: certificate % is %; its notified body, levels and base certificate are filled in once and never change', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."notifiedBodyId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."notifiedBodyId", NEW."notifiedBodyNumber") IS DISTINCT FROM (OLD."notifiedBodyId", OLD."notifiedBodyNumber")) THEN
    SELECT b."number", b."status"::text AS status INTO body FROM "NotifiedBody" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."notifiedBodyId";
    IF FOUND THEN
      IF body."number" <> NEW."notifiedBodyNumber" THEN
        RAISE EXCEPTION 'compliance: certificate % was issued by notified body % (as typed); the directory''s body % is another one', NEW."id", NEW."notifiedBodyNumber", body."number"
          USING ERRCODE = 'check_violation';
      END IF;
      IF body.status <> 'ACTIVE' AND (TG_OP = 'INSERT' OR NEW."notifiedBodyId" IS DISTINCT FROM OLD."notifiedBodyId") THEN
        RAISE EXCEPTION 'compliance: notified body % is archived; pick the active entry of the directory', body."number"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW."performanceLevels" IS DISTINCT FROM OLD."performanceLevels" THEN
    problem := "factory_certificate_levels_problem"(NEW."performanceLevels");
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'compliance: the performance levels of certificate % %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."baseCertificateId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."baseCertificateId", NEW."holderPartyId") IS DISTINCT FROM (OLD."baseCertificateId", OLD."holderPartyId")) THEN
    IF NEW."baseCertificateId" = NEW."id" THEN
      RAISE EXCEPTION 'compliance: certificate % does not rest on itself', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."holderPartyId" IS NULL
       OR EXISTS (SELECT 1 FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."holderPartyId" AND NOT 'BRAND' = ANY (p."roles")) THEN
      RAISE EXCEPTION 'compliance: certificate % rests on a base certificate only as an own-brand certificate held by a brand', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT c."companyId", c."holderPartyId", c."baseCertificateId" INTO base
      FROM "Certificate" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."baseCertificateId";
    IF FOUND AND (base."companyId" IS NULL OR base."holderPartyId" IS NOT NULL OR base."baseCertificateId" IS NOT NULL) THEN
      RAISE EXCEPTION 'compliance: the base certificate of certificate % is the factory''s own (held by a company) with no base of its own', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "Certificate" c WHERE c."tenantId" = NEW."tenantId" AND c."baseCertificateId" = NEW."id") THEN
      RAISE EXCEPTION 'compliance: own-brand certificates rest on certificate %; it takes no base of its own', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Certificate_w2b4_rules" AFTER INSERT OR UPDATE OF "notifiedBodyId", "notifiedBodyNumber", "performanceLevels", "baseCertificateId", "holderPartyId" ON "Certificate"
  FOR EACH ROW EXECUTE FUNCTION "factory_certificate_w2b4_check"();

-- =====================================================================================================================
-- CertificateCoverage (QHS-106): its own trigger beside W1's "CertificateCoverage_guard" (which keeps the certificate and
-- the style or item fixed).
--   supplier  only on an item's coverage; (set or changed) a party with the SUPPLIER role; named once, never changed or
--             cleared after.
--   article   only with a supplier; 1-100 characters.
CREATE FUNCTION "factory_certificate_coverage_supplier_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."supplierPartyId" IS NOT NULL AND NEW."supplierPartyId" IS DISTINCT FROM OLD."supplierPartyId" THEN
      RAISE EXCEPTION 'compliance: coverage % names its supplier once; it never changes', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."supplierPartyId" IS NOT NULL AND NEW."itemId" IS NULL THEN
    RAISE EXCEPTION 'compliance: coverage % names a supplier only for a bought-in part (an item), not for a style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supplierArticleCode" IS NOT NULL AND (NEW."supplierPartyId" IS NULL OR NOT "factory_styles_text_ok"(NEW."supplierArticleCode", 100)) THEN
    RAISE EXCEPTION 'compliance: coverage % gives the supplier''s article code (1 to 100 characters) only with its supplier', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supplierPartyId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."supplierPartyId" IS DISTINCT FROM OLD."supplierPartyId")
     AND EXISTS (SELECT 1 FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."supplierPartyId" AND NOT 'SUPPLIER' = ANY (p."roles")) THEN
    RAISE EXCEPTION 'compliance: coverage % names a party that is not a supplier', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "CertificateCoverage_supplier" AFTER INSERT OR UPDATE OF "supplierPartyId", "supplierArticleCode", "itemId" ON "CertificateCoverage"
  FOR EACH ROW EXECUTE FUNCTION "factory_certificate_coverage_supplier_check"();
