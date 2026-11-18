import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { ApprovalKind } from '@nexus/factory-domain/approvals-out/kinds'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import type { ApprovalRead } from '../home/api'
import { optionKey, PendingAnswer, type ApproveDialogModel } from '../home/view/ApproveDialog'
import type { OpenItemsRead } from '../documents/api'
import { waitingListSchema, type WaitingApproval } from './api'
import { answerQueue, doneWordsOf, GROUP_OF_KIND, pendingOf, sendRefusal, UNDO_MS, WAITING_GROUPS, waitingGroupsOf, waitingRowsOf, type TaskLink } from './model'
import { WaitingView, type WaitingViewModel } from './view/WaitingView'

/**
 * F-PR-14 — Home › Waiting for you (production plan §5; 06-tree B.3; 09-design (f); wall PW-P05): the ONE place the customer
 * answers — Production approvals (samples, fabric, trims, colour, leather, artwork), Order (revised order, new date, our
 * counter-offer), Quality (concessions), Made-to-measure (design proofs), Payment; one verb per row; the named approver's
 * colleagues read "Waiting for <name>", a priced counter-offer without prices "Waiting for your buyer"; an answer goes to us after
 * 10 seconds (Undo until then). Brand Beta's page holds nothing of Brand Alpha. Made-up data.
 */

const PREFIX = `/p/${BRAND_BETA.code}`
const NOW = Date.parse('2026-11-18T09:00:00Z')
const say = (en: string, it = en) => ({ en, it })
let seq = 0
const uuid = () => `b2b2b2b2-0000-4000-8000-${String(++seq).padStart(12, '0')}`

function approval(kind: ApprovalKind, over: Partial<WaitingApproval> = {}): WaitingApproval {
  return { id: uuid(), kind, words: say(`${BRAND_BETA.numbers.style} · ${kind.toLowerCase()}`), question: 'Made-up: please look at it.', dueAt: '2026-11-21T16:00:00Z', status: 'OPEN', waitingFor: null, waitingForBuyer: false, ...over }
}

const task = (approvalId: string, over: Partial<TaskLink> = {}): TaskLink => ({ href: `${PREFIX}/open/ApprovalRequest/${approvalId}`, askedBy: 'Bea Esempio', due: { at: '2026-11-21T16:00:00Z', state: 'soon' }, ...over })

function payments(): OpenItemsRead {
  return {
    asOf: '2026-11-18T09:00:00Z',
    invoices: [],
    deposits: [{ depositRequestId: uuid(), orderNumber: BRAND_BETA.customerRef, quoteDocument: null, dueDate: '2026-11-15', daysLate: 3, total: 120000, open: 120000, currency: 'EUR', payment: null, canPay: true }],
    byCurrency: [],
    counts: { invoices: 0, overdue: 0, deposits: 1 },
    card: { available: true, methods: ['CARD'], provider: 'PAYMENT_FAKE', mode: 'FAKE', reason: null },
    mayPay: true,
    live: { events: [] },
  }
}

const ALL_KINDS: ApprovalKind[] = ['SAMPLE', 'FABRIC', 'TRIM', 'COLOUR', 'LEATHER', 'ARTWORK', 'REVISED_ORDER', 'REPROMISE', 'COUNTER_OFFER', 'CONCESSION', 'PROOF', 'SIGNATURE']

