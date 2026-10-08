/**
 * ONE BRAIN AB-8 — the money writer (budget-live.ts): one product's money plan carried out at the levels the Owner set.
 *
 *   steps     pure (moneyStepsOf): OBSERVE → nothing; PROPOSE → asks (never the ladder); AUTO → the day's base move, then
 *             the rung on it; holds with their why — a shared campaign, a server switch not live, another writer today,
 *             Amazon's own budget rule, a base or rung already asked today, a rung the gate would refuse, a base that did
 *             not land; an earlier day's ladder given back as a restore. Caps: written / asked where the plan says `set`,
 *             never below this month's spend, never above or of another kind than a cap someone else set (unless the
 *             Owner's own amount), never removed.
 *   writes    (runMoneyActions, the write paths mocked): AUTO writes each budget as the brain with its evidence, through
 *             the mutation layer with the gate asked first; a refused base takes no rung; SUGGEST writes nothing new and
 *             only gives back an earlier day's ladder; the brain's caps defer the rest; PROPOSE asks once per product a
 *             day (a rerun asks nothing); a cap through the portfolio path as the brain; OBSERVE touches nothing.
 *   follow-up the per-write value cap is checked before anything is asked or written (a cap above it: said once a month,
 *             never asked — nobody in Nexus could set it); a key the gate or a person refused is not asked again that day
 *             (the answer says when it asks again); a cap once per amount a month and never while one waits; a failure
 *             while asking gives the key back. The claims (AdsBrainAsk) are an in-memory stand-in here; the real unique
 *             key and the race are budget-live-postgres's.
 *
 * Product A in IT on 2026-10-08 (made-up values, public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Claim = { id: string; key: string; kind: string; productId: string; marketplace: string; portfolioId: string | null; day: string; status: string; approvalId: string | null; toCents: number | null; reason: string | null; createdAt: number }
const h = vi.hoisted(() => ({
  budgetWrites: [] as Array<Record<string, unknown>>,
  budgetOutcome: (_campaignId: string): Record<string, unknown> => ({ ok: true, outboundQueueId: 'q', actionLogId: 'l', bidHistoryIds: [], error: null }),
  capWrites: [] as Array<Record<string, unknown>>,
  asks: [] as Array<{ tool: string; args: Record<string, unknown> }>,
  askOutcome: null as null | (() => Record<string, unknown>),
  /** The AdsBrainAsk rows (unique by key), and each approval's status. */
  claims: new Map<string, Claim>(),
  approvals: new Map<string, { status: string; decidedBy: string | null }>(),
  native: new Map<string, string[]>(),
  // AB-15 — the kill switch and the holds after an auto-undo, stood in (brain/lever-holds.ts moneyHolds).
  budgetHeld: new Map<string, string>(),
  capHeld: new Map<string, string>(),
}))
vi.mock('../../../db.js', () => ({
  default: {
    agentApproval: { findMany: vi.fn(async (a: { where: { id: { in: string[] } } }) => a.where.id.in.flatMap((id) => (h.approvals.has(id) ? [{ id, ...h.approvals.get(id)! }] : []))) },
    agentRun: { create: vi.fn(async () => ({ id: 'run-1' })), update: vi.fn(async () => ({})) },
    // The claim's INSERT … ON CONFLICT DO NOTHING RETURNING "id": a row only when the key is new.
    $queryRaw: vi.fn(async (q: { sql: string; values: unknown[] }) => {
      if (!q.sql.includes('"AdsBrainAsk"')) throw new Error(`unexpected raw query: ${q.sql}`)
      const v = q.values as Array<string | number | null>
      const row = q.sql.includes("'blocked'")
        ? { key: v[0], kind: 'portfolioCapOverValue', productId: v[1], marketplace: v[2], portfolioId: v[3], day: v[4], status: 'blocked', toCents: v[5], reason: v[6], approvalId: null }
        : { key: v[0], kind: v[1], productId: v[2], marketplace: v[3], portfolioId: v[4], day: v[5], status: 'asking', toCents: v[6], reason: null, approvalId: null }
      if (h.claims.has(String(row.key))) return []
      const id = `claim-${h.claims.size + 1}`
      h.claims.set(String(row.key), { id, createdAt: h.claims.size, ...row } as unknown as Claim)
      return [{ id }]
    }),
    adsBrainAsk: {
      findMany: vi.fn(async (a: { where: { kind: string; productId: string; marketplace: string; portfolioId: string | null; day: { gte: Date } } }) => [...h.claims.values()]
        .filter((c) => c.kind === a.where.kind && c.productId === a.where.productId && c.marketplace === a.where.marketplace && c.portfolioId === a.where.portfolioId && c.day >= a.where.day.gte.toISOString().slice(0, 10))
        .sort((x, y) => y.createdAt - x.createdAt)),
      findFirst: vi.fn(async (a: { where: { key: string } }) => h.claims.get(a.where.key) ?? null),
      update: vi.fn(async (a: { where: { id: string }; data: Partial<Claim> }) => { const c = [...h.claims.values()].find((x) => x.id === a.where.id)!; Object.assign(c, a.data); return c }),
      delete: vi.fn(async (a: { where: { id: string } }) => { for (const [k, c] of h.claims) if (c.id === a.where.id) h.claims.delete(k); return {} }),
    },
  },
}))
vi.mock('../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../ads-mutation.service.js', () => ({
  updateCampaignWithSync: vi.fn(async (a: Record<string, unknown>) => { h.budgetWrites.push(a); return h.budgetOutcome(String(a.campaignId)) }),
}))
vi.mock('../ads-portfolio.service.js', () => ({ updatePortfolioById: vi.fn(async (a: Record<string, unknown>) => { h.capWrites.push(a); return { ok: true, mode: 'live' } }) }))
vi.mock('../../agents/approval-gate.service.js', () => ({
  runOrQueueTool: vi.fn(async (tool: string, args: Record<string, unknown>) => {
    h.asks.push({ tool, args })
    if (h.askOutcome) return h.askOutcome()
    const approvalId = `ap-${h.asks.length}`
    h.approvals.set(approvalId, { status: 'pending', decidedBy: null })
    return { ok: true, mode: 'queued', approvalId }
  }),
}))
vi.mock('../../agents/call-tool.js', () => ({ systemPrincipal: (label: string) => ({ kind: 'system', label, userId: null }) }))
vi.mock('./native-rules.js', () => ({ loadNativeRules: vi.fn(async () => new Map()), nativeRuleLines: (_r: unknown, _l: string) => [] as string[] }))
vi.mock('./lever-holds.js', () => ({
  moneyHolds: vi.fn(async () => ({ budget: (id: string) => h.budgetHeld.get(id) ?? null, cap: (id: string) => h.capHeld.get(id) ?? null })),
}))

