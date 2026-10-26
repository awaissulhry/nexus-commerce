-- Reviews Insights (2026-10-26, Reviews area PR E, build spec B17) — the fields the Insights pages (Alerts, Fixes,
-- Brief) read and write.
--
--   ReviewActionItem.approvalId   the change plan (AgentApproval.id) a fix was sent in for approval; several fixes sent
--                                 together share one plan. The status text gains 'SENT' (it is a plain text column,
--                                 not a Postgres enum, so no type change).
--   ReviewSpike.resolvedBy        who resolved an alert ("Resolved by … on …"); cleared when someone reopens it.
--   ReviewSpotlight.channel       the brief's channel scope (null = every channel); `marketplace` already exists.
--
-- Additive only: nullable columns and two indexes on existing business-owned tables (their row-level security already
-- covers new columns; no model-ownership change). Nothing is backfilled; with the columns empty every current screen
-- and job behaves exactly as before (an older brief has no channel = every channel).
--
-- Rollback: DROP INDEX "ReviewSpotlight_channel_marketplace_generatedAt_idx"; DROP INDEX "ReviewActionItem_approvalId_idx";
--           ALTER TABLE "ReviewSpotlight" DROP COLUMN "channel";
--           ALTER TABLE "ReviewActionItem" DROP COLUMN "approvalId";
--           ALTER TABLE "ReviewSpike" DROP COLUMN "resolvedBy";

-- AlterTable
ALTER TABLE "ReviewSpotlight" ADD COLUMN     "channel" TEXT;

-- AlterTable
ALTER TABLE "ReviewActionItem" ADD COLUMN     "approvalId" TEXT;

-- AlterTable
ALTER TABLE "ReviewSpike" ADD COLUMN     "resolvedBy" TEXT;

-- CreateIndex
CREATE INDEX "ReviewSpotlight_channel_marketplace_generatedAt_idx" ON "ReviewSpotlight"("channel", "marketplace", "generatedAt");

-- CreateIndex
CREATE INDEX "ReviewActionItem_approvalId_idx" ON "ReviewActionItem"("approvalId");
