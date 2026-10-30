-- Written by hand (Prisma does not model triggers or partial indexes), after the generated 202610307000_money_w2a_schema
-- and before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp,
-- and keep it OUT of prisma/migrations while `npm run migration` runs (it needs the new tables).

-- The money schema of W2a (wave 7/7): the rules of its tables for every login, the owner included. The API answers
-- first, in words (B-W2a-21 standard vs actual, B-W2a-39 exports and the period lock, B-W2a-54 charge lines, B-W2a-55
-- reminders, B-W2a-61 credit notes from returns and refunds, B-W2a-62 supplier invoices); these are the last word.
-- Every refusal is a check_violation (SQLSTATE 23514).
--
--   append-only    WorkOrderCostEntry: UPDATE, DELETE and TRUNCATE refused (scripts/factory/check-append-only.mjs); a
--                  wrong entry is reversed by a new row.
--   frozen         an EXPORTED accounting export and its files; a FROZEN standard cost (but its end, set once); a
--                  supplier invoice from APPROVED on (but its payment); what an SDI supplier invoice says, always; a
--                  costing method once locked.
--   never deleted  Refund, PaymentReminder, ReceivablesSettings, SupplierInvoice, AccountingExport, PeriodLock: DELETE
--                  and TRUNCATE refused. A DRAFT standard cost, a typed supplier invoice line and a match row before
--                  approval, and the files of a DRAFT export are deleted by the office; TRUNCATE refused.
--   period lock    a write dated inside a HARD lock of its company is refused: an invoice issued, a payment received or
--                  voided, a refund paid or voided, a supplier invoice registered, changed or paid, a work-order cost
--                  entry, an office or system stock move (the floor's moves are dated now; the floor reads no lock).
--   W1 functions   redefined from their whole bodies (…_money_guards), only as far as the new columns and tables need:
--                  factory_invoice_check_issue (the return lines a credit note credits, the payment-schedule steps),
--                  factory_invoice_line_guard (CHARGE lines, the return-line and milestone references),
--                  factory_payment_guard and factory_payment_allocation_check (a payment's refunds count against it).
--                  New triggers on W1 tables (their own functions, no W1 body touched): the period lock on Invoice,
--                  Payment and StockMove, and the costing method's lock on CostingSettings.
--
-- The tenant (and site) of a row are held by the policies (USING and WITH CHECK) and by the references, not here: the
-- triggers leave "tenantId" (and "siteId") to them, so a row moved to another tenant or site is refused by row-level
-- security. A rule that reads another row skips a row this session cannot see (another tenant's). A trigger reads only
-- tables the role that fires it may read, and locks a row FOR SHARE only where that role may update it; elsewhere it
-- takes a transaction advisory lock. "Everything but these columns" is compared as jsonb (to_jsonb(row) minus the
-- named keys), so a column added later is frozen too unless a later migration names it.
--
-- Locks (pg_advisory_xact_lock, held to the end of the transaction), on top of …_money_guards' order (payment, then
-- deposit request or invoice): a credit note's refund takes the credit note's invoice lock, a payment's refund the
-- payment's; the issue of a credit note takes its return lines' locks after the invoices' ('factory.money.return-line',
-- id order); a frozen standard takes 'factory.money.standard-cost' per company and item. A period lock takes its
-- company's 'factory.period-lock' key EXCLUSIVELY; every write the lock may refuse takes it SHARED first, so a lock
-- being made waits for the writes in flight, and a write for the lock (no write slips into a period being closed).

-- =====================================================================================================================
-- Shared
-- =====================================================================================================================

CREATE FUNCTION "factory_money_w2a_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'money: TRUNCATE on "%" is refused; its rows are never deleted', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_money_w2a_refuse_ledger_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a work order''s cost ledger is kept as it was written (a wrong entry is reversed by a new row)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- A whole month: the first day of a month to the last day of a month (Europe/Rome days, as dates).
CREATE FUNCTION "factory_money_whole_months"(first_day date, last_day date) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT first_day IS NOT NULL AND last_day IS NOT NULL AND last_day >= first_day
     AND first_day = date_trunc('month', first_day)::date
     AND last_day = (date_trunc('month', last_day) + interval '1 month' - interval '1 day')::date
$$;

-- The day of an instant in Rome (the business date every W1 module uses).
CREATE FUNCTION "factory_money_rome_day"(at timestamptz) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT (at AT TIME ZONE 'Europe/Rome')::date
$$;

-- =====================================================================================================================
-- Period locks (FIN-046; design finance.accounting "5 · Export and lock")
-- =====================================================================================================================

CREATE FUNCTION "factory_period_lock_key"(tenant uuid, company uuid) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended(concat_ws('|', 'factory.period-lock', tenant, company), 0)
$$;

-- Refuses a write dated `day` inside a HARD lock of the company (`what` names the record in the message). Takes the
-- company's key SHARED, to the end of the transaction. A SOFT lock is the API's (finance may write into it with a reason).
CREATE FUNCTION "factory_period_refuse_locked"(tenant uuid, company uuid, day date, what text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  locked record;
BEGIN
  IF day IS NULL OR company IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock_shared("factory_period_lock_key"(tenant, company));
  SELECT l."periodStart" AS first_day, l."periodEnd" AS last_day INTO locked FROM "PeriodLock" l
   WHERE l."tenantId" = tenant AND l."companyId" = company AND l."status" = 'LOCKED' AND l."level" = 'HARD'
     AND day BETWEEN l."periodStart" AND l."periodEnd"
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'period lock: % is dated %, inside the closed period % to % of its company (a HARD lock: the accountant has it; lift the lock first, with a reason)', what, day, locked.first_day, locked.last_day
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- PeriodLock
--   INSERT     LOCKED, not lifted.
--   UPDATE     an UPDATE that changes nothing passes; the company, the period and the creation never change. LOCKED →
--              UNLOCKED (lifted: when, by whom, why); UNLOCKED → LOCKED (locked again: a new lock time; the lift's
--              columns cleared). The level, the export and the note change with a lock or while LOCKED.
--   every row  whole months; UNLOCKED exactly with its lift (time, person, reason); an export named is an EXPORTED one of
--              the company.
--   overlap    two LOCKED rows of a company never share a day (the company's key, exclusively: the writes in flight
--              finish first, and none starts until the lock is committed).
--   DELETE     refused (lifted instead). TRUNCATE refused.
CREATE FUNCTION "factory_period_lock_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  export_state text;
  export_company uuid;
  other uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'period lock: the lock % of % to % is lifted, never deleted', OLD."id", OLD."periodStart", OLD."periodEnd"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'LOCKED' THEN
      RAISE EXCEPTION 'period lock: lock % starts LOCKED, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."periodStart", NEW."periodEnd", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."periodStart", OLD."periodEnd", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'period lock: the company, period and creation of lock % never change (another period is another lock)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'UNLOCKED' AND NEW."status" = 'UNLOCKED'
       AND (to_jsonb(NEW) - ARRAY['tenantId', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['tenantId', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'period lock: lock % is lifted; lock it again to change it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'UNLOCKED' AND NEW."status" = 'LOCKED' AND NEW."lockedAt" <= OLD."lockedAt" THEN
      RAISE EXCEPTION 'period lock: lock % is locked again with a new lock time (after %)', OLD."id", OLD."lockedAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'LOCKED' AND NEW."status" = 'UNLOCKED'
       AND (NEW."lockedAt", NEW."lockedById", NEW."level") IS DISTINCT FROM (OLD."lockedAt", OLD."lockedById", OLD."level") THEN
      RAISE EXCEPTION 'period lock: lifting lock % keeps the lock it lifts (time, person, level)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NOT "factory_money_whole_months"(NEW."periodStart", NEW."periodEnd") THEN
    RAISE EXCEPTION 'period lock: lock % closes whole months: the first day of a month to the last day of a month, not % to %', NEW."id", NEW."periodStart", NEW."periodEnd"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'UNLOCKED') <> (NEW."unlockedAt" IS NOT NULL)
     OR (NEW."unlockedAt" IS NULL) <> (NEW."unlockedById" IS NULL)
     OR (NEW."unlockedAt" IS NULL) <> (NEW."unlockReason" IS NULL)
     OR btrim(NEW."unlockReason") = '' THEN
    RAISE EXCEPTION 'period lock: lock % is lifted exactly with when, by whom and why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."exportId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."exportId" IS DISTINCT FROM OLD."exportId") THEN
    SELECT e."status"::text, e."companyId" INTO export_state, export_company FROM "AccountingExport" e
     WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."exportId";
    IF FOUND AND export_state <> 'EXPORTED' THEN
      RAISE EXCEPTION 'period lock: lock % names export %, which is %; a lock names the EXPORTED batch made before it', NEW."id", NEW."exportId", export_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock("factory_period_lock_key"(NEW."tenantId", NEW."companyId"));
  IF NEW."status" = 'LOCKED' THEN
    SELECT l."id" INTO other FROM "PeriodLock" l
     WHERE l."tenantId" = NEW."tenantId" AND l."companyId" = NEW."companyId" AND l."id" <> NEW."id" AND l."status" = 'LOCKED'
       AND daterange(l."periodStart", l."periodEnd", '[]') && daterange(NEW."periodStart", NEW."periodEnd", '[]')
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'period lock: % to % overlaps lock % of the company; two live locks never share a day', NEW."periodStart", NEW."periodEnd", other
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PeriodLock_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PeriodLock"
  FOR EACH ROW EXECUTE FUNCTION "factory_period_lock_guard"();
CREATE TRIGGER "PeriodLock_no_truncate" BEFORE TRUNCATE ON "PeriodLock"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_w2a_refuse_truncate"();

-- =====================================================================================================================
-- Invoice and InvoiceLine (W1, …_money_guards): charge lines (FIN-060), the return lines a credit note credits
-- (FIN-070), the payment-schedule steps a line bills (FIN-058), and the period lock on the issue
-- =====================================================================================================================

-- factory_invoice_check_issue, the whole body of …_money_guards, plus at its end (W2a, wave 7/7):
--   return lines  a credit note's line crediting a return line: of a return of the invoice's company; when the return
--                 line names the invoice line it returns, that line is on the invoice the credit note credits; the
--                 credit notes issued for a return line never credit more pieces than it returns (locks: each return
--                 line, in id order, after the invoices' locks above).
--   milestones    a line naming a step of the order's payment schedule: a step of the invoice's company and, when the
--                 invoice names its order, of that order; an invoice (not a credit note) bills no WAIVED or CANCELLED
--                 step.
CREATE OR REPLACE FUNCTION "factory_invoice_check_issue"(inv "Invoice") RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  series_kind text;
  series_fiscal boolean;
  bad_entries bigint;
  summary_taxable numeric;
  summary_vat numeric;
  summary_rounding numeric;
  line_count bigint;
  line_net numeric;
  bad_line uuid;
  request_status text;
  request_amount int;
  request_currency text;
  deposit_invoiced bigint;
  original record;
  credited bigint;
  credited_net bigint;
  deducted_net bigint;
  deposit record;
  returned record;
  credited_quantity numeric;
BEGIN
  IF btrim(inv."number") = '' OR length(inv."number") > 20 OR inv."number" !~ '[0-9]' THEN
    RAISE EXCEPTION 'invoicing: invoice % gets a number of at most 20 characters with at least one digit (FatturaPA Numero, SDI 00425), not "%"', inv."id", inv."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF inv."year" <> extract(year FROM inv."issueDate")::int THEN
    RAISE EXCEPTION 'invoicing: invoice % is dated % but says year %', inv."id", inv."issueDate", inv."year"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."kind"::text, s."fiscal" INTO series_kind, series_fiscal FROM "NumberSeries" s WHERE s."tenantId" = inv."tenantId" AND s."id" = inv."numberSeriesId";
  IF FOUND THEN
    IF NOT series_fiscal
       OR NOT (series_kind = 'INVOICE'
               OR (series_kind = 'DEPOSIT_INVOICE' AND inv."docType" = 'TD02')
               OR (series_kind = 'CREDIT_NOTE' AND inv."docType" = 'TD04')) THEN
      RAISE EXCEPTION 'invoicing: a % is numbered from a fiscal INVOICE series (or DEPOSIT_INVOICE for a TD02, CREDIT_NOTE for a TD04), not from a % series', inv."docType", series_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF inv."seller" IS NULL OR jsonb_typeof(inv."seller") <> 'object' THEN
    RAISE EXCEPTION 'invoicing: invoice % is issued with the seller''s data as issued (an object)', inv."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The totals.
  SELECT count(*) FILTER (WHERE jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'taxable') IS DISTINCT FROM 'number'
                                OR jsonb_typeof(e -> 'vat') IS DISTINCT FROM 'number'
                                OR coalesce(jsonb_typeof(e -> 'rounding'), 'null') NOT IN ('number', 'null')),
         coalesce(sum((e ->> 'taxable')::numeric), 0), coalesce(sum((e ->> 'vat')::numeric), 0), coalesce(sum((e ->> 'rounding')::numeric), 0)
    INTO bad_entries, summary_taxable, summary_vat, summary_rounding
    FROM jsonb_array_elements(inv."vatSummary") e;
  IF jsonb_array_length(inv."vatSummary") = 0 OR bad_entries > 0 THEN
    RAISE EXCEPTION 'invoicing: invoice % is issued with its VAT summary: at least one entry, each with its taxable, VAT and rounding in minor units', inv."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), coalesce(sum(l."netAmount"), 0) INTO line_count, line_net
    FROM "InvoiceLine" l WHERE l."tenantId" = inv."tenantId" AND l."invoiceId" = inv."id";
  IF line_count = 0 THEN
    RAISE EXCEPTION 'invoicing: invoice % has no line; an invoice is issued with at least one', inv."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF summary_taxable <> inv."netTotal" OR summary_vat <> inv."vatTotal" OR line_net + summary_rounding <> inv."netTotal" THEN
    RAISE EXCEPTION 'invoicing: the totals of invoice % do not add up: net % and VAT % against a VAT summary of % and % (rounding %) and lines of %', inv."id", inv."netTotal", inv."vatTotal", summary_taxable, summary_vat, summary_rounding, line_net
      USING ERRCODE = 'check_violation';
  END IF;

  -- The lines' sources.
  IF inv."docType" = 'TD24' THEN
    SELECT l."id" INTO bad_line FROM "InvoiceLine" l
     WHERE l."tenantId" = inv."tenantId" AND l."invoiceId" = inv."id" AND l."kind" = 'GOODS' AND l."ddtId" IS NULL LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'invoicing: TD24 % bills goods shipped with DDTs: its line % names its DDT (DPR 633/1972 art. 21 c.4)', inv."id", bad_line
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT l."id" INTO bad_line FROM "InvoiceLine" l JOIN "Ddt" d ON d."tenantId" = l."tenantId" AND d."id" = l."ddtId"
   WHERE l."tenantId" = inv."tenantId" AND l."invoiceId" = inv."id"
     AND (d."companyId" <> inv."companyId"
          OR EXISTS (SELECT 1 FROM "DdtCancellation" x WHERE x."tenantId" = d."tenantId" AND x."ddtId" = d."id"))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'invoicing: line % of invoice % names a DDT of another company, or a cancelled one', bad_line, inv."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."id" INTO bad_line FROM "InvoiceLine" l JOIN "SalesOrderLine" s ON s."tenantId" = l."tenantId" AND s."id" = l."salesOrderLineId"
   WHERE l."tenantId" = inv."tenantId" AND l."invoiceId" = inv."id"
     AND (s."companyId" <> inv."companyId" OR (inv."salesOrderId" IS NOT NULL AND s."orderId" <> inv."salesOrderId"))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'invoicing: line % of invoice % bills an order line of another company or order', bad_line, inv."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF inv."docType" IN ('TD02', 'TD04') AND inv."grossTotal" <= 0 THEN
    RAISE EXCEPTION 'invoicing: % % has a gross total above 0', inv."docType", inv."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- TD02: the deposit request.
  IF inv."docType" = 'TD02' THEN
    PERFORM "factory_money_lock"('deposit', inv."tenantId", inv."depositRequestId");
    SELECT r."status"::text, r."amount", r."currency" INTO request_status, request_amount, request_currency
      FROM "DepositRequest" r WHERE r."tenantId" = inv."tenantId" AND r."id" = inv."depositRequestId";
    IF FOUND THEN
      IF request_status NOT IN ('OPEN', 'PAID') OR request_currency <> inv."currency" THEN
        RAISE EXCEPTION 'invoicing: TD02 % invoices deposit request %, which is % in %; a deposit invoice is for an OPEN or PAID request in its currency', inv."id", inv."depositRequestId", request_status, request_currency
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT coalesce(sum(d."grossTotal" - "factory_invoice_credited"(d."tenantId", d."id", NULL)), 0) INTO deposit_invoiced
        FROM "Invoice" d
       WHERE d."tenantId" = inv."tenantId" AND d."depositRequestId" = inv."depositRequestId" AND d."docType" = 'TD02'
         AND d."status" <> 'DRAFT' AND d."id" <> inv."id";
      IF deposit_invoiced + inv."grossTotal" > request_amount THEN
        RAISE EXCEPTION 'invoicing: deposit request % asks for %; its deposit invoices would reach % (% already)', inv."depositRequestId", request_amount, deposit_invoiced + inv."grossTotal", deposit_invoiced
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- TD04: the credited invoice.
  IF inv."docType" = 'TD04' THEN
    IF btrim(coalesce(inv."causale", '')) = '' THEN
      RAISE EXCEPTION 'invoicing: credit note % says why it credits (causale; DPR 633/1972 art. 26)', inv."id"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_money_lock"('invoice', inv."tenantId", inv."creditOfId");
    SELECT o."status"::text AS status, o."docType"::text AS doc_type, o."issueDate" AS issue_date, o."grossTotal" AS gross, o."netTotal" AS net
      INTO original FROM "Invoice" o WHERE o."tenantId" = inv."tenantId" AND o."id" = inv."creditOfId";
    IF FOUND THEN
      IF original.status = 'DRAFT' OR original.doc_type = 'TD04' OR original.issue_date > inv."issueDate" THEN
        RAISE EXCEPTION 'invoicing: credit note % credits invoice %, which is a % %; a credit note credits an issued invoice (not a credit note) of its date or before', inv."id", inv."creditOfId", original.status, original.doc_type
          USING ERRCODE = 'check_violation';
      END IF;
      credited := "factory_invoice_credited"(inv."tenantId", inv."creditOfId", inv."id");
      IF credited + inv."grossTotal" > original.gross THEN
        RAISE EXCEPTION 'invoicing: invoice % has a gross total of % and % credited; credit note % of % passes what is still creditable (DPR 633/1972 art. 26)', inv."creditOfId", original.gross, credited, inv."id", inv."grossTotal"
          USING ERRCODE = 'check_violation';
      END IF;
      IF original.doc_type = 'TD02' THEN
        SELECT coalesce(sum(c."netTotal"), 0) INTO credited_net FROM "Invoice" c
         WHERE c."tenantId" = inv."tenantId" AND c."creditOfId" = inv."creditOfId" AND c."docType" = 'TD04' AND c."status" <> 'DRAFT' AND c."id" <> inv."id";
        SELECT coalesce(sum(-l."netAmount"), 0) INTO deducted_net FROM "InvoiceLine" l JOIN "Invoice" i ON i."tenantId" = l."tenantId" AND i."id" = l."invoiceId"
         WHERE l."tenantId" = inv."tenantId" AND l."depositInvoiceId" = inv."creditOfId" AND i."status" <> 'DRAFT';
        IF credited_net + deducted_net + inv."netTotal" > original.net THEN
          RAISE EXCEPTION 'invoicing: deposit invoice % (net %) has % deducted by invoices and % credited; credit note % of net % passes it', inv."creditOfId", original.net, deducted_net, credited_net, inv."id", inv."netTotal"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;

  -- Deposit invoices deducted (TD01, TD24).
  FOR deposit IN
    SELECT DISTINCT l."depositInvoiceId" AS id FROM "InvoiceLine" l
     WHERE l."tenantId" = inv."tenantId" AND l."invoiceId" = inv."id" AND l."depositInvoiceId" IS NOT NULL
     ORDER BY 1
  LOOP
    PERFORM "factory_money_lock"('invoice', inv."tenantId", deposit.id);
    SELECT o."status"::text AS status, o."docType"::text AS doc_type, o."companyId" AS company, o."netTotal" AS net
      INTO original FROM "Invoice" o WHERE o."tenantId" = inv."tenantId" AND o."id" = deposit.id;
    IF FOUND THEN
      IF original.status = 'DRAFT' OR original.doc_type <> 'TD02' OR original.company <> inv."companyId" THEN
        RAISE EXCEPTION 'invoicing: invoice % deducts %, which is a % % of another company or not issued; a deduction names an issued TD02 of the company', inv."id", deposit.id, original.status, original.doc_type
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT coalesce(sum(-l."netAmount"), 0) INTO deducted_net FROM "InvoiceLine" l JOIN "Invoice" i ON i."tenantId" = l."tenantId" AND i."id" = l."invoiceId"
       WHERE l."tenantId" = inv."tenantId" AND l."depositInvoiceId" = deposit.id AND (i."status" <> 'DRAFT' OR i."id" = inv."id");
      SELECT coalesce(sum(c."netTotal"), 0) INTO credited_net FROM "Invoice" c
       WHERE c."tenantId" = inv."tenantId" AND c."creditOfId" = deposit.id AND c."docType" = 'TD04' AND c."status" <> 'DRAFT';
      IF deducted_net + credited_net > original.net THEN
        RAISE EXCEPTION 'invoicing: deposit invoice % has a net of % (% credited); the invoices that deduct it would deduct %', deposit.id, original.net, credited_net, deducted_net
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END LOOP;

  -- W2a (wave 7/7): the return lines a credit note credits (FIN-070), and the payment-schedule steps the lines bill
  -- (FIN-058).
  FOR returned IN
    SELECT DISTINCT l."returnLineId" AS id FROM "InvoiceLine" l
     WHERE l."tenantId" = inv."tenantId" AND l."invoiceId" = inv."id" AND l."returnLineId" IS NOT NULL
     ORDER BY 1
  LOOP
    PERFORM "factory_money_lock"('return-line', inv."tenantId", returned.id);
    SELECT r."companyId" AS company, x."invoiceId" AS billed_on, rl."quantity" AS quantity
      INTO original FROM "ReturnLine" rl
      JOIN "ReturnAuthorisation" r ON r."tenantId" = rl."tenantId" AND r."id" = rl."returnId"
      LEFT JOIN "InvoiceLine" x ON x."tenantId" = rl."tenantId" AND x."id" = rl."invoiceLineId"
     WHERE rl."tenantId" = inv."tenantId" AND rl."id" = returned.id;
    IF FOUND THEN
      IF original.company <> inv."companyId" OR (original.billed_on IS NOT NULL AND original.billed_on IS DISTINCT FROM inv."creditOfId") THEN
        RAISE EXCEPTION 'invoicing: credit note % credits return line %, which is of another company''s return or returns a line of another invoice than the one it credits (%)', inv."id", returned.id, inv."creditOfId"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT coalesce(sum(l."quantity"), 0) INTO credited_quantity FROM "InvoiceLine" l
        JOIN "Invoice" i ON i."tenantId" = l."tenantId" AND i."id" = l."invoiceId"
       WHERE l."tenantId" = inv."tenantId" AND l."returnLineId" = returned.id AND i."docType" = 'TD04'
         AND (i."status" <> 'DRAFT' OR i."id" = inv."id");
      IF credited_quantity > original.quantity THEN
        RAISE EXCEPTION 'invoicing: return line % brings back % pieces; the credit notes that credit it would credit %', returned.id, original.quantity, credited_quantity
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END LOOP;
  SELECT l."id" INTO bad_line FROM "InvoiceLine" l
    JOIN "SalesOrderMilestone" m ON m."tenantId" = l."tenantId" AND m."id" = l."milestoneId"
   WHERE l."tenantId" = inv."tenantId" AND l."invoiceId" = inv."id"
     AND (m."companyId" <> inv."companyId"
          OR (inv."salesOrderId" IS NOT NULL AND m."orderId" <> inv."salesOrderId")
          OR (inv."docType" <> 'TD04' AND m."status" IN ('WAIVED', 'CANCELLED')))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'invoicing: line % of invoice % bills a payment-schedule step of another company or order, or a WAIVED or CANCELLED one', bad_line, inv."id"
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- factory_invoice_line_guard, the whole body of …_money_guards, plus (W2a, wave 7/7):
--   CHARGE      a CHARGE line (and only it) names its charge kind; it bills no order line or size (the
--               shipped-not-invoiced queue and the order's settlement count GOODS lines); a FREIGHT charge may name the
--               DDT whose transport it bills; its amount and price are 0 or more (the W1 rule for every line but a
--               deduction).
--   return line only on a credit note (TD04), never on a deduction or a charge.
--   milestone   never on a deduction or a charge.
CREATE OR REPLACE FUNCTION "factory_invoice_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  invoice_party uuid;
  invoice_type text;
  invoice_company uuid;
  part_of uuid;
  deposit_state text;
  deposit_type text;
  deposit_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."invoiceId" <> OLD."invoiceId" OR NEW."buyerPartyId" <> OLD."buyerPartyId" THEN
      RAISE EXCEPTION 'invoicing: invoice line % never moves to another invoice', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    part_of := OLD."invoiceId";
    SELECT i."status"::text, i."partyId", i."docType"::text, i."companyId" INTO state, invoice_party, invoice_type, invoice_company
      FROM "Invoice" i WHERE i."tenantId" = OLD."tenantId" AND i."id" = OLD."invoiceId" FOR SHARE;
  ELSE
    part_of := NEW."invoiceId";
    SELECT i."status"::text, i."partyId", i."docType"::text, i."companyId" INTO state, invoice_party, invoice_type, invoice_company
      FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state NOT IN ('DRAFT', 'REJECTED') THEN
    IF TG_OP = 'UPDATE' AND OLD."partyId" IS NULL AND NEW."partyId" IS NOT DISTINCT FROM invoice_party
       AND (to_jsonb(NEW) - ARRAY['tenantId', 'partyId']) = (to_jsonb(OLD) - ARRAY['tenantId', 'partyId']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invoicing: invoice % is %; its lines are written only while it is a DRAFT, or REJECTED to correct the file (an invoice SDI took never changes: a credit note corrects it)', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF state = 'DRAFT' AND NEW."partyId" IS NOT NULL THEN
    RAISE EXCEPTION 'invoicing: line % belongs to a DRAFT; it has no party key until the invoice is issued', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF state = 'REJECTED' THEN
    IF NEW."partyId" IS NULL AND TG_OP = 'INSERT' THEN
      NEW."partyId" := invoice_party;
    END IF;
    IF NEW."partyId" IS DISTINCT FROM invoice_party THEN
      RAISE EXCEPTION 'invoicing: line % of issued invoice % has the invoice''s party key %', NEW."id", part_of, invoice_party
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."seq" < 1 OR btrim(NEW."description") = '' OR NEW."quantity" <= 0
     OR (NEW."discountPct" IS NOT NULL AND (NEW."discountPct" <= 0 OR NEW."discountPct" >= 100)) THEN
    RAISE EXCEPTION 'invoicing: line % has a place from 1, a description, a quantity above 0 and a discount above 0 and below 100', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."vatRatePct" < 0 OR (NEW."vatNature" IS NOT NULL) <> (NEW."vatRatePct" = 0)
     OR (NEW."vatLegalRef" IS NOT NULL) <> (NEW."vatNature" IS NOT NULL)
     OR NEW."vatNature" !~ '^N[1-7](\.[0-9])?$' OR btrim(NEW."vatLegalRef") = '' THEN
    RAISE EXCEPTION 'invoicing: line % is taxed at a rate above 0, or at 0 with its Natura (N1 … N7) and the law that says why (DPR 633/1972 art. 21 c.6)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'DEPOSIT_DEDUCTION') <> (NEW."depositInvoiceId" IS NOT NULL) THEN
    RAISE EXCEPTION 'invoicing: a DEPOSIT_DEDUCTION line (and only it) names the deposit invoice it deducts (line %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'DEPOSIT_DEDUCTION' THEN
    IF NEW."netAmount" >= 0 OR NEW."unitPrice" >= 0 OR NEW."salesOrderLineId" IS NOT NULL OR NEW."ddtId" IS NOT NULL
       OR (invoice_type IS NOT NULL AND invoice_type NOT IN ('TD01', 'TD24')) THEN
      RAISE EXCEPTION 'invoicing: deduction line % of a TD01 or TD24 takes a negative amount off, with no order line or DDT', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT d."status"::text, d."docType"::text, d."companyId" INTO deposit_state, deposit_type, deposit_company
      FROM "Invoice" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."depositInvoiceId";
    IF FOUND AND (deposit_state = 'DRAFT' OR deposit_type <> 'TD02' OR deposit_company IS DISTINCT FROM coalesce(invoice_company, deposit_company)) THEN
      RAISE EXCEPTION 'invoicing: line % deducts invoice %, a % %; a deduction names an issued TD02 of the company', NEW."id", NEW."depositInvoiceId", deposit_state, deposit_type
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."netAmount" < 0 OR NEW."unitPrice" < 0 OR NEW."grossAmount" < 0 THEN
    RAISE EXCEPTION 'invoicing: line % has an amount and price of 0 or more (a credit is a TD04 with positive amounts)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- W2a (wave 7/7): charge lines (FIN-060), the return line a credit note's line credits (FIN-070), the step of the
  -- payment schedule a line bills (FIN-058).
  IF (NEW."kind" = 'CHARGE') <> (NEW."chargeKind" IS NOT NULL) THEN
    RAISE EXCEPTION 'invoicing: a CHARGE line (and only it) names what it charges: freight, packaging, samples, a fee (line %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'CHARGE' AND (NEW."salesOrderLineId" IS NOT NULL OR NEW."size" IS NOT NULL) THEN
    RAISE EXCEPTION 'invoicing: charge line % bills no order line or size (the goods are GOODS lines; a FREIGHT charge may name its DDT)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."returnLineId" IS NOT NULL AND (NEW."kind" IN ('DEPOSIT_DEDUCTION', 'CHARGE') OR invoice_type <> 'TD04') THEN
    RAISE EXCEPTION 'invoicing: only a credit note''s line (not a deduction or a charge) names the return line it credits (line %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."milestoneId" IS NOT NULL AND NEW."kind" IN ('DEPOSIT_DEDUCTION', 'CHARGE') THEN
    RAISE EXCEPTION 'invoicing: a deduction or a charge line bills no step of the payment schedule (line %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- The period lock on the issue (and only there: a REJECTED invoice's correction keeps its number and date and is sent
-- again by law within five working days; B-W2a-39's checks keep a period with a rejected invoice from being locked).
CREATE FUNCTION "factory_invoice_period_lock"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", NEW."issueDate", format('invoice %s (number %s)', NEW."id", NEW."number"));
  RETURN NEW;
END
$$;

CREATE TRIGGER "Invoice_period_lock" BEFORE UPDATE ON "Invoice"
  FOR EACH ROW WHEN (OLD."status" = 'DRAFT' AND NEW."status" <> 'DRAFT')
  EXECUTE FUNCTION "factory_invoice_period_lock"();

-- =====================================================================================================================
-- Payments (W1, …_money_guards) and refunds (FIN-122, FIN-127)
-- =====================================================================================================================

-- factory_payment_guard, the whole body of …_money_guards, plus (W2a): a payment with a refund DUE or PAID is not voided
-- (cancel or void the refund first).
CREATE OR REPLACE FUNCTION "factory_payment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  allocated bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments: payment % is kept (voided when typed by mistake), never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RECEIVED' THEN
      RAISE EXCEPTION 'payments: payment % starts RECEIVED, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."status" = 'VOIDED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'payments: payment % is VOIDED; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - (kept || ARRAY['status', 'voidedAt', 'voidReason', 'internalNote', 'version', 'updatedAt']))
       IS DISTINCT FROM
       (to_jsonb(OLD) - (kept || ARRAY['status', 'voidedAt', 'voidReason', 'internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'payments: the company, party, amount, currency, date and reference of payment % never change (a wrong one is voided and typed again)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" THEN
      IF NOT (OLD."status" = 'RECEIVED' AND NEW."status" = 'VOIDED') THEN
        RAISE EXCEPTION 'payments: payment % cannot move from % to %', OLD."id", OLD."status", NEW."status"
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM "factory_money_lock"('payment', NEW."tenantId", NEW."id");
      SELECT coalesce(sum(a."amount"), 0) INTO allocated FROM "PaymentAllocation" a WHERE a."tenantId" = NEW."tenantId" AND a."paymentId" = NEW."id";
      IF allocated <> 0 THEN
        RAISE EXCEPTION 'payments: payment % still pays % (its allocations); reverse them before voiding it', NEW."id", allocated
          USING ERRCODE = 'check_violation';
      END IF;
      -- W2a: a refund of its unplaced part (receivables.prisma Refund) is cancelled or voided first.
      IF EXISTS (SELECT 1 FROM "Refund" r WHERE r."tenantId" = NEW."tenantId" AND r."paymentId" = NEW."id" AND r."status" IN ('DUE', 'PAID')) THEN
        RAISE EXCEPTION 'payments: payment % has a refund due or paid of its unplaced part; cancel or void the refund before voiding the payment', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."amount" <= 0 OR NEW."currency" !~ '^[A-Z]{3}$' OR btrim(NEW."externalRef") = '' THEN
    RAISE EXCEPTION 'payments: payment % has an amount above 0, an ISO currency and the bank''s reference', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'VOIDED') <> (NEW."voidedAt" IS NOT NULL) OR (NEW."status" = 'VOIDED' AND btrim(coalesce(NEW."voidReason", '')) = '') THEN
    RAISE EXCEPTION 'payments: payment % has its void time and reason exactly when VOIDED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- factory_payment_allocation_check, the whole body of …_money_guards, plus (W2a): what is refunded of a payment (DUE or
-- PAID) counts against its amount with its allocations.
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
    IF allocated + refunded + NEW."amount" > payment_amount THEN
      RAISE EXCEPTION 'payments: payment % of % has % allocated; % more passes it (% of it refunded or due to be)', NEW."paymentId", payment_amount, allocated, NEW."amount", refunded
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."invoiceId" IS NOT NULL THEN
    SELECT i."status"::text, i."docType"::text, i."grossTotal", i."currency" INTO target_state, target_type, target_amount, target_currency
      FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";
    IF FOUND AND NEW."amount" > 0 THEN
      IF target_state = 'DRAFT' OR target_type NOT IN ('TD01', 'TD24') THEN
        RAISE EXCEPTION 'payments: invoice % is a % %; payments go to issued TD01 and TD24 invoices (a TD02 is paid through its deposit request, a TD04 is not paid)', NEW."invoiceId", target_state, target_type
          USING ERRCODE = 'check_violation';
      END IF;
      IF target_currency IS DISTINCT FROM coalesce(payment_currency, target_currency) THEN
        RAISE EXCEPTION 'payments: payment % in % cannot pay invoice % in %', NEW."paymentId", payment_currency, NEW."invoiceId", target_currency
          USING ERRCODE = 'check_violation';
      END IF;
      credited := "factory_invoice_credited"(NEW."tenantId", NEW."invoiceId", NULL);
      SELECT coalesce(sum(a."amount"), 0) INTO allocated FROM "PaymentAllocation" a WHERE a."tenantId" = NEW."tenantId" AND a."invoiceId" = NEW."invoiceId";
      IF allocated + NEW."amount" > target_amount - credited THEN
        RAISE EXCEPTION 'payments: invoice % is open for % (gross %, credited %, paid %); % more passes it', NEW."invoiceId", target_amount - credited - allocated, target_amount, credited, allocated, NEW."amount"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    SELECT r."status"::text, r."amount", r."currency" INTO target_state, target_amount, target_currency
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
      ELSIF target_state = 'PAID' THEN
        RAISE EXCEPTION 'payments: deposit request % is PAID (final); its allocations stay', NEW."depositRequestId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- The period lock on a payment: received (its date) or voided.
CREATE FUNCTION "factory_payment_period_lock"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (NEW."status" = 'VOIDED' AND OLD."status" <> 'VOIDED') THEN
    PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", NEW."receivedOn", format('payment %s (%s)', NEW."id", NEW."externalRef"));
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Payment_period_lock" BEFORE INSERT OR UPDATE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION "factory_payment_period_lock"();

-- Refund (FIN-127; FIN-122 the credit balance)
--   INSERT     DUE or PAID (recorded once made); never CANCELLED or VOIDED.
--   UPDATE     an UPDATE that changes nothing passes; the company, party, source, method, currency and creation never
--              change. While DUE the amount, due date and note change; DUE → PAID (when, the bank's date and reference)
--              | CANCELLED (when, why); PAID → VOIDED (when, why: typed by mistake), nothing else of a PAID one changes;
--              CANCELLED and VOIDED are final.
--   every row  an amount above 0, an ISO currency; exactly one source; the payment's columns exactly from PAID on (a
--              VOIDED one keeps them), the cancellation's exactly when CANCELLED, the void's exactly when VOIDED.
--   source     (on INSERT and when the amount grows) a credit note: an issued TD04 of the company to the party in the
--              refund's currency, whose refunds (DUE or PAID) never pass its gross total (lock: the credit note); a
--              payment: RECEIVED, in the refund's currency, whose allocations and refunds never pass its amount (lock:
--              the payment, as an allocation takes it).
--   period     paid (or voided) with a bank date inside a HARD lock: refused.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_refund_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  due_moves CONSTANT text[] := ARRAY['amount', 'dueDate', 'internalNote', 'status', 'paidOn', 'externalRef', 'paidAt', 'paidById',
    'cancelledAt', 'cancelReason', 'version', 'updatedAt'];
  paid_moves CONSTANT text[] := ARRAY['status', 'voidedAt', 'voidReason', 'internalNote', 'version', 'updatedAt'];
  source_state text;
  source_type text;
  source_currency text;
  source_amount bigint;
  allocated bigint;
  refunded bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refunds: refund % is cancelled or voided, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('DUE', 'PAID') THEN
      RAISE EXCEPTION 'refunds: refund % starts DUE (or PAID when it is recorded once made), not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."creditNoteId", NEW."paymentId", NEW."method", NEW."currency", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."partyId", OLD."creditNoteId", OLD."paymentId", OLD."method", OLD."currency", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'refunds: the company, party, source, method, currency and creation of refund % never change (another refund is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CANCELLED', 'VOIDED') THEN
      RAISE EXCEPTION 'refunds: refund % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'DUE' AND (to_jsonb(NEW) - (kept || due_moves)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || due_moves)) THEN
      RAISE EXCEPTION 'refunds: refund % is DUE; only its amount, due date and note change, and it is paid or cancelled', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'PAID' AND (to_jsonb(NEW) - (kept || paid_moves)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || paid_moves)) THEN
      RAISE EXCEPTION 'refunds: refund % is PAID; what was paid never changes (a refund typed by mistake is voided)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'DUE' AND NEW."status" IN ('PAID', 'CANCELLED'))
      OR (OLD."status" = 'PAID' AND NEW."status" = 'VOIDED')) THEN
      RAISE EXCEPTION 'refunds: refund % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."amount" <= 0 OR NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'refunds: refund % has an amount above 0 and an ISO currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."creditNoteId" IS NULL) = (NEW."paymentId" IS NULL) THEN
    RAISE EXCEPTION 'refunds: refund % pays back exactly one thing: a credit note on what was paid, or a payment''s unplaced part', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('PAID', 'VOIDED')) <> (NEW."paidOn" IS NOT NULL)
     OR (NEW."paidOn" IS NULL) <> (NEW."paidAt" IS NULL)
     OR (NEW."paidOn" IS NULL) <> (NEW."externalRef" IS NULL)
     OR btrim(NEW."externalRef") = '' THEN
    RAISE EXCEPTION 'refunds: refund % is % with the wrong payment columns (from PAID on: the bank''s date, its reference and when it was recorded)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL) OR btrim(NEW."cancelReason") = ''
     OR (NEW."status" = 'VOIDED') <> (NEW."voidedAt" IS NOT NULL)
     OR (NEW."voidedAt" IS NULL) <> (NEW."voidReason" IS NULL) OR btrim(NEW."voidReason") = '' THEN
    RAISE EXCEPTION 'refunds: refund % has its cancellation exactly when CANCELLED and its void exactly when VOIDED, each with why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' OR NEW."amount" > OLD."amount" THEN
    IF NEW."creditNoteId" IS NOT NULL THEN
      PERFORM "factory_money_lock"('invoice', NEW."tenantId", NEW."creditNoteId");
      SELECT i."status"::text, i."docType"::text, i."currency", i."grossTotal" INTO source_state, source_type, source_currency, source_amount
        FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."creditNoteId";
      IF FOUND THEN
        IF source_state = 'DRAFT' OR source_type <> 'TD04' OR source_currency <> NEW."currency" THEN
          RAISE EXCEPTION 'refunds: refund % names invoice %, a % % in %; a refund pays back what an issued credit note (TD04) credits, in its currency', NEW."id", NEW."creditNoteId", source_state, source_type, source_currency
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT coalesce(sum(r."amount"), 0) INTO refunded FROM "Refund" r
         WHERE r."tenantId" = NEW."tenantId" AND r."creditNoteId" = NEW."creditNoteId" AND r."status" IN ('DUE', 'PAID') AND r."id" <> NEW."id";
        IF refunded + NEW."amount" > source_amount THEN
          RAISE EXCEPTION 'refunds: credit note % credits % and has % refunded or due; refund % of % passes it', NEW."creditNoteId", source_amount, refunded, NEW."id", NEW."amount"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    ELSE
      PERFORM "factory_money_lock"('payment', NEW."tenantId", NEW."paymentId");
      SELECT p."status"::text, p."currency", p."amount" INTO source_state, source_currency, source_amount
        FROM "Payment" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId";
      IF FOUND THEN
        IF source_state <> 'RECEIVED' OR source_currency <> NEW."currency" THEN
          RAISE EXCEPTION 'refunds: refund % pays back payment %, which is % in %; a refund pays back a RECEIVED payment, in its currency', NEW."id", NEW."paymentId", source_state, source_currency
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT coalesce(sum(a."amount"), 0) INTO allocated FROM "PaymentAllocation" a WHERE a."tenantId" = NEW."tenantId" AND a."paymentId" = NEW."paymentId";
        SELECT coalesce(sum(r."amount"), 0) INTO refunded FROM "Refund" r
         WHERE r."tenantId" = NEW."tenantId" AND r."paymentId" = NEW."paymentId" AND r."status" IN ('DUE', 'PAID') AND r."id" <> NEW."id";
        IF allocated + refunded + NEW."amount" > source_amount THEN
          RAISE EXCEPTION 'refunds: payment % of % has % allocated and % refunded or due; refund % of % passes what is unplaced', NEW."paymentId", source_amount, allocated, refunded, NEW."id", NEW."amount"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;

  IF NEW."paidOn" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."status" IS DISTINCT FROM OLD."status") THEN
    PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", NEW."paidOn", format('refund %s (%s)', NEW."id", NEW."externalRef"));
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Refund_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Refund"
  FOR EACH ROW EXECUTE FUNCTION "factory_refund_guard"();
CREATE TRIGGER "Refund_no_truncate" BEFORE TRUNCATE ON "Refund"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_w2a_refuse_truncate"();

-- =====================================================================================================================
-- Receivables: the reminder ladder and the reminders (FIN-110, FIN-111)
-- =====================================================================================================================

-- ReceivablesSettings
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change.
--   every row  the ladder: a list of at most 10 steps, each an object { level, offsetDays, action, template? } with the
--              levels 1, 2, 3 … in order, the days whole, from −60 to 365 and strictly increasing, the action EMAIL,
--              LETTER or CALL, the template a key when given; the agreed interest rate exactly when AGREED (above 0, at
--              most 100); the recovery charge and the minimum amount 0 or more. Reminders are switched on only with a
--              ladder of at least one step and the late-payment rule decided (not UNDECIDED: the accountant's,
--              GATE-ACCOUNTANT).
--   DELETE     refused (the settings are changed). TRUNCATE refused.
CREATE FUNCTION "factory_receivables_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  step jsonb;
  place bigint;
  previous int;
  days int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receivables: the receivables settings % are changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'receivables: the company and creation of the receivables settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF jsonb_typeof(NEW."ladder") <> 'array' OR jsonb_array_length(NEW."ladder") > 10 THEN
    RAISE EXCEPTION 'receivables: the reminder ladder of the settings % is a list of at most 10 steps', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  FOR step, place IN SELECT e, n FROM jsonb_array_elements(NEW."ladder") WITH ORDINALITY AS t(e, n) LOOP
    IF jsonb_typeof(step) <> 'object'
       OR jsonb_typeof(step -> 'level') IS DISTINCT FROM 'number' OR (step ->> 'level') !~ '^[0-9]+$' OR (step ->> 'level')::numeric <> place
       OR jsonb_typeof(step -> 'offsetDays') IS DISTINCT FROM 'number' OR (step ->> 'offsetDays') !~ '^-?[0-9]+$'
       OR coalesce(step ->> 'action', '') NOT IN ('EMAIL', 'LETTER', 'CALL')
       OR (step ? 'template' AND jsonb_typeof(step -> 'template') <> 'null'
           AND (jsonb_typeof(step -> 'template') <> 'string' OR btrim(step ->> 'template') = '')) THEN
      RAISE EXCEPTION 'receivables: step % of the reminder ladder of the settings % is { "level": %, "offsetDays": whole days, "action": EMAIL | LETTER | CALL, "template": a key or nothing }', place, NEW."id", place
        USING ERRCODE = 'check_violation';
    END IF;
    days := (step ->> 'offsetDays')::int;
    IF days < -60 OR days > 365 OR (previous IS NOT NULL AND days <= previous) THEN
      RAISE EXCEPTION 'receivables: the steps of the reminder ladder of the settings % come from 60 days before the due date to 365 after it, each later than the one before (step %: % days)', NEW."id", place, days
        USING ERRCODE = 'check_violation';
    END IF;
    previous := days;
  END LOOP;
  IF (NEW."lateInterestMode" = 'AGREED') <> (NEW."lateInterestAgreedPct" IS NOT NULL)
     OR NEW."lateInterestAgreedPct" <= 0 OR NEW."lateInterestAgreedPct" > 100 THEN
    RAISE EXCEPTION 'receivables: the settings % have an agreed late-payment rate exactly when the rule is AGREED, above 0 and at most 100 percent', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."recoveryChargeAmount" < 0 OR NEW."minimumAmount" < 0 THEN
    RAISE EXCEPTION 'receivables: the recovery charge and the minimum amount of the settings % are 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."remindersEnabled" AND (jsonb_array_length(NEW."ladder") = 0 OR NEW."lateInterestMode" = 'UNDECIDED') THEN
    RAISE EXCEPTION 'receivables: reminders are switched on (settings %) only with a ladder and the late-payment rule decided by the accountant (D.Lgs. 231/2002; it is UNDECIDED)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReceivablesSettings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ReceivablesSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_receivables_settings_guard"();
CREATE TRIGGER "ReceivablesSettings_no_truncate" BEFORE TRUNCATE ON "ReceivablesSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_w2a_refuse_truncate"();

-- PaymentReminder
--   INSERT     PREPARED, nothing approved, sent, skipped or cancelled; each invoice an issued TD01 or TD24 of the company to
--              the party, in the reminder's currency.
--   UPDATE     an UPDATE that changes nothing passes; what it covers (company, party, level, action, invoices, amounts,
--              currency, oldest due date) and its creation never change. While PREPARED its language and text change;
--              PREPARED → APPROVED (by a person, when) | SKIPPED (who, when, why) | CANCELLED (when, why); APPROVED →
--              SENT (when; a call with what was said) | CANCELLED. SENT, SKIPPED and CANCELLED are final.
--   every row  a level from 1; at least one invoice, each once; an amount due above 0, interest 0 or more; an ISO
--              currency; a two-letter language; approved (APPROVED, SENT) with who and when; an e-mail or letter approved
--              with its subject and body; sent exactly when SENT; skipped and cancelled exactly in their state.
--   the switch SENT only while the company's receivables settings (else the tenant-wide ones) have reminders switched on
--              (the Owner's switch, off by default: nothing reaches a customer before it).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_payment_reminder_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  text_columns CONSTANT text[] := ARRAY['language', 'subject', 'body'];
  moving CONSTANT text[] := ARRAY['status', 'approvedAt', 'approvedById', 'sentAt', 'callNote', 'skippedAt', 'skippedById', 'skipReason',
    'cancelledAt', 'cancelReason', 'version', 'updatedAt'];
  bad uuid;
  switched_on boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reminders: reminder % is skipped or cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PREPARED' OR NEW."approvedAt" IS NOT NULL OR NEW."sentAt" IS NOT NULL OR NEW."skippedAt" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN
      RAISE EXCEPTION 'reminders: reminder % starts PREPARED, not approved, sent, skipped or cancelled', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT x.id INTO bad FROM unnest(NEW."invoiceIds") AS x(id)
      LEFT JOIN "Invoice" i ON i."tenantId" = NEW."tenantId" AND i."id" = x.id
     WHERE x.id IS NULL
        OR (i."id" IS NOT NULL AND (i."status" = 'DRAFT' OR i."docType" NOT IN ('TD01', 'TD24') OR i."companyId" <> NEW."companyId"
                                    OR i."buyerPartyId" <> NEW."partyId" OR i."currency" <> NEW."currency"))
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'reminders: reminder % names invoice %, which is not an issued TD01 or TD24 of the company to the customer in %', NEW."id", bad, NEW."currency"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."status" IN ('SENT', 'SKIPPED', 'CANCELLED') THEN
      RAISE EXCEPTION 'reminders: reminder % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - (kept || text_columns || moving)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || text_columns || moving)) THEN
      RAISE EXCEPTION 'reminders: what reminder % covers (customer, level, action, invoices, amounts) and its creation never change; the ladder prepares a new one', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'PREPARED' AND (to_jsonb(NEW) - (kept || moving)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || moving)) THEN
      RAISE EXCEPTION 'reminders: reminder % is %; its text is edited only while PREPARED (before a person approves it)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."approvedAt", NEW."approvedById") IS DISTINCT FROM (OLD."approvedAt", OLD."approvedById") AND OLD."approvedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'reminders: reminder % was approved by % at %; that never changes', OLD."id", OLD."approvedById", OLD."approvedAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'PREPARED' AND NEW."status" IN ('APPROVED', 'SKIPPED', 'CANCELLED'))
      OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('SENT', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'reminders: reminder % cannot move from % to % (a person approves it before it is sent)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."level" < 1 OR cardinality(NEW."invoiceIds") IS NULL OR cardinality(NEW."invoiceIds") < 1
     OR cardinality(NEW."invoiceIds") <> (SELECT count(DISTINCT x) FROM unnest(NEW."invoiceIds") AS t(x)) THEN
    RAISE EXCEPTION 'reminders: reminder % has a level from 1 and at least one invoice, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amountDue" <= 0 OR NEW."interestAmount" < 0 OR NEW."currency" !~ '^[A-Z]{3}$' OR NEW."language" !~ '^[a-z]{2}$' THEN
    RAISE EXCEPTION 'reminders: reminder % has an amount due above 0, interest of 0 or more, an ISO currency and a two-letter language', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL)
     OR (NEW."status" IN ('APPROVED', 'SENT') AND NEW."approvedAt" IS NULL)
     OR (NEW."status" IN ('PREPARED', 'SKIPPED') AND NEW."approvedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'reminders: reminder % is % with the wrong approval: a person approves it (who and when) before it is sent', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('APPROVED', 'SENT') AND NEW."action" IN ('EMAIL', 'LETTER')
     AND (btrim(coalesce(NEW."subject", '')) = '' OR btrim(coalesce(NEW."body", '')) = '') THEN
    RAISE EXCEPTION 'reminders: an % reminder (%) is approved with its subject and text', NEW."action", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'SENT') <> (NEW."sentAt" IS NOT NULL)
     OR (NEW."callNote" IS NOT NULL AND (NEW."action" <> 'CALL' OR NEW."status" <> 'SENT'))
     OR (NEW."status" = 'SENT' AND NEW."action" = 'CALL' AND btrim(coalesce(NEW."callNote", '')) = '') THEN
    RAISE EXCEPTION 'reminders: reminder % is sent exactly when SENT (a call with what was said)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'SKIPPED') <> (NEW."skippedAt" IS NOT NULL)
     OR (NEW."skippedAt" IS NULL) <> (NEW."skippedById" IS NULL)
     OR (NEW."skippedAt" IS NULL) <> (NEW."skipReason" IS NULL) OR btrim(NEW."skipReason") = ''
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL) OR btrim(NEW."cancelReason") = '' THEN
    RAISE EXCEPTION 'reminders: reminder % is skipped (who, when, why) exactly when SKIPPED and cancelled (when, why) exactly when CANCELLED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'SENT' AND (TG_OP = 'INSERT' OR OLD."status" <> 'SENT') THEN
    SELECT s."remindersEnabled" INTO switched_on FROM "ReceivablesSettings" s
     WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId";
    IF NOT FOUND THEN
      SELECT s."remindersEnabled" INTO switched_on FROM "ReceivablesSettings" s
       WHERE s."tenantId" = NEW."tenantId" AND s."companyId" IS NULL;
    END IF;
    IF NOT coalesce(switched_on, false) THEN
      RAISE EXCEPTION 'reminders: reminders are switched off for the company of reminder % (the Owner''s switch in the receivables settings); nothing is sent to a customer', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PaymentReminder_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PaymentReminder"
  FOR EACH ROW EXECUTE FUNCTION "factory_payment_reminder_guard"();
CREATE TRIGGER "PaymentReminder_no_truncate" BEFORE TRUNCATE ON "PaymentReminder"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_w2a_refuse_truncate"();

-- =====================================================================================================================
-- Costing: the method and its lock (CostingSettings, W1), standard costs, the work-order cost ledger
-- =====================================================================================================================

-- CostingSettings (a trigger of its own; …_costing_guards' factory_costing_settings_guard is untouched)
--   every row  the lock (when and by whom) is set together; a lock needs a decided method (not UNDECIDED).
--   UPDATE     once locked, the method and the lock never change (c.c. art. 2426: the method is kept from one period to
--              the next; the screen holds it "locked once transactions exist").
CREATE FUNCTION "factory_costing_method_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."methodLockedAt" IS NOT NULL
       AND (NEW."costingMethod", NEW."methodLockedAt", NEW."methodLockedById") IS DISTINCT FROM (OLD."costingMethod", OLD."methodLockedAt", OLD."methodLockedById") THEN
      RAISE EXCEPTION 'costing: the costing method of the settings % is % and locked since % (values rely on it; c.c. art. 2426); it never changes', OLD."id", OLD."costingMethod", OLD."methodLockedAt"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."methodLockedAt" IS NULL) <> (NEW."methodLockedById" IS NULL) THEN
    RAISE EXCEPTION 'costing: the costing method of the settings % is locked with when and by whom', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."methodLockedAt" IS NOT NULL AND NEW."costingMethod" = 'UNDECIDED' THEN
    RAISE EXCEPTION 'costing: the costing method of the settings % is UNDECIDED; only a method the accountant chose is locked', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CostingSettings_method_guard" BEFORE INSERT OR UPDATE ON "CostingSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_costing_method_guard"();

-- StandardCost (FIN-024, FIN-025)
--   INSERT     a DRAFT, not frozen.
--   UPDATE     an UPDATE that changes nothing passes; the company, the item and the creation never change. A DRAFT
--              changes freely and is FROZEN (who, when); a FROZEN standard never goes back and changes only its end
--              (validTo: null → a day, once).
--   every row  every cost 0 or more and the unit cost their sum; an ISO currency; the end not before the start; the
--              minutes 0 or more; the breakdown an object; FROZEN exactly with who froze it and when.
--   overlap    two FROZEN standards of a company and item never share a day (lock: the company and item).
--   DELETE     only a DRAFT. TRUNCATE refused.
CREATE FUNCTION "factory_standard_cost_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  other uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'costing: standard cost % is FROZEN; it is never deleted (the next period gets its own)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'costing: standard cost % starts as a DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."itemId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."itemId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'costing: the company, item and creation of standard cost % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'FROZEN' THEN
      IF (to_jsonb(NEW) - (kept || ARRAY['validTo', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['validTo', 'version', 'updatedAt']))
         OR (OLD."validTo" IS NOT NULL AND NEW."validTo" IS DISTINCT FROM OLD."validTo") THEN
        RAISE EXCEPTION 'costing: standard cost % is FROZEN for its period; only its end is set, once, when the next one takes over', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."materialCost" < 0 OR NEW."labourCost" < 0 OR NEW."subcontractCost" < 0 OR NEW."overheadCost" < 0
     OR NEW."unitCost" <> NEW."materialCost" + NEW."labourCost" + NEW."subcontractCost" + NEW."overheadCost" THEN
    RAISE EXCEPTION 'costing: standard cost % has costs of 0 or more and a unit cost that is their sum (% given)', NEW."id", NEW."unitCost"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currency" !~ '^[A-Z]{3}$' OR NEW."validTo" < NEW."validFrom" OR NEW."labourMinutes" < 0
     OR (NEW."breakdown" IS NOT NULL AND jsonb_typeof(NEW."breakdown") <> 'object') THEN
    RAISE EXCEPTION 'costing: standard cost % has an ISO currency, an end not before its start, minutes of 0 or more and its breakdown as an object', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'FROZEN') <> (NEW."frozenAt" IS NOT NULL) OR (NEW."frozenAt" IS NULL) <> (NEW."frozenById" IS NULL) THEN
    RAISE EXCEPTION 'costing: standard cost % is FROZEN exactly with who froze it and when', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'FROZEN' AND (TG_OP = 'INSERT' OR OLD."status" <> 'FROZEN') THEN
    PERFORM "factory_money_lock"('standard-cost', NEW."tenantId", NEW."companyId");
    SELECT s."id" INTO other FROM "StandardCost" s
     WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId" AND s."itemId" = NEW."itemId" AND s."id" <> NEW."id"
       AND s."status" = 'FROZEN'
       AND daterange(s."validFrom", s."validTo", '[]') && daterange(NEW."validFrom", NEW."validTo", '[]')
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'costing: standard cost % from % overlaps the frozen standard % of the item; end that one first', NEW."id", NEW."validFrom", other
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "StandardCost_guard" BEFORE INSERT OR UPDATE OR DELETE ON "StandardCost"
  FOR EACH ROW EXECUTE FUNCTION "factory_standard_cost_guard"();
CREATE TRIGGER "StandardCost_no_truncate" BEFORE TRUNCATE ON "StandardCost"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_w2a_refuse_truncate"();

-- WorkOrderCostEntry: append-only (no login changes or removes a row; a wrong one is reversed).
CREATE TRIGGER "WorkOrderCostEntry_append_only" BEFORE UPDATE OR DELETE ON "WorkOrderCostEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_money_w2a_refuse_ledger_change"();
CREATE TRIGGER "WorkOrderCostEntry_no_truncate" BEFORE TRUNCATE ON "WorkOrderCostEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_w2a_refuse_ledger_change"();

-- WorkOrderCostEntry, INSERT (FIN-026, FIN-027, FIN-033, FIN-038)
--   every row  the work order's company; an ISO currency; a key; unit costs 0 or more; the source type and id both or
--              neither; the method is the company's in force (its settings, else the tenant-wide ones, else UNDECIDED),
--              and a decided method is posted only once it is locked (the first value relied on locks it, in the same
--              command).
--   reversal   the opposite amount of an entry of the same work order and kind that is no reversal and not reversed
--              yet, with a reason.
--   otherwise  MATERIAL: the item, its quantity and its stock move: an ISSUE (quantity and amount 0 or more) or a RETURN
--              (0 or less) to this work order, of the item, of the move's base quantity. SCRAP: a SCRAP move or a scan of
--              this work order. LABOUR: a scan of this work order and its minutes, above 0, with an amount of 0 or more.
--              SUBCONTRACT: a subcontract order of this work order, or a subcontractor's invoice line billing one.
--              COMPLETION: an amount of 0 or less. ADJUSTMENT: a reason.
--   period     dated (Europe/Rome) inside a HARD lock: refused.
CREATE FUNCTION "factory_work_order_cost_entry_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_company uuid;
  method text;
  locked_at timestamptz;
  original record;
  move record;
  scan_order uuid;
  billed_order uuid;
BEGIN
  SELECT w."companyId" INTO order_company FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
  IF FOUND AND order_company <> NEW."companyId" THEN
    RAISE EXCEPTION 'costing: cost entry % is of work order %''s company', NEW."id", NEW."workOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currency" !~ '^[A-Z]{3}$' OR btrim(NEW."idempotencyKey") = '' OR NEW."unitCost" < 0 OR NEW."standardUnitCost" < 0
     OR (NEW."sourceType" IS NULL) <> (NEW."sourceId" IS NULL) OR btrim(NEW."sourceType") = '' THEN
    RAISE EXCEPTION 'costing: cost entry % has an ISO currency, a key, unit costs of 0 or more, and a source type and id together', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s."costingMethod"::text, s."methodLockedAt" INTO method, locked_at FROM "CostingSettings" s
   WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId";
  IF NOT FOUND THEN
    SELECT s."costingMethod"::text, s."methodLockedAt" INTO method, locked_at FROM "CostingSettings" s
     WHERE s."tenantId" = NEW."tenantId" AND s."companyId" IS NULL;
  END IF;
  IF coalesce(method, 'UNDECIDED') <> NEW."costingMethod"::text THEN
    RAISE EXCEPTION 'costing: cost entry % is valued by %, but the company''s costing method is %', NEW."id", NEW."costingMethod", coalesce(method, 'UNDECIDED')
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."costingMethod" <> 'UNDECIDED' AND locked_at IS NULL THEN
    RAISE EXCEPTION 'costing: cost entry % relies on the costing method %; lock the method first (it is locked once used)', NEW."id", NEW."costingMethod"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."reversalOfId" IS NOT NULL THEN
    SELECT e."kind"::text AS kind, e."amount" AS amount, e."reversalOfId" AS reversal_of INTO original FROM "WorkOrderCostEntry" e
     WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."reversalOfId";
    IF FOUND THEN
      IF original.reversal_of IS NOT NULL OR original.kind <> NEW."kind"::text OR NEW."amount" <> -original.amount THEN
        RAISE EXCEPTION 'costing: reversal % takes back entry % exactly: the same kind and the opposite amount (%), never a reversal', NEW."id", NEW."reversalOfId", -original.amount
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "WorkOrderCostEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."reversalOfId" = NEW."reversalOfId") THEN
        RAISE EXCEPTION 'costing: cost entry % is reversed already', NEW."reversalOfId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF btrim(coalesce(NEW."reason", '')) = '' THEN
      RAISE EXCEPTION 'costing: reversal % says why', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'MATERIAL' THEN
    IF NEW."itemId" IS NULL OR NEW."quantity" IS NULL OR NEW."stockMoveId" IS NULL OR NEW."minutes" IS NOT NULL THEN
      RAISE EXCEPTION 'costing: material entry % names its item, quantity and stock move (no minutes)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT m."reason"::text AS reason, m."workOrderId" AS work_order, m."itemId" AS item, m."baseQuantity" AS quantity INTO move
      FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."stockMoveId";
    IF FOUND AND (move.work_order IS DISTINCT FROM NEW."workOrderId" OR move.item <> NEW."itemId" OR abs(NEW."quantity") <> move.quantity
                  OR NOT ((move.reason = 'ISSUE' AND NEW."quantity" > 0 AND NEW."amount" >= 0)
                       OR (move.reason = 'RETURN' AND NEW."quantity" < 0 AND NEW."amount" <= 0))) THEN
      RAISE EXCEPTION 'costing: material entry % posts stock move % (% of %): an ISSUE to the work order adds its base quantity and cost, a RETURN from it takes them off', NEW."id", NEW."stockMoveId", move.reason, move.quantity
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'SCRAP' THEN
    IF (NEW."stockMoveId" IS NULL) = (NEW."operationScanId" IS NULL) THEN
      RAISE EXCEPTION 'costing: scrap entry % names its SCRAP move or the scan that scrapped (one of them)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."stockMoveId" IS NOT NULL THEN
      SELECT m."reason"::text AS reason, m."workOrderId" AS work_order INTO move FROM "StockMove" m
       WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."stockMoveId";
      IF FOUND AND (move.reason <> 'SCRAP' OR move.work_order IS DISTINCT FROM NEW."workOrderId") THEN
        RAISE EXCEPTION 'costing: scrap entry % names stock move %, a % move not of this work order', NEW."id", NEW."stockMoveId", move.reason
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."kind" = 'LABOUR' THEN
    IF NEW."operationScanId" IS NULL OR NEW."minutes" IS NULL OR NEW."minutes" <= 0 OR NEW."amount" < 0 OR NEW."quantity" IS NOT NULL THEN
      RAISE EXCEPTION 'costing: labour entry % names its scan and the minutes earned (above 0), with an amount of 0 or more (never a person''s total)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'SUBCONTRACT' THEN
    IF NEW."subcontractOrderId" IS NULL AND NEW."supplierInvoiceLineId" IS NULL THEN
      RAISE EXCEPTION 'costing: subcontract entry % names its subcontract order or the subcontractor''s invoice line', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."supplierInvoiceLineId" IS NOT NULL THEN
      SELECT o."workOrderId" INTO billed_order FROM "SupplierInvoiceLine" l
        JOIN "SubcontractOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."subcontractOrderId"
       WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."supplierInvoiceLineId";
      IF NOT FOUND OR billed_order <> NEW."workOrderId" THEN
        RAISE EXCEPTION 'costing: subcontract entry % names invoice line %, which bills no subcontract order of this work order', NEW."id", NEW."supplierInvoiceLineId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."kind" = 'COMPLETION' AND NEW."amount" > 0 THEN
    RAISE EXCEPTION 'costing: completion entry % moves value out of the work order (an amount of 0 or less)', NEW."id"
      USING ERRCODE = 'check_violation';
  ELSIF NEW."kind" = 'ADJUSTMENT' AND btrim(coalesce(NEW."reason", '')) = '' THEN
    RAISE EXCEPTION 'costing: adjustment % says why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."operationScanId" IS NOT NULL THEN
    SELECT s."workOrderId" INTO scan_order FROM "OperationScan" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."operationScanId";
    IF FOUND AND scan_order <> NEW."workOrderId" THEN
      RAISE EXCEPTION 'costing: cost entry % names scan %, which is of another work order', NEW."id", NEW."operationScanId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", "factory_money_rome_day"(NEW."occurredAt"), format('cost entry %s of work order %s', NEW."id", NEW."workOrderId"));
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkOrderCostEntry_check" BEFORE INSERT ON "WorkOrderCostEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_cost_entry_check"();

