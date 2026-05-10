-- MC.8.1: Amazon A+ Content schema (Brand Registry).
-- Three tables: APlusContent (the document), APlusContentAsin (ASIN
-- attachment join), APlusModule (drag-drop blocks). Self-referential
-- FK on APlusContent.masterContentId for localization siblings;
-- SetNull so deleting the IT master orphans (but doesn't drop) the
-- DE/UK/FR/ES translations.

CREATE TABLE IF NOT EXISTS "APlusContent" (
  "id"                TEXT         NOT NULL,
  "name"              TEXT         NOT NULL,
  "brand"             TEXT,
  "marketplace"       TEXT         NOT NULL,
  "locale"            TEXT         NOT NULL,
  "masterContentId"   TEXT,
  "status"            TEXT         NOT NULL DEFAULT 'DRAFT',
  "amazonDocumentId"  TEXT,
  "submittedAt"       TIMESTAMP(3),
  "submissionPayload" JSONB,
  "publishedAt"       TIMESTAMP(3),
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "APlusContent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "APlusContent_marketplace_status_idx"
  ON "APlusContent"("marketplace", "status");
CREATE INDEX IF NOT EXISTS "APlusContent_brand_idx"
  ON "APlusContent"("brand");
CREATE INDEX IF NOT EXISTS "APlusContent_masterContentId_idx"
  ON "APlusContent"("masterContentId");

ALTER TABLE "APlusContent"
  ADD CONSTRAINT "APlusContent_masterContentId_fkey"
  FOREIGN KEY ("masterContentId") REFERENCES "APlusContent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "APlusContentAsin" (
  "contentId"  TEXT         NOT NULL,
  "asin"       TEXT         NOT NULL,
  "productId"  TEXT,
  "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "APlusContentAsin_pkey" PRIMARY KEY ("contentId", "asin")
);

CREATE INDEX IF NOT EXISTS "APlusContentAsin_asin_idx"
  ON "APlusContentAsin"("asin");
CREATE INDEX IF NOT EXISTS "APlusContentAsin_productId_idx"
  ON "APlusContentAsin"("productId");

ALTER TABLE "APlusContentAsin"
  ADD CONSTRAINT "APlusContentAsin_contentId_fkey"
  FOREIGN KEY ("contentId") REFERENCES "APlusContent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "APlusContentAsin"
  ADD CONSTRAINT "APlusContentAsin_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "APlusModule" (
  "id"        TEXT         NOT NULL,
  "contentId" TEXT         NOT NULL,
  "type"      TEXT         NOT NULL,
  "position"  INTEGER      NOT NULL DEFAULT 0,
  "payload"   JSONB        NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "APlusModule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "APlusModule_contentId_position_idx"
  ON "APlusModule"("contentId", "position");

ALTER TABLE "APlusModule"
  ADD CONSTRAINT "APlusModule_contentId_fkey"
  FOREIGN KEY ("contentId") REFERENCES "APlusContent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
