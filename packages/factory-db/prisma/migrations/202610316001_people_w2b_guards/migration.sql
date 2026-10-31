-- Written by hand (Prisma does not model triggers or partial indexes), after the generated 202610316000_people_w2b_schema
-- and before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp,
-- and keep it OUT of prisma/migrations while `npm run migration` runs (it needs the new tables and columns).

-- The people schema (W2b schema wave 4/7, B-W2b-06): the rules of its tables for every login, the owner included. The
-- API modules answer first, in words (B-W2b-26 employees and teams, B-W2b-27 privacy, B-W2b-39 skills); these are the
-- last word. Every refusal is a check_violation (SQLSTATE 23514).
--
--   one at a time   one team per person and one lead per team (TeamMember rows with no end); one OPEN leaver case per
--                   person; one level in force per person and skill (not removed); one machine authorisation in force
--                   per person and class (not revoked); one legal gate in force per site and purpose (not switched off)
--                   (partial unique indexes). Two loans of one person never overlap (trigger).
--   a person        a level names who assessed it and when, and a changed level names its assessor again (MES-281); a
--   decides         skipped leaver step names who skipped it and why; a gate names who switched it on (and off).
--   safe default    a purpose of people data is OFF at a site until a row is in force: switched on with the basis, its
--                   reference, the company's worker notice in force and a stored impact assessment (GATE-LABOUR).
--   final           a DONE or CANCELLED leaver case; a removed level; a revoked authorisation; a switched-off gate.
--   never deleted   Employee, Team, OrgArea, LeaverCase, LeaverStep, PeopleSettings, PeopleLegalGate, Skill,
--                   EmployeeSkill, MachineAuthorisation: DELETE and TRUNCATE refused. A team membership that has not begun
--                   before today and a loan that has not begun may be deleted (a mistake); TRUNCATE refused.
--   W0-W2a tables   Line.areaId names an ACTIVE area of its site (its own trigger); Worker.employeeId: a worker's office
--                   account and their employee's agree, at commit (their own constraint triggers). No W0-W2a function
--                   is redefined.
--
-- The tenant (and site) of a row are held by the policies (USING and WITH CHECK) and by the references, not here: the
-- triggers leave "tenantId" and "siteId" to them, so a row moved to another tenant or site is refused by row-level
-- security ("everything but these columns" is compared as jsonb without them). A rule that reads another row skips its
-- check when it cannot see that row (another tenant's: the policy then refuses the write). Locks: a person's loans take
-- the advisory key 'factory.people.loan|tenant|employee', a leaver case and its steps 'factory.people.leaver|tenant|case'
-- (pg_advisory_xact_lock, to the end of the transaction). "Today" is the day in Europe/Rome.

CREATE FUNCTION "factory_people_w2b_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'people: TRUNCATE on "%" is refused; its rows are never deleted', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_people_today"() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Europe/Rome')::date
$$;

-- =====================================================================================================================
-- The org tree (_core.prisma): areas and the area of a line (PLT-005)
-- =====================================================================================================================

-- OrgArea
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change.
--   every row  a code and a name.
--   ARCHIVED   only with no ACTIVE line in it.
--   DELETE     refused (archived instead). TRUNCATE refused.
CREATE FUNCTION "factory_org_area_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'people: area % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'people: the company and creation of area % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."code") = '' OR btrim(NEW."name") = '' THEN
    RAISE EXCEPTION 'people: area % has a code and a name', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'ARCHIVED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'ARCHIVED')
     AND EXISTS (SELECT 1 FROM "Line" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."areaId" = NEW."id" AND l."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'people: area % still has active lines; move them to another area or archive them first', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OrgArea_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OrgArea"
  FOR EACH ROW EXECUTE FUNCTION "factory_org_area_guard"();
CREATE TRIGGER "OrgArea_no_truncate" BEFORE TRUNCATE ON "OrgArea"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_people_w2b_refuse_truncate"();

-- Line (W0, a trigger of its own): a line is put only in an ACTIVE area (its site's: the reference).
CREATE FUNCTION "factory_line_area_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."areaId" IS NOT DISTINCT FROM OLD."areaId" THEN
    RETURN NEW;
  END IF;
  SELECT a."status"::text INTO state FROM "OrgArea" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."areaId";
  IF FOUND AND state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'people: area % is archived; line % goes into an active area', NEW."areaId", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Line_area_check" BEFORE INSERT OR UPDATE OF "areaId" ON "Line"
  FOR EACH ROW WHEN (NEW."areaId" IS NOT NULL)
  EXECUTE FUNCTION "factory_line_area_check"();

-- =====================================================================================================================
-- Employees (MES-208, MES-211) and their floor sign-in
-- =====================================================================================================================

-- Employee
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change (a person who moves to
--              another company is a new employment: a new record). The site may change: the reference keeps the home
--              line on it, and the person's levels and authorisations follow (ON UPDATE CASCADE).
--   every row  a first name, a last name and a name shown on the floor; an employee code, when set, is not blank; the
--              language a code of two or three small letters; an AGENCY worker exactly names the agency and has an end
--              date; the end on or after the start; LEFT only with an end date that has come (today or before); the
--              weekly minutes above 0 and at most 4800.
--   agency     an organisation of the employee's company or tenant-wide (checked when it is set or changed).
--   DELETE     refused (a leaver is LEFT). TRUNCATE refused.
CREATE FUNCTION "factory_employee_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  party_kind text;
  party_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'people: employee % is never deleted; a leaver is LEFT and keeps their name on the history', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'people: the company and creation of employee % never change (another company is a new employment: a new record)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."firstName") = '' OR btrim(NEW."lastName") = '' OR btrim(NEW."displayName") = '' THEN
    RAISE EXCEPTION 'people: employee % has a first name, a last name and a name shown on the floor', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."employeeCode" IS NOT NULL AND btrim(NEW."employeeCode") = '' THEN
    RAISE EXCEPTION 'people: employee % has an employee code or none, never a blank one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."locale" !~ '^[a-z]{2,3}$' THEN
    RAISE EXCEPTION 'people: the language of employee % is an ISO 639 code (it, en …), not %', NEW."id", NEW."locale"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'AGENCY') <> (NEW."agencyPartyId" IS NOT NULL) OR (NEW."kind" = 'AGENCY' AND NEW."endDate" IS NULL) THEN
    RAISE EXCEPTION 'people: employee % names an agency exactly when they are an AGENCY worker, and an agency worker has the contract''s end date (MES-211)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."endDate" IS NOT NULL AND NEW."endDate" < NEW."startDate" THEN
    RAISE EXCEPTION 'people: employee % ends (%) on or after they start (%)', NEW."id", NEW."endDate", NEW."startDate"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'LEFT' AND (NEW."endDate" IS NULL OR NEW."endDate" > "factory_people_today"()) THEN
    RAISE EXCEPTION 'people: employee % is LEFT only once their end date has come (it is %)', NEW."id", coalesce(NEW."endDate"::text, 'not set')
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."weeklyMinutes" IS NOT NULL AND (NEW."weeklyMinutes" < 1 OR NEW."weeklyMinutes" > 4800) THEN
    RAISE EXCEPTION 'people: the weekly minutes of employee % are above 0 and at most 4800 (80 hours), not %', NEW."id", NEW."weeklyMinutes"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."agencyPartyId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."agencyPartyId" IS DISTINCT FROM OLD."agencyPartyId") THEN
    SELECT p."kind"::text, p."companyId" INTO party_kind, party_company FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."agencyPartyId";
    IF FOUND AND (party_kind <> 'ORGANISATION' OR (party_company IS NOT NULL AND party_company <> NEW."companyId")) THEN
      RAISE EXCEPTION 'people: the agency of employee % is an organisation of their company or of the whole group', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Employee_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Employee"
  FOR EACH ROW EXECUTE FUNCTION "factory_employee_guard"();
CREATE TRIGGER "Employee_no_truncate" BEFORE TRUNCATE ON "Employee"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_people_w2b_refuse_truncate"();

-- One person, one record (plan §12 "never two person records"): a worker linked to an employee (Worker.employeeId, of
-- the worker's company: the reference) and that employee name the same office account, or one of them names none.
-- Checked at commit, so a command may link both in any order. (One worker per site per employee is the API's rule: the
-- generated copy test copies a linked worker.)
CREATE FUNCTION "factory_worker_employee_link"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account uuid;
BEGIN
  IF TG_TABLE_NAME = 'Worker' THEN
    SELECT w."userId", e."userId" INTO account FROM "Worker" w JOIN "Employee" e ON e."tenantId" = w."tenantId" AND e."id" = w."employeeId"
      WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."id" AND w."userId" IS NOT NULL AND e."userId" IS NOT NULL AND w."userId" <> e."userId";
    IF FOUND THEN
      RAISE EXCEPTION 'people: worker % and their employee record name different office accounts; one person has one record', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."employeeId" = NEW."id" AND w."userId" IS NOT NULL AND w."userId" <> NEW."userId") THEN
      RAISE EXCEPTION 'people: employee % and one of their floor workers name different office accounts; one person has one record', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "Worker_employee_link" AFTER INSERT OR UPDATE OF "employeeId", "userId" ON "Worker"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."employeeId" IS NOT NULL AND NEW."userId" IS NOT NULL)
  EXECUTE FUNCTION "factory_worker_employee_link"();
CREATE CONSTRAINT TRIGGER "Employee_worker_link" AFTER UPDATE OF "userId" ON "Employee"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."userId" IS NOT NULL)
  EXECUTE FUNCTION "factory_worker_employee_link"();