-- StockMove (W1, a trigger of its own; …_supply_guards' functions are untouched): an office or system move dated
-- (Europe/Rome) inside a HARD lock is refused. The floor's moves are dated now (a tablet's offline queue is checked by the
-- API, which reads the lock in the tenant's system view): the floor role reads no lock.
CREATE FUNCTION "factory_stock_move_period_lock"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'factory_floor_runtime' THEN
    RETURN NEW;
  END IF;
  PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", "factory_money_rome_day"(NEW."occurredAt"), format('stock move %s (%s)', NEW."id", NEW."reason"));
  RETURN NEW;
END
$$;

CREATE TRIGGER "StockMove_period_lock" BEFORE INSERT ON "StockMove"
  FOR EACH ROW EXECUTE FUNCTION "factory_stock_move_period_lock"();

-- =====================================================================================================================
-- Payables: supplier invoices, their lines and the three-way match (FIN-136, FIN-137)
-- =====================================================================================================================

-- SupplierInvoice
--   INSERT     RECEIVED; nothing approved, disputed, paid or voided.
--   UPDATE     an UPDATE that changes nothing passes; the company, the source and the creation never change. What an SDI
--              invoice says (supplier, kind, type, number, dates, SDI ids, currency, amounts, VAT summary, payment
--              terms, due date, credited invoice) never changes, and its XML and PDF are named once. A typed one
--              (MANUAL, EMAIL) is corrected while RECEIVED or DISPUTED. From APPROVED on nothing changes but the move to
--              PAID (the bank's date and reference) or back to RECEIVED (the approval withdrawn before payment) and the
--              internal note. RECEIVED → APPROVED | DISPUTED | VOIDED; DISPUTED → RECEIVED | VOIDED; APPROVED → PAID |
--              RECEIVED. PAID and VOIDED are final.
--   every row  a number; an ISO currency; amounts 0 or more; the VAT summary a list, the payment terms an object; a
--              TipoDocumento TDnn when given (always for SDI); SDI exactly with its IdentificativoSdI; a credited invoice
--              only on a CREDIT_NOTE, an INVOICE of the company and supplier; approved (APPROVED, PAID) with who and
--              when, never by who registered it (separation of duties); an SDI invoice approved with its XML; disputed
--              exactly while DISPUTED (who, when, why); paid exactly when PAID; voided exactly when VOIDED, never an SDI
--              one (the supplier's credit note answers it).
--   approval   matched (MATCHED, DIFFERENCES or NO_PO: not PENDING, nor WAITING_GOODS), and every match outside the
--              tolerance accepted in words.
--   period     registered (INSERT), or its journal facts changed, with a received day inside a HARD lock; paid with a
--              bank date inside one: refused.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_supplier_invoice_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  said CONSTANT text[] := ARRAY['partyId', 'kind', 'docType', 'number', 'issueDate', 'receivedOn', 'sdiIdentifier', 'sdiFileName', 'currency',
    'netTotal', 'vatTotal', 'grossTotal', 'withholdingAmount', 'stampDutyAmount', 'vatSummary', 'paymentTerms', 'dueDate', 'creditOfId'];
  journal CONSTANT text[] := ARRAY['partyId', 'kind', 'docType', 'number', 'issueDate', 'receivedOn', 'currency', 'netTotal', 'vatTotal', 'grossTotal',
    'withholdingAmount', 'stampDutyAmount', 'vatSummary'];
  approved_moves CONSTANT text[] := ARRAY['status', 'approvedAt', 'approvedById', 'approvalNote', 'paidOn', 'paymentRef', 'internalNote', 'version', 'updatedAt'];
  credited_kind text;
  bad uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payables: supplier invoice % (number %) is kept, never deleted (a typed one is voided; an SDI one is answered by a credit note)', OLD."id", OLD."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RECEIVED' THEN
      RAISE EXCEPTION 'payables: supplier invoice % starts RECEIVED, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."source", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."source", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'payables: the company, source and creation of supplier invoice % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('PAID', 'VOIDED')
       AND (to_jsonb(NEW) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'payables: supplier invoice % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'APPROVED' AND (to_jsonb(NEW) - (kept || approved_moves)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || approved_moves)) THEN
      RAISE EXCEPTION 'payables: supplier invoice % is APPROVED; it is paid, or its approval is withdrawn before anything else changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."source" = 'SDI' THEN
      IF (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(said) AS k) IS DISTINCT FROM (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(said) AS k)
         OR (OLD."xmlFileId" IS NOT NULL AND NEW."xmlFileId" IS DISTINCT FROM OLD."xmlFileId")
         OR (OLD."pdfFileId" IS NOT NULL AND NEW."pdfFileId" IS DISTINCT FROM OLD."pdfFileId") THEN
        RAISE EXCEPTION 'payables: supplier invoice % came through SDI (%); what it says never changes and its XML and PDF are named once (the supplier''s credit note corrects it)', OLD."id", OLD."sdiIdentifier"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'RECEIVED' AND NEW."status" IN ('APPROVED', 'DISPUTED', 'VOIDED'))
      OR (OLD."status" = 'DISPUTED' AND NEW."status" IN ('RECEIVED', 'VOIDED'))
      OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('PAID', 'RECEIVED'))) THEN
      RAISE EXCEPTION 'payables: supplier invoice % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."number") = '' OR NEW."currency" !~ '^[A-Z]{3}$'
     OR NEW."netTotal" < 0 OR NEW."vatTotal" < 0 OR NEW."grossTotal" < 0 OR NEW."withholdingAmount" < 0 OR NEW."stampDutyAmount" < 0
     OR jsonb_typeof(NEW."vatSummary") <> 'array' OR (NEW."paymentTerms" IS NOT NULL AND jsonb_typeof(NEW."paymentTerms") <> 'object')
     OR NEW."docType" !~ '^TD[0-9]{2}$' THEN
    RAISE EXCEPTION 'payables: supplier invoice % has a number, an ISO currency, amounts of 0 or more, its VAT summary as a list, its payment terms as an object and a TipoDocumento TDnn when given', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."source" = 'SDI') <> (NEW."sdiIdentifier" IS NOT NULL) OR btrim(NEW."sdiIdentifier") = '' OR (NEW."source" = 'SDI' AND NEW."docType" IS NULL) THEN
    RAISE EXCEPTION 'payables: supplier invoice % has its IdentificativoSdI and TipoDocumento exactly when it came through SDI', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."creditOfId" IS NOT NULL THEN
    IF NEW."kind" <> 'CREDIT_NOTE' OR NEW."creditOfId" = NEW."id" THEN
      RAISE EXCEPTION 'payables: only a supplier''s credit note names the invoice it credits (%)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' OR NEW."creditOfId" IS DISTINCT FROM OLD."creditOfId" THEN
      SELECT c."kind"::text INTO credited_kind FROM "SupplierInvoice" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."creditOfId";
      IF FOUND AND credited_kind <> 'INVOICE' THEN
        RAISE EXCEPTION 'payables: credit note % credits %, which is a credit note itself', NEW."id", NEW."creditOfId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL)
     OR (NEW."status" IN ('APPROVED', 'PAID')) <> (NEW."approvedAt" IS NOT NULL)
     OR (NEW."approvalNote" IS NOT NULL AND NEW."approvedAt" IS NULL) THEN
    RAISE EXCEPTION 'payables: supplier invoice % is approved (who, when) exactly from APPROVED on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."approvedById" IS NOT NULL AND NEW."approvedById" = NEW."createdById" THEN
    RAISE EXCEPTION 'payables: supplier invoice % is approved by another person than the one who registered it (separation of duties)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."source" = 'SDI' AND NEW."status" IN ('APPROVED', 'PAID') AND NEW."xmlFileId" IS NULL THEN
    RAISE EXCEPTION 'payables: supplier invoice % came through SDI; it is approved with its XML (the legal document) named', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DISPUTED') <> (NEW."disputedAt" IS NOT NULL)
     OR (NEW."disputedAt" IS NULL) <> (NEW."disputedById" IS NULL)
     OR (NEW."disputedAt" IS NULL) <> (NEW."disputeReason" IS NULL) OR btrim(NEW."disputeReason") = ''
     OR (NEW."status" = 'PAID') <> (NEW."paidOn" IS NOT NULL)
     OR (NEW."paidOn" IS NULL) <> (NEW."paymentRef" IS NULL) OR btrim(NEW."paymentRef") = ''
     OR (NEW."status" = 'VOIDED') <> (NEW."voidedAt" IS NOT NULL)
     OR (NEW."voidedAt" IS NULL) <> (NEW."voidReason" IS NULL) OR btrim(NEW."voidReason") = '' THEN
    RAISE EXCEPTION 'payables: supplier invoice % is disputed (who, when, why) exactly while DISPUTED, paid (the bank''s date and reference) exactly when PAID, voided (when, why) exactly when VOIDED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'VOIDED' AND NEW."source" = 'SDI' THEN
    RAISE EXCEPTION 'payables: supplier invoice % came through SDI (%): it is a fiscal document, never voided; the supplier''s credit note answers it', NEW."id", NEW."sdiIdentifier"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'APPROVED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'APPROVED') THEN
    IF NEW."matchStatus" NOT IN ('MATCHED', 'DIFFERENCES', 'NO_PO') THEN
      RAISE EXCEPTION 'payables: supplier invoice % is %; it is approved once it is matched (not while PENDING or WAITING_GOODS)', NEW."id", NEW."matchStatus"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT m."id" INTO bad FROM "SupplierInvoiceMatch" m
     WHERE m."tenantId" = NEW."tenantId" AND m."invoiceId" = NEW."id" AND NOT m."withinTolerance" AND m."acceptedAt" IS NULL
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'payables: supplier invoice % has a difference outside the tolerance (match %) that nobody accepted; accept it in words, or dispute the invoice', NEW."id", bad
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", NEW."receivedOn", format('supplier invoice %s (number %s)', NEW."id", NEW."number"));
  ELSIF (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(journal) AS k) IS DISTINCT FROM (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(journal) AS k) THEN
    PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", OLD."receivedOn", format('supplier invoice %s (number %s)', OLD."id", OLD."number"));
    PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", NEW."receivedOn", format('supplier invoice %s (number %s)', NEW."id", NEW."number"));
  END IF;
  IF NEW."paidOn" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."paidOn" IS NULL) THEN
    PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", NEW."paidOn", format('the payment of supplier invoice %s (number %s)', NEW."id", NEW."number"));
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SupplierInvoice_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SupplierInvoice"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_invoice_guard"();
CREATE TRIGGER "SupplierInvoice_no_truncate" BEFORE TRUNCATE ON "SupplierInvoice"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_w2a_refuse_truncate"();

