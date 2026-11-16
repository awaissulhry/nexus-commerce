-- B-W2b-GB29 (hand-written; the planning gaps of batch B29): the checks of the columns 202611160029_planning_gb29_w2b_schema adds.
--   G215  WorkOrderOperation.plannedQuantity: above 0, and only on an unplanned operation (routingSeq null).
--   G226  StyleCuttingLoss: a loss of 0 up to below 100 percent, cuts not below 0.
-- Every existing row passes (the column is new and null; the table is new and empty).

ALTER TABLE "WorkOrderOperation" ADD CONSTRAINT "WorkOrderOperation_planned_quantity_check"
  CHECK ("plannedQuantity" IS NULL OR ("plannedQuantity" > 0 AND "routingSeq" IS NULL));

ALTER TABLE "StyleCuttingLoss" ADD CONSTRAINT "StyleCuttingLoss_loss_check"
  CHECK ("lossPct" >= 0 AND "lossPct" < 100 AND "basedOnCuts" >= 0);
