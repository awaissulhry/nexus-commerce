-- Written by hand (Prisma does not model triggers), after the policy migration 202610284602_sales_settings_policies and
-- before 202610284701_inventory_issue_policies (the generator's output again, so the policies stay last; no table or
-- column changes here). When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Issues to a work order and returns from it (B-W1-39; plan A1 §2.5 "Work order"; PLAN §4.7 stage 11a-issue; SCM-215,
-- SCM-216). StockMove.workOrderId is a plain id (the production schema came after the ledger): these rules make it name a
-- work order of the move's tenant and site in the state the move needs, for every login, the floor's included.
-- apps/factory-api's modules/inventory/issue checks all of this first. Every refusal is a check_violation (SQLSTATE
-- 23514).
--
--   ISSUE     (not a reversal) only to a RELEASED or IN_PROGRESS work order: stock is issued while the work order is
--             being made.
--   RETURN    from any work order but a DRAFT one (which was never issued anything): a remnant comes back after the work
--             order is completed, closed or cancelled too; refusing it would keep that stock at the work order for good.
--   reversal  (of an ISSUE or a RETURN) from any work order but a DRAFT one: it mirrors a move these rules accepted, so a
--             wrong record can always be put right (the ledger is append-only).
--   site      the work order is of the move's tenant AND site (a move never names another site's work order).
--
-- A cancel (or a completion) and an issue at the same time take turns: both take the work order's issue lock, a
-- transaction advisory lock on 'factory.work-order-issue|<tenant>|<work order>' (the same key the API's issue, return,
-- undo and reversal and its complete, close and cancel take first). A row lock cannot do it: the floor role only reads
-- work orders (SELECT … FOR SHARE needs an UPDATE grant), and FOR KEY SHARE would not wait for a status update anyway.
-- So the move's trigger takes the lock, then reads the status (READ COMMITTED: each statement of the function sees what
-- committed before it), and a move of the status out of RELEASED or IN_PROGRESS takes the same lock: whichever comes
-- second waits for the first to commit and then sees it. Order: this lock before the stock locks (the move's trigger
-- below fires before StockMove_check, by name); a status update holds the row first, and no move ever waits for a work
-- order's row, so the two orders never meet in a cycle.

CREATE FUNCTION "factory_stock_move_work_order_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
BEGIN
  IF NEW."workOrderId" IS NULL THEN
    -- An ISSUE or RETURN without its work order: StockMove_check refuses it, with its own words.
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.work-order-issue', NEW."tenantId", NEW."workOrderId"), 0));
  SELECT w."status"::text INTO order_state
    FROM "WorkOrder" w
   WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory: stock move % is an % for work order %, which is not a work order of its site', NEW."id", NEW."reason", NEW."workOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF order_state = 'DRAFT' THEN
    RAISE EXCEPTION 'inventory: work order % is DRAFT; nothing is issued to it or returned from it (stock move %)', NEW."workOrderId", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reason" = 'ISSUE' AND NEW."reversalOfId" IS NULL AND order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'inventory: work order % is %; stock is issued only to a RELEASED or IN_PROGRESS work order (stock move %)', NEW."workOrderId", order_state, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Fires before StockMove_check (triggers of one event fire in name order): the work order's lock first, the stock's after.
CREATE TRIGGER "StockMove_bound_to_work_order" BEFORE INSERT ON "StockMove"
  FOR EACH ROW WHEN (NEW."reason" IN ('ISSUE', 'RETURN'))
  EXECUTE FUNCTION "factory_stock_move_work_order_check"();

-- A work order leaving RELEASED or IN_PROGRESS (completed, cancelled) waits for the issues in flight, and an issue that
-- comes after it waits for it and then sees the new status.
CREATE FUNCTION "factory_work_order_issue_lock"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.work-order-issue', NEW."tenantId", NEW."id"), 0));
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkOrder_issue_lock" BEFORE UPDATE OF "status" ON "WorkOrder"
  FOR EACH ROW WHEN (OLD."status" IN ('RELEASED', 'IN_PROGRESS') AND NEW."status" NOT IN ('RELEASED', 'IN_PROGRESS'))
  EXECUTE FUNCTION "factory_work_order_issue_lock"();
