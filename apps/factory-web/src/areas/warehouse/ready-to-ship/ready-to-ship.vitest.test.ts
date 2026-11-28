import { describe, expect, it } from 'vitest'
import type { ReadyOrder, ShipmentRow } from '../shipments/api'
import { addLinesOf, byCustomer, chipOf, chipQuery, oneShipmentBody, oneShipmentHeld, oneShipmentWords, selectionOf, SHIPMENT_CHIPS, shipmentLinesOf, toggled, toggledCustomer } from './model'

/**
 * owb-ss3 step 3.4 (design plan § 5n "Shipping › Ready to ship") — the page, pure: the orders with ready garments BY CUSTOMER; the
 * ONE-customer rule of "One shipment for the n orders" (two customers: the button says why); the body of the ONE draft and of "Add to
 * SH-…"; the chips Open · On the way · Arrived · All. Made-up data only (Brand Alpha, Brand Beta).
 */

const cell = (id: string, shippable: number) => ({ workOrderSizeId: id, workOrderId: 'wo-1', workOrderNumber: 'WO-0001', batchNumber: null, siteId: 'site-a', salesOrderLineId: 'line-1', lineSeq: 10, styleCode: 'DEMO-JKT-01', styleName: 'Jacket', colourwayCode: 'BLK', colourwayName: 'Black', size: '50', pieces: shippable, released: shippable, reversed: 0, onShipments: 0, shippable, serialTracked: false })
const ready = (id: string, number: string, party: 'A' | 'B', cells: ReturnType<typeof cell>[]): ReadyOrder => ({
  salesOrderId: id,
  number,
  customerRef: party === 'A' ? `PO-${number.slice(-3)}` : null,
  status: 'READY',
  companyId: 'co-1',
  partyId: `party-${party}`,
  party: party === 'A' ? { code: 'C-ALPHA', legalName: 'Brand Alpha' } : { code: 'C-BETA', legalName: 'Brand Beta' },
  shipsWith: null,
  cells,
})

const ORDERS = [
  ready('so-3', 'SO-2026-0103', 'B', [cell('b1', 2)]),
  ready('so-2', 'SO-2026-0102', 'A', [cell('a2', 3)]),
  ready('so-1', 'SO-2026-0101', 'A', [cell('a1', 4), cell('a1b', 1)]),
  ready('so-4', 'SO-2026-0104', 'A', [cell('a4', 0)]),
]

describe('every order with ready garments, by customer', () => {
  it('the customers by name, each one\'s orders by number, its pieces; an order with nothing to ship is not listed', () => {
    const groups = byCustomer(ORDERS)
    expect(groups.map((group) => group.name)).toEqual(['Brand Alpha', 'Brand Beta'])
    expect(groups[0]!.orders.map((row) => row.number)).toEqual(['SO-2026-0101', 'SO-2026-0102'])
    expect(groups[0]!.pieces).toBe(8)
    expect(groups[0]!.orders[0]).toEqual({ salesOrderId: 'so-1', number: 'SO-2026-0101', customerRef: 'PO-101', pieces: 5 })
    expect(byCustomer([])).toEqual([])
  })

  it('the tick boxes: one order; the box beside a customer ticks all its orders, again: none', () => {
    const groups = byCustomer(ORDERS)
    expect([...toggled(new Set(), 'so-1')]).toEqual(['so-1'])
    expect([...toggled(new Set(['so-1']), 'so-1')]).toEqual([])
    expect([...toggledCustomer(new Set(['so-1']), groups[0]!)].sort()).toEqual(['so-1', 'so-2'])
    expect([...toggledCustomer(new Set(['so-1', 'so-2']), groups[0]!)]).toEqual([])
  })
})

