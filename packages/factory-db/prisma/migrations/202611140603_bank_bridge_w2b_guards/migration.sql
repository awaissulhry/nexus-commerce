-- Written by hand (Prisma does not model triggers or partial unique indexes), after the generated
-- …_bank_bridge_w2b_schema and before the policy migration. When the migrations are renumbered, keep this file as it is
-- under its new timestamp.

-- Bank, receivables, payables and the accountant's bridge (W2b-6, schema wave 50/57, B-W2b-370; bank.prisma). These rules
-- hold for every login, the owner included; apps/factory-api's commands (B-W2b-393, -402, -403, -408) check them first in
-- words. Every refusal is a check_violation (SQLSTATE 23514) in words. The row guards are AFTER triggers (the policies
-- speak first); the refused deletes are BEFORE triggers. An UPDATE that changes nothing passes. A rule that reads another
-- row skips one the session cannot see (the isolation tests' copies). Rules that need every line of a batch, a proposal or
-- an export are checked when it is issued, approved or exported (a draft may hold a line twice meanwhile).
--
-- Reused as they are: suppliers' `factory_supplier_iban_ok`, `factory_supplier_list_ok`, `factory_supplier_office_person_ok`;
-- recall's `factory_recall_words_ok`, `factory_recall_not_future`, `factory_recall_model_name_ok`; money's
-- `factory_money_lock`, `factory_money_rome_day`, `factory_invoice_credited`.
--
-- Redefined, each from its whole latest body (…_followups_quality_money_w2b_guards), word for word plus the write-offs:
-- `factory_payment_allocation_check` (a payment's allocations, refunds and OVERPAYMENT write-offs never pass it; an
-- invoice's allocations and UNDERPAYMENT write-offs never pass what it is open for; an allocation with a standing
-- write-off is reversed after it) and `factory_refund_guard` (a payment's refunds count its OVERPAYMENT write-offs). Their
-- messages stay as they were while nothing is written off. Own triggers on W1/W2a tables: `Payment_write_offs_check`,
-- `PaymentReminder_stopped`, `AccountingExport_documents_once`, `ReceivablesSettings_bank_check`,
-- `Party_reminder_trusted_check`. At the end, the data copy: each company's Company bank columns become its first
-- BankAccount.

CREATE FUNCTION "factory_bank_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bank: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_bank_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bank: % % is kept, never deleted (its history is the record)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

-- The append-only ledgers of this wave (scripts/factory/check-append-only.mjs): PaymentWriteOff and IntegrityCheckRun. No
-- login changes or removes a row, the owner included; the runtime roles have no UPDATE, DELETE or TRUNCATE grant either.
CREATE FUNCTION "factory_bank_ledger_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a write-off and an integrity check run are kept as they were written (a wrong write-off is reversed by a new row)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- Today, in Rome (the business day).
CREATE FUNCTION "factory_bank_today"() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT "factory_money_rome_day"(now())
$$;

-- A fingerprint or code: 1 to 200 characters, no white space.
CREATE FUNCTION "factory_bank_fingerprint_ok"(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL AND value ~ '^\S{1,200}$'
$$;

-- A whole JSON number (no float in JSON money).
CREATE FUNCTION "factory_bank_json_int_ok"(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL AND jsonb_typeof(value) = 'number' AND (value #>> '{}') ~ '^-?[0-9]{1,15}$'
$$;

-- A stored file of the company with the record type (its record id is the API's: a file is made for the record first).
CREATE FUNCTION "factory_bank_file_ok"(tenant uuid, file uuid, company uuid, record_type text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT file IS NULL
      OR NOT EXISTS (SELECT 1 FROM "StoredFile" f WHERE f."tenantId" = tenant AND f."id" = file)
      OR EXISTS (SELECT 1 FROM "StoredFile" f WHERE f."tenantId" = tenant AND f."id" = file AND f."recordType" = record_type AND f."companyId" IS NOT DISTINCT FROM company)
$$;

-- The receivables settings in force for a company: its own row, else the tenant-wide row (a null on the company's row
-- follows the tenant-wide row for the tolerance; the switches are the row's own).
CREATE FUNCTION "factory_bank_write_off_tolerance"(tenant uuid, company uuid) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT s."writeOffToleranceAmount" FROM "ReceivablesSettings" s WHERE s."tenantId" = tenant AND s."companyId" = company LIMIT 1),
    (SELECT s."writeOffToleranceAmount" FROM "ReceivablesSettings" s WHERE s."tenantId" = tenant AND s."companyId" IS NULL LIMIT 1))
$$;

CREATE FUNCTION "factory_bank_riba_on"(tenant uuid, company uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT s."ribaOn" FROM "ReceivablesSettings" s WHERE s."tenantId" = tenant AND s."companyId" = company LIMIT 1),
    (SELECT s."ribaOn" FROM "ReceivablesSettings" s WHERE s."tenantId" = tenant AND s."companyId" IS NULL LIMIT 1),
    false)
$$;

-- =====================================================================================================================
-- BankAccount (FIN-130)
--   UPDATE     an UPDATE that changes nothing passes; the company, the IBAN, the currency and the creation never change
--              (another IBAN is another account); the holder, BIC, bank name and the switch change.
--   every row  the holder 1 to 140 characters on one line; the IBAN's check digits hold (ISO 7064 mod 97-10); the BIC, when
--              given, 8 or 11 letters and digits; the bank's name 1 to 140 characters on one line; an ISO currency.
--   unique     one live account per company and IBAN (BankAccount_one_live_iban).
--   DELETE     refused (switched off instead). TRUNCATE refused.
CREATE FUNCTION "factory_bank_account_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."iban", NEW."currency", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."iban", OLD."currency", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'bank: the company, IBAN, currency and creation of bank account % never change (another IBAN is another account)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."holder" IS NULL OR NOT "factory_recall_words_ok"(NEW."holder", 140, false) THEN
    RAISE EXCEPTION 'bank: bank account % names its holder (1 to 140 characters, one line)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_supplier_iban_ok"(NEW."iban") THEN
    RAISE EXCEPTION 'bank: the IBAN of bank account % is not an IBAN whose check digits hold (a country, two check digits, 11 to 30 letters or digits; upper case, no spaces)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."bic" IS NOT NULL AND NEW."bic" !~ '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$' THEN
    RAISE EXCEPTION 'bank: the BIC of bank account % is not a BIC (8 or 11 letters and digits)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."bankName", 140, false) OR NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'bank: bank account % has a bank name of 1 to 140 characters on one line (or none) and an ISO currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "BankAccount_guard" AFTER INSERT OR UPDATE ON "BankAccount"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_account_guard"();
CREATE TRIGGER "BankAccount_never_deleted" BEFORE DELETE ON "BankAccount"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_never_deleted"();
CREATE TRIGGER "BankAccount_no_truncate" BEFORE TRUNCATE ON "BankAccount"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_refuse_truncate"();
CREATE UNIQUE INDEX "BankAccount_one_live_iban" ON "BankAccount" ("tenantId", "companyId", "iban") WHERE "active";

-- =====================================================================================================================
-- BankStatement (FIN-130)
--   INSERT     into a live account; the period's first day not after its last, the last not after today (Rome); the file
--              a StoredFile of the company with record type BankStatement; imported not in the future.
--   UPDATE     what the bank said never changes (an UPDATE that changes nothing passes).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_bank_statement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'bank: statement % is what the bank said; it never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."periodStart" > NEW."periodEnd" OR NEW."periodEnd" > "factory_bank_today"() THEN
    RAISE EXCEPTION 'bank: statement % covers % to %; its first day is not after its last, and its last is not after today', NEW."id", NEW."periodStart", NEW."periodEnd"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT b."active" AS active INTO account FROM "BankAccount" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."bankAccountId";
  IF FOUND AND NOT account.active THEN
    RAISE EXCEPTION 'bank: bank account % is switched off; no statement is imported into it', NEW."bankAccountId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bank_file_ok"(NEW."tenantId", NEW."fileId", NEW."companyId", 'BankStatement') THEN
    RAISE EXCEPTION 'bank: the file of statement % is not a file of the company kept for a bank statement', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."importedAt") THEN
    RAISE EXCEPTION 'bank: statement % is not imported in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "BankStatement_guard" AFTER INSERT OR UPDATE ON "BankStatement"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_statement_guard"();
CREATE TRIGGER "BankStatement_never_deleted" BEFORE DELETE ON "BankStatement"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_never_deleted"();
CREATE TRIGGER "BankStatement_no_truncate" BEFORE TRUNCATE ON "BankStatement"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_refuse_truncate"();

-- =====================================================================================================================
-- BankLine (FIN-130)
--   INSERT     an amount other than 0 in the account's currency; the booking day inside its statement's period; the bank's
--              reference 1 to 100 characters on one line, the reference text at most 1000, the other side's name 1 to 140
--              on one line and its IBAN upper case without spaces (each when given); the fingerprint 1 to 200 characters
--              without spaces. A line imported twice into the account is refused by the unique key (23505).
--   UPDATE     never changes (an UPDATE that changes nothing passes).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_bank_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  statement record;
  account_currency text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'bank: bank line % is what the bank said; it never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amount" = 0 OR NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'bank: bank line % has an amount other than 0 (money in above 0, out below 0) and an ISO currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."periodStart" AS first_day, s."periodEnd" AS last_day INTO statement FROM "BankStatement" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."statementId";
  IF FOUND AND NEW."bookedOn" NOT BETWEEN statement.first_day AND statement.last_day THEN
    RAISE EXCEPTION 'bank: bank line % is booked on %, outside its statement''s days (% to %)', NEW."id", NEW."bookedOn", statement.first_day, statement.last_day
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT b."currency" INTO account_currency FROM "BankAccount" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."bankAccountId";
  IF FOUND AND account_currency <> NEW."currency" THEN
    RAISE EXCEPTION 'bank: bank line % is in %, its account in %', NEW."id", NEW."currency", account_currency
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."bankReference", 100, false) OR NOT "factory_recall_words_ok"(NEW."referenceText", 1000, true)
     OR NOT "factory_recall_words_ok"(NEW."counterpartyName", 140, false)
     OR (NEW."counterpartyIban" IS NOT NULL AND NEW."counterpartyIban" !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$') THEN
    RAISE EXCEPTION 'bank: bank line % has a bank reference of 1 to 100 characters on one line, a reference text of at most 1000, the other side''s name of 1 to 140 on one line and its IBAN upper case without spaces (each when given)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bank_fingerprint_ok"(NEW."fingerprint") THEN
    RAISE EXCEPTION 'bank: the fingerprint of bank line % is 1 to 200 characters without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "BankLine_guard" AFTER INSERT OR UPDATE ON "BankLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_line_guard"();
CREATE TRIGGER "BankLine_never_deleted" BEFORE DELETE ON "BankLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_never_deleted"();
CREATE TRIGGER "BankLine_no_truncate" BEFORE TRUNCATE ON "BankLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_refuse_truncate"();

-- =====================================================================================================================
-- BankMatch (FIN-132, FIN-117)
--   INSERT     a suggestion, or a person's choice accepted at once; never reversed at insert. Money in (the line above 0):
--              no supplier invoice; issued TD01 / TD24 invoices of the company to the party in the line's currency and
--              deposit requests of the company and party in it (each once, at most 50 in all), or a payment recorded by
--              hand with no items. Money out (below 0): exactly one supplier invoice of the company and party (an INVOICE,
--              not VOIDED, in the line's currency), no items, no payment.
--   UPDATE     an UPDATE that changes nothing passes; the line, party, items, supplier invoice, how sure, why and the
--              creation never change; a suggestion is accepted once (who, when; money in: with the payment it recorded),
--              then the acceptance never changes; an accepted match is reversed once (who, when, why; the payment the
--              acceptance recorded VOIDED first), then frozen.
--   every row  at least one reason, each once; accepted with who and when, not in the future; money in accepted with its
--              payment; reversed only once accepted, with who, when (not before the acceptance) and why (1 to 500).
--   payment    when it is named: RECEIVED, of the line's amount and currency.
--   unique     one live acceptance per line (BankMatch_one_accepted_per_line) and per payment (BankMatch_one_line_per_payment).
--   DELETE     only a suggestion (not accepted). TRUNCATE refused.
CREATE FUNCTION "factory_bank_match_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line record;
  target record;
  item uuid;
  items int := cardinality(NEW."invoiceIds") + cardinality(NEW."depositRequestIds");
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."bankLineId", NEW."partyId", NEW."invoiceIds", NEW."depositRequestIds", NEW."supplierInvoiceId",
        NEW."confidence", NEW."reasons", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."bankLineId", OLD."partyId", OLD."invoiceIds", OLD."depositRequestIds", OLD."supplierInvoiceId",
        OLD."confidence", OLD."reasons", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'bank: what match % suggests (the line, the party, the items, how sure and why) never changes; another one is a new match', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."reversedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'bank: match % is reversed; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."acceptedAt" IS NOT NULL
       AND (NEW."acceptedAt", NEW."acceptedById", NEW."paymentId") IS DISTINCT FROM (OLD."acceptedAt", OLD."acceptedById", OLD."paymentId") THEN
      RAISE EXCEPTION 'bank: match % is accepted; who accepted it, when and its payment never change (a wrong one is reversed)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."acceptedAt" IS NULL AND NEW."acceptedAt" IS NULL AND NEW."paymentId" IS DISTINCT FROM OLD."paymentId" THEN
      RAISE EXCEPTION 'bank: the payment of match % is named with its acceptance', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."reversedAt" IS NOT NULL OR NEW."reversedById" IS NOT NULL OR NEW."reverseReason" IS NOT NULL THEN
    RAISE EXCEPTION 'bank: match % is not reversed when it is made', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."invoiceIds" IS NULL OR NEW."depositRequestIds" IS NULL OR NEW."reasons" IS NULL THEN
    RAISE EXCEPTION 'bank: match % has lists of invoices, deposit requests and reasons (empty, not missing)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_supplier_list_ok"(NEW."invoiceIds") OR NOT "factory_supplier_list_ok"(NEW."depositRequestIds") OR items > 50 THEN
    RAISE EXCEPTION 'bank: match % names each invoice and deposit request once, at most 50 in all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW."reasons") = 0 OR NOT "factory_supplier_list_ok"(NEW."reasons") THEN
    RAISE EXCEPTION 'bank: match % says why: at least one reason, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."acceptedAt" IS NULL) <> (NEW."acceptedById" IS NULL) OR NOT "factory_recall_not_future"(NEW."acceptedAt") THEN
    RAISE EXCEPTION 'bank: match % is accepted with who and when (not in the future), or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."reversedAt" IS NULL) <> (NEW."reversedById" IS NULL) OR (NEW."reversedAt" IS NULL) <> (NEW."reverseReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."reverseReason", 500, true)
     OR (NEW."reversedAt" IS NOT NULL AND (NEW."acceptedAt" IS NULL OR NEW."reversedAt" < NEW."acceptedAt" OR NOT "factory_recall_not_future"(NEW."reversedAt"))) THEN
    RAISE EXCEPTION 'bank: match % is reversed only once accepted, with who, when (not before the acceptance, not in the future) and why (1 to 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT l."amount" AS amount, l."currency" AS currency INTO line FROM "BankLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."bankLineId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF line.amount > 0 THEN
    IF NEW."supplierInvoiceId" IS NOT NULL OR (items = 0 AND NEW."paymentId" IS NULL) THEN
      RAISE EXCEPTION 'bank: match % is for money in: it names the customer''s open items it pays, or the payment it is, never a supplier invoice', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."acceptedAt" IS NOT NULL AND NEW."paymentId" IS NULL THEN
      RAISE EXCEPTION 'bank: match % of money in is accepted with the payment it recorded', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."supplierInvoiceId" IS NULL OR items > 0 OR NEW."paymentId" IS NOT NULL THEN
    RAISE EXCEPTION 'bank: match % is for money out: it names the one supplier invoice it paid, no customer item or payment', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    FOREACH item IN ARRAY NEW."invoiceIds" LOOP
      SELECT i."status"::text AS status, i."docType"::text AS doc_type, i."companyId" AS company, i."buyerPartyId" AS party, i."currency" AS currency
        INTO target FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = item;
      IF FOUND AND (target.status = 'DRAFT' OR target.doc_type NOT IN ('TD01', 'TD24') OR target.company <> NEW."companyId"
                    OR target.party <> NEW."partyId" OR target.currency <> line.currency) THEN
        RAISE EXCEPTION 'bank: match % names invoice %, which is not an issued TD01 or TD24 of the company to the party in %', NEW."id", item, line.currency
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    FOREACH item IN ARRAY NEW."depositRequestIds" LOOP
      SELECT r."companyId" AS company, r."partyId" AS party, r."currency" AS currency
        INTO target FROM "DepositRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = item;
      IF FOUND AND (target.company <> NEW."companyId" OR target.party <> NEW."partyId" OR target.currency <> line.currency) THEN
        RAISE EXCEPTION 'bank: match % names deposit request %, which is not one of the company to the party in %', NEW."id", item, line.currency
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    IF NEW."supplierInvoiceId" IS NOT NULL THEN
      SELECT s."kind"::text AS kind, s."status"::text AS status, s."currency" AS currency
        INTO target FROM "SupplierInvoice" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."supplierInvoiceId";
      IF FOUND AND (target.kind <> 'INVOICE' OR target.status = 'VOIDED' OR target.currency <> line.currency) THEN
        RAISE EXCEPTION 'bank: match % names supplier invoice %, which is a % % in %; money out pays a supplier''s invoice, not VOIDED, in %', NEW."id", NEW."supplierInvoiceId", target.status, target.kind, target.currency, line.currency
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."paymentId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."paymentId" IS NULL) THEN
    SELECT p."status"::text AS status, p."amount" AS amount, p."currency" AS currency
      INTO target FROM "Payment" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId";
    IF FOUND AND (target.status <> 'RECEIVED' OR target.amount <> abs(line.amount) OR target.currency <> line.currency) THEN
      RAISE EXCEPTION 'bank: match % names payment %, which is % for % %; the payment of a bank line is RECEIVED for the line''s % %', NEW."id", NEW."paymentId", target.status, target.amount, target.currency, abs(line.amount), line.currency
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."reversedAt" IS NOT NULL AND TG_OP = 'UPDATE' AND OLD."reversedAt" IS NULL AND NEW."paymentId" IS NOT NULL AND items > 0 THEN
    SELECT p."status"::text AS status INTO target FROM "Payment" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId";
    IF FOUND AND target.status <> 'VOIDED' THEN
      RAISE EXCEPTION 'bank: match % recorded payment %; void the payment first, then reverse the match', NEW."id", NEW."paymentId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_bank_match_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."acceptedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'bank: match % is accepted; it is kept (a wrong one is reversed), only a suggestion is deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "BankMatch_guard" AFTER INSERT OR UPDATE ON "BankMatch"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_match_guard"();
CREATE TRIGGER "BankMatch_delete_guard" BEFORE DELETE ON "BankMatch"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_match_delete_guard"();
CREATE TRIGGER "BankMatch_no_truncate" BEFORE TRUNCATE ON "BankMatch"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_refuse_truncate"();
CREATE UNIQUE INDEX "BankMatch_one_accepted_per_line" ON "BankMatch" ("tenantId", "bankLineId")
  WHERE "acceptedAt" IS NOT NULL AND "reversedAt" IS NULL;
CREATE UNIQUE INDEX "BankMatch_one_line_per_payment" ON "BankMatch" ("tenantId", "paymentId")
  WHERE "acceptedAt" IS NOT NULL AND "reversedAt" IS NULL AND "paymentId" IS NOT NULL;

-- =====================================================================================================================
-- PaymentWriteOff (FIN-119): append-only
--   every row  an amount above 0 (a reversal: below 0, with a note); an UNDERPAYMENT names an allocation of the payment to
--              an invoice (never a reversal, not reversed), an OVERPAYMENT none; a note of 1 to 500 characters, required
--              for OTHER; the tolerance 0 or more.
--   reversal   takes back a write-off of the same payment exactly (the same kind and allocation, the opposite amount), once.
--   else       the payment RECEIVED; the tolerance the company's in force (ReceivablesSettings: its row, else the tenant-wide
--              one; none set: nothing is written off) and the amount at most it; under the money locks of the payment and the
--              invoice (as the allocations): an OVERPAYMENT keeps the payment's allocations, live refunds and write-offs
--              within its amount; an UNDERPAYMENT keeps the invoice's allocations and write-offs within what it is open
--              for (its gross less its credit notes).
CREATE FUNCTION "factory_payment_write_off_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allocation record;
  original record;
  payment record;
  tolerance integer;
  allocated bigint;
  refunded bigint;
  written bigint;
  gross bigint;
  credited bigint;
BEGIN
  IF NEW."amount" = 0 OR (NEW."reversalOfId" IS NOT NULL) <> (NEW."amount" < 0) THEN
    RAISE EXCEPTION 'payments: write-off % has an amount above 0, or is a reversal with a negative amount', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'UNDERPAYMENT') <> (NEW."allocationId" IS NOT NULL) THEN
    RAISE EXCEPTION 'payments: write-off % is an UNDERPAYMENT on the allocation whose invoice is short-paid, or an OVERPAYMENT of the payment with no allocation', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 500, true)
     OR ((NEW."reason" = 'OTHER' OR NEW."reversalOfId" IS NOT NULL) AND NEW."note" IS NULL) OR NEW."toleranceAmount" < 0 THEN
    RAISE EXCEPTION 'payments: write-off % has a note of 1 to 500 characters (required for OTHER and on a reversal) and a tolerance of 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM "factory_money_lock"('payment', NEW."tenantId", NEW."paymentId");
  IF NEW."allocationId" IS NOT NULL THEN
    SELECT a."invoiceId" AS invoice, a."reversalOfId" AS reversal_of, a."amount" AS amount
      INTO allocation FROM "PaymentAllocation" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."allocationId";
    IF FOUND THEN
      IF allocation.reversal_of IS NOT NULL OR allocation.invoice IS NULL THEN
        RAISE EXCEPTION 'payments: write-off % is on allocation %, which is a reversal or pays a deposit request; an UNDERPAYMENT closes what an allocation left open on an invoice', NEW."id", NEW."allocationId"
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM "factory_money_lock"('invoice', NEW."tenantId", allocation.invoice);
      IF NEW."reversalOfId" IS NULL
         AND EXISTS (SELECT 1 FROM "PaymentAllocation" a WHERE a."tenantId" = NEW."tenantId" AND a."reversalOfId" = NEW."allocationId") THEN
        RAISE EXCEPTION 'payments: allocation % is reversed; nothing is written off on it', NEW."allocationId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."reversalOfId" IS NOT NULL THEN
    SELECT w."kind"::text AS kind, w."amount" AS amount, w."allocationId" AS allocation, w."reversalOfId" AS reversal_of
      INTO original FROM "PaymentWriteOff" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."reversalOfId";
    IF FOUND THEN
      IF original.reversal_of IS NOT NULL OR original.kind <> NEW."kind"::text OR original.allocation IS DISTINCT FROM NEW."allocationId"
         OR NEW."amount" <> -original.amount THEN
        RAISE EXCEPTION 'payments: reversal % takes back write-off % exactly: the same kind and allocation and the opposite amount (%), never a reversal', NEW."id", NEW."reversalOfId", -original.amount
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "PaymentWriteOff" w WHERE w."tenantId" = NEW."tenantId" AND w."reversalOfId" = NEW."reversalOfId" AND w."id" <> NEW."id") THEN
        RAISE EXCEPTION 'payments: write-off % is reversed already', NEW."reversalOfId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  tolerance := "factory_bank_write_off_tolerance"(NEW."tenantId", NEW."companyId");
  IF tolerance IS NULL THEN
    RAISE EXCEPTION 'payments: write-off %: the company has no write-off tolerance set (the accountant''s, in the receivables settings); nothing is written off', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."toleranceAmount" <> tolerance OR NEW."amount" > NEW."toleranceAmount" THEN
    RAISE EXCEPTION 'payments: write-off % of % passes the company''s write-off tolerance of % (or names another)', NEW."id", NEW."amount", tolerance
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT p."status"::text AS status, p."amount" AS amount INTO payment FROM "Payment" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF payment.status <> 'RECEIVED' THEN
    RAISE EXCEPTION 'payments: payment % is %; nothing is written off on it', NEW."paymentId", payment.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'OVERPAYMENT' THEN
    SELECT coalesce(sum(a."amount"), 0) INTO allocated FROM "PaymentAllocation" a WHERE a."tenantId" = NEW."tenantId" AND a."paymentId" = NEW."paymentId";
    SELECT coalesce(sum(r."amount"), 0) INTO refunded FROM "Refund" r WHERE r."tenantId" = NEW."tenantId" AND r."paymentId" = NEW."paymentId" AND r."status" IN ('DUE', 'PAID');
    -- This row included (an AFTER trigger sees it).
    SELECT coalesce(sum(w."amount"), 0) INTO written FROM "PaymentWriteOff" w WHERE w."tenantId" = NEW."tenantId" AND w."paymentId" = NEW."paymentId" AND w."kind" = 'OVERPAYMENT';
    IF allocated + refunded + written > payment.amount THEN
      RAISE EXCEPTION 'payments: payment % of % has % allocated, % refunded or due and % written off with write-off %; it passes the payment', NEW."paymentId", payment.amount, allocated, refunded, written, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF allocation.invoice IS NOT NULL THEN
    SELECT i."grossTotal" INTO gross FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = allocation.invoice;
    IF FOUND THEN
      credited := "factory_invoice_credited"(NEW."tenantId", allocation.invoice, NULL);
      SELECT coalesce(sum(a."amount"), 0) INTO allocated FROM "PaymentAllocation" a WHERE a."tenantId" = NEW."tenantId" AND a."invoiceId" = allocation.invoice;
      SELECT coalesce(sum(w."amount"), 0) INTO written FROM "PaymentWriteOff" w
        JOIN "PaymentAllocation" a ON a."tenantId" = w."tenantId" AND a."id" = w."allocationId"
       WHERE w."tenantId" = NEW."tenantId" AND a."invoiceId" = allocation.invoice AND w."kind" = 'UNDERPAYMENT';
      IF allocated + written > gross - credited THEN
        RAISE EXCEPTION 'payments: invoice % is open for % (gross %, credited %, paid %, written off % with write-off %); it passes the invoice', allocation.invoice, gross - credited - allocated - (written - NEW."amount"), gross, credited, allocated, written, NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PaymentWriteOff_check" AFTER INSERT ON "PaymentWriteOff"
  FOR EACH ROW EXECUTE FUNCTION "factory_payment_write_off_check"();
CREATE TRIGGER "PaymentWriteOff_append_only" BEFORE UPDATE OR DELETE ON "PaymentWriteOff"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_ledger_change"();
CREATE TRIGGER "PaymentWriteOff_no_truncate" BEFORE TRUNCATE ON "PaymentWriteOff"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_ledger_change"();

-- Payment (W1's guard untouched): a payment with a write-off still standing on it is not voided (reverse the write-off
-- first; an UNDERPAYMENT's allocation is reversed after its write-off already).
CREATE FUNCTION "factory_payment_write_offs_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PaymentWriteOff" w WHERE w."tenantId" = NEW."tenantId" AND w."paymentId" = NEW."id"
              GROUP BY w."paymentId" HAVING sum(w."amount") <> 0) THEN
    RAISE EXCEPTION 'payments: payment % has a write-off still standing; reverse the write-off before the payment is voided', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Payment_write_offs_check" AFTER UPDATE OF "status" ON "Payment"
  FOR EACH ROW WHEN (NEW."status" = 'VOIDED' AND OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "factory_payment_write_offs_check"();

-- =====================================================================================================================
-- RibaBatch (FIN-126)
--   INSERT     a DRAFT: no file, issue or cancellation.
--   UPDATE     an UPDATE that changes nothing passes; the company, the account and the creation never change; ISSUED and
--              CANCELLED never change; while DRAFT the window and the note change; DRAFT → ISSUED | CANCELLED.
--   every row  the window's first day not after its last, at most 366 days; a note of 1 to 2000 characters; the file, when
--              and who exactly from ISSUED on (the file a StoredFile of the company with record type RibaBatch, not in the
--              future); the cancellation (when, why: 1 to 500) exactly when CANCELLED.
--   → ISSUED   only while the company's Ri.Ba. switch is on (ReceivablesSettings.ribaOn: its row, else the tenant-wide one;
--              OFF by default: GATE-ACCOUNTANT); from a live account; with at least one item, each invoice instalment once
--              and in no other issued batch where it is ISSUED or PAID (under the company's Ri.Ba. lock).
--   DELETE     refused (a draft is cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_riba_batch_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account record;
  clash record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'receivables: Ri.Ba. batch % starts as a DRAFT', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."bankAccountId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."bankAccountId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'receivables: the company, bank account and creation of Ri.Ba. batch % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'receivables: Ri.Ba. batch % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."dueFrom" > NEW."dueTo" OR NEW."dueTo" - NEW."dueFrom" > 366 OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'receivables: Ri.Ba. batch % has a due window whose first day is not after its last (at most 366 days) and a note of 1 to 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ISSUED') <> (NEW."fileId" IS NOT NULL) OR (NEW."status" = 'ISSUED') <> (NEW."issuedAt" IS NOT NULL)
     OR (NEW."status" = 'ISSUED') <> (NEW."issuedById" IS NOT NULL) OR NOT "factory_recall_not_future"(NEW."issuedAt") THEN
    RAISE EXCEPTION 'receivables: Ri.Ba. batch % has its file, when and by whom it was issued exactly when ISSUED (not in the future)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."cancelReason", 500, true) THEN
    RAISE EXCEPTION 'receivables: Ri.Ba. batch % is cancelled exactly when CANCELLED, with why (1 to 500 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'ISSUED' AND TG_OP = 'UPDATE' THEN
    PERFORM "factory_money_lock"('riba', NEW."tenantId", NEW."companyId");
    IF NOT "factory_bank_riba_on"(NEW."tenantId", NEW."companyId") THEN
      RAISE EXCEPTION 'receivables: Ri.Ba. batch % is issued only while the company''s Ri.Ba. switch is on (off by default, until the accountant and the bank confirm)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT b."active" AS active INTO account FROM "BankAccount" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."bankAccountId";
    IF FOUND AND NOT account.active THEN
      RAISE EXCEPTION 'receivables: Ri.Ba. batch % collects through bank account %, which is switched off', NEW."id", NEW."bankAccountId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_bank_file_ok"(NEW."tenantId", NEW."fileId", NEW."companyId", 'RibaBatch') THEN
      RAISE EXCEPTION 'receivables: the file of Ri.Ba. batch % is not a file of the company kept for a Ri.Ba. batch', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "RibaItem" i WHERE i."tenantId" = NEW."tenantId" AND i."batchId" = NEW."id") THEN
      RAISE EXCEPTION 'receivables: Ri.Ba. batch % is issued with at least one instalment', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."invoiceId" AS invoice, i."instalment" AS instalment INTO clash FROM "RibaItem" i
     WHERE i."tenantId" = NEW."tenantId" AND i."batchId" = NEW."id"
     GROUP BY i."invoiceId", i."instalment" HAVING count(*) > 1 LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'receivables: Ri.Ba. batch % collects instalment % of invoice % twice', NEW."id", clash.instalment, clash.invoice
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."invoiceId" AS invoice, i."instalment" AS instalment, o."batchId" AS batch INTO clash FROM "RibaItem" i
      JOIN "RibaItem" o ON o."tenantId" = i."tenantId" AND o."invoiceId" = i."invoiceId" AND o."instalment" = i."instalment" AND o."batchId" <> i."batchId"
      JOIN "RibaBatch" b ON b."tenantId" = o."tenantId" AND b."id" = o."batchId"
     WHERE i."tenantId" = NEW."tenantId" AND i."batchId" = NEW."id" AND b."status" = 'ISSUED' AND o."status" IN ('ISSUED', 'PAID')
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'receivables: instalment % of invoice % is collected by Ri.Ba. batch % already', clash.instalment, clash.invoice, clash.batch
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RibaBatch_guard" AFTER INSERT OR UPDATE ON "RibaBatch"
  FOR EACH ROW EXECUTE FUNCTION "factory_riba_batch_guard"();
CREATE TRIGGER "RibaBatch_never_deleted" BEFORE DELETE ON "RibaBatch"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_never_deleted"();
CREATE TRIGGER "RibaBatch_no_truncate" BEFORE TRUNCATE ON "RibaBatch"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_refuse_truncate"();

-- =====================================================================================================================
-- RibaItem (FIN-126)
--   INSERT     ISSUED, not settled, while its batch is a DRAFT (the batch read FOR SHARE); the invoice an issued TD01 / TD24;
--              the instalment one of its payment terms (1 … n), the due day that instalment's and inside the batch's
--              window, the amount above 0 and at most the instalment's.
--   UPDATE     an UPDATE that changes nothing passes; what it collects and its creation never change; settled once, only
--              while its batch is ISSUED: ISSUED → PAID | UNPAID, then frozen.
--   every row  settled (the day: not before the due day, not after today) exactly when PAID or UNPAID; the bank's fee (0 or
--              more) exactly when UNPAID.
--   DELETE     only while its batch is a DRAFT. TRUNCATE refused.
CREATE FUNCTION "factory_riba_item_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch record;
  invoice record;
  entry jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ISSUED' OR NEW."settledOn" IS NOT NULL OR NEW."unpaidFee" IS NOT NULL THEN
      RAISE EXCEPTION 'receivables: Ri.Ba. item % starts ISSUED, not settled', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."amount" <= 0 OR NEW."instalment" < 1 THEN
      RAISE EXCEPTION 'receivables: Ri.Ba. item % collects an amount above 0 of instalment 1 or later', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT b."status"::text AS status, b."dueFrom" AS due_from, b."dueTo" AS due_to INTO batch
      FROM "RibaBatch" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."batchId" FOR SHARE;
    IF FOUND THEN
      IF batch.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'receivables: Ri.Ba. batch % is %; instalments are added only while it is a DRAFT', NEW."batchId", batch.status
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."dueDate" NOT BETWEEN batch.due_from AND batch.due_to THEN
        RAISE EXCEPTION 'receivables: Ri.Ba. item % is due on %, outside its batch''s window (% to %)', NEW."id", NEW."dueDate", batch.due_from, batch.due_to
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    SELECT i."status"::text AS status, i."docType"::text AS doc_type, i."paymentTerms" AS terms INTO invoice
      FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";
    IF FOUND THEN
      IF invoice.status = 'DRAFT' OR invoice.doc_type NOT IN ('TD01', 'TD24') THEN
        RAISE EXCEPTION 'receivables: Ri.Ba. item % collects invoice %, a % %; Ri.Ba. collects issued TD01 and TD24 invoices', NEW."id", NEW."invoiceId", invoice.status, invoice.doc_type
          USING ERRCODE = 'check_violation';
      END IF;
      entry := CASE WHEN jsonb_typeof(invoice.terms -> 'installments') = 'array' THEN (invoice.terms -> 'installments') -> (NEW."instalment" - 1) END;
      IF entry IS NULL OR jsonb_typeof(entry) <> 'object' OR NOT "factory_bank_json_int_ok"(entry -> 'amount')
         OR (entry ->> 'dueDate') IS DISTINCT FROM to_char(NEW."dueDate", 'YYYY-MM-DD') OR NEW."amount" > (entry ->> 'amount')::bigint THEN
        RAISE EXCEPTION 'receivables: Ri.Ba. item % names instalment % of invoice %: an instalment of its payment terms, due on that day, for at least the amount collected', NEW."id", NEW."instalment", NEW."invoiceId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."batchId", NEW."partyId", NEW."invoiceId", NEW."instalment", NEW."dueDate", NEW."amount", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."batchId", OLD."partyId", OLD."invoiceId", OLD."instalment", OLD."dueDate", OLD."amount", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'receivables: what Ri.Ba. item % collects never changes (remove it from the draft and add another)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'ISSUED' THEN
      RAISE EXCEPTION 'receivables: Ri.Ba. item % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT b."status"::text AS status INTO batch FROM "RibaBatch" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."batchId" FOR SHARE;
    IF FOUND AND NEW."status" <> OLD."status" AND batch.status <> 'ISSUED' THEN
      RAISE EXCEPTION 'receivables: Ri.Ba. item % is settled only once its batch is issued (it is %)', OLD."id", batch.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."status" IN ('PAID', 'UNPAID')) <> (NEW."settledOn" IS NOT NULL)
     OR NEW."settledOn" < NEW."dueDate" OR NEW."settledOn" > "factory_bank_today"() THEN
    RAISE EXCEPTION 'receivables: Ri.Ba. item % is settled exactly when PAID or UNPAID, on a day not before its due day and not after today', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'UNPAID') <> (NEW."unpaidFee" IS NOT NULL) OR NEW."unpaidFee" < 0 THEN
    RAISE EXCEPTION 'receivables: Ri.Ba. item % has the bank''s fee (0 or more) exactly when it came back UNPAID', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_riba_item_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch_status text;
