-- Written by hand (Prisma does not model triggers), after the generated 202610286100_insights_attention_actions and
-- before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Home › Today's actions (B-W1-52 actions; ANA-037; design home.today "alert → Acknowledge · Assign · Resolve", popups
-- assign, resolve-note, arrange): the hand-written rules of the tables 202610286100_insights_attention_actions made, for
-- every login (the owner included). The API answers first, in words (apps/factory-api modules/insights actions.ts);
-- these are the last word.
--
--   AttentionAction     its row key starts `<kind>:<record id>` of its own kind and record, which never change.
--                       An assignment is the person, who assigned and when (all or none); a resolution is the condition,
--                       a NOTE saying what was done (never blank), who and when (all or none); an acknowledgement is the
--                       condition, who and when (all or none). Every assignment, resolution and acknowledgement it holds
--                       is in its history (checked at commit). Never deleted.
--   AttentionActionLog  append-only. A row names its action's row key, kind and record; RESOLVED carries its note (never
--                       blank), ASSIGNED and UNASSIGNED the person, ACKNOWLEDGED neither.
--   TodayLayout         its sections and panels are JSON arrays, its lens a code or nothing; it stays its person's.
-- The tenant column is left to the policies: a row moved out of its tenant is refused by row-level security.

-- ---------------------------------------------------------------------------------------------------------------------
-- AttentionActionLog: append-only (scripts/factory/check-append-only.mjs), and its INSERT rules.
CREATE FUNCTION "factory_refuse_attention_log_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'insights: % on "%" is refused; the history of Today''s actions is never changed and no row of it is removed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "AttentionActionLog_append_only" BEFORE UPDATE OR DELETE ON "AttentionActionLog"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_attention_log_change"();
CREATE TRIGGER "AttentionActionLog_no_truncate" BEFORE TRUNCATE ON "AttentionActionLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_attention_log_change"();

CREATE FUNCTION "factory_attention_log_check"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  ELSIF NEW."assigneeId" IS NOT NULL OR NEW."note" IS NOT NULL THEN
    RAISE EXCEPTION 'insights: an acknowledgement (%) names no assignee and carries no note', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AttentionActionLog_check" BEFORE INSERT ON "AttentionActionLog"
  FOR EACH ROW EXECUTE FUNCTION "factory_attention_log_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- AttentionAction
CREATE FUNCTION "factory_attention_action_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END
$$;

CREATE TRIGGER "AttentionAction_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AttentionAction"
  FOR EACH ROW EXECUTE FUNCTION "factory_attention_action_guard"();
CREATE TRIGGER "AttentionAction_no_truncate" BEFORE TRUNCATE ON "AttentionAction"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_attention_log_change"();

-- Every assignment, resolution and acknowledgement an action holds is in its history, checked at commit (the action is
-- written first: its history row references it).
CREATE FUNCTION "factory_attention_action_logged"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "AttentionAction_logged" AFTER INSERT OR UPDATE ON "AttentionAction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "factory_attention_action_logged"();

-- ---------------------------------------------------------------------------------------------------------------------
-- TodayLayout
CREATE FUNCTION "factory_today_layout_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW."sections") <> 'array' OR jsonb_typeof(NEW."panels") <> 'array' THEN
    RAISE EXCEPTION 'insights: the Today layout % keeps its sections and its panels as lists', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."mainLens" IS NOT NULL AND NEW."mainLens" !~ '^[A-Z][A-Z_]*$' THEN
    RAISE EXCEPTION 'insights: the Today layout % names its main lens by its code', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."userId" IS DISTINCT FROM OLD."userId" THEN
    RAISE EXCEPTION 'insights: the Today layout % stays its person''s', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "TodayLayout_guard" BEFORE INSERT OR UPDATE ON "TodayLayout"
  FOR EACH ROW EXECUTE FUNCTION "factory_today_layout_guard"();
