-- LX.2: one ordered authority, initialized only from existing Marketplace metadata.
-- The scalar remains unchanged for deployed readers; no database behavior guards.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "Marketplace" ADD COLUMN "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "Marketplace"
SET "languages" = CASE WHEN "code" = 'BE' THEN ARRAY['nl', 'fr']::TEXT[]
                       ELSE ARRAY[lower("language")]::TEXT[] END;
COMMIT;
