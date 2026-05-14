-- CO series: CatalogOrganizeSession + CatalogOrganizeChange
-- Session-based publish + 48-hour undo for /catalog/organize drag-and-drop.

CREATE TABLE "CatalogOrganizeSession" (
    "id"            TEXT        NOT NULL,
    "status"        TEXT        NOT NULL DEFAULT 'PUBLISHED',
    "publishedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoExpiresAt" TIMESTAMP(3) NOT NULL,
    "undoneAt"      TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CatalogOrganizeSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CatalogOrganizeChange" (
    "id"                   TEXT         NOT NULL,
    "sessionId"            TEXT         NOT NULL,
    "productId"            TEXT         NOT NULL,
    "toParentId"           TEXT         NOT NULL,
    "fromParentId"         TEXT,
    "fromVariantAttributes" JSONB,
    "attributes"           JSONB,
    "status"               TEXT         NOT NULL DEFAULT 'APPLIED',
    "queueIds"             TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "undoneAt"             TIMESTAMP(3),
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CatalogOrganizeChange_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CatalogOrganizeChange"
    ADD CONSTRAINT "CatalogOrganizeChange_sessionId_fkey"
    FOREIGN KEY ("sessionId")
    REFERENCES "CatalogOrganizeSession"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "CatalogOrganizeSession_status_createdAt_idx"
    ON "CatalogOrganizeSession"("status", "createdAt");

CREATE INDEX "CatalogOrganizeChange_sessionId_idx"
    ON "CatalogOrganizeChange"("sessionId");

CREATE INDEX "CatalogOrganizeChange_productId_idx"
    ON "CatalogOrganizeChange"("productId");
