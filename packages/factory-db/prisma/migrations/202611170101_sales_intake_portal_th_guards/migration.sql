-- Written by hand (Prisma does not model triggers), after the generated 202611170100_sales_intake_portal_th_schema and
-- before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The customer's request, TH-1b (threads plan, schema wave 1/9, B-TH-009; gaps L2-G01, L2-G08; review PR-05). The partner
-- role now READS Inquiry and InquiryLine by party (the generated policy migration); these rules keep what it reads its own
-- and keep another customer's private label off its requests. apps/factory-api checks all of this first and answers in
-- words; these rules are the last word, for every login, the owner included. No earlier function is redefined: the
-- …_sales_intake_w2b_guards triggers stay as they are (a closed inquiry stays frozen whole, the new columns included).
--
--   InquiryLine.partyId  its inquiry's party, copied at every insert and update of the line (whatever the writer gave) and
--                        when the inquiry's party is set or changes (the inquiry's own AFTER trigger); the partner policy's
--                        key, so a customer reads the lines of its own requests and never a prospect's or another's.
--   Inquiry              the customer's reference one line of 1 to 100 characters; a delivery address only with the
--                        inquiry's party (the foreign key holds it to that party's addresses), a SHIP_TO one not archived (a
--                        WAITING one is allowed: the office decides it with the order, as for a portal order request); when
--                        its party is set or changes, every line's style is one it may ask (below).
--   InquiryLine          the price shown 0 or more; its style is of our own collection (no brand) or a private-label style
--                        of the inquiry's party, or of the team the party rides for (a rider buys the team's kit, as the
--                        quote rule PRIVATE_LABEL says), never another customer's private label; a prospect's inquiry
--                        (no party yet) names no private-label style.
--
-- As every guard: a refusal is a check_violation (SQLSTATE 23514) in words; the checks are AFTER triggers (the policies
-- speak first), the copy of the party a BEFORE one. A rule that reads another row skips a row this session cannot see.

-- The lines written before this wave carry their inquiry's party. A line of a closed inquiry never changes for any login
-- (InquiryLine_guard), so the guard is off for this one statement: only the new key column is filled.
ALTER TABLE "InquiryLine" DISABLE TRIGGER "InquiryLine_guard";
UPDATE "InquiryLine" l
   SET "partyId" = i."partyId"
  FROM "Inquiry" i
 WHERE i."tenantId" = l."tenantId" AND i."id" = l."inquiryId" AND l."partyId" IS DISTINCT FROM i."partyId";
ALTER TABLE "InquiryLine" ENABLE TRIGGER "InquiryLine_guard";

