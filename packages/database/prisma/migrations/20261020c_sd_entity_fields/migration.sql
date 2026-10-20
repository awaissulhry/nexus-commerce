-- SD-AUD (2026-10-20): every Sponsored Display setting Amazon holds, stored so Claude can read it. The v1 export keeps
-- only the common model (no bid optimization, no landing page, no nested audience expression, no serving status), so a
-- new SD sync (apps/api/src/services/advertising/sd/sd-entity-sync.service.ts) reads GET /sd/{campaigns,adGroups,
-- productAds,targets,negativeTargets}/extended and fills these columns, beside the ones that already exist (tactic,
-- costType, dates, portfolio, creativeType, default bid). Additive only: nullable columns on existing business-owned
-- tables (their row-level security already covers them); null = not SD, or not read yet.
--
-- Rollback: ALTER TABLE "Campaign" DROP COLUMN "servingStatus";
--           ALTER TABLE "AdGroup" DROP COLUMN "bidOptimization", DROP COLUMN "servingStatus";
--           ALTER TABLE "AdTarget" DROP COLUMN "expressionJson", DROP COLUMN "resolvedExpressionJson", DROP COLUMN "servingStatus";
--           ALTER TABLE "AdProductAd" DROP COLUMN "landingPageType", DROP COLUMN "landingPageUrl", DROP COLUMN "adName", DROP COLUMN "servingStatus";

-- AlterTable
ALTER TABLE "AdGroup" ADD COLUMN     "bidOptimization" TEXT,
ADD COLUMN     "servingStatus" TEXT;

-- AlterTable
ALTER TABLE "AdProductAd" ADD COLUMN     "adName" TEXT,
ADD COLUMN     "landingPageType" TEXT,
ADD COLUMN     "landingPageUrl" TEXT,
ADD COLUMN     "servingStatus" TEXT;

-- AlterTable
ALTER TABLE "AdTarget" ADD COLUMN     "expressionJson" JSONB,
ADD COLUMN     "resolvedExpressionJson" JSONB,
ADD COLUMN     "servingStatus" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "servingStatus" TEXT;
