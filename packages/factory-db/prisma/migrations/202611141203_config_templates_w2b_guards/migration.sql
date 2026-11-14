-- Written by hand (Prisma does not model triggers or partial indexes), after the generated …_config_templates_w2b_schema
-- and before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Configuration without code (W2b-6, schema wave 56/57, B-W2b-379; config.prisma; PLT-111, PLT-115, PLT-231, PLT-232,
-- COL-016; and B-W2b-374's schema need, the options a quote template line starts with). These rules hold for every login,
-- the owner included; apps/factory-api's commands (B-W2b-421, B-W2b-422) check them first in words. Every refusal is a
-- check_violation (SQLSTATE 23514) in words. The row guards are AFTER triggers (the policies speak first); the refused
-- deletes are BEFORE triggers. An UPDATE that changes nothing passes. A rule that reads another row skips a row the session
-- cannot see.
--
--   CustomField              record type a table of the tenant; code and key (`field:<recordType>:<code>`); labels IT/EN; the
--                            section a code, its place 0-9999; a unit only on NUMBER; the grain exactly with the MONEY audience,
--                            a MONEY field always MONEY; shown in the portal only INTERNAL or a price; a list exactly on SELECT
--                            and MULTI_SELECT (its company's or every company's; active when the field is made or restored); a
--                            linked record type exactly on LINK; company, record type, code, type, list and link fixed. Archived,
--                            never deleted.
--   CustomFieldValue         its field's record type, a record of it that exists (of the field's company when the record has
--                            one); the key `value:<fieldId>:<recordId>`; the value in the shape of the field's type (a list's
--                            code, active when newly written; an office person; a record of the linked type; an available
--                            file of the record); changed at a time not in the future, moving forward with the value; field
--                            and record fixed; an archived field's values neither written nor removed.
--   Picklist, PicklistValue  codes and keys (`picklist:<code>`, `option:<picklistId>:<code>`); labels; a value's swatch, icon,
--                            place and description; a value added to an active list only; a list archived only while no active
--                            field picks from it; company, codes fixed. Never deleted.
--   DocumentTemplate,        born DRAFT; DRAFT → ACTIVE (published with when and by whom, once) → RETIRED (when); the words
--   EmailTemplate            frozen once published, a RETIRED version frozen whole; the key per version; the language; the
--                            words' lengths and placeholders `{{name}}`; one ACTIVE per company, kind and language (a document)
--                            or per event, company or every company, and language (a mail): the partial unique indexes
--                            below. Only a DRAFT is removed.
--   MessageTemplate          a name, a language, a body with placeholders, a record type of the tenant or none, an office
--                            person as its owner or none (shared).
--   QuoteTemplateLineOption  as a quote line's option (…_sales_pricing_w2b_guards, …_followups_sales_w2b5_guards): line, group,
--                            value fixed; not on a FEE line; the group offered by the line's style; the free text exactly when
--                            the value takes one; a material's colour only with the material; a COLOUR group's option picks no
--                            material, a MATERIAL group's no library colour. Own triggers `QuoteTemplateLine_options_check` (a
--                            line with options becomes no fee and keeps its style) and `OptionGroup_template_takes_check` (a
--                            group takes a colour or a material only while none of its template options picks the other kind);
--                            the sales pricing and the W2b-5 follow-up functions stay as they are.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed) and insert the copy:
-- every each-once rule here is a `key` text (the suffix is allowed after it, as `factory_privacy_ops_key_ok` reads it) or a
-- partial unique index of rows the copy is not (the first versions are DRAFTs).
--
-- Reused as they are: recall's `factory_recall_words_ok`, `factory_recall_not_future`, `factory_recall_model_name_ok`, and the
-- privacy step's `factory_privacy_ops_key_ok`. No earlier function is redefined.

CREATE FUNCTION "factory_config_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'configuration: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['CustomField', 'CustomFieldValue', 'Picklist', 'PicklistValue', 'DocumentTemplate', 'EmailTemplate',
                              'MessageTemplate', 'QuoteTemplateLineOption'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_config_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

CREATE FUNCTION "factory_config_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fields: % % is kept, never deleted: archive or deactivate it (records keep what it names)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

-- =====================================================================================================================
-- Helpers

-- A code of ours: lower-case letters, digits and underscores, from a letter, 1 to 40 characters (`heat_number`).
CREATE FUNCTION "factory_config_code_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NOT NULL AND code ~ '^[a-z][a-z0-9_]{0,39}$'
$$;

