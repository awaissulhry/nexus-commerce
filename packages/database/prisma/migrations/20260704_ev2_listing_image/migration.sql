-- EV2 — listing thumbnails for the builder picker + Products page.
-- Source: Trading GalleryURL (ActiveList sweep) / GetItem PictureURL[0] —
-- responses the discovery sync already fetches; no extra API calls.
-- Reversible: ALTER TABLE "EbayListingIndex" DROP COLUMN "imageUrl";

ALTER TABLE "EbayListingIndex" ADD COLUMN "imageUrl" TEXT;
