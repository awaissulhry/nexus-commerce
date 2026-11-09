-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202611010502_substances_w2b_schema and before the policy migration. When the migrations are renumbered, keep this file as
-- it is under its new timestamp.

-- Materials and restricted substances, W2b-4 schema wave 31/33 (B-W2b-217; PRD-303, PRD-304, PRD-309, PRD-314, PRD-318,
-- PRD-320 to PRD-326, PRD-329). apps/factory-api checks all of this first and answers in words (B-W2b-250, -256); these rules
-- are the last word, for every login, the owner included.
--
--   RestrictedSubstance        its CAS and EC numbers with their check digits (CAS: the digits weighted 1, 2, 3 … from
--                              the right, mod 10; EC: weighted 1 to 6 from the left, mod 11), given once, never changed; a
--                              name (per language too); a group code; on at least one list, each once; its Annex XVII
--                              entries exactly when on REACH_ANNEX_XVII; the Candidate List version that added it only
--                              when on SVHC; its company and creation never change. One ACTIVE row per CAS number in the
--                              tenant (a partial unique). Archived, never deleted.
--   SubstanceRule              one substance (of its company or tenant-wide) or one group, exactly one; material kinds
--                              (never FINISHED), product types and market codes, each once; a limit above 0 with its unit
--                              and its bound, or none of them; a CUSTOMER rule exactly with its brand; its legal reference
--                              (and an https link); switched OFF exactly with the reason, every switch with its time; its
--                              company, key and creation never change. Archived, never deleted.
--   SvhcListVersion            entries from 1, its source in words (and an https page); what was published (day, entries,
--                              source) never changes, only the note; removed only while no substance, profile or
--                              declaration request names it (a BEFORE DELETE trigger, so the words come before the
--                              foreign key's).
--   MaterialComplianceProfile  of a material (never a FINISHED garment), which never changes; each confirmation with its
--                              time and person (tannage only for a LEATHER); its origin a country code; the SVHC answer
--                              with the list version it was judged against, above 0.1 % exactly with the SVHCs it names
--                              (each on the Candidate List); what the evaluator found only with the time it ran (rule ids
--                              of the list), each once; BLOCKED says why, COMPLETE was evaluated and has no reason. Never
--                              deleted.
--   SupplierDeclarationRequest its number by `factory_document_number_guard` (…_numbering_floor_documents_guards, as it
--                              is); inserted SENT with no reminder, answer, decision or cancellation; SENT → ANSWERED |
--                              OVERDUE | CANCELLED, OVERDUE → ANSWERED | CANCELLED, ANSWERED → ACCEPTED | REFUSED; OVERDUE
--                              only after its due day (Rome); ACCEPTED, REFUSED and CANCELLED final (only the internal
--                              note moves); what was asked, of whom, how, when and by when never changes; the portal task
--                              (an UPLOAD_DOCUMENT task of its company about this request) and the link (of its company)
--                              each set once, on their own channel; the Candidate List version asked exactly for
--                              REACH_SVHC; reminders one at a time, later each, while it waits; the answer (its time, the
--                              party's DECLARATION upload in the company's portal for PORTAL, a file of this request for
--                              LINK and OFFICE) exactly when ANSWERED, ACCEPTED or REFUSED and never changed; the decision
--                              with its time, the decider's name and, refused, the reason; accepted only with every line
--                              answered and, for PORTAL, its upload accepted; a superseded request of the same kind and
--                              decided or cancelled. Never deleted.
--   SupplierDeclarationLine    written and removed only while its request is SENT, OVERDUE or ANSWERED (its row FOR
--                              SHARE); its request, material (never FINISHED), label and creation never change; the
--                              answer: none yet, no, or yes with above the threshold, the substance (ours or as named)
--                              and a concentration with its unit; an SVHC declaration names SVHCs, and in % w/w it is above
--                              the threshold exactly over 0.1 % (REACH art. 33).
--   TestPlanRule               a kind of material or one material (never FINISHED; of its company or tenant-wide),
--                              exactly one; a market code; the substance rule it proves of its company or tenant-wide and
--                              of its own test (CR_VI ↔ CR6; a CMR or OTHER rule any test); switched OFF exactly with the
--                              reason, every switch with its time; its company and creation never change. Archived, never
--                              deleted.
--   LabResult                  REDEFINED `factory_lab_result_guard` (…_quality_lab_guards, W1's whole body; never redefined
--                              since): a CR_VI result keeps every W1 rule word for word; a result of the new tests (AZO,
--                              NICKEL, PAH, DMFU, NPE, PFAS) names its method and unit (µg/cm²/week exactly for nickel
--                              release) and the substance rule's limit (valueMgKg, detectionLimitMgKg and limitMgKg then
--                              hold numbers in `unit`); below the limit PASS, above it FAIL, at the limit the rule's bound
--                              decides; a superseded result is of the same test.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the new checks are AFTER triggers (the
-- policies speak first), but the number guard and the refused deletes (BEFORE: the words come before a foreign key's; the
-- runtime roles have no DELETE grant on those tables anyway, so these speak to the owner). The tenant of a row is left to the
-- policies and the references, never compared here: a rule that reads another row skips a row this session cannot see. An
-- UPDATE that changes nothing passes.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers and
-- dates moved) and insert the copy: so a key is checked for its shape only (a copy's carries a suffix), the list version's day
-- is never compared with today (a copy's is a thousand years later), the first rows the seeds give are the plain ones (a
-- family of substances with no CAS number, a SENT request asked by the office with no task, an open line of it), and one
-- profile per material is the profile's id (the item's id, as ProductSettings'), not a unique index the copy would break.
--
-- USED FROM EARLIER WAVES, as they are: "factory_document_number_guard" (…_numbering_floor_documents_guards),
-- "factory_styles_distinct" (…_styles_libraries_w2b_guards), "factory_money_rome_day" (…_money_w2a_guards).

CREATE FUNCTION "factory_substances_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'substances: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['RestrictedSubstance', 'SubstanceRule', 'SvhcListVersion', 'MaterialComplianceProfile',
                              'SupplierDeclarationRequest', 'SupplierDeclarationLine', 'TestPlanRule'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_substances_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- Words of at most `longest` characters, not blank, without control characters; `lines`: line breaks and tabs allowed (NULL:
-- not given, which the caller allows or not).
CREATE FUNCTION "factory_substances_words_ok"(words text, longest integer, lines boolean) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT words IS NULL
      OR (btrim(words) <> '' AND char_length(words) <= longest
          AND CASE WHEN lines THEN words !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' ELSE words !~ '[[:cntrl:]]' END)
$$;

-- Words per language: null, or an object of language tags (BCP 47: "it", "en", "de-CH") to words of one line.
CREATE FUNCTION "factory_substances_i18n_ok"(words jsonb, longest integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT words IS NULL
      OR (jsonb_typeof(words) = 'object'
          AND NOT EXISTS (SELECT 1 FROM jsonb_each(words) AS e(tag, value)
                           WHERE e.tag !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' OR jsonb_typeof(e.value) <> 'string'
                              OR NOT "factory_substances_words_ok"(e.value #>> '{}', longest, false)))
$$;

-- A CAS Registry Number: 2 to 7 digits, 2 digits and the check digit (the other digits weighted 1, 2, 3 … from the right,
-- the sum mod 10). NULL: none.
CREATE FUNCTION "factory_substances_cas_ok"(cas text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  digits text;
  total integer := 0;
BEGIN
  IF cas IS NULL THEN
    RETURN true;
  END IF;
  IF cas !~ '^[1-9][0-9]{1,6}-[0-9]{2}-[0-9]$' THEN
    RETURN false;
  END IF;
  digits := reverse(replace(left(cas, length(cas) - 2), '-', ''));
  FOR i IN 1 .. length(digits) LOOP
    total := total + i * substr(digits, i, 1)::integer;
  END LOOP;
  RETURN total % 10 = right(cas, 1)::integer;
END
$$;

-- An EC number: NNN-NNN-R, R the six digits weighted 1 to 6 from the left, the sum mod 11. NULL: none.
CREATE FUNCTION "factory_substances_ec_ok"(ec text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  digits text;
  total integer := 0;
BEGIN
  IF ec IS NULL THEN
    RETURN true;
  END IF;
  IF ec !~ '^[0-9]{3}-[0-9]{3}-[0-9]$' THEN
    RETURN false;
  END IF;
  digits := replace(left(ec, 7), '-', '');
  FOR i IN 1 .. 6 LOOP
    total := total + i * substr(digits, i, 1)::integer;
  END LOOP;
  RETURN total % 11 = right(ec, 1)::integer;
END
$$;

-- A market code as the market profiles write it (a country, "UK", a part of one: "US-CA"). NULL: none.
CREATE FUNCTION "factory_substances_market_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NULL OR (length(code) <= 40 AND code ~ '^[A-Z]{2}(-[A-Za-z0-9]{1,8})*$')
$$;

-- An https link of at most 2000 characters, without spaces. NULL: none.
CREATE FUNCTION "factory_substances_https_ok"(url text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT url IS NULL OR (char_length(url) <= 2000 AND url ~ '^https://[^[:space:][:cntrl:]]+$')
$$;

-- A switch: ON has no reason; OFF says why in 1 to 500 characters (the Owner question it waits for).
CREATE FUNCTION "factory_substances_switch_ok"(switched_on boolean, off_reason text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN switched_on THEN off_reason IS NULL ELSE off_reason IS NOT NULL AND "factory_substances_words_ok"(off_reason, 500, true) END
$$;

-- =====================================================================================================================
-- RestrictedSubstance (PRD-318)
CREATE FUNCTION "factory_restricted_substance_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'substances: restricted substance % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'substances: the company and creation of restricted substance % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."casNumber" IS NOT NULL AND NEW."casNumber" IS DISTINCT FROM OLD."casNumber")
       OR (OLD."ecNumber" IS NOT NULL AND NEW."ecNumber" IS DISTINCT FROM OLD."ecNumber") THEN
      RAISE EXCEPTION 'substances: the CAS and EC numbers of restricted substance % are given once, never changed (archive it and add the right one)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_substances_cas_ok"(NEW."casNumber") OR NOT "factory_substances_ec_ok"(NEW."ecNumber") THEN
    RAISE EXCEPTION 'substances: restricted substance % has a CAS number (N…N-NN-R) and an EC number (NNN-NNN-R) with their check digits right, or none (CAS %, EC %)', NEW."id", NEW."casNumber", NEW."ecNumber"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_substances_words_ok"(NEW."name", 300, false) OR NOT "factory_substances_i18n_ok"(NEW."nameI18n", 300)
     OR NOT "factory_substances_words_ok"(NEW."note", 1000, true)
     OR (NEW."groupCode" IS NOT NULL AND NEW."groupCode" !~ '^[A-Z][A-Z0-9_]{0,39}$') THEN
    RAISE EXCEPTION 'substances: restricted substance % has a name of 1 to 300 characters (per language too), a group code of capitals, digits and _ (up to 40) or none, and a note up to 1000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lists" IS NULL OR cardinality(NEW."lists") = 0 OR NOT "factory_styles_distinct"(NEW."lists") THEN
    RAISE EXCEPTION 'substances: restricted substance % is on at least one list, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."annexXviiEntries" IS NULL OR NOT "factory_styles_distinct"(NEW."annexXviiEntries")
     OR (cardinality(NEW."annexXviiEntries") > 0) <> ('REACH_ANNEX_XVII' = ANY (NEW."lists"::text[]))
     OR EXISTS (SELECT 1 FROM unnest(NEW."annexXviiEntries") AS e(entry) WHERE e.entry !~ '^[1-9][0-9]{0,2}[a-z]?$') THEN
    RAISE EXCEPTION 'substances: restricted substance % names its REACH Annex XVII entries ("43", "46a"), each once, exactly when it is on REACH_ANNEX_XVII', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."svhcListVersionId" IS NOT NULL AND NOT ('SVHC' = ANY (NEW."lists"::text[])) THEN
    RAISE EXCEPTION 'substances: restricted substance % names the Candidate List version that added it only when it is on SVHC', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "RestrictedSubstance_guard" AFTER INSERT OR UPDATE ON "RestrictedSubstance"
  FOR EACH ROW EXECUTE FUNCTION "factory_restricted_substance_guard"();
CREATE TRIGGER "RestrictedSubstance_never_deleted" BEFORE DELETE ON "RestrictedSubstance"
  FOR EACH ROW EXECUTE FUNCTION "factory_restricted_substance_guard"();

-- One ACTIVE substance per CAS number in the tenant: an archived row keeps its number (a family has none). Prisma cannot
-- express a partial unique index.
CREATE UNIQUE INDEX "RestrictedSubstance_one_active_per_cas" ON "RestrictedSubstance" ("tenantId", "casNumber")
  WHERE "casNumber" IS NOT NULL AND "status" = 'ACTIVE';

-- =====================================================================================================================
-- SubstanceRule (PRD-319 to PRD-325, PRD-329)
CREATE FUNCTION "factory_substance_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  substance_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'substances: substance rule % is switched off or archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."key", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'substances: the company, key and creation of substance rule % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."switchedOn" <> OLD."switchedOn" AND (NEW."switchedAt" IS NULL OR NEW."switchedAt" IS NOT DISTINCT FROM OLD."switchedAt") THEN
      RAISE EXCEPTION 'substances: substance rule % is switched on or off with the time of the switch', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."key" !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' THEN
    RAISE EXCEPTION 'substances: the key of substance rule % is a letter or digit, then letters, digits, ".", "_" or "-", up to 80', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_substances_words_ok"(NEW."name", 300, false) OR NOT "factory_substances_i18n_ok"(NEW."nameI18n", 300)
     OR NOT "factory_substances_words_ok"(NEW."scopeNote", 1000, true) OR NOT "factory_substances_words_ok"(NEW."note", 1000, true)
     OR NOT "factory_substances_words_ok"(NEW."testMethod", 200, false) THEN
    RAISE EXCEPTION 'substances: substance rule % has a name of 1 to 300 characters (per language too), a test method up to 200, a scope note and a note up to 1000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."substanceId" IS NULL) = (NEW."substanceGroup" IS NULL)
     OR (NEW."substanceGroup" IS NOT NULL AND NEW."substanceGroup" !~ '^[A-Z][A-Z0-9_]{0,39}$') THEN
    RAISE EXCEPTION 'substances: substance rule % restricts one substance of the list or one group of it (a group code), exactly one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."substanceId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."substanceId" IS DISTINCT FROM OLD."substanceId") THEN
    SELECT s."companyId" INTO substance_company FROM "RestrictedSubstance" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."substanceId";
    IF FOUND AND substance_company IS NOT NULL AND substance_company IS DISTINCT FROM NEW."companyId" THEN
      RAISE EXCEPTION 'substances: substance rule % restricts a substance of its own company or a tenant-wide one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."materialKinds" IS NULL OR NEW."productTypes" IS NULL OR NEW."marketCodes" IS NULL
     OR NOT "factory_styles_distinct"(NEW."materialKinds") OR NOT "factory_styles_distinct"(NEW."productTypes")
     OR NOT "factory_styles_distinct"(NEW."marketCodes") OR 'FINISHED' = ANY (NEW."materialKinds"::text[])
     OR EXISTS (SELECT 1 FROM unnest(NEW."marketCodes") AS m(code) WHERE NOT "factory_substances_market_ok"(m.code)) THEN
    RAISE EXCEPTION 'substances: substance rule % applies to kinds of material (never FINISHED), product types and market codes ("IT", "US-CA"), each once (none: every one)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."limitValue" IS NULL) <> (NEW."limitUnit" IS NULL) OR (NEW."limitValue" IS NULL) <> (NEW."limitBound" IS NULL)
     OR NEW."limitValue" <= 0 THEN
    RAISE EXCEPTION 'substances: substance rule % has a limit above 0 with its unit and the side a value at it falls on, or none of the three', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."source" = 'CUSTOMER') <> (NEW."customerPartyId" IS NOT NULL) THEN
    RAISE EXCEPTION 'substances: substance rule % names the brand whose RSL it is exactly when it is a CUSTOMER rule', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."legalReference" IS NULL OR NOT "factory_substances_words_ok"(NEW."legalReference", 300, false)
     OR NOT "factory_substances_https_ok"(NEW."legalUrl") THEN
    RAISE EXCEPTION 'substances: substance rule % names its legal reference in 1 to 300 characters, and its link (https, up to 2000) or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_substances_switch_ok"(NEW."switchedOn", NEW."offReason") OR (NEW."switchedById" IS NOT NULL AND NEW."switchedAt" IS NULL) THEN
    RAISE EXCEPTION 'substances: substance rule % is ON with no reason, or OFF saying why in 1 to 500 characters (who switched it only with when)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SubstanceRule_guard" AFTER INSERT OR UPDATE ON "SubstanceRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_substance_rule_guard"();
CREATE TRIGGER "SubstanceRule_never_deleted" BEFORE DELETE ON "SubstanceRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_substance_rule_guard"();

-- =====================================================================================================================
-- SvhcListVersion (PRD-326)
CREATE FUNCTION "factory_svhc_list_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "RestrictedSubstance" s WHERE s."tenantId" = OLD."tenantId" AND s."svhcListVersionId" = OLD."id")
       OR EXISTS (SELECT 1 FROM "MaterialComplianceProfile" p WHERE p."tenantId" = OLD."tenantId" AND p."svhcListVersionId" = OLD."id")
       OR EXISTS (SELECT 1 FROM "SupplierDeclarationRequest" r
                   WHERE r."tenantId" = OLD."tenantId" AND (r."svhcListVersionId" = OLD."id" OR r."answeredListVersionId" = OLD."id")) THEN
      RAISE EXCEPTION 'substances: the Candidate List version of % is named by a substance, a material profile or a declaration request: it is kept', OLD."publishedOn"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."publishedOn", NEW."entryCount", NEW."source", NEW."sourceUrl", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."publishedOn", OLD."entryCount", OLD."source", OLD."sourceUrl", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'substances: what ECHA published in the Candidate List version of % (its day, entries and source) never changes; only its note', OLD."publishedOn"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."entryCount" < 1 OR NOT "factory_substances_words_ok"(NEW."source", 300, false) OR NEW."source" IS NULL
     OR NOT "factory_substances_https_ok"(NEW."sourceUrl") OR NOT "factory_substances_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'substances: the Candidate List version of % has its entries (from 1), its source in 1 to 300 characters, its page (https, up to 2000) or none, and a note up to 1000', NEW."publishedOn"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SvhcListVersion_kept" BEFORE DELETE ON "SvhcListVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_svhc_list_version_guard"();
CREATE TRIGGER "SvhcListVersion_guard" AFTER INSERT OR UPDATE ON "SvhcListVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_svhc_list_version_guard"();

-- =====================================================================================================================
-- MaterialComplianceProfile (PRD-303, PRD-314, PRD-326)
CREATE FUNCTION "factory_material_compliance_profile_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_kind text;
  item_seen boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'substances: the compliance profile % of a material is kept, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."itemId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."itemId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'substances: the material and creation of compliance profile % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT i."kind"::text INTO item_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
  item_seen := FOUND;
  IF item_seen AND item_kind = 'FINISHED' THEN
    RAISE EXCEPTION 'substances: compliance profile % is a material''s, never a finished garment''s', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."compositionConfirmedAt" IS NULL) <> (NEW."compositionConfirmedById" IS NULL)
     OR (NEW."tannageConfirmedAt" IS NULL) <> (NEW."tannageConfirmedById" IS NULL) THEN
    RAISE EXCEPTION 'substances: compliance profile % has each confirmation with its time and its person, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tannageConfirmedAt" IS NOT NULL AND item_seen AND item_kind <> 'LEATHER' THEN
    RAISE EXCEPTION 'substances: compliance profile % confirms a tannage only for a leather (this material is %)', NEW."id", item_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."originCountry" IS NOT NULL AND NEW."originCountry" !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'substances: compliance profile % names the country the material is made in by its ISO code (two capitals) or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."svhcSubstanceIds" IS NULL OR NOT "factory_styles_distinct"(NEW."svhcSubstanceIds")
     OR (NEW."svhcAboveThreshold" IS NULL) <> (NEW."svhcListVersionId" IS NULL)
     OR (NEW."svhcAboveThreshold" IS NOT DISTINCT FROM true) <> (cardinality(NEW."svhcSubstanceIds") > 0) THEN
    RAISE EXCEPTION 'substances: compliance profile % has its SVHC answer with the Candidate List version it was judged against, and names the SVHCs (each once) exactly when one is above 0.1 %% w/w', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."svhcSubstanceIds" IS DISTINCT FROM OLD."svhcSubstanceIds")
     AND EXISTS (SELECT 1 FROM unnest(NEW."svhcSubstanceIds") AS x(id)
                  WHERE NOT EXISTS (SELECT 1 FROM "RestrictedSubstance" s
                                     WHERE s."tenantId" = NEW."tenantId" AND s."id" = x.id AND 'SVHC' = ANY (s."lists"::text[]))) THEN
    RAISE EXCEPTION 'substances: compliance profile % names SVHCs of the substance list (on the Candidate List)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."applicableRuleIds" IS NULL OR NEW."testsNeeded" IS NULL OR NEW."declarationsNeeded" IS NULL
     OR NOT "factory_styles_distinct"(NEW."applicableRuleIds") OR NOT "factory_styles_distinct"(NEW."testsNeeded")
     OR NOT "factory_styles_distinct"(NEW."declarationsNeeded")
     OR (NEW."evaluatedAt" IS NULL AND (cardinality(NEW."applicableRuleIds") > 0 OR cardinality(NEW."testsNeeded") > 0 OR cardinality(NEW."declarationsNeeded") > 0)) THEN
    RAISE EXCEPTION 'substances: compliance profile % holds what the evaluator found (the rules, tests and declarations, each once) only with the time it ran', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."applicableRuleIds" IS DISTINCT FROM OLD."applicableRuleIds")
     AND EXISTS (SELECT 1 FROM unnest(NEW."applicableRuleIds") AS x(id)
                  WHERE NOT EXISTS (SELECT 1 FROM "SubstanceRule" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = x.id)) THEN
    RAISE EXCEPTION 'substances: compliance profile % names substance rules of the list', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."state" = 'BLOCKED' AND NEW."stateReason" IS NULL)
     OR (NEW."state" = 'COMPLETE' AND (NEW."stateReason" IS NOT NULL OR NEW."evaluatedAt" IS NULL))
     OR NOT "factory_substances_words_ok"(NEW."stateReason", 1000, true) OR NOT "factory_substances_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'substances: compliance profile % says why it is BLOCKED (1 to 1000 characters), is COMPLETE only once evaluated and with no reason, and has a note up to 1000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MaterialComplianceProfile_guard" AFTER INSERT OR UPDATE ON "MaterialComplianceProfile"
  FOR EACH ROW EXECUTE FUNCTION "factory_material_compliance_profile_guard"();
CREATE TRIGGER "MaterialComplianceProfile_never_deleted" BEFORE DELETE ON "MaterialComplianceProfile"
  FOR EACH ROW EXECUTE FUNCTION "factory_material_compliance_profile_guard"();

-- =====================================================================================================================
-- SupplierDeclarationRequest (PRD-304, PRD-326, PRD-329)
CREATE TRIGGER "SupplierDeclarationRequest_number" BEFORE INSERT OR UPDATE ON "SupplierDeclarationRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('declaration request', 'SUPPLIER_DECLARATION');

CREATE FUNCTION "factory_supplier_declaration_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rome_today date := "factory_money_rome_day"(now());
  party_company uuid;
  task_kind text;
  task_type text;
  task_record uuid;
  task_company uuid;
  link_company uuid;
  upload_company uuid;
  upload_category text;
  upload_status text;
  file_type text;
  file_record uuid;
  earlier_kind text;
  earlier_status text;
  all_lines integer;
  open_lines integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'substances: declaration request % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND (NEW."status" <> 'SENT' OR NEW."remindersSent" <> 0 OR NEW."lastRemindedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'substances: declaration request % starts SENT, with no reminder yet', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."status" IN ('ACCEPTED', 'REFUSED', 'CANCELLED')
       AND (to_jsonb(NEW) - ARRAY['internalNote', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['internalNote', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'substances: declaration request % is % and never changes again (only the office''s note); ask again with a new request', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."companyId", NEW."partyId", NEW."kind", NEW."svhcListVersionId", NEW."channel", NEW."message", NEW."sentAt", NEW."dueOn",
        NEW."supersedesId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."partyId", OLD."kind", OLD."svhcListVersionId", OLD."channel", OLD."message", OLD."sentAt", OLD."dueOn",
        OLD."supersedesId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'substances: what declaration request % asks, of whom, how, when and by when never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."partnerTaskId" IS NOT NULL AND NEW."partnerTaskId" IS DISTINCT FROM OLD."partnerTaskId")
       OR (OLD."linkId" IS NOT NULL AND NEW."linkId" IS DISTINCT FROM OLD."linkId") THEN
      RAISE EXCEPTION 'substances: the portal task and the link of declaration request % are set once, never changed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'SENT' AND NEW."status" IN ('ANSWERED', 'OVERDUE', 'CANCELLED'))
      OR (OLD."status" = 'OVERDUE' AND NEW."status" IN ('ANSWERED', 'CANCELLED'))
      OR (OLD."status" = 'ANSWERED' AND NEW."status" IN ('ACCEPTED', 'REFUSED'))) THEN
      RAISE EXCEPTION 'substances: declaration request % moves SENT → ANSWERED | OVERDUE | CANCELLED, OVERDUE → ANSWERED | CANCELLED, ANSWERED → ACCEPTED | REFUSED (not % → %)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'OVERDUE' AND OLD."status" <> 'OVERDUE' AND NEW."dueOn" >= rome_today THEN
      RAISE EXCEPTION 'substances: declaration request % is OVERDUE only after its due day (%)', OLD."id", NEW."dueOn"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."answeredAt" IS NOT NULL AND (NEW."answeredAt", NEW."uploadId", NEW."answerFileId") IS DISTINCT FROM (OLD."answeredAt", OLD."uploadId", OLD."answerFileId") THEN
      RAISE EXCEPTION 'substances: the answer of declaration request % never changes once it came; refuse it and ask again', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."remindersSent" <> OLD."remindersSent" OR NEW."lastRemindedAt" IS DISTINCT FROM OLD."lastRemindedAt" THEN
      IF OLD."status" NOT IN ('SENT', 'OVERDUE') OR NEW."remindersSent" <> OLD."remindersSent" + 1
         OR NEW."lastRemindedAt" IS NULL OR NEW."lastRemindedAt" <= coalesce(OLD."lastRemindedAt", OLD."sentAt") THEN
        RAISE EXCEPTION 'substances: declaration request % counts its reminders one at a time, each later than the last, while it waits for the answer', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."status" = 'ACCEPTED' AND OLD."status" <> 'ACCEPTED' THEN
      SELECT count(*)::integer, (count(*) FILTER (WHERE l."contains" IS NULL))::integer INTO all_lines, open_lines
        FROM "SupplierDeclarationLine" l WHERE l."tenantId" = NEW."tenantId" AND l."requestId" = NEW."id";
      IF all_lines = 0 OR open_lines > 0 THEN
        RAISE EXCEPTION 'substances: declaration request % is accepted with at least one material and an answer for each (% of % not answered)', OLD."id", open_lines, all_lines
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- Every row.
  IF (NEW."kind" = 'REACH_SVHC') <> (NEW."svhcListVersionId" IS NOT NULL)
     OR (NEW."answeredListVersionId" IS NOT NULL AND NEW."kind" <> 'REACH_SVHC') THEN
    RAISE EXCEPTION 'substances: declaration request % names the Candidate List version it asks about (and the one its answer states) exactly for a REACH_SVHC declaration', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."partnerTaskId" IS NOT NULL AND NEW."channel" <> 'PORTAL') OR (NEW."linkId" IS NOT NULL AND NEW."channel" <> 'LINK') THEN
    RAISE EXCEPTION 'substances: declaration request % names a portal task only when asked in the portal, a link only when asked by link', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."dueOn" < "factory_money_rome_day"(NEW."sentAt")
     OR NOT "factory_substances_words_ok"(NEW."message", 2000, true) OR NOT "factory_substances_words_ok"(NEW."internalNote", 2000, true) THEN
    RAISE EXCEPTION 'substances: declaration request % is due on or after the day it went out, with words up to 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."reminderEveryDays" IS NOT NULL AND (NEW."reminderEveryDays" < 1 OR NEW."reminderEveryDays" > 90))
     OR NEW."remindersSent" < 0 OR (NEW."remindersSent" = 0) <> (NEW."lastRemindedAt" IS NULL) THEN
    RAISE EXCEPTION 'substances: declaration request % reminds every 1 to 90 days or never, and counts the reminders sent with the last one''s time', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('ANSWERED', 'ACCEPTED', 'REFUSED')) <> (NEW."answeredAt" IS NOT NULL)
     OR (NEW."answeredAt" IS NULL AND (NEW."uploadId" IS NOT NULL OR NEW."answerFileId" IS NOT NULL OR NEW."answeredListVersionId" IS NOT NULL OR NEW."validTo" IS NOT NULL))
     OR (NEW."answeredAt" IS NOT NULL
         AND ((NEW."channel" = 'PORTAL' AND (NEW."uploadId" IS NULL OR NEW."answerFileId" IS NOT NULL))
           OR (NEW."channel" <> 'PORTAL' AND (NEW."answerFileId" IS NULL OR NEW."uploadId" IS NOT NULL))
           OR NEW."answeredAt" < NEW."sentAt"
           OR NEW."validTo" < "factory_money_rome_day"(NEW."answeredAt"))) THEN
    RAISE EXCEPTION 'substances: declaration request % has its answer exactly when ANSWERED, ACCEPTED or REFUSED: when it came (not before it went out), the party''s portal upload (PORTAL) or a file of the request (LINK, OFFICE), valid to a day not before it came or without end', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('ACCEPTED', 'REFUSED')) <> (NEW."decidedAt" IS NOT NULL)
     OR (NEW."decidedAt" IS NULL AND (NEW."decidedById" IS NOT NULL OR NEW."decidedByName" IS NOT NULL))
     OR (NEW."decidedAt" IS NOT NULL AND (NEW."decidedByName" IS NULL OR NOT "factory_substances_words_ok"(NEW."decidedByName", 200, false) OR NEW."decidedAt" < NEW."answeredAt"))
     OR (NEW."status" = 'REFUSED') <> (NEW."refuseReason" IS NOT NULL)
     OR (NEW."refuseReason" IS NOT NULL AND (char_length(btrim(NEW."refuseReason")) < 3 OR NOT "factory_substances_words_ok"(NEW."refuseReason", 500, true))) THEN
    RAISE EXCEPTION 'substances: declaration request % is decided (ACCEPTED or REFUSED) with when (not before its answer) and the name of who decided as the supplier reads it, and, refused, why in 3 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL)
     OR NOT "factory_substances_words_ok"(NEW."cancelReason", 500, true) THEN
    RAISE EXCEPTION 'substances: declaration request % is CANCELLED exactly with when and why (1 to 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it names (checked when it is set or changes; a row this session cannot see is skipped).
  IF TG_OP = 'INSERT' THEN
    SELECT p."companyId" INTO party_company FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND party_company IS NOT NULL AND party_company IS DISTINCT FROM NEW."companyId" THEN
      RAISE EXCEPTION 'substances: declaration request % asks a party of its company or a tenant-wide one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."partnerTaskId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."partnerTaskId" IS DISTINCT FROM OLD."partnerTaskId") THEN
    SELECT t."kind"::text, t."recordType", t."recordId", t."companyId" INTO task_kind, task_type, task_record, task_company
      FROM "PartnerTask" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."partnerTaskId";
    IF FOUND AND (task_kind <> 'UPLOAD_DOCUMENT' OR task_type <> 'SupplierDeclarationRequest' OR task_record <> NEW."id" OR task_company <> NEW."companyId") THEN
      RAISE EXCEPTION 'substances: the portal task of declaration request % is an UPLOAD_DOCUMENT task of its company about this request (it is % about % %)', NEW."id", task_kind, task_type, task_record
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."linkId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."linkId" IS DISTINCT FROM OLD."linkId") THEN
    SELECT l."companyId" INTO link_company FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."linkId";
    IF FOUND AND link_company IS DISTINCT FROM NEW."companyId" THEN
      RAISE EXCEPTION 'substances: the link of declaration request % is one of its company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."uploadId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."uploadId" IS DISTINCT FROM OLD."uploadId" OR NEW."status" <> OLD."status") THEN
    SELECT u."companyId", u."category"::text, u."status"::text INTO upload_company, upload_category, upload_status
      FROM "SupplierDocumentUpload" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."uploadId";
    IF FOUND AND (upload_company IS DISTINCT FROM NEW."companyId" OR upload_category <> 'DECLARATION') THEN
      RAISE EXCEPTION 'substances: the answer of declaration request % is a DECLARATION its party uploaded in its company''s portal (it is %)', NEW."id", upload_category
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND NEW."status" = 'ACCEPTED' AND upload_status <> 'ACCEPTED' THEN
      RAISE EXCEPTION 'substances: declaration request % is accepted with its portal upload accepted (the document in force; it is %)', NEW."id", upload_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."answerFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."answerFileId" IS DISTINCT FROM OLD."answerFileId") THEN
    SELECT f."recordType", f."recordId" INTO file_type, file_record FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."answerFileId";
    IF FOUND AND (file_type <> 'SupplierDeclarationRequest' OR file_record <> NEW."id") THEN
      RAISE EXCEPTION 'substances: the answer of declaration request % is a file of this request (it is a file of % %)', NEW."id", file_type, file_record
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."supersedesId" IS NOT NULL AND TG_OP = 'INSERT' THEN
    SELECT r."kind"::text, r."status"::text INTO earlier_kind, earlier_status
      FROM "SupplierDeclarationRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."supersedesId";
    IF NEW."supersedesId" = NEW."id" OR (FOUND AND (earlier_kind <> NEW."kind"::text OR earlier_status NOT IN ('ACCEPTED', 'REFUSED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'substances: declaration request % asks again a request of the same party and kind that was accepted, refused or cancelled (it is % %)', NEW."id", earlier_kind, earlier_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SupplierDeclarationRequest_guard" AFTER INSERT OR UPDATE ON "SupplierDeclarationRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_declaration_request_guard"();
CREATE TRIGGER "SupplierDeclarationRequest_never_deleted" BEFORE DELETE ON "SupplierDeclarationRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_declaration_request_guard"();

-- =====================================================================================================================
-- SupplierDeclarationLine (PRD-326, PRD-329)
CREATE FUNCTION "factory_supplier_declaration_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_state text;
  request_kind text;
  item_kind text;
  substance_lists text[];
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  SELECT r."status"::text, r."kind"::text INTO request_state, request_kind
    FROM "SupplierDeclarationRequest" r
   WHERE r."tenantId" = coalesce(NEW."tenantId", OLD."tenantId") AND r."id" = coalesce(NEW."requestId", OLD."requestId") FOR SHARE;
  IF FOUND AND request_state NOT IN ('SENT', 'OVERDUE', 'ANSWERED') THEN
    RAISE EXCEPTION 'substances: the lines of declaration request % change only while it waits or is answered (it is %)', coalesce(NEW."requestId", OLD."requestId"), request_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."partyId", NEW."requestId", NEW."itemId", NEW."articleLabel", NEW."createdAt", NEW."createdById")
                          IS DISTINCT FROM (OLD."partyId", OLD."requestId", OLD."itemId", OLD."articleLabel", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'substances: the request, material and creation of declaration line % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 1 OR NEW."articleLabel" IS NULL OR NOT "factory_substances_words_ok"(NEW."articleLabel", 200, false)
     OR NOT "factory_substances_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'substances: declaration line % has its place from 1, the material as the supplier knows it in 1 to 200 characters and a note up to 1000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT i."kind"::text INTO item_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND item_kind = 'FINISHED' THEN
      RAISE EXCEPTION 'substances: declaration line % asks about a material, never a finished garment', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."contains" IS NOT TRUE
      AND (NEW."aboveThreshold" IS NOT NULL OR NEW."substanceId" IS NOT NULL OR NEW."substanceName" IS NOT NULL
           OR NEW."concentration" IS NOT NULL OR NEW."concentrationUnit" IS NOT NULL))
     OR (NEW."contains" AND (NEW."aboveThreshold" IS NULL OR (NEW."substanceId" IS NULL AND NEW."substanceName" IS NULL)))
     OR (NEW."concentration" IS NULL) <> (NEW."concentrationUnit" IS NULL) OR NEW."concentration" < 0
     OR NOT "factory_substances_words_ok"(NEW."substanceName", 300, false) THEN
    RAISE EXCEPTION 'substances: declaration line % answers not yet or no with nothing more, or yes with whether above the threshold, the substance (of our list and/or as named, up to 300 characters) and its concentration (0 or more) with its unit or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF request_kind = 'REACH_SVHC' AND NEW."substanceId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."substanceId" IS DISTINCT FROM OLD."substanceId") THEN
    SELECT s."lists"::text[] INTO substance_lists FROM "RestrictedSubstance" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."substanceId";
    IF FOUND AND NOT ('SVHC' = ANY (substance_lists)) THEN
      RAISE EXCEPTION 'substances: declaration line % of an SVHC declaration names an SVHC of the Candidate List', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF request_kind = 'REACH_SVHC' AND NEW."concentrationUnit" = 'PERCENT_WW' AND NEW."aboveThreshold" IS DISTINCT FROM (NEW."concentration" > 0.1) THEN
    RAISE EXCEPTION 'substances: declaration line % is above the threshold exactly when its concentration is over 0.1 %% w/w (REACH art. 33)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SupplierDeclarationLine_guard" AFTER INSERT OR UPDATE OR DELETE ON "SupplierDeclarationLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_declaration_line_guard"();

-- =====================================================================================================================
-- TestPlanRule (PRD-309)
CREATE FUNCTION "factory_test_plan_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_kind text;
  item_company uuid;
  rule_company uuid;
  rule_code text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'substances: test plan rule % is switched off or archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'substances: the company and creation of test plan rule % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."switchedOn" <> OLD."switchedOn" AND (NEW."switchedAt" IS NULL OR NEW."switchedAt" IS NOT DISTINCT FROM OLD."switchedAt") THEN
      RAISE EXCEPTION 'substances: test plan rule % is switched on or off with the time of the switch', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."itemKind" IS NULL) = (NEW."itemId" IS NULL) OR NEW."itemKind" IS NOT DISTINCT FROM 'FINISHED' THEN
    RAISE EXCEPTION 'substances: test plan rule % applies to a kind of material (never FINISHED) or to one material, exactly one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."itemId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."itemId" IS DISTINCT FROM OLD."itemId") THEN
    SELECT i."kind"::text, i."companyId" INTO item_kind, item_company FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND (item_kind = 'FINISHED' OR (item_company IS NOT NULL AND item_company IS DISTINCT FROM NEW."companyId")) THEN
      RAISE EXCEPTION 'substances: test plan rule % applies to a material of its company or a tenant-wide one, never a finished garment', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_substances_market_ok"(NEW."marketCode") OR NOT "factory_substances_words_ok"(NEW."method", 200, false)
     OR NOT "factory_substances_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'substances: test plan rule % names a market code ("IT", "US-CA") or none, a method up to 200 characters and a note up to 1000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_substances_switch_ok"(NEW."switchedOn", NEW."offReason") OR (NEW."switchedById" IS NOT NULL AND NEW."switchedAt" IS NULL) THEN
    RAISE EXCEPTION 'substances: test plan rule % is ON with no reason, or OFF saying why in 1 to 500 characters (who switched it only with when)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."substanceRuleId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."substanceRuleId", NEW."test") IS DISTINCT FROM (OLD."substanceRuleId", OLD."test")) THEN
    SELECT r."companyId", r."code"::text INTO rule_company, rule_code FROM "SubstanceRule" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."substanceRuleId";
    IF FOUND AND ((rule_company IS NOT NULL AND rule_company IS DISTINCT FROM NEW."companyId")
                  OR (rule_code NOT IN ('CMR', 'OTHER') AND rule_code <> CASE NEW."test"::text WHEN 'CR_VI' THEN 'CR6' ELSE NEW."test"::text END)) THEN
      RAISE EXCEPTION 'substances: test plan rule % proves a substance rule of its company or a tenant-wide one, of its own test (a % rule for a % test)', NEW."id", rule_code, NEW."test"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "TestPlanRule_guard" AFTER INSERT OR UPDATE ON "TestPlanRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_test_plan_rule_guard"();
CREATE TRIGGER "TestPlanRule_never_deleted" BEFORE DELETE ON "TestPlanRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_test_plan_rule_guard"();

-- =====================================================================================================================
-- LabResult: REDEFINED `factory_lab_result_guard` (…_quality_lab_guards, W1's whole body, never redefined since). Kept word
-- for word for CR_VI. New: a result of another test (AZO, NICKEL, PAH, DMFU, NPE, PFAS) names its method and unit and is
-- judged against the substance rule's limit (the API's; the lot's chromium VI limit is not read), at the limit as the rule's
-- bound says; a superseded result is of the same test.
CREATE OR REPLACE FUNCTION "factory_lab_result_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lot_limit numeric;
  lot_needs_test boolean;
  file_kind text;
  earlier_verdict text;
  earlier_test text;
BEGIN
  IF NEW."test" = 'CR_VI' THEN
    IF NEW."unit" <> 'mg/kg' OR NEW."method" NOT IN ('EN ISO 17075-1', 'EN ISO 17075-2') THEN
      RAISE EXCEPTION 'quality lab: lab result % is a chromium VI result in mg/kg, by EN ISO 17075-1 or -2', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."unit" NOT IN ('mg/kg', 'µg/kg', '% w/w', 'µg/m²', 'µg/cm²/week')
        OR (NEW."test" = 'NICKEL') <> (NEW."unit" = 'µg/cm²/week')
        OR NEW."method" IS NULL OR btrim(NEW."method") = '' OR char_length(NEW."method") > 200 OR NEW."method" ~ '[[:cntrl:]]'
        OR NEW."limitMgKg" <= 0 THEN
    RAISE EXCEPTION 'quality lab: lab result % of a % test names its method (up to 200 characters), its unit (mg/kg, µg/kg, %% w/w or µg/m²; µg/cm²/week exactly for nickel release, EN 1811) and its substance rule''s limit, above 0', NEW."id", NEW."test"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."belowDetectionLimit" <> (NEW."valueMgKg" IS NULL)
     OR NEW."belowDetectionLimit" <> (NEW."detectionLimitMgKg" IS NOT NULL)
     OR NEW."valueMgKg" < 0 OR NEW."detectionLimitMgKg" <= 0 THEN
    RAISE EXCEPTION 'quality lab: lab result % has a measured value (from 0) or is below a detection limit (above 0), exactly one of them', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."test" = 'CR_VI' THEN
    SELECT l."crViLimitMgKg", l."requiresCrViTest" INTO lot_limit, lot_needs_test
      FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."lotId";
    IF FOUND AND (NOT lot_needs_test OR lot_limit IS DISTINCT FROM NEW."limitMgKg") THEN
      RAISE EXCEPTION 'quality lab: lab result % is judged against its lot''s own chromium VI limit (% mg/kg), on a lot that needs the test', NEW."id", lot_limit
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."valueMgKg" IS NOT NULL AND NEW."verdict"::text <> CASE WHEN NEW."valueMgKg" < NEW."limitMgKg" THEN 'PASS' ELSE 'FAIL' END)
       OR (NEW."belowDetectionLimit" AND (NEW."verdict" <> 'PASS' OR NEW."detectionLimitMgKg" > NEW."limitMgKg")) THEN
      RAISE EXCEPTION 'quality lab: lab result % is the value against the limit of % mg/kg (below PASS, at or above FAIL; below a detection limit only at or below the limit)', NEW."id", NEW."limitMgKg"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW."valueMgKg" IS NOT NULL
         AND ((NEW."valueMgKg" < NEW."limitMgKg" AND NEW."verdict" <> 'PASS') OR (NEW."valueMgKg" > NEW."limitMgKg" AND NEW."verdict" <> 'FAIL')))
        OR (NEW."belowDetectionLimit" AND (NEW."verdict" <> 'PASS' OR NEW."detectionLimitMgKg" > NEW."limitMgKg")) THEN
    RAISE EXCEPTION 'quality lab: lab result % is the value against the limit of % % (below PASS, above FAIL, at the limit as its substance rule says; below a detection limit only at or below the limit)', NEW."id", NEW."limitMgKg", NEW."unit"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."evidence" = 'SUPPLIER_REPORT' AND (coalesce(btrim(NEW."article"), '') = '' OR NEW."periodFrom" IS NULL OR NEW."periodTo" IS NULL OR NEW."periodFrom" > NEW."periodTo"))
     OR (NEW."evidence" = 'LOT_REPORT' AND (NEW."article" IS NOT NULL OR NEW."periodFrom" IS NOT NULL OR NEW."periodTo" IS NOT NULL)) THEN
    RAISE EXCEPTION 'quality lab: lab result % names the article and the period of a supplier report, and none for a lab report on the lot', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT f."kind"::text INTO file_kind FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF FOUND AND file_kind <> 'CERTIFICATE' THEN
    RAISE EXCEPTION 'quality lab: the report of lab result % is a CERTIFICATE file, not %', NEW."id", file_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supersedesId" IS NOT NULL THEN
    SELECT r."verdict"::text, r."test"::text INTO earlier_verdict, earlier_test FROM "LabResult" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."supersedesId";
    IF NEW."verdict" <> 'FAIL' OR earlier_verdict IS DISTINCT FROM 'PASS' THEN
      RAISE EXCEPTION 'quality lab: lab result % supersedes a PASS of its lot, and only as a FAIL on later evidence', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF earlier_test IS DISTINCT FROM NEW."test"::text THEN
      RAISE EXCEPTION 'quality lab: lab result % supersedes a result of its own test (a % result, not %)', NEW."id", NEW."test", earlier_test
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