describe('One shipment for the n orders: ONE customer only', () => {
  const groups = byCustomer(ORDERS)
  const held = (ids: string[], plan = true) => oneShipmentHeld({ plan, selection: selectionOf(groups, new Set(ids)), busy: false })

  it('nothing ticked waits; two customers never travel together (the button says why); the right first', () => {
    expect(held([])).toEqual({ key: 'held.pick' })
    expect(held(['so-1', 'so-3'])).toEqual({ key: 'held.twoCustomers', params: { count: 2 } })
    expect(held(['so-1', 'so-2'])).toBeNull()
    expect(held(['so-1'], false)).toEqual({ key: 'held.noRight' })
    expect(oneShipmentHeld({ plan: true, selection: selectionOf(groups, new Set(['so-1'])), busy: true })).toEqual({ key: 'held.busy' })
  })

  it('the words: one order "Make a shipment", several "One shipment for the n orders"; the selection counts pieces', () => {
    expect(oneShipmentWords(1)).toEqual({ key: 'act.makeShipment' })
    expect(oneShipmentWords(2)).toEqual({ key: 'act.oneShipment', params: { count: 2 } })
    expect(selectionOf(groups, new Set(['so-1', 'so-2']))).toMatchObject({ orderIds: ['so-1', 'so-2'], pieces: 8 })
  })

  it('the body: the first ticked order first, salesOrderIds when several, every released line, to the customer', () => {
    expect(oneShipmentBody(ORDERS, ['so-1', 'so-2'])).toEqual({
      salesOrderId: 'so-1',
      salesOrderIds: ['so-1', 'so-2'],
      destination: { kind: 'CUSTOMER' },
      lines: [{ workOrderSizeId: 'a1', quantity: 4 }, { workOrderSizeId: 'a1b', quantity: 1 }, { workOrderSizeId: 'a2', quantity: 3 }],
    })
    expect(oneShipmentBody(ORDERS, ['so-2'])).toEqual({ salesOrderId: 'so-2', destination: { kind: 'CUSTOMER' }, lines: [{ workOrderSizeId: 'a2', quantity: 3 }] })
    expect(oneShipmentBody(ORDERS, [])).toBeNull()
    expect(addLinesOf(ORDERS, ['so-2', 'so-1'])).toEqual([{ workOrderSizeId: 'a2', quantity: 3 }, { workOrderSizeId: 'a1', quantity: 4 }, { workOrderSizeId: 'a1b', quantity: 1 }])
  })
})

describe('the shipments part: Open · On the way · Arrived · All', () => {
  it('each chip\'s filter; an unknown address chip is Open', () => {
    expect(SHIPMENT_CHIPS).toEqual(['open', 'onTheWay', 'arrived', 'all'])
    expect(chipQuery('open')).toEqual({ open: true })
    expect(chipQuery('onTheWay')).toEqual({ status: 'SHIPPED' })
    expect(chipQuery('arrived')).toEqual({ status: 'DELIVERED' })
    expect(chipQuery('all')).toEqual({})
    expect(chipOf('arrived')).toBe('arrived')
    expect(chipOf('nonsense')).toBe('open')
    expect(chipOf(null)).toBe('open')
  })

  it('a row in a few words: the orders it carries (the first alone on an older answer), the day it left else was made', () => {
    const row = { id: 'sh-1', number: 'SEED-SH-0041', status: 'SHIPPED', partyName: 'Brand Alpha', salesOrderId: 'so-1', salesOrderNumber: 'SO-2026-0101', garments: 8, parcels: 2, carrierName: 'GLS', carrierCode: 'gls', shippedAt: '2026-11-25T09:00:00.000Z', createdAt: '2026-11-24T09:00:00.000Z' } as unknown as ShipmentRow
    expect(shipmentLinesOf([row])).toEqual([{ id: 'sh-1', number: 'SEED-SH-0041', status: 'SHIPPED', customer: 'Brand Alpha', orders: ['SO-2026-0101'], garments: 8, parcels: 2, carrier: 'GLS', at: '2026-11-25T09:00:00.000Z' }])
    const two = { ...row, salesOrders: [{ id: 'so-1', number: 'SO-2026-0101', customerRef: null }, { id: 'so-2', number: 'SO-2026-0102', customerRef: null }], shippedAt: null, carrierName: null } as unknown as ShipmentRow
    expect(shipmentLinesOf([two])[0]).toMatchObject({ orders: ['SO-2026-0101', 'SO-2026-0102'], carrier: 'gls', at: '2026-11-24T09:00:00.000Z' })
  })
})
