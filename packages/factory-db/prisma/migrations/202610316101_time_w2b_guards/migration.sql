-- Written by hand (Prisma does not model triggers or partial indexes), after the generated 202610315000_time_w2b_schema
-- and before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp,
-- and keep it OUT of prisma/migrations while `npm run migration` runs (it needs the new tables).

-- The time and attendance schema of W2b (wave 5/7): the rules of its tables for every login, the owner included. The
-- API answers first, in words (B-W2b-32 shifts and overtime requests, B-W2b-33 clock in and out, B-W2b-37 attendance
-- days, B-W2b-42 overtime, timesheets and limits, B-W2b-48 month close and the LUL calendar); these are the last word.
-- Every refusal is a check_violation (SQLSTATE 23514).
--
--   append-only    ClockEvent and AttendanceCorrection: UPDATE, DELETE and TRUNCATE refused
--                  (scripts/factory/check-append-only.mjs); a mistaken clock event is voided by a VOID event, a closed
--                  day's figure changed by a new correction.
--   closed month   a company's month closed (AttendanceMonthClose CLOSED) is never written into again: a clock event, an
--                  attendance day, an anomaly, an absence, an overtime entry, a roster cell or a timesheet dated in it is
--                  refused; its days change only by corrections.
--   never deleted  OvertimeRequest, AttendanceDay, AttendanceAnomaly, AbsenceCode, TimesheetApproval, WorkingTimeRule,
--                  a CLOSED month close: DELETE and TRUNCATE refused. A roster cell, an absence, a pending overtime entry,
--                  a pending answer to an ask and an OPEN month close are deleted while their month is open; TRUNCATE
--                  refused everywhere.
--   the floor      a tablet (factory_floor_runtime) records clock events of the floor's own sources only, and on an ask
--                  only the worker's own answer (FLOOR); the policies keep it to its site.
--
-- The tenant (and site) of a row are held by the policies (USING and WITH CHECK) and by the references, not here: the
-- triggers leave "tenantId" and "siteId" to them, so a row moved to another tenant or site is refused by row-level
-- security. A rule that reads another row skips a row this session cannot see (another tenant's). A trigger reads only
-- tables the role that fires it may read (the floor reads the month closes and the sites; the office everything here),
-- and serialises with transaction advisory locks (the floor may not lock the rows it reads). "Everything but these
-- columns" is compared as jsonb (to_jsonb(row) minus the named keys), so a column added later is frozen too unless a
-- later migration names it.
--
-- The person: "employeeId" names an Employee of the People schema (B-W2b-06), which has no table on main while this
-- step builds; the merge after it adds the foreign keys. Until then the triggers do not check that the person exists
-- or belongs to the row's company.
--
-- Locks (pg_advisory_xact_lock, held to the end of the transaction): a company's month ('factory.time.month', tenant,
-- company, year and month) is taken EXCLUSIVELY by its close and SHARED by every write the close refuses, so a close
-- waits for the writes in flight and no write slips into a month being closed; a day ('factory.time.day') by its
-- approval and by an anomaly raised or resolved on it; a request ('factory.time.overtime-request') by its moves and its
-- answers; a corrected day ('factory.time.correction') by each of its corrections.

-- =====================================================================================================================
-- Shared
-- =====================================================================================================================

CREATE FUNCTION "factory_time_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'attendance: TRUNCATE on "%" is refused; its rows are never removed that way', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_time_refuse_append_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; time and attendance keeps it as it was written (a clock event is voided by a VOID event, a closed day is corrected by a new correction)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- The first day of the month of a day.
CREATE FUNCTION "factory_time_month_of"(on_day date) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT make_date(extract(year FROM on_day)::int, extract(month FROM on_day)::int, 1)
$$;

-- The advisory key of a company's month.
CREATE FUNCTION "factory_time_month_key"(tenant uuid, company uuid, on_day date) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended(concat_ws('|', 'factory.time.month', tenant, company, extract(year FROM on_day)::int * 100 + extract(month FROM on_day)::int), 0)
$$;

-- An exclusive transaction lock on one record of a kind.
CREATE FUNCTION "factory_time_lock"(what text, tenant uuid, id uuid) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', what, tenant, id), 0))
$$;

-- The day of an instant at a site: in the site's time zone (Europe/Rome when this session cannot see the site).
CREATE FUNCTION "factory_time_site_day"(site uuid, at timestamptz) RETURNS date LANGUAGE plpgsql STABLE AS $$
DECLARE
  zone text;
BEGIN
  SELECT s."timezone" INTO zone FROM "Site" s WHERE s."id" = site;
  RETURN (at AT TIME ZONE COALESCE(zone, 'Europe/Rome'))::date;
END
$$;

-- Refuses a write dated `day` in a CLOSED month of the company (`what` names the record in the message). Takes the
-- month's key SHARED, to the end of the transaction. A month close this session cannot see refuses nothing (row-level
-- security refuses the row itself).
CREATE FUNCTION "factory_time_refuse_closed"(tenant uuid, company uuid, on_day date, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF tenant IS NULL OR company IS NULL OR on_day IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock_shared("factory_time_month_key"(tenant, company, on_day));
  IF EXISTS (SELECT 1 FROM "AttendanceMonthClose" c
              WHERE c."tenantId" = tenant AND c."companyId" = company AND c."month" = "factory_time_month_of"(on_day)
                AND c."status" = 'CLOSED') THEN
    RAISE EXCEPTION 'attendance: % is dated %, in a closed month of its company (its LUL calendar is out); a closed day changes only by a correction', what, on_day
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- A window of minutes from a date's midnight: it starts in its day and lasts 1 minute to 24 hours.
CREATE FUNCTION "factory_time_window_ok"(start_minute int, end_minute int) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT start_minute IS NOT NULL AND end_minute IS NOT NULL AND start_minute BETWEEN 0 AND 1439
     AND end_minute > start_minute AND end_minute <= start_minute + 1440
$$;

-- =====================================================================================================================
-- RosterEntry (MES-218; design people.shifts "Roster")
-- =====================================================================================================================

-- RosterEntry
--   every row  WORK: a window starting in its day, 1 minute to 24 hours long, its break 0 or more and shorter than it,
--              a non-blank name when set, a pattern (written or changed to) ACTIVE and tenant-wide or of its company;
--              OFF: no pattern, name, window or break. PUBLISHED exactly with when and by whom.
--   UPDATE     an UPDATE that changes nothing passes; the company, the person, the date and the creation never change.
--   closed     nothing written, changed or removed in a closed month of its company.
--   DELETE     allowed while its month is open (the cell goes back to the default shift). TRUNCATE refused.
CREATE FUNCTION "factory_roster_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pattern_state text;
  pattern_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "factory_time_refuse_closed"(OLD."tenantId", OLD."companyId", OLD."date", format('roster cell %s', OLD."id"));
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."employeeId", NEW."date", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."employeeId", OLD."date", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'roster: the company, person, date and creation of roster cell % never change (another day is another cell)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM "factory_time_refuse_closed"(NEW."tenantId", NEW."companyId", NEW."date", format('roster cell %s', NEW."id"));

  IF NEW."kind" = 'WORK' THEN
    IF NOT "factory_time_window_ok"(NEW."startMinute", NEW."endMinute") THEN
      RAISE EXCEPTION 'roster: the shift of cell % has its window: it starts in its day (0-1439 minutes from midnight) and lasts 1 minute to 24 hours', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."breakMinutes" < 0 OR NEW."breakMinutes" >= NEW."endMinute" - NEW."startMinute" THEN
      RAISE EXCEPTION 'roster: the break of cell % is 0 or more minutes and shorter than its shift', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF btrim(NEW."shiftLabel") = '' THEN
      RAISE EXCEPTION 'roster: the shift of cell % has a name, or none', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."shiftPatternId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."shiftPatternId" IS DISTINCT FROM OLD."shiftPatternId") THEN
      SELECT p."status"::text, p."companyId" INTO pattern_state, pattern_company FROM "ShiftPattern" p WHERE p."id" = NEW."shiftPatternId";
      IF FOUND AND (pattern_state <> 'ACTIVE' OR (pattern_company IS NOT NULL AND pattern_company <> NEW."companyId")) THEN
        RAISE EXCEPTION 'roster: cell % takes its shift from an ACTIVE pattern, tenant-wide or of its company', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."shiftPatternId" IS NOT NULL OR NEW."shiftLabel" IS NOT NULL OR NEW."startMinute" IS NOT NULL OR NEW."endMinute" IS NOT NULL
        OR NEW."breakMinutes" <> 0 THEN
    RAISE EXCEPTION 'roster: cell % is a day off: no shift, window or break', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'PUBLISHED') <> (NEW."publishedAt" IS NOT NULL)
     OR (NEW."publishedAt" IS NULL) <> (NEW."publishedById" IS NULL) THEN
    RAISE EXCEPTION 'roster: cell % is % with the wrong publication (a PUBLISHED cell has when and by whom it was published, a DRAFT one neither)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RosterEntry_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RosterEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_roster_entry_guard"();
