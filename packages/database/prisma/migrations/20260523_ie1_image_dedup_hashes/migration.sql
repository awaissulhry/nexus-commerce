-- IE.1.1 — Upload-dedup gate columns on ProductImage.
--
-- contentHash: SHA-256 hex of the raw file buffer, computed in the
--   API route before the Cloudinary call. Lets a re-upload of the
--   exact same bytes reuse the existing row with zero Cloudinary
--   round-trip. Closes the "MAIN appears 3 times" duplicate path.
--
-- perceptualHash: 16-hex-char (64-bit) Cloudinary pHash, computed
--   server-side via the upload API's `phash: true` flag. Used to
--   warn the operator when the new image is visually near-identical
--   to one already on this product (Hamming distance ≤ 6). The
--   operator can still proceed by re-submitting with ?force=true.
--
-- Both columns are nullable. Existing rows stay NULL until the
-- IE.2 backfill script hydrates them retroactively. Indexes are
-- (productId, hash) because the dedup check is always scoped to
-- one product — never global. Non-unique on contentHash because
-- the database may still contain duplicates the IE.2 sweep needs
-- to collapse before a UNIQUE constraint is safe.

ALTER TABLE "ProductImage" ADD COLUMN "contentHash"    TEXT;
ALTER TABLE "ProductImage" ADD COLUMN "perceptualHash" TEXT;

CREATE INDEX "ProductImage_productId_contentHash_idx"
  ON "ProductImage"("productId", "contentHash");

CREATE INDEX "ProductImage_productId_perceptualHash_idx"
  ON "ProductImage"("productId", "perceptualHash");
