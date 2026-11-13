-- Written by hand (Prisma does not model triggers), after the generated 202611140302_notify_depth_w2b_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Notifications, My work and mail in depth, W2b schema wave 47/57 (B-W2b-366; PLT-140, PLT-141, PLT-151, COL-021, COL-027,
-- COL-031, COL-041). apps/factory-api's notifications in depth (B-W2b-385), My work and reminders (B-W2b-388) and mail in
-- depth (B-W2b-394) check all of this first and answer in words; these rules are the last word, for every login, the owner
-- included.
--
--   NotificationPreference   an office person's own; the person, kind, channel and key fixed (only the cadence moves); the
--                            key begins `pref:<person>:<kind>:<channel>` (one row each: the unique key); the daily digest
--                            only on EMAIL. Removed to reset (no TRUNCATE).
--   RoleNotificationDefault  of an OFFICE role; the role, kind, channel, key and creation fixed; the key begins
--                            `default:<role>:<kind>:<channel>`; the daily digest only on EMAIL. Removed (no TRUNCATE).
--   PushSubscription         an office person's; the person, endpoint and creation fixed; the device label 1 to 100
--                            characters of one line; the endpoint https, at most 2048, no space; a live one has its sealed
--                            keys, a SecretValue of purpose `notifications.push`, which never change and go only once it is
--                            turned off; turned off once, then it changes no more; its last use never goes back; nothing in
--                            the future. One live subscription per endpoint (a partial unique). Never deleted.
--   ViewFollower             an office person's; the person, view, key and creation fixed; the key begins
--                            `view:<view>:<person>`; a view only its owner sees (ONLY_ME) followed only by its owner; the
--                            last count all three or none (a SHA-256 hex, 0 or more rows, not in the future), and once
--                            counted it only moves forward. Removed to unfollow, with its view (the cascade); no TRUNCATE.
--   Reminder                 an office person's; born waiting (not come back, not done); what it is about and for whom
--                            fixed; a record type that is a model name, its label 1 to 200 characters of one line, the note
--                            1 to 500; AT_TIME exactly with a time after `since`; `since` never goes back, and a new time or
--                            kind only with a later `since` (put off), which leaves it waiting again; came back once (not
--                            before `since`), cleared only by a put-off; done, then frozen but for Undo (doneAt cleared);
--                            a message of the record's own thread; nothing in the future. Removed by its person; no TRUNCATE.
--   TeamInbox                company and creation fixed; the name 1 to 100 characters of one line; the local part 1 to 64
--                            lower-case letters, digits and . _ + - (not the `r-`/`c-` of reply and capture addresses);
--                            members a list (not null), each once, at most 200, a new one an office person of the tenant who
--                            has not left. Never deleted (switched off).
--   CaptureAddress           company, token and creation fixed; the token begins with 26 lower-case base32 characters; the
--                            default team inbox switched on when named (its company: the reference); turned off once (not in
--                            the future), then it changes no more. One live address per company (a partial unique). Never
--                            deleted.
--   InboundEmail             REDEFINED `factory_inbound_email_guard` (…_email_in_guards, word for word) but for one rule: a
--                            MATCHED mail's team-inbox columns still move (a REJECTED mail still changes no more). Its own
--                            trigger InboundEmail_team_inbox_check: a team inbox of the mail's company (when it has one),
--                            switched on when named; the assignee and when, both or neither, an office person; who closed
--                            only with when; nothing in the future. Its own trigger InboundEmail_follow_up_ends: when a mail
--                            joins a thread (MATCHED), the follow-ups of the thread's earlier mails end (cleared, version
--                            moved on): "a follow-up that cancels itself when the partner replies".
--   EmailOutbound            its own BEFORE trigger EmailOutbound_bounce_kind: bounceKind is PERMANENT exactly when bouncedAt
--                            is set (written by the database with bouncedAt, so W2a's notification job needs no change);
--                            when it bounced set once; a bounce kind never cleared. The rows that bounced before are filled.
--   SalesSettings            its own trigger SalesSettings_inquiry_addresses_check: the inquiry addresses a list (not null),
--                            at most 20, each once, lower-case e-mail addresses of at most 254 characters.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the checks of the new tables are AFTER
-- triggers (the policies speak first), the refused deletes BEFORE; the redefined function keeps its triggers. The tenant of
-- a row is left to the policies and the references, never compared here: a rule that reads another row skips a row this
-- session cannot see. An UPDATE that changes nothing passes. Nothing reads factory.actor_id.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers and
-- dates moved) and insert the copy: so the keys and the token are checked by how they BEGIN, and the first rows the seed
-- gives are ones a copy may repeat (a turned-off push subscription without keys, a turned-off capture address, a waiting
-- reminder).
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok", "factory_recall_not_future" and
-- "factory_recall_model_name_ok" (…_recall_claims_w2b_guards).

