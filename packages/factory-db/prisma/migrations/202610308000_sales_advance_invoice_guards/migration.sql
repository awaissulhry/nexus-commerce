-- Written by hand (Prisma does not model triggers), with no schema folder of its own, before the policy migration. When
-- the migrations are renumbered, keep this file as it is under its new timestamp.

-- B-W2a-F2 — an advance invoice when a customer pays a "before shipping" step before the goods leave (DPR 633/1972
-- art. 6 c.4: a payment received before the supply makes the operation happen at payment, for the amount paid). W1's
-- deposit flow (payment → deposit request PAID → TD02 → deducted on the goods' invoice) invoices a payment only through
-- the DepositRequest it is allocated to; a BEFORE_SHIPPING step now names its own request too, so that flow bills the
-- balance before shipping with no other change. The API makes the request with the step and says everything in words;
-- this rule holds for every login, the owner included. Every refusal is a check_violation (SQLSTATE 23514).
--
-- It redefines one function of an earlier hand-written migration (its trigger stays):
--   "factory_sales_order_milestone_guard" (202610302201_sales_w2a_guards): a deposit request on the DEPOSIT step and,
--                                         now, on a BEFORE_SHIPPING step; still refused on ON_DELIVERY and ON_INVOICE
--                                         (they fall due with the goods' invoice). The rest of the body is unchanged.

-- SalesOrderMilestone (SAL-216)
--   INSERT     a step starts OPEN.
--   every row  an amount above 0; a share above 0 and at most 100 percent, or none; a deposit request only on the
--              DEPOSIT step or a BEFORE_SHIPPING step; paidAt exactly when PAID; a note exactly when WAIVED or CANCELLED.
--   UPDATE     an UPDATE that changes nothing passes; the order, company, party and creation never change; OPEN →
--              PAID | WAIVED | CANCELLED, and those three never change.
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE OR REPLACE FUNCTION "factory_sales_order_milestone_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales: payment schedule step % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'sales: payment schedule step % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."orderId", NEW."partyId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."orderId", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales: the order and creation of payment schedule step % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'sales: payment schedule step % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."amount" <= 0 OR (NEW."sharePct" IS NOT NULL AND (NEW."sharePct" <= 0 OR NEW."sharePct" > 100)) THEN
    RAISE EXCEPTION 'sales: payment schedule step % has an amount above 0 and a share above 0 and at most 100 percent, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."depositRequestId" IS NOT NULL AND NEW."kind" NOT IN ('DEPOSIT', 'BEFORE_SHIPPING') THEN
    RAISE EXCEPTION 'sales: payment schedule step % names a deposit request but is not the DEPOSIT step or a BEFORE_SHIPPING step (an ON_DELIVERY or ON_INVOICE step falls due with the goods'' invoice)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'PAID') <> (NEW."paidAt" IS NOT NULL)
     OR (NEW."status" IN ('WAIVED', 'CANCELLED')) <> (coalesce(btrim(NEW."statusNote"), '') <> '') THEN
    RAISE EXCEPTION 'sales: payment schedule step % is % with the wrong payment time or note', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
