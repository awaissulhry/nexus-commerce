-- Written by hand (Prisma does not model triggers), after the generated 202611011602_suppliers_depth_w2b_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Suppliers in depth, W2b-5 schema wave 42/44 (B-W2b-287; SCM-002, SCM-004, SCM-007, SCM-008, SCM-016, SCM-027, SCM-049,
-- PLN-162). apps/factory-api's modules/purchasing (B-W2b-311, -315, -331) checks all of this first and answers in words;
-- these rules are the last word, for every login, the owner included.
--
--   Party                 (new trigger Party_supplier_check, AFTER INSERT and AFTER UPDATE OF the new columns only, so no
--                         W1 or W2 write of a party meets it): the supplier kinds each once, only on a party with the
--                         SUPPLIER, SUBCONTRACTOR or CARRIER role (checked when they change); the supplier status set only on
--                         such a party, never cleared once set; each change of it with when (not in the future, later than
--                         the last) and by whom (an active office user, or none: the system), and that time and person
--                         only with a change; the reason (one line, 1 to 500) required for CONDITIONAL, ON_HOLD and
--                         BLOCKED; the origin: a country (ISO 3166-1 alpha-2), a region (one line, 1 to 120), words (1 to
--                         2000); the hides' countries (alpha-2, each once, at most 50) and tannages (each once) only on a
--                         TANNERY. A list column left NULL counts as empty (an older insert that names none).
--   PartyContact          (new trigger PartyContact_receives_check, AFTER INSERT and AFTER UPDATE OF "receives"): what a
--                         contact receives, each once.
--   SupplierBankAccount   NEVER CHANGED IN PLACE (SCM-007): proposed PROPOSED at version 1 with nothing after it; its IBAN
--                         (country, check digits by ISO 7064 mod 97-10, 11 to 30 letters or digits, upper case, no spaces),
--                         BIC (8 or 11), bank, holder (one line, 1 to 140), currency (ISO 4217), the account it replaces (the
--                         party's ACTIVE one when proposed), who proposed it and when never change; the database sets its
--                         masked IBAN (country, last four) at insert. The proposer is an active office user, or an active
--                         person of the account's own party (a partner session: only one of its own people, and only a
--                         PROPOSED account of its own party: the policies keep it to its party, the grant to insert).
--                         PROPOSED → VERIFIED | ACTIVE | REFUSED; VERIFIED → ACTIVE | REFUSED; ACTIVE → RETIRED; REFUSED
--                         and RETIRED are final. The call-back once, while PROPOSED: when (after the proposal, not in the
--                         future), who called (an active office user who neither proposed nor wrote the account) and the
--                         number: the phone of exactly one contact or address of the party that was on file BEFORE the
--                         proposal and has not changed since (created and last changed before the proposal), its digits
--                         the dialled number's. The second person's check (VERIFIED, or ACTIVE at once) only after the
--                         call-back: when (not before it, not in the future) and by whom: an active office user who is
--                         NEITHER the one who proposed the account NOR the one who wrote it, the Owner included (Owner
--                         answer 11-10, Q3 = A). ACTIVE with when (not before the check); one ACTIVE per party and currency
--                         (a partial unique index: retire the old one first). REFUSED with when, by whom (an active office
--                         user) and why (1 to 2000); RETIRED with when (not before it became active) and, when given, why
--                         (one line, 1 to 500). Each of these is set once. Never deleted.
--   SupplierQualification recorded PENDING at version 1; its company, party and creation never change; its scope (at least
--                         one entry: kinds of work and operations of the tenant's library (at most 100) for a party with the
--                         SUBCONTRACTOR role, kinds of material for a party with the SUPPLIER role, each once; the party of
--                         the company or tenant-wide), its days (until not before from) and its evidence (a list of
--                         { "recordType", "recordId" }, each once, at most 50: an ACCEPTED questionnaire answer or an
--                         ACCEPTED document upload of the party, or an AVAILABLE file of the party or of the qualification)
--                         change only while PENDING. PENDING → APPROVED | CONDITIONAL | REFUSED | WITHDRAWN; APPROVED and
--                         CONDITIONAL → SUSPENDED | WITHDRAWN; SUSPENDED → back to its decision (CONDITIONAL when it has
--                         conditions, else APPROVED) | WITHDRAWN; REFUSED and WITHDRAWN are final. The decision once: when
--                         (not in the future) and by whom (an active office user); APPROVED and CONDITIONAL from a day, with
--                         at least one evidence; CONDITIONAL with its conditions, REFUSED with why. SUSPENDED exactly with
--                         since when (not before the decision) and why; WITHDRAWN exactly with when and why (1 to 2000 each).
--                         Never deleted.
--   SubcontractAgreement  written DRAFT at version 1 (a party with the SUBCONTRACTOR role, of the company or tenant-wide; a
--                         revision from 1); its company, workshop, revision and creation never change; its title (one line,
--                         1 to 200) and days (until not before from) change only while DRAFT, as its file does. DRAFT →
--                         SIGNED (when it was signed, not in the future, and the signed file: an AVAILABLE file of this
--                         agreement or of its party, of its company or tenant-wide) → SUPERSEDED | TERMINATED (when, not
--                         before the signature, not in the future; TERMINATED with why), then frozen. One SIGNED per company
--                         and workshop (a partial unique index: supersede the old one first). Only a DRAFT is deleted.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the checks are AFTER triggers (the
-- policies speak first), but the masked IBAN (BEFORE INSERT: the database writes it) and the refused deletes (BEFORE: the
-- runtime roles have no DELETE grant on two of the tables, so these speak to the owner). The tenant of a row is left to the
-- policies and the references, never compared here. A rule that reads a person reads the User row the session may read: the
-- office reads every person of its tenant, a partner session only the people of its own party (so it can name only one of
-- them). An UPDATE that changes nothing passes.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers moved)
-- and insert the copy: so the first rows the seed gives are ones a copy may repeat (a PROPOSED account, a PENDING
-- qualification, a DRAFT agreement), and the partial unique indexes leave them alone.
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok" and "factory_recall_not_future" (…_recall_claims_w2b_guards).
-- No earlier function is redefined.

