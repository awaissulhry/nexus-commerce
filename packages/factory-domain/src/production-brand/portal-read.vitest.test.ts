import { describe, expect, it } from 'vitest'
import { GATE_KINDS } from '../planning/milestones/rules'
import {
  answeredInOf,
  BRAND_GATE_KINDS,
  brandGateStateOf,
  countWords,
  forbiddenKeysIn,
  GATE_WORDS,
  gateOrder,
  isBrandGate,
  nextMilestoneOf,
  plannedDatesOf,
  problemStateOf,
  problemWords,
  swatchStateOf,
  swatchWords,
  type BrandGate,
  type ReportedProblem,
} from './portal-read'

/**
 * B-PR-18: what a customer reads of its orders in production beyond the stage, health, waiting and urgency rules (production plan
 * §4, 06-tree §0.5; R-42, R-43, R-65; Owner P3). Pure.
 */

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const order = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const at = (iso: string) => new Date(iso)

describe('the gates a customer reads', () => {
  it('lists the real gate kinds (PP sample, size set, sample approved, leather, trims, lab) and never OTHER', () => {
    expect([...BRAND_GATE_KINDS]).toEqual(['PP_SAMPLE', 'SIZE_SET', 'SAMPLE_APPROVED', 'LEATHER_APPROVED', 'TRIMS_IN', 'LAB_PASSED'])
    expect(isBrandGate('OTHER')).toBe(false)
    // Every planning gate kind but OTHER reaches the customer; SIZE_SET comes with B-PR-23's schema wave.
    for (const kind of GATE_KINDS) expect(isBrandGate(kind)).toBe(kind !== 'OTHER')
    for (const kind of BRAND_GATE_KINDS) expect(GATE_WORDS[kind].it.length > 0 && GATE_WORDS[kind].en.length > 0).toBe(true)
  })

  it('waits on you while its sample round waits for your answer, else on us; passed wins over started before', () => {
    expect(brandGateStateOf({ passedAt: null, overriddenAt: null, waitsOnYou: true })).toBe('WAITING_YOU')
    expect(brandGateStateOf({ passedAt: null, overriddenAt: null, waitsOnYou: false })).toBe('WAITING_US')
    expect(brandGateStateOf({ passedAt: null, overriddenAt: at('2026-11-10T09:00:00Z'), waitsOnYou: true })).toBe('STARTED_BEFORE')
    expect(brandGateStateOf({ passedAt: at('2026-11-11T09:00:00Z'), overriddenAt: at('2026-11-10T09:00:00Z'), waitsOnYou: false })).toBe('PASSED')
  })

  it('reads them by target day (none last), then by kind', () => {
    const gate = (kind: BrandGate['kind'], targetDate: string | null): BrandGate => ({ kind, state: 'WAITING_US', targetDate, doneOn: null })
    const sorted = [gate('LAB_PASSED', null), gate('TRIMS_IN', '2026-11-20'), gate('PP_SAMPLE', '2026-11-20'), gate('SIZE_SET', '2026-11-18')].sort(gateOrder)
    expect(sorted.map((entry) => entry.kind)).toEqual(['SIZE_SET', 'PP_SAMPLE', 'TRIMS_IN', 'LAB_PASSED'])
  })
})

describe('swatch answers are approvals, not gates', () => {
  it('reads the decision, else waits on you while the approval is open, else nothing', () => {
    expect(swatchStateOf({ decision: 'APPROVED', requestStatus: null })).toBe('APPROVED')
    expect(swatchStateOf({ decision: 'APPROVED_WITH_COMMENTS', requestStatus: 'APPROVED_WITH_CHANGES' })).toBe('APPROVED_WITH_COMMENTS')
    expect(swatchStateOf({ decision: 'REJECTED', requestStatus: 'REFUSED' })).toBe('REFUSED')
    expect(swatchStateOf({ decision: null, requestStatus: 'OPEN' })).toBe('WAITING_YOU')
    expect(swatchStateOf({ decision: null, requestStatus: 'WITHDRAWN' })).toBeNull()
    expect(swatchStateOf({ decision: null, requestStatus: null })).toBeNull()
  })

  it('words colour, leather, fabric and trims (and any later kind as a material swatch)', () => {
    expect(swatchWords('COLOUR')).toEqual({ it: 'Colore', en: 'Colour' })
    expect(swatchWords('TRIM').en).toBe('Trims')
    expect(swatchWords('SOMETHING_NEW')).toEqual({ it: 'Campione di materiale', en: 'Material swatch' })
  })
})

