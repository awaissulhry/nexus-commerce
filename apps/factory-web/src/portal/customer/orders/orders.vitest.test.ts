import { createElement } from 'react'
// F-OP-124: the typed tracking number of a shipment card.
import { typedTrackingOf } from './model'
// F-OP-135: the typed link and a shared shipment.
import { alsoCarriesOf, typedLinkOf } from './model'
// F-SA-238: the Documents tab's grouped files (the office Files body, its customer face).
import { readFileSync } from 'node:fs'
import { renderToString } from 'react-dom/server'
import { OrderFilesBody } from '../../../lib/record-thread/files-view/view/FilesView'
import { portalFilesRead } from '../../../lib/record-thread/files-view/model'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { APPROVAL_STATUSES as DOMAIN_APPROVAL_STATUSES } from '@nexus/factory-domain/approvals-out/kinds'
import { INTENT_STATUSES as DOMAIN_INTENT_STATUSES } from '@nexus/factory-domain/payments/online/rules'
import { ORDER_REQUEST_KINDS as DOMAIN_REQUEST_KINDS, REQUEST_STATUSES as DOMAIN_REQUEST_STATUSES, VERDICT_CODES as DOMAIN_VERDICTS } from '@nexus/factory-domain/sales/change-requests/rules'
import { DEPOSIT_KINDS } from '@nexus/factory-domain/sales/quotes/quotes'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { APPROVAL_STATUSES, FAKE_SCENARIOS, INTENT_STATUSES, pickRevision, REQUEST_KINDS, REQUEST_STATUSES, VERDICT_CODES } from './api'
import { approvalPage, documentsRead, mtmRecord, orderRecord, ordersRead, ROWS, rulesOf, withoutPrices } from './design-data'
import { designScreen as listScreen } from './fixtures'
import {
  askRefusal,
  cancelBodyOf,
  cancelFeeOf,
  cancelHeld,
  changeBodyOf,
  changedCells,
  changeHeld,
  confirmationFileOf,
  documentsInOrder,
  EMPTY_CANCEL,
  EMPTY_CHANGE,
  emptiedLines,
  milestoneSteps,
  movesOf,
  neighbourOf,
  NS,
  opens,
  kindKey,
  rowHref,
  paymentStateOf,
  payHeld,
  promiseMoves,
  promiseOf,
  reconfirmHeld,
  reconfirmProblem,
  recordHref,
  shipToLines,
  tabOf,
  totalsOf,
  depositPaid, // F-OM-204
} from './model'
import { designScreen as recordScreen } from './record/fixtures'
// B-TH-223, B-TH-303: Orders & requests.
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA } from '../../../lib/testing/two-brands'
import { REQUESTS } from '../requests/design-data'
// B-TH-223 (fix-portal-1): Brand Beta's own rows; the Alpha world's codes no Beta case may carry.
import { BETA_ROWS } from './design-data'
import { listRowsOf } from './list-view-model' // pg-w2: the rows of a group (the list on the shared parts)
import type { OrdersListViewModel } from './view/OrdersListView'
import type { CustomerCaseBuilder } from './view/CustomerCase'
import type { ApiClient } from '../../../lib/api/client'

/**
 * SCR-184 (B-W2b-191): the customer's Orders & tracking, pure — the list's address and the record's tabs, the tracker's
 * steps and the promise moves, what "Ask for a change" and "Ask to cancel" send and why they wait, a refusal in our words,
 * the re-confirmation's checks, the deposit payment's state, the CSV (prices only with the grain) — the words of every code
 * in both languages, and every design case drawn in Italian and English with no raw key.
 */

const t = createTranslator('en', CATALOGUE.en[NS] ?? {})
const day = (iso: string) => iso
const FACTS = { mayAsk: true, preview: false, offline: false, busy: false }
const has = (locale: 'it' | 'en', key: string) => {
  const flat = (tree: unknown, prefix = ''): string[] =>
    typeof tree === 'object' && tree !== null ? Object.entries(tree).flatMap(([name, value]) => (typeof value === 'string' ? [prefix + name] : flat(value, `${prefix}${name}.`))) : []
  const keys = new Set(flat(CATALOGUE[locale][NS]))
  return keys.has(key) || (keys.has(`${key}_one`) && keys.has(`${key}_other`))
}

describe('the web keeps the API’s codes', () => {
  it('verdicts, request states, approval states and payment states are the domain’s', () => {
    expect(VERDICT_CODES).toEqual(DOMAIN_VERDICTS)
    expect(REQUEST_STATUSES).toEqual(DOMAIN_REQUEST_STATUSES)
    expect(APPROVAL_STATUSES).toEqual(DOMAIN_APPROVAL_STATUSES)
    expect(INTENT_STATUSES).toEqual(DOMAIN_INTENT_STATUSES)
  })

  // B-PR-23: an order's list of requests holds every kind (the production asks too) and a countered request.
  it('request kinds are the domain’s, the production asks included', () => {
    expect(REQUEST_KINDS).toEqual(DOMAIN_REQUEST_KINDS)
    expect(REQUEST_STATUSES).toContain('COUNTERED')
  })
})

