import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ApiError } from '../../../../lib/api/errors'
import type { PickerReason } from '../../../_shared/reasons/api'
import type { HoldRow } from './api'
import {
  asOfHeldKey,
  asOfInstant,
  availableOf,
  blankWriteOff,
  demandLabel,
  holdHeldKey,
  holdOfRow,
  holdsBySubject,
  quantityText,
  refusalsOf,
  reserveHeldKey,
  reserveProblem,
  spreadReservations,
  subjectProblemKey,
  valueLeaving,
  writeOffHeld,
  writeOffLines,
  writeOffProblem,
  type ReservableLine,
  type WriteOffTarget,
} from './model'

/** The warehouse's every-day rules (B-W2a-64): pure, no React, made-up data only. */

const ROME = 'Europe/Rome'
const reason = (code: string, needsDetail = false): PickerReason => ({ id: code, list: 'WRITE_OFF', code, labelIt: `${code} it`, labelEn: `${code} en`, labelI18n: {}, icon: null, colour: null, needsDetail, sortOrder: 0 })

describe('stock as of a date (design st-asof)', () => {
  it('means the last millisecond of the minute in the site zone, summer and winter time', () => {
    expect(asOfInstant('2026-09-30', '23:59', ROME)).toBe('2026-09-30T21:59:59.999Z')
    expect(asOfInstant('2026-12-31', '23:59', ROME)).toBe('2026-12-31T22:59:59.999Z')
    // The night the clocks go back (25 Oct 2026): after 03:00 the zone is UTC+1.
    expect(asOfInstant('2026-10-25', '23:59', ROME)).toBe('2026-10-25T22:59:59.999Z')
    expect(asOfInstant('2026-03-29', '12:00', ROME)).toBe('2026-03-29T10:00:59.999Z')
  })
  it('refuses a day or time that is not one, and a moment that has not come yet', () => {
    expect(asOfInstant('2026-02-30', '23:59', ROME)).toBeNull()
    expect(asOfInstant('2026-09-30', '24:00', ROME)).toBeNull()
    const now = Date.parse('2026-10-30T09:00:00.000Z')
    expect(asOfHeldKey('', '23:59', now, ROME)).toBe('asof.held.day')
    expect(asOfHeldKey('2026-10-31', '23:59', now, ROME)).toBe('asof.held.future')
    expect(asOfHeldKey('2026-10-30', '10:00', now, ROME)).toBeNull()
    expect(asOfHeldKey('2026-09-30', '', now, ROME)).toBeNull()
  })
})

describe('reservations on the stock grid (B-W2a-11: a site’s stock, placed per lot row)', () => {
  const line = (id: string, over: Partial<ReservableLine>): ReservableLine => ({ id, siteId: 'S', itemId: 'I', colourId: 'BLK', lotId: 'L1', locationCode: 'A', onHand: 20, held: 0, hideReserved: 0, ...over })
  it('fills a lot’s rows in place order up to their free stock, keeps hides’ own and spreads any-lot reservations after', () => {
    const lines = [line('a', { locationCode: 'A' }), line('b', { locationCode: 'B' }), line('h', { locationCode: 'C', onHand: 35, hideReserved: 35 }), line('x', { lotId: 'L2', locationCode: 'A', onHand: 10 })]
    const { reserved, over } = spreadReservations(lines, [
      { siteId: 'S', itemId: 'I', itemColourId: 'BLK', lotId: 'L1', reserved: '65.0000', reservations: 2, stale: 0 },
      { siteId: 'S', itemId: 'I', itemColourId: 'BLK', lotId: null, reserved: '12.0000', reservations: 1, stale: 0 },
    ])
    // L1: 65 reserved of which its hide's 35 is on row h → 30 more: 20 at A, 10 at B; any lot, in place order: L2 at A
    // takes its 10, then B its last 2.
    expect(Object.fromEntries(reserved)).toEqual({ a: 20, b: 12, h: 35, x: 10 })
    expect(over.size).toBe(0)
    expect(availableOf(20, 0, 20)).toBe(0)
  })
  it('says what does not fit as over-reserved (never as free stock)', () => {
    const { reserved, over } = spreadReservations([line('a', { onHand: 5, held: 2 })], [{ siteId: 'S', itemId: 'I', itemColourId: 'BLK', lotId: null, reserved: '10.0000', reservations: 1, stale: 0 }])
    expect(reserved.get('a')).toBe(3)
    expect(over.get('S|I|BLK')).toBe(7)
    expect(availableOf(5, 2, 10)).toBe(-7)
  })
})

