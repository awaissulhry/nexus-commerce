-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202610301001_platform_w2a_schema and before the policy migration. When the migrations are renumbered, keep this file
-- as it is under its new timestamp, and keep it OUT of prisma/migrations while `npm run migration` runs.

-- The platform schema of W2a (wave 1/7): the rules of its tables for every login, the owner included. The API answers
-- first, in words (B-W2a-08, -18, -20, -23, -32, -33, -36, -41, -42); these are the last word.
--
--   append-only   NotificationDelivery, MessageMention, AlertEvent, RestoreDrill: UPDATE, DELETE and TRUNCATE refused.
--   never deleted WorkCalendar, ShiftPattern, Task, ExportJob, AlertRule, Alert, DueTimer, ReasonCode (archived,
--                 cancelled, expired, switched off, resolved or set inactive instead); DELETE and TRUNCATE refused.
--   one of a kind one ACTIVE calendar per owner; one role default view per list, role and company; one PENDING timer
--                 per record and timer key (partial unique indexes); one unresolved alert per condition (trigger).
--   at commit     a pattern's breaks lie inside its shifts; an alert's acknowledgement, assignment, snooze and resolution
--                 are each in its history.
--   W0/W1 tables  StoredFile's scan state (factory_stored_file_guard redefined: the whole body of …_files_guards plus
--                 the scan), Today's snooze (the three functions of …_insights_attention_actions_guards redefined: their
--                 whole bodies plus the snooze), Site.floorLocales, Device's reported state.
-- A row whose parent another tenant owns is left to the policies: a check that reads the parent skips it when the parent
-- is not visible, so a row moved out of its tenant is refused by row-level security, not by these words.

-- =====================================================================================================================
-- Shared
CREATE FUNCTION "factory_refuse_platform_w2a_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform: % on "%" is refused; this history is never changed and no row of it is removed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_refuse_platform_w2a_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform: TRUNCATE on "%" is refused; its rows are never deleted', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- ISO weekdays: 1 (Monday) … 7 (Sunday), ascending, no repeats, at least one.
CREATE FUNCTION "factory_iso_weekdays_ok"(days integer[]) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  day integer;
  previous integer := 0;
BEGIN
  IF days IS NULL OR cardinality(days) = 0 THEN
    RETURN false;
  END IF;
  FOREACH day IN ARRAY days LOOP
    IF day IS NULL OR day <= previous OR day > 7 THEN
      RETURN false;
    END IF;
    previous := day;
  END LOOP;
  RETURN true;
END
$$;

-- The columns of a row that must not change, compared as JSON (tenantId is left to the policies).
CREATE FUNCTION "factory_platform_w2a_fixed"(new_row jsonb, old_row jsonb, keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT (SELECT jsonb_object_agg(key, value) FROM jsonb_each(new_row) WHERE key = ANY (keys))
         IS NOT DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(old_row) WHERE key = ANY (keys))
$$;

-- =====================================================================================================================
-- Append-only: NotificationDelivery, MessageMention, AlertEvent, RestoreDrill (scripts/factory/check-append-only.mjs)
CREATE TRIGGER "NotificationDelivery_append_only" BEFORE UPDATE OR DELETE ON "NotificationDelivery"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_platform_w2a_change"();
CREATE TRIGGER "NotificationDelivery_no_truncate" BEFORE TRUNCATE ON "NotificationDelivery"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_platform_w2a_change"();
CREATE TRIGGER "MessageMention_append_only" BEFORE UPDATE OR DELETE ON "MessageMention"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_platform_w2a_change"();
CREATE TRIGGER "MessageMention_no_truncate" BEFORE TRUNCATE ON "MessageMention"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_platform_w2a_change"();
CREATE TRIGGER "AlertEvent_append_only" BEFORE UPDATE OR DELETE ON "AlertEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_platform_w2a_change"();
CREATE TRIGGER "AlertEvent_no_truncate" BEFORE TRUNCATE ON "AlertEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_platform_w2a_change"();
CREATE TRIGGER "RestoreDrill_append_only" BEFORE UPDATE OR DELETE ON "RestoreDrill"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_platform_w2a_change"();
CREATE TRIGGER "RestoreDrill_no_truncate" BEFORE TRUNCATE ON "RestoreDrill"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_platform_w2a_change"();

-- =====================================================================================================================
-- Calendars (calendar.prisma)

-- WorkCalendar: exactly its owner's columns for its scope, which never change; a supplier's company is the supplier's
-- and its calendar carries no shift pattern; at least one working weekday; its pattern ACTIVE and tenant-wide or of its
-- company; archived, never deleted. One ACTIVE calendar per owner (the indexes below).
CREATE FUNCTION "factory_work_calendar_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed CONSTANT text[] := ARRAY['scope', 'companyId', 'siteId', 'lineId', 'workCentreId', 'partyId', 'createdAt', 'createdById'];
  party_company uuid;
  pattern record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'calendar: calendar % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT "factory_platform_w2a_fixed"(to_jsonb(NEW), to_jsonb(OLD), fixed) THEN
    RAISE EXCEPTION 'calendar: calendar % keeps its scope and its owner', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (CASE NEW."scope"
            WHEN 'COMPANY' THEN NEW."companyId" IS NOT NULL AND num_nonnulls(NEW."siteId", NEW."lineId", NEW."workCentreId", NEW."partyId") = 0
            WHEN 'SITE' THEN num_nulls(NEW."companyId", NEW."siteId") = 0 AND num_nonnulls(NEW."lineId", NEW."workCentreId", NEW."partyId") = 0
            WHEN 'LINE' THEN num_nulls(NEW."companyId", NEW."siteId", NEW."lineId") = 0 AND num_nonnulls(NEW."workCentreId", NEW."partyId") = 0
            WHEN 'WORK_CENTRE' THEN num_nulls(NEW."companyId", NEW."siteId", NEW."workCentreId") = 0 AND num_nonnulls(NEW."lineId", NEW."partyId") = 0
            ELSE NEW."partyId" IS NOT NULL AND num_nonnulls(NEW."siteId", NEW."lineId", NEW."workCentreId") = 0
          END) THEN
    RAISE EXCEPTION 'calendar: a % calendar (%) names exactly its owner: a company, a site of it, a line or work centre of the site, or a supplier', NEW."scope", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."name") = '' THEN
    RAISE EXCEPTION 'calendar: calendar % has a name', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_iso_weekdays_ok"(NEW."workingWeekdays") THEN
    RAISE EXCEPTION 'calendar: calendar % lists its working weekdays, 1 (Monday) to 7 (Sunday), ascending, at least one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."scope" = 'SUPPLIER' THEN
    IF NEW."shiftPatternId" IS NOT NULL THEN
      RAISE EXCEPTION 'calendar: a supplier''s calendar (%) keeps its working days, not our shifts', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT p."companyId" INTO party_company FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND party_company IS DISTINCT FROM NEW."companyId" THEN
      RAISE EXCEPTION 'calendar: a supplier''s calendar (%) belongs to the supplier''s company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."shiftPatternId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."shiftPatternId" IS DISTINCT FROM OLD."shiftPatternId") THEN
    SELECT s."status", s."companyId" INTO pattern FROM "ShiftPattern" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."shiftPatternId";
    IF FOUND AND (pattern."status" <> 'ACTIVE' OR (pattern."companyId" IS NOT NULL AND pattern."companyId" IS DISTINCT FROM NEW."companyId")) THEN
      RAISE EXCEPTION 'calendar: calendar % uses an active shift pattern of the tenant or of its own company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkCalendar_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkCalendar"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_calendar_guard"();
CREATE TRIGGER "WorkCalendar_no_truncate" BEFORE TRUNCATE ON "WorkCalendar"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_platform_w2a_truncate"();

