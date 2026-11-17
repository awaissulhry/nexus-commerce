-- Written by hand (Prisma does not model triggers), after the generated 202611170300_sales_intake_orders_th_schema and
-- before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- A request becomes an order, TH-2 (threads plan, schema wave 3/9, B-TH-022; gaps G3, G6, N13). apps/factory-api checks all of
-- this first and answers in words (B-TH-025 Make order, B-TH-026 Make style draft, B-TH-043 Not an order); these rules are the
-- last word, for every login, the owner included.
--
--   Inquiry   ORDERED is a fourth final state beside QUOTED, DECLINED and LOST, reached only from an open state (NEW,
--             ASSIGNED, NEED_INFO), exactly with the order it became (salesOrderId): an order of its own company and party (the
--             foreign key holds both; a prospect's inquiry is matched to its customer first), named once and never changed,
--             never at insert, one inquiry per order (a partial unique index); closed with when and by whom as the others,
--             then frozen but its note and the erasure of its prospect. "Not an order" is a decline reason (NOT_AN_ORDER):
--             DECLINED with it needs no words, as every reason but OTHER. The style drafts made from it (styleIds): none at
--             insert, then only added at the end, each once, at most 50; each added style (every one when its customer is
--             set or changes) is one of its company or tenant-wide, of our own collection or of its customer's private label
--             (or of the team its rider rides for: `factory_intake_style_allowed`, wave 1/9), never another customer's.
--
-- REDEFINED, word for word but for the lines marked B-TH-022: …_sales_intake_w2b_guards' `factory_inquiry_guard` (the state
-- machine and the closing rules take ORDERED and its order). Its trigger `Inquiry_guard` is kept as it is. New: the function
-- `factory_inquiry_style_drafts_check`, its trigger `Inquiry_style_drafts_check`, the index `Inquiry_one_per_order`.
--
-- As every guard: a refusal is a check_violation (SQLSTATE 23514) in words; the checks are AFTER triggers (the policies speak
-- first). A rule that reads another row skips a row this session cannot see, but for the style drafts: only the office writes
-- an inquiry, and it reads every style of the tenant, so a style it cannot find is not one. No row is moved: no inquiry is
-- ORDERED or names a style draft before this wave.
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok" and "factory_recall_not_future" (…_recall_claims_w2b_guards),
-- "factory_styles_distinct" (…_styles_libraries_w2b_guards), "factory_intake_email_ok", "factory_intake_phone_ok" and
-- "factory_intake_customer_problem" (…_sales_intake_w2b_guards), "factory_intake_style_allowed" (…_sales_intake_portal_th_guards).

-- =====================================================================================================================
-- Inquiry: the state machine with ORDERED (REDEFINED: …_sales_intake_w2b_guards' factory_inquiry_guard).
CREATE OR REPLACE FUNCTION "factory_inquiry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
       OR NEW."salesOrderId" IS NOT NULL -- B-TH-022
       OR NEW."prospectErasedAt" IS NOT NULL OR NEW."prospectErasedById" IS NOT NULL THEN
      RAISE EXCEPTION 'customers: inquiry % is logged open (NEW, or ASSIGNED to someone), not closed, quoted, ordered or erased', NEW."id" -- B-TH-022
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
       AND NOT (OLD."status"::text = ANY (open_states) AND NEW."status"::text IN ('NEW', 'ASSIGNED', 'NEED_INFO', 'QUOTED', 'ORDERED', 'DECLINED', 'LOST')) THEN -- B-TH-022
      RAISE EXCEPTION 'customers: inquiry % cannot move from % to % (QUOTED, ORDERED, DECLINED and LOST are final)', OLD."id", OLD."status", NEW."status" -- B-TH-022
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
    -- B-TH-022: the order it became is named once, as its quote is.
    IF OLD."salesOrderId" IS NOT NULL AND NEW."salesOrderId" IS DISTINCT FROM OLD."salesOrderId" THEN
      RAISE EXCEPTION 'customers: the order of inquiry % is named once, never changed', OLD."id"
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
  -- B-TH-022: ORDERED exactly with the order it became, of its own party (the reference holds its company and party).
  IF (NEW."status"::text = 'ORDERED') <> (NEW."salesOrderId" IS NOT NULL) OR (NEW."salesOrderId" IS NOT NULL AND NEW."partyId" IS NULL) THEN
    RAISE EXCEPTION 'customers: inquiry % is ORDERED exactly with the order it became (an order of its customer)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DECLINED') <> (NEW."declineReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'customers: inquiry % is DECLINED exactly with its reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status"::text = ANY (open_states)) <> (NEW."closedAt" IS NULL) OR (NEW."closedAt" IS NULL AND NEW."closedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'customers: inquiry % is % with the wrong closing time (QUOTED, ORDERED, DECLINED and LOST have one, an open inquiry none)', NEW."id", NEW."status" -- B-TH-022
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

-- One inquiry per order (as one per quote).
CREATE UNIQUE INDEX "Inquiry_one_per_order" ON "Inquiry" ("tenantId", "salesOrderId") WHERE "salesOrderId" IS NOT NULL;

-- =====================================================================================================================
-- Inquiry: the style drafts made from it (B-TH-026).
CREATE FUNCTION "factory_inquiry_style_drafts_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  before_count integer := CASE WHEN TG_OP = 'UPDATE' THEN coalesce(cardinality(OLD."styleIds"), 0) ELSE 0 END;
  -- The styles to check: the added ones, or all of them when its customer changes (a prospect matched, B-W2b-295).
  check_from integer;
  added uuid[];
  style_company uuid;
  style_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."styleIds", NEW."partyId") IS NOT DISTINCT FROM (OLD."styleIds", OLD."partyId") THEN
    RETURN NULL;
  END IF;
  IF NEW."styleIds" IS NULL OR cardinality(NEW."styleIds") > 50 OR NOT "factory_styles_distinct"(NEW."styleIds") THEN
    RAISE EXCEPTION 'customers: the style drafts made from inquiry % are at most 50 styles, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND cardinality(NEW."styleIds") > 0 THEN
    RAISE EXCEPTION 'customers: inquiry % is logged with no style draft made from it yet', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (cardinality(NEW."styleIds") < before_count OR NEW."styleIds"[1:before_count] IS DISTINCT FROM OLD."styleIds"[1:before_count]) THEN
    RAISE EXCEPTION 'customers: the style drafts made from inquiry % are only added, after the ones named before; none is taken off or moved', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  check_from := CASE WHEN TG_OP = 'UPDATE' AND NEW."partyId" IS DISTINCT FROM OLD."partyId" THEN 0 ELSE before_count END;
  added := NEW."styleIds"[check_from + 1:cardinality(NEW."styleIds")];
  FOREACH style_id IN ARRAY coalesce(added, ARRAY[]::uuid[]) LOOP
    SELECT s."companyId" INTO style_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = style_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customers: inquiry % names %, which is not a style of the tenant, as a style draft made from it', NEW."id", style_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF style_company IS NOT NULL AND style_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'customers: inquiry % names style % of another company as a style draft made from it', NEW."id", style_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_intake_style_allowed"(NEW."tenantId", style_id, NEW."partyId") THEN
      RAISE EXCEPTION 'customers: inquiry % names another customer''s private-label style as a style draft made from it; a private-label style is made only for its own customer', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Inquiry_style_drafts_check" AFTER INSERT OR UPDATE OF "styleIds", "partyId" ON "Inquiry"
  FOR EACH ROW EXECUTE FUNCTION "factory_inquiry_style_drafts_check"();
