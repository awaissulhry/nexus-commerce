-- An extra listing (ProductListingAlias) gets its own seller SKU, so an import or export names it by SKU inside one
-- business (Owner 2026-10-01). Additive: a nullable column and a unique index; PostgreSQL treats NULLs as distinct.
ALTER TABLE "ProductListingAlias" ADD COLUMN "sku" TEXT;

CREATE UNIQUE INDEX "ProductListingAlias_workspace_sku_key" ON "ProductListingAlias"("workspaceId", "sku");
