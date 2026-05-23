/**
 * DA-RT.1 — Central revenue-computation helper.
 *
 * Single source of truth for "what is this order worth?". Before
 * today 31 callsites (insights, dashboard, fiscal, customers,
 * analytics, replenishment, financial events) each re-implemented
 * the same `SUM(totalPrice)` / `SUM(price * qty)` / estimate-fallback
 * pattern with subtle drift. The GS-RT engagement found that several
 * of them returned 0 for orders Amazon withholds OrderTotal on, while
 * others applied partial estimates and a third group used different
 * status semantics. Result: the same operator could see three
 * different revenue numbers on three different pages.
 *
 * This helper closes the gap by exposing one canonical waterfall:
 *
 *   Tier 1 (PRIMARY)   Order.totalPrice                if > 0
 *   Tier 2 (FALLBACK)  SUM(OrderItem.price * quantity) if all items have price > 0
 *   Tier 3 (ESTIMATE)  ChannelListing.price            (per productId + marketplace)
 *                      → Product.basePrice             (fallback within tier 3)
 *   Tier 4 (NONE)      0                               + awaitingPrice flag
 *
 * Returns the computed cents, the source of the number, and two
 * trust flags (`estimated`, `awaitingPrice`) so callers can render
 * the same `*` annotation the snapshot widget uses + decide whether
 * to count the row toward "needs operator review".
 *
 * Scope of THIS commit (DA-RT.1)
 * ------------------------------
 * Helper + types + buildPriceLookup batch fetcher + unit tests only.
 * Migrating the 31 callsites to use this helper lands in DA-RT.2+
 * one surface at a time so each migration is reviewable + revertible.
 */

import prisma from '../../db.js'

// ── Types ────────────────────────────────────────────────────────────

/** Where the revenue number came from — used for `*` annotations + telemetry. */
export type RevenueSource =
  | 'order_total'       // Order.totalPrice (canonical)
  | 'item_sum'          // SUM(OrderItem.price * quantity) — items have real prices
  | 'channel_listing'   // ChannelListing.price × quantity (estimate)
  | 'base_price'        // Product.basePrice × quantity (estimate, weaker)
  | 'mixed_estimate'    // some items from channel_listing, some from base_price
  | 'none'              // no path produced a positive amount

/**
 * Shape of the inputs the helper needs. Designed to accept a Prisma
 * findMany result loosely typed — caller doesn't need to wrap.
 */
export interface OrderForRevenue {
  /** Order.totalPrice. Prisma Decimal serialises as string in JS; we
   *  accept number/string/null transparently. */
  totalPrice: number | string | null | undefined
  /** ISO currency code; defaults to 'EUR' for IT/DE/FR/ES markets. */
  currencyCode?: string | null
  /** Amazon marketplace code ('IT', 'DE', etc.) — keys the ChannelListing lookup. */
  marketplace?: string | null
  /** Order line items (must be included by the caller's findMany select). */
  items?: Array<{
    productId?: string | null
    quantity: number
    price?: number | string | null
  }>
}

export interface PriceLookup {
  /** `${productId}|${marketplace}` → unit price (in original currency, NOT cents). */
  byChannelListing: Map<string, number>
  /** `productId` → Product.basePrice (in original currency). */
  byProduct: Map<string, number>
}

