/**
 * ONE BRAIN AB-6 — a budget pool leaves out a campaign whose daily budget a product's brain owns, or the Owner holds:
 *   held       it keeps its budget (shift 0, heldBy says why); the pool's total less that budget is shared among the
 *              others by the strategy; counted in `leverHeld`; every campaign held → nothing moves, said
 *   writer     a run that may write reads the holders (rebalanceAndAudit); a person's approved run passes, as at the gate;
 *              a preview (no writer) reads nothing and proposes as before
 *   today      nothing enrolled: the same proposal as before, to the cent
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ pool: vi.fn(), campaigns: vi.fn(), audit: vi.fn(), poolUpdate: vi.fn(), campaignLeverOwners: vi.fn(), anyBrainEnrolled: vi.fn() }))
vi.mock('../../db.js', () => ({
  default: {
    budgetPool: { findUnique: h.pool, update: h.poolUpdate },
    campaign: { findMany: h.campaigns },
    budgetPoolRebalance: { create: h.audit },
  },
}))
vi.mock('./ads-mutation.service.js', () => ({ updateCampaignWithSync: vi.fn() }))
vi.mock('./brain/lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => h.anyBrainEnrolled(...a),
}))

const { computeRebalance, rebalanceAndAudit } = await import('./budget-pool-rebalancer.service.js')

const POOL = {
  id: 'pool-1', name: 'IT pool', enabled: true, dryRun: true, strategy: 'STATIC', totalDailyBudgetCents: 6000, maxShiftPerRebalancePct: 100, coolDownMinutes: 0, lastRebalancedAt: null,
  allocations: [
    { id: 'a-gale', campaignId: 'c-gale', marketplace: 'IT', targetSharePct: 50, minDailyBudgetCents: 100, maxDailyBudgetCents: null },
    { id: 'a-misano', campaignId: 'c-misano', marketplace: 'IT', targetSharePct: 30, minDailyBudgetCents: 100, maxDailyBudgetCents: null },
    { id: 'a-moss', campaignId: 'c-moss', marketplace: 'IT', targetSharePct: 20, minDailyBudgetCents: 100, maxDailyBudgetCents: null },
  ],
}
const OWNED = { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override' }
const holding = (...ids: string[]) => new Map(ids.map((id) => [id, { campaignId: id, name: id, market: 'IT', levers: { budgets: OWNED } }]))
const ENGINE = { actor: 'automation:budget-pool-rebalance' }
const byCampaign = (proposed: Array<{ campaignId: string | null; proposedBudgetCents: number; shiftCents: number; heldBy?: string }>) =>
  Object.fromEntries(proposed.map((p) => [p.campaignId, { to: p.proposedBudgetCents, shift: p.shiftCents, ...(p.heldBy ? { held: true } : {}) }]))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.pool.mockResolvedValue(POOL)
  h.campaigns.mockResolvedValue(POOL.allocations.map((a) => ({ id: a.campaignId, dailyBudget: '20.00', marketplace: 'IT' })))
  h.anyBrainEnrolled.mockResolvedValue(true)
  h.campaignLeverOwners.mockResolvedValue(new Map())
  h.audit.mockResolvedValue({ id: 'audit-1' })
})
afterEach(() => vi.unstubAllEnvs())

describe('AB-6 — a pool leaves a held daily budget out', () => {
  it('nothing held: the same proposal as before (50/30/20 of €60)', async () => {
    const r = await computeRebalance({ poolId: 'pool-1', triggeredBy: 'cron', writer: ENGINE })
    expect(byCampaign(r.proposed)).toEqual({ 'c-gale': { to: 3000, shift: 1000 }, 'c-misano': { to: 1800, shift: -200 }, 'c-moss': { to: 1200, shift: -800 } })
    expect(r).not.toHaveProperty('leverHeld')
    // and exactly the preview's (no writer, no read)
    const preview = await computeRebalance({ poolId: 'pool-1', triggeredBy: 'preview' })
    expect(preview.proposed).toEqual(r.proposed)
  })

  it('a held campaign keeps its €20; the other two share €40 by their shares (30:20); counted and said', async () => {
    h.campaignLeverOwners.mockResolvedValue(holding('c-gale'))
    const r = await computeRebalance({ poolId: 'pool-1', triggeredBy: 'cron', writer: ENGINE })
    expect(byCampaign(r.proposed)).toEqual({ 'c-gale': { to: 2000, shift: 0, held: true }, 'c-misano': { to: 2400, shift: 400 }, 'c-moss': { to: 1600, shift: -400 } })
    expect(r.proposed.map((p) => p.campaignId)).toEqual(['c-gale', 'c-misano', 'c-moss']) // the pool's order
    expect(r.proposed[0].heldBy).toBe('a product\'s brain runs the daily budget of campaign "c-gale" (c-gale) — product gale in IT')
    expect(r.leverHeld).toEqual({ counts: { productBrain: { budgets: 1 } } })
    expect(r.warnings.join(' ')).toContain('1 campaign kept at its budget')
  })

  it('every campaign held: nothing moves, said', async () => {
    h.campaignLeverOwners.mockResolvedValue(holding('c-gale', 'c-misano', 'c-moss'))
    const r = await computeRebalance({ poolId: 'pool-1', triggeredBy: 'cron', writer: ENGINE })
    expect(r.totalShiftCents).toBe(0)
    expect(r.proposed.every((p) => p.shiftCents === 0 && p.heldBy)).toBe(true)
    expect(r.warnings[0]).toContain('every campaign of the pool is held')
    expect(r.leverHeld).toEqual({ counts: { productBrain: { budgets: 3 } } })
  })

  it('a preview reads nothing; a person\'s approved run passes the held lever, as at the gate; the cron\'s run leaves it', async () => {
    h.campaignLeverOwners.mockResolvedValue(holding('c-gale'))
    await computeRebalance({ poolId: 'pool-1', triggeredBy: 'preview' })
    expect(h.campaignLeverOwners).not.toHaveBeenCalled()
    const person = await rebalanceAndAudit({ poolId: 'pool-1', triggeredBy: 'user:u1', actor: 'user:u1' as never, manual: true })
    expect(byCampaign(person.proposed)['c-gale']).toEqual({ to: 3000, shift: 1000 })
    const cron = await rebalanceAndAudit({ poolId: 'pool-1', triggeredBy: 'cron', actor: 'automation:budget-pool-rebalance' })
    expect(byCampaign(cron.proposed)['c-gale']).toEqual({ to: 2000, shift: 0, held: true })
    expect(cron.leverHeld).toEqual({ counts: { productBrain: { budgets: 1 } } })
  })

  it('the holders cannot be read: nothing left out on a guess, said unread', async () => {
    h.campaignLeverOwners.mockRejectedValue(new Error('db blip'))
    const r = await computeRebalance({ poolId: 'pool-1', triggeredBy: 'cron', writer: ENGINE })
    expect(byCampaign(r.proposed)['c-gale']).toEqual({ to: 3000, shift: 1000 })
    expect(r.leverHeld).toEqual({ counts: {}, unread: true })
  })
})
