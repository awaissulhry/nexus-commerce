-- Written by hand (Prisma does not model triggers or deferred constraint triggers), after the generated
-- 202610284100_money and before the policy migration. When the migrations are renumbered, keep this file as it is under
-- its new timestamp.

-- Money (plan A1 §2.1 "Money", "Append-only", "Issued documents", §2.5 "Invoice"; PLAN §2.8 "Corrections only by credit
-- note" (DPR 633/1972 art. 26), "Rejected file resent within 5 working days" (Provv. AdE 89757/2018), "Sequential,
-- gap-free numbering" (art. 21 c.2); Q12; features FIN-054, FIN-061, FIN-069, FIN-084, FIN-086, FIN-087, FIN-121).
-- A file SDI rejected (NS) counts as never issued (circolare AdE 13/E/2018): while REJECTED the invoice is corrected
-- (its lines and totals too: the error behind an NS may be in them, e.g. 00423) and every check of the issue runs again
-- when it leaves REJECTED; its number, series, year, date, type, company and buyer never change.
-- apps/factory-api's modules check all of this first; these rules hold for every login, the owner included. The tenant
-- and party of a row are held by the policies (USING and WITH CHECK) and by the references, not here: the triggers
-- leave "tenantId" to them. Every refusal is a check_violation (SQLSTATE 23514): a restrict_violation reaches a Prisma
-- model call as P2003 without its message. A rule that reads another row skips a row this session cannot see (another
-- tenant's): the policies refuse that write anyway. A trigger reads only tables the role that fires it may read, and
-- locks a row FOR SHARE only where that role may update it; elsewhere it takes a transaction advisory lock.
--
-- Locks (pg_advisory_xact_lock, held to the end of the transaction), always in this order, so two writers serialise and
-- never deadlock: the payment ('factory.money.payment'), then the target (the deposit request 'factory.money.deposit',
-- or the invoice 'factory.money.invoice'). An allocation takes its payment's lock, then its target's; issuing a credit
-- note takes the credited invoice's; issuing a TD02 its deposit request's; issuing an invoice that deducts deposit
-- invoices takes theirs in id order. The sums read after a lock see every committed write before it (READ COMMITTED:
-- each statement of a trigger reads a new snapshot).
--
-- "Everything but these columns" is compared as jsonb (to_jsonb(row) minus the named keys), so a column added later is
-- frozen too unless a later migration names it.

CREATE FUNCTION "factory_money_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'money: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- The append-only ledgers of this module (plan A1 §2.1; scripts/factory/check-append-only.mjs): SdiNotification and
-- PaymentAllocation. No login may change or remove a row, the owner and superusers included; the runtime roles have no
-- UPDATE, DELETE or TRUNCATE grant either (the policy migration). A wrong allocation is taken back by a reversal row.
CREATE FUNCTION "factory_refuse_money_ledger_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; an SDI notification and a payment allocation are kept as they were written (a wrong allocation is reversed by a new row)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "SdiNotification_append_only" BEFORE UPDATE OR DELETE ON "SdiNotification"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_money_ledger_change"();
CREATE TRIGGER "SdiNotification_no_truncate" BEFORE TRUNCATE ON "SdiNotification"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_money_ledger_change"();
CREATE TRIGGER "PaymentAllocation_append_only" BEFORE UPDATE OR DELETE ON "PaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_money_ledger_change"();
CREATE TRIGGER "PaymentAllocation_no_truncate" BEFORE TRUNCATE ON "PaymentAllocation"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_money_ledger_change"();

CREATE FUNCTION "factory_money_lock"(what text, tenant uuid, subject uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.money.' || what, tenant, subject), 0));
END
$$;

-- What is still payable on an issued TD01/TD24: its gross total less the gross of the credit notes issued against it.
CREATE FUNCTION "factory_invoice_credited"(tenant uuid, invoice uuid, other_than uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(c."grossTotal"), 0)::bigint FROM "Invoice" c
   WHERE c."tenantId" = tenant AND c."creditOfId" = invoice AND c."docType" = 'TD04' AND c."status" <> 'DRAFT'
     AND c."id" IS DISTINCT FROM other_than
$$;

-- =====================================================================================================================
-- Invoice (FIN-054, FIN-057, FIN-061, FIN-069, FIN-087; A1 §2.5 "Invoice")
-- =====================================================================================================================

-- The issue (DRAFT → ISSUED), and again every send of a corrected file (REJECTED → SENT | ERROR): everything that must
-- hold once the invoice has its number.
--   number      Numero: at most 20 characters, at least one digit (SDI 00425); the year is the issue date's; the series
--               is a fiscal one of the company (the reference) for the document type: INVOICE, or DEPOSIT_INVOICE for a
--               TD02, CREDIT_NOTE for a TD04 (the NumberAllocation row is checked at commit, below).
--   document    the seller and the buyer as objects, a VAT summary of at least one entry, at least one line.
--   totals      the VAT summary's taxables add up to netTotal and its VATs to vatTotal; the lines' net amounts plus the
--               summary's roundings add up to netTotal (gross = net + VAT holds on every row).
--   lines       TD24: every GOODS line names its DDT; a DDT named is the company's and not cancelled; an order line
--               named is the company's, and the invoice's order's when it names one.
--   TD02        its deposit request is OPEN or PAID, in the invoice's currency; the deposit invoices of the request
--               (less their credit notes) never pass its amount (lock: the request).
--   TD04        it says why (causale); the credited invoice is issued, not a credit note, not dated after it; the credit
--               notes of an invoice never pass its gross total, and on a TD02 their net plus the net deducted from it
--               never pass its net (lock: the credited invoice).
--   deductions  each deposit invoice deducted is an issued TD02 of the company; what all issued invoices deduct from it
--               never passes its net less its credit notes' net (locks: the TD02s, in id order).
--   TD02, TD04  a gross total above 0.
CREATE FUNCTION "factory_invoice_check_issue"(inv "Invoice") RETURNS void LANGUAGE plpgsql AS $$
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
END
$$;

-- Invoice
--   INSERT     an invoice starts as a DRAFT.
--   every row  a DRAFT has no number, series, year, date, issue time or party key; from ISSUED on it has them all and
--              its party key is its buyer; the XML is named from SENT on (every status after ISSUED); the currency is an
--              ISO code; the seller (when set) and the buyer are objects, the VAT summary a list; the totals are 0 or
--              more and gross = net + VAT; stamp duty above 0 when set; a TD02 (and only a TD02) names its deposit
--              request, whose fiscal document is TD02; a TD04 (and only a TD04) names the invoice it credits, which is
--              issued and not a credit note.
--   UPDATE     an UPDATE that changes nothing passes; the company, buyer, type and creation never change. From ISSUED on
--              the invoice is frozen (DPR 633/1972 art. 26; FIN-061): only its status, version, internal note and the
--              XML and PDF named once (null → a file) change. While REJECTED (a file SDI rejected counts as never
--              issued: circolare AdE 13/E/2018) the invoice is corrected: also its seller and buyer data, payment terms,
--              text, references, files, totals, VAT summary and stamp duty (its lines too: the InvoiceLine guard); its
--              number, series, year, date, issue, party key and links never change: the corrected file is sent again
--              under the same number and date (Provv. AdE 89757/2018), and leaving REJECTED runs every check of the
--              issue again. A corrected gross total never drops below what is paid on the invoice plus what its credit
--              notes credit, and a corrected TD02's net never below what is deducted from it plus credited (lock: the
--              invoice, as for an allocation or a credit note). The status moves DRAFT → ISSUED (the issue checks above);
--              ISSUED → SENT | ERROR; SENT → DELIVERED | NOT_DELIVERABLE | REJECTED | ERROR; ERROR → SENT | DELIVERED |
--              NOT_DELIVERABLE | REJECTED; REJECTED → SENT | ERROR; DELIVERED and NOT_DELIVERABLE are final.
--   DELETE     only a DRAFT (it has no number: no gap). TRUNCATE refused.
CREATE FUNCTION "factory_invoice_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  moving CONSTANT text[] := ARRAY['status', 'version', 'updatedAt', 'internalNote', 'xmlFileId', 'pdfFileId'];
  correctable CONSTANT text[] := ARRAY['seller', 'billTo', 'paymentTerms', 'causale', 'documentRefs', 'netTotal', 'vatTotal',
                                       'grossTotal', 'vatSummary', 'stampDutyAmount'];
  state text;
  doc_type text;
  fiscal_document text;
  allocated bigint;
  credited bigint;
  credited_net bigint;
  deducted_net bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'invoicing: invoice % (number %) is %; an issued invoice is never deleted (a credit note corrects it; DPR 633/1972 art. 26)', OLD."id", OLD."number", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'invoicing: invoice % starts as a DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."buyerPartyId", NEW."docType", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."buyerPartyId", OLD."docType", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'invoicing: the company, buyer, type and creation of invoice % never change (a different invoice is a new one)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' THEN
      IF (to_jsonb(NEW) - (kept || moving || correctable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || moving || correctable)) THEN
        RAISE EXCEPTION 'invoicing: invoice % (number % of %) is issued; its number, series, year, date, party and links never change (DPR 633/1972 art. 26: a credit note corrects it; a rejected file is sent again under the same number and date)', OLD."id", OLD."number", OLD."issueDate"
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."status" <> 'REJECTED' THEN
        IF (to_jsonb(NEW) - (kept || moving)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || moving)) THEN
          RAISE EXCEPTION 'invoicing: invoice % is %; its data, totals and text are corrected only while it is REJECTED (a credit note corrects an invoice SDI took; Provv. AdE 89757/2018)', OLD."id", OLD."status"
            USING ERRCODE = 'check_violation';
        END IF;
        IF (OLD."xmlFileId" IS NOT NULL AND NEW."xmlFileId" IS DISTINCT FROM OLD."xmlFileId")
           OR (OLD."pdfFileId" IS NOT NULL AND NEW."pdfFileId" IS DISTINCT FROM OLD."pdfFileId") THEN
          RAISE EXCEPTION 'invoicing: invoice % is %; its XML and PDF are named once (a corrected file only while it is REJECTED)', OLD."id", OLD."status"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'DRAFT' AND NEW."status" = 'ISSUED')
      OR (OLD."status" = 'ISSUED' AND NEW."status" IN ('SENT', 'ERROR'))
      OR (OLD."status" = 'SENT' AND NEW."status" IN ('DELIVERED', 'NOT_DELIVERABLE', 'REJECTED', 'ERROR'))
      OR (OLD."status" = 'ERROR' AND NEW."status" IN ('SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED'))
      OR (OLD."status" = 'REJECTED' AND NEW."status" IN ('SENT', 'ERROR'))) THEN
      RAISE EXCEPTION 'invoicing: invoice % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" = 'DRAFT' THEN
    IF NEW."partyId" IS NOT NULL OR NEW."numberSeriesId" IS NOT NULL OR NEW."number" IS NOT NULL OR NEW."year" IS NOT NULL
       OR NEW."issueDate" IS NOT NULL OR NEW."issuedAt" IS NOT NULL OR NEW."issuedById" IS NOT NULL THEN
      RAISE EXCEPTION 'invoicing: invoice % is a DRAFT; a draft has no number, series, year, date or issue, and no party key (the portal never sees it)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."numberSeriesId" IS NULL OR NEW."number" IS NULL OR NEW."year" IS NULL OR NEW."issueDate" IS NULL OR NEW."issuedAt" IS NULL THEN
      RAISE EXCEPTION 'invoicing: invoice % is %; an issued invoice has its series, number, year, date and issue time', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."partyId" IS DISTINCT FROM NEW."buyerPartyId" THEN
      RAISE EXCEPTION 'invoicing: invoice % is issued; its party key is its buyer %', NEW."id", NEW."buyerPartyId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'ISSUED' AND NEW."xmlFileId" IS NULL THEN
      RAISE EXCEPTION 'invoicing: invoice % is %; it names its XML (the legal invoice) from the first send on', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'invoicing: the currency of invoice % is an ISO 4217 code, not "%"', NEW."id", NEW."currency"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."billTo") <> 'object' OR (NEW."seller" IS NOT NULL AND jsonb_typeof(NEW."seller") <> 'object')
     OR jsonb_typeof(NEW."vatSummary") <> 'array'
     OR (NEW."paymentTerms" IS NOT NULL AND jsonb_typeof(NEW."paymentTerms") <> 'object')
     OR (NEW."documentRefs" IS NOT NULL AND jsonb_typeof(NEW."documentRefs") <> 'array') THEN
    RAISE EXCEPTION 'invoicing: invoice % holds its buyer (and seller, payment terms) as objects, its VAT summary and references as lists', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."netTotal" < 0 OR NEW."vatTotal" < 0 OR NEW."grossTotal" <> NEW."netTotal" + NEW."vatTotal"
     OR (NEW."stampDutyAmount" IS NOT NULL AND NEW."stampDutyAmount" <= 0) THEN
    RAISE EXCEPTION 'invoicing: invoice % has totals of 0 or more with gross = net + VAT (net %, VAT %, gross %) and stamp duty above 0 when due', NEW."id", NEW."netTotal", NEW."vatTotal", NEW."grossTotal"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."docType" = 'TD02') <> (NEW."depositRequestId" IS NOT NULL) THEN
    RAISE EXCEPTION 'invoicing: a TD02 (and only a TD02) names the deposit request it invoices (invoice %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."docType" = 'TD04') <> (NEW."creditOfId" IS NOT NULL) THEN
    RAISE EXCEPTION 'invoicing: a TD04 (and only a TD04) names the invoice it credits (invoice %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."creditOfId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."creditOfId" IS DISTINCT FROM OLD."creditOfId") THEN
    SELECT o."status"::text, o."docType"::text INTO state, doc_type FROM "Invoice" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."creditOfId";
    IF FOUND AND (state = 'DRAFT' OR doc_type = 'TD04') THEN
      RAISE EXCEPTION 'invoicing: credit note % credits invoice %, which is a % %; a credit note credits an issued invoice that is not a credit note', NEW."id", NEW."creditOfId", state, doc_type
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."depositRequestId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."depositRequestId" IS DISTINCT FROM OLD."depositRequestId") THEN
    SELECT r."fiscalDocument"::text INTO fiscal_document FROM "DepositRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."depositRequestId";
    IF FOUND AND fiscal_document <> 'TD02' THEN
      RAISE EXCEPTION 'invoicing: deposit request % needs no deposit invoice (its fiscal document is %: the VAT rule for the party decided it)', NEW."depositRequestId", fiscal_document
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- A corrected (REJECTED) invoice whose totals drop: never below what is paid and credited on it.
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'DRAFT'
     AND (NEW."grossTotal" < OLD."grossTotal" OR NEW."netTotal" < OLD."netTotal") THEN
    PERFORM "factory_money_lock"('invoice', NEW."tenantId", NEW."id");
    credited := "factory_invoice_credited"(NEW."tenantId", NEW."id", NULL);
    SELECT coalesce(sum(a."amount"), 0) INTO allocated FROM "PaymentAllocation" a WHERE a."tenantId" = NEW."tenantId" AND a."invoiceId" = NEW."id";
    IF NEW."grossTotal" < OLD."grossTotal" AND allocated + credited > NEW."grossTotal" THEN
      RAISE EXCEPTION 'invoicing: invoice % has % paid and % credited; its corrected gross total % cannot be below them', NEW."id", allocated, credited, NEW."grossTotal"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."docType" = 'TD02' AND NEW."netTotal" < OLD."netTotal" THEN
      SELECT coalesce(sum(c."netTotal"), 0) INTO credited_net FROM "Invoice" c
       WHERE c."tenantId" = NEW."tenantId" AND c."creditOfId" = NEW."id" AND c."docType" = 'TD04' AND c."status" <> 'DRAFT';
      SELECT coalesce(sum(-l."netAmount"), 0) INTO deducted_net FROM "InvoiceLine" l JOIN "Invoice" i ON i."tenantId" = l."tenantId" AND i."id" = l."invoiceId"
       WHERE l."tenantId" = NEW."tenantId" AND l."depositInvoiceId" = NEW."id" AND i."status" <> 'DRAFT';
      IF credited_net + deducted_net > NEW."netTotal" THEN
        RAISE EXCEPTION 'invoicing: deposit invoice % has % deducted and % credited; its corrected net % cannot be below them', NEW."id", deducted_net, credited_net, NEW."netTotal"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- The issue, and every send of a corrected file: the same checks.
  IF TG_OP = 'UPDATE' AND ((OLD."status" = 'DRAFT' AND NEW."status" = 'ISSUED') OR (OLD."status" = 'REJECTED' AND NEW."status" <> 'REJECTED')) THEN
    PERFORM "factory_invoice_check_issue"(NEW);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Invoice_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION "factory_invoice_guard"();
