-- Written by hand (Prisma does not model triggers), after the generated …_cost_actuals_w2b_schema and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Actual cost to the end (W2b-6, schema wave 54/57, B-W2b-376; cost-actuals.prisma; MES-012, MES-013, FIN-029, FIN-030,
-- FIN-031, FIN-034, FIN-043, FIN-044; GATE-ACCOUNTANT). These rules hold for every login, the owner included;
-- apps/factory-api's commands (B-W2b-411, B-W2b-407) check them first in words. Every refusal is a check_violation
-- (SQLSTATE 23514) in words. The row guards are AFTER triggers (the policies speak first); the refused changes of the
-- ledgers and the refused deletes are BEFORE triggers. An UPDATE that changes nothing passes. A rule that reads another
-- row skips one the session cannot see (the isolation tests' copies): the policies or the references refuse that write
-- anyway.
--
-- Reused as they are: recall's `factory_recall_words_ok`, `factory_recall_not_future`; money's `factory_money_rome_day`
-- and `factory_period_refuse_locked` (a posting dated inside a HARD-locked period is refused).
--
-- It redefines one function of an earlier hand-written migration (its trigger stays):
--   "factory_work_order_guard" (202611132003_production_option_steps_w2b_guards): CLOSED is no longer final: CLOSED →
--                              COMPLETED when the close is undone or reopened (MES-013), changing only the status, the
--                              closing time, the note and the version; the rest of the body is unchanged, word for word.
-- Own triggers on earlier tables: `WorkOrder_close_reopen_check` (WorkOrder: back to COMPLETED only with its close undone
-- and the close's entries reversed) and `WorkOrderCostEntry_close_check` (WorkOrderCostEntry: the W2a check
-- `WorkOrderCostEntry_check` stays as it is; this one adds the close's kinds CLOSE and VARIANCE and "a closed work order
-- takes no cost entry but a reversal").
--
-- GATE-ACCOUNTANT (lead decision 11-13): the accountant's figures — a close's VARIANCE and CLOSE entries and its
-- WorkOrderVariance rows, PurchasePriceVariance, CostOfSalesEntry, a landed cost's POSTED — are written only while the
-- company's ActualCostSettings.postingsOn is true (`factory_cost_actuals_postings_on`): no row, or a row the session cannot
-- see, is off. A reversal waits for no switch.

CREATE FUNCTION "factory_cost_actuals_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cost: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_cost_actuals_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cost: % % is kept, never deleted', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

-- The append-only ledgers of this wave (scripts/factory/check-append-only.mjs): WorkOrderVariance, PurchasePriceVariance
-- and CostOfSalesEntry. No login changes or removes a row, the owner included; the runtime roles have no UPDATE, DELETE or
-- TRUNCATE grant either.
CREATE FUNCTION "factory_cost_actuals_ledger_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; a variance and a cost of goods sold are kept as they were written (a wrong one is reversed by a new row)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- GATE-ACCOUNTANT: the company's switch for the accountant's figures (its own ActualCostSettings rows; none, or one the
-- session cannot see: off).
CREATE FUNCTION "factory_cost_actuals_postings_on"(tenant uuid, company uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(bool_and(s."postingsOn"), false)
    FROM "ActualCostSettings" s WHERE s."tenantId" = tenant AND s."companyId" = company
$$;

CREATE FUNCTION "factory_cost_actuals_require_postings"(tenant uuid, company uuid, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT "factory_cost_actuals_postings_on"(tenant, company) THEN
    RAISE EXCEPTION 'cost: the company''s figures for the accountant are switched off (GATE-ACCOUNTANT): % is written only once a person switches them on in the costing settings', what
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- The close tolerance in force for a company: its own row's, else the tenant-wide row's, else 5 %.
CREATE FUNCTION "factory_cost_actuals_tolerance"(tenant uuid, company uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT s."closeTolerancePct" FROM "ActualCostSettings" s WHERE s."tenantId" = tenant AND s."companyId" = company ORDER BY s."createdAt", s."id" LIMIT 1),
    (SELECT s."closeTolerancePct" FROM "ActualCostSettings" s WHERE s."tenantId" = tenant AND s."companyId" IS NULL ORDER BY s."createdAt", s."id" LIMIT 1),
    5::numeric)
$$;

-- Where the company takes its purchase price variance: its own row's, else the tenant-wide row's, else RECEIPT.
CREATE FUNCTION "factory_cost_actuals_ppv_at"(tenant uuid, company uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT s."ppvAt"::text FROM "ActualCostSettings" s WHERE s."tenantId" = tenant AND s."companyId" = company ORDER BY s."createdAt", s."id" LIMIT 1),
    (SELECT s."ppvAt"::text FROM "ActualCostSettings" s WHERE s."tenantId" = tenant AND s."companyId" IS NULL ORDER BY s."createdAt", s."id" LIMIT 1),
    'RECEIPT')
$$;

-- An actual figure beyond its planned one by more than `tol` percent (MES-012); nothing planned: anything actual is beyond.
CREATE FUNCTION "factory_cost_actuals_beyond"(planned numeric, actual numeric, tol numeric) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN planned = 0 THEN actual > 0 ELSE abs(actual - planned) * 100 > planned * tol END
$$;

-- A close reason code (the API's list): capitals, digits and underscores, 1 to 40, starting with a capital.
CREATE FUNCTION "factory_cost_actuals_code_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{0,39}$'
$$;

-- The digits of a currency's minor unit for a company (its Currency row; none, or one the session cannot see: 2).
CREATE FUNCTION "factory_cost_actuals_minor"(tenant uuid, company uuid, currency_code text) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT c."minorUnits" FROM "Currency" c
                    WHERE c."tenantId" = tenant AND c."companyId" = company AND c."code" = currency_code AND c."active"
                    ORDER BY c."createdAt" LIMIT 1), 2)
$$;

