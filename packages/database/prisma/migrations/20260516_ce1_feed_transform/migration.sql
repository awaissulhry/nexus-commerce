-- CE.1: Feed Transform Engine
-- FeedTransformRule: IF/THEN field mapping rules for multi-channel catalog normalization
-- ChannelSchema: per-channel field definitions for validation + UI

CREATE TABLE "FeedTransformRule" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "channel"     TEXT NOT NULL,
  "marketplace" TEXT,
  "field"       TEXT NOT NULL,
  "priority"    INTEGER NOT NULL DEFAULT 100,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "condition"   JSONB,
  "action"      JSONB NOT NULL DEFAULT '{}',
  "createdBy"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeedTransformRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeedTransformRule_name_channel_marketplace_key"
  ON "FeedTransformRule"("name", "channel", COALESCE("marketplace", ''));

CREATE INDEX "FeedTransformRule_channel_field_priority_idx"
  ON "FeedTransformRule"("channel", "field", "priority");

CREATE TABLE "ChannelSchema" (
  "id"            TEXT NOT NULL,
  "channel"       TEXT NOT NULL,
  "marketplace"   TEXT,
  "fieldKey"      TEXT NOT NULL,
  "label"         TEXT NOT NULL,
  "maxLength"     INTEGER,
  "required"      BOOLEAN NOT NULL DEFAULT false,
  "allowedValues" JSONB,
  "notes"         TEXT,
  CONSTRAINT "ChannelSchema_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelSchema_channel_marketplace_fieldKey_key"
  ON "ChannelSchema"("channel", COALESCE("marketplace", ''), "fieldKey");

CREATE INDEX "ChannelSchema_channel_marketplace_idx"
  ON "ChannelSchema"("channel", "marketplace");
