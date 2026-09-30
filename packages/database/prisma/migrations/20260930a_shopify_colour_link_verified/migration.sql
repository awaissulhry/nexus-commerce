-- Shopify colour products, link writer (docs/studies/shopify-linked-variations-PLAN.md §3.4, PR 4): when Nexus last read
-- back a colour product's colour name and colour list equal to what it wants ("Linked ✓").
-- Additive only: one nullable column on a business-owned table; row-level security is unchanged (it is per table).

-- AlterTable
ALTER TABLE "ShopifyColourProduct" ADD COLUMN "linkVerifiedAt" TIMESTAMP(3);
