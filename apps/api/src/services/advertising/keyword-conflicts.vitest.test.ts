import { describe, it, expect } from 'vitest'
import { normKeyword, tosBiasOf, acosOf, cvrOf, pickChampion, type Contender } from './keyword-conflicts.service.js'

const C = (over: Partial<Contender>): Contender => ({
  campaignId: 'c', campaignName: 'c', status: 'ENABLED', asins: [], isMine: false, targetIds: [],
  bidCents: 50, impressions: 0, clicks: 0, spendCents: 0, salesCents: 0, orders: 0,
  acos: null, cvr: null, tosBias: 0, ...over,
})

// RC3.2 — normalisation makes "Giacca  MOTO " and "giacca moto" collide.
describe('normKeyword', () => {
  it('lowercases, collapses whitespace, trims', () => {
    expect(normKeyword('Giacca  MOTO ')).toBe('giacca moto')
    expect(normKeyword('  Casco\tIntegrale ')).toBe('casco integrale')
  })
})

describe('tosBiasOf', () => {
  it('reads the PLACEMENT_TOP percentage', () => {
    expect(tosBiasOf({ placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 40 }] })).toBe(40)
  })
  it('is 0 when there is no top-of-search bias', () => {
    expect(tosBiasOf({ placementBidding: [{ placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 20 }] })).toBe(0)
    expect(tosBiasOf(null)).toBe(0)
    expect(tosBiasOf({})).toBe(0)
  })
})

describe('acos / cvr', () => {
  it('acos is spend/sales, null without sales', () => {
    expect(acosOf(2500, 10000)).toBeCloseTo(0.25)
    expect(acosOf(2500, 0)).toBeNull()
  })
  it('cvr is orders/clicks, null without clicks', () => {
    expect(cvrOf(3, 12)).toBeCloseTo(0.25)
    expect(cvrOf(0, 0)).toBeNull()
  })
})

// RC3.2 — the champion that should OWN a contested keyword.
describe('pickChampion', () => {
  it('lowest ACOS wins among click-backed converters', () => {
    const a = C({ campaignId: 'a', clicks: 20, orders: 4, spendCents: 1000, salesCents: 8000, acos: 0.125 }) // 12.5%
    const b = C({ campaignId: 'b', clicks: 20, orders: 3, spendCents: 1000, salesCents: 4000, acos: 0.25 }) // 25%
    expect(pickChampion([a, b]).championId).toBe('a')
  })

  it('an order beats no order even with thin clicks', () => {
    const seller = C({ campaignId: 'seller', clicks: 1, orders: 1, spendCents: 300, salesCents: 5000, acos: 0.06 })
    const browser = C({ campaignId: 'browser', clicks: 40, orders: 0, impressions: 9000 })
    expect(pickChampion([seller, browser]).championId).toBe('seller')
  })

  it('no sales anywhere → keep the most-established (impressions)', () => {
    const big = C({ campaignId: 'big', clicks: 10, impressions: 5000 })
    const small = C({ campaignId: 'small', clicks: 8, impressions: 800 })
    const r = pickChampion([small, big])
    expect(r.championId).toBe('big')
    expect(r.reason).toMatch(/no sales/i)
  })

  it('no traffic at all → strongest intent (highest bid)', () => {
    const cheap = C({ campaignId: 'cheap', bidCents: 30 })
    const dear = C({ campaignId: 'dear', bidCents: 90 })
    expect(pickChampion([cheap, dear]).championId).toBe('dear')
  })

  it('empty input is safe', () => {
    expect(pickChampion([]).championId).toBe('')
  })
})