describe('addresses and tabs', () => {
  // pg-t: the list's address (its group and search) is pco/list.vitest.test.ts's (groupQuery).
  it('a record opens on a tab', () => {
    expect(recordHref('/p/X', 'o1')).toBe('/p/X/orders/o1?tab=overview')
    // B-TH-275: no Messages tab — the list's "Messages" opens the order with its docked conversation shown (the frame's arrival term).
    expect(recordHref('/p/X', 'o1', 'lines')).toBe('/p/X/orders/o1?tab=lines')
    expect(tabOf('shipments')).toBe('shipments')
    expect(tabOf('nope')).toBe('overview')
    expect(tabOf('messages')).toBe('overview')
    // pp-w1 (w1.3): the old ids of links in mails land on their new tabs.
    expect(tabOf('status')).toBe('overview')
    expect(tabOf('documents')).toBe('files')
  })

  it('a request not decided yet opens nothing (it is not an order yet)', () => {
    expect(ROWS.filter(opens).length).toBe(ROWS.length - 1)
    expect(opens({ kind: 'REQUEST' })).toBe(false)
  })

  it('J / K walk the list the person came from', () => {
    expect(neighbourOf(['a', 'b', 'c'], 'b', 1)).toBe('c')
    expect(neighbourOf(['a', 'b', 'c'], 'b', -1)).toBe('a')
    expect(neighbourOf(['a', 'b'], 'b', 1)).toBeNull()
    expect(neighbourOf(['a'], 'x', 1)).toBeNull()
  })
})

describe('where the order is', () => {
  const record = orderRecord()
  it('draws the API’s six steps for the DS tracker; an estimate only for a step still to come', () => {
    const steps = milestoneSteps(record.milestones, 'en', day)
    expect(steps.map((step) => step.state)).toEqual(['done', 'done', 'done', 'partly', 'partly', 'todo'])
    expect(steps[4]).toMatchObject({ id: 'SHIPPED', current: true, expected: null })
    expect(steps[5]!.expected).toBe(record.milestones[5]!.expected)
  })

  it('the promise: moves oldest first in customer words; the first date kept only when it moved', () => {
    const moves = promiseMoves(record.promiseHistory, 'it', day)
    expect(moves.map((move) => move.reason)).toEqual(['Capacità produttiva', 'Consegna dei materiali in ritardo'])
    expect(movesOf(record.promiseHistory)).toBe(2)
    expect(promiseOf(record.order)).toEqual({ date: record.order.promiseDate, first: record.order.originalPromiseDate })
    expect(promiseOf({ ...record.order, promiseMoved: false }).first).toBeNull()
  })

  it('the delivery address line by line; the totals only with the price grain', () => {
    expect(shipToLines(record.order.shipTo)).toEqual(['Brand Alpha S.r.l. — Magazzino', 'Via Esempio 10', '20100 Milano (MI)', 'IT', 'Ufficio ricevimento'])
    expect(totalsOf(record)).toEqual({ net: 752000, vat: 165440, gross: 917440, depositPaid: 275232, toPay: 917440 - 275232 })
    expect(totalsOf(withoutPrices(record))).toBeNull()
  })

  // F-OM-204 (B-OM-005, M3-B6): a part payment shows — the payments placed on each request count, not only a request paid in full; to
  // pay is the office's own still to pay when the read sends it.
  it('a deposit part paid counts what came in; to pay is the order\'s own figure when it comes', () => {
    const open = { ...record.deposits[0]!, status: 'OPEN', amount: 275232, paidAmount: 270000 }
    const partPaid = { ...record, deposits: [open] }
    expect(depositPaid(partPaid.deposits)).toBe(270000)
    expect(totalsOf(partPaid)).toMatchObject({ depositPaid: 270000, toPay: 917440 - 270000 })
    expect(totalsOf({ ...partPaid, order: { ...partPaid.order, stillToPay: 600000 } })).toMatchObject({ toPay: 600000 })
    // An older answer (no paidAmount on a request): the PAID requests' amounts, as before.
    expect(depositPaid([{ ...open, paidAmount: undefined }])).toBe(0)
    expect(depositPaid([{ ...open, status: 'CANCELLED', paidAmount: 270000 }, { ...open, id: 'x', paidAmount: 5000 }])).toBe(5000)
  })
})

describe('Ask for a change', () => {
  const rules = rulesOf()
  const line2 = rules.lines[1]!.lineId

  it('sends only what changed: the sizes, a new date, an address, the note', () => {
    const draft = { ...EMPTY_CHANGE, cells: { [line2]: { '50': 8, '52': 4 } }, requestedDate: '2026-12-01', note: ' two more ' }
    expect(changedCells(rules, draft)).toEqual([{ lineId: line2, seq: 2, size: '50', before: 6, after: 8 }])
    expect(changeBodyOf(rules, draft)).toEqual({ kind: 'CHANGE', cells: [{ lineId: line2, size: '50', quantity: 8 }], requestedDate: '2026-12-01', note: 'two more' })
  })

  it('waits with its reason, in order: preview, may not ask, the rules, the order’s verdict, offline, a line emptied, nothing asked', () => {
    expect(changeHeld(rules, EMPTY_CHANGE, { ...FACTS, preview: true })).toBe('held.preview')
    expect(changeHeld(rules, EMPTY_CHANGE, { ...FACTS, mayAsk: false })).toBe('held.mayAsk')
    expect(changeHeld(null, EMPTY_CHANGE, FACTS)).toBe('held.reading')
    expect(changeHeld({ ...rules, change: { ...rules.change, possible: false } }, EMPTY_CHANGE, FACTS)).toBe('held.verdict')
    expect(changeHeld(rules, EMPTY_CHANGE, { ...FACTS, offline: true })).toBe('held.offline')
    const emptied = { ...EMPTY_CHANGE, cells: { [line2]: { '46': 0, '48': 0, '50': 0, '52': 0 } } }
    expect(emptiedLines(rules, emptied)).toEqual([2])
    expect(changeHeld(rules, emptied, FACTS)).toBe('change.problem.emptied')
    expect(changeHeld(rules, EMPTY_CHANGE, FACTS)).toBe('change.problem.nothing')
    expect(changeHeld(rules, { ...EMPTY_CHANGE, shipToAddressId: rules.addresses[0]!.id }, FACTS)).toBeNull()
  })
})

