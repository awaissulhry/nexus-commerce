-- Written by hand (Prisma does not model triggers), after the generated 202611170610_threads_later_th_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Threads, the later depth, TH-9 (threads plan, schema wave 9/9, B-TH-090; gaps N4, N6 = L2-G14, N17, N18, N20; wall W01: drafts
-- and pins are the office's or the writer's own; a customer reads none of another customer's). apps/factory-api checks all of this
-- first and answers in words (B-TH-091 pins, B-TH-092 drafts, B-TH-093 Done, B-TH-094 the production answer, B-TH-095 withdraw);
-- these rules are the last word, for every login, the owner included.
--
--   Thread         Done (a work state apart from CLOSED, N18): doneAt and doneById both or neither, never at its making; who
--                  marked it, an active office person when set or changed; when, not in the future.
--   ThreadPin      a message pinned on its thread (N4): its party is the message's, copied by the database at insert (set exactly
--                  when the message is shared with the thread's party: the partner policy's key, so a customer reads the pins of
--                  messages shared with it, never a pin of an internal note); the key `pin:<threadId>:<messageId>` (one pin per
--                  message: a unique index; the isolation tests' copies add a `-…` suffix); never a held message (a mail in its
--                  undo window or taken back); pinned by an active office person, at a time not in the future; never changed
--                  (unpinned: removed). The message is of the pin's own thread: the foreign key.
--   ComposerDraft  what one person typed and has not sent (N6): its person, party, record, key and making never change; the key
--                  `draft:<recordType>:<recordId>:<userId>`, or `draft:new-request:<userId>` for the portal's New order (one
--                  draft per person and record: a unique index; the copies add a suffix); a record named by type and id, both or
--                  neither; the person an office user (no party) or a portal user of the row's party, never a floor worker (they
--                  are no user); a portal person's draft is on a record of their own party (the record's table says whose it is:
--                  the files step's `factory_file_record_party`; a record their session cannot read is not theirs) or their New
--                  order, and is a reply (PARTNER) or no mode, never an office note; text up to 20000 characters (empty while
--                  typing), its other fields a JSON object up to 64 kB, its files at most 50, each once. A session that cannot see
--                  the person is refused, not skipped: an office session sees every person of the tenant, so a portal session that
--                  cannot see them is naming someone who is not its own.
--   ErasureRecord  the erasure of a person (an ERASURE request's or a sweep's record of a User, anonymised or deleted) removes that
--                  person's drafts in the same transaction, as their read marks.
--   Inquiry        WITHDRAWN (N20) is a fifth final state, reached only from an open state (before the office decided), only for a
--                  request of a customer (a party), closed with when and by whom: a portal person of the request's own customer
--                  (the API does it in the portal's name, B-TH-095), with no words of the office (closeNote stays for DECLINED and
--                  LOST). REDEFINED for it, word for word but for the lines marked B-TH-090: the wave 3/9 `factory_inquiry_guard`
--                  (…_sales_intake_orders_th_guards), its trigger kept. The production answer (N17): productionAnswer, its
--                  answering time and who answered all or none; NOT_BEFORE exactly with productionNotBefore, a Monday (the week
--                  "not before week N" starts on: a date only, never a load); answered by an active office person, at a time not
--                  in the future; like every other column, changed only while the request is open (the guard above).
--
-- As every guard: a refusal is a check_violation (SQLSTATE 23514) in words, which name no party; the checks are AFTER triggers (the
-- policies speak first), but the copy of a pin's party and the refused change of a pin (BEFORE). No row is moved: nothing is done,
-- pinned, drafted, withdrawn or answered by production before this wave.
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok" and "factory_recall_not_future" (…_recall_claims_w2b_guards),
-- "factory_recall_model_name_ok" (…_recall_claims_w2b_guards), "factory_styles_distinct" (…_styles_libraries_w2b_guards),
-- "factory_privacy_ops_key_ok" (…_privacy_integration_w2b_guards), "factory_file_record_party" (…_files_record_party_th_guards),
-- "factory_intake_email_ok", "factory_intake_phone_ok" and "factory_intake_customer_problem" (…_sales_intake_w2b_guards).

