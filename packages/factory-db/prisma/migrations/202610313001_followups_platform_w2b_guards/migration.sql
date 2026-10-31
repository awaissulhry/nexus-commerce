-- Written by hand (Prisma does not model triggers, partial indexes or a SET NULL of one column), after the generated
-- 202610313000_followups_platform_w2b_schema and before the policy migration. When the migrations are renumbered, keep
-- this file as it is under its new timestamp, and keep it OUT of prisma/migrations while `npm run migration` runs (it
-- needs the new tables and columns).

-- The W2a follow-ups for sales, product and platform (W2b schema wave 3/7, B-W2b-03): the rules of their tables and
-- columns for every login, the owner included. The API modules answer first, in words (B-W2b-16 orders and price lists,
-- B-W2b-24 platform, B-W2b-25 product, B-W2b-20 planning); these are the last word. Every refusal is a check_violation
-- (SQLSTATE 23514). A guard that reads another row skips its check when it cannot see that row (another tenant's: the
-- policy then refuses the write).
--
--   written once    FirstLoadStep: UPDATE, DELETE and TRUNCATE refused.
--   never changed   ReportRun: UPDATE and TRUNCATE refused (a retention rule may DELETE old rows).
--   never deleted   PartyPriceListAssignment: DELETE and TRUNCATE refused; only its end moves.
--   one of a kind   one block in force per address (Suppression); one personal default view per owner, list and
--                   company (SavedView); a customer's price lists never overlap (trigger) (partial unique indexes).
--   kept by the db  Role.requireMfaSince follows requireMfa (set when it is switched on, cleared when off).
--   W0-W2a tables   ExportJob.viewId is cleared (and only cleared) when its view is deleted: the foreign key becomes
--                   ON DELETE SET NULL ("viewId"), and "factory_export_job_guard" is redefined (the whole body of
--                   202610301002_platform_w2a_guards plus the cleared view); SalesOrderLine's closed-short reason code
--                   ("factory_sales_order_line_guard" redefined: the whole body of 202610302201_sales_w2a_guards plus
--                   the code); a lifted Suppression; Style's copied-from; a supplier calendar's time zone.

CREATE FUNCTION "factory_followups_platform_w2b_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'W2b: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- =====================================================================================================================
-- Sales (sales.prisma, pricing.prisma)

