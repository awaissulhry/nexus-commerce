/**
 * ONE BRAIN AB-9 — the market arbiter (brain/arbiter.ts), pure: two siblings on one term get one lead, by the Owner's pin,
 * the brand word, the pooled profit per click, then orders, clicks and id — the same lead whatever order the claims come
 * in; the others are capped at 0.8 × the lead's bid. Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { arbitrate, bidOn, pickLead, SIBLING_BID_RATIO, type Claim } from './arbiter.js'

const claim = (productId: string, over: Partial<Claim> = {}): Claim => ({
  productId, term: 'racing jacket', targets: [], wants: false, orders: 0, clicks: 0, profitPerClickCents: null, brandWord: null, ...over,
})
const kw = (targetId: string, bidCents: number, match = 'EXACT') => ({ targetId, campaignId: `c-${targetId}`, adGroupId: `g-${targetId}`, match, bidCents })

describe('AB-9 — the market arbiter', () => {
  it('two siblings on one term → one lead (the highest pooled profit per click); the other at most 0.8 × the lead\'s bid', () => {
    const leads = arbitrate([
      claim('p-storm', { targets: [kw('s1', 60)], orders: 3, clicks: 200, profitPerClickCents: 12 }),
      claim('p-sibling', { targets: [kw('m1', 70), kw('m2', 30, 'PHRASE')], orders: 5, clicks: 300, profitPerClickCents: 8 }),
    ])
    expect(leads.size).toBe(1)
    const l = leads.get('racing jacket')!
    expect(l).toMatchObject({ leadProductId: 'p-storm', rule: 'profit', leadBidCents: 60, maxBidCents: Math.floor(60 * SIBLING_BID_RATIO) })
    expect(l.contenders.filter((c) => c.lead).map((c) => c.productId)).toEqual(['p-storm'])
    expect(l.wouldLower).toEqual([{ productId: 'p-sibling', targetId: 'm1', campaignId: 'c-m1', adGroupId: 'g-m1', bidCents: 70, toBidCents: 48 }])
  })

  it('the brand word of exactly one contender beats profit; the Owner\'s pin beats the brand', () => {
    const claims = [
      claim('p-storm', { term: 'storm racing jacket', targets: [kw('s1', 40)], profitPerClickCents: 1, brandWord: 'storm' }),
      claim('p-sibling', { term: 'storm racing jacket', wants: true, profitPerClickCents: 50 }),
    ]
    expect(arbitrate(claims).get('storm racing jacket')).toMatchObject({ leadProductId: 'p-storm', rule: 'brand' })
    expect(arbitrate(claims, { pinned: new Map([['storm racing jacket', 'p-sibling']]) }).get('storm racing jacket')).toMatchObject({ leadProductId: 'p-sibling', rule: 'pinned', leadBidCents: null, maxBidCents: null, wouldLower: [] })
    // Both carry their brand word: the brand decides nothing.
    const both = arbitrate([claim('a', { wants: true, brandWord: 'x', profitPerClickCents: 2 }), claim('b', { wants: true, brandWord: 'y', profitPerClickCents: 3 })])
    expect(both.get('racing jacket')).toMatchObject({ leadProductId: 'b', rule: 'profit' })
  })

  it('ties fall to orders, then clicks, then the lowest id — the same lead whatever order the claims come in', () => {
    const a = claim('p-a', { wants: true, profitPerClickCents: 10, orders: 2, clicks: 100 })
    const b = claim('p-b', { wants: true, profitPerClickCents: 10, orders: 4, clicks: 50 })
    expect(arbitrate([a, b]).get('racing jacket')).toMatchObject({ leadProductId: 'p-b', rule: 'orders' })
    expect(arbitrate([b, a]).get('racing jacket')).toMatchObject({ leadProductId: 'p-b', rule: 'orders' })
    const c = claim('p-c', { wants: true, profitPerClickCents: 10, orders: 4, clicks: 90 })
    expect(arbitrate([a, b, c]).get('racing jacket')).toMatchObject({ leadProductId: 'p-c', rule: 'clicks' })
    const d = claim('p-0', { wants: true, profitPerClickCents: 10, orders: 4, clicks: 90 })
    expect(arbitrate([c, d]).get('racing jacket')).toMatchObject({ leadProductId: 'p-0', rule: 'id' })
    expect(arbitrate([d, c]).get('racing jacket')).toMatchObject({ leadProductId: 'p-0', rule: 'id' })
  })

  it('a contender whose profit cannot be measured is not compared; with none measured, orders decide', () => {
    const l = arbitrate([claim('p-a', { wants: true, profitPerClickCents: null, orders: 9 }), claim('p-b', { wants: true, profitPerClickCents: 1, orders: 1 })]).get('racing jacket')!
    expect(l).toMatchObject({ leadProductId: 'p-b', rule: 'profit' })
    expect(l.why).toMatch(/not measured for p-a/)
    expect(arbitrate([claim('p-a', { wants: true, orders: 9 }), claim('p-b', { wants: true, orders: 1 })]).get('racing jacket')).toMatchObject({ leadProductId: 'p-a', rule: 'orders' })
  })

  it('seeing a term is no claim: one claimant is no contest; a product\'s claims are merged', () => {
    expect(arbitrate([claim('p-a', { targets: [kw('a1', 40)] }), claim('p-b', { orders: 0, clicks: 900 })]).size).toBe(0)
    const merged = arbitrate([claim('p-a', { targets: [kw('a1', 40)] }), claim('p-a', { targets: [kw('a2', 45)], orders: 1 }), claim('p-b', { wants: true, profitPerClickCents: -5 })])
    expect(merged.get('racing jacket')!.contenders.find((c) => c.productId === 'p-a')).toMatchObject({ targets: 2, orders: 1, bidCents: 45 })
  })

  it('the lead\'s bid on the term: its exact bid first, else its highest', () => {
    expect(bidOn([kw('a', 30, 'BROAD'), kw('b', 25)])).toBe(25)
    expect(bidOn([kw('a', 30, 'BROAD'), kw('b', 35, 'PHRASE')])).toBe(35)
    expect(bidOn([])).toBeNull()
    expect(pickLead([claim('z', { wants: true }), claim('y', { wants: true })]).lead.productId).toBe('y')
  })
})
