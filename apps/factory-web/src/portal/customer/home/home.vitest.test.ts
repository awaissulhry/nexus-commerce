import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import type { ApprovalRead, DocumentsRead, HomeRead, OrdersRead } from './api'
import { homeBandOf } from './band'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { CustomerHomeView, type CustomerHomeViewModel, type StartModel } from './view/CustomerHomeView'
import { designScreen } from './fixtures'
// B-TH-238: the Messages card — its model, Brand Beta's case data, and the portal's own reads.
import type { ApiClient } from '../../../lib/api/client'
import { readUnreadWith } from '../../../lib/last-message-cell/api'
import { fetchRequests } from '../requests/api'
import { REQUESTS as BETA_REQUESTS } from '../requests/design-data'
import { fetchRecentMessages } from './api'
import { betaMessagesOf } from './fixtures'
import { messagesCardOf, messagesCountsOf, messagesEmpty } from './model'
import {
  answerProblem,
  answerRefusal,
  approvalIds,
  approvalOfTask,
  approvalTitle,
  commentNeeded,
  decisionsOf,
  documentRows,
  isFirstVisit,
  neighbourOf,
  nextOrderRows,
  orderCounts,
  readRecent,
  referenceOf,
  replyHref,
  requestHeld,
  tilesFor,
  tilesOf,
  withRecent,
} from './model'

/**
 * SCR-183 › the customer's Home (B-W2b-187), pure: the five numbers and where each opens (a page not built yet is a count
 * without a link; a page the person cannot open is no tile; the Finance tile's amount only with prices), the next deliveries
 * as the customer reads them, the new documents, Reply, the rows the Approve pop-up answers and its rules, the first visit,
 * the recent searches, the band — and every design case drawn in Italian and English with no raw key.
 */

const UUID = (n: number) => `0190f0e2-1830-7000-8000-${String(n).padStart(12, '0')}`
const everything = () => true
const NONE_BUILT = { orders: false, documents: false, returns: false }
const ALL_BUILT = { orders: true, documents: true, returns: true }

const HOME: HomeRead = {
  asOf: '2026-11-08T09:42:00.000Z',
  kind: 'CUSTOMER',
  counts: [
    { key: 'orders.open', area: 'orders', words: { it: '', en: '' }, value: 7 },
    { key: 'orders.in_production', area: 'orders', words: { it: '', en: '' }, value: 0 },
    { key: 'orders.shipping_this_week', area: 'orders', words: { it: '', en: '' }, value: 120 },
    { key: 'invoices.to_pay', area: 'documents', words: { it: '', en: '' }, value: 2 },
    { key: 'invoices.overdue', area: 'documents', words: { it: '', en: '' }, value: 1 },
    { key: 'returns.open', area: 'returns', words: { it: '', en: '' }, value: null },
  ],
  live: { events: [] },
}