-- SupplierInvoiceLine
--   INSERT, UPDATE, DELETE  only while its invoice is RECEIVED or DISPUTED (the invoice's row FOR SHARE, so an approval
--                           waits for the transaction that edits its lines, and an edit after it sees the new status); a
--                           line never moves to another invoice. The figures of an SDI invoice's line (place,
--                           description, code, quantity, unit, price, discount, amount, VAT) never change and the line is
--                           never removed; only its kind and mapping change. A typed line changes and is removed freely.
--   every row               a place from 1, a description; a quantity above 0 and a discount above 0 and below 100 when
--                           given; a VAT rate of 0 or more, a Natura (N1 … N7) when given; mapped to at most one order:
--                           a purchase order line (a GOODS or CHARGE line) of the supplier and the invoice's company, or a
--                           subcontract order (a SUBCONTRACT line) of the invoice's company; the site exactly when mapped.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_supplier_invoice_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  figures CONSTANT text[] := ARRAY['seq', 'description', 'itemCode', 'quantity', 'uom', 'unitPrice', 'discountPct', 'netAmount', 'vatRatePct', 'vatNature'];
  state text;
  invoice_source text;
  invoice_company uuid;
  part_of uuid;
  line_party uuid;
  order_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."invoiceId", NEW."partyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."invoiceId", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'payables: supplier invoice line % never moves to another invoice', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  part_of := CASE WHEN TG_OP = 'DELETE' THEN OLD."invoiceId" ELSE NEW."invoiceId" END;
  SELECT i."status"::text, i."source"::text, i."companyId" INTO state, invoice_source, invoice_company
    FROM "SupplierInvoice" i WHERE i."tenantId" = CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END AND i."id" = part_of FOR SHARE;
  IF state IS NOT NULL AND state NOT IN ('RECEIVED', 'DISPUTED') THEN
    RAISE EXCEPTION 'payables: supplier invoice % is %; its lines are written only while it is RECEIVED or DISPUTED', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF invoice_source = 'SDI' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'payables: line % of supplier invoice % came through SDI; it is never removed (only remapped)', OLD."id", part_of
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(figures) AS k) IS DISTINCT FROM (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(figures) AS k) THEN
      RAISE EXCEPTION 'payables: line % of supplier invoice % came through SDI; what it says never changes (only its kind and mapping do)', OLD."id", part_of
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."seq" < 1 OR btrim(NEW."description") = '' OR NEW."quantity" <= 0
     OR (NEW."discountPct" IS NOT NULL AND (NEW."discountPct" <= 0 OR NEW."discountPct" >= 100))
     OR NEW."vatRatePct" < 0 OR NEW."vatNature" !~ '^N[1-7](\.[0-9])?$' THEN
    RAISE EXCEPTION 'payables: supplier invoice line % has a place from 1, a description, a quantity above 0, a discount above 0 and below 100, a VAT rate of 0 or more and a Natura N1 … N7 when given', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."purchaseOrderLineId" IS NOT NULL AND NEW."subcontractOrderId" IS NOT NULL)
     OR (NEW."siteId" IS NOT NULL) <> (NEW."purchaseOrderLineId" IS NOT NULL OR NEW."subcontractOrderId" IS NOT NULL)
     OR (NEW."purchaseOrderLineId" IS NOT NULL AND NEW."kind" NOT IN ('GOODS', 'CHARGE'))
     OR (NEW."subcontractOrderId" IS NOT NULL AND NEW."kind" <> 'SUBCONTRACT') THEN
    RAISE EXCEPTION 'payables: supplier invoice line % is mapped to at most one order (a GOODS or CHARGE line to a purchase order line, a SUBCONTRACT line to a subcontract order), with that order''s site', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."purchaseOrderLineId" IS NOT NULL THEN
    SELECT pl."partyId", po."companyId" INTO line_party, order_company FROM "PurchaseOrderLine" pl
      JOIN "PurchaseOrder" po ON po."tenantId" = pl."tenantId" AND po."id" = pl."purchaseOrderId"
     WHERE pl."tenantId" = NEW."tenantId" AND pl."id" = NEW."purchaseOrderLineId";
    IF FOUND AND (line_party <> NEW."partyId" OR order_company IS DISTINCT FROM coalesce(invoice_company, order_company)) THEN
      RAISE EXCEPTION 'payables: supplier invoice line % is mapped to purchase order line %, which is not the supplier''s order of the invoice''s company', NEW."id", NEW."purchaseOrderLineId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."subcontractOrderId" IS NOT NULL THEN
    SELECT o."companyId" INTO order_company FROM "SubcontractOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."subcontractOrderId";
    IF FOUND AND order_company IS DISTINCT FROM coalesce(invoice_company, order_company) THEN
      RAISE EXCEPTION 'payables: supplier invoice line % is mapped to subcontract order % of another company', NEW."id", NEW."subcontractOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SupplierInvoiceLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SupplierInvoiceLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_invoice_line_guard"();
