-- CBU — AI Goal: associate an Amazon Ads portfolio (PortfolioPicker).
-- Additive, nullable; applied when the goal's campaigns materialize.
-- AlterTable
ALTER TABLE "AdProductGoal" ADD COLUMN "portfolioId" TEXT;
