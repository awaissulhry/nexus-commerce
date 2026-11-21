import { describe, expect, it } from 'vitest'
import { countsOf, holdsPointerOf, lastRevisionOf, mineCountOf, waitingAnswerOf, waitingItemOf } from './waiting'
import { orderWaitingOf } from '../overview/model'

// F-OC-101 … 104 (order CHANGES tab, W1): section 1, Waiting — the ONE waiting list's rows, said once with their turn, who and door.

const card = (onUs: number, onCustomer: number, still: number) => ({ onUs: Array.from({ length: onUs }), onCustomer: Array.from({ length: onCustomer }), still: Array.from({ length: still }) }) as never

describe('F-OC-101: Waiting\'s one answer', () => {
  it('"5 things wait: 4 on us, 1 on {customer}" · only steps: "4 steps are still to do" · nothing: "Nothing waits"', () => {
    expect(waitingAnswerOf(countsOf(card(4, 1, 0)))).toEqual({
      kind: 'total',
      count: 5,
      parts: [
        { key: 'changesTab.waiting.partUs', params: { count: 4 } },
        { key: 'changesTab.waiting.partCustomer', params: { count: 1 } },
      ],
    })
    expect(waitingAnswerOf(countsOf(card(0, 0, 4)))).toEqual({ kind: 'steps', count: 4 })
    expect(waitingAnswerOf(countsOf(card(0, 0, 0)))).toEqual({ kind: 'nothing' })
    // The steps are counted with the rest when something else waits too (the badge adds the same rows).
    expect(waitingAnswerOf(countsOf(card(1, 0, 2)))).toMatchObject({ kind: 'total', count: 3, parts: [{ key: 'changesTab.waiting.partUs' }, { key: 'changesTab.waiting.partSteps', params: { count: 2 } }] })
  })

  it('the last change is the latest revision (by its number, not the list\'s order); none: no line', () => {
    expect(lastRevisionOf([{ revision: 1, createdAt: '2026-11-10T09:00:00Z' }, { revision: 2, createdAt: '2026-11-12T09:00:00Z' }])).toEqual({ revision: 2, at: '2026-11-12T09:00:00Z' })
    expect(lastRevisionOf([{ revision: 3, createdAt: '2026-11-19T09:00:00Z' }, { revision: 1, createdAt: '2026-11-10T09:00:00Z' }])).toEqual({ revision: 3, at: '2026-11-19T09:00:00Z' })
    expect(lastRevisionOf([])).toBeNull()
    expect(lastRevisionOf(null)).toBeNull()
  })

  it('L4: "Holds and dates are on Production ›" only while a hold or a date waits — holds first — and never on a cancelled order', () => {
    const ready = (holds: number, dates: number) => ({ status: 'ready', rows: [], card: card(0, 0, 0), holds: Array.from({ length: holds }), dates: Array.from({ length: dates }) }) as never
    expect(holdsPointerOf(ready(1, 1), 'IN_PRODUCTION')).toBe('holds')
    expect(holdsPointerOf(ready(0, 2), 'CONFIRMED')).toBe('dates')
    expect(holdsPointerOf(ready(0, 0), 'IN_PRODUCTION')).toBeNull()
    expect(holdsPointerOf(ready(2, 0), 'CANCELLED')).toBeNull()
    expect(holdsPointerOf({ status: 'loading' }, 'IN_PRODUCTION')).toBeNull()
  })
})

// ---- F-OC-102: Waiting on us — each row its face, whose turn, who does it, its address ----
const request = (over: Record<string, unknown> = {}) => ({ id: 'r1', kind: 'CHANGE', status: 'OPEN', waitingOn: 'US', answeredIn: 'SALES', may: { accept: true, refuse: true, counter: true, counterWithPrice: false }, ...over })
const row = (over: Record<string, unknown>) => ({ key: 'k', kind: 'BRAND_REQUEST', sub: 'REQUEST', ref: null, on: 'US', since: '2026-11-19T08:12:00Z', words: { kind: 'api', words: { en: 'x', it: 'x' } }, place: 'REQUEST', door: { kind: 'their' }, ...over }) as never
const task = (over: Record<string, unknown> = {}) => ({ taskId: 't1', kind: 'SALES_ORDER_CHANGE', kindLabel: { en: 'Order change', it: 'Modifica ordine' }, requestedAt: '2026-11-18T15:05:00Z', requester: { name: 'Alex Demo', me: false }, approver: { kind: 'ROLE', name: 'Owner', me: false }, version: 1, requireStepUp: false, approve: { allowed: true, why: null }, reject: { allowed: true, why: null }, withdraw: { allowed: false, why: null }, ...over })

