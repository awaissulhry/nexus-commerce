-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202610304000_stock_plan_w2a_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp, and keep it OUT of prisma/migrations while `npm run migration` runs.

-- The stock and planning schema of W2a (wave 4/7): the rules of its tables for every login, the owner included. The API
-- answers first, in words (B-W2a-11 reservations, B-W2a-15 counts, B-W2a-16 settings and capacity, B-W2a-22 pegging,
-- firm planned orders and exceptions); these are the last word. Every refusal is a check_violation (SQLSTATE 23514).
--
--   append-only    RequirementPegging: UPDATE, DELETE and TRUNCATE refused (scripts/factory/check-append-only.mjs).
--   history        a stock count's lines from SUBMITTED on (only the move each line posts, once, while APPROVED); an
--                  APPLIED or SIGNED_OFF count (only the year-end sign-off).
--   never deleted  Reservation (released), StockCount (cancelled), PlanningSettings, LineCapacity, WorkCentreCapacity,
--                  PlanningException (resolved): DELETE and TRUNCATE refused. ItemPlanning and the lines of a DRAFT or
--                  COUNTING count are deleted by the office; TRUNCATE refused.
--   one of a kind  one ACTIVE reservation per hide; one unresolved exception per site and condition (partial unique
--                  indexes).
--   W1 table       MaterialRequirement's firm planned order (factory_material_requirement_guard redefined: the whole body
--                  of …_supply_guards plus the firm columns).
--
-- The tenant and site of a row are held by the policies (USING and WITH CHECK) and by the references, not here: the
-- triggers leave "tenantId" and "siteId" to them, so a row moved to another tenant or site is refused by row-level
-- security. A rule that reads another row skips a row this session cannot see (another tenant's or site's); a trigger
-- reads only tables the role that fires it may read (the floor's path on Reservation reads none). "Everything but these
-- columns" is compared as jsonb (to_jsonb(row) minus the named keys), so a column added later is frozen too unless a
-- later migration names it.

-- =====================================================================================================================
-- Shared
CREATE FUNCTION "factory_stock_plan_w2a_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock and planning: TRUNCATE on "%" is refused; its rows are never deleted', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_stock_plan_w2a_refuse_history_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; the planning run''s pegging is never changed and no row of it is removed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- =====================================================================================================================
-- Reservation (B-W2a-11; SCM-205, SCM-209, SCM-210)
--   INSERT     ACTIVE, nothing issued or released; a leather item tracked by HIDE is reserved by AREA or HIDE, any other
--              by QUANTITY; a colour exactly when the item has colours (a lot's colour when a lot is named); the lot is
--              not REJECTED, the hide neither CONSUMED nor SCRAPPED; held for a work order of the site that is DRAFT,
--              RELEASED or IN_PROGRESS, or for a line of a CONFIRMED, IN_PRODUCTION, READY or PARTLY_SHIPPED order of
--              the company that is not made at another site.
--   UPDATE     an UPDATE that changes nothing passes. While ACTIVE the office changes the quantity (never below what was
--              issued), the need date and note, what was issued, and moves it ACTIVE → ISSUED | RELEASED; what it holds,
--              for what, and its creation never change. A floor session (factory_floor_runtime) changes only what was
--              issued and ACTIVE → ISSUED. ISSUED and RELEASED are final.
--   every row  quantity above 0, issued 0 to quantity; ISSUED exactly with its time once all of it was issued; RELEASED
--              exactly with when, by whom and why; a HIDE names its hide and lot, the others no hide; exactly one demand,
--              the order line with its party.
--   DELETE     refused (released instead). TRUNCATE refused.
CREATE FUNCTION "factory_reservation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  office_moves CONSTANT text[] := ARRAY['quantity', 'issuedQuantity', 'needDate', 'status', 'issuedAt', 'releasedAt',
    'releasedById', 'releaseReason', 'note', 'version', 'updatedAt'];
  floor_moves CONSTANT text[] := ARRAY['issuedQuantity', 'status', 'issuedAt', 'version', 'updatedAt'];
  item_tracking text;
  lot_colour uuid;
  lot_state text;
  hide_state text;
  work_state text;
  line_company uuid;
  line_site uuid;
  order_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reservations: reservation % is released, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."status" <> 'ACTIVE' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'reservations: reservation % is %; it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime' THEN
      IF (to_jsonb(NEW) - (kept || floor_moves)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || floor_moves))
         OR NEW."status" NOT IN ('ACTIVE', 'ISSUED') THEN
        RAISE EXCEPTION 'reservations: a floor session records only what was issued against reservation % (and ISSUED)', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF (to_jsonb(NEW) - (kept || office_moves)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || office_moves)) THEN
      RAISE EXCEPTION 'reservations: what reservation % holds and what for never change; release it and reserve again', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."status" <> 'ACTIVE' OR NEW."issuedQuantity" <> 0 OR NEW."issuedAt" IS NOT NULL OR NEW."releasedAt" IS NOT NULL
       OR NEW."releasedById" IS NOT NULL OR NEW."releaseReason" IS NOT NULL THEN
      RAISE EXCEPTION 'reservations: reservation % starts ACTIVE, with nothing issued or released', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."quantity" <= 0 OR NEW."issuedQuantity" < 0 OR NEW."issuedQuantity" > NEW."quantity" THEN
    RAISE EXCEPTION 'reservations: reservation % holds a quantity above 0, of which 0 up to all of it was issued', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ISSUED') <> (NEW."issuedAt" IS NOT NULL)
     OR (NEW."status" = 'ISSUED' AND NEW."issuedQuantity" <> NEW."quantity") THEN
    RAISE EXCEPTION 'reservations: reservation % is ISSUED exactly with its time, once all of it was issued', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'RELEASED') <> (NEW."releasedAt" IS NOT NULL)
     OR (NEW."releasedAt" IS NULL) <> (NEW."releasedById" IS NULL)
     OR (NEW."releasedAt" IS NULL) <> (btrim(coalesce(NEW."releaseReason", '')) = '') THEN
    RAISE EXCEPTION 'reservations: reservation % is RELEASED exactly with when, by whom and why (SCM-210)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'HIDE') <> (NEW."hideId" IS NOT NULL) OR (NEW."hideId" IS NOT NULL AND NEW."lotId" IS NULL) THEN
    RAISE EXCEPTION 'reservations: reservation % names its hide and lot when it is a HIDE, and no hide otherwise', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."workOrderId" IS NULL) = (NEW."salesOrderLineId" IS NULL) OR (NEW."partyId" IS NULL) <> (NEW."salesOrderLineId" IS NULL) THEN
    RAISE EXCEPTION 'reservations: reservation % is held for exactly one work order or one sales order line (with its party)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT i."tracking"::text INTO item_tracking FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND (NEW."kind" = 'QUANTITY') = (item_tracking = 'HIDE') THEN
      RAISE EXCEPTION 'reservations: reservation % is a % of an item tracked %: leather tracked hide by hide is reserved by AREA or HIDE, any other item by QUANTITY', NEW."id", NEW."kind", item_tracking
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."itemColourId" IS NULL
       AND EXISTS (SELECT 1 FROM "ItemColour" c WHERE c."tenantId" = NEW."tenantId" AND c."itemId" = NEW."itemId") THEN
      RAISE EXCEPTION 'reservations: reservation % names the colour it holds: its item comes in colours', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."lotId" IS NOT NULL THEN
      SELECT l."itemColourId", l."qualityStatus"::text INTO lot_colour, lot_state
        FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."lotId";
      IF FOUND AND (lot_colour IS DISTINCT FROM NEW."itemColourId" OR lot_state = 'REJECTED') THEN
        RAISE EXCEPTION 'reservations: reservation % holds lot % in the lot''s own colour, and never a REJECTED lot', NEW."id", NEW."lotId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."hideId" IS NOT NULL THEN
      SELECT h."state"::text INTO hide_state
        FROM "Hide" h WHERE h."tenantId" = NEW."tenantId" AND h."siteId" = NEW."siteId" AND h."id" = NEW."hideId";
      IF FOUND AND hide_state IN ('CONSUMED', 'SCRAPPED') THEN
        RAISE EXCEPTION 'reservations: hide % is %; nothing of it can be reserved', NEW."hideId", hide_state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."workOrderId" IS NOT NULL THEN
      SELECT w."status"::text INTO work_state
        FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
      IF FOUND AND work_state NOT IN ('DRAFT', 'RELEASED', 'IN_PROGRESS') THEN
        RAISE EXCEPTION 'reservations: work order % is %; stock is reserved only for an open work order', NEW."workOrderId", work_state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."salesOrderLineId" IS NOT NULL THEN
      SELECT l."companyId", l."siteId", o."status"::text INTO line_company, line_site, order_state
        FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."orderId"
        WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
      IF FOUND AND (line_company <> NEW."companyId" OR (line_site IS NOT NULL AND line_site <> NEW."siteId")
                    OR order_state NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED')) THEN
        RAISE EXCEPTION 'reservations: sales order line % is not a line of an open order of the company made at this site', NEW."salesOrderLineId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Reservation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Reservation"
  FOR EACH ROW EXECUTE FUNCTION "factory_reservation_guard"();
CREATE TRIGGER "Reservation_no_truncate" BEFORE TRUNCATE ON "Reservation"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_stock_plan_w2a_refuse_truncate"();

-- No two ACTIVE reservations hold the same hide (SCM-194: no double use).
CREATE UNIQUE INDEX "Reservation_one_active_per_hide" ON "Reservation" ("tenantId", "hideId")
  WHERE "status" = 'ACTIVE' AND "hideId" IS NOT NULL;

-- =====================================================================================================================
-- StockCount (B-W2a-15; SCM-224, SCM-230; SCM-229 and SCM-293 for the approval)
--   INSERT     DRAFT or COUNTING, nothing submitted, approved, sent back, applied, signed off or cancelled.
--   UPDATE     an UPDATE that changes nothing passes; the company, number, kind, scope, inventory date and creation never
--              change. DRAFT → COUNTING | CANCELLED; COUNTING → SUBMITTED | CANCELLED; SUBMITTED → APPROVED | COUNTING
--              (sent back) | CANCELLED; APPROVED → APPLIED | CANCELLED; APPLIED → SIGNED_OFF (a year-end count).
--              APPLIED changes only by that sign-off; SIGNED_OFF and CANCELLED never change. The start and snapshot are
--              set once; the submission is written only in COUNTING → SUBMITTED and cleared in SUBMITTED → COUNTING, which
--              writes the rejection (when, by whom, why); the approval only in SUBMITTED → APPROVED, the apply only in
--              APPROVED → APPLIED, the sign-off only in APPLIED → SIGNED_OFF, the cancellation only in its move.
--              Submitting needs every line counted and every recount asked for done; approving a submission that needs
--              an approval needs an approver who counted or recounted no line that differs (SCM-229, SCM-293); applying
--              needs every line that differs to name its COUNT move (write the lines first, then the count).
--   every row  a number; YEAR_END exactly with its inventory date; a lot in the scope with its item; started and
--              snapshot exactly from COUNTING on (none while DRAFT); submitted (when, by whom, the value of the
--              differences, 0 or more) from SUBMITTED on, none while DRAFT or COUNTING; approved exactly from APPROVED on
--              (none before); applied exactly from APPLIED on; signed off with its valued list (a StoredFile of the count)
--              exactly when SIGNED_OFF; cancelled with its reason exactly when CANCELLED; a rejection all or none.
--   DELETE     refused (cancelled instead). TRUNCATE refused.
CREATE FUNCTION "factory_stock_count_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  submit_cols CONSTANT text[] := ARRAY['submittedAt', 'submittedById', 'differenceAmount', 'approvalRequired'];
  approve_cols CONSTANT text[] := ARRAY['approvedAt', 'approvedById', 'approvalNote'];
  reject_cols CONSTANT text[] := ARRAY['rejectedAt', 'rejectedById', 'rejectReason'];
  apply_cols CONSTANT text[] := ARRAY['appliedAt', 'appliedById'];
  sign_cols CONSTANT text[] := ARRAY['signedOffAt', 'signedOffById', 'valuedListFileId'];
  cancel_cols CONSTANT text[] := ARRAY['cancelledAt', 'cancelReason'];
  moved boolean;
  file_type text;
  file_record uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'counts: stock count % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('DRAFT', 'COUNTING') OR NEW."submittedAt" IS NOT NULL OR NEW."approvedAt" IS NOT NULL
       OR NEW."rejectedAt" IS NOT NULL OR NEW."appliedAt" IS NOT NULL OR NEW."signedOffAt" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN
      RAISE EXCEPTION 'counts: stock count % starts DRAFT or COUNTING, with nothing submitted, decided, applied or signed off', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."kind", NEW."locationId", NEW."itemId", NEW."lotId", NEW."itemKind",
        NEW."inventoryDate", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."number", OLD."kind", OLD."locationId", OLD."itemId", OLD."lotId", OLD."itemKind",
        OLD."inventoryDate", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'counts: the company, number, kind, scope, inventory date and creation of stock count % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    moved := NEW."status" <> OLD."status";
    IF OLD."status" IN ('SIGNED_OFF', 'CANCELLED') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'counts: stock count % is %; it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'APPLIED'
       AND (NEW."status" <> 'SIGNED_OFF'
            OR (to_jsonb(NEW) - (kept || sign_cols || ARRAY['status', 'version', 'updatedAt']))
               IS DISTINCT FROM (to_jsonb(OLD) - (kept || sign_cols || ARRAY['status', 'version', 'updatedAt']))) THEN
      RAISE EXCEPTION 'counts: stock count % is APPLIED: its history changes no more, but the year-end sign-off', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF moved AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('COUNTING', 'CANCELLED'))
                      OR (OLD."status" = 'COUNTING' AND NEW."status" IN ('SUBMITTED', 'CANCELLED'))
                      OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('APPROVED', 'COUNTING', 'CANCELLED'))
                      OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('APPLIED', 'CANCELLED'))
                      OR (OLD."status" = 'APPLIED' AND NEW."status" = 'SIGNED_OFF')) THEN
      RAISE EXCEPTION 'counts: stock count % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."startedAt" IS NOT NULL AND NEW."startedAt" IS DISTINCT FROM OLD."startedAt")
       OR (OLD."snapshotAt" IS NOT NULL AND NEW."snapshotAt" IS DISTINCT FROM OLD."snapshotAt") THEN
      RAISE EXCEPTION 'counts: the start and snapshot of stock count % are set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (moved AND ((OLD."status" = 'COUNTING' AND NEW."status" = 'SUBMITTED') OR (OLD."status" = 'SUBMITTED' AND NEW."status" = 'COUNTING')))
       AND (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY (submit_cols))
           IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY (submit_cols)) THEN
      RAISE EXCEPTION 'counts: stock count % is submitted (and its differences valued) only in the move COUNTING → SUBMITTED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (moved AND OLD."status" = 'SUBMITTED' AND NEW."status" = 'APPROVED')
       AND (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY (approve_cols))
           IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY (approve_cols)) THEN
      RAISE EXCEPTION 'counts: stock count % is approved only in the move SUBMITTED → APPROVED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF moved AND OLD."status" = 'SUBMITTED' AND NEW."status" = 'COUNTING' THEN
      IF NEW."rejectedAt" IS NULL OR NEW."rejectedAt" IS NOT DISTINCT FROM OLD."rejectedAt" THEN
        RAISE EXCEPTION 'counts: stock count % goes back to COUNTING with a new rejection (when, by whom, why)', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY (reject_cols))
          IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY (reject_cols)) THEN
      RAISE EXCEPTION 'counts: the rejection of stock count % is written only in the move SUBMITTED → COUNTING', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (moved AND NEW."status" = 'APPLIED')
       AND (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY (apply_cols))
           IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY (apply_cols)) THEN
      RAISE EXCEPTION 'counts: stock count % is applied only in the move APPROVED → APPLIED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (moved AND NEW."status" = 'SIGNED_OFF')
       AND (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY (sign_cols))
           IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY (sign_cols)) THEN
      RAISE EXCEPTION 'counts: stock count % is signed off only in the move APPLIED → SIGNED_OFF', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (moved AND NEW."status" = 'CANCELLED')
       AND (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY (cancel_cols))
           IS DISTINCT FROM (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY (cancel_cols)) THEN
      RAISE EXCEPTION 'counts: stock count % is cancelled only in its move to CANCELLED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF moved AND NEW."status" = 'SUBMITTED'
       AND EXISTS (SELECT 1 FROM "StockCountLine" l
                   WHERE l."tenantId" = NEW."tenantId" AND l."countId" = NEW."id"
                     AND (l."countedQuantity" IS NULL OR (l."recountRequestedAt" IS NOT NULL AND l."recountQuantity" IS NULL))) THEN
      RAISE EXCEPTION 'counts: stock count % is submitted once every line is counted and every recount asked for is done', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF moved AND NEW."status" = 'APPROVED' AND NEW."approvalRequired"
       AND EXISTS (SELECT 1 FROM "StockCountLine" l
                   WHERE l."tenantId" = NEW."tenantId" AND l."countId" = NEW."id"
                     AND coalesce(l."recountQuantity", l."countedQuantity") <> l."expectedQuantity"
                     AND (l."countedById" = NEW."approvedById" OR l."recountedById" = NEW."approvedById")) THEN
      RAISE EXCEPTION 'counts: % counted a line of stock count % that differs; the counter never approves their own variance (SCM-229)', NEW."approvedById", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF moved AND NEW."status" = 'APPLIED'
       AND EXISTS (SELECT 1 FROM "StockCountLine" l
                   WHERE l."tenantId" = NEW."tenantId" AND l."countId" = NEW."id"
                     AND coalesce(l."recountQuantity", l."countedQuantity") <> l."expectedQuantity" AND l."moveId" IS NULL) THEN
      RAISE EXCEPTION 'counts: stock count % is applied once every line that differs names its COUNT move (write the lines first)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."number") = '' OR (NEW."kind" = 'YEAR_END') <> (NEW."inventoryDate" IS NOT NULL)
     OR (NEW."lotId" IS NOT NULL AND NEW."itemId" IS NULL) THEN
    RAISE EXCEPTION 'counts: stock count % has a number, an inventory date exactly when it is YEAR_END, and the item of a lot in its scope', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."startedAt" IS NULL) <> (NEW."snapshotAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND NEW."startedAt" IS NOT NULL)
     OR (NEW."status" NOT IN ('DRAFT', 'CANCELLED') AND NEW."startedAt" IS NULL) THEN
    RAISE EXCEPTION 'counts: stock count % has its start and snapshot exactly from COUNTING on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."submittedAt" IS NULL) <> (NEW."submittedById" IS NULL) OR (NEW."submittedAt" IS NULL) <> (NEW."differenceAmount" IS NULL)
     OR NEW."differenceAmount" < 0
     OR (NEW."status" IN ('DRAFT', 'COUNTING') AND NEW."submittedAt" IS NOT NULL)
     OR (NEW."status" IN ('SUBMITTED', 'APPROVED', 'APPLIED', 'SIGNED_OFF') AND NEW."submittedAt" IS NULL) THEN
    RAISE EXCEPTION 'counts: stock count % is submitted (when, by whom, the value of its differences, 0 or more) exactly from SUBMITTED on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL)
     OR (NEW."status" IN ('DRAFT', 'COUNTING', 'SUBMITTED') AND NEW."approvedAt" IS NOT NULL)
     OR (NEW."status" IN ('APPROVED', 'APPLIED', 'SIGNED_OFF') AND NEW."approvedAt" IS NULL) THEN
    RAISE EXCEPTION 'counts: stock count % is approved (when, by whom) exactly from APPROVED on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."appliedAt" IS NULL) <> (NEW."appliedById" IS NULL)
     OR (NEW."appliedAt" IS NOT NULL) <> (NEW."status" IN ('APPLIED', 'SIGNED_OFF')) THEN
    RAISE EXCEPTION 'counts: stock count % is applied (when, by whom) exactly from APPLIED on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."signedOffAt" IS NULL) <> (NEW."signedOffById" IS NULL) OR (NEW."signedOffAt" IS NULL) <> (NEW."valuedListFileId" IS NULL)
     OR (NEW."signedOffAt" IS NOT NULL) <> (NEW."status" = 'SIGNED_OFF')
     OR (NEW."status" = 'SIGNED_OFF' AND NEW."kind" <> 'YEAR_END') THEN
    RAISE EXCEPTION 'counts: stock count % is signed off (when, by whom, its valued list) exactly when SIGNED_OFF, a year-end count', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."cancelledAt" IS NOT NULL) <> (NEW."status" = 'CANCELLED')
     OR (NEW."cancelledAt" IS NULL) <> (btrim(coalesce(NEW."cancelReason", '')) = '') THEN
    RAISE EXCEPTION 'counts: stock count % is cancelled with its reason exactly when CANCELLED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."rejectedAt" IS NULL) <> (NEW."rejectedById" IS NULL)
     OR (NEW."rejectedAt" IS NULL) <> (btrim(coalesce(NEW."rejectReason", '')) = '') THEN
    RAISE EXCEPTION 'counts: the rejection of stock count % says when, by whom and why, or nothing', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."valuedListFileId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."valuedListFileId" IS DISTINCT FROM OLD."valuedListFileId") THEN
    SELECT f."recordType", f."recordId" INTO file_type, file_record
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."valuedListFileId";
    IF FOUND AND (file_type <> 'StockCount' OR file_record <> NEW."id") THEN
      RAISE EXCEPTION 'counts: the valued list of stock count % is a file of that count', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "StockCount_guard" BEFORE INSERT OR UPDATE OR DELETE ON "StockCount"
  FOR EACH ROW EXECUTE FUNCTION "factory_stock_count_guard"();