CREATE FUNCTION "factory_notify_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notifications: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_notify_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notifications: % % is kept, never deleted (turn it off or switch it off)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['NotificationPreference', 'RoleNotificationDefault', 'PushSubscription', 'ViewFollower', 'Reminder', 'TeamInbox', 'CaptureAddress'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_notify_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['PushSubscription', 'TeamInbox', 'CaptureAddress'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "factory_notify_never_deleted"()', name || '_never_deleted', name);
  END LOOP;
END
$$;

-- An office person of the tenant (User.audience OFFICE): true for NULL and for a person this session cannot see (the
-- references hold that the person exists).
CREATE FUNCTION "factory_notify_office_user_ok"(tenant uuid, person uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT person IS NULL OR NOT EXISTS (
    SELECT 1 FROM "User" u WHERE u."tenantId" = tenant AND u."id" = person AND u."audience" <> 'OFFICE'
  )
$$;

-- =====================================================================================================================
-- NotificationPreference (PLT-141)
CREATE FUNCTION "factory_notification_preference_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."userId", NEW."event", NEW."channel", NEW."key", NEW."createdAt") IS DISTINCT FROM (OLD."userId", OLD."event", OLD."channel", OLD."key", OLD."createdAt") THEN
      RAISE EXCEPTION 'notifications: the person, kind, channel and key of preference % never change; only its cadence moves', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF position(('pref:' || NEW."userId"::text || ':' || NEW."event"::text || ':' || NEW."channel"::text) IN NEW."key") <> 1 THEN
    RAISE EXCEPTION 'notifications: the key of preference % is pref:<person>:<kind>:<channel> (one row per person, kind and channel)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."cadence" = 'DAILY_DIGEST' AND NEW."channel" <> 'EMAIL' THEN
    RAISE EXCEPTION 'notifications: only e-mail has a daily digest (preference %, channel %)', NEW."id", NEW."channel"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT "factory_notify_office_user_ok"(NEW."tenantId", NEW."userId") THEN
    RAISE EXCEPTION 'notifications: preference % is an office person''s choice (a partner chooses in the portal''s e-mail settings)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "NotificationPreference_guard" AFTER INSERT OR UPDATE ON "NotificationPreference"
  FOR EACH ROW EXECUTE FUNCTION "factory_notification_preference_guard"();

-- =====================================================================================================================
-- RoleNotificationDefault (PLT-141)
CREATE FUNCTION "factory_role_notification_default_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."roleId", NEW."event", NEW."channel", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."roleId", OLD."event", OLD."channel", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'notifications: the role, kind, channel, key and creation of role default % never change; only its cadence moves', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF position(('default:' || NEW."roleId"::text || ':' || NEW."event"::text || ':' || NEW."channel"::text) IN NEW."key") <> 1 THEN
    RAISE EXCEPTION 'notifications: the key of role default % is default:<role>:<kind>:<channel> (one row per role, kind and channel)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."cadence" = 'DAILY_DIGEST' AND NEW."channel" <> 'EMAIL' THEN
    RAISE EXCEPTION 'notifications: only e-mail has a daily digest (role default %, channel %)', NEW."id", NEW."channel"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM "Role" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."roleId" AND r."audience" <> 'OFFICE') THEN
    RAISE EXCEPTION 'notifications: role default % is of an office role (floor and partner roles get no office notifications)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "RoleNotificationDefault_guard" AFTER INSERT OR UPDATE ON "RoleNotificationDefault"
  FOR EACH ROW EXECUTE FUNCTION "factory_role_notification_default_guard"();

