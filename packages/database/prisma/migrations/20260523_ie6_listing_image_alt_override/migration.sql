-- IE.6 — Per-variant alt-text override on ListingImage.
--
-- Closes one half of the "single source of truth" gap: previously
-- the operator could only override the master gallery's alt text by
-- uploading a separate ProductImage per variant. Now altOverride
-- lets a variant scope its own alt without duplicating the image
-- (resolveCell + the channel publisher fall back to
-- ProductImage.alt when altOverride is NULL).
--
-- The url-derivation half lands in IE.6b — that one is a bigger
-- refactor across publish + cascade-republish paths so it stays
-- out of this commit.

ALTER TABLE "ListingImage" ADD COLUMN "altOverride" TEXT;
