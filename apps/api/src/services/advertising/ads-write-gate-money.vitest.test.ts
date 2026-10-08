/**
 * ONE BRAIN AB-8 — the brain's money writer at the write gate (design 2026-10-08-ads-one-brain/DESIGN.md §2.5, §2.6, §3):
 *
 *   owner     the money actors (brain/budget-ladder.ts MONEY_ACTORS) write only a lever the brain owns: under a non-live
 *             server switch, on a lever nobody holds, or one the Owner locked, they are refused; owned, they pass. Every
 *             other writer — the brain's other actors included — is judged exactly as AB-5 judges it.
 *   ladder    the brain's own budget write may pass the day-move CEILING as its intraday ladder (≤ +100 % of today's base,
 *             the base inside the bound), and the day after a ladder opens at the base for it; the floor binds it as
 *             everyone. Another writer with the same numbers is refused as before — the limit is not loosened for anyone else.
 *   unread    follow-up: when the money actor's lever holders cannot be read, the gate fails with the read's error (the
 *             ads worker sends the row again later) — never a refusal it would settle SKIPPED, as AB-5 (#523) set it
 *   dispatch  follow-up: a queued ladder rung is judged again when the worker sends it: its own queued row is not counted
 *             against it, and an Owner's lock or a server switch turned off since it was asked refuses it there
 *
 * The lever holders are mocked (brain/lever-owners.ts has its own tests and a real-PostgreSQL suite); the budget log is
 * what the gate reads. Every value is made up (public repo).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CampaignLeverOwners, LeverHold } from './brain/lever-owners.js'

const campaignFindUnique = vi.fn()
type LogRow = { userId: string | null; payloadBefore: unknown; payloadAfter: unknown; evidence?: unknown; amazonResponseStatus?: string; at: Date; queueId?: string | null }
let log: LogRow[] = []
/**
 * The budget log as Prisma answers the gate: rows of the campaign by createdAt bounds, order and take — and, at dispatch,
 * without the write's own queued row (the gate's `OR: [{ outboundQueueId: null }, { outboundQueueId: { not } }]`).
 */
const actionLogFindMany = vi.fn(async (args: { where?: { createdAt?: { gte?: Date; lt?: Date }; OR?: Array<{ outboundQueueId: null | { not: string } }> }; orderBy?: { createdAt: 'asc' | 'desc' }; take?: number }) => {
  const c = args.where?.createdAt
  const own = args.where?.OR?.map((o) => o.outboundQueueId).find((q): q is { not: string } => !!q && typeof q === 'object')?.not
  let rows = log.filter((r) => (!c?.gte || r.at >= c.gte) && (!c?.lt || r.at < c.lt) && (!own || r.queueId !== own))
  rows = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime())
  if (args.orderBy?.createdAt === 'desc') rows.reverse()
  return (args.take ? rows.slice(0, args.take) : rows).map(({ at: _at, queueId: _q, ...r }) => r)
})
const actionLogFindFirst = vi.fn(async (args: Parameters<typeof actionLogFindMany>[0]) => (await actionLogFindMany({ ...args, orderBy: { createdAt: 'asc' } }))[0] ?? null)
vi.mock('../../db.js', () => ({
  default: {
    campaign: { get findUnique() { return campaignFindUnique }, findMany: vi.fn(async () => []) },
    bidBrainEnrollment: { findMany: vi.fn(async () => []) },
    adKeywordProtection: { findMany: vi.fn(async () => []) },
    adSpendCeiling: { findMany: vi.fn(async () => []) },
    adBidPolicy: { findMany: vi.fn(async () => []) },
    advertisingActionLog: { get findMany() { return actionLogFindMany }, get findFirst() { return actionLogFindFirst }, count: vi.fn(async () => 0) },
    adProductAd: { findMany: vi.fn(async () => []) },
    adWriteRefusal: { create: vi.fn(async () => ({})) },
    adsStrategy: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    // Owner decision 2A — a portfolio's cap meets its own limit: no product holds an own limit here (the server's applies).
    adsBrainOverride: { findFirst: vi.fn(async () => null) },
  },
}))
vi.mock('./ads-api-client.js', () => ({ adsMode: () => 'live' }))
vi.mock('./ads-profile-resolver.js', () => ({ adsProfileFor: vi.fn(async () => ({ profileId: 'p1', mode: 'production', writesEnabledAt: new Date() })) }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('./ads-automation-state.service.js', () => ({ getAutomationState: vi.fn(async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false })) }))
const campaignLeverOwners = vi.fn()
const portfolioCapHold = vi.fn()
vi.mock('./brain/lever-owners.js', () => ({ campaignLeverOwners, portfolioCapHold }))

