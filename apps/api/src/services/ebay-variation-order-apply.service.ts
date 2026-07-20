/**
 * Variation ORDER on live eBay listings — without a full publish.
 *
 * The Variation-order modal saves the operator's axis sequence
 * (_variationAxes) and per-axis value order (_axisValueOrder) on the parent
 * ChannelListing; until now the ONLY consumer was the full push. eBay's
 * documented mechanism for the buyer-facing dropdown order is the sequence of
 * NameValueList/Value nodes in VariationSpecificsSet — and that set can be
 * revised on its own via ReviseFixedPriceItem, exactly like the relabel
 * (SKU-only) and add-variations (set+new-variations) revises this codebase
 * already runs live.
 *
 * Safety geometry (why this cannot damage a listing):
 *  - The plan is a PERMUTATION of the live set: same axis names, same values,
 *    only the sequence changes. Nothing is added, nothing is removed, so the
 *    delete-restrictions around sold variations can never trigger.
 *  - Values are emitted as the EXACT live strings (the order authority trims
 *    for comparison; emission maps back to the originals). If a live axis
 *    carries trim/case-colliding values the axis keeps its live order.
 *  - One ReviseFixedPriceItem per listing, atomic on eBay's side; a rejection
 *    surfaces as a typed per-listing error with zero mutation anywhere.
 *  - ZERO database writes in this whole flow — the flat file, snapshots and
 *    memberships are untouched by construction.
 *  - Ordering matches the push byte-for-byte: the same orderAxisValues
 *    authority with the same _axisValueOrder ?? _axisSortOrder lookup
 *    (incident #39), so "apply now" and "next full push" agree.
 *
 * Inventory-API-managed listings (a real family's primary) reject Trading
 * revises — those come back typed as 'inventory-managed' (the ordering rides
 * that listing's next normal publish, same split EB-IMG established).
 */

import prisma from '../db.js'
import { callTradingApi, siteIdForMarket, escapeXml } from './ebay-trading-api.service.js'
import { parseVariationSpecificsSet } from './ebay-variation-add.service.js'
import { orderAxisValues } from './ebay-value-order.js'
import { axisSynonymKey } from './ebay-theme-axes.js'

// ── Pure planner ──────────────────────────────────────────────────────────

export interface SpecificsSetReorderPlan {
  /** NameValueList emission order (axis sequence). */
  names: string[]
  /** name → values in the new order — always the original live strings. */
  set: Record<string, string[]>
  changed: boolean
  axisOrder: { from: string[]; to: string[] }
  valueChanges: Array<{ axis: string; from: string[]; to: string[] }>
}

/**
 * Reorder a live listing's declared VariationSpecificsSet by the operator's
 * stored config. Guarantees the result is a permutation of the input.
 */
export function planSpecificsSetReorder(
  declared: Record<string, string[]>,
  storedAxisSeq: string[] | undefined,
  valueOrderByAxis: Record<string, string[]> | undefined,
): SpecificsSetReorderPlan {
  const liveNames = Object.keys(declared)

  // Axis sequence — stored axes (synonym-matched) first in stored order,
  // live-only axes keep their live relative order after them.
  let names = liveNames
  if (storedAxisSeq?.length) {
    const rank = new Map(storedAxisSeq.map((n, i) => [axisSynonymKey(n), i] as const))
    const liveRank = new Map(liveNames.map((n, i) => [n, i] as const))
    names = [...liveNames].sort((a, b) => {
      const ra = rank.get(axisSynonymKey(a))
      const rb = rank.get(axisSynonymKey(b))
      if (ra != null && rb != null) return ra - rb
      if (ra != null) return -1
      if (rb != null) return 1
      return (liveRank.get(a) ?? 0) - (liveRank.get(b) ?? 0)
    })
  }

  const set: Record<string, string[]> = {}
  const valueChanges: SpecificsSetReorderPlan['valueChanges'] = []
  for (const name of names) {
    const live = declared[name] ?? []
    // Map the authority's trimmed identity back to the exact live strings.
    const byKey = new Map<string, string>()
    let collision = false
    for (const v of live) {
      const k = v.trim().toLowerCase()
      if (byKey.has(k)) collision = true
      byKey.set(k, v)
    }
    let next = live
    if (!collision && live.length > 1) {
      const ordered = orderAxisValues(name, live, valueOrderByAxis?.[axisSynonymKey(name)])
        .map((t) => byKey.get(t.trim().toLowerCase()))
        .filter((v): v is string => v != null)
      // Permutation guard — anything short of an exact reshuffle keeps live order.
      if (ordered.length === live.length && new Set(ordered).size === live.length) next = ordered
    }
    set[name] = next
    if (next.join('') !== live.join('')) valueChanges.push({ axis: name, from: live, to: next })
  }

  const axisChanged = names.join('') !== liveNames.join('')
  return {
    names,
    set,
    changed: axisChanged || valueChanges.length > 0,
    axisOrder: { from: liveNames, to: names },
    valueChanges,
  }
}

