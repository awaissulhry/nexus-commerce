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
  ordersCsv,
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

  it('exports in the person’s words; the value only with the price grain', () => {
    const rows = ordersRead('ALL').items
    const csv = ordersCsv(rows, t, 'en', true, day).split('\r\n')
    expect(csv).toHaveLength(rows.length + 1)
    expect(csv[0]).toBe('Your PO,Our order,Ordered on,Status,Promise date,Ordered,Shipped,Open,Net value,Currency,Next shipment')
    expect(csv[1]).toContain('7520.00')
    const without = ordersCsv(ordersRead('ALL', null, { seesPrices: false }).items, t, 'en', false, day)
    expect(without).not.toMatch(/Value|EUR|\d+\.\d\d/)
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