CREATE UNIQUE INDEX "WorkCalendar_one_per_company" ON "WorkCalendar" ("tenantId", "companyId") WHERE "scope" = 'COMPANY' AND "status" = 'ACTIVE';
CREATE UNIQUE INDEX "WorkCalendar_one_per_site" ON "WorkCalendar" ("tenantId", "siteId") WHERE "scope" = 'SITE' AND "status" = 'ACTIVE';
CREATE UNIQUE INDEX "WorkCalendar_one_per_line" ON "WorkCalendar" ("tenantId", "lineId") WHERE "scope" = 'LINE' AND "status" = 'ACTIVE';
CREATE UNIQUE INDEX "WorkCalendar_one_per_work_centre" ON "WorkCalendar" ("tenantId", "workCentreId") WHERE "scope" = 'WORK_CENTRE' AND "status" = 'ACTIVE';
CREATE UNIQUE INDEX "WorkCalendar_one_per_supplier" ON "WorkCalendar" ("tenantId", "partyId") WHERE "scope" = 'SUPPLIER' AND "status" = 'ACTIVE';

-- CalendarDay: a name; its calendar and date never change; only a WORKING day carries a pattern (never on a supplier's
-- calendar), an active one of the tenant or of the calendar's company; only a HOLIDAY comes from a holiday list.
CREATE FUNCTION "factory_calendar_day_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  calendar record;
  pattern record;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."calendarId", NEW."date", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."calendarId", OLD."date", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'calendar: day % keeps its calendar and its date (another date is another day)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."name") = '' THEN
    RAISE EXCEPTION 'calendar: day % says what it is', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" <> 'WORKING' AND NEW."shiftPatternId" IS NOT NULL THEN
    RAISE EXCEPTION 'calendar: a holiday or a closure (%) has no shifts', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."holidaySet" IS NOT NULL AND (NEW."kind" <> 'HOLIDAY' OR NEW."holidaySet" !~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$') THEN
    RAISE EXCEPTION 'calendar: only a public holiday (%) comes from a holiday list, named by its country code', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shiftPatternId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."shiftPatternId" IS DISTINCT FROM OLD."shiftPatternId") THEN
    SELECT c."scope", c."companyId" INTO calendar FROM "WorkCalendar" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."calendarId";
    IF FOUND THEN
      IF calendar."scope" = 'SUPPLIER' THEN
        RAISE EXCEPTION 'calendar: a supplier''s day (%) keeps no shifts of ours', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT s."status", s."companyId" INTO pattern FROM "ShiftPattern" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."shiftPatternId";
      IF FOUND AND (pattern."status" <> 'ACTIVE' OR (pattern."companyId" IS NOT NULL AND pattern."companyId" IS DISTINCT FROM calendar."companyId")) THEN
        RAISE EXCEPTION 'calendar: day % uses an active shift pattern of the tenant or of its calendar''s company', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CalendarDay_guard" BEFORE INSERT OR UPDATE ON "CalendarDay"
  FOR EACH ROW EXECUTE FUNCTION "factory_calendar_day_guard"();

-- ShiftPattern: a code and a name; its code and company never change; not archived while an ACTIVE calendar uses it;
-- archived, never deleted.
CREATE FUNCTION "factory_shift_pattern_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'calendar: shift pattern % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."code") = '' OR btrim(NEW."name") = '' THEN
    RAISE EXCEPTION 'calendar: shift pattern % has a code and a name', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."code", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."code", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'calendar: shift pattern % keeps its code and its company', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'ARCHIVED' AND OLD."status" = 'ACTIVE' AND EXISTS (
         SELECT 1 FROM "WorkCalendar" c WHERE c."tenantId" = NEW."tenantId" AND c."shiftPatternId" = NEW."id" AND c."status" = 'ACTIVE') THEN
      RAISE EXCEPTION 'calendar: shift pattern % is used by an active calendar; give the calendar another pattern first', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ShiftPattern_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ShiftPattern"
  FOR EACH ROW EXECUTE FUNCTION "factory_shift_pattern_guard"();
CREATE TRIGGER "ShiftPattern_no_truncate" BEFORE TRUNCATE ON "ShiftPattern"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_platform_w2a_truncate"();

-- ShiftSegment: a weekday 1-7; a shift starts in its day, a break may fall after midnight inside a night shift; it ends
-- after it starts, at most 24 hours later (and within the next day); its pattern never changes.
-- At commit: every BREAK of a pattern's weekday lies inside one of that weekday's SHIFTs.
CREATE FUNCTION "factory_shift_segment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."patternId" IS DISTINCT FROM OLD."patternId" THEN
    RAISE EXCEPTION 'calendar: segment % stays in its pattern', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."weekday" < 1 OR NEW."weekday" > 7 THEN
    RAISE EXCEPTION 'calendar: segment % is on an ISO weekday, 1 (Monday) to 7 (Sunday)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."startMinute" < 0 OR NEW."startMinute" >= (CASE WHEN NEW."kind" = 'SHIFT' THEN 1440 ELSE 2880 END)
     OR NEW."endMinute" <= NEW."startMinute" OR NEW."endMinute" > NEW."startMinute" + 1440 OR NEW."endMinute" > 2880 THEN
    RAISE EXCEPTION 'calendar: segment % starts in its day (a shift at 0-1439 minutes; a break may fall after midnight in a night shift) and ends after it starts, at most 24 hours later', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."label" IS NOT NULL AND btrim(NEW."label") = '' THEN
    RAISE EXCEPTION 'calendar: segment % has a name or none, not a blank one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ShiftSegment_guard" BEFORE INSERT OR UPDATE ON "ShiftSegment"
  FOR EACH ROW EXECUTE FUNCTION "factory_shift_segment_guard"();

CREATE FUNCTION "factory_shift_segment_breaks"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tenant uuid;
  pattern uuid;
  days integer[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    tenant := OLD."tenantId";
    pattern := OLD."patternId";
    days := ARRAY[OLD."weekday"];
  ELSIF TG_OP = 'UPDATE' THEN
    tenant := NEW."tenantId";
    pattern := NEW."patternId";
    days := ARRAY[NEW."weekday", OLD."weekday"];
  ELSE
    tenant := NEW."tenantId";
    pattern := NEW."patternId";
    days := ARRAY[NEW."weekday"];
  END IF;
  IF EXISTS (
       SELECT 1 FROM "ShiftSegment" b
        WHERE b."tenantId" = tenant AND b."patternId" = pattern AND b."weekday" = ANY (days) AND b."kind" = 'BREAK'
          AND NOT EXISTS (
            SELECT 1 FROM "ShiftSegment" s
             WHERE s."tenantId" = b."tenantId" AND s."patternId" = b."patternId" AND s."weekday" = b."weekday" AND s."kind" = 'SHIFT'
               AND s."startMinute" <= b."startMinute" AND s."endMinute" >= b."endMinute")) THEN
    RAISE EXCEPTION 'calendar: a break of shift pattern % lies outside every shift of its weekday', pattern
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "ShiftSegment_breaks_inside_shifts" AFTER INSERT OR UPDATE OR DELETE ON "ShiftSegment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "factory_shift_segment_breaks"();

-- =====================================================================================================================
-- Working together (collab.prisma)

-- Notification: its sentence, record, event and person never change (only read, done and snooze do); it names its
-- event, record and message key; params is an object; a snooze until a time is set at an earlier time.
CREATE FUNCTION "factory_notification_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changing CONSTANT text[] := ARRAY['tenantId', 'readAt', 'doneAt', 'snoozedAt', 'snoozedUntil', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'UPDATE'
     AND (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE NOT (key = ANY (changing)))
         IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE NOT (key = ANY (changing))) THEN
    RAISE EXCEPTION 'notifications: notification % keeps what it says; its person only reads it, finishes it or snoozes it', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."eventType") = '' OR btrim(NEW."recordType") = '' OR btrim(NEW."recordLabel") = '' OR btrim(NEW."messageKey") = ''
     OR jsonb_typeof(NEW."params") <> 'object' THEN
    RAISE EXCEPTION 'notifications: notification % names its event, its record with its label, and its sentence (a message key and an object of values)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."snoozedUntil" IS NOT NULL AND (NEW."snoozedAt" IS NULL OR NEW."snoozedUntil" <= NEW."snoozedAt") THEN
    RAISE EXCEPTION 'notifications: notification % is snoozed at a time until a later one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Notification_guard" BEFORE INSERT OR UPDATE ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION "factory_notification_guard"();

