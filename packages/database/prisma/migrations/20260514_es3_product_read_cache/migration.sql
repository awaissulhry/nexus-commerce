-- ES.3: ProductReadCache — denormalized read model for /products grid.
-- One row per Product; rebuilt by the read-cache BullMQ worker when
-- a ProductEvent fires. Eliminates 6-table join on every grid load.

CREATE TABLE "ProductReadCache" (
  "id"                TEXT           NOT NULL,
  "sku"               TEXT           NOT NULL,
  "name"              TEXT           NOT NULL,
  "brand"             TEXT,
  "basePrice"         DECIMAL(10,2),
  "totalStock"        INTEGER        NOT NULL DEFAULT 0,
  "lowStockThreshold" INTEGER,
  "status"            TEXT           NOT NULL,
  "syncChannels"      TEXT[]         NOT NULL DEFAULT '{}',
  "productType"       TEXT,
  "fulfillmentMethod" TEXT,
  "isParent"          BOOLEAN        NOT NULL DEFAULT false,
  "parentId"          TEXT,
  "version"           INTEGER        NOT NULL DEFAULT 0,
  -- Denormalized relations
  "familyId"          TEXT,
  "familyJson"        JSONB,
  "workflowStageId"   TEXT,
  "workflowStageJson" JSONB,
  -- Media
  "imageUrl"          TEXT,
  -- Computed counts
  "photoCount"        INTEGER        NOT NULL DEFAULT 0,
  "channelCount"      INTEGER        NOT NULL DEFAULT 0,
  "variantCount"      INTEGER        NOT NULL DEFAULT 0,
  "childCount"        INTEGER        NOT NULL DEFAULT 0,
  -- Hygiene flags
  "hasDescription"    BOOLEAN        NOT NULL DEFAULT false,
  "hasBrand"          BOOLEAN        NOT NULL DEFAULT false,
  "hasGtin"           BOOLEAN        NOT NULL DEFAULT false,
  "hasPhotos"         BOOLEAN        NOT NULL DEFAULT false,
  -- Channel keys and coverage
  "channelKeys"       TEXT[]         NOT NULL DEFAULT '{}',
  "coverageJson"      JSONB,
  -- Timestamps
  "createdAt"         TIMESTAMP(3)   NOT NULL,
  "updatedAt"         TIMESTAMP(3)   NOT NULL,
  "deletedAt"         TIMESTAMP(3),
  "cacheRefreshedAt"  TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductReadCache_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductReadCache_status_idx"           ON "ProductReadCache"("status");
CREATE INDEX "ProductReadCache_brand_idx"            ON "ProductReadCache"("brand");
CREATE INDEX "ProductReadCache_productType_idx"      ON "ProductReadCache"("productType");
CREATE INDEX "ProductReadCache_familyId_idx"         ON "ProductReadCache"("familyId");
CREATE INDEX "ProductReadCache_workflowStageId_idx"  ON "ProductReadCache"("workflowStageId");
CREATE INDEX "ProductReadCache_isParent_idx"         ON "ProductReadCache"("isParent");
CREATE INDEX "ProductReadCache_parentId_idx"         ON "ProductReadCache"("parentId");
CREATE INDEX "ProductReadCache_totalStock_idx"       ON "ProductReadCache"("totalStock");
CREATE INDEX "ProductReadCache_updatedAt_idx"        ON "ProductReadCache"("updatedAt" DESC);
CREATE INDEX "ProductReadCache_deletedAt_idx"        ON "ProductReadCache"("deletedAt");
CREATE INDEX "ProductReadCache_photoCount_idx"       ON "ProductReadCache"("photoCount");
CREATE INDEX "ProductReadCache_channelCount_idx"     ON "ProductReadCache"("channelCount");
CREATE INDEX "ProductReadCache_variantCount_idx"     ON "ProductReadCache"("variantCount");
