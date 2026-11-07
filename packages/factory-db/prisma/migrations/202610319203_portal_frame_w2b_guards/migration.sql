-- Written by hand (Prisma does not model triggers), after the generated 202610319202_portal_frame_w2b_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- W2b schema wave 20/22 (B-W2b-156): the portal frame (features COL-043, COL-060, COL-063, PLT-148; design portal.frame
-- "What waits for you" and "Ask a question / Messages", portal.signin first visit, the portals' E-mail settings). One task
-- model for every request we make of a partner; notifications and e-mail settings for partner users; a partner posts in
-- its own record threads.
--
-- apps/factory-api checks all of this first, in words; these rules hold for every login, the owner included, and every
-- refusal is a check_violation in words (as …_platform_w2a_guards and …_portal_identity_w2b_guards). The guards are AFTER
-- triggers: for the runtime roles the row-level-security policies speak first (a row moved to another tenant or party
-- fails their WITH CHECK), then the guard holds for every login. A rule that reads another row reads only what the role
-- that fires it may read (the partner role: its own party's people, threads and files); as the policies already passed,
-- a row the session cannot see there is a refusal (a person of another party or of the office, a file not shared with
-- the party). An UPDATE that changes nothing passes.
--
-- Earlier functions redefined here, each its whole body:
--   factory_notification_delivery_check   (…_platform_w2a_guards, W2a wave 1/7; not redefined since): a delivery in a
--                                         summary mail (EMAIL_DIGEST) names its mail, as an e-mail sent does.
-- New triggers on earlier tables, their functions new: Notification_party_check (the party of a partner user's
-- notification), Message_partner_post (what a partner session may post). Notification_guard (W2a) still holds a
-- notification's columns, partyId among them, once written.

-- =====================================================================================================================
-- Shared
CREATE FUNCTION "factory_portal_frame_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'portal: TRUNCATE on "%" is refused; its rows are never deleted', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "PartnerTask_no_truncate" BEFORE TRUNCATE ON "PartnerTask"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_portal_frame_refuse_truncate"();
CREATE TRIGGER "PartnerEmailPreference_no_truncate" BEFORE TRUNCATE ON "PartnerEmailPreference"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_portal_frame_refuse_truncate"();

-- =====================================================================================================================
-- PartnerTask (portal-frame.prisma; COL-043): one request we make of a partner.
--   INSERT     born OPEN, not closed, not reminded, at version 1.
--   every row  its record named (type and label, the label as the partner reads it); its source one word of up to 200
--              characters; who asked: an office person with the name the partner sees, or the system with neither;
--              closed (DONE, CANCELLED) exactly when it has a closing time, not before it was made; a person who did it
--              only on a DONE task, and then an ACTIVE partner user of the task's own party (when set or changed); the
--              reminder mark not before it was made.
--   UPDATE     the company, party, kind, record, label, source, asking and creation never change; the version goes up by
--              one at most; the reminder mark only moves later and is never cleared; a DONE or CANCELLED task changes
--              only by being reopened (OPEN again, its closing cleared). A partner session (factory_partner_runtime: a
--              portal or link session, in the command that answers the request) only closes an OPEN task as DONE:
--              status, closing time, the person who did it (a portal session names its person, a link none), version.
--   DELETE     refused: a task is cancelled, never deleted. TRUNCATE refused.
CREATE FUNCTION "factory_partner_task_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'version', 'updatedAt'];
  closing CONSTANT text[] := ARRAY['status', 'closedAt', 'doneById'];
  person_audience text;
  person_party uuid;
  person_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal: partner task % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."closedAt" IS NOT NULL OR NEW."doneById" IS NOT NULL OR NEW."remindedAt" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'portal: a new partner task (%) is OPEN, not closed, not reminded, at version 1', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."kind", NEW."recordType", NEW."recordId", NEW."recordLabel", NEW."sourceKey",
        NEW."askedById", NEW."askedByName", NEW."createdAt")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."kind", OLD."recordType", OLD."recordId", OLD."recordLabel",
        OLD."sourceKey", OLD."askedById", OLD."askedByName", OLD."createdAt") THEN
      RAISE EXCEPTION 'portal: partner task % keeps its company, partner, kind, record, source and who asked', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'portal: the version of partner task % goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."remindedAt" IS NOT NULL AND (NEW."remindedAt" IS NULL OR NEW."remindedAt" < OLD."remindedAt") THEN
      RAISE EXCEPTION 'portal: the last reminder of partner task % only moves later', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' AND NEW."status" <> 'OPEN' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'portal: partner task % is %; it changes only by being reopened', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND (OLD."status" <> 'OPEN' OR NEW."status" <> 'DONE'
            OR (to_jsonb(NEW) - (kept || closing)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || closing))) THEN
      RAISE EXCEPTION 'portal: a partner session only marks its open task % done', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."recordType") = '' OR length(NEW."recordType") > 100 OR btrim(NEW."recordLabel") = '' OR length(NEW."recordLabel") > 200 THEN
    RAISE EXCEPTION 'portal: partner task % names its record: its type and its label as the partner reads it (up to 200 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sourceKey" !~ '^[^[:space:]]{1,200}$' THEN
    RAISE EXCEPTION 'portal: partner task % names the request that made it in one word of up to 200 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."askedById" IS NULL) <> (NEW."askedByName" IS NULL) OR btrim(coalesce(NEW."askedByName", 'x')) = '' OR length(NEW."askedByName") > 200 THEN
    RAISE EXCEPTION 'portal: partner task % was asked by a person, with the name the partner sees, or by the system, with neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'OPEN') <> (NEW."closedAt" IS NULL) OR NEW."closedAt" < NEW."createdAt"
     OR (NEW."doneById" IS NOT NULL AND NEW."status" <> 'DONE') THEN
    RAISE EXCEPTION 'portal: partner task % is % with the wrong closing: a closing time exactly when DONE or CANCELLED, not before it was made, and who did it only when DONE', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."remindedAt" < NEW."createdAt" THEN
    RAISE EXCEPTION 'portal: partner task % is reminded after it was made', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."doneById" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."doneById" IS DISTINCT FROM OLD."doneById") THEN
    SELECT u."audience"::text, u."partyId", u."status"::text INTO person_audience, person_party, person_status
      FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."doneById";
    IF NOT FOUND OR person_audience <> 'PARTNER' OR person_party IS DISTINCT FROM NEW."partyId" OR person_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'portal: partner task % is done by an active person of its own partner', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PartnerTask_guard" AFTER INSERT OR UPDATE OR DELETE ON "PartnerTask"
  FOR EACH ROW EXECUTE FUNCTION "factory_partner_task_guard"();