-- A reason in words: 3 to 1,000 characters, lines allowed.
CREATE FUNCTION "factory_cost_actuals_reason_ok"(reason text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT reason IS NOT NULL AND char_length(btrim(reason)) >= 3 AND "factory_recall_words_ok"(reason, 1000, true)
$$;

-- One work order's cost ledger is written by one transaction at a time: the same lock as apps/factory-api's costing
-- poster (actual/store.ts lockWorkOrderCosts), so a close and a poster take turns.
CREATE FUNCTION "factory_cost_actuals_lock_work_order"(tenant uuid, work_order uuid) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.costing.work-order', tenant, work_order), 0))
$$;

-- =====================================================================================================================
-- ActualCostSettings (MES-012; GATE-ACCOUNTANT)
--   every row  the tolerance 0 to 100; the switch only on a company's own row (the tenant-wide row holds the tolerance and
--              the purchase price variance's place only), on exactly with when (not in the future) and by whom.
--   UPDATE     the company and creation never change; while the switch stays on, when and by whom are fixed.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_actual_cost_settings_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'cost: the company and creation of actual-cost settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."postingsOn" AND NEW."postingsOn" AND (NEW."postingsOnAt", NEW."postingsOnById") IS DISTINCT FROM (OLD."postingsOnAt", OLD."postingsOnById") THEN
      RAISE EXCEPTION 'cost: the accountant''s figures are on since %; when and by whom they were switched on never change while they stay on', OLD."postingsOnAt"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."closeTolerancePct" < 0 OR NEW."closeTolerancePct" > 100 THEN
    RAISE EXCEPTION 'cost: the close tolerance of settings % is a percent from 0 to 100, not %', NEW."id", NEW."closeTolerancePct"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."postingsOn" AND NEW."companyId" IS NULL THEN
    RAISE EXCEPTION 'cost: the accountant''s figures are switched on per company, on its own settings row, never on the tenant-wide one (GATE-ACCOUNTANT)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."postingsOn" <> (NEW."postingsOnAt" IS NOT NULL) OR (NEW."postingsOnAt" IS NULL) <> (NEW."postingsOnById" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."postingsOnAt") THEN
    RAISE EXCEPTION 'cost: the accountant''s figures are switched on with when (not in the future) and the person who did it, both; off has neither (settings %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ActualCostSettings_check" AFTER INSERT OR UPDATE ON "ActualCostSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_actual_cost_settings_check"();
CREATE TRIGGER "ActualCostSettings_never_deleted" BEFORE DELETE ON "ActualCostSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_actuals_never_deleted"();
CREATE TRIGGER "ActualCostSettings_no_truncate" BEFORE TRUNCATE ON "ActualCostSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_actuals_refuse_truncate"();

-- =====================================================================================================================
-- WorkOrderClose (MES-012, MES-013, FIN-034)
--   every row  the work order's company; garments, material cost and minutes 0 or more; an ISO currency; the tolerance 0
--              to 100; the reason code exactly when a figure is beyond the tolerance (garments, material cost or minutes
--              against their planned ones; scrap above its allowance by more than the tolerance of the planned garments),
--              a code of capitals; its words (1 to 1,000) optional; closed not in the future; undone at and by whom, both
--              or neither, not before the close and not in the future; a reopen's reason (3 to 1,000 words) only on an
--              undone close, and needed unless the person who closed it undid it within 60 seconds (the Undo, MES-013).
--   INSERT     the tolerance is the company's in force (ActualCostSettings). A live close (not undone) closes a COMPLETED
--              work order that has no other live close (under the work order's costing lock). A close may be written
--              undone (history; the isolation tests' copies).
--   UPDATE     only the undo is written (undoneAt, undoneById, reopenReason, once); everything else is fixed, and an undone
--              close changes no more.
--   at commit  a live close's work order is CLOSED at the close's time; an undone close's work order is not (it went back
--              to COMPLETED, or was closed again later).
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_work_order_close_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  movable CONSTANT text[] := ARRAY['undoneAt', 'undoneById', 'reopenReason', 'version', 'updatedAt'];
  order_company uuid;
  order_state text;
  beyond boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."undoneAt" IS NOT NULL THEN
      RAISE EXCEPTION 'cost: close % of work order % was undone at %; it changes no more (a new close is a new row)', OLD."id", OLD."workOrderId", OLD."undoneAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable) THEN
      RAISE EXCEPTION 'cost: close % of work order % keeps what was closed, when and by whom; only its undo is written (undone at, by whom, why)', OLD."id", OLD."workOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT w."companyId" INTO order_company FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
  IF FOUND AND order_company <> NEW."companyId" THEN
    RAISE EXCEPTION 'cost: close % is of work order %''s company', NEW."id", NEW."workOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."plannedQuantity" < 0 OR NEW."actualQuantity" < 0 OR NEW."plannedScrapQuantity" < 0 OR NEW."scrapQuantity" < 0
     OR NEW."plannedMaterialCost" < 0 OR NEW."actualMaterialCost" < 0 OR NEW."plannedMinutes" < 0 OR NEW."actualMinutes" < 0
     OR NEW."currency" !~ '^[A-Z]{3}$' OR NEW."tolerancePct" < 0 OR NEW."tolerancePct" > 100 THEN
    RAISE EXCEPTION 'cost: close % has garments, material cost and minutes of 0 or more, an ISO currency and a tolerance from 0 to 100', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  beyond := "factory_cost_actuals_beyond"(NEW."plannedQuantity", NEW."actualQuantity", NEW."tolerancePct")
         OR "factory_cost_actuals_beyond"(NEW."plannedMaterialCost", NEW."actualMaterialCost", NEW."tolerancePct")
         OR "factory_cost_actuals_beyond"(NEW."plannedMinutes", NEW."actualMinutes", NEW."tolerancePct")
         OR (NEW."scrapQuantity" - NEW."plannedScrapQuantity") * 100 > NEW."plannedQuantity" * NEW."tolerancePct"
         OR (NEW."plannedQuantity" = 0 AND NEW."scrapQuantity" > NEW."plannedScrapQuantity");
  IF beyond <> (NEW."reasonCode" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('cost: close %s of work order %s %s (MES-012)', NEW."id", NEW."workOrderId",
        CASE WHEN beyond THEN format('is beyond the %s %% tolerance (garments %s of %s, material %s of %s, minutes %s of %s, scrap %s over %s): it needs a reason code', NEW."tolerancePct", NEW."actualQuantity", NEW."plannedQuantity", NEW."actualMaterialCost", NEW."plannedMaterialCost", NEW."actualMinutes", NEW."plannedMinutes", NEW."scrapQuantity", NEW."plannedScrapQuantity")
             ELSE format('is within the %s %% tolerance: it takes no reason code (words go in the note)', NEW."tolerancePct") END);
  END IF;
  IF NOT "factory_cost_actuals_code_ok"(NEW."reasonCode") OR NOT "factory_recall_words_ok"(NEW."reasonNote", 1000, true) THEN
    RAISE EXCEPTION 'cost: close % has a reason code of capitals, digits and underscores (1 to 40) and words of 1 to 1,000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."closedAt")
     OR (NEW."undoneAt" IS NULL) <> (NEW."undoneById" IS NULL)
     OR NEW."undoneAt" < NEW."closedAt" OR NOT "factory_recall_not_future"(NEW."undoneAt") THEN
    RAISE EXCEPTION 'cost: close % is closed not in the future, and undone with when (not before the close, not in the future) and by whom, both, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reopenReason" IS NOT NULL AND (NEW."undoneAt" IS NULL OR NOT "factory_cost_actuals_reason_ok"(NEW."reopenReason")) THEN
    RAISE EXCEPTION 'cost: close % says why it was reopened (3 to 1,000 characters), and only once it is undone', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."undoneAt" IS NOT NULL AND NEW."reopenReason" IS NULL
     AND NOT (NEW."undoneById" = NEW."closedById" AND NEW."undoneAt" <= NEW."closedAt" + interval '60 seconds') THEN
    RAISE EXCEPTION 'cost: close % of work order % was taken back % after it was closed%: a reopen says why (MES-013; only the person who closed it undoes it within 60 seconds without a reason)', NEW."id", NEW."workOrderId", NEW."undoneAt" - NEW."closedAt",
      CASE WHEN NEW."undoneById" <> NEW."closedById" THEN ', by someone else' ELSE '' END
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."tolerancePct" <> "factory_cost_actuals_tolerance"(NEW."tenantId", NEW."companyId") THEN
      RAISE EXCEPTION 'cost: close % is judged against the company''s close tolerance in force (% %%), not % %%', NEW."id", "factory_cost_actuals_tolerance"(NEW."tenantId", NEW."companyId"), NEW."tolerancePct"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."undoneAt" IS NULL THEN
      PERFORM "factory_cost_actuals_lock_work_order"(NEW."tenantId", NEW."workOrderId");
      SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
      IF FOUND AND order_state <> 'COMPLETED' THEN
        RAISE EXCEPTION 'cost: work order % is %; a work order is closed once it is COMPLETED (close %)', NEW."workOrderId", order_state, NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "WorkOrderClose" c
                  WHERE c."tenantId" = NEW."tenantId" AND c."workOrderId" = NEW."workOrderId" AND c."undoneAt" IS NULL AND c."id" <> NEW."id") THEN
        RAISE EXCEPTION 'cost: work order % has a live close already; undo it first (close %)', NEW."workOrderId", NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WorkOrderClose_check" AFTER INSERT OR UPDATE ON "WorkOrderClose"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_close_check"();
CREATE TRIGGER "WorkOrderClose_never_deleted" BEFORE DELETE ON "WorkOrderClose"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_actuals_never_deleted"();
CREATE TRIGGER "WorkOrderClose_no_truncate" BEFORE TRUNCATE ON "WorkOrderClose"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_actuals_refuse_truncate"();

-- At commit: the close and its work order agree (the row as it stands then).
CREATE FUNCTION "factory_work_order_close_settled"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wo_close record;
  work_order record;
BEGIN
  SELECT c."workOrderId", c."closedAt", c."undoneAt" INTO wo_close FROM "WorkOrderClose" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."id";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT w."status"::text AS status, w."closedAt" AS closed_at INTO work_order FROM "WorkOrder" w
   WHERE w."tenantId" = NEW."tenantId" AND w."id" = wo_close."workOrderId";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF wo_close."undoneAt" IS NULL AND (work_order.status <> 'CLOSED' OR work_order.closed_at IS DISTINCT FROM wo_close."closedAt") THEN
    RAISE EXCEPTION 'cost: work order % is % (closed at %), but its close % says it closed at %: a live close goes with the work order CLOSED at its time, in the same transaction', wo_close."workOrderId", work_order.status, coalesce(work_order.closed_at::text, 'none'), NEW."id", wo_close."closedAt"
      USING ERRCODE = 'check_violation';
  END IF;
  IF wo_close."undoneAt" IS NOT NULL AND work_order.status = 'CLOSED' AND work_order.closed_at = wo_close."closedAt" THEN
    RAISE EXCEPTION 'cost: close % of work order % is undone, but the work order is still CLOSED by it: move it back to COMPLETED in the same transaction (MES-013)', NEW."id", wo_close."workOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "WorkOrderClose_settled" AFTER INSERT OR UPDATE ON "WorkOrderClose"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_close_settled"();

-- =====================================================================================================================
-- WorkOrder: back to COMPLETED (MES-013), its own trigger beside the guard
--   CLOSED → COMPLETED  only when the close that closed it (its close at the work order's closing time) is undone, and
--                       every VARIANCE and CLOSE entry of that close is reversed. A work order closed with no close row
--                       (W1's close, before B-W2b-411 writes one) is not reopened.
CREATE FUNCTION "factory_work_order_close_reopen_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wo_close record;
  open_entries integer;
BEGIN
  SELECT c."id", c."undoneAt" INTO wo_close FROM "WorkOrderClose" c
   WHERE c."tenantId" = NEW."tenantId" AND c."workOrderId" = NEW."id" AND c."closedAt" = OLD."closedAt"
   ORDER BY c."undoneAt" NULLS FIRST LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'production: work order % was closed with no close record (before B-W2b-376); it is not reopened', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF wo_close."undoneAt" IS NULL THEN
    RAISE EXCEPTION 'production: work order % goes back to COMPLETED only with its close % undone (undone at, by whom, and why for a reopen; MES-013)', NEW."id", wo_close."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO open_entries FROM "WorkOrderCostEntry" e
   WHERE e."tenantId" = NEW."tenantId" AND e."workOrderId" = NEW."id" AND e."reversalOfId" IS NULL
     AND ((e."kind" = 'CLOSE' AND e."sourceType" = 'WorkOrderClose' AND e."sourceId" = wo_close."id")
          OR (e."kind" = 'VARIANCE' AND e."sourceType" = 'WorkOrderVariance'
              AND e."sourceId" IN (SELECT v."id" FROM "WorkOrderVariance" v WHERE v."tenantId" = NEW."tenantId" AND v."closeId" = wo_close."id")))
     AND NOT EXISTS (SELECT 1 FROM "WorkOrderCostEntry" r WHERE r."tenantId" = NEW."tenantId" AND r."reversalOfId" = e."id");
  IF open_entries > 0 THEN
    RAISE EXCEPTION 'production: work order % goes back to COMPLETED only once the % variance and closing entr(y/ies) of its undone close % are reversed', NEW."id", open_entries, wo_close."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WorkOrder_close_reopen_check" AFTER UPDATE OF "status" ON "WorkOrder"
  FOR EACH ROW WHEN (OLD."status" = 'CLOSED' AND NEW."status" = 'COMPLETED')
  EXECUTE FUNCTION "factory_work_order_close_reopen_check"();

-- =====================================================================================================================
-- WorkOrder: factory_work_order_guard of …_production_option_steps_w2b_guards, redefined whole. The changes, marked
-- "B-W2b-376" below:
--   transitions    CLOSED → COMPLETED (an undone or reopened close, MES-013; WorkOrder_close_reopen_check says when).
--   CLOSED         still changes only its note, but in the move back to COMPLETED, which changes the status and the
--                  closing time too (and nothing else).
CREATE OR REPLACE FUNCTION "factory_work_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  -- W2b: rush moves with the priority.
  progress CONSTANT text[] := ARRAY['status', 'dueDate', 'priority', 'rush', 'note', 'startedAt', 'completedAt', 'closedAt', 'cancelledAt',
    'cancelReason', 'lineId', 'heldFromStatus', 'holdReason', 'heldAt', 'heldById', 'holdRecordType', 'holdRecordId', 'version', 'updatedAt'];
  effective text;
  revision_state text;
  revision_label uuid;
  label_state text;
  line_state text;
  cells integer;
  wrong_cells integer;
  operations integer;
  unmapped integer;
  parent record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: work order % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'production: work order % starts as DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2b (MES-010): a split's parent is another work order of the same style and kind, still open.
    IF NEW."splitFromId" IS NOT NULL THEN
      SELECT w."styleId", w."kind"::text AS kind, w."status"::text AS status INTO parent
        FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."splitFromId";
      IF NEW."splitFromId" = NEW."id" OR (FOUND AND (parent."styleId" <> NEW."styleId" OR parent.kind <> NEW."kind"::text)) THEN
        RAISE EXCEPTION 'production: work order % is split from another work order of the same style and kind (MES-010)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF FOUND AND parent.status IN ('CANCELLED', 'CLOSED', 'COMPLETED') THEN
        RAISE EXCEPTION 'production: work order % is %; nothing is split from it', NEW."splitFromId", parent.status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    -- W2b: the split it came from never changes either.
    IF (NEW."id", NEW."companyId", NEW."number", NEW."kind", NEW."styleId", NEW."splitFromId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."number", OLD."kind", OLD."styleId", OLD."splitFromId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: the company, number, kind, style, split and creation of work order % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-W2b-376: CLOSED → COMPLETED (MES-013: its close undone or reopened).
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('RELEASED', 'CANCELLED', 'ON_HOLD'))
                OR (OLD."status" = 'RELEASED' AND NEW."status" IN ('IN_PROGRESS', 'CANCELLED', 'ON_HOLD'))
                OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('COMPLETED', 'CANCELLED', 'ON_HOLD'))
                OR (OLD."status" = 'COMPLETED' AND NEW."status" = 'CLOSED')
                OR (OLD."status" = 'CLOSED' AND NEW."status" = 'COMPLETED')
                OR (OLD."status" = 'ON_HOLD' AND (NEW."status" = OLD."heldFromStatus" OR NEW."status" = 'CANCELLED'))) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('production: work order %s cannot move from %s to %s%s', OLD."id", OLD."status", NEW."status",
          CASE WHEN OLD."status" = 'ON_HOLD' THEN format(' (lifting its hold puts it back to %s, MES-008)', OLD."heldFromStatus") ELSE '' END);
    END IF;
    IF NEW."status" = 'ON_HOLD' AND OLD."status" <> 'ON_HOLD' AND NEW."heldFromStatus" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'production: work order % is held from the status it is in (%), the status lifting the hold goes back to (MES-008)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'ON_HOLD' AND OLD."status" = 'ON_HOLD'
       AND (NEW."heldFromStatus", NEW."heldAt", NEW."heldById") IS DISTINCT FROM (OLD."heldFromStatus", OLD."heldAt", OLD."heldById") THEN
      RAISE EXCEPTION 'production: the hold of work order % keeps where it was held from, when and by whom; a new hold comes after this one is lifted', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - (kept || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || progress)) THEN
      RAISE EXCEPTION 'production: work order % is %; its frozen specification (revision, label template, batch number) and release never change (MES-005); a different specification is a new work order', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-W2b-376: the move back to COMPLETED also changes the status and the closing time.
    IF OLD."status" IN ('CLOSED', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt']
                                  || CASE WHEN OLD."status" = 'CLOSED' AND NEW."status" = 'COMPLETED' THEN ARRAY['status', 'closedAt'] ELSE ARRAY[]::text[] END))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt']
                                  || CASE WHEN OLD."status" = 'CLOSED' AND NEW."status" = 'COMPLETED' THEN ARRAY['status', 'closedAt'] ELSE ARRAY[]::text[] END)) THEN
      RAISE EXCEPTION 'production: work order % is %; only its note changes%', OLD."id", OLD."status",
        CASE WHEN OLD."status" = 'CLOSED' THEN ' (or it goes back to COMPLETED when its close is undone)' ELSE '' END
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'COMPLETED' AND NEW."lineId" IS DISTINCT FROM OLD."lineId" THEN
      RAISE EXCEPTION 'production: work order % is COMPLETED; the line it was made on stays (output is counted per line)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'DRAFT' AND NEW."status" = 'RELEASED' THEN
      IF NEW."styleRevisionId" IS NULL THEN
        RAISE EXCEPTION 'production: work order % is released with a RELEASED revision of its style', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."status"::text, r."labelTemplateId" INTO revision_state, revision_label
        FROM "StyleRevision" r WHERE r."tenantId" = NEW."tenantId" AND r."styleId" = NEW."styleId" AND r."id" = NEW."styleRevisionId";
      IF FOUND THEN
        IF revision_state <> 'RELEASED' THEN
          RAISE EXCEPTION 'production: revision % is %; work order % is released only with a RELEASED revision of its style', NEW."styleRevisionId", revision_state, NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."labelTemplateId" IS DISTINCT FROM revision_label THEN
          RAISE EXCEPTION 'production: work order % carries the label template of its revision % (%), frozen with it', NEW."id", NEW."styleRevisionId", coalesce(revision_label::text, 'none')
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      IF NEW."labelTemplateId" IS NOT NULL THEN
        SELECT t."status"::text INTO label_state FROM "LabelTemplate" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."labelTemplateId";
        IF FOUND AND label_state <> 'ACTIVE' THEN
          RAISE EXCEPTION 'production: label template % is %; work order % is released with an ACTIVE one', NEW."labelTemplateId", label_state, NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      SELECT count(*),
             count(*) FILTER (WHERE CASE WHEN NEW."kind" = 'REPAIR'
                                         THEN c."measurementProfileId" IS NOT NULL AND c."quantity" <> 1
                                         ELSE (c."measurementProfileId" IS NOT NULL) <> (NEW."kind" = 'MADE_TO_MEASURE')
                                              OR (NEW."kind" = 'MADE_TO_MEASURE' AND c."quantity" <> 1) END)
        INTO cells, wrong_cells
        FROM "WorkOrderSize" c WHERE c."tenantId" = NEW."tenantId" AND c."workOrderId" = NEW."id";
      IF cells = 0 OR wrong_cells > 0 OR (NEW."kind" = 'MADE_TO_MEASURE' AND cells <> 1) THEN
        RAISE EXCEPTION 'production: work order % is released with its cells: a size grid without measurement profiles, one made-to-measure unit of quantity 1 with its profile, or a repair''s garments (a made-to-measure one a single unit with its profile)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*) INTO operations FROM "WorkOrderOperation" o WHERE o."tenantId" = NEW."tenantId" AND o."workOrderId" = NEW."id";
      -- B-W2b-F40: only the steps one of its cells is for (factory-domain product/routing-depth stepIsFor): a step for
      -- every cell, or one only for some sizes, colourways or options when a cell is of them; the others may be left out.
      SELECT count(*) INTO unmapped
        FROM "RoutingOperation" ro
       WHERE ro."tenantId" = NEW."tenantId" AND ro."revisionId" = NEW."styleRevisionId"
         AND EXISTS (SELECT 1 FROM "WorkOrderSize" c
                      WHERE c."tenantId" = NEW."tenantId" AND c."workOrderId" = NEW."id"
                        AND (cardinality(coalesce(ro."appliesToSizes", '{}'::text[])) = 0 OR c."size" = ANY (ro."appliesToSizes"))
                        AND (cardinality(coalesce(ro."appliesToColourwayIds", '{}'::uuid[])) = 0 OR c."colourwayId" = ANY (ro."appliesToColourwayIds"))
                        AND (cardinality(coalesce(ro."appliesToOptionValueIds", '{}'::uuid[])) = 0
                             OR coalesce(c."optionValueIds", '{}'::uuid[]) && ro."appliesToOptionValueIds"))
         AND NOT EXISTS (SELECT 1 FROM "WorkOrderOperation" o
                          WHERE o."tenantId" = NEW."tenantId" AND o."workOrderId" = NEW."id" AND o."routingSeq" = ro."seq");
      IF operations = 0 OR (NEW."kind" <> 'REPAIR' AND unmapped > 0) THEN
        RAISE EXCEPTION 'production: work order % is released with every step of its revision''s routing as an operation at a work centre of its site (% step(s) missing), but a step only for sizes, colourways or options none of its cells has; a repair with at least one', NEW."id", unmapped
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  effective := CASE WHEN NEW."status" = 'ON_HOLD' THEN NEW."heldFromStatus"::text ELSE NEW."status"::text END;

  IF btrim(NEW."number") = '' OR (NEW."batchNumber" IS NOT NULL AND btrim(NEW."batchNumber") = '') THEN
    RAISE EXCEPTION 'production: work order % has a number, and a batch number that is not blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ON_HOLD') <> (NEW."heldFromStatus" IS NOT NULL)
     OR (NEW."status" = 'ON_HOLD') <> (NEW."heldAt" IS NOT NULL)
     OR (NEW."status" = 'ON_HOLD') <> (btrim(coalesce(NEW."holdReason", '')) <> '')
     OR (NEW."status" <> 'ON_HOLD' AND (NEW."heldById" IS NOT NULL OR NEW."holdRecordType" IS NOT NULL OR NEW."holdRecordId" IS NOT NULL))
     OR (NEW."heldFromStatus" IS NOT NULL AND NEW."heldFromStatus" NOT IN ('DRAFT', 'RELEASED', 'IN_PROGRESS'))
     OR (NEW."holdRecordType" IS NULL) <> (NEW."holdRecordId" IS NULL)
     OR btrim(coalesce(NEW."holdRecordType", '-')) = '' THEN
    RAISE EXCEPTION 'production: work order % is % with the wrong hold: ON_HOLD exactly with the status it was held from (DRAFT, RELEASED or IN_PROGRESS), when and why (MES-008), and the record behind it as type and id or neither; no hold otherwise', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lineId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."lineId" IS DISTINCT FROM OLD."lineId") THEN
    SELECT l."status"::text INTO line_state FROM "Line" l WHERE l."tenantId" = NEW."tenantId" AND l."siteId" = NEW."siteId" AND l."id" = NEW."lineId";
    IF FOUND AND line_state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'production: line % is %; work order % is allocated to an ACTIVE line of its site (PLN-160)', NEW."lineId", line_state, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (effective IN ('RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED') AND NEW."releasedAt" IS NULL)
     OR (effective = 'DRAFT' AND (NEW."releasedAt" IS NOT NULL OR NEW."releasedById" IS NOT NULL))
     OR (NEW."releasedAt" IS NULL) <> (NEW."batchNumber" IS NULL)
     OR (NEW."releasedAt" IS NOT NULL AND NEW."styleRevisionId" IS NULL) THEN
    RAISE EXCEPTION 'production: work order % is % with the wrong release: its release time, revision and batch number (MES-076) are set exactly from RELEASED on', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (effective IN ('IN_PROGRESS', 'COMPLETED', 'CLOSED') AND NEW."startedAt" IS NULL)
     OR (effective IN ('DRAFT', 'RELEASED') AND NEW."startedAt" IS NOT NULL)
     OR (effective IN ('COMPLETED', 'CLOSED')) <> (NEW."completedAt" IS NOT NULL)
     OR (effective = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'production: work order % is % with the wrong start, completion or closing time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'production: work order % is % with the wrong cancellation (a cancelled work order has its time and reason, MES-007)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- WorkOrderVariance (FIN-029, FIN-030), append-only
--   INSERT     the close's company, site and work order (the reference: its work order) and currency; the close live (not
--              undone); the company's switch on (GATE-ACCOUNTANT); a material only for MATERIAL_PRICE, MATERIAL_USAGE and
--              SCRAP; each pair of figures both or neither, quantities and unit costs 0 or more; the amount never 0; a note
--              of 1 to 1,000 characters when given.
--   UPDATE, DELETE, TRUNCATE  refused (append-only).
CREATE FUNCTION "factory_work_order_variance_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wo_close record;
BEGIN
  SELECT c."companyId" AS company, c."siteId" AS site, c."currency" AS currency, c."undoneAt" AS undone_at INTO wo_close
    FROM "WorkOrderClose" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."closeId";
  IF FOUND THEN
    IF (wo_close.company, wo_close.site, wo_close.currency) IS DISTINCT FROM (NEW."companyId", NEW."siteId", NEW."currency") THEN
      RAISE EXCEPTION 'cost: variance % is of its close %''s company, site and currency', NEW."id", NEW."closeId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF wo_close.undone_at IS NOT NULL THEN
      RAISE EXCEPTION 'cost: close % was undone at %; it takes no variance (a new close splits its own)', NEW."closeId", wo_close.undone_at
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM "factory_cost_actuals_require_postings"(NEW."tenantId", NEW."companyId", format('the variance split of close %s', NEW."closeId"));
  IF NEW."itemId" IS NOT NULL AND NEW."category" NOT IN ('MATERIAL_PRICE', 'MATERIAL_USAGE', 'SCRAP') THEN
    RAISE EXCEPTION 'cost: variance % (%) names no material: only a material price, material usage or scrap variance does', NEW."id", NEW."category"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."standardQuantity" IS NULL) <> (NEW."actualQuantity" IS NULL) OR (NEW."standardUnitCost" IS NULL) <> (NEW."actualUnitCost" IS NULL)
     OR NEW."standardQuantity" < 0 OR NEW."actualQuantity" < 0 OR NEW."standardUnitCost" < 0 OR NEW."actualUnitCost" < 0 THEN
    RAISE EXCEPTION 'cost: variance % has its standard and actual quantities, and its standard and actual unit costs, each pair both or neither, 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amount" = 0 OR NOT "factory_recall_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'cost: variance % has an amount (never 0: above 0 cost more than standard, below 0 less) and a note of 1 to 1,000 characters when given', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WorkOrderVariance_check" AFTER INSERT ON "WorkOrderVariance"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_variance_check"();
