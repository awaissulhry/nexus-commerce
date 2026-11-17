import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { APPROVAL_STATUSES as DOMAIN_APPROVAL_STATUSES } from '@nexus/factory-domain/approvals-out/kinds'
import { INTENT_STATUSES as DOMAIN_INTENT_STATUSES } from '@nexus/factory-domain/payments/online/rules'
import { REQUEST_STATUSES as DOMAIN_REQUEST_STATUSES, VERDICT_CODES as DOMAIN_VERDICTS } from '@nexus/factory-domain/sales/change-requests/rules'
import { DEPOSIT_KINDS } from '@nexus/factory-domain/sales/quotes/quotes'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { APPROVAL_STATUSES, FAKE_SCENARIOS, INTENT_STATUSES, pickRevision, REQUEST_STATUSES, VERDICT_CODES } from './api'
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
  listQuery,
  milestoneSteps,
  movesOf,
  neighbourOf,
  NS,
  opens,
  listCsv,
  listChips,
  listRows,
  kindKey,
  ownRef,
  rowHref,
  CLOSED_REQUESTS,
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
  transitSteps,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'
// B-TH-223, B-TH-303: Orders & requests.
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA } from '../../../lib/testing/two-brands'
import { REQUESTS, requestRow } from '../requests/design-data'
import type { OrdersListViewModel } from './view/OrdersListView'
// B-TH-238: the tiles (their chips, the customer's own reads).
import type { ApiClient } from '../../../lib/api/client'
import { fetchRequests } from '../requests/api'
import { fetchOrders } from './api'
import { requestCountsOf } from './fixtures'
import { apiChipOf, isListChip, listTiles, NEEDS_YOU, OPEN_ORDERS, OPEN_REQUESTS, ordersInChip, requestsInChip, TILE_CHIPS } from './model'

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
})

