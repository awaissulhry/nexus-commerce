import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { URGENCY_LOCK_REASON_MAX, URGENCY_OFFICE_BATCH_MAX } from '@nexus/factory-domain/production-brand/urgency'
import { leftKeys, renderView, textOf } from '../../../../../lib/record-thread/parts/testing'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { workOrder as baseWorkOrder } from '../../../_shared/fixtures'
import { designScreen } from '../fixtures'
import type { OrderThreadChoice } from '../order-files/model'
import { approvalsOf as askedOf, CARD_NOW, issue, issuesOf, OTHER_ORDER, request, requestsOf as requestRows, urgencyOf, urgencyOrder } from './fixtures'
import {
  ageOf,
  answerHref,
  approvalsOf,
  CARD_LIMITS,
  cardCustomersOf,
  issueThreadOf,
  issuesOfWorkOrder,
  limitsHref,
  ordinalOf,
  ownRows,
  requestsOf,
  urgencyActsOf,
  urgencyDialogHeld,
  urgencyLinesOf,
  urgencyOutcomeOf,
  urgencyProblemOf,
  urgencyWordsOf,
  waitingRushOf,
} from './model'
import { ApiError } from '../../../../../lib/api/errors'

/**
 * F-PR-05b — the work order record's Customer card (production plan §3, §5; 06-tree A.4 O-WO-brand; 17-web-r2 §1.7): its requests with
 * Answer in Approvals, what we asked it to approve, Customer urgency (Urgent · 2nd of their 3 / Urgent – asked / Regular / Set to
 * regular by us + reason) with Set to regular…, Lock… and Unlock… (production.brand.override, a fresh code, no second person), the
 * supervisor, open problems (Waiting on us since … + No reply sent yet + Open thread), limits, what it sees and Open as <customer>.
 * Wall, web side: PW-07 (rows of the work order's own customer and orders only; a mixed work order one block per customer), PW-08
 * (the preview opens only its one customer), PW-10 (writes name only this card's own orders; refused rows of other orders counted,
 * never named), PW-14 (the supervisor fact is the record's own), PW-17 (problems of other orders never shown).
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const CUSTOMER = { id: '0190f0e2-6666-7000-8000-000000000001', code: 'ALPHA', name: 'Moto Demo S.r.l.' }
const WO = baseWorkOrder('IN_PROGRESS', { partyId: CUSTOMER.id, customer: CUSTOMER, mixedCustomers: false })
const ORDER = WO.orders[0]!
const ONE = cardCustomersOf(WO)[0]!
const CASES = ['customer-card', 'customer-card-locked', 'customer-card-dormant', 'customer-card-no-right', 'customer-card-regular', 'customer-card-lock', 'customer-card-refused', 'customer-card-outcome', 'customer-card-escalated', 'customer-card-failed', 'customer-card-mixed']

describe('F-PR-05b — whose card (PW-07)', () => {
  it('one block for a work order of one customer, each order once; one block per customer for one made before the rule', () => {
    expect(cardCustomersOf(WO)).toEqual([{ partyId: ORDER.partyId, name: ORDER.partyName, orders: [{ id: ORDER.id, number: ORDER.number, customerRef: ORDER.customerRef }] }])
    const second = { ...ORDER, id: 'o-2', number: 'SO-2', partyId: 'p-2', partyName: 'Esempio Racing S.p.A.' }
    const mixed = cardCustomersOf({ orders: [ORDER, second, ORDER] })
    expect(mixed.map((customer) => customer.partyId)).toEqual([ORDER.partyId, 'p-2'])
    expect(mixed[0]!.orders).toHaveLength(1)
    expect(cardCustomersOf({ orders: [] })).toEqual([])
  })

  it('rows of another order of the same customer are dropped', () => {
    const rows = requestRows(WO)
    expect(rows.some((row) => row.orderId === OTHER_ORDER.id)).toBe(true)
    expect(ownRows(rows, ONE).some((row) => row.orderId === OTHER_ORDER.id)).toBe(false)
  })
})

describe('F-PR-05b — requests and approvals asked of the customer', () => {
  it('waiting ones first (on us before on the customer), then the last three answered; Answer in Approvals opens it there', () => {
    const { waiting, answered } = requestsOf(ownRows(requestRows(WO), ONE))
    expect(waiting.map((row) => row.kind)).toEqual(['RUSH'])
    expect(answered.map((row) => row.status)).toEqual(['REFUSED'])
    const onThem = request(WO, { id: 'r-them', status: 'COUNTERED', waitingOn: 'CUSTOMER', askedAt: '2026-10-01T09:00:00.000Z' })
    expect(requestsOf([onThem, request(WO)]).waiting.map((row) => row.id)).toEqual([request(WO).id, 'r-them'])
    expect(answerHref('/w/DEMO', 'r 1')).toBe('/w/DEMO/home/approvals?open=r%201')
  })

  it('how long it waits: just now, hours under two days, else days', () => {
    expect(ageOf(new Date(CARD_NOW - 20 * 60_000).toISOString(), CARD_NOW)).toEqual({ key: 'customerCard.age.now' })
    expect(ageOf(new Date(CARD_NOW - 4 * 3_600_000).toISOString(), CARD_NOW)).toEqual({ key: 'customerCard.age.hours', params: { count: 4 } })
    expect(ageOf(new Date(CARD_NOW - 72 * 3_600_000).toISOString(), CARD_NOW)).toEqual({ key: 'customerCard.age.days', params: { count: 3 } })
  })

  it('approvals: the open ones first (soonest due), the decided after; each once', () => {
    const rows = askedOf(WO)
    const { open, decided } = approvalsOf([...rows, rows[0]!])
    expect(open.map((row) => row.kind)).toEqual(['SAMPLE'])
    expect(decided.map((row) => row.kind)).toEqual(['COLOUR'])
  })
})

describe('F-PR-05b — Customer urgency', () => {
  const read = (orders = [urgencyOrder(WO)], over: { on?: boolean; mayOverride?: boolean } = {}) => urgencyOf(WO, orders, over)

  it('only the work order’s own orders get a line (the other order of the customer, urgent 1st, has none)', () => {
    const lines = urgencyLinesOf(read(), ONE, new Set())
    expect(lines.map((line) => line.order.id)).toEqual([ORDER.id])
    expect(lines[0]).toMatchObject({ state: 'URGENT', rank: 2, max: 3, mayOverride: true })
  })

  it('“Urgent (customer) · 2nd of their 3”; dormant while off; Urgent – asked; Set to regular by us with the reason; Regular', () => {
    const urgent = urgencyLinesOf(read(), ONE, new Set())[0]!
    expect(urgencyWordsOf(urgent, 'en')).toEqual({ key: 'customerCard.urgency.urgentRank', params: { rank: '2nd', max: 3 } })
    expect(urgencyWordsOf(urgent, 'it')).toEqual({ key: 'customerCard.urgency.urgentRank', params: { rank: '2º', max: 3 } })
    expect(urgencyLinesOf(read([urgencyOrder(WO, { counted: false })], { on: false }), ONE, new Set())[0]!.state).toBe('URGENT_DORMANT')
    const regular = urgencyOrder(WO, { urgency: 'REGULAR', counted: false, urgentRank: null, setBy: 'BRAND' })
    expect(urgencyLinesOf(read([regular]), ONE, waitingRushOf([request(WO)]))[0]!.state).toBe('ASKED')
    expect(urgencyLinesOf(read([regular]), ONE, new Set())[0]!.state).toBe('REGULAR')
    const locked = urgencyLinesOf(read([{ ...regular, setBy: 'FACTORY', locked: true, lockReason: 'No leather slot' }]), ONE, new Set())[0]!
    expect(locked.state).toBe('SET_BACK')
    expect(urgencyWordsOf(locked, 'en')).toEqual({ key: 'customerCard.urgency.setBackWhy', params: { reason: 'No leather slot' } })
  })

  it('ordinals in English and Italian', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map((n) => ordinalOf(n, 'en'))).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd'])
    expect(ordinalOf(2, 'it')).toBe('2º')
  })

  it('acts: Set to regular… on an Urgent order, Lock… while not locked, Unlock… while locked; held without production.brand.override', () => {
    const urgent = urgencyLinesOf(read(), ONE, new Set())[0]!
    expect(urgencyActsOf(urgent, false)).toEqual([
      { act: 'regular', held: null },
      { act: 'lock', held: null },
    ])
    const locked = urgencyLinesOf(read([urgencyOrder(WO, { urgency: 'REGULAR', locked: true, setBy: 'FACTORY' })]), ONE, new Set())[0]!
    expect(urgencyActsOf(locked, false).map((entry) => entry.act)).toEqual(['unlock'])
    const noRight = urgencyLinesOf(read([urgencyOrder(WO)], { mayOverride: false }), ONE, new Set())[0]!
    expect(urgencyActsOf(noRight, false).every((entry) => entry.held?.key === 'customerCard.urgency.held.noOverride')).toBe(true)
    expect(urgencyActsOf(urgent, true)[0]!.held).toEqual({ key: 'held.busy' })
  })

  it('the dialog: a reason the customer reads for Set to regular and Lock (one line, ≤ 500); Unlock needs none', () => {
    expect(CARD_LIMITS).toEqual({ reason: URGENCY_LOCK_REASON_MAX, orders: URGENCY_OFFICE_BATCH_MAX })
    expect(urgencyDialogHeld('regular', '  ', false)).toEqual({ key: 'customerCard.urgency.held.reason' })
    expect(urgencyDialogHeld('lock', 'a\nb', false)).toEqual({ key: 'customerCard.urgency.held.line' })
    expect(urgencyDialogHeld('lock', 'x'.repeat(501), false)).toEqual({ key: 'customerCard.urgency.held.long', params: { count: 500 } })
    expect(urgencyDialogHeld('regular', 'Capacity', false)).toBeNull()
    expect(urgencyDialogHeld('unlock', '', false)).toBeNull()
    expect(urgencyDialogHeld('unlock', '', true)).toEqual({ key: 'held.busy' })
  })

  it('PW-10: the result names only this card’s own orders; any other row (or one not reached) is counted, never named', () => {
    const answer = {
      results: [
        { orderId: ORDER.id, number: ORDER.number, customerRef: null, outcome: 'DONE' as const, done: true, words: null, urgency: 'REGULAR' as const },
        { orderId: 'someone-else', number: 'SO-OTHER-1', customerRef: null, outcome: 'NO_RIGHT' as const, done: false, words: { en: 'Not yours', it: 'Non tuo' }, urgency: null },
      ],
      notFound: 2,
      replayed: false,
    }
    const outcome = urgencyOutcomeOf('regular', answer, ONE.orders)
    expect(outcome).toEqual({ act: 'regular', done: [ORDER.number], notDone: [], notShown: 3 })
    expect(JSON.stringify(outcome)).not.toContain('SO-OTHER-1')
  })

  it('refusals in the card’s words', () => {
    expect(urgencyProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'customerCard.urgency.problem.forbidden' })
    expect(urgencyProblemOf(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'customerCard.urgency.problem.conflict' })
    expect(urgencyProblemOf(new Error('x'))).toEqual({ key: 'customerCard.urgency.problem.failed' })
  })

  it('the writes are the API’s routes and the step-up sentence is the page’s catalogue (one step-up modal per page)', () => {
    const api = readFileSync(join(__dirname, 'api.ts'), 'utf8')
    expect(api).toContain("'/production/brand-orders/urgency/regular'")
    expect(api).toContain("'/production/brand-orders/urgency/unlock'")
    expect(api).toContain('/production/brands/${encodeURIComponent(partyId)}/urgency')
    const hook = readFileSync(join(__dirname, 'use-customer-card.ts'), 'utf8')
    expect(hook).toContain("guard('stepUp.urgencySentence'")
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['production-work-orders'])['production-work-orders'] ?? {})
      expect(t('stepUp.urgencySentence')).not.toBe('stepUp.urgencySentence')
    }
  })
})

describe('F-PR-05b — open problems (PW-17)', () => {
  it('only this work order’s and its orders’ open problems, oldest first; another order’s never', () => {
    const own = [issue(WO), issue(WO, { id: 'i-wo', record: { type: 'WorkOrder', id: WO.id, label: WO.number }, salesOrder: null, raisedAt: '2026-10-10T09:00:00.000Z' })]
    const shown = issuesOfWorkOrder(issuesOf(WO, own), WO.id, ONE)
    expect(shown.map((row) => row.id)).toEqual(['i-wo', issue(WO).id])
    expect(issuesOfWorkOrder(issuesOf(WO, []), WO.id, ONE)).toEqual([])
    expect(issuesOfWorkOrder(issuesOf(WO, [issue(WO, { status: 'ANSWERED' })]), WO.id, ONE)).toEqual([])
  })

  it('Open thread: the work order’s own notes, the order’s thread when it may be read, else held', () => {
    const choice: OrderThreadChoice = { orderId: ORDER.id, number: ORDER.number, party: { id: ORDER.partyId, name: ORDER.partyName }, customerRef: null, companyId: WO.companyId }
    expect(issueThreadOf(issue(WO), [choice])).toBe(ORDER.id)
    expect(issueThreadOf(issue(WO), [])).toBeNull()
    expect(issueThreadOf({ record: { type: 'WorkOrder', id: WO.id, label: WO.number }, salesOrder: null }, [])).toBe('workOrder')
  })

  it('the limits card’s address (its anchor on Portal access)', () => {
    expect(limitsHref('/w/DEMO', 'p 1')).toBe('/w/DEMO/sales/customers/p%201?tab=portal#production-limits')
  })
})

describe('F-PR-05b — the card on screen', () => {
  it('every case draws in both languages with no key left', () => {
    for (const id of CASES) for (const locale of LOCALES) expect(leftKeys(draw(id, locale), ['customerCard', 'limits', 'band', 'held', 'error']), `${id} ${locale}`).toEqual([])
  })

  it('the full card: request waiting on us 4 h + Answer in Approvals, the sample asked, the urgency line and its acts, the problem and its marks', () => {
    const html = draw('customer-card')
    const text = textOf(html)
    expect(text).toContain('Customer card')
    expect(text).toContain('waiting on us 4 h')
    expect(html).toContain('/home/approvals?open=')
    expect(text).toContain('Sample')
    expect(text).toContain('Urgent (customer) · 2nd of their 3')
    expect(text).toContain('Set to regular…')
    expect(text).toContain('Lock…')
    expect(text).toContain('Waiting on us since')
    expect(text).toContain('No reply sent yet')
    expect(text).toContain('Open thread')
    expect(text).toContain('Urgent orders on (at most 3, 2 now)')
    expect(text).toContain('Open as')
    // PW-07 / PW-17: another order of the same customer never shows.
    expect(text).not.toContain(OTHER_ORDER.number)
    expect(textOf(draw('customer-card', 'it'))).toContain('Urgenza cliente')
  })

  it('locked: the reason the customer reads, who locked it, Unlock…; dormant: kept and counting for nothing', () => {
    const text = textOf(draw('customer-card-locked'))
    expect(text).toContain('Set to regular by us: Leather for this colour arrives after the cutting slot')
    expect(text).toContain('locked by Bea Esempio')
    expect(text).toContain('Unlock…')
    expect(textOf(draw('customer-card-dormant'))).toContain('kept but not used')
  })

  it('without the rights: acts held in words (the held reason is the button’s description), approvals and limits said, never drawn empty', () => {
    const html = draw('customer-card-no-right')
    const text = textOf(html)
    expect(html).toContain('Only people who may decide for a customer')
    expect(text).toContain('partner approvals')
    expect(text).toContain('portal access')
  })

  it('the dialog names the order, asks the reason the customer reads, offers Also lock, says a fresh code and no second person', () => {
    const text = textOf(draw('customer-card-regular'))
    expect(text).toContain(`Set ${ORDER.customerRef ? `PO ${ORDER.customerRef} · ${ORDER.number}` : ORDER.number} back to Regular`)
    expect(text).toContain('Reason the customer reads')
    expect(text).toContain('Also lock it at Regular')
    expect(text).toContain('No second person')
    expect(draw('customer-card-lock')).toContain('Write the reason the customer reads.')
    expect(textOf(draw('customer-card-refused'))).toContain('Nothing was changed')
  })

  it('the outcome: done named, the rest counted (PW-10)', () => {
    const text = textOf(draw('customer-card-outcome'))
    expect(text).toContain('Set back to Regular: SO-DEMO-0042.')
    expect(text).toContain('1 more order was not changed.')
  })

  it('a part that failed says so with Try again; one being read is a skeleton', () => {
    const text = textOf(draw('customer-card-failed'))
    expect(text).toContain('could not be read')
    expect(text).toContain('Try again')
  })

  it('PW-07 / PW-08: a mixed work order shows one block per customer, and Open as is held (no one customer)', () => {
    const html = draw('customer-card-mixed')
    const text = textOf(html)
    expect(text).toContain('Moto Demo S.r.l.')
    expect(text).toContain('Esempio Racing S.p.A.')
    expect(text).toContain('this customer only')
    expect(html).toContain('one customer to preview')
  })
})