describe('why a row is held', () => {
  const hold = (id: string, type: HoldRow['subjectType'], subjects: string[], placedAt: string, status: HoldRow['status'] = 'ACTIVE'): HoldRow => ({
    id,
    siteId: 'S',
    status,
    subjectType: type,
    subjects: subjects.map((subject) => ({ id: subject, label: subject, state: null })),
    quantity: null,
    reasonCode: `R-${id}`,
    reasonNote: null,
    sourceType: null,
    placedAt,
    overdue: false,
    ageDays: 1,
    ncrId: null,
    releasedAt: null,
    closedAt: null,
    version: 1,
  })
  it('takes the oldest ACTIVE hold of a lot or hide, the hide’s own first', () => {
    const map = holdsBySubject([hold('2', 'Lot', ['L1'], '2026-10-02T08:00:00.000Z'), hold('1', 'Lot', ['L1'], '2026-10-01T08:00:00.000Z'), hold('3', 'Hide', ['H1'], '2026-10-03T08:00:00.000Z'), hold('4', 'WorkOrder', ['W1'], '2026-10-01T08:00:00.000Z'), hold('5', 'Lot', ['L2'], '2026-10-01T08:00:00.000Z', 'RELEASED')])
    expect(map.get('L1')?.holdId).toBe('1')
    expect(map.has('W1')).toBe(false)
    expect(map.has('L2')).toBe(false)
    expect(holdOfRow(map, { lotId: 'L1', hideId: 'H1' })?.holdId).toBe('3')
    expect(holdOfRow(map, { lotId: 'L1', hideId: null })?.reasonCode).toBe('R-1')
    expect(holdOfRow(map, { lotId: null, hideId: null })).toBeNull()
  })
  it('names a demand and holds the hold dialog until it may go', () => {
    expect(demandLabel({ type: 'WorkOrder', id: 'w', number: 'WO-DEMO-0031', status: 'RELEASED' })).toBe('WO-DEMO-0031')
    expect(demandLabel({ type: 'SalesOrderLine', id: 'l', orderId: 'o', orderNumber: 'SO-DEMO-0004', seq: 10, status: 'CONFIRMED' })).toBe('SO-DEMO-0004 · 10')
    const reasons = [{ ...reason('QUALITY_CHECK'), list: 'HOLD' as const }, { ...reason('OTHER', true), list: 'HOLD' as const }]
    const preview = { siteId: 'S', subjects: [{ id: 'L1', code: 'L1', label: 'L1', state: 'RELEASED', quantity: null, problem: null }], quantity: null, workOrders: [], quarantinePlaces: [] }
    const draft = { reasonCode: '', reasonNote: '', askQuarantine: false, quarantineLocationId: null }
    expect(holdHeldKey(draft, reasons, null, false)).toBe('hold.held.preview')
    expect(holdHeldKey(draft, reasons, preview, false)).toBe('hold.held.reason')
    expect(holdHeldKey({ ...draft, reasonCode: 'OTHER' }, reasons, preview, false)).toBe('hold.held.note')
    expect(holdHeldKey({ ...draft, reasonCode: 'QUALITY_CHECK', askQuarantine: true }, reasons, preview, false)).toBe('hold.held.place')
    expect(holdHeldKey({ ...draft, reasonCode: 'QUALITY_CHECK' }, reasons, preview, false)).toBeNull()
    const rejected = { ...preview, subjects: [{ ...preview.subjects[0]!, state: 'REJECTED', problem: 'Lot L1 is rejected …' }] }
    expect(holdHeldKey({ ...draft, reasonCode: 'QUALITY_CHECK' }, reasons, rejected, false)).toBe('hold.held.problem')
    expect(subjectProblemKey(rejected.subjects[0]!)).toBe('hold.problem.rejected')
  })
})