describe('addresses and tabs', () => {
  it('writes the chip and search in the address (Open, the default, is left out); a record opens on a tab', () => {
    expect(listQuery(null, '')).toBe('')
    expect(listQuery('OPEN', '  ')).toBe('')
    expect(listQuery('DATE_MOVED', ' BA-PO ', { print: '1' })).toBe('?chip=DATE_MOVED&q=BA-PO&print=1')
    expect(recordHref('/p/X', 'o1')).toBe('/p/X/orders/o1?tab=status')
    expect(recordHref('/p/X', 'o1', 'messages')).toBe('/p/X/orders/o1?tab=messages#messages')
    expect(tabOf('shipments')).toBe('shipments')
    expect(tabOf('nope')).toBe('status')
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

  it('a parcel on its way as four steps', () => {
    expect(transitSteps({ status: 'IN_TRANSIT', shippedAt: '2026-11-07T10:00:00Z' }, 'en').map((step) => step.state)).toEqual(['done', 'done', 'done', 'todo'])
    expect(transitSteps({ status: 'PACKED', shippedAt: null }, 'en').map((step) => step.state)).toEqual(['done', 'todo', 'todo', 'todo'])
  })

  it('the delivery address line by line; the totals only with the price grain', () => {
    expect(shipToLines(record.order.shipTo)).toEqual(['Brand Alpha S.r.l. — Magazzino', 'Via Esempio 10', '20100 Milano (MI)', 'IT', 'Ufficio ricevimento'])
    expect(totalsOf(record)).toEqual({ net: 752000, vat: 165440, gross: 917440, depositPaid: 275232, toPay: 917440 - 275232 })
    expect(totalsOf(withoutPrices(record))).toBeNull()
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

describe('documents and the CSV', () => {
  it('the current versions first, each earlier one after the version that replaced it; the confirmation’s PDF', () => {
    const read = documentsRead()
    const ordered = documentsInOrder(read.items)
    const current = ordered.findIndex((doc) => doc.kind === 'ORDER_CONFIRMATION' && doc.current)
    expect(ordered[current + 1]).toMatchObject({ kind: 'ORDER_CONFIRMATION', current: false })
    expect(confirmationFileOf(read.items)).toBe(read.items.find((doc) => doc.kind === 'ORDER_CONFIRMATION' && doc.current)!.files[0]!.fileId)
    expect(confirmationFileOf([])).toBeNull()
  })

  it('exports the rows shown in the person’s words, own numbers only; the value only with the price grain', () => {
    const rows = listRows('ALL', '', REQUESTS, ordersRead('ALL').items, 'en')
    const csv = listCsv(rows, t, 'en', true, day).split('\r\n')
    expect(csv).toHaveLength(rows.length + 1)
    expect(csv[0]).toBe('Your PO,Kind,Your number,Subject,Date,Status,Wanted or promised,Ordered,Shipped,Open,Net value,Currency,Next shipment')
    expect(csv[1]).toContain('Request')
    expect(csv[1]).toContain('Your request 7')
    expect(csv.join('\n')).toContain('7520.00')
    expect(csv.join('\n')).not.toMatch(/\b(?:INQ|SO|RQ)-\d{4}-\d+/)
    const without = listCsv(listRows('ALL', '', [], ordersRead('ALL', null, { seesPrices: false }).items, 'en'), t, 'en', false, day)
    expect(without).not.toMatch(/Value|EUR|\d+\.\d\d/)
  })

  it('B-TH-223: requests first (the one that needs the customer on top), then the orders; each chip its own requests', () => {
    const orders = ordersRead('OPEN').items
    const rows = listRows('OPEN', '', REQUESTS, orders, 'en')
    const open = REQUESTS.filter((row) => row.state.open)
    expect(rows.slice(0, open.length).every((row) => row.kind === 'request')).toBe(true)
    expect(rows[0]).toMatchObject({ kind: 'request', request: { state: { code: 'NEED_INFO' } } })
    expect(rows).toHaveLength(open.length + orders.length)
    expect(listRows('REQUESTED', '', REQUESTS, [], 'en')).toHaveLength(open.length)
    expect(listRows('ALL', '', REQUESTS, [], 'en')).toHaveLength(REQUESTS.length)
    expect(listRows(CLOSED_REQUESTS, '', REQUESTS, orders, 'en').map((row) => (row.kind === 'request' ? row.request.state.code : 'ORDER')).sort()).toEqual(['DECLINED', 'ORDER_CONFIRMED'])
    expect(listRows('DELIVERED', '', REQUESTS, [], 'en')).toEqual([])
    expect(listRows('ALL', 'gloves', REQUESTS, [], 'en').map((row) => row.id)).toEqual([REQUESTS[1]!.id])
  })

  it('B-TH-223: chip counts add the chip’s requests; Closed requests only when there are some; "+" when not all were read', () => {
    const read = ordersRead('OPEN')
    const chips = listChips(read.chips, { rows: REQUESTS, complete: true }, 'en', 'Closed requests')
    const open = REQUESTS.filter((row) => row.state.open).length
    expect(chips.find((chip) => chip.chip === 'OPEN')!.count).toBe(String(read.chips.find((chip) => chip.chip === 'OPEN')!.count + open))
    expect(chips.find((chip) => chip.chip === 'DELIVERED')!.count).toBe(String(read.chips.find((chip) => chip.chip === 'DELIVERED')!.count))
    expect(chips.at(-1)).toEqual({ chip: CLOSED_REQUESTS, label: 'Closed requests', count: '2' })
    expect(listChips(read.chips, { rows: REQUESTS, complete: false }, 'en', 'x').find((chip) => chip.chip === 'ALL')!.count).toMatch(/\+$/)
    expect(listChips(read.chips, { rows: [requestRow(1, 'SENT')], complete: true }, 'en', 'x').some((chip) => chip.chip === CLOSED_REQUESTS)).toBe(false)
  })

  it('B-TH-303: a row names the customer’s own number, its kind, and where it opens', () => {
    const [request, order, catalogue] = [
      listRows('ALL', '', [REQUESTS[0]!], [], 'en')[0]!,
      listRows('ALL', '', [], [ROWS[0]!], 'en')[0]!,
      listRows('ALL', '', [], [ROWS[3]!], 'en')[0]!,
    ]
    expect(ownRef(request, 'en')).toEqual({ label: 'Your request', value: '7' })
    expect(ownRef(order, 'it')).toEqual({ label: 'Il vostro ordine', value: '11' })
    expect(ownRef(catalogue, 'en')).toBeNull()
    expect([kindKey(request), kindKey(order), kindKey(catalogue)]).toEqual(['kind.request', 'kind.order', 'kind.catalogue'])
    expect(rowHref('/p/B', request)).toBe(`/p/B/orders/requests/${REQUESTS[0]!.id}`)
    expect(rowHref('/p/B', order)).toBe(`/p/B/orders/${ROWS[0]!.id}?tab=status`)
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
    for (const id of ['no-prices']) {
      const entry = listScreen.cases.find((item) => item.id === id)!
      const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell', 'portal']) }, createElement(listScreen.view, { model: entry.model })))
      expect(html).not.toMatch(/€/)
    }
    for (const id of ['status-no-prices', 'lines-no-prices']) {
      const entry = recordScreen.cases.find((item) => item.id === id)!
      const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell', 'portal']) }, createElement(recordScreen.view, { model: entry.model })))
      expect(html, id).not.toMatch(/€/)
    }
    expect(mtmRecord().order.noWithdrawal).toBe(true)
  })
})

describe('B-TH-223 — Orders & requests read by Brand Beta', () => {
  const screen = listScreen as unknown as DesignScreen<unknown>
  const render = (locale: 'it' | 'en', id: string) => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: screen.cases.find((item) => item.id === id)!.model })))

  it('every th-223 case holds nothing of Brand Alpha and no office series; the list says kinds and true states', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const entry of screen.cases.filter((item) => item.id.startsWith('th-223-'))) {
        const html = render(locale, entry.id)
        expect(scanText(html, BRAND_ALPHA), `${entry.id} (${locale})`).toEqual([])
        expect(html.match(/\b(?:INQ|SO|RQ|QT)-\d{4}-\d+/)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
      }
    }
    const html = render('en', 'th-223-all')
    expect(html).toContain('Orders &amp; requests')
    expect(html).toContain('Closed requests')
  })

  it('the rows of each th-223 case (what the grid and the phone cards draw, what the file writes) are Brand Beta’s alone', () => {
    for (const entry of screen.cases.filter((item) => item.id.startsWith('th-223-'))) {
      const body = (entry.model as (locale: 'en') => { body: { kind: string; model: OrdersListViewModel } })('en').body
      if (body.kind !== 'list') continue
      const view = body.model
      const rows = listRows(view.chip ?? view.read?.chip ?? 'OPEN', view.q, view.requests.state === 'ready' ? view.requests.rows : [], view.rows, 'en')
      const file = listCsv(rows, t, 'en', true, day)
      expect(scanText(file, BRAND_ALPHA), entry.id).toEqual([])
      expect(file.match(/\b(?:INQ|SO|RQ|QT)-\d{4}-\d+/)?.[0] ?? null, entry.id).toBeNull()
    }
    const open = listCsv(listRows('OPEN', '', REQUESTS, [], 'en'), t, 'en', true, day)
    for (const words of ['We need something from you', 'Quote being prepared', 'Being reviewed', 'Sent', 'Order waiting for approval']) expect(open).toContain(words)
    expect(open).not.toMatch(/Quote sent|Order confirmed/)
  })

  it('every case of the list draws its own numbers, never the office’s order numbers', () => {
    for (const entry of screen.cases.filter((item) => item.id !== 'no-access')) {
      const html = render('en', entry.id)
      expect(html.match(/\bSO-2026-\d+/)?.[0] ?? null, entry.id).toBeNull()
    }
  })
})

