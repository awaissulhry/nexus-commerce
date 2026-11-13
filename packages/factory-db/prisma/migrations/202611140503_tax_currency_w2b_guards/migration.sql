-- Written by hand (Prisma does not model triggers or partial unique indexes), after the generated
-- 202611140502_tax_currency_w2b_schema and before the policy migration. When the migrations are renumbered, keep this file
-- as it is under its new timestamp.

-- Invoicing, tax and currency (W2b-6 schema wave 49/57, B-W2b-369; FIN-063, FIN-068, FIN-071, FIN-076, FIN-080, FIN-095,
-- FIN-096, FIN-097, FIN-100, FIN-101, FIN-107, PLT-132, PLT-133). apps/factory-api's modules check all of this first; these
-- rules hold for every login, the owner included. The tenant of a row is held by the policies and the references, not here.
-- AFTER triggers (the policies speak first: a row outside the session's scope is refused by them); BEFORE triggers only for
-- the refused deletes and TRUNCATE. An UPDATE that changes nothing passes. Every refusal is a check_violation (SQLSTATE
-- 23514) in words. A rule that reads another row skips one the session cannot see. A business day is Europe/Rome's
-- (money's `factory_money_rome_day`). Used as they are: recall's `factory_recall_words_ok` and `factory_recall_not_future`,
-- money's `factory_money_rome_day`.
--
-- GATE-ACCOUNTANT (lead decision 11-13): CompanyEInvoiceSettings holds a company's tax switches, all OFF by default (no row:
-- off). While a switch is off the database refuses: an invoice naming a declaration of intent (declarationsOfIntentOn), a
-- STAMP_DUTY charge line (stampDutyOn), an invoice of type TD16-TD19 leaving DRAFT and a self-invoice marked ISSUED
-- (selfInvoicesOn). The tax codes switch (taxCodesOn) is the API's to read: a code is data, it reaches no document itself.
--
-- Redefined: money's `factory_invoice_check_issue` (202610307001_money_w2a_guards' body, word for word), with the
-- SELF_INVOICE series accepted for TD16-TD19 (the INVOICE series stays accepted for every type). Partial uniques:
-- DeclarationOfIntent_one_live, SelfInvoice_one_live, DepositCancellationRule_one_active, Currency_one_active,
-- InvoiceLine_one_stamp_duty.

-- =====================================================================================================================
-- Helpers
-- =====================================================================================================================

CREATE FUNCTION "factory_tax_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tax: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_tax_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tax: a "%" row is never deleted (%)', TG_TABLE_NAME,
    CASE TG_TABLE_NAME
      WHEN 'DeclarationOfIntent' THEN 'revoke it with why'
      WHEN 'StampDutyQuarter' THEN 'recount it while it is not paid'
      WHEN 'SelfInvoice' THEN 'cancel it with why while it is PENDING'
      WHEN 'CompanyEInvoiceSettings' THEN 'change its settings'
      WHEN 'SdiArchiveCopy' THEN 'our own copy of an SDI send is kept'
      WHEN 'DepositCancellationRule' THEN 'archive it'
      WHEN 'Currency' THEN 'switch it off'
      ELSE 'it is kept'
    END
    USING ERRCODE = 'check_violation';
END
$$;

-- ISO 4217: three capitals.
CREATE FUNCTION "factory_tax_currency_code_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NOT NULL AND code ~ '^[A-Z]{3}$'
$$;

