/**
 * Add variations to a LIVE eBay listing (2026-07-18).
 *
 * The owner imports files carrying the FULL size range, but adopted listings
 * may hold only a subset of variations. Publishing the new rows used to hit
 * the adopt belt ("already live — nothing re-listed") with no way to actually
 * ADD the missing variations. This service closes that gap:
 *
 *   ReviseFixedPriceItem with ONLY the new <Variation> nodes, PLUS the full
 *   <VariationSpecificsSet> extended with any new axis values (eBay rejects a
 *   variation whose value is outside the declared set). After eBay acks, a
 *   membership is created per added variation so the pool fan-out picks the
 *   new SKUs up immediately.
 *
 * Safety: one revise per listing; DB writes only after eBay's ack; variations
 * whose specifics can't be derived are skipped and reported.
 */

import prisma from '../db.js'
import { Prisma } from '@prisma/client'
import { callTradingApi, siteIdForMarket, escapeXml } from './ebay-trading-api.service.js'
import { parseLiveVariations, type LiveVariation } from './ebay-membership-reconcile.service.js'

export interface NewVariationInput {
  sku: string
  price: number
  quantity: number
  specifics: Record<string, string>
  /** Product identifier; defaults to eBay's literal "Does not apply" (the
   *  exact value the owner's live variations carry) when absent. */
  ean?: string
}

/** Parse the listing's declared VariationSpecificsSet from GetItem XML. */
export function parseVariationSpecificsSet(raw: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const set = /<VariationSpecificsSet>([\s\S]*?)<\/VariationSpecificsSet>/.exec(raw)?.[1] ?? ''
  for (const nv of set.matchAll(/<NameValueList>([\s\S]*?)<\/NameValueList>/g)) {
    const name = /<Name>([^<]*)<\/Name>/.exec(nv[1])?.[1]
    if (!name) continue
    out[name] = [...nv[1].matchAll(/<Value>([^<]*)<\/Value>/g)].map((m) => m[1])
  }
  return out
}

/** Union the declared set with the new variations' values (order-preserving). */
export function extendSpecificsSet(
  declared: Record<string, string[]>,
  additions: NewVariationInput[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, vals] of Object.entries(declared)) out[k] = [...vals]
  for (const v of additions) {
    for (const [name, value] of Object.entries(v.specifics)) {
      if (!out[name]) out[name] = []
      if (!out[name].some((x) => x.trim().toLowerCase() === value.trim().toLowerCase())) out[name].push(value)
    }
  }
  return out
}

