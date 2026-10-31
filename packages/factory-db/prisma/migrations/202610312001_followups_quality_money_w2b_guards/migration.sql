-- Written by hand (Prisma does not model triggers, deferred constraint triggers or partial unique indexes), after the
-- generated 202610312000_followups_quality_money_w2b_schema and before the policy migration. When the migrations are
-- renumbered, keep this file as it is under its new timestamp, and keep it OUT of prisma/migrations while
-- `npm run migration` runs (it needs the new tables and columns).

-- W2b schema wave 2/7 (B-W2b-02): the W2a follow-ups for quality, planning and money that the W2a notes named (B-W2a-21,
-- -22, -26, -47, -52, -55, -61, -62, -66, -67). The rules of the new tables and columns for every login, the owner
-- included; the API answers first, in words (B-W2b-14, -17, -20, -21, -22). Every refusal is a check_violation
-- (SQLSTATE 23514).
--
--   numbering      HOLD and NCR are floor document kinds: factory_number_series_floor_guard and
--                  factory_number_allocation_floor_guard (…_numbering_floor_documents_guards) REDEFINED whole, with the
--                  two kinds added (the policies' onlyValues are generated from ownership/numbering.json). A hold's
--                  number is given once and never changes or goes blank (it may be null: a hold placed before).
--   quality        a containment action's cancel reason only when CANCELLED; an inspection's due time is the office's;
--                  the default containment time 1 to 720 hours. "Placer may release" is a setting the API reads (the DB
--                  never enforced placer ≠ releaser).
--   compliance     CertificateRenewal: the application log of a renewal (STARTED → APPLIED → RENEWED, or CANCELLED);
--                  its steps set once, frozen once RENEWED or CANCELLED, never deleted.
--   planning       factory_material_requirement_guard (…_stock_plan_w2a_guards) REDEFINED whole: a line that carries a
--                  firm order is written firm, and may be made planned again later (firmCarriedFromId stays, history).
--                  PurchasingSettings: the Owner's switch for PO confirmation reminders; changed, never deleted.
--   costing        factory_work_order_cost_entry_check (…_money_w2a_guards) REDEFINED whole: a SCRAP entry may name the
--                  rework order of the work order that scrapped (sourceType ReworkOrder) when no move or scan does.
--                  CostingSettings (a trigger of its own): a company's row may hold its method only and follow the
--                  tenant-wide overhead (overheadFromTenant, its own overhead 0).
--   payables       factory_supplier_invoice_guard (…_money_w2a_guards) REDEFINED whole: the lotto columns are what SDI
--                  said (never change), an invoice of a file carries the file's IdentificativoSdI and day, a single SDI
--                  invoice never shares an IdentificativoSdI with a file; a credit note names the claim it settles once
--                  (any status but VOIDED). A voided invoice frees its number: the partial unique
--                  SupplierInvoice_one_live_per_number replaces W2a's key; SupplierInvoice_one_per_sdi_delivery keeps one
--                  single invoice per IdentificativoSdI (the generated key holds each body of a file once).
--                  PayablesSettings, SupplierInvoiceFile and SdiInboxItem: their guards; none is deleted.
--   payments       factory_payment_allocation_check (…_money_w2a_guards) REDEFINED whole: a PAID deposit request of an
--                  order that issues no deposit invoice (NONE) may have its allocation reversed, and the money is placed
--                  on an issued TD01 / TD24 of the order by an allocation naming the reversal (carriedFromId), in the
--                  same command: the deferred PaymentAllocation_carry_due refuses a commit without it.
--   receivables    factory_refund_guard (…_money_w2a_guards) REDEFINED whole: a DUE refund's reason changes with its
--                  amount and date. InterestReferenceRate: one row per half-year (1 January, 1 July), the rate as
--                  published with its source; corrected, never deleted.
--
-- As in every W2a guards file: the tenant (and site) of a row are held by the policies and the references, not here (the
-- triggers leave "tenantId" to them, so a row moved to another tenant is refused by row-level security); a rule that
-- reads another row skips a row this session cannot see; an UPDATE that changes nothing passes; "everything but these
-- columns" is compared as jsonb, so a column added later is frozen too unless a later migration names it.
--
-- Locks (pg_advisory_xact_lock, held to the end of the transaction): an SDI invoice and a file of several invoices take
-- 'factory.payables.sdi' on their IdentificativoSdI, so a single invoice and a file never share one. The allocation check
-- keeps …_money_guards' order (payment, then deposit request or invoice).

CREATE FUNCTION "factory_followups_w2b_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'W2b follow-ups: TRUNCATE on "%" is refused (rows are kept, never removed)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- =====================================================================================================================
-- Numbering: holds and NCRs numbered at the bench (floor document kinds)
-- =====================================================================================================================

-- factory_number_series_floor_guard and factory_number_allocation_floor_guard (…_numbering_floor_documents_guards): their
-- whole bodies, with HOLD and NCR among the floor's document kinds (factory-domain numbering/kinds FLOOR_DOCUMENT_KINDS;
-- ownership/numbering.json onlyValues). Their triggers stay as they are.
CREATE OR REPLACE FUNCTION "factory_number_series_floor_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  site_company uuid;
BEGIN
  IF current_user <> 'factory_floor_runtime' THEN
    RETURN NULL;
  END IF;
  IF NEW."fiscal" OR NEW."kind"::text IN ('DDT', 'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE')
     OR NEW."kind"::text NOT IN ('GOODS_RECEIPT', 'LOT', 'INSPECTION', 'RELEASE', 'HOLD', 'NCR') THEN
    RAISE EXCEPTION 'number series %: a tablet numbers goods receipts, lots, inspections, releases, holds and NCRs only, never from a fiscal series; a % series is the office''s', NEW."id", (CASE WHEN NEW."fiscal" THEN 'fiscal ' ELSE '' END) || NEW."kind"::text
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."companyId" INTO site_company FROM "Site" s WHERE s."id" = NULLIF(current_setting('factory.site_id', true), '')::uuid;
  IF site_company IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'number series %: a tablet numbers the documents of its own site''s company only', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."tenantId", NEW."companyId", NEW."kind", NEW."code", NEW."scopeKey", NEW."reset", NEW."pattern", NEW."fiscal",
        NEW."startValue", NEW."status", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."tenantId", OLD."companyId", OLD."kind", OLD."code", OLD."scopeKey", OLD."reset", OLD."pattern", OLD."fiscal",
        OLD."startValue", OLD."status", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'number series %: a tablet moves only its counter (the next number and the last date); the series is the office''s', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."nextValue" <> OLD."nextValue" AND NEW."nextValue" <> OLD."nextValue" + 1 THEN
      RAISE EXCEPTION 'number series %: a tablet moves the counter one number at a time (% to %)', OLD."id", OLD."nextValue", NEW."nextValue"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."nextValue" = OLD."nextValue" + 1 AND NOT EXISTS (
      SELECT 1 FROM "NumberAllocation" a WHERE a."tenantId" = OLD."tenantId" AND a."seriesId" = OLD."id" AND a."value" = OLD."nextValue"
    ) THEN
      RAISE EXCEPTION 'number series %: a tablet moves the counter only past a number it recorded (number % has no NumberAllocation)', OLD."id", OLD."nextValue"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  -- INSERT: the first row of a new year of a yearly series (allocateNumber's rollover on the year's first number).
  IF NEW."reset" <> 'YEARLY' OR NEW."status" <> 'ACTIVE' OR NEW."startValue" <> 1 OR NEW."nextValue" <> 1 OR NEW."lastIssuedDate" IS NOT NULL THEN
    RAISE EXCEPTION 'number series %: a tablet adds only a new year of a yearly series: active, counting from 1, nothing issued yet', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "NumberSeries" s
    WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId" AND s."kind" = NEW."kind" AND s."pattern" = NEW."pattern"
      AND s."reset" = 'YEARLY' AND s."id" <> NEW."id" AND s."scopeKey" < NEW."scopeKey"
  ) THEN
    RAISE EXCEPTION 'number series %: a tablet adds a new year only to a series the office set up (an earlier year of % %)', NEW."id", NEW."kind", NEW."pattern"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION "factory_number_allocation_floor_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  series record;
  site_company uuid;