-- =====================================================================================================================
-- PushSubscription (PLT-140)
CREATE FUNCTION "factory_push_subscription_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  secret_purpose text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."userId", NEW."endpoint", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."userId", OLD."endpoint", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'notifications: the person and the endpoint of push subscription % never change (a new device is a new subscription)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."revokedAt" IS NOT NULL AND (NEW."revokedAt", NEW."deviceLabel", NEW."lastUsedAt") IS DISTINCT FROM (OLD."revokedAt", OLD."deviceLabel", OLD."lastUsedAt") THEN
      RAISE EXCEPTION 'notifications: push subscription % was turned off at %; it changes no more (only its sealed keys go)', OLD."id", OLD."revokedAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."keysSecretId" IS DISTINCT FROM OLD."keysSecretId" AND NOT (NEW."keysSecretId" IS NULL AND NEW."revokedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'notifications: the sealed keys of push subscription % never change; they go only once it is turned off', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."lastUsedAt" IS NOT NULL AND (NEW."lastUsedAt" IS NULL OR NEW."lastUsedAt" < OLD."lastUsedAt") THEN
      RAISE EXCEPTION 'notifications: the last use of push subscription % never goes back', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."deviceLabel", 100, false) THEN
    RAISE EXCEPTION 'notifications: the device label of push subscription % is 1 to 100 characters of one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."endpoint" !~ '^https://[^[:space:][:cntrl:]]+$' OR char_length(NEW."endpoint") > 2048 THEN
    RAISE EXCEPTION 'notifications: the endpoint of push subscription % is the push service''s https address, at most 2048 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revokedAt" IS NULL AND NEW."keysSecretId" IS NULL THEN
    RAISE EXCEPTION 'notifications: push subscription % is live, so it has its sealed keys', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."revokedAt") OR NOT "factory_recall_not_future"(NEW."lastUsedAt") THEN
    RAISE EXCEPTION 'notifications: when push subscription % was used or turned off is not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT "factory_notify_office_user_ok"(NEW."tenantId", NEW."userId") THEN
      RAISE EXCEPTION 'notifications: push subscription % is an office person''s device', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."keysSecretId" IS NOT NULL THEN
      SELECT s."purpose" INTO secret_purpose FROM "SecretValue" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."keysSecretId";
      IF FOUND AND secret_purpose <> 'notifications.push' THEN
        RAISE EXCEPTION 'notifications: the keys of push subscription % are a secret of purpose notifications.push (not %)', NEW."id", secret_purpose
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PushSubscription_guard" AFTER INSERT OR UPDATE ON "PushSubscription"
  FOR EACH ROW EXECUTE FUNCTION "factory_push_subscription_guard"();

-- One live subscription per endpoint: a browser that subscribes again after it was turned off makes a new row.
CREATE UNIQUE INDEX "PushSubscription_one_live_endpoint" ON "PushSubscription" ("tenantId", "endpoint") WHERE "revokedAt" IS NULL;