const { checkAdsWriteGate, PRODUCT_BRAIN_ACTOR } = await import('./ads-write-gate.js')
const { MONEY_BUDGETS_ACTOR, MONEY_PORTFOLIO_ACTOR } = await import('./brain/budget-ladder.js')

const NOW = new Date('2026-10-08T12:00:00Z')
const TODAY = (h: number) => new Date(Date.UTC(2026, 9, 8, h))
const YESTERDAY = (h: number) => new Date(Date.UTC(2026, 9, 7, h))
/** A €40 campaign: the day-move bound around €40 is €28 … €60. */
const ROW = {
  liveBidWritesEnabled: true, dynamicBidding: null, liveBidWritesToday: 0, liveBidWritesDay: null,
  minBidCents: null, maxBidCents: null, pinPlacement: false, pinBids: false, pinBudget: false, pinNote: null,
  dailyBudget: 40, portfolioId: null, marketplace: 'IT', minBudgetCents: null, maxBudgetCents: null,
  adProduct: 'SPONSORED_PRODUCTS', type: 'SP', name: 'Product A exact', costType: null, budgetJson: null,
}
const owned = (): LeverHold => ({ kind: 'owned', productId: 'prod-a', market: 'IT', why: 'AUTO by the Owner\'s product override (user:owner, 2026-10-08)' })
const locked = (): LeverHold => ({ kind: 'locked', productId: 'prod-a', market: 'IT', why: 'locked by the Owner\'s campaign override (user:owner, 2026-10-08)' })
function holds(budgets: LeverHold | null) {
  campaignLeverOwners.mockResolvedValue(new Map<string, CampaignLeverOwners>(budgets ? [['c1', { campaignId: 'c1', name: ROW.name, market: 'IT', levers: { budgets } }]] : []))
}
/** A budget write of c1 from `fromCents` to `toCents`, as the worker hands it to the gate. */
const budget = (actor: string | null, fromCents: number, toCents: number, extra: Record<string, unknown> = {}) =>
  checkAdsWriteGate({ marketplace: 'IT', campaignId: 'c1', payloadValueCents: toCents, field: 'dailyBudget', fields: ['dailyBudget'], intendedValueCents: toCents, previousValueCents: fromCents, actor, ...extra } as never)
const row = (userId: string, before: number, after: number, at: Date, layer: string | null = null, status = 'SUCCESS', queueId: string | null = null): LogRow =>
  ({ userId, payloadBefore: { dailyBudget: before / 100 }, payloadAfter: { dailyBudget: after / 100 }, evidence: layer ? { brain: { layer } } : null, amazonResponseStatus: status, at, queueId })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  campaignFindUnique.mockReset().mockResolvedValue(ROW)
  campaignLeverOwners.mockReset()
  portfolioCapHold.mockReset().mockResolvedValue(null)
  holds(owned())
  log = []
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

describe('AB-8 — the money actors write only a lever the brain owns', () => {
  it('owned: the brain\'s budget write passes', async () => {
    expect(await budget(MONEY_BUDGETS_ACTOR, 4_000, 4_500)).toMatchObject({ allowed: true, mode: 'live' })
  })

  it('a server switch not live, a lever nobody holds: refused as not the brain\'s, nothing else changes', async () => {
    holds(null)
    const r = await budget(MONEY_BUDGETS_ACTOR, 4_000, 4_500)
    expect(r).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner' })
    expect((r as { reason: string }).reason).toMatch(/writes only a lever the brain owns: the daily budget of campaign "Product A exact" \(c1\) is not the brain's — no enrolled product's brain holds it/)
    holds(owned())
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    expect(await budget(MONEY_BUDGETS_ACTOR, 4_000, 4_500)).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner', reason: expect.stringMatching(/NEXUS_BID_BRAIN_MODE is not live/) })
  })

  it('the Owner\'s lock: refused in his words (AB-5, before the ownership check)', async () => {
    holds(locked())
    expect(await budget(MONEY_BUDGETS_ACTOR, 4_000, 4_500)).toMatchObject({ allowed: false, deniedAt: 'owner_locked' })
  })

  it('every other writer is judged as before: the brain\'s other actor and a rule on a lever nobody holds pass', async () => {
    holds(null)
    expect(await budget(PRODUCT_BRAIN_ACTOR, 4_000, 4_500)).toMatchObject({ allowed: true })
    expect(await budget('automation:rule-x', 4_000, 4_500)).toMatchObject({ allowed: true })
    expect(await budget('user:owner', 4_000, 4_500, { manual: true })).toMatchObject({ allowed: true })
  })

  it('a portfolio: the cap of one the brain owns; none named, none owned, or a switch not live — refused', async () => {
    const cap = (portfolioId: string | undefined) => checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 30_000, dimension: 'portfolio', field: 'budgetAmount', fields: ['budgetAmount'], actor: MONEY_PORTFOLIO_ACTOR, ...(portfolioId ? { portfolioId } : {}) } as never)
    portfolioCapHold.mockResolvedValue(owned())
    expect(await cap('pf-1')).toMatchObject({ allowed: true })
    portfolioCapHold.mockResolvedValue(null)
    expect(await cap('pf-1')).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner' })
    expect(await cap(undefined)).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner', reason: expect.stringMatching(/makes no portfolio/) })
    portfolioCapHold.mockResolvedValue(owned())
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    expect(await cap('pf-1')).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner' })
  })
})