BEGIN
  IF current_user <> 'factory_floor_runtime' THEN
    RETURN NULL;
  END IF;
  IF NEW."kind"::text NOT IN ('GOODS_RECEIPT', 'LOT', 'INSPECTION', 'RELEASE', 'HOLD', 'NCR') THEN
    RAISE EXCEPTION 'number % (%): a tablet numbers goods receipts, lots, inspections, releases, holds and NCRs only', NEW."formatted", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."companyId", s."kind"::text AS "kind", s."fiscal", s."nextValue" INTO series
    FROM "NumberSeries" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."seriesId";
  IF NOT FOUND OR series."fiscal" THEN
    RAISE EXCEPTION 'number % (%): series % is not one a tablet numbers from (a goods receipt, lot, inspection, release, hold or NCR series)', NEW."formatted", NEW."kind", NEW."seriesId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF series."kind" <> NEW."kind"::text OR series."companyId" <> NEW."companyId" THEN
    RAISE EXCEPTION 'number % (%): a number is of its series'' kind and company', NEW."formatted", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."companyId" INTO site_company FROM "Site" s WHERE s."id" = NULLIF(current_setting('factory.site_id', true), '')::uuid;
  IF site_company IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'number % (%): a tablet numbers the documents of its own site''s company only', NEW."formatted", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."value" > series."nextValue" THEN
    RAISE EXCEPTION 'number % (%): a tablet takes its series'' next number (%), never one ahead of it (%)', NEW."formatted", NEW."kind", series."nextValue", NEW."value"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

-- QualityHold.number (HLD-…): given when the hold is placed, or once later for a hold placed before the series existed
-- (while ACTIVE: …_quality_plant_w2a_guards freezes a released or closed hold, and the floor changes only its quarantine
-- move and release); never changed, never blank. Unlike an inspection's (…_numbering_floor_documents_guards), a new
-- hold may still come without one (the W2a commands place unnumbered holds until B-W2b-17 numbers them).
CREATE FUNCTION "factory_quality_hold_number_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."number" IS NOT NULL AND NEW."number" IS DISTINCT FROM OLD."number" THEN
    RAISE EXCEPTION 'quality: hold % has number %; it never changes', OLD."id", OLD."number"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."number" IS NOT NULL AND btrim(NEW."number") = '' THEN
    RAISE EXCEPTION 'quality: hold %''s number is never blank (its company''s HOLD series gives it)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QualityHold_number" BEFORE INSERT OR UPDATE ON "QualityHold"
  FOR EACH ROW EXECUTE FUNCTION "factory_quality_hold_number_guard"();

-- =====================================================================================================================
-- Quality: containment cancel reason, inspection due time, the default containment time
-- =====================================================================================================================

-- NcrContainmentAction.cancelReason (a trigger of its own; …_quality_plant_w2a_guards' guard is untouched and freezes a
-- cancelled action, so the reason is written with the move): only on a CANCELLED action, never blank.
CREATE FUNCTION "factory_ncr_containment_cancel_reason_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."cancelReason" IS NOT NULL AND (NEW."status" <> 'CANCELLED' OR btrim(NEW."cancelReason") = '') THEN
    RAISE EXCEPTION 'quality: containment action % says why it was cancelled only when CANCELLED, in words', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "NcrContainmentAction_cancel_reason" BEFORE INSERT OR UPDATE ON "NcrContainmentAction"
  FOR EACH ROW EXECUTE FUNCTION "factory_ncr_containment_cancel_reason_guard"();

