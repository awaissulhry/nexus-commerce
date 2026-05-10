-- BV.1 (list-wizard) — BrandVoice prompt-block guidance.
--
-- Operators inject "Terse bullets. No emojis. Technical tone."
-- style instructions into every Step 5 AI prompt as the
-- {brandVoiceBlock} substitution. Sister to TerminologyPreference;
-- scope-keyed (brand, marketplace, language) the same way as
-- PromptTemplate.

CREATE TABLE "BrandVoice" (
  "id"          TEXT PRIMARY KEY,
  "brand"       TEXT,
  "marketplace" TEXT,
  "language"    TEXT,
  "body"        TEXT NOT NULL,
  "notes"       TEXT,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "createdBy"   TEXT
);

-- Matcher index — covers the brand+marketplace+language+isActive
-- read pattern in resolveBrandVoice().
CREATE INDEX "BrandVoice_brand_marketplace_language_isActive_idx"
  ON "BrandVoice"("brand", "marketplace", "language", "isActive");

-- Admin list view — "show me all live brand voices".
CREATE INDEX "BrandVoice_isActive_idx"
  ON "BrandVoice"("isActive");
