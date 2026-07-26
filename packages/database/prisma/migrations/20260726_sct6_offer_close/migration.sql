-- SCT.6 — per-market Amazon offer close/reopen (additive, reversible state)
ALTER TABLE "ChannelListing" ADD COLUMN "offerClosedAt" TIMESTAMP(3);
ALTER TABLE "ChannelListing" ADD COLUMN "offerClosedBy" TEXT;
ALTER TABLE "ChannelListing" ADD COLUMN "offerCloseReason" TEXT;
ALTER TABLE "ChannelListing" ADD COLUMN "offerCloseSnapshot" JSONB;
