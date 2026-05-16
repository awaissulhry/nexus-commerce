-- CI.1: RFM scoring fields on Customer
-- Recency × Frequency × Monetary quintile scoring (1–5 each).
-- Computed nightly by rfm-scoring.job.ts.

ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "rfmScore"      TEXT,
  ADD COLUMN IF NOT EXISTS "rfmLabel"      TEXT,
  ADD COLUMN IF NOT EXISTS "rfmComputedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Customer_rfmLabel_idx" ON "Customer"("rfmLabel");
