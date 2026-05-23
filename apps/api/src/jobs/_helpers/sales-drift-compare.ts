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

/** DA-RT.20 — pair classification.
 *  - `true-drift`: real disagreement worth investigating. Fires alerts.
 *  - `settlement-pending`: F-side pair where F < O on a recent window
 *    (< 14 days old). Amazon's ListFinancialEvents settles T+1..T+14,
 *    so partial F-side coverage is expected, not a bug. Surfaced in
 *    the audit endpoint but skipped by the cron's publish path. */
export type DriftKind = 'true-drift' | 'settlement-pending'

export interface DriftPair {
  a: DriftStore
  b: DriftStore
  deltaCents: number
  deltaPct: number
  kind: DriftKind
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
 *  window. Returns an empty array when nothing drifts.
 *  windowAgeDays — when provided AND < settlement window, F-side
 *  pairs where F < O are classified as `settlement-pending` (Amazon's
 *  normal settlement lag). Pairs where F > O always classify as
 *  `true-drift` regardless of age — Amazon settling more than we sold
 *  is a real bug.
 *
 *  Settlement window defaults to 21 days (overridable via env
 *  NEXUS_SALES_DRIFT_SETTLEMENT_DAYS). Amazon DE in particular often
 *  settles 14-21 days post-ship; IT/ES/FR are typically 7-14. 21
 *  days as the default catches the long tail across all EU markets;
 *  operator can tighten if running a smaller-volume account. */
export function buildDriftPairs(
  sums: ThreeWaySums,
  windowAgeDays?: number,
): DriftPair[] {
  const candidates: Array<{ a: DriftStore; b: DriftStore; aVal: number | null; bVal: number | null }> = [
    { a: 'order',     b: 'aggregate', aVal: sums.orderCents,     bVal: sums.aggregateCents },
    { a: 'order',     b: 'financial', aVal: sums.orderCents,     bVal: sums.financialCents },
    { a: 'aggregate', b: 'financial', aVal: sums.aggregateCents, bVal: sums.financialCents },
  ]
  const settlementDaysRaw = Number(process.env.NEXUS_SALES_DRIFT_SETTLEMENT_DAYS ?? 21)
  const SETTLEMENT_DAYS = Number.isFinite(settlementDaysRaw) && settlementDaysRaw > 0
    ? Math.trunc(settlementDaysRaw)
    : 21
  const inSettlementWindow =
    typeof windowAgeDays === 'number' && windowAgeDays < SETTLEMENT_DAYS

  const out: DriftPair[] = []
  for (const c of candidates) {
    const delta = checkPair(c.aVal, c.bVal)
    if (!delta) continue
    const isFinancialPair = c.b === 'financial' || c.a === 'financial'
    // deltaCents = c.aVal - c.bVal. For order↔financial + aggregate↔financial,
    // a-side is the local store, b-side is financial. Positive delta means
    // local > financial (= financial hasn't fully settled = settlement-pending).
    const fIsLow = isFinancialPair && delta.deltaCents > 0
    const kind: DriftKind =
      inSettlementWindow && fIsLow ? 'settlement-pending' : 'true-drift'
    out.push({
      a: c.a,
      b: c.b,
      deltaCents: delta.deltaCents,
      deltaPct: delta.deltaPct,
      kind,
    })
  }
  return out
}
