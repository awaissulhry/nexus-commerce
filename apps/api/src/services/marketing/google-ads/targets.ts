/**
 * Google Ads step 1a — which Google Ads accounts the daily read covers in the CURRENT business: the business's ADS
 * `GoogleAccountLink` (one per business in step 1, PLAN.md L6), read through its own Google connection. A business with
 * no ADS link has no target, so the read makes no call for it (PLAN.md L9).
 *
 * The sync side's only reader of the selection table (plan-2 §0). A link whose Google connection is no longer active
 * (disconnected) is not a target; a connection that needs a new sign-in still is — the gateway refuses its calls before
 * anything is sent, and the run records that in words.
 */
import prisma from '../../../db.js'
import type { GoogleAdsTarget } from './types.js'

/** The ADS link's product key on `GoogleAccountLink.product`. */
export const ADS_PRODUCT = 'ADS'

/** Every Google Ads account this business reads, ids digits only. */
export async function listReadTargets(): Promise<GoogleAdsTarget[]> {
  const links = await prisma.googleAccountLink.findMany({
    where: { product: ADS_PRODUCT, connection: { channelType: 'GOOGLE', isActive: true } },
    select: { connectionId: true, externalId: true, loginCustomerId: true },
    orderBy: { createdAt: 'asc' },
  })
  return links.map((link) => ({ connectionId: link.connectionId, customerId: link.externalId, loginCustomerId: link.loginCustomerId ?? null }))
}

/** The target for one Google Ads account of this business, or null when the business does not read it (any more). */
export async function readTargetFor(customerId: string): Promise<GoogleAdsTarget | null> {
  return (await listReadTargets()).find((target) => target.customerId === customerId) ?? null
}