-- =====================================================================================================================
-- PartnerEmailPreference (portal-frame.prisma; COL-063, PLT-148): how often one partner person gets one topic's mail.
--   INSERT     its person is a partner user of the row's own party (the partner policy key is always the person's).
--   UPDATE     the person, the party, the topic and the creation never change (only how often); the version goes up by
--              one at most.
--   DELETE     refused: a setting is changed, never deleted. TRUNCATE refused.
-- Which topics stay on whatever is stored (orders, deliveries, invoices) is the API's (factory-domain), as the page says.
CREATE FUNCTION "factory_partner_email_preference_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person_audience text;
  person_party uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal: e-mail setting % is changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."partyId", NEW."userId", NEW."topic", NEW."createdAt") IS DISTINCT FROM (OLD."id", OLD."partyId", OLD."userId", OLD."topic", OLD."createdAt") THEN
      RAISE EXCEPTION 'portal: e-mail setting % keeps its person, partner and topic; only how often changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'portal: the version of e-mail setting % goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  SELECT u."audience"::text, u."partyId" INTO person_audience, person_party
    FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
  IF NOT FOUND OR person_audience <> 'PARTNER' OR person_party IS DISTINCT FROM NEW."partyId" THEN
    RAISE EXCEPTION 'portal: e-mail setting % is of a partner user of its own partner', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PartnerEmailPreference_guard" AFTER INSERT OR UPDATE OR DELETE ON "PartnerEmailPreference"
  FOR EACH ROW EXECUTE FUNCTION "factory_partner_email_preference_guard"();

-- =====================================================================================================================
-- Notification (collab.prisma; PLT-148): partyId is the person's party, set exactly when the person is a partner user
-- (the partner policy key), so a portal session reads its own party's notifications and an office person's never match
-- a party. Checked when written; Notification_guard (W2a) keeps it as written.
CREATE FUNCTION "factory_notification_party_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person_audience text;
  person_party uuid;