CREATE TRIGGER "RosterEntry_no_truncate" BEFORE TRUNCATE ON "RosterEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_time_refuse_truncate"();

-- =====================================================================================================================
-- OvertimeRequest and OvertimeAgreement (MES-222; design people.shifts "Overtime requests"; D.Lgs. 66/2003 art. 5)
-- =====================================================================================================================

-- OvertimeRequest
--   INSERT     DRAFT: nothing asked, approved, done or cancelled.
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change; what it asks (date,
--              start, minutes, line, reason) changes only while DRAFT; once asked, when and by whom stays. DRAFT → ASKED
--              | CANCELLED; ASKED → AGREED | CANCELLED; AGREED → APPROVED | ASKED (more people asked) | CANCELLED;
--              APPROVED → DONE | CANCELLED; DONE and CANCELLED are final. → AGREED and → APPROVED need an AGREED answer
--              (the request's lock: its answers and its moves take turns).
--   every row  minutes 1-720; the start 0-1439 when set; a non-blank reason; asked (when, who) from ASKED to DONE (a
--              cancelled one keeps it, or none); approved exactly APPROVED | DONE (a cancelled one keeps it, or none);
--              done exactly DONE; cancelled (when, a non-blank reason) exactly CANCELLED.
--   DELETE     refused (cancelled instead). TRUNCATE refused.
CREATE FUNCTION "factory_overtime_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  agreed int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'overtime: request % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'overtime: request % starts as a DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'overtime: the company and creation of request % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND (NEW."date", NEW."startMinute", NEW."minutes", NEW."lineId", NEW."reason") IS DISTINCT FROM (OLD."date", OLD."startMinute", OLD."minutes", OLD."lineId", OLD."reason") THEN
      RAISE EXCEPTION 'overtime: request % was asked; what it asks (date, time, minutes, line, reason) no longer changes (cancel it and ask again)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."askedAt" IS NOT NULL AND (NEW."askedAt", NEW."askedById") IS DISTINCT FROM (OLD."askedAt", OLD."askedById") THEN
      RAISE EXCEPTION 'overtime: request % keeps when and by whom it was first asked', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('DONE', 'CANCELLED') THEN
      RAISE EXCEPTION 'overtime: request % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'DRAFT' AND NEW."status" IN ('ASKED', 'CANCELLED'))
      OR (OLD."status" = 'ASKED' AND NEW."status" IN ('AGREED', 'CANCELLED'))
      OR (OLD."status" = 'AGREED' AND NEW."status" IN ('APPROVED', 'ASKED', 'CANCELLED'))
      OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('DONE', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'overtime: request % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NEW."status" IN ('AGREED', 'APPROVED') THEN
      PERFORM "factory_time_lock"('factory.time.overtime-request', NEW."tenantId", NEW."id");
      SELECT count(*) INTO agreed FROM "OvertimeAgreement" g WHERE g."requestId" = NEW."id" AND g."answer" = 'AGREED';
      IF agreed = 0 THEN
        RAISE EXCEPTION 'overtime: request % is % only once somebody agreed to it (D.Lgs. 66/2003 art. 5: overtime by agreement)', NEW."id", NEW."status"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."minutes" NOT BETWEEN 1 AND 720 OR (NEW."startMinute" IS NOT NULL AND NEW."startMinute" NOT BETWEEN 0 AND 1439)
     OR btrim(NEW."reason") = '' THEN
    RAISE EXCEPTION 'overtime: request % asks 1 to 720 minutes, starts in its day when a time is set, and says why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."askedAt" IS NULL) <> (NEW."askedById" IS NULL)
     OR (NEW."status" = 'DRAFT' AND NEW."askedAt" IS NOT NULL)
     OR (NEW."status" IN ('ASKED', 'AGREED', 'APPROVED', 'DONE') AND NEW."askedAt" IS NULL) THEN
    RAISE EXCEPTION 'overtime: request % is % with the wrong ask (when and by whom it was asked, from ASKED on)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL)
     OR (NEW."status" IN ('DRAFT', 'ASKED', 'AGREED') AND NEW."approvedAt" IS NOT NULL)
     OR (NEW."status" IN ('APPROVED', 'DONE') AND NEW."approvedAt" IS NULL)
     OR (NEW."status" = 'DONE') <> (NEW."doneAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'overtime: request % is % with the wrong approval (when and by whom from APPROVED on; when it was done exactly DONE)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL) OR btrim(NEW."cancelReason") = '' THEN
    RAISE EXCEPTION 'overtime: request % has its cancellation (when and why) exactly when CANCELLED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OvertimeRequest_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OvertimeRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_overtime_request_guard"();
CREATE TRIGGER "OvertimeRequest_no_truncate" BEFORE TRUNCATE ON "OvertimeRequest"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_time_refuse_truncate"();

-- OvertimeAgreement
--   INSERT     PENDING, no answer; its request (when visible) DRAFT, ASKED or AGREED.
--   UPDATE     an UPDATE that changes nothing passes; the request, the person and the creation never change. The
--              answer changes only while its request is ASKED or AGREED (the request's lock); while it is AGREED, its
--              last AGREED answer is not taken back (ask again first). The floor (factory_floor_runtime) records a
--              FLOOR answer and changes nothing else.
--   every row  PENDING: no answer columns; AGREED | DECLINED: when, and the channel: FLOOR with the worker and the tablet
--              (no user), OFFICE with the user who recorded it (no worker, no tablet).
--   DELETE     a PENDING one, while its request is DRAFT, ASKED or AGREED (a person taken off). TRUNCATE refused.
CREATE FUNCTION "factory_overtime_agreement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  answer_columns CONSTANT text[] := ARRAY['tenantId', 'siteId', 'answer', 'answeredAt', 'answeredVia', 'workerId', 'deviceId', 'version', 'updatedAt'];
  request_state text;
  others int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT r."status"::text INTO request_state FROM "OvertimeRequest" r WHERE r."id" = OLD."requestId";
    IF OLD."answer" <> 'PENDING' OR (FOUND AND request_state NOT IN ('DRAFT', 'ASKED', 'AGREED')) THEN
      RAISE EXCEPTION 'overtime: the answer % stays (only a person who has not answered is taken off a request still asked)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."answer" <> 'PENDING' THEN
      RAISE EXCEPTION 'overtime: answer % starts PENDING (the person answers after being asked)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT r."status"::text INTO request_state FROM "OvertimeRequest" r WHERE r."id" = NEW."requestId";
    IF FOUND AND request_state NOT IN ('DRAFT', 'ASKED', 'AGREED') THEN
      RAISE EXCEPTION 'overtime: request % is %; nobody more is asked', NEW."requestId", request_state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."requestId", NEW."employeeId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."requestId", OLD."employeeId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'overtime: the request, person and creation of answer % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime'
       AND ((to_jsonb(NEW) - answer_columns) IS DISTINCT FROM (to_jsonb(OLD) - answer_columns)
            OR (NEW."answer" <> OLD."answer" AND NEW."answeredVia" IS DISTINCT FROM 'FLOOR')) THEN
      RAISE EXCEPTION 'overtime: a tablet records the worker''s own answer (FLOOR) to ask % and nothing else', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."answer", NEW."answeredAt", NEW."answeredVia", NEW."workerId", NEW."deviceId", NEW."answeredById")
       IS DISTINCT FROM
       (OLD."answer", OLD."answeredAt", OLD."answeredVia", OLD."workerId", OLD."deviceId", OLD."answeredById") THEN
      PERFORM "factory_time_lock"('factory.time.overtime-request', NEW."tenantId", NEW."requestId");
      SELECT r."status"::text INTO request_state FROM "OvertimeRequest" r WHERE r."id" = NEW."requestId";
      IF current_user = 'factory_floor_runtime' AND NOT FOUND THEN
        -- The floor sees an ask from ASKED on: a draft one is not answered.
        request_state := 'DRAFT';
      END IF;
      IF request_state IS NOT NULL AND request_state NOT IN ('ASKED', 'AGREED') THEN
        RAISE EXCEPTION 'overtime: request % is %; its answers do not change (they are given while it is asked)', NEW."requestId", request_state
          USING ERRCODE = 'check_violation';
      END IF;
      IF request_state = 'AGREED' AND OLD."answer" = 'AGREED' AND NEW."answer" <> 'AGREED' THEN
        SELECT count(*) INTO others FROM "OvertimeAgreement" g WHERE g."requestId" = NEW."requestId" AND g."answer" = 'AGREED' AND g."id" <> NEW."id";
        IF others = 0 THEN
          RAISE EXCEPTION 'overtime: answer % is the last yes of request %, which is AGREED; ask again first', NEW."id", NEW."requestId"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;

  IF NEW."answer" = 'PENDING' THEN
    IF NEW."answeredAt" IS NOT NULL OR NEW."answeredVia" IS NOT NULL OR NEW."workerId" IS NOT NULL OR NEW."deviceId" IS NOT NULL
       OR NEW."answeredById" IS NOT NULL THEN
      RAISE EXCEPTION 'overtime: answer % is PENDING: nobody answered yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."answeredAt" IS NULL
     OR (NEW."answeredVia" = 'FLOOR' AND (NEW."workerId" IS NULL OR NEW."deviceId" IS NULL OR NEW."answeredById" IS NOT NULL))
     OR (NEW."answeredVia" = 'OFFICE' AND (NEW."answeredById" IS NULL OR NEW."workerId" IS NOT NULL OR NEW."deviceId" IS NOT NULL))
     OR NEW."answeredVia" IS NULL THEN
    RAISE EXCEPTION 'overtime: answer % is % with when and how it came: on a tablet (the worker and the tablet) or recorded in the office (the user)', NEW."id", NEW."answer"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OvertimeAgreement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OvertimeAgreement"
  FOR EACH ROW EXECUTE FUNCTION "factory_overtime_agreement_guard"();
CREATE TRIGGER "OvertimeAgreement_no_truncate" BEFORE TRUNCATE ON "OvertimeAgreement"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_time_refuse_truncate"();

-- =====================================================================================================================
-- ClockEvent (MES-223, MES-224, MES-227, MES-239, MES-199; design floor.clock)
-- =====================================================================================================================

CREATE TRIGGER "ClockEvent_append_only" BEFORE UPDATE OR DELETE ON "ClockEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_time_refuse_append_change"();
CREATE TRIGGER "ClockEvent_no_truncate" BEFORE TRUNCATE ON "ClockEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_time_refuse_append_change"();

-- ClockEvent (INSERT; UPDATE, DELETE and TRUNCATE are refused above)
--   floor      BADGE, NAME_PIN, OFFLINE: IN | OUT | BREAK_OUT | BREAK_IN with the worker, the tablet, the tablet's time
--              and its event id. BADGE and NAME_PIN are sent online: the time that counts is the server's (within 2
--              minutes of receivedAt); OFFLINE is dated by the tablet (occurredAt = deviceTime), never after it was
--              received (2 minutes' grace). NAME_PIN is flagged FORGOT_BADGE, BADGE never. A tablet
--              (factory_floor_runtime) records these three only.
--   office     MANUAL: IN | OUT | BREAK_OUT | BREAK_IN with a reason; AUTO: OUT with the rule in words; VOID: MANUAL,
--              with a reason, voiding an earlier event of the same person that is no VOID, at that event's time (once:
--              the unique index). None of them has a worker, tablet, tablet time, event id or flag, nor is dated after
--              it was received (2 minutes' grace). Only MANUAL IN | OUT is work outside the plant.
--   every row  flags without repeats; not dated in a closed month of its company (the site's day of occurredAt).
CREATE FUNCTION "factory_clock_event_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  floor_source CONSTANT boolean := NEW."source" IN ('BADGE', 'NAME_PIN', 'OFFLINE');
  voided record;
BEGIN
  IF current_user = 'factory_floor_runtime' AND NOT floor_source THEN
    RAISE EXCEPTION 'clock: a tablet records badge, name-and-PIN and offline clock events only, not % (event %)', NEW."source", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."flags") <> (SELECT count(DISTINCT flag) FROM unnest(NEW."flags") AS flag) THEN
    RAISE EXCEPTION 'clock: event % names a flag twice', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'VOID') <> (NEW."voidsEventId" IS NOT NULL) THEN
    RAISE EXCEPTION 'clock: a VOID event names the event it voids, and only a VOID event does (event %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF floor_source THEN
    IF NEW."kind" = 'VOID' OR NEW."workerId" IS NULL OR NEW."deviceId" IS NULL OR NEW."deviceTime" IS NULL
       OR NEW."clientEventId" IS NULL OR btrim(NEW."clientEventId") = '' THEN
      RAISE EXCEPTION 'clock: a % event is a clock-in, clock-out or break with the worker, the tablet, the tablet''s time and its event id (event %)', NEW."source", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."offSite" OR NEW."reason" IS NOT NULL THEN
      RAISE EXCEPTION 'clock: a tablet''s event % carries no reason and is no work outside the plant', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."source" = 'NAME_PIN' AND NOT ('FORGOT_BADGE' = ANY (NEW."flags")) THEN
      RAISE EXCEPTION 'clock: event % was signed by name and PIN: it is flagged FORGOT_BADGE for the team leader', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."source" = 'BADGE' AND 'FORGOT_BADGE' = ANY (NEW."flags") THEN
      RAISE EXCEPTION 'clock: event % was signed with a badge: it is not flagged FORGOT_BADGE', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."source" IN ('BADGE', 'NAME_PIN') AND abs(extract(epoch FROM NEW."occurredAt" - NEW."receivedAt")) > 120 THEN
      RAISE EXCEPTION 'clock: event % was sent online: it counts at the server''s time (%), not %; an event kept on the tablet is OFFLINE', NEW."id", NEW."receivedAt", NEW."occurredAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."source" = 'OFFLINE' AND NEW."occurredAt" <> NEW."deviceTime" THEN
      RAISE EXCEPTION 'clock: offline event % counts at the tablet''s time (%)', NEW."id", NEW."deviceTime"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."workerId" IS NOT NULL OR NEW."deviceId" IS NOT NULL OR NEW."deviceTime" IS NOT NULL OR NEW."clientEventId" IS NOT NULL
       OR cardinality(NEW."flags") > 0 THEN
      RAISE EXCEPTION 'clock: a % event has no worker, tablet, tablet time, event id or flag (event %)', NEW."source", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."reason" IS NULL OR btrim(NEW."reason") = '' THEN
      RAISE EXCEPTION 'clock: a % event says why (event %)', NEW."source", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."source" = 'AUTO' AND NEW."kind" <> 'OUT' THEN
      RAISE EXCEPTION 'clock: the automatic event % is a clock-out, not %', NEW."id", NEW."kind"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'VOID' AND NEW."source" <> 'MANUAL' THEN
      RAISE EXCEPTION 'clock: a VOID event is entered by a person (MANUAL), not % (event %)', NEW."source", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."offSite" AND (NEW."source" <> 'MANUAL' OR NEW."kind" NOT IN ('IN', 'OUT')) THEN
    RAISE EXCEPTION 'clock: only a manual clock-in or clock-out is work outside the plant (event %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."occurredAt" > NEW."receivedAt" + interval '2 minutes' THEN
    RAISE EXCEPTION 'clock: event % is dated % after it was received (%); a clock event is never in the future', NEW."id", NEW."occurredAt", NEW."receivedAt"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."kind" = 'VOID' THEN
    SELECT e."kind"::text AS kind, e."occurredAt" AS voided_at INTO voided FROM "ClockEvent" e WHERE e."id" = NEW."voidsEventId";
    IF FOUND AND (voided.kind = 'VOID' OR NEW."occurredAt" <> voided.voided_at) THEN
      RAISE EXCEPTION 'clock: VOID event % voids a clock-in, clock-out or break (not a VOID), at its time (%)', NEW."id", voided.voided_at
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM "factory_time_refuse_closed"(NEW."tenantId", NEW."companyId", "factory_time_site_day"(NEW."siteId", NEW."occurredAt"), format('clock event %s', NEW."id"));
  RETURN NEW;
END
$$;

CREATE TRIGGER "ClockEvent_check" BEFORE INSERT ON "ClockEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_clock_event_check"();

-- =====================================================================================================================
-- AttendanceDay and AttendanceAnomaly (MES-225, MES-226, MES-238; design people.attendance "Days")
-- =====================================================================================================================

-- AttendanceDay
--   INSERT     OPEN or NEEDS_FIX: not approved, not closed; not in a closed month of its company.
--   UPDATE     an UPDATE that changes nothing passes; the company, the person, the date and the creation never change.
--              OPEN ⇄ NEEDS_FIX; OPEN | NEEDS_FIX → APPROVED (no unresolved anomaly of the day: the day's lock);
--              APPROVED → OPEN | NEEDS_FIX (reopened: the approval cleared); APPROVED → CLOSED (by a month close of its
--              company and month that is OPEN, i.e. being closed; when). An APPROVED day's figures do not change (reopen
--              it first); a CLOSED day never changes (a correction changes its figures). Manual, once marked, stays.
--   every row  each minutes column 0-1440; the planned shift: all four null, or a window starting in its day, 1 minute
--              to 24 hours, its minutes 0 to the window's length, a non-blank name when set; the first clock-in not
--              after the last clock-out; approved (when, who) exactly APPROVED | CLOSED; closed (by, when) exactly
--              CLOSED.
--   closed     nothing written into a closed month of its company (the close itself happens while it is OPEN).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_attendance_day_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  status_columns CONSTANT text[] := ARRAY['tenantId', 'siteId', 'status', 'approvedAt', 'approvedById', 'monthCloseId', 'closedAt', 'version', 'updatedAt'];
  close_state text;
  close_month date;
  open_anomalies int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attendance: day % is kept (it is reopened, fixed or corrected, never deleted)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('OPEN', 'NEEDS_FIX') THEN
      RAISE EXCEPTION 'attendance: day % starts OPEN or NEEDS_FIX, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."employeeId", NEW."date", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."employeeId", OLD."date", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'attendance: the company, person, date and creation of day % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED' THEN
      RAISE EXCEPTION 'attendance: day % is CLOSED (its month is closed); it changes only by a correction', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."manual" AND NOT NEW."manual" THEN
      RAISE EXCEPTION 'attendance: day % was entered or fixed by hand; it stays marked manual', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" IN ('OPEN', 'NEEDS_FIX') AND NEW."status" IN ('OPEN', 'NEEDS_FIX', 'APPROVED'))
      OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('OPEN', 'NEEDS_FIX', 'CLOSED'))) THEN
      RAISE EXCEPTION 'attendance: day % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'APPROVED' AND NEW."status" IN ('APPROVED', 'CLOSED')
       AND (to_jsonb(NEW) - status_columns) IS DISTINCT FROM (to_jsonb(OLD) - status_columns) THEN
      RAISE EXCEPTION 'attendance: day % is APPROVED; its figures change only once it is reopened', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'APPROVED' AND NEW."status" IN ('APPROVED', 'CLOSED')
       AND (NEW."approvedAt", NEW."approvedById") IS DISTINCT FROM (OLD."approvedAt", OLD."approvedById") THEN
      RAISE EXCEPTION 'attendance: day % keeps its approval (reopen it to approve it again)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'APPROVED' AND OLD."status" <> 'APPROVED' THEN
      PERFORM "factory_time_lock"('factory.time.day', NEW."tenantId", NEW."id");
      SELECT count(*) INTO open_anomalies FROM "AttendanceAnomaly" a WHERE a."dayId" = NEW."id" AND a."resolvedAt" IS NULL;
      IF open_anomalies > 0 THEN
        RAISE EXCEPTION 'attendance: day % has % anomal% still open; resolve them before it is approved', NEW."id", open_anomalies, CASE WHEN open_anomalies = 1 THEN 'y' ELSE 'ies' END
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."status" = 'CLOSED' THEN
      SELECT c."status"::text, c."month" INTO close_state, close_month FROM "AttendanceMonthClose" c WHERE c."id" = NEW."monthCloseId";
      IF FOUND AND (close_state <> 'OPEN' OR close_month <> "factory_time_month_of"(NEW."date")) THEN
        RAISE EXCEPTION 'attendance: day % is closed by the close of its own month while that close is being made (OPEN)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  PERFORM "factory_time_refuse_closed"(NEW."tenantId", NEW."companyId", NEW."date", format('attendance day %s', NEW."id"));

  IF NEW."presentMinutes" NOT BETWEEN 0 AND 1440 OR NEW."breakMinutes" NOT BETWEEN 0 AND 1440 OR NEW."ordinaryMinutes" NOT BETWEEN 0 AND 1440
     OR NEW."overtimeMinutes" NOT BETWEEN 0 AND 1440 OR NEW."nightMinutes" NOT BETWEEN 0 AND 1440
     OR NEW."holidayMinutes" NOT BETWEEN 0 AND 1440 OR NEW."absenceMinutes" NOT BETWEEN 0 AND 1440 THEN
    RAISE EXCEPTION 'attendance: each minutes figure of day % is 0 to 1440', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((NEW."plannedLabel" IS NULL AND NEW."plannedStartMinute" IS NULL AND NEW."plannedEndMinute" IS NULL AND NEW."plannedMinutes" IS NULL)
       OR ("factory_time_window_ok"(NEW."plannedStartMinute", NEW."plannedEndMinute")
           AND NEW."plannedMinutes" IS NOT NULL AND NEW."plannedMinutes" BETWEEN 0 AND NEW."plannedEndMinute" - NEW."plannedStartMinute"
           AND (NEW."plannedLabel" IS NULL OR btrim(NEW."plannedLabel") <> ''))) THEN
    RAISE EXCEPTION 'attendance: the planned shift of day % is none, or a window starting in its day (1 minute to 24 hours) with its working minutes', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."firstInAt" > NEW."lastOutAt" THEN
    RAISE EXCEPTION 'attendance: the first clock-in of day % is not after its last clock-out', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('APPROVED', 'CLOSED')) <> (NEW."approvedAt" IS NOT NULL)
     OR (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."monthCloseId" IS NOT NULL)
     OR (NEW."monthCloseId" IS NULL) <> (NEW."closedAt" IS NULL) THEN
    RAISE EXCEPTION 'attendance: day % is % with the wrong approval or close (approved: when and by whom, from APPROVED on; closed: its month close and when, exactly CLOSED)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AttendanceDay_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AttendanceDay"
  FOR EACH ROW EXECUTE FUNCTION "factory_attendance_day_guard"();