describe('Ask to cancel', () => {
  const rules = rulesOf()
  const line2 = rules.lines[1]!.lineId
  it('the whole order, or the lines that may still be cancelled', () => {
    expect(cancelBodyOf(rules, { ...EMPTY_CANCEL, reasonCode: 'NOT_NEEDED' })).toEqual({ kind: 'CANCEL', reasonCode: 'NOT_NEEDED' })
    expect(cancelBodyOf(rules, { ...EMPTY_CANCEL, scope: 'LINES', lineIds: [rules.lines[0]!.lineId, line2], reasonCode: 'OTHER', note: ' x ' })).toEqual({ kind: 'CANCEL', lineIds: [line2], reasonCode: 'OTHER', note: 'x' })
  })

  it('waits on its field: a verdict, a line, a reason, the words a reason needs', () => {
    expect(cancelHeld(rules, EMPTY_CANCEL, FACTS)).toEqual({ key: 'held.verdict', field: 'scope' })
    expect(cancelHeld(rules, { ...EMPTY_CANCEL, scope: 'LINES' }, FACTS)).toEqual({ key: 'cancel.problem.lines', field: 'scope' })
    expect(cancelHeld(rules, { ...EMPTY_CANCEL, scope: 'LINES', lineIds: [line2] }, FACTS)).toEqual({ key: 'cancel.problem.reason', field: 'reason' })
    expect(cancelHeld(rules, { ...EMPTY_CANCEL, scope: 'LINES', lineIds: [line2], reasonCode: 'OTHER' }, FACTS)).toEqual({ key: 'cancel.problem.note', field: 'note' })
    expect(cancelHeld(rules, { ...EMPTY_CANCEL, scope: 'LINES', lineIds: [line2], reasonCode: 'NOT_NEEDED' }, FACTS)).toBeNull()
  })

  it('names the fee of what is asked (the settings now), none when free', () => {
    expect(cancelFeeOf(rules, { ...EMPTY_CANCEL, scope: 'LINES', lineIds: [line2] })).toBe(29550)
    expect(cancelFeeOf(rules, EMPTY_CANCEL)).toBe(112800)
    expect(cancelFeeOf({ ...rules, cancelFee: { ...rules.cancelFee!, pct: null } }, EMPTY_CANCEL)).toBeNull()
  })
})

