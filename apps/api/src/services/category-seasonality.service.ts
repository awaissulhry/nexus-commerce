/**
 * RX.B1 — Category-level seasonal prior.
 *
 * WHY THIS EXISTS
 * ---------------
 * The per-SKU Holt-Winters forecaster (holt-winters.service.ts) only
 * engages annual seasonality when a series has MORE than 365 daily
 * observations (`n > ANNUAL_PERIOD`). But forecast.service reads a fixed
 * 365-day history window and zero-fills it to exactly 365 entries, so
 * `n` is *always* 365 and `365 > 365` is false. Result: Holt-Winters
 * seasonality is structurally unreachable, and EVERY series forecasts as
 * trend-only (HOLT_LINEAR) with no seasonal shape. For an intensely
 * seasonal motorcycle-gear brand (spring/summer riding season) that is a
 * correctness defect, not a missing nicety.
 *
 * Even if we widened the window, no single young SKU has two clean annual
 * cycles to learn its own seasonality from. The fix is to POOL demand at
 * the product-category (productType) level — all jackets share one
 * spring-summer curve — and apply that curve as a multiplicative seasonal
 * prior on top of each SKU's own trend.
 *
 * SAFETY (zero-defect posture)
 * ----------------------------
 * A noisy seasonal index is worse than none. Three guards make a
 * weak-signal category collapse to a flat 1.0 (i.e. no change at all):
 *   1. Min-sample gate — categories below MIN_UNITS / MIN_MONTHS get a
 *      flat index and are omitted from the map entirely.
 *   2. Shrinkage — the raw index is shrunk toward 1.0 proportional to how
 *      much data backs it (`shrink = clamp(units / FULL_TRUST_UNITS)`).
 *      Sparse categories barely move; data-rich ones move fully.
 *   3. Clamp — every factor is bounded to [MIN_FACTOR, MAX_FACTOR] so a
 *      single freak month can never blow up an order.
 *
 * The index is normalized so the 12 monthly factors average ~1.0, which
 * means applying it is demand-neutral over a full year — it only
 * re-shapes WHEN demand is expected, never inflates the annual total.
 */

import prisma from '../db.js'

/** Lookback for building the seasonal shape. Two years so each calendar
 *  month ideally has two observations to average. */
const SEASONALITY_HISTORY_DAYS = 730

/** Below this many pooled units a category has no trustworthy seasonal
 *  signal → flat 1.0. */
const MIN_UNITS = 60
/** Need demand spread across at least this many distinct calendar months
 *  or the "shape" is just a spike. */
const MIN_MONTHS_WITH_DATA = 6
/** Units at which we trust the raw index fully (shrink = 1.0). */
const FULL_TRUST_UNITS = 600
/** Hard bounds on any single monthly factor. */
const MIN_FACTOR = 0.4
const MAX_FACTOR = 2.5

export interface CategorySeasonalIndex {
  productType: string
  /** 12 multiplicative factors, index 0 = January … 11 = December.
   *  Post-shrink, post-clamp, normalized to mean ~1.0. */
  monthly: number[]
  /** Raw (pre-shrink) index, for diagnostics/explainability. */
  monthlyRaw: number[]
  totalUnits: number
  monthsWithData: number
  /** Shrink weight actually applied (0 = flat, 1 = full raw index). */
  shrink: number
  /** True when the category cleared the gates and contributes a real
   *  (non-flat) curve. */
  applied: boolean
}

export type SeasonalIndexMap = Map<string, number[]>

interface RawRow {
  sku: string
  y: number
  m: number
  units: number
}

/**
 * Resolve each SKU's EFFECTIVE productType. Category lives on the master,
 * and child/variation SKUs carry null on their own row, so we walk
 * own → parent → grandparent (mirrors the replenishment endpoint's
 * parent/grandparent fallback). Without this, every child SKU resolves to
 * null and seasonality never applies. Two batched queries (Product, then
 * ProductVariation for any SKUs not found as Products).
 */
export async function resolveEffectiveProductTypes(
  skus: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (skus.length === 0) return out
  const products = await prisma.product.findMany({
    where: { sku: { in: skus } },
    select: {
      sku: true,
      productType: true,
      parent: {
        select: {
          productType: true,
          parent: { select: { productType: true } },
        },
      },
    },
  })
  for (const p of products) {
    const eff =
      p.productType ?? p.parent?.productType ?? p.parent?.parent?.productType ?? null
    if (!out.has(p.sku)) out.set(p.sku, eff)
  }
  const missing = skus.filter((s) => !out.has(s))
  if (missing.length > 0) {
    const variants = await prisma.productVariation.findMany({
      where: { sku: { in: missing } },
      select: {
        sku: true,
        product: {
          select: {
            productType: true,
            parent: {
              select: {
                productType: true,
                parent: { select: { productType: true } },
              },
            },
          },
        },
      },
    })
    for (const v of variants) {
      const eff =
        v.product?.productType ??
        v.product?.parent?.productType ??
        v.product?.parent?.parent?.productType ??
        null
      if (!out.has(v.sku)) out.set(v.sku, eff)
    }
  }
  return out
}

/**
 * Build per-category monthly seasonal indices from pooled DailySalesAggregate
 * demand. Returns both the detailed per-category diagnostics and a lean
 * Map<productType, number[12]> for the forecaster to consume.
 *
 * One DB round-trip for the pooled demand + one batched sku→productType
 * resolve. Cheap enough to run once per forecast batch and pass down.
 */