const { budgetDayMoveBounds } = await import('../ads-write-gate.js')
const { makeEngineGuard } = await import('../ads-engine-guard.js')
const { resolveBrainSettings } = await import('./settings.js')
const { moneyClock } = await import('./budget-pace.js')
const { planProductMoney } = await import('./budget-plan.js')
const { moneyModeOf, moneyStepsOf, runMoneyActions, moneyActionsWords } = await import('./budget-live.js')
const { MONEY_BUDGETS_ACTOR, MONEY_PORTFOLIO_ACTOR } = await import('./budget-ladder.js')
const { BAND, camp, ov, PRODUCT } = await import('./__fixtures__/budget-facts.js')
type Facts = import('./budget-plan.js').ProductMoneyFacts
type OverrideRow = import('./settings.js').OverrideRow
type PortfolioFacts = import('./budget-portfolio.js').PortfolioFacts
type CampaignMoneyFacts = import('./budget-campaigns.js').CampaignMoneyFacts

const NOW = new Date('2026-10-08T12:00:00Z')
const PF: PortfolioFacts = { portfolioId: 'pf-x', name: 'Portfolio X', campaignIds: ['c1', 'c2', 'c3', 'c4'], otherCampaigns: 0, lastMonthSpendCents: 30_000, monthSpendCents: 7_500, today: { policy: 'NO_CAP', amountCents: null, inBudget: true, setBy: null } }

