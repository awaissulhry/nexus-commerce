-- PES.6 — CategoryChannelMapping: our Category taxonomy ↔ the channel's own category.
-- ADDITIVE ONLY. Creates one new table; touches no existing table, column or index.
-- Nothing reads it until the mapping resolver prefers it over Product.productType, so
-- applying this alone changes no behaviour.

CREATE TABLE IF NOT EXISTS "CategoryChannelMapping" (
    "id"                  TEXT NOT NULL,
    "categoryId"          TEXT NOT NULL,
    "channel"             TEXT NOT NULL,
    "marketplace"         TEXT NOT NULL DEFAULT '*',
    "channelCategoryId"   TEXT NOT NULL,
    "channelCategoryPath" TEXT,
    "browseNodeId"        TEXT,
    "confidence"          TEXT NOT NULL DEFAULT 'MANUAL',
    "reviewedAt"          TIMESTAMP(3),
    "reviewedBy"          TEXT,
    "notes"               TEXT,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryChannelMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CategoryChannelMapping_categoryId_channel_marketplace_key"
    ON "CategoryChannelMapping" ("categoryId", "channel", "marketplace");

CREATE INDEX IF NOT EXISTS "CategoryChannelMapping_channel_marketplace_idx"
    ON "CategoryChannelMapping" ("channel", "marketplace");

CREATE INDEX IF NOT EXISTS "CategoryChannelMapping_channel_marketplace_channelCategoryId_idx"
    ON "CategoryChannelMapping" ("channel", "marketplace", "channelCategoryId");

CREATE INDEX IF NOT EXISTS "CategoryChannelMapping_categoryId_idx"
    ON "CategoryChannelMapping" ("categoryId");

-- Cascade: a deleted category must not leave a dangling mapping row.
DO $$
BEGIN
    ALTER TABLE "CategoryChannelMapping"
        ADD CONSTRAINT "CategoryChannelMapping_categoryId_fkey"
        FOREIGN KEY ("categoryId") REFERENCES "Category"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
