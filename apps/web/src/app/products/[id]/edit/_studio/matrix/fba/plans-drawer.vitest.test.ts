import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  FBA_PLAN_STATUSES, FBA_SEND_COPY,
  type FbaPlacementOption, type FbaPlanStatus, type FbaPlanStep, type FbaPlanStepEntry, type FbaPlanView, type FbaShipmentView,
} from '@nexus/shared/fba-send'

import {
  DRAWER_COPY, FBA_ROUTES, amazonWord, arriveText, canPrintLabels, canShip, choiceHeld, choicePayload, clockText, commandSlot, dayRange,
  defaultPicks, feesText, fillDown, isFbaPlanEvent, isRunning, lineRows, moneyText, newestFirst, offeredPlacements, packedText, placementLines,
  placementTitle, planFacts, planName, planProductIds, readLabelsAnswer, readOnePlanAnswer, readPlanAnswer, readPlansAnswer, rereadDelay,
  REREAD_IDLE_MS, REREAD_RUNNING_MS, shipmentTitle, shipmentTransportText, shippedConfirmText, shippedPayload, shippedText, shownPlanId,
  statusText, statusTone, timelineItems, trackingHeld, trackingRows, transportText, windowText, withTransport, withWindow,
} from './plansDrawer'

/**
 * Step 4 Send to FBA — the FBA plans drawer's model (Part E2). The drawer renders only what these return: the server's
 * status and step log become the Timeline, Amazon's options one choice, the shipments their tracking rows.
 */

const ROME = 'Europe/Rome'
const T = (hhmm: string, day = '2026-10-07') => `${day}T${hhmm}:00.000Z`

const entry = (step: FbaPlanStep, finishedAt: string | null, result: FbaPlanStepEntry['result'] = 'SUCCESS'): FbaPlanStepEntry => ({
  step, call: null, operationId: null, shipmentId: null, startedAt: finishedAt ?? T('08:00'), finishedAt, result, problems: [], note: null,
})

const shipment = (over: Partial<FbaShipmentView> = {}): FbaShipmentView => ({
  id: 'shp-1', amazonShipmentId: 'sh-1', shipmentConfirmationId: 'FBA15ABC', destinationFc: 'MXP5', status: 'WORKING', units: 24,
  boxes: [
    { boxId: 'FBA15ABCU000001', kind: 'case', lengthCm: 40, widthCm: 30, heightCm: 30, weightKg: 8, items: [{ msku: 'GALE-M', quantity: 12 }] },
    { boxId: 'FBA15ABCU000002', kind: 'mixed', lengthCm: 60, widthCm: 40, heightCm: 40, weightKg: 9, items: [{ msku: 'GALE-L', quantity: 8 }, { msku: 'GALE-S', quantity: 4 }] },
  ],
  transport: null, tracking: null, shippedAt: null, shippedBy: null,
  ...over,
})

const plan = (over: Partial<FbaPlanView> = {}): FbaPlanView => ({
  id: 'plan-1', name: 'Nexus IT 2026-10-08 #a1b2c3', status: 'QUEUED', step: 'CREATE', source: 'matrix', amazonPlanId: null,
  market: 'IT', marketplaceId: 'APJ6JRA9NG5V4', from: { locationId: 'loc-1', code: 'IT-MAIN', name: 'Main warehouse' },
  readyToShipOn: '2026-10-08', mixedBox: null, skus: 3, units: 24, shippedUnits: 0,
  lines: [
    { productId: 'p-m', sku: 'GALE-M', msku: 'GALE-M', quantity: 12, cases: [{ unitsPerCase: 12, cases: 1 }], looseUnits: 0, prepOwner: 'SELLER', labelOwner: 'SELLER', shippedQuantity: 0, held: true },
    { productId: 'p-l', sku: 'GALE-L', msku: 'GALE-L', quantity: 8, cases: [], looseUnits: 8, prepOwner: 'SELLER', labelOwner: 'SELLER', shippedQuantity: 0, held: true },
    { productId: 'p-s', sku: 'GALE-S', msku: 'GALE-S', quantity: 4, cases: [], looseUnits: 4, prepOwner: 'SELLER', labelOwner: 'SELLER', shippedQuantity: 0, held: true },
  ],
  steps: [], options: null, choice: null, shipments: [], problems: [], message: null, nextCheckAt: null,
  createdAt: T('08:00'), createdBy: 'owner@example.com', confirmedAt: null, confirmedBy: null, cancelledAt: null,
  can: { choose: false, newOptions: false, retry: false, cancel: true },
  ...over,
})

