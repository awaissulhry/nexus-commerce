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

// ── Incident #42 — SKU-less listing adoption ────────────────────────────────
//
// A pre-Nexus listing can carry variations with NO SKUs at all (the Saponette
// case: 8 variations, axis "Color", zero SKUs, zero memberships). Reconcile
// can't make memberships from them (no key), and relabel above requires
// memberships. This operation closes the loop in ONE pass:
//   live SKU-less variations → subset-match specifics onto the pool
//   (synonym-tolerant: Color:Black ↔ Colore:Nero) → ReviseFixedPriceItem
//   writes the pool SKUs onto those variations (identified by their
//   specifics) → memberships created keyed to the pool SKUs, price = the
//   LIVE variation's own price (per-listing truth).
// Unmatched/ambiguous variations are never guessed — reported untouched.

import {
  parseLiveVariations,
  findPoolMatch,
  type PoolEntry,
} from './ebay-membership-reconcile.service.js'
import { Prisma } from '@prisma/client'

export interface SkulessAdoptEntry {
  toSku: string
  productId: string
  specifics: Record<string, string>
  price: number | null
}

/** Pure planner: SKU-less live variations × pool → SKU writes + memberships. */
export function planSkulessAdoption(
  live: Array<{ sku: string; specifics: Record<string, string>; price: number | null }>,
  pool: PoolEntry[],
): { entries: SkulessAdoptEntry[]; unmatched: string[] } {
  const entries: SkulessAdoptEntry[] = []
  const unmatched: string[] = []
  const takenProducts = new Set<string>()
  for (const v of live) {
    if (String(v.sku ?? '').trim()) continue // only SKU-less variations
    const hit = findPoolMatch(v.specifics, pool)
    const label = Object.entries(v.specifics).map(([k, val]) => `${k}=${val}`).join(',') || '(no specifics)'
    if (!hit) {
      unmatched.push(label)
      continue
    }
    if (takenProducts.has(hit.productId)) {
      // two SKU-less variations resolving to the SAME product would collide
      // on the membership key — refuse the second, never guess.
      unmatched.push(`${label} (duplicate pool match)`)
      continue
    }
    takenProducts.add(hit.productId)
    entries.push({ toSku: '', productId: hit.productId, specifics: v.specifics, price: v.price })
  }
  return { entries, unmatched }
}

export interface SkulessAdoptionResult {
  itemId: string
  marketplace: string
  liveVariations: number
  skuless: number
  adopted: number
  unmatched: string[]
  ebayAck: string
  membershipsCreated: number
}

/** Write pool SKUs onto a listing's SKU-less variations and create their
 *  memberships. Reads eBay + pool; writes eBay THEN our DB (nothing persists
 *  unless eBay acked). */