-- Inspection.dueAt (a trigger of its own): the office sets and moves it (the floor neither sets nor changes it); W1's
-- factory_inspection_guard freezes it on a decided or cancelled inspection.
CREATE FUNCTION "factory_inspection_due_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'factory_floor_runtime'
     AND ((TG_OP = 'INSERT' AND NEW."dueAt" IS NOT NULL) OR (TG_OP = 'UPDATE' AND NEW."dueAt" IS DISTINCT FROM OLD."dueAt")) THEN
    RAISE EXCEPTION 'quality: the office sets by when inspection % is due; the floor does not', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Inspection_due_guard" BEFORE INSERT OR UPDATE ON "Inspection"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_due_guard"();

-- QualitySettings (a trigger of its own, as each wave added one): the default containment time is 1 to 720 hours when
-- set. placerMayRelease is any of true, false or null (follow the tenant-wide row).
CREATE FUNCTION "factory_quality_settings_followups_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."defaultContainmentHours" IS NOT NULL AND (NEW."defaultContainmentHours" < 1 OR NEW."defaultContainmentHours" > 720) THEN
    RAISE EXCEPTION 'quality: settings % give an NCR''s containment 1 to 720 hours by default, not %', NEW."id", NEW."defaultContainmentHours"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QualitySettings_followups_guard" BEFORE INSERT OR UPDATE ON "QualitySettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_quality_settings_followups_guard"();

-- =====================================================================================================================
-- Compliance: the application log of a certificate's renewal
-- =====================================================================================================================

-- CertificateRenewal (QHS-105, PRD-283)
--   INSERT     STARTED: nothing applied, renewed or cancelled.
--   UPDATE     an UPDATE that changes nothing passes; the certificate, the window, the language, the start and the
--              creation never change; the task is named once; the application is recorded once (its day, reference,
--              note, window verdict, when and by whom), kept after; STARTED → APPLIED | RENEWED | CANCELLED, APPLIED →
--              RENEWED | CANCELLED; RENEWED and CANCELLED never change.
--   every row  the window's first day ≤ its last; a two-letter language; the application exactly with its day, its
--              time and the window verdict (who and the words only with them), never on a STARTED renewal, always on an
--              APPLIED one, never after the day it was recorded (Europe/Rome); RENEWED exactly with the new certificate
--              (another one) and when; CANCELLED exactly with when and why.
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_certificate_renewal_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compliance: renewal % of certificate % is cancelled, never deleted', OLD."id", OLD."certificateId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'STARTED' OR NEW."appliedOn" IS NOT NULL OR NEW."appliedAt" IS NOT NULL OR NEW."newCertificateId" IS NOT NULL
       OR NEW."renewedAt" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN
      RAISE EXCEPTION 'compliance: renewal % starts STARTED, with nothing applied, renewed or cancelled', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."certificateId", NEW."windowOpensOn", NEW."windowClosesOn", NEW."language", NEW."startedAt", NEW."startedById", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."certificateId", OLD."windowOpensOn", OLD."windowClosesOn", OLD."language", OLD."startedAt", OLD."startedById", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the certificate, window, language, start and creation of renewal % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('RENEWED', 'CANCELLED') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'compliance: renewal % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."taskId" IS NOT NULL AND NEW."taskId" IS DISTINCT FROM OLD."taskId" THEN
      RAISE EXCEPTION 'compliance: renewal % names its task once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."appliedAt" IS NOT NULL
       AND (NEW."appliedOn", NEW."applicationReference", NEW."applicationNote", NEW."appliedInWindow", NEW."appliedAt", NEW."appliedById")
           IS DISTINCT FROM (OLD."appliedOn", OLD."applicationReference", OLD."applicationNote", OLD."appliedInWindow", OLD."appliedAt", OLD."appliedById") THEN
      RAISE EXCEPTION 'compliance: renewal % recorded its application on %; it is recorded once', OLD."id", OLD."appliedOn"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'STARTED' AND NEW."status" IN ('APPLIED', 'RENEWED', 'CANCELLED'))
      OR (OLD."status" = 'APPLIED' AND NEW."status" IN ('RENEWED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'compliance: renewal % cannot move from % to % (STARTED → APPLIED → RENEWED; cancelled before it is renewed)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."windowOpensOn" > NEW."windowClosesOn" OR NEW."language" !~ '^[a-z]{2}$' THEN
    RAISE EXCEPTION 'compliance: renewal % has its window''s first day on or before its last, and a two-letter language', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."appliedOn" IS NULL) <> (NEW."appliedAt" IS NULL) OR (NEW."appliedOn" IS NULL) <> (NEW."appliedInWindow" IS NULL)
     OR (NEW."appliedOn" IS NULL AND (NEW."appliedById" IS NOT NULL OR NEW."applicationReference" IS NOT NULL OR NEW."applicationNote" IS NOT NULL))
     OR btrim(NEW."applicationReference") = '' OR btrim(NEW."applicationNote") = ''
     OR (NEW."status" = 'STARTED' AND NEW."appliedOn" IS NOT NULL) OR (NEW."status" = 'APPLIED' AND NEW."appliedOn" IS NULL) THEN
    RAISE EXCEPTION 'compliance: renewal % is % with the wrong application: its day, the time it was recorded and whether it was in the window together (who, reference and note only with them), never while STARTED, always once APPLIED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."appliedOn" > (NEW."appliedAt" AT TIME ZONE 'Europe/Rome')::date THEN
    RAISE EXCEPTION 'compliance: renewal % records an application on %, after the day it was recorded', NEW."id", NEW."appliedOn"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'RENEWED') <> (NEW."newCertificateId" IS NOT NULL) OR (NEW."status" = 'RENEWED') <> (NEW."renewedAt" IS NOT NULL)
     OR (NEW."renewedById" IS NOT NULL AND NEW."renewedAt" IS NULL) OR NEW."newCertificateId" = NEW."certificateId" THEN
    RAISE EXCEPTION 'compliance: renewal % is % with the wrong renewal: renewed exactly with the new certificate (another one) and when', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '')
     OR (NEW."cancelledById" IS NOT NULL AND NEW."cancelledAt" IS NULL) THEN
    RAISE EXCEPTION 'compliance: renewal % is % with the wrong cancellation: cancelled exactly with when and why', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CertificateRenewal_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CertificateRenewal"
  FOR EACH ROW EXECUTE FUNCTION "factory_certificate_renewal_guard"();
