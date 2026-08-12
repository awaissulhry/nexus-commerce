/**
 * KT.1 / KT.1b — the two decisions the Keyword Tracker page rests on.
 *
 * Every fixture number below is real prod data, measured with `_kt1-probe.mts`,
 * `_kt1-period.mts` (2026-08-11) and `_kt1b-period-gate.mts` (2026-08-12):
 *   · 220 campaigns, of which only 72 carry a portfolioId — the portfolio grain's hole;
 *   · 1 of IT's 150 campaigns is ARCHIVED, which used to inflate the count the page prints;
 *   · the per-market SQP period row counts, verbatim, for all four markets.
 *
 * `chooseViewPeriod` replaced KT.1's `pickTermPeriod`, which had four tests and none of them could
 * have caught the defect: it was asked "which period holds this term" and answered correctly. The
 * question that mattered — "may two rows of one grid come from different periods" — was never put
 * to a test, and the 56-day bound it depended on had no coverage at all because it lived in the
 * orchestrator. These tests put both questions.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

const { resolveScope, chooseViewPeriod, projectCliff, KT_LOOKBACK_DAYS, SQP_COMPLETENESS_RATIO } = await import('./keyword-tracker.service.js')

const D = (s: string) => new Date(`${s}T00:00:00.000Z`)

const graph = {
  campaigns: [
    { id: 'c-it-gale-1', name: 'IT GALE 1', marketplace: 'IT', portfolioId: 'pf-gale' },
    { id: 'c-it-gale-2', name: 'IT GALE 2', marketplace: 'IT', portfolioId: 'pf-gale' },
    { id: 'c-it-loose', name: 'IT no portfolio', marketplace: 'IT', portfolioId: null },
    { id: 'c-it-loose-2', name: 'IT no portfolio 2', marketplace: 'IT', portfolioId: null },
    { id: 'c-de-gale', name: 'DE GALE', marketplace: 'DE', portfolioId: 'pf-gale-de' },
  ],
  ads: [
    { productId: 'p-gale-s', asin: 'ASIN-GALE-S', campaignId: 'c-it-gale-1' },
    { productId: 'p-gale-m', asin: 'ASIN-GALE-M', campaignId: 'c-it-gale-2' },
    { productId: 'p-moss-s', asin: 'ASIN-MOSS-S', campaignId: 'c-it-loose' },
    // the same child advertised in two campaigns — one ASIN, not two
    { productId: 'p-gale-s', asin: 'ASIN-GALE-S', campaignId: 'c-it-loose-2' },
    { productId: 'p-gale-s', asin: 'ASIN-GALE-S-DE', campaignId: 'c-de-gale' },
  ],
  products: [
    { id: 'p-gale-s', parentId: 'line-gale' },
    { id: 'p-gale-m', parentId: 'line-gale' },
    { id: 'p-moss-s', parentId: 'line-moss' },
  ],
}

describe('resolveScope', () => {
  it('market scope takes every campaign in the market and does not restrict ASINs', () => {
    const s = resolveScope(graph, { market: 'IT' })
    expect(s.boundBy).toBe('market')
    expect(s.campaignIds).toHaveLength(4)
    expect(s.asinScoped).toBe(false)
  })

  it('never crosses a market boundary — DE campaigns and DE ASINs stay out of an IT scope', () => {
    const s = resolveScope(graph, { market: 'IT' })
    expect(s.campaignIds).not.toContain('c-de-gale')
    expect(s.asins).not.toContain('ASIN-GALE-S-DE')
  })

  it('a line resolves through Product.parentId to its children ASINs, deduplicated', () => {
    const s = resolveScope(graph, { market: 'IT', line: 'line-gale' })
    expect(s.boundBy).toBe('line')
    expect(s.asins).toEqual(['ASIN-GALE-M', 'ASIN-GALE-S'])
    // one ASIN advertised in two campaigns pulls BOTH campaigns into the scope
    expect(s.campaignIds.sort()).toEqual(['c-it-gale-1', 'c-it-gale-2', 'c-it-loose-2'])
    expect(s.asinScoped).toBe(true)
  })

  it('a portfolio resolves through the EXTERNAL portfolio id on Campaign', () => {
    const s = resolveScope(graph, { market: 'IT', portfolio: 'pf-gale' })
    expect(s.boundBy).toBe('portfolio')
    expect(s.campaignIds).toEqual(['c-it-gale-1', 'c-it-gale-2'])
    expect(s.asins).toEqual(['ASIN-GALE-M', 'ASIN-GALE-S'])
  })

  it('states what the portfolio grain cannot reach — the campaigns carrying no portfolio', () => {
    const s = resolveScope(graph, { market: 'IT', portfolio: 'pf-gale' })
    expect(s.campaignsInMarket).toBe(4)
    expect(s.campaignsWithoutPortfolio).toBe(2)
  })

  it('most specific wins: a campaign overrides a portfolio and a line supplied with it', () => {
    const s = resolveScope(graph, { market: 'IT', line: 'line-moss', portfolio: 'pf-gale', campaign: 'c-it-gale-1' })
    expect(s.boundBy).toBe('campaign')
    expect(s.campaignIds).toEqual(['c-it-gale-1'])
    expect(s.asins).toEqual(['ASIN-GALE-S'])
  })

  it('a campaign from another market resolves to nothing rather than silently ignoring the market', () => {
    const s = resolveScope(graph, { market: 'IT', campaign: 'c-de-gale' })
    expect(s.campaignIds).toEqual([])
    expect(s.asins).toEqual([])
    expect(s.asinScoped).toBe(true)
  })
})

describe('resolveScope · ARCHIVED campaigns (KT.1b)', () => {
  const withArchived = {
    ...graph,
    campaigns: [
      ...graph.campaigns.map((c) => ({ ...c, status: 'ENABLED' })),
      { id: 'c-it-dead', name: 'IT archived', marketplace: 'IT', portfolioId: null, status: 'ARCHIVED' },
    ],
    ads: [...graph.ads, { productId: 'p-moss-s', asin: 'ASIN-DEAD-ONLY', campaignId: 'c-it-dead' }],
  }

  it('leaves an archived campaign out of the market count and out of market scope', () => {
    const s = resolveScope(withArchived, { market: 'IT' })
    expect(s.campaignsInMarket).toBe(4)          // not 5
    expect(s.campaignIds).not.toContain('c-it-dead')
    expect(s.asins).not.toContain('ASIN-DEAD-ONLY')
  })

  it('leaves it out of the portfolio grain\'s "cannot reach" figure too', () => {
    // 2 of the 4 live IT campaigns carry no portfolio. The archived one must not become a third.
    expect(resolveScope(withArchived, { market: 'IT', portfolio: 'pf-gale' }).campaignsWithoutPortfolio).toBe(2)
  })

  it('still resolves an archived campaign picked EXPLICITLY, rather than silently emptying the view', () => {
    // the picker is fed by /advertising/scope-options, which is unfiltered and another session's
    const s = resolveScope(withArchived, { market: 'IT', campaign: 'c-it-dead' })
    expect(s.campaignIds).toEqual(['c-it-dead'])
    expect(s.asins).toEqual(['ASIN-DEAD-ONLY'])
  })
})

/**
 * The real per-market period shapes, 2026-08-12. `now` is injected so these never rot.
 * IT median 655 · DE 428 · ES 414 · FR 69 (median of the last 12 periods).
 */