-- The detailed Natura codes SDI accepts since 1 January 2021 (factory-domain tax/natura.ts NATURA_CODES).
CREATE FUNCTION "factory_tax_natura_ok"(natura text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT natura IN ('N1', 'N2.1', 'N2.2', 'N3.1', 'N3.2', 'N3.3', 'N3.4', 'N3.5', 'N3.6', 'N4', 'N5',
                    'N6.1', 'N6.2', 'N6.3', 'N6.4', 'N6.5', 'N6.6', 'N6.7', 'N6.8', 'N6.9', 'N7')
$$;

-- A list of ids: not null, no null, each once, at most `longest`.
CREATE FUNCTION "factory_tax_id_list_ok"(ids uuid[], longest integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT ids IS NOT NULL AND array_position(ids, NULL) IS NULL AND cardinality(ids) <= longest
     AND (SELECT count(DISTINCT x) FROM unnest(ids) AS x) = cardinality(ids)
$$;

-- A company's tax switch (CompanyEInvoiceSettings; GATE-ACCOUNTANT): on only when its row says so (no row, or a row the
-- session cannot see: off). `which` is the column's name.
CREATE FUNCTION "factory_tax_switch_on"(tenant uuid, company uuid, which text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(bool_and(CASE which
                             WHEN 'taxCodesOn' THEN s."taxCodesOn"
                             WHEN 'stampDutyOn' THEN s."stampDutyOn"
                             WHEN 'declarationsOfIntentOn' THEN s."declarationsOfIntentOn"
                             WHEN 'selfInvoicesOn' THEN s."selfInvoicesOn"
                           END), false)
    FROM "CompanyEInvoiceSettings" s WHERE s."tenantId" = tenant AND s."companyId" = company
$$;

-- =====================================================================================================================
-- TaxCode (FIN-107)
--   every row  a country (two capitals); a code of 1-20 capitals, digits, dot, underscore or hyphen; a label of one line,
--              1-200; a rate 0.00-100.00, exactly 0 when it carries a Natura (a detailed code SDI accepts) with its law
--              (one line, 1-100: RiferimentoNormativo); an account key of 1-60 characters without spaces; a rule id of
--              capitals, digits and underscores; a confirmation (when and who, both, not in the future) only on a VERIFIED
--              code; valid to (when set) not before valid from. One ACTIVE version of a code per company and country on
--              any day (a transaction advisory lock per code).
--   UPDATE     the company and creation never change. From its first day (Europe/Rome) a version is in force and never
--              edited: its country, code, rate, Natura, law, account key, rule and first day are fixed (end it and make a
--              new version); its end moves only while it has not passed, and not before yesterday (it may be reopened).
--              VERIFIED never goes back to UNVERIFIED; a confirmation is recorded once. The label and the status (ACTIVE,
--              ARCHIVED) change.
--   DELETE     only a version not yet in force (from its first day on it is archived). TRUNCATE refused.
CREATE FUNCTION "factory_tax_code_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  today date := "factory_money_rome_day"(now());
  clash record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'tax: the company and creation of tax code % never change', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."validFrom" <= today THEN
      IF (NEW."country", NEW."code", NEW."ratePct", NEW."natura", NEW."legalRef", NEW."accountCodeKey", NEW."ruleId", NEW."validFrom")
         IS DISTINCT FROM (OLD."country", OLD."code", OLD."ratePct", OLD."natura", OLD."legalRef", OLD."accountCodeKey", OLD."ruleId", OLD."validFrom") THEN
        RAISE EXCEPTION 'tax: tax code % (%) is in force since %; a code in use is never edited: end this version and make a new one', OLD."code", OLD."country", OLD."validFrom"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."validTo" IS DISTINCT FROM OLD."validTo" THEN
        IF OLD."validTo" IS NOT NULL AND OLD."validTo" < today THEN
          RAISE EXCEPTION 'tax: tax code % ended on %; its end never moves', OLD."code", OLD."validTo"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."validTo" IS NOT NULL AND NEW."validTo" < today - 1 THEN
          RAISE EXCEPTION 'tax: tax code % is in force; it ends yesterday at the earliest, not on % (what applied to past documents stays)', OLD."code", NEW."validTo"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
    IF OLD."verification" = 'VERIFIED' AND NEW."verification" <> 'VERIFIED' THEN
      RAISE EXCEPTION 'tax: tax code % is VERIFIED; it never goes back to UNVERIFIED (make a new version)', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."confirmedAt" IS NOT NULL AND (NEW."confirmedAt", NEW."confirmedById") IS DISTINCT FROM (OLD."confirmedAt", OLD."confirmedById") THEN
      RAISE EXCEPTION 'tax: the accountant''s confirmation of tax code % is recorded once', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."country" IS NULL OR NEW."country" !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'tax: tax code % names its country as two capitals (ISO 3166-1: "IT"), not "%"', NEW."code", NEW."country"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."code" IS NULL OR NEW."code" !~ '^[A-Z0-9][A-Z0-9._-]{0,19}$' THEN
    RAISE EXCEPTION 'tax: a tax code is 1-20 capitals, digits, dot, underscore or hyphen ("22", "N3.2"), not "%"', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."label" IS NULL OR NOT "factory_recall_words_ok"(NEW."label", 200, false) THEN
    RAISE EXCEPTION 'tax: tax code % has a label of one line, 1 to 200 characters', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ratePct" < 0 OR NEW."ratePct" > 100 THEN
    RAISE EXCEPTION 'tax: the rate of tax code % is 0.00 to 100.00 percent, not %', NEW."code", NEW."ratePct"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."natura" IS NOT NULL) <> (NEW."ratePct" = 0) OR (NEW."natura" IS NOT NULL AND NOT "factory_tax_natura_ok"(NEW."natura")) THEN
    RAISE EXCEPTION 'tax: tax code % carries a Natura (a detailed code SDI accepts: N1, N2.1 … N7) exactly when its rate is 0, not % at %', NEW."code", coalesce(NEW."natura", 'none'), NEW."ratePct"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."legalRef" IS NOT NULL) <> (NEW."natura" IS NOT NULL) OR NOT "factory_recall_words_ok"(NEW."legalRef", 100, false) THEN
    RAISE EXCEPTION 'tax: tax code % with a Natura cites its law (RiferimentoNormativo, one line, 1 to 100 characters), and only then', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."accountCodeKey" IS NOT NULL AND NEW."accountCodeKey" !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,59}$' THEN
    RAISE EXCEPTION 'tax: the account key of tax code % is 1 to 60 letters, digits, dot, underscore, colon, slash or hyphen', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ruleId" IS NOT NULL AND NEW."ruleId" !~ '^[A-Z][A-Z0-9_]{1,59}$' THEN
    RAISE EXCEPTION 'tax: tax code % names a rule by its id (capitals, digits, underscores: "INTRA_EU_SUPPLY_OF_GOODS")', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."confirmedAt" IS NULL) <> (NEW."confirmedById" IS NULL)
     OR (NEW."confirmedAt" IS NOT NULL AND NEW."verification" <> 'VERIFIED')
     OR NOT "factory_recall_not_future"(NEW."confirmedAt") THEN
    RAISE EXCEPTION 'tax: the accountant''s confirmation of tax code % has its time (not in the future) and the person who recorded it, both, on a VERIFIED code', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."verification" = 'UNVERIFIED' AND NEW."verification" = 'VERIFIED' AND NEW."confirmedAt" IS NULL THEN
    RAISE EXCEPTION 'tax: tax code % becomes VERIFIED with the accountant''s confirmation (when, and who recorded it)', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."validTo" IS NOT NULL AND NEW."validTo" < NEW."validFrom" THEN
    RAISE EXCEPTION 'tax: tax code % ends (%) before it starts (%)', NEW."code", NEW."validTo", NEW."validFrom"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'ACTIVE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.tax.code', NEW."tenantId", NEW."companyId", NEW."country", NEW."code"), 0));
    SELECT t."validFrom", t."validTo" INTO clash FROM "TaxCode" t
     WHERE t."tenantId" = NEW."tenantId" AND t."companyId" = NEW."companyId" AND t."country" = NEW."country" AND t."code" = NEW."code"
       AND t."status" = 'ACTIVE' AND t."id" <> NEW."id"
       AND daterange(t."validFrom", t."validTo", '[]') && daterange(NEW."validFrom", NEW."validTo", '[]')
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'tax: tax code % (%) has an ACTIVE version from % to %; its versions never overlap (end it first)', NEW."code", NEW."country", clash."validFrom", coalesce(clash."validTo"::text, 'open')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_tax_code_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."validFrom" <= "factory_money_rome_day"(now()) THEN
    RAISE EXCEPTION 'tax: tax code % (%) is in force since %; archive it (only a version not yet in force is deleted)', OLD."code", OLD."country", OLD."validFrom"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "TaxCode_check" AFTER INSERT OR UPDATE ON "TaxCode"
  FOR EACH ROW EXECUTE FUNCTION "factory_tax_code_check"();
CREATE TRIGGER "TaxCode_delete" BEFORE DELETE ON "TaxCode"
  FOR EACH ROW EXECUTE FUNCTION "factory_tax_code_delete"();
CREATE TRIGGER "TaxCode_no_truncate" BEFORE TRUNCATE ON "TaxCode"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_tax_refuse_truncate"();

