import { describe, expect, it } from 'vitest'
import type { ReadyOrder } from '../../../../../warehouse/shipments/api'
import { defaultSiteOf, joinableIds, linesOf, makeHeld, MAX_ORDERS, piecesOf, shipBodyOf, togetherRowsOf, waysOf, type WaysChoice } from './model'

/**
 * owb-ss3 step 3.1 (design plan § 7 "Shipping: three ways"; settles L3, L4, L5) — the window "Ship the whole order…", pure: which ways
 * show and why one waits, the customer's other ready orders (ticked by default when they may go), the body sent per way (a DRAFT
 * through today's create, `salesOrderIds` ≤ 20, `destination`), and why "Make the shipment" waits. Made-up data only.
 */

const cell = (id: string, shippable: number) => ({ workOrderSizeId: id, workOrderId: 'wo-1', workOrderNumber: 'WO-0001', batchNumber: null, siteId: 'site-a', salesOrderLineId: 'line-1', lineSeq: 10, styleCode: 'DEMO-JKT-01', styleName: 'Jacket', colourwayCode: 'BLK', colourwayName: 'Black', size: '50', pieces: shippable, released: shippable, reversed: 0, onShipments: 0, shippable, serialTracked: false })
const ready = (id: string, number: string, cells: ReturnType<typeof cell>[], shipsWith: ReadyOrder['shipsWith'] = null): ReadyOrder => ({ salesOrderId: id, number, customerRef: null, status: 'READY', companyId: 'co-1', partyId: 'party-1', party: { code: 'C-ALPHA', legalName: 'Brand Alpha' }, shipsWith, cells })

const THIS = ready('so-1', 'SO-2026-0101', [cell('c1', 4), cell('c2', 2), cell('c3', 0)])
const MATE = ready('so-2', 'SO-2026-0102', [cell('c4', 3)], { allowed: true, why: null })
const HELD = ready('so-3', 'SO-2026-0103', [cell('c5', 5)], { allowed: false, code: null, why: 'Another site.' })
const EMPTY = ready('so-4', 'SO-2026-0104', [cell('c6', 0)], { allowed: true, why: null })
const WAREHOUSES = [{ siteId: 'wh-1', name: 'Milan warehouse', city: 'Milan' }]
const PLAN = { plan: true, send: false }
const choice = (over: Partial<WaysChoice> = {}): WaysChoice => ({ way: null, ticked: [], siteId: null, ...over })

describe('the three ways: which show, and why one waits (never hidden)', () => {
  it('alone always; together with the customer\'s other ready orders ("n ready orders of this customer"); our warehouse first', () => {
    const rows = togetherRowsOf([THIS, MATE, HELD, EMPTY], 'so-1')
    const ways = waysOf({ rows, warehouses: WAREHOUSES })
    expect(ways.map((way) => way.id)).toEqual(['ALONE', 'TOGETHER', 'OUR_WAREHOUSE'])
    expect(ways.map((way) => way.held)).toEqual([null, null, null])
    expect(ways[1]!.sub).toEqual({ key: 'ways.together.sub', params: { count: 1 } })
  })

  it('no other ready order: Together says "No other order is ready" and waits; no warehouse of our own: Our warehouse waits', () => {
    const ways = waysOf({ rows: togetherRowsOf([THIS], 'so-1'), warehouses: [] })
    expect(ways[1]).toEqual({ id: 'TOGETHER', sub: { key: 'ways.together.none' }, held: { key: 'ways.together.none' } })
    expect(ways[2]!.held).toEqual({ key: 'ways.warehouse.none' })
    // Not read yet: our warehouse is not held (the pick waits).
    expect(waysOf({ rows: [], warehouses: null })[2]!.held).toBeNull()
  })
})

describe('the together list', () => {
  it('only the other orders with something to ship; each with the read\'s verdict in the Warehouse\'s words; the joinable ticked', () => {
    const rows = togetherRowsOf([THIS, MATE, HELD, EMPTY], 'so-1')
    expect(rows.map((row) => row.number)).toEqual(['SO-2026-0102', 'SO-2026-0103'])
    expect(rows[0]).toEqual({ salesOrderId: 'so-2', number: 'SO-2026-0102', customerRef: null, pieces: 3, held: null })
    expect(rows[1]!.held).toEqual({ key: 'shipOrders.cannotJoin', ns: 'depth' })
    expect(joinableIds(rows)).toEqual(['so-2'])
  })
})

