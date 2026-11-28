import { describe, expect, it } from 'vitest'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { costOfOne } from '../now/model'
import { marginAt, pctOf, priceForTarget, priceOf, whatIf, whatIfBaseOf, type WhatIfBase } from './model'

/**
 * owb-pd5b step 5.3 (S4; design plan § 5zh "What if") — the calculator's arithmetic, in the browser, nothing saved: the materials and
 * the work in %, the overhead moving with them (a percent on material + labour), the other costs staying; the margin a share of the
 * PRICE; the lowest price that keeps the target, up to the cent. Written, not run (Owner rule). Made-up figures only.
 */

const BASE: WhatIfBase = { materials: 40, work: 50, overhead: 9, other: 1 }

describe('the typed fields', () => {
  it('a percent: "" is 0, "+10" and "10" are 10, "-5,5" is −5.5; out of −90…300 or not a number is refused', () => {
    expect(['', '+10', '10', '-5,5', '-90', '300'].map(pctOf)).toEqual([0, 10, 10, -5.5, -90, 300])
    expect(['-91', '301', 'ten', '1e2', '--5'].map(pctOf)).toEqual([null, null, null, null, null])
  })
  it('a price: "" is none, "189,50" is 189.5; a word or a negative is refused', () => {
    expect(priceOf('')).toBeUndefined()
    expect(priceOf('189,50')).toBe(189.5)
    expect(priceOf('-5')).toBeNull()
    expect(priceOf('abc')).toBeNull()
    expect(priceOf('1000000')).toBeNull()
  })
})

describe('the arithmetic', () => {
  it('nothing typed: the cost now, no change, no margin', () => {
    const answer = whatIf(BASE, { materialsPct: '', workPct: '', price: '' }, 35)
    expect(answer).toMatchObject({ cost: '100.00', change: '0.00', margin: null, verdict: null, touched: false })
    expect(answer.priceForTarget).toBe('153.85')
  })

  it('materials +10 %: 44; the overhead moves with materials + work (9 × 94 ÷ 90 = 9.40); the other costs stay', () => {
    const answer = whatIf(BASE, { materialsPct: '+10', workPct: '', price: '' }, 35)
    expect(answer.cost).toBe('104.40')
    expect(answer.change).toBe('4.40')
  })

  it('work −10 % and materials +10 %: 44 + 45 + 8.90 + 1 = 98.90, cheaper', () => {
    expect(whatIf(BASE, { materialsPct: '10', workPct: '-10', price: '' }, 35)).toMatchObject({ cost: '98.90', change: '-1.10' })
  })

  it('the margin at a price is a share of the PRICE, and says against the target', () => {
    expect(whatIf(BASE, { materialsPct: '', workPct: '', price: '160' }, 35)).toMatchObject({ margin: 37.5, verdict: 'KEEPS' })
    expect(whatIf(BASE, { materialsPct: '', workPct: '', price: '125' }, 35)).toMatchObject({ margin: 20, verdict: 'UNDER_TARGET' })
    expect(whatIf(BASE, { materialsPct: '', workPct: '', price: '90' }, 35)).toMatchObject({ margin: -11.1, verdict: 'UNDER_COST' })
    expect(marginAt(0, 100)).toBeNull()
  })

  it('the price for the target: cost ÷ (1 − target), up to the cent; none at 100 % or with no cost', () => {
    expect(priceForTarget(100, 35)).toBe(153.85)
    expect(priceForTarget(130, 35)).toBe(200)
    expect(priceForTarget(100, 100)).toBeNull()
    expect(priceForTarget(0, 35)).toBeNull()
  })

  it('a field that is not a number: no answer, and that field says why', () => {
    const answer = whatIf(BASE, { materialsPct: 'ten', workPct: '', price: 'x' }, 35)
    expect(answer.cost).toBeNull()
    expect(answer.problems.materialsPct).toEqual({ key: 'whatif.bad.pct', params: { min: -90, max: 300 } })
    expect(answer.problems.price).toEqual({ key: 'whatif.bad.price' })
    expect(answer.touched).toBe(true)
  })

  it('no materials and no work: the overhead stays as it is', () => {
    expect(whatIf({ materials: 0, work: 0, overhead: 5, other: 2 }, { materialsPct: '50', workPct: '50', price: '' }, 35).cost).toBe('7.00')
  })

  it('the base is the cost of one piece now, in its 4 parts', () => {
    // The components answer marks its figures with the cost grain (asMoney, as the API's handler does).
    const amount = (value: string) => asMoney('cost', value)
    const cost = costOfOne({ split: [{ size: '52', categories: [{ category: 'LEATHER', amount: amount('30') }, { category: 'MATERIAL', amount: amount('10') }, { category: 'LABOUR', amount: amount('50') }, { category: 'OVERHEAD', amount: amount('9') }, { category: 'PACKAGING', amount: amount('1') }], knownTotal: amount('100'), total: amount('100'), complete: true }] }, '52')!
    expect(whatIfBaseOf(cost)).toEqual(BASE)
  })
})