CREATE TRIGGER "Invoice_no_truncate" BEFORE TRUNCATE ON "Invoice"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_refuse_truncate"();

-- The issue gives the lines the invoice's party key (the portal sees them from then on), in the same statement.
CREATE FUNCTION "factory_invoice_lines_follow_issue"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "InvoiceLine" l SET "partyId" = NEW."partyId"
   WHERE l."tenantId" = NEW."tenantId" AND l."invoiceId" = NEW."id" AND l."partyId" IS NULL;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Invoice_issue_lines" AFTER UPDATE ON "Invoice"
  FOR EACH ROW WHEN (OLD."status" = 'DRAFT' AND NEW."status" <> 'DRAFT')
  EXECUTE FUNCTION "factory_invoice_lines_follow_issue"();

-- No gap, no reuse (DPR 633/1972 art. 21 c.2): an issued invoice's number is the one its series gave it in the issuing
-- transaction (allocateNumber's NumberAllocation row, recordType "Invoice": the same series, number and date). Checked
-- at commit, whatever the order of the two writes.
CREATE FUNCTION "factory_invoice_number_allocated"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "NumberAllocation" a
                  WHERE a."tenantId" = NEW."tenantId" AND a."recordType" = 'Invoice' AND a."recordId" = NEW."id"
                    AND a."seriesId" = NEW."numberSeriesId" AND a."formatted" = NEW."number" AND a."documentDate" = NEW."issueDate") THEN
    RAISE EXCEPTION 'invoicing: invoice % is issued as % of % without that number from its series (allocateNumber writes it in the issuing command: no gap, no reuse; DPR 633/1972 art. 21)', NEW."id", NEW."number", NEW."issueDate"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "Invoice_number_allocated" AFTER UPDATE ON "Invoice"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."status" = 'DRAFT' AND NEW."status" <> 'DRAFT')
  EXECUTE FUNCTION "factory_invoice_number_allocated"();