describe('write off and reserve', () => {
  const lot: WriteOffTarget = {
    kind: 'quantity',
    siteId: 'S',
    item: { id: 'I', code: 'DEMO-FOD-02', name: 'Fodera', baseUom: 'M' },
    colour: { id: 'GRY', code: 'GRY' },
    lot: { id: 'L1', code: 'LOT-D-1' },
    location: { id: 'P', code: 'N-MAG', name: 'Magazzino' },
    onHand: '120.0000',
    unitCost: '3.100000',
    currency: 'EUR',
  }
  const reasons = [reason('DAMAGED'), reason('OTHER', true)]
  it('holds Write off with the missing field named, a held lot, a reserved or held hide', () => {
    const draft = blankWriteOff()
    expect(writeOffHeld(lot, draft, reasons, false)?.key).toBe('wo.held.quantity')
    expect(writeOffHeld(lot, { ...draft, quantity: '121' }, reasons, false)?.key).toBe('wo.held.tooMuch')
    expect(writeOffHeld(lot, { ...draft, quantity: '1,5' }, reasons, false)?.key).toBe('wo.held.reason')
    expect(writeOffHeld(lot, { ...draft, quantity: '1,5', reasonCode: 'OTHER' }, reasons, false)?.key).toBe('wo.held.note')
    expect(writeOffHeld(lot, { ...draft, quantity: '1,5', reasonCode: 'DAMAGED' }, reasons, false)).toBeNull()
    // An NCR asked for needs how serious it is (the API refuses it without).
    expect(writeOffHeld(lot, { ...draft, quantity: '1,5', reasonCode: 'DAMAGED', openNcr: true }, reasons, false)?.key).toBe('wo.held.severity')
    expect(writeOffHeld(lot, { ...draft, quantity: '1,5', reasonCode: 'DAMAGED', openNcr: true, ncrSeverity: 'MINOR' }, reasons, false)).toBeNull()
    expect(writeOffHeld({ ...lot, hold: { holdId: 'h', reasonCode: 'QUALITY_CHECK', placedAt: '', subjectType: 'Lot' } }, { ...draft, quantity: '1', reasonCode: 'DAMAGED' }, reasons, false)?.key).toBe('wo.held.lotOnHold')
    const hides: WriteOffTarget = { kind: 'hides', siteId: 'S', hides: [{ id: 'H1', code: 'HD-1', lotId: 'L1', area: '50.0000', uom: 'FT2', reservedFor: 'WO-DEMO-0031' }] }
    expect(writeOffHeld(hides, { ...draft, reasonCode: 'DAMAGED' }, reasons, false)).toEqual({ key: 'wo.held.reserved', params: { code: 'HD-1', demand: 'WO-DEMO-0031' } })
    expect(writeOffLines(hides, draft)).toEqual([{ hideId: 'H1' }])
    expect(writeOffLines(lot, { ...draft, quantity: '1,5' })).toEqual([{ itemId: 'I', itemColourId: 'GRY', lotId: 'L1', fromLocationId: 'P', quantity: '1.5' }])
    expect(valueLeaving(lot, { ...draft, quantity: '2' })).toEqual({ amount: 620, currency: 'EUR' })
    expect(quantityText('0')).toBeNull()
  })
  it('says the API’s refusals in our words (by their path)', () => {
    const hold = new ApiError('conflict', 409, 'conflict', 'Lot … is on hold', null, [{ path: 'body/lines/0/refusal/QUALITY_HOLD', message: '…' }])
    expect(refusalsOf(hold)).toEqual([{ index: 0, code: 'QUALITY_HOLD' }])
    expect(writeOffProblem(hold).key).toBe('wo.problem.onHold')
    const reserved = new ApiError('conflict', 409, 'conflict', 'Hide … is reserved', null, [{ path: 'body/lines/0/hideId', message: '…' }])
    expect(writeOffProblem(reserved).key).toBe('wo.problem.reserved')
    const taken = new ApiError('conflict', 409, 'conflict', '…', null, [{ path: 'body/lines/1/refusal/HIDE_RESERVED', message: '…' }])
    expect(reserveProblem(taken)).toEqual({ key: 'reserve.refusal.HIDE_RESERVED', params: { count: 1 } })
    expect(reserveHeldKey({ hides: [{ why: null }], workOrderId: null, posting: false })).toBe('reserve.held.workOrder')
    expect(reserveHeldKey({ hides: [{ why: { key: 'reserve.why.notInStock' } }], workOrderId: 'w', posting: false })).toBe('reserve.held.none')
  })
})

describe('the every-day words', () => {
  it('has every key the rules name, in both languages', () => {
    const read = (locale: string) => JSON.parse(readFileSync(new URL(`../../../../../messages/${locale}/warehouse-daily.json`, import.meta.url), 'utf8')) as Record<string, unknown>
    const has = (tree: Record<string, unknown>, key: string) => key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree) !== undefined
    const keys = ['asof.held.day', 'asof.held.future', 'asof.held.invalid', 'hold.held.preview', 'hold.held.reason', 'hold.held.note', 'hold.held.place', 'hold.held.problem', 'hold.problem.rejected', 'wo.held.quantity', 'wo.held.tooMuch', 'wo.held.reason', 'wo.held.note', 'wo.held.lotOnHold', 'wo.held.reserved', 'wo.problem.onHold', 'wo.problem.reserved', 'wo.held.severity', 'wo.severities.MINOR', 'reserve.refusal.HIDE_RESERVED', 'reserve.held.workOrder', 'reserve.held.none']
    for (const locale of ['it', 'en']) {
      const tree = read(locale)
      for (const key of keys) expect(has(tree, key), `${locale}: ${key}`).toBe(true)
    }
  })
})
