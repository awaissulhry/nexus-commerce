/**
 * Batch 2 fix (item 7) — the money brain's brake as the bid brain reads it (bid-brain/money-brake.ts) and applies it in its
 * facts (facts.ts): only today's plan, only where the product's budgets lever is the brain's (PROPOSE or AUTO); OBSERVE or
 * OFF: nothing read, nothing changes. Made-up values (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ owners: new Map<string, unknown>(), plans: new Map<string, unknown>() }))
vi.mock('../brain/lever-owners.js', () => ({ campaignLeverOwners: vi.fn(async (ids: string[]) => new Map([...h.owners].filter(([id]) => ids.includes(id)))) }))
vi.mock('../brain/budget-shadow.js', () => ({ newestMoneyDecisions: vi.fn(async (_m: string, ids: string[]) => new Map([...h.plans].filter(([id]) => ids.includes(id)))) }))

const { loadMoneyBrakes, moneyBrakeOf } = await import('./money-brake.js')

const NOW = new Date('2026-10-08T12:00:00Z')
const plan = (level: string, extra: Record<string, unknown> = {}) => ({ plan: { day: '2026-10-08', pace: { pacePct: 102 }, brake: { level, bidStepPct: level === 'cut_bids' || level === 'stop_weakest' ? -10 : null, stop: level === 'stop_weakest' ? [{ campaignId: 'c-weak' }] : null }, ...extra } })
const owned = (productId = 'p-jacket') => ({ levers: { budgets: { kind: 'owned', productId, market: 'IT', why: 'AUTO' } } })

beforeEach(() => { h.owners = new Map(); h.plans = new Map() })

describe('batch 2 fix — the money brake the bid brain reads', () => {
  it('each level in words with no money amount; only today\'s plan; none: no brake', () => {
    expect(moneyBrakeOf(plan('hold_raises').plan as never, 'c1', 'p-jacket', '2026-10-08')).toEqual({ level: 'hold_raises', stepPct: 0, floor: false, productId: 'p-jacket', why: 'the money brake of product p-jacket (hold_raises: projected 102 % of its monthly budget, above 95 %)' })
    expect(moneyBrakeOf(plan('cut_bids').plan as never, 'c1', 'p-jacket', '2026-10-08')).toMatchObject({ level: 'cut_bids', stepPct: 10, floor: false })
    expect(moneyBrakeOf(plan('stop_weakest').plan as never, 'c-weak', 'p-jacket', '2026-10-08')).toMatchObject({ level: 'stop_weakest', floor: true })
    expect(moneyBrakeOf(plan('stop_weakest').plan as never, 'c-other', 'p-jacket', '2026-10-08')).toMatchObject({ level: 'stop_weakest', floor: false, stepPct: 10 })
    expect(moneyBrakeOf(plan('cut_bids').plan as never, 'c1', 'p-jacket', '2026-10-09')).toBeNull()
    expect(moneyBrakeOf(plan('none').plan as never, 'c1', 'p-jacket', '2026-10-08')).toBeNull()
  })

  it('read only where the budgets lever is the brain\'s (PROPOSE or AUTO): OBSERVE, OFF, locked or excluded campaigns get none', async () => {
    h.owners = new Map<string, unknown>([['c1', owned()], ['c-locked', { levers: { budgets: { kind: 'locked', productId: 'p-jacket', market: 'IT', why: 'locked' } } }], ['c-other-market', { levers: { budgets: { kind: 'owned', productId: 'p-jacket', market: 'DE', why: 'AUTO' } } }]])
    h.plans = new Map<string, unknown>([['p-jacket', plan('cut_bids')]])
    const out = await loadMoneyBrakes(['c1', 'c-locked', 'c-observe', 'c-other-market'], 'IT', NOW)
    expect([...out.keys()]).toEqual(['c1'])
    expect(out.get('c1')).toMatchObject({ level: 'cut_bids', productId: 'p-jacket' })
    // Nothing owned (production today, or every lever at OBSERVE): no plan read at all.
    h.owners = new Map()
    expect((await loadMoneyBrakes(['c1'], 'IT', NOW)).size).toBe(0)
  })
})

describe('batch 2 fix — the brake in the facts', () => {
  const brake = (level: string, floor = false) => ({ level, stepPct: level === 'hold_raises' ? 0 : 10, floor, productId: 'p-jacket', why: `the money brake of product p-jacket (${level})` }) as never
  const campaign = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: 'ENABLED', pinBids: false, pinnedBy: null, bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null, minBidCents: null, maxBidCents: null, ownTargetAcos: undefined, allowlisted: true, ...extra })
  const m = (campaigns: Array<ReturnType<typeof campaign>>) => ({
    market: 'IT', dataDay: '2026-10-07',
    campaigns: new Map(campaigns.map((c) => [c.id, c])),
    adGroups: new Map(campaigns.map((c) => [`g-${c.id}`, { id: `g-${c.id}`, campaignId: c.id, status: 'ENABLED', bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null, families: ['famA'] }])),
    targets: campaigns.map((c) => ({ id: `t-${c.id}`, adGroupId: `g-${c.id}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'race jacket', bidCents: 30, suppressedFromBidCents: null })),
    evidence: new Map(), prices: new Map([['famA', 8990]]),
  }) as never
  const run = (moneyBrakes?: Map<string, unknown>) => ({
    marketBrakes: [], strategy: new Map(campaignIds.map((id) => [`g-${id}`, { target: { kind: 'ACOS', pct: 20 }, acosPct: 20, band: null, goal: 'PROFIT', minBidCents: null, maxBidCents: 80, maxChangePct: 25, stopBidCents: 3 }])),
    accountDefaultPct: null, personHeld: new Set(), holds: [], enrollments: new Map(), lastSteps: new Map(), ...(moneyBrakes ? { moneyBrakes } : {}),
  }) as never
  const campaignIds = ['c-hold', 'c-cut', 'c-weak', 'c-weak-pinned', 'c-none']

  it('hold_raises → a raise cap; cut_bids → MONEY; stop_weakest → STOP at the stop bid on the weakest (not where the Owner pins: MONEY), MONEY on the others; none → as before', async () => {
    const { buildFacts } = await import('./facts.js')
    const rows = m([campaign('c-hold'), campaign('c-cut'), campaign('c-weak'), campaign('c-weak-pinned', { pinBids: true, pinnedBy: 'user:owner' }), campaign('c-none')])
    const brakes = new Map<string, unknown>([['c-hold', brake('hold_raises')], ['c-cut', brake('cut_bids')], ['c-weak', brake('stop_weakest', true)], ['c-weak-pinned', brake('stop_weakest', true)]])
    const f = new Map((buildFacts(rows, run(brakes)) as Array<{ targetId: string; raiseCap?: string; overrides?: Record<string, unknown> }>).map((x) => [x.targetId, x]))
    expect(f.get('t-c-hold')!.raiseCap).toBe('the money brake of product p-jacket (hold_raises): no raises')
    expect(f.get('t-c-hold')!.overrides!.money).toBeUndefined()
    expect(f.get('t-c-cut')!.overrides!.money).toEqual({ stepPct: 10, by: 'the money brake of product p-jacket (cut_bids)' })
    expect(f.get('t-c-weak')!.overrides!.stop).toEqual({ bidCents: 3, by: 'the money brake of product p-jacket (stop_weakest): one of its weakest campaigns stops until back on pace' })
    expect(f.get('t-c-weak-pinned')!.overrides).toMatchObject({ pin: expect.anything(), money: { stepPct: 10 } })
    expect(f.get('t-c-weak-pinned')!.overrides!.stop).toBeUndefined()
    expect(f.get('t-c-none')!.raiseCap).toBeUndefined()
    expect(f.get('t-c-none')!.overrides!.money).toBeUndefined()
    // No brakes read (OBSERVE, OFF, nothing enrolled): the facts are exactly as before.
    expect(buildFacts(rows, run())).toEqual(buildFacts(rows, run(new Map())))
  })
})