CREATE TRIGGER "StockCount_no_truncate" BEFORE TRUNCATE ON "StockCount"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_stock_plan_w2a_refuse_truncate"();

-- =====================================================================================================================
-- StockCountLine (B-W2a-15)
--   INSERT     only while its count is DRAFT or COUNTING, naming no move yet; inside the count's scope (its item, lot,
--              kind of material, and a location at or under its location); a lot in the line's own colour.
--   UPDATE     an UPDATE that changes nothing passes; the stock key, origin, expected quantity, place and creation are
--              the snapshot's and never change. While the count is DRAFT or COUNTING: the count, the recount and the
--              reason. While it is APPROVED: only the COUNT move that posts the difference, named once. From SUBMITTED on
--              nothing else: the count's history.
--   every row  a hide with its lot; quantities 0 or more; counted exactly with its time (who only with it); a recount
--              exactly with its time, after a count (who only with it); who asked a recount only with when; an ADDED
--              line expects 0; a reason code without spaces; a move only for a line that differs, and that move is a
--              COUNT move of the line's stock key and size: into its location for more, out of it for less.
--   DELETE     only while the count is DRAFT or COUNTING. TRUNCATE refused.
CREATE FUNCTION "factory_stock_count_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  counted CONSTANT text[] := ARRAY['countedQuantity', 'countedAt', 'countedById', 'recountRequestedAt', 'recountRequestedById',
    'recountQuantity', 'recountedAt', 'recountedById', 'reasonCode', 'reasonNote', 'version', 'updatedAt'];
  count_state text;
  count_item uuid;
  count_lot uuid;
  count_kind text;
  count_location uuid;
  count_found boolean;
  lot_colour uuid;
  difference numeric;
  posted record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT c."status"::text INTO count_state FROM "StockCount" c WHERE c."tenantId" = OLD."tenantId" AND c."id" = OLD."countId";
    IF FOUND AND count_state NOT IN ('DRAFT', 'COUNTING') THEN
      RAISE EXCEPTION 'counts: line % of a % count is history; it is never removed', OLD."id", count_state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  SELECT c."status"::text, c."itemId", c."lotId", c."itemKind"::text, c."locationId"
    INTO count_state, count_item, count_lot, count_kind, count_location
    FROM "StockCount" c WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."countId"
    FOR SHARE;
  count_found := FOUND;

  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - (kept || counted || ARRAY['moveId'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || counted || ARRAY['moveId'])) THEN
      RAISE EXCEPTION 'counts: the stock key, origin and expected quantity of count line % are its snapshot; they never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF count_found AND count_state = 'APPROVED' THEN
      IF OLD."moveId" IS NOT NULL
         OR (to_jsonb(NEW) - (kept || ARRAY['moveId', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['moveId', 'version', 'updatedAt'])) THEN
        RAISE EXCEPTION 'counts: line % of an APPROVED count takes only the COUNT move that posts its difference, once', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF count_found AND count_state NOT IN ('DRAFT', 'COUNTING') THEN
      RAISE EXCEPTION 'counts: line % of a % count is history; it never changes', OLD."id", count_state
        USING ERRCODE = 'check_violation';
    ELSIF NEW."moveId" IS DISTINCT FROM OLD."moveId" THEN
      RAISE EXCEPTION 'counts: line % names its COUNT move only while its count is APPROVED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF count_found AND count_state NOT IN ('DRAFT', 'COUNTING') THEN
      RAISE EXCEPTION 'counts: lines are added to a count while it is DRAFT or COUNTING, not % (line %)', count_state, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."moveId" IS NOT NULL THEN
      RAISE EXCEPTION 'counts: a new count line % names no move yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF count_found THEN
      IF (count_item IS NOT NULL AND count_item <> NEW."itemId") OR (count_lot IS NOT NULL AND count_lot IS DISTINCT FROM NEW."lotId")
         OR (count_kind IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId" AND i."kind"::text = count_kind))
         OR (count_location IS NOT NULL AND NOT EXISTS (
               WITH RECURSIVE up ("id", "parentId", depth) AS (
                 SELECT l."id", l."parentId", 0 FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."locationId"
                 UNION ALL
                 SELECT p."id", p."parentId", up.depth + 1 FROM "Location" p JOIN up ON p."tenantId" = NEW."tenantId" AND p."id" = up."parentId"
                 WHERE up.depth < 64
               )
               SELECT 1 FROM up WHERE up."id" = count_location)) THEN
        RAISE EXCEPTION 'counts: line % is outside the scope of its count (its location, item, lot or kind of material)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."lotId" IS NOT NULL THEN
      SELECT l."itemColourId" INTO lot_colour FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."lotId";
      IF FOUND AND lot_colour IS DISTINCT FROM NEW."itemColourId" THEN
        RAISE EXCEPTION 'counts: line % counts lot % in the lot''s own colour', NEW."id", NEW."lotId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."hideId" IS NOT NULL AND NEW."lotId" IS NULL THEN
    RAISE EXCEPTION 'counts: line % counts a hide with its lot', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expectedQuantity" < 0 OR NEW."countedQuantity" < 0 OR NEW."recountQuantity" < 0
     OR (NEW."origin" = 'ADDED' AND NEW."expectedQuantity" <> 0) THEN
    RAISE EXCEPTION 'counts: line % has no negative quantity, and expects 0 when it was ADDED while counting', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."countedQuantity" IS NULL) <> (NEW."countedAt" IS NULL) OR (NEW."countedById" IS NOT NULL AND NEW."countedAt" IS NULL)
     OR (NEW."recountQuantity" IS NULL) <> (NEW."recountedAt" IS NULL) OR (NEW."recountedById" IS NOT NULL AND NEW."recountedAt" IS NULL)
     OR (NEW."recountQuantity" IS NOT NULL AND NEW."countedQuantity" IS NULL)
     OR (NEW."recountRequestedById" IS NOT NULL AND NEW."recountRequestedAt" IS NULL) THEN
    RAISE EXCEPTION 'counts: line % is counted (and recounted, after a count) with its time; who only with it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reasonCode" IS NOT NULL AND (NEW."reasonCode" = '' OR NEW."reasonCode" ~ '\s') THEN
    RAISE EXCEPTION 'counts: the reason code of line % is a code without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  difference := coalesce(NEW."recountQuantity", NEW."countedQuantity") - NEW."expectedQuantity";
  IF NEW."moveId" IS NOT NULL AND (difference IS NULL OR difference = 0) THEN
    RAISE EXCEPTION 'counts: line % names a move only when what was counted differs from what was expected', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."moveId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."moveId" IS DISTINCT FROM OLD."moveId") THEN
    SELECT m."reason"::text AS reason, m."itemId", m."itemColourId", m."lotId", m."hideId", m."fromLocationId", m."toLocationId", m."baseQuantity"
      INTO posted
      FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."moveId";
    IF FOUND AND (posted.reason <> 'COUNT' OR posted."itemId" <> NEW."itemId" OR posted."itemColourId" IS DISTINCT FROM NEW."itemColourId"
                  OR posted."lotId" IS DISTINCT FROM NEW."lotId" OR posted."hideId" IS DISTINCT FROM NEW."hideId"
                  OR posted."baseQuantity" <> abs(difference)
                  OR (difference > 0 AND (posted."toLocationId" IS DISTINCT FROM NEW."locationId" OR posted."fromLocationId" IS NOT NULL))
                  OR (difference < 0 AND (posted."fromLocationId" IS DISTINCT FROM NEW."locationId" OR posted."toLocationId" IS NOT NULL))) THEN
      RAISE EXCEPTION 'counts: move % does not post the difference of line % (a COUNT move of its stock key and size, into its location for more, out of it for less)', NEW."moveId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "StockCountLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "StockCountLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_stock_count_line_guard"();
CREATE TRIGGER "StockCountLine_no_truncate" BEFORE TRUNCATE ON "StockCountLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_stock_plan_w2a_refuse_truncate"();

-- =====================================================================================================================
-- PlanningSettings (B-W2a-16; PLN-003)
--   UPDATE     an UPDATE that changes nothing passes; the company and creation never change.
--   every row  a horizon of 1 to 104 weeks; 0 ≤ day weeks ≤ week weeks ≤ horizon; a default efficiency above 0, at most
--              200 %; a nightly run time HH:MM or none.
--   DELETE     refused (the settings are changed, never removed). TRUNCATE refused.
CREATE FUNCTION "factory_planning_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'planning: the planning settings % are changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'planning: the company and creation of the planning settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."horizonWeeks" < 1 OR NEW."horizonWeeks" > 104 OR NEW."dayBucketWeeks" < 0
     OR NEW."dayBucketWeeks" > NEW."weekBucketWeeks" OR NEW."weekBucketWeeks" > NEW."horizonWeeks" THEN
    RAISE EXCEPTION 'planning: the settings % look 1 to 104 weeks ahead, with day buckets, then week buckets, within the horizon (PLN-003)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."defaultEfficiencyPct" <= 0 OR NEW."defaultEfficiencyPct" > 200 THEN
    RAISE EXCEPTION 'planning: the default efficiency of the settings % is above 0 and at most 200 %%', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."scheduledRunTime" IS NOT NULL AND NEW."scheduledRunTime" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RAISE EXCEPTION 'planning: the nightly run of the settings % is a time HH:MM, not %', NEW."id", NEW."scheduledRunTime"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PlanningSettings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PlanningSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_planning_settings_guard"();
CREATE TRIGGER "PlanningSettings_no_truncate" BEFORE TRUNCATE ON "PlanningSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_stock_plan_w2a_refuse_truncate"();

-- =====================================================================================================================
-- ItemPlanning (B-W2a-16; PLN-005, PLN-099)
--   UPDATE     an UPDATE that changes nothing passes; the company, item, colour and creation never change.
--   every row  lead and safety days 0 to 366; the safety stock, reorder point and minimum stock 0 or more; the lot size,
--              maximum stock, order minimum, step and maximum above 0, the maxima not below their minima (the maximum
--              stock above the minimum); the reorder point and lot size exactly for REORDER_POINT, the minimum and
--              maximum stock exactly for MIN_MAX; a supplier only for a BUY, a make site only for a MAKE, and it is a
--              plant of the company.
--   DELETE     the office deletes a row (the item is then planned by its defaults). TRUNCATE refused.
CREATE FUNCTION "factory_item_planning_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  site_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."itemId", NEW."itemColourId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."itemId", OLD."itemColourId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'planning: the company, item, colour and creation of item parameters % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."buyLeadTimeDays" NOT BETWEEN 0 AND 366 OR NEW."makeLeadTimeDays" NOT BETWEEN 0 AND 366 OR NEW."safetyLeadTimeDays" NOT BETWEEN 0 AND 366 THEN
    RAISE EXCEPTION 'planning: the lead and safety times of item parameters % are 0 to 366 days', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."safetyStock" < 0 OR NEW."reorderPoint" < 0 OR NEW."minStock" < 0 OR NEW."lotSize" <= 0 OR NEW."maxStock" <= 0
     OR NEW."minOrderQty" <= 0 OR NEW."orderMultiple" <= 0 OR NEW."maxOrderQty" <= 0
     OR NEW."maxStock" <= NEW."minStock" OR NEW."maxOrderQty" < NEW."minOrderQty" THEN
    RAISE EXCEPTION 'planning: item parameters % hold no negative stock figure, sizes above 0, and maxima not below their minima', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."method" = 'REORDER_POINT') <> (NEW."reorderPoint" IS NOT NULL) OR (NEW."method" = 'REORDER_POINT') <> (NEW."lotSize" IS NOT NULL)
     OR (NEW."method" = 'MIN_MAX') <> (NEW."minStock" IS NOT NULL) OR (NEW."method" = 'MIN_MAX') <> (NEW."maxStock" IS NOT NULL) THEN
    RAISE EXCEPTION 'planning: item parameters % give a reorder point and lot size exactly for REORDER_POINT, a minimum and maximum stock exactly for MIN_MAX (PLN-099)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."supplierId" IS NOT NULL AND NEW."source" IS DISTINCT FROM 'BUY') OR (NEW."makeSiteId" IS NOT NULL AND NEW."source" IS DISTINCT FROM 'MAKE') THEN
    RAISE EXCEPTION 'planning: item parameters % name a supplier only for a BUY and a make site only for a MAKE', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."makeSiteId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."makeSiteId" IS DISTINCT FROM OLD."makeSiteId") THEN
    SELECT s."kind"::text INTO site_kind FROM "Site" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."makeSiteId";
    IF FOUND AND site_kind <> 'PLANT' THEN
      RAISE EXCEPTION 'planning: the make site of item parameters % is a plant, not a %', NEW."id", site_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ItemPlanning_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ItemPlanning"
  FOR EACH ROW EXECUTE FUNCTION "factory_item_planning_guard"();