-- NotificationDelivery: an e-mail sent names its mail, nothing else does; a skipped or failed one says why.
CREATE FUNCTION "factory_notification_delivery_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF btrim(NEW."requestId") = '' THEN
    RAISE EXCEPTION 'notifications: delivery % keeps its request', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."channel" = 'EMAIL' AND NEW."outcome" = 'SENT') <> (NEW."emailOutboundId" IS NOT NULL) THEN
    RAISE EXCEPTION 'notifications: an e-mail sent (%) names its mail, and nothing else names one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."outcome" <> 'SENT' AND (NEW."detail" IS NULL OR btrim(NEW."detail") = '') THEN
    RAISE EXCEPTION 'notifications: a delivery skipped or failed (%) says why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "NotificationDelivery_check" BEFORE INSERT ON "NotificationDelivery"
  FOR EACH ROW EXECUTE FUNCTION "factory_notification_delivery_check"();

-- RecordFollower: its record, person and reason never change.
CREATE FUNCTION "factory_record_follower_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF btrim(NEW."recordType") = '' THEN
    RAISE EXCEPTION 'followers: follower % names its record', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW."recordType", NEW."recordId", NEW."userId", NEW."reason", NEW."createdAt", NEW."createdById")
         IS DISTINCT FROM (OLD."recordType", OLD."recordId", OLD."userId", OLD."reason", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'followers: follower % keeps its record, its person and why they followed it', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RecordFollower_guard" BEFORE INSERT OR UPDATE ON "RecordFollower"
  FOR EACH ROW EXECUTE FUNCTION "factory_record_follower_guard"();

-- MessageMention: one of the people its note mentions, with the note's thread, author and time, and the thread's record.
CREATE FUNCTION "factory_message_mention_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  note record;
  thread record;
BEGIN
  IF btrim(NEW."recordType") = '' THEN
    RAISE EXCEPTION 'mentions: mention % names its record', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT m."threadId", m."mentionedUserIds", m."authorKind", m."authorId", m."at" INTO note
    FROM "Message" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."messageId";
  IF FOUND AND (note."threadId" <> NEW."threadId" OR NOT (NEW."userId" = ANY (note."mentionedUserIds")) OR note."at" <> NEW."at"
                OR NEW."authorId" IS DISTINCT FROM (CASE WHEN note."authorKind" = 'USER' THEN note."authorId" END)) THEN
    RAISE EXCEPTION 'mentions: mention % names a person its note mentions, with the note''s thread, author and time', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT t."recordType", t."recordId" INTO thread FROM "Thread" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."threadId";
  IF FOUND AND (thread."recordType" <> NEW."recordType" OR thread."recordId" <> NEW."recordId") THEN
    RAISE EXCEPTION 'mentions: mention % names its thread''s record', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "MessageMention_check" BEFORE INSERT ON "MessageMention"
  FOR EACH ROW EXECUTE FUNCTION "factory_message_mention_check"();

-- Task: a title; its record (all three or none) never changes; an assignment is a person, by someone, at a time (all or
-- none); a due time needs its day; the checklist is a list; closed (DONE, CANCELLED) exactly when it has a closing time;
-- only an OPEN task is snoozed; cancelled, never deleted.
CREATE FUNCTION "factory_task_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed CONSTANT text[] := ARRAY['recordType', 'recordId', 'recordLabel', 'createdAt', 'createdById'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tasks: task % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT "factory_platform_w2a_fixed"(to_jsonb(NEW), to_jsonb(OLD), fixed) THEN
    RAISE EXCEPTION 'tasks: task % stays on its record', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."title") = '' THEN
    RAISE EXCEPTION 'tasks: task % has a title', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nulls(NEW."recordType", NEW."recordId", NEW."recordLabel") NOT IN (0, 3)
     OR btrim(coalesce(NEW."recordType", 'x')) = '' OR btrim(coalesce(NEW."recordLabel", 'x')) = '' THEN
    RAISE EXCEPTION 'tasks: task % is on a record (its type, id and label) or on none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nulls(NEW."assigneeId", NEW."assignedById", NEW."assignedAt") NOT IN (0, 3) THEN
    RAISE EXCEPTION 'tasks: task % is assigned to a person, by someone, at a time, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."dueTime" IS NOT NULL AND (NEW."dueDate" IS NULL OR NEW."dueTime" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') THEN
    RAISE EXCEPTION 'tasks: task % has a due time (HH:MM) only on its due day', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."checklist") <> 'array' THEN
    RAISE EXCEPTION 'tasks: the checklist of task % is a list', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'OPEN') <> (NEW."closedAt" IS NULL) OR (NEW."closedById" IS NOT NULL AND NEW."closedAt" IS NULL) THEN
    RAISE EXCEPTION 'tasks: task % is done or cancelled exactly when it has a closing time (and who closed it, if anyone)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."snoozedUntil" IS NOT NULL AND NEW."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'tasks: only an open task is snoozed (%)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Task_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Task"
  FOR EACH ROW EXECUTE FUNCTION "factory_task_guard"();
CREATE TRIGGER "Task_no_truncate" BEFORE TRUNCATE ON "Task"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_platform_w2a_truncate"();

-- =====================================================================================================================
-- Lists and reports (views.prisma)

-- SavedView: a name and a list id; shared with a role exactly when it names one, an office role; a role default is a
-- ROLE view; its state is an object; its owner and list never change. One role default per list, role and company.
CREATE FUNCTION "factory_saved_view_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  role_audience text;
BEGIN
  IF btrim(NEW."name") = '' OR NEW."listKey" !~ '^[a-z][a-z0-9_.-]*$' THEN
    RAISE EXCEPTION 'views: saved view % has a name and names its list by its page id', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."audience" = 'ROLE') <> (NEW."roleId" IS NOT NULL) OR (NEW."roleDefault" AND NEW."audience" <> 'ROLE') THEN
    RAISE EXCEPTION 'views: saved view % names a role exactly when it is shared with one, and only such a view is a role''s default', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."state") <> 'object' THEN
    RAISE EXCEPTION 'views: saved view % keeps its state as an object', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."ownerId", NEW."listKey", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."ownerId", OLD."listKey", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'views: saved view % keeps its owner and its list', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."roleId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."roleId" IS DISTINCT FROM OLD."roleId") THEN
    SELECT r."audience"::text INTO role_audience FROM "Role" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."roleId";
    IF FOUND AND role_audience <> 'OFFICE' THEN
      RAISE EXCEPTION 'views: saved view % is shared with an office role', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SavedView_guard" BEFORE INSERT OR UPDATE ON "SavedView"
  FOR EACH ROW EXECUTE FUNCTION "factory_saved_view_guard"();

CREATE UNIQUE INDEX "SavedView_one_role_default" ON "SavedView" ("tenantId", "listKey", "roleId", (COALESCE("companyId", '00000000-0000-0000-0000-000000000000'::uuid))) WHERE "roleDefault";