CREATE TRIGGER "WorkOrderVariance_append_only" BEFORE UPDATE OR DELETE ON "WorkOrderVariance"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_actuals_ledger_change"();
CREATE TRIGGER "WorkOrderVariance_no_truncate" BEFORE TRUNCATE ON "WorkOrderVariance"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_actuals_ledger_change"();

-- =====================================================================================================================
-- WorkOrderCostEntry: the close's kinds and the closed work order (FIN-029, FIN-030, FIN-034), its own trigger beside the
-- W2a check (which still checks every entry: company, method, reversal pairs, the period lock)
--   every entry      under the work order's costing lock. Not a reversal: refused once the work order is CLOSED, or once
--                    its live close's CLOSE entry is posted ("a closed work order takes no cost entry but a reversal").
--   VARIANCE         not a reversal: names one variance (sourceType WorkOrderVariance) of a live close of this work order;
--                    the opposite of its amount, its material, no quantity or minutes, dated at the close's time; one live
--                    entry per variance; before the close's CLOSE entry; the company's switch on.
--   CLOSE            not a reversal: names a live close of this work order (sourceType WorkOrderClose); no material,
--                    quantity or minutes; dated at the close's time; one live entry per close; after it the work order's
--                    entries add up to 0; the company's switch on.
--   reversal         of a VARIANCE or CLOSE entry: only once its close is undone (MES-013).
CREATE FUNCTION "factory_work_order_cost_entry_close_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
  wo_close record;
  variance record;
  original record;
  close_of uuid;
  balance bigint;
