-- Written by hand (Prisma does not model triggers), after 202611170201_production_brand_wall_copy and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- One customer per work order (production plan, schema wave 1/5, B-PR-01; lead pick L8, the brand wall: "One brand must not
-- be able to see anything related to any other brand"). A work order of one customer makes the office wall of people limited
-- to some customers one plain column (WorkOrder.partyId); cut orders, lays and trolleys may still combine several customers'
-- work orders inside the factory. No earlier function is redefined: two new triggers beside W1's WorkOrder_guard and
-- WorkOrderSize_guard (which already keep the cells changing only while the work order is a DRAFT).
--
--   WorkOrder      WorkOrder_party_fixed: made with its customer: every kind but SAMPLE names one; a SAMPLE of a customer's
--                  round is that customer's (a SAMPLE of a round for no customer: the customer of its order lines, or none
--                  when its cells name no order line). The customer never changes, with one exception: a work order that
--                  names none (a mixed one made before the rule) takes one, once, when every cell left on it is of that
--                  customer (the last part of a mixed draft, once splits took the other customers' cells away; R-33).
--   WorkOrderSize  WorkOrderSize_one_party: a cell of a work order of a customer is of that customer (or, on a SAMPLE, names
--                  no order line and so no customer: W2b-5's rule). A work order of no customer takes only cells of no
--                  customer, and only when it is a SAMPLE. A mixed one made before the rule takes no new cell and no
--                  changed one but a lower quantity: its cells only LEAVE it (removed, or lowered by a split into a work
--                  order of one customer).
--
-- Both read the other table under the work order's row lock (the cell's FOR SHARE, the work order's update), so a cell and
-- a work order's customer never change past each other. As every guard: a refusal is a check_violation (SQLSTATE 23514) in
-- words, which name no customer.

CREATE FUNCTION "factory_work_order_party_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  round_party uuid;
  cells integer;
  of_party integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."partyId" IS NULL AND NEW."kind" <> 'SAMPLE' THEN
      RAISE EXCEPTION 'production: work order % is made for the one customer of its order lines (one customer per work order)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."partyId" IS NOT DISTINCT FROM OLD."partyId" THEN
      RETURN NULL;
    END IF;
    IF OLD."partyId" IS NOT NULL OR NEW."partyId" IS NULL THEN
      RAISE EXCEPTION 'production: the customer of work order % never changes (one customer per work order)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*), count(*) FILTER (WHERE c."partyId" = NEW."partyId") INTO cells, of_party
      FROM "WorkOrderSize" c WHERE c."tenantId" = NEW."tenantId" AND c."workOrderId" = NEW."id";
    IF cells = 0 OR of_party <> cells THEN
      RAISE EXCEPTION 'production: work order % mixes customers (made before the one-customer rule): it takes a customer only once every cell left on it is of that customer (split the others off first)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."kind" = 'SAMPLE' AND NEW."sampleRoundId" IS NOT NULL THEN
    SELECT r."partyId" INTO round_party FROM "SampleRound" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."sampleRoundId";
    IF round_party IS NOT NULL AND NEW."partyId" IS DISTINCT FROM round_party THEN
      RAISE EXCEPTION 'production: sample work order % is of its sample round''s customer', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WorkOrder_party_fixed" AFTER INSERT OR UPDATE OF "partyId" ON "WorkOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_party_check"();

CREATE FUNCTION "factory_work_order_size_party_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_party uuid;
  order_kind text;
  leaving CONSTANT text[] := ARRAY['quantity', 'version', 'updatedAt'];
BEGIN
  SELECT w."partyId", w."kind"::text INTO order_party, order_kind
    FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId" FOR SHARE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF order_party IS NOT NULL THEN
    IF NEW."partyId" IS NOT NULL AND NEW."partyId" <> order_party THEN
      RAISE EXCEPTION 'production: work order cell % makes an order line of another customer than its work order''s (one customer per work order)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  -- A work order of no customer: a cell leaves it (a lower quantity, nothing else changed; a removed cell fires no check).
  IF TG_OP = 'UPDATE' AND NEW."quantity" <= OLD."quantity" AND (to_jsonb(NEW) - leaving) = (to_jsonb(OLD) - leaving) THEN
    RETURN NULL;
  END IF;
  IF order_kind = 'SAMPLE' THEN
    IF NEW."partyId" IS NOT NULL THEN
      RAISE EXCEPTION 'production: sample work order % is of no customer: its cells name no order line', NEW."workOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'production: work order % mixes customers (made before the one-customer rule): its cells only leave it (split them into one work order per customer); it takes no new or changed cell', NEW."workOrderId"
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "WorkOrderSize_one_party" AFTER INSERT OR UPDATE ON "WorkOrderSize"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_size_party_check"();