-- ExportJob: born QUEUED; QUEUED → RUNNING | FAILED, RUNNING → QUEUED (a retry) | DONE | FAILED, DONE → EXPIRED;
-- FAILED and EXPIRED are final. What was asked never changes; RUNNING has its start, DONE its start, end, row count and
-- file (a StoredFile of this job, named once), FAILED its end and reason; rows written never pass the count. Expired,
-- never deleted.
CREATE FUNCTION "factory_export_job_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed CONSTANT text[] := ARRAY['companyId', 'requestedById', 'listKey', 'viewId', 'format', 'query', 'omittedColumns', 'createdAt'];
  file record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'exports: export % expires, it is never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."listKey" !~ '^[a-z][a-z0-9_.-]*$' OR jsonb_typeof(NEW."query") <> 'object' OR NEW."omittedColumns" IS NULL THEN
    RAISE EXCEPTION 'exports: export % names its list by its page id and keeps what was asked (an object) and the columns left out', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."rowsDone" < 0 OR NEW."rowCount" < 0 OR NEW."rowsDone" > NEW."rowCount" THEN
    RAISE EXCEPTION 'exports: export % writes 0 rows or more, never more than its count', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'RUNNING' AND NEW."startedAt" IS NULL)
     OR (NEW."status" IN ('DONE', 'EXPIRED') AND num_nulls(NEW."startedAt", NEW."finishedAt", NEW."rowCount", NEW."fileId") > 0)
     OR (NEW."status" = 'FAILED' AND (NEW."finishedAt" IS NULL OR NEW."failureReason" IS NULL OR btrim(NEW."failureReason") = ''))
     OR (NEW."status" IN ('QUEUED', 'RUNNING') AND num_nonnulls(NEW."finishedAt", NEW."fileId", NEW."failureReason") > 0) THEN
    RAISE EXCEPTION 'exports: export % is % without its times, count, file or reason (or with what it cannot have yet)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'QUEUED' THEN
      RAISE EXCEPTION 'exports: a new export is QUEUED, not %', NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT "factory_platform_w2a_fixed"(to_jsonb(NEW), to_jsonb(OLD), fixed) THEN
      RAISE EXCEPTION 'exports: export % keeps what was asked', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('FAILED', 'EXPIRED') AND to_jsonb(NEW) - 'tenantId' - 'version' - 'updatedAt' IS DISTINCT FROM to_jsonb(OLD) - 'tenantId' - 'version' - 'updatedAt' THEN
      RAISE EXCEPTION 'exports: export % is %; it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'QUEUED' AND NEW."status" IN ('RUNNING', 'FAILED'))
                OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('QUEUED', 'DONE', 'FAILED'))
                OR (OLD."status" = 'DONE' AND NEW."status" = 'EXPIRED')) THEN
      RAISE EXCEPTION 'exports: export % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."fileId" IS NOT NULL AND NEW."fileId" IS DISTINCT FROM OLD."fileId" THEN
      RAISE EXCEPTION 'exports: export % keeps its file', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."fileId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."fileId" IS NULL) THEN
    SELECT f."recordType", f."recordId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
    IF FOUND AND (file."recordType" <> 'ExportJob' OR file."recordId" <> NEW."id") THEN
      RAISE EXCEPTION 'exports: the file of export % is a file of that export', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ExportJob_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ExportJob"
  FOR EACH ROW EXECUTE FUNCTION "factory_export_job_guard"();
CREATE TRIGGER "ExportJob_no_truncate" BEFORE TRUNCATE ON "ExportJob"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_platform_w2a_truncate"();

-- ReportSubscription: a report key, a language, a time of day and its weekdays; a site only with its company; params an
-- object; its recipient and report never change.
CREATE FUNCTION "factory_report_subscription_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."reportKey" !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' OR NEW."locale" !~ '^[a-z]{2,3}$' THEN
    RAISE EXCEPTION 'reports: subscription % names its report (area.report) and its language (ISO 639)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sendTime" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR NOT "factory_iso_weekdays_ok"(NEW."weekdays") THEN
    RAISE EXCEPTION 'reports: subscription % is sent at a time of day (HH:MM) on ISO weekdays, 1 (Monday) to 7 (Sunday), ascending, at least one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."siteId" IS NOT NULL AND NEW."companyId" IS NULL) OR jsonb_typeof(NEW."params") <> 'object' THEN
    RAISE EXCEPTION 'reports: subscription % names a site only with its company, and keeps its filters as an object', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."userId", NEW."reportKey", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."userId", OLD."reportKey", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'reports: subscription % keeps its recipient and its report', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReportSubscription_guard" BEFORE INSERT OR UPDATE ON "ReportSubscription"
  FOR EACH ROW EXECUTE FUNCTION "factory_report_subscription_guard"();

-- =====================================================================================================================
-- Alerts and timers (alerts.prisma)

-- AlertRule: an upper-case kind, a name, numbers as an object, a cooldown of 0 or more, one or more channels (no
-- repeats); a site only with its company; an office role; its kind, trigger and built-in mark never change; switched
-- off, never deleted.
CREATE FUNCTION "factory_alert_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  role_audience text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'alerts: rule % is switched off, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ruleKind" !~ '^[A-Z][A-Z0-9_]*$' OR btrim(NEW."name") = '' OR jsonb_typeof(NEW."threshold") <> 'object' THEN
    RAISE EXCEPTION 'alerts: rule % names its kind (upper case), its title and its numbers (an object)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."cooldownMinutes" < 0 OR NEW."channels" IS NULL OR cardinality(NEW."channels") = 0
     OR (SELECT count(DISTINCT c) FROM unnest(NEW."channels") c) <> cardinality(NEW."channels") THEN
    RAISE EXCEPTION 'alerts: rule % tells by one or more channels, each once, at most once per cooldown of 0 minutes or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."siteId" IS NOT NULL AND NEW."companyId" IS NULL THEN
    RAISE EXCEPTION 'alerts: rule % names a site only with its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."ruleKind", NEW."trigger", NEW."builtIn", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."ruleKind", OLD."trigger", OLD."builtIn", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'alerts: rule % keeps its kind, its trigger and whether it is built in', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."recipientRoleId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."recipientRoleId" IS DISTINCT FROM OLD."recipientRoleId") THEN
    SELECT r."audience"::text INTO role_audience FROM "Role" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recipientRoleId";
    IF FOUND AND role_audience <> 'OFFICE' THEN
      RAISE EXCEPTION 'alerts: rule % tells the holders of an office role', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AlertRule_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AlertRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_alert_rule_guard"();
CREATE TRIGGER "AlertRule_no_truncate" BEFORE TRUNCATE ON "AlertRule"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_platform_w2a_truncate"();

