-- CI.2: CustomerSegment model
-- Named cohorts with multi-field DSL filter conditions.

CREATE TABLE "CustomerSegment" (
  "id"            TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "description"   TEXT,
  "conditions"    JSONB NOT NULL DEFAULT '[]',
  "customerCount" INTEGER NOT NULL DEFAULT 0,
  "lastCountedAt" TIMESTAMP(3),
  "createdBy"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerSegment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerSegment_name_key" ON "CustomerSegment"("name");
CREATE INDEX "CustomerSegment_createdAt_idx" ON "CustomerSegment"("createdAt" DESC);