-- =====================================================================================================================
-- ViewFollower (PLT-151)
CREATE FUNCTION "factory_view_follower_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  view_owner uuid;
  view_audience text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."userId", NEW."viewId", NEW."key", NEW."createdAt") IS DISTINCT FROM (OLD."userId", OLD."viewId", OLD."key", OLD."createdAt") THEN
      RAISE EXCEPTION 'views: the person, view and key of follow % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."lastCountedAt" IS NOT NULL AND (NEW."lastCountedAt" IS NULL OR NEW."lastCountedAt" < OLD."lastCountedAt") THEN
      RAISE EXCEPTION 'views: follow % was counted at %; its count only moves forward', OLD."id", OLD."lastCountedAt"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF position(('view:' || NEW."viewId"::text || ':' || NEW."userId"::text) IN NEW."key") <> 1 THEN
    RAISE EXCEPTION 'views: the key of follow % is view:<view>:<person> (one row per view and person)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."lastFingerprint" IS NULL) <> (NEW."lastCount" IS NULL) OR (NEW."lastFingerprint" IS NULL) <> (NEW."lastCountedAt" IS NULL) THEN
    RAISE EXCEPTION 'views: the last count of follow % has its fingerprint, its number of rows and when, all three or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lastFingerprint" !~ '^[0-9a-f]{64}$' OR NEW."lastCount" < 0 THEN
    RAISE EXCEPTION 'views: the last count of follow % is a SHA-256 (64 lower-case hex) of its row ids and 0 or more rows', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."lastCountedAt") THEN
    RAISE EXCEPTION 'views: follow % was not counted in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT "factory_notify_office_user_ok"(NEW."tenantId", NEW."userId") THEN
      RAISE EXCEPTION 'views: follow % is an office person''s', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT v."ownerId", v."audience"::text INTO view_owner, view_audience FROM "SavedView" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."viewId";
    IF FOUND AND view_audience = 'ONLY_ME' AND view_owner <> NEW."userId" THEN
      RAISE EXCEPTION 'views: view % is its owner''s alone; only its owner follows it', NEW."viewId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ViewFollower_guard" AFTER INSERT OR UPDATE ON "ViewFollower"
  FOR EACH ROW EXECUTE FUNCTION "factory_view_follower_guard"();

-- =====================================================================================================================
-- Reminder (COL-041)
CREATE FUNCTION "factory_reminder_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  put_off boolean := false;
  thread_type text;
  thread_record uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."cameBackAt" IS NOT NULL OR NEW."doneAt" IS NOT NULL THEN
      RAISE EXCEPTION 'tasks: reminder % starts waiting: not come back, not done', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_notify_office_user_ok"(NEW."tenantId", NEW."userId") THEN
      RAISE EXCEPTION 'tasks: reminder % reminds an office person', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."messageId" IS NOT NULL THEN
      SELECT t."recordType", t."recordId" INTO thread_type, thread_record
        FROM "Message" m JOIN "Thread" t ON t."tenantId" = m."tenantId" AND t."id" = m."threadId"
       WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."messageId";
      IF FOUND AND (thread_type, thread_record) IS DISTINCT FROM (NEW."recordType", NEW."recordId") THEN
        RAISE EXCEPTION 'tasks: the message of reminder % is of the thread of its record (%), not of %', NEW."id", NEW."recordLabel", thread_type
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."userId", NEW."companyId", NEW."recordType", NEW."recordId", NEW."recordLabel", NEW."messageId", NEW."createdAt")
       IS DISTINCT FROM (OLD."userId", OLD."companyId", OLD."recordType", OLD."recordId", OLD."recordLabel", OLD."messageId", OLD."createdAt") THEN
      RAISE EXCEPTION 'tasks: what reminder % is about, and for whom, never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."doneAt" IS NOT NULL
       AND ((to_jsonb(NEW) - ARRAY['version', 'updatedAt', 'doneAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version', 'updatedAt', 'doneAt'])
            OR NEW."doneAt" IS DISTINCT FROM OLD."doneAt" AND NEW."doneAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'tasks: reminder % is done; it changes no more (Undo clears done first)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."since" < OLD."since" THEN
      RAISE EXCEPTION 'tasks: the moment reminder % watches from never goes back', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    put_off := NEW."since" > OLD."since";
    IF (NEW."kind", NEW."remindAt") IS DISTINCT FROM (OLD."kind", OLD."remindAt") AND NOT put_off THEN
      RAISE EXCEPTION 'tasks: reminder % gets a new time or kind only when it is put off (its since moves on)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF put_off AND NEW."cameBackAt" IS NOT NULL THEN
      RAISE EXCEPTION 'tasks: reminder % put off waits again: it has not come back', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."cameBackAt" IS NOT NULL AND NEW."cameBackAt" IS DISTINCT FROM OLD."cameBackAt" AND NOT put_off THEN
      RAISE EXCEPTION 'tasks: reminder % came back at %; that clears only when it is put off again', OLD."id", OLD."cameBackAt"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_model_name_ok"(NEW."recordType") THEN
    RAISE EXCEPTION 'tasks: the record type of reminder % is a model name (not %)', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."recordLabel", 200, false) THEN
    RAISE EXCEPTION 'tasks: the record label of reminder % is 1 to 200 characters of one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 500, true) THEN
    RAISE EXCEPTION 'tasks: the note of reminder % is 1 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'AT_TIME') <> (NEW."remindAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'tasks: reminder % has its time exactly when it comes back AT_TIME (ON_CHANGE has none)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."remindAt" <= NEW."since" THEN
    RAISE EXCEPTION 'tasks: reminder % comes back after it was set or put off (%), not at %', NEW."id", NEW."since", NEW."remindAt"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."cameBackAt" < NEW."since" THEN
    RAISE EXCEPTION 'tasks: reminder % came back after it was set or put off', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."since") OR NOT "factory_recall_not_future"(NEW."cameBackAt") OR NOT "factory_recall_not_future"(NEW."doneAt") THEN
    RAISE EXCEPTION 'tasks: when reminder % was set, came back or was done is not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Reminder_guard" AFTER INSERT OR UPDATE ON "Reminder"
  FOR EACH ROW EXECUTE FUNCTION "factory_reminder_guard"();

