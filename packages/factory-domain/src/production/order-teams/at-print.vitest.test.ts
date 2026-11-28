import { describe, expect, it } from 'vitest'
import { shareBasketsAtPrint, type OrderTeamShare } from './at-print'

// Made-up ids: teams and baskets are invented for the test.
const baskets = (count: number) => Array.from({ length: count }, (_, index) => ({ bundleId: `b${index + 1}` }))
const row = (orderTeamId: string, basketShare: number | null, inCharge = false): OrderTeamShare => ({ orderTeamId, inCharge, basketShare })
const plain = (shares: ReadonlyMap<string, readonly string[]>) => Object.fromEntries([...shares].map(([id, list]) => [id, [...list]]))

describe('shareBasketsAtPrint: split by share in line order, the rest to the team in charge', () => {
  it('exact: each team its share', () => {
    expect(plain(shareBasketsAtPrint([row('lead', 2, true), row('help', 3)], baskets(5)))).toEqual({ lead: ['b1', 'b2'], help: ['b3', 'b4', 'b5'] })
  })

  it('short: the rest goes to the team in charge', () => {
    expect(plain(shareBasketsAtPrint([row('help', 2), row('lead', 1, true)], baskets(6)))).toEqual({ help: ['b1', 'b2'], lead: ['b3', 'b4', 'b5', 'b6'] })
    // A team in charge without a share of its own still takes the rest.
    expect(plain(shareBasketsAtPrint([row('lead', null, true), row('help', 2)], baskets(3)))).toEqual({ help: ['b1', 'b2'], lead: ['b3'] })
    // Nobody in charge: the rest stays unnamed.
    expect(plain(shareBasketsAtPrint([row('help', 1)], baskets(3)))).toEqual({ help: ['b1'] })
  })

  it('long: the teams later in the list get what is left, maybe none', () => {
    expect(plain(shareBasketsAtPrint([row('lead', 3, true), row('help', 4), row('third', 2)], baskets(5)))).toEqual({ lead: ['b1', 'b2', 'b3'], help: ['b4', 'b5'] })
  })

  it('none: together (no share), no row, or no basket names nothing', () => {
    expect(shareBasketsAtPrint([row('lead', null, true), row('help', null)], baskets(4)).size).toBe(0)
    expect(shareBasketsAtPrint([], baskets(4)).size).toBe(0)
    expect(shareBasketsAtPrint([row('lead', 2, true)], []).size).toBe(0)
  })
})
