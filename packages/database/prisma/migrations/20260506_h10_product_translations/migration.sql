-- =====================================================================
-- H.10: Per-language master content (ProductTranslation)
--
-- Today Product.{name, description, bulletPoints, keywords} are
-- single-string fields holding ONE language's content. The H.7 AI
-- generator can produce per-marketplace text but writing it back
-- overwrites the previous language each time.
--
-- This migration adds a side table holding the non-primary-language
-- variants. Primary language (env: NEXUS_PRIMARY_LANGUAGE, default
-- 'it' for Xavia) keeps living on Product itself — every existing
-- caller that reads Product.name keeps working unchanged.
--
-- Resolver semantics (apps/api/src/services/products/translation-
-- resolver.service.ts): for a given (productId, language) return
-- the ProductTranslation row when present, else fall back to
-- Product.{name, ...}.
--
-- Indexes:
--   - (productId, language) UNIQUE — one row per language per product
--   - (language) — "all DE translations" lookups
--   - (productId) — drawer's per-product translation list
--   - (source) — "show me every AI-generated row" filter
-- =====================================================================

CREATE TABLE "ProductTranslation" (
  "id"           TEXT PRIMARY KEY,
  "productId"    TEXT NOT NULL,
  "language"     TEXT NOT NULL,
  "name"         TEXT,
  "description"  TEXT,
  "bulletPoints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "keywords"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "source"       TEXT,
  "sourceModel"  TEXT,
  "reviewedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductTranslation_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "ProductTranslation_productId_language_key"
  ON "ProductTranslation" ("productId", "language");
CREATE INDEX "ProductTranslation_language_idx"
  ON "ProductTranslation" ("language");
CREATE INDEX "ProductTranslation_productId_idx"
  ON "ProductTranslation" ("productId");
CREATE INDEX "ProductTranslation_source_idx"
  ON "ProductTranslation" ("source");