describe('F-OC-102: Waiting on us — one row each, its door only for who acts (L1, L2, L11)', () => {
  it('a request: Answer… for the team that answers its kind ("Your turn"); everyone else reads who does it, no button', () => {
    const mine = waitingItemOf(row({ door: { kind: 'answer', requestId: 'r1', request: request() } }), { manage: true })
    expect(mine).toMatchObject({ face: 'request', mine: true, who: { key: 'changesTab.who.sales' }, anchor: 'about-OrderChangeRequest-r1' })
    const others = waitingItemOf(row({ door: { kind: 'answer', requestId: 'r1', request: request({ answeredIn: 'PRODUCTION', may: { accept: false, refuse: false, counter: false, counterWithPrice: false } }) } }), { manage: true })
    expect(others).toMatchObject({ face: 'request', mine: false, who: { key: 'changesTab.who.production' } })
    // Not read yet: the API's words only — nothing claimed about who answers it.
    expect(waitingItemOf(row({ door: { kind: 'answer', requestId: 'r1', request: null } }), { manage: true })).toMatchObject({ face: 'request', mine: false, who: null })
  })

  it('L2: a problem the customer reported is a counted pointer row — never the reader\'s turn here (it is answered on Production)', () => {
    const problem = waitingItemOf(row({ sub: 'PROBLEM', ref: { type: 'ProductionIssue', id: 'i9' }, door: { kind: 'reply', messageId: 'm1' } }), { manage: true })
    expect(problem).toEqual(expect.objectContaining({ face: 'problem', mine: false, who: { key: 'changesTab.who.problem' }, anchor: 'about-ProductionIssue-i9' }))
  })

  it('our approval of an old change: the approver\'s turn; the one who asked reads "You asked for this approval: {who} decides"', () => {
    expect(waitingItemOf(row({ kind: 'YES', door: { kind: 'yes', task: task() } }), { manage: true })).toMatchObject({ face: 'approval', mine: true, who: { key: 'changesTab.who.decides', params: { who: 'Owner' } }, anchor: 'about-Approval-t1' })
    expect(waitingItemOf(row({ kind: 'YES', door: { kind: 'yes', task: task({ requester: { name: 'Alex Demo', me: true } }) } }), { manage: true })).toMatchObject({ mine: false, who: { key: 'changesTab.who.youAsked' } })
    expect(waitingItemOf(row({ kind: 'YES', door: { kind: 'yes', task: task({ approve: { allowed: false, why: null }, reject: { allowed: false, why: null } }) } }), { manage: true })).toMatchObject({ mine: false, who: { key: 'changesTab.who.decides' } })
  })

  it('L11: a revision the customer said no to — Sales\' turn ("Sales decides"), its row opens the revision in What changed', () => {
    expect(waitingItemOf(row({ kind: 'REVISION_REFUSED', ref: { type: 'SalesOrderAmendment', id: 'a2' }, door: { kind: 'refused', amendmentId: 'a2' } }), { manage: true })).toMatchObject({ face: 'refused', mine: true, who: { key: 'changesTab.who.salesDecides' }, anchor: 'about-Amendment-a2' })
    expect(waitingItemOf(row({ door: { kind: 'refused', amendmentId: 'a2' } }), { manage: false })).toMatchObject({ face: 'refused', mine: false })
  })

  it('L11: the waiting list gives a row about an amendment waiting on us the refused door, whatever kind the read calls it', () => {
    const state = orderWaitingOf({ openApprovals: [] }, { production: { status: 'ready', read: { headline: { waiting: { blockers: [{ kind: 'REVISION_REFUSED', on: 'US', words: { en: 'Seed Customer One said no to revision 2', it: 'Seed Customer One ha detto no alla revisione 2' }, since: '2026-11-13T09:40:00Z', ref: { type: 'SalesOrderAmendment', id: 'a2' }, sub: null }] } } } as never }, requests: { value: [] }, can: { recordPayment: false } }, 'en')
    if (state.status !== 'ready') throw new Error('ready')
    expect(state.card.onUs.map((entry) => entry.door)).toEqual([{ kind: 'refused', amendmentId: 'a2' }])
  })

  it('"N are your turn": the rows above that are mine and every Still to do row that asks this reader', () => {
    expect(mineCountOf([{ mine: true }, { mine: false }, { mine: true }], [{ mayAct: true }, { mayAct: false }])).toBe(3)
    expect(mineCountOf([], [])).toBe(0)
  })
})
