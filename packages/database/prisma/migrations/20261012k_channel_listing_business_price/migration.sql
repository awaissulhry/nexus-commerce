-- Amazon Business (B2B) step 3 — the business offer Nexus manages per listing. Additive only.
-- CreateEnum
CREATE TYPE "BusinessPriceRule" AS ENUM ('PERCENT_OFF', 'FIXED');

-- AlterTable
ALTER TABLE "ChannelListing" ADD COLUMN     "businessPrice" DECIMAL(10,2),
ADD COLUMN     "businessPricePercent" DECIMAL(5,2),
ADD COLUMN     "businessPriceRule" "BusinessPriceRule",
ADD COLUMN     "businessTiers" JSONB;
