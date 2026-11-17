-- Written by hand (Prisma does not model triggers), after the generated 202611170400_threads_composer_th_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The composer in depth, TH-3 (threads plan, schema wave 5/9, B-TH-038; gaps N7, thread-G08, thread-G19, thread-G20; Owner
-- decision 6 "undo send, 10 seconds"; review PR-03). apps/factory-api checks all of this first and answers in words (B-TH-048
-- undo send, B-TH-049 the amount, B-TH-050 reply, correct and the task's message); these rules are the last word, for every
-- login, the owner included.
--
--   Message        written once, as before. A typed amount (price grain) comes with its currency (ISO 4217), 0 or more, and
--                  only on an internal note that stays in the office (never for the floor: the floor sees no money, and the
--                  partner role has no grant on the two columns). It answers or corrects at most one message: one of its own
--                  thread (the references include the thread), written before it, that this session reads; a message shared
--                  with the party points only at a message shared with it that is not held (a customer never gets the id of
--                  an internal note or of a mail it never received); a correction keeps the direction of what it corrects (an
--                  internal note corrects an internal note, a mail sent a mail sent, a customer's message one of its own
--                  side). `held` only on an OUTBOUND mail's message, and only together with its mail's undo window: a deferred
--                  check at commit finds the mail that names it with a send-after time.
--                  REDEFINED (word for word but for the lines marked B-TH-038): threads' append-only
--                  `factory_refuse_message_change` (its latest body, …_privacy_erasure_w2b_guards): the one change a message
--                  takes besides an erasure is `held` true → false, nothing else, once its mail has left the window (claimed
--                  for sending, or failed: no longer QUEUED, never WITHDRAWN). The runtime roles still have no UPDATE grant on
--                  Message (scripts/factory/check-append-only.mjs): the release below is the database's own.
--   EmailOutbound  a send-after time only on a thread mail, never before it was queued and at most a minute after; the mail
--                  names a held message exactly when it has one; taken back (WITHDRAWN) only from QUEUED, only a mail with a
--                  window that was never claimed (no attempt: a claimed try may have reached SES), by an office person at a
--                  time not before it was queued, with when and by whom exactly then, set once; a mail is never born
--                  WITHDRAWN. When a mail with a window leaves QUEUED for SENDING or FAILED, its message is released (held →
--                  false) in the same statement, by `factory_message_release` (SECURITY DEFINER, a fixed search path, as the
--                  privacy erasure door: the runtime roles may not update a message themselves); a withdrawn mail's message
--                  stays held for good.
--                  REDEFINED (word for word but for the lines marked B-TH-038): email's `factory_email_outbound_guard` (its
--                  latest body, …_privacy_erasure_w2b_guards): sendAfter among what a mail sends that never changes, and the
--                  move QUEUED → WITHDRAWN.
--   Task           a task made from a message (messageId) has a record, and the message is of that record's thread; the
--                  message is named when the task is made and never changed.
--
-- Not held here (the API's, B-TH-048): that the worker claims a mail only once its send-after time has passed (the API's clock
-- is injected, the database's is not), and that a portal notice of a held message waits for its release.
--
-- As every TH guard: a refusal is a check_violation (SQLSTATE 23514) in words, which name no party (neutral toward customers);
-- the checks are AFTER triggers (the policies speak first), the deferred one at commit.

-- =====================================================================================================================
-- Message: the amount, the links, held.
CREATE FUNCTION "factory_message_composer_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  linked_id uuid := coalesce(NEW."replyToMessageId", NEW."correctsMessageId");
  linked_audience text;
  linked_direction text;
  linked_at timestamptz;
  linked_held boolean;
BEGIN
  IF (NEW."amount" IS NULL) <> (NEW."amountCurrency" IS NULL) THEN
    RAISE EXCEPTION 'threads: message % names an amount together with its currency, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amount" IS NOT NULL THEN
    IF NEW."amount" < 0 OR NEW."amountCurrency" !~ '^[A-Z]{3}$' THEN
      RAISE EXCEPTION 'threads: the amount of message % is 0 or more, in minor units of an ISO 4217 currency (three capital letters)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."audience" <> 'OFFICE' OR NEW."forFloor" THEN
      RAISE EXCEPTION 'threads: only an internal note that stays in the office carries an amount (message %): never a shared message, never a note for the floor', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."held" AND NOT (NEW."direction" = 'OUTBOUND' AND NEW."channel" = 'EMAIL') THEN
    RAISE EXCEPTION 'threads: only the message of a mail sent can wait in its undo window (message % is % by %)', NEW."id", NEW."direction", NEW."channel"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."replyToMessageId" IS NOT NULL AND NEW."correctsMessageId" IS NOT NULL THEN
    RAISE EXCEPTION 'threads: message % answers a message or corrects one, not both', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF linked_id IS NOT NULL THEN
    -- Read as the session: a portal session sees only its party's shared messages that are not held, so a message it cannot
    -- see (an internal note, a mail taken back) is refused here, in the same words as one that is not there.
    SELECT m."audience"::text, m."direction"::text, m."at", m."held" INTO linked_audience, linked_direction, linked_at, linked_held
      FROM "Message" m WHERE m."tenantId" = NEW."tenantId" AND m."threadId" = NEW."threadId" AND m."id" = linked_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'threads: message % answers or corrects a message of its own thread that its writer can read', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."audience" = 'PARTNER' AND (linked_audience <> 'PARTNER' OR linked_held) THEN
      RAISE EXCEPTION 'threads: message % is shared, so it answers or corrects only a message shared too (never an internal note, never a mail still waiting or taken back)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF linked_at > NEW."at" THEN
      RAISE EXCEPTION 'threads: message % answers or corrects a message written before it', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."correctsMessageId" IS NOT NULL AND linked_direction <> NEW."direction"::text THEN
      RAISE EXCEPTION 'threads: correction % keeps the direction of the message it corrects (%, not %)', NEW."id", linked_direction, NEW."direction"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Message_composer_check" AFTER INSERT ON "Message"
  FOR EACH ROW WHEN (NEW."amount" IS NOT NULL OR NEW."amountCurrency" IS NOT NULL OR NEW."held"
                     OR NEW."replyToMessageId" IS NOT NULL OR NEW."correctsMessageId" IS NOT NULL)
  EXECUTE FUNCTION "factory_message_composer_check"();

-- A held message has its mail by commit: the mail that names it, with a send-after time (written in the same transaction).
CREATE FUNCTION "factory_message_held_has_mail"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "EmailOutbound" e WHERE e."tenantId" = NEW."tenantId" AND e."messageId" = NEW."id" AND e."sendAfter" IS NOT NULL) THEN
    RAISE EXCEPTION 'threads: message % waits in an undo window only as the text of a mail that waits (no such mail names it)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "Message_held_has_mail" AFTER INSERT ON "Message"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."held")
  EXECUTE FUNCTION "factory_message_held_has_mail"();

