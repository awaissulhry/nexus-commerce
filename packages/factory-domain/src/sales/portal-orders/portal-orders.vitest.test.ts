import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { partnerTemplateOf, ROLE_TEMPLATES } from '../../auth/roles/templates'
import { orderProgress } from '../orders/orders'
import { PORTAL_SALES_ORDERS_VIEW } from './permissions'
import { progressOf, percentOf } from './progress'
import { customerPromiseHistory, promiseReasonOf } from './promise'
import { customerShipmentStatusOf, shipmentMilestonesOf, stillToShipOf } from './shipments'
import { chipCounts, customerStatusOf, inChip, isStillToShip, milestonesOf, weekOf, type MilestoneFacts } from './status'

const facts = (overrides: Partial<MilestoneFacts>): MilestoneFacts => ({
  status: 'CONFIRMED',
  requestedOn: '2026-11-01',
  confirmedOn: '2026-11-02',
  productionOn: null,
  readyOn: null,
  firstShippedOn: null,
  allShippedOn: null,
  deliveredOn: null,
  promiseDate: '2026-12-15',
  ...overrides,
})

describe('the permission (B-W2b-175)', () => {
  it('is a partner permission held by the customer Buyer, Finance, Quality, Viewer and Admin only', () => {
    expect(FACTORY_PERMISSIONS.get(PORTAL_SALES_ORDERS_VIEW)).toMatchObject({ partner: true, risk: 'read' })
    for (const key of ['customer-buyer', 'customer-finance', 'customer-quality', 'customer-viewer', 'customer-admin']) expect(partnerTemplateOf(key)?.permissions).toContain(PORTAL_SALES_ORDERS_VIEW)
    for (const key of ['customer-designer', 'supplier-orders', 'supplier-admin', 'subcontractor-jobs', 'guest-accountant', 'partner-approve']) expect(partnerTemplateOf(key)?.permissions).not.toContain(PORTAL_SALES_ORDERS_VIEW)
    for (const template of ROLE_TEMPLATES) expect(template.permissions).not.toContain(PORTAL_SALES_ORDERS_VIEW)
  })
})

describe('the status in customer words (SAL-075)', () => {
  it('never shows CLOSED: shipped until every shipment that left was delivered', () => {
    expect(customerStatusOf('CONFIRMED', { left: 0, delivered: 0 })).toBe('CONFIRMED')
    expect(customerStatusOf('PARTLY_SHIPPED', { left: 1, delivered: 1 })).toBe('PARTLY_SHIPPED')
    expect(customerStatusOf('SHIPPED', { left: 2, delivered: 1 })).toBe('SHIPPED')
    expect(customerStatusOf('SHIPPED', { left: 2, delivered: 2 })).toBe('DELIVERED')
    expect(customerStatusOf('CLOSED', { left: 1, delivered: 0 })).toBe('SHIPPED')
    expect(customerStatusOf('CLOSED', { left: 1, delivered: 1 })).toBe('DELIVERED')
    expect(customerStatusOf('CANCELLED', { left: 0, delivered: 0 })).toBe('CANCELLED')
  })

  it('puts each row in its chips: Open is everything not delivered or cancelled, requests included', () => {
    expect(inChip('OPEN', 'REQUESTED', false)).toBe(true)
    expect(inChip('OPEN', 'SHIPPED', false)).toBe(true)
    expect(inChip('OPEN', 'DELIVERED', false)).toBe(false)
    expect(inChip('OPEN', 'CANCELLED', false)).toBe(false)
    expect(inChip('SHIPPED', 'PARTLY_SHIPPED', false)).toBe(true)
    expect(inChip('READY', 'IN_PRODUCTION', false)).toBe(false)
    expect(inChip('DATE_MOVED', 'CANCELLED', true)).toBe(true)
    const counts = chipCounts([
      { status: 'CONFIRMED', movedLately: false },
      { status: 'IN_PRODUCTION', movedLately: true },
      { status: 'DELIVERED', movedLately: false },
    ])
    expect(Object.fromEntries(counts.map((entry) => [entry.chip, entry.count]))).toEqual({ OPEN: 2, REQUESTED: 0, IN_PRODUCTION: 1, READY: 0, SHIPPED: 0, DELIVERED: 1, CANCELLED: 0, ALL: 3, DATE_MOVED: 1 })
    expect(counts[0]!.words).toEqual({ it: 'Aperti', en: 'Open' })
  })

  it('knows the week of a day (Monday to Sunday) and which orders still have pieces to leave', () => {
    expect(weekOf('2026-11-07')).toEqual({ from: '2026-11-02', to: '2026-11-08' })
    expect(weekOf('2026-11-09')).toEqual({ from: '2026-11-09', to: '2026-11-15' })
    expect(weekOf('2026-11-08')).toEqual({ from: '2026-11-02', to: '2026-11-08' })
    expect(['CONFIRMED', 'PARTLY_SHIPPED', 'SHIPPED', 'REQUESTED'].map((status) => isStillToShip(status as never))).toEqual([true, true, false, false])
  })

  it('draws the six steps with their days, the promise as Shipped expected, the current step marked', () => {
    const confirmed = milestonesOf(facts({}))
    expect(confirmed.map((view) => [view.key, view.state, view.date, view.expected, view.current])).toEqual([
      ['REQUESTED', 'DONE', '2026-11-01', null, false],
      ['CONFIRMED', 'DONE', '2026-11-02', null, true],
      ['IN_PRODUCTION', 'TODO', null, null, false],
      ['READY', 'TODO', null, null, false],
      ['SHIPPED', 'TODO', null, '2026-12-15', false],
      ['DELIVERED', 'TODO', null, null, false],
    ])
    // Shipped in part before everything was released: Ready passed without a day, Shipped PARTLY with its first day.
    const partly = milestonesOf(facts({ status: 'PARTLY_SHIPPED', productionOn: '2026-11-05', firstShippedOn: '2026-11-20' }))
    expect(partly.map((view) => [view.key, view.state, view.date])).toEqual([
      ['REQUESTED', 'DONE', '2026-11-01'],
      ['CONFIRMED', 'DONE', '2026-11-02'],
      ['IN_PRODUCTION', 'DONE', '2026-11-05'],
      ['READY', 'DONE', null],
      ['SHIPPED', 'PARTLY', '2026-11-20'],
      ['DELIVERED', 'TODO', null],
    ])
    expect(partly.find((view) => view.current)?.key).toBe('SHIPPED')
    const delivered = milestonesOf(facts({ status: 'DELIVERED', productionOn: '2026-11-05', readyOn: '2026-11-18', firstShippedOn: '2026-11-20', allShippedOn: '2026-11-25', deliveredOn: '2026-11-27' }))
    expect(delivered.map((view) => view.state)).toEqual(['DONE', 'DONE', 'DONE', 'DONE', 'DONE', 'DONE'])
    expect(delivered.find((view) => view.key === 'SHIPPED')?.date).toBe('2026-11-25')
    // A cancelled order keeps the steps it reached, the rest are skipped.
    const cancelled = milestonesOf(facts({ status: 'CANCELLED' }))
    expect(cancelled.map((view) => view.state)).toEqual(['DONE', 'DONE', 'SKIPPED', 'SKIPPED', 'SKIPPED', 'SKIPPED'])
    expect(cancelled.find((view) => view.current)?.key).toBe('CONFIRMED')
  })
})

