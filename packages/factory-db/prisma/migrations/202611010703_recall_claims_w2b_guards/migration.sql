-- Written by hand (Prisma does not model triggers), after the generated 202611010702_recall_claims_w2b_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Recall, authority and claims, W2b-4 schema wave 33/33 (B-W2b-222; PRD-380, PRD-387, PRD-388, PRD-390). apps/factory-api
-- checks all of this first and answers in words (B-W2b-260, -264); these rules are the last word, for every login, the owner
-- included.
--
--   AuthorityNotice      drafted first (DRAFT, not sent, no reference, no file) for an OPEN register entry, to a market of
--                        the tenant; DRAFT → SENT | CANCELLED only; sent by a person (when and who, exactly when SENT),
--                        not in the future and not before the entry's report day, while the entry is OPEN, and a notice of
--                        a RISK only once the entry's risk is YES; then frozen but for the authority's reference and the
--                        copy sent (a file of this notice), each filled in once, and the note; cancelled with when and why;
--                        its entry, market and creation never change; words per language (at least one). Never deleted.
--   RecallAction         its number by `factory_document_number_guard` (…_numbering_floor_documents_guards, as it is);
--                        drafted first (DRAFT, not started, notice not published) for an OPEN register entry and of its
--                        style; DRAFT → ACTIVE | CANCELLED, ACTIVE → CLOSED; started by a person while the entry is OPEN,
--                        closed with who, when and how it ended, cancelled with when and why; its scope (the whole style,
--                        or at least one batch, serial, work order of the company and style, or shipment of the company)
--                        set while DRAFT and only widened once started; the public notice per language ({ title, problem,
--                        action, contact }) published once by a person while ACTIVE, taken down once, never after it was
--                        published changed (a language may be added); CLOSED and CANCELLED frozen but the note (and the
--                        notice taken down); its entry, number, kind, style and creation never change. Never deleted.
--   RecallProgress       written while its action is a DRAFT or ACTIVE (its row FOR SHARE), removed only while it is a
--                        DRAFT; of a party of the action's company (or tenant-wide) and, optionally, one of that party's
--                        shipments of the company; the counts 0 or more and adding up (sent = returned + repaired +
--                        destroyed + still out); its action, party, shipment and creation never change.
--   DistributorNotice    drafted first for an OPEN register entry, to a party of the company (or tenant-wide); DRAFT → SENT
--                        | CANCELLED, SENT → ANSWERED | FAILED; sent by a person while the entry is OPEN (not before its
--                        report day); what was sent (the way, contact, language, words, the recall it tells of) never
--                        changes once it left; ANSWERED with the answer and when, FAILED with why and when, CANCELLED with
--                        why and when, each final but the note; an e-mail address for EMAIL, a phone number for PHONE; a
--                        link only for LINK (of the company, set once); the recall of its own entry and not cancelled; its
--                        entry, party and creation never change. Never deleted.
--   AuthorityRequest     its number by `factory_document_number_guard`; logged OPEN with no answer; OPEN → ANSWERED |
--                        CANCELLED, then frozen but the note; received not in the future, due not before the day it came;
--                        a market of the tenant; a style of the company (or tenant-wide), batches only with a style;
--                        answered by a person with when (not before it came) and what was sent; the evidence by record type
--                        + id, both or neither; the register entry (of the company, and of its style when it names one)
--                        set once; its company, number and creation never change. Never deleted.
--   SustainabilityClaim  drafted first (DRAFT, no approval, no withdrawal); DRAFT → APPROVED | WITHDRAWN, APPROVED →
--                        WITHDRAWN; approved with when and by whom, with at least one evidence file, every one AVAILABLE,
--                        and not after its evidence expired; once approved it changes no more but its withdrawal (when,
--                        why) and the note; withdrawn is final but the note; its scope says what it names (the company,
--                        one style, one material that is not a FINISHED garment), of its company or tenant-wide; its
--                        words per language (at least one); the phrase it is printed from a phrase of the tenant; its
--                        evidence files of the company or tenant-wide, each once, at most 50; the claim it supersedes is
--                        another one of its company; its company, code, superseded claim and creation never change.
--                        Never deleted.
--   ClaimUse             added only while its claim is APPROVED and its evidence holds today (its row FOR SHARE); a STYLE
--                        use names a Style of the claim's company (or tenant-wide); ended once (not before it was added),
--                        then frozen but the note; its claim, kind, record and creation never change. Never deleted.
--   PpeRegisterEntry     REDEFINED `factory_ppe_register_entry_guard` (…_followups_f1_w2b_guards' whole body; the trigger
--                        stays): word for word as F1, with one more source type: an AuthorityRequest (an entry opened
--                        from an authority's request). The two new kinds, WITHDRAWAL and AUTHORITY_REQUEST, need no rule of
--                        their own here (the API asks a withdrawal to name its garments, as W1 asks a recall).
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the checks are AFTER triggers (the
-- policies speak first), but the number guards and the refused deletes (BEFORE: the words come before a foreign key's; the
-- runtime roles have no DELETE grant on those tables anyway, so these speak to the owner). The tenant of a row is left to the
-- policies and the references, never compared here: a rule that reads another row skips a row this session cannot see. An
-- UPDATE that changes nothing passes.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers and
-- dates moved) and insert the copy: so the first rows the seed gives are ones a copy may repeat (a DRAFT notice, recall,
-- distributor notice and claim of an OPEN entry, an OPEN authority request, a progress row of a DRAFT recall without a
-- shipment, a use of an APPROVED claim whose evidence never expires), and one progress row per action, party and shipment is
-- the unique index (a null shipment is not compared).
--
-- USED FROM EARLIER WAVES, as they are: "factory_document_number_guard" (…_numbering_floor_documents_guards),
-- "factory_styles_distinct" (…_styles_libraries_w2b_guards), "factory_money_rome_day" (…_money_w2a_guards),
-- "factory_market_code_ok" and "factory_market_code_known" (…_compliance_rules_w2b_guards).