CREATE TRIGGER "CertificateRenewal_no_truncate" BEFORE TRUNCATE ON "CertificateRenewal"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_w2b_refuse_truncate"();

-- =====================================================================================================================
-- Planning and purchasing: a carried firm line made planned again; the PO reminder switch
-- =====================================================================================================================

-- factory_material_requirement_guard (…_stock_plan_w2a_guards): its whole body; a line that carries a firm planned
-- order (firmCarriedFromId) must be firm when it is written, and may then be made planned again (its six firm columns
-- cleared, as any firm line), keeping firmCarriedFromId as its history (B-W2a-22's schema need; B-W2b-20 sets it).
CREATE OR REPLACE FUNCTION "factory_material_requirement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  decided CONSTANT text[] := ARRAY['decision', 'decisionNote', 'purchaseOrderLineId', 'decidedAt', 'decidedById',
    'firmQuantity', 'firmBaseQuantity', 'firmDate', 'firmSupplierId', 'firmedAt', 'firmedById', 'version', 'updatedAt'];
  run_state text;
  line_item uuid;
  line_colour uuid;
  carried record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supply: material requirement % is kept with its run, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || decided)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || decided)) THEN
      RAISE EXCEPTION 'supply: the numbers of material requirement % are its run''s snapshot; they never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT r."status"::text INTO run_state FROM "PlanningRun" r WHERE r."tenantId" = OLD."tenantId" AND r."id" = OLD."runId";
    IF run_state IS NOT NULL AND run_state <> 'DONE' THEN
      RAISE EXCEPTION 'supply: material requirement % is decided only while its run is DONE (it is %)', OLD."id", run_state
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."decision" = 'ORDERED' AND NEW."decision" = 'ORDERED'
       AND (NEW."firmQuantity", NEW."firmBaseQuantity", NEW."firmDate", NEW."firmSupplierId", NEW."firmedAt", NEW."firmedById")
           IS DISTINCT FROM (OLD."firmQuantity", OLD."firmBaseQuantity", OLD."firmDate", OLD."firmSupplierId", OLD."firmedAt", OLD."firmedById") THEN
      RAISE EXCEPTION 'supply: the firm planned order of material requirement % is fixed while it is ORDERED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."grossQuantity" < 0 OR NEW."usableStock" < 0 OR NEW."heldStock" < 0 OR NEW."onOrder" < 0 OR NEW."suggestedQuantity" < 0
     OR NEW."netQuantity" <> greatest(0, NEW."grossQuantity" - NEW."usableStock" - NEW."onOrder") THEN
    RAISE EXCEPTION 'supply: material requirement % has no negative quantity and a net need of max(0, gross - usable stock - on order)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."purchaseOrderLineId" IS NOT NULL AND NEW."decision" <> 'ORDERED')
     OR (NEW."decision" = 'ORDERED' AND NEW."action" = 'BUY' AND NEW."purchaseOrderLineId" IS NULL)
     OR (NEW."decision" <> 'OPEN') <> (NEW."decidedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'supply: material requirement % is ORDERED with the purchase order line that buys it (a BUY), and decided with its time', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."purchaseOrderLineId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."purchaseOrderLineId" IS DISTINCT FROM OLD."purchaseOrderLineId") THEN
    SELECT l."itemId", l."itemColourId" INTO line_item, line_colour
      FROM "PurchaseOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."purchaseOrderLineId";
    IF FOUND AND (line_item <> NEW."itemId" OR line_colour IS DISTINCT FROM NEW."itemColourId") THEN
      RAISE EXCEPTION 'supply: purchase order line % buys another material or colour than material requirement %', NEW."purchaseOrderLineId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- W2a: the firm planned order (PLN-075).
  IF (NEW."firmedAt" IS NULL) <> (NEW."firmQuantity" IS NULL) OR (NEW."firmedAt" IS NULL) <> (NEW."firmBaseQuantity" IS NULL)
     OR (NEW."firmedAt" IS NULL) <> (NEW."firmDate" IS NULL) OR (NEW."firmedById" IS NOT NULL AND NEW."firmedAt" IS NULL)
     OR (NEW."firmSupplierId" IS NOT NULL AND (NEW."firmedAt" IS NULL OR NEW."action" <> 'BUY'))
     OR NEW."firmQuantity" <= 0 OR NEW."firmBaseQuantity" <= 0 THEN
    RAISE EXCEPTION 'supply: the firm planned order of material requirement % has its quantity in both units (above 0), its date and time, and a supplier only for a BUY', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."firmedAt" IS NOT NULL AND NEW."decision" = 'IGNORED' THEN
    RAISE EXCEPTION 'supply: material requirement % is set aside (IGNORED); it is not a firm planned order', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."firmCarriedFromId" IS NOT NULL THEN
    -- W2b: a carried line is written firm; later it may be made planned again (its firm columns cleared), and keeps
    -- firmCarriedFromId (a snapshot column, never changed) as its history.
    IF TG_OP = 'INSERT' AND NEW."firmedAt" IS NULL THEN
      RAISE EXCEPTION 'supply: material requirement % carries a firm planned order, so it is firm when it is written (it may be made planned again later)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
      SELECT m."runId", m."itemId", m."itemColourId", m."action"::text AS "kind", m."firmedAt" INTO carried
        FROM "MaterialRequirement" m WHERE m."tenantId" = NEW."tenantId" AND m."siteId" = NEW."siteId" AND m."id" = NEW."firmCarriedFromId";
      IF FOUND AND (carried."runId" = NEW."runId" OR carried."itemId" <> NEW."itemId" OR carried."itemColourId" IS DISTINCT FROM NEW."itemColourId"
                    OR carried."kind" <> NEW."action"::text OR carried."firmedAt" IS NULL) THEN
        RAISE EXCEPTION 'supply: material requirement % carries a firm line of another run, of the same material, colour and action', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- PurchasingSettings (the Owner's switch for automatic PO confirmation reminders)
--   UPDATE     an UPDATE that changes nothing passes; the id, the company and the creation never change.
--   DELETE     refused (the settings are changed, never removed). TRUNCATE refused.
CREATE FUNCTION "factory_purchasing_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchasing: the purchasing settings % are changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD
     AND (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'purchasing: the id, company and creation of the purchasing settings % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PurchasingSettings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PurchasingSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_purchasing_settings_guard"();
CREATE TRIGGER "PurchasingSettings_no_truncate" BEFORE TRUNCATE ON "PurchasingSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_w2b_refuse_truncate"();

-- =====================================================================================================================
-- Costing: scrap from a rework opened by hand; the method apart from the overhead
-- =====================================================================================================================

-- factory_work_order_cost_entry_check (…_money_w2a_guards): its whole body; a SCRAP entry names its SCRAP move or the
-- scan that scrapped (at most one of them) or, with neither, the rework order of this work order that scrapped
-- (sourceType ReworkOrder: a rework opened by hand has no scan; B-W2a-21's follow-up). The ledger stays append-only.
CREATE OR REPLACE FUNCTION "factory_work_order_cost_entry_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_company uuid;
  method text;
  locked_at timestamptz;
  original record;
  move record;
  scan_order uuid;
  billed_order uuid;
  rework_order uuid;
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
    IF NEW."stockMoveId" IS NOT NULL AND NEW."operationScanId" IS NOT NULL THEN
      RAISE EXCEPTION 'costing: scrap entry % names its SCRAP move or the scan that scrapped (one of them)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b: neither: the scrap of a rework order of this work order opened by hand, with no scan (sourceType
    -- ReworkOrder, sourceId the rework order).
    IF NEW."stockMoveId" IS NULL AND NEW."operationScanId" IS NULL THEN
      IF NEW."sourceType" IS DISTINCT FROM 'ReworkOrder' THEN
        RAISE EXCEPTION 'costing: scrap entry % names its SCRAP move, the scan that scrapped, or the rework order of the work order that scrapped (sourceType ReworkOrder)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."workOrderId" INTO rework_order FROM "ReworkOrder" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."sourceId";
      IF NOT FOUND OR rework_order <> NEW."workOrderId" THEN
        RAISE EXCEPTION 'costing: scrap entry % names rework order %, which is not a rework order of work order %', NEW."id", NEW."sourceId", NEW."workOrderId"
          USING ERRCODE = 'check_violation';
      END IF;
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

-- CostingSettings (a trigger of its own; …_costing_guards' and …_money_w2a_guards' functions are untouched): a company's
-- row may hold its costing method only and follow the tenant-wide overhead (overheadFromTenant), its own overhead then 0;
-- the tenant-wide row never follows itself.
CREATE FUNCTION "factory_costing_overhead_source_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."overheadFromTenant" AND (NEW."companyId" IS NULL OR NEW."overheadPct" <> 0) THEN
    RAISE EXCEPTION 'costing: the costing settings % follow the tenant-wide overhead only as a company''s row, with its own overhead at 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CostingSettings_overhead_source" BEFORE INSERT OR UPDATE ON "CostingSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_costing_overhead_source_guard"();

-- =====================================================================================================================
-- Payables: live keys, files of several invoices, the claim a credit note settles, settings, the SDI inbox
-- =====================================================================================================================

-- The keys W2a held with plain unique keys (dropped by the schema migration): the same supplier's number and date once
-- while the invoice is not VOIDED (a voided typed invoice frees it: B-W2a-62's gap), and one single invoice per
-- IdentificativoSdI (the invoices of a file of several share theirs, each body once: the generated
-- SupplierInvoice_tenantId_sdiIdentifier_sdiBodyIndex_key).
CREATE UNIQUE INDEX "SupplierInvoice_one_live_per_number" ON "SupplierInvoice" ("tenantId", "companyId", "partyId", "number", "issueDate") WHERE "status" <> 'VOIDED';
CREATE UNIQUE INDEX "SupplierInvoice_one_per_sdi_delivery" ON "SupplierInvoice" ("tenantId", "sdiIdentifier") WHERE "sdiBodyIndex" IS NULL;

-- factory_supplier_invoice_guard (…_money_w2a_guards): its whole body, plus (W2b) the file of several invoices an SDI
-- invoice came in (what SDI said: never changes; the file's IdentificativoSdI and day; one of its bodies; a single
-- invoice never takes a file's IdentificativoSdI) and the claim a credit note settles (named once, any status but VOIDED,
-- a claim of the same company; the reference holds the supplier). Its triggers stay as they are.
CREATE OR REPLACE FUNCTION "factory_supplier_invoice_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  said CONSTANT text[] := ARRAY['partyId', 'kind', 'docType', 'number', 'issueDate', 'receivedOn', 'sdiIdentifier', 'sdiFileName', 'currency',
    'netTotal', 'vatTotal', 'grossTotal', 'withholdingAmount', 'stampDutyAmount', 'vatSummary', 'paymentTerms', 'dueDate', 'creditOfId',
    'sdiFileId', 'sdiBodyIndex'];
  journal CONSTANT text[] := ARRAY['partyId', 'kind', 'docType', 'number', 'issueDate', 'receivedOn', 'currency', 'netTotal', 'vatTotal', 'grossTotal',
    'withholdingAmount', 'stampDutyAmount', 'vatSummary'];
  approved_moves CONSTANT text[] := ARRAY['status', 'approvedAt', 'approvedById', 'approvalNote', 'paidOn', 'paymentRef', 'internalNote', 'version', 'updatedAt',
    'claimId', 'claimSiteId'];
  -- W2b: the claim a credit note settles is named once, in any status but VOIDED (a PAID credit note too).
  claim_columns CONSTANT text[] := ARRAY['claimId', 'claimSiteId'];
  credited_kind text;
  bad uuid;
  claim_company uuid;
  delivery record;
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
       AND (to_jsonb(NEW) - (kept || ARRAY['internalNote', 'version', 'updatedAt'] || CASE WHEN OLD."status" = 'PAID' THEN claim_columns ELSE '{}'::text[] END))
           IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['internalNote', 'version', 'updatedAt'] || CASE WHEN OLD."status" = 'PAID' THEN claim_columns ELSE '{}'::text[] END)) THEN
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
    IF OLD."claimId" IS NOT NULL AND (NEW."claimId", NEW."claimSiteId") IS DISTINCT FROM (OLD."claimId", OLD."claimSiteId") THEN
      RAISE EXCEPTION 'payables: credit note % settles claim %; the claim it settles is named once', OLD."id", OLD."claimId"
        USING ERRCODE = 'check_violation';
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
  -- W2b: the claim a credit note settles (claims' credit.matched).
  IF (NEW."claimId" IS NULL) <> (NEW."claimSiteId" IS NULL) OR (NEW."claimId" IS NOT NULL AND NEW."kind" <> 'CREDIT_NOTE') THEN
    RAISE EXCEPTION 'payables: only a supplier''s credit note names the claim it settles, with the claim''s site (%)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."claimId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."claimId" IS DISTINCT FROM OLD."claimId") THEN
    SELECT c."companyId" INTO claim_company FROM "SupplierClaim" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."claimId";
    IF FOUND AND claim_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'payables: credit note % settles claim %, a claim of another company', NEW."id", NEW."claimId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- W2b: an invoice of a file of several (a lotto): the file and its body, both or neither; SDI only; the file's
  -- IdentificativoSdI and day, a body of the file.
  IF (NEW."sdiFileId" IS NULL) <> (NEW."sdiBodyIndex" IS NULL) OR (NEW."sdiFileId" IS NOT NULL AND NEW."source" <> 'SDI') OR NEW."sdiBodyIndex" < 1 THEN
    RAISE EXCEPTION 'payables: supplier invoice % names the SDI file of several invoices it came in and its body (from 1), both or neither, only when it came through SDI', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."source" = 'SDI' AND (TG_OP = 'INSERT' OR (NEW."sdiIdentifier", NEW."sdiFileId") IS DISTINCT FROM (OLD."sdiIdentifier", OLD."sdiFileId")) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.payables.sdi', NEW."tenantId", NEW."sdiIdentifier"), 0));
    IF NEW."sdiFileId" IS NOT NULL THEN
      SELECT f."sdiIdentifier" AS sdi, f."invoiceCount" AS bodies, f."receivedOn" AS received INTO delivery
        FROM "SupplierInvoiceFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."sdiFileId";
      IF FOUND AND (delivery.sdi <> NEW."sdiIdentifier" OR NEW."sdiBodyIndex" > delivery.bodies OR delivery.received <> NEW."receivedOn") THEN
        RAISE EXCEPTION 'payables: supplier invoice % is body % of SDI file % (%, % invoices, received %): it carries the file''s IdentificativoSdI and day, as one of its bodies', NEW."id", NEW."sdiBodyIndex", NEW."sdiFileId", delivery.sdi, delivery.bodies, delivery.received
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF EXISTS (SELECT 1 FROM "SupplierInvoiceFile" f WHERE f."tenantId" = NEW."tenantId" AND f."sdiIdentifier" = NEW."sdiIdentifier") THEN
      RAISE EXCEPTION 'payables: SDI delivery % is a file of several invoices; each of them names the file and its body', NEW."sdiIdentifier"
        USING ERRCODE = 'check_violation';
    END IF;
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

-- PayablesSettings
--   UPDATE     an UPDATE that changes nothing passes; the id, the company and the creation never change.
--   every row  tolerances 0 to 100 percent; the amount tolerance 0 or more; LISTED exactly with one or more office users
--              of the tenant, each once (none otherwise).
--   DELETE     refused (changed, never removed). TRUNCATE refused.
CREATE FUNCTION "factory_payables_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stranger uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payables: the payables settings % are changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'payables: the id, company and creation of the payables settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."quantityTolerancePct" < 0 OR NEW."quantityTolerancePct" > 100 OR NEW."priceTolerancePct" < 0 OR NEW."priceTolerancePct" > 100
     OR NEW."differenceToleranceAmount" < 0 THEN
    RAISE EXCEPTION 'payables: the payables settings % have tolerances of 0 to 100 percent and an amount tolerance of 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sdiApproverIds" IS NULL
     OR (SELECT count(DISTINCT x) FROM unnest(NEW."sdiApproverIds") AS x) <> cardinality(NEW."sdiApproverIds")
     OR (NEW."sdiApproval" IS NOT DISTINCT FROM 'LISTED') <> (cardinality(NEW."sdiApproverIds") > 0) THEN
    RAISE EXCEPTION 'payables: the payables settings % list who approves what SDI delivered exactly when LISTED: one or more office users, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."sdiApproverIds" IS DISTINCT FROM OLD."sdiApproverIds" THEN
    SELECT x INTO stranger FROM unnest(NEW."sdiApproverIds") AS x
     WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = x)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'payables: % is not an office user of the tenant; the payables settings % list office users who approve what SDI delivered', stranger, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PayablesSettings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PayablesSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_payables_settings_guard"();