-- =====================================================================================================================
-- DeclarationOfIntent (FIN-100)
--   every row  the protocol: 17 digits, a hyphen, 6 digits; its date not in the future (Europe/Rome); the year the
--              protocol's or the next; an amount above 0 and a used amount from 0 to it; the check: its time (not in the
--              future), its person and its receipt, all three or none, the receipt a file of this declaration and its
--              company; a revocation with its time (not in the future) and why (3-500), both or neither. One live (not
--              revoked) declaration per protocol: the partial unique DeclarationOfIntent_one_live.
--   UPDATE     the company, customer, protocol, its date, the year, the amount and the creation never change; the check is
--              recorded once; a revoked declaration is frozen. What is used moves (the issue, a credit note).
--   DELETE     refused (revoked instead). TRUNCATE refused.
CREATE FUNCTION "factory_declaration_of_intent_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  file record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'tax: declaration of intent % was revoked on %; it changes no more', OLD."protocolNumber", OLD."revokedAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."companyId", NEW."partyId", NEW."protocolNumber", NEW."protocolDate", NEW."year", NEW."amount", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."partyId", OLD."protocolNumber", OLD."protocolDate", OLD."year", OLD."amount", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'tax: the company, customer, protocol, date, year and amount of declaration of intent % never change (a new declaration is a new row)', OLD."protocolNumber"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."checkedAt" IS NOT NULL AND (NEW."checkedAt", NEW."checkedById", NEW."receiptFileId") IS DISTINCT FROM (OLD."checkedAt", OLD."checkedById", OLD."receiptFileId") THEN
      RAISE EXCEPTION 'tax: the check of declaration of intent % on the tax agency''s site is recorded once', OLD."protocolNumber"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."protocolNumber" IS NULL OR NEW."protocolNumber" !~ '^[0-9]{17}-[0-9]{6}$' THEN
    RAISE EXCEPTION 'tax: a declaration of intent''s protocol is the tax agency''s: 17 digits, a hyphen and 6 digits, not "%"', NEW."protocolNumber"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."protocolDate" > "factory_money_rome_day"(now()) THEN
    RAISE EXCEPTION 'tax: declaration of intent % is dated % in the future', NEW."protocolNumber", NEW."protocolDate"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."year" < extract(year FROM NEW."protocolDate")::int OR NEW."year" > extract(year FROM NEW."protocolDate")::int + 1 THEN
    RAISE EXCEPTION 'tax: declaration of intent % (dated %) covers its year or the next, not %', NEW."protocolNumber", NEW."protocolDate", NEW."year"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amount" <= 0 OR NEW."usedAmount" < 0 OR NEW."usedAmount" > NEW."amount" THEN
    RAISE EXCEPTION 'tax: declaration of intent % declares an amount above 0 and is used from 0 up to it (amount %, used %): a used-up declaration covers no more invoices', NEW."protocolNumber", NEW."amount", NEW."usedAmount"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((NEW."checkedAt" IS NULL AND NEW."checkedById" IS NULL AND NEW."receiptFileId" IS NULL)
          OR (NEW."checkedAt" IS NOT NULL AND NEW."checkedById" IS NOT NULL AND NEW."receiptFileId" IS NOT NULL))
     OR NOT "factory_recall_not_future"(NEW."checkedAt") THEN
    RAISE EXCEPTION 'tax: the check of declaration of intent % has its time (not in the future), its person and the receipt the tax agency''s site printed, all three', NEW."protocolNumber"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."receiptFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."receiptFileId" IS DISTINCT FROM OLD."receiptFileId") THEN
    SELECT f."recordType", f."recordId", f."companyId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."receiptFileId";
    IF FOUND AND (file."recordType" <> 'DeclarationOfIntent' OR file."recordId" <> NEW."id" OR file."companyId" IS DISTINCT FROM NEW."companyId") THEN
      RAISE EXCEPTION 'tax: the receipt of declaration of intent % is a file of the declaration and its company', NEW."protocolNumber"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."revokedAt" IS NULL) <> (NEW."revokeReason" IS NULL) OR NOT "factory_recall_not_future"(NEW."revokedAt")
     OR (NEW."revokeReason" IS NOT NULL AND (char_length(btrim(NEW."revokeReason")) < 3 OR NOT "factory_recall_words_ok"(NEW."revokeReason", 500, true))) THEN
    RAISE EXCEPTION 'tax: declaration of intent % is revoked with its time (not in the future) and why (3 to 500 characters), both', NEW."protocolNumber"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "DeclarationOfIntent_check" AFTER INSERT OR UPDATE ON "DeclarationOfIntent"
  FOR EACH ROW EXECUTE FUNCTION "factory_declaration_of_intent_check"();
CREATE TRIGGER "DeclarationOfIntent_never_deleted" BEFORE DELETE ON "DeclarationOfIntent"
  FOR EACH ROW EXECUTE FUNCTION "factory_tax_never_deleted"();
CREATE TRIGGER "DeclarationOfIntent_no_truncate" BEFORE TRUNCATE ON "DeclarationOfIntent"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_tax_refuse_truncate"();
CREATE UNIQUE INDEX "DeclarationOfIntent_one_live" ON "DeclarationOfIntent" ("tenantId", "protocolNumber") WHERE "revokedAt" IS NULL;

-- =====================================================================================================================
-- StampDutyQuarter (FIN-101)
--   every row  the quarter's first day (1 January, April, July or October); invoices and total 0 or more; paid with its
--              time (not in the future, after the quarter ended) and person, both or neither.
--   UPDATE     the company, quarter and creation never change; a paid quarter is frozen.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_stamp_duty_quarter_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."paidAt" IS NOT NULL THEN
      RAISE EXCEPTION 'tax: the stamp duty of the quarter from % was paid on %; it changes no more', OLD."quarterStart", OLD."paidAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."companyId", NEW."quarterStart", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."quarterStart", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'tax: the company, quarter and creation of a stamp duty quarter never change'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF extract(day FROM NEW."quarterStart") <> 1 OR extract(month FROM NEW."quarterStart") NOT IN (1, 4, 7, 10) THEN
    RAISE EXCEPTION 'tax: a stamp duty quarter starts on 1 January, April, July or October, not on %', NEW."quarterStart"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."invoiceCount" < 0 OR NEW."total" < 0 THEN
    RAISE EXCEPTION 'tax: the stamp duty quarter from % counts 0 or more invoices and a total of 0 or more', NEW."quarterStart"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."paidAt" IS NULL) <> (NEW."paidById" IS NULL) OR NOT "factory_recall_not_future"(NEW."paidAt")
     OR (NEW."paidAt" IS NOT NULL AND "factory_money_rome_day"(NEW."paidAt") < (NEW."quarterStart" + interval '3 months')::date) THEN
    RAISE EXCEPTION 'tax: the stamp duty quarter from % is paid after it ended, with the time (not in the future) and the person, both', NEW."quarterStart"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StampDutyQuarter_check" AFTER INSERT OR UPDATE ON "StampDutyQuarter"
  FOR EACH ROW EXECUTE FUNCTION "factory_stamp_duty_quarter_check"();
