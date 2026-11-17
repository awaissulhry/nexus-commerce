import { describe, expect, it } from 'vitest'
import { CUSTOMER_URGENCY_STATES, customerUrgencyStateOf, customerUrgencyStateWords, isCustomerUrgencyState, type OrderUrgencyFacts } from './urgency-state'

/**
 * F-PR-18 — the Work orders column's four states (Urgent 2 / Urgent – asked / Regular / Set to regular by us), from the work order's
 * own orders only (PW-06: the rule takes no other customer's order; nothing in it is a place in our plan or a count of others).
 */

const order = (over: Partial<OrderUrgencyFacts> = {}): OrderUrgencyFacts => ({ urgency: 'REGULAR', urgentRank: null, asked: false, setByUs: false, ...over })

describe('F-PR-18 — the customer urgency state of a work order', () => {
  it('Urgent wins with the best place in the customer’s own list; then asked; then set back by us; then Regular', () => {
    expect(customerUrgencyStateOf([order({ urgency: 'URGENT', urgentRank: 3 }), order({ urgency: 'URGENT', urgentRank: 2 }), order({ asked: true })])).toEqual({ state: 'URGENT', urgentRank: 2 })
    expect(customerUrgencyStateOf([order({ asked: true }), order({ setByUs: true })])).toEqual({ state: 'ASKED', urgentRank: null })
    expect(customerUrgencyStateOf([order(), order({ setByUs: true })])).toEqual({ state: 'SET_BACK', urgentRank: null })
    expect(customerUrgencyStateOf([order()])).toEqual({ state: 'REGULAR', urgentRank: null })
  })

  it('no order whose urgency counts: none; an Urgent order of an unknown place is Urgent without a place', () => {
    expect(customerUrgencyStateOf([])).toBeNull()
    expect(customerUrgencyStateOf([order({ urgency: 'URGENT', urgentRank: null })])).toEqual({ state: 'URGENT', urgentRank: null })
    expect(customerUrgencyStateOf([order({ urgency: 'URGENT', urgentRank: 0 })])).toEqual({ state: 'URGENT', urgentRank: null })
  })

  it('says each state in both languages; "Urgente" alone stays the rush flag (the chip says "(cliente)")', () => {
    expect(customerUrgencyStateWords({ state: 'URGENT', urgentRank: 2 })).toEqual({ it: 'Urgente (cliente) 2', en: 'Urgent (customer) 2' })
    expect(customerUrgencyStateWords({ state: 'ASKED', urgentRank: null })).toEqual({ it: 'Urgente – richiesto', en: 'Urgent – asked' })
    expect(customerUrgencyStateWords({ state: 'SET_BACK', urgentRank: null }).en).toBe('Set to Regular by us')
    expect(customerUrgencyStateWords({ state: 'REGULAR', urgentRank: null })).toEqual({ it: 'Normale', en: 'Regular' })
    for (const state of CUSTOMER_URGENCY_STATES) expect(customerUrgencyStateWords({ state, urgentRank: null }).it).not.toBe('Urgente')
  })

  it('knows its states (a filter value from an address is one of them or nothing)', () => {
    expect(CUSTOMER_URGENCY_STATES).toEqual(['URGENT', 'ASKED', 'REGULAR', 'SET_BACK'])
    expect(isCustomerUrgencyState('ASKED')).toBe(true)
    expect(isCustomerUrgencyState('urgent')).toBe(false)
    expect(isCustomerUrgencyState(null)).toBe(false)
  })
})