-- InvoiceLine
--   INSERT, UPDATE, DELETE  only while the invoice is a DRAFT, or REJECTED (the corrected file: its lines may hold the
--                           error SDI found; the resend checks them again). The invoice's row is locked FOR SHARE, so an
--                           issue or a resend waits for the transaction that edits its lines, and an edit after it sees
--                           the new status. A line never moves to another invoice. The one change to a line of an issued
--                           invoice otherwise is its party key, set by the issue to the invoice's.
--   every row               a place from 1, a description, a quantity above 0, a discount above 0 and below 100; a rate
--                           of 0 or more, a Natura (N1 … N7) with its law exactly when the rate is 0. A DEPOSIT_DEDUCTION
--                           (and only it) names an issued TD02 of the company, on a TD01 or TD24, with a negative amount
--                           and price and no order line or DDT; any other line has an amount and price of 0 or more. A
--                           draft's line has no party key; a REJECTED invoice's line has the invoice's (a new line gets
--                           it), so the portal keeps seeing the lines of the invoice it sees.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_invoice_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END
$$;

CREATE TRIGGER "InvoiceLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_invoice_line_guard"();
CREATE TRIGGER "InvoiceLine_no_truncate" BEFORE TRUNCATE ON "InvoiceLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_refuse_truncate"();