describe('at a glance', () => {
  it('five numbers: open, in production, shipping this week, invoices to pay, open claims', () => {
    expect(tilesFor(NONE_BUILT, everything).map((tile) => tile.key)).toEqual(['orders.open', 'orders.in_production', 'orders.shipping_this_week', 'invoices.to_pay', 'returns.open'])
    // A Quality colleague who sees complaints but not returns counts its complaints.
    expect(tilesFor(NONE_BUILT, (permission) => permission !== 'portal.returns.view').at(-1)?.key).toBe('returns.complaints_open')
  })

  it('a tile opens its list once that page is built; a count that could not be read is null, never 0', () => {
    expect(tilesFor(NONE_BUILT, everything).every((tile) => tile.href === null)).toBe(true)
    expect(tilesFor(ALL_BUILT, everything).map((tile) => tile.href)).toEqual(['/orders?chip=OPEN', '/orders?chip=IN_PRODUCTION', '/orders?chip=OPEN', '/documents?group=FINANCE', '/returns'])
    const tiles = tilesOf(tilesFor(NONE_BUILT, everything), HOME, everything)
    expect(tiles.find((tile) => tile.key === 'orders.in_production')?.value).toBe(0)
    expect(tiles.find((tile) => tile.key === 'returns.open')?.value).toBeNull()
    expect(tilesOf(tilesFor(NONE_BUILT, everything), null, everything).every((tile) => tile.value === null)).toBe(true)
  })

  it('fails closed: no tile for a page the person cannot open (a buyer sees no invoices)', () => {
    const buyer = (permission: string) => permission !== 'portal.payments.view'
    expect(tilesOf(tilesFor(NONE_BUILT, buyer), HOME, buyer).map((tile) => tile.key)).not.toContain('invoices.to_pay')
    expect(tilesOf(tilesFor(NONE_BUILT, () => false), HOME, () => false)).toEqual([])
  })

  it('the Finance tile says the open amount and the overdue count, only with prices', () => {
    const money = { openItems: { byCurrency: [{ currency: 'EUR', open: 1_245_000, overdue: 320_000 }], counts: { invoices: 2, overdue: 1, deposits: 0 } }, format: (minor: number, currency: string) => `${currency} ${minor / 100}` }
    const tile = tilesOf(tilesFor(NONE_BUILT, everything), HOME, everything, money).find((entry) => entry.key === 'invoices.to_pay')!
    expect(tile).toMatchObject({ value: 2, tone: 'danger', amount: { open: 'EUR 12450', overdue: 1 } })
    // Without the amounts (the API drops them without the price grain): the counts stay, no amount.
    const blind = tilesOf(tilesFor(NONE_BUILT, everything), HOME, everything, { ...money, openItems: { ...money.openItems, byCurrency: [{ currency: 'EUR' }] } }).find((entry) => entry.key === 'invoices.to_pay')!
    expect(blind.amount).toEqual({ open: '', overdue: 1 })
    expect(tilesOf(tilesFor(NONE_BUILT, everything), HOME, everything, null).find((entry) => entry.key === 'invoices.to_pay')?.amount).toEqual({ open: '', overdue: 1 })
    expect(tilesOf(tilesFor(NONE_BUILT, everything), { ...HOME, counts: HOME.counts.filter((count) => count.key !== 'invoices.overdue') }, everything, null).find((entry) => entry.key === 'invoices.to_pay')?.amount).toBeNull()
  })
})

const ORDERS: OrdersRead = {
  asOf: '2026-11-08T09:42:00.000Z',
  progressShared: true,
  chips: [
    { chip: 'OPEN', count: 7 },
    { chip: 'ALL', count: 23 },
  ],
  count: 7,
  items: [
    { kind: 'ORDER', id: UUID(1), customerRef: 'PO-1', number: 'SO-1', yourNumber: { seq: 12, words: { en: 'Your order 12', it: 'Il vostro ordine 12' } }, status: 'IN_PRODUCTION', promiseDate: '2026-11-20', originalPromiseDate: '2026-11-13', promiseMoved: true, requestedDate: '2026-11-10', pieces: { ordered: 70, shipped: 0, open: 70 }, nextShipment: null, progressPercent: 45 },
    { kind: 'REQUEST', id: UUID(2), customerRef: 'PO-2', number: 'RQ-1', status: 'REQUESTED', promiseDate: null, originalPromiseDate: null, promiseMoved: false, requestedDate: '2026-12-01', pieces: { ordered: 10, shipped: 0, open: 10 }, nextShipment: null, progressPercent: null },
  ],
  live: { events: [] },
}

