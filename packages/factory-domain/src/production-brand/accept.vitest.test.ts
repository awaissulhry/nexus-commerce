import { describe, expect, it } from 'vitest'
import { ASK_RULES, ORDER_REQUEST_KINDS } from '../sales/change-requests/rules'
import { CUSTOMER_PAUSE_REASON, isProductionAccept, pauseDoneWords, pausePlan, plainHoldWordsOf, PRODUCTION_ACCEPT_KINDS, resumeReasonOf, type AcceptWorkOrder } from './accept'

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
