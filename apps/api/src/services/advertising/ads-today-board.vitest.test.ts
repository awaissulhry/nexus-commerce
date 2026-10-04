/**
 * ACR.1.4 — the Today board's judgement, pinned.
 *
 * The queries are not what can go wrong here. What can go wrong is the board losing the two
 * properties that make it worth opening: it must be able to say "nothing needs you", and it
 * must never print a confident €0 next to a problem whose cost is unknown. Both are easy to
 * break with a well-meaning `?? 0` and neither would fail a typecheck.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const queryRawUnsafe = vi.fn()
/** 7b — the waste read: one group per (target, currency) that cleared the click floor with no sale. */
const perfGroupBy = vi.fn(async (_args?: unknown) => [] as unknown[])
const counts = {
  suggestionCount: vi.fn(async () => 0),
  suggestionFirst: vi.fn(async () => null as { createdAt: Date } | null),
  campaignFindMany: vi.fn(async () => [] as unknown[]),
  campaignCount: vi.fn(async () => 0),
  mutationCount: vi.fn(async () => 0),
  mutationFirst: vi.fn(async () => null as unknown),
  cronGroupBy: vi.fn(async () => [] as unknown[]),
  cronFirst: vi.fn(async () => null as { startedAt: Date; outputSummary: string | null } | null),
  actionLogCount: vi.fn(async (_args?: unknown) => 0),
  rankFindMany: vi.fn(async () => [] as unknown[]),
}

vi.mock('../../db.js', () => ({
  default: {
    get $queryRawUnsafe() { return queryRawUnsafe },
    adsRuleSuggestion: {
      get count() { return counts.suggestionCount },
      get findFirst() { return counts.suggestionFirst },
    },
    campaign: {
      get findMany() { return counts.campaignFindMany },
      get count() { return counts.campaignCount },
    },
    adMutation: {
      get count() { return counts.mutationCount },
      get findFirst() { return counts.mutationFirst },
    },
    cronRun: { get groupBy() { return counts.cronGroupBy }, get findFirst() { return counts.cronFirst } },
    advertisingActionLog: { get count() { return counts.actionLogCount } },
    rankTarget: { get findMany() { return counts.rankFindMany } },
    amazonAdsDailyPerformance: { get groupBy() { return perfGroupBy } },
  },
}))

/** 7b — the campaign counts and bid bounds come from the census (its own tests pin them). */
const census = vi.fn(async () => ({ total: 220, archived: 1, allowlisted: 82, withMinBid: 0, withMaxBid: 0 }))
const bidBounds = vi.fn(async () => ({ noMinBid: 0, noMinBidNoMax: 0 }))
vi.mock('./ads-census.service.js', () => ({ get campaignCensus() { return census }, get allowlistedBidBounds() { return bidBounds } }))

/** `n` waste groups in one currency, spending `cents` between them. */
const wasteRows = (currency: string, n: number, cents: number) =>
  Array.from({ length: n }, (_, i) => ({
    entityId: `${currency}-t${i}`, currencyCode: currency,
    _sum: { costMicros: BigInt(i === 0 ? (cents - Math.floor(cents / n) * (n - 1)) * 10_000 : Math.floor(cents / n) * 10_000), clicks: 12, sales7dCents: 0 },
  }))

const automationState = vi.fn(async () => ({
  autonomy: 'AUTO', halted: false, haltReason: null as string | null, haltedAt: null as string | null,
  effectivelyStopped: false, degraded: false,
}))
vi.mock('./ads-automation-state.service.js', () => ({
  get getAutomationState() { return automationState },
}))

const { getTodayBoard } = await import('./ads-today-board.service.js')

/**
 * A clean account: nothing wasted, no proposals, every product costed, everything serving.
 * The raw queries are keyed off their text because the board fires several of them.
 */
function cleanAccount() {
  queryRawUnsafe.mockImplementation(async (sql: string) => {
    if (sql.includes("w->>'targetKey'")) return []
    if (sql.includes('NOT EXISTS')) return [{ n: 0 }]
    if (sql.includes('AdProductAd')) return [{ n: 200 }]
    return []
  })
  perfGroupBy.mockResolvedValue([])
}