BEGIN
  PERFORM "factory_cost_actuals_lock_work_order"(NEW."tenantId", NEW."workOrderId");

  IF NEW."reversalOfId" IS NOT NULL THEN
    SELECT e."kind"::text AS kind, e."sourceType" AS source_type, e."sourceId" AS source_id INTO original
      FROM "WorkOrderCostEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."reversalOfId";
    IF FOUND AND original.kind IN ('CLOSE', 'VARIANCE') THEN
      close_of := CASE WHEN original.kind = 'CLOSE' THEN original.source_id
                       ELSE (SELECT v."closeId" FROM "WorkOrderVariance" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = original.source_id) END;
      IF EXISTS (SELECT 1 FROM "WorkOrderClose" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = close_of AND c."undoneAt" IS NULL) THEN
        RAISE EXCEPTION 'cost: % entry % belongs to close %, which stands; it is reversed only once the close is undone (MES-013)', original.kind, NEW."reversalOfId", close_of
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NULL;
  END IF;

  SELECT w."status"::text INTO order_state FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId";
  IF FOUND AND order_state = 'CLOSED' THEN
    RAISE EXCEPTION 'cost: work order % is CLOSED; it takes no cost entry but a reversal (entry %, %): reopen it first', NEW."workOrderId", NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "WorkOrderCostEntry" e
               JOIN "WorkOrderClose" c ON c."tenantId" = e."tenantId" AND c."id" = e."sourceId" AND c."undoneAt" IS NULL
              WHERE e."tenantId" = NEW."tenantId" AND e."workOrderId" = NEW."workOrderId" AND e."id" <> NEW."id"
                AND e."kind" = 'CLOSE' AND e."sourceType" = 'WorkOrderClose' AND e."reversalOfId" IS NULL
                AND NOT EXISTS (SELECT 1 FROM "WorkOrderCostEntry" r WHERE r."tenantId" = e."tenantId" AND r."reversalOfId" = e."id")) THEN
    RAISE EXCEPTION 'cost: the close of work order % is settled (its closing entry is posted); it takes no cost entry but a reversal (entry %, %): undo the close first', NEW."workOrderId", NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."kind" = 'VARIANCE' THEN
    IF NEW."sourceType" IS DISTINCT FROM 'WorkOrderVariance' THEN
      RAISE EXCEPTION 'cost: variance entry % names its variance (sourceType WorkOrderVariance)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT v."workOrderId" AS work_order, v."closeId" AS close_id, v."itemId" AS item, v."amount" AS amount INTO variance
      FROM "WorkOrderVariance" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."sourceId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cost: variance entry % names %, which is not a variance of work order %', NEW."id", NEW."sourceId", NEW."workOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF variance.work_order <> NEW."workOrderId" THEN
      RAISE EXCEPTION 'cost: variance entry % names %, which is not a variance of work order %', NEW."id", NEW."sourceId", NEW."workOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT c."closedAt" AS closed_at, c."undoneAt" AS undone_at INTO wo_close FROM "WorkOrderClose" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = variance.close_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cost: variance entry % posts a variance of close %, which is not to be seen', NEW."id", variance.close_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF wo_close.undone_at IS NOT NULL THEN
      RAISE EXCEPTION 'cost: variance entry % posts a variance of close %, which is undone', NEW."id", variance.close_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."amount" <> -variance.amount OR NEW."itemId" IS DISTINCT FROM variance.item OR NEW."quantity" IS NOT NULL OR NEW."minutes" IS NOT NULL
       OR NEW."stockMoveId" IS NOT NULL OR NEW."operationScanId" IS NOT NULL OR NEW."subcontractOrderId" IS NOT NULL OR NEW."supplierInvoiceLineId" IS NOT NULL
       OR NEW."occurredAt" <> wo_close.closed_at THEN
      RAISE EXCEPTION 'cost: variance entry % takes its variance off the work order: the opposite of its amount (%), its material, no quantity, minutes or other source, dated at the close (%)', NEW."id", -variance.amount, wo_close.closed_at
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "WorkOrderCostEntry" e
                WHERE e."tenantId" = NEW."tenantId" AND e."workOrderId" = NEW."workOrderId" AND e."id" <> NEW."id" AND e."kind" = 'VARIANCE'
                  AND e."sourceType" = 'WorkOrderVariance' AND e."sourceId" = NEW."sourceId" AND e."reversalOfId" IS NULL
                  AND NOT EXISTS (SELECT 1 FROM "WorkOrderCostEntry" r WHERE r."tenantId" = e."tenantId" AND r."reversalOfId" = e."id")) THEN
      RAISE EXCEPTION 'cost: variance % is posted already (entry %)', NEW."sourceId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_cost_actuals_require_postings"(NEW."tenantId", NEW."companyId", format('the variance entry of close %s', variance.close_id));
  ELSIF NEW."kind" = 'CLOSE' THEN
    IF NEW."sourceType" IS DISTINCT FROM 'WorkOrderClose' THEN
      RAISE EXCEPTION 'cost: closing entry % names its close (sourceType WorkOrderClose)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT c."workOrderId" AS work_order, c."closedAt" AS closed_at, c."undoneAt" AS undone_at INTO wo_close
      FROM "WorkOrderClose" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."sourceId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cost: closing entry % names %, which is not a live close of work order %', NEW."id", NEW."sourceId", NEW."workOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF wo_close.work_order <> NEW."workOrderId" OR wo_close.undone_at IS NOT NULL THEN
      RAISE EXCEPTION 'cost: closing entry % names %, which is not a live close of work order %', NEW."id", NEW."sourceId", NEW."workOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."itemId" IS NOT NULL OR NEW."quantity" IS NOT NULL OR NEW."minutes" IS NOT NULL
       OR NEW."stockMoveId" IS NOT NULL OR NEW."operationScanId" IS NOT NULL OR NEW."subcontractOrderId" IS NOT NULL OR NEW."supplierInvoiceLineId" IS NOT NULL
       OR NEW."occurredAt" <> wo_close.closed_at THEN
      RAISE EXCEPTION 'cost: closing entry % names no material, quantity, minutes or other source, and is dated at the close (%)', NEW."id", wo_close.closed_at
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_cost_actuals_require_postings"(NEW."tenantId", NEW."companyId", format('the closing entry of close %s', NEW."sourceId"));
    SELECT coalesce(sum(e."amount"), 0) INTO balance FROM "WorkOrderCostEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."workOrderId" = NEW."workOrderId";
    IF balance <> 0 THEN
      RAISE EXCEPTION 'cost: closing entry % leaves % on work order %: it takes off what is left after the variances (%), so the work order''s entries add up to 0 (FIN-034)', NEW."id", balance, NEW."workOrderId", NEW."amount" - balance
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WorkOrderCostEntry_close_check" AFTER INSERT ON "WorkOrderCostEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_cost_entry_close_check"();

