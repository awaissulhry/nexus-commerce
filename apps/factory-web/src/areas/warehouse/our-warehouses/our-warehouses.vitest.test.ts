import { describe, expect, it } from 'vitest'
import type { OurWarehouse } from '../../sales/orders/record/shipments/legs/api'
import { actsOf, answerOf, daysWaiting, sectionsOf } from './model'

/**
 * owb-ss3 step 3.4 (design plan § 7) — Warehouse › Our warehouses, pure: one section per warehouse (by name), At our warehouse and On the
 * way each the oldest first, the customer's label here or awaited, the pieces, the acts by pack and send. Made-up data only.
 */

const customer = { partyId: 'party-a', code: 'C-ALPHA', name: 'Brand Alpha' }
const MILAN: OurWarehouse = {
  siteId: 'wh-1',
  code: 'WH-MI',
  name: 'Milan warehouse',
  city: 'Milan',
  country: 'IT',
  atWarehouse: [
    { shipmentId: 'sh-2', number: 'SEED-SH-0042', customer, salesOrders: [{ id: 'so-2', number: 'SO-2026-0102' }], pieces: 6, arrivedAt: '2026-11-24T09:00:00.000Z', labelSentAt: '2026-11-25T09:00:00.000Z' },
    { shipmentId: 'sh-1', number: 'SEED-SH-0041', customer, salesOrders: [{ id: 'so-1', number: 'SO-2026-0101' }], pieces: 4, arrivedAt: '2026-11-20T09:00:00.000Z', labelSentAt: null },
  ],
  onTheWay: [{ shipmentId: 'sh-3', number: 'SEED-SH-0043', customer, pieces: 2, shippedAt: '2026-11-26T09:00:00.000Z' }],
}
const LISBON: OurWarehouse = { siteId: 'wh-2', code: 'WH-RT', name: 'Lisbon warehouse', city: null, country: 'PT', atWarehouse: [], onTheWay: [] }

describe('one section per warehouse', () => {
  it('by name; At our warehouse the oldest first with the label here or awaited; the pieces added up; the place in words', () => {
    const sections = sectionsOf([MILAN, LISBON])
    expect(sections.map((section) => section.name)).toEqual(['Lisbon warehouse', 'Milan warehouse'])
    const milan = sections[1]!
    expect(milan.place).toBe('Milan, IT')
    expect(sections[0]!.place).toBe('PT')
    expect(milan.at.map((row) => [row.number, row.label])).toEqual([['SEED-SH-0041', false], ['SEED-SH-0042', true]])
    expect(milan.pieces).toEqual({ at: 10, onTheWay: 2 })
  })

  it('the answer: "2 at our warehouse · 1 on the way", else "Nothing here now"', () => {
    const [lisbon, milan] = sectionsOf([MILAN, LISBON])
    expect(answerOf(milan!)).toEqual({ key: 'section.answer', params: { at: 2, onTheWay: 1 } })
    expect(answerOf(lisbon!)).toEqual({ key: 'section.nothing' })
  })

  it('the acts are pack and send (shipping.manage); a planner or a reader sees none', () => {
    expect(actsOf({ send: true })).toEqual({ sendOn: true, arrived: true })
    expect(actsOf({ send: false })).toEqual({ sendOn: false, arrived: false })
  })

  it('days waiting at our warehouse: whole days, never below 0', () => {
    expect(daysWaiting('2026-11-20T09:00:00.000Z', new Date('2026-11-23T10:00:00.000Z'))).toBe(3)
    expect(daysWaiting('2026-11-24T09:00:00.000Z', new Date('2026-11-23T10:00:00.000Z'))).toBe(0)
  })
})