CREATE TRIGGER "PayablesSettings_no_truncate" BEFORE TRUNCATE ON "PayablesSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_w2b_refuse_truncate"();

-- SupplierInvoiceFile (a lotto: one SDI delivery, several invoices)
--   INSERT     its IdentificativoSdI is no single SDI invoice's (lock 'factory.payables.sdi' on it).
--   UPDATE     an UPDATE that changes nothing passes; only its XML is named, once (what SDI delivered never changes).
--   every row  an IdentificativoSdI and a file name; 2 invoices or more.
--   DELETE     refused (a fiscal document). TRUNCATE refused.
CREATE FUNCTION "factory_supplier_invoice_file_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  movable CONSTANT text[] := ARRAY['tenantId', 'xmlFileId', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payables: SDI file % (%) is a fiscal document, never deleted', OLD."id", OLD."sdiIdentifier"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable)
       OR (OLD."xmlFileId" IS NOT NULL AND NEW."xmlFileId" IS DISTINCT FROM OLD."xmlFileId") THEN
      RAISE EXCEPTION 'payables: SDI file % (%) is what SDI delivered: it never changes, and its XML is named once', OLD."id", OLD."sdiIdentifier"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."sdiIdentifier") = '' OR btrim(NEW."sdiFileName") = '' OR NEW."invoiceCount" < 2 THEN
    RAISE EXCEPTION 'payables: SDI file % has its IdentificativoSdI, its file name and two invoices or more (one invoice is a plain supplier invoice)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.payables.sdi', NEW."tenantId", NEW."sdiIdentifier"), 0));
    IF EXISTS (SELECT 1 FROM "SupplierInvoice" s WHERE s."tenantId" = NEW."tenantId" AND s."sdiIdentifier" = NEW."sdiIdentifier" AND s."sdiBodyIndex" IS NULL) THEN
      RAISE EXCEPTION 'payables: SDI delivery % is recorded already as one supplier invoice', NEW."sdiIdentifier"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SupplierInvoiceFile_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SupplierInvoiceFile"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_invoice_file_guard"();
