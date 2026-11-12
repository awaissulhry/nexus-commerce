-- Written by hand (Prisma does not model triggers), after the generated 202611011102_sales_intake_w2b_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Sales intake and customers, W2b-5 schema wave 37/44 (B-W2b-279; SAL-013, SAL-014, SAL-021, SAL-022, SAL-023, SAL-028,
-- SAL-032, SAL-033, SAL-237, SAL-277, SAL-305). apps/factory-api checks all of this first and answers in words (B-W2b-290,
-- -295, -303, -304); these rules are the last word, for every login, the owner included.
--
--   Inquiry              its number by `factory_document_number_guard` (…_numbering_floor_documents_guards, as it is);
--                        made open (NEW, or ASSIGNED with its assignee), not closed, no quote, its prospect not erased;
--                        NEW → ASSIGNED | NEED_INFO, ASSIGNED → NEW | NEED_INFO, NEED_INFO → NEW | ASSIGNED, and each of
--                        them → QUOTED | DECLINED | LOST (final): then frozen but its note and the erasure of its prospect;
--                        its company, source, mail, received time and creation never change; NEW has nobody assigned,
--                        ASSIGNED someone (an ACTIVE office user), with since when; MAIL exactly with its mail (an
--                        InboundEmail of its company or tenant-wide, one inquiry per mail: a partial unique index); a party
--                        (a customer or brand of its company or tenant-wide, not archived) or a prospect (a name, company
--                        or e-mail, with its lawful basis) or an erased prospect; a contact only with its party; QUOTED
--                        exactly with its quote (of its company and party, named once, one inquiry per quote: a partial
--                        unique index); DECLINED exactly with its reason; closed (when, by whom) exactly when QUOTED,
--                        DECLINED or LOST, the words of a loss or a decline OTHER; the tech pack's files of this inquiry
--                        or of its mail, each once, at most 50; the target price 0 or more in a currency. Erasure of the
--                        prospect: when and by whom, set once, never undone; the prospect's name, company, e-mail and
--                        phone stay null for good. Never deleted.
--   InquiryLine          written and removed only while its inquiry is open (the inquiry FOR SHARE); a style (of the
--                        inquiry's company or tenant-wide, a colourway only with it) or a description; the pieces by size
--                        (an object of size codes to whole pieces) and a total that is their sum; a line never moves to
--                        another inquiry.
--   CustomerRequirement  of a customer or brand (for its company, or every company); made in force; its party, company,
--                        kind, words, stages, styles, file, supersedes and creation never change: a change is a new row
--                        that supersedes an ENDED one of the same party (each replaced once: a partial unique index);
--                        ended once (active false, with when and by whom), then frozen; the stages one or more, each
--                        once; the styles each once, at most 200, of its company or tenant-wide; its file a file of the
--                        requirement or of its party. Never deleted.
--   PartyHold            of a customer or brand (for its company, or every company); placed (when, by whom or the system),
--                        with its reason and words, never changed; released once (when, by whom, why: all three), not
--                        before it was placed, then frozen; at most one in force per party, company and reason (a partial
--                        unique index). Never deleted.
--   PartyCompanyTerms    of a customer or brand that is tenant-wide or of this company; its party, company and creation
--                        never change; the deposit above 0 and at most 100 percent; the credit limit 0 or more with its
--                        currency, both or neither; the library's payment terms and the price list ACTIVE and of the
--                        company or tenant-wide when given; ended once (when, by whom), then frozen; one live row per
--                        party and company (a partial unique index). Never deleted.
--   Season               its company, code and creation never change; the code one line of 1 to 20 characters; it runs
--                        startsOn ≤ endsOn, its order book closes on or before endsOn; CLOSED exactly with when it was
--                        closed. Never deleted.
--   QuoteVersion, SalesOrder  their own triggers on "seasonId" (W1's guards untouched: a SENT version stays frozen whole):
--                        a season named or changed is OPEN, and of the quote's (the order's) company.
--   Party                its own trigger on "teamPartyId" and "kind" (W2a's commercial terms guard untouched): a rider
--                        with a team is a PERSON, not its own team; the team an ORGANISATION with the CUSTOMER or BRAND role,
--                        not archived, of the rider's company or tenant-wide; a party with riders stays an ORGANISATION.
--   PartyContact         its own trigger (no earlier one): CONSENT with when and how it was given; consent's time and
--                        source both or neither; times not in the future; erasure (when, by whom) set once, never undone:
--                        an erased contact is ARCHIVED, its name '' and no e-mail or phone, for good (it refuses new
--                        personal data).
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the checks are AFTER triggers (the
-- policies speak first), but the number guard and the refused deletes (BEFORE: the words come before a foreign key's; the
-- runtime roles have no DELETE grant on those tables anyway, so these speak to the owner). The tenant of a row is left to the
-- policies and the references, never compared here: a rule that reads another row skips a row this session cannot see. An
-- UPDATE that changes nothing passes.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers and
-- dates moved) and insert the copy: so the first rows the seed gives are ones a copy may repeat (an open OFFICE inquiry with
-- no quote and its line, a requirement in force that supersedes nothing, a RELEASED hold and ENDED terms (the partial unique
-- indexes compare only live rows), an OPEN season).
--
-- USED FROM EARLIER WAVES, as they are: "factory_document_number_guard" (…_numbering_floor_documents_guards),
-- "factory_styles_distinct" (…_styles_libraries_w2b_guards), "factory_recall_words_ok" and "factory_recall_not_future"
-- (…_recall_claims_w2b_guards).

CREATE FUNCTION "factory_intake_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'customers: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_intake_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'customers: % % is kept, never deleted (close, end, release or archive it)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['Inquiry', 'InquiryLine', 'CustomerRequirement', 'PartyHold', 'PartyCompanyTerms', 'Season'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_intake_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['Inquiry', 'CustomerRequirement', 'PartyHold', 'PartyCompanyTerms', 'Season'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "factory_intake_never_deleted"()', name || '_never_deleted', name);
  END LOOP;
END
$$;

-- An e-mail address as kept: trimmed, lower case, one @ and a dot after it, at most 254 characters. NULL: not given.
CREATE FUNCTION "factory_intake_email_ok"(address text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT address IS NULL
      OR (char_length(address) <= 254 AND address = lower(btrim(address)) AND address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
$$;

-- A phone number as typed: an optional +, then digits, spaces and ( ) . / -, 3 to 40 characters. NULL: not given.
CREATE FUNCTION "factory_intake_phone_ok"(phone text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT phone IS NULL OR phone ~ '^\+?[0-9][0-9 ()./-]{2,38}$'
$$;

-- What is wrong with naming this party for this company on a customer's row (a requirement, a hold, terms, an inquiry), in
-- words, or NULL when nothing is (or the party is not visible to this session): it has the CUSTOMER or BRAND role, is not
-- archived when `fresh` (a new or changed reference), and belongs to the company or to every company (a NULL company: every
-- company, which for a party of one company means that one).
CREATE FUNCTION "factory_intake_customer_problem"(tenant uuid, party uuid, company uuid, fresh boolean) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  party_roles text[];
  party_company uuid;
  party_status text;
BEGIN
  SELECT p."roles"::text[], p."companyId", p."status"::text INTO party_roles, party_company, party_status
    FROM "Party" p WHERE p."tenantId" = tenant AND p."id" = party;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT (coalesce(party_roles, ARRAY[]::text[]) && ARRAY['CUSTOMER', 'BRAND']) THEN
    RETURN 'is not a customer or a brand';
  END IF;
  IF fresh AND party_status = 'ARCHIVED' THEN
    RETURN 'is archived';
  END IF;
  IF company IS NOT NULL AND party_company IS NOT NULL AND party_company <> company THEN
    RETURN 'belongs to another company';
  END IF;
  RETURN NULL;
END
$$;

-- Pieces by size: an object of at most 60 size codes (one line, 1 to 20 characters: letters, digits, space . / + -) to whole
-- pieces from 1 to 100 000. Returns their sum, or NULL when the shape is wrong.
CREATE FUNCTION "factory_intake_sizes_total"(sizes jsonb) RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry record;
  n integer := 0;
  total bigint := 0;
BEGIN
  IF sizes IS NULL OR jsonb_typeof(sizes) <> 'object' THEN
    RETURN NULL;
  END IF;
  FOR entry IN SELECT e.key, e.value FROM jsonb_each(sizes) AS e LOOP
    n := n + 1;
    IF n > 60 OR entry.key !~ '^[A-Za-z0-9][A-Za-z0-9 ./+-]{0,19}$' OR jsonb_typeof(entry.value) <> 'number'
       OR (entry.value #>> '{}') !~ '^[0-9]{1,6}$' OR (entry.value #>> '{}')::bigint < 1 OR (entry.value #>> '{}')::bigint > 100000 THEN
      RETURN NULL;
    END IF;
    total := total + (entry.value #>> '{}')::bigint;
  END LOOP;
  RETURN total;
END
$$;

-- =====================================================================================================================
-- Inquiry (SAL-032, SAL-033, SAL-305)
CREATE TRIGGER "Inquiry_number" BEFORE INSERT OR UPDATE ON "Inquiry"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('inquiry', 'INQUIRY');

CREATE FUNCTION "factory_inquiry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  open_states CONSTANT text[] := ARRAY['NEW', 'ASSIGNED', 'NEED_INFO'];
  prospect CONSTANT text[] := ARRAY['prospectName', 'prospectCompany', 'prospectEmail', 'prospectPhone', 'prospectErasedAt', 'prospectErasedById'];
  loose CONSTANT text[] := ARRAY['note', 'version', 'updatedAt'];
  problem text;
  mail_company uuid;
  user_audience text;
  user_status text;
  quote_company uuid;
  usable integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text NOT IN ('NEW', 'ASSIGNED') OR NEW."closedAt" IS NOT NULL OR NEW."closedById" IS NOT NULL OR NEW."quoteId" IS NOT NULL
       OR NEW."prospectErasedAt" IS NOT NULL OR NEW."prospectErasedById" IS NOT NULL THEN
      RAISE EXCEPTION 'customers: inquiry % is logged open (NEW, or ASSIGNED to someone), not closed, quoted or erased', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."source", NEW."sourceEmailId", NEW."receivedAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."source", OLD."sourceEmailId", OLD."receivedAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'customers: the company, source, mail, received time and creation of inquiry % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT (OLD."status"::text = ANY (open_states) AND NEW."status"::text IN ('NEW', 'ASSIGNED', 'NEED_INFO', 'QUOTED', 'DECLINED', 'LOST')) THEN
      RAISE EXCEPTION 'customers: inquiry % cannot move from % to % (QUOTED, DECLINED and LOST are final)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD."status"::text = ANY (open_states))
       AND (to_jsonb(NEW) - (loose || prospect)) IS DISTINCT FROM (to_jsonb(OLD) - (loose || prospect)) THEN
      RAISE EXCEPTION 'customers: inquiry % is % and never changes (only its note, and the erasure of its prospect)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD."status"::text = ANY (open_states)) AND NEW."prospectErasedAt" IS NULL
       AND (to_jsonb(NEW) - loose) IS DISTINCT FROM (to_jsonb(OLD) - loose) THEN
      RAISE EXCEPTION 'customers: inquiry % is %; its prospect is only erased now, not changed', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."prospectErasedAt" IS NOT NULL
       AND (NEW."prospectErasedAt", NEW."prospectErasedById") IS DISTINCT FROM (OLD."prospectErasedAt", OLD."prospectErasedById") THEN
      RAISE EXCEPTION 'customers: the prospect of inquiry % was erased; the erasure is never changed or undone', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."quoteId" IS NOT NULL AND NEW."quoteId" IS DISTINCT FROM OLD."quoteId" THEN
      RAISE EXCEPTION 'customers: the quote of inquiry % is named once, never changed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Every row: the words and shapes.
  IF NEW."request" IS NULL OR NOT "factory_recall_words_ok"(NEW."request", 20000, true)
     OR NOT "factory_recall_words_ok"(NEW."note", 4000, true) THEN
    RAISE EXCEPTION 'customers: inquiry % says what is asked (1 to 20000 characters) and has notes up to 4000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currency" !~ '^[A-Z]{3}$' OR (NEW."targetUnitPrice" IS NOT NULL AND NEW."targetUnitPrice" < 0) THEN
    RAISE EXCEPTION 'customers: inquiry % has a target price of 0 or more in a currency (ISO 4217: EUR), not % %', NEW."id", NEW."targetUnitPrice", NEW."currency"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."techPackFileIds" IS NULL OR cardinality(NEW."techPackFileIds") > 50 OR NOT "factory_styles_distinct"(NEW."techPackFileIds")
     OR NOT "factory_recall_words_ok"(NEW."techPackVersion", 100, false) THEN
    RAISE EXCEPTION 'customers: the tech pack of inquiry % is at most 50 files, each once, and its version one line up to 100 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."source" = 'MAIL') <> (NEW."sourceEmailId" IS NOT NULL) THEN
    RAISE EXCEPTION 'customers: inquiry % names the mail it came from exactly when its source is MAIL', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT "factory_recall_not_future"(NEW."receivedAt") THEN
    RAISE EXCEPTION 'customers: inquiry % came at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Who asks: a party, a prospect, or an erased prospect; a contact only with its party.
  IF NEW."partyId" IS NULL AND NEW."prospectErasedAt" IS NULL
     AND coalesce(NEW."prospectName", NEW."prospectCompany", NEW."prospectEmail") IS NULL THEN
    RAISE EXCEPTION 'customers: inquiry % names its customer (a party) or a prospect (a name, company or e-mail)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."contactId" IS NOT NULL AND NEW."partyId" IS NULL THEN
    RAISE EXCEPTION 'customers: inquiry % names a contact only with the party it is a contact of', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."prospectName", 200, false) OR NOT "factory_recall_words_ok"(NEW."prospectCompany", 200, false)
     OR NOT "factory_intake_email_ok"(NEW."prospectEmail") OR NOT "factory_intake_phone_ok"(NEW."prospectPhone") THEN
    RAISE EXCEPTION 'customers: the prospect of inquiry % has a name and a company of one line up to 200 characters, an e-mail address (trimmed, lower case) and a phone number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."prospectLawfulBasis" IS NULL AND coalesce(NEW."prospectName", NEW."prospectCompany", NEW."prospectEmail", NEW."prospectPhone") IS NOT NULL THEN
    RAISE EXCEPTION 'customers: the prospect of inquiry % is kept with its lawful basis (GDPR art. 6(1))', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."prospectErasedAt" IS NULL) <> (NEW."prospectErasedById" IS NULL) THEN
    RAISE EXCEPTION 'customers: the erasure of the prospect of inquiry % has when and by whom, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."prospectErasedAt" IS NOT NULL
     AND coalesce(NEW."prospectName", NEW."prospectCompany", NEW."prospectEmail", NEW."prospectPhone") IS NOT NULL THEN
    RAISE EXCEPTION 'customers: the prospect of inquiry % was erased; its name, company, e-mail and phone stay blank for good', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."prospectErasedAt" IS DISTINCT FROM OLD."prospectErasedAt") AND NOT "factory_recall_not_future"(NEW."prospectErasedAt") THEN
    RAISE EXCEPTION 'customers: the prospect of inquiry % was erased at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The status and what goes with it.
  IF (NEW."status" = 'NEW' AND NEW."assigneeId" IS NOT NULL) OR (NEW."status" = 'ASSIGNED' AND NEW."assigneeId" IS NULL)
     OR (NEW."assigneeId" IS NULL) <> (NEW."assignedAt" IS NULL) THEN
    RAISE EXCEPTION 'customers: inquiry % is NEW with nobody assigned, ASSIGNED with its assignee and since when', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'QUOTED') <> (NEW."quoteId" IS NOT NULL) OR (NEW."quoteId" IS NOT NULL AND NEW."partyId" IS NULL) THEN
    RAISE EXCEPTION 'customers: inquiry % is QUOTED exactly with the quote it became (a quote of its party)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DECLINED') <> (NEW."declineReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'customers: inquiry % is DECLINED exactly with its reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status"::text = ANY (open_states)) <> (NEW."closedAt" IS NULL) OR (NEW."closedAt" IS NULL AND NEW."closedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'customers: inquiry % is % with the wrong closing time (QUOTED, DECLINED and LOST have one, an open inquiry none)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."closeNote", 2000, true)
     OR (NEW."closeNote" IS NOT NULL AND NEW."status" NOT IN ('DECLINED', 'LOST'))
     OR (NEW."closeNote" IS NULL AND (NEW."status" = 'LOST' OR NEW."declineReason" = 'OTHER')) THEN
    RAISE EXCEPTION 'customers: inquiry % says in words (up to 2000 characters) why it was lost or declined for another reason, and only then', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt")
     AND NEW."closedAt" IS NOT NULL AND (NOT "factory_recall_not_future"(NEW."closedAt") OR NEW."closedAt" < NEW."receivedAt") THEN
    RAISE EXCEPTION 'customers: inquiry % was closed at a time not before it came and not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it names (checked when it is set or changes; a row this session cannot see is skipped).
  IF TG_OP = 'INSERT' AND NEW."sourceEmailId" IS NOT NULL THEN
    SELECT m."companyId" INTO mail_company FROM "InboundEmail" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."sourceEmailId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customers: inquiry % is made from mail %, which is not a mail received by the tenant', NEW."id", NEW."sourceEmailId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF mail_company IS NOT NULL AND mail_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'customers: inquiry % is made from a mail of another company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."partyId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."partyId" IS DISTINCT FROM OLD."partyId") THEN
    problem := "factory_intake_customer_problem"(NEW."tenantId", NEW."partyId", NEW."companyId", true);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'customers: inquiry % names party %, which %', NEW."id", NEW."partyId", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."assigneeId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."assigneeId" IS DISTINCT FROM OLD."assigneeId") THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."assigneeId";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'customers: inquiry % is assigned to an active office user, not one that is % (%)', NEW."id", user_status, user_audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."quoteId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."quoteId" IS DISTINCT FROM OLD."quoteId") THEN
    SELECT q."companyId" INTO quote_company FROM "Quote" q WHERE q."tenantId" = NEW."tenantId" AND q."id" = NEW."quoteId";
    IF FOUND AND quote_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'customers: inquiry % became a quote of its own company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF cardinality(NEW."techPackFileIds") > 0 AND (TG_OP = 'INSERT' OR NEW."techPackFileIds" IS DISTINCT FROM OLD."techPackFileIds") THEN
    SELECT count(*) INTO usable FROM "StoredFile" f
     WHERE f."tenantId" = NEW."tenantId" AND f."id" = ANY (NEW."techPackFileIds") AND f."status" <> 'DELETED'
       AND ((f."recordType" = 'Inquiry' AND f."recordId" = NEW."id")
            OR (f."recordType" = 'InboundEmail' AND f."recordId" = NEW."sourceEmailId"));
    IF usable <> cardinality(NEW."techPackFileIds") THEN
      RAISE EXCEPTION 'customers: the tech pack of inquiry % is files of the inquiry or of the mail it came from, not deleted', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Inquiry_guard" AFTER INSERT OR UPDATE ON "Inquiry"
  FOR EACH ROW EXECUTE FUNCTION "factory_inquiry_guard"();

-- One inquiry per mail, one inquiry per quote.
CREATE UNIQUE INDEX "Inquiry_one_per_mail" ON "Inquiry" ("tenantId", "sourceEmailId") WHERE "sourceEmailId" IS NOT NULL;
CREATE UNIQUE INDEX "Inquiry_one_per_quote" ON "Inquiry" ("tenantId", "quoteId") WHERE "quoteId" IS NOT NULL;

-- =====================================================================================================================
-- InquiryLine
CREATE FUNCTION "factory_inquiry_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  inquiry_company uuid;
  style_company uuid;
  part_of uuid;
  total bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF NEW."inquiryId" <> OLD."inquiryId" OR (NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'customers: inquiry line % never moves to another inquiry', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    part_of := OLD."inquiryId";
    SELECT i."status"::text, i."companyId" INTO state, inquiry_company FROM "Inquiry" i WHERE i."tenantId" = OLD."tenantId" AND i."id" = OLD."inquiryId" FOR SHARE;
  ELSE
    part_of := NEW."inquiryId";
    SELECT i."status"::text, i."companyId" INTO state, inquiry_company FROM "Inquiry" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."inquiryId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state NOT IN ('NEW', 'ASSIGNED', 'NEED_INFO') THEN
    RAISE EXCEPTION 'customers: inquiry % is %; its lines change only while it is open', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;

  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'customers: inquiry line % has a place of 1 or more, not %', NEW."id", NEW."seq"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."styleId" IS NULL AND NEW."description" IS NULL) OR NOT "factory_recall_words_ok"(NEW."description", 2000, true)
     OR NOT "factory_recall_words_ok"(NEW."colourText", 100, false) OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'customers: inquiry line % names a style or says what is asked (up to 2000 characters), a colour in words of one line up to 100, a note up to 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."colourwayId" IS NOT NULL AND NEW."styleId" IS NULL THEN
    RAISE EXCEPTION 'customers: inquiry line % names a colourway only with its style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  total := "factory_intake_sizes_total"(NEW."sizes");
  IF total IS NULL THEN
    RAISE EXCEPTION 'customers: inquiry line % gives its pieces by size as { "<size>": <pieces> } (at most 60 sizes, 1 to 100000 pieces each)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."quantity" IS NOT NULL AND (NEW."quantity" < 1 OR NEW."quantity" > 1000000)) OR (total > 0 AND NEW."quantity" IS DISTINCT FROM total) THEN
    RAISE EXCEPTION 'customers: inquiry line % asks 1 to 1000000 pieces, the sum of its sizes when they are given (%)', NEW."id", total
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."styleId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."styleId" IS DISTINCT FROM OLD."styleId") AND inquiry_company IS NOT NULL THEN
    SELECT s."companyId" INTO style_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND AND style_company IS NOT NULL AND style_company <> inquiry_company THEN
      RAISE EXCEPTION 'customers: inquiry line % asks for a style of the inquiry''s company or a tenant-wide one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "InquiryLine_guard" AFTER INSERT OR UPDATE OR DELETE ON "InquiryLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_inquiry_line_guard"();

-- =====================================================================================================================
-- CustomerRequirement (SAL-014)
CREATE FUNCTION "factory_customer_requirement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  loose CONSTANT text[] := ARRAY['version', 'updatedAt'];
  ending CONSTANT text[] := ARRAY['active', 'endedAt', 'endedById', 'endReason'];
  problem text;
  replaced_active boolean;
  usable integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW."active" OR NEW."endedAt" IS NOT NULL OR NEW."endedById" IS NOT NULL OR NEW."endReason" IS NOT NULL THEN
      RAISE EXCEPTION 'customers: customer requirement % is made in force (active, not ended)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF NOT OLD."active" AND (to_jsonb(NEW) - loose) IS DISTINCT FROM (to_jsonb(OLD) - loose) THEN
      RAISE EXCEPTION 'customers: customer requirement % was ended and never changes; a new requirement replaces it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - (loose || ending)) IS DISTINCT FROM (to_jsonb(OLD) - (loose || ending)) THEN
      RAISE EXCEPTION 'customers: customer requirement % is fixed once written: end it and write a new one that supersedes it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."words" IS NULL OR NOT "factory_recall_words_ok"(NEW."words", 2000, true) THEN
    RAISE EXCEPTION 'customers: customer requirement % says the rule in words (1 to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."appliesAt" IS NULL OR cardinality(NEW."appliesAt") = 0 OR NOT "factory_styles_distinct"(NEW."appliesAt") THEN
    RAISE EXCEPTION 'customers: customer requirement % applies at one or more stages (quote, order, packing, shipment, invoice), each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."styleIds" IS NULL OR cardinality(NEW."styleIds") > 200 OR NOT "factory_styles_distinct"(NEW."styleIds") THEN
    RAISE EXCEPTION 'customers: customer requirement % is for every style or at most 200 styles, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."active" <> (NEW."endedAt" IS NULL) OR (NEW."endedAt" IS NULL) <> (NEW."endedById" IS NULL)
     OR (NEW."endReason" IS NOT NULL AND NEW."endedAt" IS NULL) OR NOT "factory_recall_words_ok"(NEW."endReason", 500, true) THEN
    RAISE EXCEPTION 'customers: customer requirement % is ended (not active) exactly with when and by whom, and why only then (up to 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."endedAt" IS DISTINCT FROM OLD."endedAt") AND NOT "factory_recall_not_future"(NEW."endedAt") THEN
    RAISE EXCEPTION 'customers: customer requirement % was ended at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supersedesId" = NEW."id" THEN
    RAISE EXCEPTION 'customers: customer requirement % does not supersede itself', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    problem := "factory_intake_customer_problem"(NEW."tenantId", NEW."partyId", NEW."companyId", true);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'customers: customer requirement % is for party %, which %', NEW."id", NEW."partyId", problem
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."supersedesId" IS NOT NULL THEN
      SELECT r."active" INTO replaced_active FROM "CustomerRequirement" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."supersedesId";
      IF FOUND AND replaced_active THEN
        RAISE EXCEPTION 'customers: customer requirement % supersedes one that is still in force; end it first', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."fileId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "StoredFile" f
                        WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId" AND f."status" <> 'DELETED'
                          AND ((f."recordType" = 'CustomerRequirement' AND f."recordId" = NEW."id")
                               OR (f."recordType" = 'Party' AND f."recordId" = NEW."partyId"))) THEN
      RAISE EXCEPTION 'customers: the document of customer requirement % is a file of the requirement or of its party, not deleted', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF cardinality(NEW."styleIds") > 0 THEN
      SELECT count(*) INTO usable FROM "Style" s
       WHERE s."tenantId" = NEW."tenantId" AND s."id" = ANY (NEW."styleIds")
         AND (NEW."companyId" IS NULL OR s."companyId" IS NULL OR s."companyId" = NEW."companyId");
      IF usable <> cardinality(NEW."styleIds") THEN
        RAISE EXCEPTION 'customers: customer requirement % is for styles of its company or tenant-wide ones', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "CustomerRequirement_guard" AFTER INSERT OR UPDATE ON "CustomerRequirement"
  FOR EACH ROW EXECUTE FUNCTION "factory_customer_requirement_guard"();

