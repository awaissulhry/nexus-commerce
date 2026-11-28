import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { partnerTemplateOf, ROLE_TEMPLATES } from '../../auth/roles/templates'
import { orderProgress } from '../orders/orders'
import { PORTAL_SALES_ORDERS_VIEW } from './permissions'
import { PORTAL_ORDER_REQUESTS_MANAGE } from '../portal-ordering/permissions' // owb-b7
import { progressOf, percentOf } from './progress'
import { customerPromiseHistory, PROMISE_REASON_CODES, promiseReasonOf, promiseReasonText } from './promise'
import { AUTOMATIC_REASONS } from '../amendments/reasons' // B-OL-004
import { customerShipmentStatusOf, shipmentMilestonesOf, stillToShipOf } from './shipments'
import { chipCounts, customerStatusOf, inChip, isStillToShip, milestonesOf, weekOf, type MilestoneFacts } from './status'
import { bandCounts, CHIP_WORDS, groupOf, ORDER_CHIPS, ORDER_GROUPS, type BandRow, type CustomerOrderStatus } from './status' // pg-s1 S1.1, S1.2
import type { PortalRequestState } from '../portal-requests/state' // pg-s1 S1.2

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
  // owb-b7 (Owner yes 2026-11-28): + the customer Designer.
  it('is a partner permission held by the customer Buyer, Finance, Quality, Designer, Viewer and Admin only', () => {
    expect(FACTORY_PERMISSIONS.get(PORTAL_SALES_ORDERS_VIEW)).toMatchObject({ partner: true, risk: 'read' })
    for (const key of ['customer-buyer', 'customer-finance', 'customer-quality', 'customer-designer', 'customer-viewer', 'customer-admin']) expect(partnerTemplateOf(key)?.permissions, key).toContain(PORTAL_SALES_ORDERS_VIEW)
    for (const key of ['supplier-orders', 'supplier-admin', 'subcontractor-jobs', 'guest-accountant', 'partner-approve']) expect(partnerTemplateOf(key)?.permissions, key).not.toContain(PORTAL_SALES_ORDERS_VIEW)
    for (const template of ROLE_TEMPLATES) expect(template.permissions).not.toContain(PORTAL_SALES_ORDERS_VIEW)
  })

  // owb-b7: the Designer reads its orders, never a price (no price grain) and never Send (portal.orderRequests.manage stays the Buyer's).
  it('gives the customer Designer the orders without a grain and without sending', () => {
    const designer = partnerTemplateOf('customer-designer')!
    expect(designer.permissions).toContain(PORTAL_SALES_ORDERS_VIEW)
    expect(designer.grains).toEqual([])
    expect(designer.permissions).not.toContain(PORTAL_ORDER_REQUESTS_MANAGE)
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
    // pg-s1 S1.1: + CONFIRMED (the band's Confirmed group), right after REQUESTED.
    expect(Object.fromEntries(counts.map((entry) => [entry.chip, entry.count]))).toEqual({ OPEN: 2, REQUESTED: 0, CONFIRMED: 1, IN_PRODUCTION: 1, READY: 0, SHIPPED: 0, DELIVERED: 1, CANCELLED: 0, ALL: 3, DATE_MOVED: 1 })
    expect(counts[0]!.words).toEqual({ it: 'Aperti', en: 'Open' })
    expect(ORDER_CHIPS.slice(1, 3)).toEqual(['REQUESTED', 'CONFIRMED'])
    expect(CHIP_WORDS.CONFIRMED).toEqual({ it: 'Confermati', en: 'Confirmed' })
    expect(inChip('CONFIRMED', 'CONFIRMED', false)).toBe(true)
    expect(inChip('CONFIRMED', 'IN_PRODUCTION', false)).toBe(false)
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

// ---- pg-s1 S1.2 (portal grid Z3, H4): the band's numbers, counted by the server over the party's own rows ----------------------
describe('the band of Portal › Orders (pg-s1 S1.2)', () => {
  const row = (status: CustomerOrderStatus, needsYou = false): BandRow => ({ kind: 'ROW', status, needsYou })
  const inquiry = (state: PortalRequestState): BandRow => ({ kind: 'INQUIRY', state })
  const countsOf = (rows: readonly BandRow[]) => Object.fromEntries(bandCounts(rows).groups.map((entry) => [entry.group, entry.count]))

  it('puts every row in one group: orders by their customer status, requests by their state; Cancelled and Closed requests apart', () => {
    expect(ORDER_GROUPS).toEqual(['REQUESTS', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'CLOSED_REQUESTS'])
    expect((['REQUESTED', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const).map((status) => groupOf(row(status)))).toEqual(['REQUESTS', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'SHIPPED', 'DELIVERED', 'CANCELLED'])
    expect((['SENT', 'BEING_REVIEWED', 'NEED_INFO', 'QUOTE_BEING_PREPARED', 'QUOTE_SENT', 'QUOTE_ACCEPTED'] as const).map((state) => groupOf(inquiry(state)))).toEqual(Array(6).fill('REQUESTS'))
    // Closed requests keep a place (never vanished); an ORDER_CONFIRMED request carries on as its order (counted there).
    expect((['DECLINED', 'CLOSED', 'WITHDRAWN', 'ORDER_CONFIRMED'] as const).map((state) => groupOf(inquiry(state)))).toEqual(['CLOSED_REQUESTS', 'CLOSED_REQUESTS', 'CLOSED_REQUESTS', null])
  })

  it('counts an ORDER_WAITING pair once: the request waiting for our yes is its REQUESTED order row', () => {
    // The request made into an order that waits for our yes (ORDER_WAITING) and that order (PENDING_APPROVAL: REQUESTED).
    const pair = [inquiry('ORDER_WAITING'), row('REQUESTED')]
    expect(countsOf(pair)).toMatchObject({ REQUESTS: 1 })
    expect(bandCounts(pair).open).toBe(1)
  })

  it('counts everything open once and what needs the customer: NEED_INFO requests and orders to re-confirm', () => {
    const rows = [
      row('REQUESTED'), // a catalogue order request waiting
      inquiry('SENT'),
      inquiry('NEED_INFO'),
      inquiry('ORDER_WAITING'),
      row('REQUESTED'), // … and its order
      row('CONFIRMED', true), // a revised order to re-confirm
      row('IN_PRODUCTION'),
      row('READY'),
      row('PARTLY_SHIPPED'),
      row('SHIPPED'),
      row('DELIVERED'),
      row('CANCELLED', true), // a cancelled order with a stale re-confirmation wait: neither open nor needing them
      row('DELIVERED', true), // … nor a delivered one
      inquiry('DECLINED'),
      inquiry('WITHDRAWN'),
      inquiry('ORDER_CONFIRMED'),
    ]
    expect(countsOf(rows)).toEqual({ REQUESTS: 4, CONFIRMED: 1, IN_PRODUCTION: 1, READY: 1, SHIPPED: 2, DELIVERED: 2, CANCELLED: 1, CLOSED_REQUESTS: 2 })
    // Needs you: the NEED_INFO request and the OPEN order to re-confirm — never the cancelled or delivered one (the lead's rule).
    expect(bandCounts(rows)).toMatchObject({ open: 9, needsYou: 2 })
    expect(bandCounts([])).toEqual({ groups: ORDER_GROUPS.map((group) => ({ group, count: 0 })), open: 0, needsYou: 0 })
  })

  it('counts the rows it is given, so a search never moves it: the chips follow the search, the band does not', () => {
    // The API gives the band EVERY row of the party, read before the search; the chips count only the rows the search kept.
    const every = [
      { band: row('CONFIRMED'), chip: { status: 'CONFIRMED' as const, movedLately: false }, found: true },
      { band: row('READY'), chip: { status: 'READY' as const, movedLately: false }, found: false },
      { band: row('DELIVERED'), chip: { status: 'DELIVERED' as const, movedLately: false }, found: false },
    ]
    const searched = every.filter((entry) => entry.found)
    const chips = (entries: typeof every) => Object.fromEntries(chipCounts(entries.map((entry) => entry.chip)).map((entry) => [entry.chip, entry.count]))
    expect(chips(searched)).toMatchObject({ ALL: 1, READY: 0 })
    expect(chips(every)).toMatchObject({ ALL: 3, READY: 1 })
    const band = bandCounts(every.map((entry) => entry.band))
    expect(countsOf(every.map((entry) => entry.band))).toMatchObject({ CONFIRMED: 1, READY: 1, DELIVERED: 1 })
    expect(band.open).toBe(2)
  })
})
// ---- end pg-s1 S1.2

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

  // ── B-OO-009 (order overview N10): the promise reason as a field ──
  it('B-OO-009: the stored reason is the code, then the office note; it reads back as the code, the note never in the customer words', () => {
    expect(promiseReasonText('CAPACITY', '  line 2 down for a week ')).toBe('CAPACITY: line 2 down for a week')
    expect(promiseReasonText('CAPACITY', '')).toBe('CAPACITY')
    expect(promiseReasonText('CAPACITY', undefined)).toBe('CAPACITY')
    expect(promiseReasonText(undefined, ' Leather late. ')).toBe('Leather late.')
    expect(promiseReasonText(null, '   ')).toBe('')
    for (const code of PROMISE_REASON_CODES) {
      expect(promiseReasonOf(promiseReasonText(code, 'call Marco: the buyer is slow'))).toBe(code)
      expect(promiseReasonOf(promiseReasonText(code, null))).toBe(code)
    }
    // A note whose own words name another code never wins over the code picked.
    expect(promiseReasonOf(promiseReasonText('TRANSPORT', 'QUALITY: not really'))).toBe('TRANSPORT')
    const [move] = customerPromiseHistory([{ at: new Date('2026-11-03T09:00:00.000Z'), from: '2026-12-01', to: '2026-12-08', lineIds: [], reason: promiseReasonText('CAPACITY', 'line 2 down') }], () => undefined)
    expect(move!.reason).toEqual({ code: 'CAPACITY', words: { it: 'Capacità produttiva', en: 'Production capacity' } })
    expect(JSON.stringify(move)).not.toMatch(/line 2 down/)
  })
  // ── end B-OO-009 ──

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

  // ── B-OL-004 (order lines plan D2; 18 F23): no reason given, no reason shown ──
  it('B-OL-004: a move with no reason given (none, empty, or the automatic words) shows no reason; a typed note still reads PLANNING', () => {
    const at = new Date('2026-11-03T09:00:00.000Z')
    const move = (reason: string | null) => customerPromiseHistory([{ at, from: '2026-12-01', to: '2026-12-08', lineIds: [], reason }], () => undefined)[0]!
    expect(move(AUTOMATIC_REASONS.promise).reason).toBeNull()
    expect(move(null).reason).toBeNull()
    expect(move('  ').reason).toBeNull()
    expect(JSON.stringify(move(AUTOMATIC_REASONS.promise))).not.toMatch(/order page/)
    expect(move('internal: buyer is slow').reason).toMatchObject({ code: 'PLANNING' })
    expect(move('TRANSPORT').reason).toMatchObject({ code: 'TRANSPORT' })
  })
  // ── end B-OL-004 ──
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

  // B-SA-043 (review P6-5): an order lowered after cutting (B-SA-042: 40 → 36 with 40 cut) reads at most its ordered figure —
  // never "Cut 40 of 36", never a word of extra pieces (those are the office's).
  it('reads an order lowered after cutting at its ordered figure, never more (the extra pieces are the office\'s)', () => {
    const view = progressOf([{ id: 'l1', seq: 10, quantity: 36, sizes: [{ size: 'M', quantity: 36 }] }], [{ lineId: 'l1', size: 'M', cut: 40, sewn: 38, inspected: 37, packed: 0 }])
    expect(view.lines[0]!.sizes).toEqual([{ size: 'M', ordered: 36, cut: 36, sewn: 36, inspected: 36, packed: 0 }])
    expect(JSON.stringify(view)).not.toMatch(/extra/i)
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
