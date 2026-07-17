-- EPO.5 — amendments + returns (all additive)
ALTER TABLE "Order" ADD COLUMN "reapprovalNeededAt" DATETIME;

CREATE TABLE "OrderRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "rev" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "diff" JSONB NOT NULL,
    "netDeltaCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderRevision_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OrderRevision_orderId_rev_key" ON "OrderRevision"("orderId", "rev");

CREATE TABLE "OrderReturn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderReturn_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OrderReturn_number_key" ON "OrderReturn"("number");
CREATE INDEX "OrderReturn_orderId_idx" ON "OrderReturn"("orderId");

CREATE TABLE "OrderReturnLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "returnId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "note" TEXT,
    "reworkWorkOrderId" TEXT,
    CONSTRAINT "OrderReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "OrderReturn" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "OrderReturnLine_returnId_idx" ON "OrderReturnLine"("returnId");
