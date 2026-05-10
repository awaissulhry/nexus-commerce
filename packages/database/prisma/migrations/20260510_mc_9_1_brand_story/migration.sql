-- MC.9.1: Amazon Brand Story (Brand Registry).
-- Brand-level analogue of APlusContent. Three new tables:
-- BrandStory, BrandStoryModule, BrandStoryVersion. Self-FK on
-- masterStoryId for localization siblings (SetNull on master delete
-- so translations survive). One story per (brand, marketplace,
-- locale) — Amazon rejects duplicates.

CREATE TABLE IF NOT EXISTS "BrandStory" (
  "id"                TEXT         NOT NULL,
  "name"              TEXT         NOT NULL,
  "brand"             TEXT         NOT NULL,
  "marketplace"       TEXT         NOT NULL,
  "locale"            TEXT         NOT NULL,
  "masterStoryId"     TEXT,
  "status"            TEXT         NOT NULL DEFAULT 'DRAFT',
  "amazonDocumentId"  TEXT,
  "submittedAt"       TIMESTAMP(3),
  "submissionPayload" JSONB,
  "publishedAt"       TIMESTAMP(3),
  "notes"             TEXT,
  "scheduledFor"      TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandStory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BrandStory_brand_marketplace_locale_key"
  ON "BrandStory"("brand", "marketplace", "locale");
CREATE INDEX IF NOT EXISTS "BrandStory_marketplace_status_idx"
  ON "BrandStory"("marketplace", "status");
CREATE INDEX IF NOT EXISTS "BrandStory_brand_idx"
  ON "BrandStory"("brand");
CREATE INDEX IF NOT EXISTS "BrandStory_masterStoryId_idx"
  ON "BrandStory"("masterStoryId");
CREATE INDEX IF NOT EXISTS "BrandStory_status_scheduledFor_idx"
  ON "BrandStory"("status", "scheduledFor");

ALTER TABLE "BrandStory"
  ADD CONSTRAINT "BrandStory_masterStoryId_fkey"
  FOREIGN KEY ("masterStoryId") REFERENCES "BrandStory"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "BrandStoryModule" (
  "id"        TEXT         NOT NULL,
  "storyId"   TEXT         NOT NULL,
  "type"      TEXT         NOT NULL,
  "position"  INTEGER      NOT NULL DEFAULT 0,
  "payload"   JSONB        NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandStoryModule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BrandStoryModule_storyId_position_idx"
  ON "BrandStoryModule"("storyId", "position");

ALTER TABLE "BrandStoryModule"
  ADD CONSTRAINT "BrandStoryModule_storyId_fkey"
  FOREIGN KEY ("storyId") REFERENCES "BrandStory"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "BrandStoryVersion" (
  "id"        TEXT         NOT NULL,
  "storyId"   TEXT         NOT NULL,
  "version"   INTEGER      NOT NULL,
  "reason"    TEXT         NOT NULL,
  "snapshot"  JSONB        NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandStoryVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BrandStoryVersion_storyId_version_key"
  ON "BrandStoryVersion"("storyId", "version");
CREATE INDEX IF NOT EXISTS "BrandStoryVersion_storyId_createdAt_idx"
  ON "BrandStoryVersion"("storyId", "createdAt");

ALTER TABLE "BrandStoryVersion"
  ADD CONSTRAINT "BrandStoryVersion_storyId_fkey"
  FOREIGN KEY ("storyId") REFERENCES "BrandStory"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
