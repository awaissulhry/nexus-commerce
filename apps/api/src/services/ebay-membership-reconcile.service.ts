/**
 * Membership reconcile — adopt a live eBay listing AS IT IS (GALE root cause,
 * 2026-07-17).
 *
 * The import assumed every listing shares the same child SKUs, but real
 * listings often carry their OWN custom labels (observed live: the primary
 * matches, one listing uses `IT-`-prefixed SKUs, three use short codes like
 * `T1_Ne_S`). Memberships keyed to the file's SKUs can never sync those
 * listings — every ReviseInventoryStatus targets a variation that does not
 * exist, fails, trips the publish circuit, and the listing forever shows its
 * previous state ("reverts again and again").
 *
 * This service reads the listing's REAL variations (GetItem — read-only),
 * maps each one to our pool product by its VARIATION SPECIFICS (Taglia /
 * Colore…), and rewrites the memberships to the listing's real SKUs. The
 * pool then drives the listing through the labels eBay actually has.
 *
 * Matching is by normalized specifics, never by parsing label conventions.
 */

import prisma from '../db.js'
import { Prisma } from '@prisma/client'
import { callTradingApi, siteIdForMarket } from './ebay-trading-api.service.js'

export interface LiveVariation {
  sku: string
  quantity: number | null
  specifics: Record<string, string>
}

/** `Taglia=M|Colore=Nero` — order-insensitive, trimmed, case-folded. */
export function specificsKey(specifics: Record<string, string>): string {
  return Object.entries(specifics)
    .map(([k, v]) => `${k.trim().toLowerCase()}=${String(v).trim().toLowerCase()}`)
    .sort()
    .join('|')
}

/** Parse GetItem XML → live variations with SKU + specifics. */
export function parseLiveVariations(raw: string): LiveVariation[] {
  const out: LiveVariation[] = []
  for (const vm of raw.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)) {
    const block = vm[1]
    const sku = /<SKU>([^<]*)<\/SKU>/.exec(block)?.[1] ?? ''
    if (!sku) continue
    const qty = /<Quantity>(\d+)<\/Quantity>/.exec(block)?.[1]
    const specifics: Record<string, string> = {}
    const specsBlock = /<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/.exec(block)?.[1] ?? ''
    for (const nv of specsBlock.matchAll(/<NameValueList>[\s\S]*?<Name>([^<]*)<\/Name>[\s\S]*?<Value>([^<]*)<\/Value>[\s\S]*?<\/NameValueList>/g)) {
      specifics[nv[1]] = nv[2]
    }
    out.push({ sku, quantity: qty != null ? Number(qty) : null, specifics })
  }
  return out
}

export interface ReconcilePlanEntry {
  liveSku: string
  productId: string | null
  specifics: Record<string, string>
  price: number | null
  matched: boolean
}

export interface PoolEntry {
  productId: string
  price: number | null
  specifics: Record<string, string>
}

const norm = (s: string) => s.trim().toLowerCase()

/**
 * Subset match: a live variation carries ONLY its variation AXES
 * ({Colore, Taglia}), while pool specifics may carry EVERY listed aspect
 * (Brand, Marca, Stagione…). The pool entry matches when every live
 * axis name+value appears in it (normalized). Ambiguity (two distinct
 * products both containing the live axes) is surfaced as unmatched —
 * a wrong pool link would silently cross-sync stock.
 */
export function findPoolMatch(
  liveSpecifics: Record<string, string>,
  pool: PoolEntry[],
): PoolEntry | null {
  const wanted = Object.entries(liveSpecifics).map(([k, v]) => [norm(k), norm(String(v))] as const)
  if (wanted.length === 0) return null
  const hits: PoolEntry[] = []
  for (const p of pool) {
    const have = new Map(Object.entries(p.specifics).map(([k, v]) => [norm(k), norm(String(v))] as const))
    if (wanted.every(([k, v]) => have.get(k) === v)) hits.push(p)
  }
  const distinctProducts = new Set(hits.map((h) => h.productId))
  if (distinctProducts.size !== 1) return null // no match, or ambiguous
  return hits[0]
}

/**
 * Pure planner: live variations × pool entries → the memberships this
 * listing SHOULD have. Unmatched variations still become memberships
 * (sku recorded, productId null) so the operator SEES them.
 */