describe('the groups and the rows (F-PR-14)', () => {
  it('each kind waits in its group, in the page’s order; nothing that waits is hidden (a kind not named goes under Other)', () => {
    expect(ALL_KINDS.map((kind) => [kind, GROUP_OF_KIND[kind]])).toEqual([
      ['SAMPLE', 'production'],
      ['FABRIC', 'production'],
      ['TRIM', 'production'],
      ['COLOUR', 'production'],
      ['LEATHER', 'production'],
      ['ARTWORK', 'production'],
      ['REVISED_ORDER', 'order'],
      ['REPROMISE', 'order'],
      ['COUNTER_OFFER', 'order'],
      ['CONCESSION', 'quality'],
      ['PROOF', 'mtm'],
      ['SIGNATURE', 'other'],
    ])
    const rows = waitingRowsOf({ approvals: ALL_KINDS.map((kind) => approval(kind)), tasks: [], payments: payments(), locale: 'en', prefix: PREFIX, now: NOW })
    expect(waitingGroupsOf(rows).map((entry) => [entry.group, entry.rows.length])).toEqual([
      ['production', 6],
      ['order', 3],
      ['quality', 1],
      ['mtm', 1],
      ['payment', 1],
      ['other', 1],
    ])
    expect(WAITING_GROUPS).toEqual(['production', 'order', 'quality', 'mtm', 'payment', 'other'])
    // An answered or closed request no longer waits.
    expect(waitingRowsOf({ approvals: [approval('SAMPLE', { status: 'APPROVED' })], tasks: [], payments: null, locale: 'en', prefix: PREFIX, now: NOW })).toEqual([])
  })

  it('one verb per row: Review, Re-confirm, Answer (a date, our suggestion); View when another answers it; Pay opens To pay', () => {
    const named = approval('SAMPLE', { waitingFor: 'Anna Esempio' })
    const priced = approval('COUNTER_OFFER', { waitingForBuyer: true })
    const rows = waitingRowsOf({ approvals: [approval('FABRIC'), approval('REVISED_ORDER'), approval('REPROMISE'), approval('COUNTER_OFFER'), named, priced], tasks: [], payments: payments(), locale: 'en', prefix: PREFIX, now: NOW })
    expect(rows.map((row) => [row.kind, row.verb.act, row.verb.key])).toEqual([
      ['FABRIC', 'answer', 'verb.review'],
      ['REVISED_ORDER', 'answer', 'verb.reconfirm'],
      ['REPROMISE', 'answer', 'verb.answerDate'],
      ['COUNTER_OFFER', 'answer', 'verb.answerCounter'],
      ['SAMPLE', 'view', 'verb.view'],
      ['COUNTER_OFFER', 'view', 'verb.view'],
      ['PAY_DEPOSIT', 'link', 'verb.pay'],
    ])
    expect(rows.find((row) => row.id === named.id)!.heldFor).toEqual({ kind: 'person', name: 'Anna Esempio' })
    expect(rows.find((row) => row.id === priced.id)!.heldFor).toEqual({ kind: 'buyer' })
    expect(rows.at(-1)!.verb.href).toBe(`${PREFIX}/documents?group=FINANCE`)
    // J / K walk only what the reader answers here.
    expect(answerQueue(waitingGroupsOf(rows))).toEqual(rows.filter((row) => row.verb.act === 'answer').map((row) => row.id))
  })

  it('who asked and the due come from the frame’s task list; without a task the same rule (overdue first)', () => {
    const asked = approval('PROOF')
    const late = approval('ARTWORK', { dueAt: '2026-11-17T16:00:00Z' })
    const rows = waitingRowsOf({ approvals: [asked, late], tasks: [task(asked.id)], payments: payments(), locale: 'en', prefix: PREFIX, now: NOW })
    expect(rows.find((row) => row.id === asked.id)).toMatchObject({ askedBy: 'Bea Esempio', due: { state: 'soon' } })
    expect(rows.find((row) => row.id === late.id)).toMatchObject({ askedBy: null, due: { state: 'overdue' } })
    expect(rows.find((row) => row.kind === 'PAY_DEPOSIT')).toMatchObject({ due: { state: 'overdue' }, amount: { minor: 120000, currency: 'EUR' } })
  })

  it('the API’s list parses; an older answer without waitingForBuyer reads false', () => {
    const read = waitingListSchema.parse({ state: 'OPEN', items: [{ id: uuid(), kind: 'SAMPLE', words: say('x'), question: 'q', dueAt: '2026-11-21T16:00:00Z', status: 'OPEN', decided: null, waitingFor: null }] })
    expect(read.items[0]!.waitingForBuyer).toBe(false)
  })
})

describe('the answer: Undo for 10 seconds, then we are told', () => {
  it('nothing goes before 10 seconds; the row’s words say it; a refusal is neutral', () => {
    expect(UNDO_MS).toBe(10_000)
    expect(pendingOf({ requestId: 'r', decision: 'APPROVED', answer: null, typedName: 'Berta Becker', version: 1 }, NOW).sendAt).toBe(NOW + 10_000)
    expect(doneWordsOf({ phase: 'pending', decision: 'REFUSED' })).toBe('done.pending.REFUSED')
    expect(doneWordsOf({ phase: 'sent', decision: 'APPROVED' })).toBe('done.sent.APPROVED')
    // PW-P05: a request that is not the party's answers as one that no longer waits — never that another customer exists.
    expect(sendRefusal('not_found')).toBe('problem.gone')
    expect(CATALOGUE.en['portal-waiting']!['problem.gone']).toBe('This request no longer waits for an answer.')
  })

  it('the Approve pop-up while the answer waits: what was decided, the time left and Undo', () => {
    const page: ApprovalRead = {
      request: { id: uuid(), kind: 'SAMPLE', label: `${BRAND_BETA.numbers.style} PP sample`, question: 'Made-up: the PP sample.', from: { companyName: 'Factory Example' }, dueAt: '2026-11-21T16:00:00Z', status: 'OPEN', answer: null, version: 2 },
      content: { facts: [], revisedOrder: null },
      files: [],
      may: { answer: true, withChanges: true, held: null },
      locale: 'en',
    }
    const model: ApproveDialogModel = { requestId: page.request.id, state: 'ready', page, position: null, decision: 'APPROVED', comment: '', answer: 'idle', problem: null, field: null, held: null, file: null, now: NOW, pending: { until: NOW + 8_000, decision: 'APPROVED' } }
    const text = textOf(render(createElement(PendingAnswer, { page, model, pending: model.pending! })))
    expect(text).toContain(`Approved: ${BRAND_BETA.numbers.style} PP sample`)
    expect(text).toContain('Undo')
    expect(text).toContain('Until then nothing is sent')
    expect(optionKey('REPROMISE', 'APPROVED')).toBe('approve.optionFor.REPROMISE.APPROVED')
    expect(optionKey('SAMPLE', 'REFUSED')).toBe('approve.option.REFUSED')
    expect(CATALOGUE.en['portal-customer-home']!['approve.optionFor.REPROMISE.APPROVED']).toBe('Accept the new date')
  })
})