CREATE TRIGGER "StampDutyQuarter_never_deleted" BEFORE DELETE ON "StampDutyQuarter"
  FOR EACH ROW EXECUTE FUNCTION "factory_tax_never_deleted"();
CREATE TRIGGER "StampDutyQuarter_no_truncate" BEFORE TRUNCATE ON "StampDutyQuarter"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_tax_refuse_truncate"();

-- =====================================================================================================================
-- SelfInvoice (FIN-095)
--   every row  CANCELLED exactly with its time (not in the future) and why (3-500), and no invoice; its invoice (when
--              named) of the self-invoice's type; ISSUED with its invoice issued (not a DRAFT) and the company's
--              self-invoice switch on (GATE-ACCOUNTANT). At insert the supplier invoice is not VOIDED; the deadline is not
--              before the day it was received. One live (not CANCELLED) self-invoice per supplier invoice: the partial
--              unique SelfInvoice_one_live; an invoice is the document of one (the key).
--   UPDATE     the company, supplier, supplier invoice, kind and creation never change; PENDING → ISSUED | CANCELLED, both
--              final and frozen; the invoice is named once (cleared only by the cancel, while it is still a DRAFT); the
--              deadline moves while PENDING.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_self_invoice_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc record;
  received record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'tax: self-invoice % is %; it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."companyId", NEW."partyId", NEW."supplierInvoiceId", NEW."kind", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."partyId", OLD."supplierInvoiceId", OLD."kind", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'tax: the company, supplier, supplier invoice, kind and creation of self-invoice % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."invoiceId" IS NOT NULL AND NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" THEN
      SELECT i."status"::text AS status INTO doc FROM "Invoice" i WHERE i."tenantId" = OLD."tenantId" AND i."id" = OLD."invoiceId";
      IF NOT (NEW."status" = 'CANCELLED' AND NEW."invoiceId" IS NULL AND (NOT FOUND OR doc.status = 'DRAFT')) THEN
        RAISE EXCEPTION 'tax: self-invoice % names its invoice once (it is let go only by a cancel, while the invoice is still a DRAFT)', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    SELECT s."status"::text AS status, s."receivedOn" AS received_on INTO received FROM "SupplierInvoice" s
     WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."supplierInvoiceId";
    IF FOUND AND received.status = 'VOIDED' THEN
      RAISE EXCEPTION 'tax: supplier invoice % was voided; it asks for no self-invoice', NEW."supplierInvoiceId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND NEW."deadline" < received.received_on THEN
      RAISE EXCEPTION 'tax: the deadline % of self-invoice % is before the day its supplier invoice was received (%)', NEW."deadline", NEW."id", received.received_on
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."cancelledAt")
     OR (NEW."cancelReason" IS NOT NULL AND (char_length(btrim(NEW."cancelReason")) < 3 OR NOT "factory_recall_words_ok"(NEW."cancelReason", 500, true)))
     OR (NEW."status" = 'CANCELLED' AND NEW."invoiceId" IS NOT NULL) THEN
    RAISE EXCEPTION 'tax: self-invoice % is CANCELLED exactly with its time (not in the future) and why (3 to 500 characters), and without an invoice', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'ISSUED' AND NEW."invoiceId" IS NULL THEN
    RAISE EXCEPTION 'tax: self-invoice % is ISSUED with the invoice sent to SDI for it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."invoiceId" IS NOT NULL THEN
    SELECT i."status"::text AS status, i."docType"::text AS doc_type INTO doc FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";
    IF FOUND AND doc.doc_type <> NEW."kind"::text THEN
      RAISE EXCEPTION 'tax: self-invoice % is a %; its invoice is one too, not a %', NEW."id", NEW."kind", doc.doc_type
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND NEW."status" = 'ISSUED' AND doc.status = 'DRAFT' THEN
      RAISE EXCEPTION 'tax: self-invoice % is ISSUED once its invoice is issued (it is a DRAFT)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" = 'ISSUED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'ISSUED')
     AND NOT "factory_tax_switch_on"(NEW."tenantId", NEW."companyId", 'selfInvoicesOn') THEN
    RAISE EXCEPTION 'tax: self-invoices are switched off for this company until the accountant confirms them (GATE-ACCOUNTANT); self-invoice % is not issued', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SelfInvoice_check" AFTER INSERT OR UPDATE ON "SelfInvoice"
  FOR EACH ROW EXECUTE FUNCTION "factory_self_invoice_check"();
CREATE TRIGGER "SelfInvoice_never_deleted" BEFORE DELETE ON "SelfInvoice"
  FOR EACH ROW EXECUTE FUNCTION "factory_tax_never_deleted"();
CREATE TRIGGER "SelfInvoice_no_truncate" BEFORE TRUNCATE ON "SelfInvoice"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_tax_refuse_truncate"();
CREATE UNIQUE INDEX "SelfInvoice_one_live" ON "SelfInvoice" ("tenantId", "supplierInvoiceId") WHERE "status" <> 'CANCELLED';

-- =====================================================================================================================
-- CompanyEInvoiceSettings (FIN-096; GATE-ACCOUNTANT)
--   every row  test mode exactly without liveSince and liveSetById; live exactly with both, liveSince not in the future.
--   UPDATE     the company and creation never change; while it stays live, liveSince and liveSetById are fixed.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_company_einvoice_settings_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'tax: the company and creation of e-invoice settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT OLD."testMode" AND NOT NEW."testMode" AND (NEW."liveSince", NEW."liveSetById") IS DISTINCT FROM (OLD."liveSince", OLD."liveSetById") THEN
      RAISE EXCEPTION 'tax: the company is live with SDI since %; when and by whom it went live never change while it stays live', OLD."liveSince"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."testMode" <> (NEW."liveSince" IS NULL) OR (NEW."liveSince" IS NULL) <> (NEW."liveSetById" IS NULL) OR NOT "factory_recall_not_future"(NEW."liveSince") THEN
    RAISE EXCEPTION 'tax: e-invoicing goes live with when (not in the future) and the person who took it live, both; test mode has neither (settings %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "CompanyEInvoiceSettings_check" AFTER INSERT OR UPDATE ON "CompanyEInvoiceSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_company_einvoice_settings_check"();