-- =====================================================================================================================
-- PurchasePriceVariance (FIN-031), append-only
--   every row  an ISO currency, a key, unit costs of 0 or more; exactly its source: RECEIPT a receipt line (and its site),
--              INVOICE a supplier invoice line; dated outside a HARD-locked period of its company.
--   reversal   of a variance that is no reversal, not reversed yet, of the same company, supplier, place, source, material
--              and unit costs: the opposite quantity and difference, with why (3 to 1,000). No switch needed.
--   otherwise  the company's switch on (GATE-ACCOUNTANT); taken where the company takes it (ActualCostSettings.ppvAt); a
--              quantity above 0; the difference = quantity × (paid − standard) in minor units, within one; the standard
--              (when named) FROZEN, of the material. RECEIPT: a line of a POSTED receipt of the company from the supplier,
--              never a customer's own goods (CUSTOMER_SUPPLIED), of the material, for its whole base quantity. INVOICE: a
--              GOODS line of a supplier invoice of the company, not voided.
--   UPDATE, DELETE, TRUNCATE  refused (append-only).
CREATE FUNCTION "factory_purchase_price_variance_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original record;
  receipt record;
  line record;
  standard record;
  scale numeric;
BEGIN
  IF NEW."currency" !~ '^[A-Z]{3}$' OR btrim(NEW."idempotencyKey") = '' OR NEW."standardUnitCost" < 0 OR NEW."paidUnitCost" < 0 THEN
    RAISE EXCEPTION 'cost: purchase price variance % has an ISO currency, a key and unit costs of 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."at" = 'RECEIPT') <> (NEW."receiptLineId" IS NOT NULL AND NEW."siteId" IS NOT NULL)
     OR (NEW."at" = 'INVOICE') <> (NEW."supplierInvoiceLineId" IS NOT NULL)
     OR (NEW."at" = 'INVOICE' AND (NEW."receiptLineId" IS NOT NULL OR NEW."siteId" IS NOT NULL))
     OR (NEW."at" = 'RECEIPT' AND NEW."supplierInvoiceLineId" IS NOT NULL) THEN
    RAISE EXCEPTION 'cost: purchase price variance % names exactly its source: at RECEIPT the receipt line (and its site), at INVOICE the supplier invoice line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."reason", 1000, true) THEN
    RAISE EXCEPTION 'cost: purchase price variance % says why in 1 to 1,000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", "factory_money_rome_day"(NEW."postedAt"), format('purchase price variance %s', NEW."id"));

  IF NEW."reversalOfId" IS NOT NULL THEN
    SELECT p.* INTO original FROM "PurchasePriceVariance" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."reversalOfId";
    IF FOUND THEN
      IF original."reversalOfId" IS NOT NULL
         OR (original."companyId", original."partyId", original."at", original."siteId", original."receiptLineId", original."supplierInvoiceLineId", original."itemId",
             original."standardUnitCost", original."paidUnitCost", original."standardCostId", original."currency")
            IS DISTINCT FROM
            (NEW."companyId", NEW."partyId", NEW."at", NEW."siteId", NEW."receiptLineId", NEW."supplierInvoiceLineId", NEW."itemId",
             NEW."standardUnitCost", NEW."paidUnitCost", NEW."standardCostId", NEW."currency")
         OR NEW."quantity" <> -original."quantity" OR NEW."differenceAmount" <> -original."differenceAmount" THEN
        RAISE EXCEPTION 'cost: reversal % takes back purchase price variance % exactly: the same source, material and unit costs, the opposite quantity and difference (%), never a reversal', NEW."id", NEW."reversalOfId", -original."differenceAmount"
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "PurchasePriceVariance" p WHERE p."tenantId" = NEW."tenantId" AND p."reversalOfId" = NEW."reversalOfId" AND p."id" <> NEW."id") THEN
        RAISE EXCEPTION 'cost: purchase price variance % is reversed already', NEW."reversalOfId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NOT "factory_cost_actuals_reason_ok"(NEW."reason") THEN
      RAISE EXCEPTION 'cost: reversal % says why (3 to 1,000 characters)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  PERFORM "factory_cost_actuals_require_postings"(NEW."tenantId", NEW."companyId", format('purchase price variance %s', NEW."id"));
  IF NEW."at"::text <> "factory_cost_actuals_ppv_at"(NEW."tenantId", NEW."companyId") THEN
    RAISE EXCEPTION 'cost: the company takes its purchase price variance at the %, not at the % (variance %)', lower("factory_cost_actuals_ppv_at"(NEW."tenantId", NEW."companyId")), lower(NEW."at"::text), NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  scale := power(10::numeric, "factory_cost_actuals_minor"(NEW."tenantId", NEW."companyId", NEW."currency"));
  IF NEW."quantity" <= 0 OR abs(NEW."differenceAmount" - (NEW."quantity" * (NEW."paidUnitCost" - NEW."standardUnitCost") * scale)) > 1 THEN
    RAISE EXCEPTION 'cost: purchase price variance % is the quantity (above 0) × (paid − standard): % × (% − %) = % minor units, not %', NEW."id", NEW."quantity", NEW."paidUnitCost", NEW."standardUnitCost",
      round(NEW."quantity" * (NEW."paidUnitCost" - NEW."standardUnitCost") * scale), NEW."differenceAmount"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."standardCostId" IS NOT NULL THEN
    SELECT s."status"::text AS status, s."itemId" AS item INTO standard FROM "StandardCost" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."standardCostId";
    IF FOUND AND (standard.status <> 'FROZEN' OR standard.item <> NEW."itemId") THEN
      RAISE EXCEPTION 'cost: purchase price variance % compares with a FROZEN standard of its material (standard % is %)', NEW."id", NEW."standardCostId", standard.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."at" = 'RECEIPT' THEN
    SELECT r."companyId" AS company, r."supplierId" AS supplier, r."status"::text AS status, r."kind"::text AS kind, l."itemId" AS item, l."baseQuantity" AS quantity INTO receipt
      FROM "GoodsReceiptLine" l JOIN "GoodsReceipt" r ON r."tenantId" = l."tenantId" AND r."id" = l."receiptId"
     WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."receiptLineId";
    IF FOUND THEN
      IF receipt.kind = 'CUSTOMER_SUPPLIED' THEN
        RAISE EXCEPTION 'cost: receipt line % brought a customer''s own goods: they are never valued (purchase price variance %)', NEW."receiptLineId", NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF receipt.status <> 'POSTED' OR receipt.company <> NEW."companyId" OR receipt.supplier <> NEW."partyId" OR receipt.item <> NEW."itemId" OR receipt.quantity <> NEW."quantity" THEN
        RAISE EXCEPTION 'cost: purchase price variance % is of a POSTED receipt''s line (this one: %) of its company and supplier, for the line''s material and whole base quantity (%)', NEW."id", receipt.status, receipt.quantity
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    SELECT i."companyId" AS company, i."status"::text AS status, l."kind"::text AS kind INTO line
      FROM "SupplierInvoiceLine" l JOIN "SupplierInvoice" i ON i."tenantId" = l."tenantId" AND i."id" = l."invoiceId"
     WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."supplierInvoiceLineId";
    IF FOUND AND (line.kind <> 'GOODS' OR line.company <> NEW."companyId" OR line.status = 'VOIDED') THEN
      RAISE EXCEPTION 'cost: purchase price variance % is of a GOODS line (this one: %) of a supplier invoice of its company, not voided (%)', NEW."id", line.kind, line.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PurchasePriceVariance_check" AFTER INSERT ON "PurchasePriceVariance"
  FOR EACH ROW EXECUTE FUNCTION "factory_purchase_price_variance_check"();