describe('the published plan’s dates (Owner P3)', () => {
  it('the first cutting start, the first sewing start and the last end, days only', () => {
    expect(
      plannedDatesOf([
        { centre: 'SEWING', start: '2026-11-24', end: '2026-11-26' },
        { centre: 'CUTTING', start: '2026-11-20', end: '2026-11-21' },
        { centre: 'CUTTING', start: '2026-11-19', end: '2026-11-19' },
        { centre: null, start: '2026-11-18', end: '2026-11-28' },
      ]),
    ).toEqual({ cutStart: '2026-11-19', sewStart: '2026-11-24', finish: '2026-11-28' })
    expect(plannedDatesOf([])).toEqual({ cutStart: null, sewStart: null, finish: null })
  })
})

describe('the next milestone of a list row, by level (06-tree §0.5)', () => {
  const counts = { ordered: 40, cut: 40, sewn: 32, inspected: 0, packed: 0 }
  const gates: BrandGate[] = [
    { kind: 'LAB_PASSED', state: 'WAITING_US', targetDate: '2026-11-25', doneOn: null },
    { kind: 'PP_SAMPLE', state: 'PASSED', targetDate: '2026-11-10', doneOn: '2026-11-09' },
    { kind: 'TRIMS_IN', state: 'WAITING_YOU', targetDate: '2026-11-21', doneOn: null },
  ]
  const planned = { cutStart: '2026-11-19', sewStart: '2026-11-24', finish: '2026-11-28' }

  it('Status only: the next stage word, no count, no date — whatever the API was given', () => {
    expect(nextMilestoneOf({ level: 'STATUS', stage: 'SEWING', counts, gates, planned })).toEqual({ next: { kind: 'STAGE', stage: 'QUALITY', date: null, words: { it: 'Controllo qualità', en: 'Quality check' } }, count: null })
  })

  it('+ Progress: adds "32 of 40 sewn"', () => {
    const read = nextMilestoneOf({ level: 'PROGRESS', stage: 'SEWING', counts, gates, planned })
    expect(read.count).toEqual({ done: 32, of: 40, words: { it: '32 di 40 cuciti', en: '32 of 40 sewn' } })
    expect(read.next).toMatchObject({ kind: 'STAGE', stage: 'QUALITY', date: null })
    expect(countWords('inspected', 3, 10).en).toBe('3 of 10 checked')
  })

  it('+ Gates & dates: the next waiting gate with its day, else the next stage with its planned start', () => {
    expect(nextMilestoneOf({ level: 'GATES', stage: 'PREPARING', counts: null, gates, planned }).next).toEqual({ kind: 'GATE', gate: 'TRIMS_IN', date: '2026-11-21', words: GATE_WORDS.TRIMS_IN })
    expect(nextMilestoneOf({ level: 'GATES', stage: 'PREPARING', counts: null, gates: [], planned }).next).toMatchObject({ kind: 'STAGE', stage: 'CUTTING', date: '2026-11-19' })
    expect(nextMilestoneOf({ level: 'QUALITY', stage: 'CUTTING', counts, gates: [], planned }).next).toMatchObject({ kind: 'STAGE', stage: 'SEWING', date: '2026-11-24' })
    expect(nextMilestoneOf({ level: 'GATES', stage: 'CUTTING', counts, gates: [], planned: null }).next).toMatchObject({ kind: 'STAGE', stage: 'SEWING', date: null })
  })

  it('nothing after Ready to ship, and nothing for an order that left production', () => {
    expect(nextMilestoneOf({ level: 'GATES', stage: 'READY', counts, gates: [], planned }).next).toBeNull()
    expect(nextMilestoneOf({ level: 'PROGRESS', stage: null, counts, gates, planned })).toEqual({ next: null, count: null })
  })
})