describe('a refusal in our words', () => {
  it('a cut-off at the click names its verdict and asks to read the rules again', () => {
    expect(askRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/cells/0/LEATHER_CUT' }]))).toEqual({ key: 'problem.verdict.LEATHER_CUT', reread: true })
    expect(askRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/OPEN_REQUEST' }]))).toEqual({ key: 'problem.verdict.OPEN_REQUEST', reread: true })
    expect(askRefusal(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'problem.changed', reread: true })
    expect(askRefusal(new ApiError('forbidden', 403, 'forbidden', 'x')).key).toBe('problem.forbidden')
    expect(askRefusal(new Error('boom')).key).toBe('problem.internal')
  })
})

describe('Re-confirm version N', () => {
  it('a choice first, then words for a decline', () => {
    expect(reconfirmProblem(null, '')).toBe('reconfirm.problem.choose')
    expect(reconfirmProblem('REFUSED', '  ')).toBe('reconfirm.problem.why')
    expect(reconfirmProblem('APPROVED', '')).toBeNull()
  })

  it('of this order’s open requests: the newest revision that still takes an answer', () => {
    const page = (revision: number, answer: boolean) => ({ ...approvalPage({ id: `r${revision}` }, { answer }), content: { revisedOrder: { ...approvalPage().content.revisedOrder!, revision } } })
    expect(pickRevision([page(2, false), page(3, true)])?.request.id).toBe('r3')
    expect(pickRevision([page(3, false), page(2, true)])?.request.id).toBe('r2')
    expect(pickRevision([page(2, false), page(3, false)])?.request.id).toBe('r3')
    expect(pickRevision([])).toBeNull()
  })

  // F-OC fx4 (end check 1, th9 step 13): the approval page names the order by the party's own number (F-PR-16): the order page
  // looks for its revision by that number too — it found none by the office's SO-… alone, and waited for ever.
  // pp-w1 (13-backend C-1): the order read carries no office series any more — the party's own number is the only one.
  it('a revised order is this order’s by the party’s own number ("#12"); the office’s series is never read', async () => {
    const { findRevision, orderNumbersOf } = await import('./api')
    expect(orderNumbersOf(12)).toEqual(['#12'])
    expect(orderNumbersOf(null)).toEqual([])
    const own = { ...approvalPage({ id: 'r-own' }), content: { revisedOrder: { ...approvalPage().content.revisedOrder!, orderNumber: '#12' } } }
    const other = { ...approvalPage({ id: 'r-other' }), content: { revisedOrder: { ...approvalPage().content.revisedOrder!, orderNumber: '#13' } } }
    const pages: Record<string, unknown> = { 'r-own': own, 'r-other': other }
    const api = { get: async (path: string) => (path === '/portal/approvals' ? { state: 'OPEN', items: [{ id: 'r-own', kind: 'REVISED_ORDER', dueAt: '2026-11-30T16:00:00Z', status: 'OPEN' }, { id: 'r-other', kind: 'REVISED_ORDER', dueAt: '2026-11-30T16:00:00Z', status: 'OPEN' }] } : pages[decodeURIComponent(path.split('/').pop()!)]) } as never
    expect((await findRevision(api, orderNumbersOf(12)))?.request.id).toBe('r-own')
    expect(await findRevision(api, ['SO-2026-0042'])).toBeNull()
    const view = readFileSync(new URL('./OrderPage.tsx', import.meta.url), 'utf8')
    expect(view).toContain('const revisionNumbers = useMemo(() => orderNumbersOf(ownSeq), [ownSeq])')
    expect(view).not.toContain('order.number')
  })

  it('held: a preview, not open, may not approve, the request closed, offline', () => {
    const page = approvalPage()
    const facts = { preview: false, mayApprove: true, offline: false }
    expect(reconfirmHeld(page, { ...facts, preview: true })).toBe('held.preview')
    expect(reconfirmHeld({ ...page, request: { ...page.request, status: 'APPROVED' } }, facts)).toBe('reconfirm.held.answered')
    expect(reconfirmHeld(page, { ...facts, mayApprove: false })).toBe('held.mayApprove')
    expect(reconfirmHeld({ ...page, may: { ...page.may, answer: false } }, facts)).toBe('reconfirm.held.closed')
    expect(reconfirmHeld(page, facts)).toBeNull()
  })
})

describe('Pay the deposit', () => {
  it('the panel’s state from the page’s phase and the provider’s answer', () => {
    expect(paymentStateOf('idle', null)).toBe('idle')
    expect(paymentStateOf('ready', { status: 'WAITING' })).toBe('ready')
    expect(paymentStateOf('paying', { status: 'WAITING' })).toBe('waiting')
    expect(paymentStateOf('paying', { status: 'SUCCEEDED' })).toBe('succeeded')
    expect(paymentStateOf('ready', { status: 'FAILED' })).toBe('failed')
  })

  it('Pay by card waits with its reason', () => {
    const facts = { preview: false, mayPay: true, cardAvailable: true, canPay: true, offline: false }
    expect(payHeld({ ...facts, preview: true })).toBe('held.preview')
    expect(payHeld({ ...facts, mayPay: false })).toBe('held.mayPay')
    expect(payHeld({ ...facts, cardAvailable: false })).toBe('deposit.card.unavailable')
    expect(payHeld({ ...facts, canPay: false })).toBe('deposit.card.notPayable')
    expect(payHeld(facts)).toBeNull()
  })
})

describe('documents', () => {
  it('the current versions first, each earlier one after the version that replaced it; the confirmation’s PDF', () => {
    const read = documentsRead()
    const ordered = documentsInOrder(read.items)
    const current = ordered.findIndex((doc) => doc.kind === 'ORDER_CONFIRMATION' && doc.current)
    expect(ordered[current + 1]).toMatchObject({ kind: 'ORDER_CONFIRMATION', current: false })
    expect(confirmationFileOf(read.items)).toBe(read.items.find((doc) => doc.kind === 'ORDER_CONFIRMATION' && doc.current)!.files[0]!.fileId)
    expect(confirmationFileOf([])).toBeNull()
  })

  // pg-t: the list's rows, cells and doors are pco/list.vitest.test.ts's; here the shared rules a row still reads.
  it('B-TH-303: a row names its kind and where it opens', () => {
    const [request, order, catalogue] = [
      listRowsOf(null, '', [REQUESTS[0]!], [], 'en')[0]!,
      listRowsOf(null, '', [], [ROWS[0]!], 'en')[0]!,
      listRowsOf(null, '', [], [ROWS[3]!], 'en')[0]!,
    ]
    expect([kindKey(request), kindKey(order), kindKey(catalogue)]).toEqual(['kind.request', 'kind.order', 'kind.orderRequest']) // pg-fx4: never "Catalogue"
    expect(rowHref('/p/B', request)).toBe(`/p/B/orders/requests/${REQUESTS[0]!.id}`)
    expect(rowHref('/p/B', order)).toBe(`/p/B/orders/${ROWS[0]!.id}?tab=overview`)
    expect(rowHref('/p/B', catalogue)).toBeNull()
  })
})

describe('words', () => {
  it('every code the pages word has its words in both languages', () => {
    for (const locale of ['it', 'en'] as const) {
      const keys = [
        ...VERDICT_CODES.map((code) => `problem.verdict.${code}`),
        ...DEPOSIT_KINDS.map((kind) => `deposit.kind.${kind}`),
        ...['OPEN', 'PAID', 'WAIVED', 'CANCELLED'].map((status) => `deposit.state.${status}`),
        ...['PDF', 'XML', 'FILE'].map((format) => `docs.format.${format}`),
        ...['CARD', 'SEPA_DEBIT'].flatMap((method) => [`pay.method.${method}`, `pay.methodHint.${method}`]),
        ...FAKE_SCENARIOS.map((scenario) => `pay.scenario.${scenario}`),
        ...['NOT_OPEN', 'NO_PROVIDER', 'CURRENCY', 'NOT_PAYABLE', 'PROVIDER', 'IN_PROGRESS'].map((code) => `pay.problem.${code}`),
        ...['APPROVED', 'REFUSED'].flatMap((decision) => [`reconfirm.done.${decision}`, `reconfirm.done.next.${decision}`, `reconfirm.go.${decision}`]),
        ...['ADDED', 'REMOVED', 'CHANGED'].map((change) => `revision.change.${change}`),
        ...['customerRef', 'requestedDate'].map((field) => `revision.field.${field}`),
        ...['SENDER', 'RECIPIENT', 'CARRIER'].map((by) => `shipments.by.${by}`),
        ...['held.preview', 'held.mayAsk', 'held.reading', 'held.verdict', 'held.offline', 'held.busy', 'held.mayApprove', 'held.mayPay', 'change.problem.emptied', 'change.problem.nothing', 'change.problem.long'],
        ...['cancel.problem.lines', 'cancel.problem.reason', 'cancel.problem.note', 'cancel.problem.long', 'reconfirm.problem.choose', 'reconfirm.problem.why', 'reconfirm.problem.long', 'reconfirm.problem.name', 'reconfirm.problem.changed'],
        ...['reconfirm.held.answered', 'reconfirm.held.closed', 'deposit.card.unavailable', 'deposit.card.notPayable', 'notice.changeSent', 'notice.cancelSent', 'notice.withdrawn'],
        ...['changed', 'forbidden', 'missing', 'invalid', 'rateLimited', 'unavailable', 'internal'].map((problem) => `problem.${problem}`),
        ...['docs.withdrawn', 'docs.downloadFailed', 'docs.noConfirmation'],
      ]
      expect(keys.filter((key) => !has(locale, key)), locale).toEqual([])
    }
  })
})

const KEY = /\b(?:list|row|bulk|held|band|keys|chips|col|state|ref|tabs|record|tracker|history|requests|progress|deposit|facts|revision|reconfirm|lines|sizes|totals|shipments|toShip|docs|dialog|discard|change|cancel|problem|pay|size|print|transit|notice|offline|noAccess|prices|unsaved|messages|nav)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-184 design cases', () => {
  for (const screen of [listScreen, recordScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: every case draws in Italian and English with no raw key`, () => {
      for (const locale of ['it', 'en'] as const) {
        for (const entry of screen.cases) {
          const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: entry.model })))
          expect(html, `${screen.screen}/${entry.id} (${locale})`).toContain('main-content')
          expect(html.match(KEY)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale})`).toBeNull()
          expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
        }
      }
    })
  }

  it('a role without prices sees no amount anywhere', () => {
    for (const id of ['th-223-no-prices']) { // pg-t: the case id of the list on the shared parts
      const entry = listScreen.cases.find((item) => item.id === id)!
      const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell', 'portal']) }, createElement(listScreen.view, { model: entry.model })))
      expect(html).not.toMatch(/€/)
    }
    for (const id of ['overview-no-prices', 'ov-noprice', 'ov-prod-designer', 'lines-no-prices']) {
      const entry = recordScreen.cases.find((item) => item.id === id)!
      const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell', 'portal']) }, createElement(recordScreen.view, { model: entry.model })))
      expect(html, id).not.toMatch(/€/)
    }
    expect(mtmRecord().order.noWithdrawal).toBe(true)
  })
})