CREATE TRIGGER "AttendanceDay_no_truncate" BEFORE TRUNCATE ON "AttendanceDay"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_time_refuse_truncate"();

-- AttendanceAnomaly
--   INSERT     unresolved; its day (when visible) of its company, neither APPROVED nor CLOSED (reopen an approved day
--              first: an approved day has no open anomaly), under the day's lock.
--   UPDATE     an UPDATE that changes nothing passes; everything but the resolution (resolution, resolvedAt,
--              resolvedById, resolutionNote) is fixed; resolved once, under the day's lock; a resolved anomaly never
--              changes.
--   every row  a non-blank rule key; detail a JSON object or none; resolved: resolution exactly with resolvedAt, FIXED and
--              ACCEPTED with the person who resolved it, ACCEPTED with a non-blank note; unresolved: none of them.
--   closed     not raised or resolved in a closed month of its company (the day's date).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_attendance_anomaly_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  resolution_columns CONSTANT text[] := ARRAY['tenantId', 'resolution', 'resolvedAt', 'resolvedById', 'resolutionNote', 'version', 'updatedAt'];
  day_state text;
  day_company uuid;
  day_date date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'anomaly: anomaly % is resolved, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - resolution_columns) IS DISTINCT FROM (to_jsonb(OLD) - resolution_columns) THEN
      RAISE EXCEPTION 'anomaly: what anomaly % found never changes; it is resolved', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."resolvedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'anomaly: anomaly % is resolved (%); it never changes', OLD."id", OLD."resolution"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."resolvedAt" IS NOT NULL OR NEW."resolution" IS NOT NULL THEN
    RAISE EXCEPTION 'anomaly: anomaly % is raised unresolved', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM "factory_time_lock"('factory.time.day', NEW."tenantId", NEW."dayId");
  SELECT d."status"::text, d."companyId", d."date" INTO day_state, day_company, day_date FROM "AttendanceDay" d WHERE d."id" = NEW."dayId";
  IF FOUND THEN
    IF day_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'anomaly: anomaly % is of its day''s company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' AND day_state IN ('APPROVED', 'CLOSED') THEN
      RAISE EXCEPTION 'anomaly: day % is %; reopen it before an anomaly is raised on it', NEW."dayId", day_state
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_time_refuse_closed"(NEW."tenantId", NEW."companyId", day_date, format('anomaly %s', NEW."id"));
  END IF;

  IF btrim(NEW."ruleKey") = '' OR (NEW."detail" IS NOT NULL AND jsonb_typeof(NEW."detail") <> 'object') THEN
    RAISE EXCEPTION 'anomaly: anomaly % names the rule that found it, and its detail is an object of values', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."resolution" IS NULL) <> (NEW."resolvedAt" IS NULL)
     OR (NEW."resolution" IN ('FIXED', 'ACCEPTED') AND NEW."resolvedById" IS NULL)
     OR (NEW."resolution" IS NULL AND (NEW."resolvedById" IS NOT NULL OR NEW."resolutionNote" IS NOT NULL))
     OR (NEW."resolution" = 'ACCEPTED' AND (NEW."resolutionNote" IS NULL OR btrim(NEW."resolutionNote") = ''))
     OR btrim(NEW."resolutionNote") = '' THEN
    RAISE EXCEPTION 'anomaly: anomaly % is resolved with when, how and (FIXED, ACCEPTED) by whom; ACCEPTED with why the day stands', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AttendanceAnomaly_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AttendanceAnomaly"
  FOR EACH ROW EXECUTE FUNCTION "factory_attendance_anomaly_guard"();