-- A label: one line of 1 to 80 characters.
CREATE FUNCTION "factory_config_label_ok"(label text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT label IS NOT NULL AND "factory_recall_words_ok"(label, 80, false)
$$;

-- A language: ISO 639-1, two lower-case letters.
CREATE FUNCTION "factory_config_language_ok"(language text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT language IS NOT NULL AND language ~ '^[a-z]{2}$'
$$;

-- Words with placeholders: every `{{` and `}}` belongs to a placeholder `{{name}}` or `{{record.name}}` (letters, digits and
-- underscores from a letter, up to five dotted parts, a space allowed inside each brace). NULL: no words.
CREATE FUNCTION "factory_config_placeholders_ok"(words text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT words IS NULL
      OR regexp_replace(words, '\{\{ ?[A-Za-z][A-Za-z0-9_]{0,59}(\.[A-Za-z][A-Za-z0-9_]{0,59}){0,4} ?\}\}', '', 'g') !~ '\{\{|\}\}'
$$;

-- A record type that takes custom values, links and saved replies: a model name that is a table of the tenant (with its
-- "id" and "tenantId").
CREATE FUNCTION "factory_config_record_type_ok"(record_type text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT "factory_recall_model_name_ok"(record_type)
     AND to_regclass(quote_ident(record_type)) IS NOT NULL
     AND (SELECT count(*) FROM pg_attribute a
           WHERE a."attrelid" = to_regclass(quote_ident(record_type)) AND a."attname" IN ('id', 'tenantId') AND a."attnum" > 0
             AND NOT a."attisdropped") = 2
$$;

-- A record of a record type (checked by factory_config_record_type_ok first): whether the tenant's row with this id exists
-- (a row the session cannot see counts as missing), and its company when its table has one.
CREATE FUNCTION "factory_config_row_company"(record_type text, tenant uuid, record_id uuid, OUT present boolean, OUT company uuid)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a."attrelid" = to_regclass(quote_ident(record_type)) AND a."attname" = 'companyId' AND a."attnum" > 0 AND NOT a."attisdropped") THEN
    EXECUTE format('SELECT true, r."companyId"::uuid FROM %I r WHERE r."tenantId" = $1 AND r."id" = $2', record_type) INTO present, company USING tenant, record_id;
  ELSE
    EXECUTE format('SELECT true FROM %I r WHERE r."tenantId" = $1 AND r."id" = $2', record_type) INTO present USING tenant, record_id;
  END IF;
  present := coalesce(present, false);
END
$$;

-- A day as a value holds it: `YYYY-MM-DD`, a day of the calendar.
CREATE FUNCTION "factory_config_day_ok"(day text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND to_char(day::date, 'YYYY-MM-DD') = day;
EXCEPTION WHEN others THEN
  RETURN false;
END
$$;

-- A uuid as a value holds it (lower case, with its dashes).
CREATE FUNCTION "factory_config_uuid_ok"(id text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT id IS NOT NULL AND id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- =====================================================================================================================
-- CustomField (PLT-111)
--   every row  the record type a table of the tenant; the code; the key `field:<recordType>:<code>` (each code once per record
--              type: the unique key); labels IT/EN one line of 1 to 80; the section a code; its place 0 to 9999; a unit (one
--              line of 1 to 20) only on a NUMBER field; the grain (price, cost, margin, wages, pay) exactly with the MONEY
--              audience, and a MONEY field always has it; shown in the portal only with the INTERNAL audience or as a price;
--              a list exactly on SELECT and MULTI_SELECT, a linked record type (a table of the tenant) exactly on LINK; when
--              the field is made or restored, its list active and of its company or every company's (a field of every
--              company: a list of every company).
--   UPDATE     an UPDATE that changes nothing passes; the company, record type, code, key, type, list, linked record type
--              and creation never change.
--   DELETE     refused (archived instead). TRUNCATE refused.
CREATE FUNCTION "factory_custom_field_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  list_company uuid;
  list_status text;
  list_code text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."recordType", NEW."code", NEW."key", NEW."type", NEW."picklistId", NEW."linkTo", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."recordType", OLD."code", OLD."key", OLD."type", OLD."picklistId", OLD."linkTo", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'fields: the company, record type, code, type, list and linked record type of custom field % never change (another field is another row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_config_record_type_ok"(NEW."recordType") THEN
    RAISE EXCEPTION 'fields: custom field % is added to a record type that is a table of the tenant (a model name), not %', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_config_code_ok"(NEW."code") THEN
    RAISE EXCEPTION 'fields: the code of custom field % is lower-case letters, digits and underscores, from a letter, up to 40 characters (not %)', NEW."id", NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_key_ok"(NEW."key", concat('field:', NEW."recordType", ':', NEW."code")) THEN
    RAISE EXCEPTION 'fields: the key of custom field % is field:<record type>:<code> (each code once per record type)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_config_label_ok"(NEW."labelIt") OR NOT "factory_config_label_ok"(NEW."labelEn") THEN
    RAISE EXCEPTION 'fields: custom field % has a label in Italian and in English, one line of 1 to 80 characters each', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_config_code_ok"(NEW."section") OR NEW."sortOrder" NOT BETWEEN 0 AND 9999 THEN
    RAISE EXCEPTION 'fields: custom field % sits in a form section named by its key (lower-case letters, digits and underscores) at a place from 0 to 9999', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."unit" IS NOT NULL AND (NEW."type" <> 'NUMBER' OR NOT "factory_recall_words_ok"(NEW."unit", 20, false)) THEN
    RAISE EXCEPTION 'fields: only a NUMBER field has a unit (one line of 1 to 20 characters); custom field % is %', NEW."id", NEW."type"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."audience" = 'MONEY') <> (NEW."grain" IS NOT NULL)
     OR (NEW."grain" IS NOT NULL AND NEW."grain" NOT IN ('price', 'cost', 'margin', 'wages', 'pay')) THEN
    RAISE EXCEPTION 'fields: custom field % names the grain of its money (price, cost, margin, wages or pay) exactly when only people with that grain see it (MONEY)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."type" = 'MONEY' AND NEW."audience" <> 'MONEY' THEN
    RAISE EXCEPTION 'fields: money field % is seen only by people with its grain (the MONEY audience), like a built-in money field', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shownInPortal" AND NOT (NEW."audience" = 'INTERNAL' OR (NEW."audience" = 'MONEY' AND NEW."grain" = 'price')) THEN
    RAISE EXCEPTION 'fields: custom field % is shown in the portal only when every office person sees it or it is a price: never personal data, a cost, a margin, wages or pay', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."type" IN ('SELECT', 'MULTI_SELECT')) <> (NEW."picklistId" IS NOT NULL) THEN
    RAISE EXCEPTION 'fields: custom field % picks from a list exactly when it is a SELECT or MULTI_SELECT field', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."type" = 'LINK') <> (NEW."linkTo" IS NOT NULL) OR (NEW."linkTo" IS NOT NULL AND NOT "factory_config_record_type_ok"(NEW."linkTo")) THEN
    RAISE EXCEPTION 'fields: custom field % links to a record type (a table of the tenant) exactly when it is a LINK field', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."picklistId" IS NOT NULL AND NEW."status" = 'ACTIVE' AND (TG_OP = 'INSERT' OR OLD."status" <> 'ACTIVE') THEN
    -- Read FOR SHARE: archiving the list waits for this field, and sees it.
    SELECT p."companyId", p."status"::text, p."code" INTO list_company, list_status, list_code
      FROM "Picklist" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."picklistId" FOR SHARE;
    IF FOUND THEN
      IF list_company IS NOT NULL AND list_company IS DISTINCT FROM NEW."companyId" THEN
        RAISE EXCEPTION 'fields: custom field % picks from a list of its own company or of every company (a field of every company: a list of every company; list % is of company %)', NEW."id", list_code, list_company
          USING ERRCODE = 'check_violation';
      END IF;
      IF list_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'fields: custom field % picks from list %, which is archived: restore the list first', NEW."id", list_code
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "CustomField_guard" AFTER INSERT OR UPDATE ON "CustomField"
  FOR EACH ROW EXECUTE FUNCTION "factory_custom_field_guard"();
CREATE TRIGGER "CustomField_never_deleted" BEFORE DELETE ON "CustomField"
  FOR EACH ROW EXECUTE FUNCTION "factory_config_never_deleted"();

-- =====================================================================================================================
-- CustomFieldValue (PLT-111): the shape of a value per field type (CustomFieldType), the problem in words or NULL. A list's
-- code must be one of the list's values; one the value did not hold before must be active (a deactivated value stays where it
-- is). A PERSON, LINK or FILE is checked when it is written or changed (a person who left stays on the records they are on).
CREATE FUNCTION "factory_custom_field_value_problem"(field_type text, list_id uuid, link_to text, tenant uuid, record_type text, record_id uuid, val jsonb, old_val jsonb)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  kind text := jsonb_typeof(val);
  codes text[];
  old_codes text[] := ARRAY[]::text[];
  listed text;
  person_audience text;
  file_type text;
  file_record uuid;
  file_status text;