-- =====================================================================================================================
-- Thread: Done, a work state apart from CLOSED.
CREATE FUNCTION "factory_thread_done_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  user_audience text;
  user_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."doneAt", NEW."doneById") IS NOT DISTINCT FROM (OLD."doneAt", OLD."doneById") THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' AND (NEW."doneAt" IS NOT NULL OR NEW."doneById" IS NOT NULL) THEN
    RAISE EXCEPTION 'threads: a new thread % is open work, not done', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."doneAt" IS NULL) <> (NEW."doneById" IS NULL) THEN
    RAISE EXCEPTION 'threads: thread % is done with when and by whom, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."doneAt" IS NOT NULL AND NOT "factory_recall_not_future"(NEW."doneAt") THEN
    RAISE EXCEPTION 'threads: thread % was marked done at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."doneById" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."doneById" IS DISTINCT FROM OLD."doneById") THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."doneById";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'threads: thread % is marked done by an active office person, not one that is % (%)', NEW."id", user_status, user_audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Thread_done_check" AFTER INSERT OR UPDATE OF "doneAt", "doneById" ON "Thread"
  FOR EACH ROW EXECUTE FUNCTION "factory_thread_done_check"();

-- =====================================================================================================================
-- ThreadPin: its party is its message's (BEFORE: the app never writes it); never changed.
CREATE FUNCTION "factory_thread_pin_party"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'threads: pin % is never changed; unpin the message and pin it again', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."partyId" := (SELECT m."partyId" FROM "Message" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."messageId");
  RETURN NEW;
END
$$;
CREATE TRIGGER "ThreadPin_party" BEFORE INSERT OR UPDATE ON "ThreadPin"
  FOR EACH ROW EXECUTE FUNCTION "factory_thread_pin_party"();

-- ThreadPin: once per message, never a held one, pinned by an active office person.
CREATE FUNCTION "factory_thread_pin_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  message_held boolean;
  message_party uuid;
  user_audience text;
  user_status text;
BEGIN
  IF NOT "factory_privacy_ops_key_ok"(NEW."key", concat('pin:', NEW."threadId", ':', NEW."messageId")) THEN
    RAISE EXCEPTION 'threads: the key of pin % is pin:<threadId>:<messageId> (a message is pinned once)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT m."held", m."partyId" INTO message_held, message_party FROM "Message" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."messageId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'threads: pin % names a message of this session''s', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF message_held THEN
    RAISE EXCEPTION 'threads: pin % names a mail in its undo window or taken back; such a mail is not pinned', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."partyId" IS DISTINCT FROM message_party THEN
    RAISE EXCEPTION 'threads: pin % carries its message''s party (shared or not)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."pinnedById";
  IF NOT FOUND OR user_audience <> 'OFFICE' OR user_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'threads: pin % is made by an active office person', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."pinnedAt" IS NULL OR NOT "factory_recall_not_future"(NEW."pinnedAt") THEN
    RAISE EXCEPTION 'threads: pin % was made at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ThreadPin_guard" AFTER INSERT ON "ThreadPin"
  FOR EACH ROW EXECUTE FUNCTION "factory_thread_pin_guard"();