-- SalesOrderLine (redefines 202610302201_sales_w2a_guards' "factory_sales_order_line_guard"; the trigger stays): its
-- rules, closing short (SAL-210), and the closed-short reason code (W2b):
--   INSERT, UPDATE, DELETE  only while the order is CONFIRMED, IN_PRODUCTION or READY, as before; once it is
--                           PARTLY_SHIPPED an UPDATE that changes only the short-close columns (closing short, reopening;
--                           now with the reason code) passes too; never once SHIPPED, CLOSED or CANCELLED.
--   every row               as before; closed short with its pieces (1 to the line's quantity), time, who and why, all
--                           four or none; the reason code (upper-case letters, digits and underscores: a ReasonCode of
--                           the CANCEL list, kept as text) only on a line closed short.
CREATE OR REPLACE FUNCTION "factory_sales_order_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  short CONSTANT text[] := ARRAY['closedShortQuantity', 'closedShortAt', 'closedShortById', 'closeShortReason', 'closedShortReasonCode', 'version', 'updatedAt'];
  state text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."orderId" IS DISTINCT FROM OLD."orderId" THEN
      RAISE EXCEPTION 'sales: sales order line % never moves to another order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    part_of := NEW."orderId";
    SELECT o."status"::text INTO state FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."orderId" FOR SHARE;
  ELSE
    part_of := OLD."orderId";
    SELECT o."status"::text INTO state FROM "SalesOrder" o WHERE o."tenantId" = OLD."tenantId" AND o."id" = OLD."orderId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state NOT IN ('CONFIRMED', 'IN_PRODUCTION', 'READY')
     AND NOT (TG_OP = 'UPDATE' AND state = 'PARTLY_SHIPPED' AND (to_jsonb(NEW) - short) = (to_jsonb(OLD) - short)) THEN
    RAISE EXCEPTION 'sales: sales order % is %; its lines change only while it is CONFIRMED, IN_PRODUCTION or READY (once PARTLY_SHIPPED, a line is only closed short or reopened)', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1
     OR (NEW."kind" = 'MADE_TO_MEASURE') <> (NEW."measurementProfileId" IS NOT NULL)
     OR (NEW."kind" = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1) THEN
    RAISE EXCEPTION 'sales: sales order line % is a size grid of at least one piece, or one made-to-measure unit with its measurement profile', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."closedShortAt" IS NULL) <> (NEW."closedShortQuantity" IS NULL)
     OR (NEW."closedShortAt" IS NULL) <> (NEW."closedShortById" IS NULL)
     OR (NEW."closedShortAt" IS NULL) <> (coalesce(btrim(NEW."closeShortReason"), '') = '') THEN
    RAISE EXCEPTION 'sales: sales order line % is closed short with its pieces, time, who and why, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."closedShortQuantity" IS NOT NULL AND (NEW."closedShortQuantity" < 1 OR NEW."closedShortQuantity" > NEW."quantity") THEN
    RAISE EXCEPTION 'sales: sales order line % closes short 1 to % pieces, not %', NEW."id", NEW."quantity", NEW."closedShortQuantity"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."closedShortReasonCode" IS NOT NULL
     AND (NEW."closedShortAt" IS NULL OR NEW."closedShortReasonCode" !~ '^[A-Z][A-Z0-9_]*$') THEN
    RAISE EXCEPTION 'sales: sales order line % names a closed-short reason code (upper-case letters, digits and underscores) only while it is closed short', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- PartyPriceListAssignment (design pricelist.customers "Customer or group · From")
--   INSERT     the list is ACTIVE when it is given.
--   every row  it ends (validTo) on or after it starts; the rows of one customer never overlap (the customer's row is
--              locked, so two assignments to one customer wait for each other).
--   UPDATE     an UPDATE that changes nothing passes; the customer, list, start and creation never change: only the
--              end moves.
--   DELETE     refused (the history of who had which list when). TRUNCATE refused.
CREATE FUNCTION "factory_party_price_list_assignment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  overlapping integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pricing: price list assignment % is the history of a customer''s lists; it is ended, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."partyId", NEW."priceListId", NEW."validFrom", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."partyId", OLD."priceListId", OLD."validFrom", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'pricing: price list assignment % keeps its customer, list and start; only its end moves', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT l."status"::text INTO state FROM "PriceList" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."priceListId";
    IF FOUND AND state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'pricing: price list assignment % gives a price list that is %', NEW."id", state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."validTo" IS NOT NULL AND NEW."validTo" < NEW."validFrom" THEN
    RAISE EXCEPTION 'pricing: price list assignment % ends (%) before it starts (%)', NEW."id", NEW."validTo", NEW."validFrom"
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId" FOR UPDATE;
  SELECT count(*) INTO overlapping FROM "PartyPriceListAssignment" a
    WHERE a."tenantId" = NEW."tenantId" AND a."partyId" = NEW."partyId" AND a."id" <> NEW."id"
      AND daterange(a."validFrom", a."validTo", '[]') && daterange(NEW."validFrom", NEW."validTo", '[]');
  IF overlapping > 0 THEN
    RAISE EXCEPTION 'pricing: price list assignment % (from % to %) overlaps another list of its customer; end that one first', NEW."id", NEW."validFrom", coalesce(NEW."validTo"::text, 'open')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PartyPriceListAssignment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PartyPriceListAssignment"
  FOR EACH ROW EXECUTE FUNCTION "factory_party_price_list_assignment_guard"();
CREATE TRIGGER "PartyPriceListAssignment_no_truncate" BEFORE TRUNCATE ON "PartyPriceListAssignment"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_platform_w2b_refuse_truncate"();

-- =====================================================================================================================
-- Product (product.prisma)

-- Style: copied from another style (and that style's revision): never from itself; the revision only with its style;
-- each set once (from nothing, at the copy or later from the audit), never changed or cleared.
CREATE FUNCTION "factory_style_copied_from_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."copiedFromStyleId" = NEW."id" THEN
    RAISE EXCEPTION 'product: style % is not a copy of itself', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."copiedFromRevisionId" IS NOT NULL AND NEW."copiedFromStyleId" IS NULL THEN
    RAISE EXCEPTION 'product: style % names the revision it was copied from only with that revision''s style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE'
     AND ((OLD."copiedFromStyleId" IS NOT NULL AND NEW."copiedFromStyleId" IS DISTINCT FROM OLD."copiedFromStyleId")
          OR (OLD."copiedFromRevisionId" IS NOT NULL AND NEW."copiedFromRevisionId" IS DISTINCT FROM OLD."copiedFromRevisionId")) THEN
    RAISE EXCEPTION 'product: style % keeps the style and revision it was copied from', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Style_copied_from_guard" BEFORE INSERT OR UPDATE OF "copiedFromStyleId", "copiedFromRevisionId" ON "Style"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_copied_from_guard"();

-- =====================================================================================================================
-- Platform (roles.prisma, email.prisma, imports.prisma, views.prisma, insights.prisma, calendar.prisma)

-- Role.requireMfaSince follows requireMfa (B-W2a-36's grace: a session made before it keeps the role until its next
-- sign-in): switched on (a new role that asks, or false → true) → the time the writer gave, else the transaction's;
-- off → none; while it stays on it never moves (a role that asked before W2b may be given its time once).
CREATE FUNCTION "factory_role_require_mfa_since"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW."requireMfa" THEN
    NEW."requireMfaSince" := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR NOT OLD."requireMfa" THEN
    IF NEW."requireMfaSince" IS NULL THEN
      NEW."requireMfaSince" := now();
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."requireMfaSince" IS NOT NULL AND NEW."requireMfaSince" IS DISTINCT FROM OLD."requireMfaSince" THEN
    RAISE EXCEPTION 'roles: role % asks for two-factor since %; that never moves while it asks', OLD."id", OLD."requireMfaSince"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Role_require_mfa_since" BEFORE INSERT OR UPDATE OF "requireMfa", "requireMfaSince" ON "Role"
  FOR EACH ROW EXECUTE FUNCTION "factory_role_require_mfa_since"();

-- Suppression: lifted with when, who and why (all three or none); a block starts in force; a lifted row never changes
-- again (nor is it put back in force: a later bounce blocks the address in a new row). One block in force per address.
CREATE FUNCTION "factory_suppression_lift_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'version', 'updatedAt'];
BEGIN
  IF (NEW."liftedAt" IS NULL) <> (NEW."liftedById" IS NULL)
     OR (NEW."liftedAt" IS NULL) <> (coalesce(btrim(NEW."liftReason"), '') = '') THEN
    RAISE EXCEPTION 'email: suppression % is lifted with when, who and why, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."liftedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'email: suppression % starts in force; it is lifted later', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."liftedAt" IS NOT NULL AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
    RAISE EXCEPTION 'email: suppression % was lifted; it never changes again (a new bounce blocks the address in a new row)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Suppression_lift_guard" BEFORE INSERT OR UPDATE ON "Suppression"
  FOR EACH ROW EXECUTE FUNCTION "factory_suppression_lift_guard"();

CREATE UNIQUE INDEX "Suppression_one_block_per_address" ON "Suppression" ("tenantId", "address") WHERE "liftedAt" IS NULL;

-- FirstLoadStep: one step's key; the APPLIED import it matched (of its company, or tenant-wide) exactly when there was
-- something to load, else "nothing to load" with its reason; written once: UPDATE, DELETE and TRUNCATE refused.
CREATE FUNCTION "factory_first_load_step_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'imports: first-load step % is done once; % is refused', OLD."id", TG_OP
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."step" !~ '^[a-z][A-Za-z0-9_-]*$' THEN
    RAISE EXCEPTION 'imports: first-load step % names its step by its key', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."jobId" IS NULL) <> NEW."nothingToLoad"
     OR NEW."nothingToLoad" <> (coalesce(btrim(NEW."reason"), '') <> '') THEN
    RAISE EXCEPTION 'imports: first-load step % names the import it matched, or says there was nothing to load and why', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."jobId" IS NOT NULL THEN
    SELECT j."status"::text AS status, j."companyId" INTO job FROM "ImportJob" j WHERE j."tenantId" = NEW."tenantId" AND j."id" = NEW."jobId";
    IF FOUND AND (job.status <> 'APPLIED' OR (job."companyId" IS NOT NULL AND job."companyId" <> NEW."companyId")) THEN
      RAISE EXCEPTION 'imports: first-load step % is done with an APPLIED import of its company (or a tenant-wide one)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "FirstLoadStep_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FirstLoadStep"
  FOR EACH ROW EXECUTE FUNCTION "factory_first_load_step_guard"();
CREATE TRIGGER "FirstLoadStep_no_truncate" BEFORE TRUNCATE ON "FirstLoadStep"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_platform_w2b_refuse_truncate"();

-- SavedView: one personal default per owner, list and company (as the role default per role).
CREATE UNIQUE INDEX "SavedView_one_personal_default" ON "SavedView" ("tenantId", "ownerId", "listKey", (COALESCE("companyId", '00000000-0000-0000-0000-000000000000'::uuid))) WHERE "isPersonalDefault";

-- ExportJob.viewId: deleting the view clears this column only (Prisma's SET NULL would clear tenantId too).
ALTER TABLE "ExportJob" DROP CONSTRAINT "ExportJob_tenantId_viewId_fkey";
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_tenantId_viewId_fkey" FOREIGN KEY ("tenantId", "viewId") REFERENCES "SavedView"("tenantId", "id") ON DELETE SET NULL ("viewId") ON UPDATE RESTRICT;

-- ExportJob (redefines 202610301002_platform_w2a_guards' "factory_export_job_guard"; the triggers stay): born QUEUED;
-- QUEUED → RUNNING | FAILED, RUNNING → QUEUED (a retry) | DONE | FAILED, DONE → EXPIRED; FAILED and EXPIRED are final.
-- What was asked never changes, except that the view it was made from is cleared when that view is deleted (in any
-- status; it never names another view); RUNNING has its start, DONE its start, end, row count and file (a StoredFile of
-- this job, named once), FAILED its end and reason; rows written never pass the count. Expired, never deleted.
CREATE OR REPLACE FUNCTION "factory_export_job_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed CONSTANT text[] := ARRAY['companyId', 'requestedById', 'listKey', 'format', 'query', 'omittedColumns', 'createdAt'];
  file record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'exports: export % expires, it is never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."listKey" !~ '^[a-z][a-z0-9_.-]*$' OR jsonb_typeof(NEW."query") <> 'object' OR NEW."omittedColumns" IS NULL THEN
    RAISE EXCEPTION 'exports: export % names its list by its page id and keeps what was asked (an object) and the columns left out', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."rowsDone" < 0 OR NEW."rowCount" < 0 OR NEW."rowsDone" > NEW."rowCount" THEN
    RAISE EXCEPTION 'exports: export % writes 0 rows or more, never more than its count', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'RUNNING' AND NEW."startedAt" IS NULL)
     OR (NEW."status" IN ('DONE', 'EXPIRED') AND num_nulls(NEW."startedAt", NEW."finishedAt", NEW."rowCount", NEW."fileId") > 0)
     OR (NEW."status" = 'FAILED' AND (NEW."finishedAt" IS NULL OR NEW."failureReason" IS NULL OR btrim(NEW."failureReason") = ''))
     OR (NEW."status" IN ('QUEUED', 'RUNNING') AND num_nonnulls(NEW."finishedAt", NEW."fileId", NEW."failureReason") > 0) THEN
    RAISE EXCEPTION 'exports: export % is % without its times, count, file or reason (or with what it cannot have yet)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'QUEUED' THEN
      RAISE EXCEPTION 'exports: a new export is QUEUED, not %', NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT "factory_platform_w2a_fixed"(to_jsonb(NEW), to_jsonb(OLD), fixed)
       OR (NEW."viewId" IS DISTINCT FROM OLD."viewId" AND NEW."viewId" IS NOT NULL) THEN
      RAISE EXCEPTION 'exports: export % keeps what was asked', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('FAILED', 'EXPIRED') AND to_jsonb(NEW) - 'tenantId' - 'version' - 'updatedAt' - 'viewId' IS DISTINCT FROM to_jsonb(OLD) - 'tenantId' - 'version' - 'updatedAt' - 'viewId' THEN
      RAISE EXCEPTION 'exports: export % is %; it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'QUEUED' AND NEW."status" IN ('RUNNING', 'FAILED'))
                OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('QUEUED', 'DONE', 'FAILED'))
                OR (OLD."status" = 'DONE' AND NEW."status" = 'EXPIRED')) THEN
      RAISE EXCEPTION 'exports: export % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."fileId" IS NOT NULL AND NEW."fileId" IS DISTINCT FROM OLD."fileId" THEN
      RAISE EXCEPTION 'exports: export % keeps its file', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."fileId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."fileId" IS NULL) THEN
    SELECT f."recordType", f."recordId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
    IF FOUND AND (file."recordType" <> 'ExportJob' OR file."recordId" <> NEW."id") THEN
      RAISE EXCEPTION 'exports: the file of export % is a file of that export', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ReportRun: a report key and its filters (an object); never changed (UPDATE and TRUNCATE refused); a retention rule may
