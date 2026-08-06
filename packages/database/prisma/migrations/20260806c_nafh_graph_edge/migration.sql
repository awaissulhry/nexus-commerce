-- NAF.H — typed commerce entity graph (spec Part 4 / Phase H).
-- Additive only: one new table, no existing objects touched.

-- CreateTable
CREATE TABLE "GraphEdge" (
    "id" TEXT NOT NULL,
    "fromType" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toType" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "weight" DECIMAL(10,4),
    "properties" JSONB,
    "source" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),

    CONSTRAINT "GraphEdge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GraphEdge_unique" ON "GraphEdge"("fromType", "fromId", "toType", "toId", "relation");

-- CreateIndex
CREATE INDEX "GraphEdge_fromType_fromId_relation_idx" ON "GraphEdge"("fromType", "fromId", "relation");

-- CreateIndex
CREATE INDEX "GraphEdge_toType_toId_relation_idx" ON "GraphEdge"("toType", "toId", "relation");

-- CreateIndex
CREATE INDEX "GraphEdge_relation_validTo_idx" ON "GraphEdge"("relation", "validTo");