// pg-t: Orders & requests on the shared parts — the band, the rows, the doors, the two customers (W05 / W10), the D6 parcel and the
// room's columns are pco/list.vitest.test.ts's; the tiles, chips, CSV and print of the old list left with it.
describe('B-TH-223 — Orders & requests read by Brand Beta', () => {
  const screen = listScreen as unknown as DesignScreen<unknown>
  const render = (locale: 'it' | 'en', id: string) => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: screen.cases.find((item) => item.id === id)!.model })))

  it('every th-223 case holds nothing of Brand Alpha and no office series; the list says its title and its closed requests', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const entry of screen.cases.filter((item) => item.id.startsWith('th-223-'))) {
        const html = render(locale, entry.id)
        expect(scanText(html, BRAND_ALPHA), `${entry.id} (${locale})`).toEqual([])
        expect(html.match(/\b(?:INQ|SO|RQ|QT|SH)-\d{4}-\d+/)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
      }
    }
    const html = render('en', 'th-223-list')
    expect(html).toContain('Orders &amp; requests')
    expect(html).toContain('Closed requests')
  })

  // B-TH-223 (fix-portal-1): the server render draws no grid row, so the scans above pass whatever the rows hold; the rows
  // themselves (the list read, the rows handed to the grid, the unread marks) must be Brand Beta's own.
  it('no row of a Brand Beta case carries a code of the Alpha world (its PO codes, ids, order and parcel numbers)', () => {
    const alphaCodes = ROWS.flatMap((row) => [row.id, row.customerRef, row.number, row.nextShipment?.id, row.nextShipment?.number]).filter((code): code is string => typeof code === 'string' && code !== '')
    const betaCases = screen.cases.filter((item) => /^th-(?:223|230|246)-/.test(item.id))
    expect(betaCases.length).toBeGreaterThanOrEqual(19)
    for (const entry of betaCases) {
      for (const locale of ['it', 'en'] as const) {
        const body = (entry.model as CustomerCaseBuilder)(locale).body
        if (body.kind !== 'list') continue
        const { read, rows, unread } = body.model
        const shown = listRowsOf(body.model.group, body.model.q, body.model.requests.state === 'ready' ? body.model.requests.rows : [], rows, locale)
        const data = JSON.stringify({ read, rows, unread, shown })
        expect(alphaCodes.filter((code) => data.includes(code)), `${entry.id} (${locale})`).toEqual([])
        expect(data.match(/\bBA-PO-\d+/)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
        expect(scanText(data, BRAND_ALPHA), `${entry.id} (${locale})`).toEqual([])
      }
    }
    // Beta's rows are there to be checked: its own purchase-order codes and ids.
    expect(BETA_ROWS.filter((row) => row.customerRef !== null).every((row) => row.customerRef!.startsWith('BETA-PO-'))).toBe(true)
    expect(BETA_ROWS.some((row) => ROWS.some((alpha) => alpha.id === row.id))).toBe(false)
  })

  it('every case of the list draws its own numbers, never the office’s order numbers', () => {
    for (const entry of screen.cases.filter((item) => item.id !== 'no-access')) {
      const html = render('en', entry.id)
      expect(html.match(/\bSO-2026-\d+/)?.[0] ?? null, entry.id).toBeNull()
    }
  })

  it('the model the page hands the list: a group (or everything open), never a chip, a tile or a selection', () => {
    const body = (screen.cases.find((item) => item.id === 'th-223-requests')!.model as CustomerCaseBuilder)('en').body as { kind: 'list'; model: OrdersListViewModel }
    expect(body.model.group).toBe('REQUESTS')
    expect(Object.keys(body.model)).not.toEqual(expect.arrayContaining(['chip', 'tiles', 'selected', 'transit']))
  })
})