describe('your next deliveries', () => {
  it('their PO first, the six steps from the status, the promise and how it moved, the % where shared', () => {
    const [order, request] = nextOrderRows(ORDERS, 'en', '/p/X', (day) => day)
    // B-TH-303: the customer's own number, never the office's series.
    expect(order).toMatchObject({ theirs: 'PO-1', ours: '12', oursLabel: 'Your order', promise: '2026-11-20', moved: { from: '2026-11-13', to: '2026-11-20' }, progress: 45, href: `/p/X/open/SalesOrder/${UUID(1)}` })
    expect(order!.steps.map((step) => [step.id, step.state, step.current])).toEqual([
      ['REQUESTED', 'done', false],
      ['CONFIRMED', 'done', false],
      ['IN_PRODUCTION', 'done', true],
      ['READY', 'todo', false],
      ['SHIPPED', 'todo', false],
      ['DELIVERED', 'todo', false],
    ])
    expect(order!.steps[2]!.label).toBe('In production')
    // A request has no page of its own yet, no promise; it says the date they asked for.
    expect(nextOrderRows(ORDERS, 'it', '/p/X', (day) => day)[0]).toMatchObject({ ours: '12', oursLabel: 'Il vostro ordine' })
    expect(request).toMatchObject({ kind: 'REQUEST', ours: null, oursLabel: null, href: null, promise: null, requested: '2026-12-01', moved: null, progress: null })
  })

  it('no % when the account does not share progress (C1); "see all" counts the Open chip; any order at all for the first visit', () => {
    expect(nextOrderRows({ ...ORDERS, progressShared: false }, 'en', '/p/X', (day) => day)[0]!.progress).toBeNull()
    expect(orderCounts(ORDERS)).toEqual({ open: 7, all: 23 })
    expect(orderCounts(null)).toEqual({ open: null, all: null })
    expect(nextOrderRows(null, 'en', '/p/X', (day) => day)).toEqual([])
  })
})

describe('new documents', () => {
  const read: DocumentsRead = {
    asOf: '2026-11-08T09:42:00.000Z',
    count: 2,
    newCount: 2,
    lastVisitAt: null,
    items: [
      { id: UUID(10), kind: 'DECLARATION_OF_CONFORMITY', kindWords: { it: 'D', en: 'D' }, group: 'CONFORMITY', title: { it: 'Dichiarazione', en: 'Declaration' }, for: { type: 'Shipment', id: UUID(11), label: 'SH-1', order: { id: UUID(12), number: 'SO-1', customerRef: 'PO-1' } }, date: '2026-11-07T10:00:00.000Z', version: 3, fingerprint: 'abc', language: 'it', current: true, replacedBy: null, new: true, files: [{ fileId: UUID(10), format: 'PDF', name: 'doc.pdf', contentType: 'application/pdf', sizeBytes: 1000 }] },
      { id: UUID(20), kind: 'INVOICE', kindWords: { it: 'F', en: 'I' }, group: 'FINANCE', title: { it: 'Fattura', en: 'Invoice' }, for: { type: 'Invoice', id: UUID(21), label: 'FT-1', order: null }, date: '2026-11-06T10:00:00.000Z', version: 1, fingerprint: 'def', language: null, current: true, replacedBy: null, new: true, files: [{ fileId: UUID(20), format: 'XML', name: 'ft.xml', contentType: 'application/xml', sizeBytes: 900 }] },
    ],
    live: { events: [] },
  }

  it('the title in the page’s language, what it is for, NEW, and whether it can be previewed', () => {
    const [declaration, invoice] = documentRows(read, 'it')
    expect(declaration).toMatchObject({ title: 'Dichiarazione', forWords: { key: 'documents.forOrder', params: { number: 'PO-1 · SO-1' } }, isNew: true, previewable: true, version: 3 })
    expect(invoice).toMatchObject({ title: 'Fattura', forWords: { key: 'documents.for', params: { label: 'FT-1' } }, previewable: false })
  })

  it('J / K stop at the ends (the versions are the lifted pop-up’s: documents/preview)', () => {
    expect(neighbourOf(['a', 'b', 'c'], 'b', 1)).toBe('c')
    expect(neighbourOf(['a', 'b', 'c'], 'a', -1)).toBeNull()
    expect(neighbourOf(['a'], 'z', 1)).toBeNull()
  })
})

