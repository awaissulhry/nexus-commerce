import { describe, expect, it } from 'vitest'
import { ASK_RULES, ORDER_REQUEST_KINDS } from '../sales/change-requests/rules'
import { CUSTOMER_PAUSE_REASON, isProductionAccept, pauseDoneWords, pausePlan, plainHoldWordsOf, PRODUCTION_ACCEPT_KINDS, resumeReasonOf, type AcceptWorkOrder } from './accept'
// B-PR-27b
import { ACCEPT_DONE_WORDS, joinedWords, NOTHING_TO_RUSH_WORDS, repromiseAsksOf, REPROMISE_SKIP_WORDS, RUSH_FLOOR_ONLY_WORDS, RUSH_REFUSAL_WORDS, RUSH_RIGHT_WORDS, rushMixedWords, rushPlan, sampleCellsOf, sampleInstructionsOf, type RushWorkOrder } from './accept'

/** B-PR-27a: what accepting a customer's pause and resume does to the order's work, pure (production-brand/accept). */

const A = '00000000-0000-4000-8000-00000000000a'
const wo = (id: string, patch: Partial<AcceptWorkOrder> = {}): AcceptWorkOrder => ({ id, number: `WO-${id.slice(-2)}`, status: 'DRAFT', partyId: A, otherOrders: false, paused: false, ...patch })

describe('B-PR-27a: where a request is accepted', () => {
  it('production accepts the pause, the resume, the rush and the sample round; Sales the rest', () => {
    expect([...PRODUCTION_ACCEPT_KINDS]).toEqual(['HOLD', 'RESUME', 'RUSH', 'SAMPLE_ROUND'])
    expect(ORDER_REQUEST_KINDS.filter((kind) => !isProductionAccept(kind))).toEqual(['CHANGE', 'CANCEL', 'SPLIT_SHIPMENT'])
    // The same split as who answers: production.brand.manage and sales.samples.manage here, orders.manage in Sales.
    for (const kind of ORDER_REQUEST_KINDS) expect(isProductionAccept(kind), kind).toBe(ASK_RULES[kind].answeredWith !== 'orders.manage')
  })
})

