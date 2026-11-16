-- B-W2b-GB02 (G150; B-W2b-401's gap "receivables, open items and statements ignore TD05"): a debit note (TD05) asks the
-- customer for money like an invoice, so it is paid and reminded like one. Two functions are REDEFINED whole, each with
-- its last body plus TD05 beside TD01 and TD24:
--   factory_payment_allocation_check (…_bank_bridge_w2b_guards): money allocated to an issued TD01, TD24 or TD05
--   factory_reminder_stop_guard      (…_bank_bridge_w2b_guards): a reminder stop on an issued TD01, TD24 or TD05
-- Ri.Ba. items, bank matches and online payment intents keep TD01 and TD24 only (their guards are unchanged; the API
-- leaves a debit note out of them).

-- factory_payment_allocation_check (…_bank_bridge_w2b_guards): its whole body, plus TD05.
CREATE OR REPLACE FUNCTION "factory_payment_allocation_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_amount int;
  payment_state text;
  payment_currency text;
  allocated bigint;
  original record;
  target_state text;
  target_type text;
  target_amount int;
  target_currency text;
  credited bigint;
  refunded bigint;
  target_fiscal text;
  target_order uuid;
  carried record;
  deposit record;
  written bigint;
BEGIN
  IF (NEW."invoiceId" IS NULL) = (NEW."depositRequestId" IS NULL) THEN
    RAISE EXCEPTION 'payments: allocation % pays exactly one deposit request or invoice', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amount" = 0 OR (NEW."reversalOfId" IS NOT NULL) <> (NEW."amount" < 0)
     OR (NEW."reversalOfId" IS NOT NULL AND btrim(coalesce(NEW."note", '')) = '') THEN
    RAISE EXCEPTION 'payments: allocation % has an amount above 0, or is a reversal with a negative amount and a note saying why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- W2b: a carry places on an issued TD01 / TD24 of the order the money a reversal of the same payment took back from
  -- the order's PAID deposit request that issues no deposit invoice (NONE); the reversal waits for it at commit
  -- (PaymentAllocation_carry_due).
  IF NEW."carriedFromId" IS NOT NULL THEN
    IF NEW."invoiceId" IS NULL OR NEW."amount" <= 0 OR NEW."reversalOfId" IS NOT NULL THEN
      RAISE EXCEPTION 'payments: allocation % carries a deposit onto an invoice: it pays an invoice, above 0, and is no reversal', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT c."amount" AS amount, c."reversalOfId" AS reversal_of, c."depositRequestId" AS deposit INTO carried
      FROM "PaymentAllocation" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."carriedFromId";
    IF FOUND THEN
      IF carried.reversal_of IS NULL OR carried.deposit IS NULL OR NEW."amount" <> -carried.amount THEN
        RAISE EXCEPTION 'payments: allocation % carries allocation %, which is not a reversal of a deposit request''s allocation of the opposite amount', NEW."id", NEW."carriedFromId"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."status"::text AS status, r."fiscalDocument"::text AS fiscal, r."orderId" AS order_id INTO deposit
        FROM "DepositRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = carried.deposit;
      IF FOUND THEN
        IF deposit.status <> 'PAID' OR deposit.fiscal <> 'NONE' OR deposit.order_id IS NULL THEN
          RAISE EXCEPTION 'payments: allocation % carries the money of deposit request %, which is % with document %; only a PAID deposit of an order that issues no deposit invoice (NONE) is carried onto the order''s invoice', NEW."id", carried.deposit, deposit.status, deposit.fiscal
            USING ERRCODE = 'check_violation';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM "Invoice" i
           WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId"
             AND (i."salesOrderId" = deposit.order_id
                  OR EXISTS (SELECT 1 FROM "InvoiceLine" l JOIN "SalesOrderLine" o ON o."tenantId" = l."tenantId" AND o."id" = l."salesOrderLineId"
                              WHERE l."tenantId" = i."tenantId" AND l."invoiceId" = i."id" AND o."orderId" = deposit.order_id))) THEN
          RAISE EXCEPTION 'payments: allocation % carries deposit request %''s money onto invoice %, which is not an invoice of its order %', NEW."id", carried.deposit, NEW."invoiceId", deposit.order_id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;

  PERFORM "factory_money_lock"('payment', NEW."tenantId", NEW."paymentId");
  IF NEW."invoiceId" IS NOT NULL THEN
    PERFORM "factory_money_lock"('invoice', NEW."tenantId", NEW."invoiceId");
  ELSE
    PERFORM "factory_money_lock"('deposit', NEW."tenantId", NEW."depositRequestId");
  END IF;

  IF NEW."reversalOfId" IS NOT NULL THEN
    SELECT a."amount" AS amount, a."invoiceId" AS invoice, a."depositRequestId" AS deposit, a."reversalOfId" AS reversal_of
      INTO original FROM "PaymentAllocation" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."reversalOfId";
    IF FOUND THEN
      IF original.reversal_of IS NOT NULL
         OR (original.invoice, original.deposit) IS DISTINCT FROM (NEW."invoiceId", NEW."depositRequestId")
         OR NEW."amount" <> -original.amount THEN
        RAISE EXCEPTION 'payments: reversal % takes back allocation % exactly: the same target and the opposite amount (%), never a reversal', NEW."id", NEW."reversalOfId", -original.amount
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "PaymentAllocation" a WHERE a."tenantId" = NEW."tenantId" AND a."reversalOfId" = NEW."reversalOfId") THEN
        RAISE EXCEPTION 'payments: allocation % is reversed already', NEW."reversalOfId"
          USING ERRCODE = 'check_violation';
      END IF;
      -- W2b-6 (schema wave 50/57): an allocation whose short payment is written off is reversed after its write-off.
      IF EXISTS (SELECT 1 FROM "PaymentWriteOff" w WHERE w."tenantId" = NEW."tenantId" AND w."allocationId" = NEW."reversalOfId"
                  GROUP BY w."allocationId" HAVING sum(w."amount") <> 0) THEN
        RAISE EXCEPTION 'payments: allocation % has a write-off still standing; reverse the write-off first', NEW."reversalOfId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  SELECT p."amount", p."status"::text, p."currency" INTO payment_amount, payment_state, payment_currency
    FROM "Payment" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId";
  IF FOUND THEN
    IF payment_state <> 'RECEIVED' THEN
      RAISE EXCEPTION 'payments: payment % is %; it pays nothing', NEW."paymentId", payment_state
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(a."amount"), 0) INTO allocated FROM "PaymentAllocation" a WHERE a."tenantId" = NEW."tenantId" AND a."paymentId" = NEW."paymentId";
    -- W2a: what is refunded of the payment's unplaced part (DUE or PAID; receivables.prisma Refund) counts too.
    SELECT coalesce(sum(r."amount"), 0) INTO refunded FROM "Refund" r WHERE r."tenantId" = NEW."tenantId" AND r."paymentId" = NEW."paymentId" AND r."status" IN ('DUE', 'PAID');
    -- W2b-6 (schema wave 50/57): what is written off of the payment's unplaced part (OVERPAYMENT; bank.prisma PaymentWriteOff) counts too.
    SELECT coalesce(sum(w."amount"), 0) INTO written FROM "PaymentWriteOff" w WHERE w."tenantId" = NEW."tenantId" AND w."paymentId" = NEW."paymentId" AND w."kind" = 'OVERPAYMENT';
    IF allocated + refunded + written + NEW."amount" > payment_amount THEN
      IF written <> 0 THEN
        RAISE EXCEPTION 'payments: payment % of % has % allocated; % more passes it (% of it refunded or due to be, % written off)', NEW."paymentId", payment_amount, allocated, NEW."amount", refunded, written
          USING ERRCODE = 'check_violation';
      END IF;
      RAISE EXCEPTION 'payments: payment % of % has % allocated; % more passes it (% of it refunded or due to be)', NEW."paymentId", payment_amount, allocated, NEW."amount", refunded
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."invoiceId" IS NOT NULL THEN
    SELECT i."status"::text, i."docType"::text, i."grossTotal", i."currency" INTO target_state, target_type, target_amount, target_currency
      FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";
    IF FOUND AND NEW."amount" > 0 THEN
      -- B-W2b-GB02 (G150): a debit note (TD05) is paid like an invoice.
      IF target_state = 'DRAFT' OR target_type NOT IN ('TD01', 'TD24', 'TD05') THEN
        RAISE EXCEPTION 'payments: invoice % is a % %; payments go to issued TD01, TD24 and TD05 invoices (a TD02 is paid through its deposit request, a TD04 is not paid)', NEW."invoiceId", target_state, target_type
          USING ERRCODE = 'check_violation';
      END IF;
      IF target_currency IS DISTINCT FROM coalesce(payment_currency, target_currency) THEN
        RAISE EXCEPTION 'payments: payment % in % cannot pay invoice % in %', NEW."paymentId", payment_currency, NEW."invoiceId", target_currency
          USING ERRCODE = 'check_violation';
      END IF;
      credited := "factory_invoice_credited"(NEW."tenantId", NEW."invoiceId", NULL);
      SELECT coalesce(sum(a."amount"), 0) INTO allocated FROM "PaymentAllocation" a WHERE a."tenantId" = NEW."tenantId" AND a."invoiceId" = NEW."invoiceId";
      -- W2b-6 (schema wave 50/57): what is written off of the invoice's short payments (UNDERPAYMENT) counts too.
      SELECT coalesce(sum(w."amount"), 0) INTO written FROM "PaymentWriteOff" w
        JOIN "PaymentAllocation" a ON a."tenantId" = w."tenantId" AND a."id" = w."allocationId"
       WHERE w."tenantId" = NEW."tenantId" AND a."invoiceId" = NEW."invoiceId" AND w."kind" = 'UNDERPAYMENT';
      IF allocated + written + NEW."amount" > target_amount - credited THEN
        IF written <> 0 THEN
          RAISE EXCEPTION 'payments: invoice % is open for % (gross %, credited %, paid %, written off %); % more passes it', NEW."invoiceId", target_amount - credited - allocated - written, target_amount, credited, allocated, written, NEW."amount"
            USING ERRCODE = 'check_violation';
        END IF;
        RAISE EXCEPTION 'payments: invoice % is open for % (gross %, credited %, paid %); % more passes it', NEW."invoiceId", target_amount - credited - allocated, target_amount, credited, allocated, NEW."amount"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    SELECT r."status"::text, r."amount", r."currency", r."fiscalDocument"::text, r."orderId" INTO target_state, target_amount, target_currency, target_fiscal, target_order
      FROM "DepositRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."depositRequestId";
    IF FOUND THEN
      IF NEW."amount" > 0 THEN
        IF target_state <> 'OPEN' THEN
          RAISE EXCEPTION 'payments: deposit request % is %; payments are allocated to an OPEN request', NEW."depositRequestId", target_state
            USING ERRCODE = 'check_violation';
        END IF;
        IF target_currency IS DISTINCT FROM coalesce(payment_currency, target_currency) THEN
          RAISE EXCEPTION 'payments: payment % in % cannot pay deposit request % in %', NEW."paymentId", payment_currency, NEW."depositRequestId", target_currency
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT coalesce(sum(a."amount"), 0) INTO allocated FROM "PaymentAllocation" a WHERE a."tenantId" = NEW."tenantId" AND a."depositRequestId" = NEW."depositRequestId";
        IF allocated + NEW."amount" > target_amount THEN
          RAISE EXCEPTION 'payments: deposit request % asks for % and has % paid; % more passes it', NEW."depositRequestId", target_amount, allocated, NEW."amount"
            USING ERRCODE = 'check_violation';
        END IF;
      -- W2b: a PAID deposit of an order that issues no deposit invoice (NONE) is carried onto the order's invoice: its
      -- reversal is followed by the carry in the same command (PaymentAllocation_carry_due holds it at commit).
      ELSIF target_state = 'PAID' AND NOT (target_fiscal = 'NONE' AND target_order IS NOT NULL) THEN
        RAISE EXCEPTION 'payments: deposit request % is PAID (final); its allocations stay', NEW."depositRequestId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;