-- =====================================================================================================================
-- Teams, members and loans (MES-210, PLT-020)
-- =====================================================================================================================

-- Team
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change.
--   every row  a code and a name; its line ACTIVE when it is set or changed.
--   ARCHIVED   only with nobody in it (no member row without an end, or ending today or later).
--   DELETE     refused (archived instead). TRUNCATE refused.
CREATE FUNCTION "factory_team_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'people: team % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'people: the company and creation of team % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."code") = '' OR btrim(NEW."name") = '' THEN
    RAISE EXCEPTION 'people: team % has a code and a name', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lineId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."lineId" IS DISTINCT FROM OLD."lineId") THEN
    SELECT l."status"::text INTO state FROM "Line" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."lineId";
    IF FOUND AND state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'people: line % is archived; team % works on an active line', NEW."lineId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" = 'ARCHIVED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'ARCHIVED')
     AND EXISTS (SELECT 1 FROM "TeamMember" m WHERE m."tenantId" = NEW."tenantId" AND m."teamId" = NEW."id" AND (m."until" IS NULL OR m."until" >= "factory_people_today"())) THEN
    RAISE EXCEPTION 'people: team % still has people in it; move them to another team first', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Team_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Team"
  FOR EACH ROW EXECUTE FUNCTION "factory_team_guard"();
