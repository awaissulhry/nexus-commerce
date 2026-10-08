/**
 * ONE BRAIN AB-1 review — the campaigns the Owner keeps away from the bid brain: excluded (the campaign, or a product it
 * advertises), or with its whole bids lever locked at his own value (brain/settings.ts ownerBrakeOf). The per-campaign
 * tool set-bid-brain-enrollment refuses op live and release on them (bid-brain/enrollment.ts enrollRefusal), so no path
 * — today's tool or a future override tool — puts such a campaign under the bid brain. A shared campaign counts for
 * every product it advertises: one product's exclusion keeps it out.
 *
 * A leaf (prisma, the resolver, the pure settings): bid-brain/enrollment.ts imports it without a cycle. Three queries
 * for the ownership at most, one for the overrides.
 */
import prisma from '../../../db.js'
import { resolveCampaignOwnership } from './ownership.js'
import { ownerBrakeOf, resolveBrainSettings, type OverrideRow } from './settings.js'

/** campaignId → why the Owner keeps the bid brain off it; campaigns nothing keeps off are left out. */
export async function ownerBrakes(campaignIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const owners = await resolveCampaignOwnership(campaignIds)
  if (!owners.size) return out
  const products = [...new Set([...owners.values()].flatMap((o) => o.productIds))]
  const rows: OverrideRow[] = await prisma.adsBrainOverride.findMany({
    where: { endedAt: null, OR: [{ scope: 'CAMPAIGN', campaignId: { in: [...owners.keys()] } }, ...(products.length ? [{ scope: 'PRODUCT', productId: { in: products } }] : [])] },
    select: { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true },
  })
  if (!rows.length) return out
  for (const o of owners.values()) {
    if (!o.market) continue
    // A campaign override applies to its campaign under any product; with no product it still applies (resolved alone).
    for (const productId of o.productIds.length ? o.productIds : ['']) {
      const brake = ownerBrakeOf(resolveBrainSettings({ productId, market: o.market, campaignId: o.campaignId, enrolled: true, overrides: rows }))
      if (brake) { out.set(o.campaignId, brake); break }
    }
  }
  return out
}
