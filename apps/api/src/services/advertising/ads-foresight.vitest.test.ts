/**
 * ACR.1.5 — Foresight's judgement, pinned.
 *
 * What can break here is not the SQL. It is the tab quietly starting to claim more certainty
 * than it has: reporting bid changes on a stopped account as if they will happen, counting a
 * hand-over in hour 0 that it cannot know about, or letting the two "no ceiling" vocabularies
 * drift apart again so this tab and Today describe one fact with two different numbers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const queryRawUnsafe = vi.fn()
const scheduleFindMany = vi.fn(async () => [] as unknown[])
const scheduleCount = vi.fn(async () => 0)
const rankFindMany = vi.fn(async () => [] as unknown[])

vi.mock('../../db.js', () => ({
  default: {
    get $queryRawUnsafe() { return queryRawUnsafe },
    adSchedule: { get findMany() { return scheduleFindMany }, get count() { return scheduleCount } },
    rankTarget: { get findMany() { return rankFindMany } },
  },
}))

const automationState = vi.fn(async () => ({
  autonomy: 'AUTO', halted: false, haltReason: null as string | null, haltedAt: null as string | null,
  effectivelyStopped: false, degraded: false,
}))
vi.mock('./ads-automation-state.service.js', () => ({
  get getAutomationState() { return automationState },
}))

const { getForesight } = await import('./ads-foresight.service.js')

/** 24 hourly slots starting Wednesday 2026-08-05 00:00 Europe/Rome. */
function slots() {
  const out: { at: Date; dow: number; hour: number }[] = []
  for (let h = 0; h < 24; h++) {
    out.push({ at: new Date(Date.UTC(2026, 7, 5, h, 0, 0)), dow: 3, hour: h })
  }
  return out
}

/** Two modes: one with a ceiling, one without — the distinction the whole tab turns on. */
const TARGETS = [
  { key: 'own-top-allout', name: 'Own Top — All-Out', color: null, biasPct: 300, maxBiasPct: null, maxCpcCents: 200, acosCapPct: null, allOut: true, pause: false },
  { key: 'defend-top', name: 'Defend Top', color: null, biasPct: 75, maxBiasPct: null, maxCpcCents: null, acosCapPct: 35, allOut: false, pause: false },
  { key: 'pause', name: 'Min bid', color: null, biasPct: null, maxBiasPct: null, maxCpcCents: null, acosCapPct: null, allOut: false, pause: true },
]

/** Hours 0-11 all-out, 12-23 defend-top — one hand-over, at hour 12. */
const SPLIT_WINDOWS = [
  { days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 12, targetKey: 'own-top-allout' },
  { days: [0, 1, 2, 3, 4, 5, 6], startHour: 12, endHour: 24, targetKey: 'defend-top' },
]

beforeEach(() => {
  vi.clearAllMocks()
  queryRawUnsafe.mockResolvedValue(slots())
  scheduleFindMany.mockResolvedValue([])
  scheduleCount.mockResolvedValue(0)
  rankFindMany.mockResolvedValue(TARGETS)
  automationState.mockResolvedValue({
    autonomy: 'AUTO', halted: false, haltReason: null, haltedAt: null,
    effectivelyStopped: false, degraded: false,
  })
})

describe('scheduled bid changes', () => {
  it('counts one hand-over per schedule per boundary', async () => {
    scheduleFindMany.mockResolvedValue([
      { id: 's1', name: 'A', campaignId: 'c1', windows: SPLIT_WINDOWS, defaultTargetKey: 'defend-top', timezone: 'Europe/Rome' },
      { id: 's2', name: 'B', campaignId: 'c2', windows: SPLIT_WINDOWS, defaultTargetKey: 'defend-top', timezone: 'Europe/Rome' },
    ])
    scheduleCount.mockResolvedValue(2)
    const f = await getForesight()
    expect(f.scheduledBidChanges).toBe(2) // one boundary, two schedules
    expect(f.hours[12].bidChanges).toBe(2)
  })

  it('never claims a change in hour 0 — there is no previous hour to compare against', async () => {
    scheduleFindMany.mockResolvedValue([
      { id: 's1', name: 'A', campaignId: 'c1', windows: SPLIT_WINDOWS, defaultTargetKey: 'defend-top', timezone: 'Europe/Rome' },
    ])
    const f = await getForesight()
    expect(f.hours[0].bidChanges).toBe(0)
  })

  it('reports null, not a number, when the account is stopped', async () => {
    scheduleFindMany.mockResolvedValue([
      { id: 's1', name: 'A', campaignId: 'c1', windows: SPLIT_WINDOWS, defaultTargetKey: 'defend-top', timezone: 'Europe/Rome' },
    ])
    automationState.mockResolvedValue({
      autonomy: 'AUTO', halted: true, haltReason: 'Automation runaway: 264 actions in the last hour.',
      haltedAt: '2026-08-05T09:00:00.000Z', effectivelyStopped: true, degraded: false,
    })
    const f = await getForesight()
    expect(f.scheduledBidChanges).toBeNull()
    expect(f.accountStopped).toBe(true)
    // The hours still carry their counts — the rehearsal is useful, the headline claim is not.
    expect(f.hours[12].bidChanges).toBe(1)
    expect(f.notes.join(' ')).toContain('rehearsal')
  })
})