-- =====================================================================================================================
-- TeamInbox (COL-027)
CREATE FUNCTION "factory_team_inbox_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'email-in: the company and creation of team inbox % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."name", 100, false) THEN
    RAISE EXCEPTION 'email-in: the name of team inbox % is 1 to 100 characters of one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."localPart" !~ '^[a-z0-9][a-z0-9._+-]{0,63}$' THEN
    RAISE EXCEPTION 'email-in: the address of team inbox % is 1 to 64 lower-case letters, digits and . _ + -, starting with a letter or a digit (not %)', NEW."id", NEW."localPart"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."localPart" ~ '^[rc]-' THEN
    RAISE EXCEPTION 'email-in: the address of team inbox % cannot start with r- or c- (the records'' reply addresses and the capture addresses)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."memberIds" IS NULL OR array_position(NEW."memberIds", NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'email-in: team inbox % lists its members (an empty list, not null; no empty entry)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."memberIds") > 200 OR (SELECT count(DISTINCT m) FROM unnest(NEW."memberIds") AS m) <> cardinality(NEW."memberIds") THEN
    RAISE EXCEPTION 'email-in: team inbox % has at most 200 members, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW."memberIds") AS m
     WHERE (TG_OP = 'INSERT' OR NOT m = ANY (OLD."memberIds"))
       AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = m AND u."audience" = 'OFFICE' AND u."status" <> 'DEACTIVATED')
  ) THEN
    RAISE EXCEPTION 'email-in: a new member of team inbox % is an office person of the tenant who has not left', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "TeamInbox_guard" AFTER INSERT OR UPDATE ON "TeamInbox"
  FOR EACH ROW EXECUTE FUNCTION "factory_team_inbox_guard"();

-- =====================================================================================================================
-- CaptureAddress (COL-021)
CREATE FUNCTION "factory_capture_address_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inbox_active boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."token", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."token", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'email-in: the company and token of capture address % never change (a new address is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'email-in: capture address % was turned off at %; it changes no more', OLD."id", OLD."revokedAt"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."token" !~ '^[a-z2-7]{26}' THEN
    RAISE EXCEPTION 'email-in: the token of capture address % is 26 random lower-case base32 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."revokedAt") THEN
    RAISE EXCEPTION 'email-in: capture address % was not turned off in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."defaultTeamInboxId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."defaultTeamInboxId" IS DISTINCT FROM OLD."defaultTeamInboxId") THEN
    SELECT i."active" INTO inbox_active FROM "TeamInbox" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."defaultTeamInboxId";
    IF FOUND AND NOT inbox_active THEN
      RAISE EXCEPTION 'email-in: the default team inbox of capture address % is switched off', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "CaptureAddress_guard" AFTER INSERT OR UPDATE ON "CaptureAddress"
  FOR EACH ROW EXECUTE FUNCTION "factory_capture_address_guard"();