CREATE TRIGGER "CompanyEInvoiceSettings_never_deleted" BEFORE DELETE ON "CompanyEInvoiceSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_tax_never_deleted"();
CREATE TRIGGER "CompanyEInvoiceSettings_no_truncate" BEFORE TRUNCATE ON "CompanyEInvoiceSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_tax_refuse_truncate"();

-- =====================================================================================================================
-- SdiArchiveCopy (FIN-097)
--   every row  the key begins with "sdi:" and the send's id (one copy per send); the provider named in one line, 1-100;
--              the receipts each once, at most 50; copied not in the future; the company the invoice's; the XML a
--              FISCAL_ARCHIVE file of the invoice; each receipt a FISCAL_ARCHIVE file of the company, of the invoice, its
--              send or one of SDI's notifications.
--   UPDATE     the company, party, invoice, send, key, provider, XML and creation never change; receipts are only added;
--              copiedAt only moves later.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_sdi_archive_copy_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice_company uuid;
  file record;
  bad uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."partyId", NEW."invoiceId", NEW."submissionId", NEW."key", NEW."providerName", NEW."xmlFileId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."partyId", OLD."invoiceId", OLD."submissionId", OLD."key", OLD."providerName", OLD."xmlFileId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'tax: our copy % of an SDI send keeps its send, provider and XML; only receipts are added', OLD."key"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (coalesce(OLD."receiptFileIds", '{}') <@ coalesce(NEW."receiptFileIds", '{}')) OR NEW."copiedAt" < OLD."copiedAt" THEN
      RAISE EXCEPTION 'tax: our copy % of an SDI send only gains receipts, and its copy time only moves later', OLD."key"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."key" IS NULL OR left(NEW."key", length('sdi:' || NEW."submissionId"::text)) <> 'sdi:' || NEW."submissionId"::text THEN
    RAISE EXCEPTION 'tax: our copy of SDI send % is keyed "sdi:" and the send''s id (one copy per send), not "%"', NEW."submissionId", NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."providerName" IS NULL OR NOT "factory_recall_words_ok"(NEW."providerName", 100, false) THEN
    RAISE EXCEPTION 'tax: our copy % names the intermediary that held the send in one line, 1 to 100 characters', NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_tax_id_list_ok"(NEW."receiptFileIds", 50) OR NOT "factory_recall_not_future"(NEW."copiedAt") THEN
    RAISE EXCEPTION 'tax: our copy % lists each receipt once (at most 50) and was copied not in the future', NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."companyId" INTO invoice_company FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";
  IF FOUND AND invoice_company <> NEW."companyId" THEN
    RAISE EXCEPTION 'tax: our copy % is of the company of its invoice', NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT f."kind"::text AS kind, f."recordType", f."recordId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."xmlFileId";
    IF FOUND AND (file.kind <> 'FISCAL_ARCHIVE' OR file."recordType" <> 'Invoice' OR file."recordId" <> NEW."invoiceId") THEN
      RAISE EXCEPTION 'tax: the XML of our copy % is a fiscal-archive file of its invoice', NEW."key"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT f."id" INTO bad FROM "StoredFile" f
   WHERE f."tenantId" = NEW."tenantId" AND f."id" = ANY (NEW."receiptFileIds")
     AND (TG_OP = 'INSERT' OR NOT (f."id" = ANY (OLD."receiptFileIds")))
     AND (f."kind" <> 'FISCAL_ARCHIVE' OR f."companyId" IS DISTINCT FROM NEW."companyId"
          OR f."recordType" NOT IN ('Invoice', 'SdiSubmission', 'SdiNotification'))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'tax: receipt % of our copy % is a fiscal-archive file of the company, of its invoice, send or SDI notification', bad, NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SdiArchiveCopy_check" AFTER INSERT OR UPDATE ON "SdiArchiveCopy"
  FOR EACH ROW EXECUTE FUNCTION "factory_sdi_archive_copy_check"();
CREATE TRIGGER "SdiArchiveCopy_never_deleted" BEFORE DELETE ON "SdiArchiveCopy"
  FOR EACH ROW EXECUTE FUNCTION "factory_tax_never_deleted"();
CREATE TRIGGER "SdiArchiveCopy_no_truncate" BEFORE TRUNCATE ON "SdiArchiveCopy"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_tax_refuse_truncate"();

-- =====================================================================================================================
-- InvoiceRun (FIN-068)
--   every row  the month's first day; the customers parties of the tenant, each once, 1 to 1000; ISSUED exactly with its
--              time (not in the future) and person.
--   UPDATE     the company and creation never change; PREVIEW → ISSUED only, when no draft invoice is left in it; an
--              ISSUED run is frozen; while PREVIEW no invoice of it is of a customer it no longer picks.
--   DELETE     only a PREVIEW (its invoices let go first: the references). TRUNCATE refused.
CREATE FUNCTION "factory_invoice_run_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  missing uuid;
  left_over uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."status" = 'ISSUED' THEN
      RAISE EXCEPTION 'invoicing: invoice run % was issued on %; it changes no more', OLD."id", OLD."issuedAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'invoicing: the company and creation of invoice run % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'ISSUED' THEN
      SELECT i."id" INTO left_over FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."invoiceRunId" = NEW."id" AND i."status" = 'DRAFT' LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'invoicing: invoice run % still holds draft invoice %; issue it or let it go from the run before the run is issued', NEW."id", left_over
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."partyIds" IS DISTINCT FROM OLD."partyIds" THEN
      SELECT i."id" INTO left_over FROM "Invoice" i
       WHERE i."tenantId" = NEW."tenantId" AND i."invoiceRunId" = NEW."id" AND NOT (i."buyerPartyId" = ANY (coalesce(NEW."partyIds", '{}')))
       LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'invoicing: invoice run % holds invoice % of a customer it would no longer pick; let the invoice go first', NEW."id", left_over
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF extract(day FROM NEW."month") <> 1 THEN
    RAISE EXCEPTION 'invoicing: invoice run % names its month by its first day, not %', NEW."id", NEW."month"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_tax_id_list_ok"(NEW."partyIds", 1000) OR cardinality(NEW."partyIds") = 0 THEN
    RAISE EXCEPTION 'invoicing: invoice run % picks 1 to 1000 customers, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT x INTO missing FROM unnest(NEW."partyIds") AS x
   WHERE NOT EXISTS (SELECT 1 FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = x)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'invoicing: invoice run % picks %, which is not a party of the tenant', NEW."id", missing
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ISSUED') <> (NEW."issuedAt" IS NOT NULL) OR (NEW."issuedAt" IS NULL) <> (NEW."issuedById" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."issuedAt") THEN
    RAISE EXCEPTION 'invoicing: invoice run % is ISSUED exactly with when (not in the future) and by whom', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_invoice_run_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PREVIEW' THEN
    RAISE EXCEPTION 'invoicing: invoice run % was issued; it is kept (only a preview is deleted)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "InvoiceRun_check" AFTER INSERT OR UPDATE ON "InvoiceRun"
  FOR EACH ROW EXECUTE FUNCTION "factory_invoice_run_check"();
