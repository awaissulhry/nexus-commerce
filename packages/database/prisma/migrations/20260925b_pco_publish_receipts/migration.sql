-- Additive receipt state. Existing/manual snapshots are never inferred to be accepted sends.
ALTER TABLE "ChannelListingSnapshot"
  ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'UNACCEPTED',
  ADD COLUMN "acceptedAt" TIMESTAMP(3);
