-- P3b S3 (docs/attributes/PLAN.md §10.9) — an attribute's placement (Shared or channel-only, a label: no value moves)
-- and archive instead of delete. Additive only: a defaulted NOT NULL column (old code inserts get the default), a
-- defaulted array and a nullable timestamp.
ALTER TABLE "CustomAttribute" ADD COLUMN "placement" TEXT NOT NULL DEFAULT 'shared',
ADD COLUMN "placementChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "archivedAt" TIMESTAMP(3);