-- =====================================================================================================================
-- Message: append-only (…_threads_guards, whole) + B-W2b-F54: an erasure blanks the name, the text and the HTML of a message
-- a person wrote (author PARTY, USER or WORKER); a correction is still a new message, and nothing else ever changes.
-- + B-TH-038: a held message is released (held → false, nothing else) once its mail has left the undo window.
CREATE OR REPLACE FUNCTION "factory_refuse_message_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' THEN
    IF OLD."authorKind" IN ('PARTY', 'USER', 'WORKER')
       AND "factory_privacy_ops_erasure_ok"('Message', to_jsonb(OLD), to_jsonb(NEW), '{"authorName": null, "bodyText": "", "bodyHtml": null}'::jsonb, '{}'::text[], '{}'::text[]) THEN
      RETURN NEW;
    END IF;
    -- B-TH-038: the release of a held message, once, when its mail is no longer waiting (claimed for sending, or failed) and was
    -- not taken back. Every other column stays as it was.
    IF OLD."held" AND NOT NEW."held" AND (to_jsonb(NEW) - 'held') = (to_jsonb(OLD) - 'held')
       AND EXISTS (SELECT 1 FROM public."EmailOutbound" e
                    WHERE e."tenantId" = OLD."tenantId" AND e."messageId" = OLD."id" AND e."sendAfter" IS NOT NULL
                      AND e."status" NOT IN ('QUEUED', 'WITHDRAWN')) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'append-only: % on "%" is refused; a correction is a new message', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- =====================================================================================================================
