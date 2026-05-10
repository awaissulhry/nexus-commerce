-- MC.10.1: Brand Kit + Brand Watermark Template.
-- One BrandKit per brand label (unique). BrandWatermarkTemplate
-- links via brand label (cascade on BrandKit delete).

CREATE TABLE IF NOT EXISTS "BrandKit" (
  "id"          TEXT         NOT NULL,
  "brand"       TEXT         NOT NULL,
  "displayName" TEXT,
  "tagline"     TEXT,
  "voiceNotes"  TEXT,
  "colors"      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  "fonts"       JSONB        NOT NULL DEFAULT '[]'::jsonb,
  "logos"       JSONB        NOT NULL DEFAULT '[]'::jsonb,
  "notes"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandKit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BrandKit_brand_key"
  ON "BrandKit"("brand");

CREATE TABLE IF NOT EXISTS "BrandWatermarkTemplate" (
  "id"        TEXT         NOT NULL,
  "brand"     TEXT         NOT NULL,
  "name"      TEXT         NOT NULL,
  "type"      TEXT         NOT NULL,
  "config"    JSONB        NOT NULL,
  "enabled"   BOOLEAN      NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandWatermarkTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BrandWatermarkTemplate_brand_enabled_idx"
  ON "BrandWatermarkTemplate"("brand", "enabled");

ALTER TABLE "BrandWatermarkTemplate"
  ADD CONSTRAINT "BrandWatermarkTemplate_brand_fkey"
  FOREIGN KEY ("brand") REFERENCES "BrandKit"("brand")
  ON DELETE CASCADE ON UPDATE CASCADE;
