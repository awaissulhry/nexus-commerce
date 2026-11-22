-- Written by hand (Prisma does not model triggers), after the generated 202611220300_order_files_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The order files tab's ONE schema wave ("order files 1/1", B-OF-030; design order-files-2026-11-22 13-backend §1, lead settles
-- L1; Owner D2, D3). apps/factory-api checks all of this first and answers in words (B-OF-031 the ask commands, B-OF-034 the
-- floor's photo for an ask); these rules are the last word, for every login, the owner included. The refusals are
-- check_violation (SQLSTATE 23514); their words name no customer (the brand wall) and no floor worker (worker privacy). FileAsk is
-- office only (no floor, partner or link grant: ownership/file-asks.json); the floor's answer is written by the API in the
-- tenant's system context, so this guard runs for the office runtime and the system only, and reads only tables the office reads
-- (SalesOrder, SalesOrderLine, WorkOrder, WorkOrderSize, WorkOrderOperation, Role, Team, User, StoredFile, Task).
--
--   FileAsk  NEW (B-OF-030), the 11 rules of 13-backend §1:
--     1  never deleted (accepted or cancelled instead); TRUNCATE refused.
--     2  born OPEN: no files, no answer, no decision, no cancel, no chase, no round, no check task.
--     3  its order: the ask carries the order's company and customer (also the foreign key); no new ask once the order is CLOSED
--        or CANCELLED (L1: PENDING_APPROVAL and every open state allowed). Read at the ask only: an ask made while the order was
--        open is still answered, decided or cancelled after it closed (a late signed paper must land, L2).
--     4  where it lands: SALES_ORDER the order itself (no line, work order, step or site); SALES_ORDER_LINE a line of this order
--        (no work order, step or site); WORK_ORDER a work order of the order's company and customer, not CANCELLED, not a repair,
--        with a cell of one of this order's lines (as the order files read lists them), its site the ask's, a step (when named)
--        one of its operations.
--     5  exactly one addressee: PERSON the person only, an active office person (never a portal person); OFFICE_ROLE /
--        FLOOR_ROLE the role only, a live role (not archived) of the OFFICE / FLOOR audience; FLOOR_TEAM the team only, an ACTIVE
--        team of the ask's site; STEP none of the three, the step named. Checked at the ask and on every reassign.
--     6  the floor walls: FLOOR_ROLE, FLOOR_TEAM and STEP only on a WORK_ORDER target, and never for a file with prices or body
--        data (the money wall and the measurements rule: the database's twin of the API's 400).
--     7  words: what is needed one line of 1 to 500 characters (factory_recall_words_ok); the reasons (asked again, cancelled)
--        the same, at least 3 characters. The kind asked for: DOCUMENT, PHOTO or ATTACHMENT (the upload's kinds).
--     8  frozen: id, tenant, company, customer, site, order, target, line, work order, step, kind, the prices and body data
--        marks, who asked and when. The words, the due day and the addressee change only while OPEN.
--     9  the states: OPEN → ARRIVED | CANCELLED; ARRIVED → ACCEPTED | CANCELLED | OPEN (asked again: rounds + 1, its reason, the
--        files and the answer cleared); ACCEPTED and CANCELLED are final (nothing changes). OPEN ⇔ no files and no answer;
--        ARRIVED ⇔ 1 to 10 files and when they arrived (who: an office person, or null for the floor); ACCEPTED ⇔ ARRIVED's
--        columns kept, when and by whom; CANCELLED ⇔ when, by whom and why. Each move changes only its own columns.
--     10 the files: on → ARRIVED each one a StoredFile of the record the ask lands on (the order, the line or the work order),
--        once, not DELETED, not found INFECTED by the virus scan; on → ACCEPTED every one AVAILABLE (a file held for the scan is
--        never accepted).
--     11 the chase: lastChasedAt only moves later, only while OPEN.
--   And, beside them (backstops of the same walls): who asked, answered, accepted or cancelled is an active office person when
--   named; the Tasks it names (the office addressees' "Upload: …", the asker's "Check: …") are Tasks about its own order, each
--   once; the lists (files, tasks) are never NULL.
--
-- No earlier function is redefined, and no StoredFile, Task, WorkOrder or floor trigger reads FileAsk. USED FROM EARLIER WAVES,
-- as they are: "factory_sales_refuse_truncate" (…_sales_guards), "factory_recall_words_ok" (…_recall_claims_w2b_guards),
-- "factory_supplier_office_person_ok" and "factory_supplier_list_ok" (…_suppliers_depth_w2b_guards).

-- =====================================================================================================================
-- FileAsk (file-asks.prisma; 13-backend §1 B-OF-030)
--   INSERT     rules 2-7 and 9; the asker an active office person.
--   UPDATE     an UPDATE that changes nothing passes; rule 8 (frozen), rule 9 (the move and its columns), rules 5-7 again on
--              what changed, rule 10 on → ARRIVED and → ACCEPTED, rule 11.
--   DELETE     refused (rule 1).
--   TRUNCATE   refused (rule 1).
CREATE FUNCTION "factory_file_ask_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed text[];
  order_company uuid;
  order_party uuid;
  order_status text;
  work_company uuid;
  work_site uuid;
  work_party uuid;
  work_status text;
  work_kind text;
  role_audience text;
  role_archived timestamptz;
  team_site uuid;
  team_status text;
  target_type text;
  target_id uuid;
  matched integer;
  addressee_changed boolean;
BEGIN
  -- Rule 1.
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'files: ask % is accepted or cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."fileIds" IS NULL OR NEW."taskIds" IS NULL THEN
    RAISE EXCEPTION 'files: ask % keeps its files and tasks as lists (empty, never NULL)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Rule 2.
    IF NEW."status" <> 'OPEN' OR cardinality(NEW."fileIds") <> 0 OR NEW."answeredAt" IS NOT NULL OR NEW."answeredById" IS NOT NULL
       OR NEW."acceptedAt" IS NOT NULL OR NEW."acceptedById" IS NOT NULL
       OR NEW."cancelledAt" IS NOT NULL OR NEW."cancelledById" IS NOT NULL OR NEW."cancelReason" IS NOT NULL
       OR NEW."lastChasedAt" IS NOT NULL OR NEW."rounds" <> 0 OR NEW."lastReason" IS NOT NULL OR NEW."checkTaskId" IS NOT NULL THEN
      RAISE EXCEPTION 'files: a new ask (%) is OPEN: no files, answer, decision, cancel, chase, round or check task yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_supplier_office_person_ok"(NEW."tenantId", NEW."askedById") THEN
      RAISE EXCEPTION 'files: ask % is made by an active office person', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- Rule 7: the kind asked for (fixed from here on).
    IF NEW."fileKind" NOT IN ('DOCUMENT', 'PHOTO', 'ATTACHMENT') THEN
      RAISE EXCEPTION 'files: ask % asks for a DOCUMENT, a PHOTO or an ATTACHMENT, not a %', NEW."id", NEW."fileKind"
        USING ERRCODE = 'check_violation';
    END IF;

    -- Rule 3: the order (locked against a close in the same instant).
    SELECT o."companyId", o."partyId", o."status"::text INTO order_company, order_party, order_status
      FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."salesOrderId" FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'files: ask % names an order of this session''s', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (order_company, order_party) IS DISTINCT FROM (NEW."companyId", NEW."partyId") THEN
      RAISE EXCEPTION 'files: ask % carries its order''s company and customer', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF order_status IN ('CLOSED', 'CANCELLED') THEN
      RAISE EXCEPTION 'files: order % is %: no new asks', NEW."salesOrderId", order_status
        USING ERRCODE = 'check_violation';
    END IF;

    -- Rule 4: where it lands.
    IF NEW."target" = 'SALES_ORDER' THEN
      IF NEW."salesOrderLineId" IS NOT NULL OR NEW."workOrderId" IS NOT NULL OR NEW."workOrderOperationId" IS NOT NULL OR NEW."siteId" IS NOT NULL THEN
        RAISE EXCEPTION 'files: ask % lands on the order itself: no line, work order, step or site', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."target" = 'SALES_ORDER_LINE' THEN
      IF NEW."salesOrderLineId" IS NULL OR NEW."workOrderId" IS NOT NULL OR NEW."workOrderOperationId" IS NOT NULL OR NEW."siteId" IS NOT NULL THEN
        RAISE EXCEPTION 'files: ask % lands on a line: the line only, no work order, step or site', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM 1 FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId" AND l."orderId" = NEW."salesOrderId";
      IF NOT FOUND THEN
        RAISE EXCEPTION 'files: ask % lands on a line of its own order', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NEW."workOrderId" IS NULL OR NEW."siteId" IS NULL OR NEW."salesOrderLineId" IS NOT NULL THEN
        RAISE EXCEPTION 'files: ask % lands on a work order: the work order and its site, no line', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT w."companyId", w."siteId", w."partyId", w."status"::text, w."kind"::text INTO work_company, work_site, work_party, work_status, work_kind
        FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
      IF NOT FOUND OR (work_company, work_party, work_site) IS DISTINCT FROM (NEW."companyId", NEW."partyId", NEW."siteId") THEN
        RAISE EXCEPTION 'files: ask % lands on a work order of its order''s company and customer, on that work order''s site', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF work_status = 'CANCELLED' OR work_kind = 'REPAIR' THEN
        RAISE EXCEPTION 'files: work order % is % (%): no asks land on it', NEW."workOrderId", work_status, work_kind
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM 1 FROM "WorkOrderSize" s
        JOIN "SalesOrderLine" l ON l."tenantId" = s."tenantId" AND l."id" = s."salesOrderLineId"
       WHERE s."tenantId" = NEW."tenantId" AND s."workOrderId" = NEW."workOrderId" AND l."orderId" = NEW."salesOrderId";
      IF NOT FOUND THEN
        RAISE EXCEPTION 'files: ask % lands on a work order that makes a line of its own order', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."workOrderOperationId" IS NOT NULL THEN
        PERFORM 1 FROM "WorkOrderOperation" op WHERE op."tenantId" = NEW."tenantId" AND op."id" = NEW."workOrderOperationId" AND op."workOrderId" = NEW."workOrderId";
        IF NOT FOUND THEN
          RAISE EXCEPTION 'files: ask % names a step of its own work order', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
    addressee_changed := true;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    -- Rule 8: what the ask is about never changes.
    IF (NEW."id", NEW."tenantId", NEW."companyId", NEW."partyId", NEW."siteId", NEW."salesOrderId", NEW."target", NEW."salesOrderLineId",
        NEW."workOrderId", NEW."workOrderOperationId", NEW."fileKind", NEW."priced", NEW."bodyData", NEW."askedById", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."id", OLD."tenantId", OLD."companyId", OLD."partyId", OLD."siteId", OLD."salesOrderId", OLD."target", OLD."salesOrderLineId",
        OLD."workOrderId", OLD."workOrderOperationId", OLD."fileKind", OLD."priced", OLD."bodyData", OLD."askedById", OLD."createdAt") THEN
      RAISE EXCEPTION 'files: what ask % is about, where it lands, its kind, its prices and body data marks, who asked and when never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- Rule 9: the move, and the columns it may change.
    IF OLD."status" IN ('ACCEPTED', 'CANCELLED') THEN
      RAISE EXCEPTION 'files: ask % is % (final): nothing of it changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    ELSIF OLD."status" = 'OPEN' AND NEW."status" = 'OPEN' THEN
      allowed := ARRAY['words', 'dueOn', 'addressee', 'addresseeUserId', 'addresseeRoleId', 'addresseeTeamId', 'taskIds', 'lastChasedAt', 'version', 'updatedAt'];
    ELSIF OLD."status" = 'OPEN' AND NEW."status" = 'ARRIVED' THEN
      allowed := ARRAY['status', 'fileIds', 'answeredAt', 'answeredById', 'checkTaskId', 'version', 'updatedAt'];
    ELSIF OLD."status" = 'ARRIVED' AND NEW."status" = 'ARRIVED' THEN
      allowed := ARRAY['checkTaskId', 'version', 'updatedAt'];
    ELSIF OLD."status" = 'ARRIVED' AND NEW."status" = 'OPEN' THEN
      allowed := ARRAY['status', 'fileIds', 'answeredAt', 'answeredById', 'rounds', 'lastReason', 'version', 'updatedAt'];
    ELSIF OLD."status" = 'ARRIVED' AND NEW."status" = 'ACCEPTED' THEN
      allowed := ARRAY['status', 'acceptedAt', 'acceptedById', 'version', 'updatedAt'];
    ELSIF NEW."status" = 'CANCELLED' THEN
      allowed := ARRAY['status', 'cancelledAt', 'cancelledById', 'cancelReason', 'version', 'updatedAt'];
    ELSE
      RAISE EXCEPTION 'files: ask % cannot move from % to % (OPEN → ARRIVED or CANCELLED; ARRIVED → ACCEPTED, CANCELLED or OPEN, asked again)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
      RAISE EXCEPTION 'files: ask % (% → %) changes only %', OLD."id", OLD."status", NEW."status", array_to_string(array_remove(array_remove(allowed, 'version'), 'updatedAt'), ', ')
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'ARRIVED' AND NEW."status" = 'OPEN' AND NEW."rounds" <> OLD."rounds" + 1 THEN
      RAISE EXCEPTION 'files: ask % asked again counts one more round (%), with its reason', OLD."id", OLD."rounds" + 1
        USING ERRCODE = 'check_violation';
    END IF;
    -- Rule 11: the chase only moves later.
    IF NEW."lastChasedAt" IS DISTINCT FROM OLD."lastChasedAt"
       AND (NEW."lastChasedAt" IS NULL OR (OLD."lastChasedAt" IS NOT NULL AND NEW."lastChasedAt" <= OLD."lastChasedAt")) THEN
      RAISE EXCEPTION 'files: ask % was last chased at %: the chase only moves later', OLD."id", OLD."lastChasedAt"
        USING ERRCODE = 'check_violation';
    END IF;
    addressee_changed := (NEW."addressee", NEW."addresseeUserId", NEW."addresseeRoleId", NEW."addresseeTeamId")
                         IS DISTINCT FROM (OLD."addressee", OLD."addresseeUserId", OLD."addresseeRoleId", OLD."addresseeTeamId");
  END IF;

  -- Rule 9: each state with its columns (every row).
  IF NEW."status" = 'OPEN' THEN
    IF cardinality(NEW."fileIds") <> 0 OR NEW."answeredAt" IS NOT NULL OR NEW."answeredById" IS NOT NULL
       OR NEW."acceptedAt" IS NOT NULL OR NEW."acceptedById" IS NOT NULL
       OR NEW."cancelledAt" IS NOT NULL OR NEW."cancelledById" IS NOT NULL OR NEW."cancelReason" IS NOT NULL THEN
      RAISE EXCEPTION 'files: ask % is OPEN: no files, no answer, no decision, not cancelled', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" IN ('ARRIVED', 'ACCEPTED') THEN
    IF cardinality(NEW."fileIds") NOT BETWEEN 1 AND 10 OR NEW."answeredAt" IS NULL
       OR NEW."cancelledAt" IS NOT NULL OR NEW."cancelledById" IS NOT NULL OR NEW."cancelReason" IS NOT NULL THEN
      RAISE EXCEPTION 'files: ask % is %: 1 to 10 files and when they arrived, not cancelled', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."status" = 'ACCEPTED') <> (NEW."acceptedAt" IS NOT NULL AND NEW."acceptedById" IS NOT NULL)
       OR (NEW."status" = 'ARRIVED' AND (NEW."acceptedAt" IS NOT NULL OR NEW."acceptedById" IS NOT NULL)) THEN
      RAISE EXCEPTION 'files: ask % is accepted (when and by whom, both) exactly when ACCEPTED', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."cancelledAt" IS NULL OR NEW."cancelledById" IS NULL OR NEW."cancelReason" IS NULL
       OR NEW."acceptedAt" IS NOT NULL OR NEW."acceptedById" IS NOT NULL THEN
      RAISE EXCEPTION 'files: ask % is cancelled with when, by whom and why, all three (never accepted)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((cardinality(NEW."fileIds") = 0 AND NEW."answeredAt" IS NULL AND NEW."answeredById" IS NULL)
            OR (cardinality(NEW."fileIds") BETWEEN 1 AND 10 AND NEW."answeredAt" IS NOT NULL)) THEN
      RAISE EXCEPTION 'files: ask % keeps the files and the answer it had when it was cancelled', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."rounds" < 0 OR (NEW."rounds" = 0) <> (NEW."lastReason" IS NULL) THEN
    RAISE EXCEPTION 'files: ask % carries the newest reason exactly once it was asked again (rounds %)', NEW."id", NEW."rounds"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rule 7: the words and the reasons, when written.
  IF TG_OP = 'INSERT' OR NEW."words" IS DISTINCT FROM OLD."words" THEN
    IF NOT "factory_recall_words_ok"(NEW."words", 500, false) THEN
      RAISE EXCEPTION 'files: ask % says what is needed in one line of 1 to 500 characters', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."lastReason" IS DISTINCT FROM OLD."lastReason" AND NEW."lastReason" IS NOT NULL
     AND (NOT "factory_recall_words_ok"(NEW."lastReason", 500, false) OR char_length(btrim(NEW."lastReason")) < 3) THEN
    RAISE EXCEPTION 'files: ask % is asked again with a reason in one line of 3 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."cancelReason" IS DISTINCT FROM OLD."cancelReason" AND NEW."cancelReason" IS NOT NULL
     AND (NOT "factory_recall_words_ok"(NEW."cancelReason", 500, false) OR char_length(btrim(NEW."cancelReason")) < 3) THEN
    RAISE EXCEPTION 'files: ask % is cancelled with a reason in one line of 3 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rules 5 and 6: the addressee, at the ask and on every reassign.
  IF addressee_changed THEN
    IF NEW."addressee" IN ('FLOOR_ROLE', 'FLOOR_TEAM', 'STEP') THEN
      IF NEW."target" <> 'WORK_ORDER' THEN
        RAISE EXCEPTION 'files: ask % to the floor (a floor team, a floor role or whoever works a step) lands on a work order', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."priced" OR NEW."bodyData" THEN
        RAISE EXCEPTION 'files: ask % to the floor never asks for a file with prices or body data', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."addressee" = 'PERSON' THEN
      IF NEW."addresseeUserId" IS NULL OR NEW."addresseeRoleId" IS NOT NULL OR NEW."addresseeTeamId" IS NOT NULL THEN
        RAISE EXCEPTION 'files: ask % to a person names the person only (no role, no team)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT "factory_supplier_office_person_ok"(NEW."tenantId", NEW."addresseeUserId") THEN
        RAISE EXCEPTION 'files: ask % to a person is to an active office person', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."addressee" IN ('OFFICE_ROLE', 'FLOOR_ROLE') THEN
      IF NEW."addresseeRoleId" IS NULL OR NEW."addresseeUserId" IS NOT NULL OR NEW."addresseeTeamId" IS NOT NULL THEN
        RAISE EXCEPTION 'files: ask % to a role names the role only (no person, no team)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."audience"::text, r."archivedAt" INTO role_audience, role_archived FROM "Role" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."addresseeRoleId";
      IF NOT FOUND OR role_archived IS NOT NULL
         OR role_audience IS DISTINCT FROM (CASE NEW."addressee" WHEN 'OFFICE_ROLE' THEN 'OFFICE' ELSE 'FLOOR' END) THEN
        RAISE EXCEPTION 'files: ask % to an % names a live role of that audience (an office role of the office, a floor role of the floor)', NEW."id", lower(replace(NEW."addressee"::text, '_', ' '))
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."addressee" = 'FLOOR_TEAM' THEN
      IF NEW."addresseeTeamId" IS NULL OR NEW."addresseeUserId" IS NOT NULL OR NEW."addresseeRoleId" IS NOT NULL THEN
        RAISE EXCEPTION 'files: ask % to a team names the team only (no person, no role)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT t."siteId", t."status"::text INTO team_site, team_status FROM "Team" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."addresseeTeamId";
      IF NOT FOUND OR team_site IS DISTINCT FROM NEW."siteId" OR team_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'files: ask % to a team names an active team of the work order''s site', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NEW."addresseeUserId" IS NOT NULL OR NEW."addresseeRoleId" IS NOT NULL OR NEW."addresseeTeamId" IS NOT NULL OR NEW."workOrderOperationId" IS NULL THEN
        RAISE EXCEPTION 'files: ask % to whoever works a step names the step, and no person, role or team', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- Who answered, accepted or cancelled: an active office person when named (the floor answers with no one: answeredById null).
  IF (NEW."answeredById" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."answeredById" IS DISTINCT FROM OLD."answeredById")
      AND NOT "factory_supplier_office_person_ok"(NEW."tenantId", NEW."answeredById"))
     OR (NEW."acceptedById" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."acceptedById" IS DISTINCT FROM OLD."acceptedById")
      AND NOT "factory_supplier_office_person_ok"(NEW."tenantId", NEW."acceptedById"))
     OR (NEW."cancelledById" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."cancelledById" IS DISTINCT FROM OLD."cancelledById")
      AND NOT "factory_supplier_office_person_ok"(NEW."tenantId", NEW."cancelledById")) THEN
    RAISE EXCEPTION 'files: ask % is answered, accepted or cancelled by an active office person (the floor answers as the floor, with no one named)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The Tasks it names: Tasks about its own order, each once.
  IF (TG_OP = 'INSERT' AND cardinality(NEW."taskIds") > 0) OR (TG_OP = 'UPDATE' AND NEW."taskIds" IS DISTINCT FROM OLD."taskIds") THEN
    IF NOT "factory_supplier_list_ok"(NEW."taskIds") THEN
      RAISE EXCEPTION 'files: ask % names each of its tasks once', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO matched FROM "Task" t
     WHERE t."tenantId" = NEW."tenantId" AND t."id" = ANY (NEW."taskIds") AND t."recordType" = 'SalesOrder' AND t."recordId" = NEW."salesOrderId";
    IF matched <> cardinality(NEW."taskIds") THEN
      RAISE EXCEPTION 'files: ask % names tasks about its own order only', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."checkTaskId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."checkTaskId" IS DISTINCT FROM OLD."checkTaskId") THEN
    PERFORM 1 FROM "Task" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."checkTaskId" AND t."recordType" = 'SalesOrder' AND t."recordId" = NEW."salesOrderId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'files: ask % names a check task about its own order', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Rule 10: the files sent for it.
  IF TG_OP = 'UPDATE' AND OLD."status" = 'OPEN' AND NEW."status" = 'ARRIVED' THEN
    target_type := CASE NEW."target" WHEN 'SALES_ORDER' THEN 'SalesOrder' WHEN 'SALES_ORDER_LINE' THEN 'SalesOrderLine' ELSE 'WorkOrder' END;
    target_id := CASE NEW."target" WHEN 'SALES_ORDER' THEN NEW."salesOrderId" WHEN 'SALES_ORDER_LINE' THEN NEW."salesOrderLineId" ELSE NEW."workOrderId" END;
    IF NOT "factory_supplier_list_ok"(NEW."fileIds") THEN
      RAISE EXCEPTION 'files: ask % is answered with each file once', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO matched FROM "StoredFile" f
     WHERE f."tenantId" = NEW."tenantId" AND f."id" = ANY (NEW."fileIds") AND f."recordType" = target_type AND f."recordId" = target_id
       AND f."status" <> 'DELETED';
    IF matched <> cardinality(NEW."fileIds") THEN
      RAISE EXCEPTION 'files: ask % is answered with files of the record it lands on (a %), none deleted', NEW."id", target_type
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1 FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = ANY (NEW."fileIds") AND f."scanStatus" = 'INFECTED';
    IF FOUND THEN
      RAISE EXCEPTION 'files: the virus scan found something in a file sent for ask %: it never answers an ask', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'ARRIVED' AND NEW."status" = 'ACCEPTED' THEN
    SELECT count(*) INTO matched FROM "StoredFile" f
     WHERE f."tenantId" = NEW."tenantId" AND f."id" = ANY (NEW."fileIds") AND f."status" = 'AVAILABLE';
    IF matched <> cardinality(NEW."fileIds") THEN
      RAISE EXCEPTION 'files: ask % is accepted only once every file sent for it is available (none still held by the virus scan)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "FileAsk_guard" AFTER INSERT OR UPDATE OR DELETE ON "FileAsk"
  FOR EACH ROW EXECUTE FUNCTION "factory_file_ask_guard"();
CREATE TRIGGER "FileAsk_no_truncate" BEFORE TRUNCATE ON "FileAsk"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_refuse_truncate"();