-- One live capture address per company: a leaked one is turned off and a new one made.
CREATE UNIQUE INDEX "CaptureAddress_one_live" ON "CaptureAddress" ("tenantId", "companyId") WHERE "revokedAt" IS NULL;

-- =====================================================================================================================
-- InboundEmail, 1 of 3: (W0, 202610283501_email_in_guards, whole) + W2b-6: a MATCHED mail's team-inbox columns
-- (teamInboxId, assigneeId, assignedAt, closedAt, closedById, snoozedUntil, followUpUntil) still move; a REJECTED mail, and
-- everything else of a MATCHED one, change no more.
CREATE OR REPLACE FUNCTION "factory_inbound_email_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'email-in: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email-in: received mail % is never deleted; it records what arrived and where it went', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."envelopeTo" IS NULL OR NEW."to" IS NULL OR NEW."cc" IS NULL OR NEW."referenceIds" IS NULL THEN
    RAISE EXCEPTION 'email-in: mail % lists its recipients and references (empty lists, not null)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attempts" < 0 THEN
    RAISE EXCEPTION 'email-in: mail % cannot have negative attempts', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('FETCHED', 'MATCHED', 'TRIAGE', 'HELD') AND NEW."fetchedAt" IS NULL THEN
    RAISE EXCEPTION 'email-in: mail % is % but was never read', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'MATCHED') <> (NEW."messageId" IS NOT NULL AND NEW."threadId" IS NOT NULL AND NEW."matchedBy" IS NOT NULL)
     OR (NEW."status" <> 'MATCHED' AND (NEW."messageId" IS NOT NULL OR NEW."matchedBy" IS NOT NULL)) THEN
    RAISE EXCEPTION 'email-in: mail % names its thread, message and match exactly when it is MATCHED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'HELD') <> (NEW."heldReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'email-in: mail % has a held reason exactly when it is HELD', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'REJECTED') <> (NEW."rejectReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'email-in: mail % has a reject reason exactly when it is REJECTED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."messageId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Message" m
     WHERE m."id" = NEW."messageId" AND m."tenantId" = NEW."tenantId" AND m."threadId" = NEW."threadId"
       AND m."direction" = 'INBOUND' AND m."channel" = 'EMAIL' AND m."emailMessageId" IS NOT DISTINCT FROM NEW."emailMessageId"
  ) THEN
    RAISE EXCEPTION 'email-in: mail % must name an INBOUND email message of its thread with its own Message-ID', NEW."id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- W2b-6 (wave 47/57): the team-inbox columns of a MATCHED mail still move (a REJECTED mail keeps them too).
  IF OLD."status" IN ('MATCHED', 'REJECTED')
     AND (to_jsonb(NEW) - ARRAY['version', 'updatedAt'] - CASE WHEN OLD."status" = 'MATCHED' THEN ARRAY['teamInboxId', 'assigneeId', 'assignedAt', 'closedAt', 'closedById', 'snoozedUntil', 'followUpUntil'] ELSE ARRAY[]::text[] END)
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['version', 'updatedAt'] - CASE WHEN OLD."status" = 'MATCHED' THEN ARRAY['teamInboxId', 'assigneeId', 'assignedAt', 'closedAt', 'closedById', 'snoozedUntil', 'followUpUntil'] ELSE ARRAY[]::text[] END) THEN
    RAISE EXCEPTION 'email-in: mail % is %; it changes no more', OLD."id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."accountId", NEW."receiptId", NEW."sesMessageId", NEW."s3Bucket", NEW."s3Key",
      NEW."receivedAt", NEW."envelopeFrom", NEW."envelopeTo", NEW."spfVerdict", NEW."dkimVerdict", NEW."dmarcVerdict",
      NEW."dmarcPolicy", NEW."spamVerdict", NEW."virusVerdict", NEW."createdAt", NEW."createdById")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."accountId", OLD."receiptId", OLD."sesMessageId", OLD."s3Bucket", OLD."s3Key",
      OLD."receivedAt", OLD."envelopeFrom", OLD."envelopeTo", OLD."spfVerdict", OLD."dkimVerdict", OLD."dmarcVerdict",
      OLD."dmarcPolicy", OLD."spamVerdict", OLD."virusVerdict", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'email-in: what SES said about mail % never changes', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'RECEIVED'
     AND (NEW."fromAddress", NEW."fromName", NEW."to", NEW."cc", NEW."subject", NEW."emailMessageId", NEW."inReplyTo",
          NEW."referenceIds", NEW."sizeBytes", NEW."bodyText", NEW."bodyHtml", NEW."fetchedAt")
         IS DISTINCT FROM
         (OLD."fromAddress", OLD."fromName", OLD."to", OLD."cc", OLD."subject", OLD."emailMessageId", OLD."inReplyTo",
          OLD."referenceIds", OLD."sizeBytes", OLD."bodyText", OLD."bodyHtml", OLD."fetchedAt") THEN
    RAISE EXCEPTION 'email-in: what mail % held was written when it was read; it never changes', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" NOT IN ('RECEIVED', 'FETCHED') AND NEW."attachments" IS DISTINCT FROM OLD."attachments" THEN
    RAISE EXCEPTION 'email-in: the attachments of mail % were kept when it was read and sorted; they never change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'email-in: the attempts of mail % cannot go down', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'RECEIVED' AND NEW."status" IN ('FETCHED', 'REJECTED', 'FAILED'))
    OR (OLD."status" = 'FETCHED' AND NEW."status" IN ('MATCHED', 'TRIAGE', 'HELD', 'REJECTED'))
    OR (OLD."status" = 'TRIAGE' AND NEW."status" IN ('MATCHED', 'REJECTED'))
    OR (OLD."status" = 'HELD' AND NEW."status" IN ('MATCHED', 'TRIAGE', 'REJECTED'))
    OR (OLD."status" = 'FAILED' AND NEW."status" = 'REJECTED')
  ) THEN
    RAISE EXCEPTION 'email-in: mail % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- InboundEmail, 2 of 3: the team-inbox columns (COL-027).