beforeEach(() => {
  vi.clearAllMocks()
  cleanAccount()
  counts.suggestionCount.mockResolvedValue(0)
  counts.suggestionFirst.mockResolvedValue(null)
  counts.campaignFindMany.mockResolvedValue([])
  counts.campaignCount.mockResolvedValue(0)
  counts.mutationCount.mockResolvedValue(0)
  counts.mutationFirst.mockResolvedValue(null)
  counts.cronGroupBy.mockResolvedValue([])
  counts.cronFirst.mockResolvedValue(null)
  counts.actionLogCount.mockResolvedValue(0)
  counts.rankFindMany.mockResolvedValue([])
  census.mockResolvedValue({ total: 220, archived: 1, allowlisted: 82, withMinBid: 0, withMaxBid: 0 })
  bidBounds.mockResolvedValue({ noMinBid: 0, noMinBidNoMax: 0 })
  automationState.mockResolvedValue({
    autonomy: 'AUTO', halted: false, haltReason: null, haltedAt: null,
    effectivelyStopped: false, degraded: false,
  })
})

describe('the board can say nothing needs you', () => {
  it('returns zero exceptions on a clean account', async () => {
    const b = await getTodayBoard()
    expect(b.exceptions).toHaveLength(0)
    expect(b.totals).toEqual({ critical: 0, warning: 0, info: 0 })
  })

  it('reports a null headline rather than €0 when there is no waste to report', async () => {
    const b = await getTodayBoard()
    expect(b.headline.wastedSpend30dCents).toBeNull()
    expect(b.headline.note).toContain('No target took')
  })
})

describe('nothing prints a confident zero', () => {
  it('an exception with no computable cost carries null, not 0', async () => {
    counts.suggestionCount.mockResolvedValue(4)
    counts.suggestionFirst.mockResolvedValue({ createdAt: new Date('2026-08-01T00:00:00Z') })
    const b = await getTodayBoard()
    const row = b.exceptions.find((e) => e.key === 'decisions-waiting')
    expect(row).toBeDefined()
    expect(row!.amountCents).toBeNull()
    expect(row!.amountNote).not.toBe('')
  })

  it('a real waste figure is reported as measured', async () => {
    perfGroupBy.mockResolvedValue(wasteRows('EUR', 7, 7620))
    const b = await getTodayBoard()
    expect(b.headline.wastedSpend30dCents).toBe(7620)
    expect(b.exceptions.find((e) => e.key === 'wasted-spend')?.amountCents).toBe(7620)
  })
})

describe('ranking', () => {
  it('puts critical first, and orders by € inside a severity', async () => {
    // Two criticals with different costs, plus a warning that costs more than both.
    perfGroupBy.mockResolvedValue(wasteRows('EUR', 40, 50_000)) // critical, €500
    queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes("w->>'targetKey'")) return [{ window_target: 'rest-of-search', windows: 825 }]
      if (sql.includes('NOT EXISTS')) return [{ n: 0 }]
      if (sql.includes('AdProductAd')) return [{ n: 200 }]
      return []
    })
    counts.rankFindMany.mockResolvedValue([{ key: 'rest-of-search', name: 'Rest of Search', acosCapPct: 30 }])
    counts.suggestionCount.mockResolvedValue(3)

    const b = await getTodayBoard()
    const sev = b.exceptions.map((e) => e.severity)
    expect(sev.indexOf('critical')).toBe(0)
    // Priced criticals outrank unpriced ones — an unknown cost cannot claim the top slot.
    const criticals = b.exceptions.filter((e) => e.severity === 'critical')
    expect(criticals[0].amountCents).toBe(50_000)
    expect(sev.lastIndexOf('critical')).toBeLessThan(sev.indexOf('info') === -1 ? sev.length : sev.indexOf('info'))
  })

  it('a stopped account is reported, and reported first', async () => {
    automationState.mockResolvedValue({
      autonomy: 'AUTO', halted: true, haltReason: 'Automation runaway: 264 actions in the last hour.',
      haltedAt: '2026-08-05T09:00:00.000Z', effectivelyStopped: true, degraded: false,
    })
    const b = await getTodayBoard()
    expect(b.exceptions[0].key).toBe('automation-stopped')
    expect(b.exceptions[0].detail).toContain('264 actions')
    expect(b.exceptions[0].since).toBe('2026-08-05T09:00:00.000Z')
  })
})

