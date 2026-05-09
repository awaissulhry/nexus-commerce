/**
 * W4.13 — Stock-imbalance detector.
 *
 * Walks per-product StockLevel rows across locations, computes the
 * imbalance ratio (max - min) / max, and returns products where:
 *   - ≥ 2 active locations have stock for the SKU
 *   - imbalance ratio >= threshold (default 0.5 — i.e. one location
 *     has at least 2x the stock of another)
 *   - shortage location's available is below its reorderThreshold
 *     (or some configurable floor) — pure imbalance with both
 *     locations well-stocked isn't a transfer candidate
 *
 * Output shape matches template 6's condition contract:
 *
 *   {
 *     imbalance: {
 *       ratio: number,
 *       surplusLocation: { id, code, available },
 *       shortageLocation: { id, code, available, threshold }
 *     },
 *     product: { id, sku }
 *   }
 *
 * Uses raw SQL for the cross-location aggregation — Prisma's
 * groupBy doesn't easily expose MIN/MAX with their join keys.
 * One query gets every imbalance candidate; per-row I/O stays flat.
 */

import prisma from '../db.js'

export interface DetectedImbalance {
  imbalance: {
    ratio: number
    surplusLocation: {
      id: string
      code: string
      available: number
    }
    shortageLocation: {
      id: string
      code: string
      available: number
      threshold: number | null
    }
  }
  product: {
    id: string
    sku: string
  }
}

export interface DetectImbalanceArgs {
  /** Default 0.5 — at least one location has 2x another's stock. */
  ratioThreshold?: number
  /** Floor below which the shortage location is considered "running low".
   *  When per-location reorderThreshold isn't set, we fall back to this
   *  global floor. Default 5 units. */
  shortageFloor?: number
}

export async function detectStockImbalances(
  args: DetectImbalanceArgs = {},
): Promise<DetectedImbalance[]> {
  const ratioThreshold = args.ratioThreshold ?? 0.5
  const shortageFloor = args.shortageFloor ?? 5

  // Two-pass plan: first pass groups by productId to find candidates
  // (≥2 locations + max/min); second pass joins back to StockLevel
  // to identify which specific location is surplus / shortage.
  // Bounded by Product+StockLocation count; ~milliseconds at Xavia
  // scale.
  const candidates = await prisma.$queryRaw<
    Array<{
      productId: string
      sku: string
      n_locations: bigint
      max_avail: number
      min_avail: number
    }>
  >`
    SELECT
      sl."productId",
      p.sku,
      count(*)::bigint AS n_locations,
      MAX(sl.available) AS max_avail,
      MIN(sl.available) AS min_avail
    FROM "StockLevel" sl
    JOIN "Product" p ON p.id = sl."productId"
    WHERE p.status = 'ACTIVE' AND p."isParent" = false
    GROUP BY sl."productId", p.sku
    HAVING count(*) >= 2 AND MAX(sl.available) > 0
  `

  if (candidates.length === 0) return []

  const flagged: DetectedImbalance[] = []
  for (const c of candidates) {
    const max = c.max_avail
    const min = c.min_avail
    if (max <= 0) continue
    const ratio = (max - min) / max
    if (ratio < ratioThreshold) continue

    // Hydrate the surplus + shortage locations explicitly.
    const rows = await prisma.stockLevel.findMany({
      where: {
        productId: c.productId,
        OR: [{ available: max }, { available: min }],
      },
      select: {
        locationId: true,
        available: true,
        reorderThreshold: true,
        location: { select: { code: true } },
      },
    })
    const surplus = rows.find((r) => r.available === max)
    const shortage = rows.find((r) => r.available === min)
    if (!surplus || !shortage) continue
    const shortageThreshold = shortage.reorderThreshold ?? shortageFloor
    if (shortage.available > shortageThreshold) continue // not low enough to act

    flagged.push({
      imbalance: {
        ratio: Number(ratio.toFixed(3)),
        surplusLocation: {
          id: surplus.locationId,
          code: surplus.location.code,
          available: surplus.available,
        },
        shortageLocation: {
          id: shortage.locationId,
          code: shortage.location.code,
          available: shortage.available,
          threshold: shortage.reorderThreshold,
        },
      },
      product: {
        id: c.productId,
        sku: c.sku,
      },
    })
  }

  return flagged
}
