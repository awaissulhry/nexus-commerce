-- Written by hand (Prisma does not model triggers), after the generated 202610281400_outbox_events and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The outbox keeps every event exactly as command() wrote it (plan A1 §2.1 "Append-only", §3.4). Only the delivery state
-- moves, and only forward, so the relay (the system context in factory_runtime) can mark rows and nothing can rewrite
-- an event. For every login, the owner included:
--   INSERT    a new row is PENDING with no attempt, no publishedAt and no error: nothing is born published.
--   UPDATE    refused when any column but status, attempts, nextAttemptAt, publishedAt or lastError changes; when a
--             PUBLISHED row changes its state; when attempts goes down; when a row becomes PUBLISHED without publishedAt.
--             tenantId is held by the policies (USING and WITH CHECK on the tenant): a runtime role cannot move a row.
--   DELETE    refused unless the row is PUBLISHED (a later retention job may purge published events; pending and dead
--             ones stay until a person has looked at them).
--   TRUNCATE  refused.
-- A DEAD row may go back to PENDING: a person re-queues it after fixing the cause.
CREATE FUNCTION "factory_guard_outbox_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'outbox: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' OR NEW."attempts" <> 0 OR NEW."publishedAt" IS NOT NULL OR NEW."lastError" IS NOT NULL THEN
      RAISE EXCEPTION 'outbox: a new event is PENDING with no attempt yet'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'PUBLISHED' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'outbox: event % is % and cannot be deleted; only a published event may be purged', OLD."id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."siteId", NEW."partyId", NEW."type", NEW."version", NEW."context", NEW."subject",
      NEW."correlationId", NEW."causationId", NEW."source", NEW."occurredAt", NEW."payload")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."siteId", OLD."partyId", OLD."type", OLD."version", OLD."context", OLD."subject",
      OLD."correlationId", OLD."causationId", OLD."source", OLD."occurredAt", OLD."payload") THEN
    RAISE EXCEPTION 'outbox: event % is fixed once written; only its delivery state may change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'PUBLISHED' AND (NEW."status", NEW."publishedAt") IS DISTINCT FROM (OLD."status", OLD."publishedAt") THEN
    RAISE EXCEPTION 'outbox: event % is published; its delivery state is final', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'outbox: the attempts of event % cannot go down', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'PUBLISHED' AND NEW."publishedAt" IS NULL THEN
    RAISE EXCEPTION 'outbox: event % cannot be published without publishedAt', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OutboxEvent_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OutboxEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_guard_outbox_change"();
CREATE TRIGGER "OutboxEvent_no_truncate" BEFORE TRUNCATE ON "OutboxEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_guard_outbox_change"();