CREATE TRIGGER "AttendanceAnomaly_no_truncate" BEFORE TRUNCATE ON "AttendanceAnomaly"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_time_refuse_truncate"();

-- =====================================================================================================================
-- AbsenceCode and AbsenceEntry (MES-228; design people.settings "Absence codes")
-- =====================================================================================================================

-- AbsenceCode
--   every row  labelI18n a JSON object with a non-blank Italian name ("it"); a non-blank LUL code when set.
--   UPDATE     an UPDATE that changes nothing passes; the code, the company and the creation never change.
--   DELETE     refused (archived instead). TRUNCATE refused.
CREATE FUNCTION "factory_absence_code_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'absence: code % is archived, never deleted', OLD."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."code", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."code", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'absence: the code, company and creation of absence code % never change (archive it, make another)', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."code") = '' OR jsonb_typeof(NEW."labelI18n") IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW."labelI18n" -> 'it') IS DISTINCT FROM 'string' OR btrim(NEW."labelI18n" ->> 'it') = ''
     OR btrim(NEW."lulCode") = '' THEN
    RAISE EXCEPTION 'absence: code % has a name in Italian at least ({ "it": … }) and a LUL code or none', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AbsenceCode_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AbsenceCode"
  FOR EACH ROW EXECUTE FUNCTION "factory_absence_code_guard"();
