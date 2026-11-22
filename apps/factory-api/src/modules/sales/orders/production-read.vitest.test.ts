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
import { blockerDueOf, blockerTaskOf, revisionRefusedWords, type AskedFacts } from './production-read' // B-OC-002, B-OC-004
import type { Blocker } from '@nexus/factory-domain/production-brand/waiting'
// B-MS-006: the headline's stage block with a stage set by hand, and the export's words for it.
import { headlineStageOf, type HeadlineStageRow } from './production-read'
import { productionWords, whereText } from '../../../platform/exports/sources/sales-orders'
// B-CW-022: the export's Customer urgency and Deposit cells, and its words.
import { depositText, salesOrders, urgencyText, urgencyWords } from '../../../platform/exports/sources/sales-orders'
// B-PT-001 / B-PT-003: a work order's workshops with their days; a made-to-measure row's units.
import { MTM_UNITS_LIMIT, mtmUnitsOf, workshopsOf } from './production-read'
import { workOrderSpecOf, type SpecRevision } from './production-read' // B-PT-004
import { finalDefectsOf, NCR_TITLE_LIMIT, ncrTitleOf } from './production-read' // B-PT-008, B-PT-009
// B-PT-017: the order page's live rules and parts.
import { ORDER_LIVE_EVENTS } from './views'
import { ORDER_PAGE_PARTS } from './contract'

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

  // B-PT-018: the issues are the ONE issues list's (GET /production/issues), no block of this read any more.
  it('the Sales template (orders.view, no workorders.view, no planning.promise.view): work, people, the office notes, NCRs, final and forecast withheld', () => {
    expect(withheldOf(['headline', 'lines', 'work', 'dates', 'quality', 'people', 'changes'], holding('orders.view'))).toEqual([
      'work',
      'people',
      'headline.notes',
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

// ── B-MS-006 ──
describe('B-MS-006: the headline reads the stage set by hand (who and the note behind the notes gate) and the row’s version', () => {
  const SET_AT = new Date('2026-11-18T09:30:00.000Z')
  const stored = (over: Partial<HeadlineStageRow> = {}): HeadlineStageRow => ({
    stage: 'SEWING',
    stageAt: SET_AT,
    stageSet: 'SEWING',
    stageSetReason: 'OUTAGE',
    stageSetNote: 'Made-up: the tablets were down all morning.',
    stageSetAt: SET_AT,
    version: 4,
    ...over,
  })
  const floor = { stage: 'PREPARING' as const, ahead: 0, next: 'CUTTING' as const, sewingNotCounted: false }
  const planner = { id: ALPHA, name: 'Made-up Planner', active: true }

  it('a hand Sewing over a floor at Preparing: the stage the customer reads, why, the floor’s own stage, when, the note and who; the version', () => {
    expect(headlineStageOf({ row: stored(), live: floor, partlyShipped: false, notes: true, setBy: planner })).toEqual({
      code: 'SEWING',
      words: { it: 'Cucitura', en: 'Sewing' },
      since: '2026-11-18',
      ahead: 0,
      aheadWords: null,
      sewingNotCounted: false,
      sewingNotCountedWords: null,
      next: { code: 'QUALITY', words: { it: 'Controllo qualità', en: 'Quality check' } },
      partlyShipped: false,
      byHand: { stage: 'SEWING', reasonCode: 'OUTAGE', floor: { code: 'PREPARING', words: { it: 'In preparazione', en: 'Preparing' } }, floorAtSet: null, at: '2026-11-18T09:30:00.000Z', note: 'Made-up: the tablets were down all morning.', by: planner, notice: null },
      version: 4,
    })
  })

  // B-SC-004 (stage control B): the floor's stage when it was set or changed (keeper readHandFloor), office only like the rest.
  it('B-SC-004: byHand.floorAtSet — a stage set back below the floor says where the floor stood at the set; none: null', () => {
    const back = headlineStageOf({ row: stored({ stage: 'SEWING', stageSet: 'SEWING' }), live: { stage: 'QUALITY', ahead: 0, next: 'READY', sewingNotCounted: false }, partlyShipped: false, notes: false, setBy: null, floorAtSet: 'QUALITY' })
    expect(back?.code).toBe('SEWING')
    expect(back?.byHand).toMatchObject({ stage: 'SEWING', floor: { code: 'QUALITY' }, floorAtSet: 'QUALITY', note: null, by: null })
    expect(headlineStageOf({ row: stored(), live: floor, partlyShipped: false, notes: true, setBy: null, floorAtSet: null })?.byHand?.floorAtSet).toBeNull()
    // Ready to ship and Preparing by hand are read as any other stage.
    expect(headlineStageOf({ row: stored({ stage: 'READY', stageSet: 'READY' }), live: floor, partlyShipped: false, notes: true, setBy: null, floorAtSet: 'PREPARING' })).toMatchObject({ code: 'READY', next: null, byHand: { stage: 'READY', floorAtSet: 'PREPARING' } })
    expect(headlineStageOf({ row: stored({ stage: 'PREPARING', stageSet: 'PREPARING' }), live: { stage: 'CUTTING', ahead: 0, next: 'SEWING', sewingNotCounted: false }, partlyShipped: false, notes: true, setBy: null, floorAtSet: 'CUTTING' })).toMatchObject({ code: 'PREPARING', byHand: { stage: 'PREPARING', floor: { code: 'CUTTING' }, floorAtSet: 'CUTTING' } })
  })

  it('without workorders.view (the notes gate): why, the floor and when stay; the note and who are null', () => {
    expect(headlineStageOf({ row: stored(), live: floor, partlyShipped: false, notes: false, setBy: planner })?.byHand).toEqual({ stage: 'SEWING', reasonCode: 'OUTAGE', floor: { code: 'PREPARING', words: { it: 'In preparazione', en: 'Preparing' } }, floorAtSet: null, at: '2026-11-18T09:30:00.000Z', note: null, by: null, notice: null })
  })

  // B-MS-008 (ms-fx1; Z01 note 2): what Clear… says comes from the keeper's markers (keeper readHandNotice), never the set's time.
  it('B-MS-008 (ms-fx1): the notice of the stage set by hand — told, when it goes, or never — behind no gate (no person, no note)', () => {
    const notice = (value: { told: boolean; waitsUntil: Date | null } | null, notes = false) => headlineStageOf({ row: stored(), live: floor, partlyShipped: false, notes, setBy: planner, notice: value })?.byHand?.notice
    expect(notice({ told: true, waitsUntil: null })).toEqual({ told: true, waitsUntil: null })
    expect(notice({ told: false, waitsUntil: new Date('2026-11-18T09:40:00.000Z') })).toEqual({ told: false, waitsUntil: '2026-11-18T09:40:00.000Z' })
    expect(notice({ told: false, waitsUntil: null }, true)).toEqual({ told: false, waitsUntil: null })
    expect(notice(null)).toBeNull()
    // No hand stage: no notice is read or said.
    expect(headlineStageOf({ row: stored({ stageSet: null, stageSetReason: null, stageSetNote: null, stageSetAt: null }), live: floor, partlyShipped: false, notes: true, setBy: null, notice: { told: true, waitsUntil: null } })?.byHand).toBeNull()
  })

  it('no hand stage: byHand null, the version of the row; ahead and "sewing not counted" from live facts that agree', () => {
    const plain = headlineStageOf({ row: stored({ stage: 'CUTTING', stageSet: null, stageSetReason: null, stageSetNote: null, stageSetAt: null }), live: { stage: 'CUTTING', ahead: 1, next: 'SEWING', sewingNotCounted: true }, partlyShipped: true, notes: true, setBy: null })
    expect(plain).toMatchObject({ code: 'CUTTING', ahead: 1, sewingNotCounted: true, partlyShipped: true, byHand: null, version: 4 })
    // Under a hand stage the live facts never agree: "1 line ahead" and "sewing not counted" vanish.
    expect(headlineStageOf({ row: stored(), live: { stage: 'CUTTING', ahead: 1, next: 'SEWING', sewingNotCounted: true }, partlyShipped: false, notes: true, setBy: null })).toMatchObject({ ahead: 0, sewingNotCounted: false, byHand: { floor: { code: 'CUTTING' } } })
  })

  it('no row yet: the live stage, no since, no hand stage, version null (a set by hand then sends null and makes the row); nothing at all: null', () => {
    expect(headlineStageOf({ row: null, live: floor, partlyShipped: false, notes: true, setBy: null })).toMatchObject({ code: 'PREPARING', since: null, byHand: null, version: null })
    expect(headlineStageOf({ row: null, live: null, partlyShipped: false, notes: true, setBy: null })).toBeNull()
  })

  it("the export's Where it is cell: \"Sewing (by hand) · At risk\" (en + it) only while a hand stage stands", () => {
    type Production = NonNullable<Parameters<typeof whereText>[0]['production']>
    const row = (stageByHand: Production['stageByHand']) => ({ production: { stage: 'SEWING', health: 'AT_RISK', stageByHand } as unknown as Production })
    const en = (code: string) => productionWords('en')[code] ?? code
    const it = (code: string) => productionWords('it')[code] ?? code
    expect(whereText(row({ since: '2026-11-18T09:30:00.000Z' }), en)).toBe('Sewing (by hand) · At risk')
    expect(whereText(row({ since: '2026-11-18T09:30:00.000Z' }), it)).toBe('Cucitura (a mano) · A rischio')
    expect(whereText(row(null), en)).toBe('Sewing · At risk')
    expect(whereText({ production: undefined }, en)).toBeNull()
  })
})
// ── end B-MS-006 ──

// ── B-CW-022 (customer Work tab plan §2.8): the Orders file says what the row says ──
describe('B-CW-022: the export writes the urgency state with its place and an extra deposit with its due day (en + it)', () => {
  const state = (value: 'URGENT' | 'ASKED' | 'REGULAR' | 'SET_BACK', urgentRank: number | null = null) => ({
    customerUrgency: value === 'URGENT' ? ('URGENT' as const) : ('REGULAR' as const),
    customerUrgencyState: { state: value, urgentRank, locked: false, requestId: null },
  })
  const en = (code: string) => urgencyWords('en')[code] ?? code
  const italian = (code: string) => urgencyWords('it')[code] ?? code
  const fileWords = (locale: 'en' | 'it') => (code: string) => salesOrders.words?.[locale][code] ?? code

  it('Customer urgency: the four states in the Work orders file\'s words; an Urgent row adds its place; "Urgente" alone is never written', () => {
    expect(urgencyText(state('URGENT', 2), en)).toBe('Urgent (customer) 2')
    expect(urgencyText(state('URGENT', 2), italian)).toBe('Urgente (cliente) 2')
    expect(urgencyText(state('URGENT'), en)).toBe('Urgent (customer)')
    expect(urgencyText(state('ASKED'), en)).toBe('Urgent – asked')
    expect(urgencyText(state('ASKED'), italian)).toBe('Urgente – richiesto')
    expect(urgencyText(state('SET_BACK'), en)).toBe('Set to Regular by us')
    expect(urgencyText(state('SET_BACK'), italian)).toBe('Riportato a normale da noi')
    expect(urgencyText(state('REGULAR'), en)).toBe('Regular')
    expect(urgencyText(state('REGULAR'), italian)).toBe('Normale')
    // A place is written only for Urgent.
    expect(urgencyText(state('REGULAR', 3), en)).toBe('Regular')
    // A mark and no state (a reader without states): the mark's word; none: an empty cell.
    expect(urgencyText({ customerUrgency: 'URGENT', customerUrgencyState: null }, italian)).toBe('Urgente (cliente)')
    expect(urgencyText({ customerUrgency: null, customerUrgencyState: null }, en)).toBeNull()
    // The file's own catalogue holds these words in both languages.
    expect(urgencyText(state('URGENT', 1), fileWords('it'))).toBe('Urgente (cliente) 1')
    expect(urgencyText(state('SET_BACK'), fileWords('en'))).toBe('Set to Regular by us')
  })

  it('Deposit: an extra deposit still open on an order that needs none reads the order page\'s words with its due day; else the state\'s word', () => {
    const extra = { deposit: { state: 'NOT_NEEDED' as const, dueDate: '2026-12-02', extraOpenDue: '2026-12-02' } }
    expect(depositText(extra, fileWords('en'))).toBe('Not needed · an extra deposit is open, due 2026-12-02')
    expect(depositText(extra, fileWords('it'))).toBe('Non serve · è aperto un acconto aggiuntivo, scade il 2026-12-02')
    expect(depositText({ deposit: { state: 'NOT_NEEDED' as const, dueDate: null, extraOpenDue: null } }, fileWords('en'))).toBe('Not needed')
    expect(depositText({ deposit: { state: 'OPEN' as const, dueDate: '2026-12-02', extraOpenDue: null } }, fileWords('it'))).toBe('Aperto')
  })
})
// ── end B-CW-022 ──

// ── B-PT-001 / B-PT-003 (order production tab R1, R3) ──
describe('B-PT-001: the outside workshops of a work order, with the day it went and the day it comes back', () => {
  const names = new Map([
    ['p-1', 'Made-up Stitching Lab'],
    ['p-2', 'Made-up Embroidery Lab'],
  ])
  const job = (partyId: string, issuedAt: string | null, back: string | null) => ({ partyId, issuedAt: issuedAt ? new Date(issuedAt) : null, expectedBackDate: back ? new Date(`${back}T00:00:00.000Z`) : null })

  it('each workshop once, in the order met: since its first job was issued, back on its latest expected day', () => {
    const jobs = [job('p-1', '2026-11-14T09:00:00.000Z', '2026-12-01'), job('p-2', null, null), job('p-1', '2026-11-12T09:00:00.000Z', '2026-12-04')]
    expect(workshopsOf(jobs, names, false)).toEqual([
      { name: 'Made-up Stitching Lab', since: '2026-11-12', expectedBack: '2026-12-04' },
      { name: 'Made-up Embroidery Lab', since: null, expectedBack: null },
    ])
  })

  it('a work order shared with other customers: the names only, as before (no day)', () => {
    expect(workshopsOf([job('p-1', '2026-11-12T09:00:00.000Z', '2026-12-04')], names, true)).toEqual([{ name: 'Made-up Stitching Lab', since: null, expectedBack: null }])
    expect(workshopsOf([], names, false)).toEqual([])
  })
})

describe('B-PT-003: a made-to-measure row lists its units by number, at most 50, the rest counted', () => {
  const unit = (n: number) => ({ id: `id-${n}`, number: `T-MTM-${n}`, status: 'DRAFT', lineSeq: n * 10 })

  it('three units: all three, in number order (9 before 10)', () => {
    const { unitList, unitsMore } = mtmUnitsOf([unit(10), unit(9), unit(11)])
    expect(unitList.map((row) => row.number)).toEqual(['T-MTM-9', 'T-MTM-10', 'T-MTM-11'])
    expect(unitsMore).toBe(0)
  })

  it('sixty units: the first 50 by number, 10 more counted (never listed)', () => {
    const { unitList, unitsMore } = mtmUnitsOf(Array.from({ length: 60 }, (_, index) => unit(60 - index)))
    expect(MTM_UNITS_LIMIT).toBe(50)
    expect(unitList).toHaveLength(50)
    expect(unitList[0]!.number).toBe('T-MTM-1')
    expect(unitList[49]!.number).toBe('T-MTM-50')
    expect(unitsMore).toBe(10)
    expect(mtmUnitsOf([])).toEqual({ unitList: [], unitsMore: 0 })
  })
})
// ── end B-PT-001 / B-PT-003 ──

// ── B-PT-004 (order production tab R4) ──
describe('B-PT-004: the spec a work order is made to, by the domain rule; the screen\'s words come from the state, never the English message', () => {
  const revision = (n: number, status: string, releasedAt: string | null = null): SpecRevision => ({ id: `rev-${n}`, styleId: 'style-1', revision: n, status, releasedAt: releasedAt ? new Date(releasedAt) : null })

  it('made to the revision in force: CURRENT, no newer, no decision', () => {
    expect(workOrderSpecOf(revision(2, 'RELEASED'), revision(2, 'RELEASED'), null)).toEqual({ revision: { revision: 2, status: 'RELEASED' }, state: 'CURRENT', newer: null, decision: null })
  })

  it('a newer revision is released: NEWER_RELEASED with its number and day; a change order’s decision only then', () => {
    const newer = revision(3, 'RELEASED', '2026-11-12T10:00:00.000Z')
    expect(workOrderSpecOf(revision(2, 'OBSOLETE'), newer, null)).toEqual({ revision: { revision: 2, status: 'OBSOLETE' }, state: 'NEWER_RELEASED', newer: { revision: 3, releasedOn: '2026-11-12' }, decision: null })
    const decided = workOrderSpecOf(revision(2, 'OBSOLETE'), newer, { disposition: 'FINISH_OLD', changeOrder: 'ECO-T-1' })
    expect(decided.decision).toEqual({ disposition: 'FINISH_OLD', changeOrder: 'ECO-T-1' })
    // A decision of a work order on the spec in force says nothing.
    expect(workOrderSpecOf(newer, newer, { disposition: 'REWORK', changeOrder: 'ECO-T-2' }).decision).toBeNull()
  })

  it('a draft revision: NOT_RELEASED; none chosen: NO_REVISION; withdrawn with nothing in force: WITHDRAWN — never a message', () => {
    expect(workOrderSpecOf(revision(4, 'DRAFT'), revision(3, 'RELEASED'), null)).toMatchObject({ state: 'NOT_RELEASED', newer: null })
    expect(workOrderSpecOf(null, revision(3, 'RELEASED'), null)).toEqual({ revision: null, state: 'NO_REVISION', newer: null, decision: null })
    expect(workOrderSpecOf(revision(2, 'OBSOLETE'), null, null)).toMatchObject({ state: 'WITHDRAWN', newer: null })
    expect(Object.keys(workOrderSpecOf(null, null, null)).sort()).toEqual(['decision', 'newer', 'revision', 'state'])
  })
})
// ── end B-PT-004 ──

// ── B-PT-008 / B-PT-009 (order production tab R8, R9) ──
describe('B-PT-008: a final check says its garments with a defect per class; nothing while it is open', () => {
  it('sums the defect rows per class (the domain rule); an unknown class is left out', () => {
    expect(finalDefectsOf('FAILED', [{ defectClass: 'MAJOR', quantity: 2 }, { defectClass: 'MINOR', quantity: 1 }, { defectClass: 'MAJOR', quantity: 1 }, { defectClass: 'COSMETIC', quantity: 9 }])).toEqual({ critical: 0, major: 3, minor: 1 })
    expect(finalDefectsOf('PASSED', [])).toEqual({ critical: 0, major: 0, minor: 0 })
  })

  it('an OPEN check: null (never a made-up 0)', () => {
    expect(finalDefectsOf('OPEN', [{ defectClass: 'CRITICAL', quantity: 1 }])).toBeNull()
  })
})

describe('B-PT-009: an NCR title is at most 80 characters, cut with "…"', () => {
  it('a short title stays (trimmed); a long one is cut to 80 with the ellipsis', () => {
    expect(ncrTitleOf('  Made-up: seam open on the left sleeve  ')).toBe('Made-up: seam open on the left sleeve')
    const long = `Made-up: ${'x'.repeat(120)}`
    expect(NCR_TITLE_LIMIT).toBe(80)
    expect(Array.from(ncrTitleOf(long))).toHaveLength(80)
    expect(ncrTitleOf(long).endsWith('…')).toBe(true)
    expect(ncrTitleOf('y'.repeat(80))).toBe('y'.repeat(80))
  })
})
// ── end B-PT-008 / B-PT-009 ──

// ── B-PT-017 (order production tab C3) ──
describe('B-PT-017: the order page re-reads the Production tab’s dates, headline and materials on the events that move them', () => {
  const partsOf = (type: string) => ORDER_LIVE_EVENTS.find((entry) => entry.type === type)?.parts ?? []

  it('a promise moved: + dates and headline (beside the order, its lines and changes)', () => {
    expect(partsOf('sales_order.promise_changed')).toEqual(expect.arrayContaining(['order', 'lines', 'changes', 'dates', 'headline']))
  })

  it('a work order made, changed or moved on: + dates (its forecast); a floor scan does not re-read the dates', () => {
    for (const type of ['workorder.created', 'workorder.changed', 'workorder.status_changed']) expect(partsOf(type), type).toEqual(expect.arrayContaining(['work', 'headline', 'people', 'dates']))
    expect(partsOf('production.scan_recorded')).not.toContain('dates')
  })

  it('the customer’s own materials planned or counted again: the new materials part alone', () => {
    expect(ORDER_PAGE_PARTS).toContain('materials')
    expect(partsOf('customer_material.changed')).toEqual(['materials'])
  })
})
// ── end B-PT-017 ──

// ── B-OC-008 (order changes tab R4d; 13-backend §3) ──
describe('B-OC-008: the order page re-reads the Changes tab’s Waiting and Still to do on the events that move them', () => {
  const partsOf = (type: string) => ORDER_LIVE_EVENTS.find((entry) => entry.type === type)?.parts ?? []

  it('every approval_request event (asked, answered, withdrawn, expired, decided for the party, put back): the order, the headline and the changes', () => {
    for (const type of ['approval_request.asked', 'approval_request.answered', 'approval_request.withdrawn', 'approval_request.expired', 'approval_request.decided_for_party', 'approval_request.reversed']) {
      expect(partsOf(type), type).toEqual(['order', 'headline', 'changes'])
    }
  })

  it('a production task done or changed, a scrap posted or decided, a style change moved on: the changes (Still to do)', () => {
    for (const type of ['task.completed', 'task.changed', 'production.scrap_posted', 'production.scrap_over_limit_decided', 'change_request.changed']) expect(partsOf(type), type).toEqual(['changes'])
    // A task made or handed to someone moves no row of the order (Home's own lists follow those).
    expect(partsOf('task.created')).toEqual([])
    expect(partsOf('task.assigned')).toEqual([])
  })
})
// ── end B-OC-008 ──

// ── B-OC-002 / B-OC-004 (order changes tab R2, R3b; L11) ──
describe('B-OC-002 / B-OC-004: a refused revision by its number; when an approval or a portal task is due, and what a task asks', () => {
  const kinds = new Map([['a-revised', 'REVISED_ORDER' as const]])
  const at = new Date('2026-11-26T10:00:00.000Z')
  const tasks: AskedFacts['tasks'] = new Map<string, { kind: 'RECONFIRM_ORDER' | 'ANSWER_MESSAGE'; label: string; dueAt: Date | null }>([
    ['t-1', { kind: 'RECONFIRM_ORDER', label: 'SEED-SO-0002', dueAt: at }],
    ['t-2', { kind: 'ANSWER_MESSAGE', label: 'SEED-SO-0002', dueAt: null }],
  ])
  const asked: Pick<AskedFacts, 'approvalDue' | 'tasks'> = { approvalDue: new Map<string, Date>([['a-revised', at], ['r-counter', new Date('2026-11-25T10:00:00.000Z')]]), tasks }

  it('a revised order asked of the customer names its kind; a revision it said no to names its number (EN + IT), never an amount', () => {
    expect(blockerWordsOf({ kind: 'APPROVAL', ref: { type: 'ApprovalRequest', id: 'a-revised' } }, kinds)).toEqual({ en: "Waiting for the customer's yes: Revised order", it: 'In attesa del sì del cliente: Ordine modificato' })
    const refused = { kind: 'REVISION_REFUSED' as const, ref: { type: 'SalesOrderAmendment', id: 'am-2' } }
    expect(blockerWordsOf(refused, kinds, new Map([['am-2', 2]]))).toEqual(revisionRefusedWords(2))
    expect(revisionRefusedWords(2)).toEqual({ en: 'The customer said no to revision 2 · decide: restore or change again', it: 'Il cliente ha detto no alla revisione 2 · decidi: ripristina o cambia di nuovo' })
    // Its number not read: the plain words (no number made up).
    expect(blockerWordsOf(refused, kinds)).toEqual(BLOCKER_WORDS.REVISION_REFUSED)
  })

  it('due: an approval we asked and an open counter-offer (by its request), a portal task; null for every other kind and with no record', () => {
    expect(blockerDueOf({ kind: 'APPROVAL', ref: { type: 'ApprovalRequest', id: 'a-revised' } }, asked)).toEqual(at)
    expect(blockerDueOf({ kind: 'APPROVAL', ref: { type: 'OrderChangeRequest', id: 'r-counter' } }, asked)).toEqual(new Date('2026-11-25T10:00:00.000Z'))
    expect(blockerDueOf({ kind: 'PARTNER_TASK', ref: { type: 'PartnerTask', id: 't-1' } }, asked)).toEqual(at)
    expect(blockerDueOf({ kind: 'PARTNER_TASK', ref: { type: 'PartnerTask', id: 't-2' } }, asked)).toBeNull()
    expect(blockerDueOf({ kind: 'APPROVAL', ref: null }, asked)).toBeNull()
    for (const kind of BLOCKER_KINDS.filter((entry) => entry !== 'APPROVAL' && entry !== 'PARTNER_TASK')) expect(blockerDueOf({ kind, ref: { type: 'ApprovalRequest', id: 'a-revised' } }, asked), kind).toBeNull()
  })

  it('task: a portal task says its kind and label (never who it is assigned to); every other kind: null', () => {
    expect(blockerTaskOf({ kind: 'PARTNER_TASK', ref: { type: 'PartnerTask', id: 't-1' } }, asked)).toEqual({ kind: 'RECONFIRM_ORDER', label: 'SEED-SO-0002' })
    expect(blockerTaskOf({ kind: 'PARTNER_TASK', ref: { type: 'PartnerTask', id: 'unknown' } }, asked)).toBeNull()
    expect(blockerTaskOf({ kind: 'APPROVAL', ref: { type: 'PartnerTask', id: 't-1' } }, asked)).toBeNull()
  })
})
// ── end B-OC-002 / B-OC-004 ──

// ── B-OM-008 (order money tab P1-B3, M6-B6; 13-backend §1) ──
describe('B-OM-008: the order page re-reads Money on the order settled or not, a refund of its credit notes, a cost on its work orders', () => {
  const partsOf = (type: string) => ORDER_LIVE_EVENTS.find((entry) => entry.type === type)?.parts ?? []

  it('the order settled, or not any more: money', () => {
    for (const type of ['order.fully_settled', 'order.unsettled']) expect(partsOf(type), type).toEqual(['money'])
  })

  it('every refund event and a cost posted or reversed on a work order: money (a cost also moves the work, as before)', () => {
    for (const type of ['refund.recorded', 'refund.changed', 'refund.paid', 'refund.cancelled', 'refund.voided']) expect(partsOf(type), type).toEqual(['money'])
    for (const type of ['work_order_cost.posted', 'work_order_cost.reversed']) expect(partsOf(type), type).toContain('money')
    // payment.written_off was in the payment. prefix already.
    expect(partsOf('payment.written_off')).toEqual(expect.arrayContaining(['money', 'shipments']))
  })

  // B-OM-020, B-OM-021 (S3): the margin changed by hand, and the customer's prices (or an accepted difference).
  it('the margin changed by hand: money; the customer’s prices: money as well as order, lines and changes', () => {
    expect(partsOf('order_margin.changed')).toEqual(['money'])
    expect(partsOf('sales_order.brand_price_changed')).toEqual(expect.arrayContaining(['order', 'lines', 'changes', 'money']))
  })
})
// ── end B-OM-008 ──

// ---- B-OF-004 (order files tab, PR S3.2): what re-reads the Files tab ---------------------------------------------------------------
describe('B-OF-004: a document deleted, a share changed, a price mark and every ask event re-read Files', () => {
  const filesOf = (type: string) => ORDER_LIVE_EVENTS.find((entry) => entry.type === type)?.parts ?? []
  it('lists each with the files part', () => {
    for (const type of ['file.available', 'file.removed', 'file.visibility_changed', 'file.priced_changed', 'file_ask.asked', 'file_ask.arrived', 'file_ask.decided', 'file_ask.changed']) expect(filesOf(type), type).toContain('files')
  })
})
// ---- end B-OF-004