CREATE TRIGGER "Team_no_truncate" BEFORE TRUNCATE ON "Team"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_people_w2b_refuse_truncate"();

-- TeamMember
--   INSERT     the person is of the team's company; a membership without an end (in the team now or from a day ahead)
--              needs an ACTIVE person and an ACTIVE team.
--   UPDATE     an UPDATE that changes nothing passes; the team, the person, the start and the creation never change:
--              the end moves (a move ends the row and starts another), and the lead flag changes while there is no end.
--   every row  the end on or after the start.
--   DELETE     only of a membership that has not begun before today (a mistake); an older one is ended. TRUNCATE refused.
--   (One team at a time per person, one lead at a time per team: the partial unique indexes below.)
CREATE FUNCTION "factory_team_member_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person_company uuid;
  person_state text;
  team_company uuid;
  team_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."since" < "factory_people_today"() THEN
      RAISE EXCEPTION 'people: team membership % began on %; it is ended (its last day), never deleted', OLD."id", OLD."since"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."teamId", NEW."employeeId", NEW."since", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."teamId", OLD."employeeId", OLD."since", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'people: team membership % keeps its team, person and start; a move ends it and starts another', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."isLead" <> OLD."isLead" AND NEW."until" IS NOT NULL THEN
      RAISE EXCEPTION 'people: the lead of a team is set on a membership without an end (membership %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."until" IS NOT NULL AND NEW."until" < NEW."since" THEN
    RAISE EXCEPTION 'people: team membership % ends (%) on or after it starts (%)', NEW."id", NEW."until", NEW."since"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT e."companyId", e."status"::text INTO person_company, person_state FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."employeeId";
    SELECT t."companyId", t."status"::text INTO team_company, team_state FROM "Team" t WHERE t."tenantId" = NEW."tenantId" AND t."siteId" = NEW."siteId" AND t."id" = NEW."teamId";
    IF person_company IS NOT NULL AND team_company IS NOT NULL AND person_company <> team_company THEN
      RAISE EXCEPTION 'people: employee % works for another company than team %', NEW."employeeId", NEW."teamId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."until" IS NULL AND (person_state = 'LEFT' OR team_state = 'ARCHIVED') THEN
      RAISE EXCEPTION 'people: employee % joins team % only while both are active', NEW."employeeId", NEW."teamId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "TeamMember_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TeamMember"
  FOR EACH ROW EXECUTE FUNCTION "factory_team_member_guard"();
CREATE TRIGGER "TeamMember_no_truncate" BEFORE TRUNCATE ON "TeamMember"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_people_w2b_refuse_truncate"();
CREATE UNIQUE INDEX "TeamMember_one_team_at_a_time" ON "TeamMember" ("tenantId", "employeeId") WHERE "until" IS NULL;
CREATE UNIQUE INDEX "TeamMember_one_lead_at_a_time" ON "TeamMember" ("tenantId", "teamId") WHERE "isLead" AND "until" IS NULL;