// ── B-TH-246 (threads plan TH-4, picture 28; SHEET-G10, Owner decision 13; features SHEET.portal-sheet, portal-sheet-F07; wall W10,
// W17, W39): the customer's own sheet — the ticked columns only, read-only, every cell its own page, "Download all" by the server ──
import { downloadSheet, fetchSheet, fileNameOf } from './api'
import { listBandOf } from './band'
import { portalCellText, portalColumnLabel, portalColumnsOf, sheetFileName } from './model'
import { SHEET_COLUMNS, sheetRead } from './fixtures'

describe('B-TH-246 — the customer\'s own sheet in its portal', () => {
  const said = { yes: 'Yes', no: 'No', day: (value: string) => `day ${value}` }
  it('the columns are the ones the API sends for this portal (the office ticked them; never another customer\'s): none on the plain read', () => {
    expect(portalColumnsOf(sheetRead(ordersRead('OPEN'))).map((column) => column.columnId)).toEqual(['cf:box_type', 'cf:fair_date'])
    expect(portalColumnsOf(ordersRead('OPEN'))).toEqual([])
    expect(portalColumnsOf(null)).toEqual([])
    expect(portalColumnLabel({ labelIt: 'Peso', labelEn: 'Weight', unit: 'kg' }, 'en')).toBe('Weight (kg)')
  })
  it('a cell in the customer\'s words: the API\'s words first, a list value, a day, yes / no, money in its currency; nothing as nothing', () => {
    const [box, fair] = SHEET_COLUMNS
    expect(portalCellText(box!, { value: 'GIFT', wordsIt: null, wordsEn: null }, 'en', said)).toBe('Gift box')
    expect(portalCellText(box!, { value: 'GIFT', wordsIt: 'Regalo!', wordsEn: 'Gift!' }, 'en', said)).toBe('Gift!')
    expect(portalCellText(fair!, { value: '2027-02-10', wordsIt: null, wordsEn: null }, 'en', said)).toBe('day 2027-02-10')
    expect(portalCellText({ type: 'YES_NO', options: null }, { value: true, wordsIt: null, wordsEn: null }, 'en', said)).toBe('Yes')
    expect(portalCellText({ type: 'MONEY', options: null }, { value: { amount: 12345, currency: 'EUR' }, wordsIt: null, wordsEn: null }, 'en', said)).toContain('123.45')
    expect(portalCellText(box!, undefined, 'en', said)).toBeNull()
  })
  it('the sheet is read from GET /portal/sales-orders/sheet with the view\'s chip and search (the same Open count as the list)', async () => {
    const asked: string[] = []
    const api = { get: async (path: string, options: { query?: Record<string, unknown>; schema: { parse: (value: unknown) => unknown } }) => { asked.push(`${path}?${new URLSearchParams(Object.entries(options.query ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString()}`); return options.schema.parse(sheetRead(ordersRead('OPEN'))) } } as unknown as ApiClient
    const read = await fetchSheet(api, { chip: 'OPEN', q: ' gloves ' })
    expect(asked[0]).toBe('/portal/sales-orders/sheet?chip=OPEN&q=gloves&limit=50&offset=0')
    expect(read.columns?.length).toBe(2)
    expect(read.count).toBe(ordersRead('OPEN').count)
  })
  it('"Download all (Excel)": the server\'s file in the customer\'s scope (never the office\'s export job), named as the server names it', async () => {
    const asked: Array<{ path: string; query: unknown }> = []
    const api = {
      bytes: async (path: string, options: { query?: unknown; onHeaders?: (headers: Headers) => void }) => {
        asked.push({ path, query: options.query })
        options.onHeaders?.(new Headers({ 'content-disposition': "attachment; filename*=UTF-8''Your%20orders.xlsx", 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
        return new Uint8Array([1, 2, 3])
      },
    } as unknown as ApiClient
    const file = await downloadSheet(api, { chip: 'OPEN', q: null, format: 'XLSX', locale: 'en' })
    expect(asked).toEqual([{ path: '/portal/sales-orders/sheet/download', query: { chip: 'OPEN', q: undefined, format: 'XLSX', locale: 'en' } }])
    expect(file.fileName).toBe('Your orders.xlsx')
    expect(file.bytes.length).toBe(3)
    expect(fileNameOf('attachment; filename="orders.xlsx"')).toBe('orders.xlsx')
    expect(fileNameOf(null)).toBeNull()
    expect(sheetFileName('orders', 'XLSX')).toBe('orders.xlsx')
  })
  it('the band\'s ⋯ offers Download all (and says while the file is prepared)', () => {
    const words = { t, locale: 'en', time: (value: string) => value, day } as unknown as Parameters<typeof listBandOf>[0]['words']
    const band = listBandOf({ words, asOf: null, onDownloadAll: () => undefined })
    expect(band.more?.find((item) => item.id === 'download-all')?.label).toBe('Download (Excel)') // pg-w2 (Z8): one export, the group shown
    expect(listBandOf({ words, asOf: null, onDownloadAll: () => undefined, downloading: true }).more?.find((item) => item.id === 'download-all')?.disabled).toBe(true)
    expect(listBandOf({ words, asOf: null }).more?.some((item) => item.id === 'download-all')).toBe(false)
  })
  it('W10 / W17 / W39: Brand Beta\'s sheet holds nothing of Brand Alpha and no office series, in both languages; each cell opens Beta\'s own page', () => {
    const screen = listScreen as unknown as DesignScreen<unknown>
    for (const locale of ['it', 'en'] as const) {
      for (const id of ['th-246-sheet', 'th-246-download-failed']) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: screen.cases.find((item) => item.id === id)!.model })))
        expect(scanText(html, BRAND_ALPHA), `${id} (${locale})`).toEqual([])
        expect(html.match(/\b(?:SO|QT)-\d{4}-\d+/)?.[0] ?? null, `${id} (${locale})`).toBeNull()
        expect(html).not.toMatch(/\/w\/[A-Z0-9-]+\//)
      }
    }
  })
  it('the words in it and en', () => {
    for (const locale of ['it', 'en'] as const) for (const key of ['band.downloadAll', 'band.downloading', 'band.downloadAllHint', 'sheet.yes', 'sheet.no', 'sheet.columnHint', 'sheet.downloadFailed']) expect(CATALOGUE[locale][NS]?.[key], `${locale} ${key}`).toBeTruthy()
  })
})
// ── end B-TH-246 ──

