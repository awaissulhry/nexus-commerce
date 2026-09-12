import { mappingToken, MappingConflict } from './pim/mapping/revision-token.js'
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

/** Decode one XML layer before re-escaping a permutation; &amp; must never become &amp;amp;. */
export function parseOrderSpecifics(raw: string): Record<string, string[]> {
  const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? whole
    const point = parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10)
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole
  })
  return Object.fromEntries(Object.entries(parseVariationSpecificsSet(raw)).map(([key, values]) => [decode(key), values.map(decode)]))
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
  liveToken?: string
}

const INVENTORY_MANAGED_RE = /inventor|magazzino/i

export async function applyVariationOrderToListing(
  itemId: string,
  marketplace: string,
  storedAxisSeq: string[] | undefined,
  valueOrderByAxis: Record<string, string[]> | undefined,
  ctx: { oauthToken: string },
  opts?: { dryRun?: boolean; expectedLiveToken?: string; beforeWrite?: () => Promise<void> },
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

  const declared = parseOrderSpecifics(raw)
  const liveToken = mappingToken({ declared, listingStatus })
  if (Object.keys(declared).length === 0) {
    return { itemId, title, status: 'no-variations', message: 'no VariationSpecificsSet on this listing' }
  }

  const plan = planSpecificsSetReorder(declared, storedAxisSeq, valueOrderByAxis)
  const diff = { axisOrder: plan.axisOrder, valueChanges: plan.valueChanges }
  if (!plan.changed) return { itemId, title, status: 'unchanged', liveToken }
  if (opts?.dryRun) return { itemId, title, status: 'dry-run', liveToken, ...diff }
  if (opts?.expectedLiveToken && opts.expectedLiveToken !== liveToken) return { itemId, title, status: 'error', message: 'Live variation order changed after review. Review this destination again.' }

  try {
    if (!opts?.beforeWrite || !opts.expectedLiveToken) throw new MappingConflict('Create a destination-bound order publication review first')
    await opts.beforeWrite()
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
    const liveNow = parseOrderSpecifics(again.raw)
    verified =
      JSON.stringify(Object.keys(liveNow)) === JSON.stringify(plan.names) &&
      plan.names.every((n) => JSON.stringify(liveNow[n] ?? []) === JSON.stringify(plan.set[n] ?? []))
  } catch {
    /* verification is best-effort — the revise itself was acked */
  }
  if (!verified) return { itemId, title, status: 'error', verified: false, message: 'eBay accepted the order revision, but read-back did not confirm it. Retry this review to check it again', ...diff }
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
  throw new MappingConflict('Family-wide order revision cannot select an account or alternate listing safely. Use /api/ebay/presentation-publications/review with explicit destinations, then execute that review')
}