CREATE TRIGGER "AbsenceCode_no_truncate" BEFORE TRUNCATE ON "AbsenceCode"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_time_refuse_truncate"();

-- AbsenceEntry
--   every row  minutes 1-1440; its code (when visible) tenant-wide or of its company, and ACTIVE when the entry is
--              written or moved to it; a non-blank document reference when set.
--   UPDATE     an UPDATE that changes nothing passes; the company, the person, the date and the creation never change.
--   closed     not written, changed or removed in a closed month of its company.
--   DELETE     while its month is open. TRUNCATE refused.
CREATE FUNCTION "factory_absence_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  code_state text;
  code_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "factory_time_refuse_closed"(OLD."tenantId", OLD."companyId", OLD."date", format('absence %s', OLD."id"));
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."employeeId", NEW."date", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."employeeId", OLD."date", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'absence: the company, person, date and creation of absence % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM "factory_time_refuse_closed"(NEW."tenantId", NEW."companyId", NEW."date", format('absence %s', NEW."id"));

  IF NEW."minutes" NOT BETWEEN 1 AND 1440 OR btrim(NEW."documentRef") = '' THEN
    RAISE EXCEPTION 'absence: absence % is 1 to 1440 minutes, with a document reference or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c."status"::text, c."companyId" INTO code_state, code_company FROM "AbsenceCode" c WHERE c."id" = NEW."codeId";
  IF FOUND THEN
    IF code_company IS NOT NULL AND code_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'absence: absence % takes a code of its company or a tenant-wide one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF code_state <> 'ACTIVE' AND (TG_OP = 'INSERT' OR NEW."codeId" <> OLD."codeId") THEN
      RAISE EXCEPTION 'absence: the code of absence % is archived; use an active one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AbsenceEntry_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AbsenceEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_absence_entry_guard"();