/** Product A: four campaigns stepping down 30 % under the pace (projected 96.88 % of €320 → no raises). */
function facts(overrides: OverrideRow[] = [], over: Partial<Facts> = {}, campaigns?: CampaignMoneyFacts[]): Facts {
  const s = resolveBrainSettings({ productId: PRODUCT, market: 'IT', enrolled: true, overrides })
  return {
    productId: PRODUCT, name: 'Product A', market: 'IT', currency: 'EUR', clock: moneyClock(NOW, 'Europe/Rome', 'IT'), enrolled: true,
    settings: { levers: s.levers, values: s.values, excluded: s.excluded },
    envelope: { productId: PRODUCT, cents: 32_000, source: 'own', why: 'its own monthly budget' },
    split: { budgetCents: null, budgetFrom: null, fixedCents: 32_000, sharedCents: 0, reserveCents: 0, totalCents: 32_000, why: 'IT has no monthly budget', warnings: [] },
    pace: { dayWeights: null, hourWeights: null, spentCents: 7_000, reportedThroughDay: 7, stream: { gapCents: 0, todayCents: 500 }, runRateCents: 1_000, dayWeightsFrom: 'even', hourCurveFrom: 'even', dataThrough: '2026-10-07' },
    portfolios: [PF],
    campaigns: campaigns ?? [400, 300, 200, 100].map((sp, i) => camp(`c${i + 1}`, { avgDailySpendCents: sp, todayCents: i < 2 ? 1_500 : 1_000 }, overrides)),
    band: BAND, limits: { minCents: 100, maxCents: 100_000_000 }, warnings: [],
    ...over,
  }
}
const AUTO = [ov('LEVEL', 'budgets', 'AUTO'), ov('LEVEL', 'portfolioCap', 'AUTO')]
const PROPOSE = [ov('LEVEL', 'budgets', 'PROPOSE'), ov('LEVEL', 'portfolioCap', 'PROPOSE')]
const planOf = (f: Facts) => planProductMoney(f, budgetDayMoveBounds)
const steps = (f: Facts, live = true, native = new Map<string, string[]>()) => moneyStepsOf(planOf(f), f, { live, native })
/** A ladder-ready product: a big envelope (no brake), one campaign 82 % used at 14:00 Rome inside the band (the +75 % rung). */
function ladderFacts(overrides: OverrideRow[] = AUTO, over: Partial<CampaignMoneyFacts> = {}, f: Partial<Facts> = {}): Facts {
  const c = camp('l1', { avgDailySpendCents: 1_050, usage: 0.82, settled: { spendCents: 9_000, salesCents: 36_000, orders: 4 }, ...over }, overrides)
  return facts(overrides, { envelope: { productId: PRODUCT, cents: 100_000, source: 'own', why: 'x' }, portfolios: [{ ...PF, campaignIds: ['l1'] }], ...f }, [c])
}
const auto = (posture: 'auto' | 'suggest' | 'stopped' = 'auto', perTick: number | null = 100) => makeEngineGuard({ engine: 'brain-money', posture, why: posture, caps: { perTick, perDay: 400 }, todayBefore: 0 })

beforeEach(() => {
  h.budgetWrites = []; h.capWrites = []; h.asks = []; h.askOutcome = null
  h.claims.clear(); h.approvals.clear()
  h.budgetHeld = new Map(); h.capHeld = new Map()
  h.budgetOutcome = () => ({ ok: true, outboundQueueId: 'q', actionLogId: 'l', bidHistoryIds: [], error: null })
  vi.unstubAllEnvs()
})