-- A requirement is replaced once.
CREATE UNIQUE INDEX "CustomerRequirement_replaced_once" ON "CustomerRequirement" ("tenantId", "supersedesId") WHERE "supersedesId" IS NOT NULL;

-- =====================================================================================================================
-- PartyHold (SAL-023)
CREATE FUNCTION "factory_party_hold_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  loose CONSTANT text[] := ARRAY['version', 'updatedAt'];
  release CONSTANT text[] := ARRAY['releasedAt', 'releasedById', 'releaseWords'];
  problem text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    problem := "factory_intake_customer_problem"(NEW."tenantId", NEW."partyId", NEW."companyId", true);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'customers: hold % is placed on party %, which %', NEW."id", NEW."partyId", problem
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_recall_not_future"(NEW."placedAt") THEN
      RAISE EXCEPTION 'customers: hold % was placed at a time not in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."releasedAt" IS NOT NULL AND (to_jsonb(NEW) - loose) IS DISTINCT FROM (to_jsonb(OLD) - loose) THEN
      RAISE EXCEPTION 'customers: hold % was released and never changes; a new hold is placed as its own', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - (loose || release)) IS DISTINCT FROM (to_jsonb(OLD) - (loose || release)) THEN
      RAISE EXCEPTION 'customers: hold % is never edited: it is released with words, and a new one placed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."words" IS NULL OR NOT "factory_recall_words_ok"(NEW."words", 2000, true) THEN
    RAISE EXCEPTION 'customers: hold % says why in words (1 to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."releasedAt" IS NULL) <> (NEW."releasedById" IS NULL) OR (NEW."releasedAt" IS NULL) <> (NEW."releaseWords" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."releaseWords", 2000, true) THEN
    RAISE EXCEPTION 'customers: hold % is released with when, by whom and why (1 to 2000 characters), all three or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."releasedAt" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."releasedAt" IS NULL)
     AND (NEW."releasedAt" < NEW."placedAt" OR NOT "factory_recall_not_future"(NEW."releasedAt")) THEN
    RAISE EXCEPTION 'customers: hold % is released not before it was placed and not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "PartyHold_guard" AFTER INSERT OR UPDATE ON "PartyHold"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_hold_guard"();

