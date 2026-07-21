-- SC.5 (additive): precise cutoff for newListingDefaultMode=PAUSED enforcement
ALTER TABLE "SyncChannelPolicy" ADD COLUMN IF NOT EXISTS "newListingModeSetAt" TIMESTAMP(3);