describe('AB-8 — the intraday ladder\'s give-back exception (the day-move bound)', () => {
  it('a rung above the ceiling: up to +100 % of today\'s base passes for the brain; beyond it, refused', async () => {
    // No write today: the day opened at €40, the ceiling is €60, the base is €40 → the ladder may reach €80.
    expect(await budget(MONEY_BUDGETS_ACTOR, 4_000, 8_000)).toMatchObject({ allowed: true })
    const beyond = await budget(MONEY_BUDGETS_ACTOR, 4_000, 8_100)
    expect(beyond).toMatchObject({ allowed: false, deniedAt: 'budget_day_move' })
    expect((beyond as { reason: string }).reason).toMatch(/The brain's intraday ladder may pass the ceiling only up to \+100% of today's base €40.00 \(€80.00\)/)
  })

  it('the same numbers from anyone else: refused as before — the limit is not loosened for them', async () => {
    // Nobody holds the lever, so one-owner-per-lever refuses no one: the day-move bound alone judges.
    holds(null)
    for (const actor of ['automation:rule-x', 'automation:budget-schedule-s1', PRODUCT_BRAIN_ACTOR, 'automation:bid-brain']) {
      expect(await budget(actor, 4_000, 8_000), actor).toMatchObject({ allowed: false, deniedAt: 'budget_day_move' })
    }
    // A person is not refused: his own limit asks for his "Send anyway", as before.
    expect(await budget('user:owner', 4_000, 8_000, { manual: true })).toMatchObject({ allowed: false, deniedAt: 'needs_confirmation' })
  })

  it('today\'s base is the brain\'s base move, not its rungs', async () => {
    log = [row(MONEY_BUDGETS_ACTOR, 4_000, 5_000, TODAY(1), 'base'), row(MONEY_BUDGETS_ACTOR, 5_000, 6_250, TODAY(8), 'ladder')]
    expect(await budget(MONEY_BUDGETS_ACTOR, 6_250, 10_000)).toMatchObject({ allowed: true })
    expect(await budget(MONEY_BUDGETS_ACTOR, 6_250, 10_100)).toMatchObject({ allowed: false, deniedAt: 'budget_day_move' })
  })

  it('the next day opens at the base: the give-back passes for the brain, and the same cut by another writer is refused', async () => {
    log = [row(MONEY_BUDGETS_ACTOR, 4_000, 5_000, YESTERDAY(1), 'base'), row(MONEY_BUDGETS_ACTOR, 5_000, 6_250, YESTERDAY(8), 'ladder'), row(MONEY_BUDGETS_ACTOR, 6_250, 10_000, YESTERDAY(17), 'ladder')]
    // €100 → €45: from the base €50 that is −10 % (inside); from €100 it would be −55 %.
    expect(await budget(MONEY_BUDGETS_ACTOR, 10_000, 4_500)).toMatchObject({ allowed: true })
    holds(null)
    expect(await budget('automation:rule-x', 10_000, 4_500)).toMatchObject({ allowed: false, deniedAt: 'budget_day_move' })
    holds(owned())
    // Opened at the base, the floor still binds the brain: €50 → €30 is −40 %.
    const floor = await budget(MONEY_BUDGETS_ACTOR, 10_000, 3_000)
    expect(floor).toMatchObject({ allowed: false, deniedAt: 'budget_day_move' })
    expect((floor as { reason: string }).reason).toMatch(/the day opened at €50.00 \(the base of the brain's ladder of an earlier day/)
  })

  it('a rung the gate refused moved nothing: passed over; a person\'s change since ends the carry', async () => {
    log = [row(MONEY_BUDGETS_ACTOR, 4_000, 5_000, YESTERDAY(1), 'base'), row(MONEY_BUDGETS_ACTOR, 5_000, 6_250, YESTERDAY(8), 'ladder'), row(MONEY_BUDGETS_ACTOR, 6_250, 12_000, YESTERDAY(17), 'ladder', 'SKIPPED')]
    expect(await budget(MONEY_BUDGETS_ACTOR, 6_250, 4_500)).toMatchObject({ allowed: true })
    log.push(row('user:owner', 6_250, 9_000, YESTERDAY(20)))
    // The day opens at the person's €90 for everyone, the brain included: €45 is past the floor.
    expect(await budget(MONEY_BUDGETS_ACTOR, 9_000, 4_500)).toMatchObject({ allowed: false, deniedAt: 'budget_day_move' })
  })
})

describe('AB-8 follow-up — the money actor\'s holders cannot be read: try again, never a refusal', () => {
  it('a budget: the gate fails with the read\'s own error (the worker sends the row again later), not a deny it would settle SKIPPED', async () => {
    // AB-5's check reads the holders first (the brain owns the lever: it passes); the money actor's own read then fails.
    campaignLeverOwners.mockResolvedValueOnce(new Map([['c1', { campaignId: 'c1', name: ROW.name, market: 'IT', levers: { budgets: owned() } }]])).mockRejectedValueOnce(new Error('db down'))
    await expect(budget(MONEY_BUDGETS_ACTOR, 4_000, 4_500)).rejects.toThrow('db down')
    // Unreadable from the first read: the same.
    campaignLeverOwners.mockReset().mockRejectedValue(new Error('db down'))
    await expect(budget(MONEY_BUDGETS_ACTOR, 4_000, 4_500)).rejects.toThrow('db down')
    // A person's write needs no read.
    expect(await budget('user:owner', 4_000, 4_500, { manual: true })).toMatchObject({ allowed: true })
  })

  it('a portfolio cap: the same', async () => {
    portfolioCapHold.mockResolvedValueOnce(owned()).mockRejectedValueOnce(new Error('db down'))
    await expect(checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 30_000, dimension: 'portfolio', portfolioId: 'pf-1', field: 'budgetAmount', fields: ['budgetAmount'], actor: MONEY_PORTFOLIO_ACTOR } as never)).rejects.toThrow('db down')
  })
})

