-- Written by hand (Prisma does not model triggers), after the generated 202611170110_sales_customer_numbers_th_schema and
-- before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Each customer's own running number, TH-1b (threads plan, schema wave 2/9, B-TH-104; Owner decision PR-06, planned as the
-- lead's pick A): "Your request 7", "Your quote 3", "Your order 12" beside the office number, so no customer reads from the
-- shared INQUIRY, QUOTE and SALES_ORDER series how much the others ask and order (plan §0.5). Fiscal numbers (invoices,
-- DDTs) stay on their legal series, untouched. No earlier function is redefined.
--
--   Inquiry, Quote, SalesOrder   customerSeq is given by the database, never by the app: 1, 2, 3 … per tenant, company and
--                                customer, the next after the highest the customer has there, when the row is made with its
--                                customer or (an inquiry) when a prospect is matched to one; a new customer of the row (the
--                                API never moves a quote, an order or a matched inquiry to another customer) takes the next
--                                of that customer's own; null without a customer (a prospect). It never changes otherwise:
--                                a write that names another value is refused, whatever the writer gave at insert is
--                                replaced. Two rows made at once for one customer take turns (a transaction-level advisory
--                                lock per table, company and customer); the unique index (tenant, company, party,
--                                customerSeq) is the last word. The highest is read under the writer's own policies: the
--                                office reads its whole tenant, a partner session its own party's rows, which are exactly
--                                that customer's.
--
-- The rows made before this wave are numbered here once, per customer in the order they were made (createdAt, then id),
-- with the tables' own guards off for that one statement each (a QUOTED inquiry, an ACCEPTED quote and a CLOSED order never
-- change for any login): only the new column is written.
--
-- As every guard: a refusal is a check_violation (SQLSTATE 23514) in words.

ALTER TABLE "Inquiry" DISABLE TRIGGER USER;
UPDATE "Inquiry" t SET "customerSeq" = n.seq
  FROM (SELECT "id", row_number() OVER (PARTITION BY "tenantId", "companyId", "partyId" ORDER BY "createdAt", "id") AS seq
          FROM "Inquiry" WHERE "partyId" IS NOT NULL) n
 WHERE t."id" = n."id";
ALTER TABLE "Inquiry" ENABLE TRIGGER USER;

ALTER TABLE "Quote" DISABLE TRIGGER USER;
UPDATE "Quote" t SET "customerSeq" = n.seq
  FROM (SELECT "id", row_number() OVER (PARTITION BY "tenantId", "companyId", "partyId" ORDER BY "createdAt", "id") AS seq FROM "Quote") n
 WHERE t."id" = n."id";
ALTER TABLE "Quote" ENABLE TRIGGER USER;

ALTER TABLE "SalesOrder" DISABLE TRIGGER USER;
UPDATE "SalesOrder" t SET "customerSeq" = n.seq
  FROM (SELECT "id", row_number() OVER (PARTITION BY "tenantId", "companyId", "partyId" ORDER BY "createdAt", "id") AS seq FROM "SalesOrder") n
 WHERE t."id" = n."id";
ALTER TABLE "SalesOrder" ENABLE TRIGGER USER;

-- The number given (BEFORE INSERT, and BEFORE an UPDATE that names the customer or the number).
CREATE FUNCTION "factory_customer_seq_give"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  next_seq integer;
  area CONSTANT text := CASE TG_TABLE_NAME WHEN 'Inquiry' THEN 'customers' ELSE 'sales' END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."partyId" IS NOT DISTINCT FROM OLD."partyId" THEN
    IF NEW."customerSeq" IS DISTINCT FROM OLD."customerSeq" THEN
      RAISE EXCEPTION '%: the customer''s own number of % % is given by the database once and never changes', area, TG_TABLE_NAME, OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."partyId" IS NULL THEN
    NEW."customerSeq" := NULL;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(format('factory.customer_seq:%s:%s:%s:%s', TG_TABLE_NAME, NEW."tenantId", NEW."companyId", NEW."partyId"), 0));
  EXECUTE format('SELECT coalesce(max("customerSeq"), 0) + 1 FROM %I WHERE "tenantId" = $1 AND "companyId" = $2 AND "partyId" = $3 AND "id" <> $4', TG_TABLE_NAME)
    INTO next_seq USING NEW."tenantId", NEW."companyId", NEW."partyId", NEW."id";
  NEW."customerSeq" := next_seq;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Inquiry_customer_seq" BEFORE INSERT OR UPDATE OF "partyId", "customerSeq" ON "Inquiry"
  FOR EACH ROW EXECUTE FUNCTION "factory_customer_seq_give"();
CREATE TRIGGER "Quote_customer_seq" BEFORE INSERT OR UPDATE OF "partyId", "customerSeq" ON "Quote"
  FOR EACH ROW EXECUTE FUNCTION "factory_customer_seq_give"();
CREATE TRIGGER "SalesOrder_customer_seq" BEFORE INSERT OR UPDATE OF "partyId", "customerSeq" ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_customer_seq_give"();