-- EmailOutbound: (…_email_guards, whole) + B-W2b-F54: an erasure blanks the person's addresses among the recipients (each
-- one '', the others as they were) and the subject, once the mail is no longer on its way; what was sent to whom otherwise,
-- and how it ended, stay.
-- + B-TH-038: the send-after time never changes; QUEUED → WITHDRAWN (taken back in its window; the rest of that rule is
-- EmailOutbound_undo_check below).
CREATE OR REPLACE FUNCTION "factory_email_outbound_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'email: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email: mail % is never deleted; it records what went to whom', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- B-W2b-F54: an erasure (GDPR art. 17) blanks the person's addresses among the recipients and the subject of a mail no
  -- longer on its way; nothing else of the row moves.
  IF TG_OP = 'UPDATE' AND OLD."status" NOT IN ('QUEUED', 'SENDING')
     AND (NEW."to", NEW."cc", NEW."subject") IS DISTINCT FROM (OLD."to", OLD."cc", OLD."subject")
     AND "factory_privacy_ops_erasure_ok"('EmailOutbound', to_jsonb(OLD), to_jsonb(NEW), '{"subject": ""}'::jsonb, ARRAY['to', 'cc'], '{}'::text[]) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."to" IS NULL OR NEW."cc" IS NULL OR NEW."bcc" IS NULL OR NEW."referenceIds" IS NULL THEN
      RAISE EXCEPTION 'email: mail % lists its recipients and references (empty lists, not null)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF cardinality(NEW."to") = 0 THEN
      RAISE EXCEPTION 'email: mail % has no recipient', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."attempts" < 0 THEN
      RAISE EXCEPTION 'email: mail % cannot have negative attempts', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."threadId" IS NULL) <> (NEW."messageId" IS NULL) THEN
      RAISE EXCEPTION 'email: mail % names its thread and its message, or neither', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."messageId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "Message" m
       WHERE m."id" = NEW."messageId" AND m."tenantId" = NEW."tenantId" AND m."threadId" = NEW."threadId"
         AND m."direction" = 'OUTBOUND' AND m."channel" = 'EMAIL' AND m."emailMessageId" = NEW."emailMessageId"
    ) THEN
      RAISE EXCEPTION 'email: mail % must name its thread''s OUTBOUND email message with the same Message-ID', NEW."id"
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."companyId", NEW."identityId", NEW."threadId", NEW."messageId", NEW."recordType", NEW."recordId",
      NEW."templateKey", NEW."locale", NEW."fromAddress", NEW."fromName", NEW."to", NEW."cc", NEW."bcc", NEW."subject",
      NEW."emailMessageId", NEW."inReplyTo", NEW."referenceIds", NEW."queuedAt", NEW."createdAt", NEW."createdById",
      NEW."sendAfter") -- B-TH-038
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."identityId", OLD."threadId", OLD."messageId", OLD."recordType", OLD."recordId",
      OLD."templateKey", OLD."locale", OLD."fromAddress", OLD."fromName", OLD."to", OLD."cc", OLD."bcc", OLD."subject",
      OLD."emailMessageId", OLD."inReplyTo", OLD."referenceIds", OLD."queuedAt", OLD."createdAt", OLD."createdById",
      OLD."sendAfter") THEN -- B-TH-038
    RAISE EXCEPTION 'email: what mail % sends never changes; only its delivery state moves', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."sesMessageId" IS NOT NULL AND NEW."sesMessageId" IS DISTINCT FROM OLD."sesMessageId" THEN
    RAISE EXCEPTION 'email: the SES message id of mail % is set once', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'email: the attempts of mail % cannot go down', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'QUEUED' AND NEW."status" IN ('SENDING', 'FAILED', 'WITHDRAWN')) -- B-TH-038: WITHDRAWN
    OR (OLD."status" = 'SENDING' AND NEW."status" IN ('QUEUED', 'SENT', 'FAILED'))
    OR (OLD."status" = 'SENT' AND NEW."status" IN ('DELIVERED', 'BOUNCED', 'COMPLAINED'))
    OR (OLD."status" = 'DELIVERED' AND NEW."status" IN ('BOUNCED', 'COMPLAINED'))
    OR (OLD."status" = 'BOUNCED' AND NEW."status" = 'COMPLAINED')
  ) THEN
    RAISE EXCEPTION 'email: mail % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- EmailOutbound: the undo window and the take-back.