-- LineLoan
--   INSERT     an ACTIVE person of the site's company, an ACTIVE line; the team, when named, ACTIVE and on that line (or
--              on no line); the line it comes from is another one.
--   UPDATE     an UPDATE that changes nothing passes; only the end moves (earlier: back sooner; later: longer).
--   every row  it ends after it starts; a reason; two loans of one person never overlap (the person's loan key is
--              locked, so two loans of one person wait for each other).
--   DELETE     only of a loan that has not begun. TRUNCATE refused.
CREATE FUNCTION "factory_line_loan_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person_company uuid;
  person_state text;
  site_company uuid;
  line_state text;
  team_state text;
  team_line uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."startsAt" <= now() THEN
      RAISE EXCEPTION 'people: loan % has begun; it is ended earlier, never deleted', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['tenantId', 'siteId', 'endsAt', 'version', 'updatedAt']) <> (to_jsonb(OLD) - ARRAY['tenantId', 'siteId', 'endsAt', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'people: loan % keeps its person, lines, team, start and reason; only its end moves', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."endsAt" <= NEW."startsAt" THEN
    RAISE EXCEPTION 'people: loan % ends after it starts', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."reason") = '' THEN
    RAISE EXCEPTION 'people: loan % says why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."fromLineId" IS NOT DISTINCT FROM NEW."toLineId" THEN
      RAISE EXCEPTION 'people: loan % goes to another line than the one the person comes from', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT e."companyId", e."status"::text INTO person_company, person_state FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."employeeId";
    SELECT s."companyId" INTO site_company FROM "Site" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."siteId";
    IF person_state = 'LEFT' OR (person_company IS NOT NULL AND site_company IS NOT NULL AND person_company <> site_company) THEN
      RAISE EXCEPTION 'people: employee % is lent only while active, and only to a line of their company', NEW."employeeId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT l."status"::text INTO line_state FROM "Line" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."toLineId";
    IF FOUND AND line_state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'people: line % is archived; loan % goes to an active line', NEW."toLineId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."toTeamId" IS NOT NULL THEN
      SELECT t."status"::text, t."lineId" INTO team_state, team_line FROM "Team" t WHERE t."tenantId" = NEW."tenantId" AND t."siteId" = NEW."siteId" AND t."id" = NEW."toTeamId";
      IF FOUND AND (team_state <> 'ACTIVE' OR (team_line IS NOT NULL AND team_line <> NEW."toLineId")) THEN
        RAISE EXCEPTION 'people: loan % joins an active team of line % (team %)', NEW."id", NEW."toLineId", NEW."toTeamId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW."endsAt" <> OLD."endsAt" THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.people.loan', NEW."tenantId", NEW."employeeId"), 0));
    IF EXISTS (SELECT 1 FROM "LineLoan" o WHERE o."tenantId" = NEW."tenantId" AND o."employeeId" = NEW."employeeId" AND o."id" <> NEW."id"
               AND tstzrange(o."startsAt", o."endsAt") && tstzrange(NEW."startsAt", NEW."endsAt")) THEN
      RAISE EXCEPTION 'people: employee % is already lent at that time; two loans of one person never overlap (loan %)', NEW."employeeId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LineLoan_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LineLoan"
  FOR EACH ROW EXECUTE FUNCTION "factory_line_loan_guard"();
CREATE TRIGGER "LineLoan_no_truncate" BEFORE TRUNCATE ON "LineLoan"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_people_w2b_refuse_truncate"();

-- =====================================================================================================================
-- Leavers (MES-214)
-- =====================================================================================================================

-- LeaverCase
--   INSERT     an OPEN case for an ACTIVE person; a DONE or CANCELLED one only with its closing (a leaver of the past,
--              imported).
--   UPDATE     an UPDATE that changes nothing passes; the person, the start and the creation never change; a DONE or
--              CANCELLED case never changes again. OPEN → DONE: it has steps and every one is DONE or SKIPPED. OPEN →
--              CANCELLED: until the last working day (today included). While OPEN the last working day moves.
--   every row  OPEN: neither closed nor cancelled; DONE: when it was closed (who: null for the system), not cancelled;
--              CANCELLED: when, who and why, not closed.
--   DELETE     refused. TRUNCATE refused. (One OPEN case per person: the partial unique index below.)
CREATE FUNCTION "factory_leaver_case_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person_state text;
  person_start date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'people: leaver case % is never deleted (cancelled instead)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - ARRAY['tenantId']) <> (to_jsonb(OLD) - ARRAY['tenantId']) THEN
      RAISE EXCEPTION 'people: leaver case % is %; it never changes again', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."id", NEW."employeeId", NEW."startedAt", NEW."startedById", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."employeeId", OLD."startedAt", OLD."startedById", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'people: leaver case % keeps its person and its start', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'OPEN' AND NEW."status" <> 'OPEN' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.people.leaver', NEW."tenantId", NEW."id"), 0));
    END IF;
    IF OLD."status" = 'OPEN' AND NEW."status" = 'DONE'
       AND (NOT EXISTS (SELECT 1 FROM "LeaverStep" s WHERE s."tenantId" = NEW."tenantId" AND s."caseId" = NEW."id")
            OR EXISTS (SELECT 1 FROM "LeaverStep" s WHERE s."tenantId" = NEW."tenantId" AND s."caseId" = NEW."id" AND s."status" = 'OPEN')) THEN
      RAISE EXCEPTION 'people: leaver case % is done only when every one of its steps is done or skipped', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'OPEN' AND NEW."status" = 'CANCELLED' AND OLD."lastWorkingDay" < "factory_people_today"() THEN
      RAISE EXCEPTION 'people: leaver case % is cancelled only until the last working day (%)', NEW."id", OLD."lastWorkingDay"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."status" = 'OPEN' AND (NEW."closedAt" IS NOT NULL OR NEW."closedById" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL OR NEW."cancelledById" IS NOT NULL OR NEW."cancelReason" IS NOT NULL))
     OR (NEW."status" = 'DONE' AND (NEW."closedAt" IS NULL OR NEW."cancelledAt" IS NOT NULL OR NEW."cancelledById" IS NOT NULL OR NEW."cancelReason" IS NOT NULL))
     OR (NEW."status" = 'CANCELLED' AND (NEW."cancelledAt" IS NULL OR NEW."cancelledById" IS NULL OR coalesce(btrim(NEW."cancelReason"), '') = ''
                                         OR NEW."closedAt" IS NOT NULL OR NEW."closedById" IS NOT NULL)) THEN
    RAISE EXCEPTION 'people: leaver case % is OPEN (neither closed nor cancelled), DONE (when it was closed) or CANCELLED (when, who and why)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT e."status"::text, e."startDate" INTO person_state, person_start FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."employeeId";
    IF NEW."status" = 'OPEN' AND person_state = 'LEFT' THEN
      RAISE EXCEPTION 'people: employee % has left; leaver steps start for an active person', NEW."employeeId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT e."startDate" INTO person_start FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."employeeId";
  END IF;
  IF person_start IS NOT NULL AND NEW."lastWorkingDay" < person_start THEN
    RAISE EXCEPTION 'people: the last working day of leaver case % is on or after the person''s first day (%)', NEW."id", person_start
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LeaverCase_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LeaverCase"
  FOR EACH ROW EXECUTE FUNCTION "factory_leaver_case_guard"();