export function planMembershipReconcile(
  live: LiveVariation[],
  pool: PoolEntry[],
): { entries: ReconcilePlanEntry[]; matched: number; unmatched: string[] } {
  const entries: ReconcilePlanEntry[] = []
  const unmatched: string[] = []
  for (const v of live) {
    const hit = findPoolMatch(v.specifics, pool)
    entries.push({
      liveSku: v.sku,
      productId: hit?.productId ?? null,
      specifics: v.specifics,
      price: hit?.price ?? null,
      matched: Boolean(hit),
    })
    if (!hit) unmatched.push(v.sku)
  }
  return { entries, matched: entries.length - unmatched.length, unmatched }
}

export interface ReconcileResult {
  itemId: string
  marketplace: string
  liveVariations: number
  matched: number
  rewritten: number
  removedStale: number
  unmatched: string[]
}

/**
 * Reconcile ONE listing's memberships against live eBay truth.
 * Reads eBay (GetItem); writes ONLY our DB. The pool is never touched.
 */
export async function reconcileMembershipsFromEbay(
  itemId: string,
  marketplace: string,
  ctx: { oauthToken: string },
): Promise<ReconcileResult> {
  const market = marketplace.toUpperCase()
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <OutputSelector>Item.Variations.Variation.SKU</OutputSelector>
  <OutputSelector>Item.Variations.Variation.Quantity</OutputSelector>
  <OutputSelector>Item.Variations.Variation.VariationSpecifics</OutputSelector>
</GetItemRequest>`
  const res = await callTradingApi('GetItem', xml, { oauthToken: ctx.oauthToken, siteId: siteIdForMarket(market) })
  const live = parseLiveVariations(res.raw)

  const existing = await prisma.sharedListingMembership.findMany({
    where: { marketplace: market, itemId },
  })
  // Pool truth: every membership in this market with a productId (the primary
  // listing's rows supply the full aspect-rich set). Entries for THIS itemId
  // come first so a per-listing price survives the SKU rewrite when the same
  // product matches through both.
  const allLinked = await prisma.sharedListingMembership.findMany({
    where: { marketplace: market, productId: { not: null } },
    select: { productId: true, variationSpecifics: true, price: true, itemId: true },
    orderBy: { updatedAt: 'desc' },
  })
  const pool: PoolEntry[] = allLinked
    .sort((a, b) => Number(b.itemId === itemId) - Number(a.itemId === itemId))
    .map((m) => ({
      productId: m.productId as string,
      price: m.price != null ? Number(m.price) : null,
      specifics: (m.variationSpecifics as Record<string, string>) ?? {},
    }))

  const plan = planMembershipReconcile(live, pool)

  // parentSku continuity: keep whatever this listing's memberships used.
  const parentSku = existing[0]?.parentSku ?? itemId

  let rewritten = 0
  for (const e of plan.entries) {
    await prisma.sharedListingMembership.upsert({
      where: { marketplace_itemId_sku: { marketplace: market, itemId, sku: e.liveSku } },
      update: {
        productId: e.productId,
        variationSpecifics: e.specifics,
        ...(e.price != null ? { price: new Prisma.Decimal(e.price) } : {}),
        parentSku,
        status: 'ACTIVE',
      },
      create: {
        marketplace: market, itemId, sku: e.liveSku,
        productId: e.productId,
        variationSpecifics: e.specifics,
        ...(e.price != null ? { price: new Prisma.Decimal(e.price) } : {}),
        parentSku,
        status: 'ACTIVE',
      },
    })
    rewritten++
  }

  // Remove stale memberships whose SKU is NOT live on this listing (the
  // file-SKU rows that could never sync).
  const liveSkus = new Set(live.map((v) => v.sku))
  const stale = existing.filter((m) => !liveSkus.has(m.sku))
  if (stale.length > 0) {
    await prisma.sharedListingMembership.deleteMany({
      where: { marketplace: market, itemId, sku: { in: stale.map((m) => m.sku) } },
    })
  }

  return {
    itemId,
    marketplace: market,
    liveVariations: live.length,
    matched: plan.matched,
    rewritten,
    removedStale: stale.length,
    unmatched: plan.unmatched,
  }
}