CREATE TRIGGER "SupplierInvoiceFile_no_truncate" BEFORE TRUNCATE ON "SupplierInvoiceFile"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_w2b_refuse_truncate"();

-- SdiInboxItem (a delivery the pickup could not record)
--   INSERT     OPEN: nothing recorded or dismissed.
--   UPDATE     an UPDATE that changes nothing passes; the company, the account, what SDI said of the delivery (its
--              intermediary id, IdentificativoSdI, file name, delivery time), when it was first seen and the creation
--              never change; the XML is named once; the attempts only go up and the last try only moves later; OPEN →
--              RECORDED | DISMISSED, DISMISSED → OPEN; RECORDED never changes.
--   every row  its words; 1 attempt or more, the last try not before the first sight; RECORDED exactly with when and
--              what it became (one supplier invoice, or one file of several, of the same company and IdentificativoSdI);
--              DISMISSED exactly with when and why (who only with them).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_sdi_inbox_item_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  became record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payables: SDI inbox item % (%) is recorded or dismissed, never deleted', OLD."id", OLD."sdiIdentifier"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."recordedAt" IS NOT NULL OR NEW."dismissedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'payables: SDI inbox item % starts OPEN, nothing recorded or dismissed', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."accountId", NEW."providerRef", NEW."sdiIdentifier", NEW."fileName", NEW."receivedAt", NEW."firstSeenAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."accountId", OLD."providerRef", OLD."sdiIdentifier", OLD."fileName", OLD."receivedAt", OLD."firstSeenAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'payables: the company, account, delivery and creation of SDI inbox item % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'RECORDED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'payables: SDI inbox item % is RECORDED; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."xmlFileId" IS NOT NULL AND NEW."xmlFileId" IS DISTINCT FROM OLD."xmlFileId") OR NEW."attempts" < OLD."attempts" OR NEW."lastTriedAt" < OLD."lastTriedAt" THEN
      RAISE EXCEPTION 'payables: SDI inbox item % names its XML once, and its attempts and last try only move forward', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status" = 'OPEN' AND NEW."status" IN ('RECORDED', 'DISMISSED'))
      OR (OLD."status" = 'DISMISSED' AND NEW."status" = 'OPEN')) THEN
      RAISE EXCEPTION 'payables: SDI inbox item % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."providerRef") = '' OR btrim(NEW."sdiIdentifier") = '' OR btrim(NEW."fileName") = '' OR btrim(NEW."problemText") = ''
     OR NEW."attempts" < 1 OR NEW."lastTriedAt" < NEW."firstSeenAt" THEN
    RAISE EXCEPTION 'payables: SDI inbox item % has the delivery''s ids, its file name, why it waits in words, one attempt or more and its last try not before it was first seen', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'RECORDED') <> (NEW."recordedAt" IS NOT NULL)
     OR (NEW."status" = 'RECORDED') <> ((NEW."supplierInvoiceId" IS NULL) <> (NEW."supplierInvoiceFileId" IS NULL))
     OR (NEW."status" <> 'RECORDED' AND (NEW."supplierInvoiceId" IS NOT NULL OR NEW."supplierInvoiceFileId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'payables: SDI inbox item % is % with the wrong recording: recorded exactly with when and what it became (one supplier invoice or one file of several)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DISMISSED') <> (NEW."dismissedAt" IS NOT NULL)
     OR (NEW."status" = 'DISMISSED') <> (btrim(coalesce(NEW."dismissReason", '')) <> '')
     OR (NEW."dismissedById" IS NOT NULL AND NEW."dismissedAt" IS NULL) THEN
    RAISE EXCEPTION 'payables: SDI inbox item % is % with the wrong dismissal: dismissed exactly with when and why', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'RECORDED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'RECORDED') THEN
    IF NEW."supplierInvoiceId" IS NOT NULL THEN
      SELECT s."companyId" AS company, s."sdiIdentifier" AS sdi INTO became FROM "SupplierInvoice" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."supplierInvoiceId";
    ELSE
      SELECT f."companyId" AS company, f."sdiIdentifier" AS sdi INTO became FROM "SupplierInvoiceFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."supplierInvoiceFileId";
    END IF;
    IF FOUND AND (became.company <> NEW."companyId" OR became.sdi IS DISTINCT FROM NEW."sdiIdentifier") THEN
      RAISE EXCEPTION 'payables: SDI inbox item % (%) became a record of another delivery or company', NEW."id", NEW."sdiIdentifier"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SdiInboxItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SdiInboxItem"
  FOR EACH ROW EXECUTE FUNCTION "factory_sdi_inbox_item_guard"();
CREATE TRIGGER "SdiInboxItem_no_truncate" BEFORE TRUNCATE ON "SdiInboxItem"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_w2b_refuse_truncate"();

-- =====================================================================================================================
-- Payments and receivables: a NONE deposit carried onto the invoice, refund reasons, interest reference rates
-- =====================================================================================================================

-- factory_payment_allocation_check (…_money_w2a_guards): its whole body, plus (W2b, B-W2a-61's schema need) the carry of
-- a PAID deposit that issues no deposit invoice (NONE: an EU business with VIES proof) onto its order's invoice: its
-- allocation may be reversed (a TD02 deposit's allocations stay, as before), and the money is placed on an issued TD01 /
-- TD24 of the order by an allocation naming that reversal (carriedFromId: the same payment, the opposite amount, once).
-- Its trigger stays as it is.
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

-- The reversal of a PAID NONE deposit's allocation is carried in the same command: checked at commit (a deferred
-- constraint trigger), when the carry inserted after it is visible. PaymentAllocation is append-only, so a carry made is
-- never taken away.
CREATE FUNCTION "factory_payment_allocation_carry_due"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  deposit record;
BEGIN
  SELECT r."status"::text AS status, r."fiscalDocument"::text AS fiscal INTO deposit
    FROM "DepositRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."depositRequestId";
  IF FOUND AND deposit.status = 'PAID' AND deposit.fiscal = 'NONE'
     AND NOT EXISTS (SELECT 1 FROM "PaymentAllocation" c WHERE c."tenantId" = NEW."tenantId" AND c."carriedFromId" = NEW."id") THEN
    RAISE EXCEPTION 'payments: reversal % takes money back from deposit request %, which is PAID; in the same command it is carried onto an invoice of its order (an allocation naming it as carriedFromId)', NEW."id", NEW."depositRequestId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "PaymentAllocation_carry_due" AFTER INSERT ON "PaymentAllocation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."reversalOfId" IS NOT NULL AND NEW."depositRequestId" IS NOT NULL)
  EXECUTE FUNCTION "factory_payment_allocation_carry_due"();

-- factory_refund_guard (…_money_w2a_guards): its whole body; a DUE refund's reason (reasonCode, W2b) changes with its
-- amount and due date, and is fixed once it is PAID (as everything that was paid). Its triggers stay as they are.
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

-- InterestReferenceRate (D.Lgs. 231/2002 art. 5)
--   UPDATE     an UPDATE that changes nothing passes; the half-year and the creation never change (the rate, the points,
--              the source and the note are corrected).
--   every row  the half-year starts on 1 January or 1 July; the reference rate −10 to 100 percent; the points 0 to 100;
--              where it was published, never blank.
--   DELETE     refused (corrected, never removed: interest was computed from it). TRUNCATE refused.
CREATE FUNCTION "factory_interest_reference_rate_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receivables: the reference rate of the half-year from % is corrected, never deleted', OLD."halfYearStart"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."halfYearStart", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."halfYearStart", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'receivables: the half-year and creation of reference rate % never change (another half-year is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF extract(day FROM NEW."halfYearStart") <> 1 OR extract(month FROM NEW."halfYearStart") NOT IN (1, 7) THEN
    RAISE EXCEPTION 'receivables: reference rate % starts its half-year on 1 January or 1 July, not %', NEW."id", NEW."halfYearStart"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."referenceRatePct" < -10 OR NEW."referenceRatePct" > 100 OR NEW."addedPointsPct" < 0 OR NEW."addedPointsPct" > 100 OR btrim(NEW."source") = '' THEN
    RAISE EXCEPTION 'receivables: reference rate % has a rate of -10 to 100 percent, the points the law adds (0 to 100) and where it was published', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InterestReferenceRate_guard" BEFORE INSERT OR UPDATE OR DELETE ON "InterestReferenceRate"
  FOR EACH ROW EXECUTE FUNCTION "factory_interest_reference_rate_guard"();
CREATE TRIGGER "InterestReferenceRate_no_truncate" BEFORE TRUNCATE ON "InterestReferenceRate"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_followups_w2b_refuse_truncate"();
