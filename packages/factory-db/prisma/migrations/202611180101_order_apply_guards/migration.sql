-- Written by hand (Prisma does not model triggers), after the generated 202611180100_order_apply_schema and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The sales page (sales page plan, schema wave "sales page 1/1", B-SA-005; lead picks P6', P7', P21, P26, R1, R3, R10; review
-- 17-review F-1; 15-steps-notes §5 items 1-7). apps/factory-api checks all of this first and answers in words (B-SA-040
-- "Lower to the order", B-SA-041 the work-order changes, B-SA-046 / -047 the design change, B-SA-048 the ask's message,
-- B-SA-061 "Discuss"); these rules are the last word, for every login, the owner included. The refusals are check_violation
-- (SQLSTATE 23514); their words name no other customer (the brand wall: "One brand must not be able to see anything related
-- to any other brand"). Every helper reads rows as the session sees them: a row it cannot see reads as none.
--
--   OrderChangeRequest      (item 1, 2, 5) a DESIGN request: their words required (1 to 4000), no reason code, at least one
--                           line (a deferred check at commit: OrderChangeRequest_design_has_lines); the files it sends
--                           (fileIds) only on a DESIGN request: a list, never null, of 0 to 10, each once, written with it and
--                           never changed, each an AVAILABLE file of its own order or of one of the order's lines shared with
--                           its own customer; the ask's own message (askMessageId; the reference holds the party): the
--                           customer's INBOUND message shared with it, not held, on its order's thread, named with the ask or
--                           once while it waits (OPEN or COUNTERED, nothing else changed with it), never changed — answering
--                           and withdrawing never touch it.
--   OrderChangeRequestLine  (item 1) a DESIGN request names each of its lines once, as a whole (no size), the pieces as they are.
--   ChangeRequest           (item 3) orderChangeRequestId (the reference holds the party) only on a CUSTOMER request, naming a
--                           DESIGN request of its own customer, about a style that is that customer's own private label
--                           (Style.brandPartyId = partyId) and the style of one of the request's lines; set once, never changed.
--   Message                 (item 6) what it is about (aboutKind, aboutId): both or neither, one of seven kinds, a part of the
--                           order whose thread it is in; a message shared with the customer is never about a work order (office
--                           only). Message stays append-only (…_threads_composer_th_guards' factory_refuse_message_change, as it
--                           is), so it is never changed.
--   WorkOrderChange         (item 4) born PROPOSED, undecided, with no error, at version 1; of the order's customer (the
--                           reference) and a work order of that customer or of none (a mixed one of before the one-customer
--                           rule), open; its request one of its own order; its cells lines of its own order and cells of its
--                           own work order, lowered (LOWER_TO_ORDER, always with its work order) or raised (MAKE_MORE); the
--                           extra pieces with their outcome, both or neither, only when it lowers, each of a cell it lowers;
--                           proposed and decided by an active office person; while PROPOSED only a failed apply's words
--                           change; PROPOSED → APPLIED | DECLINED (words, left as is) | STALE once, then frozen; the work order
--                           an applied MAKE_MORE made, one of its customer. Never deleted, never truncated.
--   WorkOrderSize           (item 7) REDEFINED (lead pick R1; production's yes, lane agreement 11-18): on a RELEASED or
--                           IN_PROGRESS work order a cell may go down (a lower quantity, nothing else changed) or go, never
--                           below what is already cut, bundled or on a cut order; a raise, a new cell or any other change
--                           still only while DRAFT, in the same words as before.
--   WorkOrderMaterial       (item 7, for R1's "planned materials ... follow the new figure", B-SA-040) REDEFINED: on a RELEASED
--                           or IN_PROGRESS work order a planned material may follow its cell down (both quantities lower,
--                           nothing else changed) or go with a cell nothing of which is cut, bundled or on a cut order;
--                           anything else still only while DRAFT, in the same words as before.
--
-- Earlier functions REDEFINED here, each from its current body, word for word but for the lines marked B-SA-005:
--   factory_order_change_request_guard       (…_production_wave5_counter_guards, B-PR-40 EXTRA 2: its latest)
--   factory_order_change_request_line_guard  (…_brand_asks_guards, B-PR-23: its latest)
--   factory_work_order_size_guard            (…_followups_product_w2b4_guards, B-W2b-275: its latest)
--   factory_work_order_material_guard        (…_production_guards, W1: its only body)
-- Their triggers stay as they are. New helpers: "factory_work_order_cell_floor" (read by the two production functions; the
-- floor production's "Lower to the order" lowers to, B-SA-040 reads it with SELECT), "factory_work_order_change_cells_problem"
-- and "factory_message_about_ok". New triggers: OrderChangeRequest_design_has_lines (deferred), ChangeRequest_order_ask,
-- Message_about_check, WorkOrderChange_guard and WorkOrderChange_no_truncate. USED FROM EARLIER WAVES, as they are:
-- "factory_money_rome_day" (…_money_w2a_guards), "factory_order_change_request_batch_ok" and
-- "factory_order_change_request_impact_ok" (…_brand_asks_guards), "factory_changes_words_ok" (…_changes_samples_w2b_guards),
-- "factory_production_refuse_truncate" (…_production_guards).
--
-- The wave holds nothing else (R10): no floor "seen" store, no follow-up store, no Task.partyId index, no floor-note kind.
-- DESIGN is compared as text (NEW."kind"::text) wherever it is read: the value is new in this wave's schema migration.

-- =====================================================================================================================
-- B-SA-005 helpers.

-- The least a cell of a RELEASED or IN_PROGRESS work order may go down to (R1: "never below what is already cut"; 0: it may
-- go), the largest of:
--   garments cut from hides  the fewest pieces of any planned hide part of the cell (a HIDE-tracked material of its planned
--                            materials, its part the BOM line's placement or the item's code: factory-domain production/cutting
--                            rules partOf and setsCut, "one piece per part per garment"), in cut log entries that are neither a
--                            reversal nor reversed (the API's cutCountsOf);
--   garments bundled         per part (null: whole garments), the garments of its bundles that are not VOID and not split off a
--                            bundle that is not VOID (a split leaves the parent's quantity as it was cut); the largest part;
--   garments on cut orders   over its lines of cut orders not CANCELLED: what the reconciliation says was cut, else the line's
--                            garments (a planned, released, started or cut line holds them: re-plan or lower the line first).
CREATE FUNCTION "factory_work_order_cell_floor"(p_tenant uuid, p_cell uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(
    coalesce((SELECT min(coalesce(cut.pieces, 0))
                FROM (SELECT DISTINCT coalesce(NULLIF(btrim(b."placement"), ''), i."code") AS part
                        FROM "WorkOrderMaterial" m
                        JOIN "Item" i ON i."tenantId" = m."tenantId" AND i."id" = m."itemId" AND i."tracking" = 'HIDE'
                        LEFT JOIN "BomLine" b ON b."tenantId" = m."tenantId" AND b."id" = m."bomLineId"
                       WHERE m."tenantId" = p_tenant AND m."workOrderSizeId" = p_cell) planned
                LEFT JOIN (SELECT p."part", sum(p."pieces") AS pieces
                             FROM "CutLogPiece" p
                             JOIN "CutLog" g ON g."tenantId" = p."tenantId" AND g."id" = p."cutLogId"
                            WHERE p."tenantId" = p_tenant AND p."workOrderSizeId" = p_cell AND g."reversalOfId" IS NULL
                              AND NOT EXISTS (SELECT 1 FROM "CutLog" r WHERE r."tenantId" = g."tenantId" AND r."reversalOfId" = g."id")
                            GROUP BY p."part") cut ON cut."part" = planned.part), 0),
    coalesce((SELECT max(bundled.garments)
                FROM (SELECT sum(b."quantity") AS garments
                        FROM "Bundle" b
                       WHERE b."tenantId" = p_tenant AND b."workOrderSizeId" = p_cell AND b."status" <> 'VOID'
                         AND NOT EXISTS (SELECT 1 FROM "Bundle" parent
                                          WHERE parent."tenantId" = b."tenantId" AND parent."id" = b."parentBundleId" AND parent."status" <> 'VOID')
                       GROUP BY b."part") bundled), 0),
    coalesce((SELECT sum(coalesce(r."cutQuantity", l."quantity"))
                FROM "CutOrderLine" l
                JOIN "CutOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."cutOrderId" AND o."status" <> 'CANCELLED'
                LEFT JOIN "CutReconciliation" r ON r."tenantId" = l."tenantId" AND r."cutOrderLineId" = l."id"
               WHERE l."tenantId" = p_tenant AND l."workOrderSizeId" = p_cell), 0)
  )::integer
$$;

-- What is wrong with a work-order change's cells and extra pieces (null: nothing). Its cells: a JSON array of 1 to 200 objects
-- of exactly {salesOrderLineId, size, from, to, workOrderSizeId}: a line of its own order, a size code (1 to 40 trimmed
-- characters), whole pieces 0 to 100 000, each line and size once; LOWER_TO_ORDER: to below from, each naming a cell of its
-- own work order (of that line and size); MAKE_MORE: to above from, a cell named only of its own work order. Its extra
-- pieces (or none): a JSON array of 1 to 200 objects of exactly {workOrderSizeId, salesOrderLineId, size, count}, each a cell
-- the change lowers (of that line and size), once, count 1 to 100 000.
CREATE FUNCTION "factory_work_order_change_cells_problem"(p_tenant uuid, p_order uuid, p_work_order uuid, p_kind text, p_cells jsonb, p_extra jsonb) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  uuid_shape CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  cell_keys CONSTANT text[] := ARRAY['from', 'salesOrderLineId', 'size', 'to', 'workOrderSizeId'];
  extra_keys CONSTANT text[] := ARRAY['count', 'salesOrderLineId', 'size', 'workOrderSizeId'];
  entry jsonb;
  keys text[];
  line_id uuid;
  cell_id uuid;
  size_code text;
  pieces_from integer;
  pieces_to integer;
  seen text[] := ARRAY[]::text[];
  lowered text[] := ARRAY[]::text[];
  extra_seen uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_cells IS NULL OR jsonb_typeof(p_cells) <> 'array' OR jsonb_array_length(p_cells) NOT BETWEEN 1 AND 200 THEN
    RETURN 'its cells are a list of 1 to 200';
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(p_cells) LOOP
    IF jsonb_typeof(entry) <> 'object' THEN
      RETURN 'each cell is {salesOrderLineId, size, from, to, workOrderSizeId}';
    END IF;
    SELECT array_agg(k ORDER BY k COLLATE "C") INTO keys FROM jsonb_object_keys(entry) AS k;
    IF keys IS DISTINCT FROM cell_keys
       OR jsonb_typeof(entry->'salesOrderLineId') <> 'string' OR (entry->>'salesOrderLineId') !~ uuid_shape
       OR jsonb_typeof(entry->'size') <> 'string' OR (entry->>'size') = '' OR btrim(entry->>'size') <> (entry->>'size') OR length(entry->>'size') > 40
       OR jsonb_typeof(entry->'from') <> 'number' OR (entry->>'from') !~ '^[0-9]{1,6}$'
       OR jsonb_typeof(entry->'to') <> 'number' OR (entry->>'to') !~ '^[0-9]{1,6}$'
       OR NOT (jsonb_typeof(entry->'workOrderSizeId') = 'null' OR (jsonb_typeof(entry->'workOrderSizeId') = 'string' AND (entry->>'workOrderSizeId') ~ uuid_shape)) THEN
      RETURN 'each cell is {salesOrderLineId, size, from, to, workOrderSizeId}: a line, a size code of 1 to 40 trimmed characters, whole pieces from and to, its work order''s cell or null';
    END IF;
    line_id := (entry->>'salesOrderLineId')::uuid;
    cell_id := (entry->>'workOrderSizeId')::uuid;
    size_code := entry->>'size';
    pieces_from := (entry->>'from')::integer;
    pieces_to := (entry->>'to')::integer;
    IF pieces_from > 100000 OR pieces_to > 100000 THEN
      RETURN 'a cell counts 0 to 100000 pieces';
    END IF;
    IF (p_kind = 'LOWER_TO_ORDER' AND (pieces_to >= pieces_from OR cell_id IS NULL)) OR (p_kind = 'MAKE_MORE' AND pieces_to <= pieces_from) THEN
      RETURN 'it lowers its work order''s cells (to below from, each naming its cell) or makes more (to above from)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "SalesOrderLine" l WHERE l."tenantId" = p_tenant AND l."id" = line_id AND l."orderId" = p_order) THEN
      RETURN 'each cell is of a line of its own order';
    END IF;
    IF cell_id IS NOT NULL
       AND (p_work_order IS NULL
            OR NOT EXISTS (SELECT 1 FROM "WorkOrderSize" c
                            WHERE c."tenantId" = p_tenant AND c."id" = cell_id AND c."workOrderId" = p_work_order
                              AND c."salesOrderLineId" = line_id AND c."size" = size_code)) THEN
      RETURN 'each cell it names is a cell of its own work order, of that line and size';
    END IF;
    IF (line_id::text || '|' || size_code) = ANY (seen) THEN
      RETURN 'each line and size once';
    END IF;
    seen := seen || (line_id::text || '|' || size_code);
    IF p_kind = 'LOWER_TO_ORDER' THEN
      lowered := lowered || (cell_id::text || '|' || line_id::text || '|' || size_code);
    END IF;
  END LOOP;

  IF p_extra IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_extra) <> 'array' OR jsonb_array_length(p_extra) NOT BETWEEN 1 AND 200 THEN
    RETURN 'its extra pieces are a list of 1 to 200';
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(p_extra) LOOP
    IF jsonb_typeof(entry) <> 'object' THEN
      RETURN 'each extra is {workOrderSizeId, salesOrderLineId, size, count}';
    END IF;
    SELECT array_agg(k ORDER BY k COLLATE "C") INTO keys FROM jsonb_object_keys(entry) AS k;
    IF keys IS DISTINCT FROM extra_keys
       OR jsonb_typeof(entry->'workOrderSizeId') <> 'string' OR (entry->>'workOrderSizeId') !~ uuid_shape
       OR jsonb_typeof(entry->'salesOrderLineId') <> 'string' OR (entry->>'salesOrderLineId') !~ uuid_shape
       OR jsonb_typeof(entry->'size') <> 'string'
       OR jsonb_typeof(entry->'count') <> 'number' OR (entry->>'count') !~ '^[0-9]{1,6}$'
       OR (entry->>'count')::integer NOT BETWEEN 1 AND 100000 THEN
      RETURN 'each extra is {workOrderSizeId, salesOrderLineId, size, count}: a cell, its line and size, 1 to 100000 pieces';
    END IF;
    cell_id := (entry->>'workOrderSizeId')::uuid;
    IF NOT ((cell_id::text || '|' || (entry->>'salesOrderLineId') || '|' || (entry->>'size')) = ANY (lowered)) OR cell_id = ANY (extra_seen) THEN
      RETURN 'each extra is of a cell it lowers (that cell''s line and size), once';
    END IF;
    extra_seen := extra_seen || cell_id;
  END LOOP;
  RETURN NULL;
END
$$;

-- Is the record a message names a part of this sales order? One statement per kind (plpgsql), so a session is asked only for
-- the table of the kind it names; a row it cannot see reads as none.
CREATE FUNCTION "factory_message_about_ok"(p_tenant uuid, p_order uuid, p_kind text, p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_kind = 'SalesOrderLine' THEN
    RETURN EXISTS (SELECT 1 FROM "SalesOrderLine" x WHERE x."tenantId" = p_tenant AND x."id" = p_id AND x."orderId" = p_order);
  ELSIF p_kind = 'Shipment' THEN
    RETURN EXISTS (SELECT 1 FROM "Shipment" x WHERE x."tenantId" = p_tenant AND x."id" = p_id AND x."salesOrderId" = p_order);
  ELSIF p_kind = 'Invoice' THEN
    RETURN EXISTS (SELECT 1 FROM "Invoice" x WHERE x."tenantId" = p_tenant AND x."id" = p_id AND x."salesOrderId" = p_order);
  ELSIF p_kind = 'DepositRequest' THEN
    RETURN EXISTS (SELECT 1 FROM "DepositRequest" x WHERE x."tenantId" = p_tenant AND x."id" = p_id AND x."orderId" = p_order);
  ELSIF p_kind = 'OrderGate' THEN
    RETURN EXISTS (SELECT 1 FROM "OrderGate" x WHERE x."tenantId" = p_tenant AND x."id" = p_id AND x."salesOrderId" = p_order);
  ELSIF p_kind = 'OrderChangeRequest' THEN
    RETURN EXISTS (SELECT 1 FROM "OrderChangeRequest" x WHERE x."tenantId" = p_tenant AND x."id" = p_id AND x."orderId" = p_order);
  ELSIF p_kind = 'WorkOrder' THEN
    -- A work order of the order: one that makes a line of it (a cell of one of its lines).
    RETURN EXISTS (SELECT 1 FROM "WorkOrderSize" c JOIN "SalesOrderLine" l ON l."tenantId" = c."tenantId" AND l."id" = c."salesOrderLineId"
                    WHERE c."tenantId" = p_tenant AND c."workOrderId" = p_id AND l."orderId" = p_order);
  END IF;
  RETURN false;
END
$$;

-- =====================================================================================================================
-- OrderChangeRequest (portal-sales.prisma): REDEFINED from …_production_wave5_counter_guards (its header, …_brand_asks_guards'
-- and …_portal_sales_w2b_guards' say the rest). Items 1, 2 and 5.
CREATE OR REPLACE FUNCTION "factory_order_change_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  partner CONSTANT boolean := current_user = 'factory_partner_runtime';
  kept CONSTANT text[] := ARRAY['tenantId'];
  -- B-PR-23: an acceptance may also name the sample round it made (a SAMPLE_ROUND).
  answer_columns CONSTANT text[] := ARRAY['status', 'answer', 'answeredAt', 'answeredById', 'amendmentId', 'sampleRoundId', 'version', 'updatedAt'];
  withdraw_columns CONSTANT text[] := ARRAY['status', 'withdrawnAt', 'version', 'updatedAt'];
  -- B-PR-23: what an accepted request may still name, each once: its amendment, the sample round it made.
  amendment_columns CONSTANT text[] := ARRAY['amendmentId', 'sampleRoundId', 'version', 'updatedAt'];
  -- B-PR-23: the counter-offer, written once (OPEN → COUNTERED).
  counter_columns CONSTANT text[] := ARRAY['status', 'counterApprovalId', 'counteredAt', 'counteredById', 'counterDate', 'counterFee', 'counterNote', 'version', 'updatedAt'];
  answered boolean;
  order_status text;
  address_kinds text[];
  address_status text;
  amendment_made timestamptz;
  -- B-PR-23
  countered boolean;
  counter record;
  round record;
  user_audience text;
  user_status text;
  -- B-SA-005: naming the ask's own message in the order's conversation (once, while the request waits).
  ask_columns CONSTANT text[] := ARRAY['askMessageId', 'version', 'updatedAt'];
  ask record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal: change request % is answered or withdrawn, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."answer" IS NOT NULL OR NEW."answeredAt" IS NOT NULL OR NEW."answeredById" IS NOT NULL
       OR NEW."amendmentId" IS NOT NULL OR NEW."withdrawnAt" IS NOT NULL OR NEW."version" <> 1
       -- B-PR-23: not countered, no sample round made yet.
       OR NEW."counterApprovalId" IS NOT NULL OR NEW."counteredAt" IS NOT NULL OR NEW."counteredById" IS NOT NULL OR NEW."sampleRoundId" IS NOT NULL THEN
      RAISE EXCEPTION 'portal: a new change request is OPEN, unanswered, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT o."status"::text INTO order_status FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."orderId";
    -- B-PR-23: a PARTLY_SHIPPED order may still ask to cancel (its unshipped lines), rush, pause and resume (review fix R-35).
    IF FOUND AND order_status NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY')
       AND NOT (order_status = 'PARTLY_SHIPPED' AND NEW."kind" IN ('CANCEL', 'RUSH', 'HOLD', 'RESUME')) THEN
      RAISE EXCEPTION 'portal: order % is %; a change or a cancel is asked only while it is CONFIRMED, IN_PRODUCTION or READY (a PARTLY_SHIPPED order: a cancel, a rush, a pause or a resume)', NEW."orderId", order_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."requestedDate" < "factory_money_rome_day"(NEW."createdAt") THEN
      RAISE EXCEPTION 'portal: change request % asks for %, a day already past when it was asked', NEW."id", NEW."requestedDate"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-PR-23: a RESUME only of an order whose pause was accepted (an ACCEPTED HOLD request; whether its holds are still on is
    -- the API's: the partner role reads no hold).
    IF NEW."kind" = 'RESUME'
       AND NOT EXISTS (SELECT 1 FROM "OrderChangeRequest" r
                        WHERE r."tenantId" = NEW."tenantId" AND r."orderId" = NEW."orderId" AND r."kind" = 'HOLD' AND r."status" = 'ACCEPTED') THEN
      RAISE EXCEPTION 'portal: change request % asks to resume order %, whose pause was never accepted', NEW."id", NEW."orderId"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-PR-23: a batch holds the requests of one customer and one kind (the words name no other customer).
    IF NEW."batchId" IS NOT NULL
       AND NOT "factory_order_change_request_batch_ok"(NEW."tenantId", NEW."batchId", NEW."partyId", NEW."kind"::text, NEW."id") THEN
      RAISE EXCEPTION 'portal: change request % cannot join batch %: a batch holds the requests of one customer and one kind', NEW."id", NEW."batchId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."orderId", NEW."kind", NEW."reasonCode", NEW."reason", NEW."requestedDate", NEW."shipToAddressId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."orderId", OLD."kind", OLD."reasonCode", OLD."reason", OLD."requestedDate", OLD."shipToAddressId", OLD."createdAt", OLD."createdById")
       -- B-PR-23: nor the impact shown, the kind of round asked and the batch.
       OR (NEW."impact", NEW."sampleKind", NEW."batchId") IS DISTINCT FROM (OLD."impact", OLD."sampleKind", OLD."batchId")
       -- B-SA-005: nor the files a design change sends.
       OR NEW."fileIds" IS DISTINCT FROM OLD."fileIds" THEN
      RAISE EXCEPTION 'portal: the order, kind, ask and creation of change request % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-SA-005: the ask's own message, once named, never changes.
    IF OLD."askMessageId" IS NOT NULL AND NEW."askMessageId" IS DISTINCT FROM OLD."askMessageId" THEN
      RAISE EXCEPTION 'portal: change request % names its ask''s message once; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'portal: the version of change request % goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-PR-23: a COUNTERED request waits, as an OPEN one does.
    IF OLD."status" NOT IN ('OPEN', 'COUNTERED') THEN
      IF partner OR OLD."status" <> 'ACCEPTED'
         -- B-PR-23: its amendment, or the sample round it made, each named once.
         OR NOT ((OLD."amendmentId" IS NULL AND NEW."amendmentId" IS NOT NULL) OR (OLD."sampleRoundId" IS NULL AND NEW."sampleRoundId" IS NOT NULL))
         OR (OLD."amendmentId" IS NOT NULL AND NEW."amendmentId" IS DISTINCT FROM OLD."amendmentId")
         OR (OLD."sampleRoundId" IS NOT NULL AND NEW."sampleRoundId" IS DISTINCT FROM OLD."sampleRoundId")
         OR (to_jsonb(NEW) - (kept || amendment_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || amendment_columns)) THEN
        RAISE EXCEPTION 'portal: change request % is %; it never changes again (an accepted one names its amendment, or the sample round it made, once)', OLD."id", OLD."status"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."status" IN ('ACCEPTED', 'REFUSED') THEN
      IF partner THEN
        RAISE EXCEPTION 'portal: the office answers change request %, not the customer', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (to_jsonb(NEW) - (kept || answer_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer_columns)) THEN
        RAISE EXCEPTION 'portal: answering change request % changes only %', OLD."id", array_to_string(answer_columns, ', ')
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."status" = 'WITHDRAWN' THEN
      IF (to_jsonb(NEW) - (kept || withdraw_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || withdraw_columns)) THEN
        RAISE EXCEPTION 'portal: withdrawing change request % changes only %', OLD."id", array_to_string(withdraw_columns, ', ')
          USING ERRCODE = 'check_violation';
      END IF;
    -- B-PR-23: the office counters an OPEN request, once.
    ELSIF NEW."status" = 'COUNTERED' AND OLD."status" = 'OPEN' THEN
      IF partner THEN
        RAISE EXCEPTION 'portal: the office counters change request %, not the customer', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (to_jsonb(NEW) - (kept || counter_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || counter_columns)) THEN
        RAISE EXCEPTION 'portal: countering change request % changes only %', OLD."id", array_to_string(counter_columns, ', ')
          USING ERRCODE = 'check_violation';
      END IF;
    -- B-SA-005: a waiting request (OPEN or COUNTERED) names its ask's own message, once, and nothing else with it.
    ELSIF NEW."status" = OLD."status" AND OLD."askMessageId" IS NULL AND NEW."askMessageId" IS NOT NULL THEN
      IF (to_jsonb(NEW) - (kept || ask_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ask_columns)) THEN
        RAISE EXCEPTION 'portal: naming the ask''s message of change request % changes only %', OLD."id", array_to_string(ask_columns, ', ')
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      -- B-PR-23: … or its counter-offer (a COUNTERED request: by its answer or its withdrawal).
      RAISE EXCEPTION 'portal: an OPEN change request (%) changes only by its answer or its withdrawal, or by our counter-offer (a COUNTERED one by its answer or its withdrawal)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-PR-23: a COUNTERED request is ACCEPTED exactly when the customer said yes to the counter-offer: never refused or
    -- withdrawn after that yes.
    -- B-PR-40: … while that yes stands: once we put it back (the counter's answer reversed, B-PR-30b) it is no yes any more,
    -- and the request is refused (or withdrawn), never accepted.
    IF OLD."status" = 'COUNTERED' AND NEW."status" <> 'COUNTERED' THEN
      SELECT a."status"::text AS status, a."reversedAt" AS reversed_at INTO counter FROM "ApprovalRequest" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."counterApprovalId"; -- B-PR-40: + reversedAt
      IF FOUND AND (NEW."status" = 'ACCEPTED') <> (counter.status IN ('APPROVED', 'APPROVED_WITH_CHANGES') AND counter.reversed_at IS NULL) THEN -- B-PR-40: a yes put back is no yes
        RAISE EXCEPTION 'portal: change request % is ACCEPTED exactly when the customer said yes to its counter-offer, a yes we did not put back (it is now %, the counter-offer %)', OLD."id", NEW."status", counter.status || CASE WHEN counter.reversed_at IS NOT NULL THEN ', put back' ELSE '' END
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF (NEW."kind" = 'CANCEL' AND (NEW."reasonCode" IS NULL OR NEW."requestedDate" IS NOT NULL OR NEW."shipToAddressId" IS NOT NULL))
     OR (NEW."kind" = 'CHANGE' AND NEW."reasonCode" IS NOT NULL)
     OR NEW."reasonCode" !~ '^[A-Z][A-Z0-9_]{0,39}$'
     -- B-SA-005: a design change's words up to 4000.
     OR (NEW."reason" IS NOT NULL AND (btrim(NEW."reason") = '' OR length(NEW."reason") > CASE WHEN NEW."kind"::text = 'DESIGN' THEN 4000 ELSE 2000 END)) THEN
    RAISE EXCEPTION 'portal: change request % (%): a cancel gives a code of the CANCEL reason list and asks no date or address, a change has no reason code; their words up to 2000 (a design change up to 4000)', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-SA-005: a design change: their words (required), no reason code; the files it sends only on a design change: a list
  -- (never null) of 0 to 10, each once.
  IF (NEW."kind"::text = 'DESIGN' AND (NEW."reason" IS NULL OR NEW."reasonCode" IS NOT NULL))
     OR NEW."fileIds" IS NULL
     OR (cardinality(NEW."fileIds") > 0 AND NEW."kind"::text <> 'DESIGN')
     OR cardinality(NEW."fileIds") > 10
     OR (SELECT count(DISTINCT x) FROM unnest(NEW."fileIds") AS x) <> cardinality(NEW."fileIds") THEN
    RAISE EXCEPTION 'portal: change request % (%): a design change says in their words what should change (no reason code); only a design change sends files: up to 10, each once', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-SA-005: the files a design change sends (at Send): AVAILABLE files of its own order or of one of the order's lines,
  -- shared with its own customer. Read as the session: a portal session reads only its own customer's files, so another
  -- customer's file is refused in the same words as one that is not there.
  IF TG_OP = 'INSERT' AND cardinality(NEW."fileIds") > 0
     AND EXISTS (SELECT 1 FROM unnest(NEW."fileIds") AS x(file_id)
                  WHERE NOT EXISTS (SELECT 1 FROM "StoredFile" f
                                     WHERE f."tenantId" = NEW."tenantId" AND f."id" = x.file_id AND f."partyId" = NEW."partyId" AND f."status" = 'AVAILABLE'
                                       AND ((f."recordType" = 'SalesOrder' AND f."recordId" = NEW."orderId")
                                            OR (f."recordType" = 'SalesOrderLine'
                                                AND EXISTS (SELECT 1 FROM "SalesOrderLine" l WHERE l."tenantId" = f."tenantId" AND l."id" = f."recordId" AND l."orderId" = NEW."orderId"))))) THEN
    RAISE EXCEPTION 'portal: design change request % sends only available files of its own order or of its lines, shared with its own customer', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-SA-005 (P21): the ask's own message, when it is named: the customer's INBOUND message shared with it (the reference holds
  -- the party), not held, on its order's thread. Read as the session, as the files.
  IF NEW."askMessageId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."askMessageId" IS NULL) THEN
    SELECT m."direction"::text AS direction, m."held" AS held, t."recordType" AS record_type, t."recordId" AS record_id INTO ask
      FROM "Message" m JOIN "Thread" t ON t."tenantId" = m."tenantId" AND t."id" = m."threadId"
     WHERE m."tenantId" = NEW."tenantId" AND m."partyId" = NEW."partyId" AND m."id" = NEW."askMessageId";
    IF NOT FOUND OR ask.direction <> 'INBOUND' OR ask.held OR ask.record_type <> 'SalesOrder' OR ask.record_id <> NEW."orderId" THEN
      RAISE EXCEPTION 'portal: change request % names as its ask the customer''s own message in its order''s conversation', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- B-PR-23: the production asks' own columns: a code only on a cancel (required, above) or a pause (optional); the date on a
  -- change, a rush (the need-by date) or a split shipment (its first part's); the address on a change only; the kind of round
  -- exactly on a sample round, one of the four a customer asks; the round it made only on an ACCEPTED sample round.
  IF (NEW."kind" IN ('RUSH', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND') AND NEW."reasonCode" IS NOT NULL)
     OR (NEW."kind" NOT IN ('CHANGE', 'RUSH', 'SPLIT_SHIPMENT') AND NEW."requestedDate" IS NOT NULL)
     OR (NEW."kind" <> 'CHANGE' AND NEW."shipToAddressId" IS NOT NULL)
     OR (NEW."kind" = 'SAMPLE_ROUND') <> (NEW."sampleKind" IS NOT NULL)
     OR NEW."sampleKind"::text NOT IN ('PRE_PRODUCTION', 'SIZE_SET', 'TOP_OF_PRODUCTION', 'BRAND')
     OR (NEW."sampleRoundId" IS NOT NULL AND (NEW."kind" <> 'SAMPLE_ROUND' OR NEW."status" <> 'ACCEPTED')) THEN
    RAISE EXCEPTION 'portal: change request % (%): a code only on a cancel or a pause, a date only on a change, a rush or a split shipment, an address only on a change, the kind of round (pre-production, size set, top of production or the brand''s) exactly on a sample round, the round it made only once accepted', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: the impact shown at Send holds no number (never an amount).
  IF NOT "factory_order_change_request_impact_ok"(NEW."impact") THEN
    RAISE EXCEPTION 'portal: change request % keeps the impact shown at Send as a JSON object of words, codes, dates and yes or no, up to 8000 characters: no number in it, so never an amount', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: the counter-offer: its approval, when and by whom, all or none; COUNTERED always with it, an OPEN request never;
  -- what it offers (a date, a fee, words: at least one) only with it; the fee 0 or more; its words 1 to 2000; its date not
  -- before the day it was countered (Rome); countered not before it was asked, answered or withdrawn not before it was
  -- countered.
  countered := NEW."counterApprovalId" IS NOT NULL;
  IF countered <> (NEW."counteredAt" IS NOT NULL) OR countered <> (NEW."counteredById" IS NOT NULL)
     OR (NEW."status" = 'COUNTERED' AND NOT countered) OR (NEW."status" = 'OPEN' AND countered)
     OR (NOT countered AND (NEW."counterDate" IS NOT NULL OR NEW."counterFee" IS NOT NULL OR NEW."counterNote" IS NOT NULL))
     OR (countered AND NEW."counterDate" IS NULL AND NEW."counterFee" IS NULL AND NEW."counterNote" IS NULL)
     OR NEW."counterFee" < 0
     OR (NEW."counterNote" IS NOT NULL AND (btrim(NEW."counterNote") = '' OR length(NEW."counterNote") > 2000))
     OR NEW."counterDate" < "factory_money_rome_day"(NEW."counteredAt")
     OR NEW."counteredAt" < NEW."createdAt" OR NEW."answeredAt" < NEW."counteredAt" OR NEW."withdrawnAt" < NEW."counteredAt" THEN
    RAISE EXCEPTION 'portal: change request % is % with the wrong counter-offer: its approval request, when and by whom exactly when countered (always when COUNTERED), with a date, a fee of 0 or more or words up to 2000 (at least one), the date not before the day it was countered', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF countered AND (TG_OP = 'INSERT' OR OLD."counterApprovalId" IS NULL) THEN
    SELECT a."kind"::text AS kind, a."recordType" AS record_type, a."recordId" AS record_id, a."companyId" AS company_id, a."status"::text AS status
      INTO counter FROM "ApprovalRequest" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."counterApprovalId";
    IF FOUND AND (counter.kind <> 'COUNTER_OFFER' OR counter.record_type <> 'OrderChangeRequest' OR counter.record_id <> NEW."id"
                  OR counter.company_id <> NEW."companyId" OR counter.status <> 'OPEN') THEN
      RAISE EXCEPTION 'portal: change request % is countered by an OPEN COUNTER_OFFER approval request about it, of its own company and customer', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."counteredById";
    IF FOUND AND (user_audience <> 'OFFICE' OR user_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'portal: change request % is countered by an active office person', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- B-PR-23: the round an accepted sample round ask made: of the kind asked, for the request's customer, made after it was asked.
  IF NEW."sampleRoundId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."sampleRoundId" IS NULL) THEN
    SELECT r."kind"::text AS kind, r."partyId" AS party_id, r."createdAt" AS created_at INTO round
      FROM "SampleRound" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."sampleRoundId";
    IF FOUND AND (round.kind IS DISTINCT FROM NEW."sampleKind"::text OR round.party_id IS DISTINCT FROM NEW."partyId" OR round.created_at < NEW."createdAt") THEN
      RAISE EXCEPTION 'portal: change request % names the sample round it made: of the kind asked, for its own customer, made after it was asked', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  answered := NEW."status" IN ('ACCEPTED', 'REFUSED');
  IF answered <> (NEW."answeredAt" IS NOT NULL) OR answered <> (NEW."answeredById" IS NOT NULL) OR NEW."answeredAt" < NEW."createdAt"
     OR (NOT answered AND NEW."answer" IS NOT NULL)
     OR (NEW."status" = 'REFUSED' AND btrim(coalesce(NEW."answer", '')) = '')
     OR (NEW."answer" IS NOT NULL AND (btrim(NEW."answer") = '' OR length(NEW."answer") > 2000))
     OR (NEW."amendmentId" IS NOT NULL AND NEW."status" <> 'ACCEPTED') THEN
    RAISE EXCEPTION 'portal: change request % is %: the answer (when, who) exactly when ACCEPTED or REFUSED, words to refuse (up to 2000), an amendment only when ACCEPTED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL) OR NEW."withdrawnAt" < NEW."createdAt" THEN
    RAISE EXCEPTION 'portal: change request % is %: withdrawn (when) exactly when WITHDRAWN', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."shipToAddressId" IS NOT NULL AND TG_OP = 'INSERT' THEN
    SELECT a."kinds"::text[], a."status"::text INTO address_kinds, address_status
      FROM "PartyAddress" a WHERE a."tenantId" = NEW."tenantId" AND a."partyId" = NEW."partyId" AND a."id" = NEW."shipToAddressId";
    IF FOUND AND (NOT ('SHIP_TO' = ANY (address_kinds)) OR address_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'portal: change request % asks for one of the customer''s SHIP_TO addresses, not archived', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."amendmentId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."amendmentId" IS NULL) THEN
    SELECT m."createdAt" INTO amendment_made FROM "SalesOrderAmendment" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."amendmentId";
    IF FOUND AND amendment_made < NEW."createdAt" THEN
      RAISE EXCEPTION 'portal: change request % names an amendment made after it was asked', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- B-SA-005 (item 1): a design change names at least one line, written with it (in the same transaction): checked at commit.
CREATE FUNCTION "factory_order_change_request_design_lines"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "OrderChangeRequestLine" x WHERE x."tenantId" = NEW."tenantId" AND x."requestId" = NEW."id") THEN
    RAISE EXCEPTION 'portal: design change request % names at least one line of its order, written with it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "OrderChangeRequest_design_has_lines" AFTER INSERT ON "OrderChangeRequest"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."kind"::text = 'DESIGN')
  EXECUTE FUNCTION "factory_order_change_request_design_lines"();

-- =====================================================================================================================
-- OrderChangeRequestLine (portal-sales.prisma): REDEFINED from …_brand_asks_guards (its header there says the rest). Item 1.
CREATE OR REPLACE FUNCTION "factory_order_change_request_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_status text;
  request_kind text;
  request_order uuid;
  line_order uuid;
  -- B-PR-23
  line_style uuid;
  line_colourway uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'portal: what change request % asked is never changed or removed', OLD."requestId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r."status"::text, r."kind"::text, r."orderId" INTO request_status, request_kind, request_order
    FROM "OrderChangeRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."requestId" FOR SHARE;
  IF FOUND AND request_status <> 'OPEN' THEN
    RAISE EXCEPTION 'portal: change request % is %; what it asks is written while it is OPEN', NEW."requestId", request_status
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: and the line's style and colourway.
  SELECT l."orderId", l."styleId", l."colourwayId" INTO line_order, line_style, line_colourway
    FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."orderLineId";
  IF request_order IS NOT NULL AND line_order IS NOT NULL AND line_order <> request_order THEN
    RAISE EXCEPTION 'portal: change request % asks for a line of its own order', NEW."requestId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."quantity" < 0 OR NEW."quantity" > 100000 OR NEW."quantityBefore" < 0 OR NEW."quantityBefore" > 100000
     OR (request_kind = 'CANCEL' AND NEW."quantity" <> 0)
     -- B-PR-23: a change asks a different number, or the same number in another colourway.
     OR (request_kind = 'CHANGE' AND NEW."quantity" = NEW."quantityBefore" AND NEW."colourwayId" IS NULL)
     OR (NEW."size" IS NOT NULL AND (btrim(NEW."size") <> NEW."size" OR NEW."size" = '' OR length(NEW."size") > 40)) THEN
    RAISE EXCEPTION 'portal: change request % (%) asks 0 to 100000 pieces, before and asked: a cancel asks 0, a change a different number; a size of 1 to 40 trimmed characters', NEW."requestId", request_kind
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: another colourway only on a change: of the line's own style (the colourway's reference key), both or neither, not
  -- the one the line has.
  IF (NEW."styleId" IS NULL) <> (NEW."colourwayId" IS NULL)
     OR (NEW."colourwayId" IS NOT NULL AND request_kind IS NOT NULL AND request_kind <> 'CHANGE')
     OR (NEW."colourwayId" IS NOT NULL AND line_style IS NOT NULL AND (NEW."styleId" <> line_style OR NEW."colourwayId" = line_colourway)) THEN
    RAISE EXCEPTION 'portal: change request % asks another colourway only on a change: one of the line''s own style (style and colourway, both or neither), not the one the line has', NEW."requestId"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: a rush, a pause or a resume asks for the whole order (no lines); a split shipment's first part ships 1 to the
  -- pieces of each cell; a sample round names one line.
  IF request_kind IN ('RUSH', 'HOLD', 'RESUME')
     OR (request_kind = 'SPLIT_SHIPMENT' AND (NEW."quantity" < 1 OR NEW."quantity" > NEW."quantityBefore"))
     OR (request_kind = 'SAMPLE_ROUND'
         AND EXISTS (SELECT 1 FROM "OrderChangeRequestLine" x WHERE x."tenantId" = NEW."tenantId" AND x."requestId" = NEW."requestId" AND x."id" <> NEW."id")) THEN
    RAISE EXCEPTION 'portal: change request % (%): a rush, a pause or a resume asks for the whole order (no lines), a split shipment''s first part ships 1 to the pieces of each cell, a sample round names one line', NEW."requestId", request_kind
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-SA-005: a design change names each of its lines once (a null size is no key of the unique), as a whole (no size), the
  -- pieces as they are; at least one line: OrderChangeRequest_design_has_lines, at commit.
  IF request_kind = 'DESIGN'
     AND (NEW."size" IS NOT NULL OR NEW."quantity" <> NEW."quantityBefore"
          OR EXISTS (SELECT 1 FROM "OrderChangeRequestLine" x
                      WHERE x."tenantId" = NEW."tenantId" AND x."requestId" = NEW."requestId" AND x."orderLineId" = NEW."orderLineId" AND x."id" <> NEW."id")) THEN
    RAISE EXCEPTION 'portal: design change request % names each of its lines once, as a whole (no size), the pieces as they are', NEW."requestId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- ChangeRequest (changes.prisma; item 3, lead pick R3): the customer's design change that raised it. Its own trigger beside
-- …_changes_samples_w2b_guards' ChangeRequest_guard (not redefined). The reference holds the party (a request of another
-- customer is refused by it); this holds the rest: only on a CUSTOMER request (with its party: the reference is not checked
-- without one), naming a DESIGN request of its own customer, about a style that is that customer's own private label
-- (Style.brandPartyId = partyId: a style of our own collection or of another label never changes from a customer's ask) and
-- the style of one of the request's lines; set once, never changed or cleared.
CREATE FUNCTION "factory_change_request_order_ask_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ask_kind text;
  style_brand uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."orderChangeRequestId" IS NOT DISTINCT FROM OLD."orderChangeRequestId" THEN
      RETURN NULL;
    END IF;
    IF OLD."orderChangeRequestId" IS NOT NULL THEN
      RAISE EXCEPTION 'changes: change request % names the customer''s request that raised it once; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."orderChangeRequestId" IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW."source" <> 'CUSTOMER' OR NEW."partyId" IS NULL THEN
    RAISE EXCEPTION 'changes: change request % names a customer''s request only when it is the customer''s own (source CUSTOMER, with its customer)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r."kind"::text INTO ask_kind FROM "OrderChangeRequest" r
   WHERE r."tenantId" = NEW."tenantId" AND r."partyId" = NEW."partyId" AND r."id" = NEW."orderChangeRequestId";
  IF NOT FOUND OR ask_kind <> 'DESIGN' THEN
    RAISE EXCEPTION 'changes: change request % names a design change request of its own customer', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."brandPartyId" INTO style_brand FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
  IF style_brand IS DISTINCT FROM NEW."partyId" THEN
    RAISE EXCEPTION 'changes: change request % comes from a customer''s design change only for a style of that customer''s own private label (a style of our own collection or of another label never changes from a customer''s ask)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "OrderChangeRequestLine" x
                   JOIN "SalesOrderLine" l ON l."tenantId" = x."tenantId" AND l."id" = x."orderLineId"
                  WHERE x."tenantId" = NEW."tenantId" AND x."requestId" = NEW."orderChangeRequestId" AND l."styleId" = NEW."styleId") THEN
    RAISE EXCEPTION 'changes: change request % is about the style of one of the lines its customer''s design change names', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ChangeRequest_order_ask" AFTER INSERT OR UPDATE OF "orderChangeRequestId" ON "ChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_change_request_order_ask_check"();

-- =====================================================================================================================
-- Message (threads.prisma; item 6, B-SA-061 "Discuss"): what it is about. Its own trigger beside the TH ones (none
-- redefined); written once like the rest of the message (factory_refuse_message_change, as it is). Both or neither; one of the
-- seven kinds; only on a message of a sales order's thread, a part of that order (factory_message_about_ok); a message shared
-- with the customer is never about a work order (office only). Read as the session: a record it cannot see is "not a part of
-- this record", in the same words as one that is not there.
CREATE FUNCTION "factory_message_about_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  thread_type text;
  thread_record uuid;
BEGIN
  IF (NEW."aboutKind" IS NULL) <> (NEW."aboutId" IS NULL)
     OR NEW."aboutKind" NOT IN ('SalesOrderLine', 'Shipment', 'Invoice', 'DepositRequest', 'OrderGate', 'OrderChangeRequest', 'WorkOrder') THEN
    RAISE EXCEPTION 'threads: message % names what it is about by kind and id, both or neither: a line, shipment, invoice, deposit request, gate, change request or work order of its order', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."audience" = 'PARTNER' AND NEW."aboutKind" = 'WorkOrder' THEN
    RAISE EXCEPTION 'threads: message % is shared with the customer, so it is never about a work order (office only)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT t."recordType", t."recordId" INTO thread_type, thread_record
    FROM "Thread" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."threadId";
  IF NOT FOUND OR thread_type <> 'SalesOrder' OR NOT "factory_message_about_ok"(NEW."tenantId", thread_record, NEW."aboutKind", NEW."aboutId") THEN
    RAISE EXCEPTION 'threads: message % is about a part of its own order (not a part of this record)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Message_about_check" AFTER INSERT ON "Message"
  FOR EACH ROW WHEN (NEW."aboutKind" IS NOT NULL OR NEW."aboutId" IS NOT NULL)
  EXECUTE FUNCTION "factory_message_about_check"();

-- =====================================================================================================================
-- WorkOrderChange (order-apply.prisma; item 4, lead picks P6', R1; 13-backend B4b). Office only (no other grant).
--   INSERT     PROPOSED, undecided, no failed apply yet, no work order made, at version 1; its work order of the order's
--              customer or of none (a mixed one made before the one-customer rule), not COMPLETED, CLOSED or CANCELLED; its
--              request one of its own order (the reference holds the customer); its cells and extra pieces as
--              factory_work_order_change_cells_problem says; proposed by an active office person.
--   UPDATE     an UPDATE that changes nothing passes; the version goes up by one; while PROPOSED only a failed apply's words
--              (lastError) change; the decision PROPOSED → APPLIED | DECLINED | STALE writes only the status, when, by whom,
--              the words, the work order an applied MAKE_MORE made and lastError (kept or cleared); a decided change never
--              changes.
--   every row  its work order with its site, both or neither, always on LOWER_TO_ORDER; extra pieces with their outcome, both
--              or neither, only on LOWER_TO_ORDER; why in 1 to 500 characters, a failed apply up to 500, a decision up to 300;
--              when it was decided exactly once decided (not before it was proposed), by whom always to apply or decline, words
--              to decline ("Left as is"), none of it while PROPOSED; the work order made only on an APPLIED MAKE_MORE that named
--              none, a work order of its customer; decided by an active office person.
--   DELETE     refused (declined or made stale). TRUNCATE refused.
CREATE FUNCTION "factory_work_order_change_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  waiting_columns CONSTANT text[] := ARRAY['lastError', 'version', 'updatedAt'];
  decision_columns CONSTANT text[] := ARRAY['status', 'decidedAt', 'decidedById', 'decisionNote', 'madeWorkOrderId', 'lastError', 'version', 'updatedAt'];
  decided boolean;
  problem text;
  work_party uuid;
  work_state text;
  ask_order uuid;
  made_party uuid;
  user_audience text;
  user_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: work-order change % is declined or made stale, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PROPOSED' OR NEW."decidedAt" IS NOT NULL OR NEW."decidedById" IS NOT NULL OR NEW."decisionNote" IS NOT NULL
       OR NEW."madeWorkOrderId" IS NOT NULL OR NEW."lastError" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'production: a new work-order change is PROPOSED, undecided, with no failed apply yet, at version 1 (change %)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'production: the version of work-order change % goes up by one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'PROPOSED' THEN
      RAISE EXCEPTION 'production: work-order change % is %; it never changes again', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'PROPOSED' THEN
      IF (to_jsonb(NEW) - (kept || waiting_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || waiting_columns)) THEN
        RAISE EXCEPTION 'production: while it waits, work-order change % changes only by a failed apply''s words', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF (to_jsonb(NEW) - (kept || decision_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || decision_columns)) THEN
      RAISE EXCEPTION 'production: deciding work-order change % changes only %', OLD."id", array_to_string(decision_columns, ', ')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."siteId" IS NULL) <> (NEW."workOrderId" IS NULL) OR (NEW."kind" = 'LOWER_TO_ORDER' AND NEW."workOrderId" IS NULL) THEN
    RAISE EXCEPTION 'production: work-order change % names its work order with that work order''s site, both or neither, always when it lowers one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."extra" IS NULL) <> (NEW."extraOutcome" IS NULL) OR (NEW."extra" IS NOT NULL AND NEW."kind" <> 'LOWER_TO_ORDER') THEN
    RAISE EXCEPTION 'production: work-order change % names its extra pieces with what happens to them, both or neither, only when it lowers a work order', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_changes_words_ok"(NEW."reason", 500, true) OR NOT "factory_changes_words_ok"(NEW."lastError", 500, true)
     OR NOT "factory_changes_words_ok"(NEW."decisionNote", 300, true) THEN
    RAISE EXCEPTION 'production: work-order change % says why in 1 to 500 characters, a failed apply in up to 500, a decision in up to 300', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  decided := NEW."status" <> 'PROPOSED';
  IF decided <> (NEW."decidedAt" IS NOT NULL)
     OR (NEW."status" IN ('APPLIED', 'DECLINED') AND NEW."decidedById" IS NULL)
     OR (NOT decided AND (NEW."decidedById" IS NOT NULL OR NEW."decisionNote" IS NOT NULL))
     OR (NEW."status" = 'DECLINED' AND NEW."decisionNote" IS NULL)
     OR NEW."decidedAt" < NEW."createdAt" THEN
    RAISE EXCEPTION 'production: work-order change % is % with the wrong decision: when exactly once decided (not before it was proposed), by whom always to apply or decline, words to decline (left as is)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."madeWorkOrderId" IS NOT NULL AND (NEW."status" <> 'APPLIED' OR NEW."kind" <> 'MAKE_MORE' OR NEW."workOrderId" IS NOT NULL) THEN
    RAISE EXCEPTION 'production: work-order change % names the work order it made only when it applied a MAKE_MORE that named none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."workOrderId" IS NOT NULL THEN
      SELECT w."partyId", w."status"::text INTO work_party, work_state
        FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
      IF FOUND AND ((work_party IS NOT NULL AND work_party <> NEW."partyId") OR work_state IN ('COMPLETED', 'CLOSED', 'CANCELLED')) THEN
        RAISE EXCEPTION 'production: work-order change % names an open work order of its own order''s customer (or one made before the one-customer rule)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."requestId" IS NOT NULL THEN
      SELECT r."orderId" INTO ask_order FROM "OrderChangeRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."requestId";
      IF FOUND AND ask_order <> NEW."salesOrderId" THEN
        RAISE EXCEPTION 'production: work-order change % carries out a request of its own order', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    problem := "factory_work_order_change_cells_problem"(NEW."tenantId", NEW."salesOrderId", NEW."workOrderId", NEW."kind"::text, NEW."cells", NEW."extra");
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'production: work-order change %: %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."proposedById";
    IF NOT FOUND OR user_audience <> 'OFFICE' OR user_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'production: work-order change % is proposed by an active office person', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."status" = 'PROPOSED' AND NEW."status" <> 'PROPOSED' THEN
    IF NEW."decidedById" IS NOT NULL THEN
      SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."decidedById";
      IF NOT FOUND OR user_audience <> 'OFFICE' OR user_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'production: work-order change % is decided by an active office person', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."madeWorkOrderId" IS NOT NULL THEN
      SELECT w."partyId" INTO made_party FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."madeWorkOrderId";
      IF NOT FOUND OR made_party IS DISTINCT FROM NEW."partyId" THEN
        RAISE EXCEPTION 'production: work-order change % names the work order it made: one of its own customer', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WorkOrderChange_guard" AFTER INSERT OR UPDATE OR DELETE ON "WorkOrderChange"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_change_guard"();
CREATE TRIGGER "WorkOrderChange_no_truncate" BEFORE TRUNCATE ON "WorkOrderChange"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_production_refuse_truncate"();

-- =====================================================================================================================
-- WorkOrderSize (production.prisma; item 7, lead pick R1): REDEFINED `factory_work_order_size_guard` from
-- …_followups_product_w2b4_guards (its latest body, B-W2b-275; never redefined since), word for word but for the lines marked
-- B-SA-005. The triggers stay (…_production_guards' BEFORE WorkOrderSize_guard; the brand wall's WorkOrderSize_one_party lets
-- a cell of a mixed work order go down as before).
CREATE OR REPLACE FUNCTION "factory_work_order_size_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  order_kind text;
  part_of uuid;
  line record;
  -- B-SA-005 (R1): what a cell going down may change, and the least it may go down to.
  lowered CONSTANT text[] := ARRAY['quantity', 'version', 'updatedAt'];
  cut_floor integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."workOrderId" <> OLD."workOrderId" THEN
      RAISE EXCEPTION 'production: work order cell % never moves to another work order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    part_of := NEW."workOrderId";
    SELECT w."status"::text, w."kind"::text INTO state, order_kind FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId" FOR SHARE;
  ELSE
    part_of := OLD."workOrderId";
    SELECT w."status"::text, w."kind"::text INTO state, order_kind FROM "WorkOrder" w WHERE w."tenantId" = OLD."tenantId" AND w."id" = OLD."workOrderId" FOR SHARE;
  END IF;
  -- B-SA-005 (R1, production's "Lower to the order"): on a RELEASED or IN_PROGRESS work order a cell may still go down (a lower
  -- quantity, nothing else changed) or go, never below what is already cut, bundled or on a cut order
  -- (factory_work_order_cell_floor; a cell that goes: nothing of it). A raise, a new cell or any other change stays DRAFT only.
  IF state IN ('RELEASED', 'IN_PROGRESS')
     AND (TG_OP = 'DELETE'
          OR (TG_OP = 'UPDATE' AND NEW."quantity" < OLD."quantity" AND (to_jsonb(NEW) - lowered) = (to_jsonb(OLD) - lowered))) THEN
    cut_floor := "factory_work_order_cell_floor"(OLD."tenantId", OLD."id");
    IF (TG_OP = 'DELETE' AND cut_floor > 0) OR (TG_OP = 'UPDATE' AND NEW."quantity" < cut_floor) THEN
      RAISE EXCEPTION 'production: work order % is %; cell % goes down only to what is already cut, bundled or on a cut order (%), never below it', part_of, state, OLD."id", cut_floor
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'production: work order % is %; its size quantities are frozen (MES-005), they change only while it is DRAFT', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1 OR btrim(NEW."size") = '' THEN
    RAISE EXCEPTION 'production: work order cell % has a size and at least one piece', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF order_kind IS NOT NULL AND order_kind <> 'REPAIR'
     AND ((order_kind = 'MADE_TO_MEASURE') <> (NEW."measurementProfileId" IS NOT NULL)
          OR (order_kind = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1)) THEN
    RAISE EXCEPTION 'production: work order cell % is one made-to-measure unit with its measurement profile, or a size-grid cell without one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF order_kind = 'REPAIR' AND NEW."measurementProfileId" IS NOT NULL AND NEW."quantity" <> 1 THEN
    RAISE EXCEPTION 'production: repair cell % repairs one made-to-measure garment (one unit with its profile)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b-5 (B-W2b-275): the order line and its party both or neither; neither only on a SAMPLE work order (which names its
  -- sample round: B-W2b-212's WorkOrder trigger), for an internal or uncharged round.
  IF (NEW."salesOrderLineId" IS NULL) <> (NEW."partyId" IS NULL) THEN
    RAISE EXCEPTION 'production: work order cell % names its sales order line with that line''s party, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."salesOrderLineId" IS NULL AND order_kind IS DISTINCT FROM 'SAMPLE' THEN
    RAISE EXCEPTION 'production: work order cell % makes a sales order line: only a SAMPLE work order''s cell may name none (an internal or uncharged sample round)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."styleId", l."colourwayId", l."kind"::text AS kind, l."measurementProfileId" INTO line
    FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
  IF FOUND
     AND ((line."styleId", line."colourwayId", line."measurementProfileId") IS DISTINCT FROM (NEW."styleId", NEW."colourwayId", NEW."measurementProfileId")
          OR (order_kind IS NOT NULL AND order_kind <> 'REPAIR'
              AND line.kind <> CASE WHEN order_kind = 'SAMPLE' THEN 'SIZE_GRID' ELSE order_kind END)) THEN
    RAISE EXCEPTION 'production: work order cell % makes its sales order line %: the same style, colourway, kind and measurement profile (a repair: any kind; a sample: a size grid''s)', NEW."id", NEW."salesOrderLineId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- WorkOrderMaterial (production.prisma; item 7, for R1's "planned materials ... follow the new figure", B-SA-040): REDEFINED
-- `factory_work_order_material_guard` from …_production_guards (its only body), word for word but for the lines marked
-- B-SA-005. The triggers stay.
CREATE OR REPLACE FUNCTION "factory_work_order_material_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
  base_uom text;
  -- B-SA-005 (R1): what a planned material following its cell down may change.
  lowered CONSTANT text[] := ARRAY['quantity', 'baseQuantity', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."workOrderId" <> OLD."workOrderId" THEN
      RAISE EXCEPTION 'production: planned material % never moves to another work order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    part_of := NEW."workOrderId";
    SELECT w."status"::text INTO state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId" FOR SHARE;
  ELSE
    part_of := OLD."workOrderId";
    SELECT w."status"::text INTO state FROM "WorkOrder" w WHERE w."tenantId" = OLD."tenantId" AND w."id" = OLD."workOrderId" FOR SHARE;
  END IF;
  -- B-SA-005 (R1: "planned materials ... follow the new figure"): on a RELEASED or IN_PROGRESS work order a planned material
  -- may still follow its cell down (both quantities lower, nothing else changed) or go with a cell nothing of which is cut,
  -- bundled or on a cut order (factory_work_order_cell_floor 0). Anything else stays DRAFT only.
  IF state IN ('RELEASED', 'IN_PROGRESS')
     AND ((TG_OP = 'UPDATE' AND NEW."quantity" < OLD."quantity" AND NEW."baseQuantity" < OLD."baseQuantity"
           AND (to_jsonb(NEW) - lowered) = (to_jsonb(OLD) - lowered))
          OR (TG_OP = 'DELETE' AND "factory_work_order_cell_floor"(OLD."tenantId", OLD."workOrderSizeId") = 0)) THEN
    NULL;
  ELSIF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'production: work order % is %; its planned materials are frozen (MES-005), they change only while it is DRAFT', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" <= 0 OR NEW."baseQuantity" <= 0 THEN
    RAISE EXCEPTION 'production: planned material % has a quantity above 0 in both units', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."baseUom"::text INTO base_uom FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
  IF FOUND AND NEW."uom"::text = base_uom AND NEW."quantity" <> NEW."baseQuantity" THEN
    RAISE EXCEPTION 'production: planned material % is in the base unit %; its quantity is its base quantity', NEW."id", base_uom
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