-- At most one hold in force per party, company (or every company) and reason.
CREATE UNIQUE INDEX "PartyHold_one_in_force" ON "PartyHold" ("tenantId", "partyId", (coalesce("companyId", '00000000-0000-0000-0000-000000000000'::uuid)), "reason")
  WHERE "releasedAt" IS NULL;

-- =====================================================================================================================
-- PartyCompanyTerms (SAL-013, SAL-028, SAL-237)
CREATE FUNCTION "factory_party_company_terms_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  loose CONSTANT text[] := ARRAY['version', 'updatedAt'];
  problem text;
  state text;
  owner_company uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    problem := "factory_intake_customer_problem"(NEW."tenantId", NEW."partyId", NEW."companyId", true);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'customers: terms % are for party %, which %', NEW."id", NEW."partyId", problem
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."partyId", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."partyId", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'customers: the party, company and creation of terms % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."endedAt" IS NOT NULL AND (to_jsonb(NEW) - loose) IS DISTINCT FROM (to_jsonb(OLD) - loose) THEN
      RAISE EXCEPTION 'customers: terms % were ended and never change; new terms are made as their own', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."depositPct" IS NOT NULL AND (NEW."depositPct" <= 0 OR NEW."depositPct" > 100) THEN
    RAISE EXCEPTION 'customers: the deposit of terms % is above 0 and at most 100 percent, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."creditLimitAmount" IS NULL) <> (NEW."creditLimitCurrency" IS NULL) OR NEW."creditLimitAmount" < 0
     OR NEW."creditLimitCurrency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'customers: the credit limit of terms % is 0 or more with its currency (ISO 4217), both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."paymentTerms", 500, true) THEN
    RAISE EXCEPTION 'customers: the payment terms of terms % are printed in up to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."endedAt" IS NULL) <> (NEW."endedById" IS NULL) THEN
    RAISE EXCEPTION 'customers: terms % are ended with when and by whom, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."endedAt" IS DISTINCT FROM OLD."endedAt") AND NOT "factory_recall_not_future"(NEW."endedAt") THEN
    RAISE EXCEPTION 'customers: terms % were ended at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."paymentTermsId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."paymentTermsId" IS DISTINCT FROM OLD."paymentTermsId") THEN
    SELECT t."status"::text, t."companyId" INTO state, owner_company FROM "PaymentTerms" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."paymentTermsId";
    IF FOUND AND (state <> 'ACTIVE' OR (owner_company IS NOT NULL AND owner_company <> NEW."companyId")) THEN
      RAISE EXCEPTION 'customers: terms % are given payment terms that are % or of another company', NEW."id", state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."priceListId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."priceListId" IS DISTINCT FROM OLD."priceListId") THEN
    SELECT l."status"::text, l."companyId" INTO state, owner_company FROM "PriceList" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."priceListId";
    IF FOUND AND (state <> 'ACTIVE' OR (owner_company IS NOT NULL AND owner_company <> NEW."companyId")) THEN
      RAISE EXCEPTION 'customers: terms % are given a price list that is % or of another company', NEW."id", state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "PartyCompanyTerms_guard" AFTER INSERT OR UPDATE ON "PartyCompanyTerms"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_company_terms_guard"();

