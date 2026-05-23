-- IE.2.4 — Lock in the upload dedup contract at the database level.
--
-- The IE.1 migration created a non-unique index on
-- (productId, contentHash) to support the route's findFirst lookup.
-- After the IE.2 backfill + collapse pass removes pre-existing
-- duplicates, replace it with a UNIQUE constraint so any future code
-- path that somehow bypasses the route-level gate still fails fast
-- instead of silently writing a duplicate row.
--
-- Postgres allows multiple NULL values in a multi-column UNIQUE
-- index, so rows whose contentHash never got backfilled (sharp
-- decode failure, image fetch 404, etc.) don't trip the constraint.
-- The collapse script is what guarantees no two non-NULL hashes
-- collide before this migration runs.

DROP INDEX IF EXISTS "ProductImage_productId_contentHash_idx";

CREATE UNIQUE INDEX "ProductImage_productId_contentHash_key"
  ON "ProductImage"("productId", "contentHash");
