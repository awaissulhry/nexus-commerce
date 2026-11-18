import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PARTNER_MESSAGE_TEMPLATES } from '@nexus/factory-domain/portal/notifications/messages'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { ApiError } from '../../../../lib/api/errors'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import type { Locale } from '../../../../lib/i18n/locales'
import { render, textOf } from '../../../../lib/record-thread/parts/testing'
import { scanText } from '../../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../../lib/testing/two-brands'
import type { ChangeRules, ImpactRead } from '../../orders/api'
import { rulesOf } from '../../orders/design-data'
import { changeAsksSomething, changeBodyOf, changeHeld, colourSizeProblems, colourwaysAsked, EMPTY_CHANGE, NS as ORDERS_NS } from '../../orders/model'
import { BulkApproveDialog, WAITING_NS, type BulkApproveDialogModel } from '../../waiting/view/BulkApproveDialog'
import type { ProductionRow, Urgency } from '../api'
import { NS } from '../model'
import { AskManyReview, type AskManyReviewModel } from '../view/AskManyReview'
import type { ApprovalsToReview, ApproveManyAnswer, AskManyAnswer } from './api'
import { approveBodyOf, approveDoneLineOf, approveHeldOf, approveRefusalOf, approveResultsOf, approveRowsOf, keepTicked } from './approve-model'
import { askFormProblem, askHeldOf, askManyBodyOf, askRefusalOf, askResultsOf, askReviewOf, askUsHrefOf, askVerdictOf, EMPTY_ASK_FORM, impactLineOf, type AskRowFacts } from './ask-model'
import { askKindsOf, bulkBarOf, phoneBarOf, type BulkFacts } from './model'

// The DS Modal and the review draw in a portal in the browser; on the server render of a test they are drawn in place.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), children as never, footer as never) : null
  return { ...actual, Modal }
})
vi.mock('@nexus/ui/patterns', async (original) => {
  const actual = await original<typeof import('@nexus/ui/patterns')>()
  const ReviewChangesModal = (props: import('@nexus/ui/patterns').ReviewChangesModalProps) =>
    props.open
      ? createElement(
          'section',
          { role: 'dialog' },
          createElement('h2', null, props.title),
          createElement('p', null, props.summary as ReactNode),
          createElement(actual.ReviewChangesPanel, { changes: props.changes, ...(props.state ? { state: props.state } : {}), lead: props.lead, ...(props.doneLine ? { doneLine: props.doneLine } : {}), ...(props.labels ? { labels: props.labels } : {}), ack: false, onAckChange: () => undefined }),
          createElement('button', null, props.saveLabel),
        )
      : null
  return { ...actual, ReviewChangesModal }
})

/**
 * F-PR-23b — Approve N and Ask N on My production (production plan §3 "Bulk asks", "Bulk 'Approve' cannot be undone; the dialog
 * says so before Send"; lead picks L25, L26; R-50; walls PW-12, PW-15): Approve = one list of the approvals waiting on the picked
 * orders, each with its photo or PDF, ticked one by one, one typed name, rows the person may not answer held with why, no Undo and
 * the words before Send; Ask ▾ = the kinds the customer's limits open (pause, cancel, resume; urgent only through Mark urgent), one
 * request per order with its impact, one batch, each answered by us; "Ask us" on one row opens the order's Ask dialog at Urgent;
 * the change asks a colour (B-PR-27a). Brand Beta's dialogs hold nothing of Brand Alpha and never the office's series. Made up.
 */