describe('rank modes without a CPC ceiling', () => {
  it('ignores a mode nothing schedules — an unused hole is not an exposure', async () => {
    counts.rankFindMany.mockResolvedValue([{ key: 'own-top', name: 'Own Top of Search', acosCapPct: 45 }])
    queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes("w->>'targetKey'")) return [] // no windows use it
      if (sql.includes('NOT EXISTS')) return [{ n: 0 }]
      if (sql.includes('AdProductAd')) return [{ n: 200 }]
      return []
    })
    const b = await getTodayBoard()
    expect(b.exceptions.find((e) => e.key === 'rank-modes-no-cpc-ceiling')).toBeUndefined()
  })

  it('counts modes, not windows — 1,980 windows must not read as 1,980 problems', async () => {
    counts.rankFindMany.mockResolvedValue([
      { key: 'rest-of-search', name: 'Rest of Search', acosCapPct: 30 },
      { key: 'defend-top', name: 'Defend Top', acosCapPct: 35 },
    ])
    queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes("w->>'targetKey'")) return [
        { window_target: 'rest-of-search', windows: 825 },
        { window_target: 'defend-top', windows: 660 },
      ]
      if (sql.includes('NOT EXISTS')) return [{ n: 0 }]
      if (sql.includes('AdProductAd')) return [{ n: 200 }]
      return []
    })
    const b = await getTodayBoard()
    const row = b.exceptions.find((e) => e.key === 'rank-modes-no-cpc-ceiling')!
    expect(row.count).toBe(2)
    expect(row.amountNote).toContain('1,485')
    // Most-used first, so the sentence names the mode that matters.
    expect(row.detail.indexOf('Rest of Search')).toBeLessThan(row.detail.indexOf('Defend Top'))
  })
})

describe('coverage gaps', () => {
  it('is silent when the coverage week is unmeasured — a gap you cannot see is not a gap', async () => {
    // getCoverageScoreboard runs against the same mocked prisma and resolves unmeasured.
    const b = await getTodayBoard()
    expect(b.exceptions.find((e) => e.key === 'coverage-gaps')).toBeUndefined()
  })

  it('never prices a keyword we do not run — that would be a forecast', async () => {
    // Whatever else changes, this row must stay unpriced: the board reports measurements.
    const b = await getTodayBoard()
    const row = b.exceptions.find((e) => e.key === 'coverage-gaps')
    if (row) {
      expect(row.amountCents).toBeNull()
      expect(row.amountNote).toMatch(/forecast/)
    }
  })
})

describe('freshness', () => {
  it('only counts refused writes from the last 48 hours', async () => {
    counts.mutationCount.mockResolvedValue(0) // 167 older failures exist, none recent
    const b = await getTodayBoard()
    expect(b.exceptions.find((e) => e.key === 'failed-mutations')).toBeUndefined()
    expect(counts.mutationCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ state: 'FAILED' }) }),
    )
  })
})

/**
 * 7b (review 8.6) — the waste figure reads settled days per currency; the min-bid row states a maximum only when every
 * campaign has one; the 30% line names the fallback and what the Bid optimiser did.
 */