describe('What waits for you and the Approve pop-up', () => {
  it('Approve and Review rows name their request; every other row keeps its own verb', () => {
    expect(approvalOfTask({ kind: 'APPROVE', href: `/p/X/open/ApprovalRequest/${UUID(1)}#task:t` })).toBe(UUID(1))
    expect(approvalOfTask({ kind: 'RECONFIRM_ORDER', href: `/p/X/open/ApprovalRequest/${UUID(2)}` })).toBe(UUID(2))
    expect(approvalOfTask({ kind: 'UPLOAD_DOCUMENT', href: `/p/X/open/ApprovalRequest/${UUID(3)}` })).toBeNull()
    expect(approvalOfTask({ kind: 'APPROVE', href: `/p/X/open/SalesOrder/${UUID(4)}` })).toBeNull()
    const groups = [{ rows: [{ kind: 'RECONFIRM_ORDER', href: `/open/ApprovalRequest/${UUID(1)}` }, { kind: 'UPLOAD_DOCUMENT', href: '/open/SalesOrder/x' }] }, { rows: [{ kind: 'APPROVE', href: `/open/ApprovalRequest/${UUID(2)}`, done: { canUndo: false } }, { kind: 'APPROVE', href: `/open/ApprovalRequest/${UUID(3)}` }] }]
    expect(approvalIds(groups)).toEqual([UUID(1), UUID(3)])
  })

  const page = (over: Partial<ApprovalRead['request']> = {}, may: Partial<ApprovalRead['may']> = {}): ApprovalRead => ({
    request: { id: UUID(1), kind: 'PROOF', label: 'SO-2026-0042 · line 2', question: 'Check the names.', from: { companyName: 'Pelletteria Esempio' }, dueAt: '2026-11-10T16:00:00.000Z', status: 'OPEN', answer: null, version: 1, ...over },
    content: { facts: [], revisedOrder: null },
    files: [],
    may: { answer: true, withChanges: true, ...may },
    locale: 'en',
  })

  it('the decisions the kind allows, words where the answer needs them, the checks in order', () => {
    expect(decisionsOf(page())).toEqual(['APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED'])
    expect(decisionsOf(page({}, { withChanges: false }))).toEqual(['APPROVED', 'REFUSED'])
    expect(commentNeeded('APPROVED')).toBe(false)
    expect(commentNeeded('REFUSED')).toBe(true)
    expect(answerProblem(null, '')).toEqual({ key: 'approve.problem.choose', field: 'decision' })
    expect(answerProblem('REFUSED', '  ')).toEqual({ key: 'approve.problem.why', field: 'comment' })
    expect(answerProblem('APPROVED_WITH_CHANGES', '')).toEqual({ key: 'approve.problem.what', field: 'comment' })
    expect(answerProblem('APPROVED', 'x'.repeat(4001))).toEqual({ key: 'approve.problem.long', field: 'comment' })
    expect(answerProblem('APPROVED', '')).toBeNull()
  })

  it('refusals in our words; a request answered or closed holds the answer; the title never shows the API’s English', () => {
    expect(answerRefusal('conflict')).toEqual({ key: 'approve.problem.changed', reload: true })
    expect(answerRefusal('not_found')).toEqual({ key: 'approve.problem.gone', gone: true })
    expect(answerRefusal(null)).toEqual({ key: 'approve.problem.internal' })
    expect(requestHeld(page())).toBeNull()
    expect(requestHeld(page({ status: 'APPROVED' }, { answer: false }))).toBe('held.answered')
    expect(requestHeld(page({ status: 'WITHDRAWN' }, { answer: false }))).toBe('held.closed')
    expect(referenceOf('SO-2026-0042 · line 2')).toBe('SO-2026-0042')
    const t = (key: string, params?: Readonly<Record<string, string | number>>) => `${key}${params ? JSON.stringify(params) : ''}`
    expect(approvalTitle(page(), t)).toBe('approve.title{"kind":"kind.PROOF","label":"SO-2026-0042"}')
  })
})

