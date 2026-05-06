-- =====================================================================
-- R.17 — Substitution-aware demand
--
-- Operators link primary→substitute SKU pairs with a substitution
-- fraction. During the primary's stockout windows (from R.12's
-- StockoutEvent table), some of the substitute's observed demand is
-- credited back to the primary's "true demand" and removed from the
-- substitute's velocity calc — so we don't over-buy the substitute
-- after the primary comes back in stock.
-- =====================================================================

CREATE TABLE "ProductSubstitution" (
  "id"                   TEXT NOT NULL,
  "primaryProductId"     TEXT NOT NULL,
  "substituteProductId"  TEXT NOT NULL,
  "substitutionFraction" DECIMAL(3,2) NOT NULL DEFAULT 0.50,
  "notes"                TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProductSubstitution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductSubstitution_primaryProductId_fkey"
    FOREIGN KEY ("primaryProductId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProductSubstitution_substituteProductId_fkey"
    FOREIGN KEY ("substituteProductId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProductSubstitution_primaryProductId_substituteProductId_key"
  ON "ProductSubstitution"("primaryProductId", "substituteProductId");
CREATE INDEX "ProductSubstitution_substituteProductId_idx"
  ON "ProductSubstitution"("substituteProductId");

-- ── ReplenishmentRecommendation audit fields ──────────────────────
ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "rawVelocity"               DECIMAL(10,2);
ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "substitutionAdjustedDelta" DECIMAL(10,2);
