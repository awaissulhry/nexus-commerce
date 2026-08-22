/**
 * SOV-P1 (2026-08-22) — the per-keyword MARKET share an SOV rule is allowed to decide on.
 *
 * 🔴 What this replaces, and why it had to be replaced.
 *
 * `buildSovBidContexts` used to take its "Share of Voice" from `analyzeShareOfVoice()`, whose
 * `sovPct` is **a query's impressions ÷ our OWN account's total impressions over every query and
 * every marketplace**. That is an impression *mix*, not a share of any market, and the difference
 * is not academic. Measured on prod 2026-08-22:
 *
 *   · median `sovPct` = 0.0026 %, so `Share of Voice < 50 %` matched 1000 of 1000 rows and
 *     `< 1 %` matched 986 — every threshold an operator would type was a no-op;
 *   · against Amazon's own per-query share, over 607 market×query pairs, **Spearman ρ = −0.2445**,
 *     negative in all four markets (DE −0.35 · ES −0.35 · IT −0.17 · FR −0.57).
 *
 * It did not merely mis-scale the answer, it **ordered it backwards**: a head query has many
 * impressions (high mix) against an enormous market (low real share), and a tail query is the
 * inverse. On the HEAD the two numbers are within an order of magnitude and the error changes sign
 * (0.5×–6.4×), which is exactly why a rescale could not have fixed it; the damage is in the TAIL,
 * where a rule actually acts. Our five strongest real positions — IT "giubbotto moto uomo nero" at
 * 15.11 %, "giacca da moto impermeabile uomo" at 14.91 %, and so on — all read ≈0.00x %, so
 * "raise the bid where Share of Voice is low" raised them hardest exactly where we already held
 * the most market.
 *
 * So the number now comes from `SearchQueryPerformance` — Amazon Brand Analytics' own
 * `impressionsBrand / impressionsTotal` per (marketplace × query × ASIN × week). It is the only
 * per-keyword market share this system holds, and 100 % of its rows carry a real denominator.
 *
 * ⚠ **The gate is `chooseViewPeriod`, imported and not re-implemented.** Keyword Tracker, the
 * (parked) Share-of-Voice report and this service must agree about which week is real, or the
 * engine acts on a week the operator is not being shown. `SQP_COMPLETENESS_RATIO` is shared and is
 * not lowered here ([[project_sov_share_of_voice_page]]).
 *
 * 🔴 **One deliberate difference from the page: a truncated week is REFUSED, not rendered.**
 * `chooseViewPeriod` never returns nothing — when no period qualifies it falls back to the newest
 * one and flags `truncated`, because a page that empties is worse than a page that explains itself.
 * An engine has the opposite duty: a share computed from a half-written week would move live bids
 * on a denominator that is still being filled. So a market whose gate says anything other than
 * `complete` contributes **no contexts at all**, and the tab says which markets those are.
 *
 * Null-vs-zero, once: a query with no market total yields **no row**, never a 0. `share()` in
 * `sqp.service.ts` coalesces those two and breaking that tie is the reason this whole section
 * exists ([[reference_sov_zero_vs_rounding]]).
 *
 * Read-only. No writes, no Amazon calls.
 */

import prisma from '../../db.js'
import {
  chooseViewPeriod,
  type KtPeriodReason,
} from './keyword-tracker.service.js'
import { SOV_MARKETS, SOV_DEFAULT_WEEKS } from './share-of-voice.service.js'

/** One query's market impression share, in one marketplace, on the gate's chosen week. */
export interface SovKeywordShareRow {
  marketplace: string
  /** trimmed + lowercased — the key an `AdTarget.expressionValue` is matched on */
  query: string
  impressionsBrand: number
  impressionsTotal: number
  /** 0..1. Never present when `impressionsTotal` is 0 — the row is omitted instead. */
  sharePct: number
  /** how many of our ASIN rows summed into this query */
  asinRows: number
}

/** What the gate decided for one marketplace, in the words the tab prints. */
export interface SovMarketPeriod {
  marketplace: string
  /** the week the engine reads, or null when the market is refused */
  start: Date | null
  /** how old that week's START is, in whole days — the honest freshness number */
  ageDays: number | null
  rows: number
  baselineRows: number
  threshold: number
  reason: KtPeriodReason
  /** true when the gate could not find a complete week — the market is then REFUSED */
  refused: boolean
  /** distinct queries with a real market total on the chosen week */
  queries: number
}