CREATE TRIGGER "AbsenceEntry_no_truncate" BEFORE TRUNCATE ON "AbsenceEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_time_refuse_truncate"();

-- =====================================================================================================================
-- OvertimeEntry (MES-229; design people.attendance "Overtime to approve")
-- =====================================================================================================================

-- OvertimeEntry
--   INSERT     PENDING, no decision.
--   UPDATE     an UPDATE that changes nothing passes; the company, the person, the date and the creation never change;
--              the class, the minutes and the request change only while PENDING. PENDING → APPROVED | REJECTED; APPROVED
--              | REJECTED → PENDING (the decision taken back: cleared).
--   every row  minutes 1-1440; a request named (when visible, and written or changed to) is neither DRAFT nor CANCELLED;
--              approved (when, who) exactly APPROVED; rejected (when, who, a non-blank reason) exactly REJECTED.
--   closed     nothing written, changed or removed in a closed month of its company.
--   DELETE     a PENDING one (a recomputation). TRUNCATE refused.
CREATE FUNCTION "factory_overtime_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'overtime: entry % is %; only a pending one is removed (take the decision back first)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_time_refuse_closed"(OLD."tenantId", OLD."companyId", OLD."date", format('overtime entry %s', OLD."id"));
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'overtime: entry % starts PENDING (paid only once approved), not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."employeeId", NEW."date", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."employeeId", OLD."date", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'overtime: the company, person, date and creation of entry % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'PENDING' AND (NEW."kind", NEW."minutes", NEW."requestId") IS DISTINCT FROM (OLD."kind", OLD."minutes", OLD."requestId") THEN
      RAISE EXCEPTION 'overtime: entry % is %; its class, minutes and request change only once the decision is taken back', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'PENDING' AND NEW."status" IN ('APPROVED', 'REJECTED'))
      OR (OLD."status" IN ('APPROVED', 'REJECTED') AND NEW."status" = 'PENDING')) THEN
      RAISE EXCEPTION 'overtime: entry % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM "factory_time_refuse_closed"(NEW."tenantId", NEW."companyId", NEW."date", format('overtime entry %s', NEW."id"));

  IF NEW."minutes" NOT BETWEEN 1 AND 1440 THEN
    RAISE EXCEPTION 'overtime: entry % is 1 to 1440 minutes', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."requestId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."requestId" IS DISTINCT FROM OLD."requestId") THEN
    SELECT r."status"::text INTO request_state FROM "OvertimeRequest" r WHERE r."id" = NEW."requestId";
    IF FOUND AND request_state IN ('DRAFT', 'CANCELLED') THEN
      RAISE EXCEPTION 'overtime: entry % is worked for a request that was asked (not a % one)', NEW."id", request_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."status" = 'APPROVED') <> (NEW."approvedAt" IS NOT NULL)
     OR (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL)
     OR (NEW."status" = 'REJECTED') <> (NEW."rejectedAt" IS NOT NULL)
     OR (NEW."rejectedAt" IS NULL) <> (NEW."rejectedById" IS NULL)
     OR (NEW."rejectedAt" IS NULL) <> (NEW."rejectReason" IS NULL) OR btrim(NEW."rejectReason") = '' THEN
    RAISE EXCEPTION 'overtime: entry % is % with the wrong decision (approved: when and by whom; rejected: when, by whom and why)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OvertimeEntry_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OvertimeEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_overtime_entry_guard"();
CREATE TRIGGER "OvertimeEntry_no_truncate" BEFORE TRUNCATE ON "OvertimeEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_time_refuse_truncate"();

-- =====================================================================================================================
-- TimesheetApproval (MES-230)
-- =====================================================================================================================

-- TimesheetApproval
--   INSERT     PENDING: no approval.
--   UPDATE     an UPDATE that changes nothing passes; the company, the person, the period and the creation never change.
--              PENDING → LEAD_APPROVED (the lead: when, who); LEAD_APPROVED → APPROVED (HR: when, who, another person
--              than the lead); LEAD_APPROVED | APPROVED → PENDING (sent back: a new return, when, who, why; the approvals
--              cleared). The return columns change only by a send-back.
--   every row  the period inside one calendar month (start ≤ end); the lead's approval exactly LEAD_APPROVED |
--              APPROVED, HR's exactly APPROVED, by two different people; returned: when, who and a non-blank reason
--              together, or none.
--   closed     nothing written or changed in a closed month of its company.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_timesheet_approval_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'timesheet: timesheet % is kept (sent back, never deleted)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'timesheet: timesheet % starts PENDING, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."employeeId", NEW."periodStart", NEW."periodEnd", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."employeeId", OLD."periodStart", OLD."periodEnd", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'timesheet: the company, person, period and creation of timesheet % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'PENDING' AND NEW."status" = 'LEAD_APPROVED')
      OR (OLD."status" = 'LEAD_APPROVED' AND NEW."status" IN ('APPROVED', 'PENDING'))
      OR (OLD."status" = 'APPROVED' AND NEW."status" = 'PENDING')) THEN
      RAISE EXCEPTION 'timesheet: timesheet % cannot move from % to % (the lead approves, then HR)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'PENDING' AND NEW."status" = 'PENDING' THEN
      IF NEW."returnedAt" IS NULL OR (OLD."returnedAt" IS NOT NULL AND NEW."returnedAt" <= OLD."returnedAt") THEN
        RAISE EXCEPTION 'timesheet: timesheet % is sent back with when, by whom and why', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF (NEW."returnedAt", NEW."returnedById", NEW."returnReason") IS DISTINCT FROM (OLD."returnedAt", OLD."returnedById", OLD."returnReason") THEN
      RAISE EXCEPTION 'timesheet: the return of timesheet % changes only when it is sent back', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'LEAD_APPROVED' AND NEW."status" = 'APPROVED'
       AND (NEW."leadApprovedAt", NEW."leadApprovedById") IS DISTINCT FROM (OLD."leadApprovedAt", OLD."leadApprovedById") THEN
      RAISE EXCEPTION 'timesheet: HR approves timesheet % as the lead approved it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM "factory_time_refuse_closed"(NEW."tenantId", NEW."companyId", NEW."periodStart", format('timesheet %s', NEW."id"));

  IF NEW."periodEnd" < NEW."periodStart" OR "factory_time_month_of"(NEW."periodStart") <> "factory_time_month_of"(NEW."periodEnd") THEN
    RAISE EXCEPTION 'timesheet: the period of timesheet % lies inside one calendar month (% to %)', NEW."id", NEW."periodStart", NEW."periodEnd"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('LEAD_APPROVED', 'APPROVED')) <> (NEW."leadApprovedAt" IS NOT NULL)
     OR (NEW."leadApprovedAt" IS NULL) <> (NEW."leadApprovedById" IS NULL)
     OR (NEW."status" = 'APPROVED') <> (NEW."hrApprovedAt" IS NOT NULL)
     OR (NEW."hrApprovedAt" IS NULL) <> (NEW."hrApprovedById" IS NULL) THEN
    RAISE EXCEPTION 'timesheet: timesheet % is % with the wrong approvals (the lead''s from LEAD_APPROVED on, HR''s exactly APPROVED; each when and by whom)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."hrApprovedById" = NEW."leadApprovedById" THEN
    RAISE EXCEPTION 'timesheet: timesheet % is approved by two people (the lead, then HR); nobody approves it twice', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."returnedAt" IS NULL) <> (NEW."returnedById" IS NULL) OR (NEW."returnedAt" IS NULL) <> (NEW."returnReason" IS NULL)
     OR btrim(NEW."returnReason") = '' THEN
    RAISE EXCEPTION 'timesheet: timesheet % was sent back with when, by whom and why, or never', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "TimesheetApproval_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TimesheetApproval"
  FOR EACH ROW EXECUTE FUNCTION "factory_timesheet_approval_guard"();