BEGIN
  SELECT b."status"::text INTO batch_status FROM "RibaBatch" b WHERE b."tenantId" = OLD."tenantId" AND b."id" = OLD."batchId" FOR SHARE;
  IF FOUND AND batch_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'receivables: Ri.Ba. batch % is %; its instalments are removed only while it is a DRAFT', OLD."batchId", batch_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "RibaItem_guard" AFTER INSERT OR UPDATE ON "RibaItem"
  FOR EACH ROW EXECUTE FUNCTION "factory_riba_item_guard"();
CREATE TRIGGER "RibaItem_delete_guard" BEFORE DELETE ON "RibaItem"
  FOR EACH ROW EXECUTE FUNCTION "factory_riba_item_delete_guard"();
CREATE TRIGGER "RibaItem_no_truncate" BEFORE TRUNCATE ON "RibaItem"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_refuse_truncate"();

-- =====================================================================================================================
-- ReminderStop (FIN-112)
--   INSERT     in force (not lifted); the invoice an issued TD01 / TD24.
--   UPDATE     an UPDATE that changes nothing passes; the invoice, the reason and the creation never change; while in force
--              its until and note change and it is lifted once (who, when; why when given); a lifted stop never changes.
--   every row  a PROMISE_TO_PAY names the day promised; until not before the day it was made; a note of 1 to 2000
--              characters; lifted with who and when (not before it was made, not in the future), why 1 to 500 characters.
--   DELETE     refused (lifted instead). TRUNCATE refused.
-- PaymentReminder (W2a's guard untouched): a reminder is not approved or sent while a stop holds on one of its invoices
-- (not lifted, until today or later, or with no until).
CREATE FUNCTION "factory_reminder_stop_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."liftedAt" IS NOT NULL OR NEW."liftedById" IS NOT NULL OR NEW."liftReason" IS NOT NULL THEN
      RAISE EXCEPTION 'receivables: reminder stop % starts in force, not lifted', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."status"::text AS status, i."docType"::text AS doc_type INTO invoice FROM "Invoice" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";
    IF FOUND AND (invoice.status = 'DRAFT' OR invoice.doc_type NOT IN ('TD01', 'TD24')) THEN
      RAISE EXCEPTION 'receivables: reminder stop % names invoice %, a % %; reminders cover issued TD01 and TD24 invoices', NEW."id", NEW."invoiceId", invoice.status, invoice.doc_type
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

CREATE TRIGGER "ReminderStop_guard" AFTER INSERT OR UPDATE ON "ReminderStop"
  FOR EACH ROW EXECUTE FUNCTION "factory_reminder_stop_guard"();
CREATE TRIGGER "ReminderStop_never_deleted" BEFORE DELETE ON "ReminderStop"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_never_deleted"();
CREATE TRIGGER "ReminderStop_no_truncate" BEFORE TRUNCATE ON "ReminderStop"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_refuse_truncate"();

CREATE FUNCTION "factory_payment_reminder_stopped"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held record;
BEGIN
  SELECT s."invoiceId" AS invoice, s."reason"::text AS reason INTO held FROM "ReminderStop" s
   WHERE s."tenantId" = NEW."tenantId" AND s."invoiceId" = ANY (NEW."invoiceIds") AND s."liftedAt" IS NULL
     AND (s."until" IS NULL OR s."until" >= "factory_bank_today"())
   ORDER BY s."createdAt" LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'receivables: reminder % covers invoice %, whose reminders are stopped (%); it is not approved or sent while the stop holds', NEW."id", held.invoice, held.reason
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PaymentReminder_stopped" AFTER UPDATE OF "status" ON "PaymentReminder"
  FOR EACH ROW WHEN (NEW."status" IN ('APPROVED', 'SENT') AND OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "factory_payment_reminder_stopped"();

-- =====================================================================================================================
-- CustomerStatementFigures (FIN-135)
--   UPDATE     an UPDATE that changes nothing passes; the company, the customer and the creation never change.
--   every row  as of a day not after today; an ISO currency; the figures { "orders": [{ "reference", "amount" }],
--              "payments": [{ "reference", "date", "amount" }], "balance" } (references 1 to 100 characters on one line,
--              dates YYYY-MM-DD, whole amounts, at most 500 entries each); the file, when kept, a StoredFile of the company
--              with record type CustomerStatementFigures; a note of 1 to 2000 characters.
--   DELETE     refused (corrected instead). TRUNCATE refused.
CREATE FUNCTION "factory_bank_figures_ok"(figures jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry jsonb;
BEGIN
  IF figures IS NULL OR jsonb_typeof(figures) <> 'object'
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(figures) AS t(k)) IS DISTINCT FROM ARRAY['balance', 'orders', 'payments']
     OR jsonb_typeof(figures -> 'orders') <> 'array' OR jsonb_typeof(figures -> 'payments') <> 'array'
     OR jsonb_array_length(figures -> 'orders') > 500 OR jsonb_array_length(figures -> 'payments') > 500
     OR NOT "factory_bank_json_int_ok"(figures -> 'balance') THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT e FROM jsonb_array_elements(figures -> 'orders') AS t(e) LOOP
    IF jsonb_typeof(entry) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(entry) AS t(k)) IS DISTINCT FROM ARRAY['amount', 'reference']
       OR jsonb_typeof(entry -> 'reference') <> 'string' OR NOT "factory_recall_words_ok"(entry ->> 'reference', 100, false)
       OR NOT "factory_bank_json_int_ok"(entry -> 'amount') THEN
      RETURN false;
    END IF;
  END LOOP;
  FOR entry IN SELECT e FROM jsonb_array_elements(figures -> 'payments') AS t(e) LOOP
    IF jsonb_typeof(entry) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(entry) AS t(k)) IS DISTINCT FROM ARRAY['amount', 'date', 'reference']
       OR jsonb_typeof(entry -> 'reference') <> 'string' OR NOT "factory_recall_words_ok"(entry ->> 'reference', 100, false)
       OR jsonb_typeof(entry -> 'date') <> 'string' OR (entry ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$'
       OR NOT "factory_bank_json_int_ok"(entry -> 'amount') THEN
      RETURN false;
    END IF;
    PERFORM (entry ->> 'date')::date;
  END LOOP;
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN false;
END
$$;

CREATE FUNCTION "factory_customer_statement_figures_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'receivables: the company, customer and creation of the customer''s figures % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."asOf" > "factory_bank_today"() OR NEW."currency" !~ '^[A-Z]{3}$' OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'receivables: the customer''s figures % are as of a day not after today, in an ISO currency, with a note of 1 to 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bank_figures_ok"(NEW."figures") THEN
    RAISE EXCEPTION 'receivables: the customer''s figures % are { "orders": [{ "reference", "amount" }], "payments": [{ "reference", "date", "amount" }], "balance" } (references 1 to 100 characters, dates YYYY-MM-DD, whole amounts, at most 500 entries each)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_bank_file_ok"(NEW."tenantId", NEW."fileId", NEW."companyId", 'CustomerStatementFigures') THEN
    RAISE EXCEPTION 'receivables: the file of the customer''s figures % is not a file of the company kept for them', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CustomerStatementFigures_guard" AFTER INSERT OR UPDATE ON "CustomerStatementFigures"
  FOR EACH ROW EXECUTE FUNCTION "factory_customer_statement_figures_guard"();
CREATE TRIGGER "CustomerStatementFigures_never_deleted" BEFORE DELETE ON "CustomerStatementFigures"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_never_deleted"();
CREATE TRIGGER "CustomerStatementFigures_no_truncate" BEFORE TRUNCATE ON "CustomerStatementFigures"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_refuse_truncate"();

-- =====================================================================================================================
-- PaymentProposal (FIN-140, FIN-142)
--   INSERT     a DRAFT: no approval, payment or cancellation.
--   UPDATE     an UPDATE that changes nothing passes; the company, the week, the currency and the maker never change; PAID
--              and CANCELLED never change; DRAFT → APPROVED | CANCELLED; APPROVED → DRAFT (sent back: the approval
--              cleared) | PAID | CANCELLED; otherwise only the note changes.
--   every row  the week starts on a Monday; an ISO currency; a note of 1 to 2000 characters; approved (who, when) exactly
--              while APPROVED or PAID, by an active office person who is NOT the one who made it (the Owner included:
--              Owner answer Q3 = A); paid (when) exactly when PAID; cancelled (when, why: 1 to 500) exactly when CANCELLED;
--              no time in the future.
--   → APPROVED with at least one line; each supplier invoice once, APPROVED, and in no other DRAFT or APPROVED proposal;
--              each line held by no one: an ACTIVE bank account of its supplier in the proposal's currency (under the
--              company's proposal lock).
--   → PAID     every line's supplier invoice is PAID.
--   DELETE     refused (cancelled instead). TRUNCATE refused.
CREATE FUNCTION "factory_payment_proposal_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'note', 'version', 'updatedAt'];
  bad record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'payables: payment proposal % starts as a DRAFT', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."weekStart", NEW."currency", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."weekStart", OLD."currency", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'payables: the company, week, currency and maker of payment proposal % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('PAID', 'CANCELLED') THEN
      RAISE EXCEPTION 'payables: payment proposal % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = OLD."status" AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'payables: payment proposal % stays %; only its note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'DRAFT' AND NEW."status" IN ('APPROVED', 'CANCELLED'))
      OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('DRAFT', 'PAID', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'payables: payment proposal % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'APPROVED' AND NEW."status" = 'PAID'
       AND (NEW."approvedAt", NEW."approvedById") IS DISTINCT FROM (OLD."approvedAt", OLD."approvedById") THEN
      RAISE EXCEPTION 'payables: who approved payment proposal % and when never change once it is paid', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF extract(isodow FROM NEW."weekStart") <> 1 OR NEW."currency" !~ '^[A-Z]{3}$' OR NOT "factory_recall_words_ok"(NEW."note", 2000, true) THEN
    RAISE EXCEPTION 'payables: payment proposal % is for a week starting on a Monday, in an ISO currency, with a note of 1 to 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('APPROVED', 'PAID')) <> (NEW."approvedAt" IS NOT NULL) OR (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL)
     OR (NEW."status" = 'PAID') <> (NEW."paidAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."cancelledAt" IS NULL) <> (NEW."cancelReason" IS NULL)
     OR NOT "factory_recall_words_ok"(NEW."cancelReason", 500, true)
     OR NOT "factory_recall_not_future"(NEW."approvedAt") OR NOT "factory_recall_not_future"(NEW."paidAt") OR NOT "factory_recall_not_future"(NEW."cancelledAt") THEN
    RAISE EXCEPTION 'payables: payment proposal % is approved (who, when) exactly while APPROVED or PAID, paid exactly when PAID and cancelled (when, why) exactly when CANCELLED, none in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."approvedById" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById") THEN
    IF NEW."approvedById" = NEW."createdById" THEN
      RAISE EXCEPTION 'payables: payment proposal % is never approved by the person who made it', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_supplier_office_person_ok"(NEW."tenantId", NEW."approvedById") THEN
      RAISE EXCEPTION 'payables: payment proposal % is approved by an active office person', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."status" = 'APPROVED' AND OLD."status" = 'DRAFT' THEN
    PERFORM "factory_money_lock"('payment-proposal', NEW."tenantId", NEW."companyId");
    IF NOT EXISTS (SELECT 1 FROM "PaymentProposalLine" l WHERE l."tenantId" = NEW."tenantId" AND l."proposalId" = NEW."id") THEN
      RAISE EXCEPTION 'payables: payment proposal % is approved with at least one supplier invoice', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT l."supplierInvoiceId" AS invoice INTO bad FROM "PaymentProposalLine" l
     WHERE l."tenantId" = NEW."tenantId" AND l."proposalId" = NEW."id" GROUP BY l."supplierInvoiceId" HAVING count(*) > 1 LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'payables: payment proposal % pays supplier invoice % twice', NEW."id", bad.invoice
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT l."supplierInvoiceId" AS invoice, s."status"::text AS status INTO bad FROM "PaymentProposalLine" l
      JOIN "SupplierInvoice" s ON s."tenantId" = l."tenantId" AND s."id" = l."supplierInvoiceId"
     WHERE l."tenantId" = NEW."tenantId" AND l."proposalId" = NEW."id" AND s."status" <> 'APPROVED' LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'payables: payment proposal % pays supplier invoice %, which is %; only an invoice approved for payment is paid', NEW."id", bad.invoice, bad.status
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT l."supplierInvoiceId" AS invoice, o."proposalId" AS other INTO bad FROM "PaymentProposalLine" l
      JOIN "PaymentProposalLine" o ON o."tenantId" = l."tenantId" AND o."supplierInvoiceId" = l."supplierInvoiceId" AND o."proposalId" <> l."proposalId"
      JOIN "PaymentProposal" p ON p."tenantId" = o."tenantId" AND p."id" = o."proposalId"
     WHERE l."tenantId" = NEW."tenantId" AND l."proposalId" = NEW."id" AND p."status" IN ('DRAFT', 'APPROVED') LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'payables: supplier invoice % is in payment proposal % too; it is paid by one proposal', bad.invoice, bad.other
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT l."supplierInvoiceId" AS invoice INTO bad FROM "PaymentProposalLine" l
      LEFT JOIN "SupplierBankAccount" b ON b."tenantId" = l."tenantId" AND b."id" = l."supplierBankAccountId"
     WHERE l."tenantId" = NEW."tenantId" AND l."proposalId" = NEW."id"
       AND (b."id" IS NULL OR b."status" <> 'ACTIVE' OR b."currency" <> NEW."currency") LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'payables: payment proposal % holds supplier invoice %: it has no ACTIVE (verified) bank account of its supplier in %; a payment goes only to the verified account', NEW."id", bad.invoice, NEW."currency"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" = 'PAID' AND OLD."status" <> 'PAID' THEN
    SELECT l."supplierInvoiceId" AS invoice, s."status"::text AS status INTO bad FROM "PaymentProposalLine" l
      JOIN "SupplierInvoice" s ON s."tenantId" = l."tenantId" AND s."id" = l."supplierInvoiceId"
     WHERE l."tenantId" = NEW."tenantId" AND l."proposalId" = NEW."id" AND s."status" <> 'PAID' LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'payables: payment proposal % is paid once every supplier invoice in it is PAID (% is %)', NEW."id", bad.invoice, bad.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PaymentProposal_guard" AFTER INSERT OR UPDATE ON "PaymentProposal"
  FOR EACH ROW EXECUTE FUNCTION "factory_payment_proposal_guard"();
CREATE TRIGGER "PaymentProposal_never_deleted" BEFORE DELETE ON "PaymentProposal"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_never_deleted"();
CREATE TRIGGER "PaymentProposal_no_truncate" BEFORE TRUNCATE ON "PaymentProposal"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_refuse_truncate"();

-- PaymentProposalLine (FIN-140)
--   INSERT, UPDATE, DELETE only while its proposal is a DRAFT (the proposal read FOR SHARE).
--   UPDATE     an UPDATE that changes nothing passes; the proposal, the supplier, the invoice and the creation never change.
--   every row  an amount above 0 and a discount of 0 or more, together at most the invoice's total less its withholding;
--              the invoice an INVOICE, not PAID or VOIDED, in the proposal's currency; the bank account, when named (null:
--              held), ACTIVE and in the proposal's currency.
--   INSERT     the invoice in no other DRAFT or APPROVED proposal (under the company's proposal lock).
CREATE FUNCTION "factory_payment_proposal_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  proposal record;
  invoice record;
  account record;
  other uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."proposalId", NEW."partyId", NEW."supplierInvoiceId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."proposalId", OLD."partyId", OLD."supplierInvoiceId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'payables: the proposal, supplier, invoice and creation of payment proposal line % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT p."status"::text AS status, p."currency" AS currency INTO proposal
    FROM "PaymentProposal" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."proposalId" FOR SHARE;
  IF FOUND AND proposal.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'payables: payment proposal % is %; its lines are written only while it is a DRAFT', NEW."proposalId", proposal.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amount" <= 0 OR NEW."discountAmount" < 0 THEN
    RAISE EXCEPTION 'payables: payment proposal line % pays an amount above 0 with a discount of 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."kind"::text AS kind, s."status"::text AS status, s."currency" AS currency, s."grossTotal" AS gross, coalesce(s."withholdingAmount", 0) AS withheld
    INTO invoice FROM "SupplierInvoice" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."supplierInvoiceId";
  IF FOUND THEN
    IF invoice.kind <> 'INVOICE' OR invoice.status IN ('PAID', 'VOIDED') OR invoice.currency IS DISTINCT FROM coalesce(proposal.currency, invoice.currency) THEN
      RAISE EXCEPTION 'payables: payment proposal line % pays supplier invoice %, a % % in %; a proposal pays an invoice not yet paid or voided, in its currency', NEW."id", NEW."supplierInvoiceId", invoice.status, invoice.kind, invoice.currency
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."amount" + NEW."discountAmount" > invoice.gross - invoice.withheld THEN
      RAISE EXCEPTION 'payables: payment proposal line % pays % with a discount of %, more than supplier invoice % asks (% less % withheld)', NEW."id", NEW."amount", NEW."discountAmount", NEW."supplierInvoiceId", invoice.gross, invoice.withheld
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."supplierBankAccountId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."supplierBankAccountId" IS DISTINCT FROM OLD."supplierBankAccountId") THEN
    SELECT b."status"::text AS status, b."currency" AS currency INTO account
      FROM "SupplierBankAccount" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."supplierBankAccountId";
    IF FOUND AND (account.status <> 'ACTIVE' OR account.currency IS DISTINCT FROM coalesce(proposal.currency, account.currency)) THEN
      RAISE EXCEPTION 'payables: payment proposal line % pays to bank account %, which is % in %; a payment goes only to the supplier''s ACTIVE (verified) account in its currency', NEW."id", NEW."supplierBankAccountId", account.status, account.currency
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM "factory_money_lock"('payment-proposal', NEW."tenantId", NEW."companyId");
    SELECT o."proposalId" INTO other FROM "PaymentProposalLine" o
      JOIN "PaymentProposal" p ON p."tenantId" = o."tenantId" AND p."id" = o."proposalId"
     WHERE o."tenantId" = NEW."tenantId" AND o."supplierInvoiceId" = NEW."supplierInvoiceId" AND o."proposalId" <> NEW."proposalId"
       AND p."status" IN ('DRAFT', 'APPROVED') LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'payables: supplier invoice % is in payment proposal % already; it is paid by one proposal', NEW."supplierInvoiceId", other
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_payment_proposal_line_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  proposal_status text;
BEGIN
  SELECT p."status"::text INTO proposal_status FROM "PaymentProposal" p WHERE p."tenantId" = OLD."tenantId" AND p."id" = OLD."proposalId" FOR SHARE;
  IF FOUND AND proposal_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'payables: payment proposal % is %; its lines are removed only while it is a DRAFT', OLD."proposalId", proposal_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "PaymentProposalLine_guard" AFTER INSERT OR UPDATE ON "PaymentProposalLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_payment_proposal_line_guard"();
CREATE TRIGGER "PaymentProposalLine_delete_guard" BEFORE DELETE ON "PaymentProposalLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_payment_proposal_line_delete_guard"();
CREATE TRIGGER "PaymentProposalLine_no_truncate" BEFORE TRUNCATE ON "PaymentProposalLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_refuse_truncate"();

-- =====================================================================================================================
-- AccountMapping (FIN-152; GATE-ACCOUNTANT)
--   UPDATE     an UPDATE that changes nothing passes; the company, kind, key, first day and creation never change; the
--              account and the note change only before the first day (Rome); from it the row is fixed (a change is a row
--              from a later day).
--   every row  the key 1 to 80 characters on one line, no space at either end; the account 1 to 40 letters, digits and
--              . _ / -, starting with a letter or digit; a note of 1 to 500 characters.
--   DELETE     only before its first day. TRUNCATE refused.
CREATE FUNCTION "factory_account_mapping_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."kind", NEW."key", NEW."validFrom", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."kind", OLD."key", OLD."validFrom", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'accounting: the company, kind, key, first day and creation of account mapping % never change (another is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."validFrom" <= "factory_bank_today"() THEN
      RAISE EXCEPTION 'accounting: account mapping % applies since %; it is fixed (a change is a new row from a later day)', OLD."id", OLD."validFrom"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."key" IS NULL OR NEW."key" <> btrim(NEW."key") OR NOT "factory_recall_words_ok"(NEW."key", 80, false) THEN
    RAISE EXCEPTION 'accounting: the key of account mapping % is 1 to 80 characters on one line, no space at either end', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."accountCode" !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$' OR NOT "factory_recall_words_ok"(NEW."note", 500, true) THEN
    RAISE EXCEPTION 'accounting: account mapping % names an account of 1 to 40 letters, digits and . _ / - (starting with a letter or digit) and a note of 1 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_account_mapping_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."validFrom" <= "factory_bank_today"() THEN
    RAISE EXCEPTION 'accounting: account mapping % applies since %; it is kept (a change is a new row from a later day)', OLD."id", OLD."validFrom"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "AccountMapping_guard" AFTER INSERT OR UPDATE ON "AccountMapping"
  FOR EACH ROW EXECUTE FUNCTION "factory_account_mapping_guard"();
CREATE TRIGGER "AccountMapping_delete_guard" BEFORE DELETE ON "AccountMapping"
  FOR EACH ROW EXECUTE FUNCTION "factory_account_mapping_delete_guard"();
CREATE TRIGGER "AccountMapping_no_truncate" BEFORE TRUNCATE ON "AccountMapping"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_refuse_truncate"();

-- AccountingSettings (GATE-ACCOUNTANT): the company and the creation never change (an UPDATE that changes nothing passes);
-- never deleted, no TRUNCATE.
CREATE FUNCTION "factory_accounting_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD
     AND (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'accounting: the company and creation of the accounting settings % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AccountingSettings_guard" AFTER UPDATE ON "AccountingSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_accounting_settings_guard"();
CREATE TRIGGER "AccountingSettings_never_deleted" BEFORE DELETE ON "AccountingSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_never_deleted"();
CREATE TRIGGER "AccountingSettings_no_truncate" BEFORE TRUNCATE ON "AccountingSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_refuse_truncate"();

-- =====================================================================================================================
-- ExportedDocument (FIN-154)
--   INSERT     while its export is a DRAFT (read FOR SHARE); not flagged; CHANGED only in a re-export (the export amends an
--              earlier one).
--   UPDATE     an UPDATE that changes nothing passes; only the flag moves: set once (when, what the fingerprint became),
--              after the export is EXPORTED; then frozen.
--   every row  the record type a model name; the fingerprint 1 to 200 characters without spaces; the number 1 to 40 on one
--              line; flagged with when (not in the future) and a fingerprint of the same shape, other than the exported one.
--   DELETE     only while its export is a DRAFT. TRUNCATE refused.
-- AccountingExport (W2a's guard untouched): when it becomes EXPORTED (under the company's export lock) each document is in
-- it once, a NEW document is in no other EXPORTED export of the company, a CHANGED one was handed over by an earlier one.
CREATE FUNCTION "factory_exported_document_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  export record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."changedAt" IS NOT NULL OR NEW."changedFingerprint" IS NOT NULL THEN
      RAISE EXCEPTION 'accounting: exported document % is not flagged as changed when it is handed over', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT e."status"::text AS status, e."supersedesId" AS supersedes INTO export
      FROM "AccountingExport" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."exportId" FOR SHARE;
    IF FOUND THEN
      IF export.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'accounting: export % is %; its documents are written only while it is a DRAFT', NEW."exportId", export.status
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."change" = 'CHANGED' AND export.supersedes IS NULL THEN
        RAISE EXCEPTION 'accounting: exported document % is CHANGED only in a re-export (export % amends none)', NEW."id", NEW."exportId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['changedAt', 'changedFingerprint']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['changedAt', 'changedFingerprint'])
       OR OLD."changedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'accounting: exported document % never changes; only a later change of the document is flagged on it, once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT e."status"::text AS status INTO export FROM "AccountingExport" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."exportId";
    IF FOUND AND export.status <> 'EXPORTED' THEN
      RAISE EXCEPTION 'accounting: export % is %; a change is flagged on its documents only once it is exported', NEW."exportId", export.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_recall_model_name_ok"(NEW."recordType") OR NOT "factory_bank_fingerprint_ok"(NEW."fingerprint")
     OR NOT "factory_recall_words_ok"(NEW."number", 40, false) THEN
    RAISE EXCEPTION 'accounting: exported document % names a model, a fingerprint of 1 to 200 characters without spaces and a number of 1 to 40 characters on one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."changedAt" IS NULL) <> (NEW."changedFingerprint" IS NULL) OR NOT "factory_recall_not_future"(NEW."changedAt")
     OR (NEW."changedFingerprint" IS NOT NULL AND (NOT "factory_bank_fingerprint_ok"(NEW."changedFingerprint") OR NEW."changedFingerprint" = NEW."fingerprint")) THEN
    RAISE EXCEPTION 'accounting: exported document % is flagged with when (not in the future) and the fingerprint it has now, other than the exported one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_exported_document_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  export_status text;
BEGIN
  SELECT e."status"::text INTO export_status FROM "AccountingExport" e WHERE e."tenantId" = OLD."tenantId" AND e."id" = OLD."exportId" FOR SHARE;
  IF FOUND AND export_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'accounting: export % is %; its documents are kept', OLD."exportId", export_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "ExportedDocument_guard" AFTER INSERT OR UPDATE ON "ExportedDocument"
  FOR EACH ROW EXECUTE FUNCTION "factory_exported_document_guard"();
CREATE TRIGGER "ExportedDocument_delete_guard" BEFORE DELETE ON "ExportedDocument"
  FOR EACH ROW EXECUTE FUNCTION "factory_exported_document_delete_guard"();
CREATE TRIGGER "ExportedDocument_no_truncate" BEFORE TRUNCATE ON "ExportedDocument"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_refuse_truncate"();

CREATE FUNCTION "factory_accounting_export_documents_once"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  clash record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.accounting-export', NEW."tenantId", NEW."companyId"), 0));
  SELECT d."recordType" AS record_type, d."recordId" AS record_id INTO clash FROM "ExportedDocument" d
   WHERE d."tenantId" = NEW."tenantId" AND d."exportId" = NEW."id" GROUP BY d."recordType", d."recordId" HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'accounting: export % hands over % % twice', NEW."id", clash.record_type, clash.record_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT d."recordType" AS record_type, d."recordId" AS record_id, o."exportId" AS other INTO clash FROM "ExportedDocument" d
    JOIN "ExportedDocument" o ON o."tenantId" = d."tenantId" AND o."companyId" = d."companyId" AND o."recordType" = d."recordType"
                             AND o."recordId" = d."recordId" AND o."exportId" <> d."exportId"
    JOIN "AccountingExport" e ON e."tenantId" = o."tenantId" AND e."id" = o."exportId"
   WHERE d."tenantId" = NEW."tenantId" AND d."exportId" = NEW."id" AND d."change" = 'NEW' AND e."status" = 'EXPORTED' LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'accounting: export % hands over % % as NEW, but export % handed it over already (a re-export carries it as CHANGED)', NEW."id", clash.record_type, clash.record_id, clash.other
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT d."recordType" AS record_type, d."recordId" AS record_id INTO clash FROM "ExportedDocument" d
   WHERE d."tenantId" = NEW."tenantId" AND d."exportId" = NEW."id" AND d."change" = 'CHANGED'
     AND NOT EXISTS (SELECT 1 FROM "ExportedDocument" o JOIN "AccountingExport" e ON e."tenantId" = o."tenantId" AND e."id" = o."exportId"
                      WHERE o."tenantId" = d."tenantId" AND o."companyId" = d."companyId" AND o."recordType" = d."recordType"
                        AND o."recordId" = d."recordId" AND o."exportId" <> d."exportId" AND e."status" = 'EXPORTED')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'accounting: export % hands over % % as CHANGED, but no earlier export handed it over', NEW."id", clash.record_type, clash.record_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AccountingExport_documents_once" AFTER UPDATE OF "status" ON "AccountingExport"
  FOR EACH ROW WHEN (NEW."status" = 'EXPORTED' AND OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "factory_accounting_export_documents_once"();

-- =====================================================================================================================
-- IntegrityCheckRun (FIN-157): append-only
--   every row  the check's code capitals, digits and _ (2 to 64, starting with a capital); run not in the future; PASSED
--              with no failure and no error; FAILED with a count of at least 1 and 1 to 100 failures (at most the count),
--              each { "recordType": a model name, "recordId": a uuid, "code"?: capitals, digits and _ }; ERROR with no
--              failure and the error in words (1 to 2000).
CREATE FUNCTION "factory_integrity_check_run_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry jsonb;
  listed int;
BEGIN
  IF NEW."checkCode" !~ '^[A-Z][A-Z0-9_]{1,63}$' OR NOT "factory_recall_not_future"(NEW."ranAt") THEN
    RAISE EXCEPTION 'accounting: integrity check run % names its check (capitals, digits and _, 2 to 64) and ran not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."failures") <> 'array' OR jsonb_array_length(NEW."failures") > 100 THEN
    RAISE EXCEPTION 'accounting: the failures of integrity check run % are a list of at most 100', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  listed := jsonb_array_length(NEW."failures");
  IF (NEW."result" = 'FAILED' AND (NEW."failureCount" < 1 OR listed < 1 OR listed > NEW."failureCount"))
     OR (NEW."result" <> 'FAILED' AND (NEW."failureCount" <> 0 OR listed <> 0))
     OR (NEW."result" = 'ERROR') <> (NEW."errorWords" IS NOT NULL) OR NOT "factory_recall_words_ok"(NEW."errorWords", 2000, true) THEN
    RAISE EXCEPTION 'accounting: integrity check run % is PASSED with no failure, FAILED with its count and up to 100 of them, or ERROR with the error in words', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  FOR entry IN SELECT e FROM jsonb_array_elements(NEW."failures") AS t(e) LOOP
    IF jsonb_typeof(entry) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(entry) AS k(name) WHERE k.name NOT IN ('recordType', 'recordId', 'code'))
       OR jsonb_typeof(entry -> 'recordType') IS DISTINCT FROM 'string' OR NOT "factory_recall_model_name_ok"(entry ->> 'recordType')
       OR jsonb_typeof(entry -> 'recordId') IS DISTINCT FROM 'string'
       OR (entry ->> 'recordId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (entry ? 'code' AND (jsonb_typeof(entry -> 'code') <> 'string' OR (entry ->> 'code') !~ '^[A-Z][A-Z0-9_]{1,63}$')) THEN
      RAISE EXCEPTION 'accounting: a failure of integrity check run % is { "recordType": a model name, "recordId": a uuid, "code"?: a code }', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER "IntegrityCheckRun_check" AFTER INSERT ON "IntegrityCheckRun"
  FOR EACH ROW EXECUTE FUNCTION "factory_integrity_check_run_check"();
CREATE TRIGGER "IntegrityCheckRun_append_only" BEFORE UPDATE OR DELETE ON "IntegrityCheckRun"
  FOR EACH ROW EXECUTE FUNCTION "factory_bank_ledger_change"();
CREATE TRIGGER "IntegrityCheckRun_no_truncate" BEFORE TRUNCATE ON "IntegrityCheckRun"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_bank_ledger_change"();

-- =====================================================================================================================
-- ReceivablesSettings (W2a's guard untouched): the write-off tolerance is 0 or more.
CREATE FUNCTION "factory_receivables_settings_bank_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."writeOffToleranceAmount" < 0 THEN
    RAISE EXCEPTION 'receivables: the write-off tolerance of the settings % is 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReceivablesSettings_bank_check" AFTER INSERT OR UPDATE OF "writeOffToleranceAmount" ON "ReceivablesSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_receivables_settings_bank_check"();

-- Party (its guards untouched): a customer's trusted reminder level is 1 to 10, or none.
CREATE FUNCTION "factory_party_reminder_trusted_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."reminderTrustedLevel" NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'parties: the trusted reminder level of party % is 1 to 10, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Party_reminder_trusted_check" AFTER INSERT OR UPDATE OF "reminderTrustedLevel" ON "Party"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_reminder_trusted_check"();

-- =====================================================================================================================
-- The allocation and refund checks count the write-offs (their triggers stay as they are)
-- =====================================================================================================================

-- factory_payment_allocation_check (…_followups_quality_money_w2b_guards): its whole body, plus (W2b-6, schema wave 50/57)
-- the OVERPAYMENT write-offs of the payment in its cap, the UNDERPAYMENT write-offs of the invoice in what it is open for,
-- and an allocation with a write-off still standing reversed only after it. Its messages are the same while nothing is
-- written off.
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

-- factory_refund_guard (…_followups_quality_money_w2b_guards): its whole body, plus (W2b-6, schema wave 50/57) the
-- OVERPAYMENT write-offs of the payment it pays back (what is written off is not refunded). Its messages are the same while
-- nothing is written off; its triggers stay as they are.
CREATE OR REPLACE FUNCTION "factory_refund_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  due_moves CONSTANT text[] := ARRAY['amount', 'dueDate', 'internalNote', 'status', 'paidOn', 'externalRef', 'paidAt', 'paidById',
    'cancelledAt', 'cancelReason', 'version', 'updatedAt', 'reasonCode'];
  paid_moves CONSTANT text[] := ARRAY['status', 'voidedAt', 'voidReason', 'internalNote', 'version', 'updatedAt'];
  source_state text;
  source_type text;
  source_currency text;
  source_amount bigint;
  allocated bigint;
  refunded bigint;
  written bigint;
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
      RAISE EXCEPTION 'refunds: refund % is DUE; only its amount, due date, reason and note change, and it is paid or cancelled', OLD."id"
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
        -- W2b-6 (schema wave 50/57): what is written off of the payment's unplaced part (OVERPAYMENT) is not refunded.
        SELECT coalesce(sum(w."amount"), 0) INTO written FROM "PaymentWriteOff" w
         WHERE w."tenantId" = NEW."tenantId" AND w."paymentId" = NEW."paymentId" AND w."kind" = 'OVERPAYMENT';
        IF allocated + refunded + written + NEW."amount" > source_amount THEN
          IF written <> 0 THEN
            RAISE EXCEPTION 'refunds: payment % of % has % allocated, % refunded or due and % written off; refund % of % passes what is unplaced', NEW."paymentId", source_amount, allocated, refunded, written, NEW."id", NEW."amount"
              USING ERRCODE = 'check_violation';
          END IF;
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

-- =====================================================================================================================
-- The data copy: each company's first bank account from its Company bank columns (which stay: the deposit page and the
-- invoice print them). Only a company with an IBAN whose check digits hold and a holder of 1 to 140 characters on one line,
-- and no bank account yet; a bank name longer than 140 characters (or on several lines) is left out. Re-running it adds
-- nothing.
INSERT INTO "BankAccount" ("id", "tenantId", "companyId", "holder", "iban", "bic", "bankName", "currency", "active", "version", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."tenantId", c."id", btrim(c."bankAccountHolder"), c."iban", c."bic",
       CASE WHEN "factory_recall_words_ok"(c."bankName", 140, false) THEN c."bankName" END,
       'EUR', true, 1, now(), now()
  FROM "Company" c
 WHERE c."iban" IS NOT NULL AND "factory_supplier_iban_ok"(c."iban")
   AND c."bankAccountHolder" IS NOT NULL AND btrim(c."bankAccountHolder") <> '' AND "factory_recall_words_ok"(btrim(c."bankAccountHolder"), 140, false)
   AND NOT EXISTS (SELECT 1 FROM "BankAccount" b WHERE b."tenantId" = c."tenantId" AND b."companyId" = c."id");
