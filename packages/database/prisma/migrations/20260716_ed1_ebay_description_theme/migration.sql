-- ED.1 — eBay dynamic description themes (additive)
CREATE TABLE "EbayDescriptionTheme" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "html" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayDescriptionTheme_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EbayDescriptionTheme_name_key" ON "EbayDescriptionTheme"("name");
CREATE INDEX "EbayDescriptionTheme_isDefault_active_idx" ON "EbayDescriptionTheme"("isDefault", "active");
