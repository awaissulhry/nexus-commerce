/**
 * VP.3 — rule-based SKU assignment for eBay Volume Pricing.
 *
 * Operators don't want to hand-pick the SKUs that belong in a volume promotion;
 * they want to say "every eBay-IT helmet over €80 that still clears a 20% margin".
 * resolveSkusByRule turns such a rule into the concrete SKU list a promotion's
 * `skus` field expects.
 *
 * Eligibility (all conditions AND'd; every optional filter is skipped when unset):
 *   (a) the Product has an ACTIVE eBay ChannelListing for the given marketplace
 *       (ChannelListing.channel='EBAY', marketplace=<x>, listingStatus='ACTIVE').
 *       That listing's price (ChannelListing.price ?? Product.basePrice) is the
 *       effective per-unit price the tiers discount off.
 *   (b) categoryId — membership in that PIM Category OR any of its descendants,
 *       resolved through the CategoryClosure table (ancestorId = categoryId gives
 *       the whole subtree, self-pair included), then ProductCategory.
 *   (c) brand — exact Product.brand match.
 *   (d) maxPrice — effective price ≤ maxPrice.
 *   (e) minMarginPercent — margin at the effective price ≥ floor. Margin uses
 *       Product.costPrice (the canonical cost-of-goods column used by the pricing/
 *       repricing engines), falling back to weightedAvgCostCents/100 (rolling WAC).
 *       Products with no known cost are EXCLUDED when minMarginPercent is set
 *       (can't prove they clear the floor) and INCLUDED otherwise.
 *
 * eBay's item_promotion accepts ≤500 SKUs (MAX_SKUS, mirrors the push guard); the
 * resolved list is capped there and `truncated` reports when more matched.
 *
 * The pure scoring/margin maths live in computeEffectivePrice + passesFilters so
 * they're unit-testable without a DB; the DB query is the thin shell around them.
 */

import type { PrismaClient } from '@prisma/client'

/** eBay item_promotion SKU ceiling — same constant the push service guards on. */
export const MAX_SKUS = 500

export interface ResolveSkusRule {
  marketplace: string
  categoryId?: string
  brand?: string
  /** Floor margin % — exclude SKUs below it (and SKUs with unknown cost). */
  minMarginPercent?: number
  /** Exclude SKUs whose effective per-unit price exceeds this. */
  maxPrice?: number
  /** Cap the returned list (still hard-capped at MAX_SKUS). */
  limit?: number
}

export interface ResolvedSku {
  sku: string
  price: number
  marginPercent: number | null
}

export interface ResolveSkusResult {
  skus: string[]
  count: number
  /** True when more SKUs matched than were returned (limit / MAX_SKUS cap). */
  truncated: boolean
  /** Total eligible matches before the cap was applied. */
  matched: number
  /** First ≤20 resolved rows, for the UI preview. */
  sample: ResolvedSku[]
}

/** Minimal product shape the pure helpers need (a candidate row + its eBay listing). */
export interface ResolveCandidate {
  sku: string
  basePrice: number
  brand: string | null
  /** Cost of goods in major units (€), or null when unknown. */
  cost: number | null
  /** Effective eBay price = listing.price ?? basePrice, in major units. */
  listingPrice: number | null
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Effective per-unit price the tiers discount off: listing override, else base. */
export function computeEffectivePrice(c: ResolveCandidate): number {
  return c.listingPrice != null && c.listingPrice > 0 ? c.listingPrice : c.basePrice
}

/** Seller margin % at the effective price, or null when cost is unknown. */
export function computeMarginPercent(price: number, cost: number | null): number | null {
  if (cost == null || !(cost > 0) || !(price > 0)) return null
  return round2(((price - cost) / price) * 100)
}

/**
 * Pure eligibility test for a single candidate against a rule's value filters
 * (brand / maxPrice / minMarginPercent). Marketplace + category membership are
 * resolved in the DB query, not here. Returns the resolved row when it passes,
 * else null — so the caller gets price+margin for free on the keep path.
 */
export function passesFilters(
  c: ResolveCandidate,
  rule: Pick<ResolveSkusRule, 'brand' | 'maxPrice' | 'minMarginPercent'>,
): ResolvedSku | null {
  if (rule.brand != null && c.brand !== rule.brand) return null

  const price = computeEffectivePrice(c)
  if (!(price > 0)) return null
  if (rule.maxPrice != null && price > rule.maxPrice) return null

  const marginPercent = computeMarginPercent(price, c.cost)
  if (rule.minMarginPercent != null) {
    // Unknown cost ⇒ can't prove the floor is cleared ⇒ exclude.
    if (marginPercent == null || marginPercent < rule.minMarginPercent) return null
  }

  return { sku: c.sku, price, marginPercent }
}

/**
 * Resolve the rule against the DB. Pulls the candidate set (eBay-ACTIVE on the
 * marketplace, optionally narrowed to a category subtree), then runs the pure
 * passesFilters over each and caps the result.
 */
export async function resolveSkusByRule(
  prisma: PrismaClient,
  rule: ResolveSkusRule,
): Promise<ResolveSkusResult> {
  const { marketplace, categoryId, limit } = rule

  // (b) Optional category subtree → set of categoryIds via the closure table.
  let categoryIds: string[] | null = null
  if (categoryId) {
    const closure = await prisma.categoryClosure.findMany({
      where: { ancestorId: categoryId },
      select: { descendantId: true },
    })
    categoryIds = closure.map((r) => r.descendantId)
    // Unknown category ⇒ no descendants ⇒ nothing eligible. Short-circuit.
    if (categoryIds.length === 0) {
      return { skus: [], count: 0, truncated: false, matched: 0, sample: [] }
    }
  }

  // (a) Candidate products: an ACTIVE eBay listing for this marketplace, plus
  // (c) brand and (b) category membership pushed into the query where cheap.
  const products = await prisma.product.findMany({
    where: {
      ...(rule.brand != null ? { brand: rule.brand } : {}),
      channelListings: {
        some: { channel: 'EBAY', marketplace, listingStatus: 'ACTIVE' },
      },
      ...(categoryIds != null ? { categories: { some: { categoryId: { in: categoryIds } } } } : {}),
    },
    select: {
      sku: true,
      basePrice: true,
      brand: true,
      costPrice: true,
      weightedAvgCostCents: true,
      channelListings: {
        where: { channel: 'EBAY', marketplace, listingStatus: 'ACTIVE' },
        select: { price: true },
        orderBy: { updatedAt: 'desc' },
        take: 1,
      },
    },
  })

  const eligible: ResolvedSku[] = []
  for (const p of products) {
    const cost =
      p.costPrice != null
        ? Number(p.costPrice)
        : p.weightedAvgCostCents != null
          ? p.weightedAvgCostCents / 100
          : null
    const listing = p.channelListings[0]
    const candidate: ResolveCandidate = {
      sku: p.sku,
      basePrice: Number(p.basePrice),
      brand: p.brand,
      cost,
      listingPrice: listing?.price != null ? Number(listing.price) : null,
    }
    const passed = passesFilters(candidate, rule)
    if (passed) eligible.push(passed)
  }

  // Stable, deterministic ordering for the cap + sample.
  eligible.sort((a, b) => a.sku.localeCompare(b.sku))

  const matched = eligible.length
  const cap = Math.min(limit != null && limit > 0 ? limit : MAX_SKUS, MAX_SKUS)
  const kept = eligible.slice(0, cap)

  return {
    skus: kept.map((e) => e.sku),
    count: kept.length,
    truncated: matched > kept.length,
    matched,
    sample: kept.slice(0, 20),
  }
}