CREATE FUNCTION "factory_supplier_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'suppliers: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_supplier_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'suppliers: % % is kept, never deleted (its history is the record: refuse, retire or withdraw it)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

-- An IBAN: a country, two check digits and 11 to 30 letters or digits, upper case, no spaces, whose check digits hold (ISO
-- 7064 mod 97-10: the first four characters moved to the end, each letter as two digits A = 10 … Z = 35, the number mod 97
-- is 1). The country's own length is the API's (factory-domain).
CREATE FUNCTION "factory_supplier_iban_ok"(iban text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  moved text;
  ch text;
  remainder integer := 0;
BEGIN
  IF iban IS NULL OR iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' THEN
    RETURN false;
  END IF;
  moved := substr(iban, 5) || substr(iban, 1, 4);
  FOR i IN 1 .. char_length(moved) LOOP
    ch := substr(moved, i, 1);
    IF ch ~ '^[A-Z]$' THEN
      remainder := (remainder * 100 + ascii(ch) - 55) % 97;
    ELSE
      remainder := (remainder * 10 + ascii(ch) - 48) % 97;
    END IF;
  END LOOP;
  RETURN remainder = 1;
END
$$;

-- The digits of a phone number ("+39 055 123 4567" → "390551234567").
CREATE FUNCTION "factory_supplier_phone_digits"(phone text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')
$$;

-- An active office user of the tenant (read as the session may read them: these columns are written by the office, which
-- reads every person of its tenant).
CREATE FUNCTION "factory_supplier_office_person_ok"(tenant uuid, person uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "User" u
                  WHERE u."tenantId" = tenant AND u."id" = person AND u."audience" = 'OFFICE' AND u."status" = 'ACTIVE')
$$;

-- A list without NULLs, each value once (NULL: an empty list).
CREATE FUNCTION "factory_supplier_list_ok"(list anyarray) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT list IS NULL
      OR (array_position(list, NULL) IS NULL
          AND cardinality(list) = (SELECT count(DISTINCT v) FROM unnest(list) AS v))
$$;

-- =====================================================================================================================
-- Party (SCM-002, SCM-008, SCM-016): the supplier kinds, status and origin.
CREATE FUNCTION "factory_party_supplier_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  supplier_side constant boolean := coalesce(NEW."roles" && ARRAY['SUPPLIER', 'SUBCONTRACTOR', 'CARRIER']::"PartyRole"[], false);
  kinds constant "SupplierKind"[] := coalesce(NEW."supplierKinds", '{}');
  hides constant text[] := coalesce(NEW."hideOriginCountries", '{}');
  tannages constant "Tannage"[] := coalesce(NEW."tannages", '{}');
  kinds_changed boolean;
  status_changed boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW."supplierKinds", NEW."supplierStatus", NEW."supplierStatusReason", NEW."supplierStatusChangedAt", NEW."supplierStatusChangedById",
          NEW."originCountry", NEW."originRegion", NEW."originNote", NEW."hideOriginCountries", NEW."tannages")
         IS NOT DISTINCT FROM
         (OLD."supplierKinds", OLD."supplierStatus", OLD."supplierStatusReason", OLD."supplierStatusChangedAt", OLD."supplierStatusChangedById",
          OLD."originCountry", OLD."originRegion", OLD."originNote", OLD."hideOriginCountries", OLD."tannages") THEN
    RETURN NULL;
  END IF;
  kinds_changed := TG_OP = 'INSERT' OR coalesce(NEW."supplierKinds", '{}') IS DISTINCT FROM coalesce(OLD."supplierKinds", '{}');
  status_changed := TG_OP = 'INSERT' OR NEW."supplierStatus" IS DISTINCT FROM OLD."supplierStatus";

  -- What kind of supplier (SCM-002).
  IF NOT "factory_supplier_list_ok"(kinds) THEN
    RAISE EXCEPTION 'parties: party % names each supplier kind once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF kinds_changed AND cardinality(kinds) > 0 AND NOT supplier_side THEN
    RAISE EXCEPTION 'parties: party % has supplier kinds only with the SUPPLIER, SUBCONTRACTOR or CARRIER role', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Where it stands with us (SCM-008).
  IF NEW."supplierStatus" IS NULL THEN
    IF TG_OP = 'UPDATE' AND OLD."supplierStatus" IS NOT NULL THEN
      RAISE EXCEPTION 'parties: the supplier status of party % is never cleared once set (INACTIVE: no longer used)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF num_nonnulls(NEW."supplierStatusReason", NEW."supplierStatusChangedAt", NEW."supplierStatusChangedById") > 0 THEN
      RAISE EXCEPTION 'parties: party % has no supplier status, so no reason, time or person of a change', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF status_changed THEN
      IF NOT supplier_side THEN
        RAISE EXCEPTION 'parties: party % has a supplier status only with the SUPPLIER, SUBCONTRACTOR or CARRIER role', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."supplierStatusChangedAt" IS NULL OR NOT "factory_recall_not_future"(NEW."supplierStatusChangedAt")
         OR (TG_OP = 'UPDATE' AND OLD."supplierStatusChangedAt" IS NOT NULL AND NEW."supplierStatusChangedAt" <= OLD."supplierStatusChangedAt") THEN
        RAISE EXCEPTION 'parties: each change of the supplier status of party % records when (not in the future, later than the last change)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."supplierStatusChangedById" IS NOT NULL AND NOT "factory_supplier_office_person_ok"(NEW."tenantId", NEW."supplierStatusChangedById") THEN
        RAISE EXCEPTION 'parties: the supplier status of party % is changed by an active office user (or by the system: no person)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF (NEW."supplierStatusChangedAt", NEW."supplierStatusChangedById") IS DISTINCT FROM (OLD."supplierStatusChangedAt", OLD."supplierStatusChangedById") THEN
      RAISE EXCEPTION 'parties: party % records when and by whom its supplier status changed only with a change of the status', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."supplierStatus" IN ('CONDITIONAL', 'ON_HOLD', 'BLOCKED') AND NEW."supplierStatusReason" IS NULL THEN
      RAISE EXCEPTION 'parties: party % is % as a supplier with the reason why', NEW."id", NEW."supplierStatus"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."supplierStatusReason", 500, false) THEN
    RAISE EXCEPTION 'parties: the reason for the supplier status of party % is one line of 1 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Where it makes what it sells us (SCM-016).
  IF NEW."originCountry" IS NOT NULL AND NEW."originCountry" !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'parties: the origin of party % is a country code of two capitals (ISO 3166-1 alpha-2)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."originRegion", 120, false) OR NOT "factory_recall_words_ok"(NEW."originNote", 2000, true) THEN
    RAISE EXCEPTION 'parties: the origin of party % has a region of one line (1 to 120 characters) and words of 1 to 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_supplier_list_ok"(hides) OR cardinality(hides) > 50
     OR EXISTS (SELECT 1 FROM unnest(hides) AS c(code) WHERE c.code !~ '^[A-Z]{2}$') THEN
    RAISE EXCEPTION 'parties: party % names the countries its raw hides come from by two capitals (ISO 3166-1 alpha-2), each once, at most 50', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_supplier_list_ok"(tannages) THEN
    RAISE EXCEPTION 'parties: party % names each tannage once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (cardinality(hides) > 0 OR cardinality(tannages) > 0) AND NOT ('TANNERY' = ANY (kinds)) THEN
    RAISE EXCEPTION 'parties: party % gives its hides'' origin and its tannages only as a TANNERY (one of its supplier kinds)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Party_supplier_check_insert" AFTER INSERT ON "Party"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_supplier_check"();