CREATE TRIGGER "SupplierInvoiceLine_no_truncate" BEFORE TRUNCATE ON "SupplierInvoiceLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_w2a_refuse_truncate"();

-- SupplierInvoiceMatch
--   INSERT, UPDATE, DELETE  only while its invoice is RECEIVED or DISPUTED (the invoice's row FOR SHARE: an approval and a
--                           match never cross). A match never moves to another invoice line.
--   every row               exactly one order: the line's purchase order line (and, when something was received, one of
--                           its receipt lines, of a POSTED receipt) or the line's subcontract order; the invoice line is
--                           the invoice's; quantities and prices 0 or more; tolerances 0 to 100 percent; accepted (who,
--                           when, why) together, and only outside the tolerance.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_supplier_invoice_match_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
  line record;
  receipt record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."invoiceId", NEW."invoiceLineId", NEW."partyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."invoiceId", OLD."invoiceLineId", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'payables: match % never moves to another invoice line (the match is redone with new rows)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  part_of := CASE WHEN TG_OP = 'DELETE' THEN OLD."invoiceId" ELSE NEW."invoiceId" END;
  SELECT i."status"::text INTO state FROM "SupplierInvoice" i
   WHERE i."tenantId" = CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END AND i."id" = part_of FOR SHARE;
  IF state IS NOT NULL AND state NOT IN ('RECEIVED', 'DISPUTED') THEN
    RAISE EXCEPTION 'payables: supplier invoice % is %; its match is written only while it is RECEIVED or DISPUTED', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF (NEW."purchaseOrderLineId" IS NULL) = (NEW."subcontractOrderId" IS NULL)
     OR (NEW."goodsReceiptLineId" IS NOT NULL AND NEW."purchaseOrderLineId" IS NULL) THEN
    RAISE EXCEPTION 'payables: match % is against exactly one order: a purchase order line (with a receipt line when goods arrived) or a subcontract order', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."invoicedQuantity" < 0 OR NEW."receivedQuantity" < 0 OR NEW."orderedUnitPrice" < 0 OR NEW."invoicedUnitPrice" < 0
     OR NEW."quantityTolerancePct" < 0 OR NEW."quantityTolerancePct" > 100 OR NEW."priceTolerancePct" < 0 OR NEW."priceTolerancePct" > 100 THEN
    RAISE EXCEPTION 'payables: match % has quantities and prices of 0 or more and tolerances of 0 to 100 percent', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."acceptedAt" IS NULL) <> (NEW."acceptedById" IS NULL) OR (NEW."acceptedAt" IS NULL) <> (NEW."acceptNote" IS NULL)
     OR btrim(NEW."acceptNote") = '' OR (NEW."acceptedAt" IS NOT NULL AND NEW."withinTolerance") THEN
    RAISE EXCEPTION 'payables: a difference outside the tolerance is accepted with who, when and why (match %; a match within it needs none)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."invoiceId" AS invoice, l."purchaseOrderLineId" AS po_line, l."subcontractOrderId" AS subcontract INTO line FROM "SupplierInvoiceLine" l
   WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."invoiceLineId";
  IF FOUND AND (line.invoice <> NEW."invoiceId" OR line.po_line IS DISTINCT FROM NEW."purchaseOrderLineId" OR line.subcontract IS DISTINCT FROM NEW."subcontractOrderId") THEN
    RAISE EXCEPTION 'payables: match % is of line % of its invoice, against the order the line is mapped to', NEW."id", NEW."invoiceLineId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."goodsReceiptLineId" IS NOT NULL THEN
    SELECT rl."purchaseOrderLineId" AS po_line, r."status"::text AS status INTO receipt FROM "GoodsReceiptLine" rl
      JOIN "GoodsReceipt" r ON r."tenantId" = rl."tenantId" AND r."id" = rl."receiptId"
     WHERE rl."tenantId" = NEW."tenantId" AND rl."id" = NEW."goodsReceiptLineId";
    IF FOUND AND (receipt.po_line IS DISTINCT FROM NEW."purchaseOrderLineId" OR receipt.status <> 'POSTED') THEN
      RAISE EXCEPTION 'payables: match % names receipt line %, which is not a POSTED receipt of the purchase order line', NEW."id", NEW."goodsReceiptLineId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SupplierInvoiceMatch_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SupplierInvoiceMatch"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_invoice_match_guard"();