const NOW = D('2026-08-12').getTime()
const P = (rows: Array<[string, number]>) => rows.map(([d, r]) => ({ start: D(d), rows: r }))

const IT = P([['2026-07-26', 8], ['2026-07-19', 655], ['2026-07-12', 1066], ['2026-07-05', 989],
  ['2026-06-28', 857], ['2026-06-21', 1042], ['2026-06-14', 921], ['2026-06-07', 462],
  ['2026-05-31', 158], ['2026-05-24', 376], ['2026-05-17', 1]])
const DE = P([['2026-07-26', 5], ['2026-07-19', 364], ['2026-07-12', 675], ['2026-07-05', 438],
  ['2026-06-28', 428], ['2026-06-21', 729], ['2026-06-14', 776], ['2026-06-07', 234], ['2026-05-31', 84]])
const ES = P([['2026-07-26', 71], ['2026-07-19', 193], ['2026-07-12', 443], ['2026-07-05', 354],
  ['2026-06-28', 414], ['2026-06-21', 544], ['2026-06-14', 465], ['2026-06-07', 290],
  ['2026-05-31', 433], ['2026-05-24', 569], ['2026-05-17', 124]])
const FR = P([['2026-07-26', 1], ['2026-07-19', 4], ['2026-07-12', 42], ['2026-07-05', 44],
  ['2026-06-28', 69], ['2026-06-21', 85], ['2026-06-14', 106], ['2026-06-07', 61],
  ['2026-05-31', 135], ['2026-05-24', 177], ['2026-05-17', 183]])