-- =====================================================================================================================
-- SDI (FIN-084, FIN-086, FIN-087)
-- =====================================================================================================================

-- SdiSubmission
--   INSERT     a send starts SENDING, SENT or FAILED (never with an outcome); it sends an issued invoice (never a draft),
--              its XML of the moment, through an SDI account of the invoice's company.
--   UPDATE     an UPDATE that changes nothing passes; the invoice, attempt, account, file name, XML and creation never
--              change; the provider's id and SDI's id are named once. The status moves SENDING → SENT | FAILED;
--              SENT → FAILED; SENT | FAILED → DELIVERED | NOT_DELIVERABLE | REJECTED (FAILED: the provider did not answer
--              but the file reached SDI). DELIVERED, NOT_DELIVERABLE and REJECTED are final (a resend is a new row).
--   every row  an attempt from 1, a file name; SENT has its send time; FAILED says why; the outcome time is set exactly
--              when DELIVERED, NOT_DELIVERABLE or REJECTED.
--   DELETE     refused (the record of what was sent). TRUNCATE refused.
CREATE FUNCTION "factory_sdi_submission_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  invoice_xml uuid;
  invoice_company uuid;
  account_provider text;
  account_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sdi: send % of invoice % is kept, never deleted', OLD."id", OLD."invoiceId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('SENDING', 'SENT', 'FAILED') THEN
      RAISE EXCEPTION 'sdi: send % starts SENDING, SENT or FAILED, not % (SDI''s outcome comes later)', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."status"::text, i."xmlFileId", i."companyId" INTO state, invoice_xml, invoice_company
      FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";
    IF FOUND THEN
      IF state = 'DRAFT' THEN
        RAISE EXCEPTION 'sdi: invoice % is a DRAFT; only an issued invoice is sent', NEW."invoiceId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF invoice_xml IS DISTINCT FROM NEW."xmlFileId" THEN
        RAISE EXCEPTION 'sdi: send % of invoice % sends file %, not the invoice''s XML %', NEW."id", NEW."invoiceId", NEW."xmlFileId", invoice_xml
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT a."provider"::text, a."companyId" INTO account_provider, account_company
        FROM "IntegrationAccount" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."integrationAccountId";
      IF FOUND AND (account_provider <> 'SDI' OR account_company IS DISTINCT FROM invoice_company) THEN
        RAISE EXCEPTION 'sdi: send % goes through an SDI account of the invoice''s company, not a % account', NEW."id", account_provider
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."partyId", NEW."invoiceId", NEW."attempt", NEW."integrationAccountId", NEW."fileName", NEW."xmlFileId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."partyId", OLD."invoiceId", OLD."attempt", OLD."integrationAccountId", OLD."fileName", OLD."xmlFileId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sdi: the invoice, attempt, account, file name and XML of send % never change (a resend is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."providerRef" IS NOT NULL AND NEW."providerRef" IS DISTINCT FROM OLD."providerRef")
       OR (OLD."sdiIdentifier" IS NOT NULL AND NEW."sdiIdentifier" IS DISTINCT FROM OLD."sdiIdentifier") THEN
      RAISE EXCEPTION 'sdi: the provider''s id and SDI''s id of send % are named once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('DELIVERED', 'NOT_DELIVERABLE', 'REJECTED') AND (to_jsonb(NEW) - ARRAY['tenantId']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['tenantId']) THEN
      RAISE EXCEPTION 'sdi: send % is %; it never changes (a resend is a new row)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'SENDING' AND NEW."status" IN ('SENT', 'FAILED'))
      OR (OLD."status" = 'SENT' AND NEW."status" IN ('FAILED', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED'))
      OR (OLD."status" = 'FAILED' AND NEW."status" IN ('DELIVERED', 'NOT_DELIVERABLE', 'REJECTED'))) THEN
      RAISE EXCEPTION 'sdi: send % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."attempt" < 1 OR btrim(NEW."fileName") = '' THEN
    RAISE EXCEPTION 'sdi: send % has an attempt from 1 and a file name', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'SENT' AND NEW."sentAt" IS NULL)
     OR (NEW."status" = 'FAILED' AND btrim(coalesce(NEW."failureReason", '')) = '')
     OR ((NEW."status" IN ('DELIVERED', 'NOT_DELIVERABLE', 'REJECTED')) <> (NEW."outcomeAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'sdi: send % is % with the wrong times or reason (SENT: its send time; FAILED: why; an outcome: its time)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SdiSubmission_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SdiSubmission"
  FOR EACH ROW EXECUTE FUNCTION "factory_sdi_submission_guard"();
CREATE TRIGGER "SdiSubmission_no_truncate" BEFORE TRUNCATE ON "SdiSubmission"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_refuse_truncate"();

-- SdiNotification, INSERT (append-only above): the message as received is an object. It may come in any order and for
-- a send in any state (SDI answers what it received, also after the provider timed out), so the send's state is the
-- API's to move.
CREATE FUNCTION "factory_sdi_notification_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW."payload") <> 'object' THEN
    RAISE EXCEPTION 'sdi: notification % keeps the message as received (an object)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SdiNotification_check" BEFORE INSERT ON "SdiNotification"
  FOR EACH ROW EXECUTE FUNCTION "factory_sdi_notification_check"();

-- =====================================================================================================================
-- Payments (FIN-121, FIN-122; Q12)
-- =====================================================================================================================

-- Payment
--   INSERT     a payment starts RECEIVED.
--   UPDATE     an UPDATE that changes nothing passes; its company, party, method, amount, currency, date, reference and
--              creation never change; RECEIVED → VOIDED only once its allocations add up to 0 (all reversed; lock: the
--              payment); a VOIDED payment never changes.
--   every row  an amount above 0, an ISO currency, a bank reference; voidedAt and the reason exactly when VOIDED.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_payment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE TRIGGER "Payment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION "factory_payment_guard"();
CREATE TRIGGER "Payment_no_truncate" BEFORE TRUNCATE ON "Payment"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_money_refuse_truncate"();

-- PaymentAllocation, INSERT (append-only above). Locks: the payment, then the target.
--   shape      exactly one target (a deposit request or an invoice); an amount above 0, or a reversal: below 0, naming
--              an allocation of the same payment and target that is not a reversal and not reversed yet, with its
--              opposite amount and a note saying why.
--   payment    RECEIVED (a VOIDED payment pays nothing); its allocations never pass its amount; the target's currency.
--   invoice    issued (not a DRAFT), a TD01 or TD24 (a TD02 is paid through its deposit request, a TD04 is not paid);
--              its allocations never pass its gross total less its credit notes.
--   deposit    OPEN for an allocation (PAID, WAIVED and CANCELLED are final); its allocations never pass its amount;
--              a PAID request's allocations stay (no reversal).
CREATE FUNCTION "factory_payment_allocation_check"() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF allocated + NEW."amount" > payment_amount THEN
      RAISE EXCEPTION 'payments: payment % of % has % allocated; % more passes it', NEW."paymentId", payment_amount, allocated, NEW."amount"
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

CREATE TRIGGER "PaymentAllocation_check" BEFORE INSERT ON "PaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION "factory_payment_allocation_check"();
