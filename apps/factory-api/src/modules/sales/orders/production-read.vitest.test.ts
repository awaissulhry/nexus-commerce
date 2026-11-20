import { describe, expect, it } from 'vitest'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { alsoMakesOf, BLOCKER_WORDS, daysBetween, inWorkPiecesOf, mtmGroupsOf, ownShareOf, partsOf, sumOrNull, withheldOf, type OtherOrder } from './production-read'
// B-OP-021: a work order's rights from the order page, and a blocker's door behind the wall.
import { blockerRefFor, SHARED_WORK_ORDER_WORDS, workOrderRightsOf } from './production-read'
import { BLOCKER_KINDS } from '@nexus/factory-domain/production-brand/waiting'
// B-OO-007: what still waits after production; a first promise is not a move.
import { officeBlockersOf, promiseMovesOf } from './production-read'
import { blockerWordsOf } from './production-read' // walk #3
import type { Blocker } from '@nexus/factory-domain/production-brand/waiting'

/**
 * B-SA-031 / B-SA-032 — the office's read of one order's production, its pure parts (the PG suite production-read.pg.vitest.test.ts
 * proves the reads): the parts asked, what is withheld by right, "also makes" (only this customer's orders named, the rest of them
 * counted, another customer's never named nor counted), made-to-measure units grouped per style × colourway, the order's own share
 * of a work order, and what is in work as counts. Every id and name is made up (Brand Alpha, Brand Beta).
 */

const ALPHA = '11111111-1111-4111-8111-111111111111'
const BETA = '22222222-2222-4222-8222-222222222222'
const order = (number: string, partyId: string, companyId = 'c1'): OtherOrder => ({ id: `id-${number}`, number, companyId, partyId })

describe('partsOf: the parts a read asks', () => {
  it('reads every part when none is named, keeps the contract’s order, and refuses an unknown part in words', () => {
    expect(partsOf(undefined)).toEqual(['headline', 'lines', 'work', 'dates', 'quality', 'people', 'changes'])
    expect(partsOf('people, headline,lines')).toEqual(['headline', 'lines', 'people'])
    expect(partsOf('lines,lines')).toEqual(['lines'])
    expect(() => partsOf('lines,money')).toThrow(ValidationError)
    expect(() => partsOf(' , ')).toThrow("Not a part of the order's production.")
  })
})

describe('withheldOf: a part or block the reader may not read is named, never an empty part', () => {
  const holding = (...rights: Permission[]) => (permission: Permission) => rights.includes(permission)

  it('the Sales template (orders.view, no workorders.view, no planning.promise.view): work, people, the office notes, issues, NCRs, final and forecast withheld', () => {
    expect(withheldOf(['headline', 'lines', 'work', 'dates', 'quality', 'people', 'changes'], holding('orders.view'))).toEqual([
      'work',
      'people',
      'headline.notes',
      'quality.issues',
      'quality.ncrs',
      'quality.final',
      'dates.forecast',
    ])
  })

  it('only the parts asked are looked at; every right: nothing withheld', () => {
    expect(withheldOf(['lines', 'changes'], holding())).toEqual([])
    expect(withheldOf(['quality'], holding('workorders.view', 'quality.ncr.view'))).toEqual(['quality.final'])
    expect(withheldOf(['headline', 'work', 'dates', 'quality', 'people'], holding('workorders.view', 'quality.ncr.view', 'quality.inspections.view', 'planning.promise.view'))).toEqual([])
  })
})

describe('alsoMakesOf: what a work order also makes, behind the brand wall', () => {
  it('names the other orders of THIS customer the reader reaches, counts the others of this customer, never another customer’s', () => {
    const others = [order('SO-A2', ALPHA), order('SO-A3', ALPHA, 'c2'), order('SO-B1', BETA)]
    const reaches = (other: OtherOrder) => other.companyId === 'c1'
    expect(alsoMakesOf(others, ALPHA, reaches)).toEqual({ orders: [{ id: 'id-SO-A2', number: 'SO-A2' }], more: 1 })
    // Brand Beta's order is never named nor counted on Brand Alpha's order, even for a reader who reaches it.
    expect(alsoMakesOf(others, ALPHA, () => true)).toEqual({ orders: [{ id: 'id-SO-A2', number: 'SO-A2' }, { id: 'id-SO-A3', number: 'SO-A3' }], more: 0 })
    expect(JSON.stringify(alsoMakesOf(others, ALPHA, () => true))).not.toContain('SO-B1')
    expect(alsoMakesOf([], ALPHA, () => true)).toEqual({ orders: [], more: 0 })
  })
})