describe('the two "no ceiling" vocabularies stay distinct and both get reported', () => {
  it('an all-out mode WITH a ceiling is not unbounded and not uncapped', async () => {
    scheduleFindMany.mockResolvedValue([
      { id: 's1', name: 'A', campaignId: 'c1', windows: SPLIT_WINDOWS, defaultTargetKey: 'defend-top', timezone: 'Europe/Rome' },
    ])
    const f = await getForesight()
    // Hour 0 is all-out, and that mode carries maxCpcCents 200.
    expect(f.hours[0].unbounded).toBe(0)
    expect(f.hours[0].noCpcCeiling).toBe(0)
  })

  it('an everyday mode with NO ceiling is counted, even though it is not all-out', async () => {
    scheduleFindMany.mockResolvedValue([
      { id: 's1', name: 'A', campaignId: 'c1', windows: SPLIT_WINDOWS, defaultTargetKey: 'defend-top', timezone: 'Europe/Rome' },
    ])
    const f = await getForesight()
    // Hour 12 onward is defend-top: maxCpcCents null, allOut false.
    expect(f.hours[12].unbounded).toBe(0)
    expect(f.hours[12].noCpcCeiling).toBe(1)
    expect(f.notes.join(' ')).toContain('no CPC ceiling of any kind')
  })

  it('a suppression hour is exempt — driving bids down cannot cost money', async () => {
    scheduleFindMany.mockResolvedValue([{
      id: 's1', name: 'A', campaignId: 'c1', timezone: 'Europe/Rome', defaultTargetKey: 'pause',
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24, targetKey: 'pause' }],
    }])
    const f = await getForesight()
    expect(f.hours[5].suppressed).toBe(1)
    expect(f.hours[5].noCpcCeiling).toBe(0)
  })
})

describe('engines', () => {
  it('reports cadence and fire count from the expression, not from a label', async () => {
    const f = await getForesight()
    const bid = f.engines.find((e) => e.key === 'auto-bid')!
    expect(bid.cadence).toBe('every 6 h at :20')
    expect(bid.fires).toBe(4)
    const coverage = f.engines.find((e) => e.key === 'coverage-engine')!
    expect(coverage.fires).toBe(1)
    // HP5 (2026-08-21): the auto-harvest engine is retired — the forecast must not list it.
    expect(f.engines.find((e) => e.key === 'auto-harvest')).toBeUndefined()
  })

  it('a stopped account blocks every engine, with the halt as the stated reason', async () => {
    automationState.mockResolvedValue({
      autonomy: 'AUTO', halted: true, haltReason: 'Automation runaway: 264 actions in the last hour.',
      haltedAt: null, effectivelyStopped: true, degraded: false,
    })
    process.env.NEXUS_ENABLE_AMAZON_ADS_CRON = '1'
    try {
      const f = await getForesight()
      expect(f.engines.every((e) => !e.canWrite)).toBe(true)
      expect(f.engines[0].blockedReason).toContain('264 actions')
    } finally {
      delete process.env.NEXUS_ENABLE_AMAZON_ADS_CRON
    }
  })

  it('every blocked engine states a reason — "cannot write" with no why is the old board\'s failure', async () => {
    const f = await getForesight()
    for (const e of f.engines) {
      if (!e.canWrite) expect(e.blockedReason).toBeTruthy()
    }
  })
})

describe('no schedules', () => {
  it('says so rather than rendering an empty timeline with no explanation', async () => {
    const f = await getForesight()
    expect(f.scheduledBidChanges).toBe(0)
    expect(f.notes.join(' ')).toContain('No schedule is enabled')
    expect(f.hours).toHaveLength(24)
  })
})
