-- Written by hand (Prisma does not model triggers), after the generated 202611170420_config_brand_fields_th_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- A custom field for one customer, TH-4 (threads plan, schema wave 7/9, B-TH-055; gap WALL-G08 / SHEET-G06; research §12
-- decision 12 "a column made for one brand is hidden for every other brand"; surface W17). apps/factory-api's platform/fields
-- checks all of this first and answers in words (B-TH-056: the field shows only on that customer's records, sheet and portal;
-- the portal read returns fields for every customer or this one); these rules are the last word, for every login, the owner
-- included.
--
--   CustomField       a field for one customer (partyId) names a party of the tenant that is a customer (role CUSTOMER) and
--                     active when the field is made, of the field's company or tenant-wide; it is added to a record type whose
--                     table says whose record it is (its "partyId" column, or the column the thread resolver reads: Party
--                     itself, Style brandPartyId, Invoice buyerPartyId, Certificate holderPartyId, Lot and GoodsReceipt
--                     supplierId, Capa customerId: the mapping of …_files_record_party_th_guards' factory_file_record_party);
--                     the customer never changes (null: every customer, as before; another customer's field is another row).
--   CustomFieldValue  a value of a field for one customer goes only on a record of that customer, read from the record as the
--                     files guard reads it (factory_file_record_party, reused as it is): never on another customer's record,
--                     never on a record of none, never on one whose customer this session cannot read (W17: a field of
--                     customer B is never a field of customer A).
--
-- A record whose customer changes later (a prospect's request matched to its customer) keeps the values written before, as it
-- keeps its files; the API shows a customer's field only on that customer's records (B-TH-056), so such a value is shown
-- nowhere else. Fields made before this rule are every customer's (partyId null): nothing to count.
--
-- As every TH guard: a refusal is a check_violation (SQLSTATE 23514) in words, which name no party (an office message, neutral
-- toward customers); the checks are AFTER triggers (the policies speak first). No earlier function is redefined: the
-- configuration guards (…_config_templates_w2b_guards) still hold the rest of a field and of a value.

-- The column a record type's table names its party in, when the table has it (NULL: the table says no party), with the
-- mapping of factory_file_record_party.
CREATE FUNCTION "factory_config_record_party_column"(record_type text) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  party_column text := CASE record_type
    WHEN 'Party' THEN 'id'
    WHEN 'Style' THEN 'brandPartyId'
    WHEN 'Invoice' THEN 'buyerPartyId'
    WHEN 'Certificate' THEN 'holderPartyId'
    WHEN 'Lot' THEN 'supplierId'
    WHEN 'GoodsReceipt' THEN 'supplierId'
    WHEN 'Capa' THEN 'customerId'
    ELSE 'partyId'
  END;
  record_table regclass;
BEGIN
  IF record_type IS NULL OR record_type !~ '^[A-Z][A-Za-z0-9]{0,62}$' THEN
    RETURN NULL;
  END IF;
  record_table := to_regclass(quote_ident(record_type));
  IF record_table IS NULL OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = record_table AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = party_column) THEN
    RETURN NULL;
  END IF;
  RETURN party_column;
END
$$;

-- CustomField: whose field it is.
CREATE FUNCTION "factory_custom_field_party_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  party_roles text[];
  party_status text;
  party_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."partyId" IS DISTINCT FROM OLD."partyId" THEN
      RAISE EXCEPTION 'fields: the customer custom field % is for never changes (another customer''s field is another row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW."partyId" IS NULL THEN
    RETURN NULL;
  END IF;
  IF "factory_config_record_party_column"(NEW."recordType") IS NULL THEN
    RAISE EXCEPTION 'fields: custom field % is for one customer, so it goes on a record type whose records name their customer (not %)', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT p."roles"::text[], p."status"::text, p."companyId" INTO party_roles, party_status, party_company
    FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
  IF NOT FOUND OR NOT ('CUSTOMER' = ANY (party_roles)) OR party_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'fields: custom field % is for one active customer of the tenant', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."companyId" IS NOT NULL AND party_company IS NOT NULL AND party_company <> NEW."companyId" THEN
    RAISE EXCEPTION 'fields: custom field % of one company is for a customer of that company or of every company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "CustomField_party_check" AFTER INSERT OR UPDATE OF "partyId" ON "CustomField"
  FOR EACH ROW EXECUTE FUNCTION "factory_custom_field_party_check"();

-- CustomFieldValue: a customer's field only on that customer's records.
CREATE FUNCTION "factory_custom_field_value_party_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  field_party uuid;
  field_code text;
  record_known boolean;
  record_party uuid;
BEGIN
  SELECT f."partyId", f."code" INTO field_party, field_code FROM "CustomField" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fieldId";
  IF field_party IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT r.known, r.party INTO record_known, record_party FROM "factory_file_record_party"(NEW."tenantId", NEW."recordType", NEW."recordId") r;
  IF NOT record_known OR record_party IS DISTINCT FROM field_party THEN
    RAISE EXCEPTION 'fields: custom value % of field % goes only on a record of the customer the field is for', NEW."id", field_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "CustomFieldValue_party_check" AFTER INSERT ON "CustomFieldValue"
  FOR EACH ROW EXECUTE FUNCTION "factory_custom_field_value_party_check"();
