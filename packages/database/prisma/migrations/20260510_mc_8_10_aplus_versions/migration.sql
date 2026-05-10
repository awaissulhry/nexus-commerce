-- MC.8.10: A+ Content versioning + scheduling.
-- New APlusContentVersion table snapshots the document on submit/
-- rollback. APlusContent gains scheduledFor for delayed submissions.

ALTER TABLE "APlusContent"
  ADD COLUMN IF NOT EXISTS "scheduledFor" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "APlusContent_status_scheduledFor_idx"
  ON "APlusContent"("status", "scheduledFor");

CREATE TABLE IF NOT EXISTS "APlusContentVersion" (
  "id"        TEXT         NOT NULL,
  "contentId" TEXT         NOT NULL,
  "version"   INTEGER      NOT NULL,
  "reason"    TEXT         NOT NULL,
  "snapshot"  JSONB        NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "APlusContentVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "APlusContentVersion_contentId_version_key"
  ON "APlusContentVersion"("contentId", "version");
CREATE INDEX IF NOT EXISTS "APlusContentVersion_contentId_createdAt_idx"
  ON "APlusContentVersion"("contentId", "createdAt");

ALTER TABLE "APlusContentVersion"
  ADD CONSTRAINT "APlusContentVersion_contentId_fkey"
  FOREIGN KEY ("contentId") REFERENCES "APlusContent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