describe('AB-8 follow-up — a queued ladder rung is judged again at dispatch', () => {
  /** At 08:00 the brain asked a rung €40 → €70 on today's €40 base; Nexus wrote its copy and queued it (its row PENDING). */
  const queued = () => {
    log = [row(MONEY_BUDGETS_ACTOR, 4_000, 7_000, TODAY(8), 'ladder', 'PENDING', 'q-rung')]
    campaignFindUnique.mockResolvedValue({ ...ROW, dailyBudget: 70 })
  }
  /** The worker's gate call for that row: its queue id, the value it replaces and the value it sends. */
  const dispatch = () => budget(MONEY_BUDGETS_ACTOR, 4_000, 7_000, { queueId: 'q-rung' })

  it('nothing changed since it was asked: it passes — its own queued row is not counted against it', async () => {
    queued()
    expect(await dispatch()).toMatchObject({ allowed: true })
  })

  it('the Owner locked the budget since: refused at dispatch, in his words', async () => {
    queued()
    holds(locked())
    expect(await dispatch()).toMatchObject({ allowed: false, deniedAt: 'owner_locked' })
  })

  it('the lever left the brain, or the server switch went to shadow, since: refused as not the brain\'s', async () => {
    queued()
    holds(null)
    expect(await dispatch()).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner' })
    holds(owned())
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    expect(await dispatch()).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner', reason: expect.stringMatching(/NEXUS_BID_BRAIN_MODE is not live/) })
  })

  it('a rung that became past +100 % of today\'s base since (the brain\'s base moved down meanwhile): refused at dispatch', async () => {
    // The base went €40 → €30 at 09:00 (landed) after the rung to €70 was queued at 08:00: €70 is past €30 + 100 % = €60.
    log = [row(MONEY_BUDGETS_ACTOR, 4_000, 7_000, TODAY(8), 'ladder', 'PENDING', 'q-rung'), row(MONEY_BUDGETS_ACTOR, 4_000, 3_000, TODAY(9), 'base')]
    expect(await dispatch()).toMatchObject({ allowed: false, deniedAt: 'budget_day_move' })
  })
})