// ---- F-SA-238: Documents — the order's shared files grouped like the office's Files tab (the same body, its customer face) --------
describe('F-SA-238 — the portal Documents tab: the customer’s own shared files by source, the customer face', () => {
  const PORTAL_READ = {
    asOf: '2026-11-18T09:00:00Z',
    order: { id: 'o-alpha', customerRef: 'PO-7731', yourNumber: { seq: 12, words: { en: 'Your order 12', it: 'Il vostro ordine 12' } } },
    groups: [
      { key: 'ORDER', words: { en: 'Order & thread', it: 'Ordine e conversazione' }, files: [{ id: 'f1', name: 'Order sheet.pdf', kind: 'DOCUMENT', category: null, documentKind: null, documentWords: null, contentType: 'application/pdf', sizeBytes: 2048, versionNo: 1, at: '2026-11-12T10:00:00Z', from: { type: 'SalesOrder', id: 'o-alpha', label: 'Your order 12' }, line: null }] },
      { key: 'SHIPMENTS', words: { en: 'Shipments & invoices', it: 'Spedizioni e fatture' }, files: [{ id: 'f2', name: 'DDT 41.pdf', kind: 'DOCUMENT', category: null, documentKind: 'DDT', documentWords: { en: 'Delivery note', it: 'Documento di trasporto' }, contentType: 'application/pdf', sizeBytes: 4096, versionNo: 1, at: '2026-11-15T10:00:00Z', from: { type: 'Shipment', id: 's1', label: null }, line: null }] },
      { key: 'RETURNS', words: { en: 'Returns & complaints', it: 'Resi e reclami' }, files: [] },
    ],
    total: 2,
  }
  const draw = (locale: 'it' | 'en', model: Parameters<typeof OrderFilesBody>[0]['model']) =>
    renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(OrderFilesBody, { model, party: null, actions: {} })))

  it('the customer’s own numbers, its groups, the library’s document words; no audience label, no also on, nothing counted, no choosing', () => {
    const read = portalFilesRead(PORTAL_READ, 'Your order 12')
    expect(read.order.number).toBe('Your order 12')
    expect(read.groups.flatMap((group) => group.files).every((file) => file.audience === 'CUSTOMER_CAN_SEE' && file.alsoOn.length === 0 && file.alsoOnOther === 0)).toBe(true)
    for (const locale of ['en', 'it'] as const) {
      const html = draw(locale, { read, problem: null, selected: [], canShare: false, face: 'customer' })
      // F-OF-101: the read's "Shipments & invoices" is split by the file's source — a shipment's papers under "Shipments".
      for (const words of locale === 'en' ? ['Order &amp; thread', 'Order sheet.pdf', 'Delivery note'] : ['Ordine e conversazione', 'Documento di trasporto']) expect(html, words).toContain(words)
      expect(html).toMatch(locale === 'en' ? />Shipments(<!-- -->)?\s/ : />Spedizioni(<!-- -->)?\s/)
      expect(html).not.toContain(locale === 'en' ? 'Shipments &amp; invoices' : 'Spedizioni e fatture')
      for (const never of ['Office only', 'Solo ufficio', 'Shared with the customer', 'Condiviso con il cliente', 'you cannot open', 'non puoi aprire', 'also on', 'anche su', 'type="checkbox"']) expect(html, never).not.toContain(never)
      expect(html).not.toContain('Returns')
    }
  })

  it('empty: "No documents yet."; reading: skeleton rows; a failed read says so with Try again', () => {
    const empty = portalFilesRead({ ...PORTAL_READ, groups: [], total: 0 }, 'Your order 12')
    expect(draw('en', { read: empty, problem: null, selected: [], canShare: false, face: 'customer' })).toContain('No documents yet.')
    expect(draw('it', { read: empty, problem: null, selected: [], canShare: false, face: 'customer' })).toContain('Ancora nessun documento.')
    expect(draw('en', { read: null, problem: null, selected: [], canShare: false, face: 'customer' })).toContain('role="status"')
    expect(draw('en', { read: null, problem: 'read', selected: [], canShare: false, face: 'customer' })).toMatch(/Try again|Retry/)
  })

  // pp-w1 (w1.3): read on arrival on every tab (the tab strip counts the files) and again on every hint of the live channel.
  it('the page reads it on arrival and again on the live channel’s news; another customer’s order: the neutral "not found"', () => {
    const page = readFileSync(new URL('./OrderPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain("const orderFiles = usePortalOrderFiles(api, id, true, ")
    expect(page).toContain('      orderFiles.reload() // F-SA-238: live on partner_notification.created; pp-w1 (w1.3): the Files count on every tab')
    const tab = readFileSync(new URL('./view/DocumentsTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("t('docs.filesNotFound')")
    for (const locale of ['en', 'it'] as const) {
      const t = createTranslator(locale, messagesFor(locale, ['portal-orders'])['portal-orders']!)
      for (const key of ['docs.filesTitle', 'docs.filesNotFound', 'docs.versionsTitle']) expect(t(key), `${locale}: ${key}`).not.toBe(key)
    }
  })
})
// ---- end F-SA-238

// ---- F-OP-124 (order page plan N5): the number of a carrier booked by hand on the customer's shipment card ----------------------
describe('F-OP-124: the typed tracking number ("No live tracking")', () => {
  it('a typed number is shown as typed; none, blank or absent shows nothing', () => {
    expect(typedTrackingOf({ typedTrackingNumber: ' T-BRT-0001 ' })).toBe('T-BRT-0001')
    expect(typedTrackingOf({ typedTrackingNumber: null })).toBeNull()
    expect(typedTrackingOf({ typedTrackingNumber: '   ' })).toBeNull()
    expect(typedTrackingOf({})).toBeNull()
  })

  it('says it in both languages, the same words to every customer', () => {
    for (const locale of ['it', 'en'] as const) {
      const t = createTranslator(locale, messagesFor(locale, ['portal-orders'])['portal-orders']!)
      for (const key of ['shipments.typed.label', 'shipments.typed.noLive']) expect(t(key), `${locale}: ${key}`).not.toBe(key)
    }
    expect(createTranslator('en', messagesFor('en', ['portal-orders'])['portal-orders']!)('shipments.typed.noLive')).toBe('No live tracking')
  })
})
// ---- end F-OP-124

// ---- F-OP-135 (order page plan N6; B-OP-034, B-OP-044): the typed link and a shared shipment, as the customer sees them ----------
describe('F-OP-135: Track › for a typed link; a shared shipment named by this customer’s own orders only', () => {
  it('Track › only for an https link typed beside a number', () => {
    expect(typedLinkOf({ typedTrackingNumber: 'T-1', typedTrackingUrl: ' https://track.example.com/T-1 ' })).toBe('https://track.example.com/T-1')
    expect(typedLinkOf({ typedTrackingNumber: 'T-1', typedTrackingUrl: 'http://track.example.com/T-1' })).toBeNull()
    expect(typedLinkOf({ typedTrackingNumber: 'T-1', typedTrackingUrl: 'javascript:alert(1)' })).toBeNull()
    expect(typedLinkOf({ typedTrackingNumber: null, typedTrackingUrl: 'https://track.example.com/T-1' })).toBeNull()
    expect(typedLinkOf({ typedTrackingNumber: 'T-1' })).toBeNull()
  })

  it('"Also N pieces of your order #12": the customer’s own number, else its PO; never the office’s series', () => {
    for (const locale of ['it', 'en'] as const) {
      const t = createTranslator(locale, messagesFor(locale, ['portal-orders'])['portal-orders']!)
      const lines = alsoCarriesOf({ otherOrders: [{ yourNumber: { seq: 12, words: { it: 'Vostro ordine 12', en: 'Your order 12' } }, customerRef: 'PO-4471', pieces: 3 }, { yourNumber: null, customerRef: 'PO-4480', pieces: 1 }, { yourNumber: null, customerRef: 'PO-4490', pieces: 0 }] }, t)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('#12')
      expect(lines[0]).toContain('3')
      expect(lines[1]).toContain('PO-4480')
      for (const line of lines) expect(line).not.toMatch(/SO-\d/)
      expect(alsoCarriesOf({}, t)).toEqual([])
      for (const key of ['shipments.typed.track']) expect(t(key), `${locale}: ${key}`).not.toBe(key)
      expect(t('shipments.typed.trackOf', { number: 'SH-0091' })).toContain('SH-0091')
    }
  })
})
// ---- end F-OP-135
