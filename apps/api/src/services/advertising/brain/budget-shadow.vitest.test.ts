/**
 * ONE BRAIN AB-8 follow-up — the money run reads Amazon's usage of the portfolio caps (one Amazon call per market) only
 * where it can matter: at a full slot (every 6 hours), never at a 15-minute tick, and only for the products whose budgets
 * or portfolioCap lever is PROPOSE or AUTO — never for a product at OBSERVE (its plan is a shadow). The market's money
 * load is mocked: what the run asks it to read is the subject. Made-up ids (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  enrollments: [] as Array<{ productId: string; marketplace: string }>,
  overrides: [] as unknown[],
  loads: [] as Array<{ market: string; readPortfolioUsage: unknown }>,
}))
vi.mock('../../../db.js', () => ({
  default: {
    adsBrainEnrollment: { findMany: vi.fn(async () => h.enrollments) },
    adsBrainOverride: { findMany: vi.fn(async () => h.overrides) },
    adsBrainBudgetDecision: { deleteMany: vi.fn(async () => ({ count: 0 })), createMany: vi.fn(async () => ({ count: 0 })) },
    $queryRaw: vi.fn(async () => []),
  },
}))
vi.mock('../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('./budget-load.js', () => ({
  loadMarketMoney: vi.fn(async (market: string, opts: { readPortfolioUsage?: unknown }) => {
    h.loads.push({ market, readPortfolioUsage: opts.readPortfolioUsage })
    return { market, facts: new Map() }
  }),
}))

const { moneyShadowProducts, readsPortfolioUsage, runMoneyShadowOnce } = await import('./budget-shadow.js')
const { ov } = await import('./__fixtures__/budget-facts.js')

const NOW = new Date('2026-10-08T12:00:00Z')
/** Product A's overrides (the fixture's), re-keyed to another product id. */
const of = (productId: string, rows: Array<ReturnType<typeof ov>>) => rows.map((r) => ({ ...r, productId }))

beforeEach(() => {
  h.loads = []
  h.enrollments = [{ productId: 'p-observe', marketplace: 'IT' }, { productId: 'p-budgets', marketplace: 'IT' }, { productId: 'p-cap', marketplace: 'IT' }, { productId: 'p-de', marketplace: 'DE' }]
  h.overrides = [
    ...of('p-budgets', [ov('LEVEL', 'budgets', 'PROPOSE')]),
    ...of('p-cap', [ov('LEVEL', 'portfolioCap', 'AUTO')]),
  ]
})

describe('AB-8 follow-up — Amazon\'s usage of the caps is read only where it can matter', () => {
  it('a product reads it when its budgets or its portfolioCap lever is PROPOSE or AUTO; at OBSERVE it does not', async () => {
    const products = await moneyShadowProducts()
    expect(products.map((p) => [p.productId, p.level, p.readsUsage])).toEqual([
      ['p-de', 'OBSERVE', false], ['p-budgets', 'PROPOSE', true], ['p-cap', 'OBSERVE', true], ['p-observe', 'OBSERVE', false],
    ])
    // Products handed in without the flag: from the budgets level alone.
    expect(readsPortfolioUsage({ productId: 'x', market: 'IT', level: 'AUTO' })).toBe(true)
    expect(readsPortfolioUsage({ productId: 'x', market: 'IT', level: 'OBSERVE' })).toBe(false)
  })

  it('a full slot asks the read for those products only (a market of OBSERVE products: none, so no Amazon call)', async () => {
    await runMoneyShadowOnce({ now: NOW, live: true })
    expect(h.loads).toEqual([
      { market: 'DE', readPortfolioUsage: [] },
      { market: 'IT', readPortfolioUsage: ['p-budgets', 'p-cap'] },
    ])
  })

  it('a 15-minute tick never asks it, whatever the levels', async () => {
    await runMoneyShadowOnce({ now: NOW, live: true, between: true, products: [{ productId: 'p-budgets', market: 'IT', level: 'AUTO', readsUsage: true }] })
    expect(h.loads).toEqual([{ market: 'IT', readPortfolioUsage: [] }])
  })
})