function draw(over: Partial<WaitingViewModel> = {}, locale: 'en' | 'it' = 'en') {
  const named = approval('SAMPLE', { id: 'b2b2b2b2-0000-4000-8000-000000000501', waitingFor: 'Berta Becker' })
  const priced = approval('COUNTER_OFFER', { waitingForBuyer: true })
  const mine = approval('FABRIC', { id: 'b2b2b2b2-0000-4000-8000-000000000502' })
  const rows = waitingRowsOf({ approvals: [mine, named, priced, approval('REPROMISE')], tasks: [task(mine.id)], payments: payments(), locale, prefix: PREFIX, now: NOW })
  const model: WaitingViewModel = { state: 'ready', groups: waitingGroupsOf(rows), done: {}, notice: null, dialog: null, now: NOW, ...over }
  return render(createElement(WaitingView, { model }), locale)
}

describe('the page (screen side of PW-P05)', () => {
  it('the groups, one verb per row, who answers what; the payment with its amount and Pay', () => {
    const text = textOf(draw())
    for (const words of ['Production approvals', 'Order', 'Payment', 'Approve the fabric', 'Asked by Bea Esempio', 'Waiting for Berta Becker', 'Waiting for your buyer', 'Answer the new date', 'Pay the deposit for', 'Review', 'View', 'Pay']) expect(text).toContain(words)
  })

  it('an answer that waits shows its words and Undo in its row; a sent one says so without Undo', () => {
    const pending = textOf(draw({ done: { 'b2b2b2b2-0000-4000-8000-000000000502': { phase: 'pending', decision: 'APPROVED' } } }))
    expect(pending).toContain('Approved: it goes to us in a few seconds')
    expect(pending).toContain('Undo')
    const sent = textOf(draw({ done: { 'b2b2b2b2-0000-4000-8000-000000000502': { phase: 'sent', decision: 'APPROVED' } } }))
    expect(sent).toContain('Approved: sent to us')
  })

  it('empty is said; a failed read is never drawn as empty', () => {
    expect(textOf(draw({ groups: [] }))).toContain('Nothing waits for you.')
    const failed = textOf(draw({ state: 'error', groups: [] }))
    expect(failed).toContain('We could not read what waits for you.')
    expect(failed).not.toContain('Nothing waits for you.')
  })

  // ---- F-PR-16 (the browser walk): no short line on an empty page at 1920
  it('nothing waits and a failed read fill the page: the DS empty state, a danger banner with Try again', () => {
    const empty = draw({ groups: [] })
    expect(empty).toContain('class="nds-empty"')
    expect(textOf(empty)).toContain('Nothing waits for you.')
    const failed = render(createElement(WaitingView, { model: { state: 'error', groups: [], done: {}, notice: null, dialog: null, now: NOW }, actions: { onRetry: () => undefined } }), 'en')
    expect(failed).toContain('class="nds-banner danger"')
    expect(failed).toContain('role="alert"')
    expect(textOf(failed)).toContain('Try again')
    expect(failed).not.toContain('nds-empty')
  })
  // ---- end F-PR-16

  it('Brand Beta’s page holds nothing of Brand Alpha, in both languages', () => {
    for (const locale of ['en', 'it'] as const) expect(scanText(draw({}, locale), BRAND_ALPHA), locale).toEqual([])
  })

  it('every word in both languages; the Italian speaks to the customer as "voi"', () => {
    const en = Object.keys(CATALOGUE.en['portal-waiting'] ?? {}).sort()
    const it = Object.entries(CATALOGUE.it['portal-waiting'] ?? {})
    expect(en.length).toBeGreaterThan(40)
    expect(it.map(([key]) => key).sort()).toEqual(en)
    for (const [key, text] of it) expect(text, key).not.toMatch(/\b(tu|tuo|tua|tuoi|tue|ti|hai|puoi|vuoi|scegli|scrivici|approva|paga|rispondi)\b/i)
    const added = Object.entries(CATALOGUE.it['portal-customer-home'] ?? {}).filter(([key]) => key.startsWith('approve.pending.') || key.startsWith('approve.optionFor.'))
    expect(added.length).toBe(16)
    for (const [key, text] of added) expect(text, key).not.toMatch(/\b(tu|tuo|tua|ti|hai|puoi|accetta|rifiuta|dicci)\b/i)
  })
})