describe('mtmGroupsOf: made-to-measure work orders, one per unit, grouped per style × colourway', () => {
  it('folds twelve unit work orders of one style and colour into one row, with their statuses', () => {
    const units = [
      ...Array.from({ length: 9 }, (_, index) => ({ id: `w${index}`, styleId: 'JKT', colourwayId: 'BLK', status: 'RELEASED', units: 1 })),
      ...Array.from({ length: 3 }, (_, index) => ({ id: `d${index}`, styleId: 'JKT', colourwayId: 'BLK', status: 'DRAFT', units: 1 })),
      { id: 'r1', styleId: 'JKT', colourwayId: 'RED', status: 'IN_PROGRESS', units: 1 },
    ]
    const groups = mtmGroupsOf(units)
    expect(groups.map((group) => [group.styleId, group.colourwayId, group.units, group.workOrders, group.byStatus])).toEqual([
      ['JKT', 'BLK', 12, 12, [{ status: 'DRAFT', count: 3 }, { status: 'RELEASED', count: 9 }]],
      ['JKT', 'RED', 1, 1, [{ status: 'IN_PROGRESS', count: 1 }]],
    ])
  })
})

describe('the order’s own share and what is in work', () => {
  it('sums only the order’s own cells; a step nobody counts stays null, never a made-up 0', () => {
    const counts = new Map([
      ['c1', { cut: 4, sewn: null, inspected: 0 }],
      ['c2', { cut: 2, sewn: null, inspected: 1 }],
    ])
    expect(ownShareOf([{ cellId: 'c1', quantity: 20 }, { cellId: 'c2', quantity: 20 }], counts)).toEqual({ cells: 2, pieces: 40, cut: 6, sewn: null, checked: 1 })
    // A draft's cell has no count at all.
    expect(ownShareOf([{ cellId: 'draft', quantity: 10 }], counts)).toEqual({ cells: 1, pieces: 10, cut: null, sewn: null, checked: null })
    expect(sumOrNull([null, null])).toBeNull()
    expect(sumOrNull([null, 0])).toBe(0)
  })

  it('pieces between the steps, as counts; sewing not counted: no sewing or checking figure', () => {
    expect(inWorkPiecesOf({ started: 40, cut: 30, sewn: 20, checked: 12, packed: 4 })).toEqual({ cutting: 10, sewing: 10, checking: 8, packing: 8 })
    expect(inWorkPiecesOf({ started: 40, cut: 30, sewn: null, checked: 0, packed: 0 })).toEqual({ cutting: 10, sewing: null, checking: null, packing: 0 })
    expect(inWorkPiecesOf({ started: 0, cut: null, sewn: null, checked: null, packed: null })).toEqual({ cutting: 0, sewing: null, checking: null, packing: null })
  })

  it('the promise slip in days, and every blocker has its words (it + en)', () => {
    expect(daysBetween('2026-12-02', '2026-12-08')).toBe(6)
    expect(daysBetween('2026-12-08', '2026-12-02')).toBe(-6)
    for (const kind of BLOCKER_KINDS) expect(BLOCKER_WORDS[kind].it.length * BLOCKER_WORDS[kind].en.length).toBeGreaterThan(0)
  })
})

// ── B-OP-021 (13-backend §3 B4, B6; review R-11) ──
describe('B-OP-021: what the order page may do to a work order, and where a blocker opens', () => {
  const holding = (...rights: Permission[]) => (permission: Permission) => rights.includes(permission)

  it('rights are the reader’s own over the work order; one shared with other customers is changed on its own page only', () => {
    expect(workOrderRightsOf(holding('workorders.manage'), false)).toEqual({ manage: true, release: false, hold: false, why: null })
    expect(workOrderRightsOf(holding('workorders.release', 'workorders.hold'), false)).toEqual({ manage: false, release: true, hold: true, why: null })
    expect(workOrderRightsOf(holding('workorders.manage', 'workorders.release', 'workorders.hold'), true)).toEqual({ manage: false, release: false, hold: false, why: SHARED_WORK_ORDER_WORDS })
    expect(SHARED_WORK_ORDER_WORDS.it.length > 0 && SHARED_WORK_ORDER_WORDS.en.length > 0).toBe(true)
  })

  it('a blocker names its record; a work order only for a reader who reaches it', () => {
    const reaches = (id: string) => id === 'wo-reached'
    expect(blockerRefFor({ type: 'OrderChangeRequest', id: 'r1' }, reaches)).toEqual({ type: 'OrderChangeRequest', id: 'r1' })
    expect(blockerRefFor({ type: 'WorkOrder', id: 'wo-reached' }, reaches)).toEqual({ type: 'WorkOrder', id: 'wo-reached' })
    expect(blockerRefFor({ type: 'WorkOrder', id: 'wo-of-another' }, reaches)).toBeNull()
    expect(blockerRefFor(null, reaches)).toBeNull()
    expect(blockerRefFor(undefined, reaches)).toBeNull()
    // F-OP-103: a reported problem keeps the message it was raised with (Reply in the thread opens there); none: no messageId key.
    expect(blockerRefFor({ type: 'ProductionIssue', id: 'p1', messageId: 'm1' }, reaches)).toEqual({ type: 'ProductionIssue', id: 'p1', messageId: 'm1' })
    expect(blockerRefFor({ type: 'ProductionIssue', id: 'p1', messageId: null }, reaches)).toEqual({ type: 'ProductionIssue', id: 'p1' })
  })
})
// ── end B-OP-021 ──