const own = (shipmentId: string, id: string, carrierName: string) => ({
  transportationOptionId: id, shipmentId, carrierName, carrierCode: carrierName.toUpperCase(), shippingMode: 'GROUND_SMALL_PARCEL',
  shippingSolution: 'USE_YOUR_OWN_CARRIER', quote: null, preconditions: ['CONFIRMED_DELIVERY_WINDOW'],
})
const partnered = (shipmentId: string, id: string) => ({
  transportationOptionId: id, shipmentId, carrierName: 'UPS', carrierCode: 'UPSN', shippingMode: 'GROUND_SMALL_PARCEL',
  shippingSolution: 'AMAZON_PARTNERED_CARRIER', quote: { cost: { amount: 45, currency: 'EUR' }, expiresAt: null, voidableUntil: null }, preconditions: [],
})
const windowOf = (id: string, start: string, end: string) => ({ deliveryWindowOptionId: id, start, end, availabilityType: 'AVAILABLE', validUntil: null })

const TWO_SHIPMENTS: FbaPlacementOption = {
  placementOptionId: 'po-2', status: 'OFFERED', expiresAt: T('14:30'),
  fees: [{ type: 'FEE', target: 'Placement Services', description: null, value: { amount: 0, currency: 'EUR' } }],
  discounts: [],
  shipments: [
    {
      shipmentId: 'sh-a', destinationFc: 'MXP5', destinationTown: 'Castel San Giovanni',
      transport: [partnered('sh-a', 'to-a-ups'), own('sh-a', 'to-a-brt', 'BRT'), own('sh-a', 'to-a-gls', 'GLS')],
      deliveryWindows: [windowOf('dw-a-late', T('00:00', '2026-10-28'), T('00:00', '2026-11-03')), windowOf('dw-a-early', T('00:00', '2026-10-14'), T('00:00', '2026-10-21'))],
    },
    {
      shipmentId: 'sh-b', destinationFc: 'FCO1', destinationTown: null,
      transport: [own('sh-b', 'to-b-brt', 'BRT')],
      deliveryWindows: [windowOf('dw-b', T('00:00', '2026-10-15'), T('00:00', '2026-10-22'))],
    },
  ],
}
const ONE_SHIPMENT: FbaPlacementOption = {
  placementOptionId: 'po-1', status: 'OFFERED', expiresAt: T('14:30'), fees: [], discounts: [],
  shipments: [{ shipmentId: 'sh-c', destinationFc: 'MXP5', destinationTown: null, transport: [own('sh-c', 'to-c', 'BRT')], deliveryWindows: [windowOf('dw-c', T('00:00', '2026-10-14'), T('00:00', '2026-10-21'))] }],
}
const waiting = (over: Partial<FbaPlanView> = {}) => plan({
  status: 'WAITING_FOR_CHOICE', step: 'CONFIRM',
  options: { readAt: T('08:30'), expiresAt: T('14:30'), placements: [TWO_SHIPMENTS, ONE_SHIPMENT, { ...ONE_SHIPMENT, placementOptionId: 'po-old', status: 'EXPIRED' }] },
  can: { choose: true, newOptions: false, retry: false, cancel: true },
  ...over,
})