describe('7b — waste on settled days, per currency', () => {
  it('reads the settled window: no day newer than the Sponsored Products attribution lag', async () => {
    await getTodayBoard()
    const where = (perfGroupBy.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where
    expect(where.entityType).toBe('AD_TARGET')
    // Sponsored Products and the rest end at different lags, so the window is an OR of two date ranges.
    const ranges = ((where.OR as Array<{ date: { gte: Date; lte: Date } }>) ?? [where as { date: { gte: Date; lte: Date } }]).map((r) => r.date)
    const sevenDaysAgo = Date.now() - 7 * 86_400_000
    for (const r of ranges) expect(r.lte.getTime()).toBeLessThanOrEqual(sevenDaysAgo + 86_400_000)
    expect(ranges.length).toBeGreaterThan(0)
  })

  it('never adds two currencies: each is reported apart, and there is no single amount', async () => {
    perfGroupBy.mockResolvedValue([...wasteRows('EUR', 3, 24_761), ...wasteRows('GBP', 2, 1_230)])
    const b = await getTodayBoard()
    expect(b.headline.wastedSpend30dCents).toBeNull()
    expect(b.headline.wastedTargets).toBe(5)
    expect(b.headline.wasted).toEqual([
      { currency: 'EUR', cents: 24_761, targets: 3 },
      { currency: 'GBP', cents: 1_230, targets: 2 },
    ])
    const row = b.exceptions.find((e) => e.key === 'wasted-spend')!
    expect(row.amountCents).toBeNull()
    expect(row.amounts).toEqual([{ currency: 'EUR', cents: 24_761 }, { currency: 'GBP', cents: 1_230 }])
    expect(row.detail).toContain('€247.61 on 3')
    expect(row.detail).toContain('£12.30 on 2')
    expect(row.detail).not.toContain('259.91')
  })

  it('one currency keeps its single amount, and the note says what it cannot leave out', async () => {
    perfGroupBy.mockResolvedValue(wasteRows('EUR', 2, 900))
    const b = await getTodayBoard()
    expect(b.headline.wastedSpend30dCents).toBe(900)
    expect(b.headline.note).toContain('settled days')
    expect(b.headline.note).toContain('suppression floor')
    // The link stays: Recommendations is a live page.
    expect(b.exceptions.find((e) => e.key === 'wasted-spend')?.action?.href).toBe('/marketing/ads/recommendations')
  })
})

describe('7b — the no-minimum-bid row says a maximum only when there is one', () => {
  it('none of them has a maximum: it does not claim the gate enforces one', async () => {
    bidBounds.mockResolvedValue({ noMinBid: 82, noMinBidNoMax: 82 })
    const row = (await getTodayBoard()).exceptions.find((e) => e.key === 'no-min-bid')!
    expect(row.title).toBe('82 of 82 allowlisted campaigns have no minimum bid')
    expect(row.detail).not.toMatch(/enforces a maximum|Each has a maximum/)
    expect(row.detail).toContain('None of them has a maximum bid either')
  })

  it('every one has a maximum: then it says so', async () => {
    bidBounds.mockResolvedValue({ noMinBid: 5, noMinBidNoMax: 0 })
    const row = (await getTodayBoard()).exceptions.find((e) => e.key === 'no-min-bid')!
    expect(row.title).toBe('5 of 82 allowlisted campaigns have no minimum bid')
    expect(row.detail).toContain('Each has a maximum bid')
  })

  it('some have one: it names how many do not', async () => {
    bidBounds.mockResolvedValue({ noMinBid: 5, noMinBidNoMax: 3 })
    const row = (await getTodayBoard()).exceptions.find((e) => e.key === 'no-min-bid')!
    expect(row.detail).toContain('3 of them have no maximum bid either')
  })
})

describe('7b — the 30% target ACOS line', () => {
  const noCostAccount = () => queryRawUnsafe.mockImplementation(async (sql: string) => {
    if (sql.includes("w->>'targetKey'")) return []
    if (sql.includes('NOT EXISTS')) return [{ n: 12 }]
    if (sql.includes('AdProductAd')) return [{ n: 200 }]
    return []
  })

  it('names 30% as the Bid optimiser\'s fallback, and says it changed nothing when it changed nothing', async () => {
    noCostAccount()
    counts.cronFirst.mockResolvedValue({ startedAt: new Date('2026-10-04T12:20:00Z'), outputSummary: 'proposed=0 applied=0' })
    const row = (await getTodayBoard()).exceptions.find((e) => e.key === 'no-cost-data')!
    expect(row.detail).toContain('falls back to a flat 30% target ACOS')
    expect(row.detail).toContain('not a setting')
    expect(row.detail).toContain('changed no bid in the last 7 days')
    expect(row.detail).toContain('proposed=0 applied=0')
    expect(row.detail).not.toContain('Target ACOS uses the flat 30% default')
  })

  it('counts its writes by its own actor when it did act, and says when it never ran', async () => {
    noCostAccount()
    counts.cronFirst.mockResolvedValue({ startedAt: new Date('2026-10-04T12:20:00Z'), outputSummary: null })
    counts.actionLogCount.mockResolvedValue(14)
    let row = (await getTodayBoard()).exceptions.find((e) => e.key === 'no-cost-data')!
    expect(row.detail).toContain('changed 14 bids in the last 7 days')
    expect(counts.actionLogCount).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: { in: ['automation:auto-bid'] } }) }))

    counts.cronFirst.mockResolvedValue(null)
    counts.actionLogCount.mockResolvedValue(0)
    row = (await getTodayBoard()).exceptions.find((e) => e.key === 'no-cost-data')!
    expect(row.detail).toContain('The Bid optimiser has never run.')
  })
})