-- One live row of terms per party and company.
CREATE UNIQUE INDEX "PartyCompanyTerms_one_live" ON "PartyCompanyTerms" ("tenantId", "partyId", "companyId") WHERE "endedAt" IS NULL;

-- =====================================================================================================================
-- Season (SAL-277)
CREATE FUNCTION "factory_season_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."code", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."code", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'customers: the company, code and creation of season % never change (styles keep its code as their season)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."code" !~ '^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,19}$' OR NEW."code" <> btrim(NEW."code") THEN
    RAISE EXCEPTION 'customers: season % has a code of one line, 1 to 20 characters (letters, digits, space . _ / -), not %', NEW."id", NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."name" IS NULL OR NOT "factory_recall_words_ok"(NEW."name", 100, false) OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'customers: season % has a name of one line (1 to 100 characters) and a note up to 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."endsOn" < NEW."startsOn" OR NEW."orderBookClosesOn" > NEW."endsOn" THEN
    RAISE EXCEPTION 'customers: season % runs from % to a day not before it, and its order book closes on or before its end', NEW."id", NEW."startsOn"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."closedAt" IS NULL AND NEW."closedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'customers: season % is CLOSED exactly with when it was closed (and by whom)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt") AND NOT "factory_recall_not_future"(NEW."closedAt") THEN
    RAISE EXCEPTION 'customers: season % was closed at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Season_guard" AFTER INSERT OR UPDATE ON "Season"
  FOR EACH ROW EXECUTE FUNCTION "factory_season_guard"();

