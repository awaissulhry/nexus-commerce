-- Meta ads step 33 (lane C3, 2026-10-21; Owner decision D2) — "Send sales to Meta (Conversions API)": one switch per
-- business, OFF by default. A person turns it on in Nexus (Settings › Channels › Meta); while it is off, upload-meta-events
-- refuses and the gateway sends no Conversions API event of this business. Additive only: two nullable columns on the
-- existing business-owned "AccountSettings" (its row-level security already covers them); no row and null both mean off.
-- Code: apps/api/src/services/marketing/meta-ads/events-switch.ts.
--
-- Rollback: ALTER TABLE "AccountSettings" DROP COLUMN "metaConversionsApiOnAt", DROP COLUMN "metaConversionsApiOnBy";

-- AlterTable
ALTER TABLE "AccountSettings" ADD COLUMN     "metaConversionsApiOnAt" TIMESTAMP(3),
ADD COLUMN     "metaConversionsApiOnBy" TEXT;
