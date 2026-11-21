import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../../../../lib/api/client'
import { ASK_DAYS, askRevisedOrder, askTargetOf, revisedOrderAskBody, revisionToAskOf } from './revised-order-ask'

// F-OC-201 (order CHANGES tab, W2; 13-backend §1, B-OC-001; L5): the customer's new yes, asked on the REVISION by ONE helper.

const NOW = Date.parse('2026-11-22T09:00:00Z')
const order = { language: 'it', partyId: 'p1', chain: { quote: { id: 'q1' } } } as never

/** A made-up API: the customer's contacts, the quote's contact, and what the ask was sent with. */
function fakeApi(over: { contacts?: unknown[]; partyFails?: boolean; askFails?: boolean } = {}) {
  const sent: { path: string; body: unknown }[] = []
  const api = {
    get: async (path: string) => {
      if (path.startsWith('/parties/')) {
        if (over.partyFails) throw new Error('forbidden')
        return { party: { contacts: over.contacts ?? [{ id: 'c1', name: 'Lia Cliente', email: 'lia.cliente@example.com', status: 'ACTIVE', roles: ['ORDERS'] }] } }
      }
      return { quote: { contactId: null } }
    },
    post: async (path: string, init: { body: unknown }) => {
      sent.push({ path, body: init.body })
      if (over.askFails) throw new Error('refused')
      return { request: {}, url: null, delivery: 'SENT' }
    },
  }
  return { api: api as unknown as ApiClient, sent }
}

describe('F-OC-201: which revision a save asks about', () => {
  it('a plain change saved with the tick asks on its amendment; without the tick, or the address alone (no amendment): nobody', () => {
    expect(askTargetOf({ amendment: { id: 'a2', reacceptance: 'NEEDED' } })).toBe('a2')
    expect(askTargetOf({ amendment: { id: 'a2', reacceptance: 'NOT_NEEDED' } })).toBeNull()
    expect(askTargetOf({ amendment: null })).toBeNull()
  })

  it('fault 3: a priced change the customer must accept is asked too (it asked nobody before); one that needs no yes is not', () => {
    expect(askTargetOf({ change: { id: 'a3', customer: { decision: 'NOT_ASKED', requestId: null, answeredAt: null } } })).toBe('a3')
    expect(askTargetOf({ change: { id: 'a3', customer: { decision: 'NOT_NEEDED', requestId: null, answeredAt: null } } })).toBeNull()
  })
})

describe('F-OC-201: the ask\'s body — on the revision, to the confirmation\'s recipient, in the order\'s language', () => {
  it('faults 1 and 2: recordType SalesOrderAmendment and its id (the old SalesOrder was refused: "A revised order is asked on SalesOrderAmendment."), the address with send', () => {
    expect(revisedOrderAskBody({ language: 'it' }, 'a2', 'Riconfermate?', { email: 'lia.cliente@example.com' }, NOW)).toEqual({
      kind: 'REVISED_ORDER',
      recordType: 'SalesOrderAmendment',
      recordId: 'a2',
      question: 'Riconfermate?',
      dueAt: new Date(NOW + ASK_DAYS * 86_400_000).toISOString(),
      fileIds: [],
      send: true,
      email: 'lia.cliente@example.com',
      language: 'it',
    })
  })

  it('no e-mail address on file: the portal task only (send false, no address) — never a send that the route refuses', () => {
    const body = revisedOrderAskBody({ language: 'en' }, 'a2', 'Re-confirm?', null, NOW)
    expect(body).toMatchObject({ send: false, language: 'en' })
    expect(body).not.toHaveProperty('email')
  })

  it('askRevisedOrder: the orders contact\'s e-mail → asked by e-mail; no contact with one → the portal only; a refused ask throws (the save stands)', async () => {
    const mailed = fakeApi()
    expect(await askRevisedOrder(mailed.api, order, 'a2', 'q', { quotes: true })).toEqual({ reach: 'email', email: 'lia.cliente@example.com' })
    expect(mailed.sent).toEqual([{ path: '/approvals-out', body: expect.objectContaining({ recordType: 'SalesOrderAmendment', recordId: 'a2', send: true, email: 'lia.cliente@example.com' }) }])
    const portal = fakeApi({ contacts: [{ id: 'c2', name: 'Seed Buyer', email: null, status: 'ACTIVE', roles: ['ORDERS'] }] })
    expect(await askRevisedOrder(portal.api, order, 'a2', 'q', { quotes: false })).toEqual({ reach: 'portal' })
    expect(portal.sent[0]!.body).toMatchObject({ send: false })
    // The customer's contacts cannot be read (no parties.view): the portal task, never a failed send.
    expect(await askRevisedOrder(fakeApi({ partyFails: true }).api, order, 'a2', 'q', { quotes: false })).toEqual({ reach: 'portal' })
    await expect(askRevisedOrder(fakeApi({ askFails: true }).api, order, 'a2', 'q', { quotes: false })).rejects.toThrow()
  })
})

describe('F-OC-201 (L5): "Ask {customer}…" on the latest revision that waits and was never asked, or whose ask expired', () => {
  const change = (revision: number, decision: string) => ({ id: `a${revision}`, revision, customer: { decision, requestId: null, answeredAt: null } })
  it('NOT_ASKED, EXPIRED or WITHDRAWN on the latest revision while the order waits; never an older one, never an open or answered ask', () => {
    const waiting = '2026-11-19T10:00:00Z'
    expect(revisionToAskOf({ reapprovalNeededAt: waiting, changes: [change(1, 'ACCEPTED'), change(2, 'NOT_ASKED')] } as never)).toEqual({ amendmentId: 'a2', revision: 2, expired: false })
    expect(revisionToAskOf({ reapprovalNeededAt: waiting, changes: [change(2, 'EXPIRED'), change(1, 'NOT_ASKED')] } as never)).toEqual({ amendmentId: 'a2', revision: 2, expired: true })
    expect(revisionToAskOf({ reapprovalNeededAt: waiting, changes: [change(3, 'WITHDRAWN')] } as never)).toMatchObject({ revision: 3 })
    for (const decision of ['WAITING', 'ACCEPTED', 'REFUSED', 'NOT_NEEDED']) expect(revisionToAskOf({ reapprovalNeededAt: waiting, changes: [change(2, decision)] } as never), decision).toBeNull()
    // The order waits for no yes: nothing to ask.
    expect(revisionToAskOf({ reapprovalNeededAt: null, changes: [change(2, 'NOT_ASKED')] } as never)).toBeNull()
    expect(revisionToAskOf(null)).toBeNull()
  })
})
