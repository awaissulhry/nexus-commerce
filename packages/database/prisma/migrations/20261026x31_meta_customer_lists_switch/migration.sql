-- Meta consent PR 2 (2026-10-26; Owner decision D8, follow-up (a) of the Meta ads build) — "Upload customer lists to
-- Meta": one switch per business, OFF by default, a copy of step 33's "Send sales to Meta". A person turns it on in Nexus
-- (Settings › Channels › Meta); while it is off, set-meta-audience-members adds and replaces nobody and the gateway sends
-- no customer-list upload of this business. Additive only: two nullable columns on the existing business-owned
-- "AccountSettings" (its row-level security already covers them); no row and null both mean off.
-- Code: apps/api/src/services/marketing/meta-ads/customer-lists-switch.ts.
--
-- Rollback: ALTER TABLE "AccountSettings" DROP COLUMN "metaCustomerListsOnAt", DROP COLUMN "metaCustomerListsOnBy";

-- AlterTable
ALTER TABLE "AccountSettings" ADD COLUMN     "metaCustomerListsOnAt" TIMESTAMP(3),
ADD COLUMN     "metaCustomerListsOnBy" TEXT;