describe('chooseViewPeriod', () => {
  it('refuses the truncated newest week in EVERY market — the defect, at the shipped constants', () => {
    for (const [label, periods] of [['IT', IT], ['DE', DE], ['ES', ES], ['FR', FR]] as const) {
      const c = chooseViewPeriod(periods, { now: NOW })
      expect(c.start, label).not.toEqual(D('2026-07-26'))
      expect(c.rejected.some((r) => r.start === '2026-07-26'), label).toBe(true)
    }
  })

  it('picks the newest COMPLETE week per market, at the shipped constants', () => {
    expect(chooseViewPeriod(IT, { now: NOW }).start).toEqual(D('2026-07-19'))
    expect(chooseViewPeriod(DE, { now: NOW }).start).toEqual(D('2026-07-19'))
    // ES 2026-07-19 holds 193 of a 414-row normal week — 47%, under the half-a-week gate
    expect(chooseViewPeriod(ES, { now: NOW }).start).toEqual(D('2026-07-12'))
    expect(chooseViewPeriod(FR, { now: NOW }).start).toEqual(D('2026-07-12'))
    for (const periods of [IT, DE, ES, FR]) {
      expect(chooseViewPeriod(periods, { now: NOW }).truncated).toBe(false)
      expect(chooseViewPeriod(periods, { now: NOW }).reason).toBe('complete')
    }
  })

  it('reports the gate it applied, so the page can show its working', () => {
    const c = chooseViewPeriod(IT, { now: NOW })
    expect(c.baselineRows).toBe(655)
    expect(c.threshold).toBe(655 * SQP_COMPLETENESS_RATIO)
    expect(c.rows).toBe(655)
  })

  it('the BASELINE median is wider than the lookback on purpose — a local median accepts what it should reject', () => {
    // ES at ratio 0.5 over 28 days. Local median of [71, 193] = 132 ⇒ 71 clears 66 and the
    // truncated week wins. The wider baseline (414) rejects both and says so.
    const local = chooseViewPeriod(ES, { now: NOW, lookbackDays: 28, baselinePeriods: 2 })
    expect(local.start).toEqual(D('2026-07-26'))
    const baseline = chooseViewPeriod(ES, { now: NOW, lookbackDays: 28 })
    expect(baseline.truncated).toBe(true)
    expect(baseline.reason).toBe('incomplete-week')
  })

  it('42 and 56 days agree in all four markets today — which is why the bound is the tighter one', () => {
    for (const periods of [IT, DE, ES, FR]) {
      expect(chooseViewPeriod(periods, { now: NOW, lookbackDays: 56 }).start)
        .toEqual(chooseViewPeriod(periods, { now: NOW, lookbackDays: 42 }).start)
    }
    expect(KT_LOOKBACK_DAYS).toBe(42)
  })

  it('falls back LOUDLY rather than rendering nothing when no week qualifies', () => {
    const c = chooseViewPeriod(FR, { now: NOW, lookbackDays: 28 })
    expect(c.start).toEqual(D('2026-07-26'))   // the newest thing inside the window
    expect(c.truncated).toBe(true)
    expect(c.reason).toBe('incomplete-week')
    expect(c.rejected).toEqual([])             // nothing was skipped to get here — it IS the newest
  })

  it('distinguishes "the newest week is partial" from "there is no week in the window at all"', () => {
    const stale = chooseViewPeriod(P([['2026-05-31', 900], ['2026-05-24', 880]]), { now: NOW })
    expect(stale.reason).toBe('outside-lookback')
    expect(stale.truncated).toBe(true)
    expect(stale.start).toEqual(D('2026-05-31'))
  })

  it('a market with no SQP rows at all is no-data, not a crash', () => {
    const c = chooseViewPeriod([], { now: NOW })
    expect(c).toMatchObject({ start: null, reason: 'no-data', truncated: true, rows: 0, baselineRows: 0 })
  })

  it('takes the newest qualifying period even when an older one is bigger', () => {
    // 07-19 (655) qualifies; 07-12 (1066) is bigger and must NOT win on size
    expect(chooseViewPeriod(IT, { now: NOW }).start).toEqual(D('2026-07-19'))
  })
})