CREATE TRIGGER "Party_supplier_check" AFTER UPDATE OF "supplierKinds", "supplierStatus", "supplierStatusReason", "supplierStatusChangedAt",
    "supplierStatusChangedById", "originCountry", "originRegion", "originNote", "hideOriginCountries", "tannages" ON "Party"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_supplier_check"();

-- =====================================================================================================================
-- PartyContact (SCM-004): what a contact receives.
CREATE FUNCTION "factory_party_contact_receives_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."receives" IS NOT DISTINCT FROM OLD."receives" THEN
    RETURN NULL;
  END IF;
  IF NOT "factory_supplier_list_ok"(NEW."receives") THEN
    RAISE EXCEPTION 'parties: contact % names what it receives each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PartyContact_receives_check" AFTER INSERT OR UPDATE OF "receives" ON "PartyContact"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_contact_receives_check"();

-- =====================================================================================================================
-- SupplierBankAccount (SCM-007)
-- The masked IBAN: written by the database at insert (the IBAN never changes after it).
CREATE FUNCTION "factory_supplier_bank_account_mask"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."ibanCountry" := left(coalesce(NEW."iban", ''), 2);
  NEW."ibanLast4" := right(coalesce(NEW."iban", ''), 4);
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_supplier_bank_account_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed constant text[] := ARRAY['id', 'partyId', 'iban', 'ibanCountry', 'ibanLast4', 'bic', 'bankName', 'holder', 'currency', 'replacesId',
                                 'proposedById', 'proposedAt', 'createdAt', 'createdById'];
  call_back constant text[] := ARRAY['callBackAt', 'callBackById', 'callBackContactId', 'callBackAddressId', 'callBackPhone'];
  by_partner constant boolean := current_user = 'factory_partner_runtime';
  person_audience text;
  person_party uuid;
  person_status text;
  replaced_status text;
  on_file_phone text;
  on_file_created timestamptz;
  on_file_changed timestamptz;
  new_call_back boolean := false;
  new_check boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF to_jsonb(NEW) = to_jsonb(OLD) THEN
      RETURN NULL;
    END IF;
    IF OLD."status" IN ('REFUSED', 'RETIRED') THEN
      RAISE EXCEPTION 'suppliers: bank account % is % already: it never changes again (propose a new account)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT jsonb_object_agg(k.name, to_jsonb(NEW) -> k.name) FROM unnest(fixed) AS k(name))
       IS DISTINCT FROM (SELECT jsonb_object_agg(k.name, to_jsonb(OLD) -> k.name) FROM unnest(fixed) AS k(name)) THEN
      RAISE EXCEPTION 'suppliers: bank account % is never changed in place (its IBAN, BIC, bank, holder, currency, the account it replaces, who proposed it and when): propose a new account', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" NOT IN (OLD."version", OLD."version" + 1) THEN
      RAISE EXCEPTION 'suppliers: bank account % moves its version by one at most (% → %)', OLD."id", OLD."version", NEW."version"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'PROPOSED' AND NEW."status" IN ('VERIFIED', 'ACTIVE', 'REFUSED'))
                OR (OLD."status" = 'VERIFIED' AND NEW."status" IN ('ACTIVE', 'REFUSED'))
                OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED')) THEN
      RAISE EXCEPTION 'suppliers: bank account % goes PROPOSED → VERIFIED → ACTIVE → RETIRED (or PROPOSED, VERIFIED → REFUSED), not % → %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."callBackAt" IS NOT NULL
       AND (SELECT jsonb_object_agg(k.name, to_jsonb(NEW) -> k.name) FROM unnest(call_back) AS k(name))
           IS DISTINCT FROM (SELECT jsonb_object_agg(k.name, to_jsonb(OLD) -> k.name) FROM unnest(call_back) AS k(name)) THEN
      RAISE EXCEPTION 'suppliers: the call-back of bank account % is recorded once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."verifiedAt" IS NOT NULL AND (NEW."verifiedAt", NEW."verifiedById") IS DISTINCT FROM (OLD."verifiedAt", OLD."verifiedById"))
       OR (OLD."activatedAt" IS NOT NULL AND NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt") THEN
      RAISE EXCEPTION 'suppliers: the check and the activation of bank account % are recorded once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    new_call_back := OLD."callBackAt" IS NULL AND NEW."callBackAt" IS NOT NULL;
    new_check := OLD."verifiedAt" IS NULL AND NEW."verifiedAt" IS NOT NULL;
    IF new_call_back AND OLD."status" <> 'PROPOSED' THEN
      RAISE EXCEPTION 'suppliers: the call-back of bank account % is recorded while it is PROPOSED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."status" <> 'PROPOSED' OR NEW."version" <> 1
       OR num_nonnulls(NEW."callBackAt", NEW."callBackById", NEW."callBackContactId", NEW."callBackAddressId", NEW."callBackPhone",
                       NEW."verifiedAt", NEW."verifiedById", NEW."activatedAt", NEW."refusedAt", NEW."refusedById", NEW."refuseReason",
                       NEW."retiredAt", NEW."retireReason") > 0 THEN
      RAISE EXCEPTION 'suppliers: bank account % is proposed PROPOSED at version 1, with no call-back, check or decision yet (a change is a new account)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_supplier_iban_ok"(NEW."iban") THEN
      RAISE EXCEPTION 'suppliers: bank account % has an IBAN: a country, two check digits that hold (ISO 7064 mod 97-10) and 11 to 30 letters or digits, upper case, no spaces', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."bic" IS NOT NULL AND NEW."bic" !~ '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$' THEN
      RAISE EXCEPTION 'suppliers: the BIC of bank account % is 8 or 11 upper-case letters and digits (bank, country, location, branch)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."holder" IS NULL OR NOT "factory_recall_words_ok"(NEW."holder", 140, false) OR NOT "factory_recall_words_ok"(NEW."bankName", 140, false) THEN
      RAISE EXCEPTION 'suppliers: bank account % names its holder (one line, 1 to 140 characters) and, when given, its bank (1 to 140)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."currency" IS NULL OR NEW."currency" !~ '^[A-Z]{3}$' THEN
      RAISE EXCEPTION 'suppliers: the currency of bank account % is three capitals (ISO 4217)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_recall_not_future"(NEW."proposedAt") THEN
      RAISE EXCEPTION 'suppliers: bank account % is not proposed in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- Who proposed it: an active office user, or an active person of the account's own party; a partner session only one of
    -- its own people (it reads only them).
    SELECT u."audience"::text, u."partyId", u."status"::text INTO person_audience, person_party, person_status
      FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."proposedById";
    IF NOT FOUND OR person_status <> 'ACTIVE'
       OR (person_audience = 'PARTNER' AND person_party IS DISTINCT FROM NEW."partyId")
       OR (by_partner AND person_audience <> 'PARTNER') THEN
      RAISE EXCEPTION 'suppliers: bank account % is proposed by an active office user, or by an active person of its own supplier in the portal', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."replacesId" IS NOT NULL THEN
      -- The reference keeps it an account of the same party, which a partner session reads too.
      SELECT b."status"::text INTO replaced_status FROM "SupplierBankAccount" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."replacesId";
      IF NEW."replacesId" = NEW."id" OR (FOUND AND replaced_status <> 'ACTIVE') THEN
        RAISE EXCEPTION 'suppliers: bank account % replaces the ACTIVE account of its party (not %)', NEW."id", coalesce(replaced_status, 'itself')
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- Every row: its status and the columns of each step agree.
  IF num_nonnulls(NEW."callBackAt", NEW."callBackById", NEW."callBackPhone") NOT IN (0, 3)
     OR (NEW."callBackAt" IS NULL AND num_nonnulls(NEW."callBackContactId", NEW."callBackAddressId") > 0)
     OR (NEW."callBackAt" IS NOT NULL AND num_nonnulls(NEW."callBackContactId", NEW."callBackAddressId") <> 1) THEN
    RAISE EXCEPTION 'suppliers: the call-back of bank account % has when, who called, the number and exactly one contact or address it is the phone of: all or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."verifiedAt" IS NULL) <> (NEW."verifiedById" IS NULL)
     OR (NEW."verifiedAt" IS NOT NULL AND NEW."callBackAt" IS NULL)
     OR ((NEW."status" IN ('VERIFIED', 'ACTIVE', 'RETIRED')) AND NEW."verifiedAt" IS NULL)
     OR (NEW."status" = 'PROPOSED' AND NEW."verifiedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'suppliers: bank account % is VERIFIED, ACTIVE or RETIRED exactly once a second person checked it after the call-back (when and who)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('ACTIVE', 'RETIRED')) <> (NEW."activatedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'suppliers: bank account % is ACTIVE (or RETIRED) exactly with when it became active', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'REFUSED') <> (NEW."refusedAt" IS NOT NULL)
     OR num_nonnulls(NEW."refusedAt", NEW."refusedById", NEW."refuseReason") NOT IN (0, 3)
     OR NOT "factory_recall_words_ok"(NEW."refuseReason", 2000, true) THEN
    RAISE EXCEPTION 'suppliers: bank account % is REFUSED exactly with when, by whom and why (1 to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'RETIRED') <> (NEW."retiredAt" IS NOT NULL)
     OR (NEW."retireReason" IS NOT NULL AND NEW."retiredAt" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."retireReason", 500, false) THEN
    RAISE EXCEPTION 'suppliers: bank account % is RETIRED exactly with when, and why only then (one line, 1 to 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- The call-back (SCM-007): to a number on file before the proposal, by someone who did not propose or write it.
    IF new_call_back THEN
      IF NEW."callBackAt" < NEW."proposedAt" OR NOT "factory_recall_not_future"(NEW."callBackAt") THEN
        RAISE EXCEPTION 'suppliers: the call-back of bank account % is after its proposal and not in the future', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT "factory_supplier_office_person_ok"(NEW."tenantId", NEW."callBackById")
         OR NEW."callBackById" = NEW."proposedById" OR NEW."callBackById" IS NOT DISTINCT FROM NEW."createdById" THEN
        RAISE EXCEPTION 'suppliers: the call-back of bank account % is made by an active office user who neither proposed nor wrote the account', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."callBackContactId" IS NOT NULL THEN
        SELECT c."phone", c."createdAt", c."updatedAt" INTO on_file_phone, on_file_created, on_file_changed
          FROM "PartyContact" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."callBackContactId";
      ELSE
        SELECT a."phone", a."createdAt", a."updatedAt" INTO on_file_phone, on_file_created, on_file_changed
          FROM "PartyAddress" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."callBackAddressId";
      END IF;
      IF NOT FOUND OR on_file_created >= NEW."proposedAt" OR on_file_changed >= NEW."proposedAt" THEN
        RAISE EXCEPTION 'suppliers: the call-back of bank account % goes to a number we had on file before the proposal: a contact or address of the supplier made and last changed before it', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT "factory_recall_words_ok"(NEW."callBackPhone", 40, false) OR length("factory_supplier_phone_digits"(NEW."callBackPhone")) < 6
         OR "factory_supplier_phone_digits"(NEW."callBackPhone") <> "factory_supplier_phone_digits"(on_file_phone) THEN
        RAISE EXCEPTION 'suppliers: the call-back of bank account % dials the phone on file (its digits), as dialled in one line of up to 40 characters', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    -- The second person's check: NOBODY VERIFIES THEIR OWN CHANGE (Owner answer Q3 = A), the Owner included.
    IF new_check THEN
      IF NEW."verifiedAt" < NEW."callBackAt" OR NOT "factory_recall_not_future"(NEW."verifiedAt") THEN
        RAISE EXCEPTION 'suppliers: bank account % is checked after its call-back and not in the future', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."verifiedById" = NEW."proposedById" OR NEW."verifiedById" IS NOT DISTINCT FROM NEW."createdById" THEN
        RAISE EXCEPTION 'suppliers: bank account % is checked by a second person: never the one who proposed or wrote it (nobody verifies their own change)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT "factory_supplier_office_person_ok"(NEW."tenantId", NEW."verifiedById") THEN
        RAISE EXCEPTION 'suppliers: bank account % is checked by an active office user', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF OLD."activatedAt" IS NULL AND NEW."activatedAt" IS NOT NULL
       AND (NEW."activatedAt" < NEW."verifiedAt" OR NOT "factory_recall_not_future"(NEW."activatedAt")) THEN
      RAISE EXCEPTION 'suppliers: bank account % becomes active after its check and not in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."refusedAt" IS NULL AND NEW."refusedAt" IS NOT NULL
       AND (NEW."refusedAt" < NEW."proposedAt" OR NOT "factory_recall_not_future"(NEW."refusedAt")
            OR NOT "factory_supplier_office_person_ok"(NEW."tenantId", NEW."refusedById")) THEN
      RAISE EXCEPTION 'suppliers: bank account % is refused by an active office user, after its proposal and not in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."retiredAt" IS NULL AND NEW."retiredAt" IS NOT NULL
       AND (NEW."retiredAt" < NEW."activatedAt" OR NOT "factory_recall_not_future"(NEW."retiredAt")) THEN
      RAISE EXCEPTION 'suppliers: bank account % is retired after it became active and not in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SupplierBankAccount_mask" BEFORE INSERT ON "SupplierBankAccount"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_bank_account_mask"();
CREATE TRIGGER "SupplierBankAccount_guard" AFTER INSERT OR UPDATE ON "SupplierBankAccount"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_bank_account_guard"();
CREATE TRIGGER "SupplierBankAccount_never_deleted" BEFORE DELETE ON "SupplierBankAccount"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_never_deleted"();
CREATE TRIGGER "SupplierBankAccount_no_truncate" BEFORE TRUNCATE ON "SupplierBankAccount"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supplier_refuse_truncate"();

-- Payments use one ACTIVE account per party and currency: activating a new one retires the old one first, in the same command.
CREATE UNIQUE INDEX "SupplierBankAccount_one_active_per_currency" ON "SupplierBankAccount"("tenantId", "partyId", "currency") WHERE "status" = 'ACTIVE';

-- =====================================================================================================================
-- SupplierQualification (SCM-027, PLN-162)
CREATE FUNCTION "factory_supplier_qualification_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed constant text[] := ARRAY['id', 'companyId', 'partyId', 'createdAt', 'createdById'];
  scope constant text[] := ARRAY['workCentreKinds', 'operationIds', 'materialKinds', 'validFrom', 'validUntil', 'evidence'];
  decision constant text[] := ARRAY['decidedAt', 'decidedById', 'conditions', 'refuseReason'];
  work_kinds constant "WorkCentreKind"[] := coalesce(NEW."workCentreKinds", '{}');
  operations constant uuid[] := coalesce(NEW."operationIds", '{}');
  materials constant "ItemKind"[] := coalesce(NEW."materialKinds", '{}');
  scope_changed boolean := true;
  party_roles text[];
  party_company uuid;
  entry jsonb;
  record_type text;
  record_id uuid;
  found_party uuid;
  found_state text;
  found_type text;
  found_record uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF to_jsonb(NEW) = to_jsonb(OLD) THEN
      RETURN NULL;
    END IF;
    IF OLD."status" IN ('REFUSED', 'WITHDRAWN') THEN
      RAISE EXCEPTION 'suppliers: qualification % is % already: it never changes again (record a new qualification)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT jsonb_object_agg(k.name, to_jsonb(NEW) -> k.name) FROM unnest(fixed) AS k(name))
       IS DISTINCT FROM (SELECT jsonb_object_agg(k.name, to_jsonb(OLD) -> k.name) FROM unnest(fixed) AS k(name)) THEN
      RAISE EXCEPTION 'suppliers: qualification % keeps its company, supplier and creation', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" NOT IN (OLD."version", OLD."version" + 1) THEN
      RAISE EXCEPTION 'suppliers: qualification % moves its version by one at most (% → %)', OLD."id", OLD."version", NEW."version"
        USING ERRCODE = 'check_violation';
    END IF;
    scope_changed := (SELECT jsonb_object_agg(k.name, to_jsonb(NEW) -> k.name) FROM unnest(scope) AS k(name))
                     IS DISTINCT FROM (SELECT jsonb_object_agg(k.name, to_jsonb(OLD) -> k.name) FROM unnest(scope) AS k(name));
    IF scope_changed AND OLD."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'suppliers: qualification % keeps what it is for, its days and its evidence once decided (record a new qualification)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."decidedAt" IS NOT NULL
       AND (SELECT jsonb_object_agg(k.name, to_jsonb(NEW) -> k.name) FROM unnest(decision) AS k(name))
           IS DISTINCT FROM (SELECT jsonb_object_agg(k.name, to_jsonb(OLD) -> k.name) FROM unnest(decision) AS k(name)) THEN
      RAISE EXCEPTION 'suppliers: qualification % is decided once (when, by whom, its conditions or why not)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'PENDING' AND NEW."status" IN ('APPROVED', 'CONDITIONAL', 'REFUSED', 'WITHDRAWN'))
                OR (OLD."status" IN ('APPROVED', 'CONDITIONAL') AND NEW."status" IN ('SUSPENDED', 'WITHDRAWN'))
                OR (OLD."status" = 'SUSPENDED' AND NEW."status" IN ('APPROVED', 'CONDITIONAL', 'WITHDRAWN'))) THEN
      RAISE EXCEPTION 'suppliers: qualification % goes PENDING → APPROVED | CONDITIONAL | REFUSED, then SUSPENDED and back, or WITHDRAWN; not % → %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- A lifted suspension goes back to its decision: CONDITIONAL when it has conditions, else APPROVED.
    IF OLD."status" = 'SUSPENDED' AND NEW."status" IN ('APPROVED', 'CONDITIONAL') AND (NEW."status" = 'CONDITIONAL') <> (NEW."conditions" IS NOT NULL) THEN
      RAISE EXCEPTION 'suppliers: qualification % is lifted back to its decision (%)', OLD."id", CASE WHEN NEW."conditions" IS NULL THEN 'APPROVED' ELSE 'CONDITIONAL' END
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."decidedAt" IS NULL AND NEW."decidedAt" IS NOT NULL
       AND (NOT "factory_recall_not_future"(NEW."decidedAt") OR NOT "factory_supplier_office_person_ok"(NEW."tenantId", NEW."decidedById")) THEN
      RAISE EXCEPTION 'suppliers: qualification % is decided by an active office user, not in the future', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" <> 'PENDING' OR NEW."version" <> 1
        OR num_nonnulls(NEW."decidedAt", NEW."decidedById", NEW."conditions", NEW."refuseReason", NEW."suspendedAt", NEW."suspendReason",
                        NEW."withdrawnAt", NEW."withdrawReason") > 0 THEN
    RAISE EXCEPTION 'suppliers: qualification % is recorded PENDING at version 1, with no decision, suspension or withdrawal yet', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every row: the status and its columns agree.
  IF (NEW."decidedAt" IS NULL) <> (NEW."decidedById" IS NULL)
     OR (NEW."status" IN ('APPROVED', 'CONDITIONAL', 'REFUSED', 'SUSPENDED') AND NEW."decidedAt" IS NULL)
     OR (NEW."status" = 'PENDING' AND NEW."decidedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'suppliers: qualification % is APPROVED, CONDITIONAL or REFUSED (and SUSPENDED) exactly with when and by whom it was decided', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CONDITIONAL' AND NEW."conditions" IS NULL) OR (NEW."status" = 'APPROVED' AND NEW."conditions" IS NOT NULL)
     OR (NEW."conditions" IS NOT NULL AND (NEW."decidedAt" IS NULL OR NEW."refuseReason" IS NOT NULL))
     OR (NEW."status" = 'REFUSED') <> (NEW."refuseReason" IS NOT NULL)
     OR NOT "factory_recall_words_ok"(NEW."conditions", 2000, true) OR NOT "factory_recall_words_ok"(NEW."refuseReason", 2000, true) THEN
    RAISE EXCEPTION 'suppliers: qualification % is CONDITIONAL exactly with its conditions and REFUSED exactly with why (1 to 2000 characters each)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'SUSPENDED') <> (NEW."suspendedAt" IS NOT NULL) OR (NEW."suspendedAt" IS NULL) <> (NEW."suspendReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."suspendReason", 2000, true)
     OR (NEW."suspendedAt" IS NOT NULL AND (NEW."suspendedAt" < NEW."decidedAt" OR NOT "factory_recall_not_future"(NEW."suspendedAt"))) THEN
    RAISE EXCEPTION 'suppliers: qualification % is SUSPENDED exactly with since when (not before its decision, not in the future) and why (1 to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL) OR (NEW."withdrawnAt" IS NULL) <> (NEW."withdrawReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."withdrawReason", 2000, true)
     OR (NEW."withdrawnAt" IS NOT NULL AND (NEW."withdrawnAt" < NEW."decidedAt" OR NOT "factory_recall_not_future"(NEW."withdrawnAt"))) THEN
    RAISE EXCEPTION 'suppliers: qualification % is WITHDRAWN exactly with when (not before its decision, not in the future) and why (1 to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."validUntil" IS NOT NULL AND (NEW."validFrom" IS NULL OR NEW."validUntil" < NEW."validFrom") THEN
    RAISE EXCEPTION 'suppliers: qualification % holds until a day not before the day it holds from', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('APPROVED', 'CONDITIONAL', 'SUSPENDED')
     AND (NEW."validFrom" IS NULL OR jsonb_typeof(NEW."evidence") IS DISTINCT FROM 'array' OR jsonb_array_length(NEW."evidence") = 0) THEN
    RAISE EXCEPTION 'suppliers: qualification % is APPROVED or CONDITIONAL from a day, with at least one evidence', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it is for, and what it rests on (at insert and when they change; only while PENDING).
  IF scope_changed THEN
    IF NOT "factory_supplier_list_ok"(work_kinds) OR NOT "factory_supplier_list_ok"(operations) OR NOT "factory_supplier_list_ok"(materials)
       OR cardinality(work_kinds) + cardinality(operations) + cardinality(materials) = 0 OR cardinality(operations) > 100 THEN
      RAISE EXCEPTION 'suppliers: qualification % is for at least one kind of work, operation or kind of material, each once (at most 100 operations)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF cardinality(operations) > 0
       AND (SELECT count(*) FROM "Operation" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = ANY (operations)) <> cardinality(operations) THEN
      RAISE EXCEPTION 'suppliers: qualification % names operations of the tenant''s library only', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT p."roles"::text[], p."companyId" INTO party_roles, party_company FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND THEN
      IF party_company IS NOT NULL AND party_company <> NEW."companyId" THEN
        RAISE EXCEPTION 'suppliers: qualification % is of a supplier of its company or tenant-wide', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (cardinality(work_kinds) + cardinality(operations) > 0 AND NOT ('SUBCONTRACTOR' = ANY (party_roles)))
         OR (cardinality(materials) > 0 AND NOT ('SUPPLIER' = ANY (party_roles))) THEN
        RAISE EXCEPTION 'suppliers: qualification % is for work only of a party with the SUBCONTRACTOR role, for materials only of one with the SUPPLIER role', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."evidence" IS NULL OR jsonb_typeof(NEW."evidence") <> 'array' OR jsonb_array_length(NEW."evidence") > 50
       OR (SELECT count(DISTINCT e.value) FROM jsonb_array_elements(NEW."evidence") AS e) <> jsonb_array_length(NEW."evidence") THEN
      RAISE EXCEPTION 'suppliers: qualification % lists its evidence as [{ "recordType", "recordId" }], each once, at most 50', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    FOR entry IN SELECT e.value FROM jsonb_array_elements(NEW."evidence") AS e LOOP
      IF jsonb_typeof(entry) <> 'object'
         OR EXISTS (SELECT 1 FROM jsonb_object_keys(entry) AS k(name) WHERE k.name NOT IN ('recordType', 'recordId'))
         OR jsonb_typeof(entry -> 'recordType') IS DISTINCT FROM 'string'
         OR (entry ->> 'recordType') NOT IN ('SupplierQuestionnaireResponse', 'SupplierDocumentUpload', 'StoredFile')
         OR jsonb_typeof(entry -> 'recordId') IS DISTINCT FROM 'string'
         OR (entry ->> 'recordId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'suppliers: qualification % names each evidence as { "recordType": "SupplierQuestionnaireResponse" | "SupplierDocumentUpload" | "StoredFile", "recordId": a uuid }', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      record_type := entry ->> 'recordType';
      record_id := (entry ->> 'recordId')::uuid;
      IF record_type = 'SupplierQuestionnaireResponse' THEN
        SELECT r."partyId", r."decision"::text INTO found_party, found_state
          FROM "SupplierQuestionnaireResponse" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = record_id;
        IF NOT FOUND OR found_party <> NEW."partyId" OR found_state IS DISTINCT FROM 'ACCEPTED' THEN
          RAISE EXCEPTION 'suppliers: qualification % rests on an ACCEPTED questionnaire answer of its own supplier (not %)', NEW."id", record_id
            USING ERRCODE = 'check_violation';
        END IF;
      ELSIF record_type = 'SupplierDocumentUpload' THEN
        SELECT d."partyId", d."status"::text INTO found_party, found_state
          FROM "SupplierDocumentUpload" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = record_id;
        IF NOT FOUND OR found_party <> NEW."partyId" OR found_state <> 'ACCEPTED' THEN
          RAISE EXCEPTION 'suppliers: qualification % rests on an ACCEPTED document of its own supplier (not %)', NEW."id", record_id
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        SELECT f."status"::text, f."recordType", f."recordId" INTO found_state, found_type, found_record
          FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = record_id;
        IF NOT FOUND OR found_state <> 'AVAILABLE'
           OR NOT ((found_type = 'Party' AND found_record = NEW."partyId") OR (found_type = 'SupplierQualification' AND found_record = NEW."id")) THEN
          RAISE EXCEPTION 'suppliers: qualification % rests on an AVAILABLE file of its supplier or of the qualification (not %)', NEW."id", record_id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SupplierQualification_guard" AFTER INSERT OR UPDATE ON "SupplierQualification"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_qualification_guard"();
CREATE TRIGGER "SupplierQualification_never_deleted" BEFORE DELETE ON "SupplierQualification"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_never_deleted"();
CREATE TRIGGER "SupplierQualification_no_truncate" BEFORE TRUNCATE ON "SupplierQualification"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supplier_refuse_truncate"();

-- =====================================================================================================================
-- SubcontractAgreement (SCM-049; L. 192/1998 art. 2)
CREATE FUNCTION "factory_subcontract_agreement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed constant text[] := ARRAY['id', 'companyId', 'partyId', 'revision', 'createdAt', 'createdById'];
  terms constant text[] := ARRAY['title', 'termsFileId', 'signedAt', 'validFrom', 'validUntil'];
  party_roles text[];
  party_company uuid;
  file_status text;
  file_company uuid;
  file_type text;
  file_record uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF to_jsonb(NEW) = to_jsonb(OLD) THEN
      RETURN NULL;
    END IF;
    IF OLD."status" IN ('SUPERSEDED', 'TERMINATED') THEN
      RAISE EXCEPTION 'suppliers: subcontract agreement % is % already: it never changes again', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT jsonb_object_agg(k.name, to_jsonb(NEW) -> k.name) FROM unnest(fixed) AS k(name))
       IS DISTINCT FROM (SELECT jsonb_object_agg(k.name, to_jsonb(OLD) -> k.name) FROM unnest(fixed) AS k(name)) THEN
      RAISE EXCEPTION 'suppliers: subcontract agreement % keeps its company, workshop, revision and creation', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" NOT IN (OLD."version", OLD."version" + 1) THEN
      RAISE EXCEPTION 'suppliers: subcontract agreement % moves its version by one at most (% → %)', OLD."id", OLD."version", NEW."version"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'SIGNED'
       AND (SELECT jsonb_object_agg(k.name, to_jsonb(NEW) -> k.name) FROM unnest(terms) AS k(name))
           IS DISTINCT FROM (SELECT jsonb_object_agg(k.name, to_jsonb(OLD) -> k.name) FROM unnest(terms) AS k(name)) THEN
      RAISE EXCEPTION 'suppliers: subcontract agreement % is signed: its title, file, signature and days are fixed (write a new revision)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'SIGNED')
                OR (OLD."status" = 'SIGNED' AND NEW."status" IN ('SUPERSEDED', 'TERMINATED'))) THEN
      RAISE EXCEPTION 'suppliers: subcontract agreement % goes DRAFT → SIGNED → SUPERSEDED | TERMINATED, not % → %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."status" <> 'DRAFT' OR NEW."version" <> 1 OR num_nonnulls(NEW."signedAt", NEW."endedAt", NEW."endReason") > 0 THEN
      RAISE EXCEPTION 'suppliers: subcontract agreement % is written DRAFT at version 1, not signed or ended yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."revision" < 1 THEN
      RAISE EXCEPTION 'suppliers: subcontract agreement % is numbered from revision 1', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT p."roles"::text[], p."companyId" INTO party_roles, party_company FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND (NOT ('SUBCONTRACTOR' = ANY (party_roles)) OR (party_company IS NOT NULL AND party_company <> NEW."companyId")) THEN
      RAISE EXCEPTION 'suppliers: subcontract agreement % is with a workshop (the SUBCONTRACTOR role) of its company or tenant-wide', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Every row.
  IF NEW."title" IS NULL OR NOT "factory_recall_words_ok"(NEW."title", 200, false) THEN
    RAISE EXCEPTION 'suppliers: subcontract agreement % has a title of one line, 1 to 200 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."validUntil" IS NOT NULL AND NEW."validUntil" < NEW."validFrom" THEN
    RAISE EXCEPTION 'suppliers: subcontract agreement % covers until a day not before its first day', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DRAFT') <> (NEW."signedAt" IS NULL) OR (NEW."status" <> 'DRAFT' AND NEW."termsFileId" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."signedAt") THEN
    RAISE EXCEPTION 'suppliers: subcontract agreement % is signed exactly with when (not in the future) and its signed file', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('SUPERSEDED', 'TERMINATED')) <> (NEW."endedAt" IS NOT NULL)
     OR (NEW."endReason" IS NOT NULL AND NEW."endedAt" IS NULL) OR (NEW."status" = 'TERMINATED' AND NEW."endReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."endReason", 2000, true)
     OR (NEW."endedAt" IS NOT NULL AND (NEW."endedAt" < NEW."signedAt" OR NOT "factory_recall_not_future"(NEW."endedAt"))) THEN
    RAISE EXCEPTION 'suppliers: subcontract agreement % ends (SUPERSEDED, TERMINATED with why) exactly with when, not before it was signed and not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- The signed file, when it is signed: an available file of the agreement or of its workshop, of its company or tenant-wide.
  IF NEW."status" = 'SIGNED' AND (TG_OP = 'INSERT' OR OLD."status" = 'DRAFT') THEN
    SELECT f."status"::text, f."companyId", f."recordType", f."recordId" INTO file_status, file_company, file_type, file_record
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."termsFileId";
    IF NOT FOUND OR file_status <> 'AVAILABLE' OR (file_company IS NOT NULL AND file_company <> NEW."companyId")
       OR NOT ((file_type = 'SubcontractAgreement' AND file_record = NEW."id") OR (file_type = 'Party' AND file_record = NEW."partyId")) THEN
      RAISE EXCEPTION 'suppliers: subcontract agreement % is signed with an AVAILABLE file of the agreement or of its workshop, of its company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_subcontract_agreement_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'suppliers: subcontract agreement % is %: only a DRAFT is deleted (supersede or terminate it)', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "SubcontractAgreement_guard" AFTER INSERT OR UPDATE ON "SubcontractAgreement"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontract_agreement_guard"();
CREATE TRIGGER "SubcontractAgreement_delete_guard" BEFORE DELETE ON "SubcontractAgreement"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontract_agreement_delete_guard"();
CREATE TRIGGER "SubcontractAgreement_no_truncate" BEFORE TRUNCATE ON "SubcontractAgreement"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supplier_refuse_truncate"();

-- One SIGNED agreement per company and workshop: signing a new revision supersedes the old one first, in the same command.
CREATE UNIQUE INDEX "SubcontractAgreement_one_signed" ON "SubcontractAgreement"("tenantId", "companyId", "partyId") WHERE "status" = 'SIGNED';
