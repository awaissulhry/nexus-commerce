-- Order routing rules: rule-based warehouse assignment for inbound
-- orders. Pre-this, shipments were always created against a fixed
-- default warehouse — fine for single-warehouse setups, broken for
-- multi-warehouse (audit's #1 critical operations gap).

CREATE TABLE IF NOT EXISTS "OrderRoutingRule" (
  "id"              TEXT PRIMARY KEY,
  "name"            TEXT NOT NULL,
  "priority"        INTEGER NOT NULL DEFAULT 100,
  "channel"         TEXT,
  "marketplace"     TEXT,
  "shippingCountry" TEXT,
  "warehouseId"     TEXT NOT NULL,
  "isActive"        BOOLEAN NOT NULL DEFAULT TRUE,
  "notes"           TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  "createdBy"       TEXT,
  CONSTRAINT "OrderRoutingRule_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "OrderRoutingRule_priority_isActive_idx"
  ON "OrderRoutingRule" ("priority", "isActive");
CREATE INDEX IF NOT EXISTS "OrderRoutingRule_warehouseId_idx"
  ON "OrderRoutingRule" ("warehouseId");