-- factory_reminder_stop_guard (…_bank_bridge_w2b_guards): its whole body, plus TD05.
CREATE OR REPLACE FUNCTION "factory_reminder_stop_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."liftedAt" IS NOT NULL OR NEW."liftedById" IS NOT NULL OR NEW."liftReason" IS NOT NULL THEN
      RAISE EXCEPTION 'receivables: reminder stop % starts in force, not lifted', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."status"::text AS status, i."docType"::text AS doc_type INTO invoice FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";
    -- B-W2b-GB02 (G150): + a debit note (TD05), which reminders cover too.
    IF FOUND AND (invoice.status = 'DRAFT' OR invoice.doc_type NOT IN ('TD01', 'TD24', 'TD05')) THEN
      RAISE EXCEPTION 'receivables: reminder stop % names invoice %, a % %; reminders cover issued TD01, TD24 and TD05 invoices', NEW."id", NEW."invoiceId", invoice.status, invoice.doc_type
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."invoiceId", NEW."reason", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."invoiceId", OLD."reason", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'receivables: the invoice, reason and creation of reminder stop % never change (another reason is another stop)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."liftedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'receivables: reminder stop % is lifted; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."reason" = 'PROMISE_TO_PAY' AND NEW."until" IS NULL) OR NEW."until" < "factory_money_rome_day"(NEW."createdAt")
     OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'receivables: reminder stop % holds until a day not before it was made (a promise to pay names the day promised), with a note of 1 to 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."liftedAt" IS NULL) <> (NEW."liftedById" IS NULL) OR (NEW."liftedAt" IS NULL AND NEW."liftReason" IS NOT NULL)
     OR NOT "factory_recall_words_ok"(NEW."liftReason", 500, true)
     OR NEW."liftedAt" < NEW."createdAt" OR NOT "factory_recall_not_future"(NEW."liftedAt") THEN
    RAISE EXCEPTION 'receivables: reminder stop % is lifted with who and when (not before it was made, not in the future), why 1 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

