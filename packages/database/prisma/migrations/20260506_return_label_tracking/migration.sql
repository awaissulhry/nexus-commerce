-- Return label tracking: store the carrier-generated URL + tracking
-- + email timestamp so the customer-facing return workflow is
-- auditable even before native carrier (Sendcloud) integration lands.

ALTER TABLE "Return"
  ADD COLUMN IF NOT EXISTS "returnLabelUrl"         TEXT,
  ADD COLUMN IF NOT EXISTS "returnLabelCarrier"     TEXT,
  ADD COLUMN IF NOT EXISTS "returnTrackingNumber"   TEXT,
  ADD COLUMN IF NOT EXISTS "returnLabelGeneratedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "returnLabelEmailedAt"   TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Return_returnTrackingNumber_idx"
  ON "Return" ("returnTrackingNumber");