CREATE FUNCTION "factory_recall_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'recall: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_recall_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'recall: % % of "%" is kept, never deleted (cancel, close, withdraw or end it)', TG_TABLE_NAME, OLD."id", TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['AuthorityNotice', 'RecallAction', 'RecallProgress', 'DistributorNotice', 'AuthorityRequest',
                              'SustainabilityClaim', 'ClaimUse'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_recall_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['AuthorityNotice', 'RecallAction', 'DistributorNotice', 'AuthorityRequest', 'SustainabilityClaim', 'ClaimUse'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "factory_recall_never_deleted"()', name || '_never_deleted', name);
  END LOOP;
END
$$;

-- Words of at most `longest` characters, not blank, without control characters; `lines`: line breaks and tabs allowed (NULL:
-- not given, which the caller allows or not).
CREATE FUNCTION "factory_recall_words_ok"(words text, longest integer, lines boolean) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT words IS NULL
      OR (btrim(words) <> '' AND char_length(words) <= longest
          AND CASE WHEN lines THEN words !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' ELSE words !~ '[[:cntrl:]]' END)
$$;

-- Words per language: an object of at least one language tag (BCP 47: "it", "en", "de-CH") to words (see above).
CREATE FUNCTION "factory_recall_i18n_ok"(words jsonb, longest integer, lines boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry record;
  n integer := 0;
BEGIN
  IF words IS NULL OR jsonb_typeof(words) <> 'object' THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT e.key, e.value FROM jsonb_each(words) AS e LOOP
    n := n + 1;
    IF entry.key !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' OR jsonb_typeof(entry.value) <> 'string'
       OR NOT "factory_recall_words_ok"(entry.value #>> '{}', longest, lines) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN n > 0;
END
$$;

-- A public recall notice: per language (at least one) exactly { "title", "problem", "action", "contact" }: a title of one
-- line (1 to 200 characters), what is wrong and what to do (1 to 2000, line breaks allowed), whom to contact (1 to 1000).
CREATE FUNCTION "factory_recall_notice_ok"(notice jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry record;
  n integer := 0;
BEGIN
  IF notice IS NULL OR jsonb_typeof(notice) <> 'object' THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT e.key, e.value FROM jsonb_each(notice) AS e LOOP
    n := n + 1;
    IF entry.key !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' OR jsonb_typeof(entry.value) <> 'object' THEN
      RETURN false;
    END IF;
    IF (SELECT array_agg(k.name ORDER BY k.name) FROM jsonb_object_keys(entry.value) AS k(name)) IS DISTINCT FROM ARRAY['action', 'contact', 'problem', 'title']
       OR jsonb_typeof(entry.value -> 'title') <> 'string' OR NOT "factory_recall_words_ok"(entry.value ->> 'title', 200, false)
       OR jsonb_typeof(entry.value -> 'problem') <> 'string' OR NOT "factory_recall_words_ok"(entry.value ->> 'problem', 2000, true)
       OR jsonb_typeof(entry.value -> 'action') <> 'string' OR NOT "factory_recall_words_ok"(entry.value ->> 'action', 2000, true)
       OR jsonb_typeof(entry.value -> 'contact') <> 'string' OR NOT "factory_recall_words_ok"(entry.value ->> 'contact', 1000, true) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN n > 0;
END
$$;

-- Codes as reported (batch numbers, serials): each 1 to `longest` characters of one line without spaces at either end, each
-- once, at most `most`.
CREATE FUNCTION "factory_recall_codes_ok"(list text[], longest integer, most integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT list IS NOT NULL
     AND cardinality(list) <= most
     AND "factory_styles_distinct"(list)
     AND NOT EXISTS (SELECT 1 FROM unnest(list) AS c(code)
                      WHERE c.code IS NULL OR c.code <> btrim(c.code) OR NOT "factory_recall_words_ok"(c.code, longest, false))
$$;

-- A time that is not in the future (five minutes of clock difference allowed). NULL: not given.
CREATE FUNCTION "factory_recall_not_future"(at timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT at IS NULL OR at <= now() + interval '5 minutes'
$$;

-- A record type: a model name ("EvidencePack", "LabelTemplate"), a capital, then letters and digits, 2 to 60.
CREATE FUNCTION "factory_recall_model_name_ok"(name text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT name IS NOT NULL AND name ~ '^[A-Z][A-Za-z0-9]{1,59}$'
$$;

-- =====================================================================================================================
-- AuthorityNotice (PRD-387; Reg. (EU) 2016/425 art. 8(8))
CREATE FUNCTION "factory_authority_notice_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_status text;
  entry_risk text;
  entry_reported timestamptz;
  file_type text;
  file_record uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."sentAt" IS NOT NULL OR NEW."sentById" IS NOT NULL OR NEW."reference" IS NOT NULL
       OR NEW."fileId" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL OR NEW."cancelReason" IS NOT NULL THEN
      RAISE EXCEPTION 'recall: authority notice % is drafted first (DRAFT, not sent, without a reference or a copy)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."registerEntryId", NEW."marketCode", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."registerEntryId", OLD."marketCode", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'recall: the register entry, the market and the creation of authority notice % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (OLD."status" = 'DRAFT' AND NEW."status" IN ('SENT', 'CANCELLED')) THEN
      RAISE EXCEPTION 'recall: authority notice % moves DRAFT → SENT | CANCELLED only (not % → %)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'SENT'
       AND (to_jsonb(NEW) - ARRAY['reference', 'fileId', 'note', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['reference', 'fileId', 'note', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'recall: authority notice % was sent and never changes (only the authority''s reference, its copy and the note are filled in)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CANCELLED'
       AND (to_jsonb(NEW) - ARRAY['note', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['note', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'recall: authority notice % is CANCELLED and never changes (only the note)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."reference" IS NOT NULL AND NEW."reference" IS DISTINCT FROM OLD."reference")
       OR (OLD."fileId" IS NOT NULL AND NEW."fileId" IS DISTINCT FROM OLD."fileId") THEN
      RAISE EXCEPTION 'recall: the authority''s reference and the copy of authority notice % are filled in once, never changed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Every row.
  IF NOT "factory_market_code_ok"(NEW."marketCode") THEN
    RAISE EXCEPTION 'recall: authority notice % names its market by its code ("IT", "DE"), not %', NEW."id", NEW."marketCode"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."authorityName" IS NULL OR NOT "factory_recall_words_ok"(NEW."authorityName", 300, false)
     OR NOT "factory_recall_i18n_ok"(NEW."words", 20000, true) OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'recall: authority notice % names the authority (1 to 300 characters) and says what it reports per language ({ "it": "…" }, 1 to 20000 characters each), with a note up to 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'SENT') <> (NEW."sentAt" IS NOT NULL) OR (NEW."status" = 'SENT') <> (NEW."sentById" IS NOT NULL) THEN
    RAISE EXCEPTION 'recall: authority notice % is sent with when and by whom (a person: nothing goes to an authority by itself), exactly when SENT', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" <> 'SENT' AND (NEW."reference" IS NOT NULL OR NEW."fileId" IS NOT NULL))
     OR NOT "factory_recall_words_ok"(NEW."reference", 200, false) THEN
    RAISE EXCEPTION 'recall: authority notice % takes the authority''s reference (1 to 200 characters) and its copy only once it is SENT', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."cancelReason", 500, true) THEN
    RAISE EXCEPTION 'recall: authority notice % is CANCELLED exactly with when and why (1 to 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it names (checked when it is set or changes; a row this session cannot see is skipped).
  IF TG_OP = 'INSERT' AND NOT "factory_market_code_known"(NEW."tenantId", NEW."marketCode") THEN
    RAISE EXCEPTION 'recall: authority notice % is for market %, which is not a market of the tenant (Rules & markets)', NEW."id", NEW."marketCode"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR (NEW."status" = 'SENT' AND OLD."status" <> 'SENT') THEN
    SELECT e."status"::text, e."risk"::text, e."reportedAt" INTO entry_status, entry_risk, entry_reported
      FROM "PpeRegisterEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."registerEntryId" FOR SHARE;
    IF FOUND THEN
      IF entry_status <> 'OPEN' THEN
        RAISE EXCEPTION 'recall: authority notice % is drafted and sent while its register entry is OPEN (it is %)', NEW."id", entry_status
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."status" = 'SENT' THEN
        IF NEW."decision" = 'RISK' AND entry_risk <> 'YES' THEN
          RAISE EXCEPTION 'recall: authority notice % reports a risk: its register entry''s risk is decided YES first (it is %)', NEW."id", entry_risk
            USING ERRCODE = 'check_violation';
        END IF;
        IF NOT "factory_recall_not_future"(NEW."sentAt") OR "factory_money_rome_day"(NEW."sentAt") < "factory_money_rome_day"(entry_reported) THEN
          RAISE EXCEPTION 'recall: authority notice % is sent at a time not in the future and not before the day its register entry was reported', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;
  IF NEW."fileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."fileId" IS DISTINCT FROM OLD."fileId") THEN
    SELECT f."recordType", f."recordId" INTO file_type, file_record
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
    IF FOUND AND (file_type <> 'AuthorityNotice' OR file_record <> NEW."id") THEN
      RAISE EXCEPTION 'recall: the copy of authority notice % is a file of this notice (it is a file of % %)', NEW."id", file_type, file_record
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "AuthorityNotice_guard" AFTER INSERT OR UPDATE ON "AuthorityNotice"
  FOR EACH ROW EXECUTE FUNCTION "factory_authority_notice_guard"();

-- =====================================================================================================================
-- RecallAction (PRD-388)
CREATE TRIGGER "RecallAction_number" BEFORE INSERT OR UPDATE ON "RecallAction"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('recall action', 'RECALL');

CREATE FUNCTION "factory_recall_action_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_status text;
  entry_style uuid;
  entry_reported timestamptz;
  wanted integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."startedAt" IS NOT NULL OR NEW."startedById" IS NOT NULL OR NEW."closedAt" IS NOT NULL
       OR NEW."closedById" IS NOT NULL OR NEW."closeNote" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL OR NEW."cancelReason" IS NOT NULL
       OR NEW."noticePublishedAt" IS NOT NULL OR NEW."noticePublishedById" IS NOT NULL OR NEW."noticeWithdrawnAt" IS NOT NULL THEN
      RAISE EXCEPTION 'recall: recall action % is drafted first (DRAFT, not started, its notice not published)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."registerEntryId", NEW."kind", NEW."styleId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."registerEntryId", OLD."kind", OLD."styleId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'recall: the register entry, kind, style and creation of recall action % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'DRAFT' AND NEW."status" IN ('ACTIVE', 'CANCELLED'))
      OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'CLOSED')) THEN
      RAISE EXCEPTION 'recall: recall action % moves DRAFT → ACTIVE | CANCELLED, ACTIVE → CLOSED (not % → %)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED')
       AND (to_jsonb(NEW) - ARRAY['note', 'noticeWithdrawnAt', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['note', 'noticeWithdrawnAt', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'recall: recall action % is % and never changes (only the note, and its public notice taken down)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND ((OLD."wholeStyle" AND NOT NEW."wholeStyle")
            OR NOT (NEW."batchNumbers" @> OLD."batchNumbers") OR NOT (NEW."serials" @> OLD."serials")
            OR NOT (NEW."workOrderIds" @> OLD."workOrderIds") OR NOT (NEW."shipmentIds" @> OLD."shipmentIds")) THEN
      RAISE EXCEPTION 'recall: recall action % started: its scope only widens (nothing it calls back is taken out)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."startedAt" IS NOT NULL AND (NEW."startedAt", NEW."startedById") IS DISTINCT FROM (OLD."startedAt", OLD."startedById"))
       OR (OLD."noticePublishedAt" IS NOT NULL AND (NEW."noticePublishedAt", NEW."noticePublishedById") IS DISTINCT FROM (OLD."noticePublishedAt", OLD."noticePublishedById"))
       OR (OLD."noticeWithdrawnAt" IS NOT NULL AND NEW."noticeWithdrawnAt" IS DISTINCT FROM OLD."noticeWithdrawnAt") THEN
      RAISE EXCEPTION 'recall: when recall action % started, when its notice was published and when it was taken down are set once, never changed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."noticePublishedAt" IS NOT NULL AND NOT (NEW."publicNotice" @> OLD."publicNotice") THEN
      RAISE EXCEPTION 'recall: the public notice of recall action % was published: its words never change (a language may be added)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."noticePublishedAt" IS NOT NULL AND OLD."noticePublishedAt" IS NULL AND NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'recall: the public notice of recall action % is published while the action runs (ACTIVE)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Every row.
  IF NOT NEW."wholeStyle"
     AND cardinality(NEW."batchNumbers") + cardinality(NEW."serials") + cardinality(NEW."workOrderIds") + cardinality(NEW."shipmentIds") = 0 THEN
    RAISE EXCEPTION 'recall: recall action % calls back the whole style or names what it calls back (batches, serials, work orders or shipments)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_codes_ok"(NEW."batchNumbers", 100, 1000) OR NOT "factory_recall_codes_ok"(NEW."serials", 100, 10000)
     OR NOT "factory_styles_distinct"(NEW."workOrderIds") OR NOT "factory_styles_distinct"(NEW."shipmentIds")
     OR cardinality(NEW."workOrderIds") > 1000 OR cardinality(NEW."shipmentIds") > 1000 THEN
    RAISE EXCEPTION 'recall: recall action % names each batch, serial (1 to 100 characters), work order and shipment once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."publicNotice" IS NOT NULL AND NOT "factory_recall_notice_ok"(NEW."publicNotice") THEN
    RAISE EXCEPTION 'recall: the public notice of recall action % says per language { "title", "problem", "action", "contact" } (a title of 1 to 200 characters, the others 1 to 2000, the contact up to 1000)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."noticePublishedAt" IS NULL) <> (NEW."noticePublishedById" IS NULL)
     OR (NEW."noticePublishedAt" IS NOT NULL AND NEW."publicNotice" IS NULL)
     OR (NEW."noticeWithdrawnAt" IS NOT NULL AND (NEW."noticePublishedAt" IS NULL OR NEW."noticeWithdrawnAt" < NEW."noticePublishedAt")) THEN
    RAISE EXCEPTION 'recall: the public notice of recall action % is published with its words, when and by whom (a person), and taken down only after it was published', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('ACTIVE', 'CLOSED')) <> (NEW."startedAt" IS NOT NULL) OR (NEW."startedAt" IS NULL) <> (NEW."startedById" IS NULL) THEN
    RAISE EXCEPTION 'recall: recall action % is started with when and by whom (a person), exactly from ACTIVE on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."closedAt" IS NULL) <> (NEW."closedById" IS NULL)
     OR (NEW."closedAt" IS NULL) <> (NEW."closeNote" IS NULL) OR NOT "factory_recall_words_ok"(NEW."closeNote", 2000, true)
     OR NEW."closedAt" < NEW."startedAt" THEN
    RAISE EXCEPTION 'recall: recall action % is CLOSED exactly with when (not before it started), by whom and how it ended (1 to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."cancelReason", 500, true) OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'recall: recall action % is CANCELLED exactly with when and why (1 to 500 characters); its note is up to 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt"
      OR NEW."noticePublishedAt" IS DISTINCT FROM OLD."noticePublishedAt" OR NEW."noticeWithdrawnAt" IS DISTINCT FROM OLD."noticeWithdrawnAt")
     AND NOT ("factory_recall_not_future"(NEW."startedAt") AND "factory_recall_not_future"(NEW."closedAt")
              AND "factory_recall_not_future"(NEW."noticePublishedAt") AND "factory_recall_not_future"(NEW."noticeWithdrawnAt")) THEN
    RAISE EXCEPTION 'recall: recall action % records its start, its end and its notice at times not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it names (checked when it is set or changes; a row this session cannot see is skipped).
  IF TG_OP = 'INSERT' OR (NEW."status" = 'ACTIVE' AND OLD."status" <> 'ACTIVE') THEN
    SELECT e."status"::text, e."styleId", e."reportedAt" INTO entry_status, entry_style, entry_reported
      FROM "PpeRegisterEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."registerEntryId" FOR SHARE;
    IF FOUND THEN
      IF entry_status <> 'OPEN' THEN
        RAISE EXCEPTION 'recall: recall action % is drafted and started while its register entry is OPEN (it is %)', NEW."id", entry_status
          USING ERRCODE = 'check_violation';
      END IF;
      IF entry_style <> NEW."styleId" THEN
        RAISE EXCEPTION 'recall: recall action % is of its register entry''s style', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."startedAt" IS NOT NULL AND "factory_money_rome_day"(NEW."startedAt") < "factory_money_rome_day"(entry_reported) THEN
        RAISE EXCEPTION 'recall: recall action % starts on or after the day its register entry was reported', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW."workOrderIds" IS DISTINCT FROM OLD."workOrderIds" THEN
    wanted := cardinality(NEW."workOrderIds");
    IF wanted > 0 AND (SELECT count(*) FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."companyId" = NEW."companyId"
                         AND w."styleId" = NEW."styleId" AND w."id" = ANY (NEW."workOrderIds")) <> wanted THEN
      RAISE EXCEPTION 'recall: recall action % names a work order that is not of its company and style', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW."shipmentIds" IS DISTINCT FROM OLD."shipmentIds" THEN
    wanted := cardinality(NEW."shipmentIds");
    IF wanted > 0 AND (SELECT count(*) FROM "Shipment" s WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId"
                         AND s."id" = ANY (NEW."shipmentIds")) <> wanted THEN
      RAISE EXCEPTION 'recall: recall action % names a shipment that is not of its company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "RecallAction_guard" AFTER INSERT OR UPDATE ON "RecallAction"
  FOR EACH ROW EXECUTE FUNCTION "factory_recall_action_guard"();

-- =====================================================================================================================
-- RecallProgress (PRD-388)
CREATE FUNCTION "factory_recall_progress_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  action_status text;
  action_company uuid;
  party_company uuid;
  shipment_party uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."recallActionId", NEW."partyId", NEW."shipmentId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."recallActionId", OLD."partyId", OLD."shipmentId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'recall: the recall, customer, shipment and creation of progress row % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT a."status"::text, a."companyId" INTO action_status, action_company
    FROM "RecallAction" a
   WHERE a."tenantId" = coalesce(NEW."tenantId", OLD."tenantId") AND a."id" = coalesce(NEW."recallActionId", OLD."recallActionId") FOR SHARE;
  IF TG_OP = 'DELETE' THEN
    IF FOUND AND action_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'recall: progress row % is removed only while its recall is a DRAFT (it is %)', OLD."id", action_status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF FOUND AND action_status NOT IN ('DRAFT', 'ACTIVE') THEN
    RAISE EXCEPTION 'recall: progress row % is written only while its recall is a DRAFT or ACTIVE (it is %)', NEW."id", action_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."unitsSent" < 0 OR NEW."unitsReturned" < 0 OR NEW."unitsRepaired" < 0 OR NEW."unitsDestroyed" < 0 OR NEW."unitsStillOut" < 0
     OR NEW."unitsReturned" + NEW."unitsRepaired" + NEW."unitsDestroyed" + NEW."unitsStillOut" <> NEW."unitsSent" THEN
    RAISE EXCEPTION 'recall: progress row % counts 0 or more of each, and what was sent adds up: returned % + repaired % + destroyed % + still out % = sent %',
      NEW."id", NEW."unitsReturned", NEW."unitsRepaired", NEW."unitsDestroyed", NEW."unitsStillOut", NEW."unitsSent"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'recall: the note of progress row % is 1 to 2000 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND action_company IS NOT NULL THEN
    SELECT p."companyId" INTO party_company FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND party_company IS NOT NULL AND party_company <> action_company THEN
      RAISE EXCEPTION 'recall: progress row % follows a party of its recall''s company or a tenant-wide one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."shipmentId" IS NOT NULL THEN
      SELECT s."partyId" INTO shipment_party FROM "Shipment" s
       WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = action_company AND s."id" = NEW."shipmentId";
      IF NOT FOUND OR shipment_party <> NEW."partyId" THEN
        RAISE EXCEPTION 'recall: progress row % follows a shipment of its recall''s company to its own customer', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "RecallProgress_guard" AFTER INSERT OR UPDATE OR DELETE ON "RecallProgress"
  FOR EACH ROW EXECUTE FUNCTION "factory_recall_progress_guard"();

-- =====================================================================================================================
-- DistributorNotice (Reg. (EU) 2016/425 art. 8(4); PRD-388)
CREATE FUNCTION "factory_distributor_notice_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_status text;
  entry_reported timestamptz;
  party_company uuid;
  action_status text;
  link_company uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."sentAt" IS NOT NULL OR NEW."sentById" IS NOT NULL OR NEW."answeredAt" IS NOT NULL
       OR NEW."answer" IS NOT NULL OR NEW."answeredByName" IS NOT NULL OR NEW."failedAt" IS NOT NULL OR NEW."failureReason" IS NOT NULL
       OR NEW."cancelledAt" IS NOT NULL OR NEW."cancelReason" IS NOT NULL THEN
      RAISE EXCEPTION 'recall: distributor notice % is written first (DRAFT, not sent, no answer)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."registerEntryId", NEW."partyId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."registerEntryId", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'recall: the register entry, the party and the creation of distributor notice % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'DRAFT' AND NEW."status" IN ('SENT', 'CANCELLED'))
      OR (OLD."status" = 'SENT' AND NEW."status" IN ('ANSWERED', 'FAILED'))) THEN
      RAISE EXCEPTION 'recall: distributor notice % moves DRAFT → SENT | CANCELLED, SENT → ANSWERED | FAILED (not % → %)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND (NEW."recallActionId", NEW."channel", NEW."contactName", NEW."contact", NEW."language", NEW."subject", NEW."message", NEW."sentAt", NEW."sentById")
           IS DISTINCT FROM (OLD."recallActionId", OLD."channel", OLD."contactName", OLD."contact", OLD."language", OLD."subject", OLD."message", OLD."sentAt", OLD."sentById") THEN
      RAISE EXCEPTION 'recall: distributor notice % left: what was sent, to whom, how and when never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('ANSWERED', 'FAILED', 'CANCELLED')
       AND (to_jsonb(NEW) - ARRAY['note', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['note', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'recall: distributor notice % is % and never changes (only the note); send a new one', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."linkId" IS NOT NULL AND NEW."linkId" IS DISTINCT FROM OLD."linkId" THEN
      RAISE EXCEPTION 'recall: the link of distributor notice % is set once, never changed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Every row.
  IF (NEW."channel" = 'EMAIL' AND (NEW."contact" IS NULL OR char_length(NEW."contact") > 320 OR NEW."contact" !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+\.[^@[:space:][:cntrl:]]+$'))
     OR (NEW."channel" = 'PHONE' AND (NEW."contact" IS NULL OR NEW."contact" !~ '^\+?[0-9][0-9 ()./-]{4,39}$'))
     OR NOT "factory_recall_words_ok"(NEW."contact", 320, false) OR NOT "factory_recall_words_ok"(NEW."contactName", 200, false) THEN
    RAISE EXCEPTION 'recall: distributor notice % reaches an e-mail address (EMAIL) or a phone number (PHONE), named in one line (up to 200 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."language" IS NULL OR NEW."language" !~ '^[a-z]{2,3}$'
     OR NOT "factory_recall_words_ok"(NEW."subject", 300, false)
     OR NEW."message" IS NULL OR NOT "factory_recall_words_ok"(NEW."message", 20000, true)
     OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'recall: distributor notice % names its language (ISO 639: "it") and has its words (1 to 20000 characters), a subject of one line up to 300 and a note up to 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."linkId" IS NOT NULL AND NEW."channel" <> 'LINK' THEN
    RAISE EXCEPTION 'recall: distributor notice % names a link only when it goes by link', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('SENT', 'ANSWERED', 'FAILED')) <> (NEW."sentAt" IS NOT NULL) OR (NEW."sentAt" IS NULL) <> (NEW."sentById" IS NULL) THEN
    RAISE EXCEPTION 'recall: distributor notice % is sent with when and by whom (a person), exactly from SENT on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ANSWERED') <> (NEW."answeredAt" IS NOT NULL) OR (NEW."answeredAt" IS NULL) <> (NEW."answer" IS NULL)
     OR (NEW."answer" IS NULL AND NEW."answeredByName" IS NOT NULL)
     OR NOT "factory_recall_words_ok"(NEW."answer", 4000, true) OR NOT "factory_recall_words_ok"(NEW."answeredByName", 200, false)
     OR NEW."answeredAt" < NEW."sentAt" THEN
    RAISE EXCEPTION 'recall: distributor notice % is ANSWERED exactly with when (not before it was sent) and the answer (1 to 4000 characters), and who answered (up to 200)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'FAILED') <> (NEW."failedAt" IS NOT NULL) OR (NEW."failedAt" IS NULL) <> (NEW."failureReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."failureReason", 500, true) OR NEW."failedAt" < NEW."sentAt" THEN
    RAISE EXCEPTION 'recall: distributor notice % FAILED exactly with when (not before it was sent) and why (1 to 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."cancelReason", 500, true) THEN
    RAISE EXCEPTION 'recall: distributor notice % is CANCELLED exactly with when and why (1 to 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."sentAt" IS DISTINCT FROM OLD."sentAt" OR NEW."answeredAt" IS DISTINCT FROM OLD."answeredAt" OR NEW."failedAt" IS DISTINCT FROM OLD."failedAt")
     AND NOT ("factory_recall_not_future"(NEW."sentAt") AND "factory_recall_not_future"(NEW."answeredAt") AND "factory_recall_not_future"(NEW."failedAt")) THEN
    RAISE EXCEPTION 'recall: distributor notice % records when it was sent, answered or failed at times not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it names (checked when it is set or changes; a row this session cannot see is skipped).
  IF TG_OP = 'INSERT' OR (NEW."status" = 'SENT' AND OLD."status" <> 'SENT') THEN
    SELECT e."status"::text, e."reportedAt" INTO entry_status, entry_reported
      FROM "PpeRegisterEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."registerEntryId" FOR SHARE;
    IF FOUND THEN
      IF entry_status <> 'OPEN' THEN
        RAISE EXCEPTION 'recall: distributor notice % is written and sent while its register entry is OPEN (it is %)', NEW."id", entry_status
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."sentAt" IS NOT NULL AND "factory_money_rome_day"(NEW."sentAt") < "factory_money_rome_day"(entry_reported) THEN
        RAISE EXCEPTION 'recall: distributor notice % is sent on or after the day its register entry was reported', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT p."companyId" INTO party_company FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND party_company IS NOT NULL AND party_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'recall: distributor notice % tells a party of its company or a tenant-wide one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."recallActionId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."recallActionId" IS DISTINCT FROM OLD."recallActionId") THEN
    SELECT a."status"::text INTO action_status FROM "RecallAction" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."recallActionId";
    IF FOUND AND action_status = 'CANCELLED' THEN
      RAISE EXCEPTION 'recall: distributor notice % tells of a recall that was cancelled', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."linkId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."linkId" IS DISTINCT FROM OLD."linkId") THEN
    SELECT l."companyId" INTO link_company FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."linkId";
    IF FOUND AND link_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'recall: the link of distributor notice % is one of its company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "DistributorNotice_guard" AFTER INSERT OR UPDATE ON "DistributorNotice"
  FOR EACH ROW EXECUTE FUNCTION "factory_distributor_notice_guard"();

-- =====================================================================================================================
-- AuthorityRequest (PRD-390; Reg. (EU) 2019/1020 art. 4(3))
CREATE TRIGGER "AuthorityRequest_number" BEFORE INSERT OR UPDATE ON "AuthorityRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('authority request', 'AUTHORITY_REQUEST');

CREATE FUNCTION "factory_authority_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  style_company uuid;
  entry_style uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."answeredAt" IS NOT NULL OR NEW."answeredById" IS NOT NULL OR NEW."answerSummary" IS NOT NULL
       OR NEW."cancelledAt" IS NOT NULL OR NEW."cancelReason" IS NOT NULL THEN
      RAISE EXCEPTION 'recall: authority request % is logged OPEN, not answered yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'recall: the company and creation of authority request % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (OLD."status" = 'OPEN' AND NEW."status" IN ('ANSWERED', 'CANCELLED')) THEN
      RAISE EXCEPTION 'recall: authority request % moves OPEN → ANSWERED | CANCELLED only (not % → %)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN'
       AND (to_jsonb(NEW) - ARRAY['note', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['note', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'recall: authority request % is % and never changes (only the note); a new request is logged as its own', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."registerEntryId" IS NOT NULL AND NEW."registerEntryId" IS DISTINCT FROM OLD."registerEntryId" THEN
      RAISE EXCEPTION 'recall: the register entry of authority request % is set once, never changed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Every row.
  IF NOT "factory_market_code_ok"(NEW."marketCode") THEN
    RAISE EXCEPTION 'recall: authority request % names the authority''s market by its code ("IT"), not %', NEW."id", NEW."marketCode"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."authorityName" IS NULL OR NOT "factory_recall_words_ok"(NEW."authorityName", 300, false)
     OR NOT "factory_recall_words_ok"(NEW."authorityReference", 200, false)
     OR NEW."request" IS NULL OR NOT "factory_recall_words_ok"(NEW."request", 4000, true)
     OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'recall: authority request % names the authority (1 to 300 characters) and its reference (up to 200), says what it asks (1 to 4000) and has a note up to 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_codes_ok"(NEW."batchNumbers", 100, 500) OR (cardinality(NEW."batchNumbers") > 0 AND NEW."styleId" IS NULL) THEN
    RAISE EXCEPTION 'recall: authority request % names batches (1 to 100 characters, each once) only with their style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt") AND NOT "factory_recall_not_future"(NEW."receivedAt") THEN
    RAISE EXCEPTION 'recall: authority request % came at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."dueOn" < "factory_money_rome_day"(NEW."receivedAt") THEN
    RAISE EXCEPTION 'recall: authority request % is due on or after the day it came (%)', NEW."id", "factory_money_rome_day"(NEW."receivedAt")
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ANSWERED') <> (NEW."answeredAt" IS NOT NULL) OR (NEW."answeredAt" IS NULL) <> (NEW."answeredById" IS NULL)
     OR (NEW."answeredAt" IS NULL) <> (NEW."answerSummary" IS NULL) OR NOT "factory_recall_words_ok"(NEW."answerSummary", 4000, true)
     OR NEW."answeredAt" < NEW."receivedAt" THEN
    RAISE EXCEPTION 'recall: authority request % is ANSWERED exactly with when (not before it came), by whom (a person) and what was sent (1 to 4000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."answeredAt" IS DISTINCT FROM OLD."answeredAt") AND NOT "factory_recall_not_future"(NEW."answeredAt") THEN
    RAISE EXCEPTION 'recall: authority request % was answered at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."evidenceType" IS NULL) <> (NEW."evidenceId" IS NULL)
     OR (NEW."evidenceType" IS NOT NULL AND NOT "factory_recall_model_name_ok"(NEW."evidenceType")) THEN
    RAISE EXCEPTION 'recall: authority request % names the evidence sent by its record type ("EvidencePack") and id, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."cancelReason", 500, true) THEN
    RAISE EXCEPTION 'recall: authority request % is CANCELLED exactly with when and why (1 to 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it names (checked when it is set or changes; a row this session cannot see is skipped).
  IF (TG_OP = 'INSERT' OR NEW."marketCode" IS DISTINCT FROM OLD."marketCode") AND NOT "factory_market_code_known"(NEW."tenantId", NEW."marketCode") THEN
    RAISE EXCEPTION 'recall: authority request % comes from market %, which is not a market of the tenant (Rules & markets)', NEW."id", NEW."marketCode"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."styleId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."styleId" IS DISTINCT FROM OLD."styleId") THEN
    SELECT s."companyId" INTO style_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND AND style_company IS NOT NULL AND style_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'recall: authority request % is about a style of its company or a tenant-wide one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."registerEntryId" IS NOT NULL AND NEW."styleId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."registerEntryId", NEW."styleId") IS DISTINCT FROM (OLD."registerEntryId", OLD."styleId")) THEN
    SELECT e."styleId" INTO entry_style FROM "PpeRegisterEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."registerEntryId";
    IF FOUND AND entry_style <> NEW."styleId" THEN
      RAISE EXCEPTION 'recall: the register entry of authority request % is of the style it is about', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "AuthorityRequest_guard" AFTER INSERT OR UPDATE ON "AuthorityRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_authority_request_guard"();

-- =====================================================================================================================
-- SustainabilityClaim (PRD-380; Dir. (EU) 2024/825)
CREATE FUNCTION "factory_sustainability_claim_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_company uuid;
  item_kind text;
  wanted integer;
  usable integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."approvedAt" IS NOT NULL OR NEW."approvedById" IS NOT NULL
       OR NEW."withdrawnAt" IS NOT NULL OR NEW."withdrawnById" IS NOT NULL OR NEW."withdrawReason" IS NOT NULL THEN
      RAISE EXCEPTION 'recall: sustainability claim % is drafted first (DRAFT, not approved, not withdrawn)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."code", NEW."supersedesId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."code", OLD."supersedesId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'recall: the company, code, the claim it replaces and the creation of sustainability claim % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'DRAFT' AND NEW."status" IN ('APPROVED', 'WITHDRAWN'))
      OR (OLD."status" = 'APPROVED' AND NEW."status" = 'WITHDRAWN')) THEN
      RAISE EXCEPTION 'recall: sustainability claim % moves DRAFT → APPROVED | WITHDRAWN, APPROVED → WITHDRAWN (not % → %)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'APPROVED'
       AND (to_jsonb(NEW) - ARRAY['status', 'withdrawnAt', 'withdrawnById', 'withdrawReason', 'note', 'version', 'updatedAt'])
           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'withdrawnAt', 'withdrawnById', 'withdrawReason', 'note', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'recall: sustainability claim % is approved and never changes but its withdrawal (a changed claim is a new one that replaces it)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'WITHDRAWN'
       AND (to_jsonb(NEW) - ARRAY['note', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['note', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'recall: sustainability claim % is WITHDRAWN and never changes (only the note)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Every row.
  IF NEW."code" IS NULL OR NEW."code" !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$' THEN
    RAISE EXCEPTION 'recall: sustainability claim % has a code of a letter or digit, then letters, digits, ".", "_" or "-" (up to 60)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_i18n_ok"(NEW."wording", 1000, false)
     OR (NEW."phraseKey" IS NOT NULL AND NEW."phraseKey" !~ '^[^[:space:][:cntrl:]]{1,100}$')
     OR NOT "factory_recall_words_ok"(NEW."scopeNote", 1000, true) OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'recall: sustainability claim % says its words per language ({ "it": "…" }, one line of 1 to 1000 characters each), names its phrase by its key, and keeps its scope note to 1000 and its note to 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."scope" = 'STYLE') <> (NEW."styleId" IS NOT NULL) OR (NEW."scope" = 'MATERIAL') <> (NEW."itemId" IS NOT NULL) THEN
    RAISE EXCEPTION 'recall: sustainability claim % names one style exactly when it covers a STYLE, one material exactly when it covers a MATERIAL, and neither for the COMPANY', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_styles_distinct"(NEW."evidenceFileIds") OR cardinality(NEW."evidenceFileIds") > 50 THEN
    RAISE EXCEPTION 'recall: sustainability claim % names each evidence file once, at most 50', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL)
     OR (NEW."status" = 'DRAFT' AND NEW."approvedAt" IS NOT NULL) OR (NEW."status" = 'APPROVED' AND NEW."approvedAt" IS NULL) THEN
    RAISE EXCEPTION 'recall: sustainability claim % is approved with when and by whom, from APPROVED on (a draft has neither)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL) OR (NEW."withdrawnAt" IS NULL) <> (NEW."withdrawReason" IS NULL)
     OR (NEW."withdrawnAt" IS NULL AND NEW."withdrawnById" IS NOT NULL) OR NOT "factory_recall_words_ok"(NEW."withdrawReason", 500, true)
     OR NEW."withdrawnAt" < NEW."approvedAt" THEN
    RAISE EXCEPTION 'recall: sustainability claim % is WITHDRAWN exactly with when (not before it was approved) and why (1 to 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supersedesId" = NEW."id" THEN
    RAISE EXCEPTION 'recall: sustainability claim % replaces another claim, not itself', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" OR NEW."withdrawnAt" IS DISTINCT FROM OLD."withdrawnAt")
     AND NOT ("factory_recall_not_future"(NEW."approvedAt") AND "factory_recall_not_future"(NEW."withdrawnAt")) THEN
    RAISE EXCEPTION 'recall: sustainability claim % is approved and withdrawn at times not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it names (checked when it is set or changes; a row this session cannot see is skipped).
  IF NEW."styleId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."styleId" IS DISTINCT FROM OLD."styleId") THEN
    SELECT s."companyId" INTO owner_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND AND owner_company IS NOT NULL AND owner_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'recall: sustainability claim % covers a style of its company or a tenant-wide one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."itemId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."itemId" IS DISTINCT FROM OLD."itemId") THEN
    SELECT i."companyId", i."kind"::text INTO owner_company, item_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND ((owner_company IS NOT NULL AND owner_company <> NEW."companyId") OR item_kind = 'FINISHED') THEN
      RAISE EXCEPTION 'recall: sustainability claim % covers a material of its company or a tenant-wide one, never a FINISHED garment', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."phraseKey" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."phraseKey" IS DISTINCT FROM OLD."phraseKey")
     AND NOT EXISTS (SELECT 1 FROM "Phrase" p WHERE p."tenantId" = NEW."tenantId" AND p."key" = NEW."phraseKey") THEN
    RAISE EXCEPTION 'recall: sustainability claim % is printed from phrase %, which is not a phrase of the tenant (the phrase library)', NEW."id", NEW."phraseKey"
      USING ERRCODE = 'check_violation';
  END IF;
  wanted := cardinality(NEW."evidenceFileIds");
  IF wanted > 0 AND (TG_OP = 'INSERT' OR NEW."evidenceFileIds" IS DISTINCT FROM OLD."evidenceFileIds") THEN
    IF (SELECT count(*) FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = ANY (NEW."evidenceFileIds")
          AND (f."companyId" IS NULL OR f."companyId" = NEW."companyId") AND f."status" <> 'DELETED') <> wanted THEN
      RAISE EXCEPTION 'recall: sustainability claim % names as evidence only files of its company (or tenant-wide) that are not deleted', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" = 'APPROVED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'APPROVED') THEN
    SELECT count(*) INTO usable FROM "StoredFile" f
     WHERE f."tenantId" = NEW."tenantId" AND f."id" = ANY (NEW."evidenceFileIds") AND f."status" = 'AVAILABLE';
    IF wanted = 0 OR usable <> wanted THEN
      RAISE EXCEPTION 'recall: sustainability claim % is approved with its evidence: at least one file, every one available (% of % are; Dir. (EU) 2024/825)', NEW."id", usable, wanted
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."validUntil" < "factory_money_rome_day"(NEW."approvedAt") THEN
      RAISE EXCEPTION 'recall: sustainability claim % is not approved after its evidence expired (valid until %)', NEW."id", NEW."validUntil"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "SustainabilityClaim_guard" AFTER INSERT OR UPDATE ON "SustainabilityClaim"
  FOR EACH ROW EXECUTE FUNCTION "factory_sustainability_claim_guard"();

-- =====================================================================================================================
-- ClaimUse (PRD-380)
CREATE FUNCTION "factory_claim_use_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  claim_status text;
  claim_valid date;
  claim_company uuid;
  style_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."claimId", NEW."kind", NEW."recordType", NEW."recordId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."claimId", OLD."kind", OLD."recordType", OLD."recordId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'recall: the claim, kind, record and creation of claim use % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."endedAt" IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['note', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['note', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'recall: claim use % ended and never changes (only the note)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_model_name_ok"(NEW."recordType") THEN
    RAISE EXCEPTION 'recall: claim use % names its record by its model name ("LabelTemplate", "Style")', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'STYLE' AND NEW."recordType" <> 'Style' THEN
    RAISE EXCEPTION 'recall: claim use % on a style names a Style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."label", 200, false) OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'recall: claim use % is named in one line up to 200 characters, with a note up to 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."endedAt" IS NULL AND NEW."endedById" IS NOT NULL) OR NEW."endedAt" < NEW."createdAt"
     OR ((TG_OP = 'INSERT' OR NEW."endedAt" IS DISTINCT FROM OLD."endedAt") AND NOT "factory_recall_not_future"(NEW."endedAt")) THEN
    RAISE EXCEPTION 'recall: claim use % ends at a time not before it was added and not in the future (who ended it only with when)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT c."status"::text, c."validUntil", c."companyId" INTO claim_status, claim_valid, claim_company
      FROM "SustainabilityClaim" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."claimId" FOR SHARE;
    IF FOUND THEN
      IF claim_status <> 'APPROVED' OR claim_valid < "factory_money_rome_day"(now()) THEN
        RAISE EXCEPTION 'recall: claim use % is added only while its claim is APPROVED and its evidence holds (it is %, valid until %)', NEW."id", claim_status, claim_valid
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."kind" = 'STYLE' THEN
        SELECT s."companyId" INTO style_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."recordId";
        IF NOT FOUND OR (style_company IS NOT NULL AND style_company <> claim_company) THEN
          RAISE EXCEPTION 'recall: claim use % on a style names a Style of the claim''s company or a tenant-wide one', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ClaimUse_guard" AFTER INSERT OR UPDATE ON "ClaimUse"
  FOR EACH ROW EXECUTE FUNCTION "factory_claim_use_guard"();

-- =====================================================================================================================
-- PpeRegisterEntry (redefines …_followups_f1_w2b_guards' "factory_ppe_register_entry_guard"; the trigger stays): F1's rules
-- word for word, with one more source type, AuthorityRequest (an entry opened from an authority's request, PRD-390).
CREATE OR REPLACE FUNCTION "factory_ppe_register_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  wanted integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: PPE register entry % is kept (closed), never deleted (Reg. 2016/425 art. 8(4))', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'quality: PPE register entry % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."reference", NEW."kind", NEW."reportedAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."reference", OLD."kind", OLD."reportedAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, reference, kind, report time and creation of PPE register entry % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: PPE register entry % is CLOSED; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."reference") = '' OR btrim(NEW."description") = '' THEN
    RAISE EXCEPTION 'quality: PPE register entry % has a reference and a description', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."status" = 'CLOSED') <> (NEW."closedById" IS NOT NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closeReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: PPE register entry % is % with the wrong closing: a closed entry has its time, who closed it and why', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The source, the authority's reference, the corrective action done.
  IF (NEW."sourceType" IS NULL) <> (NEW."sourceId" IS NULL)
     OR (NEW."sourceType" IS NOT NULL AND NEW."sourceType" NOT IN ('QualityReleaseReversal', 'QualityRelease', 'Inspection', 'Shipment', 'LabResult', 'Complaint', 'Nonconformance', 'ReturnAuthorisation', 'AuthorityRequest')) THEN
    RAISE EXCEPTION 'quality: PPE register entry % names its source as a known record type and an id, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."authorityReference" IS NOT NULL AND NEW."authorityNotifiedAt" IS NULL THEN
    RAISE EXCEPTION 'quality: PPE register entry % has an authority reference without the date the authority was told', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."actionCompletedAt" IS NOT NULL AND btrim(coalesce(NEW."actionTaken", '')) = '' THEN
    RAISE EXCEPTION 'quality: PPE register entry % marks a corrective action done without the action', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The id lists: rows of the entry's tenant and company (work orders also of its style).
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."lotIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."companyId" = NEW."companyId" AND l."id" = ANY(NEW."lotIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a material lot that is not of its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."workOrderIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."companyId" = NEW."companyId" AND w."styleId" = NEW."styleId" AND w."id" = ANY(NEW."workOrderIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a work order that is not of its company and style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."shipmentIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "Shipment" s WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId" AND s."id" = ANY(NEW."shipmentIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a shipment that is not of its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- OPEN → CLOSED: its duties met.
  IF TG_OP = 'UPDATE' AND OLD."status" = 'OPEN' AND NEW."status" = 'CLOSED' THEN
    IF btrim(NEW."closeReason") = '' THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes with a reason', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."risk" = 'ASSESSING' THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes once its risk is decided (yes or no)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF btrim(coalesce(NEW."actionTaken", '')) = '' OR NEW."actionCompletedAt" IS NULL THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes once its corrective action is written and done (Reg. 2016/425 art. 8(8))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."risk" = 'YES' AND (NEW."authorityNotifiedAt" IS NULL OR btrim(coalesce(NEW."authorityReference", '')) = '') THEN
      RAISE EXCEPTION 'quality: PPE register entry % may present a risk: it closes once the authorities were told, with the date and their reference (Reg. 2016/425 art. 8(8))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."distributorsInformedAt" IS NULL AND EXISTS (
      SELECT 1
      FROM "ShipmentLine" sl
      JOIN "Shipment" s ON s."tenantId" = sl."tenantId" AND s."id" = sl."shipmentId"
      JOIN "WorkOrder" w ON w."tenantId" = sl."tenantId" AND w."id" = sl."workOrderId"
      WHERE sl."tenantId" = NEW."tenantId"
        AND s."companyId" = NEW."companyId"
        AND s."status" IN ('SHIPPED', 'DELIVERED')
        AND w."companyId" = NEW."companyId"
        AND w."styleId" = NEW."styleId"
        AND (
          w."id" = ANY(coalesce(NEW."workOrderIds", '{}'::uuid[]))
          OR w."batchNumber" = ANY(coalesce(NEW."batchNumbers", '{}'::text[]))
          OR s."id" = ANY(coalesce(NEW."shipmentIds", '{}'::uuid[]))
          OR EXISTS (
            SELECT 1 FROM "StockMove" m
            WHERE m."tenantId" = NEW."tenantId" AND m."companyId" = NEW."companyId" AND m."workOrderId" = w."id"
              AND m."lotId" = ANY(coalesce(NEW."lotIds", '{}'::uuid[])) AND m."reason" = 'ISSUE' AND m."reversalOfId" IS NULL
              AND NOT EXISTS (SELECT 1 FROM "StockMove" r WHERE r."tenantId" = m."tenantId" AND r."siteId" = m."siteId" AND r."reversalOfId" = m."id")
          )
          OR EXISTS (
            SELECT 1 FROM "GarmentSerial" g
            WHERE g."tenantId" = sl."tenantId" AND g."shipmentLineId" = sl."id" AND g."serial" = ANY(coalesce(NEW."serials", '{}'::text[]))
          )
        )
    ) THEN
      RAISE EXCEPTION 'quality: garments PPE register entry % concerns left for customers: it closes once the distributors were informed (Reg. 2016/425 art. 8(4))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
