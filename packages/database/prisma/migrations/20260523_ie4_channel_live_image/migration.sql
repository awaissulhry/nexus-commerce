-- IE.4 — Live channel image snapshots.
--
-- New table mirroring "what's currently live on channel" for each
-- (product, channel, marketplace, sku, slot) tuple. Refreshed by the
-- IE.4 fetcher (Amazon GetListingsItem with includedData=['images']
-- first, eBay + Shopify follow). The IE.5 drift detector compares
-- these snapshots against the local ListingImage intent and surfaces
-- mismatches in the workspace.
--
-- Cascade delete on productId so removing a product cleans up its
-- snapshot rows in one shot. Marketplace is nullable for eBay +
-- Shopify (single-region channels today).

CREATE TABLE "ChannelLiveImage" (
  "id"          TEXT      PRIMARY KEY,
  "productId"   TEXT      NOT NULL,
  "channel"     TEXT      NOT NULL,
  "marketplace" TEXT,
  "externalSku" TEXT,
  "asin"        TEXT,
  "slot"        TEXT,
  "url"         TEXT      NOT NULL,
  "width"       INTEGER,
  "height"      INTEGER,
  "sortOrder"   INTEGER   NOT NULL DEFAULT 0,
  "etag"        TEXT,
  "fetchedAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ChannelLiveImage_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ChannelLiveImage_productId_channel_marketplace_externalSku_slot_key"
  ON "ChannelLiveImage"("productId", "channel", "marketplace", "externalSku", "slot");

CREATE INDEX "ChannelLiveImage_productId_channel_idx"
  ON "ChannelLiveImage"("productId", "channel");

CREATE INDEX "ChannelLiveImage_fetchedAt_idx"
  ON "ChannelLiveImage"("fetchedAt");