CREATE TRIGGER "ItemPlanning_no_truncate" BEFORE TRUNCATE ON "ItemPlanning"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_stock_plan_w2a_refuse_truncate"();

-- =====================================================================================================================
-- LineCapacity, WorkCentreCapacity (B-W2a-16; PLN-014, PLN-115): per line and work centre, never per person.
--   UPDATE     an UPDATE that changes nothing passes; the company, line or work centre and creation never change.
--   every row  a planned efficiency above 0, at most 200 %; people or units 1 to 500, or none.
--   DELETE     refused (changed, never removed). TRUNCATE refused.
CREATE FUNCTION "factory_line_capacity_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'planning: the capacity % of a line is changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."lineId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."lineId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'planning: the company, line and creation of line capacity % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."plannedEfficiencyPct" <= 0 OR NEW."plannedEfficiencyPct" > 200 OR NEW."operators" NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'planning: line capacity % plans an efficiency above 0 and at most 200 %%, with 1 to 500 people or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LineCapacity_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LineCapacity"
  FOR EACH ROW EXECUTE FUNCTION "factory_line_capacity_guard"();
CREATE TRIGGER "LineCapacity_no_truncate" BEFORE TRUNCATE ON "LineCapacity"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_stock_plan_w2a_refuse_truncate"();

