-- M1: per-marketplace participation tracking
--
-- Adds 3 nullable columns to Marketplace so we can record whether the
-- operator's SP-API auth actually permits selling in each marketplace.
-- Separate from `isActive` (operator-controlled enable/disable) so we
-- never silently drop a marketplace the operator has enabled but where
-- the auth scope has lapsed.
--
-- participationStatus is a coarse enum (not a real ENUM type because
-- Amazon may introduce new statuses we don't want a migration for):
--   PARTICIPATING   = canSell true, no listings suspended
--   SUSPENDED       = canSell true, hasSuspendedListings true
--   NOT_PARTICIPATING = canSell false
--   ACCESS_DENIED   = SP-API returned 403 for this marketplace
--   UNKNOWN         = never probed (default for legacy rows)

ALTER TABLE "Marketplace"
  ADD COLUMN "isParticipating" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "participationStatus" TEXT,
  ADD COLUMN "participationCheckedAt" TIMESTAMP(3);

-- Seed: mark IT as participating since we have 24mo of IT orders proving
-- the auth works there. Other markets stay at default false until the
-- first /api/amazon/participations/refresh call writes them back.
UPDATE "Marketplace"
SET "isParticipating" = TRUE,
    "participationStatus" = 'PARTICIPATING',
    "participationCheckedAt" = NOW()
WHERE "channel" = 'AMAZON' AND "code" = 'IT';