-- =====================================================================================================================
-- ComposerDraft: whose draft, of which record, in what shape.
CREATE FUNCTION "factory_composer_draft_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  user_audience text;
  user_party uuid;
  record_known boolean;
  record_party uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."userId", NEW."partyId", NEW."recordType", NEW."recordId", NEW."key", NEW."createdAt")
       IS DISTINCT FROM (OLD."userId", OLD."partyId", OLD."recordType", OLD."recordId", OLD."key", OLD."createdAt") THEN
      RAISE EXCEPTION 'threads: the person, party, record and key of draft % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The shape: a record by type and id or none, the key, the text, the fields, the files.
  IF (NEW."recordType" IS NULL) <> (NEW."recordId" IS NULL)
     OR (NEW."recordType" IS NOT NULL AND NOT "factory_recall_model_name_ok"(NEW."recordType")) THEN
    RAISE EXCEPTION 'threads: draft % names its record by its model name and id, both or neither (the portal''s New order)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT "factory_privacy_ops_key_ok"(NEW."key",
       CASE WHEN NEW."recordType" IS NULL THEN concat('draft:new-request:', NEW."userId")
            ELSE concat('draft:', NEW."recordType", ':', NEW."recordId", ':', NEW."userId") END) THEN
    RAISE EXCEPTION 'threads: the key of draft % is draft:<recordType>:<recordId>:<userId>, or draft:new-request:<userId> (one per person and record)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."bodyText" IS NULL OR char_length(NEW."bodyText") > 20000 OR NEW."bodyText" ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' THEN
    RAISE EXCEPTION 'threads: the text of draft % is up to 20000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fields" IS NULL OR jsonb_typeof(NEW."fields") <> 'object' OR octet_length(NEW."fields"::text) > 65536 THEN
    RAISE EXCEPTION 'threads: the other fields of draft % are one JSON object up to 64 kB', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attachmentFileIds" IS NULL OR cardinality(NEW."attachmentFileIds") > 50 OR NOT "factory_styles_distinct"(NEW."attachmentFileIds") THEN
    RAISE EXCEPTION 'threads: draft % has at most 50 files, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Whose: an office person's (no party) or a portal person's of their own party, on their own party's record.
  IF TG_OP = 'INSERT' THEN
    SELECT u."audience"::text, u."partyId" INTO user_audience, user_party FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'threads: draft % names a person who is not one of this session''s people', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (user_audience = 'OFFICE' AND NEW."partyId" IS NOT NULL)
       OR (user_audience = 'PARTNER' AND (user_party IS NULL OR NEW."partyId" IS DISTINCT FROM user_party))
       OR user_audience NOT IN ('OFFICE', 'PARTNER') THEN
      RAISE EXCEPTION 'threads: draft % is an office person''s (no party) or a portal person''s (their own party)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."partyId" IS NOT NULL AND NEW."recordType" IS NOT NULL THEN
      SELECT r.known, r.party INTO record_known, record_party FROM "factory_file_record_party"(NEW."tenantId", NEW."recordType", NEW."recordId") r;
      IF NOT record_known OR record_party IS DISTINCT FROM NEW."partyId" THEN
        RAISE EXCEPTION 'threads: a portal person keeps drafts only on their own company''s records'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."partyId" IS NOT NULL AND NEW."audience" IS NOT NULL AND NEW."audience"::text <> 'PARTNER' THEN
    RAISE EXCEPTION 'threads: a portal person''s draft % is a reply, never an office note', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ComposerDraft_guard" AFTER INSERT OR UPDATE ON "ComposerDraft"
  FOR EACH ROW EXECUTE FUNCTION "factory_composer_draft_guard"();

-- ErasureRecord: a person erased takes their drafts with them (as their read marks, …_threads_reads_th_guards).
CREATE FUNCTION "factory_composer_drafts_erased"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "ComposerDraft" d WHERE d."tenantId" = NEW."tenantId" AND d."userId" = NEW."recordId";
  RETURN NULL;
END
$$;
CREATE TRIGGER "ErasureRecord_composer_drafts" AFTER INSERT ON "ErasureRecord"
  FOR EACH ROW WHEN (NEW."recordType" = 'User' AND NEW."method" <> 'KEPT')
  EXECUTE FUNCTION "factory_composer_drafts_erased"();

