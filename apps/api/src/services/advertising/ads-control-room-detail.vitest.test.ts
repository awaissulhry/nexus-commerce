/**
 * ACR.1.2e — the engine drawer's read model.
 *
 * These exist because of a defect that shipped and was invisible: `getEngineDetail` kept its
 * OWN engine→cron map beside the one in `ads-control-room.service`. Another workstream added
 * `coverage-engine` to the Levers board, the row rendered with an "Open →" like every other
 * row, and the drawer 404'd. Nothing failed — no type error, no exception, no red test. The
 * board simply looked complete while one of its rows led nowhere.
 *
 * That is the shape worth pinning: not "does the function work" but "can this file's idea of
 * the engine list drift from the list the rows are drawn from". It cannot now, because the
 * cron is read from `getEngineLevers()`. The first test below fails if anyone reintroduces a
 * local map, because the engine it asks for is deliberately absent from EVERY table in the
 * file under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cronFindMany = vi.fn(async () => [] as unknown[])
const cronGroupBy = vi.fn(async () => [] as unknown[])
const cronCount = vi.fn(async () => 0)
const actionLogFindMany = vi.fn(async () => [] as unknown[])
const campaignFindMany = vi.fn(async () => [] as unknown[])

vi.mock('../../db.js', () => ({
  default: {
    cronRun: {
      get findMany() { return cronFindMany },
      get groupBy() { return cronGroupBy },
      get count() { return cronCount },
    },
    advertisingActionLog: { get findMany() { return actionLogFindMany } },
    campaign: { get findMany() { return campaignFindMany } },
  },
}))

/**
 * The levers service is the single source of the engine list. Mocked with an engine this
 * file has never heard of — that is the whole point.
 */
const getEngineLevers = vi.fn(async () => ({
  levers: [
    { key: 'rank-defend', name: 'Rank & Dayparting', cron: 'ad-rank-defend' },
    { key: 'anomaly-guard', name: 'Anomaly breaker', cron: 'ads-anomaly-guard' },
    // Registered engine this file has NO evidence mapping for.
    { key: 'brand-new-engine', name: 'Something added next week', cron: 'a-brand-new-cron' },
    // Engine whose cron is not in the trigger registry.
    { key: 'tos-defense', name: 'Top-of-Search defense', cron: 'top-of-search-defense' },
  ],
  global: {},
}))
vi.mock('./ads-control-room.service.js', () => ({
  get getEngineLevers() { return getEngineLevers },
}))

// Only two of the four crons above are manually triggerable.
vi.mock('../../jobs/cron-registry.js', () => ({
  CRON_REGISTRY: {
    'ad-rank-defend': async () => 'ok',
    'a-brand-new-cron': async () => 'ok',
    'ads-anomaly-guard': async () => 'ok',
  },
}))

const { getEngineDetail } = await import('./ads-control-room-detail.service.js')

beforeEach(() => {
  cronFindMany.mockReset(); cronFindMany.mockResolvedValue([])
  cronGroupBy.mockReset(); cronGroupBy.mockResolvedValue([])
  cronCount.mockReset(); cronCount.mockResolvedValue(0)
  actionLogFindMany.mockReset(); actionLogFindMany.mockResolvedValue([])
  campaignFindMany.mockReset(); campaignFindMany.mockResolvedValue([])
})

describe('ACR.1.2e — the engine list cannot drift from the rows that open it', () => {
  it('THE REGRESSION: an engine this file has never heard of still resolves', async () => {
    // `brand-new-engine` appears in no map in ads-control-room-detail.service.ts. Before the
    // fix this returned null and the route answered 404 — on a row the board had just drawn.
    const d = await getEngineDetail('brand-new-engine')
    expect(d).not.toBeNull()
    expect(d!.cron).toBe('a-brand-new-cron')
  })

  it('takes the cron from the levers service, not from a local table', async () => {
    const d = await getEngineDetail('rank-defend')
    expect(d!.cron).toBe('ad-rank-defend')
    expect(getEngineLevers).toHaveBeenCalled()
  })

  it('an engine the levers service does NOT list is a 404, not an empty drawer', async () => {
    // The opposite failure: inventing a drawer for something the board never showed.
    expect(await getEngineDetail('not-an-engine')).toBeNull()
  })
})

describe('ACR.1.2e — "Run now" offers only what the trigger route will accept', () => {
  it('offers the button when the cron is in the registry the route validates against', async () => {
    const d = await getEngineDetail('rank-defend')
    expect(d!.run.available).toBe(true)
    expect(d!.run.jobName).toBe('ad-rank-defend')
  })

  it('withholds it, WITH A REASON, when the cron is not registered', async () => {
    // A button that offers to fire a job the route answers 404 for is worse than no button.
    const d = await getEngineDetail('tos-defense')
    expect(d!.run.available).toBe(false)
    expect(d!.run.jobName).toBeNull()
    expect(d!.run.why).toBeTruthy()
  })
})

describe('ACR.1.2e — the three empty states are DIFFERENT facts', () => {
  it('an engine that writes no entity rows says so, rather than showing an empty list', async () => {
    const d = await getEngineDetail('anomaly-guard')
    expect(d!.writesEntities).toBe(false)
    expect(d!.evidence).toHaveLength(0)
    expect(d!.evidenceNote).toMatch(/never writes to an entity/i)
    // It must not have gone looking for rows it cannot have.
    expect(actionLogFindMany).not.toHaveBeenCalled()
  })

  it('an engine that CAN write but has not says something different', async () => {
    const d = await getEngineDetail('rank-defend')
    expect(d!.writesEntities).toBe(true)
    expect(d!.evidenceNote).toMatch(/no bid or placement writes/i)
  })

  it('an UNMAPPED engine admits it is unmapped rather than claiming it did nothing', async () => {
    // The dangerous silence: "nothing recorded" on an engine nobody has wired up yet is a
    // claim about the account, not about this file's coverage.
    const d = await getEngineDetail('brand-new-engine')
    expect(d!.evidenceNote).toMatch(/no evidence source mapped/i)
    expect(d!.evidenceNote).not.toMatch(/^Nothing recorded/i)
  })
})

describe('ACR.1.2e — a failed run is not shown blank', () => {
  it('falls back to errorMessage when a run recorded no output summary', async () => {
    cronFindMany.mockResolvedValue([{
      id: 'r1',
      startedAt: new Date('2026-08-05T10:00:00Z'),
      finishedAt: new Date('2026-08-05T10:00:30Z'),
      status: 'FAILED',
      triggeredBy: 'cron',
      outputSummary: null,
      errorMessage: 'profiles=9 errors=9 report timed out',
    }])
    const d = await getEngineDetail('rank-defend')
    // A FAILED row with an empty output column is the failure being hidden a second time.
    expect(d!.runs[0].summary).toContain('errors=9')
    expect(d!.runs[0].durationMs).toBe(30_000)
    expect(d!.lastSummary).toContain('errors=9')
  })

  it('reports duration as null when a run has not finished, never as zero', async () => {
    cronFindMany.mockResolvedValue([{
      id: 'r2', startedAt: new Date(), finishedAt: null, status: 'RUNNING',
      triggeredBy: 'manual', outputSummary: null, errorMessage: null,
    }])
    const d = await getEngineDetail('rank-defend')
    expect(d!.runs[0].durationMs).toBeNull()
  })
})