export interface SovKeywordShareResult {
  /** key: `${marketplace}|${lowercased query}` */
  byKey: Map<string, SovKeywordShareRow>
  periods: SovMarketPeriod[]
  /** markets that contributed at least one row */
  measuredMarkets: string[]
}

const DAY = 86_400_000

/** `${marketplace}|${query}` — the ONE join key, so a caller cannot build a different one. */
export function sovShareKey(marketplace: string | null | undefined, query: string | null | undefined): string {
  return `${marketplace ?? ''}|${(query ?? '').trim().toLowerCase()}`
}

/** The shape this module needs off an SQP row. Narrow on purpose so it is trivially testable. */
export interface SqpShareInput {
  searchQuery: string | null
  impressionsBrand: number | null
  impressionsTotal: number | null
}

/**
 * Fold a week's SQP rows into one share per query. **Pure** — extracted so the rule below is
 * tested rather than asserted.
 *
 * 🔴 THE RULE, and it is the one that is easy to get wrong: **Σ brand ÷ MAX total.**
 *
 * A query's rows are one per ASIN of ours. Our brand impressions are SPLIT across those rows, so
 * they must be summed. The market total is **one number repeated on every row**, so summing it
 * multiplies the denominator by the ASIN count and divides every share by it. Verified on prod
 * 2026-08-22: of 135 multi-ASIN query-weeks, **0** had rows disagreeing about `impressionsTotal`,
 * and 0 had Σbrand > max(total) — so `max` is exact, not a heuristic. `share-of-voice.service.ts:666`
 * has always done it this way; a study probe that summed it overstated the head-query gaps by up to
 * an order of magnitude, which is precisely why this now has a test.
 *
 * A query with no market total yields NO entry — never a zero. "Amazon reported no market total"
 * and "we hold none of this market" are different facts ([[reference_sov_zero_vs_rounding]]).
 */
export function aggregateQueryShares(rows: readonly SqpShareInput[]): Map<string, { brand: number; total: number; sharePct: number; asinRows: number }> {
  const agg = new Map<string, { brand: number; total: number; asinRows: number }>()
  for (const r of rows) {
    const q = (r.searchQuery ?? '').trim().toLowerCase()
    if (!q) continue
    const a = agg.get(q) ?? { brand: 0, total: 0, asinRows: 0 }
    a.brand += r.impressionsBrand ?? 0
    a.total = Math.max(a.total, r.impressionsTotal ?? 0)
    a.asinRows += 1
    agg.set(q, a)
  }
  const out = new Map<string, { brand: number; total: number; sharePct: number; asinRows: number }>()
  for (const [q, a] of agg) {
    if (a.total <= 0) continue
    out.set(q, { brand: a.brand, total: a.total, sharePct: a.brand / a.total, asinRows: a.asinRows })
  }
  return out
}

/**
 * Amazon's own per-query market impression share, per marketplace, on the gate's chosen week.
 *
 * `now` is injectable so the gate's choice is testable without the clock — the same reason
 * `chooseViewPeriod` takes it.
 */
export async function keywordMarketShares(
  opts: { markets?: readonly string[]; now?: number; lookbackDays?: number } = {},
): Promise<SovKeywordShareResult> {
  const markets = opts.markets ?? SOV_MARKETS
  const now = opts.now ?? Date.now()
  // The page's own default window, so the engine reads the week the report would render.
  const lookbackDays = opts.lookbackDays ?? SOV_DEFAULT_WEEKS * 7

  const byKey = new Map<string, SovKeywordShareRow>()
  const periods: SovMarketPeriod[] = []
  const measuredMarkets: string[] = []

  for (const marketplace of markets) {
    const groups = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'],
      where: { marketplace },
      _count: { _all: true },
    })
    if (!groups.length) {
      periods.push({
        marketplace, start: null, ageDays: null, rows: 0, baselineRows: 0, threshold: 0,
        reason: 'no-data', refused: true, queries: 0,
      })
      continue
    }

    // Row ratio, not the ASIN floor: Share of Voice is the caller `chooseViewPeriod`'s own comment
    // names as staying on the ratio deliberately. Passing `floorAsins` here would move a gate this
    // service does not own.
    const gate = chooseViewPeriod(
      groups.map((g) => ({ start: g.startDate, rows: g._count._all })),
      { lookbackDays, now },
    )

    const refused = gate.reason !== 'complete' || gate.start == null
    const ageDays = gate.start ? Math.floor((now - +gate.start) / DAY) : null

    if (refused || !gate.start) {
      periods.push({
        marketplace, start: gate.start, ageDays, rows: gate.rows, baselineRows: gate.baselineRows,
        threshold: gate.threshold, reason: gate.reason, refused: true, queries: 0,
      })
      continue
    }

    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace, startDate: gate.start },
      select: { searchQuery: true, impressionsBrand: true, impressionsTotal: true },
    })

    const agg = aggregateQueryShares(rows)
    for (const [query, a] of agg) {
      byKey.set(sovShareKey(marketplace, query), {
        marketplace,
        query,
        impressionsBrand: a.brand,
        impressionsTotal: a.total,
        sharePct: a.sharePct,
        asinRows: a.asinRows,
      })
    }
    const measured = agg.size

    if (measured > 0) measuredMarkets.push(marketplace)
    periods.push({
      marketplace, start: gate.start, ageDays, rows: gate.rows, baselineRows: gate.baselineRows,
      threshold: gate.threshold, reason: gate.reason, refused: false, queries: measured,
    })
  }

  return { byKey, periods, measuredMarkets }
}