CREATE TRIGGER "TimesheetApproval_no_truncate" BEFORE TRUNCATE ON "TimesheetApproval"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_time_refuse_truncate"();

-- =====================================================================================================================
-- AttendanceMonthClose (MES-231; design people.attendance "Month close"; D.L. 112/2008 art. 39)
-- =====================================================================================================================

-- AttendanceMonthClose
--   INSERT     OPEN: not closed, no LUL calendar.
--   UPDATE     an UPDATE that changes nothing passes; the company, the month and the creation never change. OPEN: the
--              note changes; OPEN → CLOSED (when, who) under the month's key taken EXCLUSIVELY (the writes in flight
--              finish first; none starts until the close commits), only when every attendance day of its company in
--              the month is CLOSED by it, no anomaly of those days is open and no overtime of the company in the month
--              waits for its decision (PENDING). CLOSED is final, but for the LUL calendar: its file and SHA-256 are set
--              once, together: a stored file of this close (recordType "AttendanceMonthClose"), AVAILABLE, with that
--              SHA-256.
--   every row  month is its first day; closed (when, who) exactly CLOSED; the LUL file and its SHA-256 (64 lower-case
--              hex) together, only on a CLOSED close.
--   DELETE     an OPEN one (an abandoned close; a day it closed holds it by its reference). TRUNCATE refused.
CREATE FUNCTION "factory_attendance_month_close_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  first_day date;
  last_day date;
  not_closed int;
  open_anomalies int;
  pending_overtime int;
  file record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'month close: % of % is CLOSED; a closed month is never reopened or deleted', OLD."id", OLD."month"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'month close: % starts OPEN (its days close one by one), not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."month", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."month", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'month close: the company, month and creation of close % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED' THEN
      IF NEW."status" <> 'CLOSED'
         OR (to_jsonb(NEW) - ARRAY['tenantId', 'lulFileId', 'lulSha256', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['tenantId', 'lulFileId', 'lulSha256', 'version', 'updatedAt'])
         OR (OLD."lulFileId" IS NOT NULL AND (NEW."lulFileId", NEW."lulSha256") IS DISTINCT FROM (OLD."lulFileId", OLD."lulSha256")) THEN
        RAISE EXCEPTION 'month close: % of % is CLOSED; it never changes but for its LUL calendar, sealed once', OLD."id", OLD."month"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF OLD."status" = 'OPEN' AND NEW."status" = 'CLOSED' THEN
      PERFORM pg_advisory_xact_lock("factory_time_month_key"(NEW."tenantId", NEW."companyId", NEW."month"));
      first_day := NEW."month";
      last_day := (NEW."month" + interval '1 month' - interval '1 day')::date;
      SELECT count(*) INTO not_closed FROM "AttendanceDay" d
       WHERE d."companyId" = NEW."companyId" AND d."date" BETWEEN first_day AND last_day
         AND (d."status" <> 'CLOSED' OR d."monthCloseId" IS DISTINCT FROM NEW."id");
      IF not_closed > 0 THEN
        RAISE EXCEPTION 'month close: % attendance day(s) of % are not closed by close %; approve and close every day first', not_closed, to_char(first_day, 'YYYY-MM'), NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*) INTO open_anomalies FROM "AttendanceAnomaly" a JOIN "AttendanceDay" d ON d."id" = a."dayId"
       WHERE d."companyId" = NEW."companyId" AND d."date" BETWEEN first_day AND last_day AND a."resolvedAt" IS NULL;
      IF open_anomalies > 0 THEN
        RAISE EXCEPTION 'month close: % anomal% of % still open', open_anomalies, CASE WHEN open_anomalies = 1 THEN 'y is' ELSE 'ies are' END, to_char(first_day, 'YYYY-MM')
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*) INTO pending_overtime FROM "OvertimeEntry" o
       WHERE o."companyId" = NEW."companyId" AND o."date" BETWEEN first_day AND last_day AND o."status" = 'PENDING';
      IF pending_overtime > 0 THEN
        RAISE EXCEPTION 'month close: % overtime entr% of % still wait for approval (overtime is paid only once approved)', pending_overtime, CASE WHEN pending_overtime = 1 THEN 'y' ELSE 'ies' END, to_char(first_day, 'YYYY-MM')
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."status" = 'OPEN' AND NEW."status" = 'OPEN'
          AND (to_jsonb(NEW) - ARRAY['tenantId', 'note', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['tenantId', 'note', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'month close: % is being closed; only its note changes until it is CLOSED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."lulFileId" IS NOT NULL AND OLD."lulFileId" IS NULL THEN
      SELECT f."recordType", f."recordId", f."status"::text AS status, f."sha256" INTO file FROM "StoredFile" f WHERE f."id" = NEW."lulFileId";
      IF FOUND AND (file."recordType" <> 'AttendanceMonthClose' OR file."recordId" <> NEW."id" OR file.status <> 'AVAILABLE' OR file."sha256" <> NEW."lulSha256") THEN
        RAISE EXCEPTION 'month close: the LUL calendar of close % is an AVAILABLE stored file of this close, sealed with its SHA-256', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."month" <> "factory_time_month_of"(NEW."month") THEN
    RAISE EXCEPTION 'month close: % names its month by its first day, not %', NEW."id", NEW."month"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."closedAt" IS NULL) <> (NEW."closedById" IS NULL) THEN
    RAISE EXCEPTION 'month close: % is % with the wrong close (when and by whom, exactly CLOSED)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."lulFileId" IS NULL) <> (NEW."lulSha256" IS NULL) OR NEW."lulSha256" !~ '^[0-9a-f]{64}$'
     OR (NEW."lulFileId" IS NOT NULL AND NEW."status" <> 'CLOSED') THEN
    RAISE EXCEPTION 'month close: the LUL calendar of close % comes with its SHA-256, on a CLOSED month', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AttendanceMonthClose_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AttendanceMonthClose"
  FOR EACH ROW EXECUTE FUNCTION "factory_attendance_month_close_guard"();
CREATE TRIGGER "AttendanceMonthClose_no_truncate" BEFORE TRUNCATE ON "AttendanceMonthClose"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_time_refuse_truncate"();

-- =====================================================================================================================
-- AttendanceCorrection (MES-231; design people.attendance "Correct a closed day")
-- =====================================================================================================================

CREATE TRIGGER "AttendanceCorrection_append_only" BEFORE UPDATE OR DELETE ON "AttendanceCorrection"
  FOR EACH ROW EXECUTE FUNCTION "factory_time_refuse_append_change"();
CREATE TRIGGER "AttendanceCorrection_no_truncate" BEFORE TRUNCATE ON "AttendanceCorrection"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_time_refuse_append_change"();

-- AttendanceCorrection (INSERT; UPDATE, DELETE and TRUNCATE are refused above)
--   every row  a non-blank reason; minutes before and after 0-1440 and different; an absence code exactly for ABSENCE.
--   the day    (when visible) CLOSED, of its company, closed by its month close.
--   the chain  under the corrected day's lock, the minutes before are the figure now: the latest correction's after
--              (same day, kind and code; the latest by creation time, then id), else the closed value: the day's
--              column (PRESENT, ORDINARY, NIGHT, HOLIDAY), the APPROVED overtime of the class that day
--              (OVERTIME_DAY, OVERTIME_NIGHT, OVERTIME_HOLIDAY), or the minutes of the code's absences that day
--              (ABSENCE).
CREATE FUNCTION "factory_attendance_correction_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  corrected record;
  current_minutes int;
BEGIN
  IF NEW."reason" IS NULL OR btrim(NEW."reason") = '' THEN
    RAISE EXCEPTION 'correction: correction % says why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."minutesBefore" NOT BETWEEN 0 AND 1440 OR NEW."minutesAfter" NOT BETWEEN 0 AND 1440 OR NEW."minutesBefore" = NEW."minutesAfter" THEN
    RAISE EXCEPTION 'correction: correction % changes a figure (0 to 1440 minutes before and after, not the same)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'ABSENCE') <> (NEW."absenceCodeId" IS NOT NULL) THEN
    RAISE EXCEPTION 'correction: correction % names an absence code exactly when it corrects an absence', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM "factory_time_lock"('factory.time.correction', NEW."tenantId", NEW."dayId");
  SELECT d.* INTO corrected FROM "AttendanceDay" d WHERE d."id" = NEW."dayId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF corrected."status" <> 'CLOSED' OR corrected."companyId" <> NEW."companyId" OR corrected."monthCloseId" IS DISTINCT FROM NEW."monthCloseId" THEN
    RAISE EXCEPTION 'correction: correction % corrects a CLOSED day of its company, closed by its month close (an open day is fixed, not corrected)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c."minutesAfter" INTO current_minutes FROM "AttendanceCorrection" c
   WHERE c."dayId" = NEW."dayId" AND c."kind" = NEW."kind" AND c."absenceCodeId" IS NOT DISTINCT FROM NEW."absenceCodeId"
   ORDER BY c."createdAt" DESC, c."id" DESC
   LIMIT 1;
  IF NOT FOUND THEN
    current_minutes := CASE NEW."kind"
      WHEN 'PRESENT' THEN corrected."presentMinutes"
      WHEN 'ORDINARY' THEN corrected."ordinaryMinutes"
      WHEN 'NIGHT' THEN corrected."nightMinutes"
      WHEN 'HOLIDAY' THEN corrected."holidayMinutes"
      WHEN 'ABSENCE' THEN (SELECT COALESCE(sum(a."minutes"), 0) FROM "AbsenceEntry" a
                             WHERE a."employeeId" = corrected."employeeId" AND a."date" = corrected."date" AND a."codeId" = NEW."absenceCodeId")
      ELSE (SELECT COALESCE(sum(o."minutes"), 0) FROM "OvertimeEntry" o
             WHERE o."employeeId" = corrected."employeeId" AND o."date" = corrected."date" AND o."status" = 'APPROVED'
               AND o."kind"::text = substr(NEW."kind"::text, length('OVERTIME_') + 1))
    END;
  END IF;
  IF NEW."minutesBefore" <> current_minutes THEN
    RAISE EXCEPTION 'correction: correction % starts from the figure now (% minutes), not % (another correction came first)', NEW."id", current_minutes, NEW."minutesBefore"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AttendanceCorrection_check" BEFORE INSERT ON "AttendanceCorrection"
  FOR EACH ROW EXECUTE FUNCTION "factory_attendance_correction_check"();

-- =====================================================================================================================
-- WorkingTimeRule (MES-232; design people.settings "Working-time limits"; D.Lgs. 66/2003)
-- =====================================================================================================================

-- WorkingTimeRule
--   every row  limit above 0; a break length exactly for BREAK_AFTER (1 minute up to the limit); a reference period
--              (1-12 months) only for WEEKLY_AVERAGE; a site's rule names its company (the reference checks the pair); a
--              non-blank legal reference; alert roles non-blank and without repeats.
--   UPDATE     an UPDATE that changes nothing passes; the company, the site, the kind and the creation never change.
--   ACTIVE     one ACTIVE rule per scope (tenant, company, site) and kind: the partial unique index below.
--   DELETE     refused (archived instead). TRUNCATE refused.
CREATE FUNCTION "factory_working_time_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'working time: rule % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."siteId", NEW."kind", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."siteId", OLD."kind", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'working time: the scope, kind and creation of rule % never change (archive it, make another)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."limitMinutes" <= 0 THEN
    RAISE EXCEPTION 'working time: rule % has a limit above 0 minutes', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'BREAK_AFTER') <> (NEW."breakMinutes" IS NOT NULL) OR NEW."breakMinutes" NOT BETWEEN 1 AND NEW."limitMinutes" THEN
    RAISE EXCEPTION 'working time: a break length belongs to a BREAK_AFTER rule only, 1 minute up to its limit (rule %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."referenceMonths" IS NOT NULL AND (NEW."kind" <> 'WEEKLY_AVERAGE' OR NEW."referenceMonths" NOT BETWEEN 1 AND 12) THEN
    RAISE EXCEPTION 'working time: a reference period (1 to 12 months) belongs to the weekly average only (rule %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."siteId" IS NOT NULL AND NEW."companyId" IS NULL THEN
    RAISE EXCEPTION 'working time: a site''s rule names its company (rule %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."legalReference") = ''
     OR EXISTS (SELECT 1 FROM unnest(NEW."alertRoles") AS role WHERE role IS NULL OR btrim(role) = '')
     OR cardinality(NEW."alertRoles") <> (SELECT count(DISTINCT role) FROM unnest(NEW."alertRoles") AS role) THEN
    RAISE EXCEPTION 'working time: rule % names the law it applies, and whom it alerts once each', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkingTimeRule_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkingTimeRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_working_time_rule_guard"();
CREATE TRIGGER "WorkingTimeRule_no_truncate" BEFORE TRUNCATE ON "WorkingTimeRule"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_time_refuse_truncate"();

CREATE UNIQUE INDEX "WorkingTimeRule_one_active" ON "WorkingTimeRule"
  ("tenantId", (COALESCE("companyId", '00000000-0000-0000-0000-000000000000'::uuid)), (COALESCE("siteId", '00000000-0000-0000-0000-000000000000'::uuid)), "kind")
  WHERE "status" = 'ACTIVE';