describe('a plan\'s status, in the shared words', () => {
  it('every status has a word and a tone: running info, a person\'s turn warning, failed danger, shipped success, final neutral', () => {
    for (const status of FBA_PLAN_STATUSES) expect(statusText(status)).toBe(FBA_SEND_COPY.status[status])
    expect(statusTone('PACKING')).toBe('info')
    expect(statusTone('WAITING_FOR_CHOICE')).toBe('warning')
    expect(statusTone('READY_TO_SHIP')).toBe('warning')
    expect(statusTone('HELD')).toBe('warning')
    expect(statusTone('FAILED')).toBe('danger')
    expect(statusTone('AT_AMAZON')).toBe('success')
    expect(statusTone('CANCELLED')).toBe('neutral')
    expect(isRunning('QUOTING')).toBe(true)
    expect(isRunning('WAITING_FOR_CHOICE')).toBe(false)
  })

  it('the plan\'s name as stored; an older row without one shows its id\'s end', () => {
    expect(planName(plan())).toBe('Nexus IT 2026-10-08 #a1b2c3')
    expect(planName(plan({ name: ' ', id: 'cmabc123456' }))).toBe('Plan #123456')
  })

  it('one line of facts, only what the server sent', () => {
    expect(planFacts(plan())).toBe('To IT · 24 units · 3 SKUs · from IT-MAIN')
    expect(planFacts(plan({ market: null, from: null, units: 1, skus: 1 }))).toBe('1 unit · 1 SKU')
  })

  it('the list is newest first, and the drawer opens on the asked plan, else the only one, else the list', () => {
    const a = plan({ id: 'a', createdAt: T('08:00') })
    const b = plan({ id: 'b', createdAt: T('09:00') })
    expect(newestFirst([a, b]).map(p => p.id)).toEqual(['b', 'a'])
    expect(shownPlanId([a, b], null, null)).toBeNull()
    expect(shownPlanId([a], null, null)).toBe('a')
    expect(shownPlanId([a, b], null, 'a')).toBe('a')
    expect(shownPlanId([a, b], 'b', 'a')).toBe('b')
  })
})

