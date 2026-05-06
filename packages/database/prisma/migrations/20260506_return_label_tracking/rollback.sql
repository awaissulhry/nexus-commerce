ALTER TABLE "Return"
  DROP COLUMN IF EXISTS "returnLabelUrl",
  DROP COLUMN IF EXISTS "returnLabelCarrier",
  DROP COLUMN IF EXISTS "returnTrackingNumber",
  DROP COLUMN IF EXISTS "returnLabelGeneratedAt",
  DROP COLUMN IF EXISTS "returnLabelEmailedAt";
