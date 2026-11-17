-- Written by hand (Prisma does not model triggers), after the generated 202611170700_brand_production_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- A customer's production state, its issues and the plain production hold (production plan, schema wave 3/5, B-PR-15; lead
-- picks L17, L18, L20, L21, L24; review fixes R-41…R-49; wall tests PW-11, PW-15, PW-17 DB parts). apps/factory-api checks all
-- of this first and answers in words (B-PR-17 the keeper, B-PR-21 holds, B-PR-22a/b urgency, B-PR-42a the supervisor, B-PR-43b
-- and B-PR-45 issues); these rules are the last word, for every login, the owner included. The refusals are check_violation
-- (SQLSTATE 23514); their words name no other customer (the brand wall: "One brand must not be able to see anything related to
-- any other brand").
--
--   BrandOrderProduction  the order, its company and customer, the key and the creation never change; the key is
--                         `brand-production:<salesOrderId>` (one row per order: the unique key; the isolation tests' copies
--                         add a `-…` suffix);
--                         urgency: the place in the customer's Urgent list (urgentRank) is set exactly while URGENT, and is
--                         1 or more (no unique key: a shipped order keeps its last urgency as history; the command rewrites
--                         the open ranks 1..n under the customer's PortalSettings row lock); who set it (BRAND or FACTORY)
--                         and when, both or neither, an Urgent mark always with them; the person, when named or changed, a
--                         portal person of the order's own customer for BRAND, an office person for FACTORY;
--                         the lock: a locked order is REGULAR; its reason (one line, at most 500), when and by whom exactly
--                         while locked; the locker, when named or changed, an active office person;
--                         the supervisor and since when, both or neither; when named or changed, an active office person
--                         (the Inquiry assignee's rule: a person made inactive later stays named until the office changes it);
--                         the raise of the health: only to AT_RISK, with its reason code, when, by whom and until when, all
--                         or none; the office's note only beside a raise, one line of at most 200;
--                         what it waits on: since when only with whom;
--                         never deleted; TRUNCATE refused.
--   ProductionIssue       a SalesOrder or a WorkOrder of ONE customer, of the issue's own company and customer (a sales order:
--                         the record itself is the issue's order and it has no site; a work order: its site, its customer
--                         set, its single order when the issue names one); its task a Task of the tenant (a plain id; one
--                         Task per batch) and its message a message of the record's own thread (a plain id); the due day not
--                         before the day it was raised (Rome);
--                         a new issue is OPEN, unanswered and not escalated; OPEN → ANSWERED | CANCELLED, an OFFICE issue
--                         ANSWERED → OPEN again (its task reopened, R-42); CANCELLED is final; answeredAt exactly while
--                         ANSWERED, not before it was raised; the escalation step 0 to 2, escalatedAt exactly from step 1;
--                         what it is about, its task, message, source, batch, raising and creation never change;
--                         never deleted; TRUNCATE refused.
--   WorkOrderHold         of its work order's company and customer (the work order's partyId, null only for a work order of
--                         none); a BRAND hold of a customer's work order, its ask (when named) an OrderChangeRequest of kind
--                         HOLD of that customer; a PRODUCTION hold names no ask; the reason a code (A-Z, 0-9, _; at most
--                         40); the office's note at most 2000, the customer's words one line of at most 500;
--                         placed ACTIVE on an open work order (DRAFT, RELEASED, IN_PROGRESS or ON_HOLD; its row read FOR
--                         SHARE, so a status change waits) by an office person — or written whole as history, LIFTED with its
--                         lift; ACTIVE → LIFTED once, with when (not before it was placed), by whom (an office person) and why
--                         (one line, at most 500), exactly while LIFTED; a LIFTED hold never changes; while ACTIVE only the
--                         note and the customer's words may be put right; never deleted; TRUNCATE refused.
--   WorkOrder             the new trigger WorkOrder_production_holds: a work order leaves ON_HOLD (back to the status it was
--                         held from, or CANCELLED) only when no ACTIVE WorkOrderHold names it: lift them first (a cancel
--                         lifts its holds first). Quality holds keep their own rules (…_quality_plant_w2a_guards).
--
-- No row is moved: the tables are new. No earlier function is redefined. USED FROM EARLIER WAVES, as they are:
-- "factory_privacy_ops_key_ok" (…_privacy_integration_w2b_guards), "factory_money_rome_day" (…_money_w2a_guards) and
-- "factory_production_refuse_truncate" (…_production_guards).

-- =====================================================================================================================
-- BrandOrderProduction: one order's production state for its customer.
CREATE FUNCTION "factory_brand_order_production_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  user_audience text;
  user_status text;
  user_party uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: the production state % of an order is kept, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."salesOrderId", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."salesOrderId", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: the order, customer, key and creation of production state % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_privacy_ops_key_ok"(NEW."key", concat('brand-production:', NEW."salesOrderId")) THEN
    RAISE EXCEPTION 'production: the key of production state % is brand-production:<salesOrderId> (one per order)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The customer's urgency (L17, L18; R-46, R-49).
  IF (NEW."urgency" = 'URGENT') <> (NEW."urgentRank" IS NOT NULL) OR NEW."urgentRank" < 1 THEN
    RAISE EXCEPTION 'production: order % has a place in its customer''s Urgent list (1 or more) exactly while it is Urgent (%)', NEW."salesOrderId", NEW."urgency"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."urgencySetAt" IS NULL) <> (NEW."urgencySetBy" IS NULL)
     OR (NEW."urgencySetById" IS NOT NULL AND NEW."urgencySetAt" IS NULL)
     OR (NEW."urgency" = 'URGENT' AND NEW."urgencySetAt" IS NULL) THEN
    RAISE EXCEPTION 'production: the urgency of order % names who set it (the customer or us) and when, both or neither, and an Urgent mark always has them', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."urgencySetById" IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW."urgencySetById", NEW."urgencySetBy") IS DISTINCT FROM (OLD."urgencySetById", OLD."urgencySetBy")) THEN
    SELECT u."audience"::text, u."partyId" INTO user_audience, user_party FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."urgencySetById";
    IF FOUND AND ((NEW."urgencySetBy" = 'BRAND' AND (user_audience <> 'PARTNER' OR user_party IS DISTINCT FROM NEW."partyId"))
                  OR (NEW."urgencySetBy" = 'FACTORY' AND user_audience <> 'OFFICE')) THEN
      RAISE EXCEPTION 'production: the urgency of order % is set by a portal person of its own customer (BRAND) or by an office person (FACTORY)', NEW."salesOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The factory's lock (L18; R-45): a locked order is Regular, with the reason the customer reads.
  IF NEW."urgencyLocked" AND NEW."urgency" <> 'REGULAR' THEN
    RAISE EXCEPTION 'production: order % locked by us is Regular', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."urgencyLocked" <> (NEW."urgencyLockReason" IS NOT NULL)
     OR NEW."urgencyLocked" <> (NEW."urgencyLockedAt" IS NOT NULL)
     OR NEW."urgencyLocked" <> (NEW."urgencyLockedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'production: order % is locked with its reason, when and by whom, exactly while it is locked', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."urgencyLockReason" IS NOT NULL
     AND (btrim(NEW."urgencyLockReason") = '' OR char_length(NEW."urgencyLockReason") > 500 OR NEW."urgencyLockReason" ~ '[\r\n]') THEN
    RAISE EXCEPTION 'production: the reason order % is locked is one line of at most 500 characters', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."urgencyLockedById" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."urgencyLockedById" IS DISTINCT FROM OLD."urgencyLockedById") THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."urgencyLockedById";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'production: order % is locked by an active office person', NEW."salesOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The supervisor of the order (L21): the Inquiry assignee's pattern.
  IF (NEW."supervisorId" IS NULL) <> (NEW."supervisorAssignedAt" IS NULL) THEN
    RAISE EXCEPTION 'production: order % names its supervisor together with since when, or neither (the customer''s default)', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supervisorId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."supervisorId" IS DISTINCT FROM OLD."supervisorId") THEN
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."supervisorId";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'production: the supervisor of order % is an active office person, not one that is % (%)', NEW."salesOrderId", user_status, user_audience
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The factory's raise of the health (B-PR-13 health.ts): only to AT_RISK, never lower; the note is the office's.
  IF NEW."healthSet" IS NOT NULL AND NEW."healthSet" <> 'AT_RISK' THEN
    RAISE EXCEPTION 'production: a person raises the health of order % to AT_RISK only, not %', NEW."salesOrderId", NEW."healthSet"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nulls(NEW."healthSet", NEW."healthReasonCode", NEW."healthSetAt", NEW."healthSetById", NEW."healthSetUntil") NOT IN (0, 5) THEN
    RAISE EXCEPTION 'production: a raise of the health of order % has its reason code, when, by whom and until when, or there is none', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."healthNote" IS NOT NULL
     AND (NEW."healthSet" IS NULL OR btrim(NEW."healthNote") = '' OR char_length(NEW."healthNote") > 200 OR NEW."healthNote" ~ '[\r\n]') THEN
    RAISE EXCEPTION 'production: the office''s note on the health of order % stands only beside a raise, one line of at most 200 characters', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it waits on.
  IF NEW."waitingSince" IS NOT NULL AND NEW."waitingOn" IS NULL THEN
    RAISE EXCEPTION 'production: order % waits since a time only on someone', NEW."salesOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "BrandOrderProduction_guard" AFTER INSERT OR UPDATE OR DELETE ON "BrandOrderProduction"
  FOR EACH ROW EXECUTE FUNCTION "factory_brand_order_production_guard"();