CREATE FUNCTION "factory_inbound_email_team_inbox_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inbox_company uuid;
  inbox_active boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW."teamInboxId", NEW."assigneeId", NEW."assignedAt", NEW."closedAt", NEW."closedById", NEW."snoozedUntil", NEW."followUpUntil")
         IS NOT DISTINCT FROM (OLD."teamInboxId", OLD."assigneeId", OLD."assignedAt", OLD."closedAt", OLD."closedById", OLD."snoozedUntil", OLD."followUpUntil") THEN
    RETURN NULL;
  END IF;
  IF NEW."teamInboxId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."teamInboxId" IS DISTINCT FROM OLD."teamInboxId") THEN
    SELECT i."companyId", i."active" INTO inbox_company, inbox_active FROM "TeamInbox" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."teamInboxId";
    IF FOUND AND NEW."companyId" IS NOT NULL AND inbox_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'email-in: mail % lands in a team inbox of its own company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND NOT inbox_active THEN
      RAISE EXCEPTION 'email-in: team inbox % is switched off; no mail is put in it (mail %)', NEW."teamInboxId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."assigneeId" IS NULL) <> (NEW."assignedAt" IS NULL) THEN
    RAISE EXCEPTION 'email-in: mail % is assigned with who and when, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."assigneeId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."assigneeId" IS DISTINCT FROM OLD."assigneeId")
     AND NOT "factory_notify_office_user_ok"(NEW."tenantId", NEW."assigneeId") THEN
    RAISE EXCEPTION 'email-in: mail % is assigned to an office person', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."closedById" IS NOT NULL AND NEW."closedAt" IS NULL THEN
    RAISE EXCEPTION 'email-in: who closed mail % comes with when', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."assignedAt") OR NOT "factory_recall_not_future"(NEW."closedAt") THEN
    RAISE EXCEPTION 'email-in: mail % was not assigned or closed in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "InboundEmail_team_inbox_check"
  AFTER INSERT OR UPDATE OF "teamInboxId", "assigneeId", "assignedAt", "closedAt", "closedById", "snoozedUntil", "followUpUntil" ON "InboundEmail"
  FOR EACH ROW EXECUTE FUNCTION "factory_inbound_email_team_inbox_check"();