describe('the rest of Home', () => {
  it('Reply opens the record’s Messages: its own page once built, else the frame’s record page', () => {
    const conversation = { record: { type: 'SalesOrder', id: 'so1', theirRef: null, ourRef: 'SO-1', subtitle: null, status: null } }
    expect(replyHref('/p/X', conversation, () => null)).toBe('/p/X/open/SalesOrder/so1#messages')
    expect(replyHref('/p/X', conversation, (_type, id) => `/orders/${id}`)).toBe('/p/X/orders/so1?tab=messages#messages')
  })

  it('the first visit: nothing waits, no order at all (or none to see), no new document', () => {
    expect(isFirstVisit({ tasks: 'ready', openTasks: 0, seesOrders: true, ordersAll: 0, newDocuments: 0 })).toBe(true)
    expect(isFirstVisit({ tasks: 'ready', openTasks: 0, seesOrders: false, ordersAll: null, newDocuments: 0 })).toBe(true)
    // B-TH-223: a request sent (or not read yet) is past the first step.
    expect(isFirstVisit({ tasks: 'ready', openTasks: 0, seesOrders: true, ordersAll: 0, newDocuments: 0, requestsAll: 1 })).toBe(false)
    expect(isFirstVisit({ tasks: 'ready', openTasks: 0, seesOrders: true, ordersAll: 0, newDocuments: 0, requestsAll: null })).toBe(false)
    expect(isFirstVisit({ tasks: 'ready', openTasks: 0, seesOrders: true, ordersAll: 0, newDocuments: 0, requestsAll: 0 })).toBe(true)
    expect(isFirstVisit({ tasks: 'ready', openTasks: 1, seesOrders: true, ordersAll: 0, newDocuments: 0 })).toBe(false)
    expect(isFirstVisit({ tasks: 'ready', openTasks: 0, seesOrders: true, ordersAll: 3, newDocuments: 0 })).toBe(false)
    expect(isFirstVisit({ tasks: 'ready', openTasks: 0, seesOrders: true, ordersAll: null, newDocuments: 0 })).toBe(false)
    expect(isFirstVisit({ tasks: 'loading', openTasks: 0, seesOrders: true, ordersAll: 0, newDocuments: 0 })).toBe(false)
    expect(isFirstVisit({ tasks: 'ready', openTasks: 0, seesOrders: true, ordersAll: 0, newDocuments: 2 })).toBe(false)
  })

  it('recent searches: newest first, no repeats, five at most, anything odd read as nothing', () => {
    expect(withRecent(['b', 'PO-1'], 'po-1')).toEqual(['po-1', 'b'])
    expect(withRecent(['1', '2', '3', '4', '5'], 'new')).toEqual(['new', '1', '2', '3', '4'])
    expect(withRecent(['x'], ' ')).toEqual(['x'])
    expect(readRecent('["PO-1", 3, "SO-2"]')).toEqual(['PO-1', 'SO-2'])
    expect(readRecent('{')).toEqual([])
    expect(readRecent(null)).toEqual([])
  })

  it('the band: Updated, the statement for Finance, E-mail settings outside a preview', () => {
    const t = (key: string) => key
    const band = homeBandOf({ t, asOf: '10:42', statement: '/api/portal/payments/statement/pdf?language=it', emailSettings: true, ordersKey: false })
    expect(band.status?.label).toBe('band.updated')
    expect(band.more?.map((item) => item.id)).toEqual(['statement', 'email'])
    expect(band.actions).toEqual([])
    expect(homeBandOf({ t, asOf: null, statement: null, emailSettings: false, ordersKey: false }).more).toEqual([])
  })
})

const KEY = /\b(band|keys|state|search|tiles|orders|documents|doc|messages|welcome|verb|held|kind|status|approve|start)\.[a-zA-Z_-]+/

describe('SCR-183 design cases', () => {
  it('every case draws in Italian and English with no raw key and made-up data only', () => {
    expect(designScreen.cases.length).toBeGreaterThanOrEqual(25)
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html, `${entry.id} (${locale})`).not.toMatch(KEY)
        expect(html, `${entry.id} (${locale})`).toContain('main-content')
        expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
      }
    }
  })

  it('the Italian page speaks Italian', () => {
    const entry = designScreen.cases.find((item) => item.id === 'buyer')!
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
    expect(html).toContain('Le tue prossime consegne')
    expect(html).toContain('Trova qualsiasi cosa')
    expect(html).not.toContain('Your next deliveries')
    expect(html).not.toContain('New documents')
  })
})

