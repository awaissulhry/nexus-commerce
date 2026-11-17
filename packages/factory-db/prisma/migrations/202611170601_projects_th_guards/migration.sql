-- Written by hand (Prisma does not model triggers), after the generated 202611170600_projects_th_schema and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Projects, TH-5 (threads plan, schema wave 8/9, B-TH-065; gaps PROJ-G01, PROJ-G03, PROJ-G04, PROJ-G06; walls W01, W38: brand B
-- never sees brand A's project, and linking brand B's record to brand A's project is refused by the database). apps/factory-api
-- checks all of this first and answers in words (B-TH-066 the project record, B-TH-067 its links, B-TH-068 its people); these
-- rules are the last word, for every login, the owner included.
--
--   Project        its number from the company's PROJECT series (the numbering step's `factory_document_number_guard`: given at
--                  insert, never blank, never changed); made ACTIVE with no outcome; ACTIVE ⇄ ON_HOLD, ACTIVE | ON_HOLD →
--                  CLOSED, CLOSED → ACTIVE (reopened); CLOSED exactly with its outcome (DONE or STOPPED), its one line (1 to
--                  500 characters) and when (not in the future, not before it was made; by whom optional, only with when); a
--                  CLOSED project changes nothing but its reopening, which takes its outcome away; its company, number,
--                  outside company and creation never change; a name of one line (1 to 200), a goal up to 4000; its lead an
--                  active office person when named or changed; its outside company, when it has one, a customer, brand,
--                  supplier or subcontractor of the tenant, tenant-wide or of the project's company, neither blocked nor
--                  archived (a season of the company: the foreign key).
--   ProjectLink    its party is its project's, copied by the database at insert (the partner policy's key; the app never writes
--                  it); the key `link:<projectId>:<recordType>:<recordId>` (one link per project and record: a unique index;
--                  the isolation tests' copies add a `-…` suffix); the record one of the kinds a project links (Style,
--                  SampleRound, Quote, SalesOrder, PurchaseOrder, SubcontractOrder, ChangeRequest, Certificate, Inquiry,
--                  Shipment, MeasurementProfile), a row of the tenant (an office session reads every one, so a record it
--                  cannot find is not one), of the project's company or tenant-wide, and of the project's outside company or
--                  of none (an office-only project links only records of none: PROJ.linked-F03); a note of one line (1 to
--                  500); added and removed only while the project is not CLOSED; never changed.
--   linked records a later change of a linked record's company or outside company (a style made a brand's private label, a
--                  prospect's request matched to its customer) that would leave it in a project of another company is refused
--                  until it is unlinked: one trigger per linkable table, on its party and company columns only.
--   RecordFollower a portal person follows only as a member of a project of their own party (partyId: theirs, exactly when
--                  the person is a portal user; the project's outside company), added by the office (reason ADDED); an office
--                  person's row names no party; ADDED names who added them (createdById, someone else); the party never
--                  changes (the W2a guard keeps the record, person, reason and adder).
--   Thread         a project's thread names the project's own outside company, or none for an office-only project (its
--                  shared messages reach that company only): checked when it is made and when its party is set.
--
-- As every guard: a refusal is a check_violation (SQLSTATE 23514) in words, which name no party (an office message, neutral
-- toward customers); the checks are AFTER triggers (the policies speak first), but the number guard, the copy of a link's party
-- and the refused change or removal of a link (BEFORE). No earlier function is redefined. No row is moved: nothing names a
-- project before this wave.
--
-- USED FROM EARLIER WAVES, as they are: "factory_document_number_guard" (…_numbering_floor_documents_guards),
-- "factory_recall_words_ok", "factory_recall_not_future" (…_recall_claims_w2b_guards), "factory_privacy_ops_key_ok"
-- (…_privacy_integration_w2b_guards).

-- =====================================================================================================================
-- Project: its number, from its company's PROJECT series.
CREATE TRIGGER "Project_number" BEFORE INSERT OR UPDATE ON "Project"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('project', 'PROJECT');

-- Project: the state machine, the words and who it names.
CREATE FUNCTION "factory_project_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  closing CONSTANT text[] := ARRAY['status', 'outcome', 'outcomeNote', 'closedAt', 'closedById', 'version', 'updatedAt'];
  loose CONSTANT text[] := ARRAY['version', 'updatedAt'];
  user_audience text;
  user_status text;
  party_roles text[];
  party_company uuid;
  party_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' OR NEW."outcome" IS NOT NULL OR NEW."outcomeNote" IS NOT NULL OR NEW."closedAt" IS NOT NULL OR NEW."closedById" IS NOT NULL THEN
      RAISE EXCEPTION 'projects: project % is made ACTIVE, not closed and with no outcome', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."number", NEW."partyId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."number", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'projects: the company, number, outside company and creation of project % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'ACTIVE' AND NEW."status" IN ('ON_HOLD', 'CLOSED'))
                OR (OLD."status" = 'ON_HOLD' AND NEW."status" IN ('ACTIVE', 'CLOSED'))
                OR (OLD."status" = 'CLOSED' AND NEW."status" = 'ACTIVE')) THEN
      RAISE EXCEPTION 'projects: project % cannot move from % to % (a closed project is reopened ACTIVE)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND NEW."status" = 'CLOSED' AND (to_jsonb(NEW) - loose) IS DISTINCT FROM (to_jsonb(OLD) - loose) THEN
      RAISE EXCEPTION 'projects: project % is CLOSED and never changes; reopen it first', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND NEW."status" <> 'CLOSED' AND (to_jsonb(NEW) - closing) IS DISTINCT FROM (to_jsonb(OLD) - closing) THEN
      RAISE EXCEPTION 'projects: project % is reopened on its own; its other details change after', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Every row: the words.
  IF NOT "factory_recall_words_ok"(NEW."name", 200, false) OR NOT "factory_recall_words_ok"(NEW."goal", 4000, true) THEN
    RAISE EXCEPTION 'projects: project % has a name of one line (1 to 200 characters) and a goal up to 4000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Closed exactly with its outcome, its line and when; by whom only with when.
  IF (NEW."status" = 'CLOSED') <> (NEW."outcome" IS NOT NULL) OR (NEW."status" = 'CLOSED') <> (NEW."outcomeNote" IS NOT NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."closedAt" IS NULL AND NEW."closedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'projects: project % is CLOSED exactly with its outcome (DONE or STOPPED), its one line and when it closed', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."outcomeNote", 500, false) THEN
    RAISE EXCEPTION 'projects: the outcome of project % is said in one line of 1 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."closedAt" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt")
     AND (NOT "factory_recall_not_future"(NEW."closedAt") OR NEW."closedAt" < NEW."createdAt") THEN
    RAISE EXCEPTION 'projects: project % was closed at a time not before it was made and not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Who leads it (an office session sees every person of the tenant).
  IF TG_OP = 'INSERT' OR NEW."leadId" IS DISTINCT FROM OLD."leadId" THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."leadId";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'projects: project % is led by an active office person, not one that is % (%)', NEW."id", user_status, user_audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Its outside company, chosen when it is made.
  IF TG_OP = 'INSERT' AND NEW."partyId" IS NOT NULL THEN
    SELECT p."roles"::text[], p."companyId", p."status"::text INTO party_roles, party_company, party_status
      FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND NOT (coalesce(party_roles, ARRAY[]::text[]) && ARRAY['CUSTOMER', 'BRAND', 'SUPPLIER', 'SUBCONTRACTOR']) THEN
      RAISE EXCEPTION 'projects: project % is shared with a customer, a brand, a supplier or a subcontractor, or with nobody outside', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND party_status IN ('BLOCKED', 'ARCHIVED') THEN
      RAISE EXCEPTION 'projects: project % cannot be shared with a company that is %', NEW."id", lower(party_status)
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND party_company IS NOT NULL AND party_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'projects: project % is shared with a company of its own company''s, or of every company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Project_guard" AFTER INSERT OR UPDATE ON "Project"
  FOR EACH ROW EXECUTE FUNCTION "factory_project_guard"();

-- =====================================================================================================================
-- What a project may link: the kinds of record, and where each table says whose a record is.
CREATE FUNCTION "factory_project_link_columns"(record_type text, OUT party_column text, OUT company_column text)
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE record_type
           WHEN 'Style' THEN 'brandPartyId'
           WHEN 'Certificate' THEN 'holderPartyId'
           WHEN 'SampleRound' THEN 'partyId'
           WHEN 'Quote' THEN 'partyId'
           WHEN 'SalesOrder' THEN 'partyId'
           WHEN 'PurchaseOrder' THEN 'partyId'
           WHEN 'SubcontractOrder' THEN 'partyId'
           WHEN 'ChangeRequest' THEN 'partyId'
           WHEN 'Inquiry' THEN 'partyId'
           WHEN 'Shipment' THEN 'partyId'
           WHEN 'MeasurementProfile' THEN 'partyId'
         END,
         CASE WHEN record_type = 'MeasurementProfile' THEN NULL
              WHEN record_type IN ('Style', 'Certificate', 'SampleRound', 'Quote', 'SalesOrder', 'PurchaseOrder', 'SubcontractOrder',
                                   'ChangeRequest', 'Inquiry', 'Shipment') THEN 'companyId'
         END
$$;

-- A linkable record as its table says: known = a row of the tenant this session reads; its company (null: tenant-wide, or a
-- table with none) and its party (null: of none).
CREATE FUNCTION "factory_project_link_record"(tenant uuid, record_type text, record uuid, OUT known boolean, OUT company uuid, OUT party uuid)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  columns record;
  seen integer;
BEGIN
  known := false;
  company := NULL;
  party := NULL;
  SELECT c.party_column, c.company_column INTO columns FROM "factory_project_link_columns"(record_type) c;
  IF columns.party_column IS NULL OR record IS NULL THEN
    RETURN;
  END IF;
  EXECUTE format('SELECT %s, %I FROM %I WHERE "tenantId" = $1 AND "id" = $2',
                 CASE WHEN columns.company_column IS NULL THEN 'NULL::uuid' ELSE format('%I', columns.company_column) END,
                 columns.party_column, record_type)
    INTO company, party USING tenant, record;
  GET DIAGNOSTICS seen = ROW_COUNT;
  known := seen > 0;
END
$$;

-- ProjectLink: its party is its project's (BEFORE: the app never writes it).
CREATE FUNCTION "factory_project_link_party"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."partyId" := (SELECT p."partyId" FROM "Project" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."projectId");
  RETURN NEW;
END
$$;
CREATE TRIGGER "ProjectLink_party" BEFORE INSERT ON "ProjectLink"
  FOR EACH ROW EXECUTE FUNCTION "factory_project_link_party"();

-- ProjectLink: never changed; removed only while its project is not CLOSED.
CREATE FUNCTION "factory_project_link_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'projects: link % is never changed; remove it and link the record again', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT p."status"::text INTO project_status FROM "Project" p WHERE p."tenantId" = OLD."tenantId" AND p."id" = OLD."projectId";
  IF project_status = 'CLOSED' THEN
    RAISE EXCEPTION 'projects: the links of a CLOSED project stay as they are; reopen it first'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER "ProjectLink_fixed" BEFORE UPDATE OR DELETE ON "ProjectLink"
  FOR EACH ROW EXECUTE FUNCTION "factory_project_link_fixed"();

-- ProjectLink: a record of the project's company and outside company (or of none), linked once, while the project is open.
CREATE FUNCTION "factory_project_link_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project record;
  linked record;
BEGIN
  SELECT p."companyId", p."partyId", p."status"::text AS status INTO project FROM "Project" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."projectId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'projects: link % names a project of this session''s', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF project.status = 'CLOSED' THEN
    RAISE EXCEPTION 'projects: a CLOSED project links no new record; reopen it first'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."partyId" IS DISTINCT FROM project."partyId" THEN
    RAISE EXCEPTION 'projects: link % carries its project''s outside company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_key_ok"(NEW."key", concat('link:', NEW."projectId", ':', NEW."recordType", ':', NEW."recordId")) THEN
    RAISE EXCEPTION 'projects: the key of link % is link:<projectId>:<recordType>:<recordId> (a record is linked once)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 500, false) THEN
    RAISE EXCEPTION 'projects: the note of link % is one line of 1 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT c.party_column FROM "factory_project_link_columns"(NEW."recordType") c) IS NULL THEN
    RAISE EXCEPTION 'projects: a project links styles, sample rounds, quotes, orders, purchase and subcontract orders, change requests, certificates, requests, shipments and measurement profiles, not a %', NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.known, r.company, r.party INTO linked FROM "factory_project_link_record"(NEW."tenantId", NEW."recordType", NEW."recordId") r;
  IF NOT linked.known THEN
    RAISE EXCEPTION 'projects: link % names a % that is not a record of the tenant', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF linked.company IS NOT NULL AND linked.company <> project."companyId" THEN
    RAISE EXCEPTION 'projects: a project links records of its own company (or of every company), not this %', NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF linked.party IS NOT NULL AND linked.party IS DISTINCT FROM project."partyId" THEN
    RAISE EXCEPTION 'projects: this % belongs to another company; it cannot join this project (a project links records of its own outside company, or of none)', NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "ProjectLink_guard" AFTER INSERT ON "ProjectLink"
  FOR EACH ROW EXECUTE FUNCTION "factory_project_link_guard"();

-- A linked record that changes its company or outside company stays only in projects it still fits.
-- TG_ARGV[0]: the table's party column; TG_ARGV[1]: its company column, or '' when it has none.
CREATE FUNCTION "factory_project_linked_record_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_now CONSTANT jsonb := to_jsonb(NEW);
  new_party uuid := (row_now ->> TG_ARGV[0])::uuid;
  new_company uuid := CASE WHEN TG_ARGV[1] = '' THEN NULL ELSE (row_now ->> TG_ARGV[1])::uuid END;
BEGIN
  IF EXISTS (SELECT 1 FROM "ProjectLink" l
               JOIN "Project" p ON p."tenantId" = l."tenantId" AND p."id" = l."projectId"
              WHERE l."tenantId" = NEW."tenantId" AND l."recordType" = TG_TABLE_NAME AND l."recordId" = NEW."id"
                AND ((new_party IS NOT NULL AND new_party IS DISTINCT FROM p."partyId")
                     OR (new_company IS NOT NULL AND new_company <> p."companyId"))) THEN
    RAISE EXCEPTION 'projects: % % is linked to a project of another company; unlink it there first', TG_TABLE_NAME, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

DO $$
DECLARE
  linkable text;
  columns record;
BEGIN
  FOREACH linkable IN ARRAY ARRAY['Style', 'Certificate', 'SampleRound', 'Quote', 'SalesOrder', 'PurchaseOrder', 'SubcontractOrder',
                                  'ChangeRequest', 'Inquiry', 'Shipment', 'MeasurementProfile'] LOOP
    SELECT c.party_column, c.company_column INTO columns FROM "factory_project_link_columns"(linkable) c;
    IF columns.company_column IS NULL THEN
      EXECUTE format('CREATE TRIGGER %I AFTER UPDATE OF %I ON %I FOR EACH ROW WHEN (NEW.%I IS DISTINCT FROM OLD.%I) '
                     'EXECUTE FUNCTION "factory_project_linked_record_check"(%L, %L)',
                     linkable || '_project_links', columns.party_column, linkable, columns.party_column, columns.party_column,
                     columns.party_column, '');
    ELSE
      EXECUTE format('CREATE TRIGGER %I AFTER UPDATE OF %I, %I ON %I FOR EACH ROW WHEN (NEW.%I IS DISTINCT FROM OLD.%I OR NEW.%I IS DISTINCT FROM OLD.%I) '
                     'EXECUTE FUNCTION "factory_project_linked_record_check"(%L, %L)',
                     linkable || '_project_links', columns.party_column, columns.company_column, linkable,
                     columns.party_column, columns.party_column, columns.company_column, columns.company_column,
                     columns.party_column, columns.company_column);
    END IF;
  END LOOP;
END
$$;

-- =====================================================================================================================
-- RecordFollower: a portal person follows only as a member of a project of their own party, added by the office; ADDED names
-- who added them.
CREATE FUNCTION "factory_record_follower_party_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  user_audience text;
  user_party uuid;
  project_party uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."partyId" IS DISTINCT FROM OLD."partyId" THEN
      RAISE EXCEPTION 'followers: the party of follower % never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW."reason"::text = 'ADDED' AND (NEW."createdById" IS NULL OR NEW."createdById" = NEW."userId") THEN
    RAISE EXCEPTION 'followers: follower % was ADDED by someone else, who is named (createdById); following by one''s own choice is CHOSE', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT u."audience"::text, u."partyId" INTO user_audience, user_party FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'followers: follower % names a person who is not one of this session''s people', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF user_audience = 'OFFICE' AND NEW."partyId" IS NULL THEN
    RETURN NULL;
  END IF;
  IF user_audience <> 'PARTNER' OR user_party IS NULL OR NEW."partyId" IS DISTINCT FROM user_party THEN
    RAISE EXCEPTION 'followers: follower % is an office person (no party) or a portal person with their own party', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."recordType" = 'Project' THEN
    SELECT p."partyId" INTO project_party FROM "Project" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."recordId";
  END IF;
  IF NEW."recordType" <> 'Project' OR project_party IS NULL OR project_party <> NEW."partyId" THEN
    RAISE EXCEPTION 'followers: a portal person follows only a project shared with their own company, as a member'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reason"::text <> 'ADDED' THEN
    RAISE EXCEPTION 'followers: a portal person is a project member only when the office ADDED them, not %', NEW."reason"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "RecordFollower_party_check" AFTER INSERT OR UPDATE OF "partyId" ON "RecordFollower"
  FOR EACH ROW EXECUTE FUNCTION "factory_record_follower_party_check"();

-- =====================================================================================================================
-- Thread: a project's thread names the project's outside company, or none.
CREATE FUNCTION "factory_thread_project_party_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_party uuid;
BEGIN
  SELECT p."partyId" INTO project_party FROM "Project" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."recordId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'threads: thread % is the thread of a project of the tenant', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."partyId" IS DISTINCT FROM project_party THEN
    RAISE EXCEPTION 'threads: the thread of a project is shared with the project''s own outside company, or with nobody outside'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "Thread_project_party" AFTER INSERT OR UPDATE OF "partyId", "recordType", "recordId" ON "Thread"
  FOR EACH ROW WHEN (NEW."recordType" = 'Project')
  EXECUTE FUNCTION "factory_thread_project_party_check"();
