-- Written by hand (Prisma does not model triggers), after the generated 202610286000_floor_sync and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The floor sync (B-W0-30; PLT-237, PLT-239, PLT-189; A1 §2.1 "Append-only", §3.8; design floor.sync SCR-023): the
-- hand-written rules of the tables 202610286000_floor_sync made, for every login (the owner included). The API answers
-- first, in words (apps/factory-api platform/floor-sync); these are the last word.
--
--   FloorSyncEvent       append-only: a recorded event is never changed or removed. It keeps the tablet's id for the
--                        event, its kind, the record it became and the request; its place in the queue is from 0.
--   FloorRefusedAction   kept OPEN with the tablet's id for the event, its kind, the refusal's code, words and fix (none
--                        blank) and what was sent; the module's own refusal named both by type and id, or not at all.
--                        What was sent never changes. It closes once: RESOLVED by the ledger row of the same device and
--                        client event id (with the time), or DISCARDED with when, from where and why (the words not
--                        blank); never both; never deleted.
-- The tenant, company and site columns are left to the policies: a row moved out of its scope is refused by row-level
-- security.

-- ---------------------------------------------------------------------------------------------------------------------
-- FloorSyncEvent: append-only (scripts/factory/check-append-only.mjs), and its INSERT rules.
CREATE FUNCTION "factory_refuse_floor_sync_ledger_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'floor sync: % on "%" is refused; a recorded event is never changed and no floor sync row is removed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "FloorSyncEvent_append_only" BEFORE UPDATE OR DELETE ON "FloorSyncEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_floor_sync_ledger_change"();
CREATE TRIGGER "FloorSyncEvent_no_truncate" BEFORE TRUNCATE ON "FloorSyncEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_floor_sync_ledger_change"();

CREATE FUNCTION "factory_floor_sync_event_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF btrim(NEW."clientEventId") = '' OR btrim(NEW."kind") = '' OR btrim(NEW."resultType") = '' OR btrim(NEW."requestId") = '' THEN
    RAISE EXCEPTION 'floor sync: recorded event % keeps the tablet''s id for it, its kind, the record it became and the request', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."deviceSeq" < 0 THEN
    RAISE EXCEPTION 'floor sync: recorded event % keeps its place in the tablet''s queue (from 0)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "FloorSyncEvent_check" BEFORE INSERT ON "FloorSyncEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_floor_sync_event_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- FloorRefusedAction
CREATE FUNCTION "factory_floor_refused_action_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'companyId', 'siteId'];
  closing CONSTANT text[] := ARRAY['status', 'resolvedByEventId', 'resolvedAt', 'discardedAt', 'discardedById', 'discardedBy', 'discardReason', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'floor sync: refused action % is discarded, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."resolvedByEventId" IS NOT NULL OR NEW."resolvedAt" IS NOT NULL OR NEW."discardedAt" IS NOT NULL
       OR NEW."discardedById" IS NOT NULL OR NEW."discardedBy" IS NOT NULL OR NEW."discardReason" IS NOT NULL THEN
      RAISE EXCEPTION 'floor sync: refused action % is kept open', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF btrim(NEW."clientEventId") = '' OR btrim(NEW."kind") = '' OR btrim(NEW."code") = '' OR btrim(NEW."message") = '' OR btrim(NEW."fix") = '' THEN
      RAISE EXCEPTION 'floor sync: refused action % keeps the tablet''s id for it, its kind, its code, its words and its fix', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."deviceSeq" < 0 THEN
      RAISE EXCEPTION 'floor sync: refused action % keeps its place in the tablet''s queue (from 0)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."moduleRefusalType" IS NULL) <> (NEW."moduleRefusalId" IS NULL) OR btrim(coalesce(NEW."moduleRefusalType", 'x')) = '' THEN
      RAISE EXCEPTION 'floor sync: refused action % names the module''s own refusal by type and id, or not at all', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - kept) IS NOT DISTINCT FROM (to_jsonb(OLD) - kept) THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - (kept || closing)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || closing)) THEN
    RAISE EXCEPTION 'floor sync: refused action % keeps what the tablet sent; it is only resolved or discarded', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'floor sync: refused action % is closed (%): it closes once', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'OPEN' THEN
    RAISE EXCEPTION 'floor sync: refused action % changes only when it is resolved or discarded', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'RESOLVED' THEN
    IF NEW."resolvedByEventId" IS NULL OR NEW."resolvedAt" IS NULL OR NEW."discardedAt" IS NOT NULL OR NEW."discardedById" IS NOT NULL
       OR NEW."discardedBy" IS NOT NULL OR NEW."discardReason" IS NOT NULL THEN
      RAISE EXCEPTION 'floor sync: refused action % is resolved by a recorded event, with the time, and nothing else', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM "FloorSyncEvent" e WHERE e."tenantId" = NEW."tenantId" AND e."siteId" = NEW."siteId" AND e."id" = NEW."resolvedByEventId"
            AND e."deviceId" = NEW."deviceId" AND e."clientEventId" = NEW."clientEventId") THEN
      RAISE EXCEPTION 'floor sync: refused action % is resolved by the event its tablet sent again under the same id', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- DISCARDED
  IF NEW."discardedAt" IS NULL OR NEW."discardedBy" IS NULL OR NEW."discardReason" IS NULL OR btrim(NEW."discardReason") = ''
     OR NEW."resolvedByEventId" IS NOT NULL OR NEW."resolvedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'floor sync: refused action % is discarded with when, from where and why', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "FloorRefusedAction_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FloorRefusedAction"
  FOR EACH ROW EXECUTE FUNCTION "factory_floor_refused_action_guard"();
CREATE TRIGGER "FloorRefusedAction_no_truncate" BEFORE TRUNCATE ON "FloorRefusedAction"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_floor_sync_ledger_change"();