-- InboundEmail, 3 of 3: a follow-up cancels itself when the partner replies: when a mail joins a thread (MATCHED), the
-- follow-ups of the thread's mails received before it end (the version moves on, so a compare-and-set write of the old
-- row fails and reads again); a REJECTED mail keeps what it had (it changes no more).
CREATE FUNCTION "factory_inbound_email_follow_up_ends"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'MATCHED' AND NEW."threadId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'MATCHED') THEN
    UPDATE "InboundEmail" e
       SET "followUpUntil" = NULL, "version" = e."version" + 1, "updatedAt" = now()
     WHERE e."tenantId" = NEW."tenantId" AND e."threadId" = NEW."threadId" AND e."id" <> NEW."id"
       AND e."followUpUntil" IS NOT NULL AND e."receivedAt" < NEW."receivedAt" AND e."status" <> 'REJECTED';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "InboundEmail_follow_up_ends" AFTER INSERT OR UPDATE OF "status" ON "InboundEmail"
  FOR EACH ROW EXECUTE FUNCTION "factory_inbound_email_follow_up_ends"();

-- =====================================================================================================================
-- EmailOutbound (COL-031): the bounce kind, kept by the database with bouncedAt. W2a's notification job
-- (platform/email-out/notifications.ts) sets bouncedAt for a Permanent bounce only, so PERMANENT is written with it; a
-- Transient or Undetermined bounce is written by B-W2b-394 (the mail stays as it was). Fired before "EmailOutbound_guard"
-- (names in order), which leaves bounceKind alone.
CREATE FUNCTION "factory_email_outbound_bounce_kind"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."bouncedAt" IS NOT NULL THEN
    NEW."bounceKind" := 'PERMANENT';
  ELSIF NEW."bounceKind" = 'PERMANENT' THEN
    RAISE EXCEPTION 'email: mail % bounced for good (PERMANENT) only with when it bounced', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."bouncedAt" IS NOT NULL AND NEW."bouncedAt" IS DISTINCT FROM OLD."bouncedAt" THEN
      RAISE EXCEPTION 'email: when mail % bounced is set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."bounceKind" IS NOT NULL AND NEW."bounceKind" IS NULL THEN
      RAISE EXCEPTION 'email: the bounce kind of mail % is never cleared', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- The mails that bounced for good before this wave.
UPDATE "EmailOutbound" SET "bounceKind" = 'PERMANENT' WHERE "bouncedAt" IS NOT NULL AND "bounceKind" IS NULL;

CREATE TRIGGER "EmailOutbound_bounce_kind" BEFORE INSERT OR UPDATE ON "EmailOutbound"
  FOR EACH ROW EXECUTE FUNCTION "factory_email_outbound_bounce_kind"();

-- =====================================================================================================================
-- SalesSettings: the inquiry addresses (SAL-033; B-W2b-295's need).
CREATE FUNCTION "factory_sales_settings_inquiry_addresses_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  address text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."inquiryAddresses" IS NOT DISTINCT FROM OLD."inquiryAddresses" THEN
    RETURN NULL;
  END IF;
  IF NEW."inquiryAddresses" IS NULL OR array_position(NEW."inquiryAddresses", NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'sales: the inquiry addresses of sales settings % are a list (an empty list, not null; no empty entry)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."inquiryAddresses") > 20
     OR (SELECT count(DISTINCT a) FROM unnest(NEW."inquiryAddresses") AS a) <> cardinality(NEW."inquiryAddresses") THEN
    RAISE EXCEPTION 'sales: sales settings % list at most 20 inquiry addresses, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  FOREACH address IN ARRAY NEW."inquiryAddresses" LOOP
    IF char_length(address) > 254 OR address !~ '^[^@[:space:][:cntrl:][:upper:]]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' THEN
      RAISE EXCEPTION 'sales: "%" is not a lower-case e-mail address (the inquiry addresses of sales settings %)', left(address, 80), NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SalesSettings_inquiry_addresses_check" AFTER INSERT OR UPDATE OF "inquiryAddresses" ON "SalesSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_settings_inquiry_addresses_check"();