CREATE TRIGGER "InvoiceRun_delete" BEFORE DELETE ON "InvoiceRun"
  FOR EACH ROW EXECUTE FUNCTION "factory_invoice_run_delete"();
CREATE TRIGGER "InvoiceRun_no_truncate" BEFORE TRUNCATE ON "InvoiceRun"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_tax_refuse_truncate"();

-- =====================================================================================================================
-- DepositCancellationRule (FIN-080)
--   every row  the share kept 0 to 100, above 0 exactly for KEEP_PERCENT; REFUND_DOUBLE only for a caparra (confirmatoria
--              or penitenziale) when we cancel (c.c. artt. 1385, 1386); all kept → no document; a note of 1-500. One
--              ACTIVE rule per company, kind, side and order type: the partial unique DepositCancellationRule_one_active.
--   UPDATE     the company, kind, side, order type and creation never change.
--   DELETE     refused (archived). TRUNCATE refused.
CREATE FUNCTION "factory_deposit_cancellation_rule_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."depositKind", NEW."cancelledBy", NEW."madeToMeasure", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."depositKind", OLD."cancelledBy", OLD."madeToMeasure", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'invoicing: the company, deposit kind, side and order type of deposit rule % never change (archive it, make another)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."keepPct" < 0 OR NEW."keepPct" > 100 OR (NEW."refundRule" = 'KEEP_PERCENT') <> (NEW."keepPct" > 0) THEN
    RAISE EXCEPTION 'invoicing: deposit rule % keeps a share from 0 to 100 percent, above 0 exactly when it keeps a percent (not % with %)', NEW."id", NEW."keepPct", NEW."refundRule"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."refundRule" = 'REFUND_DOUBLE' AND (NEW."depositKind" NOT IN ('CAPARRA', 'CAPARRA_PENITENZIALE') OR NEW."cancelledBy" <> 'COMPANY') THEN
    RAISE EXCEPTION 'invoicing: deposit rule % pays back double only a caparra when we cancel (c.c. artt. 1385, 1386)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."keepPct" = 100 AND NEW."documentKind" <> 'NONE' THEN
    RAISE EXCEPTION 'invoicing: deposit rule % keeps all of it; nothing is paid back, so no document follows', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 500, true) THEN
    RAISE EXCEPTION 'invoicing: the note of deposit rule % is 1 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "DepositCancellationRule_check" AFTER INSERT OR UPDATE ON "DepositCancellationRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_deposit_cancellation_rule_check"();
CREATE TRIGGER "DepositCancellationRule_never_deleted" BEFORE DELETE ON "DepositCancellationRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_tax_never_deleted"();
CREATE TRIGGER "DepositCancellationRule_no_truncate" BEFORE TRUNCATE ON "DepositCancellationRule"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_tax_refuse_truncate"();
CREATE UNIQUE INDEX "DepositCancellationRule_one_active" ON "DepositCancellationRule"
  ("tenantId", "companyId", "depositKind", "cancelledBy", (coalesce("madeToMeasure"::text, 'any'))) WHERE "status" = 'ACTIVE';

-- =====================================================================================================================
-- Currency (PLT-132)
--   every row  an ISO 4217 code; minor units 0 to 4; the company's base currency (Company.currency) never switched off.
--              One active row per company and code: the partial unique Currency_one_active.
--   UPDATE     the company, code, minor units and creation never change.
--   DELETE     refused (switched off). TRUNCATE refused.
CREATE FUNCTION "factory_currency_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."code", NEW."minorUnits", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."code", OLD."minorUnits", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'currency: the company, code and minor units of currency % never change (only switched on or off)', OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_tax_currency_code_ok"(NEW."code") THEN
    RAISE EXCEPTION 'currency: a currency is an ISO 4217 code of three capitals ("USD"), not "%"', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."minorUnits" < 0 OR NEW."minorUnits" > 4 THEN
    RAISE EXCEPTION 'currency: % has 0 to 4 minor-unit digits (ISO 4217), not %', NEW."code", NEW."minorUnits"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT NEW."active" THEN
    SELECT c."currency" INTO base FROM "Company" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."companyId";
    IF FOUND AND base = NEW."code" THEN
      RAISE EXCEPTION 'currency: % is the company''s base currency; it is never switched off', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Currency_check" AFTER INSERT OR UPDATE ON "Currency"
  FOR EACH ROW EXECUTE FUNCTION "factory_currency_check"();
CREATE TRIGGER "Currency_never_deleted" BEFORE DELETE ON "Currency"
  FOR EACH ROW EXECUTE FUNCTION "factory_tax_never_deleted"();
CREATE TRIGGER "Currency_no_truncate" BEFORE TRUNCATE ON "Currency"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_tax_refuse_truncate"();
CREATE UNIQUE INDEX "Currency_one_active" ON "Currency" ("tenantId", "companyId", "code") WHERE "active";

