/**
 * Meta ads M1 — which Meta ad accounts the daily read covers in the CURRENT business: the business's AD_ACCOUNT
 * `MetaAccountLink` (one per business), read through its own Meta connection. A business with none has no target, so
 * the read makes no call for it. A link whose connection is no longer active is not a target; a connection that needs
 * a new token still is — the gateway holds its calls before anything is sent, and the run records that in words.
 */
import prisma from '../../../db.js'
import type { MetaAdsTarget } from './types.js'

export const AD_ACCOUNT_PRODUCT = 'AD_ACCOUNT'

export async function listMetaReadTargets(): Promise<MetaAdsTarget[]> {
  const links = await prisma.metaAccountLink.findMany({
    where: { product: AD_ACCOUNT_PRODUCT, connection: { channelType: 'META', isActive: true } },
    select: { connectionId: true, externalId: true },
    orderBy: { createdAt: 'asc' },
  })
  return links.map((link) => ({ connectionId: link.connectionId, adAccountId: link.externalId }))
}

export async function metaReadTargetFor(adAccountId: string): Promise<MetaAdsTarget | null> {
  return (await listMetaReadTargets()).find((target) => target.adAccountId === adAccountId) ?? null
}