CREATE TRIGGER "LeaverCase_no_truncate" BEFORE TRUNCATE ON "LeaverCase"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_people_w2b_refuse_truncate"();
CREATE UNIQUE INDEX "LeaverCase_one_open_per_employee" ON "LeaverCase" ("tenantId", "employeeId") WHERE "status" = 'OPEN';

-- LeaverStep
--   every write  only while its case is OPEN (the case's key is locked, so the case is closed after its steps).
--   UPDATE       an UPDATE that changes nothing passes; the case, kind, place, automatic flag and creation never change.
--   every row    its place 1 or more; OPEN: not done; DONE: when (who: required unless the system ticks an automatic
--                step), no skip reason; SKIPPED: when, who and why; where it was done (recordType and recordId) both or
--                neither. Reopened (back to OPEN) while the case is OPEN.
--   DELETE       refused (a step not needed is SKIPPED). TRUNCATE refused.
CREATE FUNCTION "factory_leaver_step_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  this_case uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'people: leaver step % is never deleted; a step not needed is SKIPPED with the reason', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."caseId", NEW."kind", NEW."seq", NEW."automatic", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."caseId", OLD."kind", OLD."seq", OLD."automatic", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'people: leaver step % keeps its case, kind and place', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  this_case := NEW."caseId";
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.people.leaver', NEW."tenantId", this_case), 0));
  SELECT c."status"::text INTO state FROM "LeaverCase" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = this_case;
  IF FOUND AND state <> 'OPEN' THEN
    RAISE EXCEPTION 'people: leaver case % is %; its steps no longer change', this_case, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'people: leaver step % has its place in the list, from 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'OPEN' AND (NEW."doneAt" IS NOT NULL OR NEW."doneById" IS NOT NULL OR NEW."skipReason" IS NOT NULL))
     OR (NEW."status" = 'DONE' AND (NEW."doneAt" IS NULL OR NEW."skipReason" IS NOT NULL OR (NOT NEW."automatic" AND NEW."doneById" IS NULL)))
     OR (NEW."status" = 'SKIPPED' AND (NEW."doneAt" IS NULL OR NEW."doneById" IS NULL OR coalesce(btrim(NEW."skipReason"), '') = '')) THEN
    RAISE EXCEPTION 'people: leaver step % is OPEN, DONE (when, and who unless the system ticked it) or SKIPPED (when, who and why: a person decides)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."recordType" IS NULL) <> (NEW."recordId" IS NULL) OR btrim(NEW."recordType") = '' THEN
    RAISE EXCEPTION 'people: leaver step % names where it was done by a record type and id, both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LeaverStep_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LeaverStep"
  FOR EACH ROW EXECUTE FUNCTION "factory_leaver_step_guard"();
CREATE TRIGGER "LeaverStep_no_truncate" BEFORE TRUNCATE ON "LeaverStep"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_people_w2b_refuse_truncate"();

-- =====================================================================================================================
-- People settings and the legal gate (MES-225, MES-227, ANA-075, H3; GATE-LABOUR, PLT-209, MES-249, MES-282)
-- =====================================================================================================================

-- PeopleSettings
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change.
--   every row  the lateness grace 0 to 60 minutes; the overtime unit 1 to 60; the rounding 0, 5 or 15; the automatic
--              clock-out none or 0 to 720 minutes after the shift; the minimum group size 3 to 1000 (ANA-075: a group of
--              two shows one person to the other); the roles that see one person's figures role keys, each once.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_people_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'people: the people settings % are changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'people: the company and creation of the people settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."lateGraceMinutes" NOT BETWEEN 0 AND 60 OR NEW."overtimeUnitMinutes" NOT BETWEEN 1 AND 60
     OR NEW."roundingMinutes" NOT IN (0, 5, 15) OR NEW."autoClockOutAfterMinutes" NOT BETWEEN 0 AND 720 THEN
    RAISE EXCEPTION 'people: the people settings % round clock events to 0, 5 or 15 minutes, give 0 to 60 minutes of grace, count overtime in units of 1 to 60 minutes and close an open clock-in 0 to 720 minutes after the shift, or never', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."minimumGroupSize" NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'people: the minimum group size of the people settings % is 3 or more (a group of two shows one person to the other; ANA-075), not %', NEW."id", NEW."minimumGroupSize"
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW."figureRoleKeys") k WHERE k IS NULL OR k !~ '^[a-z][a-z0-9_.-]*$')
     OR cardinality(NEW."figureRoleKeys") <> (SELECT count(DISTINCT k) FROM unnest(NEW."figureRoleKeys") k) THEN
    RAISE EXCEPTION 'people: the people settings % name the roles that see one person''s figures by their keys (hr, custom.<slug>), each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PeopleSettings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PeopleSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_people_settings_guard"();