/**
 * KT.5 — the cliff, as a date.
 *
 * Every expectation below is the measured prod shape on 2026-08-12 with `now` injected, so these
 * pin the arithmetic rather than the calendar. The reason this needs a test at all: the answer is
 * counter-intuitive. The gate never renders an empty grid, so a market does not "go blank" — it
 * COLLAPSES to a thinner week first, and that earlier date is the one an operator needs. My own
 * first measurement found only the second date and reported 26 days when the real answer was 19.
 */
describe('projectCliff', () => {
  it('names the COLLAPSE date, not just the day nothing is in the window', () => {
    // IT chooses 2026-07-19 (655 rows). 07-19 + 42d = 08-30, so on 08-31 it ages out and the only
    // period left inside the window is the 8-row 07-26 week.
    const c = projectCliff(IT, { now: NOW })
    expect(c.collapseOn).toBe('2026-08-31')
    expect(c.collapseToPeriod).toBe('2026-07-26')
    // and the row count of the week it falls back to, so the warning can be concrete
    expect(c.collapseToRows).toBe(8)
    expect(c.blankOn).toBe('2026-09-07')
  })

  it('gives ES and FR an EARLIER collapse, because they are already reading an older week', () => {
    // both chose 2026-07-12; + 42d = 08-23, so 08-24
    for (const periods of [ES, FR]) {
      expect(projectCliff(periods, { now: NOW }).collapseOn).toBe('2026-08-24')
    }
  })

  it('all four markets lose every in-window week on the same day', () => {
    for (const periods of [IT, DE, ES, FR]) {
      expect(projectCliff(periods, { now: NOW }).blankOn).toBe('2026-09-07')
    }
  })

  it('a complete week landing later moves both dates forward', () => {
    const withFresh = [{ start: D('2026-08-09'), rows: 700 }, ...IT]
    const c = projectCliff(withFresh, { now: NOW })
    expect(c.collapseOn! > '2026-08-31').toBe(true)
    expect(c.blankOn! > '2026-09-07').toBe(true)
  })

  it('no periods at all is not a crash', () => {
    expect(projectCliff([], { now: NOW })).toEqual({ collapseOn: null, collapseToPeriod: null, collapseToRows: 0, blankOn: null })
  })

  it('the collapse date is derived from the LOOKBACK, not hard-coded', () => {
    // a 56-day lookback pushes IT's collapse out by exactly the 14-day difference
    expect(projectCliff(IT, { now: NOW, lookbackDays: 56 }).collapseOn).toBe('2026-09-14')
  })
})
