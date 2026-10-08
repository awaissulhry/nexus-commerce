/**
 * ONE BRAIN AB-6 — the budget pool cron's line counts the campaigns its rebalances left at their budget (a product's brain
 * owns it, or the Owner holds it), per lever, and says when the holders could not be read; a normal line is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ pools: vi.fn(), rebalance: vi.fn() }))
vi.mock('../db.js', () => ({ default: { budgetPool: { findMany: h.pools } } }))
vi.mock('../services/advertising/budget-pool-rebalancer.service.js', () => ({
  BUDGET_POOL_CRON_ACTOR: 'automation:budget-pool-rebalance',
  computeRebalance: vi.fn(),
  rebalanceAndAudit: h.rebalance,
}))
vi.mock('../services/advertising/ads-engine-guard.js', () => ({ openEngineGuard: vi.fn(), nothingHeld: () => ({}), engineGuardNote: () => '' }))

const { runBudgetPoolRebalanceOnce, getBudgetPoolRebalanceStatus } = await import('./budget-pool-rebalance.job.js')

beforeEach(() => {
  vi.clearAllMocks()
  h.pools.mockResolvedValue([{ id: 'pool-1', dryRun: true }, { id: 'pool-2', dryRun: true }])
})

describe('AB-6 — the pool cron\'s line', () => {
  it('counts the held campaigns of every pool, per lever', async () => {
    h.rebalance
      .mockResolvedValueOnce({ ok: true, proposed: [], totalShiftCents: 400, leverHeld: { counts: { budgets: 1 } } })
      .mockResolvedValueOnce({ ok: true, proposed: [], totalShiftCents: 0, leverHeld: { counts: { budgets: 2 } } })
    const r = await runBudgetPoolRebalanceOnce()
    expect(r.leverHeld).toEqual({ budgets: 3 })
    expect(getBudgetPoolRebalanceStatus().lastSummary).toMatch(/ brain-levers=budgets:3 \(left to a product's brain or the Owner's lock\)$/)
  })

  it('says when the holders could not be read', async () => {
    h.rebalance.mockResolvedValue({ ok: true, proposed: [], totalShiftCents: 0, leverHeld: { counts: {}, unread: true } })
    await runBudgetPoolRebalanceOnce()
    expect(getBudgetPoolRebalanceStatus().lastSummary).toContain('brain-levers=unread')
  })

  it('nothing held: the line as before', async () => {
    h.rebalance.mockResolvedValue({ ok: true, proposed: [], totalShiftCents: 100 })
    const r = await runBudgetPoolRebalanceOnce()
    expect(r).not.toHaveProperty('leverHeld')
    expect(getBudgetPoolRebalanceStatus().lastSummary).toMatch(/^pools=2 rebalanced=2 live=0 skipped=0 shift=200¢ \d+ms$/)
  })
})
