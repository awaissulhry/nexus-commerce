import { describe, expect, it } from 'vitest'
import { HOLD_BRAND_WORDS_MAX, HOLD_LIFT_REASON_MAX, HOLD_NOTE_MAX } from './kinds'
import { afterHoldEnds, customerWordsOf, holdKindOfList, liftProblems, placeProblems, productionHoldMove, unholdableWords, wordsOrNull, type StandingHold } from './rules'
// B-OO-005: the order's ONE hold plan.
import { ORDER_HOLD_HELD, orderHoldHeldWords, orderHoldPlanOf, SHARED_HOLD_WORDS, type OrderHoldWorkOrder } from './rules'

/**
 * B-PR-21 — the plain production hold's rules (production plan §5 "holds (one dialog)", 08-backend §4.5, R-22): the one dialog's
 * kind, what a hold may say, which work orders take one, what the customer reads, and the one rule by which quality's release and
 * the production lift let a work order leave ON_HOLD only when no hold names it any more.
 */

const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 17, 9, minute))
const quality = (id: string, minute: number): StandingHold => ({ recordType: 'QualityHold', id, reason: `quality ${id}`, placedAt: at(minute) })
const production = (id: string, minute: number): StandingHold => ({ recordType: 'WorkOrderHold', id, reason: `production ${id}`, placedAt: at(minute) })
const held = (holdRecordType: string | null, holdRecordId: string | null) => ({ status: 'ON_HOLD', holdRecordType, holdRecordId })

describe('the one "Put on hold" dialog: the list of the picked reason decides the kind', () => {
  it('a HOLD reason is a quality hold, a PRODUCTION_HOLD reason a production hold, any other list none', () => {
    expect(holdKindOfList('HOLD')).toBe('QUALITY')
    expect(holdKindOfList('PRODUCTION_HOLD')).toBe('PRODUCTION')
    expect(holdKindOfList('PAUSE')).toBeNull()
    expect(holdKindOfList('')).toBeNull()
  })
})

describe('placing: what a production hold may say', () => {
  it('a code of the list, the office note up to its limit, the customer’s words in one line', () => {
    expect(placeProblems({ reasonCode: 'MATERIAL_MISSING' })).toEqual([])
    expect(placeProblems({ reasonCode: 'OTHER', note: 'x'.repeat(HOLD_NOTE_MAX), brandWords: 'y'.repeat(HOLD_BRAND_WORDS_MAX) })).toEqual([])
    // Blank words are words left out (the API stores null).
    expect(placeProblems({ reasonCode: 'CAPACITY', note: '  ', brandWords: '' })).toEqual([])
  })

  it('refuses in words: a code the database refuses, a note too long, the customer’s words too long or on two lines', () => {
    expect(placeProblems({ reasonCode: 'material missing' }).map((problem) => problem.path)).toEqual(['reasonCode'])
    expect(placeProblems({ reasonCode: 'A'.repeat(41) }).map((problem) => problem.path)).toEqual(['reasonCode'])
    expect(placeProblems({ reasonCode: 'OTHER', note: 'x'.repeat(HOLD_NOTE_MAX + 1) })).toEqual([{ path: 'note', message: `At most ${HOLD_NOTE_MAX} characters.` }])
    expect(placeProblems({ reasonCode: 'OTHER', brandWords: 'y'.repeat(HOLD_BRAND_WORDS_MAX + 1) })).toEqual([{ path: 'brandWords', message: `At most ${HOLD_BRAND_WORDS_MAX} characters.` }])
    expect(placeProblems({ reasonCode: 'OTHER', brandWords: 'first line\nsecond line' })).toEqual([{ path: 'brandWords', message: 'One line, without line breaks.' }])
  })

  it('a lift says why, in one line', () => {
    expect(liftProblems({ reason: 'Material arrived' })).toEqual([])
    expect(liftProblems({})).toEqual([{ path: 'reason', message: 'Say why the hold is lifted.' }])
    expect(liftProblems({ reason: '   ' })).toEqual([{ path: 'reason', message: 'Say why the hold is lifted.' }])
    expect(liftProblems({ reason: 'z'.repeat(HOLD_LIFT_REASON_MAX + 1) })).toEqual([{ path: 'reason', message: `At most ${HOLD_LIFT_REASON_MAX} characters.` }])
    expect(liftProblems({ reason: 'one\ntwo' })).toEqual([{ path: 'reason', message: 'One line, without line breaks.' }])
  })

  it('words are kept trimmed, blank words not at all', () => {
    expect(wordsOrNull('  Waiting for the leather  ')).toBe('Waiting for the leather')
    expect(wordsOrNull('   ')).toBeNull()
    expect(wordsOrNull(undefined)).toBeNull()
  })
})