describe('the promise in customer words (PLN-178)', () => {
  it('shows a curated reason, never the office text', () => {
    expect(promiseReasonOf('MATERIAL_LATE')).toBe('MATERIAL_LATE')
    expect(promiseReasonOf('material_late: tannery batch 12 is late, call Marco')).toBe('MATERIAL_LATE')
    expect(promiseReasonOf('[QUALITY]')).toBe('QUALITY')
    expect(promiseReasonOf('Material delivery late.')).toBe('MATERIAL_LATE')
    expect(promiseReasonOf('  modifica richiesta da voi ')).toBe('YOUR_CHANGE')
    expect(promiseReasonOf('Customer pays late, push them back')).toBe('PLANNING')
    expect(promiseReasonOf('LATE: whatever')).toBe('PLANNING')
    expect(promiseReasonOf(null)).toBe('PLANNING')
  })

  it('lists the moves newest first with the lines by number and the day in Rome', () => {
    const history = customerPromiseHistory(
      [
        { at: new Date('2026-11-03T09:00:00.000Z'), from: '2026-12-01', to: '2026-12-08', lineIds: [], reason: 'CAPACITY: line 2 down' },
        { at: new Date('2026-11-10T23:30:00.000Z'), from: '2026-12-08', to: '2026-12-15', lineIds: ['a', 'gone'], reason: 'internal: buyer is slow' },
      ],
      (lineId) => (lineId === 'a' ? 20 : undefined),
    )
    expect(history).toEqual([
      { on: '2026-11-11', from: '2026-12-08', to: '2026-12-15', lines: [20], reason: { code: 'PLANNING', words: { it: 'La nostra pianificazione è cambiata', en: 'Our planning changed' } } },
      { on: '2026-11-03', from: '2026-12-01', to: '2026-12-08', lines: [], reason: { code: 'CAPACITY', words: { it: 'Capacità produttiva', en: 'Production capacity' } } },
    ])
    expect(JSON.stringify(history)).not.toMatch(/buyer is slow|line 2 down/)
  })
})