/** ReviseFixedPriceItem XML carrying ONLY the reordered VariationSpecificsSet. */
export function buildReorderXml(itemId: string, plan: SpecificsSetReorderPlan): string {
  const setXml = plan.names
    .map((name) =>
      `<NameValueList><Name>${escapeXml(name)}</Name>${(plan.set[name] ?? [])
        .map((v) => `<Value>${escapeXml(v)}</Value>`)
        .join('')}</NameValueList>`)
    .join('')
  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <ItemID>${escapeXml(itemId)}</ItemID>
    <Variations><VariationSpecificsSet>${setXml}</VariationSpecificsSet></Variations>
  </Item>
</ReviseFixedPriceItemRequest>`
}

// ── Per-listing apply ─────────────────────────────────────────────────────

export interface ApplyOrderListingResult {
  itemId: string
  title?: string
  status: 'applied' | 'unchanged' | 'dry-run' | 'not-active' | 'no-variations' | 'inventory-managed' | 'error'
  /** applied only: read-back GetItem confirmed the live order matches the plan. */
  verified?: boolean
  axisOrder?: { from: string[]; to: string[] }
  valueChanges?: Array<{ axis: string; from: string[]; to: string[] }>
  message?: string
}

const INVENTORY_MANAGED_RE = /inventor|magazzino/i

export async function applyVariationOrderToListing(
  itemId: string,
  marketplace: string,
  storedAxisSeq: string[] | undefined,
  valueOrderByAxis: Record<string, string[]> | undefined,
  ctx: { oauthToken: string },
  opts?: { dryRun?: boolean },
): Promise<ApplyOrderListingResult> {
  const market = marketplace.toUpperCase()
  const siteId = siteIdForMarket(market)
  const getXml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${escapeXml(itemId)}</ItemID>
</GetItemRequest>`

  let raw: string
  let title: string | undefined
  try {
    const got = await callTradingApi('GetItem', getXml, { oauthToken: ctx.oauthToken, siteId })
    raw = got.raw
    title = /<Title>([^<]*)<\/Title>/.exec(raw)?.[1] || undefined
  } catch (err: unknown) {
    return { itemId, status: 'error', message: `GetItem failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (!raw.trim()) {
    return { itemId, status: 'error', message: 'empty GetItem response (NEXUS_EBAY_REAL_API gate off?)' }
  }

  const listingStatus = /<ListingStatus>([^<]*)<\/ListingStatus>/.exec(raw)?.[1] ?? ''
  if (listingStatus && listingStatus !== 'Active') {
    return { itemId, title, status: 'not-active', message: `listing is ${listingStatus}` }
  }

  const declared = parseVariationSpecificsSet(raw)
  if (Object.keys(declared).length === 0) {
    return { itemId, title, status: 'no-variations', message: 'no VariationSpecificsSet on this listing' }
  }

  const plan = planSpecificsSetReorder(declared, storedAxisSeq, valueOrderByAxis)
  const diff = { axisOrder: plan.axisOrder, valueChanges: plan.valueChanges }
  if (!plan.changed) return { itemId, title, status: 'unchanged' }
  if (opts?.dryRun) return { itemId, title, status: 'dry-run', ...diff }

  try {
    await callTradingApi('ReviseFixedPriceItem', buildReorderXml(itemId, plan), {
      oauthToken: ctx.oauthToken,
      siteId,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (INVENTORY_MANAGED_RE.test(message)) {
      return { itemId, title, status: 'inventory-managed', message: 'managed by the Inventory API — the order applies on that listing’s next publish' }
    }
    return { itemId, title, status: 'error', ...diff, message }
  }

  // Read-back verify (FFT invariant style): the live set now IS the plan.
  let verified = false
  try {
    const again = await callTradingApi('GetItem', getXml, { oauthToken: ctx.oauthToken, siteId })
    const liveNow = parseVariationSpecificsSet(again.raw)
    verified =
      JSON.stringify(Object.keys(liveNow)) === JSON.stringify(plan.names) &&
      plan.names.every((n) => JSON.stringify(liveNow[n] ?? []) === JSON.stringify(plan.set[n] ?? []))
  } catch {
    /* verification is best-effort — the revise itself was acked */
  }
  return { itemId, title, status: 'applied', verified, ...diff }
}

// ── Family orchestrator ───────────────────────────────────────────────────

export interface ApplyOrderFamilyResult {
  marketplace: string
  storedAxes: string[]
  hasStoredValueOrder: boolean
  listings: ApplyOrderListingResult[]
}

/**
 * Apply the saved variation order to every live listing carrying this family:
 * Lane A (ChannelListing.externalListingId) ∪ Lane B (SharedListingMembership
 * by productId OR sku — the FFT-I2 double-keyed join). READ-ONLY on our DB.
 */
export async function applyVariationOrderForFamily(
  parentProductId: string,
  marketplace: string,
  ctx: { oauthToken: string },
  opts?: { dryRun?: boolean },
): Promise<ApplyOrderFamilyResult> {
  const market = marketplace.toUpperCase()
  const parent = await prisma.product.findUnique({
    where: { id: parentProductId },
    select: { id: true, sku: true },
  })
  if (!parent) throw new Error('parent product not found')
  const children = await prisma.product.findMany({
    where: { parentId: parentProductId, deletedAt: null },
    select: { id: true, sku: true },
  })
  const ids = [parent.id, ...children.map((c) => c.id)]
  const skus = [parent.sku, ...children.map((c) => c.sku)].filter(Boolean) as string[]

  // Stored order — the SAME lookup the push runs (incident #39).
  const parentCl = await prisma.channelListing.findFirst({
    where: { productId: parent.id, channel: 'EBAY', marketplace: market },
    select: { platformAttributes: true },
  })
  const pa = (parentCl?.platformAttributes ?? {}) as Record<string, unknown>
  const storedAxisSeq = Array.isArray(pa._variationAxes) ? (pa._variationAxes as string[]) : undefined
  const storedValueOrder = (pa._axisValueOrder ?? pa._axisSortOrder) as Record<string, string[]> | undefined
  const valueOrderByAxis =
    storedValueOrder && typeof storedValueOrder === 'object' ? storedValueOrder : undefined

  const memberships = await prisma.sharedListingMembership.findMany({
    where: { marketplace: market, OR: [{ productId: { in: ids } }, { sku: { in: skus } }] },
    select: { itemId: true },
  })
  const laneA = await prisma.channelListing.findMany({
    where: { productId: { in: ids }, channel: 'EBAY', marketplace: market, externalListingId: { not: null } },
    select: { externalListingId: true },
  })
  const itemIds = [
    ...new Set(
      [...memberships.map((m) => m.itemId), ...laneA.map((l) => l.externalListingId)]
        .map((id) => String(id ?? '').trim())
        .filter((id) => /^\d+$/.test(id)),
    ),
  ]

  const listings: ApplyOrderListingResult[] = []
  for (const itemId of itemIds) {
    listings.push(
      await applyVariationOrderToListing(itemId, market, storedAxisSeq, valueOrderByAxis, ctx, opts),
    )
  }
  return {
    marketplace: market,
    storedAxes: storedAxisSeq ?? [],
    hasStoredValueOrder: !!valueOrderByAxis && Object.keys(valueOrderByAxis).length > 0,
    listings,
  }
}