BEGIN
  SELECT u."audience"::text, u."partyId" INTO person_audience, person_party
    FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
  IF NOT FOUND OR (person_audience = 'PARTNER') <> (NEW."partyId" IS NOT NULL) OR NEW."partyId" IS DISTINCT FROM person_party THEN
    RAISE EXCEPTION 'notifications: notification % names its person''s party exactly when the person is a partner user', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Notification_party_check" AFTER INSERT ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION "factory_notification_party_check"();

-- NotificationDelivery, redefined whole from …_platform_w2a_guards (W2a wave 1/7). Kept: it keeps its request; a skipped
-- or failed delivery says why. New: a notification listed in a summary mail (EMAIL_DIGEST) that was SENT names that mail,
-- as an e-mail sent does; nothing else names one.
CREATE OR REPLACE FUNCTION "factory_notification_delivery_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF btrim(NEW."requestId") = '' THEN
    RAISE EXCEPTION 'notifications: delivery % keeps its request', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."channel" IN ('EMAIL', 'EMAIL_DIGEST') AND NEW."outcome" = 'SENT') <> (NEW."emailOutboundId" IS NOT NULL) THEN
    RAISE EXCEPTION 'notifications: an e-mail or a summary mail sent (%) names its mail, and nothing else names one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."outcome" <> 'SENT' AND (NEW."detail" IS NULL OR btrim(NEW."detail") = '') THEN
    RAISE EXCEPTION 'notifications: a delivery skipped or failed (%) says why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- Message (threads.prisma; COL-060): what a partner session posts in its own party's record thread. The policies keep it
-- to its party (partyId, and the thread's party by the shared-message reference); its column grants leave out the
-- author id, the mentions and the floor flag (their defaults: none, none, the office's). Message_guard (W0) still holds
-- every message's shape. A partner session posts only:
--   a message received from its party (INBOUND), shared with it (PARTNER), written in the portal (PORTAL), by the party
--   (PARTY), with the name of the person who wrote it (up to 200 characters); not a mail (no Message-ID); attaching only
--   AVAILABLE files of the thread's record shared with its party (the W0 rule of platform/threads: a file the party may not
--   see never goes to it; a file this session cannot see is refused).
CREATE FUNCTION "factory_message_partner_post_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  thread_type text;
  thread_record uuid;
BEGIN
  IF current_user <> 'factory_partner_runtime' THEN
    RETURN NULL;
  END IF;
  IF NEW."direction" <> 'INBOUND' OR NEW."audience" <> 'PARTNER' OR NEW."channel" <> 'PORTAL' OR NEW."authorKind" <> 'PARTY' THEN
    RAISE EXCEPTION 'threads: a partner session posts only its party''s own message from the portal (INBOUND, PARTNER, PORTAL, PARTY), not message % (%, %, %, %)', NEW."id", NEW."direction", NEW."audience", NEW."channel", NEW."authorKind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(coalesce(NEW."authorName", '')) = '' OR length(NEW."authorName") > 200 THEN
    RAISE EXCEPTION 'threads: portal post % names the person who wrote it (up to 200 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."emailMessageId" IS NOT NULL THEN
    RAISE EXCEPTION 'threads: portal post % is not a mail; it has no Message-ID', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."attachmentFileIds") > 0 THEN
    SELECT t."recordType", t."recordId" INTO thread_type, thread_record
      FROM "Thread" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."threadId";
    IF NOT FOUND OR EXISTS (
         SELECT 1 FROM unnest(NEW."attachmentFileIds") AS a(file_id)
          WHERE NOT EXISTS (SELECT 1 FROM "StoredFile" f
                             WHERE f."tenantId" = NEW."tenantId" AND f."id" = a.file_id AND f."partyId" = NEW."partyId"
                               AND f."recordType" = thread_type AND f."recordId" = thread_record AND f."status" = 'AVAILABLE')) THEN
      RAISE EXCEPTION 'threads: portal post % attaches only available files of its record that are shared with its party', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Message_partner_post" AFTER INSERT ON "Message"
  FOR EACH ROW EXECUTE FUNCTION "factory_message_partner_post_check"();
