/**
 * Ads Core (E1) — pure, currency- and precision-safe helpers for ad-metric
 * aggregation, shared by every ads channel (Amazon today, eBay from E2).
 * Moved verbatim from services/advertising/ads-metrics-math.ts (AME.2/AME.3)
 * — one implementation, no per-channel forks.
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

/**
 * ADM-A5 — which ad products actually publish new-to-brand metrics.
 *
 * Verified against Amazon's own allowed-column lists on 2026-08-26 by probing the v3 report API
 * with an invalid column name, which makes it answer with what each report really offers:
 *
 *   spCampaigns   52 columns · ZERO newToBrand*   ← Sponsored Products publishes none, ever
 *   spTargeting   61 columns · ZERO newToBrand*
 *   sbCampaigns   66 columns · 14 newToBrand*
 *   sdCampaigns   73 columns · 11 newToBrand*
 *
 * 🔴 This is a GATE, not an optimisation, and a row's existence cannot replace it. The two legacy
 * columns `ntbOrders14d` / `ntbSalesCents14d` carry `DEFAULT 0`, so all 6,019 Sponsored Products
 * rows already hold a zero nobody measured — the columns were never requested from any report
 * until 2026-08-26. A presence check (`_count > 0`) passes on those defaulted zeros, so without
 * this predicate the Ad Manager printed "0 new-to-brand orders" for Sponsored Products campaigns:
 * a confident measurement of something Amazon has never reported and never will.
 *
 * The distinction it preserves is the one the honesty law turns on — "not applicable to this ad
 * product" is not "zero", and a defaulted column cannot tell you which it is.
 */
export function ntbIsPublishedFor(adProduct: string | null | undefined): boolean {
  return adProduct === 'SPONSORED_BRANDS' || adProduct === 'SPONSORED_DISPLAY'
}