-- =====================================================================================================================
-- The season of a quote version and of an order (SAL-277): OPEN and of the quote's (the order's) company when named or
-- changed. W1's QuoteVersion and SalesOrder guards stay as they are (a SENT version is frozen whole, seasonId included).
CREATE FUNCTION "factory_sales_season_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  season_company uuid;
  season_status text;
  sale_company uuid;
BEGIN
  IF NEW."seasonId" IS NULL OR (TG_OP = 'UPDATE' AND NEW."seasonId" IS NOT DISTINCT FROM OLD."seasonId") THEN
    RETURN NULL;
  END IF;
  SELECT s."companyId", s."status"::text INTO season_company, season_status FROM "Season" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."seasonId";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'QuoteVersion' THEN
    SELECT q."companyId" INTO sale_company FROM "Quote" q WHERE q."tenantId" = NEW."tenantId" AND q."id" = NEW."quoteId";
  ELSE
    sale_company := NEW."companyId";
  END IF;
  IF sale_company IS NOT NULL AND season_company <> sale_company THEN
    RAISE EXCEPTION 'customers: % % names a season of another company', TG_TABLE_NAME, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF season_status <> 'OPEN' THEN
    RAISE EXCEPTION 'customers: % % names season %, which is CLOSED; name an open season', TG_TABLE_NAME, NEW."id", NEW."seasonId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "QuoteVersion_season_check" AFTER INSERT OR UPDATE OF "seasonId" ON "QuoteVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_season_check"();
