-- RPT.12 — operator-defined metrics. Purely additive: one new table.

CREATE TABLE "CustomMetric" (
    "id"          TEXT NOT NULL,
    "reportId"    TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "formula"     TEXT NOT NULL,
    "format"      TEXT NOT NULL DEFAULT 'ratio',
    "betterWhen"  TEXT,
    "description" TEXT,
    "ownerId"     TEXT NOT NULL DEFAULT 'default-user',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomMetric_reportId_name_key" ON "CustomMetric"("reportId", "name");
CREATE INDEX "CustomMetric_reportId_idx" ON "CustomMetric"("reportId");