-- Whether a style may be asked by this party: our own collection (no brand), the party's own private label, or the private
-- label of the team the party rides for. NULL party (a prospect): only our own collection. A style this session cannot see
-- passes (the foreign key and the earlier guard speak for it).
CREATE FUNCTION "factory_intake_style_allowed"(tenant uuid, style uuid, party uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  brand uuid;
  team uuid;
BEGIN
  IF style IS NULL THEN
    RETURN true;
  END IF;
  SELECT s."brandPartyId" INTO brand FROM "Style" s WHERE s."tenantId" = tenant AND s."id" = style;
  IF NOT FOUND OR brand IS NULL THEN
    RETURN true;
  END IF;
  IF party IS NULL THEN
    RETURN false;
  END IF;
  IF brand = party THEN
    RETURN true;
  END IF;
  SELECT p."teamPartyId" INTO team FROM "Party" p WHERE p."tenantId" = tenant AND p."id" = party;
  RETURN team IS NOT NULL AND team = brand;
END
$$;

-- =====================================================================================================================
-- InquiryLine: the inquiry's party, copied.
CREATE FUNCTION "factory_inquiry_line_party"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  party uuid;
BEGIN
  SELECT i."partyId" INTO party FROM "Inquiry" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."inquiryId";
  IF FOUND THEN
    NEW."partyId" := party;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "InquiryLine_party" BEFORE INSERT OR UPDATE ON "InquiryLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_inquiry_line_party"();

-- Inquiry: its party set or changed reaches its lines (their own BEFORE trigger copies it again).
CREATE FUNCTION "factory_inquiry_party_to_lines"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "InquiryLine" l SET "partyId" = NEW."partyId"
   WHERE l."tenantId" = NEW."tenantId" AND l."inquiryId" = NEW."id" AND l."partyId" IS DISTINCT FROM NEW."partyId";
  RETURN NULL;
END
$$;
CREATE TRIGGER "Inquiry_party_to_lines" AFTER UPDATE OF "partyId" ON "Inquiry"
  FOR EACH ROW WHEN (NEW."partyId" IS DISTINCT FROM OLD."partyId")
  EXECUTE FUNCTION "factory_inquiry_party_to_lines"();

-- =====================================================================================================================
-- Inquiry: the customer's reference, its delivery address, and the styles its lines may name for its party.
CREATE FUNCTION "factory_inquiry_portal_th_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  address_kinds text[];
  address_status text;
  refused integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."customerRef", NEW."shipToAddressId", NEW."partyId") IS NOT DISTINCT FROM (OLD."customerRef", OLD."shipToAddressId", OLD."partyId") THEN
    RETURN NULL;
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."customerRef", 100, false) THEN
    RAISE EXCEPTION 'customers: the customer''s reference of inquiry % is one line of 1 to 100 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shipToAddressId" IS NOT NULL AND NEW."partyId" IS NULL THEN
    RAISE EXCEPTION 'customers: inquiry % names a delivery address only with its customer (a prospect has none)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shipToAddressId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."shipToAddressId", NEW."partyId") IS DISTINCT FROM (OLD."shipToAddressId", OLD."partyId")) THEN
    SELECT a."kinds"::text[], a."status"::text INTO address_kinds, address_status
      FROM "PartyAddress" a WHERE a."tenantId" = NEW."tenantId" AND a."partyId" = NEW."partyId" AND a."id" = NEW."shipToAddressId";
    IF FOUND AND (NOT ('SHIP_TO' = ANY (address_kinds)) OR address_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'customers: inquiry % is delivered to one of its customer''s SHIP_TO addresses, not archived', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."partyId" IS DISTINCT FROM OLD."partyId" THEN
    SELECT count(*) INTO refused FROM "InquiryLine" l
     WHERE l."tenantId" = NEW."tenantId" AND l."inquiryId" = NEW."id"
       AND NOT "factory_intake_style_allowed"(NEW."tenantId", l."styleId", NEW."partyId");
    IF refused > 0 THEN
      RAISE EXCEPTION 'customers: inquiry % asks for another customer''s private-label style on % line(s); a private-label style is asked only by its own customer', NEW."id", refused
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Inquiry_portal_th_check" AFTER INSERT OR UPDATE OF "customerRef", "shipToAddressId", "partyId" ON "Inquiry"
  FOR EACH ROW EXECUTE FUNCTION "factory_inquiry_portal_th_check"();

-- =====================================================================================================================
-- InquiryLine: the price shown, and never another customer's private label (PR-05).
CREATE FUNCTION "factory_inquiry_line_th_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."styleId", NEW."unitPriceShown", NEW."partyId") IS NOT DISTINCT FROM (OLD."styleId", OLD."unitPriceShown", OLD."partyId") THEN
    RETURN NULL;
  END IF;
  IF NEW."unitPriceShown" IS NOT NULL AND NEW."unitPriceShown" < 0 THEN
    RAISE EXCEPTION 'customers: inquiry line % keeps the price shown as 0 or more, not %', NEW."id", NEW."unitPriceShown"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_intake_style_allowed"(NEW."tenantId", NEW."styleId", NEW."partyId") THEN
    RAISE EXCEPTION 'customers: inquiry line % asks for another customer''s private-label style; a private-label style is asked only by its own customer', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "InquiryLine_th_check" AFTER INSERT OR UPDATE OF "styleId", "unitPriceShown", "partyId" ON "InquiryLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_inquiry_line_th_check"();