CREATE TRIGGER "PeopleSettings_no_truncate" BEFORE TRUNCATE ON "PeopleSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_people_w2b_refuse_truncate"();

-- PeopleLegalGate (a row in force = the purpose switched ON at the site; none = OFF)
--   INSERT     the notice is a WORKER_FLOOR notice of the company: PUBLISHED for a gate in force (PUBLISHED or SUPERSEDED
--              for an ended one, a decision of the past); the impact assessment the company's: STORED for a gate in force
--              (STORED or SUPERSEDED for an ended one).
--   UPDATE     an UPDATE that changes nothing passes; a switched-off gate never changes again; while in force only who
--              sees the figures (leadsSeeFigures) changes, and it is switched off once (when, who, why).
--   every row  a basis reference; the basis covers leads only for PERFORMANCE, on a union agreement or the Ispettorato's
--              authorisation; leads see figures only where it does; switched off with all three (when, who, why) or none,
--              never before it was switched on.
--   DELETE     refused (the history of every decision). TRUNCATE refused. (One gate in force per site and purpose: the
--              partial unique index below.)
CREATE FUNCTION "factory_people_legal_gate_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  notice_kind text;
  notice_state text;
  dpia_company uuid;
  dpia_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'people: legal gate % is the record of a decision; it is switched off, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."switchedOffAt" IS NOT NULL AND (to_jsonb(NEW) - ARRAY['tenantId', 'siteId']) <> (to_jsonb(OLD) - ARRAY['tenantId', 'siteId']) THEN
      RAISE EXCEPTION 'people: legal gate % was switched off; it never changes again (switching on again is a new record)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['tenantId', 'siteId', 'leadsSeeFigures', 'switchedOffAt', 'switchedOffById', 'switchOffReason', 'version', 'updatedAt'])
       <> (to_jsonb(OLD) - ARRAY['tenantId', 'siteId', 'leadsSeeFigures', 'switchedOffAt', 'switchedOffById', 'switchOffReason', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'people: legal gate % keeps its purpose, basis, notice, impact assessment and switch-on; a new basis is a new record', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."basisReference") = '' THEN
    RAISE EXCEPTION 'people: legal gate % names the reference of its basis (the agreement, the authorisation or counsel''s opinion)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."basisCoversLeads" AND (NEW."purpose" <> 'PERFORMANCE' OR NEW."basis" NOT IN ('UNION_AGREEMENT', 'INL_AUTHORISATION')) THEN
    RAISE EXCEPTION 'people: legal gate % says the basis covers leads only for PERFORMANCE, on a union agreement or the Ispettorato''s authorisation', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."leadsSeeFigures" AND NOT NEW."basisCoversLeads" THEN
    RAISE EXCEPTION 'people: at legal gate % leads see one person''s figures only where the recorded basis covers leads', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."switchedOffAt" IS NULL) <> (NEW."switchedOffById" IS NULL) OR (NEW."switchedOffAt" IS NULL) <> (coalesce(btrim(NEW."switchOffReason"), '') = '')
     OR NEW."switchedOffAt" < NEW."switchedOnAt" THEN
    RAISE EXCEPTION 'people: legal gate % is switched off with when, who and why, and not before it was switched on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT n."kind"::text, n."status"::text INTO notice_kind, notice_state FROM "PrivacyNotice" n WHERE n."tenantId" = NEW."tenantId" AND n."companyId" = NEW."companyId" AND n."id" = NEW."noticeId";
    IF FOUND AND (notice_kind <> 'WORKER_FLOOR' OR notice_state = 'DRAFT' OR (NEW."switchedOffAt" IS NULL AND notice_state <> 'PUBLISHED')) THEN
      RAISE EXCEPTION 'people: legal gate % is switched on with the company''s worker notice in force (notice % is a % notice, %)', NEW."id", NEW."noticeId", notice_kind, notice_state
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT d."companyId", d."status"::text INTO dpia_company, dpia_state FROM "PrivacyDpia" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."dpiaId";
    IF FOUND AND (dpia_company <> NEW."companyId" OR dpia_state = 'DRAFT' OR (NEW."switchedOffAt" IS NULL AND dpia_state <> 'STORED')) THEN
      RAISE EXCEPTION 'people: legal gate % is switched on with the company''s stored impact assessment (assessment % is %)', NEW."id", NEW."dpiaId", dpia_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PeopleLegalGate_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PeopleLegalGate"
  FOR EACH ROW EXECUTE FUNCTION "factory_people_legal_gate_guard"();