describe('which work orders take a production hold', () => {
  it('DRAFT, RELEASED and IN_PROGRESS go ON_HOLD; one ON_HOLD stays held; the rest are refused in words', () => {
    expect((['DRAFT', 'RELEASED', 'IN_PROGRESS'] as const).map(productionHoldMove)).toEqual(['HOLD', 'HOLD', 'HOLD'])
    expect(productionHoldMove('ON_HOLD')).toBe('ALREADY')
    expect((['COMPLETED', 'CLOSED', 'CANCELLED'] as const).map(productionHoldMove)).toEqual(['REFUSED', 'REFUSED', 'REFUSED'])
    expect(unholdableWords('WO-0142', 'RELEASED')).toBeNull()
    expect(unholdableWords('WO-0142', 'ON_HOLD')).toBeNull()
    expect(unholdableWords('WO-0142', 'COMPLETED')).toBe('Work order WO-0142 is completed: no work is left to stop. Hold its garments with a quality hold instead.')
    expect(unholdableWords('WO-0142', 'CANCELLED')).toBe('Work order WO-0142 is cancelled: nothing is left to hold.')
  })
})

describe('what the customer reads: the words meant for it, never the office’s note', () => {
  it('its own words when written, else the reason’s words', () => {
    expect(customerWordsOf({ brandWords: 'We wait for your artwork.' }, 'Open technical question')).toBe('We wait for your artwork.')
    expect(customerWordsOf({ brandWords: null }, 'Open technical question')).toBe('Open technical question')
    expect(customerWordsOf({ brandWords: '  ' }, 'Capacity')).toBe('Capacity')
  })
})

describe('after a hold ends: the work order leaves ON_HOLD only when no hold names it any more (both ways round)', () => {
  it('a quality release with a production hold still standing: it stays held, under the production hold', () => {
    const answer = afterHoldEnds({ workOrder: held('QualityHold', 'q1'), ended: { recordType: 'QualityHold', id: 'q1' }, standing: [production('p1', 5)] })
    expect(answer).toEqual({ action: 'REPOINT', to: production('p1', 5) })
  })

  it('a production lift with a quality hold still standing: it stays held, under the quality hold', () => {
    const answer = afterHoldEnds({ workOrder: held('WorkOrderHold', 'p1'), ended: { recordType: 'WorkOrderHold', id: 'p1' }, standing: [quality('q1', 9)] })
    expect(answer).toEqual({ action: 'REPOINT', to: quality('q1', 9) })
  })

  it('the oldest hold still standing becomes its record; the ended one never counts, even when passed', () => {
    const answer = afterHoldEnds({ workOrder: held('WorkOrderHold', 'p1'), ended: { recordType: 'WorkOrderHold', id: 'p1' }, standing: [production('p1', 1), quality('q2', 30), production('p3', 20)] })
    expect(answer).toEqual({ action: 'REPOINT', to: production('p3', 20) })
  })

  it('a hold that is not the work order’s record ends: it stays held under its own record', () => {
    expect(afterHoldEnds({ workOrder: held('QualityHold', 'q1'), ended: { recordType: 'WorkOrderHold', id: 'p1' }, standing: [quality('q1', 1)] })).toEqual({ action: 'STAY' })
  })

  it('no hold left: back to the status it was held from', () => {
    expect(afterHoldEnds({ workOrder: held('WorkOrderHold', 'p1'), ended: { recordType: 'WorkOrderHold', id: 'p1' }, standing: [] })).toEqual({ action: 'LIFT' })
    expect(afterHoldEnds({ workOrder: held('QualityHold', 'q1'), ended: { recordType: 'QualityHold', id: 'q1' }, standing: [quality('q1', 1)] })).toEqual({ action: 'LIFT' })
    // A record that no longer stands (a stale one) does not keep it held.
    expect(afterHoldEnds({ workOrder: held('QualityHold', 'q0'), ended: { recordType: 'WorkOrderHold', id: 'p1' }, standing: [] })).toEqual({ action: 'LIFT' })
  })

  it('a record of another kind (an NCR) lifts its own; a work order no longer held does nothing', () => {
    expect(afterHoldEnds({ workOrder: held('Nonconformance', 'n1'), ended: { recordType: 'QualityHold', id: 'q1' }, standing: [] })).toEqual({ action: 'STAY' })
    expect(afterHoldEnds({ workOrder: { status: 'RELEASED', holdRecordType: null, holdRecordId: null }, ended: { recordType: 'WorkOrderHold', id: 'p1' }, standing: [] })).toEqual({ action: 'STAY' })
  })
})