/** ReviseFixedPriceItem XML: extended set + ONLY the new variations. */
export function buildAddVariationsXml(
  itemId: string,
  specificsSet: Record<string, string[]>,
  additions: NewVariationInput[],
): string {
  const setXml = Object.entries(specificsSet)
    .map(([name, vals]) =>
      `<NameValueList><Name>${escapeXml(name)}</Name>${vals.map((v) => `<Value>${escapeXml(v)}</Value>`).join('')}</NameValueList>`)
    .join('')
  const varsXml = additions
    .map((v) => {
      const nvl = Object.entries(v.specifics)
        .map(([n, val]) => `<NameValueList><Name>${escapeXml(n)}</Name><Value>${escapeXml(val)}</Value></NameValueList>`)
        .join('')
      const ean = v.ean?.trim() || 'Does not apply'
      return `<Variation><SKU>${escapeXml(v.sku)}</SKU><StartPrice>${v.price.toFixed(2)}</StartPrice><Quantity>${Math.max(0, Math.trunc(v.quantity))}</Quantity><VariationProductListingDetails><EAN>${escapeXml(ean)}</EAN></VariationProductListingDetails><VariationSpecifics>${nvl}</VariationSpecifics></Variation>`
    })
    .join('')
  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <ItemID>${escapeXml(itemId)}</ItemID>
    <Variations><VariationSpecificsSet>${setXml}</VariationSpecificsSet>${varsXml}</Variations>
  </Item>
</ReviseFixedPriceItemRequest>`
}

export interface AddVariationsResult {
  itemId: string
  marketplace: string
  added: number
  skippedExisting: number
  ebayAck: string
  membershipsCreated: number
}

/**
 * Add the given variations to a live listing. Variations whose SKU is already
 * live on the listing are skipped (idempotent). Memberships created after ack.
 */
export async function addVariationsToListing(
  itemId: string,
  marketplace: string,
  candidates: NewVariationInput[],
  ctx: { oauthToken: string },
): Promise<AddVariationsResult> {
  const market = marketplace.toUpperCase()
  const getXml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${escapeXml(itemId)}</ItemID>
</GetItemRequest>`
  const got = await callTradingApi('GetItem', getXml, { oauthToken: ctx.oauthToken, siteId: siteIdForMarket(market) })
  const live: LiveVariation[] = parseLiveVariations(got.raw)
  const declaredSet = parseVariationSpecificsSet(got.raw)
  const liveSkus = new Set(live.map((v) => v.sku))
  const axisNames = Object.keys(declaredSet)

  // Project each candidate's specifics onto the listing's DECLARED axes —
  // extra aspects (Brand, Stagione…) never ride a Variation node, and a
  // candidate missing a declared axis value cannot be added (skipped, visible
  // in the counts). Axis-name matching is case-insensitive.
  const additions: NewVariationInput[] = []
  // Audit S5 — a crash between eBay's ack and the membership writes used to
  // orphan live variations forever (GetItem shows them live → skipped; no
  // membership → no pool fan-out). Live SKUs with NO membership now self-heal.
  const healCandidates: Array<{ sku: string; live: LiveVariation }> = []
  let skippedExisting = 0
  for (const c of candidates) {
    if (!c.sku) { skippedExisting++; continue }
    if (liveSkus.has(c.sku)) {
      const lv = live.find((v) => v.sku === c.sku)
      if (lv) healCandidates.push({ sku: c.sku, live: lv })
      skippedExisting++
      continue
    }
    const projected: Record<string, string> = {}
    let complete = true
    for (const axis of axisNames) {
      const hit = Object.entries(c.specifics).find(([k]) => k.trim().toLowerCase() === axis.trim().toLowerCase())
      if (!hit || !String(hit[1]).trim()) { complete = false; break }
      projected[axis] = String(hit[1]).trim()
    }
    if (!complete || axisNames.length === 0) { skippedExisting++; continue }
    additions.push({ ...c, specifics: projected })
  }

  let ebayAck = 'NOOP'
  let membershipsCreated = 0
  if (additions.length > 0) {
    const xml = buildAddVariationsXml(itemId, extendSpecificsSet(declaredSet, additions), additions)
    const res = await callTradingApi('ReviseFixedPriceItem', xml, {
      oauthToken: ctx.oauthToken,
      siteId: siteIdForMarket(market),
    })
    ebayAck = res.ack

    // Link the new variations to the pool + memberships (fan-out live).
    const products = await prisma.product.findMany({
      where: { sku: { in: additions.map((a) => a.sku) }, deletedAt: null },
      select: { id: true, sku: true, parentId: true },
    })
    const productIdBySku = new Map(products.map((p) => [p.sku, p.id]))
    const existing = await prisma.sharedListingMembership.findFirst({
      where: { marketplace: market, itemId },
      select: { parentSku: true },
    })
    // Audit S6 — first-touch fallback resolves the POOL family's real parent
    // SKU (numeric itemId broke grid family-grouping).
    let parentSku = existing?.parentSku ?? ''
    if (!parentSku) {
      const withParent = products.find((p) => p.parentId)
      if (withParent?.parentId) {
        const poolParent = await prisma.product.findFirst({ where: { id: withParent.parentId }, select: { sku: true } })
        if (poolParent?.sku) parentSku = poolParent.sku
      }
    }
    if (!parentSku) parentSku = itemId
    for (const a of additions) {
      await prisma.sharedListingMembership.upsert({
        where: { marketplace_itemId_sku: { marketplace: market, itemId, sku: a.sku } },
        update: {
          productId: productIdBySku.get(a.sku) ?? null,
          variationSpecifics: a.specifics,
          price: new Prisma.Decimal(a.price),
          status: 'ACTIVE',
          lastQtyPushed: a.quantity,
          lastPushedAt: new Date(),
        },
        create: {
          marketplace: market, itemId, sku: a.sku, parentSku,
          productId: productIdBySku.get(a.sku) ?? null,
          variationSpecifics: a.specifics,
          price: new Prisma.Decimal(a.price),
          status: 'ACTIVE',
          lastQtyPushed: a.quantity,
          lastPushedAt: new Date(),
        },
      })
      membershipsCreated++
    }
  }

  // Self-heal (audit S5): live variations missing a membership get one from
  // LIVE truth (specifics/price from GetItem — the identity eBay actually has).
  if (healCandidates.length > 0) {
    const healProducts = await prisma.product.findMany({
      where: { sku: { in: healCandidates.map((h) => h.sku) }, deletedAt: null },
      select: { id: true, sku: true, parentId: true },
    })
    const healIdBySku = new Map(healProducts.map((p) => [p.sku, p.id]))
    const anyMembership = await prisma.sharedListingMembership.findFirst({
      where: { marketplace: market, itemId },
      select: { parentSku: true },
    })
    let healParent = anyMembership?.parentSku ?? ''
    if (!healParent) {
      const wp = healProducts.find((p) => p.parentId)
      if (wp?.parentId) {
        const pp = await prisma.product.findFirst({ where: { id: wp.parentId }, select: { sku: true } })
        if (pp?.sku) healParent = pp.sku
      }
    }
    if (!healParent) healParent = itemId
    for (const h of healCandidates) {
      const exists = await prisma.sharedListingMembership.findFirst({
        where: { marketplace: market, itemId, sku: h.sku },
        select: { id: true },
      })
      if (exists) continue
      await prisma.sharedListingMembership.create({
        data: {
          marketplace: market, itemId, sku: h.sku, parentSku: healParent,
          productId: healIdBySku.get(h.sku) ?? null,
          variationSpecifics: h.live.specifics,
          status: 'ACTIVE',
        },
      })
      membershipsCreated++
    }
  }

  return { itemId, marketplace: market, added: additions.length, skippedExisting, ebayAck, membershipsCreated }
}
