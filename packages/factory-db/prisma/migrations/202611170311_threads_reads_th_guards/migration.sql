-- Written by hand (Prisma does not model triggers), after the generated 202611170310_threads_reads_th_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Threads know who read them and who answers them, TH-2 (threads plan, schema wave 4/9, B-TH-023; gaps G10, N2, X-G05;
-- review PR-26). apps/factory-api checks all of this first and answers in words (B-TH-027 unread per person, B-TH-028 who
-- answers); these rules are the last word, for every login, the owner included. No earlier function is redefined.
--
--   ThreadRead    one person's read mark on one thread: its thread, person, party, key and creation never change; the key
--                 `read:<threadId>:<userId>` (one per thread and person: a unique index; the isolation tests' copies add a
--                 `-…` suffix, as a dashboard layout's key takes one); the person is an
--                 office user (no party) or a portal user of the row's party (then the thread's own party: the second
--                 reference holds it), never a floor worker (they are no user: the reference to User; the floor's role has
--                 no grant either: Statuto dei Lavoratori art. 4); the message read is a message of the same thread, and for a
--                 portal person one shared with their party (an internal note never counts as read or unread for a
--                 customer); read at a time not in the future. A session that cannot see the person or the message is
--                 refused, not skipped: an office session sees every person and message of the tenant, so a portal session
--                 that cannot see them is naming someone or something that is not its own.
--   Thread        who answers it (ownerId), when named or changed, is an active office user of the tenant (a person who
--                 leaves later stays named until someone else is: the thread shows them as inactive).
--   ErasureRecord the erasure of a person (an ERASURE request's or a sweep's record of a User, anonymised or deleted) removes
--                 that person's read marks in the same transaction (PR-26: erased with the person).
--
-- As every guard: a refusal is a check_violation (SQLSTATE 23514) in words; the checks are AFTER triggers (the policies speak
-- first). The tenant of a row is left to the policies and the references.
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_not_future" (…_recall_claims_w2b_guards), "factory_privacy_ops_key_ok"
-- (…_privacy_integration_w2b_guards).

-- =====================================================================================================================
-- ThreadRead: whose mark, on which message.
CREATE FUNCTION "factory_thread_read_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  user_audience text;
  user_party uuid;
  message_thread uuid;
  message_party uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."threadId", NEW."userId", NEW."partyId", NEW."key", NEW."createdAt") IS DISTINCT FROM (OLD."threadId", OLD."userId", OLD."partyId", OLD."key", OLD."createdAt") THEN
      RAISE EXCEPTION 'threads: the thread, person and party of read mark % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NOT "factory_privacy_ops_key_ok"(NEW."key", concat('read:', NEW."threadId", ':', NEW."userId")) THEN
    RAISE EXCEPTION 'threads: the key of read mark % is read:<threadId>:<userId> (one per thread and person)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT u."audience"::text, u."partyId" INTO user_audience, user_party FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'threads: read mark % names a person who is not one of this session''s people', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (user_audience = 'OFFICE' AND NEW."partyId" IS NOT NULL)
       OR (user_audience = 'PARTNER' AND NEW."partyId" IS DISTINCT FROM user_party)
       OR user_audience NOT IN ('OFFICE', 'PARTNER') THEN
      RAISE EXCEPTION 'threads: read mark % is an office person''s (no party) or a portal person''s (their own party), not a % person''s with party %', NEW."id", user_audience, NEW."partyId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW."lastReadMessageId" IS DISTINCT FROM OLD."lastReadMessageId" THEN
    SELECT m."threadId", m."partyId" INTO message_thread, message_party FROM "Message" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."lastReadMessageId";
    IF NOT FOUND OR message_thread <> NEW."threadId" THEN
      RAISE EXCEPTION 'threads: read mark % stops at a message of its own thread', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."partyId" IS NOT NULL AND message_party IS DISTINCT FROM NEW."partyId" THEN
      RAISE EXCEPTION 'threads: a portal person''s read mark % stops at a message shared with their party, never an internal note', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (TG_OP = 'INSERT' OR NEW."readAt" IS DISTINCT FROM OLD."readAt") AND (NEW."readAt" IS NULL OR NOT "factory_recall_not_future"(NEW."readAt")) THEN
    RAISE EXCEPTION 'threads: read mark % was read at a time not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ThreadRead_guard" AFTER INSERT OR UPDATE ON "ThreadRead"
  FOR EACH ROW EXECUTE FUNCTION "factory_thread_read_guard"();

-- =====================================================================================================================
-- Thread: who answers it.
CREATE FUNCTION "factory_thread_owner_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  user_audience text;
  user_status text;
BEGIN
  IF NEW."ownerId" IS NULL OR (TG_OP = 'UPDATE' AND NEW."ownerId" IS NOT DISTINCT FROM OLD."ownerId") THEN
    RETURN NULL;
  END IF;
  SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."ownerId";
  IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
    RAISE EXCEPTION 'threads: thread % is answered by an active office person, not one that is % (%)', NEW."id", user_status, user_audience
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Thread_owner_check" AFTER INSERT OR UPDATE OF "ownerId" ON "Thread"
  FOR EACH ROW EXECUTE FUNCTION "factory_thread_owner_check"();

-- =====================================================================================================================
-- ErasureRecord: a person erased takes their read marks with them (PR-26).
CREATE FUNCTION "factory_thread_reads_erased"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "ThreadRead" r WHERE r."tenantId" = NEW."tenantId" AND r."userId" = NEW."recordId";
  RETURN NULL;
END
$$;
CREATE TRIGGER "ErasureRecord_thread_reads" AFTER INSERT ON "ErasureRecord"
  FOR EACH ROW WHEN (NEW."recordType" = 'User' AND NEW."method" <> 'KEPT')
  EXECUTE FUNCTION "factory_thread_reads_erased"();