CREATE FUNCTION "factory_work_centre_capacity_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'planning: the capacity % of a work centre is changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."workCentreId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."workCentreId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'planning: the company, work centre and creation of work-centre capacity % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."plannedEfficiencyPct" <= 0 OR NEW."plannedEfficiencyPct" > 200 OR NEW."units" NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'planning: work-centre capacity % plans an efficiency above 0 and at most 200 %%, with 1 to 500 units or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkCentreCapacity_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkCentreCapacity"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_centre_capacity_guard"();
CREATE TRIGGER "WorkCentreCapacity_no_truncate" BEFORE TRUNCATE ON "WorkCentreCapacity"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_stock_plan_w2a_refuse_truncate"();

-- =====================================================================================================================
-- RequirementPegging (B-W2a-22; PLN-071): append-only (UPDATE, DELETE, TRUNCATE refused for every login).
--   INSERT     a quantity above 0; the demand's shape (ORDER_LINE: an order line, no work order; WORK_ORDER: a work
--              order, and the order line it makes or none; SAFETY_STOCK and REORDER: neither; the party exactly with the
--              order line, a size only with it, never blank); the supply's shape (RESERVATION exactly with its
--              reservation, PURCHASE_ORDER exactly with its line, a supply date exactly for a purchase order line or the
--              planned order); a purchase order line or reservation of the requirement's material and colour.
CREATE FUNCTION "factory_requirement_pegging_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  need_item uuid;
  need_colour uuid;
  supply_item uuid;
  supply_colour uuid;