CREATE TRIGGER "SupplierInvoiceMatch_no_truncate" BEFORE TRUNCATE ON "SupplierInvoiceMatch"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_w2a_refuse_truncate"();

-- =====================================================================================================================
-- Accounting exports (FIN-046, LOG-098, LOG-100)
-- =====================================================================================================================

-- One first export per company and period (a re-export names the one it amends).
CREATE UNIQUE INDEX "AccountingExport_one_first_export_per_period" ON "AccountingExport" ("tenantId", "companyId", "periodStart", "periodEnd")
  WHERE "status" = 'EXPORTED' AND "supersedesId" IS NULL;

-- AccountingExport
--   INSERT     a DRAFT: no number, no export, no cancellation.
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change. A DRAFT changes freely
--              and moves DRAFT → EXPORTED (its number from the company's ACCOUNTING_EXPORT series, who, when) |
--              CANCELLED (when, why). EXPORTED and CANCELLED are final: an exported batch never changes (a re-export
--              amends it).
--   every row  whole months; at least one package, each once; a layout; the checks and the documents as lists; the
--              number, series and export exactly from EXPORTED on, the cancellation exactly when CANCELLED; a re-export
--              names an EXPORTED batch of the same company and period (not itself).
--   export     at least one file; every check an object { code, passed } that passed or is explained in words.
--   DELETE     refused (a draft is cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_accounting_export_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  series_kind text;
  series_fiscal boolean;
  amended record;
  bad jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting: export % is cancelled (a draft) or kept (exported), never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'accounting: export % starts as a DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'accounting: the company and creation of export % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'accounting: export % (number %) is %; it never changes (a re-export amends an exported batch)', OLD."id", OLD."number", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (OLD."status" = 'DRAFT' AND NEW."status" IN ('EXPORTED', 'CANCELLED')) THEN
      RAISE EXCEPTION 'accounting: export % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NOT "factory_money_whole_months"(NEW."periodStart", NEW."periodEnd") THEN
    RAISE EXCEPTION 'accounting: export % covers whole months: the first day of a month to the last day of a month, not % to %', NEW."id", NEW."periodStart", NEW."periodEnd"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."packages") IS NULL OR cardinality(NEW."packages") < 1
     OR cardinality(NEW."packages") <> (SELECT count(DISTINCT p) FROM unnest(NEW."packages") AS t(p))
     OR btrim(NEW."layout") = '' OR jsonb_typeof(NEW."checks") <> 'array' OR jsonb_typeof(NEW."manifest") <> 'array' THEN
    RAISE EXCEPTION 'accounting: export % has at least one package, each once, a layout, and its checks and documents as lists', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'EXPORTED') <> (NEW."number" IS NOT NULL)
     OR (NEW."number" IS NULL) <> (NEW."numberSeriesId" IS NULL)
     OR (NEW."number" IS NULL) <> (NEW."exportedAt" IS NULL)
     OR (NEW."number" IS NULL) <> (NEW."exportedById" IS NULL)
     OR btrim(NEW."number") = ''
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL) OR btrim(NEW."cancelReason") = '' THEN
    RAISE EXCEPTION 'accounting: export % is % with the wrong columns (its number, series and export exactly from EXPORTED on; its cancellation, with why, exactly when CANCELLED)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supersedesId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."supersedesId" IS DISTINCT FROM OLD."supersedesId" OR NEW."status" <> OLD."status") THEN
    SELECT e."status"::text AS status, e."periodStart" AS first_day, e."periodEnd" AS last_day INTO amended FROM "AccountingExport" e
     WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."supersedesId";
    IF NEW."supersedesId" = NEW."id"
       OR (FOUND AND (amended.status <> 'EXPORTED' OR amended.first_day <> NEW."periodStart" OR amended.last_day <> NEW."periodEnd")) THEN
      RAISE EXCEPTION 'accounting: re-export % amends export %: an EXPORTED batch of the same company and period', NEW."id", NEW."supersedesId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" = 'EXPORTED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'EXPORTED') THEN
    SELECT s."kind"::text, s."fiscal" INTO series_kind, series_fiscal FROM "NumberSeries" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."numberSeriesId";
    IF FOUND AND series_kind <> 'ACCOUNTING_EXPORT' THEN
      RAISE EXCEPTION 'accounting: export % is numbered from the company''s ACCOUNTING_EXPORT series, not from a % series', NEW."id", series_kind
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "AccountingExportFile" f WHERE f."tenantId" = NEW."tenantId" AND f."exportId" = NEW."id") THEN
      RAISE EXCEPTION 'accounting: export % has no file; the export job stores its files before it is EXPORTED', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT c INTO bad FROM jsonb_array_elements(NEW."checks") AS t(c)
     WHERE jsonb_typeof(c) <> 'object' OR jsonb_typeof(c -> 'code') IS DISTINCT FROM 'string'
        OR jsonb_typeof(c -> 'passed') IS DISTINCT FROM 'boolean'
        OR ((c ->> 'passed') = 'false' AND btrim(coalesce(c ->> 'explanation', '')) = '')
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'accounting: export % has a check that failed with no explanation (or is no { code, passed }): %', NEW."id", bad
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AccountingExport_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AccountingExport"
  FOR EACH ROW EXECUTE FUNCTION "factory_accounting_export_guard"();