describe('the problems a customer reported (R-42, R-43)', () => {
  const problem = (over: Partial<ReportedProblem>): ReportedProblem => ({ orderId: order(1), partyId: B, status: 'OPEN', raisedAt: at('2026-11-16T09:00:00Z'), answeredAt: null, answeredInOrderId: null, ...over })

  it('waits on us since the oldest open one, until we write in the order’s thread', () => {
    const state = problemStateOf(order(1), B, [problem({ raisedAt: at('2026-11-16T09:00:00Z') }), problem({ raisedAt: at('2026-11-15T10:00:00Z') }), problem({ orderId: order(2) })])
    expect(state).toEqual({ state: 'WAITING_ON_US', since: '2026-11-15' })
    expect(problemWords(state!)).toEqual({ it: 'In attesa di una nostra risposta dal 15 nov', en: 'Waiting on us since 15 Nov' })
  })

  it('reads "Answered" when the answer is in its own thread, "Answered in your order N" when it is in another order of its batch', () => {
    const answeredHere = problemStateOf(order(1), B, [problem({ status: 'ANSWERED', answeredAt: at('2026-11-17T08:00:00Z'), answeredInOrderId: order(1) })])
    expect(answeredHere).toEqual({ state: 'ANSWERED', on: '2026-11-17' })
    expect(problemWords(answeredHere!).en).toBe('Answered 17 Nov')
    const elsewhere = problemStateOf(order(1), B, [problem({ status: 'ANSWERED', answeredAt: at('2026-11-17T08:00:00Z'), answeredInOrderId: order(2) })])
    expect(elsewhere).toEqual({ state: 'ANSWERED_IN', on: '2026-11-17', orderId: order(2) })
    // fix-pr-5 (lead decision): the customer's own number of that order (as the bell), else its PO, else the day; never SO-….
    expect(problemWords(elsewhere!, { seq: 13, customerRef: 'BETA-PO-0013' })).toEqual({ it: 'Risposto nel vostro ordine 13', en: 'Answered in your order 13' })
    expect(problemWords(elsewhere!, { seq: null, customerRef: 'BETA-PO-0013' })).toEqual({ it: 'Risposto in BETA-PO-0013', en: 'Answered in BETA-PO-0013' })
    expect(problemWords(elsewhere!, { seq: null, customerRef: '  ' })).toEqual({ it: 'Risposto il 17 nov', en: 'Answered 17 Nov' })
    expect(problemWords(elsewhere!)).toEqual({ it: 'Risposto il 17 nov', en: 'Answered 17 Nov' })
    expect(problemStateOf(order(1), B, [problem({ status: 'CANCELLED' })])).toBeNull()
  })

  it('throws on a problem of another customer (the wall)', () => {
    expect(() => problemStateOf(order(1), B, [problem({ partyId: A })])).toThrow(/another customer/)
  })

  it('finds where the batch was answered: its own thread first, else the earliest other order of the batch, never before it was raised', () => {
    const raised = { orderId: order(1), raisedAt: at('2026-11-16T09:00:00Z'), answeredAt: at('2026-11-17T12:00:00Z') }
    const answers = new Map<string, Date[]>([
      [order(1), [at('2026-11-15T09:00:00Z')]],
      [order(2), [at('2026-11-17T11:00:00Z')]],
      [order(3), [at('2026-11-17T10:00:00Z'), at('2026-11-18T10:00:00Z')]],
    ])
    expect(answeredInOf(raised, [order(1), order(2), order(3)], answers)).toBe(order(3))
    expect(answeredInOf(raised, [order(1), order(2)], answers)).toBe(order(2))
    expect(answeredInOf({ ...raised, answeredAt: at('2026-11-17T09:00:00Z') }, [order(1), order(2), order(3)], answers)).toBeNull()
    expect(answeredInOf(raised, [order(1), order(3)], new Map<string, Date[]>([...answers, [order(1), [at('2026-11-17T11:30:00Z')]]]))).toBe(order(1))
  })
})

describe('the wall: keys a customer read never holds (PW-15, PW-P03)', () => {
  it('finds a supervisor, a note, a place, a line or a work order anywhere in an answer', () => {
    expect(forbiddenKeysIn({ items: [{ id: 'x', health: { code: 'AT_RISK', note: 'office words' } }], urgentUse: { used: 1 } })).toEqual(['/items/0/health/note'])
    expect(forbiddenKeysIn({ supervisorId: 'x', planned: { laneId: 'y', minutes: 3 }, order: { position: 4, workOrders: [] } })).toEqual(['/supervisorId', '/planned/laneId', '/planned/minutes', '/order/position', '/order/workOrders'])
    expect(forbiddenKeysIn({ stage: { code: 'SEWING' }, urgency: { urgentRank: 1 }, gates: { planned: { cutStart: '2026-11-19' } }, progress: { lines: [{ lineId: 'order line' }] } })).toEqual([])
  })
})