CREATE TRIGGER "SalesOrder_season_check" AFTER INSERT OR UPDATE OF "seasonId" ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_season_check"();

-- =====================================================================================================================
-- Party: a rider under a team or dealer (SAL-021). W2a's "Party_commercial_terms_guard" and W2b's "Party_website_check" stay
-- as they are.
CREATE FUNCTION "factory_party_team_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  team_kind text;
  team_roles text[];
  team_status text;
  team_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."teamPartyId", NEW."kind") IS NOT DISTINCT FROM (OLD."teamPartyId", OLD."kind") THEN
    RETURN NULL;
  END IF;
  IF NEW."kind" = 'PERSON' AND EXISTS (SELECT 1 FROM "Party" r WHERE r."tenantId" = NEW."tenantId" AND r."teamPartyId" = NEW."id" AND r."id" <> NEW."id") THEN
    RAISE EXCEPTION 'parties: party % has riders, so it stays an organisation (move its riders first)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."teamPartyId" IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW."kind" <> 'PERSON' OR NEW."teamPartyId" = NEW."id" THEN
    RAISE EXCEPTION 'parties: party % rides for a team, so it is a person (PERSON), never its own team', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT t."kind"::text, t."roles"::text[], t."status"::text, t."companyId" INTO team_kind, team_roles, team_status, team_company
    FROM "Party" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."teamPartyId";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF team_kind <> 'ORGANISATION' OR NOT (coalesce(team_roles, ARRAY[]::text[]) && ARRAY['CUSTOMER', 'BRAND'])
     OR (team_status = 'ARCHIVED' AND (TG_OP = 'INSERT' OR NEW."teamPartyId" IS DISTINCT FROM OLD."teamPartyId"))
     OR (team_company IS NOT NULL AND NEW."companyId" IS NOT NULL AND team_company <> NEW."companyId") THEN
    RAISE EXCEPTION 'parties: the team of rider % is an organisation with the customer or brand role, not archived, of the rider''s company or tenant-wide', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Party_team_check" AFTER INSERT OR UPDATE OF "teamPartyId", "kind" ON "Party"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_team_check"();