export async function computeCategorySeasonalIndices(): Promise<{
  indices: CategorySeasonalIndex[]
  map: SeasonalIndexMap
  generatedAt: string
}> {
  const since = new Date()
  since.setUTCHours(0, 0, 0, 0)
  since.setUTCDate(since.getUTCDate() - SEASONALITY_HISTORY_DAYS)

  // Pooled demand bucketed by (sku, year, month). We keep year so we can
  // count how many distinct years each calendar month was observed in and
  // average per-occurrence (avoids biasing months that happen to appear
  // in the data twice vs once).
  const rows = await prisma.$queryRaw<RawRow[]>`
    SELECT sku,
           EXTRACT(YEAR FROM day)::int  AS y,
           EXTRACT(MONTH FROM day)::int AS m,
           SUM("unitsSold")::int        AS units
    FROM "DailySalesAggregate"
    WHERE day >= ${since}
    GROUP BY sku, EXTRACT(YEAR FROM day), EXTRACT(MONTH FROM day)
  `

  if (rows.length === 0) {
    return { indices: [], map: new Map(), generatedAt: new Date().toISOString() }
  }

  // Resolve sku → EFFECTIVE productType (own → parent → grandparent), so
  // child SKUs' demand is attributed to the master's category.
  const skus = [...new Set(rows.map((r) => r.sku))]
  const ptBySku = await resolveEffectiveProductTypes(skus)

  // Accumulate per (productType, calendarMonth): summed units + the set of
  // distinct years observed.
  interface Accum {
    unitsByMonth: number[] // 12
    yearsByMonth: Array<Set<number>> // 12
    total: number
  }
  const byType = new Map<string, Accum>()
  for (const r of rows) {
    const pt = ptBySku.get(r.sku)
    if (!pt) continue // uncategorized SKUs can't inform a category curve
    const m = Number(r.m)
    const units = Number(r.units)
    if (!Number.isFinite(m) || m < 1 || m > 12 || !Number.isFinite(units)) continue
    let acc = byType.get(pt)
    if (!acc) {
      acc = {
        unitsByMonth: new Array(12).fill(0),
        yearsByMonth: Array.from({ length: 12 }, () => new Set<number>()),
        total: 0,
      }
      byType.set(pt, acc)
    }
    acc.unitsByMonth[m - 1] += units
    acc.yearsByMonth[m - 1].add(Number(r.y))
    acc.total += units
  }

  const indices: CategorySeasonalIndex[] = []
  const map: SeasonalIndexMap = new Map()

  for (const [productType, acc] of byType) {
    const occurByMonth = acc.yearsByMonth.map((s) => s.size)
    const built = buildCategoryIndex(acc.unitsByMonth, occurByMonth, acc.total)
    indices.push({ productType, ...built })
    // Only categories that cleared the gate go into the map the forecaster
    // reads — everything else implicitly gets a flat 1.0 (no change).
    if (built.applied) map.set(productType, built.monthly)
  }

  indices.sort((a, b) => b.totalUnits - a.totalUnits)
  return { indices, map, generatedAt: new Date().toISOString() }
}

/**
 * Pure core of the seasonal-index computation — extracted so it can be
 * unit-tested without a database. Given pooled units per calendar month
 * and how many distinct years each month was observed, returns the
 * normalized + smoothed + shrunk + clamped 12-factor index plus its
 * provenance.
 *
 * @param unitsByMonth 12 entries, index 0 = January
 * @param occurByMonth 12 entries, distinct-year count each month was seen
 * @param total        total pooled units (drives the gate + shrink)
 */
export function buildCategoryIndex(
  unitsByMonth: number[],
  occurByMonth: number[],
  total: number,
): Omit<CategorySeasonalIndex, 'productType'> {
  // Average units per occurrence of each calendar month.
  const avgPerOccur = unitsByMonth.map((u, i) =>
    occurByMonth[i] > 0 ? u / occurByMonth[i] : 0,
  )
  const monthsWithData = occurByMonth.filter((c) => c > 0).length

  // Normalize to mean 1 over the OBSERVED months. Months with no
  // observation are treated as the category mean (factor 1) rather than 0
  // so a coverage gap doesn't read as "zero demand that month".
  const observed = avgPerOccur.filter((_, i) => occurByMonth[i] > 0)
  const mean =
    observed.length > 0 ? observed.reduce((a, b) => a + b, 0) / observed.length : 0

  const rawIndex = avgPerOccur.map((v, i) =>
    occurByMonth[i] > 0 && mean > 0 ? v / mean : 1,
  )

  // 3-month circular moving average smooths single-month noise.
  const smoothed = rawIndex.map((_, i) => {
    const a = rawIndex[(i + 11) % 12]
    const b = rawIndex[i]
    const c = rawIndex[(i + 1) % 12]
    return (a + b + c) / 3
  })

  const gatePassed = total >= MIN_UNITS && monthsWithData >= MIN_MONTHS_WITH_DATA
  const shrink = gatePassed ? Math.min(1, total / FULL_TRUST_UNITS) : 0

  // Shrink toward 1.0, then clamp.
  const finalIndex = smoothed.map((v) => {
    const shrunk = 1 + shrink * (v - 1)
    return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, shrunk))
  })

  return {
    monthly: finalIndex,
    monthlyRaw: rawIndex.map((v) => Math.round(v * 1000) / 1000),
    totalUnits: total,
    monthsWithData,
    shrink: Math.round(shrink * 1000) / 1000,
    applied: gatePassed && shrink > 0,
  }
}

/**
 * Multiplicative seasonal factor for a given productType on a given UTC
 * date. Returns 1.0 (neutral) when the category has no trusted curve.
 */
export function seasonalFactorFor(
  map: SeasonalIndexMap,
  productType: string | null | undefined,
  date: Date,
): number {
  if (!productType) return 1
  const monthly = map.get(productType)
  if (!monthly) return 1
  const f = monthly[date.getUTCMonth()]
  return Number.isFinite(f) && f > 0 ? f : 1
}
