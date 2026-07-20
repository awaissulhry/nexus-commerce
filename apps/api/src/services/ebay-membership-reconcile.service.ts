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
import { axisSynonymKey, axisValueSynonymKey } from './ebay-theme-axes.js'

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

/** Parse GetItem XML → live variations with SKU + specifics.
 *  Incident #42 — SKU-LESS variations are KEPT (sku: '') so reconcile can
 *  COUNT them and the adoption flow can write pool SKUs onto them; dropping
 *  them here made a fully SKU-less listing look like it had no variations
 *  at all. Consumers key by real SKUs, so '' rows are inert to them. */
export function parseLiveVariations(raw: string): LiveVariation[] {
  const out: LiveVariation[] = []
  for (const vm of raw.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)) {
    const block = vm[1]
    const sku = /<SKU>([^<]*)<\/SKU>/.exec(block)?.[1] ?? ''
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

/**
 * Subset match: a live variation carries ONLY its variation AXES
 * ({Colore, Taglia}), while pool specifics may carry EVERY listed aspect
 * (Brand, Marca, Stagione…). The pool entry matches when every live
 * axis name+value appears in it (normalized). Ambiguity (two distinct
 * products both containing the live axes) is surfaced as unmatched —
 * a wrong pool link would silently cross-sync stock.
 *
 * Incident #42 — names AND values normalize through the synonym tables
 * (axisSynonymKey / axisValueSynonymKey): pre-Nexus adopted listings
 * declare English axes (Color: Black) while the pool speaks Italian
 * (Colore: Nero). Both sides fold to the same deterministic keys; the
 * ambiguity guard is unchanged.
 */
export function findPoolMatch(
  liveSpecifics: Record<string, string>,
  pool: PoolEntry[],
): PoolEntry | null {
  const nk = (k: string) => axisSynonymKey(k)
  const nv = (v: string) => axisValueSynonymKey(v)
  const wanted = Object.entries(liveSpecifics).map(([k, v]) => [nk(k), nv(String(v))] as const)
  if (wanted.length === 0) return null
  const hits: PoolEntry[] = []
  for (const p of pool) {
    const have = new Map(Object.entries(p.specifics).map(([k, v]) => [nk(k), nv(String(v))] as const))
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
  /** FFT-I2 — exact-SKU pool link fallback: live SKU → pool product id.
   *  Since the relabel, live variation SKUs ARE the pool child SKUs, so the
   *  SKU is a deterministic join. Specifics-matching alone cascaded link
   *  loss: it matched only against ALREADY-LINKED memberships, so one null
   *  pass made every later pass null too (196 links lost estate-wide,
   *  repaired 2026-07-20 — the family file collapsed to one group). */
  skuToProductId?: ReadonlyMap<string, string>,
): { entries: ReconcilePlanEntry[]; matched: number; unmatched: string[] } {
  const entries: ReconcilePlanEntry[] = []
  const unmatched: string[] = []
  for (const v of live) {
    const hit = findPoolMatch(v.specifics, pool)
    const skuLink = !hit && v.sku ? skuToProductId?.get(v.sku) ?? null : null
    entries.push({
      liveSku: v.sku,
      productId: hit?.productId ?? skuLink,
      specifics: v.specifics,
      price: hit?.price ?? null,
      matched: Boolean(hit) || Boolean(skuLink),
    })
    if (!hit && !skuLink) unmatched.push(v.sku)
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
  /** Incident #42 — live variations that carry NO SKU at all. A membership
   *  keyed by '' is unusable (and @@unique collapses all of them into one
   *  row), so they are never written; the count is surfaced so the caller
   *  can run the SKU-less adoption (write pool SKUs to eBay, then
   *  re-reconcile). */
  skuless: number
  /** Incident #33 — listing-level custom label (Item.SKU = parent SKU):
   *  'set' = backfilled by this reconcile; 'kept' = already correct;
   *  'unsupported' = the listing rejects Trading revises (Inventory-managed);
   *  'failed' = revise errored (non-fatal). */
  customLabel?: 'set' | 'kept' | 'unsupported' | 'failed'
}

/**
 * Reconcile ONE listing's memberships against live eBay truth.
 * Reads eBay (GetItem); writes ONLY our DB. The pool is never touched.
 */
export async function reconcileMembershipsFromEbay(
  itemId: string,
  marketplace: string,
  ctx: { oauthToken: string },
  /** Incident #42 — the listing's OWN parent SKU when the caller knows it
   *  (a CL-linked shell). Without it, first-touch resolution walks pool
   *  children to the POOL family parent — right for adopted primary
   *  listings, wrong for ALT shells (their parent SKU is the shell). */
  preferredParentSku?: string,
): Promise<ReconcileResult> {
  const market = marketplace.toUpperCase()
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <OutputSelector>Item.SKU</OutputSelector>
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

  // FFT-I2 — exact-SKU pool links: since the relabel, live variation SKUs ARE
  // the pool child SKUs — the deterministic fallback when specifics-matching
  // misses (which previously wrote productId:null and cascaded link loss).
  const poolLinkSkus = [...new Set(live.map((v) => v.sku).filter(Boolean))]
  const skuProducts = poolLinkSkus.length
    ? await prisma.product.findMany({ where: { sku: { in: poolLinkSkus }, deletedAt: null }, select: { id: true, sku: true } })
    : []
  const skuToProductId = new Map(skuProducts.map((p) => [p.sku, p.id]))

  let plan = planMembershipReconcile(live, pool, skuToProductId)
  // Incident #42b — FAMILY LOCK: a single-axis listing ({Colore: Verde})
  // subset-matched against the WHOLE market's memberships collides with any
  // other family carrying the same colour → the ambiguity guard refuses.
  // When at least one variation matched unambiguously, the family is known:
  // restrict the pool to that family's children and re-match the remainder.
  // Within-family ambiguity is still refused — never guessed.
  if (plan.unmatched.length > 0 && plan.matched > 0) {
    const matchedIds = [...new Set(plan.entries.filter((e) => e.productId).map((e) => e.productId as string))]
    const matchedProducts = await prisma.product.findMany({
      where: { id: { in: matchedIds } },
      select: { parentId: true },
    })
    const parentIds = [...new Set(matchedProducts.map((p) => p.parentId).filter((x): x is string => Boolean(x)))]
    if (parentIds.length === 1) {
      const familyChildren = await prisma.product.findMany({
        where: { parentId: parentIds[0], deletedAt: null },
        select: { id: true },
      })
      const familyIds = new Set(familyChildren.map((c) => c.id))
      const lockedPool = pool.filter((p) => familyIds.has(p.productId))
      if (lockedPool.length > 0) plan = planMembershipReconcile(live, lockedPool, skuToProductId)
    }
  }

  // parentSku continuity: keep whatever this listing's memberships used.
  // First-touch listings (no memberships yet) resolve the POOL family's real
  // parent SKU — a numeric itemId fallback broke family grouping in the grid
  // (audit S6): loadSharedMembershipRows matches by real parent SKUs.
  let parentSku = existing[0]?.parentSku ?? ''
  if (!parentSku && preferredParentSku && !/^\d+$/.test(preferredParentSku)) parentSku = preferredParentSku
  if (!parentSku) {
    const firstPoolId = plan.entries.find((e) => e.productId)?.productId
    if (firstPoolId) {
      const poolChild = await prisma.product.findFirst({
        where: { id: firstPoolId },
        select: { parentId: true },
      })
      if (poolChild?.parentId) {
        const poolParent = await prisma.product.findFirst({
          where: { id: poolChild.parentId },
          select: { sku: true },
        })
        if (poolParent?.sku) parentSku = poolParent.sku
      }
    }
  }
  if (!parentSku) parentSku = itemId

  let rewritten = 0
  let skuless = 0
  for (const e of plan.entries) {
    // Incident #42 — a SKU-less live variation can't become a membership
    // (empty key; @@unique collapses them). Count + skip; the composed
    // reconcile flow writes pool SKUs to eBay first, then re-reconciles.
    if (!String(e.liveSku ?? '').trim()) {
      skuless++
      continue
    }
    await prisma.sharedListingMembership.upsert({
      where: { marketplace_itemId_sku: { marketplace: market, itemId, sku: e.liveSku } },
      update: {
        // Incident #42b — an UNMATCHED re-run must never destroy an existing
        // pool link: a colour that collides across families (ambiguity refusal)
        // yields productId null, and writing that null would sever a
        // previously-established, working linkage. Null never overwrites.
        ...(e.productId ? { productId: e.productId } : {}),
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

  // Incident #33 — BACKFILL the listing-level custom label (Item.SKU) with
  // the parent SKU on listings created before the #30 fix. Metadata-only
  // revise; Inventory-managed listings reject Trading revises → 'unsupported'.
  let customLabel: ReconcileResult['customLabel']
  try {
    const liveItemSku = /<Item>[\s\S]*?<SKU>([^<]*)<\/SKU>/.exec(res.raw)?.[1] ?? ''
    const isRealParent = Boolean(parentSku) && parentSku !== itemId
    if (!isRealParent) {
      customLabel = undefined
    } else if (liveItemSku === parentSku) {
      customLabel = 'kept'
    } else {
      const reviseXml = `<?xml version="1.0" encoding="utf-8"?>\n<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><Item><ItemID>${itemId}</ItemID><SKU>${parentSku}</SKU></Item></ReviseFixedPriceItemRequest>`
      await callTradingApi('ReviseFixedPriceItem', reviseXml, { oauthToken: ctx.oauthToken, siteId: siteIdForMarket(market) })
      customLabel = 'set'
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    customLabel = /magazzino|inventory/i.test(msg) ? 'unsupported' : 'failed'
  }

  return {
    itemId,
    marketplace: market,
    liveVariations: live.length,
    matched: plan.matched,
    rewritten,
    removedStale: stale.length,
    unmatched: plan.unmatched,
    skuless,
    ...(customLabel ? { customLabel } : {}),
  }
}