-- =====================================================================================================================
-- PartyContact: the lawful basis, consent, objection and erasure of a contact (SAL-022; GDPR arts. 6, 7, 17, 21).
CREATE FUNCTION "factory_party_contact_privacy_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."erasedAt" IS NOT NULL AND (NEW."erasedAt", NEW."erasedById") IS DISTINCT FROM (OLD."erasedAt", OLD."erasedById") THEN
      RAISE EXCEPTION 'parties: contact % was erased; the erasure is never changed or undone', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."erasedAt" IS NULL) <> (NEW."erasedById" IS NULL) THEN
    RAISE EXCEPTION 'parties: the erasure of contact % has when and by whom, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."erasedAt" IS NOT NULL AND (NEW."name" <> '' OR NEW."email" IS NOT NULL OR NEW."phone" IS NOT NULL OR NEW."status" <> 'ARCHIVED') THEN
    RAISE EXCEPTION 'parties: contact % was erased; its name, e-mail and phone stay blank and it stays archived (a new contact is made for new data)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."consentAt" IS NULL) <> (NEW."consentSource" IS NULL) OR NOT "factory_recall_words_ok"(NEW."consentSource", 500, true)
     OR (NEW."lawfulBasis" = 'CONSENT' AND NEW."consentAt" IS NULL) THEN
    RAISE EXCEPTION 'parties: contact % records consent with when and how it was given (up to 500 characters), both or neither, and a CONSENT basis has them', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."consentAt" IS DISTINCT FROM OLD."consentAt" OR NEW."objectedAt" IS DISTINCT FROM OLD."objectedAt" OR NEW."erasedAt" IS DISTINCT FROM OLD."erasedAt")
     AND NOT ("factory_recall_not_future"(NEW."consentAt") AND "factory_recall_not_future"(NEW."objectedAt") AND "factory_recall_not_future"(NEW."erasedAt")) THEN
    RAISE EXCEPTION 'parties: the consent, objection and erasure times of contact % are not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "PartyContact_privacy_check" AFTER INSERT OR UPDATE ON "PartyContact"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_contact_privacy_check"();
