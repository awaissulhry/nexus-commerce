-- Written by hand (Prisma does not model triggers), after 202611190105_customer_page_policies. When the migrations are
-- renumbered, keep this file as it is under its new timestamp. No table, column or policy changes: no policy migration
-- follows it.
--
-- The order page (order page plan N5, B-OP-033; end-check fix op-fx2): goods recorded as made ELSEWHERE (B-OP-032) left with
-- a paper DDT, not a Nexus one, and a customer invoiced monthly gets a deferred invoice (TD24, DPR 633/1972 art. 21 c.4
-- lett. a) that cites it: {kind DDT, number, date} in the invoice's documentRefs, FatturaPA DatiDDT. apps/factory-api's
-- invoicing (from-shipment/without-ddt.ts) drafts it so; the issue check refused it, because a TD24's every GOODS line had to
-- name a Nexus DDT (InvoiceLine.ddtId).
--
-- Redefined: money's `factory_invoice_check_issue` (202611140503_tax_currency_w2b_guards' body, word for word), with one
-- change in the TD24 rule, marked B-OP-033: a GOODS line without a Nexus DDT passes only when a shipment of the invoice's
-- company and customer, recorded ELSEWHERE and not cancelled, carries that line's order line, and the invoice cites that
-- shipment's paper DDT with the number and date it was recorded with. Every other GOODS line of a TD24 still names its DDT.
-- A shipment the session cannot see reads as none (the line is refused).

-- =====================================================================================================================
-- factory_invoice_check_issue, the whole body of 202611140503_tax_currency_w2b_guards, word for word, but for B-OP-033.
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
               OR (series_kind = 'CREDIT_NOTE' AND inv."docType" = 'TD04')
               OR (series_kind = 'SELF_INVOICE' AND inv."docType" IN ('TD16', 'TD17', 'TD18', 'TD19'))) THEN
      RAISE EXCEPTION 'invoicing: a % is numbered from a fiscal INVOICE series (or DEPOSIT_INVOICE for a TD02, CREDIT_NOTE for a TD04, SELF_INVOICE for a TD16-TD19), not from a % series', inv."docType", series_kind
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
     WHERE l."tenantId" = inv."tenantId" AND l."invoiceId" = inv."id" AND l."kind" = 'GOODS' AND l."ddtId" IS NULL
       -- B-OP-033 (op-fx2): or the goods left with a paper DDT — a shipment of the company and the invoice's customer recorded
       -- as made ELSEWHERE (not cancelled) carries this order line, and the invoice cites that paper DDT, its number and date
       -- as recorded ({kind DDT, number, date} in documentRefs).
       AND NOT EXISTS (
         SELECT 1 FROM "Shipment" s
           JOIN "ShipmentLine" sl ON sl."tenantId" = s."tenantId" AND sl."shipmentId" = s."id"
          WHERE s."tenantId" = inv."tenantId" AND s."companyId" = inv."companyId" AND s."partyId" = inv."buyerPartyId"
            AND s."origin" = 'ELSEWHERE' AND s."status" <> 'CANCELLED'
            AND s."externalDdtNumber" IS NOT NULL AND s."externalDdtDate" IS NOT NULL
            AND sl."salesOrderLineId" = l."salesOrderLineId"
            AND jsonb_typeof(inv."documentRefs") = 'array'
            AND inv."documentRefs" @> jsonb_build_array(jsonb_build_object('kind', 'DDT', 'number', s."externalDdtNumber", 'date', to_char(s."externalDdtDate", 'YYYY-MM-DD'))))
     LIMIT 1;
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
