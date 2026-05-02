ALTER TABLE "VariantChannelListing"
  DROP COLUMN IF EXISTS "syncRetryCount",
  DROP COLUMN IF EXISTS "lastSyncError",
  DROP COLUMN IF EXISTS "createdAt",
  DROP COLUMN IF EXISTS "updatedAt";