// ---- B-OO-005 (order overview N6, F13, F16): "Hold the whole order" — which work orders the one Hold dialog holds ---------------
const wo = (number: string, status: string, extra: Partial<OrderHoldWorkOrder> = {}): OrderHoldWorkOrder => ({ id: `id-${number}`, number, status, version: 3, sharedWithOtherCustomers: false, rights: { hold: true }, ...extra })

describe('B-OO-005 orderHoldPlanOf: the ONE plan of "Hold the whole order", the web imports it', () => {
  it('holds every own open work order the reader may hold, with its version; the plan is not held', () => {
    const plan = orderHoldPlanOf({ workOrders: [wo('WO-1', 'DRAFT'), wo('WO-2', 'RELEASED', { version: 7 }), wo('WO-3', 'IN_PROGRESS')] })
    expect(plan).toEqual({ ids: ['id-WO-1', 'id-WO-2', 'id-WO-3'], numbers: ['WO-1', 'WO-2', 'WO-3'], versions: { 'id-WO-1': 3, 'id-WO-2': 7, 'id-WO-3': 3 }, left: [], notReached: 0, held: null })
  })

  it('none yet: no work order is made for this order (and a cancelled one is no work)', () => {
    for (const workOrders of [[], [wo('WO-9', 'CANCELLED')]]) {
      const plan = orderHoldPlanOf({ workOrders })
      expect(plan).toMatchObject({ ids: [], left: [], held: { code: 'NONE_YET', words: { en: 'Nothing to hold yet: no work order is made for this order.', it: 'Ancora niente da fermare: nessun ordine di lavoro è stato creato per questo ordine.' } } })
    }
  })

  it('every one completed: no work is left to stop, its garments take a quality hold; each named with why', () => {
    const plan = orderHoldPlanOf({ workOrders: [wo('WO-1', 'COMPLETED'), wo('WO-2', 'CLOSED')] })
    expect(plan.ids).toEqual([])
    expect(plan.held).toEqual({ code: 'ALL_DONE', words: orderHoldHeldWords('ALL_DONE') })
    expect(plan.held!.words.en).toMatch(/quality hold/)
    expect(plan.left.map((entry) => [entry.number, entry.words.en])).toEqual([
      ['WO-1', 'Completed: no work is left to stop. Hold its garments with a quality hold instead.'],
      ['WO-2', 'Closed: nothing is left to hold.'],
    ])
  })

  it('waiting for a yes: the order waits already, nothing is in work until then', () => {
    const plan = orderHoldPlanOf({ workOrders: [wo('WO-1', 'DRAFT')], waitingForYes: true })
    expect(plan).toMatchObject({ ids: [], versions: {}, held: { code: 'WAITING_FOR_YES', words: { en: 'The order waits for a yes: nothing is in work until then.' } } })
  })

  it('F13 a shared work order is reached and NAMED, left out with "hold it on its page"; the others are held', () => {
    const shared = wo('WO-4', 'IN_PROGRESS', { sharedWithOtherCustomers: true, rights: { hold: false } })
    const plan = orderHoldPlanOf({ workOrders: [wo('WO-1', 'DRAFT'), shared] })
    expect(plan.ids).toEqual(['id-WO-1'])
    expect(plan.left).toEqual([{ id: 'id-WO-4', number: 'WO-4', words: SHARED_HOLD_WORDS }])
    expect(SHARED_HOLD_WORDS).toEqual({ en: 'Shared with other customers: hold it on its page.', it: 'Condiviso con altri clienti: mettilo in sospeso dalla sua pagina.' })
    expect(plan.notReached).toBe(0)
    // Only shared ones, open: nothing from here, each says why.
    expect(orderHoldPlanOf({ workOrders: [shared] }).held?.code).toBe('NONE_HOLDABLE')
  })

  it('F13 one not reached is COUNTED, never named (a set of words of its own); none reached at all: Production holds them', () => {
    const plan = orderHoldPlanOf({ workOrders: [wo('WO-1', 'DRAFT')], workOrdersLeftOut: 2 })
    expect(plan).toMatchObject({ ids: ['id-WO-1'], left: [], notReached: 2, held: null })
    const none = orderHoldPlanOf({ workOrders: [], workOrdersLeftOut: 1 })
    expect(none.held).toEqual({ code: 'NONE_REACHED', words: { en: '1 work order of this order is not shown to you: ask Production to hold it.', it: '1 ordine di lavoro di questo ordine non ti è visibile: chiedi alla Produzione di metterlo in sospeso.' } })
    expect(orderHoldPlanOf({ workOrders: [], workOrdersLeftOut: 3 }).held!.words.en).toBe('3 work orders of this order are not shown to you: ask Production to hold them.')
    // The reached one completed, two not reached: the rest is Production's (never "every one is completed").
    expect(orderHoldPlanOf({ workOrders: [wo('WO-1', 'COMPLETED')], workOrdersLeftOut: 2 }).held?.code).toBe('NONE_REACHED')
    // The shared and the not-reached never mix: a shared one is in `left`, the count stays the read's.
    expect(JSON.stringify(none)).not.toContain('WO-')
  })

  it('the reader holds none (Sales): held "Production does this"; one ON_HOLD already is left out; every open one on hold: held', () => {
    const sales = orderHoldPlanOf({ workOrders: [wo('WO-1', 'DRAFT', { rights: { hold: false } }), wo('WO-2', 'IN_PROGRESS', { rights: { hold: false } })] })
    expect(sales).toMatchObject({ ids: [], held: { code: 'NO_RIGHT', words: { en: 'You may not put work orders on hold: Production does this.' } } })
    const some = orderHoldPlanOf({ workOrders: [wo('WO-1', 'ON_HOLD'), wo('WO-2', 'RELEASED')] })
    expect(some.ids).toEqual(['id-WO-2'])
    expect(some.left).toEqual([{ id: 'id-WO-1', number: 'WO-1', words: { it: 'Già in sospeso.', en: 'On hold already.' } }])
    expect(orderHoldPlanOf({ workOrders: [wo('WO-1', 'ON_HOLD'), wo('WO-2', 'COMPLETED')] }).held).toEqual({ code: 'ALL_ON_HOLD', words: { en: 'Every open work order of this order is on hold already.', it: 'Ogni ordine di lavoro aperto di questo ordine è già in sospeso.' } })
  })

  it('every held code has words in both languages', () => {
    for (const code of ORDER_HOLD_HELD) {
      const words = orderHoldHeldWords(code, 2)
      expect(words.en.trim(), code).not.toBe('')
      expect(words.it.trim(), code).not.toBe('')
      expect(words.it, code).not.toBe(words.en)
    }
  })
})
// ---- end B-OO-005
