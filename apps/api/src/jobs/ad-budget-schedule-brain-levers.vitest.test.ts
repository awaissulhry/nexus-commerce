/**
 * ONE BRAIN AB-6 — a budget schedule leaves a daily budget a product's brain owns (or the Owner holds at his own value):
 *   window     entering a window on a held campaign writes nothing; the other campaign of the schedule as before
 *   give-back  a give-back owed on a held campaign waits: the memo is carried as it was (written when the lever is free)
 *   summary    the run line counts the skips per lever; one read for every campaign of every schedule
 *   today      nothing enrolled: every write as before, the line unchanged
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  schedules: vi.fn(),
  campaign: vi.fn(),
  scheduleUpdate: vi.fn(),
  update: vi.fn(),
  campaignLeverOwners: vi.fn(),
  anyBrainEnrolled: vi.fn(),
}))
vi.mock('../db.js', () => ({
  default: {
    budgetSchedule: { findMany: h.schedules, update: h.scheduleUpdate },
    campaign: { findUnique: h.campaign },
    outboundSyncQueue: { findMany: vi.fn(async () => []) },
    automationRule: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  },
}))
vi.mock('../services/advertising/ads-mutation.service.js', () => ({ updateCampaignWithSync: h.update }))
vi.mock('../services/advertising/ads-engine-guard.js', () => ({
  openEngineGuard: async () => ({ permit: () => ({ forward: true }), settle: () => {}, report: () => undefined }),
  allowChange: () => true,
  nothingHeld: () => ({}),
  engineGuardNote: () => '',
}))
vi.mock('../services/advertising/brain/lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => h.anyBrainEnrolled(...a),
}))

const { runBudgetScheduleOnce, budgetScheduleSummaryLine } = await import('./ad-budget-schedule.job.js')

const MONDAY = new Date('2026-10-05T10:00:00Z')
const TUESDAY = new Date('2026-10-06T10:00:00Z')
const KEY = '2026-10-05#1||||incPct|50'
const OWNED = { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override' }
const schedule = (lastApplied: Record<string, unknown> = {}) => ({
  id: 's1', kind: 'BUDGET', type: 'CAMPAIGN_BUDGET', enabled: true, timezone: 'Europe/Rome', startDate: null, endDate: null, neverExpire: true, excludeDates: [],
  windows: [{ day: 1, adj: 'incPct', value: 50 }], campaigns: [{ id: 'c-gale' }, { id: 'c-misano' }], lastApplied, createdAt: new Date('2026-09-01'),
})
const lastOf = () => (h.scheduleUpdate.mock.calls[0][0] as { data: { lastApplied: Record<string, unknown> } }).data.lastApplied

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.anyBrainEnrolled.mockResolvedValue(true)
  h.campaignLeverOwners.mockResolvedValue(new Map())
  h.campaign.mockResolvedValue({ dailyBudget: '10.00', status: 'ENABLED' })
  h.update.mockResolvedValue({ ok: true, outboundQueueId: 'q1', actionLogId: 'l1' })
})
afterEach(() => vi.unstubAllEnvs())

describe('AB-6 — budget schedules leave a held daily budget', () => {
  it('entering a window: the held campaign is left, the other written; counted in the line; one read', async () => {
    h.schedules.mockResolvedValue([schedule()])
    h.campaignLeverOwners.mockResolvedValue(new Map([['c-gale', { campaignId: 'c-gale', name: 'GALE', market: 'IT', levers: { budgets: OWNED } }]]))
    const r = await runBudgetScheduleOnce(MONDAY)
    expect(h.campaignLeverOwners).toHaveBeenCalledTimes(1)
    expect(h.campaignLeverOwners).toHaveBeenCalledWith(['c-gale', 'c-misano'])
    expect(h.update).toHaveBeenCalledTimes(1)
    expect(h.update.mock.calls[0][0]).toMatchObject({ campaignId: 'c-misano', patch: { dailyBudget: 15 } })
    expect(r).toMatchObject({ changed: 1, leverHeld: { budgets: 1 } })
    expect(lastOf()).not.toHaveProperty('c-gale') // nothing committed: the window is entered on the first run allowed to
    expect(budgetScheduleSummaryLine(r)).toBe('evaluated=1 changed=1 yielded=0 refused=0 brain-levers=budgets:1 (left to a product\'s brain or the Owner\'s lock)')
  })

  it('a give-back owed on a held campaign waits: the memo is carried unchanged, nothing written', async () => {
    const entered = { budget: 15, at: '2026-10-05T08:00:00Z', state: 'applied', live: 10, windowKey: KEY, baseCents: 1000, ownCents: 1500, outboundQueueId: 'q-enter' }
    h.schedules.mockResolvedValue([schedule({ 'c-gale': entered })])
    h.campaign.mockResolvedValue({ dailyBudget: '15.00', status: 'ENABLED' })
    h.campaignLeverOwners.mockResolvedValue(new Map([['c-gale', { campaignId: 'c-gale', name: 'GALE', market: 'IT', levers: { budgets: { ...OWNED, kind: 'locked' } } }]]))
    const r = await runBudgetScheduleOnce(TUESDAY)
    expect(h.update).not.toHaveBeenCalled()
    expect(lastOf()['c-gale']).toEqual(entered)
    expect(r.leverHeld).toEqual({ budgets: 1 })
  })

  it('nothing enrolled (production today): both written as before, the line unchanged', async () => {
    h.schedules.mockResolvedValue([schedule()])
    h.anyBrainEnrolled.mockResolvedValue(false)
    const r = await runBudgetScheduleOnce(MONDAY)
    expect(h.update).toHaveBeenCalledTimes(2)
    expect(r).toEqual({ evaluated: 1, changed: 2, yielded: 0, refused: 0 })
    expect(budgetScheduleSummaryLine(r)).toBe('evaluated=1 changed=2 yielded=0 refused=0')
  })

  it('who holds the budgets cannot be read: nothing skipped on a guess, the line says unread', async () => {
    h.schedules.mockResolvedValue([schedule()])
    h.campaignLeverOwners.mockRejectedValue(new Error('db blip'))
    const r = await runBudgetScheduleOnce(MONDAY)
    expect(h.update).toHaveBeenCalledTimes(2)
    expect(budgetScheduleSummaryLine(r)).toContain('brain-levers=unread')
  })
})
