-- PES.6 wave-4 (D16) — cell formulas + master field rules.
-- ADDITIVE ONLY: three new tables. No existing table, column or index is touched, and nothing
-- reads them until the cell-formula write path and the master-rule read path are wired.

CREATE TABLE IF NOT EXISTS "CellFormula" (
    "id"          TEXT NOT NULL,
    "productId"   TEXT NOT NULL,
    "scope"       TEXT NOT NULL,
    "channel"     TEXT NOT NULL DEFAULT '',
    "marketplace" TEXT NOT NULL DEFAULT '',
    "locale"      TEXT NOT NULL DEFAULT '',
    "fieldKey"    TEXT NOT NULL,
    "expr"        TEXT NOT NULL,
    "dependsOn"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "lastValue"   JSONB,
    "lastError"   TEXT,
    "version"     INTEGER NOT NULL DEFAULT 1,
    "updatedBy"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CellFormula_pkey" PRIMARY KEY ("id")
);

-- Coordinate columns are NOT NULL with '' as the "not scoped" sentinel: Postgres treats NULLs as
-- DISTINCT in a unique index, so nullable columns here would accept the same master formula twice.
CREATE UNIQUE INDEX IF NOT EXISTS "CellFormula_coord_key"
    ON "CellFormula" ("productId", "scope", "channel", "marketplace", "locale", "fieldKey");
CREATE INDEX IF NOT EXISTS "CellFormula_productId_idx"        ON "CellFormula" ("productId");
CREATE INDEX IF NOT EXISTS "CellFormula_productId_scope_idx"  ON "CellFormula" ("productId", "scope");
CREATE INDEX IF NOT EXISTS "CellFormula_fieldKey_idx"         ON "CellFormula" ("fieldKey");

DO $$
BEGIN
    ALTER TABLE "CellFormula"
        ADD CONSTRAINT "CellFormula_productId_fkey"
        FOREIGN KEY ("productId") REFERENCES "Product"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "MasterFieldRule" (
    "id"          TEXT NOT NULL,
    "productType" TEXT NOT NULL DEFAULT '*',
    "fieldKey"    TEXT NOT NULL,
    "expr"        TEXT NOT NULL,
    "version"     INTEGER NOT NULL DEFAULT 1,
    "updatedBy"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MasterFieldRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MasterFieldRule_productType_fieldKey_key"
    ON "MasterFieldRule" ("productType", "fieldKey");
CREATE INDEX IF NOT EXISTS "MasterFieldRule_fieldKey_idx" ON "MasterFieldRule" ("fieldKey");

CREATE TABLE IF NOT EXISTS "MasterFieldRuleRevision" (
    "id"          TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "fieldKey"    TEXT NOT NULL,
    "version"     INTEGER NOT NULL,
    "snapshot"    JSONB NOT NULL,
    "changedBy"   TEXT,
    "reason"      TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MasterFieldRuleRevision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MasterFieldRuleRevision_pt_fk_version_key"
    ON "MasterFieldRuleRevision" ("productType", "fieldKey", "version");
CREATE INDEX IF NOT EXISTS "MasterFieldRuleRevision_pt_fk_idx"
    ON "MasterFieldRuleRevision" ("productType", "fieldKey");