const tr = (locale: Locale, ns: string) => createTranslator(locale, CATALOGUE[locale][ns] ?? {})
const en = tr('en', NS)
const it_ = tr('it', NS)
const enOrders = tr('en', ORDERS_NS)
const w = (text: string) => ({ it: text, en: text })
const day = (iso: string) => iso
const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`
const OFFICE_SERIES = /\b(?:SO|INQ|QT|RQ|WO)-\d{4}-\d+/
const B1 = 'b1b1b1b1-0000-4000-8000-000000000501'
const B2 = 'b1b1b1b1-0000-4000-8000-000000000502'

function urgency(over: Partial<Urgency> = {}): Urgency {
  return { code: 'REGULAR', words: w('Regular'), urgentRank: null, asked: false, askedWords: null, byUs: false, byUsWords: null, locked: false, lockWords: null, ...over }
}
function row(id: string, seq: number, over: Partial<ProductionRow> = {}): ProductionRow {
  return {
    id,
    customerRef: `${BRAND_BETA.customerRef}-${seq}`,
    number: BRAND_BETA.numbers.order,
    yourNumber: customerNumberOf('ORDER', seq),
    orderedOn: '2026-10-05',
    styles: [{ code: BRAND_BETA.numbers.style, name: 'Rider jacket' }],
    pieces: 40,
    promiseDate: '2026-12-02',
    originalPromiseDate: null,
    promiseMoved: false,
    stage: { code: 'SEWING', words: w('Sewing'), since: '2026-11-10', next: null },
    health: null,
    waiting: { code: 'YOU', words: w('Waiting on you'), since: '2026-11-15' },
    marks: { onHold: false, paused: false, partlyShipped: false, changePending: false, words: [] },
    urgency: urgency(),
    next: null,
    count: null,
    ...over,
  }
}
const FACTS: BulkFacts = { urgencyOn: true, mayMark: true, mayAsk: true, mayReport: true, mayFiles: true, preview: false, offline: false, busy: false, mayApprove: true, mayAnswer: true, askKinds: ['HOLD', 'CANCEL'] }

describe('the bar: Approve and Ask ▾ (at most five actions)', () => {
  it('Approve counts the picked orders waiting on you; held when none waits, or for a role that does not answer', () => {
    const rows = [row(B1, 1), row(B2, 2, { waiting: { code: 'US', words: w('Waiting on us'), since: null } })]
    const bar = bulkBarOf(rows, 2, FACTS, en)
    expect(bar.actions.map((action) => action.id)).toEqual(['URGENT', 'REGULAR', 'TOP', 'APPROVE'])
    expect(bar.actions.find((action) => action.id === 'APPROVE')).toMatchObject({ label: 'Approve 1', held: null })
    expect(bulkBarOf(rows.slice(1), 2, FACTS, en).actions.find((action) => action.id === 'APPROVE')).toMatchObject({ label: 'Approve', held: 'Nothing waits for your answer on the orders you picked.' })
    expect(bulkBarOf(rows, 2, { ...FACTS, mayAnswer: false }, en).actions.find((action) => action.id === 'APPROVE')?.held).toBe('Your role reads approvals; answering them needs the Buyer or Production role.')
    expect(bar.actions.length + (bar.ask ? 1 : 0)).toBeLessThanOrEqual(5)
  })

  it('Ask ▾ offers only the kinds the limits open (urgent never: Mark urgent asks it); held while they are read; a phone puts them in More ▾', () => {
    const bar = bulkBarOf([row(B1, 1)], 1, FACTS, en)
    expect(bar.ask?.map((action) => [action.id, action.label])).toEqual([
      ['ASK_HOLD', 'Ask to pause'],
      ['ASK_CANCEL', 'Ask to cancel'],
    ])
    expect(bulkBarOf([row(B1, 1)], 1, { ...FACTS, askKinds: null }, en).ask?.every((action) => action.held === 'Reading what your orders allow…')).toBe(true)
    expect(bulkBarOf([row(B1, 1)], 1, { ...FACTS, mayAsk: false }, en).ask).toBeNull()
    expect(phoneBarOf(bar).more.map((action) => action.id)).toEqual(['TOP', 'APPROVE', 'ASK_HOLD', 'ASK_CANCEL', 'REPORT', 'FILES', 'EXPORT'])
    // The limits: HOLD and RESUME as its list opens them; CANCEL by the company's cut-offs, always.
    const rules = rulesOf({ asks: [{ kind: 'HOLD', words: w('Pause'), open: false, verdict: { possible: false, code: 'NOT_OPEN', day: null, words: w('x') }, waitingRequestId: null }, { kind: 'RESUME', words: w('Resume'), open: true, verdict: { possible: false, code: 'NOT_PAUSED', day: null, words: w('x') }, waitingRequestId: null }] })
    expect(askKindsOf(rules)).toEqual(['CANCEL', 'RESUME'])
    expect(askKindsOf(null)).toEqual(['CANCEL'])
  })

  it('"Ask us" on one row opens the order’s Ask dialog at Urgent, only over the limit or from Cutting; never on our lock or an ask waiting', () => {
    const use = { used: 1, max: 3, agreed: 0, left: 2, over: false, words: w('1 of 3 urgent used') }
    const facts = { urgencyOn: true, mayAsk: true, use }
    expect(askUsHrefOf(`/p/${BRAND_BETA.code}`, row(B1, 1), facts)).toBe(`/p/${BRAND_BETA.code}/orders/${B1}?tab=status&ask=RUSH`)
    expect(askUsHrefOf('/p/X', row(B1, 1, { stage: { code: 'PREPARING', words: w('Preparing'), since: null, next: null } }), facts)).toBeNull()
    expect(askUsHrefOf('/p/X', row(B1, 1, { stage: { code: 'PREPARING', words: w('Preparing'), since: null, next: null } }), { ...facts, use: { ...use, used: 3, left: 0 } })).toBe(`/p/X/orders/${B1}?tab=status&ask=RUSH`)
    expect(askUsHrefOf('/p/X', row(B1, 1, { urgency: urgency({ locked: true }) }), facts)).toBeNull()
    expect(askUsHrefOf('/p/X', row(B1, 1, { urgency: urgency({ asked: true }) }), facts)).toBeNull()
    expect(askUsHrefOf('/p/X', row(B1, 1), { ...facts, mayAsk: false })).toBeNull()
    expect(askUsHrefOf('/p/X', row(B1, 1), { ...facts, urgencyOn: false })).toBeNull()
  })
})

// ---- Approve N ------------------------------------------------------------------------------------------------------------------
function review(over: Partial<ApprovalsToReview> = {}): ApprovalsToReview {
  const order = (orderId: string) => ({ orderId, number: BRAND_BETA.numbers.order, customerRef: null })
  return {
    orders: [
      { ...order(B1), waiting: 2 },
      { ...order(B2), waiting: 1 },
    ],
    items: [
      { requestId: 'r-sample', version: 2, kind: 'SAMPLE', words: { it: 'Campione · PP · BX-200', en: 'Sample · PP · BX-200' }, question: 'Do you approve the PP sample?', dueAt: '2026-11-20T10:00:00.000Z', orders: [order(B1), order(B2)], facts: [{ label: 'Colour', value: 'Sand' }], files: [{ id: 'f-1', originalName: 'pp-sample.jpg', contentType: 'image/jpeg', sizeBytes: 2048 }, { id: 'f-2', originalName: 'pp-sample.pdf', contentType: 'application/pdf', sizeBytes: 4096 }], may: { approve: true, held: null } },
      { requestId: 'r-counter', version: 1, kind: 'COUNTER_OFFER', words: w('Counter-offer · #4'), question: 'Do you accept our suggestion?', dueAt: '2026-11-21T10:00:00.000Z', orders: [order(B1)], facts: [], files: [], may: { approve: false, held: 'Waiting for your buyer' } },
    ],
    more: true,
    notFound: 1,
    undo: { it: 'Un’approvazione firmata non si può annullare qui. Per cambiarla, scriveteci.', en: 'A signed approval cannot be undone here. To change it, write to us.' },
    ...over,
  }
}
const names = new Map([
  [B1, `${BRAND_BETA.customerRef}-1 · Your order 1`],
  [B2, `${BRAND_BETA.customerRef}-2 · Your order 2`],
])
const nameOf = (id: string) => names.get(id) ?? null

describe('Approve N: one list, ticked one by one, one typed name, no Undo', () => {
  it('each approval once with its orders by their own names (never the office’s number), its files; a row held with why', () => {
    const rows = approveRowsOf(review(), nameOf, 'en', en)
    expect(rows[0]).toMatchObject({ id: 'r-sample', label: 'Sample · PP · BX-200', orders: `${BRAND_BETA.customerRef}-1 · Your order 1, ${BRAND_BETA.customerRef}-2 · Your order 2`, held: null })
    expect(rows[0]?.files).toEqual([
      { id: 'f-1', name: 'pp-sample.jpg', picture: true, pdf: false },
      { id: 'f-2', name: 'pp-sample.pdf', picture: false, pdf: true },
    ])
    expect(rows[1]?.held).toBe('Waiting for your buyer')
    expect(JSON.stringify(rows)).not.toContain(BRAND_BETA.numbers.order)
    // Only rows this person may answer stay ticked.
    expect(keepTicked(['r-sample', 'r-counter', 'gone'], rows)).toEqual(['r-sample'])
  })

  it('Approve waits for a tick, the role, the connection; it sends each ticked one at the version read and the one name', () => {
    const facts = { preview: false, offline: false, mayAnswer: true, sending: false }
    expect(approveHeldOf([], facts, en)).toBe('Tick at least one approval first.')
    expect(approveHeldOf(['r-sample'], { ...facts, mayAnswer: false }, en)).toBe('Your role reads approvals; answering them needs the Buyer or Production role.')
    expect(approveHeldOf(['r-sample'], { ...facts, preview: true }, en)).toBe('A preview reads only.')
    expect(approveHeldOf(['r-sample'], facts, en)).toBeNull()
    expect(approveBodyOf(review(), ['r-sample'], '  Berta Becker ')).toEqual({ items: [{ requestId: 'r-sample', version: 2 }], typedName: 'Berta Becker' })
  })

  it('after Send one result per approval; 409 names each in our words; no answer: the ticks stay and Approve tries again', () => {
    const rows = approveRowsOf(review(), nameOf, 'en', en)
    const answer: ApproveManyAnswer = { results: [{ requestId: 'r-sample', kind: 'SAMPLE', done: true, status: 'APPROVED', code: null, words: { it: 'Approvato.', en: 'Approved.' } }], notFound: 0, replayed: false }
    const results = approveResultsOf(rows, ['r-sample'], answer, 'en', en)
    expect(results).toEqual([{ id: 'r-sample', label: 'Sample · PP · BX-200', ok: true, words: 'Approved.', tone: 'success' }])
    expect(approveDoneLineOf(results, en)).toEqual({ line: '1 approved', tone: 'success' })
    const refused = approveRefusalOf(rows, ['r-sample'], new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/items/0/CHANGED', message: 'English' }]), en)
    expect(refused.results?.[0]?.words).toBe('It changed since you opened the list: read it again.')
    expect(approveRefusalOf(rows, ['r-sample'], new ApiError('unavailable', 503, 'unavailable', 'x', null, []), en)).toEqual({ results: null, problem: 'Not sent: we could not be reached. Approve again: nothing is answered twice.' })
  })

  it('Brand Beta’s dialog: its approvals, the no-Undo words before the typed name, nothing of Brand Alpha, never the office’s series', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = tr(locale, NS)
      const list = review()
      const model: BulkApproveDialogModel = { state: 'ready', readProblem: null, orders: 2, rows: approveRowsOf(list, nameOf, locale, words), ticked: ['r-sample'], more: `/p/${BRAND_BETA.code}/waiting`, undo: list.undo[locale], phase: 'edit', held: null, problem: null, results: null, doneLine: null, file: null }
      const html = render(createElement(BulkApproveDialog, { model }), locale)
      const text = textOf(html)
      expect(text).toContain(list.undo[locale])
      expect(text).toContain(locale === 'en' ? 'Approve 1' : 'Approvate 1')
      // The held row says why in the API's words (the fixture's).
      expect(text).toContain('Waiting for your buyer')
      expect(text).toContain(`${BRAND_BETA.customerRef}-1 · Your order 1`)
      expect(scanText(html, BRAND_ALPHA), locale).toEqual([])
      expect(html.match(OFFICE_SERIES)?.[0] ?? null, locale).toBeNull()
    }
  })
})

// ---- Ask N ---------------------------------------------------------------------------------------------------------------------
const betaRules = (over: Partial<ChangeRules> = {}): ChangeRules =>
  rulesOf({
    order: { ...rulesOf().order, number: BRAND_BETA.numbers.order, customerRef: BRAND_BETA.customerRef },
    addresses: [],
    openRequestId: null,
    cancel: { possible: true, code: 'FREE', day: null, words: w('Free') },
    asks: [
      { kind: 'HOLD', words: w('Pause'), open: true, verdict: { possible: true, code: 'FREE', day: null, words: w('Free') }, waitingRequestId: null },
      { kind: 'RESUME', words: w('Resume'), open: true, verdict: { possible: false, code: 'NOT_PAUSED', day: null, words: w('The order is not paused.') }, waitingRequestId: null },
    ],
    ...over,
  })
const impact = (over: Partial<ImpactRead['impact']> = {}, fee?: number): ImpactRead => ({ asOf: '2026-11-18T09:00:00.000Z', impact: { kind: 'HOLD', frozen: [], blocked: false, priced: false, earliest: null, notes: [], ...over }, ...(fee !== undefined ? { cancelFee: { currency: 'EUR', totalFee: fee } } : {}) })
const askWords = { locale: 'en' as const, t: en, tOrders: enOrders, day, money }

describe('Ask N: the kinds the limits open, one request per order with its impact, one batch', () => {
  it('each order by its own rules: may be asked, or why not in our words (not open, waiting, a request waits already)', () => {
    expect(askVerdictOf('HOLD', betaRules(), 'en', enOrders, day, en)).toEqual({ possible: true })
    expect(askVerdictOf('RESUME', betaRules(), 'en', enOrders, day, en)).toEqual({ possible: false, why: 'The order is not paused.' })
    const waiting = betaRules({ asks: [{ kind: 'HOLD', words: w('Pause'), open: true, verdict: { possible: false, code: 'WAITING', day: '2026-11-16', words: w('x') }, waitingRequestId: 'q-1' }] })
    expect(askVerdictOf('HOLD', waiting, 'en', enOrders, day, en)).toEqual({ possible: false, why: 'Your request of 2026-11-16 waits for our answer.' })
    expect(askVerdictOf('HOLD', betaRules({ asks: [] }), 'en', enOrders, day, en)).toEqual({ possible: false, why: "This request is not open for your orders. Write to us in the order's conversation." })
    expect(askVerdictOf('CANCEL', betaRules({ openRequestId: 'q-2' }), 'en', enOrders, day, en)).toEqual({ possible: false, why: 'A change or cancel request waits on this order already.' })
  })

  it('the impact in one line: frozen or not, the cost (an amount only for a price role), what a pause means; blocked cannot be asked', () => {
    expect(impactLineOf('HOLD', impact(), money, enOrders)).toEqual({ line: 'Nothing you ask is frozen. No price applies. A pause may move your date.', blocked: false })
    expect(impactLineOf('CANCEL', impact({ kind: 'CANCEL', priced: true, frozen: [{ field: 'SIZE_QUANTITY', lineId: null, line: null, size: null, state: 'CHANGE_REQUEST', words: w('Cut pieces') }] }, 29550), money, enOrders).line).toBe('Part of what you ask is frozen: it becomes a priced change. A fee of 295.50 EUR applies.')
    expect(impactLineOf('CANCEL', impact({ kind: 'CANCEL', priced: true }), money, enOrders).line).toBe('Nothing you ask is frozen. A price may apply: we will tell you.')
    expect(impactLineOf('CANCEL', impact({ kind: 'CANCEL', blocked: true, frozen: [{ field: 'SIZE_QUANTITY', lineId: null, line: null, size: null, state: 'BLOCKED', words: w('Packed') }] }), money, enOrders).blocked).toBe(true)
  })

  it('the review names each order: reading, asked of us with its impact, cannot and why; Send waits for the reads and the form', () => {
    const facts = (id: string, name: string, over: Partial<AskRowFacts> = {}): AskRowFacts => ({ id, name, now: 'Sewing', rules: { state: 'ready', rules: betaRules() }, impact: { state: 'ready', read: impact() }, ...over })
    const ready = askReviewOf('HOLD', [facts(B1, 'Your order 1'), facts(B2, 'Your order 2', { rules: { state: 'ready', rules: betaRules({ asks: [] }) }, impact: null })], askWords)
    expect(ready.rows.map((entry) => [entry.id, entry.will, entry.next])).toEqual([
      [B1, 'ASK', 'Asked: pause'],
      [B2, 'CANNOT', 'Stays as it is'],
    ])
    expect(ready.rows[0]?.note).toBe('Nothing you ask is frozen. No price applies. A pause may move your date.')
    expect(ready.send).toEqual([B1])
    const common = { preview: false, offline: false, busy: false }
    expect(askHeldOf(ready, null, common, en)).toBeNull()
    expect(askHeldOf(ready, 'bulk.ask.form.why', common, en)).toBe('Say why you want to pause, in a few words.')
    const reading = askReviewOf('HOLD', [facts(B1, 'Your order 1', { rules: { state: 'loading', rules: null } })], askWords)
    expect(askHeldOf(reading, null, common, en)).toBe('Reading what each order allows and what it means first.')
    // An order whose rules could not be read is still sent: we check it at Send.
    expect(askReviewOf('HOLD', [facts(B1, 'Your order 1', { rules: { state: 'error', rules: null } })], askWords).send).toEqual([B1])
  })

  it('the form once for every order: a pause says why; a cancel picks a reason (and words when the reason needs them)', () => {
    const reasons = betaRules().reasons
    expect(askFormProblem('HOLD', EMPTY_ASK_FORM, reasons)).toBe('bulk.ask.form.why')
    expect(askFormProblem('RESUME', EMPTY_ASK_FORM, reasons)).toBeNull()
    expect(askFormProblem('CANCEL', EMPTY_ASK_FORM, reasons)).toBe('bulk.ask.form.reason')
    expect(askFormProblem('CANCEL', { reason: '', reasonCode: 'OTHER' }, reasons)).toBe('bulk.ask.form.note')
    expect(askManyBodyOf('CANCEL', [B1, B2], { reason: ' Season over ', reasonCode: 'NOT_NEEDED' })).toEqual({ orderIds: [B1, B2], kind: 'CANCEL', reasonCode: 'NOT_NEEDED', reason: 'Season over' })
    expect(askManyBodyOf('HOLD', [B1], { reason: 'Our shop opens later', reasonCode: 'ignored' })).toEqual({ orderIds: [B1], kind: 'HOLD', reason: 'Our shop opens later' })
  })

  it('after Send one result per row; 409 in our words at each place; an id not in the answer "not found"', () => {
    const facts = (id: string): AskRowFacts => ({ id, name: id, now: 'Sewing', rules: { state: 'ready', rules: betaRules() }, impact: { state: 'ready', read: impact() } })
    const asked = askReviewOf('HOLD', [facts(B1), facts(B2)], askWords)
    const answer: AskManyAnswer = { batchId: 'batch-9', kind: 'HOLD', results: [{ orderId: B1, number: BRAND_BETA.numbers.order, customerRef: null, done: true, requestId: 'q-9', code: null, words: w('Asked: we answer you.') }], notFound: 0, replayed: false }
    const outcome = askResultsOf(asked, answer, 'en', en)
    expect(outcome.results[B1]).toEqual({ ok: true, words: 'Asked of us: we answer you.', tone: 'info' })
    expect(outcome.results[B2]).toEqual({ ok: false, words: 'Not found among your orders in production.', tone: 'danger' })
    const refused = askRefusalOf(asked, new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/orderIds/0/PAUSED', message: 'English' }, { path: 'body/orderIds/1/SOMETHING', message: 'English' }]), en, enOrders)
    expect(refused.results?.[B1]?.words).toBe('The order is paused already: ask us to resume it when you are ready.')
    expect(refused.results?.[B2]?.words).toBe('This could not be asked for this order.')
  })

  it('Brand Beta’s review names its own orders only; nothing of Brand Alpha, never the office’s series', () => {
    const facts = (id: string, name: string): AskRowFacts => ({ id, name, now: 'Sewing', rules: { state: 'ready', rules: betaRules() }, impact: { state: 'ready', read: impact() } })
    for (const locale of ['it', 'en'] as const) {
      const words = { locale, t: tr(locale, NS), tOrders: tr(locale, ORDERS_NS), day, money }
      const reviewed = askReviewOf('HOLD', [facts(B1, `${BRAND_BETA.customerRef}-1 · Your order 1`), facts(B2, `${BRAND_BETA.customerRef}-2 · Your order 2`)], words)
      const model: AskManyReviewModel = { kind: 'HOLD', title: 'x', lead: 'y', rows: reviewed.rows, form: EMPTY_ASK_FORM, reasons: [], formProblem: null, phase: 'ready', results: null, doneLine: null, save: 'Ask for 2', held: null, problem: null, undo: null }
      const html = render(createElement(AskManyReview, { model }), locale)
      expect(textOf(html)).toContain(`${BRAND_BETA.customerRef}-2 · Your order 2`)
      expect(scanText(html, BRAND_ALPHA), locale).toEqual([])
      expect(html.match(OFFICE_SERIES)?.[0] ?? null, locale).toBeNull()
    }
  })
})

// ---- the change asks a colour (B-PR-27a #1626: the portal's Ask dialog replaces "write to us" with the real option) --------------
describe('the change asks another colourway of the line’s style', () => {
  const RED = { id: 'cw-red', code: 'RED', name: 'Red', sizes: ['46', '48', '50', '52', '54'] }
  const withColours = (): ChangeRules => {
    const base = rulesOf()
    return { ...base, lines: base.lines.map((line, index) => (index === 1 ? { ...line, colourways: [RED] } : line)) }
  }

  it('a colourway its style offers is asked (only its own lines); another one is never named; the change asks something', () => {
    const rules = withColours()
    const line = rules.lines[1]!.lineId
    const draft = { ...EMPTY_CHANGE, colourways: { [line]: RED.id, [rules.lines[0]!.lineId]: 'cw-not-offered', 'another-line': RED.id } }
    expect(colourwaysAsked(rules, draft)).toEqual([{ lineId: line, colourwayId: RED.id }])
    const body = changeBodyOf(rules, draft)
    expect(body.colourways).toEqual([{ lineId: line, colourwayId: RED.id }])
    expect(changeAsksSomething(body)).toBe(true)
    expect(changeBodyOf(rules, EMPTY_CHANGE).colourways).toBeUndefined()
  })

  it('a colourway not made in a size the line keeps holds Send, in words', () => {
    const rules = withColours()
    const line = rules.lines[1]!
    const narrow = { ...RED, sizes: ['46', '48'] }
    const only = { ...rules, lines: rules.lines.map((entry) => (entry.lineId === line.lineId ? { ...entry, colourways: [narrow] } : entry)) }
    const draft = { ...EMPTY_CHANGE, colourways: { [line.lineId]: narrow.id } }
    expect(colourSizeProblems(only, draft).map((problem) => problem.size)).toEqual(['50', '52'])
    expect(changeHeld(only, draft, { mayAsk: true, preview: false, offline: false, busy: false })).toBe('change.problem.colourSizes')
    expect(CATALOGUE.en[ORDERS_NS]!['change.problem.colourSizes']).toBe('The colourway you picked is not made in every size you keep: set those sizes to 0 or pick another colourway.')
  })
})

describe('the words', () => {
  it('bell and mail words of an urgent ask answered are the API’s, topic PRODUCTION, in both languages (B-PR-31)', () => {
    for (const key of ['portal.production.rush_accepted', 'portal.production.rush_refused'] as const) {
      const template = PARTNER_MESSAGE_TEMPLATES[key]
      expect(template.topic, key).toBe('PRODUCTION')
      expect(template.en, key).toBeTruthy()
      expect(template.it, key).toBeTruthy()
    }
  })

  it('portal-waiting has the same keys and placeholders in both languages; the new Italian words are "voi"', () => {
    const itWords = CATALOGUE.it[WAITING_NS]!
    const enWords = CATALOGUE.en[WAITING_NS]!
    expect(Object.keys(itWords).sort()).toEqual(Object.keys(enWords).sort())
    for (const key of Object.keys(enWords)) expect((itWords[key]!.match(/\{\w+\}/g) ?? []).sort(), key).toEqual((enWords[key]!.match(/\{\w+\}/g) ?? []).sort())
    const tu = /\b(tu|tuo|tua|tuoi|tue|ti|te|hai|puoi|sei|vuoi|devi|chiedi)\b/i
    for (const [key, value] of [...Object.entries(itWords), ...Object.entries(CATALOGUE.it[NS] ?? {})]) if (key.startsWith('bulk.')) expect(value, key).not.toMatch(tu)
    expect(it_('bulk.ask.HOLD')).toBe('Chiedete una pausa')
  })
})