describe('B-PR-27a: the pause', () => {
  it('holds every open work order of the order (one the customer paused already is left as it is), in id order', () => {
    const plan = pausePlan([wo('01'), wo('02', { status: 'IN_PROGRESS' }), wo('03', { status: 'ON_HOLD', paused: true }), wo('04', { status: 'COMPLETED' }), wo('05', { status: 'CANCELLED' })])
    expect(plan).toEqual({ ok: true, hold: ['01', '02'], already: ['03'] })
  })

  it('an order with no open work order yet is answered by hand (nothing to pause)', () => {
    for (const workOrders of [[], [wo('01', { status: 'CLOSED' })]]) {
      const plan = pausePlan(workOrders)
      expect(plan).toMatchObject({ ok: false, code: 'NO_WORK' })
      if (!plan.ok) expect(plan.words.en).toMatch(/nothing to pause.*Answer by hand/)
    }
  })

  it('a mixed work order (no customer: made before the rule) is answered by hand — it is never held, named in the words', () => {
    const plan = pausePlan([wo('01'), wo('02', { partyId: null })])
    expect(plan).toMatchObject({ ok: false, code: 'MIXED', numbers: ['WO-02'] })
    if (!plan.ok) expect([plan.words.en, plan.words.it]).toEqual([expect.stringMatching(/WO-02 was made before the one-customer rule.*answer by hand/), expect.stringMatching(/WO-02 è stato fatto prima/)])
    // A closed mixed work order does not count (nothing is paused there).
    expect(pausePlan([wo('01'), wo('02', { partyId: null, status: 'CLOSED' })])).toMatchObject({ ok: true, hold: ['01'] })
  })

  it('a work order that also makes another order is answered by hand (that order would stop too)', () => {
    expect(pausePlan([wo('01'), wo('02', { otherOrders: true }), wo('03', { otherOrders: true })])).toMatchObject({ ok: false, code: 'SHARED', numbers: ['WO-02', 'WO-03'] })
  })

  it('the pause has its own words (never a code of the production list), the floor reads them; a production hold its reason', () => {
    expect(CUSTOMER_PAUSE_REASON.code).toMatch(/^[A-Z][A-Z0-9_]{0,39}$/)
    expect(plainHoldWordsOf({ kind: 'BRAND', reasonCode: 'CUSTOMER_PAUSE' }, undefined)).toBe("Paused at the customer's request")
    expect(plainHoldWordsOf({ kind: 'PRODUCTION', reasonCode: 'MATERIAL_MISSING' }, 'Material missing')).toBe('Material missing')
    expect(plainHoldWordsOf({ kind: 'PRODUCTION', reasonCode: 'GONE' }, undefined)).toBe('GONE')
  })

  it('says what was done, and why a pause was lifted (one line, at most 500)', () => {
    expect(pauseDoneWords('HOLD', ['WO-1', 'WO-2']).en).toBe("Paused at the customer's request: WO-1, WO-2.")
    expect(pauseDoneWords('HOLD', []).en).toMatch(/paused at the customer's request already/)
    expect(pauseDoneWords('RESUME', []).en).toBe("Nothing was paused any more: the order's work goes on.")
    expect(pauseDoneWords('RESUME', ['WO-1']).it).toBe('Ripreso: WO-1.')
    expect(resumeReasonOf('SO-0001')).toBe("Resumed at the customer's request (SO-0001).")
    expect(resumeReasonOf('X'.repeat(600))).toHaveLength(500)
    expect(resumeReasonOf('SO-0001')).not.toMatch(/[\r\n]/)
  })
})

// ── B-PR-27b: "Urgent – asked", ship what is ready, another sample round ─────────────────────────────────────────────────────────
describe('B-PR-27b: rushing the floor, the re-promise, the sample round', () => {
  const rush = (id: string, patch: Partial<RushWorkOrder> = {}): RushWorkOrder => ({ ...wo(id), rush: false, ...patch })

  it('rushes the open own work orders (one rushed already is said so); a mixed one is never rushed by the accept', () => {
    expect(rushPlan([rush('01'), rush('02', { rush: true }), rush('03', { partyId: null }), rush('04', { status: 'CLOSED' })])).toEqual({ rush: ['01'], already: ['02'], mixed: ['WO-03'] })
    expect(rushPlan([rush('01', { status: 'COMPLETED' })])).toEqual({ rush: [], already: [], mixed: [] })
    expect(rushMixedWords(['WO-03']).en).toBe("Work order WO-03 also makes other customers' pieces: rush it by hand if needed.")
  })

  it('proposes the date asked for every open size promised later; a size promised by then, shipped or unpromised keeps its date', () => {
    expect(
      repromiseAsksOf(
        [
          { size: '50', open: 2, promised: '2026-12-20' },
          { size: '52', open: 2, promised: '2026-12-01' },
          { size: '54', open: 0, promised: '2026-12-20' },
          { size: '56', open: 1, promised: null },
        ],
        '2026-12-05',
      ),
    ).toEqual([{ size: '50', date: '2026-12-05' }])
  })

  it('a size set is one piece of each size the line orders; any other round one piece of the base size', () => {
    const line = { colourwayId: 'blk', baseSize: null, sizes: [{ size: '52', quantity: 2 }, { size: '50', quantity: 1 }, { size: '54', quantity: 0 }] }
    const style = { baseSize: '52', sizes: ['48', '50', '52', '54'] }
    expect(sampleCellsOf('SIZE_SET', line, style)).toEqual([{ colourwayId: 'blk', size: '50', quantity: 1 }, { colourwayId: 'blk', size: '52', quantity: 1 }])
    expect(sampleCellsOf('PRE_PRODUCTION', line, style)).toEqual([{ colourwayId: 'blk', size: '52', quantity: 1 }])
    expect(sampleCellsOf('TOP_OF_PRODUCTION', { ...line, baseSize: '50' }, style)).toEqual([{ colourwayId: 'blk', size: '50', quantity: 1 }])
    expect(sampleCellsOf('BRAND', line, { baseSize: null, sizes: ['48', '50', '52'] })).toEqual([{ colourwayId: 'blk', size: '50', quantity: 1 }])
    expect(sampleInstructionsOf('SO-1', 10, null)).toBe('Asked by the customer from its portal (SO-1, line 10).')
    expect(sampleInstructionsOf('SO-1', 10, 'One of each.')).toBe('Asked by the customer from its portal (SO-1, line 10): One of each.')
  })

  it('says each refusal and what was done in the office’s words, it and en', () => {
    for (const words of [...Object.values(RUSH_REFUSAL_WORDS), NOTHING_TO_RUSH_WORDS, RUSH_RIGHT_WORDS, RUSH_FLOOR_ONLY_WORDS, ...Object.values(REPROMISE_SKIP_WORDS)]) {
      expect(words.it.length, words.en).toBeGreaterThan(0)
      expect(words.en.length).toBeGreaterThan(0)
    }
    expect(joinedWords([ACCEPT_DONE_WORDS.urgent(3, false), ACCEPT_DONE_WORDS.rushed(['WO-1']), ACCEPT_DONE_WORDS.repromised(1)]).en).toBe("Marked Urgent by us: number 3 in the customer's own Urgent list. Rushed on the floor: WO-1. New date proposed to sales for 1 line.")
    expect(ACCEPT_DONE_WORDS.urgent(2, true).en).toBe('The order was Urgent already: it keeps its place.')
  })
})
