-- ADX G4 — CONTAINS matching for keyword protection.
-- Additive and nullable; existing rows fall back to isPrefix and behave unchanged.
ALTER TABLE "AdKeywordProtection" ADD COLUMN "matchType" TEXT;
UPDATE "AdKeywordProtection" SET "matchType" = CASE WHEN "isPrefix" THEN 'PREFIX' ELSE 'EXACT' END;