/**
 * SOV-P3 — the tab's one-line census.
 *
 * The Share of Voice tab used to state nothing at all: an empty grid, an empty state, and 280px of
 * dead space. An operator about to write their first SOV rule had no way to answer the two
 * questions that decide whether the rule can work — *how many of my keywords does Amazon even
 * report a market share for*, and *how old is that reading* — and no way to pick a threshold,
 * because the distribution was invisible.
 *
 * Every number here is measured on the same call the ENGINE makes, so the strip and the rule cannot
 * disagree. On a failed read the client renders NOTHING rather than a fabricated zero.
 */
/** The four counts, computed identically for the account and for one market. */
export interface SovStripCounts {
  /** ENABLED positive keyword targets — the population a SOV rule may consider. */
  enabledKeywords: number
  /** Of those, how many carry a market share on the gate's chosen week. */
  measured: number
  /** Median share among the measured, as a fraction. Null when nothing is measured. */
  medianPct: number | null
  /** How many measured keywords sit under 1 % of their market — the tail a rule usually targets. */
  underOnePct: number
}

export interface SovStrip extends SovStripCounts {
  /**
   * 🔴 The SAME four counts per market, because the tab has a market selector.
   *
   * Without these the strip printed account-wide totals beside a single market's week: on
   * `?market=DE` it read "793 of 1,777 enabled keywords carry a market share · … · Amazon's week:
   * DE 2026-08-09", and every one of those numbers was the account's, not Germany's. An operator
   * reads a number next to a market name as that market's. Caught by driving the selector on the
   * local rig rather than by reading the diff.
   */
  byMarket: Record<string, SovStripCounts>
  periods: Array<{ marketplace: string; week: string | null; ageDays: number | null; refused: boolean }>
}

export async function getSovStrip(): Promise<SovStrip> {
  const shares = await keywordMarketShares()
  const targets = await prisma.adTarget.findMany({
    // Mirrors `buildSovBidContexts` exactly — if these two `where`s drift, the strip describes a
    // population no rule reads, which is the fabricated-cell class this section keeps re-shipping.
    where: { kind: 'KEYWORD', isNegative: false, status: 'ENABLED' },
    select: { expressionValue: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } },
    take: 3000,
  })
  const all: number[] = []
  const perMarket = new Map<string, { enabled: number; shares: number[] }>()
  for (const t of targets) {
    const mkt = t.adGroup?.campaign?.marketplace ?? '?'
    const bucket = perMarket.get(mkt) ?? { enabled: 0, shares: [] }
    bucket.enabled += 1
    const row = shares.byKey.get(sovShareKey(t.adGroup?.campaign?.marketplace, t.expressionValue))
    if (row) { bucket.shares.push(row.sharePct); all.push(row.sharePct) }
    perMarket.set(mkt, bucket)
  }
  const counts = (enabled: number, xs: number[]): SovStripCounts => {
    const sorted = [...xs].sort((a, b) => a - b)
    return {
      enabledKeywords: enabled,
      measured: sorted.length,
      medianPct: sorted.length ? sorted[sorted.length >> 1] : null,
      underOnePct: sorted.filter((s) => s < 0.01).length,
    }
  }
  const byMarket: Record<string, SovStripCounts> = {}
  for (const [mkt, b] of perMarket) byMarket[mkt] = counts(b.enabled, b.shares)
  return {
    ...counts(targets.length, all),
    byMarket,
    periods: shares.periods.map((p) => ({
      marketplace: p.marketplace,
      week: p.start ? p.start.toISOString().slice(0, 10) : null,
      ageDays: p.ageDays,
      refused: p.refused,
    })),
  }
}
