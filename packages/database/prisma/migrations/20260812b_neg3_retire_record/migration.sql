-- NEG.3 — when WE retired a negative, and why.
--
-- Additive and nullable. `AdTarget.updatedAt` is the last INGEST tick, not a decision timestamp:
-- all 62 already-archived negatives share one updatedAt day because the v1 export re-stamps every
-- matched row on each pass. So there has never been a way to ask when a negative was retired.
-- These columns answer it from the moment they exist, and stay NULL for every pre-existing row
-- rather than inventing a date for the 62 that were archived on Amazon and mirrored in.
ALTER TABLE "AdTarget" ADD COLUMN "retiredAt" TIMESTAMP(3);
ALTER TABLE "AdTarget" ADD COLUMN "retireReason" TEXT;