CREATE TRIGGER "PeopleLegalGate_no_truncate" BEFORE TRUNCATE ON "PeopleLegalGate"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_people_w2b_refuse_truncate"();
CREATE UNIQUE INDEX "PeopleLegalGate_one_in_force" ON "PeopleLegalGate" ("tenantId", "siteId", "purpose") WHERE "switchedOffAt" IS NULL;

-- =====================================================================================================================
-- Skills and machine authorisations (skills.prisma; MES-241, MES-244, MES-246)
-- =====================================================================================================================

-- Skill
--   INSERT     its operation of its company or tenant-wide (a tenant-wide skill names a tenant-wide operation).
--   UPDATE     an UPDATE that changes nothing passes; the company, code, kind, operation, class and creation never change.
--   every row  a code and a name; the words per language an object; OPERATION exactly with an operation, MACHINE exactly
--              with a class of machine, GENERAL with neither.
--   DELETE     refused (archived instead). TRUNCATE refused.
CREATE FUNCTION "factory_skill_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  operation_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'people: skill % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."code", NEW."kind", NEW."operationId", NEW."machineClassId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."code", OLD."kind", OLD."operationId", OLD."machineClassId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'people: skill % keeps its company, code, kind and what it is about', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."code") = '' OR btrim(NEW."name") = '' OR jsonb_typeof(NEW."nameI18n") <> 'object' THEN
    RAISE EXCEPTION 'people: skill % has a code, a name and its words per language (an object)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'OPERATION') <> (NEW."operationId" IS NOT NULL) OR (NEW."kind" = 'MACHINE') <> (NEW."machineClassId" IS NOT NULL) THEN
    RAISE EXCEPTION 'people: skill % is about one operation (OPERATION), one class of machine (MACHINE) or neither (GENERAL)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."operationId" IS NOT NULL THEN
    SELECT o."companyId" INTO operation_company FROM "Operation" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."operationId";
    IF FOUND AND operation_company IS NOT NULL AND operation_company IS DISTINCT FROM NEW."companyId" THEN
      RAISE EXCEPTION 'people: skill % is about an operation of its own company, or of the whole group', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Skill_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Skill"
  FOR EACH ROW EXECUTE FUNCTION "factory_skill_guard"();
CREATE TRIGGER "Skill_no_truncate" BEFORE TRUNCATE ON "Skill"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_people_w2b_refuse_truncate"();

-- EmployeeSkill
--   INSERT     a level in force (not removed) needs an ACTIVE person and an ACTIVE skill; the skill is the person's
--              company's or tenant-wide; the trainer a person of the same company, not the trainee.
--   UPDATE     an UPDATE that changes nothing passes; the person, skill and creation never change; a removed level never
--              changes again (its site follows the person); a changed level names who assessed it again, later than the
--              last time (MES-281); a sign-off is set once, and the trainee period no longer moves after it.
--   every row  who assessed it and when (the columns are required); the trainee period ends on or after the level's
--              start; signed off with the day and who (the trainer only with them), only for a trainee, on or after the
--              start; removed with when, who and why, or not at all.
--   DELETE     refused (removed instead). TRUNCATE refused. (One level in force per person and skill: the partial unique
--              index below.)
CREATE FUNCTION "factory_employee_skill_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person_company uuid;
  person_state text;
  skill_company uuid;
  skill_state text;
  trainer_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'people: skill level % is removed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."removedAt" IS NOT NULL AND (to_jsonb(NEW) - ARRAY['tenantId', 'siteId']) <> (to_jsonb(OLD) - ARRAY['tenantId', 'siteId']) THEN
      RAISE EXCEPTION 'people: skill level % was removed; it never changes again', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."id", NEW."employeeId", NEW."skillId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."employeeId", OLD."skillId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'people: skill level % keeps its person and skill', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."level" <> OLD."level" AND NEW."assessedAt" <= OLD."assessedAt" THEN
      RAISE EXCEPTION 'people: the level of % changes only with who assessed it again and when (a person decides; MES-281)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."signedOffOn" IS NOT NULL
       AND (NEW."signedOffOn", NEW."signedOffById", NEW."trainerEmployeeId", NEW."traineeUntil") IS DISTINCT FROM (OLD."signedOffOn", OLD."signedOffById", OLD."trainerEmployeeId", OLD."traineeUntil") THEN
      RAISE EXCEPTION 'people: the trainee of skill level % was signed off; the sign-off and the trainee period never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."traineeUntil" IS NOT NULL AND NEW."traineeUntil" < NEW."since" THEN
    RAISE EXCEPTION 'people: the trainee period of skill level % ends on or after the level''s start', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."signedOffOn" IS NULL) <> (NEW."signedOffById" IS NULL) OR (NEW."trainerEmployeeId" IS NOT NULL AND NEW."signedOffOn" IS NULL)
     OR (NEW."signedOffOn" IS NOT NULL AND (NEW."traineeUntil" IS NULL OR NEW."signedOffOn" < NEW."since"))
     OR NEW."trainerEmployeeId" = NEW."employeeId" THEN
    RAISE EXCEPTION 'people: skill level % signs off a trainee with the day and who (the trainer, another person, only with them), on or after the level''s start', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."removedAt" IS NULL) <> (NEW."removedById" IS NULL) OR (NEW."removedAt" IS NULL) <> (coalesce(btrim(NEW."removeReason"), '') = '') THEN
    RAISE EXCEPTION 'people: skill level % is removed with when, who and why, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT e."companyId", e."status"::text INTO person_company, person_state FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."employeeId";
    SELECT s."companyId", s."status"::text INTO skill_company, skill_state FROM "Skill" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."skillId";
    IF NEW."removedAt" IS NULL AND (person_state = 'LEFT' OR skill_state = 'ARCHIVED') THEN
      RAISE EXCEPTION 'people: a level is given to an active person in an active skill (employee %, skill %)', NEW."employeeId", NEW."skillId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF skill_company IS NOT NULL AND person_company IS NOT NULL AND skill_company <> person_company THEN
      RAISE EXCEPTION 'people: skill % belongs to another company than employee %', NEW."skillId", NEW."employeeId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."trainerEmployeeId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."trainerEmployeeId" IS DISTINCT FROM OLD."trainerEmployeeId") THEN
    SELECT e."companyId" INTO person_company FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."employeeId";
    SELECT e."companyId" INTO trainer_company FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."trainerEmployeeId";
    IF person_company IS NOT NULL AND trainer_company IS NOT NULL AND person_company <> trainer_company THEN
      RAISE EXCEPTION 'people: the trainer of skill level % works for the trainee''s company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "EmployeeSkill_guard" BEFORE INSERT OR UPDATE OR DELETE ON "EmployeeSkill"
  FOR EACH ROW EXECUTE FUNCTION "factory_employee_skill_guard"();
