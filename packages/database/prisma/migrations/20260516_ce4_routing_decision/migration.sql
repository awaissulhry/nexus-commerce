-- CE.4: Smart Order Routing — RoutingDecision audit log
-- Captures which routing method was used and the scoring breakdown
-- for each resolveWarehouseForOrder() call.

CREATE TABLE "RoutingDecision" (
  "id"          TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "warehouseId" TEXT,
  "method"      TEXT NOT NULL,
  "ruleId"      TEXT,
  "scoreSummary" JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoutingDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RoutingDecision_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE
);

CREATE INDEX "RoutingDecision_orderId_idx" ON "RoutingDecision"("orderId");
CREATE INDEX "RoutingDecision_createdAt_idx" ON "RoutingDecision"("createdAt" DESC);
