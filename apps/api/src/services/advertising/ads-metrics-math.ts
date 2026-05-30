/**
 * AME.2 / AME.3 — pure, currency- and precision-safe helpers for ad-metric
 * aggregation. Centralised + unit-tested so every rollup (campaign-detail
 * ad-group allocation, by-product grid, account reconciliation) shares ONE
 * correct implementation instead of re-deriving it inline.
 *
 * Precision rule (AME.3): always sum spend in micros, then round to cents
 * ONCE. Rounding each daily row before summing accumulates error.
 *
 * Currency rule (AME.2): never bare-sum minor units across currencies. Convert
 * each currency bucket to the EUR base (master currency) first. All current ad
 * data is EUR (rate 1 → no-op), but a future UK/US marketplace would otherwise
 * silently add GBP/USD cents to EUR cents.
 */

/** micros → cents, rounding ONCE on already-summed micros (never per row). */
export function microsToCents(micros: bigint | number | null | undefined): number {
  return Math.round(Number(micros ?? 0) / 10_000)
}

/**
 * Convert native-currency minor units (cents) to EUR-base cents at
 * `eurPerUnit` (EUR per 1 native currency unit; obtain via
 * getFxRate(prisma, nativeCcy, 'EUR')). EUR→EUR passes rate 1 (no-op).
 */
export function toEurCents(nativeCents: number, eurPerUnit: number): number {
  if (eurPerUnit === 1 || nativeCents === 0) return nativeCents
  return Math.round(nativeCents * eurPerUnit)
}

/**
 * Largest-remainder allocation: distribute an integer `total` across rows by
 * `shares`, guaranteeing Σ(parts) === total exactly — so a parent total split
 * across children never drifts and no child can exceed the parent. Edge cases:
 * total ≤ 0 → all zeros; share-sum ≤ 0 → even split of the total.
 */
export function allocate(total: number, shares: number[]): number[] {
  const n = shares.length
  if (n === 0) return []
  if (total <= 0) return shares.map(() => 0)
  const sum = shares.reduce((a, b) => a + b, 0)
  if (sum <= 0) {
    const base = Math.floor(total / n)
    const out = shares.map(() => base)
    for (let i = 0; i < total - base * n; i++) out[i] += 1
    return out
  }
  const raw = shares.map((s) => (total * s) / sum)
  const out = raw.map((v) => Math.floor(v))
  const rem = total - out.reduce((a, b) => a + b, 0)
  const order = raw.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f)
  for (let k = 0; k < rem; k++) out[order[k % n]!.i] += 1
  return out
}
