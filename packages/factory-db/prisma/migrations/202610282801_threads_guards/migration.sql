-- Written by hand (Prisma does not model triggers), after the generated 202610282400_threads_messages and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Record threads (plan A1 §2.3, §3.7; features COL-001, COL-003, COL-020). apps/factory-api's platform/threads checks
-- all of this first; these rules hold for every login, the owner included.
--
-- Thread
--   INSERT     a thread is born OPEN, with a reply token of at least 26 characters (the API makes 26 random lower-case
--              base32 ones: 130 bits); a thread on a site names the site's company too (the site reference includes it).
--   UPDATE     the record (type and id), its company and site, the reply token and the creation never change; the party
--              is set once (from none to the record's party) and never changed after (the shared messages' reference
--              also holds it); the last-activity time only moves later and is never cleared. tenantId is held by the
--              policies (USING and WITH CHECK on the tenant).
--   DELETE     refused: a thread is the record's history.
--   TRUNCATE   refused.
CREATE FUNCTION "factory_thread_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'threads: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'threads: thread % is never deleted; it is the record''s history', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."siteId" IS NOT NULL AND NEW."companyId" IS NULL THEN
    RAISE EXCEPTION 'threads: thread % is on a site, so it belongs to that site''s company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'threads: a new thread is OPEN, not %', NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF length(NEW."replyToken") < 26 THEN
      RAISE EXCEPTION 'threads: the reply token of thread % is too short to be unguessable', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."companyId", NEW."siteId", NEW."recordType", NEW."recordId", NEW."replyToken", NEW."createdAt",
      NEW."createdById")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."siteId", OLD."recordType", OLD."recordId", OLD."replyToken", OLD."createdAt",
      OLD."createdById") THEN
    RAISE EXCEPTION 'threads: the record, company, site and reply address of thread % never change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."partyId" IS NOT NULL AND NEW."partyId" IS DISTINCT FROM OLD."partyId" THEN
    RAISE EXCEPTION 'threads: the party of thread % is set once and never changes', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."lastMessageAt" IS NOT NULL AND (NEW."lastMessageAt" IS NULL OR NEW."lastMessageAt" < OLD."lastMessageAt") THEN
    RAISE EXCEPTION 'threads: the last activity of thread % only moves later', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Thread_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Thread"
  FOR EACH ROW EXECUTE FUNCTION "factory_thread_guard"();
CREATE TRIGGER "Thread_no_truncate" BEFORE TRUNCATE ON "Thread"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_thread_guard"();

-- Message: append-only (plan A1 §2.1; scripts/factory/check-append-only.mjs). No login may change or remove a message;
-- the runtime roles have no UPDATE, DELETE or TRUNCATE grant either (the policy migration). A correction is a new
-- message.
CREATE FUNCTION "factory_refuse_message_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a correction is a new message', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER "Message_append_only" BEFORE UPDATE OR DELETE ON "Message"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_message_change"();
CREATE TRIGGER "Message_no_truncate" BEFORE TRUNCATE ON "Message"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_message_change"();

-- A new message (COL-003: an internal note never reaches a party):
--   an INTERNAL_NOTE, and only it, is for the OFFICE, written in the app; partyId (the partner role's policy key) is
--   set exactly when the audience is PARTNER, and then it is the thread's own party (the reference
--   Message_tenantId_threadId_partyId_fkey); only an internal note mentions people; only an inbound mail carries HTML
--   (sanitised by the email-in step); the system writes with no author id, a user or a floor worker with theirs; a
--   message has text or attachments.
CREATE FUNCTION "factory_message_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."mentionedUserIds" IS NULL OR NEW."attachmentFileIds" IS NULL THEN
    RAISE EXCEPTION 'threads: message % lists its mentions and attachments (empty lists, not null)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."direction" = 'INTERNAL_NOTE') <> (NEW."audience" = 'OFFICE') THEN
    RAISE EXCEPTION 'threads: message % is % for %; internal notes, and only they, are for the office', NEW."id", NEW."direction", NEW."audience"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."audience" = 'PARTNER') <> (NEW."partyId" IS NOT NULL) THEN
    RAISE EXCEPTION 'threads: message % names a party exactly when it is shared with one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."direction" = 'INTERNAL_NOTE' AND NEW."channel" <> 'APP' THEN
    RAISE EXCEPTION 'threads: internal note % is written in the app, not by %', NEW."id", NEW."channel"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."mentionedUserIds") > 0 AND NEW."direction" <> 'INTERNAL_NOTE' THEN
    RAISE EXCEPTION 'threads: only an internal note mentions people (message %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."bodyHtml" IS NOT NULL AND NOT (NEW."direction" = 'INBOUND' AND NEW."channel" = 'EMAIL') THEN
    RAISE EXCEPTION 'threads: only an inbound mail carries HTML (message %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."authorKind" = 'SYSTEM' AND NEW."authorId" IS NOT NULL)
     OR (NEW."authorKind" IN ('USER', 'WORKER') AND NEW."authorId" IS NULL) THEN
    RAISE EXCEPTION 'threads: message % has the wrong author id for a % author', NEW."id", NEW."authorKind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF length(NEW."bodyText") = 0 AND cardinality(NEW."attachmentFileIds") = 0 THEN
    RAISE EXCEPTION 'threads: message % has neither text nor attachments', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Message_guard" BEFORE INSERT ON "Message"
  FOR EACH ROW EXECUTE FUNCTION "factory_message_guard"();