// ── B-TH-223: New order on Home (P-HOME.actions) ───────────────────────────────────────────────────────────────────
describe('B-TH-223 — Start: New order like an e-mail, or a question', () => {
  const view = (start: StartModel, locale: 'it' | 'en' = 'en') => {
    const model = { prefix: '/p/BRAND-BETA', search: null, welcome: null, tiles: null, orders: null, documents: null, messages: null, approve: null, document: null, start } as CustomerHomeViewModel
    return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['portal-customer-home', 'ds-words']) }, createElement(CustomerHomeView, { model, tasks: null })))
  }

  it('New order is the page’s main button (the e-mail-like compose), Ask a question beside it; the band has no second primary', () => {
    const html = view({ newOrderHref: '/p/BRAND-BETA/orders/new', buyer: true, admins: [], draft: null })
    expect(html).toMatch(/<a class="fw-pch-door is-primary" href="\/p\/BRAND-BETA\/orders\/new">/)
    expect(html).toContain('Ask a question')
    expect(homeBandOf({ t: (key: string) => key, asOf: null, statement: null, emailSettings: true, ordersKey: true }).actions).toEqual([])
  })

  it('a colleague without the order right reads who can give it — no dead button', () => {
    const html = view({ newOrderHref: null, buyer: false, admins: [BRAND_BETA.portalPerson.name], draft: null })
    expect(html).not.toContain('/orders/new')
    expect(html).toContain('Only the buyers of your company send orders.')
    expect(html).toContain(BRAND_BETA.portalPerson.name)
    expect(view({ newOrderHref: null, buyer: false, admins: [], draft: null })).toContain('Ask us to add a buyer for your company.')
  })

  it('a draft kept on this device: "Draft: … · Continue"; Brand Beta’s Home holds nothing of Brand Alpha', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = view({ newOrderHref: '/p/BRAND-BETA/orders/new', buyer: true, admins: [BRAND_BETA.portalPerson.name], draft: { subject: BRAND_BETA.customerRef, at: '10:42' } }, locale)
      expect(html).toContain(locale === 'en' ? `Draft: ${BRAND_BETA.customerRef}` : `Bozza: ${BRAND_BETA.customerRef}`)
      expect(html).toContain(locale === 'en' ? 'Continue' : 'Continua')
      expect(html).not.toMatch(KEY)
      expect(scanText(html, BRAND_ALPHA)).toEqual([])
    }
  })
})