CREATE TRIGGER "PurchasePriceVariance_append_only" BEFORE UPDATE OR DELETE ON "PurchasePriceVariance"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_actuals_ledger_change"();
CREATE TRIGGER "PurchasePriceVariance_no_truncate" BEFORE TRUNCATE ON "PurchasePriceVariance"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_actuals_ledger_change"();

-- =====================================================================================================================
-- CostOfSalesEntry (FIN-043), append-only
--   every row  an ISO currency, a key; exactly one source: a shipment line with its site (and, when named, the SHIPMENT move
--              of that line), or an invoice line (no site, no move); the amount the sum of material, labour, subcontract
--              and overhead; dated outside a HARD-locked period of its company.
--   reversal   of an entry that is no reversal, not reversed yet, of the same company, customer and source: the opposite
--              quantity and amounts, with why (3 to 1,000). No switch needed.
--   otherwise  the company's switch on (GATE-ACCOUNTANT); the quantity above 0 and every amount 0 or more. A shipment line:
--              of the customer, of a shipment of the company that left (SHIPPED or DELIVERED), for its garments. An invoice
--              line: a GOODS line of an issued invoice (not a draft, not rejected) of the company, for its quantity.
--   UPDATE, DELETE, TRUNCATE  refused (append-only).
CREATE FUNCTION "factory_cost_of_sales_entry_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original record;
  shipment record;
  invoice record;
  move record;
