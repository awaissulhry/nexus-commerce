-- Written by hand (Prisma does not model triggers), after the generated 202611220100_order_money_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The order money tab's ONE schema wave ("order money 1/1", B-OM-019; design order-money-2026-11-22 13-backend §5, lead
-- settles L2, L4; Owner D4, D7). apps/factory-api checks all of this first and answers in words (B-OM-020 accept / take back a
-- price difference, B-OM-021 hand cost lines); these rules are the last word, for every login, the owner included. The
-- refusals are check_violation (SQLSTATE 23514); their words name no customer (the brand wall). Both tables are office only
-- (no partner or floor grant: ownership/sales-brand-prices.json, ownership/costing.json).
--
--   OrderPriceAcceptance  NEW (B-OM-020): starts in force; never changed but for its taking back (when, by whom and why, all
--                         three, once); never deleted; both nets at least 0 and a reason of 3 to 500; never written once the
--                         order is CLOSED or CANCELLED; at most one in force per order (the partial unique index
--                         "OrderPriceAcceptance_one_in_force"). TRUNCATE refused.
--   OrderCostLine         NEW (B-OM-021): starts counted; never changed but for its removal (when, by whom and why, all three,
--                         once); never deleted; an amount above 0 in the order's currency and a reason of 3 to 500; never
--                         written once the order is CLOSED or CANCELLED. TRUNCATE refused.
--   SalesOrder.targetMarginPct  NEW column: no rule of its own here; the order's guard (factory_sales_order_guard, its newest body
--                         in …_delivery_customs_w2b_guards) freezes a CLOSED or CANCELLED order whole, so the target changes only
--                         while the order is open. NOT REDEFINED.
--
-- No earlier function is redefined. USED FROM EARLIER WAVES, as they are: "factory_sales_refuse_truncate" (…_sales_guards),
-- "factory_costing_refuse_truncate" (…_costing_guards).

-- =====================================================================================================================
-- OrderPriceAcceptance (sales-brand-prices.prisma; 13-backend §5 B-OM-019 a)
--   INSERT     in force: no withdraw column set.
--   UPDATE     an UPDATE that changes nothing passes; only the withdraw columns change, from none to all three, once.
--   DELETE     refused (taken back, never deleted).
--   every row  both nets at least 0; a reason of 3 to 500 trimmed characters; its order not CLOSED or CANCELLED.
--   TRUNCATE   refused.
CREATE FUNCTION "factory_order_price_acceptance_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  withdraw_columns CONSTANT text[] := ARRAY['withdrawnAt', 'withdrawnById', 'withdrawReason'];
  order_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prices: accepted price difference % is never deleted; it is taken back', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."withdrawnAt" IS NOT NULL OR NEW."withdrawnById" IS NOT NULL OR NEW."withdrawReason" IS NOT NULL THEN
      RAISE EXCEPTION 'prices: accepted price difference % starts in force, not taken back', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (to_jsonb(NEW) - withdraw_columns) IS DISTINCT FROM (to_jsonb(OLD) - withdraw_columns) THEN
      RAISE EXCEPTION 'prices: accepted price difference % never changes; it is taken back once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."withdrawnAt" IS NOT NULL THEN
      RAISE EXCEPTION 'prices: accepted price difference % is taken back already', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."withdrawnAt" IS NULL OR NEW."withdrawnById" IS NULL OR NEW."withdrawReason" IS NULL
       OR length(btrim(NEW."withdrawReason")) < 3 OR length(NEW."withdrawReason") > 500 THEN
      RAISE EXCEPTION 'prices: accepted price difference % is taken back with when, by whom and why (3 to 500 characters), all three', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."ourNet" < 0 OR NEW."brandNet" < 0 OR length(btrim(NEW."reason")) < 3 OR length(NEW."reason") > 500 THEN
    RAISE EXCEPTION 'prices: accepted price difference % has both nets at least 0 and a reason of 3 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Its order: open (READY, shipped and delivered orders stay open: the price is often checked at invoicing).
  SELECT o."status"::text INTO order_status FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."salesOrderId" FOR SHARE;
  IF order_status IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'prices: order % is %; its price check stays as it was', NEW."salesOrderId", order_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OrderPriceAcceptance_guard" AFTER INSERT OR UPDATE OR DELETE ON "OrderPriceAcceptance"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_price_acceptance_guard"();
CREATE TRIGGER "OrderPriceAcceptance_no_truncate" BEFORE TRUNCATE ON "OrderPriceAcceptance"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_sales_refuse_truncate"();

-- At most one accepted difference in force per order (a partial unique index Prisma cannot express).
CREATE UNIQUE INDEX "OrderPriceAcceptance_one_in_force" ON "OrderPriceAcceptance" ("tenantId", "salesOrderId") WHERE "withdrawnAt" IS NULL;

-- =====================================================================================================================
-- OrderCostLine (costing.prisma; 13-backend §5 B-OM-019 b; lead L2: added lines only)
--   INSERT     counted: no remove column set; in the order's currency.
--   UPDATE     an UPDATE that changes nothing passes; only the remove columns change, from none to all three, once.
--   DELETE     refused (removed, never deleted).
--   every row  an amount above 0; an ISO currency; a reason of 3 to 500 trimmed characters; its order not CLOSED or CANCELLED.
--   TRUNCATE   refused.
CREATE FUNCTION "factory_order_cost_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  remove_columns CONSTANT text[] := ARRAY['removedAt', 'removedById', 'removeReason'];
  order_status text;
  order_currency text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'costing: hand cost line % is never deleted; it is removed with a reason', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."removedAt" IS NOT NULL OR NEW."removedById" IS NOT NULL OR NEW."removeReason" IS NOT NULL THEN
      RAISE EXCEPTION 'costing: hand cost line % starts counted, not removed', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (to_jsonb(NEW) - remove_columns) IS DISTINCT FROM (to_jsonb(OLD) - remove_columns) THEN
      RAISE EXCEPTION 'costing: hand cost line % never changes; it is removed once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."removedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'costing: hand cost line % is removed already', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."removedAt" IS NULL OR NEW."removedById" IS NULL OR NEW."removeReason" IS NULL
       OR length(btrim(NEW."removeReason")) < 3 OR length(NEW."removeReason") > 500 THEN
      RAISE EXCEPTION 'costing: hand cost line % is removed with when, by whom and why (3 to 500 characters), all three', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."amount" <= 0 OR NEW."currency" !~ '^[A-Z]{3}$' OR length(btrim(NEW."reason")) < 3 OR length(NEW."reason") > 500 THEN
    RAISE EXCEPTION 'costing: hand cost line % has an amount above 0, an ISO currency and a reason of 3 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Its order: open, and (a new line) in its currency.
  SELECT o."status"::text, o."currency" INTO order_status, order_currency FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."salesOrderId" FOR SHARE;
  IF order_status IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'costing: order % is %; its costs stay as they were', NEW."salesOrderId", order_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."currency" <> order_currency THEN
    RAISE EXCEPTION 'costing: hand cost line % is in the order''s currency (%), not %', NEW."id", order_currency, NEW."currency"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OrderCostLine_guard" AFTER INSERT OR UPDATE OR DELETE ON "OrderCostLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_cost_line_guard"();
CREATE TRIGGER "OrderCostLine_no_truncate" BEFORE TRUNCATE ON "OrderCostLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_costing_refuse_truncate"();
