/**
 * DA-RT.11 — Pure helpers extracted from sales-drift-detector.job.ts
 * so the comparison logic can be unit-tested without touching the DB
 * or the cron scaffolding.
 *
 * The cron itself still owns the SQL queries + event publishing —
 * these helpers only handle:
 *   1. tolerance calculation (max(€1, 0.5% of max))
 *   2. single-pair check (returns null when either side is missing
 *      or within tolerance — distinct from a real zero)
 *   3. 3-way pair fan-out (orders all three pairs, skipping financial
 *      pairs when financial side is null)
 *
 * Anything that needs Prisma stays in the cron file.
 */

export type DriftStore = 'order' | 'aggregate' | 'financial'

export interface DriftPair {
  a: DriftStore
  b: DriftStore
  deltaCents: number
  deltaPct: number
}

export interface ThreeWaySums {
  orderCents: number
  aggregateCents: number
  /** null when Store C has no rows for this window — distinct from
   *  "Amazon settled €0", which would be 0. Pairs touching a null
   *  side are skipped. */
  financialCents: number | null
}

/** max(€1, 0.5% of `maxCents`), rounded to nearest cent. The €1 floor
 *  keeps near-empty days from firing on rounding-level noise. */
export function toleranceFor(maxCents: number): number {
  return Math.max(100, Math.round(maxCents * 0.005))
}

/** Returns the pair's drift when both sides are present AND the
 *  absolute delta exceeds tolerance; null otherwise. */
export function checkPair(
  a: number | null,
  b: number | null,
): { deltaCents: number; deltaPct: number } | null {
  if (a === null || b === null) return null
  const max = Math.max(a, b)
  if (max === 0) return null
  const delta = a - b
  if (Math.abs(delta) <= toleranceFor(max)) return null
  return { deltaCents: delta, deltaPct: (delta / max) * 100 }
}

/** Builds the drifting-pair list for a single (day, marketplace)
 *  window. Returns an empty array when nothing drifts. */
export function buildDriftPairs(sums: ThreeWaySums): DriftPair[] {
  const candidates: Array<{ a: DriftStore; b: DriftStore; aVal: number | null; bVal: number | null }> = [
    { a: 'order',     b: 'aggregate', aVal: sums.orderCents,     bVal: sums.aggregateCents },
    { a: 'order',     b: 'financial', aVal: sums.orderCents,     bVal: sums.financialCents },
    { a: 'aggregate', b: 'financial', aVal: sums.aggregateCents, bVal: sums.financialCents },
  ]
  const out: DriftPair[] = []
  for (const c of candidates) {
    const delta = checkPair(c.aVal, c.bVal)
    if (!delta) continue
    out.push({ a: c.a, b: c.b, deltaCents: delta.deltaCents, deltaPct: delta.deltaPct })
  }
  return out
}