-- delete old rows.
CREATE FUNCTION "factory_report_run_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'insights: report run % is never changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reportKey" !~ '^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9_.-]*$' OR jsonb_typeof(NEW."params") <> 'object' THEN
    RAISE EXCEPTION 'insights: report run % names its report by its key and keeps its filters as an object', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReportRun_guard" BEFORE INSERT OR UPDATE ON "ReportRun"
  FOR EACH ROW EXECUTE FUNCTION "factory_report_run_guard"();
CREATE TRIGGER "ReportRun_no_truncate" BEFORE TRUNCATE ON "ReportRun"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_platform_w2b_refuse_truncate"();

-- WorkCalendar.timeZone: only on a SUPPLIER calendar, and a zone PostgreSQL knows (IANA: "Asia/Karachi").
CREATE FUNCTION "factory_work_calendar_time_zone_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."timeZone" IS NOT NULL
     AND (NEW."scope" <> 'SUPPLIER' OR NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z."name" = NEW."timeZone")) THEN
    RAISE EXCEPTION 'calendar: calendar % has a time zone of its own only as a supplier''s calendar, and a known one (IANA), not %', NEW."id", NEW."timeZone"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkCalendar_time_zone_guard" BEFORE INSERT OR UPDATE OF "timeZone", "scope" ON "WorkCalendar"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_calendar_time_zone_guard"();