BEGIN
  IF NEW."quantity" <= 0 THEN
    RAISE EXCEPTION 'planning: pegging % pegs a quantity above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."demandKind" = 'ORDER_LINE' AND (NEW."salesOrderLineId" IS NULL OR NEW."workOrderId" IS NOT NULL))
     OR (NEW."demandKind" = 'WORK_ORDER' AND NEW."workOrderId" IS NULL)
     OR (NEW."demandKind" IN ('SAFETY_STOCK', 'REORDER') AND (NEW."salesOrderLineId" IS NOT NULL OR NEW."workOrderId" IS NOT NULL))
     OR (NEW."partyId" IS NULL) <> (NEW."salesOrderLineId" IS NULL)
     OR (NEW."size" IS NOT NULL AND (NEW."salesOrderLineId" IS NULL OR btrim(NEW."size") = '')) THEN
    RAISE EXCEPTION 'planning: pegging % names the demand of its kind % (an order line with its party and size, a work order, or neither for safety stock and reorder rules)', NEW."id", NEW."demandKind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."supplyKind" = 'RESERVATION') <> (NEW."reservationId" IS NOT NULL)
     OR (NEW."supplyKind" = 'PURCHASE_ORDER') <> (NEW."purchaseOrderLineId" IS NOT NULL)
     OR (NEW."supplyKind" IN ('PURCHASE_ORDER', 'PLANNED')) <> (NEW."supplyDate" IS NOT NULL) THEN
    RAISE EXCEPTION 'planning: pegging % names the supply of its kind % (a reservation, a purchase order line with its date, the planned order''s date)', NEW."id", NEW."supplyKind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reservationId" IS NOT NULL OR NEW."purchaseOrderLineId" IS NOT NULL THEN
    SELECT r."itemId", r."itemColourId" INTO need_item, need_colour
      FROM "MaterialRequirement" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."requirementId";
    IF FOUND THEN
      IF NEW."reservationId" IS NOT NULL THEN
        SELECT s."itemId", s."itemColourId" INTO supply_item, supply_colour
          FROM "Reservation" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."reservationId";
      ELSE
        SELECT s."itemId", s."itemColourId" INTO supply_item, supply_colour
          FROM "PurchaseOrderLine" s WHERE s."tenantId" = NEW."tenantId" AND s."siteId" = NEW."siteId" AND s."id" = NEW."purchaseOrderLineId";
      END IF;
      IF FOUND AND (supply_item <> need_item OR supply_colour IS DISTINCT FROM need_colour) THEN
        RAISE EXCEPTION 'planning: pegging % counts on a supply of another material or colour than its requirement', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RequirementPegging_guard" BEFORE INSERT ON "RequirementPegging"
  FOR EACH ROW EXECUTE FUNCTION "factory_requirement_pegging_guard"();