-- Alert: keyed `<rule kind>:<record id>[:<sub key>]` by its own rule's kind and record, an occurrence of 1 or more; born
-- OPEN with nothing set, and only while no other alert of its key is unresolved; what it is about never changes;
-- OPEN → ACKNOWLEDGED → RESOLVED or OPEN → RESOLVED, and RESOLVED changes no more; an acknowledgement is by someone at a
-- time, an assignment and a snooze are all or none; resolved exactly when it has a resolution: HANDLED by a person with
-- a note, CLEARED by the system without one. Never deleted. At commit: each acknowledgement, assignment, snooze and
-- resolution is in its history.
CREATE FUNCTION "factory_alert_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed CONSTANT text[] := ARRAY['ruleId', 'ruleKind', 'severity', 'companyId', 'siteId', 'partyId', 'recordType', 'recordId', 'recordLabel',
                                 'dedupeKey', 'occurrence', 'facts', 'raisedAt', 'createdAt'];
  rule_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'alerts: alert % is resolved, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ruleKind" !~ '^[A-Z][A-Z0-9_]*$' OR btrim(NEW."recordType") = '' OR btrim(NEW."recordLabel") = '' OR jsonb_typeof(NEW."facts") <> 'object'
     OR NEW."occurrence" < 1 OR NOT starts_with(NEW."dedupeKey", NEW."ruleKind" || ':' || NEW."recordId"::text) THEN
    RAISE EXCEPTION 'alerts: alert % is keyed <rule kind>:<record id>[:<sub key>] by its own kind and record, counts its occurrence from 1 and keeps its facts (an object)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'OPEN' OR num_nonnulls(NEW."acknowledgedAt", NEW."acknowledgedById", NEW."assignedToId", NEW."assignedById", NEW."assignedAt",
                                             NEW."snoozedUntil", NEW."snoozedById", NEW."snoozedAt", NEW."resolvedAt", NEW."resolution",
                                             NEW."resolvedById", NEW."resolveNote") > 0 THEN
      RAISE EXCEPTION 'alerts: alert % is raised OPEN, with nothing done about it yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT r."ruleKind" INTO rule_kind FROM "AlertRule" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."ruleId";
    IF FOUND AND rule_kind <> NEW."ruleKind" THEN
      RAISE EXCEPTION 'alerts: alert % carries its rule''s kind', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "Alert" a WHERE a."tenantId" = NEW."tenantId" AND a."dedupeKey" = NEW."dedupeKey" AND a."state" <> 'RESOLVED') THEN
      RAISE EXCEPTION 'alerts: % is raised again only after its alert is resolved', NEW."dedupeKey"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT "factory_platform_w2a_fixed"(to_jsonb(NEW), to_jsonb(OLD), fixed) THEN
      RAISE EXCEPTION 'alerts: alert % keeps its rule, its record and why it fired', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'RESOLVED' AND to_jsonb(NEW) - 'tenantId' - 'version' - 'updatedAt' IS DISTINCT FROM to_jsonb(OLD) - 'tenantId' - 'version' - 'updatedAt' THEN
      RAISE EXCEPTION 'alerts: alert % is resolved; it changes no more', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."state" <> OLD."state"
       AND NOT ((OLD."state" = 'OPEN' AND NEW."state" IN ('ACKNOWLEDGED', 'RESOLVED')) OR (OLD."state" = 'ACKNOWLEDGED' AND NEW."state" = 'RESOLVED')) THEN
      RAISE EXCEPTION 'alerts: alert % cannot move from % to %', OLD."id", OLD."state", NEW."state"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF num_nulls(NEW."acknowledgedAt", NEW."acknowledgedById") NOT IN (0, 2)
     OR (NEW."state" = 'ACKNOWLEDGED' AND NEW."acknowledgedAt" IS NULL) OR (NEW."state" = 'OPEN' AND NEW."acknowledgedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'alerts: alert % is acknowledged by someone at a time exactly from ACKNOWLEDGED on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nulls(NEW."assignedToId", NEW."assignedById", NEW."assignedAt") NOT IN (0, 3) THEN
    RAISE EXCEPTION 'alerts: alert % is assigned to a person, by someone, at a time, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nulls(NEW."snoozedUntil", NEW."snoozedById", NEW."snoozedAt") NOT IN (0, 3) OR NEW."snoozedUntil" <= NEW."snoozedAt" THEN
    RAISE EXCEPTION 'alerts: alert % is snoozed by someone at a time until a later one, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."state" = 'RESOLVED') <> (NEW."resolvedAt" IS NOT NULL) OR (NEW."resolvedAt" IS NULL) <> (NEW."resolution" IS NULL)
     OR (NEW."resolution" = 'HANDLED' AND (NEW."resolvedById" IS NULL OR NEW."resolveNote" IS NULL OR btrim(NEW."resolveNote") = ''))
     OR (coalesce(NEW."resolution"::text, 'CLEARED') = 'CLEARED' AND num_nonnulls(NEW."resolvedById", NEW."resolveNote") > 0) THEN
    RAISE EXCEPTION 'alerts: alert % is resolved exactly when it has a resolution: by a person with a note saying what was done, or by the system with none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Alert_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Alert"
  FOR EACH ROW EXECUTE FUNCTION "factory_alert_guard"();
CREATE TRIGGER "Alert_no_truncate" BEFORE TRUNCATE ON "Alert"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_platform_w2a_truncate"();

CREATE FUNCTION "factory_alert_logged"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."acknowledgedAt" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."acknowledgedAt" IS DISTINCT FROM OLD."acknowledgedAt")
     AND NOT EXISTS (
       SELECT 1 FROM "AlertEvent" e
        WHERE e."tenantId" = NEW."tenantId" AND e."alertId" = NEW."id" AND e."verb" = 'ACKNOWLEDGED'
          AND e."actorId" = NEW."acknowledgedById" AND e."at" = NEW."acknowledgedAt") THEN
    RAISE EXCEPTION 'alerts: the acknowledgement of alert % is not in its history', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."assignedToId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."assignedToId" IS DISTINCT FROM OLD."assignedToId" OR NEW."assignedAt" IS DISTINCT FROM OLD."assignedAt")
     AND NOT EXISTS (
       SELECT 1 FROM "AlertEvent" e
        WHERE e."tenantId" = NEW."tenantId" AND e."alertId" = NEW."id" AND e."verb" = 'ASSIGNED'
          AND e."assigneeId" = NEW."assignedToId" AND e."actorId" = NEW."assignedById" AND e."at" = NEW."assignedAt") THEN
    RAISE EXCEPTION 'alerts: the assignment of alert % is not in its history', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."snoozedAt" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."snoozedAt" IS DISTINCT FROM OLD."snoozedAt" OR NEW."snoozedUntil" IS DISTINCT FROM OLD."snoozedUntil")
     AND NOT EXISTS (
       SELECT 1 FROM "AlertEvent" e
        WHERE e."tenantId" = NEW."tenantId" AND e."alertId" = NEW."id" AND e."verb" = 'SNOOZED'
          AND e."actorId" = NEW."snoozedById" AND e."snoozedUntil" = NEW."snoozedUntil" AND e."at" = NEW."snoozedAt") THEN
    RAISE EXCEPTION 'alerts: the snooze of alert % is not in its history', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."resolvedAt" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt")
     AND NOT EXISTS (
       SELECT 1 FROM "AlertEvent" e
        WHERE e."tenantId" = NEW."tenantId" AND e."alertId" = NEW."id" AND e."verb" = 'RESOLVED'
          AND e."actorId" IS NOT DISTINCT FROM NEW."resolvedById" AND e."note" IS NOT DISTINCT FROM NEW."resolveNote" AND e."at" = NEW."resolvedAt") THEN
    RAISE EXCEPTION 'alerts: the resolution of alert % is not in its history', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "Alert_logged" AFTER INSERT OR UPDATE ON "Alert"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "factory_alert_logged"();

-- AlertEvent: what each verb carries. RAISED: the system, with the facts; ACKNOWLEDGED: a person; ASSIGNED and
-- UNASSIGNED: a person and the assignee; SNOOZED: a person and a later time; RESOLVED: a person with a note, or the
-- system without one.
CREATE FUNCTION "factory_alert_event_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF btrim(NEW."requestId") = '' THEN
    RAISE EXCEPTION 'alerts: history row % keeps its request', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (CASE NEW."verb"
            WHEN 'RAISED' THEN num_nonnulls(NEW."actorId", NEW."assigneeId", NEW."snoozedUntil", NEW."note") = 0 AND jsonb_typeof(NEW."facts") = 'object'
            WHEN 'ACKNOWLEDGED' THEN NEW."actorId" IS NOT NULL AND num_nonnulls(NEW."assigneeId", NEW."snoozedUntil", NEW."note", NEW."facts") = 0
            WHEN 'ASSIGNED' THEN num_nulls(NEW."actorId", NEW."assigneeId") = 0 AND num_nonnulls(NEW."snoozedUntil", NEW."note", NEW."facts") = 0
            WHEN 'UNASSIGNED' THEN num_nulls(NEW."actorId", NEW."assigneeId") = 0 AND num_nonnulls(NEW."snoozedUntil", NEW."note", NEW."facts") = 0
            WHEN 'SNOOZED' THEN num_nulls(NEW."actorId", NEW."snoozedUntil") = 0 AND NEW."snoozedUntil" > NEW."at" AND num_nonnulls(NEW."assigneeId", NEW."note", NEW."facts") = 0
            ELSE num_nonnulls(NEW."assigneeId", NEW."snoozedUntil", NEW."facts") = 0
                 AND ((NEW."actorId" IS NULL AND NEW."note" IS NULL) OR (NEW."actorId" IS NOT NULL AND btrim(coalesce(NEW."note", '')) <> ''))
          END) THEN
    RAISE EXCEPTION 'alerts: history row % (%) carries what its verb needs and nothing else', NEW."id", NEW."verb"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AlertEvent_check" BEFORE INSERT ON "AlertEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_alert_event_check"();

