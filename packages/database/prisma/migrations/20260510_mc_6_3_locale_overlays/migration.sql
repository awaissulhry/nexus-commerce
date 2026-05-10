-- MC.6.3 — Per-asset locale overlay rows.
-- Stores localized text/badge overlays applied at variant build time
-- via Cloudinary `l_text:` overlays.

CREATE TABLE "AssetLocaleOverlay" (
  "id" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "position" TEXT NOT NULL DEFAULT 'south',
  "color" TEXT NOT NULL DEFAULT 'white',
  "bgColor" TEXT,
  "font" TEXT NOT NULL DEFAULT 'Arial_60_bold',
  "offsetY" INTEGER NOT NULL DEFAULT 24,
  "offsetX" INTEGER NOT NULL DEFAULT 0,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AssetLocaleOverlay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AssetLocaleOverlay_assetId_locale_key"
  ON "AssetLocaleOverlay" ("assetId", "locale");

CREATE INDEX "AssetLocaleOverlay_locale_idx"
  ON "AssetLocaleOverlay" ("locale");

ALTER TABLE "AssetLocaleOverlay"
  ADD CONSTRAINT "AssetLocaleOverlay_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "DigitalAsset"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
