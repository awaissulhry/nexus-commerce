/**
 * W4.2 — TierPricingService.
 *
 * Resolves the effective price for (product, customer, qty). The
 * pure resolver (`resolveTierPrice`) is exported separately from
 * the DB-bound class so unit tests cover the priority rules
 * without spinning up Prisma.
 *
 * Priority rules (highest priority first):
 *   1. Filter applicable tiers — customerGroupId matches OR is null
 *      (null = "applies to everyone")
 *   2. Filter to tiers with minQty <= requestedQty
 *   3. At the same minQty, prefer group-specific over generic
 *   4. From the surviving set, pick the row with the highest minQty
 *      (deepest discount the buyer qualifies for)
 *   5. If no tier qualifies, fall back to basePrice
 *
 * The price stored on each row is absolute (not "% off basePrice")
 * so the resolver is pure arithmetic — no surprise rounding when
 * the operator changes basePrice on a product that has tiers.
 *
 * Idempotency / determinism:
 *   The @@unique([productId, minQty, customerGroupId]) DB
 *   constraint guarantees at most one tier per tuple. Combined
 *   with the priority rules above, resolveTierPrice is deterministic
 *   for any (basePrice, tiers, qty, group) input.
 */

import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'

export interface TierPriceRow {
  minQty: number
  price: number
  customerGroupId: string | null
}

export interface TierResolution {
  /** Effective unit price after applying tier rules. */
  price: number
  /** Source of the price: 'base' if no tier qualified, 'tier' if a
   *  tier won, with details. */
  source: 'base' | 'tier'
  /** When source='tier', the (minQty, customerGroupId) that won. */
  appliedTier: {
    minQty: number
    customerGroupId: string | null
  } | null
}

/**
 * Pure resolver. Tested directly without DB.
 *
 * @param basePrice  Product.basePrice fallback.
 * @param tiers      All tier rows for the product (any group, any minQty).
 * @param qty        Requested quantity.
 * @param groupId    Customer's group, or null for anonymous /
 *                   no-group buyers.
 */
export function resolveTierPrice(
  basePrice: number,
  tiers: readonly TierPriceRow[],
  qty: number,
  groupId: string | null,
): TierResolution {
  if (qty <= 0) {
    // Sentinel — qty=0 means "what would I pay for one?" Resolve at
    // qty=1 since that's the buyer-meaningful answer.
    qty = 1
  }

  // Step 1+2: filter to tiers the buyer qualifies for.
  const applicable = tiers.filter(
    (t) =>
      t.minQty <= qty &&
      (t.customerGroupId === null || t.customerGroupId === groupId),
  )
  if (applicable.length === 0) {
    return { price: basePrice, source: 'base', appliedTier: null }
  }

  // Step 3+4: at each minQty, prefer group-specific. Then pick the
  // highest minQty (deepest discount).
  //
  // Implementation: bucket by minQty, dedup with group-specific
  // preference, then sort buckets DESC and take the first.
  const byMinQty = new Map<number, TierPriceRow>()
  for (const t of applicable) {
    const existing = byMinQty.get(t.minQty)
    if (!existing) {
      byMinQty.set(t.minQty, t)
      continue
    }
    // Same minQty: group-specific (non-null group) beats generic.
    const existingIsGeneric = existing.customerGroupId === null
    const candidateIsGeneric = t.customerGroupId === null
    if (existingIsGeneric && !candidateIsGeneric) {
      byMinQty.set(t.minQty, t)
    }
    // Otherwise existing stays (either both group-specific —
    // but that's prevented by @@unique — or both generic, same).
  }

  // Sort minQty DESC and pick the first.
  const sorted = [...byMinQty.values()].sort((a, b) => b.minQty - a.minQty)
  const winner = sorted[0]
  return {
    price: winner.price,
    source: 'tier',
    appliedTier: {
      minQty: winner.minQty,
      customerGroupId: winner.customerGroupId,
    },
  }
}

/**
 * DB-bound wrapper. Loads the product + its tiers and returns the
 * resolved price. Used by checkout / order-creation paths once
 * those wire in (Wave 8 B2B catalog).
 */
export class TierPricingService {
  constructor(private readonly client: PrismaClient = prisma) {}

  async resolve(
    productId: string,
    qty: number,
    customerGroupId: string | null = null,
  ): Promise<TierResolution> {
    const product = await this.client.product.findUnique({
      where: { id: productId },
      select: {
        basePrice: true,
        tierPrices: {
          select: {
            minQty: true,
            price: true,
            customerGroupId: true,
          },
        },
      },
    })
    if (!product) {
      throw new Error(`TierPricingService: product ${productId} not found`)
    }
    const tiers: TierPriceRow[] = product.tierPrices.map((t) => ({
      minQty: t.minQty,
      // Prisma Decimal → number. Tiers carry max 10,2 precision so
      // Number() round-trip is lossless within the supported range.
      price: Number(t.price as unknown as Prisma.Decimal),
      customerGroupId: t.customerGroupId,
    }))
    return resolveTierPrice(
      Number(product.basePrice as unknown as Prisma.Decimal),
      tiers,
      qty,
      customerGroupId,
    )
  }
}

export const tierPricingService = new TierPricingService()
