-- W12: ProductSeo — per-locale SEO metadata (meta title, meta description,
-- URL handle, Open Graph, schema.org JSON-LD).

CREATE TABLE IF NOT EXISTS "ProductSeo" (
  "id"              TEXT        NOT NULL,
  "productId"       TEXT        NOT NULL,
  "locale"          TEXT        NOT NULL,
  "metaTitle"       TEXT,
  "metaDescription" TEXT,
  "urlHandle"       TEXT,
  "ogTitle"         TEXT,
  "ogDescription"   TEXT,
  "ogImageUrl"      TEXT,
  "canonicalUrl"    TEXT,
  "schemaOrgJson"   JSONB,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductSeo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductSeo_productId_locale_key"
  ON "ProductSeo"("productId", "locale");

CREATE INDEX IF NOT EXISTS "ProductSeo_productId_idx"
  ON "ProductSeo"("productId");

CREATE INDEX IF NOT EXISTS "ProductSeo_locale_idx"
  ON "ProductSeo"("locale");

CREATE INDEX IF NOT EXISTS "ProductSeo_urlHandle_idx"
  ON "ProductSeo"("urlHandle");

ALTER TABLE "ProductSeo"
  ADD CONSTRAINT "ProductSeo_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
