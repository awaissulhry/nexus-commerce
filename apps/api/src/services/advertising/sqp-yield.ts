/**
 * SQP.4 — order the nightly request set by MEASURED YIELD.
 *
 * ── The defect this fixes ─────────────────────────────────────────────────────────────────────
 *
 * `ourAsinsForMarketplace` orders by `listingStatus` and nothing else, so the nightly ten are
 * effectively alphabetical within a status band. Measured 2026-08-14, IT, same week and same night:
 *
 *   2 hand-picked ASINs known to return rows  →  66 rows  (33.0 rows/report)
 *   10 ASINs the nightly pass selected        →   6 rows  ( 0.6 rows/report)
 *
 * **A 55× difference at identical cost**, and eight of the nightly ten returned literally nothing.
 * Across the four markets only 2/10 (IT), 3/10 (DE), 7/10 (ES) and 2/10 (FR) of the requested ASINs
 * had ever returned a row. IT's ten best sit at selection ranks 10, 21, 23, 24, 27, 36, 67, 80, 81
 * and 95 — every one outside the cut.
 *
 * So the feed's problem was never budget. It was aim.
 *
 * ── Three tiers, because "never asked" and "asked and empty" are different facts ───────────────
 *
 * 🔴 `_acr2-sqp-backfill.mts` seeds its top-N from `SearchQueryPerformance`, so an ASIN with zero rows
 * can never enter it — a pure exploit with no explore, and the reason a cold ASIN stays cold forever.
 * This must not repeat that, so the ordering is:
 *
 *   1. PROVEN     — has returned rows. Ranked by rows per *measured week*, not by total, or an ASIN
 *                   ranks high merely for having been sampled more often.
 *   2. UNPROVEN   — never requested. Keeps its incoming preference order. It may be excellent; we
 *                   have no evidence either way, and evidence is what the exploration quota buys.
 *   3. BARREN     — requested and returned zero rows, every time. Ranked last, because this is the
 *                   one tier we have positive evidence *against*.
 *
 * BARREN below UNPROVEN is the whole point: 71–73% of reports return the empty 334-byte payload, and
 * re-asking a known-empty ASIN spends ~65s of `createReport` throttle to re-learn something already in
 * the ledger.
 *
 * ── Where the evidence comes from ─────────────────────────────────────────────────────────────
 *
 * Both sources are needed and they are not interchangeable. `SearchQueryPerformance` records only
 * successes — an ASIN that returned nothing leaves no row, so it is indistinguishable there from one
 * never asked. **`SqpReportRequest.rowsParsed` is the only place a measured zero is written down.**
 */

/** What we know about one ASIN's past yield. */
export interface AsinYieldEvidence {
  /** total rows this ASIN has ever produced (SearchQueryPerformance + ledger agree on successes) */
  rows: number
  /** how many distinct weeks it has been *measured* in — the denominator for a fair rate */
  weeksMeasured: number
  /** how many reports we have requested for it, from the ledger. 0 = never asked. */
  reportsRequested: number
}

export type YieldTier = 'proven' | 'unproven' | 'barren'

export function tierOf(e: AsinYieldEvidence | undefined): YieldTier {
  if (!e || e.reportsRequested === 0) return e && e.rows > 0 ? 'proven' : 'unproven'
  if (e.rows > 0) return 'proven'
  return 'barren'
}

/** Rows per measured week — the fair rate. Zero-safe; an unmeasured ASIN scores 0, not Infinity. */
export function yieldRate(e: AsinYieldEvidence | undefined): number {
  if (!e || e.weeksMeasured <= 0) return 0
  return e.rows / e.weeksMeasured
}

/**
 * Order a pool for tonight's request set.
 *
 * `pool` arrives in the existing preference order and that order is preserved *within* the unproven
 * tier — this function adds a yield signal, it does not discard the listing-status one.
 */
export function rankByYield(
  pool: string[],
  evidence: Map<string, AsinYieldEvidence>,
): Array<{ asin: string; tier: YieldTier; rate: number; rank: number }> {
  const incoming = new Map(pool.map((a, i) => [a, i]))
  const TIER_ORDER: Record<YieldTier, number> = { proven: 0, unproven: 1, barren: 2 }

  return pool
    .map((asin) => {
      const e = evidence.get(asin)
      return { asin, tier: tierOf(e), rate: yieldRate(e), evidence: e }
    })
    .sort((a, b) => {
      if (TIER_ORDER[a.tier] !== TIER_ORDER[b.tier]) return TIER_ORDER[a.tier] - TIER_ORDER[b.tier]
      if (a.tier === 'proven') {
        if (b.rate !== a.rate) return b.rate - a.rate
        // more weeks of evidence wins a tie — a single lucky week is weaker than five consistent ones
        const aw = a.evidence?.weeksMeasured ?? 0, bw = b.evidence?.weeksMeasured ?? 0
        if (bw !== aw) return bw - aw
      }
      // everything else keeps the incoming order, so the ranking is deterministic run to run
      return incoming.get(a.asin)! - incoming.get(b.asin)!
    })
    .map((x, rank) => ({ asin: x.asin, tier: x.tier, rate: x.rate, rank }))
}

/**
 * Tonight's set: the best proven ASINs, plus a reserved slice for ASINs we have never asked about.
 *
 * 🔴 `exploreSlots` is not padding. Without it this is `_acr2-sqp-backfill.mts` again — a ranking that
 * can only ever re-select what it already knows, in a pool where 93.6% of ASINs have never been asked
 * once. The default reserves 2 of 10, so exploration is real but never costs more than a fifth of the
 * night's evidence-backed yield.
 */
export function planRequestSet(args: {
  pool: string[]
  evidence: Map<string, AsinYieldEvidence>
  budget: number
  exploreSlots?: number
  /** ASINs to leave alone tonight — settled weeks, in-flight reports (SQP.3). */
  exclude?: ReadonlySet<string>
}): { chosen: string[]; exploit: string[]; explore: string[]; barrenSkipped: number } {
  const budget = Math.max(0, Math.floor(args.budget))
  const exclude = args.exclude ?? new Set<string>()
  const ranked = rankByYield(args.pool, args.evidence).filter((r) => !exclude.has(r.asin))

  const explore = Math.max(0, Math.min(budget, args.exploreSlots ?? Math.max(1, Math.floor(budget / 5))))
  const exploitBudget = budget - explore

  const proven = ranked.filter((r) => r.tier === 'proven').slice(0, exploitBudget).map((r) => r.asin)
  const taken = new Set(proven)
  const unproven = ranked.filter((r) => r.tier === 'unproven' && !taken.has(r.asin)).slice(0, explore).map((r) => r.asin)
  unproven.forEach((a) => taken.add(a))

  // Any slot the two tiers could not fill falls through in rank order rather than going unused — a
  // report not sent is capacity thrown away, and even a barren ASIN re-confirms a zero cheaply.
  const filler = ranked.filter((r) => !taken.has(r.asin)).slice(0, budget - taken.size).map((r) => r.asin)

  return {
    chosen: [...proven, ...unproven, ...filler],
    exploit: proven,
    explore: unproven,
    barrenSkipped: ranked.filter((r) => r.tier === 'barren' && !taken.has(r.asin) && !filler.includes(r.asin)).length,
  }
}