CREATE TRIGGER "RequirementPegging_append_only" BEFORE UPDATE OR DELETE ON "RequirementPegging"
  FOR EACH ROW EXECUTE FUNCTION "factory_stock_plan_w2a_refuse_history_change"();
CREATE TRIGGER "RequirementPegging_no_truncate" BEFORE TRUNCATE ON "RequirementPegging"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_stock_plan_w2a_refuse_history_change"();

-- =====================================================================================================================
-- PlanningException (B-W2a-22; PLN-193)
--   INSERT     NEW, nothing acknowledged, snoozed or resolved; found first and last by the same run at the same time; only
--              while no unresolved exception of the site has its dedupe key (a partial unique index).
--   UPDATE     an UPDATE that changes nothing passes; the company, kind, key, occurrence, first run and creation never
--              change; NEW → ACKNOWLEDGED | RESOLVED, ACKNOWLEDGED → RESOLVED; RESOLVED changes no more; the
--              acknowledgement is set once; the latest sighting never moves back.
--   every row  the key starts with `<kind>:`; facts a JSON object; orders affected 0 or more, days late 0 or more or
--              none; the record named with both its type and id, or neither; a colour with its item; acknowledged (when,
--              by whom) exactly from ACKNOWLEDGED on (none while NEW); a snooze by a person (when, by whom; until after
--              it, or until the next run); RESOLVED exactly with when and how: HANDLED by a person with a note, CLEARED by
--              a run (no person, no note).
--   DELETE     refused (resolved instead). TRUNCATE refused.
CREATE FUNCTION "factory_planning_exception_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'planning: exception % is resolved, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'NEW' OR NEW."acknowledgedAt" IS NOT NULL OR NEW."snoozedAt" IS NOT NULL OR NEW."resolvedAt" IS NOT NULL
       OR NEW."resolution" IS NOT NULL OR NEW."firstRunId" <> NEW."lastRunId" OR NEW."firstSeenAt" <> NEW."lastSeenAt" OR NEW."occurrence" < 1 THEN
      RAISE EXCEPTION 'planning: exception % starts NEW, found first and last by one run, with nothing acknowledged, snoozed or resolved', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."kind", NEW."dedupeKey", NEW."occurrence", NEW."firstRunId", NEW."firstSeenAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."kind", OLD."dedupeKey", OLD."occurrence", OLD."firstRunId", OLD."firstSeenAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'planning: what exception % is about, and when it was first found, never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'RESOLVED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'planning: exception % is RESOLVED; it changes no more (a new finding is a new occurrence)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'NEW' AND NEW."status" IN ('ACKNOWLEDGED', 'RESOLVED')) OR (OLD."status" = 'ACKNOWLEDGED' AND NEW."status" = 'RESOLVED')) THEN
      RAISE EXCEPTION 'planning: exception % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."acknowledgedAt" IS NOT NULL
       AND (NEW."acknowledgedAt", NEW."acknowledgedById") IS DISTINCT FROM (OLD."acknowledgedAt", OLD."acknowledgedById") THEN
      RAISE EXCEPTION 'planning: exception % is acknowledged once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."lastSeenAt" < OLD."lastSeenAt" THEN
      RAISE EXCEPTION 'planning: the latest sighting of exception % never moves back', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF left(NEW."dedupeKey", length(NEW."kind"::text) + 1) <> NEW."kind"::text || ':' OR length(NEW."dedupeKey") <= length(NEW."kind"::text) + 1 THEN
    RAISE EXCEPTION 'planning: the key of exception % starts with %: and names what it is about', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."facts") <> 'object' OR NEW."ordersAffected" < 0 OR NEW."daysLate" < 0 OR NEW."lastSeenAt" < NEW."firstSeenAt" THEN
    RAISE EXCEPTION 'planning: exception % has its facts as an object, no negative impact, and its latest sighting after its first', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."recordType" IS NULL) <> (NEW."recordId" IS NULL) OR NEW."recordType" !~ '^[A-Z][A-Za-z]*$'
     OR (NEW."itemColourId" IS NOT NULL AND NEW."itemId" IS NULL) THEN
    RAISE EXCEPTION 'planning: exception % names its record with both its type and id (or neither), and a colour with its material', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."acknowledgedAt" IS NULL) <> (NEW."acknowledgedById" IS NULL)
     OR (NEW."status" = 'NEW' AND NEW."acknowledgedAt" IS NOT NULL)
     OR (NEW."status" = 'ACKNOWLEDGED' AND NEW."acknowledgedAt" IS NULL) THEN
    RAISE EXCEPTION 'planning: exception % is acknowledged (when, by whom) exactly from ACKNOWLEDGED on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."snoozedAt" IS NULL) <> (NEW."snoozedById" IS NULL) OR (NEW."snoozedUntil" IS NOT NULL AND NEW."snoozedAt" IS NULL)
     OR NEW."snoozedUntil" <= NEW."snoozedAt" THEN
    RAISE EXCEPTION 'planning: exception % is snoozed by a person (when, by whom), until after that or until the next run', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'RESOLVED') <> (NEW."resolvedAt" IS NOT NULL) OR (NEW."resolvedAt" IS NULL) <> (NEW."resolution" IS NULL)
     OR (NEW."resolution" = 'HANDLED' AND (NEW."resolvedById" IS NULL OR btrim(coalesce(NEW."resolveNote", '')) = ''))
     OR (NEW."resolution" = 'CLEARED' AND (NEW."resolvedById" IS NOT NULL OR NEW."resolveNote" IS NOT NULL))
     OR (NEW."resolution" IS NULL AND (NEW."resolvedById" IS NOT NULL OR NEW."resolveNote" IS NOT NULL)) THEN
    RAISE EXCEPTION 'planning: exception % is RESOLVED exactly with when and how: HANDLED by a person with a note, CLEARED by a run', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PlanningException_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PlanningException"
  FOR EACH ROW EXECUTE FUNCTION "factory_planning_exception_guard"();