BEGIN
  IF NEW."currency" !~ '^[A-Z]{3}$' OR btrim(NEW."idempotencyKey") = '' THEN
    RAISE EXCEPTION 'cost: cost of sales entry % has an ISO currency and a key', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF ((NEW."shipmentLineId" IS NOT NULL AND NEW."siteId" IS NOT NULL) = (NEW."invoiceLineId" IS NOT NULL))
     OR (NEW."shipmentLineId" IS NULL AND (NEW."siteId" IS NOT NULL OR NEW."stockMoveId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'cost: cost of sales entry % names exactly one source: a shipment line with its site (and its SHIPMENT move, when there is one), or an invoice line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amount" <> NEW."materialAmount" + NEW."labourAmount" + NEW."subcontractAmount" + NEW."overheadAmount" THEN
    RAISE EXCEPTION 'cost: cost of sales entry % is the sum of its material, labour, subcontract and overhead (%), not %', NEW."id",
      NEW."materialAmount" + NEW."labourAmount" + NEW."subcontractAmount" + NEW."overheadAmount", NEW."amount"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."reason", 1000, true) THEN
    RAISE EXCEPTION 'cost: cost of sales entry % says why in 1 to 1,000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stockMoveId" IS NOT NULL THEN
    SELECT m."reason"::text AS reason, m."shipmentLineId" AS line INTO move FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."stockMoveId";
    IF FOUND AND (move.reason <> 'SHIPMENT' OR move.line IS DISTINCT FROM NEW."shipmentLineId") THEN
      RAISE EXCEPTION 'cost: cost of sales entry % names stock move %, a % move, not the SHIPMENT of its shipment line', NEW."id", NEW."stockMoveId", move.reason
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", "factory_money_rome_day"(NEW."postedAt"), format('cost of sales entry %s', NEW."id"));

  IF NEW."reversalOfId" IS NOT NULL THEN
    SELECT e.* INTO original FROM "CostOfSalesEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."reversalOfId";
    IF FOUND THEN
      IF original."reversalOfId" IS NOT NULL
         OR (original."companyId", original."partyId", original."siteId", original."shipmentLineId", original."invoiceLineId", original."stockMoveId", original."currency")
            IS DISTINCT FROM (NEW."companyId", NEW."partyId", NEW."siteId", NEW."shipmentLineId", NEW."invoiceLineId", NEW."stockMoveId", NEW."currency")
         OR (NEW."quantity", NEW."materialAmount", NEW."labourAmount", NEW."subcontractAmount", NEW."overheadAmount")
            IS DISTINCT FROM (-original."quantity", -original."materialAmount", -original."labourAmount", -original."subcontractAmount", -original."overheadAmount") THEN
        RAISE EXCEPTION 'cost: reversal % takes back cost of sales entry % exactly: the same source, the opposite quantity and amounts (%), never a reversal', NEW."id", NEW."reversalOfId", -original."amount"
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "CostOfSalesEntry" e WHERE e."tenantId" = NEW."tenantId" AND e."reversalOfId" = NEW."reversalOfId" AND e."id" <> NEW."id") THEN
        RAISE EXCEPTION 'cost: cost of sales entry % is reversed already', NEW."reversalOfId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NOT "factory_cost_actuals_reason_ok"(NEW."reason") THEN
      RAISE EXCEPTION 'cost: reversal % says why (3 to 1,000 characters)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  PERFORM "factory_cost_actuals_require_postings"(NEW."tenantId", NEW."companyId", format('cost of goods sold %s', NEW."id"));
  IF NEW."quantity" <= 0 OR NEW."materialAmount" < 0 OR NEW."labourAmount" < 0 OR NEW."subcontractAmount" < 0 OR NEW."overheadAmount" < 0 THEN
    RAISE EXCEPTION 'cost: cost of sales entry % has a quantity above 0 and amounts of 0 or more (a reversal takes one back)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shipmentLineId" IS NOT NULL THEN
    SELECT s."companyId" AS company, s."status"::text AS status, l."partyId" AS party, l."quantity" AS quantity INTO shipment
      FROM "ShipmentLine" l JOIN "Shipment" s ON s."tenantId" = l."tenantId" AND s."id" = l."shipmentId"
     WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."shipmentLineId";
    IF FOUND AND (shipment.company <> NEW."companyId" OR shipment.party <> NEW."partyId" OR shipment.status NOT IN ('SHIPPED', 'DELIVERED') OR NEW."quantity" <> shipment.quantity) THEN
      RAISE EXCEPTION 'cost: cost of sales entry % is of a line of a shipment of its company and customer that left (this one is %), for its % garment(s)', NEW."id", shipment.status, shipment.quantity
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT i."companyId" AS company, i."status"::text AS status, l."kind"::text AS kind, l."quantity" AS quantity INTO invoice
      FROM "InvoiceLine" l JOIN "Invoice" i ON i."tenantId" = l."tenantId" AND i."id" = l."invoiceId"
     WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."invoiceLineId";
    IF FOUND AND (invoice.company <> NEW."companyId" OR invoice.kind <> 'GOODS' OR invoice.status IN ('DRAFT', 'REJECTED') OR NEW."quantity" <> invoice.quantity) THEN
      RAISE EXCEPTION 'cost: cost of sales entry % is of a GOODS line (this one: %) of an issued invoice of its company (this one: %), for its quantity (%)', NEW."id", invoice.kind, invoice.status, invoice.quantity
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "CostOfSalesEntry_check" AFTER INSERT ON "CostOfSalesEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_of_sales_entry_check"();
CREATE TRIGGER "CostOfSalesEntry_append_only" BEFORE UPDATE OR DELETE ON "CostOfSalesEntry"
  FOR EACH ROW EXECUTE FUNCTION "factory_cost_actuals_ledger_change"();
CREATE TRIGGER "CostOfSalesEntry_no_truncate" BEFORE TRUNCATE ON "CostOfSalesEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_actuals_ledger_change"();

-- =====================================================================================================================
-- LandedCostAllocation (FIN-044)
--   every row  the amount above 0 and the charge line's net amount; the line a CHARGE line of a supplier invoice of the
--              company, not voided; an ISO currency; a note of 1 to 1,000 characters when given; posted at and by whom
--              exactly from POSTED on; reversed at, by whom and why (3 to 1,000) exactly when REVERSED.
--   INSERT     born DRAFT.
--   UPDATE     the company, supplier, line and creation never change; DRAFT → POSTED → REVERSED; a DRAFT changes its
--              basis, amount and note; POSTED changes only into REVERSED; REVERSED changes no more.
--   → POSTED   the company's switch on (GATE-ACCOUNTANT); at least one share, the shares adding up to the amount; dated
--              outside a HARD-locked period; one POSTED allocation per charge line (the partial unique below).
--   DELETE     only a DRAFT, once its shares are removed. TRUNCATE refused.
CREATE FUNCTION "factory_landed_cost_allocation_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  draft_moves CONSTANT text[] := ARRAY['basis', 'amount', 'note', 'status', 'postedAt', 'postedById', 'version', 'updatedAt'];
  posted_moves CONSTANT text[] := ARRAY['status', 'reversedAt', 'reversedById', 'reverseReason', 'note', 'version', 'updatedAt'];
  line record;
  shares integer;
  total bigint;
