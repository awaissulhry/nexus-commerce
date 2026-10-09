/**
 * ONE BRAIN AB-12 — one run of the state brain (brain/state-run.ts), with the loader and the database mocked (the real
 * reads, the gate and the status path run in the real-PostgreSQL suite state-postgres): the levels end to end — OBSERVE
 * logs only, PROPOSE asks one request per action per product (enable-ads lifting the brain's own AUTO pause asks the
 * approver's code), AUTO writes per campaign — a campaign dead for weeks is paused too, never archived; the day's cap across a market's
 * products; a refusal tried again once a UTC day; rows only on change (and the day's first for a pause the brain carries);
 * one product failing never stops the others; nothing watched → only the prune.
 * Values are made up (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateFacts, StopCause } from './state.js'

const h = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  todays: [] as Array<{ outcome: string; campaignId: string }>,
  pruned: 0,
  loaded: new Map<string, unknown>(),
  posture: { posture: 'auto', why: 'the account ads dial is AUTO' },
  // AB-15 — the kill switch and the holds after an auto-undo (brain/lever-holds.ts), stood in.
  holds: { kill: null as string | null, campaigns: new Map<string, { why: string; blocks: 'pause' | 'resume' | null; until: string }>() },
}))
vi.mock('../../../db.js', () => ({
  default: {
    adsBrainStateDecision: {
      deleteMany: vi.fn(async () => ({ count: h.pruned })),
      groupBy: vi.fn(async () => h.todays),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => { h.created.push(...data); return { count: data.length } }),
    },
  },
}))
vi.mock('../ads-engine-guard.js', () => ({ readEnginePosture: vi.fn(async () => h.posture) }))
vi.mock('../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('./lever-holds.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lever-holds.js')>()),
  leverHolds: vi.fn(async () => ({ kill: h.holds.kill, campaigns: h.holds.campaigns, terms: new Map(), portfolios: new Map() })),
}))
vi.mock('./state-load.js', () => ({
  stateWatchProducts: vi.fn(async () => []),
  loadProductStateFacts: vi.fn(async (productId: string) => {
    const l = h.loaded.get(productId)
    if (l instanceof Error) throw l
    return l ?? null
  }),
}))

const { runStateBrainOnce, stateSummaryLine, requestArgs } = await import('./state-run.js')

const NOW = new Date('2026-10-08T12:00:00Z')
const H = 3_600_000
const D = 86_400_000
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * H)
const STOP_MEMORY = { savedPlacements: null, savedStrategy: null, biddingStrategy: 'LEGACY_FOR_SALES', flooredKeywords: 2, floorBy: 'automation:retail-guard' }
const long: StopCause = { cause: 'stock', endsAt: new Date(NOW.getTime() + 10 * D), source: 'restock_date', words: 'out of stock' }

function facts(campaignId: string, level: string, over: Partial<StateFacts> = {}): StateFacts {
  return {
    campaignId, name: `Campaign ${campaignId}`, productId: 'jacket', market: 'IT', status: 'ENABLED', owner: 'product',
    lever: { effective: level, why: level }, pauseMinDays: 3, archiveDeadWeeks: 4, causes: [long], stockNotRecovered: false, stopSince: null,
    lastStatusChange: null, memory: null, stopMemory: STOP_MEMORY, asked: null, impressions: 100, ageDays: 300, ...over,
  }
}
function load(productId: string, list: StateFacts[], previous: Array<[string, Record<string, unknown>]> = [], asked: Array<[string, Record<string, unknown>]> = []) {
  h.loaded.set(productId, { productId, market: 'IT', enrolled: true, facts: list, previous: new Map(previous), asked: new Map(asked) })
}
const P = (productId: string) => ({ productId, market: 'IT', level: 'AUTO' as const })
const ask = vi.fn(async (_tool: string, _args: Record<string, unknown>) => ({ approvalId: 'ap-1' }) as { approvalId: string } | { error: string })
const write = vi.fn(async (_c: string, _s: string, _r: string, _run: string) => ({ queued: true, error: null as string | null }))
const run = (products = [P('jacket')], now = NOW) => runStateBrainOnce({ now, products, ask, write })

beforeEach(() => {
  h.created = []; h.todays = []; h.pruned = 0; h.loaded = new Map()
  h.posture = { posture: 'auto', why: 'the account ads dial is AUTO' }
  h.holds = { kill: null, campaigns: new Map() }
  ask.mockClear(); write.mockClear()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
})

describe('AB-12 — the state brain\'s run', () => {
  it('nothing watched (production today): no run — only the 30-day prune', async () => {
    h.pruned = 4
    const r = await runStateBrainOnce({ now: NOW, products: [], ask, write })
    expect(r).toMatchObject({ ran: false, pruned: 4, campaigns: [] })
    expect(stateSummaryLine(r)).toMatch(/nothing decided, nothing written · pruned=4/)
    expect(ask).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('OBSERVE: logged as SHADOW — nothing asked, nothing written', async () => {
    load('jacket', [facts('c1', 'OBSERVE')])
    const r = await run()
    expect(ask).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({ mode: 'SHADOW', kind: 'change', action: 'pause', outcome: 'shadow', cause: 'stock', campaignId: 'c1', marketplace: 'IT', level: 'OBSERVE' })
    expect((h.created[0].decision as { memory: unknown }).memory).toBeNull()
    expect(stateSummaryLine(r)).toBe('STATE IT: pause shadow 1 · pruned=0')
  })

  it('PROPOSE: one request per action for the product\'s campaigns, as "Nexus ads brain"; the pause\'s memory rides on the request', async () => {
    load('jacket', [facts('c1', 'PROPOSE'), facts('c2', 'PROPOSE'), facts('c3', 'PROPOSE', { causes: [] })])
    await run()
    expect(ask).toHaveBeenCalledTimes(1)
    const [tool, args] = ask.mock.calls[0]
    expect(tool).toBe('pause-ads')
    expect(args).toMatchObject({ campaignIds: ['c1', 'c2'], why: expect.stringMatching(/^The ads brain: 2 campaigns of one product: Campaign c1 — PROPOSE: asks a person to pause it/) })
    expect((args.why as string).length).toBeLessThanOrEqual(300)
    const rows = h.created.filter((x) => x.action === 'pause')
    expect(rows.map((x) => [x.campaignId, x.mode, x.outcome, x.approvalId])).toEqual([['c1', 'PROPOSE', 'asked', 'ap-1'], ['c2', 'PROPOSE', 'asked', 'ap-1']])
    const decision = rows[0].decision as { memory: unknown; asked: { action: string; approvalId: string; memory: { via: string; statusBefore: string } } }
    expect(decision.memory).toBeNull()
    expect(decision.asked).toMatchObject({ action: 'pause', approvalId: 'ap-1', memory: { via: 'request', statusBefore: 'ENABLED' } })
    expect(write).not.toHaveBeenCalled()
  })

  it('PROPOSE: a request the gate or the tool refuses is recorded as refused, its reason in the why', async () => {
    ask.mockResolvedValueOnce({ error: 'campaign c1 is not on the live-write allowlist' })
    load('jacket', [facts('c1', 'PROPOSE')])
    await run()
    expect(h.created[0]).toMatchObject({ outcome: 'refused', approvalId: null, why: expect.stringMatching(/— not done: campaign c1 is not on the live-write allowlist$/) })
  })

  it('PROPOSE: the resume of the brain\'s own AUTO pause asks enable-ads to lift an automation\'s pause (the approver\'s code)', async () => {
    const paused: Partial<StateFacts> = {
      status: 'PAUSED', causes: [],
      lastStatusChange: { to: 'PAUSED', at: at(48), by: 'brain', who: 'automation:ads-brain-state', via: 'auto', approvalId: null },
      memory: { pausedAt: at(48).toISOString(), via: 'auto', approvalId: null, statusBefore: 'ENABLED', causes: ['stock'], expectedEndAt: null, stop: STOP_MEMORY },
    }
    load('jacket', [facts('c1', 'PROPOSE', paused)])
    await run()
    expect(ask).toHaveBeenCalledWith('enable-ads', expect.objectContaining({ campaignIds: ['c1'], includePeoplesPauses: true }))
    expect(requestArgs('resume', []).args).not.toHaveProperty('includePeoplesPauses')
  })

  it('AUTO: each pause written as the brain, its memory on the row; a campaign dead for weeks is paused too, never archived', async () => {
    load('jacket', [facts('c1', 'AUTO'), facts('c2', 'AUTO', { causes: [], impressions: 0, ageDays: 90 })])
    await run()
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls.map((c) => c.slice(0, 2))).toEqual([['c1', 'PAUSED'], ['c2', 'PAUSED']])
    expect(ask).not.toHaveBeenCalled()
    const pause = h.created.find((x) => x.campaignId === 'c1')!
    expect(pause).toMatchObject({ mode: 'LIVE', outcome: 'queued', action: 'pause' })
    expect((pause.decision as { memory: { statusBefore: string; stop: unknown } }).memory).toMatchObject({ statusBefore: 'ENABLED', stop: STOP_MEMORY })
    const dead = h.created.find((x) => x.campaignId === 'c2')!
    expect(dead).toMatchObject({ mode: 'LIVE', action: 'pause', outcome: 'queued' })
    expect((dead.decision as { memory: { causes: string[] } }).memory).toMatchObject({ causes: ['dead'] })
  })

  it('AUTO: a refused write leaves no memory and is tried again only the next UTC day', async () => {
    write.mockResolvedValueOnce({ queued: false, error: 'Not sent to Amazon: no product\'s brain owns the state' })
    load('jacket', [facts('c1', 'AUTO')])
    await run()
    const first = h.created[0]
    expect(first).toMatchObject({ outcome: 'refused' })
    expect((first.decision as { memory: unknown }).memory).toBeNull()
    // Later the same day: not tried again, nothing new logged.
    h.created = []
    load('jacket', [facts('c1', 'AUTO')], [['c1', { decisionHash: first.decisionHash, createdAt: NOW, action: 'pause', outcome: 'refused', mode: 'LIVE', approvalId: null, decision: first.decision }]])
    await run([P('jacket')], new Date(NOW.getTime() + 2 * H))
    expect(write).toHaveBeenCalledTimes(1)
    expect(h.created).toEqual([])
    // The next UTC day: tried again.
    await run([P('jacket')], new Date(NOW.getTime() + 14 * H))
    expect(write).toHaveBeenCalledTimes(2)
    expect(h.created[0]).toMatchObject({ outcome: 'queued' })
  })

  it('the day\'s cap holds across the market\'s products: 3 pauses, the 4th waits; the shadow counts its own', async () => {
    h.todays = [{ outcome: 'queued', campaignId: 'c0' }]
    load('jacket', [facts('c1', 'AUTO'), facts('c2', 'AUTO')])
    load('helmet', [facts('c3', 'AUTO'), facts('c4', 'OBSERVE')].map((f) => ({ ...f, productId: 'helmet' })))
    await run([P('jacket'), P('helmet')])
    expect(write.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2'])
    expect(h.created.map((x) => [x.campaignId, x.outcome])).toEqual([['c1', 'queued'], ['c2', 'queued'], ['c3', 'capped'], ['c4', 'shadow']])
  })

  it('a rerun on unchanged facts logs nothing; the brain\'s pause in force is logged once a UTC day', async () => {
    const paused: Partial<StateFacts> = {
      status: 'PAUSED', causes: [long],
      lastStatusChange: { to: 'PAUSED', at: at(5), by: 'brain', who: 'automation:ads-brain-state', via: 'auto', approvalId: null },
      memory: { pausedAt: at(5).toISOString(), via: 'auto', approvalId: null, statusBefore: 'ENABLED', causes: ['stock'], expectedEndAt: long.endsAt!.toISOString(), stop: STOP_MEMORY },
    }
    load('jacket', [facts('c1', 'AUTO', paused)])
    await run()
    const first = h.created[0]
    expect(first).toMatchObject({ action: 'keep', kind: 'change' })
    expect((first.decision as { memory: unknown }).memory).not.toBeNull()
    const previous: Array<[string, Record<string, unknown>]> = [['c1', { decisionHash: first.decisionHash, createdAt: NOW, action: 'keep', outcome: 'none', mode: 'LIVE', approvalId: null, decision: first.decision }]]
    h.created = []
    load('jacket', [facts('c1', 'AUTO', paused)], previous)
    await run([P('jacket')], new Date(NOW.getTime() + H))
    expect(h.created).toEqual([])
    await run([P('jacket')], new Date(NOW.getTime() + 13 * H))
    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({ kind: 'snapshot', action: 'keep' })
    expect(write).not.toHaveBeenCalled()
  })

  it('a request still waiting is carried, not asked again; one product failing never stops the others', async () => {
    load('jacket', [facts('c1', 'PROPOSE', { asked: { action: 'pause', approvalId: 'ap-7', state: 'waiting', at: at(2) } })], [], [['c1', { action: 'pause', approvalId: 'ap-7', at: at(2).toISOString(), status: 'pending' }]])
    h.loaded.set('broken', new Error('database away'))
    const r = await run([P('broken'), P('jacket')])
    expect(ask).not.toHaveBeenCalled()
    expect(h.created[0]).toMatchObject({ outcome: 'waiting', approvalId: 'ap-7' })
    expect((h.created[0].decision as { asked: { approvalId: string } }).asked).toMatchObject({ approvalId: 'ap-7' })
    expect(r.failed).toEqual([{ productId: 'broken', market: 'IT', error: 'database away' }])
    expect(stateSummaryLine(r)).toMatch(/IT broken failed: database away/)
  })

  it('AUTO under a shadow server switch: logged as SHADOW, nothing written; with the ads automation halted: held', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    load('jacket', [facts('c1', 'AUTO')])
    await run()
    expect(h.created[0]).toMatchObject({ mode: 'SHADOW', outcome: 'shadow' })
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    h.posture = { posture: 'stopped', why: 'halted: test' }
    h.created = []
    await run()
    expect(h.created[0]).toMatchObject({ mode: 'LIVE', outcome: 'held' })
    expect(write).not.toHaveBeenCalled()
  })
  it('AB-15 — the Owner\'s kill switch on the state lever: nothing written or asked, the decision kept as held in the kill\'s words', async () => {
    h.holds.kill = 'stopped by the Owner\'s kill switch (user:owner, 2026-10-08, product jacket in IT): "test stop"'
    load('jacket', [facts('c1', 'AUTO'), facts('c2', 'AUTO', { causes: [], impressions: 0, ageDays: 90 })])
    const r = await run()
    expect(write).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
    expect(h.created.find((x) => x.campaignId === 'c1')).toMatchObject({ action: 'pause', outcome: 'held', why: expect.stringContaining('not done: stopped by the Owner\'s kill switch') })
    expect(h.created.find((x) => x.campaignId === 'c2')).toMatchObject({ action: 'pause', outcome: 'held' })
    expect(r.campaigns.map((c) => c.outcome)).toEqual(['held', 'held'])
  })

  it('AB-15 — the hold after auto-undo put a pause back blocks the next pause of that campaign only; a resume and other campaigns go on', async () => {
    h.holds.campaigns.set('c1', { why: 'auto-undo put back a brain change here on 2026-10-07 (judgement j1): the brain pauses that campaign again only after 7 days — held until 2026-10-14', blocks: 'pause', until: '2026-10-14T00:00:00.000Z' })
    load('jacket', [facts('c1', 'AUTO'), facts('c3', 'AUTO')])
    await run()
    expect(write.mock.calls.map((c) => c.slice(0, 2))).toEqual([['c3', 'PAUSED']])
    expect(h.created.find((x) => x.campaignId === 'c1')).toMatchObject({ action: 'pause', outcome: 'held', why: expect.stringContaining('held until 2026-10-14') })
    // A hold that blocks a resume does not hold a pause.
    h.holds.campaigns.set('c1', { why: 'held', blocks: 'resume', until: '2026-10-14T00:00:00.000Z' })
    h.created = []; write.mockClear()
    load('jacket', [facts('c1', 'AUTO')])
    await run()
    expect(write.mock.calls.map((c) => c.slice(0, 2))).toEqual([['c1', 'PAUSED']])
  })
})