CREATE FUNCTION "factory_email_outbound_undo_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  message_held boolean;
  person_audience text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."sendAfter" IS NOT NULL THEN
      IF NEW."messageId" IS NULL THEN
        RAISE EXCEPTION 'email: only a mail on a thread waits in an undo window (mail % names no thread message)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."sendAfter" < NEW."queuedAt" OR NEW."sendAfter" > NEW."queuedAt" + interval '1 minute' THEN
        RAISE EXCEPTION 'email: mail % waits from when it was queued for at most a minute (undo send), not until %', NEW."id", NEW."sendAfter"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."status" = 'WITHDRAWN' THEN
      RAISE EXCEPTION 'email: mail % is not born taken back: a person takes back a mail that waits', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."messageId" IS NOT NULL THEN
      SELECT m."held" INTO message_held FROM "Message" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."messageId";
      IF FOUND AND message_held <> (NEW."sendAfter" IS NOT NULL) THEN
        RAISE EXCEPTION 'email: mail % waits in an undo window exactly when its message is held (the message waits with it)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL) OR (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnById" IS NOT NULL) THEN
    RAISE EXCEPTION 'email: mail % names when and by whom it was taken back exactly when it was (WITHDRAWN)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."withdrawnAt" IS NOT NULL AND (NEW."withdrawnAt", NEW."withdrawnById") IS DISTINCT FROM (OLD."withdrawnAt", OLD."withdrawnById") THEN
      RAISE EXCEPTION 'email: when and by whom mail % was taken back are set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'WITHDRAWN' AND OLD."status" <> 'WITHDRAWN' THEN
      IF OLD."sendAfter" IS NULL THEN
        RAISE EXCEPTION 'email: mail % had no undo window; it cannot be taken back', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."attempts" > 0 THEN
        RAISE EXCEPTION 'email: mail % was already claimed for sending and may have left; it cannot be taken back', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."withdrawnAt" < NEW."queuedAt" THEN
        RAISE EXCEPTION 'email: mail % is taken back after it was queued, not at %', OLD."id", NEW."withdrawnAt"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT u."audience"::text INTO person_audience FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."withdrawnById";
      IF person_audience IS DISTINCT FROM 'OFFICE' THEN
        RAISE EXCEPTION 'email: mail % is taken back by an office person of the tenant', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "EmailOutbound_undo_check" AFTER INSERT OR UPDATE ON "EmailOutbound"
  FOR EACH ROW EXECUTE FUNCTION "factory_email_outbound_undo_check"();

-- The release: a mail with a window leaves QUEUED for SENDING or FAILED → its message is no longer held, in the same statement.
-- SECURITY DEFINER with a fixed search path (the privacy erasure door's pattern): no runtime role may update a message; the
-- append-only trigger above lets exactly this change through.
CREATE FUNCTION "factory_message_release"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public."Message" m SET "held" = false
   WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."messageId" AND m."held";
  RETURN NULL;
END
$$;
CREATE TRIGGER "EmailOutbound_release_message" AFTER UPDATE OF "status" ON "EmailOutbound"
  FOR EACH ROW WHEN (OLD."status" = 'QUEUED' AND NEW."status" IN ('SENDING', 'FAILED') AND NEW."messageId" IS NOT NULL AND NEW."sendAfter" IS NOT NULL)
  EXECUTE FUNCTION "factory_message_release"();

-- =====================================================================================================================
-- Task: the message it was made from.
CREATE FUNCTION "factory_task_message_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  thread_type text;
  thread_record uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."messageId" IS DISTINCT FROM OLD."messageId" THEN
      RAISE EXCEPTION 'tasks: the message task % was made from is named when it is made and never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."messageId" IS NULL OR (NEW."recordType", NEW."recordId") IS NOT DISTINCT FROM (OLD."recordType", OLD."recordId") THEN
      RETURN NULL;
    END IF;
  END IF;
  IF NEW."messageId" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT t."recordType", t."recordId" INTO thread_type, thread_record
    FROM "Message" m JOIN "Thread" t ON t."tenantId" = m."tenantId" AND t."id" = m."threadId"
   WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."messageId";
  IF NOT FOUND OR NEW."recordType" IS NULL OR NEW."recordId" IS NULL OR (thread_type, thread_record) IS DISTINCT FROM (NEW."recordType", NEW."recordId") THEN
    RAISE EXCEPTION 'tasks: task % is made from a message of its own record''s thread (a task with a message has a record)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Task_message_check" AFTER INSERT OR UPDATE OF "messageId", "recordType", "recordId" ON "Task"
  FOR EACH ROW EXECUTE FUNCTION "factory_task_message_check"();