export interface RevenueComputation {
  /** Final cents amount the caller should use for display + aggregation. */
  cents: number
  /** Which waterfall tier produced the number. */
  source: RevenueSource
  /** True when the number is not Order.totalPrice (downstream tiers). */
  estimated: boolean
  /** True when we couldn't get any positive amount — operator may need to
   *  manually override or wait for Amazon to release OrderTotal. */
  awaitingPrice: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────

function toNumber(v: number | string | null | undefined): number {
  if (v == null) return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const ZERO: RevenueComputation = {
  cents: 0,
  source: 'none',
  estimated: false,
  awaitingPrice: true,
}

// ── Single-order computation ─────────────────────────────────────────

/**
 * Compute revenue for a single order through the 3-tier waterfall.
 * Pure function — pass priceLookup pre-fetched by buildPriceLookup
 * when you need the estimate tier (omit it and you'll only get tiers
 * 1–2).
 */
export function computeOrderRevenue(
  order: OrderForRevenue,
  priceLookup?: PriceLookup,
): RevenueComputation {
  // ── Tier 1: Order.totalPrice ─────────────────────────────────
  const direct = toNumber(order.totalPrice)
  if (direct > 0) {
    return {
      cents: Math.round(direct * 100),
      source: 'order_total',
      estimated: false,
      awaitingPrice: false,
    }
  }

  // ── Tier 2: SUM(OrderItem.price * quantity) ───────────────────
  // Requires ALL items to have a positive price — partial item data
  // would silently under-report. Falls through to tier 3 if any item
  // is missing a price.
  const items = order.items ?? []
  if (items.length > 0) {
    let itemSumCents = 0
    let allHavePrice = true
    for (const it of items) {
      const unit = toNumber(it.price)
      if (unit > 0) {
        itemSumCents += Math.round(unit * 100) * (it.quantity ?? 0)
      } else {
        allHavePrice = false
        break
      }
    }
    if (allHavePrice && itemSumCents > 0) {
      return {
        cents: itemSumCents,
        source: 'item_sum',
        estimated: false,
        awaitingPrice: false,
      }
    }
  }

  // ── Tier 3: ChannelListing.price → Product.basePrice estimate ──
  // Needs the priceLookup. If caller didn't pass one, skip to tier 4.
  if (priceLookup && items.length > 0) {
    let estCents = 0
    let perItemSources: Array<'channel_listing' | 'base_price' | 'none'> = []
    for (const it of items) {
      if (!it.productId) {
        perItemSources.push('none')
        continue
      }
      const pairKey = `${it.productId}|${order.marketplace ?? 'DEFAULT'}`
      const listingPrice = priceLookup.byChannelListing.get(pairKey)
      if (listingPrice != null && listingPrice > 0) {
        estCents += Math.round(listingPrice * 100) * (it.quantity ?? 0)
        perItemSources.push('channel_listing')
        continue
      }
      const basePrice = priceLookup.byProduct.get(it.productId)
      if (basePrice != null && basePrice > 0) {
        estCents += Math.round(basePrice * 100) * (it.quantity ?? 0)
        perItemSources.push('base_price')
        continue
      }
      perItemSources.push('none')
    }
    if (estCents > 0) {
      // Tag the dominant source — useful for UI tooltips that explain
      // which fallback fired. Mixed when both channel + base prices
      // contributed; otherwise the homogeneous source name.
      const hasListing = perItemSources.includes('channel_listing')
      const hasBase = perItemSources.includes('base_price')
      const source: RevenueSource = hasListing && hasBase
        ? 'mixed_estimate'
        : hasListing
        ? 'channel_listing'
        : 'base_price'
      return {
        cents: estCents,
        source,
        estimated: true,
        // Estimate exists but we still don't know the real Amazon-side
        // value → keep `awaitingPrice` so reconciliation banners +
        // alerts can flag for operator review.
        awaitingPrice: true,
      }
    }
  }

  // ── Tier 4: nothing worked ───────────────────────────────────
  return ZERO
}

// ── Batch helpers ────────────────────────────────────────────────────

/**
 * Pre-fetch the price lookup for a set of productIds + channel. Use
 * this once per aggregate query, then pass the result to
 * computeOrderRevenue for every order in the batch — keeps the DB
 * roundtrips O(1) per batch instead of O(N).
 */
export async function buildPriceLookup(
  productIds: string[],
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY' = 'AMAZON',
): Promise<PriceLookup> {
  const byChannelListing = new Map<string, number>()
  const byProduct = new Map<string, number>()
  if (productIds.length === 0) return { byChannelListing, byProduct }

  const [listings, products] = await Promise.all([
    prisma.channelListing.findMany({
      where: {
        productId: { in: productIds },
        channel,
      },
      select: { productId: true, marketplace: true, price: true, salePrice: true },
    }),
    prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, basePrice: true },
    }),
  ])

  for (const l of listings) {
    // salePrice wins over list price when both present.
    const eff =
      l.salePrice != null
        ? Number(l.salePrice)
        : l.price != null
        ? Number(l.price)
        : null
    if (eff != null && Number.isFinite(eff) && eff > 0) {
      byChannelListing.set(`${l.productId}|${l.marketplace}`, eff)
    }
  }
  for (const p of products) {
    const bp = Number(p.basePrice)
    if (Number.isFinite(bp) && bp > 0) {
      byProduct.set(p.id, bp)
    }
  }
  return { byChannelListing, byProduct }
}

/**
 * Compute revenue for an array of orders in a single batch. Builds
 * the price lookup once, then runs computeOrderRevenue per order.
 * Returns the inputs with the computation attached so callers don't
 * need a separate merge step.
 */
export async function computeOrdersRevenue<T extends OrderForRevenue & { id?: string }>(
  orders: T[],
  options: { channel?: 'AMAZON' | 'EBAY' | 'SHOPIFY' } = {},
): Promise<Array<T & { revenue: RevenueComputation }>> {
  const channel = options.channel ?? 'AMAZON'

  // Collect distinct productIds across all items in the batch.
  const productIds = Array.from(
    new Set(
      orders.flatMap((o) =>
        (o.items ?? [])
          .map((i) => i.productId)
          .filter((p): p is string => !!p),
      ),
    ),
  )

  // Only fetch the lookup if at least one order has totalPrice === 0
  // (the only case we'd consult tiers 2–3 for). Saves a roundtrip on
  // typical "all orders priced" batches.
  const needsLookup = orders.some((o) => toNumber(o.totalPrice) <= 0)
  const lookup = needsLookup
    ? await buildPriceLookup(productIds, channel)
    : { byChannelListing: new Map(), byProduct: new Map() }

  return orders.map((o) => ({
    ...o,
    revenue: computeOrderRevenue(o, lookup),
  }))
}

// ── Aggregation helpers ──────────────────────────────────────────────

export interface RevenueRollup {
  /** Cents from Order.totalPrice + item_sum tiers (real numbers). */
  confirmedCents: number
  /** Cents from channel_listing + base_price + mixed_estimate tiers. */
  estimatedCents: number
  /** confirmed + estimated. */
  totalCents: number
  /** Count of orders contributing to estimatedCents. */
  awaitingPriceCount: number
  /** Count of orders that produced 0 (no estimate either). */
  zeroCount: number
}

/**
 * Roll up an array of revenue computations into a single set of
 * counters. Use for "Sales total" tile + per-marketplace rows.
 */
export function rollupRevenue(
  results: Array<{ revenue: RevenueComputation }>,
): RevenueRollup {
  const out: RevenueRollup = {
    confirmedCents: 0,
    estimatedCents: 0,
    totalCents: 0,
    awaitingPriceCount: 0,
    zeroCount: 0,
  }
  for (const r of results) {
    const c = r.revenue
    if (c.source === 'order_total' || c.source === 'item_sum') {
      out.confirmedCents += c.cents
    } else if (
      c.source === 'channel_listing' ||
      c.source === 'base_price' ||
      c.source === 'mixed_estimate'
    ) {
      out.estimatedCents += c.cents
    }
    if (c.awaitingPrice) {
      if (c.cents > 0) out.awaitingPriceCount += 1
      else out.zeroCount += 1
    }
    out.totalCents += c.cents
  }
  return out
}