CREATE TRIGGER "AccountingExport_no_truncate" BEFORE TRUNCATE ON "AccountingExport"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_w2a_refuse_truncate"();

-- AccountingExportFile
--   INSERT, DELETE  only while its export is a DRAFT (the export's row FOR SHARE: the move to EXPORTED waits for the job
--                   that writes its files, and sees them).
--   UPDATE          an UPDATE that changes nothing passes; nothing else (a file of an export never changes).
--   INSERT          a place from 1; a package of the export; a format CSV, XLSX, XML, TXT or PDF; a row count of 0 or more;
--                   a StoredFile of the export (recordType "AccountingExport", recordId the export).
--   TRUNCATE        refused.
CREATE FUNCTION "factory_accounting_export_file_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  packages "AccountingPackage"[];
  file_type text;
  file_record uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'accounting: file % of export % never changes', OLD."id", OLD."exportId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT e."status"::text, e."packages" INTO state, packages FROM "AccountingExport" e
   WHERE e."tenantId" = CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END
     AND e."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."exportId" ELSE NEW."exportId" END
   FOR SHARE;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'accounting: export % is %; its files are added (or removed) only while it is a DRAFT', CASE WHEN TG_OP = 'DELETE' THEN OLD."exportId" ELSE NEW."exportId" END, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW."seq" < 1 OR NEW."rowCount" < 0 OR NEW."format" NOT IN ('CSV', 'XLSX', 'XML', 'TXT', 'PDF')
     OR (packages IS NOT NULL AND NOT (NEW."package" = ANY (packages))) THEN
    RAISE EXCEPTION 'accounting: file % of export % has a place from 1, a package of the export, a format CSV, XLSX, XML, TXT or PDF and a row count of 0 or more', NEW."id", NEW."exportId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT f."recordType", f."recordId" INTO file_type, file_record FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF FOUND AND (file_type <> 'AccountingExport' OR file_record <> NEW."exportId") THEN
    RAISE EXCEPTION 'accounting: file % of export % is a stored file of the export (recordType AccountingExport), not of % %', NEW."id", NEW."exportId", file_type, file_record
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AccountingExportFile_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AccountingExportFile"
  FOR EACH ROW EXECUTE FUNCTION "factory_accounting_export_file_guard"();
CREATE TRIGGER "AccountingExportFile_no_truncate" BEFORE TRUNCATE ON "AccountingExportFile"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_w2a_refuse_truncate"();
