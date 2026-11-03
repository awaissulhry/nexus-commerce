-- Written by hand (Prisma does not model triggers, partial indexes or deferred constraint triggers), after the generated
-- 202610317900_quality_problems_w2b_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- W2b schema wave 11/16 (B-W2b-79): the quality records that are not inspections: CAPA and 8D with their sources and actions,
-- cause codes, a defect charged to its operation, NCR cost lines and concessions, hold groups, the result and four-eyes
-- settings, quality alert rules, the complaint's investigation and answer letter, the new generated documents (features
-- QHS-004, QHS-075, QHS-085, QHS-086, QHS-087, QHS-093, QHS-094, QHS-096, QHS-116, QHS-154, QHS-300, MES-127).
-- apps/factory-api's modules check all of this first, in words; these rules hold for every login, the owner included. Every
-- refusal is a check_violation (SQLSTATE 23514), but the number's (the shared factory_document_number_guard).
--
-- As in every guards migration: the tenant and site of a row are held by the policies (USING and WITH CHECK) and the
-- references, not here (no trigger compares "tenantId" or "siteId" of the row it guards, so a row moved out of a
-- session's scope meets row-level security first); a rule that reads another row skips a row this session cannot see
-- (another tenant's or site's: the policies refuse that write anyway); an UPDATE that changes nothing passes. A trigger
-- reads only tables (and columns) the role that fires it may read, and locks a row FOR SHARE only where that role may
-- update it. "Everything but these columns" is compared as jsonb, so a column added later is frozen too unless a later
-- migration names it.
--
-- Earlier functions redefined here, each its whole body:
--   factory_nonconformance_guard    (…_quality_plant_w2a_guards): the cause, the CAPA, and a DECIDED or CLOSED NCR gets its
--                                   CAPA once.
--   factory_quality_release_check   (…_quality_final_release_guards): OVERRIDE and CUSTOMER apply while the settings' list names
--                                   them. The default is both, so nothing changes until a person changes the list.
--   factory_generated_document_check (…_followups_stock_w2b_guards): the new kinds, and a document of a record with no site.

CREATE FUNCTION "factory_quality_problems_w2b_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'quality problems: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['Capa', 'CapaSource', 'CapaAction', 'CauseCode', 'QualityHoldGroup', 'NcrCostLine', 'NcrConcession', 'QualityAlertRule'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_quality_problems_w2b_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- =====================================================================================================================
-- CAPA and 8D (capa.prisma)

-- Capa (QHS-093)
--   INSERT     at its type's first stage (PLAN, D1), nothing closed or cancelled.
--   UPDATE     the company, type and creation never change, nor the number (its own trigger); CLOSED and CANCELLED never
--              change; inside its type's stages it moves either way; CLOSED only from its last stage (CHECK, D8), with
--              at least one action, every one DONE or CANCELLED and one DONE (write the actions first: this reads them
--              at the UPDATE; each action holds the CAPA FOR SHARE, so the two take turns); CANCELLED from any stage.
--   every row  a title; the problem's words not blank when given; the team a list of { userId, role }, each person once; the
--              customer has the CUSTOMER or BRAND role; closed (time, who, words) exactly when CLOSED; cancelled (time,
--              reason) exactly when CANCELLED.
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_capa_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  stages text[];
  actions bigint;
  open_actions bigint;
  done_actions bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: CAPA % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  stages := CASE WHEN NEW."type" = 'CAPA' THEN ARRAY['PLAN', 'ACT', 'CHECK'] ELSE ARRAY['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'] END;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> stages[1] THEN
      RAISE EXCEPTION 'quality: a % starts at %, not % (CAPA %)', NEW."type", stages[1], NEW."status", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."type", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."type", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, type and creation of CAPA % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: CAPA % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT (NEW."status"::text = ANY (stages) OR NEW."status" = 'CANCELLED'
                OR (NEW."status" = 'CLOSED' AND OLD."status"::text = stages[cardinality(stages)])) THEN
      RAISE EXCEPTION 'quality: CAPA % cannot move from % to % (its stages run %, and it closes from the last one)', OLD."id", OLD."status", NEW."status", array_to_string(stages, ', ')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."title") = ''
     OR btrim(coalesce(NEW."problemWhat", 'x')) = '' OR btrim(coalesce(NEW."problemWhere", 'x')) = ''
     OR btrim(coalesce(NEW."problemWhen", 'x')) = '' OR btrim(coalesce(NEW."problemHowMany", 'x')) = '' THEN
    RAISE EXCEPTION 'quality: CAPA % has a title, and the words of its problem are not blank when given', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."team" IS DISTINCT FROM OLD."team" THEN
    IF jsonb_typeof(NEW."team") <> 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."team") m
                   WHERE jsonb_typeof(m) <> 'object' OR coalesce(m ->> 'userId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      OR btrim(coalesce(m ->> 'role', '')) = '')
       OR (SELECT count(*) FROM jsonb_array_elements(NEW."team") m) <> (SELECT count(DISTINCT m ->> 'userId') FROM jsonb_array_elements(NEW."team") m) THEN
      RAISE EXCEPTION 'quality: the team of CAPA % is a list of { "userId", "role" }, each person once', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."customerId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."customerId" IS DISTINCT FROM OLD."customerId")
     AND EXISTS (SELECT 1 FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."customerId"
                  AND NOT ('CUSTOMER' = ANY (p."roles") OR 'BRAND' = ANY (p."roles"))) THEN
    RAISE EXCEPTION 'quality: CAPA % is written for a party that is no customer or brand', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closedById" IS NOT NULL)
     OR (NEW."status" = 'CLOSED') <> (btrim(coalesce(NEW."closeNote", '')) <> '')
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'quality: CAPA % is % with the wrong ending: closed (time, who, words) exactly when CLOSED, cancelled (time, reason) exactly when CANCELLED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."status" = 'CLOSED' AND OLD."status" <> 'CLOSED' THEN
    SELECT count(*), count(*) FILTER (WHERE a."status" = 'OPEN'), count(*) FILTER (WHERE a."status" = 'DONE')
      INTO actions, open_actions, done_actions
      FROM "CapaAction" a WHERE a."tenantId" = NEW."tenantId" AND a."capaId" = NEW."id";
    IF done_actions = 0 OR open_actions > 0 THEN
      RAISE EXCEPTION 'quality: CAPA % closes once its actions are done (% action(s), % open, % done; QHS-096)', NEW."id", actions, open_actions, done_actions
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Capa_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Capa"
  FOR EACH ROW EXECUTE FUNCTION "factory_capa_guard"();

-- Numbered like Inspection (…_numbering_floor_documents_guards): given when the row is made, never changed.
CREATE TRIGGER "Capa_number" BEFORE INSERT OR UPDATE ON "Capa"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('CAPA', 'CAPA');

-- The record a CAPA's rows hang on: its status, its row held FOR SHARE, so a closing waits for a write in flight and a
-- write after it sees it. Null: a row this session cannot see.
CREATE FUNCTION "factory_capa_open_status"(tenant uuid, capa uuid, what text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  SELECT c."status"::text INTO state FROM "Capa" c WHERE c."tenantId" = tenant AND c."id" = capa FOR SHARE;
  IF state IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'quality: CAPA % is %; its % never change', capa, state, what
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN state;
END
$$;

-- CapaSource (QHS-087)
--   INSERT, DELETE  while the CAPA is open (its row FOR SHARE).
--   INSERT          a Nonconformance or a Complaint of the CAPA's company, or an Audit (no table yet: named by its id).
--   DELETE          refused while the NCR still names the CAPA: clear Nonconformance.capaId first.
--   UPDATE          refused (removed and made again). TRUNCATE refused.
CREATE FUNCTION "factory_capa_source_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  capa_company uuid;
  record_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'quality: source % of a CAPA is never changed; remove it and add it again', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM "factory_capa_open_status"(OLD."tenantId", OLD."capaId", 'sources');
    IF OLD."recordType" = 'Nonconformance'
       AND EXISTS (SELECT 1 FROM "Nonconformance" n WHERE n."tenantId" = OLD."tenantId" AND n."id" = OLD."recordId" AND n."capaId" = OLD."capaId") THEN
      RAISE EXCEPTION 'quality: NCR % still names CAPA %; clear it there first', OLD."recordId", OLD."capaId"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM "factory_capa_open_status"(NEW."tenantId", NEW."capaId", 'sources');
  IF NEW."recordType" NOT IN ('Nonconformance', 'Complaint', 'Audit') THEN
    RAISE EXCEPTION 'quality: source % of a CAPA is an NCR (Nonconformance), a Complaint or an Audit, not %', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."recordType" <> 'Audit' THEN
    SELECT c."companyId" INTO capa_company FROM "Capa" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."capaId";
    IF NEW."recordType" = 'Nonconformance' THEN
      SELECT n."companyId" INTO record_company FROM "Nonconformance" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."recordId";
    ELSE
      SELECT p."companyId" INTO record_company FROM "Complaint" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."recordId";
    END IF;
    IF capa_company IS NOT NULL AND record_company IS DISTINCT FROM capa_company THEN
      RAISE EXCEPTION 'quality: source % of CAPA % is a % of the CAPA''s company (% is not)', NEW."id", NEW."capaId", NEW."recordType", NEW."recordId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CapaSource_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CapaSource"
  FOR EACH ROW EXECUTE FUNCTION "factory_capa_source_guard"();

-- CapaAction (QHS-096)
--   INSERT     OPEN, nothing reminded, escalated or ended; while the CAPA is open (its row FOR SHARE).
--   UPDATE     while the CAPA is open; the CAPA, number and creation never change; OPEN → DONE | CANCELLED, both final, and an
--              ended action never changes; the reminders only count up, with a later time; the escalation is set once.
--   every row  says what to do; reminders from 0, a time exactly with one; DONE exactly with its time and who, and its evidence
--              when it gets there: a note or a file of the action (StoredFile recordType "CapaAction"); CANCELLED exactly
--              with its reason.
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_capa_action_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: action % of a CAPA is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."remindersSent" <> 0 OR NEW."lastRemindedAt" IS NOT NULL OR NEW."escalatedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'quality: action % of a CAPA starts OPEN, nothing reminded or escalated', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."capaId", NEW."seq", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."capaId", OLD."seq", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: action % never moves to another CAPA or another number; its creation never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: action % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."remindersSent" < OLD."remindersSent" OR NEW."lastRemindedAt" < OLD."lastRemindedAt"
       OR (NEW."remindersSent" > OLD."remindersSent" AND NEW."lastRemindedAt" IS NOT DISTINCT FROM OLD."lastRemindedAt") THEN
      RAISE EXCEPTION 'quality: the reminders of action % only count up, each with a later time', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."escalatedAt" IS NOT NULL AND NEW."escalatedAt" IS DISTINCT FROM OLD."escalatedAt" THEN
      RAISE EXCEPTION 'quality: action % escalated once, at %', OLD."id", OLD."escalatedAt"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM "factory_capa_open_status"(NEW."tenantId", NEW."capaId", 'actions');
  IF btrim(NEW."description") = '' OR NEW."remindersSent" < 0 OR (NEW."remindersSent" > 0) <> (NEW."lastRemindedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: action % says what to do, and counts its reminders with the last one''s time', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DONE') <> (NEW."doneAt" IS NOT NULL) OR (NEW."status" = 'DONE') <> (NEW."doneById" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'quality: action % is % with the wrong ending: done exactly with its time and who, cancelled exactly with its reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'DONE' AND (TG_OP = 'INSERT' OR OLD."status" <> 'DONE')
     AND btrim(coalesce(NEW."evidenceNote", '')) = ''
     AND NOT EXISTS (SELECT 1 FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."recordType" = 'CapaAction' AND f."recordId" = NEW."id") THEN
    RAISE EXCEPTION 'quality: action % is done with its evidence: a note or a file of the action (QHS-096)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CapaAction_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CapaAction"
  FOR EACH ROW EXECUTE FUNCTION "factory_capa_action_guard"();

-- =====================================================================================================================
-- Cause codes (holds.prisma, quality.prisma, ncr.prisma)

-- CauseCode (QHS-004)
--   UPDATE     the code, the process and the creation never change (inspection defects, NCRs and reports keep them).
--   every row  its words (as a reason list's).
--   DELETE     a code nothing names (the references refuse the rest: retire it). TRUNCATE refused.
CREATE FUNCTION "factory_cause_code_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."code", NEW."process", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."code", OLD."process", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the code, the process and the creation of cause code % never change (retire it and add another)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_quality_plant_words_ok"(NEW."code", NEW."labelIt", NEW."labelEn", NEW."labelI18n", NULL, NULL) THEN
    RAISE EXCEPTION 'quality: cause code % has a code without spaces, Italian and English words, and its other languages as { "<language>": "<words>" }', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CauseCode_guard" BEFORE INSERT OR UPDATE ON "CauseCode"
  FOR EACH ROW EXECUTE FUNCTION "factory_cause_code_guard"();

-- InspectionDefect: the cause is an active code when it is set. W1's factory_inspection_defect_guard keeps the rest (only
-- while OPEN).
CREATE FUNCTION "factory_inspection_defect_cause_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."causeCodeId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."causeCodeId" IS DISTINCT FROM OLD."causeCodeId")
     AND EXISTS (SELECT 1 FROM "CauseCode" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."causeCodeId" AND NOT c."active") THEN
    RAISE EXCEPTION 'quality: defect % names a retired cause code; an inspection names an active one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InspectionDefect_cause_guard" BEFORE INSERT OR UPDATE ON "InspectionDefect"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_defect_cause_guard"();

-- =====================================================================================================================
-- Nonconformances (ncr.prisma)

-- Nonconformance (redefines …_quality_plant_w2a_guards' function; the trigger stays): its rules, and
--   the cause   an active code when it is set; part of the problem, so read-only once DECIDED.
--   the CAPA    the CAPA lists the NCR as a source first (the reference keeps it to the company). While OPEN or CONTAINED it
--               changes freely; once DECIDED or CLOSED it is given once and kept; a CANCELLED NCR gets none. On a CLOSED NCR
--               that one change, with its version and update time, is all that passes.
CREATE OR REPLACE FUNCTION "factory_nonconformance_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  decided_movable CONSTANT text[] := ARRAY['tenantId', 'siteId', 'stage', 'closedAt', 'closedById', 'closeNote', 'closeSignatureSha256', 'ownerId',
                                           'containmentDueAt', 'capaId', 'version', 'updatedAt'];
  escalated_late CONSTANT text[] := ARRAY['tenantId', 'siteId', 'capaId', 'version', 'updatedAt'];
  final_movable text[];
  actions bigint;
  open_actions bigint;
  done_actions bigint;
  decided numeric;
  unapproved bigint;
  undone bigint;
  library record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: NCR % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."stage" <> 'OPEN' OR NEW."containedAt" IS NOT NULL OR NEW."decidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'quality: NCR % starts OPEN, nothing contained or decided', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, number and creation of NCR % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b (B-W2b-79): a CLOSED NCR gets its CAPA once (a repeat is often seen after the first one closed), and nothing else.
    final_movable := CASE WHEN OLD."stage" = 'CLOSED' AND OLD."capaId" IS NULL AND NEW."capaId" IS NOT NULL THEN escalated_late ELSE kept END;
    IF OLD."stage" IN ('CLOSED', 'CANCELLED') AND (to_jsonb(NEW) - final_movable) IS DISTINCT FROM (to_jsonb(OLD) - final_movable) THEN
      RAISE EXCEPTION 'quality: NCR % is %; it never changes', OLD."id", OLD."stage"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."stage" = 'DECIDED' AND OLD."capaId" IS NOT NULL AND NEW."capaId" IS DISTINCT FROM OLD."capaId" THEN
      RAISE EXCEPTION 'quality: NCR % is DECIDED; the CAPA it was escalated to stays', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."stage" <> OLD."stage"
       AND NOT ((OLD."stage" = 'OPEN' AND NEW."stage" IN ('CONTAINED', 'CANCELLED'))
                OR (OLD."stage" = 'CONTAINED' AND NEW."stage" IN ('DECIDED', 'CANCELLED'))
                OR (OLD."stage" = 'DECIDED' AND NEW."stage" = 'CLOSED')) THEN
      RAISE EXCEPTION 'quality: NCR % cannot move from % to % (OPEN → CONTAINED → DECIDED → CLOSED; cancelled while OPEN or CONTAINED)', OLD."id", OLD."stage", NEW."stage"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."stage" = 'DECIDED' AND (to_jsonb(NEW) - decided_movable) IS DISTINCT FROM (to_jsonb(OLD) - decided_movable) THEN
      RAISE EXCEPTION 'quality: NCR % is DECIDED; its problem is read-only now (only its closing, owner and containment due time change)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."containedAt" IS NOT NULL AND NEW."containedAt" IS DISTINCT FROM OLD."containedAt")
       OR (OLD."decidedAt" IS NOT NULL AND NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt")
       OR (NEW."stage" = OLD."stage" AND (NEW."containedAt" IS DISTINCT FROM OLD."containedAt" OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt")) THEN
      RAISE EXCEPTION 'quality: NCR % records when it was contained and decided in those moves, once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."number") = '' OR btrim(NEW."title") = '' OR NEW."quantityAffected" <= 0 OR coalesce(NEW."quantitySuspect", 0) < 0 THEN
    RAISE EXCEPTION 'quality: NCR % has a number, a title, a quantity affected above 0 and a quantity suspect from 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."sourceType" IS NULL) <> (NEW."sourceId" IS NULL) OR btrim(coalesce(NEW."sourceType", '-')) = ''
     OR (NEW."foundById" IS NOT NULL AND NEW."foundByWorkerId" IS NOT NULL)
     OR (NEW."colourwayId" IS NOT NULL AND NEW."styleId" IS NULL) OR (NEW."lotId" IS NOT NULL AND NEW."itemId" IS NULL)
     OR (NEW."zone" IS NOT NULL AND (btrim(NEW."zone") = '' OR NEW."zone" ~ '\s')) THEN
    RAISE EXCEPTION 'quality: NCR % names its source as a type and an id or neither, at most one finder, a colourway with its style, a lot with its item and a zone id without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."stage" IN ('CONTAINED', 'DECIDED', 'CLOSED') AND NEW."containedAt" IS NULL) OR (NEW."stage" = 'OPEN' AND NEW."containedAt" IS NOT NULL)
     OR (NEW."stage" IN ('DECIDED', 'CLOSED')) <> (NEW."decidedAt" IS NOT NULL)
     OR (NEW."stage" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL)
     OR (NEW."stage" = 'CLOSED') <> (NEW."closedById" IS NOT NULL)
     OR (NEW."stage" = 'CLOSED') <> (btrim(coalesce(NEW."closeSignatureSha256", '')) <> '')
     OR (NEW."stage" <> 'CLOSED' AND NEW."closeNote" IS NOT NULL)
     OR (NEW."stage" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."stage" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'quality: NCR % is % with the wrong times: contained from CONTAINED on, decided from DECIDED on, closed (time, who, signature) exactly when CLOSED, cancelled (time, reason) exactly when CANCELLED', NEW."id", NEW."stage"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."defectCodeId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."defectCodeId" IS DISTINCT FROM OLD."defectCodeId") THEN
    SELECT d."code", d."parentId", d."active" INTO library FROM "DefectCode" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."defectCodeId";
    IF FOUND THEN
      IF library."parentId" IS NULL OR NOT library."active" THEN
        RAISE EXCEPTION 'quality: NCR % names defect code %, which is a category or retired; an NCR names an active defect of the library', NEW."id", library."code"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  -- W2b (B-W2b-79): the cause is an active code when it is set; the CAPA lists the NCR as a source first (QHS-087).
  IF NEW."causeCodeId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."causeCodeId" IS DISTINCT FROM OLD."causeCodeId")
     AND EXISTS (SELECT 1 FROM "CauseCode" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."causeCodeId" AND NOT c."active") THEN
    RAISE EXCEPTION 'quality: NCR % names a retired cause code; an NCR names an active one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."capaId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."capaId" IS DISTINCT FROM OLD."capaId")
     AND NOT EXISTS (SELECT 1 FROM "CapaSource" s
                      WHERE s."tenantId" = NEW."tenantId" AND s."capaId" = NEW."capaId" AND s."recordType" = 'Nonconformance' AND s."recordId" = NEW."id") THEN
    RAISE EXCEPTION 'quality: NCR % is escalated to CAPA %, which does not list it as a source; add the source first', NEW."id", NEW."capaId"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."stage" <> OLD."stage" THEN
    IF NEW."stage" = 'CONTAINED' THEN
      SELECT count(*), count(*) FILTER (WHERE a."status" = 'OPEN'), count(*) FILTER (WHERE a."status" = 'DONE')
        INTO actions, open_actions, done_actions
        FROM "NcrContainmentAction" a WHERE a."tenantId" = NEW."tenantId" AND a."ncrId" = NEW."id";
      IF done_actions = 0 OR open_actions > 0 THEN
        RAISE EXCEPTION 'quality: NCR % is contained once its containment actions are done (% action(s), % open, % done; QHS-082)', NEW."id", actions, open_actions, done_actions
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."stage" = 'DECIDED' THEN
      SELECT coalesce(sum(l."quantity"), 0), count(*) FILTER (WHERE l."approvalRequired" AND l."approvedAt" IS NULL)
        INTO decided, unapproved
        FROM "NcrDispositionLine" l WHERE l."tenantId" = NEW."tenantId" AND l."ncrId" = NEW."id";
      IF decided <> NEW."quantityAffected" OR unapproved > 0 THEN
        RAISE EXCEPTION 'quality: NCR % is decided once its whole quantity is (% of % decided) and every decision that needs approval is approved (% waiting; QHS-083)', NEW."id", decided, NEW."quantityAffected", unapproved
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."stage" = 'CLOSED' THEN
      SELECT count(*) INTO undone FROM "NcrDispositionLine" l WHERE l."tenantId" = NEW."tenantId" AND l."ncrId" = NEW."id" AND l."doneAt" IS NULL;
      IF undone > 0 THEN
        RAISE EXCEPTION 'quality: NCR % closes once every decision is carried out (% waiting for its stock move or follow-up; QHS-090)', NEW."id", undone
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "QualityHold" h WHERE h."tenantId" = NEW."tenantId" AND h."ncrId" = NEW."id" AND h."status" = 'ACTIVE') THEN
        RAISE EXCEPTION 'quality: NCR % still decides a hold that is ACTIVE; release or close it first (QHS-090)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."stage" = 'CANCELLED' THEN
      IF EXISTS (SELECT 1 FROM "NcrDispositionLine" l WHERE l."tenantId" = NEW."tenantId" AND l."ncrId" = NEW."id" AND l."doneAt" IS NOT NULL) THEN
        RAISE EXCEPTION 'quality: NCR % has a decision carried out; it is closed, not cancelled', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- NcrCostLine (QHS-086)
--   INSERT, UPDATE, DELETE  while the NCR is neither CLOSED nor CANCELLED (its row FOR SHARE).
--   UPDATE                  the NCR, number, source, its record and the creation never change.
--   every row               the amount from 0; OTHER says what in words, words not blank when given; a COMPUTED line names
--                           its record (a type and an id), a TYPED line none.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_ncr_cost_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  part_of uuid;
  stage text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."ncrId", NEW."seq", NEW."source", NEW."recordType", NEW."recordId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."ncrId", OLD."seq", OLD."source", OLD."recordType", OLD."recordId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: cost line % never moves to another NCR or number; its source and creation never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  part_of := CASE WHEN TG_OP = 'DELETE' THEN OLD."ncrId" ELSE NEW."ncrId" END;
  SELECT n."stage"::text INTO stage FROM "Nonconformance" n
   WHERE n."tenantId" = CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END AND n."id" = part_of FOR SHARE;
  IF stage IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'quality: NCR % is %; its cost lines never change', part_of, stage
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW."amount" < 0 THEN
    RAISE EXCEPTION 'quality: cost line % has an amount from 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'OTHER' AND NEW."description" IS NULL) OR btrim(coalesce(NEW."description", 'x')) = '' THEN
    RAISE EXCEPTION 'quality: cost line % says what it is in words (OTHER), and its words are not blank when given', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."source" = 'COMPUTED') <> (NEW."recordType" IS NOT NULL) OR (NEW."recordType" IS NULL) <> (NEW."recordId" IS NULL)
     OR btrim(coalesce(NEW."recordType", 'x')) = '' OR NEW."recordType" ~ '\s' THEN
    RAISE EXCEPTION 'quality: cost line % is %: a computed line names its record (a type without spaces and an id), a typed line none', NEW."id", NEW."source"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "NcrCostLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NcrCostLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_ncr_cost_line_guard"();

-- NcrConcession (QHS-085)
--   INSERT     ASKED, nothing answered; while the NCR is neither CLOSED nor CANCELLED (its row FOR SHARE).
--   UPDATE     the NCR, number, customer, when and by whom it was asked and the creation never change; ASKED → ACCEPTED |
--              REFUSED, both final, and an answered concession never changes. The answer may come after the NCR closed.
--   every row  the ask and the proposal in words; the customer has the CUSTOMER or BRAND role; answered (time, the name of who
--              answered) exactly when not ASKED, why when REFUSED; nothing of an answer while ASKED; the answer's file is a
--              file of the row (StoredFile recordType "NcrConcession").
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_ncr_concession_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  stage text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: concession % is answered, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ASKED' THEN
      RAISE EXCEPTION 'quality: concession % starts ASKED', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT n."stage"::text INTO stage FROM "Nonconformance" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."ncrId" FOR SHARE;
    IF stage IN ('CLOSED', 'CANCELLED') THEN
      RAISE EXCEPTION 'quality: NCR % is %; no concession is asked any more', NEW."ncrId", stage
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."ncrId", NEW."seq", NEW."partyId", NEW."askedAt", NEW."askedById", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."ncrId", OLD."seq", OLD."partyId", OLD."askedAt", OLD."askedById", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the NCR, number, customer, asking and creation of concession % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'ASKED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: concession % is %; an answered concession never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."ask") = '' OR btrim(NEW."proposal") = '' THEN
    RAISE EXCEPTION 'quality: concession % says what is asked and what is proposed, in words', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."partyId" IS DISTINCT FROM OLD."partyId")
     AND EXISTS (SELECT 1 FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId"
                  AND NOT ('CUSTOMER' = ANY (p."roles") OR 'BRAND' = ANY (p."roles"))) THEN
    RAISE EXCEPTION 'quality: concession % is asked of a party that is no customer or brand', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ASKED') <> (NEW."answeredAt" IS NULL)
     OR (NEW."status" = 'ASKED') <> (btrim(coalesce(NEW."answeredBy", '')) = '')
     OR (NEW."status" = 'ASKED' AND (NEW."answer" IS NOT NULL OR NEW."answerFileId" IS NOT NULL OR NEW."recordedById" IS NOT NULL))
     OR (NEW."status" = 'REFUSED' AND btrim(coalesce(NEW."answer", '')) = '') THEN
    RAISE EXCEPTION 'quality: concession % is % with the wrong answer: when and the name of who answered exactly once answered, why when refused, nothing while asked', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."answerFileId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "StoredFile" f
                  WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."answerFileId" AND (f."recordType" <> 'NcrConcession' OR f."recordId" <> NEW."id")) THEN
    RAISE EXCEPTION 'quality: the answer of concession % is a file of the concession (recordType NcrConcession)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "NcrConcession_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NcrConcession"
  FOR EACH ROW EXECUTE FUNCTION "factory_ncr_concession_guard"();

-- =====================================================================================================================
-- A defect charged to its operation (production.prisma OperationScanDefect; append-only: the …_production_scan_records_guards
-- triggers). INSERT: the operation is of the work order of its scan, or of the scan its correction request corrects. Per
-- operation, no person: a charge per worker stays behind the art. 4 switch (B-W2b-99).
CREATE FUNCTION "factory_operation_scan_defect_cause_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scan_order uuid;
  charged_order uuid;
BEGIN
  IF NEW."causedAtOperationId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."scanId" IS NOT NULL THEN
    SELECT s."workOrderId" INTO scan_order FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."scanId";
  ELSE
    SELECT q."workOrderId" INTO scan_order FROM "ScanCorrectionRequest" q WHERE q."tenantId" = NEW."tenantId" AND q."siteId" = NEW."siteId" AND q."id" = NEW."correctionRequestId";
  END IF;
  SELECT o."workOrderId" INTO charged_order FROM "WorkOrderOperation" o WHERE o."tenantId" = NEW."tenantId" AND o."siteId" = NEW."siteId" AND o."id" = NEW."causedAtOperationId";
  -- Outside this session's scope the policies refuse the row.
  IF scan_order IS NOT NULL AND charged_order IS NOT NULL AND scan_order <> charged_order THEN
    RAISE EXCEPTION 'production: scan line % charges a defect to an operation of another work order', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OperationScanDefect_cause_check" BEFORE INSERT ON "OperationScanDefect"
  FOR EACH ROW EXECUTE FUNCTION "factory_operation_scan_defect_cause_check"();

-- =====================================================================================================================
-- Hold groups (holds.prisma)

-- QualityHoldGroup (QHS-075)
--   UPDATE     only the counts change (with the version and the update time): "Extend hold" adds holds and moves them.
--   every row  the source a type without spaces; a reason code without spaces; the counts { "<what>": <whole number from 0> }.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_quality_hold_group_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  movable CONSTANT text[] := ARRAY['tenantId', 'counts', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: hold group % is never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable) THEN
      RAISE EXCEPTION 'quality: of hold group % only the counts change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."sourceType") = '' OR NEW."sourceType" ~ '\s' OR btrim(NEW."reasonCode") = '' OR NEW."reasonCode" ~ '\s' THEN
    RAISE EXCEPTION 'quality: hold group % names its source''s type and its reason code, without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."counts") <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(NEW."counts") e
                 WHERE jsonb_typeof(e.value) <> 'number' OR (e.value #>> '{}') !~ '^[0-9]+$') THEN
    RAISE EXCEPTION 'quality: the counts of hold group % are { "<what>": <whole number from 0> }', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QualityHoldGroup_guard" BEFORE INSERT OR UPDATE OR DELETE ON "QualityHoldGroup"
  FOR EACH ROW EXECUTE FUNCTION "factory_quality_hold_group_guard"();

-- QualityHold: its group is given once and never changed or cleared. A released or closed hold takes none (W2a's
-- factory_quality_hold_guard freezes the row), and a floor session changes none (that function's list of what the floor may
-- change leaves it out).
CREATE FUNCTION "factory_quality_hold_group_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."groupId" IS NOT NULL AND NEW."groupId" IS DISTINCT FROM OLD."groupId" THEN
    RAISE EXCEPTION 'quality: hold % is part of hold group %; its group is given once', OLD."id", OLD."groupId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QualityHold_group_kept" BEFORE UPDATE OF "groupId" ON "QualityHold"
  FOR EACH ROW EXECUTE FUNCTION "factory_quality_hold_group_kept"();

-- =====================================================================================================================
-- The settings (quality.prisma)

-- QualitySettings (a trigger of its own, as each wave added one): the undo window is 0 to 300 seconds when set; the four-eyes
-- list is a list (not null) of distinct conditions, OVERRIDE and CUSTOMER: ALWAYS is the rule's (releaseFourEyes).
CREATE FUNCTION "factory_quality_settings_four_eyes_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."benchUndoSeconds" IS NOT NULL AND NEW."benchUndoSeconds" NOT BETWEEN 0 AND 300 THEN
    RAISE EXCEPTION 'quality: the undo window after a bench scan is 0 to 300 seconds, not %', NEW."benchUndoSeconds"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fourEyesConditions" IS NULL
     OR array_position(NEW."fourEyesConditions", NULL) IS NOT NULL
     OR 'ALWAYS' = ANY (NEW."fourEyesConditions")
     OR (SELECT count(DISTINCT c) FROM unnest(NEW."fourEyesConditions") c) <> cardinality(NEW."fourEyesConditions") THEN
    RAISE EXCEPTION 'quality: the four-eyes list of settings % names OVERRIDE and CUSTOMER at most once each (a second person for every release is the rule, releaseFourEyes)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QualitySettings_four_eyes_guard" BEFORE INSERT OR UPDATE ON "QualitySettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_quality_settings_four_eyes_guard"();

-- QualityRelease (redefines …_quality_final_release_guards' function, the latest of it; the trigger stays): its rules, and
-- OVERRIDE and CUSTOMER apply while fourEyesConditions names them. The column's default names both and an existing row got
-- that default, so a release is decided as before until a person changes the list.
CREATE OR REPLACE FUNCTION "factory_quality_release_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
  style_id uuid;
  inspection record;
  cell record;
  released bigint;
  from_inspection bigint;
  category text;
  zone text;
  release_day date;
  stale uuid;
  reasons "ReleaseSecondPersonReason"[] := ARRAY[]::"ReleaseSecondPersonReason"[];
  company_rule text;
  tenant_rule text;
  company_parties uuid[];
  tenant_parties uuid[];
  company_conditions "ReleaseSecondPersonReason"[];
  tenant_conditions "ReleaseSecondPersonReason"[];
  conditions "ReleaseSecondPersonReason"[];
  same_person boolean;
BEGIN
  IF NEW."quantity" < 1 OR btrim(NEW."signatureSha256") = '' THEN
    RAISE EXCEPTION 'quality: release % is of at least one garment, signed', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."releasedById" IS NULL) = (NEW."releasedByWorkerId" IS NULL) THEN
    RAISE EXCEPTION 'quality: release % names exactly one releaser: an office user or a floor inspector of the site', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'factory_floor_runtime' AND NEW."releasedById" IS NOT NULL THEN
    RAISE EXCEPTION 'quality: the floor records the release of a worker (the signed-in floor inspector), not of an office user (release %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- Why a second person is needed (Owner answer Q1 (a)): written here from the inspection and the company's rules.
  NEW."secondPersonReasons" := ARRAY[]::"ReleaseSecondPersonReason"[];
  SELECT w."status"::text, w."styleId" INTO order_state, style_id
    FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF NOT FOUND THEN
    -- Outside this session's scope: the policies refuse the row.
    RETURN NEW;
  END IF;
  IF order_state NOT IN ('RELEASED', 'IN_PROGRESS', 'COMPLETED') THEN
    RAISE EXCEPTION 'quality: work order % is %; its garments are released while it is RELEASED, IN_PROGRESS or COMPLETED', NEW."workOrderId", order_state
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."status"::text AS status, i."lotSize", i."inspectorWorkerId", i."inspectorUserId", i."notMakerStatement", i."overrideReason" INTO inspection
    FROM "Inspection" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."inspectionId";
  IF FOUND AND inspection.status <> 'PASSED' THEN
    RAISE EXCEPTION 'quality: inspection % is %; garments are released only from a PASSED inspection (QHS-058)', NEW."inspectionId", inspection.status
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.release', NEW."tenantId", NEW."workOrderId"), 0));
  SELECT c."quantity", c."colourwayId", c."size", c."measurementProfileId", c."partyId" INTO cell
    FROM "WorkOrderSize" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."workOrderSizeId";
  IF FOUND THEN
    SELECT (SELECT coalesce(sum(r."quantity"), 0) FROM "QualityRelease" r WHERE r."tenantId" = NEW."tenantId" AND r."workOrderSizeId" = NEW."workOrderSizeId")
         - (SELECT coalesce(sum(v."quantity"), 0) FROM "QualityReleaseReversal" v WHERE v."tenantId" = NEW."tenantId" AND v."workOrderSizeId" = NEW."workOrderSizeId")
      INTO released;
    IF released + NEW."quantity" > cell."quantity" THEN
      RAISE EXCEPTION 'quality: cell % has % piece(s) and % released (less reversals); release % of % more is refused', NEW."workOrderSizeId", cell."quantity", released, NEW."id", NEW."quantity"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF inspection.status IS NOT NULL THEN
    SELECT coalesce(sum(r."quantity"), 0) INTO from_inspection
      FROM "QualityRelease" r WHERE r."tenantId" = NEW."tenantId" AND r."inspectionId" = NEW."inspectionId";
    IF from_inspection + NEW."quantity" > inspection."lotSize" THEN
      RAISE EXCEPTION 'quality: inspection % judged a lot of % garment(s), % released already; release % of % more is refused', NEW."inspectionId", inspection."lotSize", from_inspection, NEW."id", NEW."quantity"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_quality_check_not_maker"(NEW."tenantId", NEW."workOrderId", inspection."inspectorWorkerId", inspection."inspectorUserId", inspection."notMakerStatement", 'inspection', NEW."inspectionId");
  END IF;
  PERFORM "factory_quality_check_not_maker"(NEW."tenantId", NEW."workOrderId", NEW."releasedByWorkerId", NEW."releasedById", true, 'release', NEW."id");

  -- Four eyes as a setting (Owner answer Q1 (a); QualitySettings: the company's row, else the tenant-wide one, else
  -- WHEN_REQUIRED; the customers listed on either row): OVERRIDE when the inspection overrode its computed result,
  -- CUSTOMER when the cell's customer is listed, ALWAYS when the rule asks it for every release. W2b (B-W2b-79; design
  -- qs-sod "Four-eyes release for"): OVERRIDE and CUSTOMER apply while fourEyesConditions names them: a company's list
  -- adds to the tenant-wide one; no row at all: both.
  SELECT q."releaseFourEyes"::text, q."secondPersonPartyIds", q."fourEyesConditions" INTO company_rule, company_parties, company_conditions
    FROM "QualitySettings" q WHERE q."tenantId" = NEW."tenantId" AND q."id" = NEW."companyId";
  SELECT q."releaseFourEyes"::text, q."secondPersonPartyIds", q."fourEyesConditions" INTO tenant_rule, tenant_parties, tenant_conditions
    FROM "QualitySettings" q WHERE q."tenantId" = NEW."tenantId" AND q."id" = NEW."tenantId";
  conditions := CASE WHEN company_conditions IS NULL AND tenant_conditions IS NULL THEN ARRAY['OVERRIDE', 'CUSTOMER']::"ReleaseSecondPersonReason"[]
                     ELSE coalesce(company_conditions, ARRAY[]::"ReleaseSecondPersonReason"[]) || coalesce(tenant_conditions, ARRAY[]::"ReleaseSecondPersonReason"[]) END;
  IF 'OVERRIDE' = ANY (conditions) AND inspection.status IS NOT NULL AND inspection."overrideReason" IS NOT NULL THEN
    reasons := reasons || 'OVERRIDE'::"ReleaseSecondPersonReason";
  END IF;
  IF 'CUSTOMER' = ANY (conditions) AND cell."partyId" IS NOT NULL
     AND cell."partyId" = ANY (coalesce(company_parties, ARRAY[]::uuid[]) || coalesce(tenant_parties, ARRAY[]::uuid[])) THEN
    reasons := reasons || 'CUSTOMER'::"ReleaseSecondPersonReason";
  END IF;
  IF coalesce(company_rule, tenant_rule, 'WHEN_REQUIRED') = 'ALWAYS' THEN
    reasons := reasons || 'ALWAYS'::"ReleaseSecondPersonReason";
  END IF;
  NEW."secondPersonReasons" := reasons;
  -- Then the release is the second signature: the releaser is not the inspector who signed the result (the same worker,
  -- the same user, or, read only by the office, a worker linked to the other's user).
  IF cardinality(reasons) > 0 AND inspection.status IS NOT NULL THEN
    same_person := (NEW."releasedByWorkerId" IS NOT NULL AND NEW."releasedByWorkerId" = inspection."inspectorWorkerId")
                OR (NEW."releasedById" IS NOT NULL AND NEW."releasedById" = inspection."inspectorUserId");
    IF NOT same_person AND current_user <> 'factory_floor_runtime' THEN
      same_person := EXISTS (SELECT 1 FROM "Worker" w
                              WHERE w."tenantId" = NEW."tenantId"
                                AND ((w."id" = inspection."inspectorWorkerId" AND w."userId" = NEW."releasedById")
                                     OR (w."id" = NEW."releasedByWorkerId" AND w."userId" = inspection."inspectorUserId")));
    END IF;
    IF same_person THEN
      RAISE EXCEPTION 'quality: release % needs a second person (%): the inspector who signed inspection % does not release it alone (four eyes, Owner answer Q1)', NEW."id", array_to_string(reasons, ', '), NEW."inspectionId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT s."ppeCategory"::text INTO category FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = style_id;
  IF FOUND AND category <> 'NOT_PPE' THEN
    SELECT coalesce(co."timezone", 'Europe/Rome') INTO zone FROM "Company" co WHERE co."tenantId" = NEW."tenantId" AND co."id" = NEW."companyId";
    release_day := (NEW."releasedAt" AT TIME ZONE coalesce(zone, 'Europe/Rome'))::date;
    IF cardinality(NEW."certificateIds") = 0 THEN
      RAISE EXCEPTION 'quality: style % is PPE (%); release % names the certificates that cover it (the certificate gate, Reg. 2016/425)', style_id, category, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT x."id" INTO stale FROM unnest(NEW."certificateIds") AS x("id")
     WHERE NOT EXISTS (SELECT 1 FROM "Certificate" ce
                        WHERE ce."tenantId" = NEW."tenantId" AND ce."id" = x."id" AND ce."status" = 'VALID'
                          AND release_day BETWEEN ce."validFrom" AND ce."validTo")
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'quality: certificate % is not VALID on %; release % names only certificates valid that day', stale, release_day, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF cell."quantity" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "CertificateCoverage" v
                        WHERE v."tenantId" = NEW."tenantId" AND v."certificateId" = ANY (NEW."certificateIds") AND v."styleId" = style_id
                          AND v."status" = 'ACTIVE'
                          AND (cardinality(v."colourwayIds") = 0 OR cell."colourwayId" = ANY (v."colourwayIds"))
                          AND (cardinality(v."sizes") = 0 OR cell."size" = ANY (v."sizes"))
                          AND (cell."measurementProfileId" IS NULL OR v."allowsMadeToMeasure")) THEN
      RAISE EXCEPTION 'quality: no certificate named by release % covers style % in colourway % and size % (the certificate gate, A1 §2.5)', NEW."id", style_id, cell."colourwayId", cell."size"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- QualityAlertRule (QHS-154)
--   UPDATE     the company, the event and the creation never change.
--   every row  a role exactly for ROLE and OWNER_AND_ROLE; waits 0 to 43200 minutes (30 days); daysBefore exactly for
--              CERTIFICATE_EXPIRING: from 1 to 730, highest first, and it fires by them (withinMinutes 0); at least one
--              channel, each once.
--   DELETE     the office removes a rule (the audit log keeps it). TRUNCATE refused.
CREATE FUNCTION "factory_quality_alert_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."event", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."event", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, event and creation of alert rule % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."audience" = 'OWNER') <> (NEW."roleId" IS NULL) THEN
    RAISE EXCEPTION 'quality: alert rule % tells %: a role exactly for ROLE and OWNER_AND_ROLE', NEW."id", NEW."audience"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."withinMinutes" NOT BETWEEN 0 AND 43200 THEN
    RAISE EXCEPTION 'quality: alert rule % waits 0 to 43200 minutes (30 days), not %', NEW."id", NEW."withinMinutes"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."daysBefore" IS NULL
     OR (NEW."event" = 'CERTIFICATE_EXPIRING') <> (cardinality(NEW."daysBefore") > 0)
     OR (NEW."event" = 'CERTIFICATE_EXPIRING' AND NEW."withinMinutes" <> 0)
     OR EXISTS (SELECT 1 FROM unnest(NEW."daysBefore") WITH ORDINALITY d(days, place)
                 WHERE d.days IS NULL OR d.days NOT BETWEEN 1 AND 730
                    OR d.days >= NEW."daysBefore"[d.place - 1]) THEN
    RAISE EXCEPTION 'quality: alert rule % names the days before an expiry exactly for CERTIFICATE_EXPIRING: from 1 to 730, highest first', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."channels" IS NULL OR cardinality(NEW."channels") = 0
     OR (SELECT count(DISTINCT c) FROM unnest(NEW."channels") c) <> cardinality(NEW."channels") THEN
    RAISE EXCEPTION 'quality: alert rule % names at least one channel, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QualityAlertRule_guard" BEFORE INSERT OR UPDATE ON "QualityAlertRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_quality_alert_rule_guard"();

-- =====================================================================================================================
-- The complaint's investigation and answer letter (complaints.prisma; QHS-116). W2a's factory_complaint_guard keeps the
-- rest; a CLOSED complaint never changes there.
--   investigation  the findings and the root cause from TRIAGED on, not blank when given.
--   the letter     a template and words not blank when given, a language of two lower-case letters, distinct files; frozen
--                  while the complaint stays ANSWERED (going back to INVESTIGATING opens it again).
--   sent           its document, who and how: all three or none, only with answeredAt. The document is a COMPLAINT_ANSWER of this
--                  complaint, in the letter's language.
CREATE FUNCTION "factory_complaint_answer_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW."status" = 'NEW' AND (NEW."findings" IS NOT NULL OR NEW."rootCause" IS NOT NULL) THEN
    RAISE EXCEPTION 'complaints: complaint % is investigated once it is triaged', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(coalesce(NEW."findings", 'x')) = '' OR btrim(coalesce(NEW."rootCause", 'x')) = ''
     OR btrim(coalesce(NEW."answerTemplate", 'x')) = '' OR btrim(coalesce(NEW."answerText", 'x')) = ''
     OR coalesce(NEW."answerLanguage", 'xx') !~ '^[a-z]{2}$' THEN
    RAISE EXCEPTION 'complaints: complaint % has findings, a root cause, a template and words not blank when given, and a two-letter language', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."answerFileIds" IS NULL OR (SELECT count(DISTINCT f) FROM unnest(NEW."answerFileIds") f) <> cardinality(NEW."answerFileIds") THEN
    RAISE EXCEPTION 'complaints: the answer of complaint % names each of its files once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'ANSWERED' AND NEW."status" = 'ANSWERED'
     AND (NEW."answerTemplate", NEW."answerLanguage", NEW."answerText", NEW."answerFileIds", NEW."answerDocumentId", NEW."answeredById", NEW."answeredVia")
         IS DISTINCT FROM
         (OLD."answerTemplate", OLD."answerLanguage", OLD."answerText", OLD."answerFileIds", OLD."answerDocumentId", OLD."answeredById", OLD."answeredVia") THEN
    RAISE EXCEPTION 'complaints: complaint % is ANSWERED; its letter changes once it goes back to INVESTIGATING', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."answerDocumentId" IS NULL) <> (NEW."answeredById" IS NULL) OR (NEW."answerDocumentId" IS NULL) <> (NEW."answeredVia" IS NULL)
     OR (NEW."answerDocumentId" IS NOT NULL AND NEW."answeredAt" IS NULL) THEN
    RAISE EXCEPTION 'complaints: the letter sent for complaint % names its document, who sent it and how, all three, with the time it was answered', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."answerDocumentId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."answerDocumentId" IS DISTINCT FROM OLD."answerDocumentId") THEN
    SELECT d."kind"::text AS kind, d."recordType", d."recordId", d."language" INTO document
      FROM "GeneratedDocument" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."answerDocumentId";
    IF FOUND AND (document.kind <> 'COMPLAINT_ANSWER' OR document."recordType" <> 'Complaint' OR document."recordId" <> NEW."id"
                  OR document."language" IS DISTINCT FROM NEW."answerLanguage") THEN
      RAISE EXCEPTION 'complaints: the letter sent for complaint % is a COMPLAINT_ANSWER of this complaint, in the letter''s language', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Complaint_answer_guard" BEFORE INSERT OR UPDATE ON "Complaint"
  FOR EACH ROW EXECUTE FUNCTION "factory_complaint_answer_guard"();

-- =====================================================================================================================
-- GeneratedDocument (redefines …_followups_stock_w2b_guards' function; the trigger stays): its rules, with the new kinds: an
-- inspection report of an Inspection or an IncomingInspection, a certificate of conformity of a Shipment, an NCR report of a
-- Nonconformance, an 8D of a Capa, an answer letter of a Complaint (those two have no site, so neither has the document).
-- A check report, a frozen risk assessment and a PPE receipt name their record by type and id, and their file must be a file
-- of it; the record itself is checked once its table exists: waves 14 and 15 add their WHEN to this CASE.
CREATE OR REPLACE FUNCTION "factory_generated_document_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_company uuid;
  record_site uuid;
  file record;
BEGIN
  IF NEW."version" < 1 OR NEW."fingerprint" !~ '^[0-9a-f]{64}$' OR NEW."language" !~ '^[a-z]{2}$'
     OR btrim(coalesce(NEW."layout", 'x')) = '' OR btrim(coalesce(NEW."number", 'x')) = '' THEN
    RAISE EXCEPTION 'documents: generated document % has a version from 1, a SHA-256 fingerprint (lower-case hex), its two-letter language and, when given, a layout and a number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((NEW."kind" = 'PACKING_LIST' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'CLAIM_LETTER' AND NEW."recordType" = 'SupplierClaim')
          OR (NEW."kind" = 'JOB_SHEET' AND NEW."recordType" IN ('SubcontractOrder', 'MaintenanceJob'))
          OR (NEW."kind" = 'RMA_SHEET' AND NEW."recordType" = 'ReturnAuthorisation')
          OR (NEW."kind" = 'INSPECTION_REPORT' AND NEW."recordType" IN ('Inspection', 'IncomingInspection'))
          OR (NEW."kind" = 'CERTIFICATE_OF_CONFORMITY' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'NCR_REPORT' AND NEW."recordType" = 'Nonconformance')
          OR (NEW."kind" = 'EIGHT_D' AND NEW."recordType" = 'Capa')
          OR (NEW."kind" = 'COMPLAINT_ANSWER' AND NEW."recordType" = 'Complaint')
          OR (NEW."kind" = 'CHECK_REPORT' AND NEW."recordType" = 'MachineCheckResult')
          OR (NEW."kind" = 'DVR_FROZEN' AND NEW."recordType" = 'RiskAssessmentVersion')
          OR (NEW."kind" = 'PPE_RECEIPT' AND NEW."recordType" = 'PpeIssue')) THEN
    RAISE EXCEPTION 'documents: generated document % is a % of a %; a packing list is a Shipment''s, a claim letter a SupplierClaim''s, a job sheet a SubcontractOrder''s or a MaintenanceJob''s, an RMA sheet a ReturnAuthorisation''s, a certificate of conformity a Shipment''s, an inspection report an Inspection''s or an IncomingInspection''s, an NCR report a Nonconformance''s, an 8D a Capa''s, an answer letter a Complaint''s, a check report a MachineCheckResult''s, a frozen risk assessment a RiskAssessmentVersion''s, a PPE receipt a PpeIssue''s', NEW."id", NEW."kind", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  CASE NEW."recordType"
    -- W2b (B-W2b-79): these tables come with waves 14 and 15, which add their WHEN here; until then the file below is the check.
    WHEN 'MachineCheckResult', 'RiskAssessmentVersion', 'PpeIssue' THEN
      PERFORM 1 WHERE false;
    -- A record of the whole company has no site, and neither has its document.
    WHEN 'Capa' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "Capa" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Complaint' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "Complaint" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Inspection' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Inspection" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'IncomingInspection' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "IncomingInspection" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Nonconformance' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Nonconformance" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Shipment' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Shipment" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'SupplierClaim' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "SupplierClaim" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'SubcontractOrder' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "SubcontractOrder" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'MaintenanceJob' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "MaintenanceJob" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    ELSE
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "ReturnAuthorisation" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
  END CASE;
  IF FOUND AND (record_company, record_site) IS DISTINCT FROM (NEW."companyId", NEW."siteId") THEN
    RAISE EXCEPTION 'documents: generated document % is of the company and site of its % %', NEW."id", NEW."recordType", NEW."recordId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT f."recordType", f."recordId", f."companyId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF FOUND AND (file."recordType", file."recordId", file."companyId") IS DISTINCT FROM (NEW."recordType", NEW."recordId", NEW."companyId") THEN
    RAISE EXCEPTION 'documents: the file of generated document % is a file of its own record (% %) and company', NEW."id", NEW."recordType", NEW."recordId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