BEGIN
  IF TG_OP = 'INSERT' AND NEW."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'cost: landed cost % starts as a DRAFT, not %', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."partyId", NEW."supplierInvoiceLineId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."partyId", OLD."supplierInvoiceLineId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'cost: the company, supplier, charge line and creation of landed cost % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'POSTED') OR (OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED')) THEN
      RAISE EXCEPTION 'cost: landed cost % cannot move from % to % (DRAFT → POSTED → REVERSED)', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'REVERSED'
       OR (OLD."status" = 'DRAFT' AND (to_jsonb(NEW) - draft_moves) IS DISTINCT FROM (to_jsonb(OLD) - draft_moves))
       OR (OLD."status" = 'POSTED' AND ((to_jsonb(NEW) - posted_moves) IS DISTINCT FROM (to_jsonb(OLD) - posted_moves) OR NEW."status" <> 'REVERSED')) THEN
      RAISE EXCEPTION 'cost: landed cost % is %; % changes', OLD."id", OLD."status",
        CASE OLD."status" WHEN 'DRAFT' THEN 'only its basis, amount and note' WHEN 'POSTED' THEN 'nothing but its reversal (when, by whom, why)' ELSE 'nothing' END
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."amount" <= 0 OR NEW."currency" !~ '^[A-Z]{3}$' OR NOT "factory_recall_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'cost: landed cost % has an amount above 0, an ISO currency and a note of 1 to 1,000 characters when given', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."kind"::text AS kind, l."netAmount" AS net, i."companyId" AS company, i."status"::text AS status INTO line
    FROM "SupplierInvoiceLine" l JOIN "SupplierInvoice" i ON i."tenantId" = l."tenantId" AND i."id" = l."invoiceId"
   WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."supplierInvoiceLineId";
  IF FOUND AND (line.kind <> 'CHARGE' OR line.company <> NEW."companyId" OR line.status = 'VOIDED' OR line.net <> NEW."amount") THEN
    RAISE EXCEPTION 'cost: landed cost % lands a CHARGE line (this one: %) of a supplier invoice of its company, not voided (%), for its net amount (%)', NEW."id", line.kind, line.status, line.net
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('POSTED', 'REVERSED')) <> (NEW."postedAt" IS NOT NULL) OR (NEW."postedAt" IS NULL) <> (NEW."postedById" IS NULL)
     OR (NEW."status" = 'REVERSED') <> (NEW."reversedAt" IS NOT NULL) OR (NEW."reversedAt" IS NULL) <> (NEW."reversedById" IS NULL)
     OR (NEW."status" = 'REVERSED') <> (NEW."reverseReason" IS NOT NULL)
     OR (NEW."reverseReason" IS NOT NULL AND NOT "factory_cost_actuals_reason_ok"(NEW."reverseReason"))
     OR NEW."reversedAt" < NEW."postedAt" THEN
    RAISE EXCEPTION 'cost: landed cost % is % with when and by whom it was posted exactly from POSTED on, and when, by whom and why (3 to 1,000 characters) it was reversed exactly when REVERSED, not before its posting', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'POSTED' AND (TG_OP = 'INSERT' OR OLD."status" = 'DRAFT') THEN
    PERFORM "factory_cost_actuals_require_postings"(NEW."tenantId", NEW."companyId", format('landed cost %s', NEW."id"));
    SELECT count(*), coalesce(sum(s."amount"), 0) INTO shares, total FROM "LandedCostShare" s WHERE s."tenantId" = NEW."tenantId" AND s."allocationId" = NEW."id";
    IF shares = 0 OR total <> NEW."amount" THEN
      RAISE EXCEPTION 'cost: landed cost % is posted with its shares adding up to its amount (%): % share(s) add up to %', NEW."id", NEW."amount", shares, total
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_period_refuse_locked"(NEW."tenantId", NEW."companyId", "factory_money_rome_day"(NEW."postedAt"), format('landed cost %s', NEW."id"));
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "LandedCostAllocation_check" AFTER INSERT OR UPDATE ON "LandedCostAllocation"
  FOR EACH ROW EXECUTE FUNCTION "factory_landed_cost_allocation_check"();

CREATE FUNCTION "factory_landed_cost_allocation_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'cost: landed cost % is %; only a DRAFT is deleted (a posted one is reversed)', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "LandedCostShare" s WHERE s."tenantId" = OLD."tenantId" AND s."allocationId" = OLD."id") THEN
    RAISE EXCEPTION 'cost: landed cost % still has shares; remove them first', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "LandedCostAllocation_delete_guard" BEFORE DELETE ON "LandedCostAllocation"
  FOR EACH ROW EXECUTE FUNCTION "factory_landed_cost_allocation_delete_guard"();
CREATE TRIGGER "LandedCostAllocation_no_truncate" BEFORE TRUNCATE ON "LandedCostAllocation"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_actuals_refuse_truncate"();

-- One POSTED allocation per charge line (a reversed one makes room for the next).
CREATE UNIQUE INDEX "LandedCostAllocation_one_posted" ON "LandedCostAllocation" ("tenantId", "supplierInvoiceLineId") WHERE "status" = 'POSTED';

-- =====================================================================================================================
-- LandedCostShare (FIN-044)
--   every row  the allocation (read FOR SHARE: a posting waits) is a DRAFT; the key `share:<allocationId>:<lotId>` (or it
--              with a suffix "-…"); the lot of the allocation's company, received on a receipt line, ours (a customer's own
--              lot is never valued); the basis figure above 0, the amount 0 or more.
--   UPDATE     the allocation, lot, site, item, key and creation never change.
--   DELETE     only while its allocation is a DRAFT. TRUNCATE refused.
CREATE FUNCTION "factory_landed_cost_share_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_now record;
  allocation record;
  lot record;
  key_base text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_now := OLD;
  ELSE
    row_now := NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."allocationId", NEW."lotId", NEW."siteId", NEW."itemId", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."allocationId", OLD."lotId", OLD."siteId", OLD."itemId", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'cost: the allocation, lot, key and creation of landed cost share % never change (remove it and add another)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT a."status"::text AS status, a."companyId" AS company INTO allocation FROM "LandedCostAllocation" a
   WHERE a."tenantId" = row_now."tenantId" AND a."id" = row_now."allocationId" FOR SHARE;
  IF FOUND AND allocation.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'cost: landed cost % is %; its shares are written, changed and removed only while it is a DRAFT', row_now."allocationId", allocation.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  key_base := format('share:%s:%s', NEW."allocationId", NEW."lotId");
  IF NOT (NEW."key" = key_base OR NEW."key" LIKE key_base || '-%') OR NEW."basisAmount" <= 0 OR NEW."amount" < 0 THEN
    RAISE EXCEPTION 'cost: landed cost share % has the key "%", a basis figure above 0 and an amount of 0 or more', NEW."id", key_base
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."companyId" AS company, l."ownerPartyId" AS owner, l."receiptLineId" AS receipt_line INTO lot FROM "Lot" l
   WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."lotId";
  IF FOUND AND (allocation.company IS DISTINCT FROM lot.company OR lot.owner IS NOT NULL OR lot.receipt_line IS NULL) THEN
    RAISE EXCEPTION 'cost: landed cost share % lands on a lot of its company, received on a receipt line, ours (a customer''s own lot is never valued)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LandedCostShare_check" AFTER INSERT OR UPDATE ON "LandedCostShare"
  FOR EACH ROW EXECUTE FUNCTION "factory_landed_cost_share_check"();
CREATE TRIGGER "LandedCostShare_delete_guard" BEFORE DELETE ON "LandedCostShare"
  FOR EACH ROW EXECUTE FUNCTION "factory_landed_cost_share_check"();
CREATE TRIGGER "LandedCostShare_no_truncate" BEFORE TRUNCATE ON "LandedCostShare"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_cost_actuals_refuse_truncate"();