describe('AB-8 — the steps (pure)', () => {
  it('the mode: SHADOW at OBSERVE or with the switch not live, PROPOSE, LIVE at AUTO (a campaign\'s own AUTO counts)', () => {
    expect(moneyModeOf(facts(), true)).toBe('SHADOW')
    expect(moneyModeOf(facts(AUTO), false)).toBe('SHADOW')
    expect(moneyModeOf(facts(PROPOSE), true)).toBe('PROPOSE')
    expect(moneyModeOf(facts(AUTO), true)).toBe('LIVE')
    expect(moneyModeOf(facts([ov('LEVEL', 'budgets', 'AUTO', 'c2')]), true)).toBe('LIVE')
  })

  it('AUTO: each campaign\'s base move for today, from today\'s budget, as a forward write', () => {
    expect(steps(facts(AUTO)).campaigns.map((s) => [s.campaignId, s.do, 'fromCents' in s ? s.fromCents : null, 'toCents' in s ? s.toCents : null])).toEqual([
      ['c1', 'write', 1_500, 1_050], ['c2', 'write', 1_500, 1_050], ['c3', 'write', 1_000, 700], ['c4', 'write', 1_000, 700],
    ])
    expect(steps(facts(AUTO)).campaigns[0]).toMatchObject({ layer: 'base', kind: 'forward', level: 'AUTO' })
  })

  it('OBSERVE, a switch not live, a campaign the Owner set to OBSERVE: held with the reason; PROPOSE: asked', () => {
    expect(steps(facts()).campaigns.every((s) => s.do === 'hold' && s.why === 'OBSERVE: the brain plans it in shadow, writes nothing')).toBe(true)
    expect(steps(facts(AUTO), false).campaigns[0]).toMatchObject({ do: 'hold', why: expect.stringMatching(/NEXUS_BID_BRAIN_MODE is not live/) })
    expect(steps(facts([...AUTO, ov('LEVEL', 'budgets', 'OBSERVE', 'c2')])).campaigns.map((s) => s.do)).toEqual(['write', 'hold', 'write', 'write'])
    expect(steps(facts(PROPOSE)).campaigns.map((s) => s.do)).toEqual(['ask', 'ask', 'ask', 'ask'])
  })

  it('held: another writer moved it today, a base move already asked today, Amazon\'s own budget rule, a shared campaign', () => {
    const today = { c1: { baseAsked: false, ladderAskedCents: null, others: ['user:owner'] }, c2: { baseAsked: true, ladderAskedCents: null, others: [] } }
    const out = steps(facts(AUTO, { today }), true, new Map([['c3', ['budget rule "Weekend boost" raises its budget']]])).campaigns
    expect(out.map((s) => [s.campaignId, s.do])).toEqual([['c1', 'hold'], ['c2', 'hold'], ['c3', 'hold'], ['c4', 'write']])
    expect(out[0].why).toBe('another writer moved this budget today (user:owner): the brain leaves it until the next budget day')
    expect(out[1].why).toBe('the day\'s base move was asked already today: one base move a day')
    expect(out[2].why).toMatch(/^Amazon's own rule acts on its budget \(budget rule "Weekend boost" raises its budget\): two brains on one lever/)
    const shared = facts(AUTO, {}, [camp('s1', { owner: 'shared', avgDailySpendCents: 100 }, AUTO)])
    expect(steps(shared).campaigns).toEqual([expect.objectContaining({ campaignId: 's1', do: 'hold', why: expect.stringMatching(/^a shared campaign: no product's brain owns its budget/) })])
  })

  it('the ladder at AUTO: the rung on today\'s base, once; never at PROPOSE, never one the gate would refuse, never on a base that did not land', () => {
    const rung = steps(ladderFacts()).campaigns
    expect(rung).toEqual([expect.objectContaining({ campaignId: 'l1', do: 'write', layer: 'ladder', fromCents: 1_500, toCents: 2_625, kind: 'forward' })])
    expect(steps(ladderFacts(AUTO, {}, { today: { l1: { baseAsked: false, ladderAskedCents: 2_625, others: [] } } })).campaigns[0]).toMatchObject({ do: 'hold', why: 'the rung to €26.25 was asked already today' })
    expect(steps(ladderFacts(PROPOSE)).campaigns[0]).toMatchObject({ do: 'hold', why: 'the intraday ladder runs only at AUTO: a person\'s approval would come too late in the day' })
    const f = ladderFacts()
    const p = planOf(f)
    p.campaigns[0].ladder!.allowed = false
    expect(moneyStepsOf(p, f, { live: true }).campaigns[0]).toMatchObject({ do: 'hold', why: expect.stringMatching(/^the rung \+75 % is not written/) })
    // The day's base was decided at €15.00 but the budget is still €12.00 (its base write was refused): no rung on it.
    const unlanded = ladderFacts(AUTO, { todayCents: 1_200, stepToday: 1_500 }, { today: { l1: { baseAsked: true, ladderAskedCents: null, others: [] } } })
    expect(steps(unlanded).campaigns.map((s) => s.why)).toEqual(['the day\'s base move was asked already today: one base move a day', 'the day\'s base €15.00 has not landed (the budget\'s base is €12.00): no rung on it'])
  })

  it('an earlier day\'s ladder: going back to its base is a restore; a base move below it is forward, the give-back named', () => {
    const back = ladderFacts(AUTO, { todayCents: 3_000, openingCents: 1_500, ladderNow: { baseCents: 1_500, fromDay: 'before' }, usage: null })
    expect(steps(back).campaigns).toEqual([expect.objectContaining({ do: 'write', layer: 'base', fromCents: 3_000, toCents: 1_500, kind: 'restore' })])
    const below = ladderFacts(AUTO, { todayCents: 3_000, openingCents: 1_500, ladderNow: { baseCents: 1_500, fromDay: 'before' }, avgDailySpendCents: 500, usage: null })
    expect(steps(below).campaigns[0]).toMatchObject({ kind: 'forward', toCents: 1_050, restoreCents: 1_500 })
  })

  it('caps: AUTO writes and PROPOSE asks where the plan sets one; OBSERVE and a switch not live hold; a cap already as planned is nothing', () => {
    expect(steps(facts(AUTO)).portfolios).toEqual([expect.objectContaining({ portfolioId: 'pf-x', do: 'write', fromCents: null, toCents: 36_800 })])
    expect(steps(facts(PROPOSE)).portfolios[0]).toMatchObject({ do: 'ask', toCents: 36_800 })
    expect(steps(facts()).portfolios[0]).toMatchObject({ do: 'hold', why: 'OBSERVE: the brain plans the cap in shadow, writes nothing' })
    expect(steps(facts(AUTO), false).portfolios[0]).toMatchObject({ do: 'hold' })
    const same = facts(AUTO, { portfolios: [{ ...PF, today: { policy: 'MONTHLY_RECURRING', amountCents: 36_800, inBudget: true, setBy: 'brain' } }] })
    expect(steps(same).portfolios).toEqual([])
  })

  it('caps never below this month\'s spend, never raised or changed in kind when someone else set them — the Owner\'s own amount excepted', () => {
    const spent = facts(AUTO, { portfolios: [{ ...PF, monthSpendCents: 40_000 }] })
    expect(steps(spent).portfolios[0]).toMatchObject({ do: 'hold', why: expect.stringMatching(/is not above this month's spend in it plus one day: it would stop every campaign in it at once/) })
    const theirs = (amountCents: number, policy = 'MONTHLY_RECURRING') => ({ ...PF, today: { policy, amountCents, inBudget: true, setBy: 'other' as const } })
    expect(steps(facts(AUTO, { portfolios: [theirs(30_000)] })).portfolios[0]).toMatchObject({ do: 'hold', why: 'the cap €300.00 someone else set stands: the brain may lower it, never raise it (it would plan €368.00)' })
    expect(steps(facts(AUTO, { portfolios: [theirs(50_000)] })).portfolios[0]).toMatchObject({ do: 'write', fromCents: 50_000, toCents: 36_800 })
    expect(steps(facts(AUTO, { portfolios: [theirs(50_000, 'DATE_RANGE')] })).portfolios[0]).toMatchObject({ do: 'hold', why: expect.stringMatching(/^a date range cap someone else set stands/) })
    // The Owner's own cap amount (portfolioCapCents) is his setting: the brain applies it.
    const own = facts([...AUTO, ov('VALUE', 'portfolioCapCents', 34_000)], { portfolios: [theirs(30_000)] })
    expect(steps(own).portfolios[0]).toMatchObject({ do: 'write', toCents: 34_000 })
    // The Owner's lock of the cap, or the cap switched off: nothing.
    expect(steps(facts([...AUTO, ov('LOCK', 'portfolioCap', null)])).portfolios).toEqual([])
    expect(steps(facts([...AUTO, ov('VALUE', 'portfolioCapOn', false)])).portfolios).toEqual([])
  })
})

describe('AB-8 — the writes', () => {
  it('OBSERVE: nothing asked, nothing written', async () => {
    const f = facts()
    const out = await runMoneyActions(planOf(f), f, { runId: 'bm-1', live: true, guard: async () => auto() })
    expect(out).toMatchObject({ mode: 'SHADOW', campaigns: [], portfolios: [] })
    expect([h.budgetWrites, h.capWrites, h.asks]).toEqual([[], [], []])
    expect(moneyActionsWords(out)).toBe('')
  })

  it('AUTO: every budget written as the brain with its evidence, the gate asked first; the cap through the portfolio path', async () => {
    const f = facts(AUTO)
    const guard = auto()
    const out = await runMoneyActions(planOf(f), f, { runId: 'bm-1', live: true, guard: async () => guard })
    expect(h.budgetWrites).toHaveLength(4)
    expect(h.budgetWrites[0]).toMatchObject({
      campaignId: 'c1', patch: { dailyBudget: 10.5 }, actor: MONEY_BUDGETS_ACTOR, askGate: true,
      evidence: { metric: 'dailyBudget', source: { kind: 'ads-brain', id: 'bm-1' }, brain: { runId: 'bm-1', layer: 'base', dataDay: '2026-10-07', goalBidCents: null } },
    })
    expect(String(h.budgetWrites[0].reason)).toMatch(/^ads brain — expected €4.00 a day/)
    expect(h.capWrites).toEqual([expect.objectContaining({ portfolioId: 'pf-x', budget: { amount: 368, currencyCode: 'EUR', policy: 'monthlyRecurring' }, actor: MONEY_PORTFOLIO_ACTOR, audit: expect.objectContaining({ actor: MONEY_PORTFOLIO_ACTOR, changeSetId: null, evidence: expect.objectContaining({ metric: 'portfolioBudgetCap', brain: expect.objectContaining({ layer: 'cap' }) }) }) })])
    expect(out.counts).toMatchObject({ queued: 4, written: 1, refused: 0 })
    expect(moneyActionsWords(out)).toBe('queued=4 caps=1')
    expect(guard.report()).toMatchObject({ changes: 5 })
  })

  it('a refused base move takes no rung on it; an unchanged value queues nothing', async () => {
    const f = ladderFacts(AUTO, { avgDailySpendCents: 1_400 })
    expect(steps(f).campaigns.map((s) => [s.do, 'layer' in s ? s.layer : null])).toEqual([['write', 'base'], ['write', 'ladder']])
    h.budgetOutcome = () => ({ ok: false, outboundQueueId: null, actionLogId: null, bidHistoryIds: [], error: 'Not sent to Amazon: refused' })
    const out = await runMoneyActions(planOf(f), f, { runId: 'bm-2', live: true, guard: async () => auto() })
    expect(h.budgetWrites).toHaveLength(1)
    expect(out.campaigns).toEqual([expect.objectContaining({ layer: 'base', sent: 'refused', reason: 'Not sent to Amazon: refused' })])
    h.budgetWrites = []
    h.budgetOutcome = () => ({ ok: true, outboundQueueId: null, actionLogId: null, bidHistoryIds: [], error: 'no_changes' })
    const again = await runMoneyActions(planOf(f), f, { runId: 'bm-3', live: true, guard: async () => auto() })
    expect(again.campaigns.map((c) => c.sent)).toEqual(['unchanged', 'unchanged'])
    expect(again.counts.queued).toBe(0)
  })

  it('SUGGEST writes nothing new and gives back an earlier day\'s ladder alone; the brain\'s caps defer the rest to the next run', async () => {
    // This product's cap (115 % of a large envelope) is above the default per-write value cap: a value cap above it here.
    vi.stubEnv('NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS', '500000')
    const f = ladderFacts(AUTO, { todayCents: 3_000, openingCents: 1_500, ladderNow: { baseCents: 1_500, fromDay: 'before' }, avgDailySpendCents: 500, usage: null })
    const out = await runMoneyActions(planOf(f), f, { runId: 'bm-4', live: true, guard: async () => auto('suggest') })
    expect(h.budgetWrites).toEqual([expect.objectContaining({ patch: { dailyBudget: 15 }, evidence: expect.objectContaining({ brain: expect.objectContaining({ layer: 'base' }) }) })])
    expect(out.campaigns[0]).toMatchObject({ layer: 'giveback', sent: 'queued', toCents: 1_500 })
    expect(out.portfolios[0]).toMatchObject({ sent: 'would-apply' })
    h.budgetWrites = []
    const capped = facts(AUTO)
    const deferred = await runMoneyActions(planOf(capped), capped, { runId: 'bm-5', live: true, guard: async () => auto('auto', 2) })
    expect(h.budgetWrites).toHaveLength(2)
    expect(deferred.campaigns.map((c) => c.sent)).toEqual(['queued', 'queued', 'deferred', 'deferred'])
    expect(deferred.campaigns[2].reason).toBe('the brain\'s money caps for this run are used: it goes next run')
  })

  it('PROPOSE: one request for the product\'s day (set-campaign-budget\'s list form) and one for the cap; a rerun asks nothing', async () => {
    const f = facts(PROPOSE)
    const out = await runMoneyActions(planOf(f), f, { runId: 'bm-6', live: true, guard: async () => auto() })
    expect(h.budgetWrites).toEqual([])
    expect(h.asks.map((a) => a.tool)).toEqual(['set-campaign-budget', 'set-portfolio'])
    expect(h.asks[0].args).toMatchObject({ campaigns: [{ campaignId: 'c1', dailyBudgetCents: 1_050 }, { campaignId: 'c2', dailyBudgetCents: 1_050 }, { campaignId: 'c3', dailyBudgetCents: 700 }, { campaignId: 'c4', dailyBudgetCents: 700 }] })
    expect(String(h.asks[0].args.why).length).toBeLessThanOrEqual(300)
    expect(String(h.asks[0].args.why)).toMatch(/^ads brain — Product A \(IT\) 2026-10-08: the day's budget moves inside the pace \(brake hold_raises\); c1 €15.00 → €10.50/)
    expect(h.asks[1].args).toMatchObject({ op: 'update', portfolioId: 'pf-x', cap: { amountCents: 36_800, policy: 'monthly' } })
    expect(out.proposals.map((p) => [p.kind, p.key, p.approvalId, p.fresh])).toEqual([
      ['budgets', `budgets:${PRODUCT}:IT:2026-10-08`, 'ap-1', true], ['portfolioCap', `cap:${PRODUCT}:IT:pf-x:2026-10-08`, 'ap-2', true],
    ])
    expect(out.campaigns.every((c) => c.sent === 'asked')).toBe(true)
    expect(out.counts.asked).toBe(2)
    expect([...h.claims.values()].map((c) => [c.key, c.status, c.approvalId, c.toCents])).toEqual([
      [`budgets:${PRODUCT}:IT:2026-10-08`, 'asked', 'ap-1', null], [`cap:${PRODUCT}:IT:pf-x:2026-10-08`, 'asked', 'ap-2', 36_800],
    ])
    // The next run the same day: the requests were asked already (whatever became of them): none again.
    const again = await runMoneyActions(planOf(f), f, { runId: 'bm-7', live: true, guard: async () => auto() })
    expect(h.asks).toHaveLength(2)
    expect(again.counts.asked).toBe(0)
    expect(again.proposals[0]).toMatchObject({ approvalId: 'ap-1', fresh: false, why: 'asked already today: it waits for a person' })
    expect(again.proposals[1]).toMatchObject({ approvalId: 'ap-2', fresh: false, why: expect.stringMatching(/waits for a person: no second one$/) })
    expect(again.campaigns.every((c) => c.sent === 'asked')).toBe(true)
  })
})

describe('AB-8 follow-up — the per-write value cap, checked before anything is asked or written', () => {
  it('a cap above it: never written, never asked (nobody in Nexus could set it) — said once a month, held each run', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS', '30000')
    for (const levels of [AUTO, PROPOSE]) {
      h.claims.clear()
      const f = facts(levels)
      expect(moneyStepsOf(planOf(f), f, { live: true, valueCapCents: 30_000 }).portfolios).toEqual([expect.objectContaining({ do: 'over-value', toCents: 36_800 })])
      const out = await runMoneyActions(planOf(f), f, { runId: 'bm-v', live: true, guard: async () => auto() })
      expect(h.capWrites).toEqual([])
      expect(h.asks.filter((a) => a.tool === 'set-portfolio')).toEqual([])
      expect(out.portfolios).toEqual([expect.objectContaining({ sent: 'held', toCents: 36_800, why: expect.stringMatching(/above the per-write value cap .* the gate refuses it for every writer — the brain, an approved set-portfolio and the Portfolios page alike/) })])
      expect(out.proposals.find((p) => p.kind === 'portfolioCap')).toMatchObject({ key: `cap-over:${PRODUCT}:IT:pf-x:2026-10`, status: 'blocked', approvalId: null, fresh: true })
      // Rerun: held again, nothing new said (once a month).
      const again = await runMoneyActions(planOf(f), f, { runId: 'bm-v2', live: true, guard: async () => auto() })
      expect(again.portfolios[0]).toMatchObject({ sent: 'held' })
      expect(again.proposals.find((p) => p.kind === 'portfolioCap')).toMatchObject({ fresh: false, why: expect.stringContaining('(said already this month)') })
      expect([...h.claims.values()].filter((c) => c.kind === 'portfolioCapOverValue')).toHaveLength(1)
    }
    expect(h.capWrites).toEqual([])
  })

  it('a budget above it at AUTO: held before the write (the gate would refuse the brain); below it: written', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS', '1000')
    const f = facts(AUTO)
    const out = await runMoneyActions(planOf(f), f, { runId: 'bm-b', live: true, guard: async () => auto() })
    expect(h.budgetWrites.map((w) => w.campaignId)).toEqual(['c3', 'c4'])
    expect(out.campaigns.filter((c) => c.sent === 'held').map((c) => [c.campaignId, c.why])).toEqual([
      ['c1', expect.stringMatching(/^the day's base .* is above the per-write value cap/)], ['c2', expect.stringMatching(/^the day's base .* is above the per-write value cap/)],
    ])
    // A rung above it: held; the base under it still written.
    expect(steps(ladderFacts(), true).campaigns[0]).toMatchObject({ do: 'write', layer: 'ladder', toCents: 2_625 })
    const f2 = ladderFacts()
    expect(moneyStepsOf(planOf(f2), f2, { live: true, valueCapCents: 2_000 }).campaigns).toEqual([expect.objectContaining({ do: 'hold', why: expect.stringMatching(/^the rung \+75 % to .* is above the per-write value cap/) })])
  })
})

describe('AB-8 follow-up — asked once, atomically; a refusal is not asked again the same day', () => {
  it('the gate did not queue it: the key is kept — not asked again today, and the answer says it asks again tomorrow', async () => {
    const f = facts(PROPOSE)
    h.askOutcome = () => ({ ok: false, mode: 'error', error: 'tool set-campaign-budget is disabled' })
    const out = await runMoneyActions(planOf(f), f, { runId: 'bm-r1', live: true, guard: async () => auto() })
    expect(out.proposals.map((p) => [p.kind, p.status, p.fresh])).toEqual([['budgets', 'refused', true], ['portfolioCap', 'refused', true]])
    expect(out.campaigns.every((c) => c.sent === 'refused')).toBe(true)
    h.askOutcome = null
    const again = await runMoneyActions(planOf(f), f, { runId: 'bm-r2', live: true, guard: async () => auto() })
    expect(h.asks).toHaveLength(2)
    expect(again.proposals[0]).toMatchObject({ status: 'refused', fresh: false, why: 'not asked again today: the gate did not queue it (tool set-campaign-budget is disabled); the brain asks again on the next budget day (2026-10-09)' })
  })

  it('a person refused it: not asked again that day, whatever the amount; the next day only another amount is asked', async () => {
    const f = facts(PROPOSE)
    await runMoneyActions(planOf(f), f, { runId: 'bm-p1', live: true, guard: async () => auto() })
    expect(h.asks.map((a) => a.tool)).toEqual(['set-campaign-budget', 'set-portfolio'])
    h.approvals.set('ap-1', { status: 'rejected', decidedBy: 'Owner' })
    h.approvals.set('ap-2', { status: 'rejected', decidedBy: 'Owner' })
    // The same day the plan's cap moved (more spend in the month): no new request either.
    const moved = facts(PROPOSE, { envelope: { productId: PRODUCT, cents: 34_000, source: 'own', why: 'its own monthly budget' } })
    const sameDay = await runMoneyActions(planOf(moved), moved, { runId: 'bm-p2', live: true, guard: async () => auto() })
    expect(h.asks).toHaveLength(2)
    expect(sameDay.proposals[0]).toMatchObject({ status: 'rejected', why: 'a person refused it today (Owner): not asked again today; the brain asks again on the next budget day (2026-10-09)' })
    expect(sameDay.proposals[1]).toMatchObject({ status: 'rejected', fresh: false, why: 'a person refused it today (Owner): not asked again today; from 2026-10-09 the brain asks again only for another amount (this one not again this month)' })
    expect(sameDay.campaigns.every((c) => c.sent === 'held') && sameDay.portfolios.every((c) => c.sent === 'held')).toBe(true)
    // The next budget day: the budgets are asked again; the refused amount is not, another one is.
    const next = new Date('2026-10-09T12:00:00Z')
    const tomorrow = facts(PROPOSE, { clock: moneyClock(next, 'Europe/Rome', 'IT') })
    const t = await runMoneyActions(planOf(tomorrow), tomorrow, { runId: 'bm-p3', live: true, guard: async () => auto() })
    expect(planOf(tomorrow).portfolioCap.portfolios[0].capCents).toBe(36_800)
    expect(t.proposals.map((p) => [p.kind, p.fresh, p.status])).toEqual([['budgets', true, 'pending'], ['portfolioCap', false, 'rejected']])
    expect(t.proposals[1].why).toBe('this amount was asked already this month (rejected): not asked again this month')
    const other = facts(PROPOSE, { clock: moneyClock(next, 'Europe/Rome', 'IT'), envelope: { productId: PRODUCT, cents: 34_000, source: 'own', why: 'its own monthly budget' } })
    const o = await runMoneyActions(planOf(other), other, { runId: 'bm-p4', live: true, guard: async () => auto() })
    expect(o.proposals[1]).toMatchObject({ kind: 'portfolioCap', fresh: true, status: 'pending' })
    expect(h.asks.filter((a) => a.tool === 'set-portfolio')).toHaveLength(2)
  })

  it('asking failed (not refused): the key is given back, the next run asks', async () => {
    const f = facts(PROPOSE)
    h.askOutcome = () => { throw new Error('database away') }
    await expect(runMoneyActions(planOf(f), f, { runId: 'bm-f1', live: true, guard: async () => auto() })).rejects.toThrow('database away')
    expect(h.claims.size).toBe(0)
    h.askOutcome = null
    const out = await runMoneyActions(planOf(f), f, { runId: 'bm-f2', live: true, guard: async () => auto() })
    expect(out.proposals.map((p) => p.fresh)).toEqual([true, true])
  })
})

describe('AB-8 — AUTO under a switch that is not live', () => {
  it('nothing is written; the logged actions hold every move with the reason', async () => {
    const f = facts(AUTO)
    const out = await runMoneyActions(planOf(f), f, { runId: 'bm-8', live: false, guard: async () => auto() })
    expect([h.budgetWrites, h.capWrites, h.asks]).toEqual([[], [], []])
    expect(out).toMatchObject({ mode: 'SHADOW', counts: { held: 5 } })
    expect(out.campaigns.every((c) => c.sent === 'held' && /NEXUS_BID_BRAIN_MODE is not live/.test(c.why))).toBe(true)
    expect(moneyActionsWords(out)).toBe('')
  })
})

describe('AB-15 — the kill switch and the hold after an auto-undo', () => {
  it('a held campaign budget and a held cap are steps that hold, in the words given; the rest is written as before (pure)', () => {
    const f = facts(AUTO)
    const held = moneyStepsOf(planOf(f), f, { live: true, holds: { budget: (id) => (id === 'c2' ? 'auto-undo put back a brain change here (judgement j1): held until 2026-10-15' : null), cap: () => 'stopped by the Owner\'s kill switch (user:owner, 2026-10-08, every product in IT): "test stop"' } })
    expect(held.campaigns.map((s) => [s.campaignId, s.do])).toEqual([['c1', 'write'], ['c2', 'hold'], ['c3', 'write'], ['c4', 'write']])
    expect(held.campaigns[1]).toMatchObject({ why: 'auto-undo put back a brain change here (judgement j1): held until 2026-10-15: not written' })
    expect(held.portfolios).toEqual([expect.objectContaining({ portfolioId: 'pf-x', do: 'hold', why: expect.stringMatching(/kill switch .*: not written$/) })])
    // Without holds: exactly the steps of before.
    expect(moneyStepsOf(planOf(f), f, { live: true, holds: { budget: () => null, cap: () => null } })).toEqual(steps(f))
  })

  it('runMoneyActions reads the holds: a killed budgets lever writes no budget, the cap still goes', async () => {
    for (const id of ['c1', 'c2', 'c3', 'c4']) h.budgetHeld.set(id, 'stopped by the Owner\'s kill switch (user:owner, 2026-10-08, product A in IT): "test stop"')
    const f = facts(AUTO)
    const out = await runMoneyActions(planOf(f), f, { runId: 'bm-k', live: true, guard: async () => auto() })
    expect(h.budgetWrites).toEqual([])
    expect(h.capWrites).toHaveLength(1)
    expect(out.campaigns.every((c) => c.sent === 'held' && /kill switch/.test(c.why))).toBe(true)
    expect(out.counts).toMatchObject({ queued: 0, written: 1, held: 4 })
  })
})
