-- VP.3: reusable named volume-pricing tier ladder (library template). Additive
-- only — a brand-new table, no FK, no change to any existing table. A promotion
-- created "from a template" COPIES the template's tiers; the two never share a row.

CREATE TABLE "EbayVolumeTierTemplate" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "tiers"       JSONB NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EbayVolumeTierTemplate_pkey" PRIMARY KEY ("id")
);
