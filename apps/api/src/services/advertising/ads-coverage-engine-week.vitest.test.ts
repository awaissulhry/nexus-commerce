/**
 * A2 (2026-10-10) — the coverage engine's share, end to end on its own run with the database stood in.
 *
 * Before: the week was MAX(startDate) of any period (a MONTH row could pass as the newest week), with no completeness
 * gate and no age limit; the share summed every ASIN of the business into one family's bid; and the ladder stepped +12 %
 * every day on the same weekly reading, logging a 30-day window for a one-week share. Now: the SOV gate's week (WEEK
 * rows, complete, ended ≤ 14 days ago), the set's portfolio ASINs only, one share step per term per week, evidence
 * {metric:'sqp_brand_impression_share', week, ageDays}. Made-up numbers only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  weeks: [] as Array<{ startDate: Date; _count: { _all: number } }>,
  sqpCalls: [] as unknown[][],
  log: [] as Array<{ actionType: string; evidence: Record<string, unknown> }>,
  sqpRows: [] as Array<{ searchQuery: string; impressionsBrand: number; impressionsTotal: number }>,
  spendCents: 500n, salesCents: 2_000n,
}))
vi.mock('../../db.js', () => ({
  default: {
    keywordCoverageSet: {
      findMany: async () => [{ id: 'set-1', portfolioId: 'PF-1', marketplace: 'IT', name: 'jackets', enabled: true, dailySpendCapCents: null, acosCapPct: null, terms: [{ id: 'term-1', term: 'giacca moto', status: 'ACTIVE', isControl: false, targetSharePct: 3, maxCpcCents: 80 }] }],
    },
    // The set's members (status ENABLED) and familyIdentity's portfolio campaigns: one campaign.
    campaign: { findMany: async () => [{ id: 'c-1', name: 'JACKETS', externalCampaignId: 'E-1', marketplace: 'IT' }] },
    adProductAd: { findMany: async () => [{ asin: 'B0SETASIN1' }] },
    searchQueryPerformance: { groupBy: async () => h.weeks },
    // The champion target: 40¢, 30 days €5 spend / €20 sales (ACoS 25 %).
    $queryRawUnsafe: async () => [{ id: 't-1', campaign_id: 'c-1', bid: 40, spend_c: h.spendCents, sales_c: h.salesCents, impressions: 100n }],
    $queryRaw: async (...args: unknown[]) => { h.sqpCalls.push(args); return h.sqpRows },
    advertisingActionLog: {
      findMany: async () => h.log.map((r) => ({ evidence: r.evidence })),
      create: async ({ data }: { data: { actionType: string; evidence: Record<string, unknown> } }) => { h.log.push(data); return data },
    },
  },
}))
vi.mock('../automation/engine-switch.service.js', () => ({ engineMode: async (_k: string, env: string) => ({ mode: env, switched: null, note: null }) }))

const { runCoverageEngineOnce } = await import('./ads-coverage-engine.service.js')

const DAY = 86_400_000
const midnight = () => Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
/** WEEK periods starting `ago` days back (a week ends at its start + 7 days), 500 rows each. */
const weeksStarting = (...ago: number[]) => ago.map((n) => ({ startDate: new Date(midnight() - n * DAY), _count: { _all: 500 } }))
const iso = (ago: number) => new Date(midnight() - ago * DAY).toISOString().slice(0, 10)

beforeEach(() => {
  vi.stubEnv('NEXUS_COVERAGE_ENGINE_MODE', 'observe')
  h.weeks = weeksStarting(13, 20, 27, 34) // the newest ended 6 days ago
  h.sqpCalls = []
  h.log = []
  h.sqpRows = [{ searchQuery: 'Giacca moto', impressionsBrand: 10, impressionsTotal: 1_000 }] // 1 % vs a 3 % target
  h.spendCents = 500n; h.salesCents = 2_000n
})

describe('runCoverageEngineOnce — the share it reads (A2)', () => {
  it('🔴 reads the set\'s own ASINs on the gated week, steps once, and logs the week and its age (no 30-day window)', async () => {
    const r = await runCoverageEngineOnce()
    expect(r.decisions[0]).toMatchObject({ share: 0.01, shareWeek: iso(13), shareAgeDays: 6, decision: { action: 'up', nextBidCents: 45, basis: 'share' } })
    // The SQP read names the set's portfolio ASINs and its terms — not every ASIN of the business.
    const params = h.sqpCalls[0].slice(1)
    expect(params).toContainEqual(['B0SETASIN1'])
    expect(params).toContainEqual(['giacca moto'])
    expect(h.log).toHaveLength(1)
    expect(h.log[0].evidence).toMatchObject({ metric: 'sqp_brand_impression_share', observed: '1.00%', threshold: '3%', week: iso(13), ageDays: 6, setId: 'set-1', term: 'giacca moto' })
    expect(h.log[0].evidence).not.toHaveProperty('windowDays')
  })

  it('🔴 the next day on the same week: holds, saying so — it used to step +12 % every day on one weekly reading', async () => {
    await runCoverageEngineOnce()
    const again = await runCoverageEngineOnce()
    expect(again.decisions[0].decision).toMatchObject({ action: 'hold', basis: 'share' })
    expect(again.decisions[0].decision.reason).toContain('already stepped on this week')
    expect(h.log).toHaveLength(1)
    // a newer week arrives → steps again
    h.weeks = weeksStarting(6, 13, 20, 27)
    const next = await runCoverageEngineOnce()
    expect(next.decisions[0]).toMatchObject({ shareWeek: iso(6), decision: { action: 'up' } })
    expect(h.log).toHaveLength(2)
  })

  it('🔴 the newest complete week ended 20 days ago → unmeasured, holds, says why; nothing read for it', async () => {
    h.weeks = weeksStarting(27, 34, 41, 48)
    const r = await runCoverageEngineOnce()
    expect(r.decisions[0]).toMatchObject({ share: null, shareWeek: null, decision: { action: 'hold', basis: 'none' } })
    expect(r.decisions[0].decision.reason).toBe(`share unmeasured — IT: the newest complete Brand Analytics week (week of ${iso(27)}) ended 20 days ago; shares older than 14 days are not used`)
    expect(h.sqpCalls).toHaveLength(0)
    expect(h.log).toHaveLength(0)
  })

  it('the set\'s ASINs have no row for the term on that week → unmeasured, said', async () => {
    h.sqpRows = []
    const r = await runCoverageEngineOnce()
    expect(r.decisions[0].decision.reason).toBe(`share unmeasured — the set's ASINs have no Brand Analytics row with a market total for this term in the week of ${iso(13)}`)
  })

  it('the waste guard still acts on a day the share already stepped this week, with its own 30-day evidence', async () => {
    await runCoverageEngineOnce()
    h.spendCents = 2_500n; h.salesCents = 0n
    const r = await runCoverageEngineOnce()
    expect(r.decisions[0].decision).toMatchObject({ action: 'down', basis: 'waste' })
    expect(h.log[1].evidence).toMatchObject({ metric: 'spend_without_sales_30d', windowDays: 30, term: 'giacca moto' })
  })
})