-- DueTimer: a timer key (`KIND[:±N(m|h|d)]`), its record, its payload an object; FIRED exactly with its firing time,
-- CANCELLED exactly with its time and reason; PENDING → FIRED | CANCELLED, and then it changes no more; what it watches
-- never changes; its rule is a DATE rule. Cancelled, never deleted. One PENDING timer per record and key (the index).
CREATE FUNCTION "factory_due_timer_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed CONSTANT text[] := ARRAY['timerKey', 'ruleId', 'companyId', 'siteId', 'partyId', 'recordType', 'recordId', 'recordLabel', 'dueAt',
                                 'fireAt', 'payload', 'createdAt', 'createdById'];
  rule_trigger text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'timers: timer % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."timerKey" !~ '^[A-Z][A-Z0-9_]*(:[+-]?[0-9]+[mhd])?$' OR btrim(NEW."recordType") = '' OR jsonb_typeof(NEW."payload") <> 'object' THEN
    RAISE EXCEPTION 'timers: timer % names its kind and offset (KIND[:±N(m|h|d)]), its record, and keeps its payload as an object', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'FIRED') <> (NEW."firedAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelReason" IS NOT NULL AND btrim(NEW."cancelReason") <> '') THEN
    RAISE EXCEPTION 'timers: timer % is FIRED exactly with its firing time, CANCELLED exactly with its time and reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NOT "factory_platform_w2a_fixed"(to_jsonb(NEW), to_jsonb(OLD), fixed) THEN
      RAISE EXCEPTION 'timers: timer % keeps what it watches (a moved date is a new timer)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'PENDING' AND to_jsonb(NEW) - 'tenantId' - 'version' - 'updatedAt' IS DISTINCT FROM to_jsonb(OLD) - 'tenantId' - 'version' - 'updatedAt' THEN
      RAISE EXCEPTION 'timers: timer % is %; it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."ruleId" IS NOT NULL THEN
    SELECT r."trigger"::text INTO rule_trigger FROM "AlertRule" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."ruleId";
    IF FOUND AND rule_trigger <> 'DATE' THEN
      RAISE EXCEPTION 'timers: timer % is asked for by a DATE rule', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "DueTimer_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DueTimer"
  FOR EACH ROW EXECUTE FUNCTION "factory_due_timer_guard"();
CREATE TRIGGER "DueTimer_no_truncate" BEFORE TRUNCATE ON "DueTimer"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_platform_w2a_truncate"();

CREATE UNIQUE INDEX "DueTimer_one_pending" ON "DueTimer" ("tenantId", "recordType", "recordId", "timerKey") WHERE "status" = 'PENDING';

-- =====================================================================================================================
-- Reasons (reasons.prisma)

-- ReasonCode: a code without spaces and its words in Italian and English, never blank; other languages as an object of
-- words keyed by ISO 639 code; an icon id and a "#RRGGBB" colour, or none; its list and code never change; set
-- inactive, never deleted.
CREATE FUNCTION "factory_reason_code_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reasons: reason % is set inactive, never deleted (records keep its code)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."code" !~ '^\S+$' OR btrim(NEW."labelIt") = '' OR btrim(NEW."labelEn") = '' THEN
    RAISE EXCEPTION 'reasons: reason % has a code without spaces and its words in Italian and English', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."labelI18n") <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(NEW."labelI18n") w WHERE w.key !~ '^[a-z]{2,3}$' OR jsonb_typeof(w.value) <> 'string' OR btrim(w.value #>> '{}') = '') THEN
    RAISE EXCEPTION 'reasons: reason % keeps its other languages as words keyed by language code ({ "ro": "…" })', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."icon" !~ '^[a-z][a-z0-9-]*$' OR NEW."colour" !~ '^#[0-9A-Fa-f]{6}$' THEN
    RAISE EXCEPTION 'reasons: reason % names its icon by its id and its colour as #RRGGBB', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."list", NEW."code", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."list", OLD."code", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'reasons: reason % keeps its list and its code (records keep them)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReasonCode_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ReasonCode"
  FOR EACH ROW EXECUTE FUNCTION "factory_reason_code_guard"();
CREATE TRIGGER "ReasonCode_no_truncate" BEFORE TRUNCATE ON "ReasonCode"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_platform_w2a_truncate"();

-- =====================================================================================================================
-- Search (search.prisma)

-- SearchEntry: its record never changes; a title, an area, a view permission (<area>.<…>) and its search text, never
-- blank.
CREATE FUNCTION "factory_search_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF btrim(NEW."recordType") = '' OR btrim(NEW."title") = '' OR btrim(NEW."searchText") = ''
     OR NEW."area" !~ '^[a-z][a-z0-9_-]*$' OR NEW."viewPermission" !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' THEN
    RAISE EXCEPTION 'search: entry % names its record, a title, its area, the permission that sees it and its search text', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."recordType", NEW."recordId", NEW."createdAt") IS DISTINCT FROM (OLD."recordType", OLD."recordId", OLD."createdAt") THEN
    RAISE EXCEPTION 'search: entry % stays the entry of its record', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SearchEntry_guard" BEFORE INSERT OR UPDATE ON "SearchEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_search_entry_guard"();

-- =====================================================================================================================
-- Operations (ops.prisma)

-- RestoreDrill: where it was restored, its request; its checks a non-empty list of { key, match } (checksums, never
-- totals); PASSED only when every check matches; a duration of 0 minutes or more; its evidence a file of this drill.
CREATE FUNCTION "factory_restore_drill_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  file record;
BEGIN
  IF btrim(NEW."environment") = '' OR btrim(NEW."requestId") = '' OR NEW."durationMinutes" < 0 THEN
    RAISE EXCEPTION 'drills: drill % says where it was restored, keeps its request and took 0 minutes or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."checks") <> 'array' OR jsonb_array_length(NEW."checks") = 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."checks") c
                 WHERE jsonb_typeof(c) <> 'object' OR jsonb_typeof(c -> 'key') IS DISTINCT FROM 'string' OR btrim(c ->> 'key') = ''
                    OR jsonb_typeof(c -> 'match') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'drills: drill % lists its checks, each { key, match } with the checksums compared', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."result" = 'PASSED' AND EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."checks") c WHERE (c ->> 'match')::boolean IS NOT TRUE) THEN
    RAISE EXCEPTION 'drills: drill % passed only if every check matches', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."evidenceFileId" IS NOT NULL THEN
    SELECT f."recordType", f."recordId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."evidenceFileId";
    IF FOUND AND (file."recordType" <> 'RestoreDrill' OR file."recordId" <> NEW."id") THEN
      RAISE EXCEPTION 'drills: the evidence of drill % is a file of that drill', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RestoreDrill_check" BEFORE INSERT ON "RestoreDrill"
  FOR EACH ROW EXECUTE FUNCTION "factory_restore_drill_check"();

-- =====================================================================================================================
-- W0/W1 tables

-- Site.floorLocales: one or more ISO 639 codes, lower case, no repeats.
CREATE FUNCTION "factory_site_floor_locales_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."floorLocales" IS NULL OR cardinality(NEW."floorLocales") = 0
     OR EXISTS (SELECT 1 FROM unnest(NEW."floorLocales") l WHERE l IS NULL OR l !~ '^[a-z]{2,3}$')
     OR (SELECT count(DISTINCT l) FROM unnest(NEW."floorLocales") l) <> cardinality(NEW."floorLocales") THEN
    RAISE EXCEPTION 'sites: site % lists its floor languages: one or more ISO 639 codes, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Site_floor_locales_check" BEFORE INSERT OR UPDATE ON "Site"
  FOR EACH ROW EXECUTE FUNCTION "factory_site_floor_locales_check"();

