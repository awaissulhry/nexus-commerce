import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SDI_NEXT_ACTIONS as DOMAIN_SDI_ACTIONS, SDI_STATE_CODES as DOMAIN_SDI_CODES } from '@nexus/factory-domain/invoicing/sdi/words'
import { INVOICE_DOC_TYPES as DOMAIN_DOC_TYPES, INVOICE_STATUSES as DOMAIN_INVOICE_STATUSES } from '@nexus/factory-domain/invoicing/invoices'
import { LINK_STATES as DOMAIN_LINK_STATES } from '@nexus/factory-domain/links/purposes'
import { BOARD_LANES as DOMAIN_LANES, ORDER_ACTIONS as DOMAIN_ACTIONS, SALES_ORDER_STATUSES as DOMAIN_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, listAddress as pageOfList, recordAddress, RECORD_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { BOARD_LANES, DEPOSIT_KINDS, DEPOSIT_REQUEST_STATUSES, DEPOSIT_STATES, INVOICE_DOC_TYPES, INVOICE_STATUSES, LINK_STATES, ORDER_ACTIONS, ORDER_STATUSES, SDI_NEXT_ACTIONS, SDI_STATE_CODES, SETTLEMENT_GAPS, SHIPMENT_STATUSES, WORK_ORDER_STATUSES } from './api'
import { BOARD, canOf, deposit, LIST_ROWS, order, PAID, SENT_LINK, TD02, TODAY } from './_demo/fixtures'
import { runWithStepUp } from './hooks'
import { designScreen as listScreen } from './list/fixtures'
import {
  boardLanes,
  closeHeld,
  depositGate,
  depositSteps,
  knownIds,
  laneCount,
  laneQuery,
  laneValue,
  layoutFromAddress,
  linkHeld,
  listAddress,
  listTouches,
  liveTouches,
  nextStep,
  ordersCsv,
  parseAmount,
  paymentHeld,
  paymentProblems,
  promiseProblems,
  ROW_VIEWS,
  rowsFromAddress,
  rowsQuery,
  settlementWords,
  stillToPay,
  tabOf,
  tileCount,
  TILES,
  writeProblem,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'
import { designScreen as depositPayScreen } from '../../../links/deposit-pay/fixtures'

const params = (query: string) => new URLSearchParams(query)

describe('the enums mirror factory-domain (the screens say words for every value the API sends)', () => {
  it('order states, lanes, actions, link states, SDI states and next steps, invoice kinds and states', () => {
    expect([...ORDER_STATUSES]).toEqual([...DOMAIN_STATUSES])
    expect([...BOARD_LANES]).toEqual([...DOMAIN_LANES])
    expect([...ORDER_ACTIONS]).toEqual([...DOMAIN_ACTIONS])
    expect([...LINK_STATES]).toEqual([...DOMAIN_LINK_STATES])
    expect([...SDI_STATE_CODES]).toEqual([...DOMAIN_SDI_CODES])
    expect([...SDI_NEXT_ACTIONS]).toEqual([...DOMAIN_SDI_ACTIONS])
    expect([...INVOICE_DOC_TYPES]).toEqual([...DOMAIN_DOC_TYPES])
    expect([...INVOICE_STATUSES]).toEqual([...DOMAIN_INVOICE_STATUSES])
  })
})

describe('the saved rows, the address and the API query (one filter model)', () => {
  it('reads the API’s own filters from the address — Home › Today’s See all links land on the right rows', () => {
    expect(rowsFromAddress(params(''))).toBe('open')
    expect(rowsFromAddress(params('late=true'))).toBe('late')
    expect(rowsFromAddress(params('deposit=OPEN'))).toBe('deposit')
    expect(rowsFromAddress(params('status=READY'))).toBe('READY')
    expect(rowsFromAddress(params('status=NOPE'))).toBe('open')
    expect(rowsFromAddress(params('rows=all'))).toBe('all')
    expect(layoutFromAddress(params('view=board'))).toBe('board')
    expect(layoutFromAddress(params(''))).toBe('list')
    expect(pageOfList('/sales/orders', { late: 'true' }, OFFICE_PAGES)).toBe('/sales/orders?late=true')
    expect(pageOfList('/sales/orders', { deposit: 'OPEN' }, OFFICE_PAGES)).toBe('/sales/orders?deposit=OPEN')
  })

  it('writes every view back to the same address, and each view asks the API its filter', () => {
    for (const rows of ROW_VIEWS) {
      const address = listAddress('/w/DEMO/sales/orders', { rows, q: '', layout: 'list' })
      expect(rowsFromAddress(new URL(address, 'http://x').searchParams), rows).toBe(rows)
    }
    expect(listAddress('/p', { rows: 'open', q: '', layout: 'list' })).toBe('/p')
    expect(listAddress('/p', { rows: 'late', q: ' SO-88 ', layout: 'board' })).toBe('/p?view=board&late=true&q=SO-88')
    expect(rowsQuery('open', '')).toMatchObject({ open: true })
    expect(rowsQuery('late', 'x')).toMatchObject({ late: true, q: 'x' })
    expect(rowsQuery('deposit', '')).toMatchObject({ deposit: 'OPEN' })
    expect(rowsQuery('SHIPPED', '')).toMatchObject({ status: 'SHIPPED' })
    expect(rowsQuery('all', '')).not.toHaveProperty('open')
  })

  it('a tile is a saved rows view; its count is the board’s (unknown: null, never 0)', () => {
    expect(TILES.map((tile) => tile.rows)).toEqual(['late', 'deposit', 'IN_PRODUCTION', 'READY'])
    // The board's own filters mean the same rows as the tiles' saved views.
    for (const tile of BOARD.tiles) expect(rowsQuery(TILES.find((entry) => entry.key === tile.key)!.rows, '')).toMatchObject(Object.fromEntries(Object.entries(tile.filter).map(([key, value]) => [key, key === 'late' ? true : value])))
    expect(tileCount(BOARD, 'late')).toBe(2)
    expect(tileCount(null, 'late')).toBeNull()
  })
})

describe('the board by state', () => {
  const lane = (status: (typeof BOARD_LANES)[number], more = false) => ({ status, items: LIST_ROWS.filter((row) => row.status === status), more, problem: null })
  it('shows one lane for a state’s view, none for closed or cancelled, all five otherwise', () => {
    expect(boardLanes('open')).toEqual([...BOARD_LANES])
    expect(boardLanes('READY')).toEqual(['READY'])
    expect(boardLanes('CLOSED')).toEqual([])
    expect(laneQuery('CONFIRMED', 'deposit', 'q')).toMatchObject({ status: 'CONFIRMED', deposit: 'OPEN', late: false, q: 'q' })
  })
  it('counts from the board while only the search filters; else what the lane read ("50+" when more wait)', () => {
    expect(laneCount(lane('CONFIRMED'), 'open', BOARD)).toBe(3)
    expect(laneCount(lane('CONFIRMED'), 'late', BOARD)).toBe(3)
    expect(laneCount(lane('CONFIRMED', true), 'late', BOARD)).toBeNull()
  })
  it('a lane’s value only with the price grain and only when every order of it was read', () => {
    expect(laneValue(lane('CONFIRMED'), true)).toBe(624000 + 1260000 + 270000)
    expect(laneValue(lane('CONFIRMED', true), true)).toBeNull()
    expect(laneValue(lane('CONFIRMED'), false)).toBeNull()
  })
})

describe('the record: the next step by state, held with its reason', () => {
  it('Confirmed → Make work orders, held while the deposit is open or missing, or without the right', () => {
    expect(nextStep(order('CONFIRMED'), canOf('owner'))).toEqual({ kind: 'makeWorkOrders', held: { key: 'held.deposit', params: { date: '2026-11-04' } } })
    expect(nextStep(order('CONFIRMED'), canOf('sales')).held?.key).toBe('held.noWorkOrders')
    const paid = order('CONFIRMED', { chain: { ...order('CONFIRMED').chain, depositRequests: [PAID] } })
    expect(nextStep(paid, canOf('owner'))).toEqual({ kind: 'makeWorkOrders', held: null })
    expect(nextStep(order('CONFIRMED', { depositRequired: false, chain: { ...order().chain, depositRequests: [] } }), canOf('owner')).held).toBeNull()
    expect(nextStep(order('CONFIRMED', { chain: { ...order().chain, depositRequests: [] } }), canOf('owner')).held?.key).toBe('held.depositMissing')
  })
  it('In production / Ready / Partly shipped → Change promise date; Shipped → Close; final → nothing', () => {
    expect(nextStep(order('IN_PRODUCTION'), canOf('sales'))).toEqual({ kind: 'changePromise', held: null })
    expect(nextStep(order('PARTLY_SHIPPED'), canOf('finance')).held?.key).toBe('held.noManage')
    expect(nextStep(order('SHIPPED', { settled: true }), canOf('sales'))).toEqual({ kind: 'close', held: null })
    expect(nextStep(order('CLOSED'), canOf('owner')).kind).toBeNull()
    expect(nextStep(order('CANCELLED'), canOf('owner')).kind).toBeNull()
  })
  it('closing an unsettled order needs orders.close (and a reason, asked by the dialog)', () => {
    expect(closeHeld(order('SHIPPED'), canOf('sales'))?.key).toBe('held.notSettled')
    expect(closeHeld(order('SHIPPED'), canOf('finance'))).toBeNull()
    expect(closeHeld(order('SHIPPED', { settled: true }), canOf('manager'))?.key).toBe('held.noClose')
    expect(settlementWords(order('SHIPPED'))).toEqual(['settlement.BALANCE_DUE', 'settlement.AT_SDI'])
    expect(settlementWords({ settlement: { settled: false, missing: [{ code: 'SOMETHING_NEW', message: 'x' }], source: 'x' } })).toEqual(['settlement.OTHER'])
  })
  it('a promise change: a day from today, a reason, a line when lines are chosen', () => {
    expect(promiseProblems({ date: '', reason: 'x', today: TODAY, current: null, lineIds: [], allLines: true })).toEqual({ date: 'promise.problem.date' })
    expect(promiseProblems({ date: '2026-10-28', reason: 'x', today: TODAY, current: null, lineIds: [], allLines: true })).toEqual({ date: 'promise.problem.past' })
    expect(promiseProblems({ date: '2026-12-15', reason: 'x', today: TODAY, current: '2026-12-15', lineIds: [], allLines: true })).toEqual({ date: 'promise.problem.same' })
    expect(promiseProblems({ date: '2026-12-15', reason: '  ', today: TODAY, current: null, lineIds: [], allLines: false })).toEqual({ reason: 'promise.problem.reason', lines: 'promise.problem.lines' })
    expect(promiseProblems({ date: TODAY, reason: 'ok', today: TODAY, current: '2026-12-15', lineIds: [], allLines: true })).toEqual({})
  })
  it('tabs from the address; the chain’s ids for live events', () => {
    expect(tabOf('money')).toBe('money')
    expect(tabOf('nope')).toBe('lines')
    const ids = knownIds(order('SHIPPED'))
    expect(ids.has(order('SHIPPED').id)).toBe(true)
    expect(ids.has(TD02.id)).toBe(true)
    expect(liveTouches({ type: 'sales_order.status_changed', fields: { orderId: order().id } }, ids)).toBe(true)
    expect(liveTouches({ type: 'payment.deposit_paid', fields: { depositRequestId: PAID.id } }, ids)).toBe(true)
    expect(liveTouches({ type: 'sales_order.status_changed', fields: { orderId: 'another' } }, ids)).toBe(false)
    expect(liveTouches({ type: 'thread.message_posted', fields: { recordId: order().id } }, ids)).toBe(false)
    expect(liveTouches({ type: 'quote.accepted', fields: {} })).toBe(true)
    expect(listTouches({ type: 'sales_order.created' })).toBe(true)
    expect(listTouches({ type: 'payment.deposit_paid' })).toBe(true)
    expect(listTouches({ type: 'workorder.progress' })).toBe(false)
  })
})

describe('the deposit (Q12: an acconto by bank transfer)', () => {
  it('the gate the work orders read: waiting, paid, waived, not needed, missing', () => {
    expect(depositGate(order('CONFIRMED')).state).toBe('WAITING')
    expect(depositGate({ depositRequired: true, chain: { ...order().chain, depositRequests: [PAID] } }).state).toBe('PAID')
    expect(depositGate({ depositRequired: true, chain: { ...order().chain, depositRequests: [deposit({ status: 'WAIVED' })] } }).state).toBe('WAIVED')
    expect(depositGate({ depositRequired: true, chain: { ...order().chain, depositRequests: [deposit({ status: 'CANCELLED' })] } }).state).toBe('MISSING')
    expect(depositGate({ depositRequired: false, chain: { ...order().chain, depositRequests: [] } }).state).toBe('NOT_NEEDED')
  })
  it('five steps: asked → page → payment → TD02 → SDI, each in its state', () => {
    expect(depositSteps(deposit(), [], null)).toEqual({ requested: 'done', page: 'current', paid: 'waiting', invoice: 'waiting', sdi: 'waiting' })
    expect(depositSteps(deposit({ link: SENT_LINK }), [], null)).toMatchObject({ page: 'done', paid: 'current' })
    expect(depositSteps(deposit({ link: SENT_LINK, paidAmount: 100000 }), [], null)).toMatchObject({ paid: 'current', invoice: 'current' })
    expect(depositSteps(PAID, [], null)).toMatchObject({ paid: 'done', invoice: 'current', sdi: 'waiting' })
    expect(depositSteps(PAID, [TD02], 'NOT_SENT')).toMatchObject({ invoice: 'done', sdi: 'current' })
    expect(depositSteps(PAID, [TD02], 'DELIVERED')).toMatchObject({ sdi: 'done' })
    expect(depositSteps(PAID, [{ ...TD02, status: 'DRAFT' }], null)).toMatchObject({ invoice: 'current' })
    expect(depositSteps(deposit({ fiscalDocument: 'NONE', status: 'PAID' }), [], null)).toMatchObject({ invoice: 'notNeeded', sdi: 'notNeeded' })
    // A TD02 of another request is not this one's.
    expect(depositSteps(PAID, [{ ...TD02, depositRequestId: 'another' }], 'DELIVERED')).toMatchObject({ invoice: 'current' })
  })
  it('what is left to pay, and who may send the page and record the payment', () => {
    expect(stillToPay(deposit({ paidAmount: 100000 }))).toBe(128384)
    expect(stillToPay(PAID)).toBe(0)
    expect(stillToPay({ status: 'OPEN', amount: undefined, paidAmount: undefined })).toBeNull()
    expect(linkHeld(deposit(), canOf('sales'))?.key).toBe('held.noPayments')
    expect(linkHeld(deposit(), canOf('finance'))).toBeNull()
    expect(linkHeld(PAID, canOf('finance'))?.key).toBe('held.depositNotOpen')
    expect(paymentHeld(deposit(), canOf('finance'))).toBeNull()
    expect(paymentHeld(deposit(), canOf('manager'))?.key).toBe('held.noPayments')
  })
  it('a typed amount in either language; the payment’s problems', () => {
    expect(parseAmount('2.283,84')).toBe(228384)
    expect(parseAmount('2283.84')).toBe(228384)
    expect(parseAmount('€ 1000')).toBe(100000)
    expect(parseAmount('0')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
    expect(paymentProblems({ amount: '', receivedOn: TODAY, reference: 'CRO-1', today: TODAY, left: 1000 })).toEqual({ amount: 'payment.problem.amount' })
    expect(paymentProblems({ amount: '20,00', receivedOn: '2026-10-30', reference: ' ', today: TODAY, left: 1000 })).toEqual({ over: true, receivedOn: 'payment.problem.future', reference: 'payment.problem.reference' })
    expect(paymentProblems({ amount: '10,00', receivedOn: TODAY, reference: 'CRO-1', today: TODAY, left: 1000 })).toEqual({})
  })
  it('a 403 asking for a step-up runs the write again once the code was taken (same work, same key)', async () => {
    let calls = 0
    const work = async () => {
      calls += 1
      if (calls === 1) throw new ApiError('step_up', 403, 'forbidden', 'x', null, [{ path: 'stepUp' }])
      return 'done'
    }
    let asked = 0
    expect(await runWithStepUp(work, async () => void (asked += 1))).toBe('done')
    expect([calls, asked]).toEqual([2, 1])
    await expect(runWithStepUp(async () => Promise.reject(new ApiError('conflict', 409, 'conflict', 'x')), async () => undefined)).rejects.toThrow()
  })
})

describe('problems in this app’s words; the CSV by grain', () => {
  it('maps the API’s refusals to words, never its English', () => {
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version' }]))).toEqual({ key: 'problem.write.moved', reload: true })
    expect(writeProblem(new ApiError('conflict', 409, 'invalid_state', 'x'))).toEqual({ key: 'problem.write.state', reload: true })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/externalRef' }])).key).toBe('problem.write.reference')
    expect(writeProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/promiseDate' }])).key).toBe('promise.problem.past')
    expect(writeProblem(new ApiError('forbidden', 403, 'forbidden', 'x')).key).toBe('problem.write.forbidden')
    expect(writeProblem(new Error('boom')).key).toBe('problem.write.internal')
  })
  it('Export N: money columns only with the price grain', () => {
    const words = { header: (key: string) => key, status: (status: string) => status, deposit: (state: string) => state }
    const withPrice = ordersCsv(LIST_ROWS.slice(0, 2), true, words, 'it').split('\n')
    expect(withPrice[0]).toContain('net')
    expect(withPrice).toHaveLength(3)
    expect(ordersCsv(LIST_ROWS.slice(0, 2), false, words, 'it').split('\n')[0]).not.toContain('net')
  })
})

describe('where an order opens (one detail rule)', () => {
  it('its own page once built; the list page with the API’s query', () => {
    expect(RECORD_PAGES.SalesOrder).toBe('/sales/orders/[id]')
    expect(LIST_PAGES['/sales/orders']).toBe('/sales/orders')
    expect(recordAddress({ type: 'SalesOrder', id: 'o1', label: 'SO-1', companyId: 'c1' }, OFFICE_PAGES)).toBe('/sales/orders/o1')
    expect(OFFICE_PAGES.has('/sales/orders')).toBe(true)
    expect(OFFICE_PAGES.has('/sales/orders/[id]')).toBe(true)
  })
})

const LEFT_KEY =
  /\b(?:common|live|status|deposit|depositKind|requestStatus|rows|tile|layout|list|col|bulk|csv|board|tab|step|action|record|held|summary|chain|gate|lines|layer|dates|production|woStatus|ship|shipStatus|money|docType|invoiceStatus|sdi|link|payment|sdiSend|promise|ready|close|settlement|docs|part|notice|stepUp|problem|keys)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
// Permission and grain names are never on screen either; a file name or an e-mail address is not a key.
const NOT_KEYS = /\b[\w.-]+@[\w.-]+\.\w+\b|\b[\w-]+\.(?:pdf|csv)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(NOT_KEYS, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html, `${screen.screen}/${item.id} (${locale}): a permission name on screen`).not.toMatch(/\b(?:orders|payments|invoices|workorders|quotes)\.(?:view|manage|close|record|issue)\b/)
        }
      }
    })
  }

  it(`SCR-199 (the customer's deposit page): ${depositPayScreen.cases.length} cases × it, en`, () => {
    const screen = depositPayScreen as unknown as DesignScreen<unknown>
    for (const item of screen.cases) {
      for (const locale of LOCALES) {
        const html = render(screen, item.model, locale)
        expect(html.length, `SCR-199/${item.id}`).toBeGreaterThan(200)
        expect(html.match(/\b(?:what|bank|paid|kind|copy|copied|title)\.[a-zA-Z]+\b/)?.[0] ?? null, `SCR-199/${item.id} (${locale})`).toBeNull()
      }
    }
    // No price but the party's own; the IBAN read in groups of four.
    expect(render(screen, screen.cases[0]!.model, 'it')).toContain('IT60 X054 2811 1010 0000 0123 456')
  })

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      const has = (key: string) => expect(t(key), `${locale}: ${key}`).not.toBe(key)
      for (const status of ORDER_STATUSES) has(`status.${status}`)
      for (const view of ROW_VIEWS) has(`rows.${view}`)
      for (const state of DEPOSIT_STATES) has(`deposit.${state}`)
      for (const status of DEPOSIT_REQUEST_STATUSES) has(`requestStatus.${status}`)
      for (const kind of DEPOSIT_KINDS) has(`depositKind.${kind}`)
      for (const state of LINK_STATES) has(`link.${state}`)
      for (const code of SDI_STATE_CODES) has(`sdi.state.${code}`)
      for (const action of SDI_NEXT_ACTIONS) has(`sdi.next.${action}`)
      for (const docType of INVOICE_DOC_TYPES) has(`docType.${docType}`)
      for (const status of INVOICE_STATUSES) has(`invoiceStatus.${status}`)
      for (const code of [...SETTLEMENT_GAPS, 'OTHER']) has(`settlement.${code}`)
      for (const status of WORK_ORDER_STATUSES) has(`woStatus.${status}`)
      for (const status of SHIPMENT_STATUSES) has(`shipStatus.${status}`)
      for (const state of ['NOT_NEEDED', 'WAITING', 'PAID', 'WAIVED', 'MISSING']) has(`gate.state.${state}`)
      for (const tile of TILES) has(`tile.${tile.key}`)
    }
  })
})