describe('the body sent per way (a DRAFT through today\'s create; L4: never more)', () => {
  it('alone: this order\'s released garments on no shipment, to the customer', () => {
    expect(linesOf(THIS.cells)).toEqual([{ workOrderSizeId: 'c1', quantity: 4 }, { workOrderSizeId: 'c2', quantity: 2 }])
    expect(shipBodyOf({ order: THIS, others: [MATE], choice: choice({ way: 'ALONE' }) })).toEqual({ salesOrderId: 'so-1', destination: { kind: 'CUSTOMER' }, lines: [{ workOrderSizeId: 'c1', quantity: 4 }, { workOrderSizeId: 'c2', quantity: 2 }] })
  })

  it('together: this order first, then the ticked ones (salesOrderIds), every line of each, to the customer', () => {
    expect(shipBodyOf({ order: THIS, others: [MATE, HELD], choice: choice({ way: 'TOGETHER', ticked: ['so-2'] }) })).toEqual({
      salesOrderId: 'so-1',
      salesOrderIds: ['so-1', 'so-2'],
      destination: { kind: 'CUSTOMER' },
      lines: [{ workOrderSizeId: 'c1', quantity: 4 }, { workOrderSizeId: 'c2', quantity: 2 }, { workOrderSizeId: 'c4', quantity: 3 }],
    })
  })

  it('our warehouse first: the destination names the warehouse site', () => {
    expect(shipBodyOf({ order: THIS, others: [], choice: choice({ way: 'OUR_WAREHOUSE', siteId: 'wh-1' }) })).toEqual({ salesOrderId: 'so-1', destination: { kind: 'OUR_WAREHOUSE', siteId: 'wh-1' }, lines: [{ workOrderSizeId: 'c1', quantity: 4 }, { workOrderSizeId: 'c2', quantity: 2 }] })
    expect(defaultSiteOf(WAREHOUSES)).toBe('wh-1')
    expect(defaultSiteOf([...WAREHOUSES, { siteId: 'wh-2', name: 'Rotterdam warehouse', city: null }])).toBeNull()
  })

  it('at most 20 orders in one shipment', () => {
    const many = Array.from({ length: 25 }, (_, index) => ready(`so-m${index}`, `SO-2026-02${String(index).padStart(2, '0')}`, [cell(`m${index}`, 1)], { allowed: true, why: null }))
    const body = shipBodyOf({ order: THIS, others: many, choice: choice({ way: 'TOGETHER', ticked: many.map((order) => order.salesOrderId) }) })
    expect(body.salesOrderIds).toHaveLength(MAX_ORDERS)
  })
})

describe('"Make the shipment" waits with words', () => {
  const ways = waysOf({ rows: togetherRowsOf([THIS, MATE], 'so-1'), warehouses: WAREHOUSES })
  const held = (over: Partial<Parameters<typeof makeHeld>[0]> = {}) => makeHeld({ rights: PLAN, order: THIS, ways, choice: choice({ way: 'ALONE' }), busy: false, ...over })

  it('the right first (plan: shipping.plan OR shipping.manage), then nothing ready, then the choice', () => {
    expect(held({ rights: { plan: false } })).toEqual({ key: 'ways.held.noRight' })
    expect(held({ order: null })).toEqual({ key: 'ways.held.nothing' })
    expect(piecesOf(EMPTY)).toBe(0)
    expect(held({ order: EMPTY })).toEqual({ key: 'ways.held.nothing' })
    expect(held({ choice: choice() })).toEqual({ key: 'ways.held.pick' })
    expect(held({ choice: choice({ way: 'TOGETHER', ticked: [] }) })).toEqual({ key: 'ways.held.tick' })
    expect(held({ choice: choice({ way: 'OUR_WAREHOUSE' }) })).toEqual({ key: 'ways.held.warehouse' })
    expect(held({ busy: true })).toEqual({ key: 'ways.held.busy' })
    expect(held()).toBeNull()
    expect(held({ choice: choice({ way: 'TOGETHER', ticked: ['so-2'] }) })).toBeNull()
  })

  it('a way that waits holds the act with its own words', () => {
    const alone = waysOf({ rows: [], warehouses: [] })
    expect(makeHeld({ rights: PLAN, order: THIS, ways: alone, choice: choice({ way: 'TOGETHER', ticked: ['so-2'] }), busy: false })).toEqual({ key: 'ways.together.none' })
    expect(makeHeld({ rights: PLAN, order: THIS, ways: alone, choice: choice({ way: 'OUR_WAREHOUSE', siteId: 'wh-1' }), busy: false })).toEqual({ key: 'ways.warehouse.none' })
  })
})
