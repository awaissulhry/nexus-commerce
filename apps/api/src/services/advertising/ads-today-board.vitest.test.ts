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
const counts = {
  suggestionCount: vi.fn(async () => 0),
  suggestionFirst: vi.fn(async () => null as { createdAt: Date } | null),
  campaignFindMany: vi.fn(async () => [] as unknown[]),
  campaignCount: vi.fn(async () => 0),
  mutationCount: vi.fn(async () => 0),
  mutationFirst: vi.fn(async () => null as unknown),
  cronGroupBy: vi.fn(async () => [] as unknown[]),
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
    cronRun: { get groupBy() { return counts.cronGroupBy } },
    rankTarget: { get findMany() { return counts.rankFindMany } },
  },
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
    if (sql.includes('HAVING SUM(d.clicks)')) return [{ spend_c: 0, targets: 0 }]
    if (sql.includes("w->>'targetKey'")) return []
    if (sql.includes('NOT EXISTS')) return [{ n: 0 }]
    if (sql.includes('AdProductAd')) return [{ n: 200 }]
    return []
  })
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
  counts.rankFindMany.mockResolvedValue([])
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
    queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('HAVING SUM(d.clicks)')) return [{ spend_c: 7620, targets: 7 }]
      if (sql.includes("w->>'targetKey'")) return []
      if (sql.includes('NOT EXISTS')) return [{ n: 0 }]
      if (sql.includes('AdProductAd')) return [{ n: 200 }]
      return []
    })
    const b = await getTodayBoard()
    expect(b.headline.wastedSpend30dCents).toBe(7620)
    expect(b.exceptions.find((e) => e.key === 'wasted-spend')?.amountCents).toBe(7620)
  })
})

describe('ranking', () => {
  it('puts critical first, and orders by € inside a severity', async () => {
    // Two criticals with different costs, plus a warning that costs more than both.
    queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('HAVING SUM(d.clicks)')) return [{ spend_c: 50_000, targets: 40 }] // critical, €500
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
      if (sql.includes('HAVING SUM(d.clicks)')) return [{ spend_c: 0, targets: 0 }]
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
      if (sql.includes('HAVING SUM(d.clicks)')) return [{ spend_c: 0, targets: 0 }]
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