// ---- B-TH-238 (P-CUS-ORD-LIST.tiles-F01; wall W05, W10): the tiles — We need something from you · Open requests · Open orders ----
describe('B-TH-238 — the tiles of Orders & requests', () => {
  const screen = listScreen as unknown as DesignScreen<unknown>
  const render = (locale: 'it' | 'en', id: string) => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: screen.cases.find((item) => item.id === id)!.model })))
  const counts = requestCountsOf(REQUESTS)

  it('three tiles from the customer’s own reads: the first is Home’s number (the same read), each a filter of the list', () => {
    const read = ordersRead('OPEN')
    expect(listTiles({ counts }, read)).toEqual([
      { chip: NEEDS_YOU, value: counts.needsYou },
      { chip: OPEN_REQUESTS, value: counts.open },
      { chip: OPEN_ORDERS, value: read.chips.find((entry) => entry.chip === 'OPEN')!.count },
    ])
    // Unknown is "—", never 0.
    expect(listTiles(null, null).map((tile) => tile.value)).toEqual([null, null, null])
    // Each tile's rows: the requests that need the customer, the open requests, the open orders (no request among them).
    expect(requestsInChip(NEEDS_YOU, REQUESTS).map((row) => row.state.code)).toEqual(['NEED_INFO'])
    expect(requestsInChip(OPEN_REQUESTS, REQUESTS)).toHaveLength(counts.open)
    expect(requestsInChip(OPEN_ORDERS, REQUESTS)).toEqual([])
    expect([ordersInChip(NEEDS_YOU), ordersInChip(OPEN_REQUESTS), ordersInChip(OPEN_ORDERS)]).toEqual([false, false, true])
    expect([apiChipOf(OPEN_ORDERS), apiChipOf(NEEDS_YOU), apiChipOf('IN_PRODUCTION'), apiChipOf(null)]).toEqual(['OPEN', null, 'IN_PRODUCTION', null])
    for (const chip of TILE_CHIPS) {
      expect(isListChip(chip, ['OPEN'])).toBe(true)
      expect(listQuery(chip, '')).toBe(`?chip=${chip}`)
      for (const locale of ['it', 'en'] as const) {
        expect(has(locale, `tiles.${chip}`), `${locale} ${chip}`).toBe(true)
        expect(has(locale, `tiles.hint.${chip}`), `${locale} ${chip} hint`).toBe(true)
      }
    }
  })

  it('on screen: the tiles above the list, a pressed tile shows its rows only; Brand Beta’s alone, no office series', () => {
    const list = render('en', 'th-223-list')
    for (const words of ['We need something from you', 'Open requests', 'Open orders']) expect(list).toContain(words)
    expect(list).toContain('nds-metric btn')
    expect(list).not.toContain('nds-metric btn active')
    const needs = render('en', 'th-238-needs-you')
    expect(needs).toContain('nds-metric btn active')
    expect(needs).toContain('Rain jackets like last spring, 40 pieces')
    expect(needs).not.toContain('Winter gloves for the shop, sizes S to XL')
    for (const id of ['th-238-needs-you', 'th-238-open-requests', 'th-238-open-orders']) {
      for (const locale of ['it', 'en'] as const) {
        const html = render(locale, id)
        expect(scanText(html, BRAND_ALPHA), `${id} (${locale})`).toEqual([])
        expect(html.match(/\b(?:INQ|SO|RQ|QT)-\d{4}-\d+/)?.[0] ?? null, `${id} (${locale})`).toBeNull()
      }
    }
    expect(render('it', 'th-223-list')).toContain('Ci serve qualcosa da voi')
  })

  it('W05/W10: customer B’s tiles never move with customer A’s requests or orders (two customers, each its own reads)', async () => {
    type Json = Record<string, unknown>
    const world: Record<'alpha' | 'beta', { requests: Json[]; orders: ReturnType<typeof ordersRead> }> = {
      alpha: { requests: [{ ...requestRow(1, 'NEED_INFO'), id: BRAND_ALPHA.ids.order, customerRef: BRAND_ALPHA.customerRef }], orders: ordersRead('OPEN') },
      beta: { requests: [...REQUESTS], orders: ordersRead('OPEN') },
    }
    const apiOf = (key: 'alpha' | 'beta') =>
      ({
        get: async (path: string, options: { schema: { parse: (value: unknown) => unknown } }) => {
          const own = world[key]
          if (path === '/portal/inquiries') return options.schema.parse({ rows: own.requests, counts: requestCountsOf(own.requests as unknown as typeof REQUESTS), complete: true })
          if (path === '/portal/sales-orders') return own.orders
          throw new Error(`unexpected GET ${path}`)
        },
      }) as unknown as ApiClient
    const tilesOf = async (key: 'alpha' | 'beta') => {
      const api = apiOf(key)
      return listTiles(await fetchRequests(api, { state: 'ALL', limit: 200 }), await fetchOrders(api, { chip: 'OPEN' }))
    }
    const before = await tilesOf('beta')
    const alphaBefore = await tilesOf('alpha')
    // Customer A moves: two more requests wait for it, and it has more open orders.
    world.alpha.requests.push({ ...requestRow(2, 'NEED_INFO'), id: BRAND_ALPHA.ids.file }, { ...requestRow(3, 'SENT'), id: BRAND_ALPHA.ids.thread })
    world.alpha.orders = { ...world.alpha.orders, chips: world.alpha.orders.chips.map((entry) => (entry.chip === 'OPEN' ? { ...entry, count: entry.count + 5 } : entry)) }
    expect(await tilesOf('beta')).toEqual(before)
    expect(await tilesOf('alpha')).not.toEqual(alphaBefore)
  })
})
// ---- end B-TH-238
