/**
 * ONE BRAIN AB-7 — the month's envelope per product in one market (budget-envelope.ts): the Owner's own product budget
 * wins, a playbook budget × the days next, then a share of the market budget by spend, the reserve for campaigns no
 * product's brain owns, Σ never above the market budget, a zero-spend product without a share, a category cap bounding.
 * Every value is made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { apportion, marketBudget, splitEnvelopes, type EnvelopeInput, type EnvelopeProduct } from './budget-envelope.js'

const product = (productId: string, over: Partial<EnvelopeProduct> = {}): EnvelopeProduct => ({ productId, own: null, playbookDaily: null, categoryCaps: [], trailingSpendCents: 0, ...over })
const input = (over: Partial<EnvelopeInput> = {}): EnvelopeInput => ({
  market: 'IT', month: '2026-10', daysInMonth: 31, windowDays: 30, budget: { strategy: null, plan: null }, products: [], reserveSpendCents: 0, ...over,
})
const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0)

describe('apportion — parts that add up to the whole', () => {
  it('splits by weight with the largest remainder, to the cent', () => {
    expect(apportion(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(apportion(60_000, [30_000, 12_000, 4_500])).toEqual([38_710, 15_484, 5_806])
    expect(sum(apportion(60_000, [29_999, 12_003, 4_501]))).toBe(60_000)
  })
  it('a zero or negative weight gets nothing; no weight at all, nothing for anyone', () => {
    expect(apportion(1000, [0, 3, -2, 1])).toEqual([0, 750, 0, 250])
    expect(apportion(1000, [0, 0])).toEqual([0, 0])
    expect(apportion(0, [1, 2])).toEqual([0, 0])
  })
})

describe('the market budget — the stricter of the strategy cap and the Budget Manager plan', () => {
  it('takes the smaller one and names both; 0 or none is no cap', () => {
    expect(marketBudget({ strategy: { cents: 80_000, from: 'ads strategy: Italy (IT) v2' }, plan: { cents: 60_000, from: 'the plan' } })).toEqual({ cents: 60_000, from: 'the plan (stricter than ads strategy: Italy (IT) v2, €800.00)' })
    expect(marketBudget({ strategy: { cents: 0, from: 's' }, plan: null })).toEqual({ cents: null, from: null })
    expect(marketBudget({ strategy: null, plan: { cents: 50_000, from: 'the plan' } })).toEqual({ cents: 50_000, from: 'the plan' })
  })
})

describe('AB-7 — each product\'s envelope', () => {
  it('a product\'s own monthly budget (the ads strategy product row) wins; the rest of the market is shared by spend, the shared campaigns keep a reserve', () => {
    const split = splitEnvelopes(input({
      budget: { strategy: null, plan: { cents: 60_000, from: 'the Budget Manager\'s 2026-10 plan' } },
      products: [
        product('prod-a', { own: { cents: 32_000, from: 'ads strategy: Product A (IT) v2' }, trailingSpendCents: 30_000 }),
        product('prod-b', { trailingSpendCents: 12_000 }),
        product('prod-c', { trailingSpendCents: 3_000 }),
      ],
      reserveSpendCents: 5_000,
    }))
    expect(split.envelopes.get('prod-a')).toMatchObject({ cents: 32_000, source: 'own', why: 'its own monthly budget (ads strategy: Product A (IT) v2)' })
    // €280 left, shared 12,000 : 3,000 : 5,000 (the reserve).
    expect(split.envelopes.get('prod-b')).toMatchObject({ cents: 16_800, source: 'share', sharePct: 60 })
    expect(split.envelopes.get('prod-c')).toMatchObject({ cents: 4_200, source: 'share', sharePct: 15 })
    expect(split).toMatchObject({ budgetCents: 60_000, fixedCents: 32_000, sharedCents: 21_000, reserveCents: 7_000, totalCents: 53_000, warnings: [] })
    expect(split.totalCents + split.reserveCents).toBe(split.budgetCents)
    expect(split.envelopes.get('prod-b')!.why).toContain('60 % of the €280.00 left after the products with their own budget')
  })

  it('a playbook daily budget × the days of the month, when the product has no budget of its own', () => {
    const split = splitEnvelopes(input({ products: [product('prod-a', { playbookDaily: { cents: 1_000, from: 'playbook: Product A (IT) v3' }, trailingSpendCents: 30_000 })] }))
    expect(split.envelopes.get('prod-a')).toMatchObject({ cents: 31_000, source: 'playbook', why: 'its playbook\'s daily budget €10.00 × 31 days (playbook: Product A (IT) v3)' })
    // Its own budget beats its playbook.
    const own = splitEnvelopes(input({ products: [product('prod-a', { own: { cents: 32_000, from: 'ads strategy: Product A (IT) v2' }, playbookDaily: { cents: 1_000, from: 'p' } })] }))
    expect(own.envelopes.get('prod-a')).toMatchObject({ cents: 32_000, source: 'own' })
  })

  it('no market budget: a product with nothing of its own has no envelope (no pace, no brake, no cap), said', () => {
    const split = splitEnvelopes(input({ products: [product('prod-a', { trailingSpendCents: 30_000 }), product('prod-b', { own: { cents: 20_000, from: 's' } })] }))
    expect(split.envelopes.get('prod-a')).toMatchObject({ cents: null, source: 'none' })
    expect(split.envelopes.get('prod-a')!.why).toMatch(/^no envelope: the Owner set no monthly budget for IT/)
    expect(split).toMatchObject({ budgetCents: null, totalCents: 20_000 })
  })

  it('zero spend: a product that spent nothing in the window gets no share of the market budget (a share of nothing is a stop)', () => {
    const split = splitEnvelopes(input({ budget: { strategy: { cents: 30_000, from: 'ads strategy: Italy (IT) v1' }, plan: null }, products: [product('prod-a', { trailingSpendCents: 0 }), product('prod-b', { trailingSpendCents: 9_000 })] }))
    expect(split.envelopes.get('prod-a')).toMatchObject({ cents: null, source: 'none' })
    expect(split.envelopes.get('prod-a')!.why).toContain('spent nothing in the last 30 days')
    expect(split.envelopes.get('prod-b')).toMatchObject({ cents: 30_000, source: 'share', sharePct: 100 })
  })

  it('Σ envelopes never passes the market budget: own and playbook budgets above it are scaled to fit, said; the others get 0', () => {
    const split = splitEnvelopes(input({
      budget: { strategy: { cents: 50_000, from: 'ads strategy: Italy (IT) v4' }, plan: null },
      products: [product('prod-a', { own: { cents: 40_000, from: 'a' } }), product('prod-b', { playbookDaily: { cents: 1_000, from: 'b' } }), product('prod-c', { trailingSpendCents: 4_000 })],
    }))
    // 40,000 + 31,000 = 71,000 > 50,000 → each × 70.4 %.
    expect(split.envelopes.get('prod-a')).toMatchObject({ cents: 28_169, source: 'own', scaledPct: 70.4 })
    expect(split.envelopes.get('prod-b')).toMatchObject({ cents: 21_831, source: 'playbook', scaledPct: 70.4 })
    expect(split.envelopes.get('prod-c')).toMatchObject({ cents: 0, source: 'share' })
    expect(split.totalCents).toBe(50_000)
    expect(split.warnings).toEqual([expect.stringContaining('scaled to 70.4 % to fit it')])
  })

  it('a category cap bounds a product\'s envelope (a product cannot spend more than its category may)', () => {
    const split = splitEnvelopes(input({ products: [product('prod-a', { own: { cents: 32_000, from: 'a' }, categoryCaps: [{ cents: 30_000, from: 'ads strategy: Jackets (IT) v1' }, { cents: 90_000, from: 'x' }] })] }))
    expect(split.envelopes.get('prod-a')).toMatchObject({ cents: 30_000, boundBy: 'ads strategy: Jackets (IT) v1' })
    expect(split.envelopes.get('prod-a')!.why).toContain('lowered to the category cap €300.00')
  })
})