// ---- B-TH-238 (P-HOME.messages; wall W05, W06, W08, W10): the Messages card ---------------------------------------------------
describe('B-TH-238 — Home’s Messages: what needs the customer first, then new messages, the account’s conversation', () => {
  const OFFICE = /\b(?:INQ|QT|SO|RQ)-\d{4}-\d{2,}/
  const renderCase = (id: string, locale: 'it' | 'en' = 'en') => {
    const entry = designScreen.cases.find((item) => item.id === id)!
    return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
  }

  it('the card’s order: requests that need the customer, then conversations with new messages, then by last message, the account last', () => {
    const card = betaMessagesOf('en').card!
    expect(card.needsYou.map((row) => row.yours)).toEqual(['Your request 7'])
    expect(card.needsYou[0]).toMatchObject({ kind: 'needsYou', href: `/p/${BRAND_BETA.code}/orders/requests/${BETA_REQUESTS[0]!.id}`, newCount: 2, last: { from: 'us' } })
    // The waiting request is not repeated among the conversations; the account's conversation is not one of them either.
    expect(card.conversations.map((row) => row.ours)).toEqual(['#12', '#3'])
    expect(card.conversations[0]).toMatchObject({ newCount: 1, last: { from: 'us' } })
    expect(card.conversations[1]).toMatchObject({ newCount: 0, last: { from: 'you' } })
    expect(card.account).toMatchObject({ kind: 'account', href: `/p/${BRAND_BETA.code}/open/Party/b2b2b2b2-0000-4000-8000-000000000299#messages`, last: { from: 'us' } })
    expect(messagesCountsOf(card)).toEqual({ needsYou: 1, newMessages: 3, conversations: 2 })
    // No request waits: its conversation joins the others; new messages first, then the newest.
    const plain = betaMessagesOf('en', { waiting: [] }).card!
    expect(plain.needsYou).toEqual([])
    expect(plain.conversations.map((row) => [row.ours, row.newCount])).toEqual([['#7', 2], ['#12', 1], ['#3', 0]])
    // Nothing yet: the account is still offered (its page opens before a first message).
    const none = betaMessagesOf('en', { waiting: [], conversations: [] }).card!
    expect(messagesEmpty(none)).toBe(true)
    expect(none.account).toMatchObject({ last: null, newCount: 0 })
  })

  it('on screen: "We need something from you" with Answer, "Last message: from you / from <company>", new marks, Write to us — it and en', () => {
    const en = renderCase('th-238-messages')
    expect(en).toContain('We need something from you · 1 request')
    expect(en).toContain('Answer')
    expect(en).toContain('2 new')
    expect(en).toContain('Last message: from Pelletteria Esempio')
    expect(en).toContain('Last message: from you')
    expect(en).toContain('Your conversation with Pelletteria Esempio')
    expect(en.indexOf('We need something from you')).toBeLessThan(en.indexOf('#12'))
    expect(en.indexOf('#12')).toBeLessThan(en.indexOf('Your conversation with'))
    const it_ = renderCase('th-238-messages', 'it')
    expect(it_).toContain('Ci serve qualcosa da voi · 1 richiesta')
    expect(it_).toContain('Ultimo messaggio: da voi')
    const none = renderCase('th-238-messages-none')
    expect(none).toContain('No messages yet.')
    expect(none).toContain('Write to us')
  })

  it('scanText: Brand Beta’s Home holds nothing of Brand Alpha and no office series', () => {
    for (const id of ['th-238-messages', 'th-238-messages-new', 'th-238-messages-none']) {
      for (const locale of ['it', 'en'] as const) {
        const html = renderCase(id, locale)
        expect(scanText(html, BRAND_ALPHA), `${id} (${locale})`).toEqual([])
        expect(html.match(OFFICE)?.[0] ?? null, `${id} (${locale})`).toBeNull()
      }
    }
  })

  it('W05/W06/W08: customer B’s Home counts never move with customer A’s orders, requests or messages (two customers, each its own reads)', async () => {
    type Json = Record<string, unknown>
    const stateOf = (code: 'NEED_INFO' | 'BEING_REVIEWED') => ({ code, words: { en: code === 'NEED_INFO' ? 'We need something from you' : 'Being reviewed', it: code === 'NEED_INFO' ? 'Ci serve qualcosa da voi' : 'In esame' }, open: true, needsYou: code === 'NEED_INFO' })
    const request = (brand: typeof BRAND_ALPHA, n: number, code: 'NEED_INFO' | 'BEING_REVIEWED') => ({
      id: `${brand.ids.order.slice(0, 24)}${String(800 + n).padStart(12, '0')}`,
      number: `INQ-2026-0${brand.key === 'alpha' ? 1 : 2}${n}`,
      yourNumber: { seq: n, words: { en: `Your request ${n}`, it: `La vostra richiesta ${n}` } },
      customerRef: brand.customerRef,
      subject: `${brand.tradeName} request ${n}`,
      state: stateOf(code),
      wantedDate: null,
      receivedAt: '2026-11-10T09:00:00.000Z',
      updatedAt: `2026-11-1${n}T09:00:00.000Z`,
      pieces: 0,
    })
    const conversation = (brand: typeof BRAND_ALPHA, type: string, recordId: string, newCount: number) => ({
      record: { type, id: recordId, theirRef: brand.customerRef, ourRef: '#1', subtitle: null, status: null },
      thread: { id: brand.ids.thread, status: 'OPEN' },
      last: { id: brand.ids.file, side: 'COMPANY', channel: 'PORTAL', authorName: null, excerpt: brand.message, attachmentCount: 0, at: '2026-11-16T09:00:00.000Z' },
      newCount,
    })
    const world: Record<'alpha' | 'beta', { requests: Json[]; conversations: Json[]; unread: Record<string, number> }> = {
      alpha: { requests: [request(BRAND_ALPHA, 1, 'NEED_INFO')], conversations: [conversation(BRAND_ALPHA, 'SalesOrder', BRAND_ALPHA.ids.order, 1)], unread: {} },
      beta: { requests: [request(BRAND_BETA, 1, 'NEED_INFO'), request(BRAND_BETA, 2, 'BEING_REVIEWED')], conversations: [conversation(BRAND_BETA, 'SalesOrder', BRAND_BETA.ids.order, 2)], unread: {} },
    }
    // The portal's own client of one sign-in: it answers that customer's rows only, as the API's partner scope does.
    const apiOf = (key: 'alpha' | 'beta') =>
      ({
        get: async (path: string, options: { schema: { parse: (value: unknown) => unknown } }) => {
          const own = world[key]
          if (path === '/portal/inquiries') return options.schema.parse({ rows: own.requests, counts: { needsYou: own.requests.filter((row) => (row.state as { needsYou: boolean }).needsYou).length, open: own.requests.length }, complete: true })
          if (path === '/portal/threads') return options.schema.parse({ conversations: own.conversations })
          throw new Error(`unexpected GET ${path}`)
        },
        post: async (path: string, options: { body: { records: { recordId: string }[] }; schema: { parse: (value: unknown) => unknown } }) => {
          if (path !== '/threads/unread') throw new Error(`unexpected POST ${path}`)
          return options.schema.parse({ counts: options.body.records.map((record) => ({ recordType: 'Inquiry', recordId: record.recordId, newCount: world[key].unread[record.recordId] ?? 0, lastAt: null })) })
        },
      }) as unknown as ApiClient
    const homeOf = async (key: 'alpha' | 'beta') => {
      const api = apiOf(key)
      const brand = key === 'alpha' ? BRAND_ALPHA : BRAND_BETA
      const waiting = await fetchRequests(api, { state: 'OPEN', limit: 50 })
      const { conversations } = await fetchRecentMessages(api)
      const counts = await readUnreadWith(api)(waiting.rows.filter((row) => row.state.needsYou).map((row) => ({ recordType: 'Inquiry', recordId: row.id })), new AbortController().signal)
      return messagesCardOf({ prefix: `/p/${brand.code}`, partyId: brand.ids.order, locale: 'en', waiting: waiting.rows, needsYouCount: waiting.counts.needsYou, conversations, unread: Object.fromEntries(counts.map((count) => [count.recordId, count.newCount])), recordPage: () => null })
    }
    world.beta.unread[(world.beta.requests[0] as { id: string }).id] = 1
    const before = messagesCountsOf(await homeOf('beta'))
    const alphaBefore = messagesCountsOf(await homeOf('alpha'))
    expect(before).toEqual({ needsYou: 1, newMessages: 3, conversations: 1 })
    // Customer A moves: a new request waits for it, new messages on its order, a new order with a message, its request read.
    world.alpha.requests.push(request(BRAND_ALPHA, 2, 'NEED_INFO'))
    ;(world.alpha.conversations[0] as { newCount: number }).newCount += 4
    world.alpha.conversations.push(conversation(BRAND_ALPHA, 'SalesOrder', BRAND_ALPHA.ids.file, 1))
    world.alpha.unread[(world.alpha.requests[0] as { id: string }).id] = 5
    const after = await homeOf('beta')
    expect(messagesCountsOf(after)).toEqual(before)
    expect(messagesCountsOf(await homeOf('alpha'))).not.toEqual(alphaBefore)
    // B's card names nothing of A (its rows, links and words are B's own).
    expect(scanText(JSON.stringify(after), BRAND_ALPHA)).toEqual([])
  })
})
// ---- end B-TH-238
