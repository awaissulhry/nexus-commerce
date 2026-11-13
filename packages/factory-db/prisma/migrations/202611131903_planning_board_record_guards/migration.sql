-- Written by hand (B-W2b-F39; Prisma does not model triggers), after the generated …_planning_board_record_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.
--
-- The planning board's record keeps its own copy of the operation it names (B-W2b-F39, Owner decision 2026-11-13, option B).
-- B-W2b-329's ScheduleChange is append-only and named the bar's WorkOrderOperation by a foreign key (Restrict), so an
-- operation that ever had a bar placed, moved or sent back to the tray on the board could never leave its work order: a
-- draft's release, revision change or repair steps that dropped it were refused (B-W2b-F36). The schema folder before this
-- one dropped that foreign key (workOrderOperationId stays a plain id, as slotId is) and added the copy, operationSeq and
-- operationName.
--
--   ScheduleChange_operation_copy (AFTER INSERT): a change keeps the copy exactly when it names an operation, and the
--   operation it names is one of its work order at its site, with that seq and name, when the change is written (what the
--   foreign key checked at insert, plus the copy). Later the operation may leave its work order; the copy stays.
--
-- The changes written before this step keep no copy: filling it would change rows of an append-only ledger, which no
-- migration does (scripts/factory/check-append-only.mjs: no migration disables a ledger's trigger). Their operation still
-- exists when this runs (the foreign key held until the folder before); the API names one that left later as "an operation
-- no longer on the work order", without its seq and name.
--
-- No earlier function is redefined.

CREATE FUNCTION "factory_schedule_change_operation_copy"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  op record;
BEGIN
  IF (NEW."workOrderOperationId" IS NULL) <> (NEW."operationSeq" IS NULL) OR (NEW."workOrderOperationId" IS NULL) <> (NEW."operationName" IS NULL) THEN
    RAISE EXCEPTION 'planning: change % keeps the copy of its operation (its seq and name) exactly when it names one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."workOrderOperationId" IS NOT NULL THEN
    SELECT o."seq", o."name" INTO op FROM "WorkOrderOperation" o
     WHERE o."tenantId" = NEW."tenantId" AND o."siteId" = NEW."siteId" AND o."workOrderId" = NEW."workOrderId" AND o."id" = NEW."workOrderOperationId";
    IF NOT FOUND OR op."seq" <> NEW."operationSeq" OR op."name" <> NEW."operationName" THEN
      RAISE EXCEPTION 'planning: change % names an operation of its work order with the operation''s seq and name as they are when the change is written', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ScheduleChange_operation_copy" AFTER INSERT ON "ScheduleChange"
  FOR EACH ROW EXECUTE FUNCTION "factory_schedule_change_operation_copy"();