-- =====================================================================================================================
-- ExchangeRate (PLT-132, PLT-133)
--   every row  base and quote ISO 4217 codes, different; an ECB rate's base is EUR; the rate above 0; the day not in the
--              future (Europe/Rome); MANUAL exactly with the person who typed it; the key begins with
--              "<base>:<quote>:<YYYY-MM-DD>:<source>" (one rate per base, quote, day and source).
--   UPDATE     the base, quote, day, source, key and creation never change; an ECB rate never changes (what the file said);
--              a MANUAL rate is corrected with its person.
--   DELETE     only a MANUAL rate (the day falls back to the ECB's). TRUNCATE refused.
CREATE FUNCTION "factory_exchange_rate_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prefix text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."source" = 'ECB' THEN
      RAISE EXCEPTION 'currency: the ECB rate % is what the ECB''s file said; it never changes (type a manual rate for the day)', OLD."key"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."base", NEW."quote", NEW."rateDate", NEW."source", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."base", OLD."quote", OLD."rateDate", OLD."source", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'currency: the currencies, day and source of rate % never change (only a manual rate is corrected)', OLD."key"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_tax_currency_code_ok"(NEW."base") OR NOT "factory_tax_currency_code_ok"(NEW."quote") OR NEW."base" = NEW."quote" THEN
    RAISE EXCEPTION 'currency: a rate is between two different ISO 4217 currencies, not % and %', NEW."base", NEW."quote"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."source" = 'ECB' AND NEW."base" <> 'EUR' THEN
    RAISE EXCEPTION 'currency: the ECB''s reference rates are against the euro; an ECB rate''s base is EUR, not %', NEW."base"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."rate" <= 0 THEN
    RAISE EXCEPTION 'currency: the rate of % to % on % is above 0', NEW."base", NEW."quote", NEW."rateDate"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."rateDate" > "factory_money_rome_day"(now()) THEN
    RAISE EXCEPTION 'currency: no rate is known for % yet (the day is in the future)', NEW."rateDate"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."source" = 'MANUAL') <> (NEW."overriddenById" IS NOT NULL) THEN
    RAISE EXCEPTION 'currency: a manual rate names the person who typed it, an ECB rate nobody (% to % on %)', NEW."base", NEW."quote", NEW."rateDate"
      USING ERRCODE = 'check_violation';
  END IF;
  prefix := concat_ws(':', NEW."base", NEW."quote", to_char(NEW."rateDate", 'YYYY-MM-DD'), NEW."source"::text);
  IF NEW."key" IS NULL OR left(NEW."key", length(prefix)) <> prefix THEN
    RAISE EXCEPTION 'currency: the rate of % to % on % (%) is keyed "%", not "%"', NEW."base", NEW."quote", NEW."rateDate", NEW."source", prefix, NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_exchange_rate_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."source" <> 'MANUAL' THEN
    RAISE EXCEPTION 'currency: the ECB rate % is kept; only a manual rate is removed', OLD."key"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "ExchangeRate_check" AFTER INSERT OR UPDATE ON "ExchangeRate"
  FOR EACH ROW EXECUTE FUNCTION "factory_exchange_rate_check"();
CREATE TRIGGER "ExchangeRate_delete" BEFORE DELETE ON "ExchangeRate"
  FOR EACH ROW EXECUTE FUNCTION "factory_exchange_rate_delete"();
CREATE TRIGGER "ExchangeRate_no_truncate" BEFORE TRUNCATE ON "ExchangeRate"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_tax_refuse_truncate"();

-- =====================================================================================================================
-- PaymentTerms (FIN-076): its own trigger on the two new columns (W2a's factory_payment_terms_guard untouched).
--   every row  skipped months 1 to 12, each once, at most 11.
CREATE FUNCTION "factory_payment_terms_due_conventions_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."skipMonths" IS NULL OR array_position(NEW."skipMonths", NULL) IS NOT NULL OR cardinality(NEW."skipMonths") > 11
     OR (SELECT count(DISTINCT m) FROM unnest(NEW."skipMonths") AS m) <> cardinality(NEW."skipMonths")
     OR EXISTS (SELECT 1 FROM unnest(NEW."skipMonths") AS m WHERE m < 1 OR m > 12) THEN
    RAISE EXCEPTION 'pricing: payment terms % skip months 1 to 12, each once, at most 11 (not %)', NEW."code", NEW."skipMonths"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PaymentTerms_due_conventions_check" AFTER INSERT OR UPDATE OF "skipMonths", "fromEndOfMonth" ON "PaymentTerms"
  FOR EACH ROW EXECUTE FUNCTION "factory_payment_terms_due_conventions_check"();

-- =====================================================================================================================
-- Invoice (FIN-063, FIN-068, FIN-071, FIN-095, FIN-100): its own trigger on the new columns (W1's factory_invoice_guard
-- untouched: it freezes them with every other column from the issue on).
--   every row  the language an ISO 639-1 code; the rate, its day and the euro total all three or none, none in euro, the
--              rate above 0, the euro total 0 or more, the day not after the invoice's date; a TD05 (and only a TD05) names
--              the invoice it adds to: issued, a TD01 or TD24 (and, at the issue, dated on or before it).
--   run        named or changed: the run is a PREVIEW (locked FOR SHARE) that picks the invoice's customer.
--   declaration named or changed: the company's declarations switch is on (GATE-ACCOUNTANT) and the declaration is not
--              revoked; at the issue also: checked on the tax agency's site, of the invoice's year, dated on or before
--              it, and the VAT summary has an N3.5 entry.
--   issue      a TD16-TD19 leaves DRAFT only while the company's self-invoice switch is on (GATE-ACCOUNTANT); a STAMP_DUTY
--              charge line equals the invoice's stamp duty, in euro.
CREATE FUNCTION "factory_invoice_tax_currency_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  issuing boolean := TG_OP = 'UPDATE' AND OLD."status" = 'DRAFT' AND NEW."status" <> 'DRAFT';
  other record;
  run record;
  doi record;
  stamp_lines bigint;
  stamp_net bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF NEW."language" IS NOT NULL AND NEW."language" !~ '^[a-z]{2}$' THEN
    RAISE EXCEPTION 'invoicing: invoice % is written in a language named by its ISO 639-1 code ("de"), not "%"', NEW."id", NEW."language"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((NEW."exchangeRate" IS NULL AND NEW."rateDate" IS NULL AND NEW."totalEur" IS NULL)
          OR (NEW."exchangeRate" IS NOT NULL AND NEW."rateDate" IS NOT NULL AND NEW."totalEur" IS NOT NULL))
     OR (NEW."exchangeRate" IS NOT NULL AND (NEW."currency" = 'EUR' OR NEW."exchangeRate" <= 0 OR NEW."totalEur" < 0)) THEN
    RAISE EXCEPTION 'invoicing: invoice % in % keeps its rate (above 0), the rate''s day and its total in euro, all three or none (none in euro)', NEW."id", NEW."currency"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."rateDate" IS NOT NULL AND NEW."issueDate" IS NOT NULL AND NEW."rateDate" > NEW."issueDate" THEN
    RAISE EXCEPTION 'invoicing: the rate of invoice % is of %, after its date %', NEW."id", NEW."rateDate", NEW."issueDate"
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW."docType" = 'TD05') <> (NEW."debitOfId" IS NOT NULL) THEN
    RAISE EXCEPTION 'invoicing: a debit note TD05 (and only a TD05) names the invoice it adds charges to (invoice %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."debitOfId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."debitOfId" IS DISTINCT FROM OLD."debitOfId" OR issuing) THEN
    SELECT o."status"::text AS status, o."docType"::text AS doc_type, o."issueDate" AS issue_date INTO other
      FROM "Invoice" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."debitOfId";
    IF FOUND AND (other.status = 'DRAFT' OR other.doc_type NOT IN ('TD01', 'TD24')) THEN
      RAISE EXCEPTION 'invoicing: debit note % adds to invoice %, a % %; a debit note adds to an issued TD01 or TD24', NEW."id", NEW."debitOfId", other.status, other.doc_type
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND issuing AND other.issue_date > NEW."issueDate" THEN
      RAISE EXCEPTION 'invoicing: debit note % (dated %) adds to invoice % dated after it (%)', NEW."id", NEW."issueDate", NEW."debitOfId", other.issue_date
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."invoiceRunId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."invoiceRunId" IS DISTINCT FROM OLD."invoiceRunId") THEN
    SELECT r."status"::text AS status, r."partyIds" AS party_ids INTO run
      FROM "InvoiceRun" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."invoiceRunId" FOR SHARE;
    IF FOUND AND (run.status <> 'PREVIEW' OR NOT (NEW."buyerPartyId" = ANY (run.party_ids))) THEN
      RAISE EXCEPTION 'invoicing: invoice % goes into invoice run % only while it is a PREVIEW that picks its customer', NEW."id", NEW."invoiceRunId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."declarationOfIntentId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."declarationOfIntentId" IS DISTINCT FROM OLD."declarationOfIntentId" OR issuing) THEN
    IF NOT "factory_tax_switch_on"(NEW."tenantId", NEW."companyId", 'declarationsOfIntentOn') THEN
      RAISE EXCEPTION 'invoicing: declarations of intent are switched off for this company until the accountant confirms them (GATE-ACCOUNTANT); invoice % names none', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT d."protocolNumber" AS protocol, d."protocolDate" AS protocol_date, d."year" AS year, d."checkedAt" AS checked_at, d."revokedAt" AS revoked_at INTO doi
      FROM "DeclarationOfIntent" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."declarationOfIntentId";
    IF FOUND AND doi.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'invoicing: declaration of intent % was revoked; invoice % cannot rest on it', doi.protocol, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND issuing AND (doi.checked_at IS NULL OR doi.year <> NEW."year" OR doi.protocol_date > NEW."issueDate") THEN
      RAISE EXCEPTION 'invoicing: invoice % (%, %) rests on declaration of intent % only once it is checked on the tax agency''s site, of the invoice''s year and dated on or before it', NEW."id", NEW."year", NEW."issueDate", doi.protocol
        USING ERRCODE = 'check_violation';
    END IF;
    IF issuing AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."vatSummary") AS e WHERE e ->> 'nature' = 'N3.5') THEN
      RAISE EXCEPTION 'invoicing: invoice % names a declaration of intent; its VAT summary has the N3.5 lines it covers', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF issuing THEN
    IF NEW."docType" IN ('TD16', 'TD17', 'TD18', 'TD19') AND NOT "factory_tax_switch_on"(NEW."tenantId", NEW."companyId", 'selfInvoicesOn') THEN
      RAISE EXCEPTION 'invoicing: self-invoices are switched off for this company until the accountant confirms them (GATE-ACCOUNTANT); % % is not issued', NEW."docType", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*), coalesce(sum(l."netAmount"), 0) INTO stamp_lines, stamp_net FROM "InvoiceLine" l
     WHERE l."tenantId" = NEW."tenantId" AND l."invoiceId" = NEW."id" AND l."chargeKind" = 'STAMP_DUTY';
    IF stamp_lines > 0 AND (NEW."stampDutyAmount" IS NULL OR stamp_net <> NEW."stampDutyAmount" OR NEW."currency" <> 'EUR') THEN
      RAISE EXCEPTION 'invoicing: invoice % charges stamp duty of % to the customer; it carries that stamp duty (%), in euro', NEW."id", stamp_net, coalesce(NEW."stampDutyAmount"::text, 'none')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Invoice_tax_currency_check" AFTER INSERT OR UPDATE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION "factory_invoice_tax_currency_check"();

