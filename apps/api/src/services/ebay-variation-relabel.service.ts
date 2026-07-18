/**
 * Variation SKU relabeling — put the OWNER'S pool SKUs on a live eBay listing
 * (2026-07-18, owner decision: "I prefer my own SKUs and not the T series").
 *
 * Adopted listings arrived with their own custom labels (T1_Ne_L, IT-GALE-…).
 * Adoption made sync work by mirroring those labels; this service goes the
 * final step: ReviseFixedPriceItem rewrites each live variation's SKU to the
 * pool product's SKU — the variation is identified by its VariationSpecifics
 * (Taglia/Colore…), which are unchanged. After eBay confirms, the listing's
 * memberships are rewritten to the new SKUs (per-listing price + snapshot
 * preserved). End state: every listing shares identical pool SKUs — the
 * purest form of the shared-pool model.
 *
 * Safety: one ReviseFixedPriceItem per listing; nothing is written to our DB
 * unless eBay acked; unmapped variations (no pool link) are left untouched
 * and reported.
 */

import prisma from '../db.js'
import { callTradingApi, siteIdForMarket, escapeXml } from './ebay-trading-api.service.js'

export interface RelabelPlanEntry {
  fromSku: string
  toSku: string
  specifics: Record<string, string>
}

/** Build the ReviseFixedPriceItem XML for a batch of SKU relabels. */
export function buildRelabelXml(itemId: string, entries: RelabelPlanEntry[]): string {
  const variations = entries
    .map((e) => {
      const nvl = Object.entries(e.specifics)
        .map(([n, v]) => `<NameValueList><Name>${escapeXml(n)}</Name><Value>${escapeXml(v)}</Value></NameValueList>`)
        .join('')
      return `<Variation><SKU>${escapeXml(e.toSku)}</SKU><VariationSpecifics>${nvl}</VariationSpecifics></Variation>`
    })
    .join('')
  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <ItemID>${escapeXml(itemId)}</ItemID>
    <Variations>${variations}</Variations>
  </Item>
</ReviseFixedPriceItemRequest>`
}

export interface RelabelResult {
  itemId: string
  marketplace: string
  planned: number
  alreadyPool: number
  unmapped: string[]
  ebayAck: string
  membershipsRewritten: number
}

/**
 * Relabel ONE listing's variation SKUs to the pool products' SKUs.
 * Reads memberships (liveSku → productId), writes eBay, then our DB.
 */
export async function relabelListingToPoolSkus(
  itemId: string,
  marketplace: string,
  ctx: { oauthToken: string },
): Promise<RelabelResult> {
  const market = marketplace.toUpperCase()
  const memberships = await prisma.sharedListingMembership.findMany({
    where: { marketplace: market, itemId },
  })
  if (memberships.length === 0) {
    throw new Error(`no memberships for item ${itemId} on ${market} — run Reconcile first`)
  }
  const productIds = [...new Set(memberships.map((m) => m.productId).filter((v): v is string => !!v))]
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, sku: true },
  })
  const poolSkuByProductId = new Map(products.map((p) => [p.id, p.sku]))

  const entries: RelabelPlanEntry[] = []
  const unmapped: string[] = []
  let alreadyPool = 0
  for (const m of memberships) {
    const poolSku = m.productId ? poolSkuByProductId.get(m.productId) : undefined
    if (!poolSku) {
      unmapped.push(m.sku)
      continue
    }
    if (poolSku === m.sku) {
      alreadyPool++
      continue
    }
    entries.push({
      fromSku: m.sku,
      toSku: poolSku,
      specifics: (m.variationSpecifics as Record<string, string>) ?? {},
    })
  }

  let ebayAck = 'NOOP'
  let membershipsRewritten = 0
  if (entries.length > 0) {
    const xml = buildRelabelXml(itemId, entries)
    const res = await callTradingApi('ReviseFixedPriceItem', xml, {
      oauthToken: ctx.oauthToken,
      siteId: siteIdForMarket(market),
    })
    ebayAck = res.ack
    // eBay acked — rewrite our memberships to the new SKUs (per-listing price,
    // snapshot, qty state all preserved; only the natural key's sku changes).
    for (const e of entries) {
      const old = memberships.find((m) => m.sku === e.fromSku)!
      await prisma.$transaction([
        prisma.sharedListingMembership.delete({
          where: { marketplace_itemId_sku: { marketplace: market, itemId, sku: e.fromSku } },
        }),
        prisma.sharedListingMembership.create({
          data: {
            marketplace: market,
            itemId,
            sku: e.toSku,
            parentSku: old.parentSku,
            productId: old.productId,
            variationSpecifics: old.variationSpecifics as object,
            price: old.price,
            status: old.status,
            lastQtyPushed: old.lastQtyPushed,
            lastPushedAt: old.lastPushedAt,
            flatFileSnapshot: (old.flatFileSnapshot as object | null) ?? undefined,
          },
        }),
      ])
      membershipsRewritten++
    }
  }

  return {
    itemId,
    marketplace: market,
    planned: entries.length,
    alreadyPool,
    unmapped,
    ebayAck,
    membershipsRewritten,
  }
}