-- Device state (B-W2a-42): the battery 0-100 %, the queue 0 or more, and the time of the report whenever any of them is set.
CREATE FUNCTION "factory_device_state_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."batteryPercent" < 0 OR NEW."batteryPercent" > 100 OR NEW."queuedActions" < 0
     OR (num_nonnulls(NEW."batteryPercent", NEW."batteryCharging", NEW."queuedActions") > 0 AND NEW."statusReportedAt" IS NULL) THEN
    RAISE EXCEPTION 'devices: device % reports its battery (0-100 %%) and its queue (0 or more) with the time it reported them', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Device_state_check" BEFORE INSERT OR UPDATE ON "Device"
  FOR EACH ROW EXECUTE FUNCTION "factory_device_state_check"();

-- StoredFile: factory_stored_file_guard of …_files_guards, redefined whole, with the virus scan (PLT-245, B-W2a-42):
--   every row  a verdict (CLEAN, INFECTED, FAILED) has its time and its scanner, and only a verdict has them; INFECTED
--              and FAILED say what (the signature, why it could not scan), nothing else does; an INFECTED file is never
--              AVAILABLE.
--   INSERT     a file is born NOT_SCANNED (the scan starts when the upload is confirmed).
--   UPDATE     the scan moves NOT_SCANNED → PENDING → CLEAN | INFECTED | FAILED and CLEAN | FAILED → PENDING (a rescan);
--              INFECTED is final. A file becomes AVAILABLE only NOT_SCANNED or CLEAN. Two moves join the status
--              machine: QUARANTINED → AVAILABLE when the file waited for its scan (reason `scan_pending`) and the scan
--              came back CLEAN; AVAILABLE → QUARANTINED when a scan finds it INFECTED. A DELETED file's scan changes no
--              more either.
CREATE OR REPLACE FUNCTION "factory_stored_file_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'files: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'files: file % is never deleted; it keeps its row in status DELETED', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."visibility" IS NULL OR NOT ('OFFICE' = ANY (NEW."visibility")) THEN
    RAISE EXCEPTION 'files: file % must be visible to the office', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF ('FLOOR' = ANY (NEW."visibility")) <> (NEW."floorSiteId" IS NOT NULL) THEN
    RAISE EXCEPTION 'files: file % names a floor site exactly when it is shared with the floor', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."floorSiteId" IS NOT NULL AND NEW."companyId" IS NULL THEN
    RAISE EXCEPTION 'files: file % is shared with a floor, so it belongs to that site''s company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF ('PARTNER' = ANY (NEW."visibility") OR 'LINK' = ANY (NEW."visibility")) <> (NEW."partyId" IS NOT NULL) THEN
    RAISE EXCEPTION 'files: file % names a party exactly when it is shared with a portal or a link', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'FISCAL_ARCHIVE') <> (NEW."storageKey" LIKE 'legal/%') THEN
    RAISE EXCEPTION 'files: file % is in the legal store exactly when it is a fiscal archive file', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'FISCAL_ARCHIVE' AND NEW."retainUntil" IS NULL THEN
    RAISE EXCEPTION 'files: fiscal archive file % needs its retention date', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sizeBytes" < 1 THEN
    RAISE EXCEPTION 'files: file % has no content', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'AVAILABLE' AND NEW."availableAt" IS NULL)
     OR (NEW."status" = 'QUARANTINED' AND NEW."quarantineReason" IS NULL)
     OR ((NEW."status" = 'DELETED') <> (NEW."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'files: file % is % without its time or reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."scanStatus" IN ('CLEAN', 'INFECTED', 'FAILED')) <> (NEW."scannedAt" IS NOT NULL)
     OR (NEW."scanStatus" IN ('CLEAN', 'INFECTED', 'FAILED')) <> (NEW."scanEngine" IS NOT NULL AND btrim(NEW."scanEngine") <> '')
     OR (NEW."scanStatus" IN ('INFECTED', 'FAILED')) <> (NEW."scanFinding" IS NOT NULL AND btrim(NEW."scanFinding") <> '') THEN
    RAISE EXCEPTION 'files: the scan of file % (%) has its time and scanner exactly with a verdict, and says what it found exactly when INFECTED or FAILED', NEW."id", NEW."scanStatus"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'AVAILABLE' AND NEW."scanStatus" = 'INFECTED' THEN
    RAISE EXCEPTION 'files: file % is infected; it is never available', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('PENDING_UPLOAD', 'AVAILABLE') THEN
      RAISE EXCEPTION 'files: a new file is PENDING_UPLOAD or AVAILABLE, not %', NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."scanStatus" <> 'NOT_SCANNED' THEN
      RAISE EXCEPTION 'files: a new file is NOT_SCANNED (its scan starts when the upload is confirmed), not %', NEW."scanStatus"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."companyId", NEW."recordType", NEW."recordId", NEW."kind", NEW."originalName", NEW."contentType",
      NEW."sizeBytes", NEW."sha256", NEW."storeAccountId", NEW."storageKey", NEW."createdAt", NEW."createdById")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."recordType", OLD."recordId", OLD."kind", OLD."originalName", OLD."contentType",
      OLD."sizeBytes", OLD."sha256", OLD."storeAccountId", OLD."storageKey", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'files: the content of file % never changes; a new version is a new file', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'DELETED'
     AND (NEW."status", NEW."visibility", NEW."floorSiteId", NEW."partyId", NEW."retainUntil", NEW."legalHold",
          NEW."quarantineReason", NEW."availableAt", NEW."deletedAt", NEW."scanStatus", NEW."scannedAt", NEW."scanEngine", NEW."scanFinding")
         IS DISTINCT FROM
         (OLD."status", OLD."visibility", OLD."floorSiteId", OLD."partyId", OLD."retainUntil", OLD."legalHold",
          OLD."quarantineReason", OLD."availableAt", OLD."deletedAt", OLD."scanStatus", OLD."scannedAt", OLD."scanEngine", OLD."scanFinding") THEN
    RAISE EXCEPTION 'files: file % is deleted; it changes no more', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."scanStatus" <> OLD."scanStatus"
     AND NOT ((OLD."scanStatus" = 'NOT_SCANNED' AND NEW."scanStatus" = 'PENDING')
              OR (OLD."scanStatus" = 'PENDING' AND NEW."scanStatus" IN ('CLEAN', 'INFECTED', 'FAILED'))
              OR (OLD."scanStatus" IN ('CLEAN', 'FAILED') AND NEW."scanStatus" = 'PENDING')) THEN
    RAISE EXCEPTION 'files: the scan of file % cannot move from % to %', OLD."id", OLD."scanStatus", NEW."scanStatus"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status"
     AND NOT ((OLD."status" = 'PENDING_UPLOAD' AND NEW."status" IN ('AVAILABLE', 'QUARANTINED', 'DELETED'))
              OR (OLD."status" IN ('AVAILABLE', 'QUARANTINED') AND NEW."status" = 'DELETED')
              OR (OLD."status" = 'QUARANTINED' AND NEW."status" = 'AVAILABLE' AND OLD."quarantineReason" = 'scan_pending'
                  AND OLD."scanStatus" = 'PENDING' AND NEW."scanStatus" = 'CLEAN')
              OR (OLD."status" = 'AVAILABLE' AND NEW."status" = 'QUARANTINED' AND NEW."scanStatus" = 'INFECTED')) THEN
    RAISE EXCEPTION 'files: file % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'AVAILABLE' AND OLD."status" <> 'AVAILABLE' AND NEW."scanStatus" NOT IN ('NOT_SCANNED', 'CLEAN') THEN
    RAISE EXCEPTION 'files: file % becomes available only unscanned (no scanner) or clean, not %', OLD."id", NEW."scanStatus"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'DELETED' AND OLD."status" <> 'DELETED'
     AND (NEW."legalHold" OR (NEW."retainUntil" IS NOT NULL AND NEW."retainUntil" > now())) THEN
    RAISE EXCEPTION 'files: file % is retained (legal hold or retention date); it cannot be deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."retainUntil" IS NOT NULL AND (NEW."retainUntil" IS NULL OR NEW."retainUntil" < OLD."retainUntil") THEN
    RAISE EXCEPTION 'files: the retention date of file % only moves later', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Today's actions: the three functions of …_insights_attention_actions_guards, redefined whole, with the snooze (W2a):
--   AttentionAction     a snooze is the condition, who and when (all or none), and until a later time or until the
--                       condition changes; at commit it is in the history.
--   AttentionActionLog  SNOOZED names no assignee and carries no note; only SNOOZED carries an until-time, and it is later
--                       than the row's time.
CREATE OR REPLACE FUNCTION "factory_attention_log_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  action record;
BEGIN
  IF btrim(NEW."rowKey") = '' OR btrim(NEW."recordType") = '' OR btrim(NEW."recordLabel") = '' OR btrim(NEW."condition") = '' OR btrim(NEW."requestId") = '' THEN
    RAISE EXCEPTION 'insights: history row % keeps the row key, the record and its label, the condition and the request', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- The action is the reference's (an action this login cannot see is another tenant's: the policies refuse the row).
  SELECT a."rowKey", a."kind", a."recordType", a."recordId" INTO action FROM "AttentionAction" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."actionId";
  IF FOUND AND (action."rowKey" <> NEW."rowKey" OR action."kind" <> NEW."kind" OR action."recordType" <> NEW."recordType" OR action."recordId" <> NEW."recordId") THEN
    RAISE EXCEPTION 'insights: history row % names its action''s row key, kind and record', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."snoozedUntil" IS NOT NULL AND (NEW."verb" <> 'SNOOZED' OR NEW."snoozedUntil" <= NEW."at") THEN
    RAISE EXCEPTION 'insights: only a snooze (%) carries an until-time, later than when it was done', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."verb" = 'RESOLVED' THEN
    IF NEW."note" IS NULL OR btrim(NEW."note") = '' OR NEW."assigneeId" IS NOT NULL THEN
      RAISE EXCEPTION 'insights: a resolution (%) keeps a note saying what was done, and names no assignee', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."verb" IN ('ASSIGNED', 'UNASSIGNED') THEN
    IF NEW."assigneeId" IS NULL OR NEW."note" IS NOT NULL THEN
      RAISE EXCEPTION 'insights: an assignment (%) names its person and carries no note', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."verb" = 'SNOOZED' THEN
    IF NEW."assigneeId" IS NOT NULL OR NEW."note" IS NOT NULL THEN
      RAISE EXCEPTION 'insights: a snooze (%) names no assignee and carries no note', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."assigneeId" IS NOT NULL OR NEW."note" IS NOT NULL THEN
    RAISE EXCEPTION 'insights: an acknowledgement (%) names no assignee and carries no note', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "factory_attention_action_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed CONSTANT text[] := ARRAY['rowKey', 'kind', 'recordType', 'recordId', 'subKey', 'createdAt', 'createdById'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'insights: Today action % is never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY (fixed))
       IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY (fixed)) THEN
      RAISE EXCEPTION 'insights: Today action % keeps its row key, kind and record', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."kind" !~ '^[A-Z][A-Z_]*$' OR btrim(NEW."recordType") = ''
       OR NOT starts_with(NEW."rowKey", NEW."kind" || ':' || NEW."recordId"::text) THEN
      RAISE EXCEPTION 'insights: Today action % is keyed <kind>:<record id>[:<sub key>] by its own kind and record', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF num_nulls(NEW."assignedToId", NEW."assignedById", NEW."assignedAt") NOT IN (0, 3) THEN
    RAISE EXCEPTION 'insights: Today action % is assigned to a person, by someone, at a time, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nulls(NEW."resolvedCondition", NEW."resolveNote", NEW."resolvedById", NEW."resolvedAt") NOT IN (0, 4)
     OR btrim(coalesce(NEW."resolvedCondition", 'x')) = '' THEN
    RAISE EXCEPTION 'insights: Today action % is resolved in a condition, with a note, by someone, at a time, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."resolveNote" IS NOT NULL AND btrim(NEW."resolveNote") = '' THEN
    RAISE EXCEPTION 'insights: Today action % is resolved with a note saying what was done', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nulls(NEW."acknowledgedCondition", NEW."acknowledgedById", NEW."acknowledgedAt") NOT IN (0, 3)
     OR btrim(coalesce(NEW."acknowledgedCondition", 'x')) = '' THEN
    RAISE EXCEPTION 'insights: Today action % is acknowledged in a condition, by someone, at a time, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nulls(NEW."snoozedCondition", NEW."snoozedById", NEW."snoozedAt") NOT IN (0, 3)
     OR btrim(coalesce(NEW."snoozedCondition", 'x')) = ''
     OR (NEW."snoozedUntil" IS NOT NULL AND (NEW."snoozedAt" IS NULL OR NEW."snoozedUntil" <= NEW."snoozedAt")) THEN
    RAISE EXCEPTION 'insights: Today action % is snoozed in a condition, by someone, at a time, until a later time or until the condition changes, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "factory_attention_action_logged"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."assignedToId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."assignedToId" IS DISTINCT FROM OLD."assignedToId" OR NEW."assignedAt" IS DISTINCT FROM OLD."assignedAt")
     AND NOT EXISTS (
       SELECT 1 FROM "AttentionActionLog" l
        WHERE l."tenantId" = NEW."tenantId" AND l."actionId" = NEW."id" AND l."verb" = 'ASSIGNED'
          AND l."assigneeId" = NEW."assignedToId" AND l."actorId" = NEW."assignedById" AND l."at" = NEW."assignedAt") THEN
    RAISE EXCEPTION 'insights: the assignment of Today action % is not in its history', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."resolvedAt" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt" OR NEW."resolvedCondition" IS DISTINCT FROM OLD."resolvedCondition")
     AND NOT EXISTS (
       SELECT 1 FROM "AttentionActionLog" l
        WHERE l."tenantId" = NEW."tenantId" AND l."actionId" = NEW."id" AND l."verb" = 'RESOLVED' AND l."condition" = NEW."resolvedCondition"
          AND l."note" = NEW."resolveNote" AND l."actorId" = NEW."resolvedById" AND l."at" = NEW."resolvedAt") THEN
    RAISE EXCEPTION 'insights: the resolution of Today action % is not in its history with its note', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."acknowledgedAt" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."acknowledgedAt" IS DISTINCT FROM OLD."acknowledgedAt" OR NEW."acknowledgedCondition" IS DISTINCT FROM OLD."acknowledgedCondition")
     AND NOT EXISTS (
       SELECT 1 FROM "AttentionActionLog" l
        WHERE l."tenantId" = NEW."tenantId" AND l."actionId" = NEW."id" AND l."verb" = 'ACKNOWLEDGED' AND l."condition" = NEW."acknowledgedCondition"
          AND l."actorId" = NEW."acknowledgedById" AND l."at" = NEW."acknowledgedAt") THEN
    RAISE EXCEPTION 'insights: the acknowledgement of Today action % is not in its history', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."snoozedAt" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."snoozedAt" IS DISTINCT FROM OLD."snoozedAt" OR NEW."snoozedCondition" IS DISTINCT FROM OLD."snoozedCondition"
          OR NEW."snoozedUntil" IS DISTINCT FROM OLD."snoozedUntil")
     AND NOT EXISTS (
       SELECT 1 FROM "AttentionActionLog" l
        WHERE l."tenantId" = NEW."tenantId" AND l."actionId" = NEW."id" AND l."verb" = 'SNOOZED' AND l."condition" = NEW."snoozedCondition"
          AND l."actorId" = NEW."snoozedById" AND l."at" = NEW."snoozedAt" AND l."snoozedUntil" IS NOT DISTINCT FROM NEW."snoozedUntil") THEN
    RAISE EXCEPTION 'insights: the snooze of Today action % is not in its history', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