describe('production progress (SAL-076)', () => {
  const lines = [
    { id: 'l20', seq: 20, quantity: 3, sizes: [{ size: '52', quantity: 2 }, { size: '50', quantity: 1 }] },
    { id: 'l10', seq: 10, quantity: 1, sizes: [] },
  ]

  it('sums the cells per line and size; a later stage implies the earlier ones; never above what was ordered', () => {
    const view = progressOf(lines, [
      { lineId: 'l20', size: '52', cut: 3, sewn: null, inspected: 1, packed: 1 },
      { lineId: 'l20', size: '52', cut: 0, sewn: null, inspected: 0, packed: 0 },
      { lineId: 'l20', size: '50', cut: 0, sewn: null, inspected: 1, packed: 0 },
    ])
    expect(view.lines.map((line) => line.seq)).toEqual([10, 20])
    expect(view.lines[0]).toEqual({ lineId: 'l10', seq: 10, ordered: 1, cut: null, sewn: null, inspected: null, packed: null, sizes: [{ size: null, ordered: 1, cut: null, sewn: null, inspected: null, packed: null }] })
    expect(view.lines[1]!.sizes).toEqual([
      { size: '52', ordered: 2, cut: 2, sewn: 1, inspected: 1, packed: 1 },
      { size: '50', ordered: 1, cut: 1, sewn: 1, inspected: 1, packed: 0 },
    ])
    expect(view.whole).toEqual({ ordered: 4, cut: 3, sewn: 2, inspected: 2, packed: 1 })
    expect(view.percent).toBe(50)
    expect(percentOf({ ordered: 0, cut: null, sewn: null, inspected: null, packed: null })).toBeNull()
  })
})

describe('shipments and what is still to ship (SAL-080, SAL-081)', () => {
  it('says the shipment the customer way from its parcels', () => {
    expect(customerShipmentStatusOf('PACKED', ['LABEL_CREATED'])).toBe('PACKED')
    expect(customerShipmentStatusOf('SHIPPED', [])).toBe('IN_TRANSIT')
    expect(customerShipmentStatusOf('SHIPPED', ['IN_TRANSIT', 'OUT_FOR_DELIVERY'])).toBe('IN_TRANSIT')
    expect(customerShipmentStatusOf('SHIPPED', ['OUT_FOR_DELIVERY', 'DELIVERED'])).toBe('OUT_FOR_DELIVERY')
    expect(customerShipmentStatusOf('SHIPPED', ['IN_TRANSIT', 'EXCEPTION'])).toBe('DELAYED')
    expect(customerShipmentStatusOf('DELIVERED', ['DELIVERED'])).toBe('DELIVERED')
    expect(customerShipmentStatusOf('RETURNED', ['RETURNED'])).toBe('RETURNED')
  })

  it('marks Packed, Collected, In transit and Delivered from the records', () => {
    const packed = new Date('2026-11-23T10:00:00.000Z')
    const shipped = new Date('2026-11-24T08:05:00.000Z')
    const onTheWay = new Date('2026-11-24T17:30:00.000Z')
    const views = shipmentMilestonesOf({ status: 'SHIPPED', packedAt: packed, shippedAt: shipped, deliveredAt: null, events: [{ status: 'LABEL_CREATED', occurredAt: packed }, { status: 'IN_TRANSIT', occurredAt: onTheWay }] })
    expect(views.map((view) => [view.key, view.done, view.at])).toEqual([
      ['PACKED', true, packed],
      ['COLLECTED', true, shipped],
      ['IN_TRANSIT', true, onTheWay],
      ['DELIVERED', false, null],
    ])
    expect(shipmentMilestonesOf({ status: 'PACKED', packedAt: packed, shippedAt: null, deliveredAt: null, events: [] }).map((view) => view.done)).toEqual([true, false, false, false])
  })

  it('lists the open pieces per size after a partial shipment, expected on the line promise, else the order one', () => {
    const progress = orderProgress({
      lines: [
        { id: 'a', seq: 10, quantity: 3, sizes: [{ size: '50', quantity: 1 }, { size: '52', quantity: 2 }] },
        { id: 'b', seq: 20, quantity: 2, sizes: [{ size: '54', quantity: 2 }] },
        { id: 'c', seq: 30, quantity: 1, sizes: [] },
      ],
      inWorkOrders: [],
      released: [],
      shipped: [{ lineId: 'a', size: '50', quantity: 1 }, { lineId: 'a', size: '52', quantity: 1 }],
      invoiced: [],
      closedShort: new Set(['c']),
    })
    expect(stillToShipOf(progress.rows, [{ id: 'a', seq: 10, promiseDate: null }, { id: 'b', seq: 20, promiseDate: '2026-12-20' }], '2026-12-15')).toEqual([
      { lineId: 'a', seq: 10, size: '52', ordered: 2, shipped: 1, open: 1, expected: '2026-12-15' },
      { lineId: 'b', seq: 20, size: '54', ordered: 2, shipped: 0, open: 2, expected: '2026-12-20' },
    ])
  })
})