describe('the steps (Timeline) — from the server\'s status and step log, never guessed', () => {
  const states = (p: FbaPlanView) => timelineItems(p).map(i => i.state)

  it('in order, with the shared labels', () => {
    expect(timelineItems(plan()).map(i => i.label)).toEqual(FBA_SEND_COPY.timeline.map(t => t.label))
  })

  it('QUEUED: nothing ran yet; CREATING: the first step runs', () => {
    expect(states(plan())).toEqual(['todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo'])
    expect(timelineItems(plan()).every(i => i.at === null)).toBe(true)
    expect(states(plan({ status: 'CREATING' }))[0]).toBe('running')
  })

  it('a done step shows the time Amazon finished it; one with no recorded time shows none', () => {
    const items = timelineItems(plan({ status: 'BOXES', step: 'BOXES', steps: [entry('CREATE', T('08:01')), entry('CREATE', T('08:03')), entry('PACK', null, 'IN_PROGRESS')] }))
    expect(items.slice(0, 3).map(i => [i.state, i.at])).toEqual([['done', T('08:03')], ['done', undefined], ['running', undefined]])
  })

  it('PLACE and QUOTE are one item; WAITING_FOR_CHOICE asks the person at "Confirmed"', () => {
    expect(states(plan({ status: 'PLACING' }))[3]).toBe('running')
    const items = timelineItems(waiting({ steps: [entry('PLACE', T('08:20')), entry('QUOTE', T('08:30'))] }))
    expect(items[3]).toMatchObject({ state: 'done', at: T('08:30') })
    expect(items[4]).toMatchObject({ state: 'waiting', at: null, detail: FBA_SEND_COPY.status.WAITING_FOR_CHOICE })
  })

  it('READY_TO_SHIP counts the shipments already shipped; SHIPPED takes the last Shipped time; At Amazon has no time of its own', () => {
    const ready = plan({ status: 'READY_TO_SHIP', step: 'TRACKING', shipments: [shipment({ shippedAt: T('10:42') }), shipment({ id: 'shp-2' })] })
    expect(timelineItems(ready)[6]).toMatchObject({ state: 'waiting', detail: '1 of 2 shipments shipped' })
    expect(timelineItems(plan({ status: 'READY_TO_SHIP' }))[6].detail).toBe(FBA_SEND_COPY.status.READY_TO_SHIP)
    const shipped = plan({ status: 'SHIPPED', shipments: [shipment({ shippedAt: T('10:42') }), shipment({ id: 'shp-2', shippedAt: T('11:05') })] })
    expect(timelineItems(shipped)[6]).toMatchObject({ state: 'done', at: T('11:05') })
    expect(timelineItems(shipped)[7]).toMatchObject({ state: 'todo', at: null })
    const atAmazon = timelineItems({ ...shipped, status: 'AT_AMAZON' })
    expect(atAmazon.every(i => i.state === 'done')).toBe(true)
    expect(atAmazon[7].at).toBeUndefined()
  })

  it('FAILED marks the failed step with the server\'s sentence; HELD the waiting one', () => {
    const failed = plan({ status: 'FAILED', step: 'PACK', message: 'Amazon refused the packing option', steps: [entry('CREATE', T('08:01'))] })
    expect(states(failed)).toEqual(['done', 'failed', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo'])
    expect(timelineItems(failed)[1]).toMatchObject({ detail: 'Amazon refused the packing option', at: undefined })
    const fromProblem = plan({ status: 'FAILED', step: 'BOXES', problems: [{ code: 'FBA_1', message: 'Box too heavy', severity: 'ERROR', details: null }] })
    expect(timelineItems(fromProblem)[2].detail).toBe('Box too heavy')
    const held = plan({ status: 'HELD', step: 'CREATE', message: FBA_SEND_COPY.held.writesOff })
    expect(timelineItems(held)[0]).toMatchObject({ state: 'held', detail: FBA_SEND_COPY.held.writesOff })
    const tracking = plan({ status: 'HELD', step: 'TRACKING', message: FBA_SEND_COPY.held.rate })
    expect(timelineItems(tracking)[6].state).toBe('held')
  })

  it('a cancelled plan keeps only what Amazon finished, then "Cancelled" at its time; the steps that never ran are left out', () => {
    const cancelled = plan({ status: 'CANCELLED', step: 'CANCEL', cancelledAt: T('09:00'), steps: [entry('CREATE', T('08:01')), entry('PACK', null, 'FAILED')] })
    expect(timelineItems(cancelled).map(i => [i.label, i.state, i.at])).toEqual([
      ['Created', 'done', T('08:01')],
      ['Cancelled', 'cancelled', T('09:00')],
    ])
    expect(timelineItems(plan({ status: 'CANCELLED', cancelledAt: T('08:00') })).map(i => i.label)).toEqual(['Cancelled'])
    expect(timelineItems(plan({ status: 'CANCELLING', step: 'CANCEL' })).at(-1)).toMatchObject({ label: 'Cancelling', state: 'running' })
    const cancelFailed = plan({ status: 'FAILED', step: 'CANCEL', message: 'Amazon could not cancel' })
    expect(timelineItems(cancelFailed).at(-1)).toMatchObject({ state: 'failed', detail: 'Amazon could not cancel' })
  })
})

describe('money, days and times', () => {
  it('fees summed per currency; no valued fee → 0.00', () => {
    expect(moneyText({ amount: 12.5, currency: 'EUR' })).toBe('€12.50')
    expect(moneyText({ amount: 3, currency: 'NOT A CODE' })).toBe('3.00 NOT A CODE')
    expect(feesText([])).toBe('0.00')
    expect(feesText([
      { type: 'FEE', target: null, description: null, value: { amount: 1.1, currency: 'EUR' } },
      { type: 'FEE', target: null, description: null, value: { amount: 2.2, currency: 'EUR' } },
      { type: 'FEE', target: null, description: null, value: null },
    ])).toBe('€3.30')
  })

  it('a delivery window: one month says it once; two months say both', () => {
    expect(dayRange(T('00:00', '2026-10-14'), T('00:00', '2026-10-21'), 'UTC')).toEqual({ start: '14', end: '21 Oct' })
    expect(windowText({ start: T('00:00', '2026-10-28'), end: T('00:00', '2026-11-03') }, 'UTC')).toBe('28 Oct–3 Nov')
    expect(arriveText({ start: T('00:00', '2026-10-14'), end: T('00:00', '2026-10-21') }, 'UTC')).toBe('arrive 14–21 Oct')
  })

  it('a time is the clock today and the day + clock another day; Amazon\'s words are made readable', () => {
    const now = Date.parse(T('12:00'))
    expect(clockText(T('08:42'), { timeZone: ROME, now })).toBe('10:42')
    expect(clockText(T('08:42', '2026-10-06'), { timeZone: ROME, now })).toBe('6 Oct 10:42')
    expect(clockText('not a time')).toBe('not a time')
    expect(amazonWord('IN_TRANSIT')).toBe('in transit')
  })
})

describe('the choice: Amazon\'s options with their fees and carriers, in ONE pick', () => {
  it('only the options Amazon offers now, in its order', () => {
    expect(offeredPlacements(waiting()).map(o => o.placementOptionId)).toEqual(['po-2', 'po-1'])
    expect(offeredPlacements(plan())).toEqual([])
  })

  it('the card: shipments, fulfilment centres and Amazon\'s fees; one line per shipment with carrier and arrival', () => {
    expect(placementTitle(TWO_SHIPMENTS)).toBe('2 shipments · MXP5, FCO1 · Amazon fees €0.00')
    expect(placementTitle(ONE_SHIPMENT)).toBe('1 shipment · MXP5 · Amazon fees 0.00')
    expect(placementLines(TWO_SHIPMENTS, defaultPicks(TWO_SHIPMENTS), 'UTC')).toEqual([
      'MXP5: Own carrier · BRT · arrive 14–21 Oct',
      'FCO1: Own carrier · BRT · arrive 15–22 Oct',
    ])
    expect(placementLines(ONE_SHIPMENT, defaultPicks(ONE_SHIPMENT), 'UTC')).toEqual(['Own carrier · BRT · arrive 14–21 Oct'])
    const discounted = { ...ONE_SHIPMENT, discounts: [{ type: 'DISCOUNT', target: null, description: null, value: { amount: 5, currency: 'EUR' } }] }
    expect(placementLines(discounted, defaultPicks(discounted), 'UTC').at(-1)).toBe('discount €5.00')
  })

  it('defaults: the first own carrier Amazon lists and the earliest window', () => {
    expect(defaultPicks(TWO_SHIPMENTS)).toEqual({
      'sh-a': { transportationOptionId: 'to-a-brt', deliveryWindowOptionId: 'dw-a-early' },
      'sh-b': { transportationOptionId: 'to-b-brt', deliveryWindowOptionId: 'dw-b' },
    })
  })

  it('an Amazon-partnered carrier takes no window and names its quote; back to an own carrier takes the earliest again', () => {
    const start = defaultPicks(TWO_SHIPMENTS)
    const ups = withTransport(start, TWO_SHIPMENTS, 'sh-a', 'to-a-ups')
    expect(ups['sh-a']).toEqual({ transportationOptionId: 'to-a-ups', deliveryWindowOptionId: null })
    expect(placementLines(TWO_SHIPMENTS, ups, 'UTC')[0]).toBe('MXP5: UPS · Amazon-partnered · €45.00')
    const gls = withTransport(ups, TWO_SHIPMENTS, 'sh-a', 'to-a-gls')
    expect(gls['sh-a']).toEqual({ transportationOptionId: 'to-a-gls', deliveryWindowOptionId: 'dw-a-early' })
    const late = withWindow(gls, TWO_SHIPMENTS, 'sh-a', 'dw-a-late')
    expect(late['sh-a'].deliveryWindowOptionId).toBe('dw-a-late')
    expect(withTransport(late, TWO_SHIPMENTS, 'sh-a', 'to-a-brt')['sh-a'].deliveryWindowOptionId).toBe('dw-a-late')
    expect(withWindow(late, TWO_SHIPMENTS, 'sh-a', 'dw-unknown')).toBe(late)
    expect(withTransport(late, TWO_SHIPMENTS, 'sh-a', 'to-unknown')).toBe(late)
    expect(transportText(partnered('x', 'y'))).toBe('UPS · Amazon-partnered · €45.00')
    expect(transportText({ ...own('x', 'y', 'BRT'), shippingMode: 'FREIGHT_LTL' })).toBe('BRT · freight ltl')
  })

  it('"Confirm with Amazon" is held until every shipment has a carrier and, for an own carrier, a window', () => {
    expect(choiceHeld(TWO_SHIPMENTS, defaultPicks(TWO_SHIPMENTS))).toBeNull()
    expect(choiceHeld(null, {})).toBe(DRAWER_COPY.noOptions)
    expect(choiceHeld(TWO_SHIPMENTS, { 'sh-a': defaultPicks(TWO_SHIPMENTS)['sh-a'] })).toBe('FCO1: choose a carrier')
    const noWindows = { ...ONE_SHIPMENT, shipments: [{ ...ONE_SHIPMENT.shipments[0], deliveryWindows: [] }] }
    expect(choiceHeld(noWindows, defaultPicks(noWindows))).toBe('MXP5: Amazon gave no delivery window for this carrier')
  })

  it('the payload: one entry per shipment, the window only for an own carrier', () => {
    const picks = withTransport(defaultPicks(TWO_SHIPMENTS), TWO_SHIPMENTS, 'sh-a', 'to-a-ups')
    expect(choicePayload(TWO_SHIPMENTS, picks)).toEqual({
      placementOptionId: 'po-2',
      shipments: [
        { shipmentId: 'sh-a', transportationOptionId: 'to-a-ups', deliveryWindowOptionId: null },
        { shipmentId: 'sh-b', transportationOptionId: 'to-b-brt', deliveryWindowOptionId: 'dw-b' },
      ],
    })
  })
})

describe('the shipments: labels, one tracking number per box, Mark shipped', () => {
  it('a shipment\'s title and the carrier Amazon confirmed', () => {
    expect(shipmentTitle(shipment())).toBe('FBA15ABC · MXP5 · 2 boxes')
    expect(shipmentTransportText(shipment())).toBeNull()
    const confirmed = shipment({ transport: { transportationOptionId: 'to', carrierName: 'BRT', carrierCode: 'BRT', shippingMode: 'GROUND_SMALL_PARCEL', shippingSolution: 'USE_YOUR_OWN_CARRIER', deliveryWindow: { deliveryWindowOptionId: 'dw', start: T('00:00', '2026-10-14'), end: T('00:00', '2026-10-21') }, quote: null } })
    expect(shipmentTransportText(confirmed, 'UTC')).toBe('Own carrier · BRT · arrive 14–21 Oct')
  })

  it('labels from READY_TO_SHIP on; Mark shipped only for a shipment not shipped yet', () => {
    const ready = plan({ status: 'READY_TO_SHIP' })
    expect(canShip(ready, shipment())).toBe(true)
    expect(canShip(ready, shipment({ shippedAt: T('10:00') }))).toBe(false)
    expect(canShip(plan({ status: 'LABELS' }), shipment())).toBe(false)
    expect(canPrintLabels(ready, shipment())).toBe(true)
    expect(canPrintLabels(plan({ status: 'SHIPPED' }), shipment())).toBe(true)
    expect(canPrintLabels(plan({ status: 'CANCELLED' }), shipment())).toBe(false)
    expect(canPrintLabels(ready, shipment({ boxes: [] }))).toBe(false)
  })

  it('one row per box with its content; a pasted column fills this box and the ones below', () => {
    const s = shipment()
    expect(trackingRows(s, { FBA15ABCU000002: 'T2' })).toEqual([
      { boxId: 'FBA15ABCU000001', label: 'Box 1 of 2', content: 'GALE-M ×12', value: '' },
      { boxId: 'FBA15ABCU000002', label: 'Box 2 of 2', content: 'GALE-L ×8 · GALE-S ×4', value: 'T2' },
    ])
    const ids = s.boxes.map(b => b.boxId)
    expect(fillDown(ids, ids[0], 'T1\r\nT2\nT3\n', {})).toEqual({ FBA15ABCU000001: 'T1', FBA15ABCU000002: 'T2' })
    expect(fillDown(ids, ids[1], 'X\tY', { FBA15ABCU000001: 'T1' })).toEqual({ FBA15ABCU000001: 'T1', FBA15ABCU000002: 'X' })
    expect(fillDown(ids, ids[0], 'ONLY-ONE', {})).toBeNull()
  })

  it('Mark shipped waits for a number on every box; the numbers go trimmed', () => {
    const s = shipment()
    expect(trackingHeld(s, { FBA15ABCU000001: ' ' })).toBe('Add a tracking number for every box (2 of 2 missing)')
    expect(trackingHeld(s, { FBA15ABCU000001: 'T1', FBA15ABCU000002: 'T2' })).toBeNull()
    expect(shippedPayload(s, { FBA15ABCU000001: ' T1 ', FBA15ABCU000002: 'T2' })).toEqual({
      tracking: [{ boxId: 'FBA15ABCU000001', trackingId: 'T1' }, { boxId: 'FBA15ABCU000002', trackingId: 'T2' }],
    })
    expect(shippedConfirmText(plan(), s)).toBe('24 units leave IT-MAIN')
    expect(shippedConfirmText(plan({ from: null }), s)).toBe('24 units leave the warehouse')
  })

  it('after Shipped: "tracking sent" only when Amazon took it, and Amazon\'s own status word', () => {
    const now = Date.parse(T('12:00'))
    expect(shippedText(shipment(), { timeZone: ROME, now })).toBeNull()
    expect(shippedText(shipment({ shippedAt: T('08:42'), status: 'WORKING' }), { timeZone: ROME, now })).toBe('Shipped 10:42 · sending tracking · Amazon: working')
    expect(shippedText(shipment({ shippedAt: T('08:42'), status: 'IN_TRANSIT', tracking: { boxes: [], sentAt: T('08:43') } }), { timeZone: ROME, now }))
      .toBe('Shipped 10:42 · tracking sent · Amazon: in transit')
  })

  it('the plan\'s SKUs for the table and the stock hint', () => {
    expect(lineRows(plan())[0]).toEqual({ id: 'p-m', cells: ['GALE-M', '12', '1 case of 12', '0'] })
    expect(lineRows(plan())[1]).toEqual({ id: 'p-l', cells: ['GALE-L', '8', '8 loose', '0'] })
    expect(planProductIds(plan())).toEqual(['p-m', 'p-l', 'p-s'])
  })

  it('how a line is packed: cases per size, then the loose units', () => {
    expect(packedText({ cases: [{ unitsPerCase: 12, cases: 2 }], looseUnits: 3 })).toBe('2 cases of 12 + 3 loose')
    expect(packedText({ cases: [{ unitsPerCase: 12, cases: 2 }, { unitsPerCase: 6, cases: 1 }], looseUnits: 3 })).toBe('2×12 + 1×6 + 3 loose')
    expect(packedText({ cases: [{ unitsPerCase: 12, cases: 2 }, { unitsPerCase: 6, cases: 0 }], looseUnits: 0 })).toBe('2 cases of 12')
    expect(packedText({ cases: [], looseUnits: 0 })).toBe('—')
  })
})

describe('the routes and their answers (Part C, routes/fba-send.routes.ts)', () => {
  it('the paths of the contract', () => {
    expect(FBA_ROUTES.plans('root 1')).toBe('/api/fba/inbound/plans?productId=root%201&open=1')
    expect(FBA_ROUTES.plan('p1')).toBe('/api/fba/inbound/plans/p1')
    expect(FBA_ROUTES.choice('p1')).toBe('/api/fba/inbound/plans/p1/choice')
    expect(FBA_ROUTES.cancel('p1')).toBe('/api/fba/inbound/plans/p1/cancel')
    expect(FBA_ROUTES.retry('p1')).toBe('/api/fba/inbound/plans/p1/retry')
    expect(FBA_ROUTES.labels('s1')).toBe('/api/fba/inbound/shipments/s1/labels')
    expect(FBA_ROUTES.shipped('s1')).toBe('/api/fba/inbound/shipments/s1/shipped')
    expect(commandSlot('choice', 'p1')).toBe('fba-choice:p1')
  })

  it('a click\'s answer is the plan the server holds now, or the server\'s own sentence with its problems', () => {
    const view = waiting()
    expect(readPlanAnswer(200, view, null)).toEqual({ ok: true, plan: view })
    expect(readPlanAnswer(409, { ok: false, code: 'WRONG_STATE', error: 'This plan is already confirmed', problems: [] }, null))
      .toEqual({ ok: false, message: 'This plan is already confirmed', problems: [] })
    expect(readPlanAnswer(400, { ok: false, code: 'REFUSED', error: 'Refused', problems: [{ code: 'OVER_FREE', message: 'GALE-M: 12 units asked; 4 free at IT-MAIN', productId: 'p-m', blocking: true }] }, null))
      .toEqual({ ok: false, message: 'Refused', problems: ['GALE-M: 12 units asked; 4 free at IT-MAIN'] })
    expect(readPlanAnswer(502, null, null)).toEqual({ ok: false, message: 'The server refused this (HTTP 502).', problems: [] })
    expect(readPlanAnswer(200, { ok: true }, null)).toEqual({ ok: false, message: DRAWER_COPY.noPlanInAnswer, problems: [] })
    const running = readPlanAnswer(409, { error: 'The same request is still running.' }, 'running')
    expect(running.ok).toBe(false)
    if (!running.ok) expect(running.message).toContain('still running')
  })

  it('the list is read newest first; a refused read throws the server\'s sentence', () => {
    const a = plan({ id: 'a', createdAt: T('08:00') })
    const b = plan({ id: 'b', createdAt: T('09:00') })
    expect(readPlansAnswer(200, { plans: [a, b, { id: 'junk' }] }).map(p => p.id)).toEqual(['b', 'a'])
    expect(() => readPlansAnswer(403, { ok: false, error: 'Missing permission inbound.manage' })).toThrow('Missing permission inbound.manage')
    expect(readOnePlanAnswer(404, { ok: false, error: 'not found' })).toBeNull()
    expect(readOnePlanAnswer(200, a)).toEqual(a)
  })

  it('the labels link must be a web link from the server', () => {
    expect(readLabelsAnswer(200, { downloadUrl: 'https://amazon.example/labels.pdf' })).toBe('https://amazon.example/labels.pdf')
    expect(() => readLabelsAnswer(200, { downloadUrl: 'javascript:alert(1)' })).toThrow()
    expect(() => readLabelsAnswer(409, { ok: false, code: 'LABELS_UNAVAILABLE', error: 'No labels yet' })).toThrow('No labels yet')
  })
})

describe('live', () => {
  it('the plan event arrives as inventory.stock_changed with subtype fba-plan (E1\'s bridge); other stock events do not re-read', () => {
    expect(isFbaPlanEvent({ type: 'inventory.stock_changed', meta: { subtype: 'fba-plan', planId: 'p1' } })).toBe(true)
    expect(isFbaPlanEvent({ type: 'inventory.stock_changed', meta: { subtype: 'cases' } })).toBe(false)
    expect(isFbaPlanEvent({ type: 'stock.adjusted', meta: { subtype: 'fba-plan' } })).toBe(false)
  })

  it('re-reads more often while the job moves a plan', () => {
    const at = (status: FbaPlanStatus) => ({ status })
    expect(rereadDelay([at('READY_TO_SHIP'), at('QUOTING')])).toBe(REREAD_RUNNING_MS)
    expect(rereadDelay([at('READY_TO_SHIP')])).toBe(REREAD_IDLE_MS)
    expect(rereadDelay([])).toBe(REREAD_IDLE_MS)
  })
})

describe('the drawer file keeps the design-system rules', () => {
  const source = readFileSync(join(__dirname, 'FbaPlansDrawer.tsx'), 'utf8')
  it('no raw controls, no Tailwind, the DS Drawer at 480 px', () => {
    expect(source).not.toMatch(/<(button|input|select|textarea|table)[\s>]/)
    expect(source).not.toMatch(/className="[^"]*\b(text|bg|flex|grid|p|m|px|py|gap)-[a-z0-9]/)
    expect(source).toMatch(/export const FBA_PLANS_DRAWER_WIDTH = 480/)
    expect(source).toMatch(/<Drawer\b/)
  })
  it('confirming at Amazon is one click on the server\'s option — no authenticator code is asked', () => {
    expect(source).not.toMatch(/ConfirmPhraseField|confirmPhrase|type-to-confirm|totp/i)
    expect(source).toMatch(/FBA_SEND_COPY\.confirmFinal/)
  })
})
