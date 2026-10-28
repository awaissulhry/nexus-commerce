import { describe, expect, it } from 'vitest'
import { Dec } from '../../tax/decimal'
import { foldBalances, type Balance } from '../ledger/moves'
import { figuresOf, isHeld, itemTotals, reconcileBalances } from './overview'

const SITE = '0195f5d0-0000-7000-8000-0000000000a1'
const LEATHER = '0195f5d0-0000-7000-8000-0000000000b1'
const LINING = '0195f5d0-0000-7000-8000-0000000000b2'
const QUARANTINED = '0195f5d0-0000-7000-8000-0000000000c1'
const RELEASED = '0195f5d0-0000-7000-8000-0000000000c2'
const STORE = '0195f5d0-0000-7000-8000-0000000000e1'
const BIN = '0195f5d0-0000-7000-8000-0000000000e2'
const status = { [QUARANTINED]: 'QUARANTINE', [RELEASED]: 'RELEASED' } as const

const balance = (locationId: string, itemId: string, onHand: string, lotId: string | null = null, hideId: string | null = null): Balance => ({
  siteId: SITE,
  locationId,
  itemId,
  itemColourId: null,
  lotId,
  hideId,
  onHand: new Dec(onHand),
})

// Ported from the old app's four-column stock (apps/factory src/lib/__tests__/material-stock.test.ts): available is
// what is physically free; here what a lot's quality status holds is not (reservations come with planning).
describe('on hand, held and available (SCM-190, SCM-198, QHS-073)', () => {
  it('a lot that is not RELEASED holds all of its stock; stock without a lot is never held', () => {
    expect(isHeld('QUARANTINE')).toBe(true)
    expect(isHeld('BLOCKED')).toBe(true)
    expect(isHeld('REJECTED')).toBe(true)
    expect(isHeld('RELEASED')).toBe(false)
    expect(isHeld(null)).toBe(false)
    const held = figuresOf(new Dec('53.2'), 'QUARANTINE')
    expect([held.onHand, held.held, held.available].map((value) => value.toFixed(4))).toEqual(['53.2000', '53.2000', '0.0000'])
    const free = figuresOf(new Dec('8'), null)
    expect([free.onHand, free.held, free.available].map((value) => value.toFixed(4))).toEqual(['8.0000', '0.0000', '8.0000'])
  })

  it('totals each item with its hides and area side by side (SCM-258)', () => {
    const balances = [
      balance(STORE, LEATHER, '53.2', QUARANTINED, 'hide-1'),
      balance(BIN, LEATHER, '51.8', RELEASED, 'hide-2'),
      balance(BIN, LEATHER, '20', RELEASED, 'hide-3'),
      balance(STORE, LINING, '120'),
    ]
    expect(itemTotals(balances, (lotId) => status[lotId as keyof typeof status])).toEqual([
      { itemId: LEATHER, itemColourId: null, onHand: '125.0000', held: '53.2000', available: '71.8000', hides: 3, heldHides: 1, locations: 2 },
      { itemId: LINING, itemColourId: null, onHand: '120.0000', held: '0.0000', available: '120.0000', hides: 0, heldHides: 0, locations: 1 },
    ])
  })
})

describe('the ledger reconciles (PLAN §4.7 end check)', () => {
  it('passes when the fold and the sums agree and nothing is below zero', () => {
    const moves = [{ siteId: SITE, itemId: LINING, itemColourId: null, lotId: null, hideId: null, fromLocationId: null, toLocationId: STORE, baseQuantity: '5' }]
    expect(reconcileBalances(foldBalances(moves), [balance(STORE, LINING, '5')])).toEqual({ mismatches: [], negative: [] })
  })

  it('names the keys that disagree and the balances below zero', () => {
    const result = reconcileBalances([balance(STORE, LINING, '5'), balance(BIN, LINING, '-1')], [balance(STORE, LINING, '4')])
    // In location order: STORE (…e1), then BIN (…e2).
    expect(result.mismatches.map((entry) => [entry.folded, entry.summed])).toEqual([
      ['5.0000', '4.0000'],
      ['-1.0000', '0.0000'],
    ])
    expect(result.negative).toHaveLength(1)
  })
})