CREATE TRIGGER "BrandOrderProduction_no_truncate" BEFORE TRUNCATE ON "BrandOrderProduction"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();

-- =====================================================================================================================
-- ProductionIssue: an issue that needs an answer, about one customer's record.
CREATE FUNCTION "factory_production_issue_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_company uuid;
  record_site uuid;
  record_party uuid;
  thread_type text;
  thread_record uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: issue % is answered or cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."answeredAt" IS NOT NULL OR NEW."escalationStep" <> 0 OR NEW."escalatedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'production: a new issue (%) is OPEN, unanswered and not escalated', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."siteId", NEW."partyId", NEW."recordType", NEW."recordId", NEW."salesOrderId", NEW."taskId", NEW."messageId",
        NEW."source", NEW."batchId", NEW."raisedAt", NEW."dueDate", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."siteId", OLD."partyId", OLD."recordType", OLD."recordId", OLD."salesOrderId", OLD."taskId", OLD."messageId",
        OLD."source", OLD."batchId", OLD."raisedAt", OLD."dueDate", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: what issue % is about, its task, message, source, batch, due day and raising never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'OPEN' AND NEW."status" IN ('ANSWERED', 'CANCELLED'))
                OR (OLD."status" = 'ANSWERED' AND NEW."status" = 'OPEN' AND NEW."source" = 'OFFICE')) THEN
      RAISE EXCEPTION 'production: issue % cannot move from % to % (OPEN → ANSWERED or CANCELLED; an office issue whose task reopens is OPEN again)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."status" = 'ANSWERED') <> (NEW."answeredAt" IS NOT NULL) OR NEW."answeredAt" < NEW."raisedAt" THEN
    RAISE EXCEPTION 'production: issue % is answered (when, not before it was raised) exactly while it is ANSWERED (%)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."escalationStep" NOT BETWEEN 0 AND 2 OR (NEW."escalationStep" > 0) <> (NEW."escalatedAt" IS NOT NULL) OR NEW."escalatedAt" < NEW."raisedAt" THEN
    RAISE EXCEPTION 'production: issue % is escalated by step 0 to 2, with when exactly from step 1 (not before it was raised)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."dueDate" < "factory_money_rome_day"(NEW."raisedAt") THEN
    RAISE EXCEPTION 'production: issue % falls due on or after the day it was raised', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The record: a sales order or a work order of the issue's own company and customer.
    IF NEW."recordType" = 'SalesOrder' THEN
      SELECT o."companyId", NULL::uuid, o."partyId" INTO record_company, record_site, record_party
        FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."recordId";
    ELSIF NEW."recordType" = 'WorkOrder' THEN
      SELECT w."companyId", w."siteId", w."partyId" INTO record_company, record_site, record_party
        FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."recordId";
    ELSE
      RAISE EXCEPTION 'production: issue % is about a SalesOrder or a WorkOrder, not a %', NEW."id", NEW."recordType"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'production: issue % names a % of this session''s', NEW."id", NEW."recordType"
        USING ERRCODE = 'check_violation';
    END IF;
    IF record_party IS NULL THEN
      RAISE EXCEPTION 'production: issue % is about a work order of one customer (a work order of several customers or of none has no issue)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (record_company, record_site, record_party) IS DISTINCT FROM (NEW."companyId", NEW."siteId", NEW."partyId")
       OR (NEW."recordType" = 'SalesOrder' AND NEW."salesOrderId" IS DISTINCT FROM NEW."recordId") THEN
      RAISE EXCEPTION 'production: issue % carries its record''s company, site and customer (a sales order: itself as the order, no site)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- Its task (one per batch) and its message in the record's own thread: plain ids, checked once.
    PERFORM 1 FROM "Task" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."taskId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'production: issue % names a task of this session''s', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT th."recordType", th."recordId" INTO thread_type, thread_record
      FROM "Message" m JOIN "Thread" th ON th."tenantId" = m."tenantId" AND th."id" = m."threadId"
     WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."messageId";
    IF NOT FOUND OR (thread_type, thread_record) IS DISTINCT FROM (NEW."recordType", NEW."recordId") THEN
      RAISE EXCEPTION 'production: issue % names a message of its own record''s thread', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ProductionIssue_guard" AFTER INSERT OR UPDATE OR DELETE ON "ProductionIssue"
  FOR EACH ROW EXECUTE FUNCTION "factory_production_issue_guard"();