export async function adoptSkulessVariations(
  itemId: string,
  marketplace: string,
  ctx: { oauthToken: string },
  preferredParentSku?: string,
): Promise<SkulessAdoptionResult> {
  const market = marketplace.toUpperCase()
  const getXml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${escapeXml(itemId)}</ItemID></GetItemRequest>`
  const got = await callTradingApi('GetItem', getXml, { oauthToken: ctx.oauthToken, siteId: siteIdForMarket(market) })
  const live = parseLiveVariations(got.raw)
  // per-variation price (StartPrice) by specifics — parseLiveVariations
  // doesn't carry it and the membership should record the LIVE price.
  const priceBySpecs = new Map<string, number>()
  for (const vm of got.raw.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)) {
    const block = vm[1]
    const price = /<StartPrice[^>]*>([\d.]+)<\/StartPrice>/.exec(block)?.[1]
    if (price == null) continue
    const specs: string[] = []
    const specsBlock = /<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/.exec(block)?.[1] ?? ''
    for (const nv of specsBlock.matchAll(/<NameValueList>[\s\S]*?<Name>([^<]*)<\/Name>[\s\S]*?<Value>([^<]*)<\/Value>[\s\S]*?<\/NameValueList>/g)) {
      specs.push(`${nv[1].trim().toLowerCase()}=${nv[2].trim().toLowerCase()}`)
    }
    priceBySpecs.set(specs.sort().join('|'), Number(price))
  }
  const keyOf = (specifics: Record<string, string>) =>
    Object.entries(specifics).map(([k, v]) => `${k.trim().toLowerCase()}=${String(v).trim().toLowerCase()}`).sort().join('|')

  const skulessLive = live
    .filter((v) => !String(v.sku ?? '').trim())
    .map((v) => ({ sku: v.sku, specifics: v.specifics, price: priceBySpecs.get(keyOf(v.specifics)) ?? null }))

  const base: SkulessAdoptionResult = {
    itemId, marketplace: market, liveVariations: live.length,
    skuless: skulessLive.length, adopted: 0, unmatched: [], ebayAck: 'NOOP', membershipsCreated: 0,
  }
  if (skulessLive.length === 0) return base

  // Pool truth — same sourcing as reconcile: every linked membership in this
  // market (the primary supplies the aspect-rich set).
  const allLinked = await prisma.sharedListingMembership.findMany({
    where: { marketplace: market, productId: { not: null } },
    select: { productId: true, variationSpecifics: true, price: true },
    orderBy: { updatedAt: 'desc' },
  })
  const pool: PoolEntry[] = allLinked.map((m) => ({
    productId: m.productId as string,
    price: m.price != null ? Number(m.price) : null,
    specifics: (m.variationSpecifics as Record<string, string>) ?? {},
  }))

  const plan = planSkulessAdoption(skulessLive, pool)
  base.unmatched = plan.unmatched
  if (plan.entries.length === 0) return base

  const products = await prisma.product.findMany({
    where: { id: { in: plan.entries.map((e) => e.productId) } },
    select: { id: true, sku: true, parentId: true },
  })
  const skuById = new Map(products.map((p) => [p.id, p.sku]))
  const entries: RelabelPlanEntry[] = plan.entries
    .map((e) => ({ fromSku: '', toSku: skuById.get(e.productId) ?? '', specifics: e.specifics }))
    .filter((e) => Boolean(e.toSku))
  if (entries.length === 0) return base

  const res = await callTradingApi('ReviseFixedPriceItem', buildRelabelXml(itemId, entries), {
    oauthToken: ctx.oauthToken,
    siteId: siteIdForMarket(market),
  })
  base.ebayAck = res.ack
  base.adopted = entries.length

  // parent SKU for the new memberships: caller's (the shell) > pool family parent > itemId
  let parentSku = preferredParentSku && !/^\d+$/.test(preferredParentSku) ? preferredParentSku : ''
  if (!parentSku) {
    const firstParentId = products.find((p) => p.parentId)?.parentId
    if (firstParentId) {
      const poolParent = await prisma.product.findFirst({ where: { id: firstParentId }, select: { sku: true } })
      if (poolParent?.sku) parentSku = poolParent.sku
    }
  }
  if (!parentSku) parentSku = itemId

  for (const e of plan.entries) {
    const toSku = skuById.get(e.productId)
    if (!toSku) continue
    await prisma.sharedListingMembership.upsert({
      where: { marketplace_itemId_sku: { marketplace: market, itemId, sku: toSku } },
      update: {
        productId: e.productId,
        variationSpecifics: e.specifics,
        ...(e.price != null ? { price: new Prisma.Decimal(e.price) } : {}),
        parentSku,
        status: 'ACTIVE',
      },
      create: {
        marketplace: market, itemId, sku: toSku,
        productId: e.productId,
        variationSpecifics: e.specifics,
        ...(e.price != null ? { price: new Prisma.Decimal(e.price) } : {}),
        parentSku,
        status: 'ACTIVE',
      },
    })
    base.membershipsCreated++
  }
  return base
}