-- =====================================================================================================================
-- InvoiceLine (FIN-101, Owner 11-13): the stamp duty charged to the customer, its own trigger (W1/W2a's
-- factory_invoice_line_guard untouched).
--   STAMP_DUTY  a CHARGE (W2a's rule) of one unit at rate 0 with Natura N1 (escluso art. 15), above 0, on an invoice in
--               euro of a company whose stamp duty switch is on (GATE-ACCOUNTANT); at most one per invoice: the partial
--               unique InvoiceLine_one_stamp_duty.
CREATE FUNCTION "factory_invoice_line_stamp_duty_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv record;
BEGIN
  IF NEW."chargeKind" IS DISTINCT FROM 'STAMP_DUTY' OR (TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD) THEN
    RETURN NULL;
  END IF;
  IF NEW."quantity" <> 1 OR NEW."netAmount" <= 0 OR NEW."vatRatePct" <> 0 OR NEW."vatNature" IS DISTINCT FROM 'N1' THEN
    RAISE EXCEPTION 'invoicing: the stamp duty charged on line % is one unit above 0 at rate 0 with Natura N1 (escluso art. 15 DPR 633/1972)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."companyId" AS company, i."currency" AS currency INTO inv FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";
  IF FOUND AND inv.currency <> 'EUR' THEN
    RAISE EXCEPTION 'invoicing: stamp duty is charged in euro; invoice % is in %', NEW."invoiceId", inv.currency
      USING ERRCODE = 'check_violation';
  END IF;
  IF FOUND AND (TG_OP = 'INSERT' OR OLD."chargeKind" IS DISTINCT FROM 'STAMP_DUTY') AND NOT "factory_tax_switch_on"(NEW."tenantId", inv.company, 'stampDutyOn') THEN
    RAISE EXCEPTION 'invoicing: charging stamp duty to the customer is switched off for this company until the accountant confirms it (GATE-ACCOUNTANT); line % is not added', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "InvoiceLine_stamp_duty_check" AFTER INSERT OR UPDATE ON "InvoiceLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_invoice_line_stamp_duty_check"();
CREATE UNIQUE INDEX "InvoiceLine_one_stamp_duty" ON "InvoiceLine" ("tenantId", "invoiceId") WHERE "chargeKind" = 'STAMP_DUTY';

-- =====================================================================================================================
-- factory_invoice_check_issue, the whole body of 202610307001_money_w2a_guards, word for word, with one change: a TD16,
-- TD17, TD18 or TD19 (a self-invoice) may also be numbered from a fiscal SELF_INVOICE series (its own sezionale).
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
