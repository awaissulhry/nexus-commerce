-- CreateIndex
CREATE INDEX "MovementLedger_materialId_type_qty_idx" ON "MovementLedger"("materialId", "type", "qty");

-- CreateIndex
CREATE INDEX "MovementLedger_refType_type_refId_materialId_qty_idx" ON "MovementLedger"("refType", "type", "refId", "materialId", "qty");

-- CreateIndex
CREATE INDEX "WorkOrderStage_workOrderId_finishedAt_idx" ON "WorkOrderStage"("workOrderId", "finishedAt");