// ── B-OO-007 (order overview plan §6; review F11; N10b) ──
describe('B-OO-007: after production only the requests wait; a first promise is not a move', () => {
  const at = new Date('2026-11-10T08:00:00.000Z')
  const every: Blocker[] = [
    { kind: 'NO_MOVE', since: at, ref: { type: 'WorkOrder', id: 'wo-1' } },
    { kind: 'BRAND_PAUSE', since: at, ref: { type: 'WorkOrder', id: 'wo-2' } },
    { kind: 'DEPOSIT', since: at, ref: null },
    { kind: 'GATE', since: at, ref: { type: 'OrderGate', id: 'g-1' } },
    { kind: 'MATERIAL_SHORT', since: null, ref: null },
    { kind: 'BRAND_REQUEST', since: at, ref: { type: 'ApprovalRequest', id: 'a-1' }, sub: 'REPROMISE' },
    { kind: 'BRAND_REQUEST', since: at, ref: { type: 'ProductionIssue', id: 'p-1' }, sub: 'PROBLEM' },
    { kind: 'BRAND_REQUEST', since: at, ref: { type: 'OrderChangeRequest', id: 'r-1' }, sub: 'REQUEST' },
    { kind: 'APPROVAL', since: at, ref: { type: 'ApprovalRequest', id: 'a-2' } },
  ]

  it('a current order (or one that waits for a yes) keeps every blocker', () => {
    for (const status of ['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const) expect(officeBlockersOf(status, every)).toEqual(every)
  })

  it('shipped, delivered, closed or cancelled: the holds and the dates go (a refused new date too), the requests stay', () => {
    for (const status of ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const) {
      const kept = officeBlockersOf(status, every)
      expect(kept.map((blocker) => blocker.ref?.id)).toEqual(['p-1', 'r-1', 'a-2'])
    }
    expect(officeBlockersOf('SHIPPED', [])).toEqual([])
  })

  it('counts the promise moves without the row that set a first promise', () => {
    // A first promise (the order had none), then two moves.
    expect(promiseMovesOf([{ promiseDate: null, originalPromiseDate: null }, { promiseDate: '2026-12-01', originalPromiseDate: '2026-12-01' }, { promiseDate: '2026-12-08', originalPromiseDate: '2026-12-01' }])).toBe(2)
    // A line change on an order with no promise yet is a first promise too; one of an order promised already is a move.
    expect(promiseMovesOf([{ lines: { 'l-1': null }, originalPromiseDate: null }])).toBe(0)
    expect(promiseMovesOf([{ lines: { 'l-1': '2026-12-01' }, originalPromiseDate: '2026-11-28' }])).toBe(1)
    // A row that does not say (no originalPromiseDate, or no before at all) counts, as before.
    expect(promiseMovesOf([{ promiseDate: '2026-12-01' }, null, 'text'])).toBe(3)
    expect(promiseMovesOf([])).toBe(0)
  })
})
// ── end B-OO-007 ──

// ── walk #3 (order overview walk fix round): an approval we asked of the customer says what it asks ──
describe('walk #3: an approval we asked names what it asks (its kind), never only "the customer\'s yes"', () => {
  const asked = (id: string): Blocker => ({ kind: 'APPROVAL', since: null, ref: { type: 'ApprovalRequest', id } })
  const kinds = new Map([['a-artwork', 'ARTWORK' as const], ['a-sample', 'SAMPLE' as const]])

  it('says the kind in the office words, English and Italian', () => {
    expect(blockerWordsOf(asked('a-artwork'), kinds)).toEqual({ en: "Waiting for the customer's yes: Artwork", it: 'In attesa del sì del cliente: Grafica' })
    expect(blockerWordsOf(asked('a-sample'), kinds)).toEqual({ en: "Waiting for the customer's yes: Sample", it: 'In attesa del sì del cliente: Campione' })
  })

  it('a kind not read, our counter-offer (its request says it) and every other blocker: the plain words', () => {
    expect(blockerWordsOf(asked('a-unknown'), kinds)).toEqual(BLOCKER_WORDS.APPROVAL)
    expect(blockerWordsOf({ kind: 'APPROVAL', ref: { type: 'OrderChangeRequest', id: 'a-artwork' } }, kinds)).toEqual(BLOCKER_WORDS.APPROVAL)
    for (const kind of BLOCKER_KINDS) expect(blockerWordsOf({ kind, ref: null }, kinds), kind).toEqual(BLOCKER_WORDS[kind])
  })

  it('never the question (free text, shown only with the approvals right): the words are the kind\'s name alone', () => {
    const words = blockerWordsOf(asked('a-artwork'), kinds)
    expect(words.en.split(': ')).toEqual(["Waiting for the customer's yes", 'Artwork'])
  })
})