CREATE TRIGGER "EmployeeSkill_no_truncate" BEFORE TRUNCATE ON "EmployeeSkill"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_people_w2b_refuse_truncate"();
CREATE UNIQUE INDEX "EmployeeSkill_one_in_force" ON "EmployeeSkill" ("tenantId", "employeeId", "skillId") WHERE "removedAt" IS NULL;

-- MachineAuthorisation
--   INSERT     an authorisation in force (not revoked) needs an ACTIVE person and an active class of machine.
--   UPDATE     an UPDATE that changes nothing passes; the person, class, start, who authorised it and the creation never
--              change; a revoked authorisation never changes again (its site follows the person); while in force its end
--              moves (extended or shortened) and it is revoked once.
--   every row  the end on or after the start; revoked with when, who and why, or not at all.
--   DELETE     refused (revoked instead). TRUNCATE refused. (One authorisation in force per person and class: the partial
--              unique index below.)
CREATE FUNCTION "factory_machine_authorisation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  person_state text;
  class_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'people: machine authorisation % is revoked, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."revokedAt" IS NOT NULL AND (to_jsonb(NEW) - ARRAY['tenantId', 'siteId']) <> (to_jsonb(OLD) - ARRAY['tenantId', 'siteId']) THEN
      RAISE EXCEPTION 'people: machine authorisation % was revoked; it never changes again (a new authorisation is a new record)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."id", NEW."employeeId", NEW."machineClassId", NEW."authorisedOn", NEW."authorisedById", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."employeeId", OLD."machineClassId", OLD."authorisedOn", OLD."authorisedById", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'people: machine authorisation % keeps its person, class, start and who authorised it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."validUntil" IS NOT NULL AND NEW."validUntil" < NEW."authorisedOn" THEN
    RAISE EXCEPTION 'people: machine authorisation % ends (%) on or after it starts (%)', NEW."id", NEW."validUntil", NEW."authorisedOn"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."revokedAt" IS NULL) <> (NEW."revokedById" IS NULL) OR (NEW."revokedAt" IS NULL) <> (coalesce(btrim(NEW."revokeReason"), '') = '') THEN
    RAISE EXCEPTION 'people: machine authorisation % is revoked with when, who and why, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."revokedAt" IS NULL THEN
    SELECT e."status"::text INTO person_state FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."employeeId";
    SELECT c."active" INTO class_active FROM "MachineClass" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."machineClassId";
    IF person_state = 'LEFT' OR class_active = false THEN
      RAISE EXCEPTION 'people: an active person is authorised on an active class of machine (employee %, class %)', NEW."employeeId", NEW."machineClassId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "MachineAuthorisation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "MachineAuthorisation"
  FOR EACH ROW EXECUTE FUNCTION "factory_machine_authorisation_guard"();
CREATE TRIGGER "MachineAuthorisation_no_truncate" BEFORE TRUNCATE ON "MachineAuthorisation"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_people_w2b_refuse_truncate"();
CREATE UNIQUE INDEX "MachineAuthorisation_one_in_force" ON "MachineAuthorisation" ("tenantId", "employeeId", "machineClassId") WHERE "revokedAt" IS NULL;