CREATE TRIGGER "PlanningException_no_truncate" BEFORE TRUNCATE ON "PlanningException"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_stock_plan_w2a_refuse_truncate"();

-- One unresolved exception per site and condition: a run finds it again instead of raising a second one.
CREATE UNIQUE INDEX "PlanningException_one_open_per_key" ON "PlanningException" ("tenantId", "siteId", "dedupeKey")
  WHERE "status" <> 'RESOLVED';

-- =====================================================================================================================
-- MaterialRequirement (B-W1-29; W2a B-W2a-22, PLN-075 the firm planned order). REDEFINES
-- factory_material_requirement_guard (202610283701_supply_guards): its whole body, plus the firm columns.
--   UPDATE     an UPDATE that changes nothing passes; its numbers are the run's snapshot and never change: only the
--              decision (decision, note, purchase order line, who and when) and the firm planned order change, while its
--              run is DONE. W2a: the firm planned order is fixed while the line stays ORDERED; the line it carries never
--              changes.
--   every row  no negative quantity; net = max(0, gross − usable stock − on order); ORDERED exactly with the purchase
--              order line that buys it for a BUY (a line of the same item and colour), decided exactly with its time.
--              W2a: a firm planned order has its quantity in both units (above 0), its date and time, all or none, who
--              only with it, a supplier only for a BUY; never on an IGNORED line; a carried line is firm and carries a
--              firm line of another run of the site, of the same material, colour and action.
--   DELETE     refused (kept with its run). TRUNCATE refused.
CREATE OR REPLACE FUNCTION "factory_material_requirement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  decided CONSTANT text[] := ARRAY['decision', 'decisionNote', 'purchaseOrderLineId', 'decidedAt', 'decidedById',
    'firmQuantity', 'firmBaseQuantity', 'firmDate', 'firmSupplierId', 'firmedAt', 'firmedById', 'version', 'updatedAt'];
  run_state text;
  line_item uuid;
  line_colour uuid;
  carried record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supply: material requirement % is kept with its run, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || decided)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || decided)) THEN
      RAISE EXCEPTION 'supply: the numbers of material requirement % are its run''s snapshot; they never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT r."status"::text INTO run_state FROM "PlanningRun" r WHERE r."tenantId" = OLD."tenantId" AND r."id" = OLD."runId";
    IF run_state IS NOT NULL AND run_state <> 'DONE' THEN
      RAISE EXCEPTION 'supply: material requirement % is decided only while its run is DONE (it is %)', OLD."id", run_state
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."decision" = 'ORDERED' AND NEW."decision" = 'ORDERED'
       AND (NEW."firmQuantity", NEW."firmBaseQuantity", NEW."firmDate", NEW."firmSupplierId", NEW."firmedAt", NEW."firmedById")
           IS DISTINCT FROM (OLD."firmQuantity", OLD."firmBaseQuantity", OLD."firmDate", OLD."firmSupplierId", OLD."firmedAt", OLD."firmedById") THEN
      RAISE EXCEPTION 'supply: the firm planned order of material requirement % is fixed while it is ORDERED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."grossQuantity" < 0 OR NEW."usableStock" < 0 OR NEW."heldStock" < 0 OR NEW."onOrder" < 0 OR NEW."suggestedQuantity" < 0
     OR NEW."netQuantity" <> greatest(0, NEW."grossQuantity" - NEW."usableStock" - NEW."onOrder") THEN
    RAISE EXCEPTION 'supply: material requirement % has no negative quantity and a net need of max(0, gross - usable stock - on order)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."purchaseOrderLineId" IS NOT NULL AND NEW."decision" <> 'ORDERED')
     OR (NEW."decision" = 'ORDERED' AND NEW."action" = 'BUY' AND NEW."purchaseOrderLineId" IS NULL)
     OR (NEW."decision" <> 'OPEN') <> (NEW."decidedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'supply: material requirement % is ORDERED with the purchase order line that buys it (a BUY), and decided with its time', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."purchaseOrderLineId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."purchaseOrderLineId" IS DISTINCT FROM OLD."purchaseOrderLineId") THEN
    SELECT l."itemId", l."itemColourId" INTO line_item, line_colour
      FROM "PurchaseOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."purchaseOrderLineId";
    IF FOUND AND (line_item <> NEW."itemId" OR line_colour IS DISTINCT FROM NEW."itemColourId") THEN
      RAISE EXCEPTION 'supply: purchase order line % buys another material or colour than material requirement %', NEW."purchaseOrderLineId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- W2a: the firm planned order (PLN-075).
  IF (NEW."firmedAt" IS NULL) <> (NEW."firmQuantity" IS NULL) OR (NEW."firmedAt" IS NULL) <> (NEW."firmBaseQuantity" IS NULL)
     OR (NEW."firmedAt" IS NULL) <> (NEW."firmDate" IS NULL) OR (NEW."firmedById" IS NOT NULL AND NEW."firmedAt" IS NULL)
     OR (NEW."firmSupplierId" IS NOT NULL AND (NEW."firmedAt" IS NULL OR NEW."action" <> 'BUY'))
     OR NEW."firmQuantity" <= 0 OR NEW."firmBaseQuantity" <= 0 THEN
    RAISE EXCEPTION 'supply: the firm planned order of material requirement % has its quantity in both units (above 0), its date and time, and a supplier only for a BUY', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."firmedAt" IS NOT NULL AND NEW."decision" = 'IGNORED' THEN
    RAISE EXCEPTION 'supply: material requirement % is set aside (IGNORED); it is not a firm planned order', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."firmCarriedFromId" IS NOT NULL THEN
    IF NEW."firmedAt" IS NULL THEN
      RAISE EXCEPTION 'supply: material requirement % carries a firm planned order, so it is firm', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
      SELECT m."runId", m."itemId", m."itemColourId", m."action"::text AS "kind", m."firmedAt" INTO carried
        FROM "MaterialRequirement" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."firmCarriedFromId";
      IF FOUND AND (carried."runId" = NEW."runId" OR carried."itemId" <> NEW."itemId" OR carried."itemColourId" IS DISTINCT FROM NEW."itemColourId"
                    OR carried."kind" <> NEW."action"::text OR carried."firmedAt" IS NULL) THEN
        RAISE EXCEPTION 'supply: material requirement % carries a firm line of another run, of the same material, colour and action', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