CREATE TRIGGER "ProductionIssue_no_truncate" BEFORE TRUNCATE ON "ProductionIssue"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();

-- =====================================================================================================================
-- WorkOrderHold: a plain production or customer hold.
CREATE FUNCTION "factory_work_order_hold_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  editable CONSTANT text[] := ARRAY['note', 'brandWords', 'version', 'updatedAt'];
  lift CONSTANT text[] := ARRAY['status', 'liftedAt', 'liftedById', 'liftReason', 'note', 'brandWords', 'version', 'updatedAt'];
  order_company uuid;
  order_party uuid;
  order_status text;
  request_kind text;
  request_party uuid;
  user_audience text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: hold % is lifted, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."status" = 'LIFTED' THEN
      RAISE EXCEPTION 'production: hold % is lifted; it never changes again', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'ACTIVE' AND (to_jsonb(NEW) - editable) IS DISTINCT FROM (to_jsonb(OLD) - editable) THEN
      RAISE EXCEPTION 'production: while hold % stands only the office''s note and the customer''s words are put right; lift it to end it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'LIFTED' AND (to_jsonb(NEW) - lift) IS DISTINCT FROM (to_jsonb(OLD) - lift) THEN
      RAISE EXCEPTION 'production: lifting hold % changes only %', OLD."id", array_to_string(lift, ', ')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."reasonCode" !~ '^[A-Z][A-Z0-9_]{0,39}$' THEN
    RAISE EXCEPTION 'production: hold % gives a code of the PRODUCTION_HOLD reason list (A-Z, 0-9, _), not %', NEW."id", NEW."reasonCode"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."note" IS NOT NULL AND (btrim(NEW."note") = '' OR char_length(NEW."note") > 2000))
     OR (NEW."brandWords" IS NOT NULL AND (btrim(NEW."brandWords") = '' OR char_length(NEW."brandWords") > 500 OR NEW."brandWords" ~ '[\r\n]')) THEN
    RAISE EXCEPTION 'production: hold % keeps the office''s note (at most 2000 characters) and the customer''s words (one line, at most 500)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'LIFTED') <> (NEW."liftedAt" IS NOT NULL)
     OR (NEW."status" = 'LIFTED') <> (NEW."liftedById" IS NOT NULL)
     OR (NEW."status" = 'LIFTED') <> (NEW."liftReason" IS NOT NULL)
     OR NEW."liftedAt" < NEW."placedAt"
     OR (NEW."liftReason" IS NOT NULL AND (btrim(NEW."liftReason") = '' OR char_length(NEW."liftReason") > 500 OR NEW."liftReason" ~ '[\r\n]')) THEN
    RAISE EXCEPTION 'production: hold % is lifted with when (not before it was placed), by whom and why (one line, at most 500), exactly while LIFTED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'PRODUCTION' AND NEW."requestId" IS NOT NULL THEN
    RAISE EXCEPTION 'production: production hold % answers no customer''s ask', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Its work order: the company and customer it carries, an open status for a hold that stands (read FOR SHARE: a status
    -- change of the work order waits for this transaction, and WorkOrder_production_holds then sees the hold).
    IF NEW."status" = 'ACTIVE' THEN
      SELECT w."companyId", w."partyId", w."status"::text INTO order_company, order_party, order_status
        FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId" FOR SHARE;
    ELSE
      SELECT w."companyId", w."partyId", w."status"::text INTO order_company, order_party, order_status
        FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
    END IF;
    IF FOUND THEN
      IF (order_company, order_party) IS DISTINCT FROM (NEW."companyId", NEW."partyId") THEN
        RAISE EXCEPTION 'production: hold % carries its work order''s company and customer', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."status" = 'ACTIVE' AND order_status NOT IN ('DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD') THEN
        RAISE EXCEPTION 'production: hold % is placed on an open work order, not a % one', NEW."id", order_status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."kind" = 'BRAND' AND NEW."partyId" IS NULL THEN
      RAISE EXCEPTION 'production: a customer''s hold (%) is on a work order of that customer', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."requestId" IS NOT NULL THEN
      SELECT r."kind"::text, r."partyId" INTO request_kind, request_party FROM "OrderChangeRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."requestId";
      IF NOT FOUND OR request_kind <> 'HOLD' OR request_party IS DISTINCT FROM NEW."partyId" THEN
        RAISE EXCEPTION 'production: customer''s hold % answers a HOLD ask of the work order''s own customer', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    SELECT u."audience"::text INTO user_audience FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."placedById";
    IF FOUND AND user_audience <> 'OFFICE' THEN
      RAISE EXCEPTION 'production: hold % is placed by an office person', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."liftedById" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."liftedById" IS NULL) THEN
    SELECT u."audience"::text INTO user_audience FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."liftedById";
    IF FOUND AND user_audience <> 'OFFICE' THEN
      RAISE EXCEPTION 'production: hold % is lifted by an office person', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WorkOrderHold_guard" AFTER INSERT OR UPDATE OR DELETE ON "WorkOrderHold"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_hold_guard"();
CREATE TRIGGER "WorkOrderHold_no_truncate" BEFORE TRUNCATE ON "WorkOrderHold"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();

-- =====================================================================================================================
-- WorkOrder: no leaving ON_HOLD while an ACTIVE WorkOrderHold names it.
CREATE FUNCTION "factory_work_order_production_holds"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  standing integer;
BEGIN
  SELECT count(*)::int INTO standing FROM "WorkOrderHold" h WHERE h."tenantId" = NEW."tenantId" AND h."workOrderId" = NEW."id" AND h."status" = 'ACTIVE';
  IF standing > 0 THEN
    RAISE EXCEPTION 'production: work order % stays on hold while % production or customer hold(s) stand; lift them first', NEW."id", standing
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WorkOrder_production_holds" AFTER UPDATE OF "status" ON "WorkOrder"
  FOR EACH ROW WHEN (OLD."status" = 'ON_HOLD' AND NEW."status" IS DISTINCT FROM OLD."status")
  EXECUTE FUNCTION "factory_work_order_production_holds"();
