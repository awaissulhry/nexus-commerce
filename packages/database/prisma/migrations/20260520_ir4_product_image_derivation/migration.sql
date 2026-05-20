-- IR.4.1 — Self-FK for in-app image editor derivations.
--
-- The editor (crop / rotate / flip) creates a NEW ProductImage row
-- whose URL is a Cloudinary transformation of the source. This column
-- points at the source so the lightbox drawer can render the version
-- chain ("Derived from MAIN v1" / "N derivatives").
--
-- ON DELETE SET NULL: deleting a source image doesn't cascade-delete
-- its derivatives. The derivatives' transformation URLs continue to
-- resolve as long as Cloudinary keeps the source publicId — Cloudinary
-- delete is a separate, explicit operation in the upload route.
--
-- Index supports the "show me derivatives of X" query in the drawer
-- as well as integrity checks during source-delete decisions.

ALTER TABLE "ProductImage" ADD COLUMN "derivedFromImageId" TEXT;

ALTER TABLE "ProductImage"
  ADD CONSTRAINT "ProductImage_derivedFromImageId_fkey"
  FOREIGN KEY ("derivedFromImageId") REFERENCES "ProductImage"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ProductImage_derivedFromImageId_idx" ON "ProductImage"("derivedFromImageId");