BEGIN
  IF val IS NULL OR kind = 'null' THEN
    RETURN 'a value is never empty (a value is cleared by removing it)';
  END IF;
  IF field_type = 'TEXT' THEN
    IF kind <> 'string' OR NOT "factory_recall_words_ok"(val #>> '{}', 4000, true) THEN
      RETURN 'a TEXT value is a string of 1 to 4000 characters';
    END IF;
  ELSIF field_type = 'NUMBER' THEN
    IF kind <> 'number' THEN
      RETURN 'a NUMBER value is a number';
    END IF;
    IF abs((val #>> '{}')::numeric) >= 1e15 THEN
      RETURN 'a NUMBER value is below 10^15';
    END IF;
  ELSIF field_type = 'MONEY' THEN
    IF kind <> 'object' THEN
      RETURN 'a MONEY value is { "amount": <whole minor units>, "currency": "<ISO 4217>" }';
    END IF;
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(val) k) IS DISTINCT FROM ARRAY['amount', 'currency']::text[]
       OR jsonb_typeof(val -> 'amount') IS DISTINCT FROM 'number' OR jsonb_typeof(val -> 'currency') IS DISTINCT FROM 'string' THEN
      RETURN 'a MONEY value is { "amount": <whole minor units>, "currency": "<ISO 4217>" }';
    END IF;
    IF (val ->> 'amount')::numeric <> trunc((val ->> 'amount')::numeric) OR abs((val ->> 'amount')::numeric) >= 1e15
       OR (val ->> 'currency') !~ '^[A-Z]{3}$' THEN
      RETURN 'a MONEY value is a whole number of minor units below 10^15 with its currency (three capitals, ISO 4217)';
    END IF;
  ELSIF field_type = 'DATE' THEN
    IF kind <> 'string' OR NOT "factory_config_day_ok"(val #>> '{}') THEN
      RETURN 'a DATE value is a day, YYYY-MM-DD';
    END IF;
  ELSIF field_type = 'YES_NO' THEN
    IF kind <> 'boolean' THEN
      RETURN 'a YES_NO value is true or false';
    END IF;
  ELSIF field_type = 'SELECT' THEN
    IF kind <> 'string' THEN
      RETURN 'a SELECT value is one value code of its list';
    END IF;
    codes := ARRAY[val #>> '{}'];
  ELSIF field_type = 'MULTI_SELECT' THEN
    IF kind <> 'array' THEN
      RETURN 'a MULTI_SELECT value is a list of 1 to 100 value codes of its list, each once';
    END IF;
    IF jsonb_array_length(val) NOT BETWEEN 1 AND 100
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(val) e WHERE jsonb_typeof(e) <> 'string')
       OR (SELECT count(DISTINCT e) FROM jsonb_array_elements_text(val) e) <> jsonb_array_length(val) THEN
      RETURN 'a MULTI_SELECT value is a list of 1 to 100 value codes of its list, each once';
    END IF;
    codes := ARRAY(SELECT jsonb_array_elements_text(val));
  ELSIF field_type IN ('PERSON', 'LINK', 'FILE') THEN
    IF kind <> 'string' OR NOT "factory_config_uuid_ok"(val #>> '{}') THEN
      RETURN format('a %s value is an id (a uuid)', field_type);
    END IF;
    IF val IS NOT DISTINCT FROM old_val THEN
      RETURN NULL;
    END IF;
    IF field_type = 'PERSON' THEN
      SELECT u."audience"::text INTO person_audience FROM "User" u WHERE u."tenantId" = tenant AND u."id" = (val #>> '{}')::uuid;
      IF person_audience IS DISTINCT FROM 'OFFICE' THEN
        RETURN 'a PERSON value is an office person of the tenant';
      END IF;
    ELSIF field_type = 'LINK' THEN
      IF NOT (SELECT r.present FROM "factory_config_row_company"(link_to, tenant, (val #>> '{}')::uuid) r) THEN
        RETURN format('a LINK value is the id of a %s record that exists', link_to);
      END IF;
    ELSE
      SELECT f."recordType", f."recordId", f."status"::text INTO file_type, file_record, file_status
        FROM "StoredFile" f WHERE f."tenantId" = tenant AND f."id" = (val #>> '{}')::uuid;
      IF NOT FOUND OR (file_type, file_record) IS DISTINCT FROM (record_type, record_id) OR file_status <> 'AVAILABLE' THEN
        RETURN 'a FILE value is an available file of the record';
      END IF;
    END IF;
  ELSE
    RETURN format('a field of type %s takes no value here', field_type);
  END IF;

  IF codes IS NOT NULL THEN
    SELECT string_agg(c, ', ') INTO listed FROM unnest(codes) c
     WHERE NOT EXISTS (SELECT 1 FROM "PicklistValue" v WHERE v."tenantId" = tenant AND v."picklistId" = list_id AND v."code" = c);
    IF listed IS NOT NULL THEN
      RETURN format('%s is not a value of its list', listed);
    END IF;
    IF jsonb_typeof(old_val) = 'string' THEN
      old_codes := ARRAY[old_val #>> '{}'];
    ELSIF jsonb_typeof(old_val) = 'array' THEN
      old_codes := ARRAY(SELECT jsonb_array_elements_text(old_val));
    END IF;
    SELECT string_agg(c, ', ') INTO listed FROM unnest(codes) c
     WHERE c <> ALL (old_codes)
       AND NOT EXISTS (SELECT 1 FROM "PicklistValue" v WHERE v."tenantId" = tenant AND v."picklistId" = list_id AND v."code" = c AND v."active");
    IF listed IS NOT NULL THEN
      RETURN format('%s is deactivated: it stays on the records that have it, and is chosen no more', listed);
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- CustomFieldValue
--   INSERT     the record exists (its table is the field's record type) and, when the field has a company and the record
--              has one, is of that company.
--   every row  its field active (read FOR SHARE: archiving waits); the field's record type; the key
--              `value:<fieldId>:<recordId>` (one value per field and record); the value in the shape of the field's type
--              (factory_custom_field_value_problem); changed not in the future.
--   UPDATE     an UPDATE that changes nothing passes; the field, the record, the key and the creation never change; a new
--              value comes with a later change time.
--   DELETE     only while its field is active (an archived field's values are kept as they are). TRUNCATE refused.
CREATE FUNCTION "factory_custom_field_value_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  field_status text;
  field_code text;
  field_type text;
  field_record_type text;
  field_company uuid;
  field_list uuid;
  field_link text;
  record_present boolean;
  record_company uuid;
  problem text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT f."status"::text, f."code" INTO field_status, field_code
      FROM "CustomField" f WHERE f."tenantId" = OLD."tenantId" AND f."id" = OLD."fieldId" FOR SHARE;
    IF field_status = 'ARCHIVED' THEN
      RAISE EXCEPTION 'fields: custom field % is archived: its values are kept as they are (restore it to clear one)', field_code
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."fieldId", NEW."recordType", NEW."recordId", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."fieldId", OLD."recordType", OLD."recordId", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'fields: custom value % keeps its field and record (another record''s value is another row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT f."status"::text, f."code", f."type"::text, f."recordType", f."companyId", f."picklistId", f."linkTo"
    INTO field_status, field_code, field_type, field_record_type, field_company, field_list, field_link
    FROM "CustomField" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fieldId" FOR SHARE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF field_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'fields: custom field % is archived: it takes no new value and its values change no more', field_code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."recordType" IS DISTINCT FROM field_record_type THEN
    RAISE EXCEPTION 'fields: custom value % is of a % record, as its field % (not %)', NEW."id", field_record_type, field_code, NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_key_ok"(NEW."key", concat('value:', NEW."fieldId", ':', NEW."recordId")) THEN
    RAISE EXCEPTION 'fields: the key of custom value % is value:<field>:<record> (one value per field and record)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT r.present, r.company INTO record_present, record_company FROM "factory_config_row_company"(NEW."recordType", NEW."tenantId", NEW."recordId") r;
    IF NOT record_present THEN
      RAISE EXCEPTION 'fields: custom value % is of a % % that does not exist', NEW."id", NEW."recordType", NEW."recordId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF field_company IS NOT NULL AND record_company IS NOT NULL AND record_company <> field_company THEN
      RAISE EXCEPTION 'fields: custom value % is of a record of company %, and field % is of company % only', NEW."id", record_company, field_code, field_company
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_not_future"(NEW."changedAt") THEN
    RAISE EXCEPTION 'fields: custom value % was not changed in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."value" IS DISTINCT FROM OLD."value" AND NEW."changedAt" <= OLD."changedAt" THEN
    RAISE EXCEPTION 'fields: custom value % names when its new value was written: later than its last change', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."value" IS DISTINCT FROM OLD."value" THEN
    problem := "factory_custom_field_value_problem"(field_type, field_list, field_link, NEW."tenantId", NEW."recordType", NEW."recordId", NEW."value",
                                                    CASE WHEN TG_OP = 'UPDATE' THEN OLD."value" END);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'fields: custom value % of field %: %', NEW."id", field_code, problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "CustomFieldValue_guard" AFTER INSERT OR UPDATE OR DELETE ON "CustomFieldValue"
  FOR EACH ROW EXECUTE FUNCTION "factory_custom_field_value_guard"();

-- =====================================================================================================================
-- Picklist (PLT-115)
--   every row  the code; the key `picklist:<code>` (each code once in the tenant); labels IT/EN.
--   UPDATE     an UPDATE that changes nothing passes; the company, code, key and creation never change; archived only while no
--              active field picks from it.
--   DELETE     refused (archived instead). TRUNCATE refused.
CREATE FUNCTION "factory_picklist_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  field_code text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."code", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."code", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'fields: the company and the code of list % never change (records keep its codes)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'ARCHIVED' AND OLD."status" <> 'ARCHIVED' THEN
      SELECT f."code" INTO field_code FROM "CustomField" f
       WHERE f."tenantId" = NEW."tenantId" AND f."picklistId" = NEW."id" AND f."status" = 'ACTIVE' LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'fields: list % is picked from by active field %: archive the field first', NEW."code", field_code
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NOT "factory_config_code_ok"(NEW."code") THEN
    RAISE EXCEPTION 'fields: the code of list % is lower-case letters, digits and underscores, from a letter, up to 40 characters (not %)', NEW."id", NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_key_ok"(NEW."key", concat('picklist:', NEW."code")) THEN
    RAISE EXCEPTION 'fields: the key of list % is picklist:<code> (each code once in the tenant)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_config_label_ok"(NEW."labelIt") OR NOT "factory_config_label_ok"(NEW."labelEn") THEN
    RAISE EXCEPTION 'fields: list % has a name in Italian and in English, one line of 1 to 80 characters each', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Picklist_guard" AFTER INSERT OR UPDATE ON "Picklist"
  FOR EACH ROW EXECUTE FUNCTION "factory_picklist_guard"();
CREATE TRIGGER "Picklist_never_deleted" BEFORE DELETE ON "Picklist"
  FOR EACH ROW EXECUTE FUNCTION "factory_config_never_deleted"();

-- PicklistValue (PLT-115)
--   INSERT     into an active list (read FOR SHARE).
--   every row  the code (upper-case letters, digits and underscores, up to 40); the key `option:<picklistId>:<code>` (each code
--              once per list); labels IT/EN; the colour a swatch `#rrggbb`, the icon a tag icon id, its place 0 to 9999, the
--              description up to 500 characters.
--   UPDATE     an UPDATE that changes nothing passes; the list, code, key and creation never change.
--   DELETE     refused (deactivated instead: records keep the code). TRUNCATE refused.
CREATE FUNCTION "factory_picklist_value_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  list_status text;
  list_code text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."picklistId", NEW."code", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."picklistId", OLD."code", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'fields: the list and the code of list value % never change (records keep the code)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT p."status"::text, p."code" INTO list_status, list_code
      FROM "Picklist" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."picklistId" FOR SHARE;
    IF list_status = 'ARCHIVED' THEN
      RAISE EXCEPTION 'fields: list % is archived: it takes no new value', list_code
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."code" IS NULL OR NEW."code" !~ '^[A-Z0-9][A-Z0-9_]{0,39}$' THEN
    RAISE EXCEPTION 'fields: the code of list value % is upper-case letters, digits and underscores, up to 40 characters (not %)', NEW."id", NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_key_ok"(NEW."key", concat('option:', NEW."picklistId", ':', NEW."code")) THEN
    RAISE EXCEPTION 'fields: the key of list value % is option:<list>:<code> (each code once per list)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_config_label_ok"(NEW."labelIt") OR NOT "factory_config_label_ok"(NEW."labelEn") THEN
    RAISE EXCEPTION 'fields: list value % has a label in Italian and in English, one line of 1 to 80 characters each', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."colour" IS NOT NULL AND NEW."colour" !~ '^#[0-9A-Fa-f]{6}$') OR (NEW."icon" IS NOT NULL AND NEW."icon" !~ '^[a-z][a-z0-9-]{0,39}$') THEN
    RAISE EXCEPTION 'fields: list value % has a swatch colour #rrggbb and a tag icon id (lower-case letters, digits and dashes), or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sortOrder" NOT BETWEEN 0 AND 9999 OR NOT "factory_recall_words_ok"(NEW."description", 500, true) THEN
    RAISE EXCEPTION 'fields: list value % has its place from 0 to 9999 and a description of up to 500 characters (or none)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PicklistValue_guard" AFTER INSERT OR UPDATE ON "PicklistValue"
  FOR EACH ROW EXECUTE FUNCTION "factory_picklist_value_guard"();
CREATE TRIGGER "PicklistValue_never_deleted" BEFORE DELETE ON "PicklistValue"
  FOR EACH ROW EXECUTE FUNCTION "factory_config_never_deleted"();

-- =====================================================================================================================
-- DocumentTemplate (PLT-231), EmailTemplate (PLT-232): a template version's life, the problem in words or NULL.
--   INSERT     born DRAFT, neither published nor retired.
--   every row  published (when, not in the future, and by whom, both) exactly once out of DRAFT; retired (when, not before
--              it was published nor in the future) exactly when RETIRED.
--   UPDATE     DRAFT → ACTIVE → RETIRED, nothing else; the publication is set once; a RETIRED version changes no more.
CREATE FUNCTION "factory_template_state_problem"(op text, old_status text, new_status text, published_at timestamptz, published_by uuid,
                                                 retired_at timestamptz, old_published_at timestamptz, old_published_by uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN op = 'INSERT' AND new_status <> 'DRAFT'
      THEN 'is written as a DRAFT, then published'
    WHEN op = 'UPDATE' AND old_status = 'RETIRED'
      THEN 'is RETIRED: it changes no more'
    WHEN op = 'UPDATE' AND new_status IS DISTINCT FROM old_status
         AND NOT ((old_status = 'DRAFT' AND new_status = 'ACTIVE') OR (old_status = 'ACTIVE' AND new_status = 'RETIRED'))
      THEN format('moves DRAFT → ACTIVE → RETIRED (not %s → %s)', old_status, new_status)
    WHEN (new_status <> 'DRAFT') <> (published_at IS NOT NULL) OR (published_at IS NULL) <> (published_by IS NULL)
         OR NOT "factory_recall_not_future"(published_at)
      THEN 'names when and by whom it was published exactly once it is published, not in the future'
    WHEN op = 'UPDATE' AND old_published_at IS NOT NULL AND (published_at, published_by) IS DISTINCT FROM (old_published_at, old_published_by)
      THEN 'was published once; when and by whom stay as they were'
    WHEN (new_status = 'RETIRED') <> (retired_at IS NOT NULL) OR retired_at < published_at OR NOT "factory_recall_not_future"(retired_at)
      THEN 'names when it was retired exactly when RETIRED, not before it was published nor in the future'
    ELSE NULL
  END
$$;

CREATE FUNCTION "factory_template_draft_only_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'templates: % % was published (%): it is kept, never removed (a newer version replaces it)', TG_TABLE_NAME, OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

-- DocumentTemplate
--   every row  the language; the version from 1; the key `doc:<kind>:<companyId>:<language>:<revision>` (each version once);
--              the header and the footer up to 2000 characters, the terms up to 20000, each with placeholders only of the
--              form {{name}}; the fields shown (letters, digits, `_` and `.`, from a lower-case letter, up to 60 characters)
--              each once, up to 60; the life above.
--   UPDATE     an UPDATE that changes nothing passes; the company, kind, language, version number, key and creation never
--              change; out of DRAFT the words and the fields shown never change.
--   DELETE     only a DRAFT. TRUNCATE refused. One ACTIVE per company, kind and language: `DocumentTemplate_one_active`.
CREATE FUNCTION "factory_document_template_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."kind", NEW."language", NEW."revision", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."kind", OLD."language", OLD."revision", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'templates: the company, kind, language and version number of document template % never change (a new version is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (NEW."header", NEW."terms", NEW."footer", NEW."fieldsShown") IS DISTINCT FROM (OLD."header", OLD."terms", OLD."footer", OLD."fieldsShown") THEN
      RAISE EXCEPTION 'templates: document template % was published: its words and fields never change (write a new version)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  problem := "factory_template_state_problem"(TG_OP, CASE WHEN TG_OP = 'UPDATE' THEN OLD."status"::text END, NEW."status"::text, NEW."publishedAt", NEW."publishedById",
                                              NEW."retiredAt", CASE WHEN TG_OP = 'UPDATE' THEN OLD."publishedAt" END, CASE WHEN TG_OP = 'UPDATE' THEN OLD."publishedById" END);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'templates: document template % %', NEW."id", problem
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_config_language_ok"(NEW."language") OR NEW."revision" < 1 THEN
    RAISE EXCEPTION 'templates: document template % is in a language of two lower-case letters (ISO 639-1), with its version number from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_key_ok"(NEW."key", concat('doc:', NEW."kind", ':', NEW."companyId", ':', NEW."language", ':', NEW."revision")) THEN
    RAISE EXCEPTION 'templates: the key of document template % is doc:<kind>:<company>:<language>:<version> (each version once)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."header", 2000, true) OR NOT "factory_recall_words_ok"(NEW."terms", 20000, true)
     OR NOT "factory_recall_words_ok"(NEW."footer", 2000, true) THEN
    RAISE EXCEPTION 'templates: document template % has a header and a footer of up to 2000 characters and terms of up to 20000 (or none)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_config_placeholders_ok"(NEW."header") OR NOT "factory_config_placeholders_ok"(NEW."terms") OR NOT "factory_config_placeholders_ok"(NEW."footer") THEN
    RAISE EXCEPTION 'templates: the words of document template % hold placeholders only as {{name}} (every {{ closed by }})', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."fieldsShown") > 60
     OR cardinality(NEW."fieldsShown") <> (SELECT count(DISTINCT f) FROM unnest(NEW."fieldsShown") f)
     OR EXISTS (SELECT 1 FROM unnest(NEW."fieldsShown") f WHERE f IS NULL OR f !~ '^[a-z][A-Za-z0-9_.]{0,59}$') THEN
    RAISE EXCEPTION 'templates: document template % shows up to 60 fields of its layout, each once, by their keys (unitPrice, delivery)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "DocumentTemplate_guard" AFTER INSERT OR UPDATE ON "DocumentTemplate"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_template_guard"();
CREATE TRIGGER "DocumentTemplate_draft_only_deleted" BEFORE DELETE ON "DocumentTemplate"
  FOR EACH ROW EXECUTE FUNCTION "factory_template_draft_only_deleted"();
CREATE UNIQUE INDEX "DocumentTemplate_one_active" ON "DocumentTemplate" ("tenantId", "companyId", "kind", "language") WHERE "status" = 'ACTIVE';

-- EmailTemplate
--   every row  the event (lower-case words joined by dots, up to 100 characters: the mail's template key); the language; the
--              version from 1; the key `mail:<event>:<companyId | all>:<language>:<revision>` (each version once); the subject
--              one line of 1 to 200 characters, the body 1 to 20000, each with placeholders only of the form {{name}}; the
--              life above.
--   UPDATE     an UPDATE that changes nothing passes; the company, event, language, version number, key and creation never
--              change; out of DRAFT the subject and the body never change.
--   DELETE     only a DRAFT. TRUNCATE refused. One ACTIVE per event, company (or every company) and language:
--              `EmailTemplate_one_active`.
CREATE FUNCTION "factory_email_template_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."event", NEW."language", NEW."revision", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."event", OLD."language", OLD."revision", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'templates: the company, event, language and version number of e-mail template % never change (a new version is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (NEW."subject", NEW."body") IS DISTINCT FROM (OLD."subject", OLD."body") THEN
      RAISE EXCEPTION 'templates: e-mail template % was published: its subject and body never change (write a new version)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  problem := "factory_template_state_problem"(TG_OP, CASE WHEN TG_OP = 'UPDATE' THEN OLD."status"::text END, NEW."status"::text, NEW."publishedAt", NEW."publishedById",
                                              NEW."retiredAt", CASE WHEN TG_OP = 'UPDATE' THEN OLD."publishedAt" END, CASE WHEN TG_OP = 'UPDATE' THEN OLD."publishedById" END);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'templates: e-mail template % %', NEW."id", problem
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."event" IS NULL OR char_length(NEW."event") > 100 OR NEW."event" !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' THEN
    RAISE EXCEPTION 'templates: e-mail template % is for an event named as the mail''s template key: lower-case words joined by dots, up to 100 characters (not %)', NEW."id", NEW."event"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_config_language_ok"(NEW."language") OR NEW."revision" < 1 THEN
    RAISE EXCEPTION 'templates: e-mail template % is in a language of two lower-case letters (ISO 639-1), with its version number from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_key_ok"(NEW."key", concat('mail:', NEW."event", ':', coalesce(NEW."companyId"::text, 'all'), ':', NEW."language", ':', NEW."revision")) THEN
    RAISE EXCEPTION 'templates: the key of e-mail template % is mail:<event>:<company or all>:<language>:<version> (each version once)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."subject" IS NULL OR NOT "factory_recall_words_ok"(NEW."subject", 200, false)
     OR NEW."body" IS NULL OR NOT "factory_recall_words_ok"(NEW."body", 20000, true) THEN
    RAISE EXCEPTION 'templates: e-mail template % has a subject of one line of 1 to 200 characters and a body of 1 to 20000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_config_placeholders_ok"(NEW."subject") OR NOT "factory_config_placeholders_ok"(NEW."body") THEN
    RAISE EXCEPTION 'templates: the words of e-mail template % hold placeholders only as {{name}} (every {{ closed by }})', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "EmailTemplate_guard" AFTER INSERT OR UPDATE ON "EmailTemplate"
  FOR EACH ROW EXECUTE FUNCTION "factory_email_template_guard"();
CREATE TRIGGER "EmailTemplate_draft_only_deleted" BEFORE DELETE ON "EmailTemplate"
  FOR EACH ROW EXECUTE FUNCTION "factory_template_draft_only_deleted"();
CREATE UNIQUE INDEX "EmailTemplate_one_active" ON "EmailTemplate"
  ("tenantId", "event", "language", (COALESCE("companyId", '00000000-0000-0000-0000-000000000000'::uuid))) WHERE "status" = 'ACTIVE';

-- =====================================================================================================================
-- MessageTemplate (COL-016)
--   every row  a name of one line, 1 to 120 characters; the language; a body of 1 to 10000 characters with placeholders only
--              of the form {{name}}; the record type a table of the tenant, or none (any record); the owner an office person
--              (checked when named), or none (shared).
--   UPDATE     an UPDATE that changes nothing passes; the creation never changes.
--   TRUNCATE   refused.
CREATE FUNCTION "factory_message_template_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_audience text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'templates: saved reply % keeps its creation', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."name" IS NULL OR NOT "factory_recall_words_ok"(NEW."name", 120, false) OR NOT "factory_config_language_ok"(NEW."language") THEN
    RAISE EXCEPTION 'templates: saved reply % has a name of one line of 1 to 120 characters and a language of two lower-case letters (ISO 639-1)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."body" IS NULL OR NOT "factory_recall_words_ok"(NEW."body", 10000, true) OR NOT "factory_config_placeholders_ok"(NEW."body") THEN
    RAISE EXCEPTION 'templates: saved reply % has a body of 1 to 10000 characters, its placeholders only as {{name}} (every {{ closed by }})', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."recordType" IS NOT NULL AND NOT "factory_config_record_type_ok"(NEW."recordType") THEN
    RAISE EXCEPTION 'templates: saved reply % is for a record type that is a table of the tenant (a model name), or for any record (not %)', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ownerId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId") THEN
    SELECT u."audience"::text INTO owner_audience FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."ownerId";
    IF FOUND AND owner_audience <> 'OFFICE' THEN
      RAISE EXCEPTION 'templates: saved reply % is an office person''s own, or shared (not a partner user''s)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MessageTemplate_guard" AFTER INSERT OR UPDATE ON "MessageTemplate"
  FOR EACH ROW EXECUTE FUNCTION "factory_message_template_guard"();

-- =====================================================================================================================
-- QuoteTemplateLineOption (SAL-133; B-W2b-374's schema need), as a quote line's option
--   every row  of a line that is no fee (read FOR SHARE: a change of the line's kind or style waits); the customer's text
--              exactly when the value takes one, one line of at most its length (500 without one) matching its pattern; a
--              material's colour only with the material; a COLOUR group's option picks no material, a MATERIAL group's no
--              library colour.
--   INSERT     a group the line's style offers (StyleOptionGroup).
--   UPDATE     an UPDATE that changes nothing passes; the line, group, value and creation never change.
--   DELETE     free (removed with its line: ON DELETE CASCADE). TRUNCATE refused.
CREATE FUNCTION "factory_quote_template_line_option_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_kind text;
  line_style uuid;
  takes_text boolean;
  text_length integer;
  text_pattern text;
  group_takes text;
  group_code text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."lineId", NEW."groupId", NEW."valueId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."lineId", OLD."groupId", OLD."valueId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'options: template option % keeps its line, group and value (another choice is another row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT l."kind"::text, l."styleId" INTO line_kind, line_style
    FROM "QuoteTemplateLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."lineId" FOR SHARE;
  IF line_kind = 'FEE' THEN
    RAISE EXCEPTION 'options: quote template line % is a fee: it starts with no options', NEW."lineId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND line_style IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "StyleOptionGroup" g WHERE g."tenantId" = NEW."tenantId" AND g."styleId" = line_style AND g."groupId" = NEW."groupId") THEN
    RAISE EXCEPTION 'options: template option % is of a group the style of quote template line % does not offer', NEW."id", NEW."lineId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."freeText" IS DISTINCT FROM OLD."freeText" THEN
    SELECT v."freeText", v."freeTextMaxLength", v."freeTextPattern" INTO takes_text, text_length, text_pattern
      FROM "OptionValue" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."valueId";
    IF takes_text IS NOT NULL AND takes_text <> (NEW."freeText" IS NOT NULL) THEN
      RAISE EXCEPTION 'options: template option % has the customer''s text exactly when its value takes one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."freeText" IS NOT NULL
       AND (NOT "factory_recall_words_ok"(NEW."freeText", coalesce(text_length, 500), false)
            OR (text_pattern IS NOT NULL AND NEW."freeText" !~ text_pattern)) THEN
      RAISE EXCEPTION 'options: the text of template option % is one line of at most % characters%', NEW."id", coalesce(text_length, 500),
        CASE WHEN text_pattern IS NULL THEN '' ELSE ' matching the value''s pattern' END
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."itemColourId" IS NOT NULL AND NEW."itemId" IS NULL THEN
    RAISE EXCEPTION 'options: template option % names a material''s colour only with the material', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."colourId" IS NOT NULL OR NEW."itemId" IS NOT NULL)
     AND (TG_OP = 'INSERT' OR (NEW."colourId", NEW."itemId") IS DISTINCT FROM (OLD."colourId", OLD."itemId")) THEN
    SELECT g."takes"::text, g."code" INTO group_takes, group_code FROM "OptionGroup" g WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."groupId";
    IF group_takes = 'COLOUR' AND NEW."itemId" IS NOT NULL THEN
      RAISE EXCEPTION 'options: template option % is of group %, which takes a colour of the library: it picks no material', NEW."id", group_code
        USING ERRCODE = 'check_violation';
    END IF;
    IF group_takes = 'MATERIAL' AND NEW."colourId" IS NOT NULL THEN
      RAISE EXCEPTION 'options: template option % is of group %, which takes a material and its colour: it picks no library colour', NEW."id", group_code
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QuoteTemplateLineOption_guard" AFTER INSERT OR UPDATE ON "QuoteTemplateLineOption"
  FOR EACH ROW EXECUTE FUNCTION "factory_quote_template_line_option_guard"();

-- QuoteTemplateLine (own trigger; the sales pricing guard `QuoteTemplateLine_guard` untouched): a line with options becomes no
-- fee and keeps its style (the options were chosen of that style's offers). B-W2b-294's template route replaces a template's
-- lines (delete, then insert), which removes their options with them.
CREATE FUNCTION "factory_quote_template_line_options_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "QuoteTemplateLineOption" o WHERE o."tenantId" = NEW."tenantId" AND o."lineId" = NEW."id") THEN
    IF NEW."kind" = 'FEE' THEN
      RAISE EXCEPTION 'options: quote template line % has options: it becomes a fee only once they are removed', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."styleId" IS DISTINCT FROM OLD."styleId" THEN
      RAISE EXCEPTION 'options: quote template line % keeps its style while it has options (chosen of that style''s offers): remove them first', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QuoteTemplateLine_options_check" AFTER UPDATE OF "kind", "styleId" ON "QuoteTemplateLine"
  FOR EACH ROW WHEN (NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."styleId" IS DISTINCT FROM OLD."styleId")
  EXECUTE FUNCTION "factory_quote_template_line_options_check"();

-- OptionGroup (own trigger; the BOM options guards and the W2b-5 follow-ups' `OptionGroup_takes_check` untouched): a group
-- takes COLOUR only while none of its quote template options names a material, MATERIAL only while none names a library
-- colour. The words begin `options: `, so the takes route (B-W2b-374, `takesGuarded`) answers 409 in them.
CREATE FUNCTION "factory_option_group_template_takes_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."takes" = 'COLOUR'
      AND EXISTS (SELECT 1 FROM "QuoteTemplateLineOption" o WHERE o."tenantId" = NEW."tenantId" AND o."groupId" = NEW."id" AND o."itemId" IS NOT NULL))
     OR (NEW."takes" = 'MATERIAL'
      AND EXISTS (SELECT 1 FROM "QuoteTemplateLineOption" o WHERE o."tenantId" = NEW."tenantId" AND o."groupId" = NEW."id" AND o."colourId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'options: group % takes a % only once none of the quote template options of it picks %', NEW."code",
      CASE NEW."takes" WHEN 'COLOUR' THEN 'colour of the library' ELSE 'material' END,
      CASE NEW."takes" WHEN 'COLOUR' THEN 'a material' ELSE 'a library colour' END
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OptionGroup_template_takes_check" AFTER UPDATE OF "takes" ON "OptionGroup"
  FOR EACH ROW WHEN (NEW."takes" IS NOT NULL AND NEW."takes" IS DISTINCT FROM OLD."takes")
  EXECUTE FUNCTION "factory_option_group_template_takes_check"();
