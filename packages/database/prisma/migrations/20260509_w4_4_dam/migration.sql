-- W4.4 — DigitalAsset + AssetUsage (Plytix-parity DAM library).
--
-- Top-level reusable assets + a join layer that records "asset X is
-- used by entity Y in role Z". Distinct from ProductImage (the
-- legacy product-bound image store):
--
--   - DigitalAsset is reusable across products via AssetUsage rows
--     (no duplicate uploads when the same hero photo applies to a
--     parent + every variant).
--   - Metadata is JSON so the operator can capture alt text,
--     photographer credit, color tags, captions without schema
--     churn.
--
-- Storage is provider-pluggable (storageProvider enum stored as
-- string: 'cloudinary' / 's3' / 'r2' / 'local'). url is denorm'd
-- for fast reads; storageProvider + storageId is source of truth.
--
-- Migration plan: ProductImage → DigitalAsset + AssetUsage backfill
-- runs as a one-shot script in a follow-up Wave 4 commit. Until
-- then, both paths coexist.

-- ── DigitalAsset ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DigitalAsset" (
  "id"               TEXT NOT NULL,
  "code"             TEXT,
  "label"            TEXT NOT NULL,
  "type"             TEXT NOT NULL DEFAULT 'image',
  "mimeType"         TEXT NOT NULL,
  "sizeBytes"        INTEGER NOT NULL,
  "storageProvider"  TEXT NOT NULL DEFAULT 'cloudinary',
  "storageId"        TEXT NOT NULL,
  "url"              TEXT NOT NULL,
  "originalFilename" TEXT,
  "metadata"         JSONB,
  "createdAt"        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP NOT NULL,

  CONSTRAINT "DigitalAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DigitalAsset_code_key"
  ON "DigitalAsset"("code")
  WHERE "code" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "DigitalAsset_type_idx"
  ON "DigitalAsset"("type");

-- ── AssetUsage ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AssetUsage" (
  "id"        TEXT NOT NULL,
  "assetId"   TEXT NOT NULL,
  "scope"     TEXT NOT NULL,
  "productId" TEXT,
  "role"      TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL,

  CONSTRAINT "AssetUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AssetUsage_assetId_scope_productId_role_sortOrder_key"
  ON "AssetUsage"("assetId", "scope", "productId", "role", "sortOrder");

CREATE INDEX IF NOT EXISTS "AssetUsage_assetId_idx"
  ON "AssetUsage"("assetId");

CREATE INDEX IF NOT EXISTS "AssetUsage_scope_productId_idx"
  ON "AssetUsage"("scope", "productId");

CREATE INDEX IF NOT EXISTS "AssetUsage_productId_idx"
  ON "AssetUsage"("productId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AssetUsage_assetId_fkey'
  ) THEN
    ALTER TABLE "AssetUsage"
      ADD CONSTRAINT "AssetUsage_assetId_fkey"
      FOREIGN KEY ("assetId") REFERENCES "DigitalAsset"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AssetUsage_productId_fkey'
  ) THEN
    ALTER TABLE "AssetUsage"
      ADD CONSTRAINT "AssetUsage_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "Product"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