-- =====================================================================================================================
-- Inquiry: the state machine with WITHDRAWN (REDEFINED: …_sales_intake_orders_th_guards' factory_inquiry_guard).
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
  closer_party uuid; -- B-TH-090
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
       AND NOT (OLD."status"::text = ANY (open_states) AND NEW."status"::text IN ('NEW', 'ASSIGNED', 'NEED_INFO', 'QUOTED', 'ORDERED', 'DECLINED', 'LOST', 'WITHDRAWN')) THEN -- B-TH-090
      RAISE EXCEPTION 'customers: inquiry % cannot move from % to % (QUOTED, ORDERED, DECLINED, LOST and WITHDRAWN are final)', OLD."id", OLD."status", NEW."status" -- B-TH-090
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
    RAISE EXCEPTION 'customers: inquiry % is % with the wrong closing time (QUOTED, ORDERED, DECLINED, LOST and WITHDRAWN have one, an open inquiry none)', NEW."id", NEW."status" -- B-TH-090
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-TH-090: WITHDRAWN only for a request of a customer, closed by a portal person of that customer (the API does it in the
  -- portal's name).
  IF NEW."status"::text = 'WITHDRAWN' AND (NEW."partyId" IS NULL OR NEW."closedById" IS NULL) THEN -- B-TH-090
    RAISE EXCEPTION 'customers: inquiry % is WITHDRAWN only by its customer, who is named (a prospect''s request is not withdrawn: it is lost or declined)', NEW."id" -- B-TH-090
      USING ERRCODE = 'check_violation'; -- B-TH-090
  END IF; -- B-TH-090
  IF NEW."status"::text = 'WITHDRAWN' AND (TG_OP = 'INSERT' OR NEW."status" IS DISTINCT FROM OLD."status" OR NEW."closedById" IS DISTINCT FROM OLD."closedById") THEN -- B-TH-090
    SELECT u."audience"::text, u."partyId" INTO user_audience, closer_party FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."closedById"; -- B-TH-090
    IF NOT FOUND OR user_audience <> 'PARTNER' OR closer_party IS DISTINCT FROM NEW."partyId" THEN -- B-TH-090
      RAISE EXCEPTION 'customers: inquiry % is withdrawn by a portal person of its own customer, not by anyone else', NEW."id" -- B-TH-090
        USING ERRCODE = 'check_violation'; -- B-TH-090
    END IF; -- B-TH-090
  END IF; -- B-TH-090
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

-- =====================================================================================================================
-- Inquiry: production's answer.
CREATE FUNCTION "factory_inquiry_production_answer_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  user_audience text;
  user_status text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW."productionAnswer", NEW."productionNotBefore", NEW."productionAnsweredAt", NEW."productionAnsweredById")
         IS NOT DISTINCT FROM (OLD."productionAnswer", OLD."productionNotBefore", OLD."productionAnsweredAt", OLD."productionAnsweredById") THEN
    RETURN NULL;
  END IF;
  IF (NEW."productionAnswer" IS NULL) <> (NEW."productionAnsweredAt" IS NULL) OR (NEW."productionAnswer" IS NULL) <> (NEW."productionAnsweredById" IS NULL) THEN
    RAISE EXCEPTION 'customers: production''s answer on inquiry % comes with when and by whom, all or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."productionAnswer"::text IS NOT DISTINCT FROM 'NOT_BEFORE') <> (NEW."productionNotBefore" IS NOT NULL) THEN
    RAISE EXCEPTION 'customers: production''s answer on inquiry % names its week exactly when it says not before (NOT_BEFORE)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."productionNotBefore" IS NOT NULL AND extract(isodow FROM NEW."productionNotBefore") <> 1 THEN
    RAISE EXCEPTION 'customers: production''s answer on inquiry % names its week by its Monday, not %', NEW."id", NEW."productionNotBefore"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."productionAnsweredAt" IS NOT NULL AND NOT "factory_recall_not_future"(NEW."productionAnsweredAt") THEN
    RAISE EXCEPTION 'customers: production answered inquiry % at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."productionAnsweredById" IS NOT NULL THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."productionAnsweredById";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'customers: production''s answer on inquiry % is given by an active office person, not one that is % (%)', NEW."id", user_status, user_audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Inquiry_production_answer_check" AFTER INSERT OR UPDATE OF "productionAnswer", "productionNotBefore", "productionAnsweredAt", "productionAnsweredById" ON "Inquiry"
  FOR EACH ROW EXECUTE FUNCTION "factory_inquiry_production_answer_check"();
